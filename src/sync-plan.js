import { join } from "node:path";

/**
 * 同步频率模型与调度单元生成。频率只决定何时触发一次完整同步，
 * 不是增量同步：每次触发都会重建整份标准资源副本。
 *
 * @typedef {{kind: "manual"} | {kind: "every", everyMinutes: number, weekdays?: number[]} | {kind: "daily", at: string, weekdays?: number[]} | {kind: "weekly", at: string, weekdays: number[]}} Cadence
 * @typedef {{kind?: string, everyMinutes?: number, at?: string, weekdays?: number[]}} CadenceInput
 * @typedef {{command: string, args: string[], ignoreFailure?: boolean}} ScheduleCommand
 */

/** 与 normalizeCadence 实际接受的集合保持一致（hourly 是 every 60 的语法糖）。 */
export const CADENCE_KINDS = ["manual", "every", "hourly", "daily", "weekly"];

const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/**
 * 校验并补全频率对象；hourly 是 every 60 的语法糖（缺 everyMinutes 时按 60 补齐）。
 * every / daily 可选 weekdays：只在这些星期到期，其余日子不 due。
 *
 * @param {CadenceInput} input
 * @returns {Cadence}
 */
export function normalizeCadence(input) {
  const hourly = input?.kind === "hourly";
  const kind = hourly ? "every" : input?.kind;
  if (kind === "manual") return { kind: "manual" };
  if (kind === "every") {
    const everyMinutes = hourly ? 60 : Number(input?.everyMinutes);
    if (!Number.isInteger(everyMinutes) || everyMinutes < 1) {
      throw new Error(`every 频率需要正整数分钟间隔，收到：${input?.everyMinutes ?? "(空)"}`);
    }
    const weekdays = normalizeOptionalWeekdays(input?.weekdays);
    return { kind: "every", everyMinutes, ...(weekdays ? { weekdays } : {}) };
  }
  if (kind === "daily" || kind === "weekly") {
    const at = normalizeAt(input?.at ?? "09:00");
    if (kind === "daily") {
      const weekdays = normalizeOptionalWeekdays(input?.weekdays);
      return { kind: "daily", at, ...(weekdays ? { weekdays } : {}) };
    }
    return { kind: "weekly", at, weekdays: normalizeWeekdays(input?.weekdays) };
  }
  throw new Error(`不支持的频率：${input?.kind ?? "(空)"}；可用 ${CADENCE_KINDS.join("、")}`);
}

/**
 * 频率的 kind 分派只在这里发生：一次求值同时给出文案、是否到期与下次到期时间，
 * `cadenceText` / `isDue` / `nextDueAt` 都只读取这份结果。
 *
 * @param {Cadence} cadence
 * @param {string | null | undefined} [lastRunAt]
 * @param {Date | string} [now]
 * @returns {{normalized: Cadence, text: string, due: boolean, next: string | null}}
 */
function evaluateCadence(cadence, lastRunAt = null, now = new Date()) {
  const normalized = normalizeCadence(cadence);
  if (normalized.kind === "manual") {
    return { normalized, text: "手动", due: false, next: null };
  }
  const nowDate = toDate(now, "now");
  const last = toOptionalDate(lastRunAt);
  if (normalized.kind === "every") {
    const allowed = isAllowedWeekday(normalized, nowDate);
    const due = allowed && (!last || nowDate.getTime() - last.getTime() >= normalized.everyMinutes * 60000);
    let next;
    if (!last || due) {
      next = nowDate.toISOString();
    } else {
      const candidate = new Date(last.getTime() + normalized.everyMinutes * 60000);
      if (candidate > nowDate && isAllowedWeekday(normalized, candidate)) {
        next = candidate.toISOString();
      } else {
        const fallback = nextAllowedDayStart(normalized, nowDate);
        next = fallback ? fallback.toISOString() : null;
      }
    }
    return {
      normalized,
      text: `每 ${normalized.everyMinutes} 分钟${weekdaySuffix(normalized.weekdays)}`,
      due,
      next,
    };
  }
  const allowed = isAllowedWeekday(normalized, nowDate);
  const due = allowed && (!last || last < latestOccurrence(normalized, nowDate));
  let next;
  if (!last || due) {
    next = nowDate.toISOString();
  } else {
    const occurrence = nextOccurrence(normalized, nowDate);
    next = occurrence ? occurrence.toISOString() : null;
  }
  const text =
    normalized.kind === "daily"
      ? normalized.weekdays
        ? `每${weekdayNames(normalized.weekdays)} ${normalized.at}`
        : `每天 ${normalized.at}`
      : `每${weekdayNames(normalized.weekdays)} ${normalized.at}`;
  return { normalized, text, due, next };
}

/**
 * @param {Cadence} cadence
 */
export function cadenceText(cadence) {
  return evaluateCadence(cadence).text;
}

/**
 * 按本地时间判断是否到期。非允许星期一律不 due；
 * 从未运行（或上次时间无法解析）的允许日立即到期；manual 永不到期。
 *
 * @param {Cadence} cadence
 * @param {string | null | undefined} lastRunAt
 * @param {Date | string} [now]
 */
export function isDue(cadence, lastRunAt, now = new Date()) {
  return evaluateCadence(cadence, lastRunAt, now).due;
}

/**
 * 下次到期时间。已到期或从未运行（允许日）时返回当前时刻；manual 返回 null。
 * 与 isDue 共用同一次 kind 分派。
 *
 * @param {Cadence} cadence
 * @param {string | null | undefined} lastRunAt
 * @param {Date | string} [now]
 * @returns {string | null}
 */
export function nextDueAt(cadence, lastRunAt, now = new Date()) {
  return evaluateCadence(cadence, lastRunAt, now).next;
}

/**
 * 生成 macOS launchd plist 或 Linux systemd user service+timer 的内容与安装命令。
 * 本函数只构造，不写文件、不执行命令；安装由 CLI 在用户同意后完成。
 *
 * @param {{
 *   platform: string,
 *   instanceDir: string,
 *   instanceId: string,
 *   nodePath: string,
 *   cliPath: string,
 *   tickMinutes: number,
 *   home: string,
 *   uid?: number,
 *   logPath?: string
 * }} options
 */
export function buildSchedule(options) {
  const platform = options.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`不支持的平台：${platform}；只支持 darwin（launchd）与 linux（systemd user）`);
  }
  const tickMinutes = Number(options.tickMinutes);
  if (!Number.isInteger(tickMinutes) || tickMinutes < 1) {
    throw new Error(`--tick-minutes 必须是正整数，收到：${options.tickMinutes}`);
  }
  const id = String(options.instanceId ?? "").slice(0, 8) || "instance";
  const label = `com.wecom-support-bot.sync.${id}`;
  const logPath = options.logPath ?? join(options.instanceDir, "logs/sync.log");
  const args = [options.nodePath, options.cliPath, "sync-due", "--instance-dir", options.instanceDir];

  if (platform === "darwin") {
    const plistPath = join(options.home, "Library/LaunchAgents", `${label}.plist`);
    const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    return {
      platform,
      label,
      tickMinutes,
      logPath,
      units: [{ path: plistPath, content: launchdPlist({ label, args, tickMinutes, logPath }) }],
      installCommands: [
        { command: "launchctl", args: ["bootout", `gui/${uid}`, plistPath], ignoreFailure: true },
        { command: "launchctl", args: ["bootstrap", `gui/${uid}`, plistPath] },
      ],
      uninstallCommands: [
        { command: "launchctl", args: ["bootout", `gui/${uid}`, plistPath], ignoreFailure: true },
      ],
    };
  }

  const unitDir = join(options.home, ".config/systemd/user");
  const servicePath = join(unitDir, `${label}.service`);
  const timerPath = join(unitDir, `${label}.timer`);
  return {
    platform,
    label,
    tickMinutes,
    logPath,
    units: [
      { path: servicePath, content: systemdService({ label, args, logPath }) },
      { path: timerPath, content: systemdTimer({ label, tickMinutes }) },
    ],
    installCommands: [
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      { command: "systemctl", args: ["--user", "enable", "--now", `${label}.timer`] },
    ],
    uninstallCommands: [
      { command: "systemctl", args: ["--user", "disable", "--now", `${label}.timer`], ignoreFailure: true },
      { command: "systemctl", args: ["--user", "daemon-reload"] },
    ],
  };
}

/** @param {{label: string, args: string[], tickMinutes: number, logPath: string}} options */
function launchdPlist({ label, args, tickMinutes, logPath }) {
  const programArguments = args.map((argument) => `    <string>${escapeXml(argument)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>StartInterval</key>
  <integer>${tickMinutes * 60}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

/** @param {{label: string, args: string[], logPath: string}} options */
function systemdService({ label, args, logPath }) {
  const execStart = args.map((argument) => `"${escapeSystemd(argument)}"`).join(" ");
  return `[Unit]
Description=wecom-support-bot sync (${label})

[Service]
Type=oneshot
ExecStart=${execStart}
StandardOutput=append:${escapeSystemd(logPath)}
StandardError=append:${escapeSystemd(logPath)}
`;
}

/** @param {{label: string, tickMinutes: number}} options */
function systemdTimer({ label, tickMinutes }) {
  return `[Unit]
Description=wecom-support-bot sync timer (${label})

[Timer]
OnBootSec=1min
OnActiveSec=1min
OnUnitActiveSec=${tickMinutes}min
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/** @param {string} value */
function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** @param {string} value */
function escapeSystemd(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
}

/** @param {string} at */
function normalizeAt(at) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(at));
  if (!match) throw new Error(`时间格式必须是 HH:MM（00:00–23:59），收到：${at}`);
  return `${match[1]}:${match[2]}`;
}

/**
 * @param {number[] | undefined} weekdays
 * @returns {number[] | undefined}
 */
function normalizeOptionalWeekdays(weekdays) {
  if (weekdays === undefined || weekdays === null) return undefined;
  return normalizeWeekdays(weekdays);
}

/**
 * @param {number[] | undefined} weekdays
 * @returns {number[]}
 */
function normalizeWeekdays(weekdays) {
  const values = weekdays === undefined || weekdays === null ? [1] : weekdays;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("weekdays 需要至少一个星期（1=周一 … 7=周日）");
  }
  const normalized = [...new Set(values.map((value) => Number(value)))].sort((left, right) => left - right);
  if (normalized.some((value) => !Number.isInteger(value) || value < 1 || value > 7)) {
    throw new Error(`星期必须是 1 到 7 的整数，收到：${values.join(",")}`);
  }
  return normalized;
}

/** @param {number[] | undefined} weekdays */
function weekdayNames(weekdays) {
  return (weekdays ?? []).map((day) => WEEKDAY_NAMES[day - 1]).join("、");
}

/** @param {number[] | undefined} weekdays */
function weekdaySuffix(weekdays) {
  return weekdays ? `（仅${weekdayNames(weekdays)}）` : "";
}

/**
 * 是否落在允许的星期。没有 weekdays 表示每天允许。
 *
 * @param {Cadence} cadence
 * @param {Date} date
 */
function isAllowedWeekday(cadence, date) {
  if (cadence.kind === "manual") return true;
  return !cadence.weekdays || cadence.weekdays.includes(isoWeekday(date));
}

/**
 * 最近的 daily / weekly 到期点（含 weekdays 限制）。
 *
 * @param {Cadence & {kind: "daily" | "weekly"}} cadence
 * @param {Date} now
 */
function latestOccurrence(cadence, now) {
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = addDays(now, -offset);
    if (!isAllowedWeekday(cadence, day)) continue;
    const occurrence = atOn(day, cadence.at);
    if (occurrence <= now) return occurrence;
  }
  return addDays(now, -7);
}

/**
 * 下一个 daily / weekly 到期点（含 weekdays 限制）。
 *
 * @param {Cadence & {kind: "daily" | "weekly"}} cadence
 * @param {Date} now
 */
function nextOccurrence(cadence, now) {
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = addDays(now, offset);
    if (!isAllowedWeekday(cadence, day)) continue;
    const candidate = atOn(day, cadence.at);
    if (candidate > now) return candidate;
  }
  return null;
}

/**
 * 严格晚于 from 的下一个允许日的 00:00。
 *
 * @param {Cadence} cadence
 * @param {Date} from
 */
function nextAllowedDayStart(cadence, from) {
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = addDays(from, offset);
    if (!isAllowedWeekday(cadence, day)) continue;
    const start = atOn(day, "00:00");
    if (start > from) return start;
  }
  return null;
}

/** @param {string} at */
function atParts(at) {
  const [hours, minutes] = at.split(":").map(Number);
  return { hours, minutes };
}

/** @param {Date} day @param {string} at */
function atOn(day, at) {
  const { hours, minutes } = atParts(at);
  const result = new Date(day);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

/** @param {Date} date @param {number} days */
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** @param {Date} date */
function isoWeekday(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

/**
 * @param {Date | string} value
 * @param {string} label
 */
function toDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} 不是合法时间：${value}`);
  return date;
}

/** @param {string | null | undefined} value */
function toOptionalDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

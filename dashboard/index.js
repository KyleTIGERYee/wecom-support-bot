import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { attachTimelines, loadSessionFiles, redactText } from "./timeline.js";
import { capText, stringValue } from "./text.js";
import { toSessionKey } from "../src/wecom.js";

const DEFAULT_TIMEZONE = "Asia/Shanghai";

/**
 * 构建只读看板索引。所有输入都视为不可信数据；坏行只计数，不影响其他记录。
 *
 * @param {{sources: {
 *   instances: Array<{id: string, inboxPath: string, logPath: string, piDir: string, imagesDir: string}>,
 *   rawLogPath?: string,
 *   userMapPath?: string
 * }, timezone?: string}} options
 */
export async function buildDashboard({ sources, timezone = DEFAULT_TIMEZONE }) {
  const diagnostics = { badLines: 0, missingSources: 0, unmatchedTurns: 0, mappedTurns: 0 };
  /** @type {Map<string, any>} */
  const inboxById = new Map();
  /** @type {Map<string, any>} */
  const completionById = new Map();

  for (const instance of sources.instances) {
    const inboxRecords = await readJsonLines(instance.inboxPath, diagnostics);
    for (const record of inboxRecords) {
      if (typeof record.msgid !== "string" || !record.msgid) continue;
      const previous = inboxById.get(record.msgid);
      if (typeof record.question === "string") {
        if (!previous || previous.instanceId !== instance.id) {
          inboxById.set(record.msgid, { ...record, instanceId: instance.id, state: record.state === "running" ? "running" : "received" });
        }
      } else if (previous && typeof record.state === "string") {
        previous.state = record.state;
        if (typeof record.at === "string") previous.stateAt = record.at;
      }
    }

    const logRecords = await readBotLog(instance.logPath, diagnostics);
    for (const record of logRecords) {
      if (record.event !== "答复完成" || typeof record.detail?.msgid !== "string") continue;
      if (!completionById.has(record.detail.msgid)) {
        completionById.set(record.detail.msgid, { ...record.detail, completedAt: record.at, instanceId: instance.id });
      }
    }
  }

  const userMap = await readUserMap(sources.userMapPath, diagnostics);
  const rawById = await readRawInbound(sources.rawLogPath, diagnostics);
  const ids = new Set([...inboxById.keys(), ...completionById.keys()]);
  const turns = [...ids].map((msgid) => normalizeTurn(msgid, inboxById.get(msgid), completionById.get(msgid), rawById.get(msgid), userMap, timezone))
    .filter((turn) => turn.date)
    .sort((a, b) => a.receivedMs - b.receivedMs || a.id.localeCompare(b.id));
  const activeSessionKeys = new Set(turns.map((turn) => turn.completion?.sessionKey).filter((key) => typeof key === "string"));
  const sessionFiles = await loadSessionFiles(sources.instances, activeSessionKeys, diagnostics);
  attachTimelines(turns, sessionFiles, diagnostics);
  const imagesByTurn = await indexImages(turns, sources.instances);

  const dates = [...new Set(turns.map((turn) => turn.date))].sort();

  return {
    getMeta() {
      return { generatedAt: new Date().toISOString(), defaultDate: dates.at(-1) ?? null, dates, diagnostics: { ...diagnostics } };
    },
    /** @param {{date?: string|null, query?: string, colleagueId?: string, sessionKey?: string}} [filters] */
    getDay(filters = {}) {
      const date = filters.date || dates.at(-1) || null;
      const query = (filters.query ?? "").trim().toLocaleLowerCase("zh-CN");
      const selected = turns.filter((turn) => {
        if (turn.date !== date) return false;
        if (filters.colleagueId && turn.colleagueId !== filters.colleagueId) return false;
        if (filters.sessionKey && turn.sessionKey !== filters.sessionKey) return false;
        if (query && ![turn.colleagueName, turn.colleagueId, turn.question, turn.answer?.text ?? ""].some((value) => value.toLocaleLowerCase("zh-CN").includes(query))) return false;
        return true;
      });
      return buildDay(date, selected);
    },
    /** @param {string} msgid */
    getTurn(msgid) {
      const turn = turns.find((candidate) => candidate.id === msgid);
      if (!turn) return null;
      return {
        ...publicTurn(turn),
        answer: turn.answer,
        delivery: {
          channel: turn.channel,
          status: turn.failed ? "failed" : turn.delivered ? "delivered" : "pending",
          bodyArchived: false,
        },
        orchestration: turn.completion ? {
          route: turn.route,
          mode: stringValue(turn.completion.mode) || null,
          rounds: Number.isFinite(turn.completion.rounds) ? turn.completion.rounds : null,
          guarded: turn.guarded,
          exhausted: Boolean(turn.completion.exhausted),
          timedOut: Boolean(turn.completion.timedOut),
          stalled: Boolean(turn.completion.stalled),
          stallRetries: Number.isFinite(turn.completion.stallRetries) ? turn.completion.stallRetries : 0,
          loadDepth: stringValue(turn.completion.loadDepth) || null,
          approvals: approvalSummary(turn.completion.executionApprovals),
        } : null,
        timeline: turn.timeline,
        counts: turn.counts,
        images: turn.images.map((/** @type {any} */ image) => ({ index: image.index, mimeType: image.mimeType })),
      };
    },
    /** @param {string} msgid @param {any} index */
    getImage(msgid, index) {
      if (!Number.isInteger(index) || index < 1) return null;
      return imagesByTurn.get(msgid)?.get(index) ?? null;
    },
  };
}

/** @param {string} path @param {any} diagnostics @returns {Promise<any[]>} */
async function readJsonLines(path, diagnostics) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") diagnostics.missingSources += 1;
    return [];
  }
  const records = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed);
      else diagnostics.badLines += 1;
    } catch {
      diagnostics.badLines += 1;
    }
  }
  return records;
}

/** @param {string} path @param {any} diagnostics @returns {Promise<any[]>} */
async function readBotLog(path, diagnostics) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") diagnostics.missingSources += 1;
    return [];
  }
  const records = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^\[([^\]]+)\]\s+(INFO|WARN|ERROR)\s+(.*?)(?:\s+(\{.*\}))?\s*$/);
    if (!match) {
      diagnostics.badLines += 1;
      continue;
    }
    let detail = {};
    if (match[4]) {
      try { detail = JSON.parse(match[4]); } catch { diagnostics.badLines += 1; continue; }
    }
    records.push({ at: match[1], level: match[2], event: match[3], detail });
  }
  return records;
}

/** @param {string|undefined} path @param {any} diagnostics */
async function readRawInbound(path, diagnostics) {
  /** @type {Map<string, any>} */
  const messages = new Map();
  if (!path) return messages;
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") diagnostics.missingSources += 1;
    return messages;
  }
  for (const line of raw.split("\n")) {
    if (!line.includes("cmd=aibot_msg_callback") || !line.includes(" body=")) continue;
    const at = line.match(/^\[([^\]]+)\]/)?.[1];
    try {
      const frame = JSON.parse(line.slice(line.indexOf(" body=") + 6));
      const msgid = stringValue(frame?.msgid);
      if (!msgid || messages.has(msgid) || !validDate(at)) continue;
      const body = frame;
      let question = "";
      if (typeof body.text?.content === "string") question = body.text.content;
      else if (typeof body.voice?.content === "string") question = body.voice.content;
      else if (Array.isArray(body.mixed?.msg_item)) {
        question = body.mixed.msg_item
          .filter((/** @type {any} */ item) => item?.msgtype === "text" && typeof item.text?.content === "string")
          .map((/** @type {any} */ item) => item.text.content)
          .join(" ");
      }
      let imageCount = body.image?.url ? 1 : 0;
      if (Array.isArray(body.mixed?.msg_item)) {
        imageCount += body.mixed.msg_item.filter((/** @type {any} */ item) => item?.msgtype === "image" && item.image?.url).length;
      }
      messages.set(msgid, {
        question: question.replace(/^(?:@[^\s@]+\s+)+/, "").trim(),
        userId: stringValue(body.from?.userid),
        chatType: body.chattype === "group" ? "group" : "single",
        chatId: stringValue(body.chatid),
        receivedAt: at,
        imageCount,
      });
    } catch {
      diagnostics.badLines += 1;
    }
  }
  return messages;
}

/** @param {string|undefined} path @param {any} diagnostics */
async function readUserMap(path, diagnostics) {
  if (!path) return new Map();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed).filter(([, value]) => value && typeof value === "object" && typeof value.name === "string" && value.name.trim()));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") diagnostics.badLines += 1;
    else diagnostics.missingSources += 1;
    return new Map();
  }
}

/** @param {Map<string, any>} userMap @param {string} userId @param {any} sessionKey */
function findUserMapping(userMap, userId, sessionKey) {
  const direct = userMap.get(userId);
  if (direct) return direct;
  const candidates = new Set([toSessionKey(userId)]);
  if (typeof sessionKey === "string") candidates.add(sessionKey.replace(/-g\d+$/, ""));
  for (const mapping of userMap.values()) {
    if (typeof mapping.b64 !== "string" || !/^[A-Za-z0-9_-]+$/.test(mapping.b64)) continue;
    if (candidates.has(`wx-${mapping.b64}`)) return mapping;
  }
  return null;
}

/** @param {string} msgid @param {any} inbox @param {any} completion @param {any} raw @param {Map<string, any>} userMap @param {string} timezone @returns {any} */
function normalizeTurn(msgid, inbox, completion, raw, userMap, timezone) {
  const receivedAt = validDate(inbox?.receivedAt) ? inbox.receivedAt : validDate(raw?.receivedAt) ? raw.receivedAt : completion?.completedAt;
  const receivedMs = Date.parse(receivedAt ?? "");
  const userId = stringValue(inbox?.userId) || stringValue(raw?.userId) || "unknown";
  const mappedName = findUserMapping(userMap, userId, completion?.sessionKey)?.name?.trim();
  const durationMs = Number.isFinite(completion?.totalMs) && completion.totalMs >= 0 ? completion.totalMs : null;
  const channel = normalizeChannel(completion?.channel);
  const route = normalizeRoute(completion?.route);
  const guarded = completion?.guarded === true;
  const delivered = completion ? channel === "stream" || channel === "push" : inbox?.state === "answered";
  const failed = channel === "none" || inbox?.state === "failed";
  const question = capText(cleanQuestion(stringValue(inbox?.question) || stringValue(raw?.question)), 20000);
  const questionAnchor = stringValue(inbox?.question) || stringValue(raw?.question);
  return {
    id: msgid,
    colleagueId: userId,
    colleagueName: mappedName || `未识别用户 ${userId}`,
    sessionKey: stringValue(completion?.sessionKey) || `${userId}-unknown`,
    generation: generationOf(completion?.sessionKey),
    question: question.text,
    questionAnchor,
    questionTruncated: question.truncated,
    receivedAt,
    receivedMs,
    date: Number.isFinite(receivedMs) ? dateInTimezone(receivedMs, timezone) : null,
    chatType: inbox?.chatType === "group" || raw?.chatType === "group" ? "group" : "single",
    chatId: stringValue(inbox?.chatId) || stringValue(raw?.chatId),
    imageCount: Number.isInteger(raw?.imageCount) ? raw.imageCount : 0,
    state: stringValue(inbox?.state) || (completion ? "answered" : "received"),
    delivered,
    failed,
    channel,
    route,
    guarded,
    durationMs,
    instanceId: inbox?.instanceId ?? completion?.instanceId ?? null,
    completion,
  };
}

/** @param {any[]} turns @param {Array<{id: string, imagesDir: string}>} instances */
async function indexImages(turns, instances) {
  /** @type {Map<string, Map<number, {path: string, mimeType: string, index: number}>>} */
  const result = new Map();
  /** @type {Map<string, any[]>} */
  const filesByInstance = new Map();
  for (const instance of instances) {
    try {
      const entries = await readdir(instance.imagesDir, { withFileTypes: true });
      filesByInstance.set(instance.id, entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort());
    } catch {
      filesByInstance.set(instance.id, []);
    }
  }
  for (const turn of turns) {
    turn.images = [];
    const files = filesByInstance.get(turn.instanceId) ?? [];
    const prefix = `${turn.id.replace(/[^A-Za-z0-9_-]/g, "_")}-`;
    const images = new Map();
    for (const filename of files) {
      if (!filename.startsWith(prefix)) continue;
      const match = filename.slice(prefix.length).match(/^(\d+)\.(jpg|jpeg|png|gif|webp|bmp)$/i);
      if (!match) continue;
      const index = Number(match[1]);
      if (images.has(index)) continue;
      const mimeType = imageMime(extname(filename));
      if (!mimeType) continue;
      const image = { path: join(instances.find((instance) => instance.id === turn.instanceId)?.imagesDir ?? "", filename), mimeType, index };
      images.set(index, image);
      turn.images.push(image);
    }
    turn.images.sort((/** @type {any} */ a, /** @type {any} */ b) => a.index - b.index);
    if (images.size) result.set(turn.id, images);
  }
  return result;
}

/** @param {string} ext */
function imageMime(ext) {
  return ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" })[ext.toLowerCase()] ?? null;
}

/** @param {string|null} date @param {any[]} turns */
function buildDay(date, turns) {
  const durations = turns.map((turn) => turn.durationMs).filter((value) => value !== null);
  const summary = {
    questions: turns.length,
    activeColleagues: new Set(turns.map((turn) => turn.colleagueId)).size,
    sessions: new Set(turns.map((turn) => turn.sessionKey)).size,
    succeeded: turns.filter((turn) => turn.delivered && !turn.failed).length,
    failed: turns.filter((turn) => turn.failed).length,
    averageMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
  };
  /** @type {Map<string, any>} */
  const colleagues = new Map();
  /** @type {Map<string, any>} */
  const sessions = new Map();
  for (const turn of turns) {
    if (!colleagues.has(turn.colleagueId)) colleagues.set(turn.colleagueId, { colleagueId: turn.colleagueId, name: turn.colleagueName, questions: 0, sessions: new Set() });
    const colleague = colleagues.get(turn.colleagueId);
    colleague.questions += 1;
    colleague.sessions.add(turn.sessionKey);
    if (!sessions.has(turn.sessionKey)) {
      sessions.set(turn.sessionKey, { id: turn.sessionKey, generation: turn.generation, colleagueId: turn.colleagueId, colleagueName: turn.colleagueName, startedAt: turn.receivedAt, lastAt: turn.receivedAt, questions: 0, firstQuestion: turn.question, chatTypes: new Set() });
    }
    const session = sessions.get(turn.sessionKey);
    session.questions += 1;
    session.lastAt = turn.receivedAt;
    session.chatTypes.add(turn.chatType);
  }
  return {
    date,
    summary,
    colleagues: [...colleagues.values()].map((colleague) => ({ ...colleague, sessions: colleague.sessions.size })).sort((a, b) => b.questions - a.questions || a.name.localeCompare(b.name, "zh-CN")),
    sessions: [...sessions.values()].map((session) => ({ ...session, chatTypes: [...session.chatTypes] })).sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt)),
    turns: turns.map(publicTurn).reverse(),
  };
}

/** @param {any} turn */
function publicTurn(turn) {
  return {
    id: turn.id,
    colleagueId: turn.colleagueId,
    colleagueName: turn.colleagueName,
    sessionKey: turn.sessionKey,
    generation: turn.generation,
    question: turn.question,
    questionTruncated: turn.questionTruncated,
    receivedAt: turn.receivedAt,
    chatType: turn.chatType,
    state: turn.state,
    delivered: turn.delivered,
    failed: turn.failed,
    durationMs: turn.durationMs,
    channel: turn.channel,
    route: turn.route,
    guarded: turn.guarded,
    answerPreview: turn.answer?.text ? turn.answer.text.slice(0, 240) : "",
    hasTimeline: Boolean(turn.timeline?.length),
    imageCount: turn.imageCount,
  };
}

/** @param {any} approvals */
function approvalSummary(approvals) {
  const rows = Array.isArray(approvals) ? approvals : [];
  return {
    total: rows.length,
    allowed: rows.filter((row) => row?.verdict === "ALLOW").length,
    denied: rows.filter((row) => row?.verdict === "DENY").length,
  };
}

/** @param {string} value */
function cleanQuestion(value) { return redactText(value.split("\n\n[系统补充]", 1)[0]).trim(); }
/** @param {any} value */
function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
/** @param {any} value */
function normalizeRoute(value) { return value === "quick" || value === "deep" ? value : null; }
/** @param {any} value */
function normalizeChannel(value) { return value === "stream" || value === "push" || value === "none" ? value : null; }
/** @param {any} sessionKey */
function generationOf(sessionKey) {
  const match = typeof sessionKey === "string" ? sessionKey.match(/-g(\d+)$/) : null;
  return match ? Number(match[1]) : null;
}
/** @param {number} timestamp @param {string} timezone */
function dateInTimezone(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(timestamp);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

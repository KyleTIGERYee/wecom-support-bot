import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * 自动发现本机可看的机器人实例，不依赖固定实例名或某台机器的项目路径。
 *
 * 默认扫描 `~/.wecom-support-bot/instances/*` 与仓库 `instances/*`；两者都是
 * `local-instance.js init --instance-dir` 的常见落点。显式传入的实例目录优先。
 * 仓库根目录若有旧的 `data/inbox.jsonl`，作为 legacy 实例一并展示。
 *
 * @param {{projectDir: string, homeDir?: string, instanceDirs?: string[], rawLogPath?: string}} options
 */
export async function createDefaultDashboardSources({ projectDir, homeDir = homedir(), instanceDirs = [], rawLogPath: explicitRawLogPath }) {
  /** @type {string[]} */
  const candidates = [];
  const seen = new Set();
  /** @param {string} dir */
  const addCandidate = (dir) => {
    if (typeof dir !== "string" || !dir.trim()) return;
    const resolved = resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push(resolved);
  };

  for (const dir of instanceDirs) addCandidate(dir);
  for (const root of [join(homeDir, ".wecom-support-bot/instances"), join(projectDir, "instances")]) {
    for (const entry of await readDirEntries(root)) {
      if (entry.isDirectory()) addCandidate(join(root, entry.name));
    }
  }

  /** @type {string[]} */
  const usedIds = [];
  /** @type {any[]} */
  const instances = [];
  for (const dir of candidates) {
    if (!(await isInstanceDir(dir))) continue;
    instances.push(await buildInstance(dir, usedIds));
  }

  // 旧版直接跑在仓库根目录的实例（没有 instance.json，只有 data/inbox.jsonl）
  const legacyInbox = join(projectDir, "data/inbox.jsonl");
  if (await exists(legacyInbox)) {
    instances.push({
      id: uniqueId("legacy", usedIds),
      inboxPath: legacyInbox,
      logPath: join(projectDir, "logs/bot.log"),
      piDir: await findSessionsDir(join(homeDir, ".pi-support/agent/sessions")),
      imagesDir: join(projectDir, "data/images"),
    });
  }

  const globalUserMap = join(homeDir, ".wecom-support-bot/user-map.json");
  const rawLogPath = explicitRawLogPath ? resolve(explicitRawLogPath) : join(projectDir, "logs/launchd.stdout.log");
  return {
    instances,
    ...(await exists(globalUserMap) ? { userMapPath: globalUserMap } : {}),
    userMapPaths: instances.map((instance) => instance.userMapPath).filter(Boolean),
    ...(await exists(rawLogPath) ? { rawLogPath } : {}),
  };
}

/** @param {string} dir @param {string[]} usedIds */
async function buildInstance(dir, usedIds) {
  const userMapPath = join(dir, "data/user-map.json");
  return {
    id: uniqueId(basename(dir) || "instance", usedIds),
    inboxPath: join(dir, "data/inbox.jsonl"),
    logPath: join(dir, "logs/bot.log"),
    piDir: await findSessionsDir(join(dir, "agent/sessions")),
    imagesDir: join(dir, "data/images"),
    ...(await exists(userMapPath) ? { userMapPath } : {}),
  };
}

/** 实例目录至少要有 instance.json 或收件箱，避免把普通目录当成实例。 @param {string} dir */
async function isInstanceDir(dir) {
  return await exists(join(dir, "instance.json")) || await exists(join(dir, "data/inbox.jsonl"));
}

/**
 * pi 的会话目录按项目工作目录命名；这里不猜命名规则，直接取 sessions 下最新的子目录。
 * 没有子目录时返回 sessions 自身，让上层按缺数据统计。
 *
 * @param {string} sessionsDir
 */
async function findSessionsDir(sessionsDir) {
  const entries = await readDirEntries(sessionsDir);
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(sessionsDir, entry.name));
  if (dirs.length <= 1) return dirs[0] ?? sessionsDir;
  let newest = dirs[0];
  let newestMs = -1;
  for (const dir of dirs) {
    const info = await stat(dir).catch(() => null);
    if (info && info.mtimeMs > newestMs) {
      newestMs = info.mtimeMs;
      newest = dir;
    }
  }
  return newest;
}

/** @param {string} base @param {string[]} usedIds */
function uniqueId(base, usedIds) {
  let id = base;
  let suffix = 2;
  while (usedIds.includes(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.push(id);
  return id;
}

/** @param {string} dir */
async function readDirEntries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** @param {string} path */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

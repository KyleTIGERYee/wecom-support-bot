import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { copyFile, cp, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runAgentTurn } from "../src/agent.js";
import {
  createSourcePathFilter,
  isSensitiveName,
  scanInventory,
} from "../src/instance-inventory.js";
import { CADENCE_KINDS, buildSchedule, cadenceText, isDue, nextDueAt, normalizeCadence } from "../src/sync-plan.js";
import {
  assertUniqueSourceNames,
  canonicalSourceKey,
  findRegisteredSource,
  normalizeSource,
  parseGitlabSource,
  pathsOverlap,
  redactSourceCredentials,
  resolveRealPath,
} from "../src/source-spec.js";
import { acquireLock, releaseLock } from "../src/lock.js";
import { createGuardClient, createQuickClient } from "../src/model-client.js";
import { handleTurn } from "../src/orchestrate.js";
import { reviewReply } from "../src/guard.js";
import { classifyQuestion } from "../src/route.js";
import { createSessionState } from "../src/session-state.js";
import { createLocalResourceCatalog } from "../src/resource-catalog.js";
import { createLocalRuntimeConfig as createSharedLocalRuntimeConfig } from "../src/local-instance-config.js";

const execFileAsync = promisify(execFile);
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "ask") {
    await ask(args);
    return;
  }
  if (command === "configure-bi") {
    await configureBi(args);
    return;
  }
  if (command === "init") {
    await init(args);
    return;
  }
  if (command === "sync") {
    await sync(args);
    return;
  }
  if (command === "status") {
    await status(args);
    return;
  }
  if (command === "export") {
    await exportInstance(args);
    return;
  }
  if (command === "inventory") {
    await inventory(args);
    return;
  }
  if (command === "plan") {
    await plan(args);
    return;
  }
  if (command === "sync-due") {
    await syncDue(args);
    return;
  }
  if (command === "schedule") {
    await schedule(args);
    return;
  }
  throw new Error(
    "用法：local-instance.js init|ask|sync|status|export|configure-bi|inventory|plan|sync-due|schedule [选项]",
  );
}

async function configureBi(args) {
  const options = parseConfigureBiArgs(args);
  const instanceDir = resolve(options.instanceDir);
  const [defaults, saved] = await Promise.all([
    readFile(join(projectDir, "config/default.json"), "utf8").then(JSON.parse),
    readFile(join(instanceDir, "instance.json"), "utf8").then(JSON.parse),
  ]);
  const knowledgeBase = defaults.roots?.knowledgeBase;
  if (typeof knowledgeBase !== "string" || !isAbsolute(knowledgeBase)) {
    throw new Error("config/default.json 缺少绝对路径 roots.knowledgeBase，无法确定默认可信 BI 目录");
  }
  if (!isAbsolute(options.script)) throw new Error("configure-bi 的 --script 必须是绝对路径");

  let realScript;
  let realDefaultScript;
  try {
    realScript = await realpath(options.script);
    const defaultScript = join(knowledgeBase, "数据库", `${options.business}-db-wiki`, "scripts", "bi_query.py");
    realDefaultScript = join(await realpath(dirname(defaultScript)), "bi_query.py");
  } catch {
    throw new Error("BI 脚本或对应业务线的默认可信目录不存在、悬空或无法解析");
  }
  if (!(await stat(realScript)).isFile()) throw new Error("BI 脚本真实路径必须是文件");
  if (realScript !== realDefaultScript) {
    throw new Error(`BI 脚本必须解析到 ${options.business} 默认可信目录中的 bi_query.py，不能登记任意副本`);
  }

  const blockedRoots = [join(instanceDir, "context"), join(instanceDir, "workspace"), projectDir];
  for (const root of blockedRoots) {
    let realRoot;
    try {
      realRoot = await realpath(root);
    } catch {
      throw new Error(`无法解析写根或保护根，配置已拒绝：${root}`);
    }
    if (realScript === realRoot || realScript.startsWith(`${realRoot}/`)) {
      throw new Error("context、workspace 写根与 project 保护根及其别名不能登记为可信 BI");
    }
  }
  if (
    saved.trustedDataScripts !== undefined &&
    (!saved.trustedDataScripts || typeof saved.trustedDataScripts !== "object" || Array.isArray(saved.trustedDataScripts))
  ) {
    throw new Error("instance.json 的 trustedDataScripts 必须是按业务线登记的对象");
  }
  saved.trustedDataScripts = { ...saved.trustedDataScripts, [options.business]: realScript };
  if (saved.syncPlan !== undefined) saved.syncPlan = normalizeSyncPlan(saved);
  await writeJson(join(instanceDir, "instance.json"), saved);
  process.stdout.write(`${JSON.stringify({ status: "ok", instanceDir, business: options.business, script: realScript })}\n`);
}

async function inventory(args) {
  const options = parseInventoryArgs(args);
  const result = await scanInventory({
    roots: options.roots,
    maxDepth: options.maxDepth,
    exclude: options.exclude,
    symlinks: options.symlinks,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function plan(args) {
  const options = parsePlanArgs(args);
  const instanceDir = resolve(options.instanceDir);
  await assertSafeInstanceDir(instanceDir);
  const saved = await readInstanceConfig(instanceDir);
  const registry = await readSourceRegistry(instanceDir);
  await assertNoDuplicateSourceNames(
    (saved.contextSources ?? []).map((source) => ({
      name: source.name,
      type: source.type,
      path: registry[source.name]?.path,
    })),
  );
  const rawPlanSources = Array.isArray(saved.syncPlan?.sources) ? saved.syncPlan.sources : [];
  saved.syncPlan = ensurePlanEntries(saved, registry);
  const hasUnknownPlanFields = rawPlanSources.some(
    (entry) => entry && typeof entry === "object" && Object.keys(entry).some((key) => !PLAN_FIELDS.includes(key)),
  );
  let changed = hasUnknownPlanFields || saved.syncPlan.sources.length !== rawPlanSources.length;
  if (options.source) {
    const updated = await applyPlanUpdate(saved, options, instanceDir);
    saved.syncPlan = { sources: updated.sources };
    saved.contextSources = updated.contextSources;
    changed = true;
    await writeJson(join(instanceDir, "instance.json"), saved);
    process.stdout.write(`${JSON.stringify({ instanceDir, updated: updated.name, ...buildPlanView(saved) })}\n`);
    return;
  }
  if (changed) await writeJson(join(instanceDir, "instance.json"), saved);
  process.stdout.write(`${JSON.stringify({ instanceDir, ...buildPlanView(saved) })}\n`);
}

/**
 * 首次运行 plan 时为所有 contextSources 补齐计划条目：
 * 默认 enabled、manual 频率。登记阶段写入 registry 的 exclude / symlinks 在此沿用，
 * 之后以计划条目为准。未登记来源不会因为“未登记”在同步时被删掉。
 *
 * @param {any} saved
 * @param {Record<string, {exclude?: string[], symlinks?: string}>} [registry]
 */
function ensurePlanEntries(saved, registry = {}) {
  const plan = normalizeSyncPlan(saved);
  const known = new Set(plan.sources.map((entry) => entry.name));
  const additions = (Array.isArray(saved.contextSources) ? saved.contextSources : [])
    .filter((source) => typeof source?.name === "string" && !known.has(source.name))
    .map((source) => {
      const registered = registry?.[source.name] ?? {};
      return {
        name: source.name,
        scope: source.scope === "private" ? "private" : "shared",
        exclude: Array.isArray(registered.exclude) ? registered.exclude : [],
        symlinks: registered.symlinks ?? "follow",
        cadence: { kind: "manual" },
        enabled: true,
        lastRunAt: null,
        lastStatus: null,
        lastVersion: null,
      };
    });
  if (additions.length === 0) return plan;
  return { sources: [...plan.sources, ...additions] };
}

async function syncDue(args) {
  const options = parseSyncDueArgs(args);
  const instanceDir = resolve(options.instanceDir);
  await assertSafeInstanceDir(instanceDir);
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now 不是合法 ISO 8601 时间：${options.now}`);
  let saved = await readInstanceConfig(instanceDir);
  let registry = await readSourceRegistry(instanceDir);
  let plan = ensurePlanEntries(saved, registry);
  saved.syncPlan = plan;
  let enabled = plan.sources.filter((entry) => entry.enabled !== false);
  let due = enabled.filter((entry) => isDue(entry.cadence, entry.lastRunAt, now));
  let sourceSet = buildSyncDueSourceSet(saved, plan, registry);
  await markCarriedSources(instanceDir, saved, sourceSet.sources, due);
  assertUniqueSourceNameList(sourceSet.sources);
  await assertNoDuplicateSourceNames(sourceSet.sources);
  if (options.dryRun) {
    const view = buildPlanView(saved, now);
    process.stdout.write(
      `${JSON.stringify({
        dryRun: true,
        ran: false,
        checkedAt: now.toISOString(),
        due: due.map((entry) => entry.name),
        removed: sourceSet.removed,
        sources: view.sources,
      })}\n`,
    );
    return;
  }
  if (due.length === 0) {
    process.stdout.write(`${JSON.stringify({ ran: false, checkedAt: now.toISOString(), due: [], removed: [] })}\n`);
    return;
  }

  const lockPath = join(instanceDir, "data/sync.lock");
  const lock = await acquireLock({ lockPath });
  if (!lock.acquired) {
    process.stdout.write(
      `${JSON.stringify({
        ran: false,
        locked: true,
        holder: lock.holder ?? null,
        reason: lock.reason ?? "同步锁被占用",
        due: due.map((entry) => entry.name),
        removed: [],
      })}\n`,
    );
    return;
  }
  try {
    // 拿锁后重读：另一个进程可能刚完成计划更新或同步。
    saved = await readInstanceConfig(instanceDir);
    registry = await readSourceRegistry(instanceDir);
    plan = ensurePlanEntries(saved, registry);
    saved.syncPlan = plan;
    enabled = plan.sources.filter((entry) => entry.enabled !== false);
    due = enabled.filter((entry) => isDue(entry.cadence, entry.lastRunAt, now));
    sourceSet = buildSyncDueSourceSet(saved, plan, registry);
    await markCarriedSources(instanceDir, saved, sourceSet.sources, due);
    assertUniqueSourceNameList(sourceSet.sources);
    await assertNoDuplicateSourceNames(sourceSet.sources);
    if (due.length === 0) {
      process.stdout.write(`${JSON.stringify({ ran: false, checkedAt: now.toISOString(), due: [], removed: [] })}\n`);
      return;
    }
    const syncedNames = new Set(sourcesToRead(sourceSet.sources).map((source) => source.name));
    const outcome = await runSyncOnce({
      instanceDir,
      sources: sourceSet.sources,
      operation: "sync-due",
      now,
      saved,
      plan,
      due,
      markPlanSources: syncedNames,
      preserveDisabled: true,
    });
    let planUpdateError = null;
    if (!outcome.ok) {
      try {
        await markPlanSourcesError(instanceDir, syncedNames);
      } catch (error) {
        planUpdateError = error?.message ?? String(error);
      }
    }
    process.stdout.write(
      `${JSON.stringify({
        ...outcome.result,
        removed: outcome.ok ? sourceSet.removed : [],
        ...(planUpdateError ? { planUpdateError } : {}),
      })}\n`,
    );
    if (!outcome.ok) process.exitCode = 1;
  } finally {
    await releaseLock({ lockPath });
  }
}

/**
 * 整包同步集合 = 全部 contextSources；只有显式 disabled 才移除副本。
 * 未登记来源按 manual 处理，仍参与整包同步。
 *
 * 原始来源路径保存在实例内独立的 data/source-registry.json（不进入 instance.json，
 * 也不进入团队包），未逐项登记计划的来源仍能按 manual 参与整包同步。
 *
 * @param {any} saved
 * @param {{sources: any[]}} plan
 * @param {Record<string, {path?: string, type?: string, ref?: string}>} registry
 */
function buildSyncDueSourceSet(saved, plan, registry = {}) {
  const entries = new Map(plan.sources.map((entry) => [entry.name, entry]));
  const contextSources = Array.isArray(saved.contextSources) ? saved.contextSources : [];
  const sources = [];
  const removed = [];
  contextSources.forEach((source, index) => {
    const entry = entries.get(source.name) ?? null;
    if (entry?.enabled === false || (!entry && source.status === "disabled")) {
      removed.push(source.name);
      return;
    }
    const registryEntry = registry[source.name] ?? null;
    sources.push({
      slot: index + 1,
      name: source.name,
      path: registryEntry?.path ?? null,
      type: registryEntry?.type ?? source.type ?? "auto",
      scope: entry?.scope ?? source.scope,
      exclude: entry?.exclude ?? source.exclude ?? [],
      symlinks: entry?.symlinks ?? source.symlinks ?? "follow",
      includeSecrets: source.includeSecrets === true,
      ...(registryEntry?.ref ? { ref: registryEntry.ref } : {}),
    });
  });
  return { sources, removed };
}

/**
 * 未到期来源沿用实例内已有副本：只检查 context/<slot>-<name>，绝不读原始来源。
 * 标记为 carried 的来源在复制阶段硬链接，不重新从原始路径复制。
 * 没有现成副本（或副本为空）的来源保持原样，仍按到期处理从原始来源复制。
 *
 * @param {string} instanceDir
 * @param {any} saved
 * @param {any[]} sources
 * @param {any[]} due
 */
async function markCarriedSources(instanceDir, saved, sources, due) {
  const dueNames = new Set((Array.isArray(due) ? due : []).map((entry) => entry.name));
  const known = new Map(
    (Array.isArray(saved.contextSources) ? saved.contextSources : [])
      .filter((source) => typeof source?.name === "string" && source.status === "ok" && typeof source.localPath === "string")
      .map((source) => [source.name, source.localPath]),
  );
  for (const source of sources) {
    if (dueNames.has(source.name)) continue;
    const localPath = known.get(source.name) ?? join("context", `${String(source.slot).padStart(3, "0")}-${source.name}`);
    if (await hasUsableContextCopy(instanceDir, localPath)) source.carried = localPath;
  }
}

/** @param {string} instanceDir @param {string} localPath */
async function hasUsableContextCopy(instanceDir, localPath) {
  const target = join(instanceDir, localPath);
  try {
    const info = await stat(target);
    if (info.isFile()) return true;
    if (!info.isDirectory()) return false;
    return (await listLocalFiles(target)).length > 0;
  } catch {
    return false;
  }
}

/** 沿用来源不读原始路径，因此不参与基于真实路径的来源查重。 @param {any[]} sources */
function sourcesToRead(sources) {
  return sources.filter((source) => typeof source?.carried !== "string");
}

/**
 * 名称唯一性对全部来源生效：沿用来源不读原始路径，但仍不能借“沿用”绕过重复名检查。
 * @param {any[]} sources
 */
function assertUniqueSourceNameList(sources) {
  const seen = new Set();
  for (const source of Array.isArray(sources) ? sources : []) {
    const name = typeof source?.name === "string" ? source.name : "";
    if (!name) continue;
    if (seen.has(name)) throw new Error(`来源名称重复，同一实例内来源名必须唯一：${name}`);
    seen.add(name);
  }
}

/**
 * 把实例内已有副本硬链接进暂存目录。硬链接与复制内容一致，但提交后删除旧 context
 * 只减少一个链接，新副本仍然有效；跨设备或链接失败时回退为复制文件。
 *
 * @param {{instanceDir: string, stagingDir: string, localPath: string}} options
 */
async function carryExistingSource({ instanceDir, stagingDir, localPath }) {
  const sourcePath = join(instanceDir, localPath);
  const targetPath = join(stagingDir, localPath);
  const info = await stat(sourcePath);
  if (info.isFile()) {
    await mkdir(dirname(targetPath), { recursive: true });
    await linkOrCopyFile(sourcePath, targetPath);
    return;
  }
  await linkOrCopyTree(sourcePath, targetPath);
}

/** @param {string} sourcePath @param {string} targetPath */
async function linkOrCopyTree(sourcePath, targetPath) {
  await mkdir(targetPath, { recursive: true });
  const entries = await readdir(sourcePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const from = join(sourcePath, entry.name);
    const to = join(targetPath, entry.name);
    if (entry.isDirectory()) await linkOrCopyTree(from, to);
    else if (entry.isFile()) await linkOrCopyFile(from, to);
  }
}

/** @param {string} sourcePath @param {string} targetPath */
async function linkOrCopyFile(sourcePath, targetPath) {
  try {
    await link(sourcePath, targetPath);
  } catch {
    await copyFile(sourcePath, targetPath);
  }
}

async function schedule(args) {
  const options = parseScheduleArgs(args);
  const instanceDir = resolve(options.instanceDir);
  await assertSafeInstanceDir(instanceDir);
  const saved = await readInstanceConfig(instanceDir);
  const generated = buildSchedule({
    platform: options.platform,
    instanceDir,
    instanceId: saved.instance?.id ?? "instance",
    nodePath: process.execPath,
    cliPath: join(projectDir, "scripts/local-instance.js"),
    tickMinutes: options.tickMinutes,
    home: resolve(options.home),
  });

  // `--dry-run` 与默认行为完全等价：不指定 --install/--uninstall 时本来就只生成、不落盘。
  // 显式写出来只是让调用方无需记住默认值，两者走同一条预览路径。
  const dryRun = options.dryRun || (!options.install && !options.uninstall);
  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify({
        dryRun: true,
        status: "ok",
        platform: generated.platform,
        label: generated.label,
        tickMinutes: generated.tickMinutes,
        logPath: generated.logPath,
        units: generated.units,
        commands: generated.installCommands,
      })}\n`,
    );
    return;
  }

  if (!options.yes) {
    process.stdout.write(
      `${JSON.stringify({
        dryRun: true,
        status: "error",
        action: options.install ? "install" : "uninstall",
        requiresConfirmation: true,
        reason: "需要用户明确同意后加 --yes；请先把将要写入的文件与将要执行的系统命令展示给用户，取得明确同意后再执行",
        platform: generated.platform,
        label: generated.label,
        tickMinutes: generated.tickMinutes,
        logPath: generated.logPath,
        units: generated.units,
        commands: options.install ? generated.installCommands : generated.uninstallCommands,
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (options.install) {
    await mkdir(join(instanceDir, "logs"), { recursive: true });
    for (const unit of generated.units) {
      await mkdir(dirname(unit.path), { recursive: true });
      await writeFile(unit.path, unit.content, { encoding: "utf8", mode: 0o644 });
    }
    const commands = await runScheduleCommands(generated.installCommands);
    const failed = commands.some((command) => command.status === "error");
    process.stdout.write(
      `${JSON.stringify({
        status: failed ? "error" : "ok",
        platform: generated.platform,
        installed: generated.units.map((unit) => unit.path),
        logPath: generated.logPath,
        commands,
      })}\n`,
    );
    if (failed) process.exitCode = 1;
    return;
  }

  const commands = await runScheduleCommands(generated.uninstallCommands);
  const removed = [];
  for (const unit of generated.units) {
    if (await pathExists(unit.path)) {
      await rm(unit.path, { force: true });
      removed.push(unit.path);
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      status: commands.some((command) => command.status === "error") ? "error" : "ok",
      platform: generated.platform,
      removed,
      commands,
    })}\n`,
  );
  if (commands.some((command) => command.status === "error")) process.exitCode = 1;
}

async function runScheduleCommands(commands) {
  const results = [];
  for (const command of commands) {
    try {
      const { stdout } = await execFileAsync(command.command, command.args);
      results.push({
        command: command.command,
        args: command.args,
        status: "ok",
        ...(stdout.trim() ? { stdout: stdout.trim() } : {}),
      });
    } catch (error) {
      results.push({
        command: command.command,
        args: command.args,
        status: command.ignoreFailure ? "ignored" : "error",
        reason: error?.message ?? String(error),
      });
      if (!command.ignoreFailure) break;
    }
  }
  return results;
}

async function readInstanceConfig(instanceDir) {
  return JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
}

const SOURCE_REGISTRY_PATH = "data/source-registry.json";

/**
 * 原始来源路径、类型、--ref 与复制选项（--exclude / --symlinks）只登记在实例内的
 * data/source-registry.json，不写进 instance.json（实例可整体搬移）也不进入团队包。
 * 它服务定时同步的重新复制，并在首次补齐同步计划时作为 exclude / symlinks 的默认值。
 *
 * @param {string} instanceDir
 * @returns {Promise<Record<string, {path?: string, type?: string, ref?: string, exclude?: string[], symlinks?: string}>>}
 */
async function readSourceRegistry(instanceDir) {
  try {
    const value = JSON.parse(await readFile(join(instanceDir, SOURCE_REGISTRY_PATH), "utf8"));
    return value && typeof value.sources === "object" && value.sources !== null && !Array.isArray(value.sources)
      ? value.sources
      : {};
  } catch {
    return {};
  }
}

/**
 * 把本次登记合并进暂存目录。registry 与 context / instance.json / sync-status
 * 一起由 commitContext 原子替换，失败时全部回滚，不在事务外单独落盘。
 *
 * @param {string} instanceDir
 * @param {string} stagingDir
 * @param {{name: string, path?: string, type?: string, ref?: string, exclude?: string[], symlinks?: string}[]} entries
 * @returns {Promise<boolean>}
 */
async function stageSourceRegistry(instanceDir, stagingDir, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const sources = await readSourceRegistry(instanceDir);
  let changed = false;
  for (const entry of entries) {
    if (!entry?.name || typeof entry.path !== "string") continue;
    sources[entry.name] = {
      path: entry.path,
      ...(entry.type ? { type: entry.type } : {}),
      ...(entry.ref ? { ref: entry.ref } : {}),
      exclude: Array.isArray(entry.exclude) ? entry.exclude : [],
      symlinks: entry.symlinks ?? "follow",
    };
    changed = true;
  }
  if (!changed) return false;
  const stagedPath = join(stagingDir, SOURCE_REGISTRY_PATH);
  await mkdir(dirname(stagedPath), { recursive: true });
  await writeJson(stagedPath, { version: 1, sources });
  return true;
}

/** syncPlan 条目只允许这些字段；原始路径与类型只存在于 data/source-registry.json。 */
const PLAN_FIELDS = ["name", "cadence", "exclude", "symlinks", "scope", "enabled", "lastRunAt", "lastStatus", "lastVersion"];

function normalizeSyncPlan(saved) {
  const plan = saved?.syncPlan;
  const sources = Array.isArray(plan?.sources)
    ? plan.sources
        .filter((entry) => entry && typeof entry === "object" && typeof entry.name === "string")
        .map((entry) => Object.fromEntries(PLAN_FIELDS.filter((field) => entry[field] !== undefined).map((field) => [field, entry[field]])))
    : [];
  return { sources };
}

async function applyPlanUpdate(saved, options, instanceDir) {
  const registry = await readSourceRegistry(instanceDir);
  const registered = await findRegisteredSource(registry, options.source, { instanceDir });
  const contextSources = Array.isArray(saved.contextSources) ? saved.contextSources : [];
  const contextSource = contextSources.find((source) => source.name === registered.name);
  if (!contextSource) {
    throw new Error(`来源已登记但没有对应的标准资源副本：${registered.name}；请先运行 init 或 sync`);
  }
  const plan = normalizeSyncPlan(saved);
  const existing = plan.sources.find((entry) => entry.name === registered.name) ?? null;
  const cadence = options.cadence ?? existing?.cadence;
  if (!cadence) throw new Error("首次为来源配置同步计划需要 --cadence");
  const scope = options.scope ?? existing?.scope ?? contextSource.scope;
  if (!["shared", "private"].includes(scope)) throw new Error("--scope 必须是 shared 或 private");
  if (saved.instance?.template === "team" && scope !== "shared") {
    throw new Error("团队实例只能使用明确共享的来源");
  }
  const symlinks = options.symlinks ?? existing?.symlinks ?? "follow";
  if (options.includeSecrets === true && scope !== "private") {
    throw new Error("--include-secrets 只能用于 private 来源；shared 来源不得包含凭证文件");
  }
  // 切回 shared 时自动撤销该来源的凭证复制，shared 永远不携带敏感文件。
  const includeSecrets = scope === "private" ? options.includeSecrets ?? (contextSource.includeSecrets === true) : false;
  const exclude = options.clearExcludes ? [] : options.exclude.length > 0 ? options.exclude : existing?.exclude ?? [];
  const enabled = options.disable ? false : options.enable ? true : existing?.enabled ?? true;
  const entry = {
    name: registered.name,
    scope,
    exclude,
    symlinks,
    cadence,
    enabled,
    lastRunAt: existing?.lastRunAt ?? null,
    lastStatus: existing?.lastStatus ?? null,
    lastVersion: existing?.lastVersion ?? null,
  };
  return {
    name: entry.name,
    sources: existing
      ? plan.sources.map((candidate) => (candidate.name === entry.name ? entry : candidate))
      : [...plan.sources, entry],
    contextSources: contextSources.map((source) =>
      source.name === entry.name ? { ...source, includeSecrets } : source,
    ),
  };
}

function buildPlanView(saved, now = new Date()) {
  const plan = normalizeSyncPlan(saved);
  const contextByName = new Map((saved.contextSources ?? []).map((source) => [source.name, source]));
  const sources = plan.sources.map((entry) => {
    const context = contextByName.get(entry.name);
    try {
      return {
        ...entry,
        ...(context?.secretsIncluded ? { secretsIncluded: true, secretFiles: context.secretFiles ?? [] } : {}),
        cadenceText: cadenceText(entry.cadence),
        due: entry.enabled !== false ? isDue(entry.cadence, entry.lastRunAt, now) : false,
        nextDueAt: entry.enabled !== false ? nextDueAt(entry.cadence, entry.lastRunAt, now) : null,
      };
    } catch (error) {
      return {
        ...entry,
        cadenceText: "无效",
        due: false,
        nextDueAt: null,
        error: error?.message ?? String(error),
      };
    }
  });
  const nextSyncAt = sources.map((source) => source.nextDueAt).filter(Boolean).sort()[0] ?? null;
  const planned = new Set(sources.map((source) => source.name));
  return {
    checkedAt: now.toISOString(),
    sources,
    nextSyncAt,
    unplanned: (saved.contextSources ?? [])
      .filter((source) => !planned.has(source.name))
      .map((source) => source.name),
  };
}

async function markPlanSourcesError(instanceDir, names) {
  const saved = await readInstanceConfig(instanceDir);
  const plan = normalizeSyncPlan(saved);
  if (plan.sources.length === 0) return;
  saved.syncPlan = {
    ...plan,
    sources: plan.sources.map((entry) => (names.has(entry.name) ? { ...entry, lastStatus: "error" } : entry)),
  };
  await writeJson(join(instanceDir, "instance.json"), saved);
}

async function init(args) {
  const options = parseInitArgs(args);
  const instanceDir = resolve(options.instanceDir);
  await assertSafeInstanceDir(instanceDir);
  await mkdir(join(instanceDir, "workspace"), { recursive: true });
  const stagingDir = await createStagingDir(instanceDir);
  const importing = ["import", "existing"].includes(options.template);
  if (importing && !options.importPackage) throw new Error("既有实例导入需要 --package");
  let importedPackage = null;
  let contextSources;
  let sourceRegistry = [];
  if (importing) {
    const packageDir = join(stagingDir, "package");
    await mkdir(packageDir, { recursive: true });
    await extractPackage(resolve(options.importPackage), packageDir);
    importedPackage = await readImportedPackage(packageDir);
    contextSources = await copyImportedSources(stagingDir, packageDir, importedPackage.config.contextSources);
  } else {
    const copied = await copySources({ instanceDir, stagingDir, sources: options.sources, template: options.template });
    contextSources = copied.contextSources;
    sourceRegistry = copied.registry;
  }
  applyModelDefaults(options, importedPackage?.config.models ?? {});
  const syncedAt = new Date().toISOString();
  const version = await hashSources(stagingDir, contextSources);
  for (const source of contextSources) {
    if (source.status === "ok") source.version = version;
  }
  const manifest = await manifestHashes(stagingDir, contextSources);
  const resources = {
    version,
    catalogVersion: version,
    syncedAt,
    files: manifest.files,
    fileHashes: manifest.fileHashes,
    ...(importedPackage ? { importedFromVersion: importedPackage.config.resources?.version ?? null } : {}),
  };

  const mainModel = await checkModel(options.baseUrl, options.apiKey, options.model);
  const quickModel = sameModel(options, "quick")
    ? { ...mainModel, checkedAs: "main" }
    : await checkModel(options.quickBaseUrl, options.quickApiKey, options.quickModel);
  const approvalModel = sameModel(options, "approval")
    ? { ...mainModel, checkedAs: "main" }
    : await checkModel(options.approvalBaseUrl, options.approvalApiKey, options.approvalModel);
  const guardModel = await checkModel(options.guardBaseUrl, options.guardApiKey, options.guardModel);
  const sourcesReady = contextSources.length > 0 && contextSources.every((source) => source.status === "ok");
  const contextCheck =
    contextSources.length === 0
      ? { status: "error", executed: true, reason: "未选择本地上下文来源" }
      : { status: sourcesReady ? "ok" : "error", executed: true };
  let catalog = null;
  let catalogError = null;
  try {
    catalog = await createLocalResourceCatalog(stagingDir, contextSources, syncedAt);
  } catch (error) {
    catalogError = error?.message ?? String(error);
  }
  const secrets = {
    mainApiKey: options.apiKey,
    quickApiKey: options.quickApiKey,
    guardApiKey: options.guardApiKey,
    executionApprovalApiKey: options.approvalApiKey,
  };
  const config = {
    version: 2,
    ready: false,
    instance: { id: randomUUID(), template: importing ? "team" : options.template, ...(importing ? { imported: true } : {}) },
    initializedAt: syncedAt,
    models: {
      main: { baseUrl: options.baseUrl, model: options.model },
      quick: { baseUrl: options.quickBaseUrl, model: options.quickModel },
      guard: { baseUrl: options.guardBaseUrl, model: options.guardModel },
      executionApproval: { baseUrl: options.approvalBaseUrl, model: options.approvalModel },
    },
    contextSources,
    resources,
    checks: {},
  };
  await mkdir(join(stagingDir, "agent"), { recursive: true });
  await writeJson(join(stagingDir, "agent/models.json"), createPiModels(options));
  const functionalChecks = await runInitializationChecks({
    instanceDir,
    stagingDir,
    saved: config,
    secrets,
    catalog,
    catalogError,
    sourcesReady,
    mainModel,
    quickModel,
    approvalModel,
  });
  const checks = {
    mainModel,
    quickModel,
    approvalModel,
    guardModel,
    context: contextCheck,
    ...functionalChecks,
  };
  const ready =
    sourcesReady &&
    [mainModel, quickModel, approvalModel, guardModel, functionalChecks.executionApproval, functionalChecks.exampleTask].every(
      (check) => check.status === "ok",
    ) &&
    functionalChecks.knowledge.status !== "error" &&
    functionalChecks.skills.status !== "error";
  config.ready = ready;
  config.checks = checks;

  const registryStaged = await stageSourceRegistry(instanceDir, stagingDir, sourceRegistry);
  await commitContext({
    instanceDir,
    stagingDir,
    config,
    lastSync: {
      status: sourcesReady ? "ok" : "error",
      operation: importing ? "import" : "init",
      finishedAt: syncedAt,
      version,
    },
    registryStaged,
  });
  await writeJson(join(instanceDir, "secrets.json"), secrets);
  await mkdir(join(instanceDir, "agent"), { recursive: true });
  await writeJson(join(instanceDir, "agent/models.json"), createPiModels(options));

  process.stdout.write(
    `${JSON.stringify({ ready, instanceDir, resources, checks: { ...checks, contextSources } })}\n`,
  );
  if (!ready) process.exitCode = 1;
}

async function runInitializationChecks({
  instanceDir,
  stagingDir,
  saved,
  secrets,
  catalog,
  catalogError,
  sourcesReady,
  mainModel,
  quickModel,
  approvalModel,
}) {
  const knowledgeEntry = catalog?.entries.find((entry) => !entry.skillName) ?? null;
  const skill = catalog?.skills[0] ?? null;
  const knowledgeCount = catalog?.entries.filter((entry) => !entry.skillName).length ?? 0;
  let skipReason = null;
  if (!sourcesReady || !catalog) skipReason = catalogError ?? "本地来源未就绪，未执行真实 pi 检查";
  else if (mainModel.status !== "ok") skipReason = "主模型连接失败，未执行真实 pi 示例任务";
  else if (quickModel.status !== "ok") skipReason = "快速模型连接失败，未执行与 ask 相同的分诊和编排";

  let exampleResult = null;
  let lastTurn = null;
  let exampleError = null;
  if (!skipReason) {
    const question = [
      knowledgeEntry
        ? "初始化示例任务：这是实例就绪检查。请从目录选择一项本地知识并使用 read 实际读取。"
        : "初始化示例任务：这是实例就绪检查。本来源没有普通知识，不需要读取知识正文。",
      skill ? `同时按任务路由加载 ${skill.name} 的 SKILL.md 正文。` : "本来源没有 Skill，不需要读取 Skill。",
      "完成实际读取后只回答“示例任务完成”。不要创建任务产物。",
    ].join("\n");
    try {
      const executed = await executeLocalQuestion({
        instanceDir,
        question,
        sessionKey: "initialization-example",
        saved,
        secrets,
        requireReady: false,
        catalogRoot: stagingDir,
        workspaceDir: join(instanceDir, "workspace"),
        agentDir: join(stagingDir, "agent"),
        stateStorePath: join(stagingDir, "checks/example-session-state.json"),
      });
      exampleResult = executed.result;
      lastTurn = executed.lastTurn;
    } catch (error) {
      exampleError = error?.message ?? String(error);
    }
  }
  const committedPath = (path) =>
    typeof path === "string" && path.startsWith(`${stagingDir}/`)
      ? join(instanceDir, path.slice(stagingDir.length + 1))
      : path;
  const loadedResources = (exampleResult?.loadedResources ?? []).map((resource) => ({
    ...resource,
    path: committedPath(resource.path),
  }));
  const answer = exampleResult?.finalText?.trim() ?? "";
  const exampleOk = Boolean(
    !exampleError &&
    lastTurn &&
    !lastTurn.failed &&
    !lastTurn.timedOut &&
    !lastTurn.stalled &&
    answer.includes("示例任务完成"),
  );
  const exampleTask = skipReason
    ? { status: "skipped", executed: false, reason: skipReason }
    : {
        status: exampleOk ? "ok" : "error",
        executed: true,
        answer,
        loadedResources: loadedResources.map((resource) => resource.path),
        ...(exampleOk
          ? {}
          : { reason: exampleError ?? "真实 pi 示例任务未产生预期回答或执行失败" }),
      };
  // 知识正文不限于 Skill 根之外的文件：实体知识库通常整个目录就是一个 Skill，
  // 根内的指标卡、SQL、表文档同样是知识正文。这里只要读到的不是 SKILL.md 本身即可。
  const knowledgeLoadedPaths = loadedResources
    .filter((resource) => (resource.resourceType ?? resource.depth) !== "skill")
    .map((resource) => resource.path);
  const knowledgeLoaded = knowledgeLoadedPaths.length > 0;
  const knowledge = !knowledgeEntry
    ? catalog && catalog.skills.length > 0
      ? { status: "skipped", executed: false, reason: "来源仅包含 Skills，未执行知识正文检索" }
      : { status: "error", executed: true, reason: catalogError ?? "本地副本没有可检索的知识资源" }
    : skipReason
      ? { status: "skipped", executed: false, reason: skipReason, entries: knowledgeCount }
      : {
          status: knowledgeLoaded ? "ok" : "error",
          executed: true,
          entries: knowledgeCount,
          loadedResources: knowledgeLoadedPaths,
          ...(knowledgeLoaded ? {} : { reason: "示例任务没有实际完成本地知识 read" }),
        };
  const skillLoaded = loadedResources.some(
    (resource) => resource.path === committedPath(skill?.path) && resource.resourceType === "skill",
  );
  const skills = !sourcesReady || !catalog
    ? { status: "skipped", executed: false, reason: skipReason }
    : !skill
      ? { status: "skipped", executed: false, reason: "未选择 Skills，未执行 Skill 正文加载" }
      : skipReason
        ? { status: "skipped", executed: false, reason: skipReason, skills: catalog.skills.map((entry) => entry.name) }
        : {
            status: skillLoaded ? "ok" : "error",
            executed: true,
            skills: catalog.skills.map((entry) => entry.name),
            loadedResources: skillLoaded ? [committedPath(skill.path)] : [],
            ...(skillLoaded ? {} : { reason: "示例任务没有实际完成 Skill 正文 read" }),
          };
  const executionApproval = !sourcesReady || !catalog
    ? { status: "error", executed: false, reason: skipReason }
    : await checkExecutionApproval({ instanceDir, stagingDir, saved, secrets, mainModel, approvalModel });
  return { knowledge, skills, executionApproval, exampleTask };
}

async function checkExecutionApproval({ instanceDir, stagingDir, saved, secrets, mainModel, approvalModel }) {
  if (mainModel.status !== "ok" || approvalModel.status !== "ok") {
    return {
      status: "error",
      executed: false,
      reason: mainModel.reason ?? approvalModel.reason ?? "主模型或执行审批模型未就绪",
    };
  }
  const config = await createLocalRuntimeConfig({
    saved,
    secrets,
    catalogRoot: stagingDir,
    workspaceDir: join(instanceDir, "workspace"),
    agentDir: join(stagingDir, "agent"),
  });
  const allowedPath = join(instanceDir, "workspace", `.init-approval-${randomUUID()}.md`);
  const deniedPath = join(instanceDir, `.init-outside-${randomUUID()}.md`);
  let turn = null;
  let allowedContent = null;
  let checkError = null;
  try {
    turn = await runAgentTurn({
      prompt: [
        "INIT_EXECUTION_APPROVAL_CHECK：必须依次执行两次 write 工具，不得改成其他工具。",
        `INIT_APPROVAL_ALLOWED_PATH: ${allowedPath}`,
        "第一次向上述 ALLOWED_PATH 写入，content 精确为 INIT_APPROVAL_WRITE。",
        `INIT_APPROVAL_DENIED_PATH: ${deniedPath}`,
        "收到第一次工具结果后，第二次向上述 DENIED_PATH 写入，content 为 INIT_OUTSIDE_WRITE。",
        "第二次应被硬规则拒绝；收到拒绝后回答“审批检查完成”。",
      ].join("\n"),
      sessionId: `initialization-approval-${randomUUID()}`,
      config,
      projectDir,
      resourceCatalog: [],
      idleTimeoutMs: config.pi.idleTimeoutMs,
      hardTimeoutMs: config.pi.timeoutMs,
      thinkingLevel: config.pi.thinkingLevel,
    });
    if (await pathExists(allowedPath)) allowedContent = await readFile(allowedPath, "utf8");
  } catch (error) {
    checkError = error?.message ?? String(error);
  } finally {
    await rm(allowedPath, { force: true });
    await rm(deniedPath, { force: true });
  }
  const approvals = turn?.executionApprovals ?? [];
  const allowed = approvals.find((entry) => entry.target === allowedPath && entry.verdict === "ALLOW" && entry.source === "model");
  const denied = approvals.find((entry) => entry.target === deniedPath && entry.verdict === "DENY" && entry.source === "hard-rule");
  const ok = Boolean(
    turn &&
    !turn.failed &&
    !turn.timedOut &&
    !turn.stalled &&
    allowedContent === "INIT_APPROVAL_WRITE" &&
    allowed &&
    denied &&
    !(await pathExists(deniedPath)),
  );
  return {
    status: ok ? "ok" : "error",
    executed: true,
    writeRoots: ["context", "workspace"],
    protectedRoots: ["project"],
    approvals,
    ...(ok ? {} : { reason: checkError ?? "未观察到获批 workspace 写入和越界硬拒绝的完整审批证据" }),
  };
}

async function sync(args) {
  const options = parseSyncArgs(args);
  const instanceDir = resolve(options.instanceDir);
  await assertSafeInstanceDir(instanceDir);
  const saved = await readInstanceConfig(instanceDir);
  const registry = await readSourceRegistry(instanceDir);
  const existingSources = (Array.isArray(saved.contextSources) ? saved.contextSources : []).map((source) => ({
    name: source.name,
    path: registry[source.name]?.path,
  }));
  const outcome = await runSyncOnce({
    instanceDir,
    sources: options.sources,
    operation: "sync",
    now: new Date(),
    saved,
    existingSources,
  });
  // 手动 sync 只复制本次给定的来源；计划里应同步却没参与本次的来源必须显式列出，
  // 否则 sync-due 会报它们 due 却永远没有副本可复制。
  process.stdout.write(`${JSON.stringify({ ...outcome.result, notIncluded: notIncludedSources(saved, outcome.result) })}\n`);
  if (!outcome.ok) process.exitCode = 1;
}

/**
 * @param {any} saved 同步前的实例配置
 * @param {any} result 本次 sync 的结果
 * @returns {string[]}
 */
function notIncludedSources(saved, result) {
  const attempted = new Set((result?.contextSources ?? []).map((source) => source.name));
  const disabled = new Set(
    (saved?.syncPlan?.sources ?? []).filter((entry) => entry.enabled === false).map((entry) => entry.name),
  );
  const planned = new Set([
    ...(saved?.contextSources ?? []).map((source) => source.name),
    ...(saved?.syncPlan?.sources ?? []).map((entry) => entry.name),
  ]);
  return [...planned].filter((name) => !attempted.has(name) && !disabled.has(name)).sort();
}

/**
 * sync 与 sync-due 共用的完整同步管线：暂存复制 → 校验 → 统计本地修改 →
 * 生成资源清单与版本（无本地改动时复用旧哈希）→ 有改动才留存快照 → 事务提交。
 *
 * @param {{
 *   instanceDir: string,
 *   sources: any[],
 *   operation: "sync" | "sync-due",
 *   now: Date,
 *   saved?: any,
 *   plan?: {sources: any[]} | null,
 *   due?: any[],
 *   markPlanSources?: Set<string> | null,
 *   preserveDisabled?: boolean,
 *   existingSources?: {name?: string, path?: string}[]
 * }} options
 */
async function runSyncOnce({
  instanceDir,
  sources,
  operation,
  now,
  saved = null,
  plan = null,
  due = [],
  markPlanSources = null,
  preserveDisabled = false,
  existingSources = [],
}) {
  saved ??= await readInstanceConfig(instanceDir);
  const startedAt = now.toISOString();
  const stagingDir = await createStagingDir(instanceDir);
  let commitStarted = false;
  /** @type {any[] | null} */
  let copiedSources = null;
  try {
    const copied = await copySources({
      instanceDir,
      stagingDir,
      sources,
      template: saved.instance?.template,
      existingSources,
      previousSources: Array.isArray(saved.contextSources) ? saved.contextSources : [],
    });
    const contextSources = copied.contextSources;
    copiedSources = contextSources;
    const failed = contextSources.find((source) => source.status !== "ok");
    if (contextSources.length === 0 || failed) {
      throw new Error(failed?.reason ?? "同步至少需要一个可读取的标准资源来源");
    }
    const syncedAt = now.toISOString();
    const localModifications = await detectLocalModifications(instanceDir, saved);
    // 副本被本地改过时不能复用旧哈希，否则基线僵化：之后每次都误报“有改动”并反复写快照。
    const manifest = await manifestHashes(
      stagingDir,
      contextSources,
      saved.resources?.fileHashes,
      localModifications.count === 0,
    );
    const version = await hashSources(stagingDir, contextSources, manifest.fileHashes);
    for (const source of contextSources) source.version = version;
    await createLocalResourceCatalog(stagingDir, contextSources, syncedAt);
    const resources = {
      version,
      catalogVersion: version,
      syncedAt,
      files: manifest.files,
      fileHashes: manifest.fileHashes,
    };
    const previousVersion = saved.resources?.version ?? null;
    // 快照只为“覆盖前留住本地改动”：没有本地改动就不生成，已有 previous 保持不动。
    const snapshotStaged = localModifications.count > 0 ? await stagePreviousContext(instanceDir) : false;
    const snapshotPath = snapshotStaged ? join(instanceDir, "snapshots/previous") : null;
    const mergedContextSources = preserveDisabled
      ? mergePreservedSources(saved.contextSources, contextSources, plan)
      : contextSources;
    const updatedPlan =
      markPlanSources && plan
        ? {
            ...plan,
            sources: plan.sources.map((entry) =>
              markPlanSources.has(entry.name)
                ? { ...entry, lastRunAt: syncedAt, lastStatus: "ok", lastVersion: version }
                : entry,
            ),
          }
        : null;
    const planForConfig = updatedPlan ?? (saved.syncPlan ? normalizeSyncPlan(saved) : null);
    const config = {
      ...saved,
      ...(planForConfig ? { syncPlan: planForConfig } : {}),
      contextSources: mergedContextSources,
      resources,
      checks: { ...saved.checks, context: { status: "ok" } },
    };
    const lastSync = {
      status: "ok",
      operation,
      startedAt,
      finishedAt: syncedAt,
      version,
      previousVersion,
      snapshotPath,
      localModifications,
      ...(operation === "sync-due" ? { due: due.map((entry) => entry.name) } : {}),
    };
    const registryStaged = await stageSourceRegistry(instanceDir, stagingDir, copied.registry);
    commitStarted = true;
    await commitContext({ instanceDir, stagingDir, config, lastSync, registryStaged, snapshotStaged });
    return {
      ok: true,
      result: {
        ...(operation === "sync-due" ? { ran: true } : {}),
        ...lastSync,
        resources,
        contextSources: mergedContextSources,
      },
    };
  } catch (error) {
    if (!commitStarted) await rm(stagingDir, { recursive: true, force: true });
    // 提交失败：丢弃暂存快照，保留原来的 snapshots/previous。
    await rm(join(instanceDir, "snapshots/previous.next"), { recursive: true, force: true }).catch(() => {});
    const reason = redactSourceCredentials(error?.message ?? error);
    const lastSync = {
      status: "error",
      operation,
      startedAt,
      finishedAt: new Date().toISOString(),
      version: saved.resources?.version ?? null,
      reason,
    };
    if (!commitStarted) await writeJson(join(instanceDir, "sync-status.json"), lastSync);
    return {
      ok: false,
      result: {
        ...(operation === "sync-due" ? { ran: true, due: due.map((entry) => entry.name) } : {}),
        ...lastSync,
        ...(copiedSources ? { contextSources: copiedSources } : {}),
      },
    };
  }
}

/**
 * disabled 来源是唯一会移除副本的显式操作：保留计划与 contextSources 条目，
 * 但不再复制其文件，并在调用方输出 removed。
 *
 * @param {any[] | undefined} previous
 * @param {any[]} copied
 * @param {{sources: any[]} | null} plan
 */
function mergePreservedSources(previous, copied, plan) {
  if (!plan) return copied;
  const disabled = new Set(plan.sources.filter((entry) => entry.enabled === false).map((entry) => entry.name));
  const remaining = new Map(copied.map((source) => [source.name, source]));
  const merged = [];
  for (const source of Array.isArray(previous) ? previous : []) {
    if (disabled.has(source.name)) {
      merged.push({ ...source, status: "disabled" });
      continue;
    }
    const next = remaining.get(source.name);
    if (next) {
      merged.push(next);
      remaining.delete(source.name);
    }
  }
  for (const extra of remaining.values()) merged.push(extra);
  return merged;
}

function emptyLocalModifications() {
  return { count: 0, added: 0, modified: 0, removed: 0, sample: [] };
}

/**
 * 用上一次同步写入的 resources.files / fileHashes 与当前 context 实际内容比对。
 * 只报告、不阻塞同步；单向同步仍以标准版本为准。
 *
 * @param {string} instanceDir
 * @param {any} saved
 */
async function detectLocalModifications(instanceDir, saved) {
  const contextDir = join(instanceDir, "context");
  if (!(await pathExists(contextDir))) return emptyLocalModifications();
  const current = await hashTreeFiles(contextDir, "context");
  const baseline = saved.resources?.fileHashes;
  const hasHashes =
    baseline && typeof baseline === "object" && !Array.isArray(baseline) && Object.keys(baseline).length > 0;
  const manifest = Array.isArray(saved.resources?.files) ? saved.resources.files : [];
  const added = [];
  const modified = [];
  const removed = [];
  if (hasHashes) {
    for (const [path, hash] of current) {
      if (!(path in baseline)) added.push(path);
      else if (baseline[path] !== hash) modified.push(path);
    }
    for (const path of Object.keys(baseline)) {
      if (!current.has(path)) removed.push(path);
    }
  } else {
    const known = new Set(manifest);
    for (const path of current.keys()) {
      if (!known.has(path)) added.push(path);
    }
    for (const path of known) {
      if (!current.has(path)) removed.push(path);
    }
  }
  added.sort();
  modified.sort();
  removed.sort();
  const sample = [
    ...added.map((path) => `+ ${path}`),
    ...modified.map((path) => `~ ${path}`),
    ...removed.map((path) => `- ${path}`),
  ].slice(0, 10);
  return {
    count: added.length + modified.length + removed.length,
    added: added.length,
    modified: modified.length,
    removed: removed.length,
    sample,
  };
}

/**
 * 把当前 context 暂存到 snapshots/previous.next。它只是本次事务的一部分：
 * 只有提交成功才把它替换成 snapshots/previous（只保留最近一版）；
 * 提交失败时删除 next，旧的上一版保持不动。
 *
 * @param {string} instanceDir
 * @returns {Promise<boolean>}
 */
async function stagePreviousContext(instanceDir) {
  const current = join(instanceDir, "context");
  if (!(await pathExists(current))) return false;
  const next = join(instanceDir, "snapshots/previous.next");
  await mkdir(dirname(next), { recursive: true });
  await rm(next, { recursive: true, force: true });
  await cp(current, next, { recursive: true, dereference: false });
  return true;
}

/**
 * 资源清单与其逐文件 sha256。副本没有任何本地改动时，沿用来源直接复用旧哈希，省掉重读；
 * 一旦检测到本地改动就整体重算，避免基线僵化——否则之后每次同步都会误报“有改动”并反复写快照。
 *
 * @param {string} rootDir
 * @param {any[]} sources
 * @param {Record<string, string> | null | undefined} [previousHashes]
 * @param {boolean} [reuseCarried]
 */
async function manifestHashes(rootDir, sources, previousHashes = null, reuseCarried = false) {
  const files = await resourceManifest(rootDir, sources);
  const carriedPaths = (Array.isArray(sources) ? sources : [])
    .filter((source) => source?.status === "ok" && source.carried === true && typeof source.localPath === "string")
    .map((source) => source.localPath);
  const fileHashes = {};
  for (const file of files) {
    const carried = reuseCarried && carriedPaths.some((localPath) => file === localPath || file.startsWith(`${localPath}/`));
    if (carried && typeof previousHashes?.[file] === "string") {
      fileHashes[file] = previousHashes[file];
      continue;
    }
    fileHashes[file] = await hashFile(resolve(rootDir, file));
  }
  return { files, fileHashes };
}

/** @param {string} path */
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * @param {string} directory
 * @param {string} prefix
 * @returns {Promise<Map<string, string>>}
 */
async function hashTreeFiles(directory, prefix) {
  const result = new Map();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childPrefix = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      for (const [path, hash] of await hashTreeFiles(join(directory, entry.name), childPrefix)) {
        result.set(path, hash);
      }
    } else if (entry.isFile()) {
      result.set(childPrefix, await hashFile(join(directory, entry.name)));
    }
  }
  return result;
}

async function status(args) {
  const options = parseInstanceArgs(args, "status");
  const instanceDir = resolve(options.instanceDir);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  const loadFailures = [];
  let catalog = null;
  try {
    catalog = await createLocalResourceCatalog(instanceDir, saved.contextSources, saved.resources?.syncedAt ?? saved.initializedAt);
  } catch (error) {
    loadFailures.push({ source: "catalog", reason: error?.message ?? String(error) });
  }
  const coverageSources = [];
  const registry = await readSourceRegistry(instanceDir);
  const planView = buildPlanView(saved);
  const planSources = new Map(planView.sources.map((source) => [source.name, source]));
  for (const source of saved.contextSources ?? []) {
    const planSource = planSources.get(source.name) ?? null;
    const planFields = {
      symlinks: source.symlinks ?? null,
      excluded: source.excluded ?? null,
      excludedSensitive: source.excludedSensitive ?? { files: [], total: 0 },
      ...(source.secretsIncluded ? { secretsIncluded: true } : {}),
      ...(Array.isArray(source.secretFiles) ? { secretFiles: source.secretFiles } : {}),
      ref: registry[source.name]?.ref ?? null,
      lastRunAt: planSource?.lastRunAt ?? null,
      lastSyncStatus: planSource?.lastStatus ?? null,
      nextDueAt: planSource?.nextDueAt ?? null,
    };
    if (source.status === "disabled") {
      coverageSources.push({ name: source.name, scope: source.scope, status: "disabled", files: 0, skills: 0, ...planFields });
      continue;
    }
    if (source.status !== "ok" || !source.localPath) {
      loadFailures.push({ source: source.name, reason: source.reason ?? "来源未就绪" });
      coverageSources.push({ name: source.name, scope: source.scope, status: source.status, files: 0, skills: 0, ...planFields });
      continue;
    }
    try {
      const files = await listLocalFiles(resolve(instanceDir, source.localPath));
      coverageSources.push({
        name: source.name,
        scope: source.scope,
        status: "ok",
        files: files.length,
        skills: files.filter((file) => basename(file) === "SKILL.md").length,
        ...planFields,
      });
    } catch (error) {
      loadFailures.push({ source: source.name, reason: error?.message ?? String(error) });
      coverageSources.push({ name: source.name, scope: source.scope, status: "error", files: 0, skills: 0, ...planFields });
    }
  }
  for (const path of saved.resources?.files ?? []) {
    if (!(await pathExists(resolve(instanceDir, path)))) {
      loadFailures.push({ source: "context", reason: `标准资源文件缺失：${path}` });
    }
  }
  const actualVersion = loadFailures.length === 0 ? await hashSources(instanceDir, saved.contextSources) : null;
  let lastSync = null;
  try {
    lastSync = JSON.parse(await readFile(join(instanceDir, "sync-status.json"), "utf8"));
  } catch {
    lastSync = { status: "unknown", reason: "尚未记录同步状态" };
  }
  const coverage = {
    sources: coverageSources,
    files: coverageSources.reduce((total, source) => total + source.files, 0),
    knowledge: catalog?.entries.filter((entry) => !entry.skillName).length ?? 0,
    skills: catalog?.skills.length ?? 0,
    shared: catalog?.entries.filter((entry) => entry.scope === "shared").length ?? 0,
    private: catalog?.entries.filter((entry) => entry.scope === "private").length ?? 0,
  };
  const version = saved.resources?.version ?? null;
  process.stdout.write(
    `${JSON.stringify({
      instanceId: saved.instance.id,
      template: saved.instance.template,
      ready: saved.ready,
      resources: {
        version,
        catalogVersion: catalog ? actualVersion : null,
        actualVersion,
        syncedAt: saved.resources?.syncedAt ?? saved.initializedAt ?? null,
        consistent: Boolean(catalog && loadFailures.length === 0 && actualVersion),
        matchesSyncedVersion: Boolean(version && actualVersion === version),
      },
      lastSync,
      previousVersion: lastSync?.previousVersion ?? null,
      snapshotPath: lastSync?.snapshotPath ?? null,
      localModifications: await detectLocalModifications(instanceDir, saved),
      lastSyncLocalModifications: lastSync?.localModifications ?? null,
      syncPlan: { sources: planView.sources, nextSyncAt: planView.nextSyncAt },
      loadFailures,
      coverage,
    })}\n`,
  );
}

async function exportInstance(args) {
  const options = parseExportArgs(args);
  const instanceDir = resolve(options.instanceDir);
  const output = resolve(options.output);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  const sharedSources = (saved.contextSources ?? [])
    .filter((source) => source.status === "ok" && source.scope === "shared" && source.localPath)
    .map((source) => ({
      name: source.name,
      type: source.type,
      scope: "shared",
      localPath: source.localPath,
      status: "ok",
    }));
  if (sharedSources.length === 0) throw new Error("没有可分发的明确共享资源");
  const stagingDir = await createStagingDir(instanceDir);
  try {
    for (const source of sharedSources) {
      await cp(resolve(instanceDir, source.localPath), resolve(stagingDir, source.localPath), {
        recursive: true,
        dereference: false,
      });
    }
    await assertNoSymlinks(join(stagingDir, "context"));
    await assertNoSensitiveFiles(join(stagingDir, "context"));
    const version = await hashSources(stagingDir, sharedSources);
    for (const source of sharedSources) source.version = version;
    const models = Object.fromEntries(
      Object.entries(saved.models ?? {}).map(([role, config]) => [role, { baseUrl: config.baseUrl, model: config.model }]),
    );
    const packageConfig = {
      version: 2,
      ready: false,
      instance: { template: "team" },
      models,
      contextSources: sharedSources,
      resources: { version, catalogVersion: version, files: await resourceManifest(stagingDir, sharedSources) },
    };
    await writeJson(join(stagingDir, "instance.json"), packageConfig);
    await writeJson(join(stagingDir, "instance-package.json"), {
      format: "wecom-support-bot-team-instance",
      formatVersion: 1,
      resourceVersion: version,
      createdAt: new Date().toISOString(),
    });
    await rm(output, { force: true });
    await execFileAsync("zip", ["-q", "-r", output, "."], { cwd: stagingDir });
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        output,
        resourceVersion: version,
        sharedSources: sharedSources.length,
        excludedPrivateSources: (saved.contextSources ?? []).filter((source) => source.scope !== "shared").length,
      })}\n`,
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function readImportedPackage(packageDir) {
  await assertNoSymlinks(packageDir);
  const files = await listLocalFiles(packageDir);
  for (const file of files) {
    const name = file.replaceAll("\\", "/");
    if (name !== "instance.json" && name !== "instance-package.json" && !name.startsWith("context/")) {
      throw new Error(`导入包包含不允许的实例状态或凭证：${name}`);
    }
  }
  const manifest = JSON.parse(await readFile(join(packageDir, "instance-package.json"), "utf8"));
  if (manifest.format !== "wecom-support-bot-team-instance" || manifest.formatVersion !== 1) {
    throw new Error("不是受支持的团队实例分发包");
  }
  const config = JSON.parse(await readFile(join(packageDir, "instance.json"), "utf8"));
  if (!Array.isArray(config.contextSources) || config.contextSources.length === 0) {
    throw new Error("导入包没有共享标准资源");
  }
  return { config, manifest };
}

async function copyImportedSources(stagingDir, packageDir, sources) {
  await assertUniqueSourceNames(
    sources.map((source) => ({
      name: source?.name,
      path: typeof source?.localPath === "string" ? source.localPath : "",
    })),
  );
  const contextSources = [];
  for (const source of sources) {
    if (source.scope !== "shared" || typeof source.localPath !== "string") {
      throw new Error("导入包只能包含明确共享的标准资源");
    }
    const normalized = source.localPath.replaceAll("\\", "/");
    if (!normalized.startsWith("context/") || normalized.split("/").includes("..")) {
      throw new Error("导入包包含越界资源路径");
    }
    const sourcePath = resolve(packageDir, normalized);
    const targetPath = resolve(stagingDir, normalized);
    const packageRoot = resolve(packageDir, "context");
    const targetRoot = resolve(stagingDir, "context");
    if (!sourcePath.startsWith(`${packageRoot}/`) || !targetPath.startsWith(`${targetRoot}/`)) {
      throw new Error("导入包资源路径越出共享副本");
    }
    await cp(sourcePath, targetPath, { recursive: true, dereference: false });
    contextSources.push({
      name: source.name,
      type: source.type,
      scope: "shared",
      localPath: normalized,
      status: "ok",
    });
  }
  return contextSources;
}

async function assertNoSymlinks(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`资源不允许符号链接：${basename(path)}`);
  if (!info.isDirectory()) return;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`资源包不允许符号链接：${entry.name}`);
    if (entry.isDirectory()) await assertNoSymlinks(join(path, entry.name));
  }
}

/**
 * 团队包不静默剔除任何东西：只要有凭证类文件留在待打包副本里，就直接拒绝导出，
 * 并列出文件让用户处理。
 *
 * @param {string} path
 */
async function assertNoSensitiveFiles(path) {
  const info = await stat(path);
  if (!info.isDirectory()) {
    if (isSensitiveName(basename(path))) throw new Error(`团队包包含敏感文件，拒绝导出：${basename(path)}`);
    return;
  }
  const found = [];
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectSensitiveFiles(child, entry.name);
      found.push(...nested);
    } else if (entry.isFile() && isSensitiveName(entry.name)) {
      found.push(entry.name);
    }
  }
  if (found.length > 0) {
    throw new Error(`团队包包含敏感文件，拒绝导出（不会静默剔除）：${found.slice(0, 10).join("、")}`);
  }
}

/**
 * @param {string} path
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
async function collectSensitiveFiles(path, prefix) {
  const found = [];
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const childPrefix = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await collectSensitiveFiles(join(path, entry.name), childPrefix)));
    else if (entry.isFile() && isSensitiveName(entry.name)) found.push(childPrefix);
  }
  return found;
}

async function createStagingDir(instanceDir) {
  await mkdir(instanceDir, { recursive: true });
  const stagingDir = join(instanceDir, `.resources-${randomUUID()}`);
  await mkdir(join(stagingDir, "context"), { recursive: true });
  return stagingDir;
}

/**
 * 登记前检查来源名唯一性：registry 按 name 存储，同名不同路径会互相覆盖，
 * 两份标准副本也会共用名称。既检查本批来源之间，也检查与实例内已登记来源的冲突
 * （同名同真实路径允许，视为重新登记）。规范化失败的单来源错误仍由复制阶段报告。
 *
 * @param {{name?: string, type?: string, path?: string}[]} sources
 * @param {string} [template]
 * @param {{name?: string, path?: string}[]} [existing]
 */
async function assertNoDuplicateSourceNames(sources, template, existing = []) {
  const named = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const rawPath = typeof source?.path === "string" ? source.path.trim() : "";
    if (!rawPath) continue;
    try {
      const spec = await normalizeSource(source, { template });
      named.push({ name: spec.name, path: spec.sourcePath });
    } catch {
      // 交给复制阶段按单个来源报错。
    }
  }
  await assertUniqueSourceNames(named);
  const registered = new Map(
    (Array.isArray(existing) ? existing : [])
      // 旧实例（本改动之前创建）没有 registry，contextSources 里只有名字没有原始路径。
      // 这类条目无法比较路径，按“首次登记”处理，否则老实例永远无法再同步。
      .filter((entry) => typeof entry?.name === "string" && entry.name && typeof entry?.path === "string" && entry.path)
      .map((entry) => [entry.name, entry.path]),
  );
  for (const source of named) {
    if (!registered.has(source.name)) continue;
    const previous = registered.get(source.name);
    if (typeof previous === "string" && previous !== "" && (await sameSourcePath(previous, source.path))) continue;
    await assertUniqueSourceNames([
      { name: source.name, path: typeof previous === "string" ? previous : "" },
      { name: source.name, path: source.path },
    ]);
  }
}

/** @param {string} left @param {string} right */
async function sameSourcePath(left, right) {
  try {
    return (await canonicalSourceKey(left)) === (await canonicalSourceKey(right));
  } catch {
    return left === right;
  }
}

/**
 * @param {{instanceDir: string, stagingDir: string, sources: any[], template?: string, existingSources?: {name?: string, path?: string}[], previousSources?: any[]}} options
 */
async function copySources({ instanceDir, stagingDir, sources, template, existingSources = [], previousSources = [] }) {
  await assertNoDuplicateSourceNames(sourcesToRead(sources), template, existingSources);
  const contextSources = [];
  /** @type {{name: string, path: string, type?: string, ref?: string}[]} */
  const registry = [];
  for (const [index, source] of sources.entries()) {
    // 沿用来源只用实例内副本，不解析也不读取原始路径。
    if (typeof source?.carried === "string") {
      const previousEntry = previousSources.find((entry) => entry?.name === source.name) ?? null;
      const previous = previousEntry?.status === "ok" ? previousEntry : {};
      try {
        await carryExistingSource({ instanceDir, stagingDir, localPath: source.carried });
        contextSources.push({
          ...previous,
          name: source.name,
          type: source.type ?? previous.type ?? "auto",
          scope: source.scope ?? previous.scope,
          localPath: source.carried,
          status: "ok",
          carried: true,
        });
      } catch (error) {
        contextSources.push({
          name: source.name,
          scope: source.scope,
          status: "error",
          reason: `沿用已有副本失败：${redactSourceCredentials(error?.message ?? error)}`,
        });
      }
      continue;
    }
    const rawPath = typeof source?.path === "string" ? source.path : "";
    if (rawPath.trim() === "") {
      contextSources.push({
        name: source?.name ?? `source-${index + 1}`,
        type: source?.type ?? "auto",
        scope: source?.scope,
        status: "error",
        reason: "来源缺少原始路径，无法重新同步；请用 sync --source 指定原始来源",
      });
      continue;
    }
    /** @type {import("../src/source-spec.js").SourceSpec | null} */
    let spec = null;
    /** @type {ReturnType<typeof parseGitlabSource> | null} */
    let gitlabSource = null;
    let targetPath = null;
    try {
      spec = await normalizeSource(source, { template });
      if (spec.type === "missing") throw new Error(`来源不存在或不可访问：${spec.name}`);
      if (spec.scope !== "shared" && spec.scope !== "private") {
        contextSources.push({
          name: spec.name,
          type: spec.type,
          scope: spec.scope,
          status: "error",
          reason: "每个本地来源都必须明确共享或个人私有范围",
        });
        continue;
      }
      if (spec.type === "gitlab") gitlabSource = parseGitlabSource(spec.sourcePath);
      if (!gitlabSource || gitlabSource.local) await assertSourceTargetSeparated(spec.sourcePath, instanceDir);
      let readPath = spec.sourcePath;
      let detectedType = spec.type;
      if (spec.type === "gitlab") {
        const checkout = join(stagingDir, `gitlab-checkout-${index + 1}`);
        const cloneArgs = ["clone", "--quiet", "--no-hardlinks", "--depth", "1"];
        if (spec.ref) cloneArgs.push("--branch", spec.ref);
        cloneArgs.push("--", spec.sourcePath, checkout);
        await execFileAsync("git", cloneArgs, {
          env: { ...process.env, GIT_ALLOW_PROTOCOL: gitlabSource?.protocols, GIT_TERMINAL_PROMPT: "0" },
        });
        await rm(join(checkout, ".git"), { recursive: true, force: true });
        readPath = checkout;
        detectedType = "directory";
      }
      const position = Number.isInteger(source.slot) && source.slot > 0 ? source.slot : index + 1;
      const localPath = join("context", `${String(position).padStart(3, "0")}-${spec.name}`);
      targetPath = join(stagingDir, localPath);
      let copyInfo;
      if (detectedType === "package") {
        const extractDir = `${targetPath}__extract-${randomUUID()}`;
        await mkdir(extractDir, { recursive: true });
        try {
          await extractPackage(readPath, extractDir);
          copyInfo = await copyDirectorySource({
            sourcePath: extractDir,
            targetPath,
            exclude: spec.exclude,
            symlinks: spec.symlinks,
            scope: /** @type {"shared" | "private"} */ (spec.scope),
            includeSecrets: spec.includeSecrets,
            packageMode: true,
          });
        } finally {
          await rm(extractDir, { recursive: true, force: true });
        }
      } else if (detectedType === "directory") {
        copyInfo = await copyDirectorySource({
          sourcePath: readPath,
          targetPath,
          exclude: spec.exclude,
          symlinks: spec.symlinks,
          scope: /** @type {"shared" | "private"} */ (spec.scope),
          includeSecrets: spec.includeSecrets,
        });
      } else {
        copyInfo = await copySingleFileSource({
          sourcePath: readPath,
          targetPath,
          exclude: spec.exclude,
          symlinks: spec.symlinks,
          scope: /** @type {"shared" | "private"} */ (spec.scope),
          includeSecrets: spec.includeSecrets,
        });
      }
      if (detectedType !== "file" && (await listLocalFiles(targetPath)).length === 0) {
        throw new Error("本地来源为空，没有可读取的文件");
      }
      contextSources.push({
        name: spec.name,
        type: spec.type,
        scope: spec.scope,
        localPath,
        status: "ok",
        exclude: spec.exclude,
        ...copyInfo,
        ...(spec.includeSecrets ? { includeSecrets: true } : {}),
      });
      // 原始路径、类型、--ref 与复制选项只进 data/source-registry.json；
      // 含凭证的地址在规范化阶段已被拒绝。
      registry.push({
        name: spec.name,
        path: spec.sourcePath,
        type: spec.type,
        ...(spec.ref ? { ref: spec.ref } : {}),
        exclude: spec.exclude,
        symlinks: spec.symlinks,
      });
    } catch (error) {
      if (targetPath) await rm(targetPath, { recursive: true, force: true });
      const copyInfo = /** @type {any} */ (error)?.copyInfo;
      contextSources.push({
        name: spec?.name ?? gitlabSource?.name ?? basename(rawPath) ?? `source-${index + 1}`,
        scope: source?.scope,
        status: "error",
        reason: `本地来源不可读：${redactSourceCredentials(error?.message ?? error)}`,
        ...(copyInfo ? copyInfo : {}),
      });
    }
  }
  return { contextSources, registry };
}

/**
 * `--include-secrets` 是来源级开关：即使本次没有命中任何凭证文件，
 * 结果也必须标 `secretsIncluded: true`，避免把“没命中”误读成“没开启”。
 *
 * @param {ReturnType<typeof emptyCopyStats>} stats
 * @param {boolean} includeSecrets
 */
function copyInfoFromStats(stats, includeSecrets = false) {
  const excludedSensitiveFiles = [...new Set(stats.excludedSensitiveFiles)].sort();
  const secretFiles = [...new Set(stats.secretFiles)].sort();
  return {
    symlinks: {
      followed: stats.followed,
      skipped: stats.skipped,
      followedOutsideRoot: stats.followedOutsideRoot,
      blockedOutsideRoot: stats.blockedOutsideRoot,
      broken: stats.broken,
    },
    excluded: { files: stats.excludedFiles, dirs: stats.excludedDirs, sensitive: stats.excludedSensitive },
    excludedSensitive: { files: excludedSensitiveFiles.slice(0, 20), total: excludedSensitiveFiles.length },
    ...(includeSecrets ? { secretsIncluded: true, secretFiles } : {}),
  };
}

function emptyCopyStats() {
  return {
    followed: 0,
    skipped: 0,
    followedOutsideRoot: 0,
    blockedOutsideRoot: 0,
    broken: 0,
    excludedFiles: 0,
    excludedDirs: 0,
    excludedSensitive: 0,
    /** @type {string[]} */
    excludedSensitiveFiles: [],
    /** @type {string[]} */
    secretFiles: [],
  };
}

/**
 * @param {string} message
 * @param {ReturnType<typeof emptyCopyStats>} stats
 * @param {boolean} includeSecrets
 */
function copyInfoError(message, stats, includeSecrets = false) {
  const error = new Error(message);
  /** @type {any} */ (error).copyInfo = copyInfoFromStats(stats, includeSecrets);
  return error;
}

/**
 * 按排除规则与软链策略复制目录。默认跟随软链；shared 来源与资源包拒绝指向根外的软链，
 * 避免把来源根之外的私人文件带进团队副本。过滤与敏感检测都作用在最终真实目标上。
 * `includeSecrets` 只由 private 来源显式请求，命中项列名并继续复制。
 */
async function copyDirectorySource({
  sourcePath,
  targetPath,
  exclude,
  symlinks,
  scope,
  includeSecrets = false,
  packageMode = false,
}) {
  const filter = createSourcePathFilter({ exclude, includeSecrets });
  const stats = emptyCopyStats();
  const realRoot = await realpath(sourcePath);
  await mkdir(targetPath, { recursive: true });
  await copyTreeEntries({
    directory: sourcePath,
    targetRoot: targetPath,
    relPath: "",
    realRel: "",
    filter,
    symlinks,
    scope,
    includeSecrets,
    packageMode,
    realRoot,
    ancestors: new Set([realRoot]),
    stats,
  });
  return copyInfoFromStats(stats, includeSecrets);
}

async function copyTreeEntries({
  directory,
  targetRoot,
  relPath,
  realRel,
  filter,
  symlinks,
  scope,
  includeSecrets,
  packageMode,
  realRoot,
  ancestors,
  stats,
}) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const childRel = relPath ? join(relPath, entry.name) : entry.name;
    const childRealRel = realRel ? join(realRel, entry.name) : entry.name;
    const childPath = join(directory, entry.name);
    const destination = join(targetRoot, childRel);
    if (entry.isSymbolicLink()) {
      await copySourceSymlink({
        linkPath: childPath,
        destination,
        targetRoot,
        relPath: childRel,
        filter,
        symlinks,
        scope,
        includeSecrets,
        packageMode,
        realRoot,
        ancestors,
        stats,
      });
      continue;
    }
    if (entry.isDirectory()) {
      if (filter(childRealRel, true)) {
        stats.excludedDirs += 1;
        continue;
      }
      await mkdir(destination, { recursive: true });
      let realChild;
      try {
        realChild = await realpath(childPath);
      } catch {
        stats.skipped += 1;
        continue;
      }
      await copyTreeEntries({
        directory: childPath,
        targetRoot,
        relPath: childRel,
        realRel: childRealRel,
        filter,
        symlinks,
        scope,
        includeSecrets,
        packageMode,
        realRoot,
        ancestors: new Set([...ancestors, realChild]),
        stats,
      });
      continue;
    }
    if (entry.isFile()) {
      const sensitive = isSensitiveName(entry.name);
      if (sensitive && !includeSecrets) {
        stats.excludedSensitive += 1;
        stats.excludedSensitiveFiles.push(childRel.replaceAll(sep, "/"));
        continue;
      }
      if (filter(childRealRel, false)) {
        stats.excludedFiles += 1;
        continue;
      }
      if (sensitive) stats.secretFiles.push(childRel.replaceAll(sep, "/"));
      await copyFile(childPath, destination);
      continue;
    }
    stats.skipped += 1;
  }
}

async function copySourceSymlink({
  linkPath,
  destination,
  targetRoot,
  relPath,
  filter,
  symlinks,
  scope,
  includeSecrets,
  packageMode,
  realRoot,
  ancestors,
  stats,
}) {
  if (symlinks === "skip") {
    stats.skipped += 1;
    return;
  }
  if (symlinks === "reject") throw copyInfoError(`资源不允许符号链接：${relPath}`, stats, includeSecrets);
  let target;
  try {
    target = await realpath(linkPath);
  } catch {
    stats.broken += 1;
    return;
  }
  /** @type {import("node:fs").Stats} */
  let info;
  try {
    info = await stat(target);
  } catch {
    stats.broken += 1;
    return;
  }
  const isDirectory = info.isDirectory();
  const outside = !(target === realRoot || target.startsWith(`${realRoot}${sep}`));
  const targetRel = outside ? basename(target) : relative(realRoot, target);
  const sensitive = isSensitiveName(basename(target)) || isSensitiveName(basename(relPath));
  if (sensitive && !includeSecrets) {
    stats.excludedSensitive += 1;
    stats.excludedSensitiveFiles.push(relPath.replaceAll(sep, "/"));
    return;
  }
  if (filter(targetRel, isDirectory)) {
    if (isDirectory) stats.excludedDirs += 1;
    else stats.excludedFiles += 1;
    return;
  }
  if (outside) {
    if (packageMode || scope === "shared") {
      stats.blockedOutsideRoot += 1;
      throw copyInfoError(`符号链接指向来源根之外，已拒绝：${relPath}`, stats, includeSecrets);
    }
    stats.followedOutsideRoot += 1;
  }
  if (isDirectory) {
    if (ancestors.has(target)) {
      stats.skipped += 1;
      return;
    }
    await mkdir(destination, { recursive: true });
    await copyTreeEntries({
      directory: target,
      targetRoot,
      relPath,
      realRel: targetRel,
      filter,
      symlinks,
      scope,
      includeSecrets,
      packageMode,
      realRoot,
      ancestors: new Set([...ancestors, target]),
      stats,
    });
  } else if (info.isFile()) {
    if (sensitive) stats.secretFiles.push(relPath.replaceAll(sep, "/"));
    await copyFile(target, destination);
  } else {
    stats.skipped += 1;
    return;
  }
  stats.followed += 1;
}

/**
 * 单文件来源同样走软链策略、根外拒绝与敏感目标检测，不能绕过。
 *
 * @param {{sourcePath: string, targetPath: string, exclude: string[], symlinks: string, scope: string, includeSecrets?: boolean}} options
 */
async function copySingleFileSource({ sourcePath, targetPath, exclude, symlinks, scope, includeSecrets = false }) {
  const filter = createSourcePathFilter({ exclude, includeSecrets });
  const stats = emptyCopyStats();
  const linkInfo = await lstat(sourcePath);
  let readPath = sourcePath;
  if (linkInfo.isSymbolicLink()) {
    if (symlinks === "skip") {
      stats.skipped += 1;
      throw copyInfoError(`来源文件是符号链接，已按 --symlinks skip 跳过：${basename(sourcePath)}`, stats, includeSecrets);
    }
    if (symlinks === "reject") throw copyInfoError(`资源不允许符号链接：${basename(sourcePath)}`, stats, includeSecrets);
    let target;
    try {
      target = await realpath(sourcePath);
    } catch {
      stats.broken += 1;
      throw copyInfoError(`符号链接目标不存在或无法解析：${basename(sourcePath)}`, stats, includeSecrets);
    }
    const targetInfo = await stat(target);
    if (!targetInfo.isFile()) {
      throw copyInfoError(`单文件来源的符号链接目标不是普通文件：${basename(sourcePath)}`, stats, includeSecrets);
    }
    const parentRoot = await realpath(dirname(sourcePath));
    const outside = !(target === parentRoot || target.startsWith(`${parentRoot}${sep}`));
    if (outside) {
      if (scope === "shared") {
        stats.blockedOutsideRoot += 1;
        throw copyInfoError(`符号链接指向来源根之外，已拒绝：${basename(sourcePath)}`, stats, includeSecrets);
      }
      stats.followedOutsideRoot += 1;
    }
    stats.followed += 1;
    readPath = target;
  }
  const targetName = basename(readPath);
  const linkName = basename(sourcePath);
  const sensitive = isSensitiveName(targetName) || isSensitiveName(linkName);
  if (sensitive && !includeSecrets) {
    stats.excludedSensitive += 1;
    stats.excludedSensitiveFiles.push(targetName);
    throw copyInfoError(`来源文件命中敏感文件规则，已排除：${targetName}`, stats, includeSecrets);
  }
  if (filter(targetName, false)) {
    stats.excludedFiles += 1;
    throw copyInfoError(`来源文件命中默认排除或自定义排除：${targetName}`, stats, includeSecrets);
  }
  const targetInfo = await stat(readPath);
  if (!targetInfo.isFile()) throw copyInfoError(`来源不是普通文件：${targetName}`, stats, includeSecrets);
  if (sensitive) stats.secretFiles.push(targetName);
  await copyFile(readPath, targetPath);
  return copyInfoFromStats(stats, includeSecrets);
}

async function assertSafeInstanceDir(instanceDir) {
  const protectedRoots = ["/", homedir(), projectDir, dirname(projectDir)];
  if (protectedRoots.includes(instanceDir)) {
    throw new Error("实例目录不能是系统根、用户主目录、主工作区或项目保护根");
  }
  const realInstance = await resolveRealPath(instanceDir);
  for (const protectedRoot of protectedRoots) {
    if (realInstance === await resolveRealPath(protectedRoot)) {
      throw new Error("实例目录的真实路径不能是系统根、用户主目录、主工作区或项目保护根");
    }
  }
}

async function assertSourceTargetSeparated(sourcePath, instanceDir) {
  const realSource = await resolveRealPath(sourcePath);
  const targetRoots = [
    instanceDir,
    join(instanceDir, "context"),
    join(instanceDir, "workspace"),
    join(instanceDir, "data"),
    join(instanceDir, "data/session-state.json"),
  ];
  for (const targetRoot of targetRoots) {
    if (pathsOverlap(realSource, await resolveRealPath(targetRoot))) {
      throw new Error("同步来源与实例目录、context、workspace 或会话状态的真实路径不能相同或互相包含");
    }
  }
  for (const protectedRoot of [projectDir, dirname(projectDir), homedir()]) {
    const realProtected = await resolveRealPath(protectedRoot);
    if (realSource === realProtected || realProtected.startsWith(`${realSource}/`)) {
      throw new Error("保护根不能直接作为同步来源或包含在来源中，请选择明确共享的子目录或资源包");
    }
  }
}

async function extractPackage(sourcePath, targetPath) {
  const { stdout: entries } = await execFileAsync("unzip", ["-Z1", sourcePath]);
  for (const entry of entries.split("\n").filter(Boolean)) {
    if (entry.startsWith("/") || /^[a-z]:\//i.test(entry) || entry.split(/[\\/]/).includes("..")) {
      throw new Error(`资源包包含越界路径：${entry}`);
    }
  }
  await execFileAsync("unzip", ["-q", sourcePath, "-d", targetPath]);
}

/**
 * 把 context、instance.json、source registry、sync-status 与暂存的上一版快照放在
 * 同一个事务里替换：任一步失败都按逆序回滚，快照也不会在提交失败时被换成新副本。
 */
async function commitContext({ instanceDir, stagingDir, config, lastSync = null, registryStaged = false, snapshotStaged = false }) {
  const entries = [
    {
      name: "context",
      current: join(instanceDir, "context"),
      staged: join(stagingDir, "context"),
      backup: join(stagingDir, "previous-context"),
      oldMoved: false,
      newMoved: false,
    },
    {
      name: "instance.json",
      current: join(instanceDir, "instance.json"),
      staged: join(stagingDir, "instance.json"),
      backup: join(stagingDir, "previous-instance.json"),
      oldMoved: false,
      newMoved: false,
    },
  ];
  if (registryStaged) {
    entries.push({
      name: SOURCE_REGISTRY_PATH,
      current: join(instanceDir, SOURCE_REGISTRY_PATH),
      staged: join(stagingDir, SOURCE_REGISTRY_PATH),
      backup: join(stagingDir, "previous-source-registry.json"),
      oldMoved: false,
      newMoved: false,
    });
  }
  if (lastSync) {
    entries.push({
      name: "sync-status.json",
      current: join(instanceDir, "sync-status.json"),
      staged: join(stagingDir, "sync-status.json"),
      backup: join(stagingDir, "previous-sync-status.json"),
      oldMoved: false,
      newMoved: false,
    });
  }
  if (snapshotStaged) {
    entries.push({
      name: "snapshots/previous",
      current: join(instanceDir, "snapshots/previous"),
      staged: join(instanceDir, "snapshots/previous.next"),
      backup: join(stagingDir, "previous-snapshot"),
      oldMoved: false,
      newMoved: false,
    });
  }
  try {
    await writeJson(join(stagingDir, "instance.json"), config);
    if (lastSync) await writeJson(join(stagingDir, "sync-status.json"), lastSync);
    for (const entry of entries) {
      if (await pathExists(entry.current)) {
        await rename(entry.current, entry.backup);
        entry.oldMoved = true;
      }
      if (entry.name === "sync-status.json" && process.env.WECOM_BOT_TEST_FAIL_SYNC_STATUS_COMMIT === "1") {
        throw new Error("注入的 sync-status 提交失败");
      }
      await mkdir(dirname(entry.current), { recursive: true });
      await rename(entry.staged, entry.current);
      entry.newMoved = true;
    }
  } catch (error) {
    for (const entry of [...entries].reverse()) {
      if (entry.newMoved) {
        await rename(entry.current, join(stagingDir, `failed-${entry.name.replaceAll("/", "-")}`)).catch(() => {});
      }
      if (entry.oldMoved) await rename(entry.backup, entry.current).catch(() => {});
    }
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  await rm(stagingDir, { recursive: true, force: true });
}

/**
 * 全局版本：对每个文件取 sha256 再按路径汇总。分离出逐文件哈希后，同步时可以把
 * 已经算好的清单哈希直接喂进来，避免为了算版本再把几 GB 文件重读一遍。
 *
 * @param {string} rootDir
 * @param {any[]} sources
 * @param {Record<string, string> | null} [knownHashes] 形如 `context/001-xxx/a.md` → sha256
 */
async function hashSources(rootDir, sources, knownHashes = null) {
  const okSources = sources.filter((source) => source.status === "ok" && source.localPath);
  if (okSources.length === 0) return null;
  const hash = createHash("sha256");
  for (const source of okSources) {
    hash.update(`${source.name}\0${source.scope}\0${source.localPath}\0`);
    await hashPath(resolve(rootDir, source.localPath), "", hash, knownHashes, source.localPath);
  }
  return hash.digest("hex");
}

async function hashPath(path, prefix, hash, knownHashes = null, keyPrefix = "") {
  const info = await stat(path);
  if (info.isFile()) {
    const relative = prefix || basename(path);
    hash.update(`${relative}\0`);
    const known = knownHashes?.[keyPrefix ? `${keyPrefix}/${relative}` : relative];
    hash.update(known ?? (await hashFile(path)));
    hash.update("\0");
    return;
  }
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    await hashPath(join(path, entry.name), prefix ? join(prefix, entry.name) : entry.name, hash, knownHashes, keyPrefix);
  }
}

async function resourceManifest(rootDir, sources) {
  const manifest = [];
  for (const source of sources.filter((candidate) => candidate.status === "ok" && candidate.localPath)) {
    const sourceRoot = resolve(rootDir, source.localPath);
    if ((await stat(sourceRoot)).isFile()) {
      manifest.push(source.localPath);
      continue;
    }
    const files = await listRelativeFiles(sourceRoot);
    for (const file of files) manifest.push(join(source.localPath, file));
  }
  return manifest.sort();
}

async function listRelativeFiles(path, prefix = "") {
  const info = await stat(path);
  if (info.isFile()) return [prefix || basename(path)];
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    const childPrefix = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(join(path, entry.name), childPrefix)));
    else if (entry.isFile()) files.push(childPrefix);
  }
  return files;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ask(args) {
  const options = parseAskArgs(args);
  const { result } = await executeLocalQuestion({
    instanceDir: resolve(options.instanceDir),
    question: options.question,
    sessionKey: options.sessionKey,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function executeLocalQuestion({
  instanceDir,
  question,
  sessionKey,
  saved = null,
  secrets = null,
  requireReady = true,
  catalogRoot = instanceDir,
  workspaceDir = join(instanceDir, "workspace"),
  agentDir = join(instanceDir, "agent"),
  stateStorePath = join(instanceDir, "data/session-state.json"),
}) {
  saved ??= JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  if (requireReady && !saved.ready) throw new Error("实例初始化检查未通过，不能启用");
  secrets ??= JSON.parse(await readFile(join(instanceDir, "secrets.json"), "utf8"));
  const config = await createLocalRuntimeConfig({ saved, secrets, catalogRoot, workspaceDir, agentDir });
  await mkdir(workspaceDir, { recursive: true });

  const context = await createLocalResourceCatalog(
    catalogRoot,
    saved.contextSources,
    saved.resources?.syncedAt ?? saved.initializedAt ?? null,
  );
  const state = createSessionState({ storePath: stateStorePath, rotation: config.rotation });
  await state.load();
  const userKey = `local-${createHash("sha256").update(`${saved.instance.id}:${sessionKey}`).digest("hex").slice(0, 32)}`;
  const resolvedSessionKey = state.resolveSessionId(userKey, Date.now());
  const callModel = await createGuardClient({ config, agentDir });
  const callQuickModel = await createQuickClient({ config, agentDir });
  const route = await classifyQuestion({ question, callModel: callQuickModel });
  const turnConfig = route === "quick"
    ? {
        ...config,
        pi: {
          ...config.pi,
          provider: "local-instance-quick",
          model: saved.models.quick?.model ?? saved.models.main.model,
        },
      }
    : config;
  const thinkingLevel = config.pi.thinkingLevels?.[route] ?? config.pi.thinkingLevel;
  let lastInputTokens = 0;
  let lastTurn = null;

  const result = await handleTurn({
    question,
    sessionKey: resolvedSessionKey,
    deps: {
      state,
      context: {
        catalog: context.text,
        dataPlaybook: context.dataPlaybook,
        entries: context.entries,
        skills: context.skills,
        workspaceDir,
        trustedDataScripts: config.trustedDataScripts,
      },
      runAgent: async ({ prompt, sessionId, currentSkill }) => {
        const turn = await runAgentTurn({
          prompt,
          sessionId,
          currentSkill,
          config: turnConfig,
          projectDir,
          resourceCatalog: context.entries,
          idleTimeoutMs: config.pi.idleTimeoutMs,
          hardTimeoutMs: config.pi.timeoutMs,
          thinkingLevel,
        });
        lastTurn = turn;
        lastInputTokens = turn.inputTokens || lastInputTokens;
        return turn;
      },
      review: ({ answer }) => reviewReply({ answer, callModel }),
    },
    maxRounds: config.guard.maxRounds,
    messages: {
      fallbackText: config.surface.fallbackText,
      errorText: config.surface.errorText,
      timeoutText: config.surface.timeoutText,
    },
  });
  state.recordActivity(userKey, { at: Date.now(), inputTokens: lastInputTokens });
  await state.flush();
  return {
    result: { ...result, instanceId: saved.instance.id, sessionId: resolvedSessionKey },
    lastTurn,
  };
}

async function createLocalRuntimeConfig(options) {
  const defaults = JSON.parse(await readFile(join(projectDir, "config/default.json"), "utf8"));
  return createSharedLocalRuntimeConfig({ ...options, projectDir, defaults });
}

function parseConfigureBiArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--instance-dir") options.instanceDir = value;
    else if (flag === "--business") options.business = value;
    else if (flag === "--script") options.script = value;
    else throw new Error(`configure-bi 未知选项：${flag}`);
  }
  if (!options.instanceDir || !options.business || !options.script) {
    throw new Error("configure-bi 需要 --instance-dir、--business 与 --script");
  }
  if (!["ajly", "lzz"].includes(options.business)) throw new Error("configure-bi 的 --business 只支持 ajly 或 lzz");
  return options;
}

function parseInventoryArgs(args) {
  const options = { roots: [], exclude: [], symlinks: "follow", maxDepth: Number.POSITIVE_INFINITY };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--root") options.roots.push(value);
    else if (flag === "--exclude") options.exclude.push(value);
    else if (flag === "--symlinks") options.symlinks = value;
    else if (flag === "--max-depth") {
      const depth = Number(value);
      if (!Number.isInteger(depth) || depth < 1) throw new Error(`--max-depth 必须是正整数：${value}`);
      options.maxDepth = depth;
    } else throw new Error(`inventory 未知选项：${flag}`);
  }
  if (options.roots.length === 0) throw new Error("inventory 至少需要一个 --root");
  if (!["follow", "skip", "reject"].includes(options.symlinks)) {
    throw new Error(`--symlinks 只支持 follow、skip 或 reject：${options.symlinks}`);
  }
  return options;
}

function parsePlanArgs(args) {
  const options = { exclude: [], weekdays: [], clearExcludes: false, includeSecrets: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--enable") {
      options.enable = true;
      continue;
    }
    if (flag === "--disable") {
      options.disable = true;
      continue;
    }
    if (flag === "--clear-excludes") {
      options.clearExcludes = true;
      continue;
    }
    if (flag === "--include-secrets") {
      options.includeSecrets = true;
      continue;
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--instance-dir") options.instanceDir = value;
    else if (flag === "--source") options.source = value;
    else if (flag === "--scope") options.scope = value;
    else if (flag === "--cadence") options.cadenceKind = value;
    else if (flag === "--every-minutes") {
      const everyMinutes = Number(value);
      if (!Number.isInteger(everyMinutes)) throw new Error(`--every-minutes 必须是整数：${value}`);
      options.everyMinutes = everyMinutes;
    } else if (flag === "--at") options.at = value;
    else if (flag === "--weekday") options.weekdays.push(Number(value));
    else if (flag === "--weekdays") options.weekdays.push(...parseWeekdaysValue(value));
    else if (flag === "--exclude") options.exclude.push(value);
    else if (flag === "--symlinks") options.symlinks = value;
    else throw new Error(`plan 未知选项：${flag}`);
  }
  if (!options.instanceDir) throw new Error("plan 需要 --instance-dir");
  if (options.enable && options.disable) throw new Error("--enable 与 --disable 不能同时使用");
  if (options.clearExcludes && options.exclude.length > 0) {
    throw new Error("--clear-excludes 与 --exclude 不能同时使用");
  }
  const cadenceParams =
    options.everyMinutes !== undefined || options.at !== undefined || options.weekdays.length > 0;
  if (!options.cadenceKind && cadenceParams) {
    throw new Error("--at、--weekday、--weekdays、--every-minutes 需要与 --cadence 一起使用，不能单独更新");
  }
  const updateRequested =
    options.source !== undefined ||
    options.scope !== undefined ||
    options.cadenceKind !== undefined ||
    cadenceParams ||
    options.exclude.length > 0 ||
    options.clearExcludes ||
    options.symlinks !== undefined ||
    options.includeSecrets ||
    options.enable ||
    options.disable;
  if (!options.source && updateRequested) throw new Error("更新同步计划需要 --source <原始来源路径>");
  if (options.symlinks !== undefined && !["follow", "skip", "reject"].includes(options.symlinks)) {
    throw new Error(`--symlinks 只支持 follow、skip 或 reject：${options.symlinks}`);
  }
  options.cadence = options.cadenceKind ? cadenceFromArgs(options) : null;
  return options;
}

function parseSyncDueArgs(args) {
  const options = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--instance-dir") options.instanceDir = value;
    else if (flag === "--now") options.now = value;
    else throw new Error(`sync-due 未知选项：${flag}`);
  }
  if (!options.instanceDir) throw new Error("sync-due 需要 --instance-dir");
  return options;
}

function parseScheduleArgs(args) {
  const options = {
    tickMinutes: 15,
    home: homedir(),
    platform: process.platform,
    install: false,
    uninstall: false,
    yes: false,
    dryRun: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (flag === "--yes") {
      options.yes = true;
      continue;
    }
    if (flag === "--install") {
      options.install = true;
      continue;
    }
    if (flag === "--uninstall") {
      options.uninstall = true;
      continue;
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--instance-dir") options.instanceDir = value;
    else if (flag === "--tick-minutes") {
      const tickMinutes = Number(value);
      if (!Number.isInteger(tickMinutes) || tickMinutes < 1) throw new Error(`--tick-minutes 必须是正整数：${value}`);
      options.tickMinutes = tickMinutes;
    } else if (flag === "--home") options.home = value;
    else if (flag === "--platform") options.platform = value;
    else throw new Error(`schedule 未知选项：${flag}`);
  }
  if (!options.instanceDir) throw new Error("schedule 需要 --instance-dir");
  if (options.install && options.uninstall) throw new Error("--install 与 --uninstall 不能同时使用");
  if (options.dryRun && (options.install || options.uninstall)) {
    throw new Error("--dry-run 不能与 --install 或 --uninstall 同时使用");
  }
  if (options.platform !== "darwin" && options.platform !== "linux") {
    throw new Error(`--platform 只支持 darwin 或 linux（Windows 请在 WSL2 内运行）：${options.platform}`);
  }
  return options;
}

/**
 * CLI 只负责拒绝与频率种类冲突的参数；kind 分派与补全统一交给 normalizeCadence，
 * 避免命令行与频率模型各维护一份分派。
 */
function cadenceFromArgs(options) {
  const kind = options.cadenceKind;
  if (!CADENCE_KINDS.includes(kind)) {
    throw new Error(`不支持的频率：${kind}；可用 ${CADENCE_KINDS.join("、")}`);
  }
  if (kind === "manual" && (options.everyMinutes !== undefined || options.at !== undefined || options.weekdays.length > 0)) {
    throw new Error("manual 频率不接受 --every-minutes、--at 或 --weekday");
  }
  if ((kind === "every" || kind === "hourly") && options.at !== undefined) {
    throw new Error(`${kind} 频率不接受 --at`);
  }
  if (kind === "hourly" && options.everyMinutes !== undefined) {
    throw new Error("hourly 固定每 60 分钟，不接受 --every-minutes");
  }
  if ((kind === "daily" || kind === "weekly") && options.everyMinutes !== undefined) {
    throw new Error(`${kind} 频率不接受 --every-minutes`);
  }
  return normalizeCadence({
    kind,
    everyMinutes: options.everyMinutes,
    at: options.at,
    weekdays: options.weekdays.length > 0 ? options.weekdays : undefined,
  });
}

function parseWeekdaysValue(value) {
  const days = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    const range = /^([1-7])-([1-7])$/.exec(trimmed);
    if (range) {
      for (let day = Number(range[1]); day <= Number(range[2]); day += 1) days.push(day);
    } else {
      days.push(Number(trimmed));
    }
  }
  return days;
}

function parseExportArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--instance-dir") options.instanceDir = value;
    else if (flag === "--output") options.output = value;
    else throw new Error(`export 未知选项：${flag}`);
  }
  if (!options.instanceDir || !options.output) throw new Error("export 需要 --instance-dir 与 --output");
  return options;
}

/**
 * init / sync 的逐来源复制选项，与 plan 同义：`--exclude` 追加自定义规则，
 * `--clear-excludes` 清空（与 `--exclude` 互斥），`--symlinks` 选择软链策略。
 * 三者都必须跟在对应的 `--source` 之后，并由 registry 持久化。
 *
 * @param {{sources: {exclude?: string[], clearExcludes?: boolean, symlinks?: string}[]}} options
 * @param {string} flag
 * @param {string} [value]
 * @returns {boolean} 是否已处理该选项
 */
function applySourceCopyOption(options, flag, value) {
  if (flag !== "--clear-excludes" && flag !== "--exclude" && flag !== "--symlinks") return false;
  if (options.sources.length === 0) throw new Error(`${flag} 必须跟在 --source 后面`);
  const source = options.sources.at(-1);
  if (flag === "--clear-excludes") {
    if (source.exclude && source.exclude.length > 0) throw new Error("--clear-excludes 与 --exclude 不能同时使用");
    source.clearExcludes = true;
    return true;
  }
  if (flag === "--exclude") {
    if (source.clearExcludes) throw new Error("--clear-excludes 与 --exclude 不能同时使用");
    source.exclude = [...(source.exclude ?? []), value];
    return true;
  }
  if (!["follow", "skip", "reject"].includes(String(value))) {
    throw new Error(`--symlinks 只支持 follow、skip 或 reject：${value}`);
  }
  source.symlinks = value;
  return true;
}

function parseSyncArgs(args) {
  const options = { sources: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--include-secrets") {
      if (options.sources.length === 0) throw new Error("--include-secrets 必须跟在 --source 后面");
      options.sources.at(-1).includeSecrets = true;
      continue;
    }
    if (flag === "--clear-excludes") {
      applySourceCopyOption(options, flag);
      continue;
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--instance-dir") options.instanceDir = value;
    else if (flag === "--source") options.sources.push({ path: value, scope: undefined });
    else if (flag === "--source-type") {
      if (options.sources.length === 0) throw new Error("--source-type 必须跟在 --source 后面");
      options.sources.at(-1).type = value;
    } else if (flag === "--ref") {
      if (options.sources.length === 0) throw new Error("--ref 必须跟在 --source 后面");
      options.sources.at(-1).ref = value;
    } else if (flag === "--scope") {
      if (options.sources.length === 0) throw new Error("--scope 必须跟在 --source 后面");
      options.sources.at(-1).scope = value;
    } else if (!applySourceCopyOption(options, flag, value)) throw new Error(`未知选项：${flag}`);
  }
  if (!options.instanceDir) throw new Error("sync 需要 --instance-dir");
  return options;
}

function parseInstanceArgs(args, command) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--instance-dir") options.instanceDir = value;
    else throw new Error(`${command} 未知选项：${flag}`);
  }
  if (!options.instanceDir) throw new Error(`${command} 需要 --instance-dir`);
  return options;
}

function parseAskArgs(args) {
  const options = { sessionKey: "local-user" };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--instance-dir") options.instanceDir = value;
    else if (flag === "--question") options.question = value;
    else if (flag === "--session-key") options.sessionKey = value;
    else throw new Error(`未知选项：${flag}`);
  }
  if (!options.instanceDir || !options.question) throw new Error("ask 需要 --instance-dir 与 --question");
  return options;
}

async function listLocalFiles(path, prefix = "") {
  const info = await stat(path);
  if (info.isFile()) return [prefix || basename(path)];
  if (!info.isDirectory()) throw new Error(`不支持的本地来源：${path}`);
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const childPath = join(path, entry.name);
    const childPrefix = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await listLocalFiles(childPath, childPrefix)));
    else if (entry.isFile()) files.push(childPrefix);
  }
  return files;
}

function parseInitArgs(args) {
  const options = { sources: [], template: "blank" };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--include-secrets") {
      if (options.sources.length === 0) throw new Error("--include-secrets 必须跟在 --source 后面");
      options.sources.at(-1).includeSecrets = true;
      continue;
    }
    if (flag === "--clear-excludes") {
      applySourceCopyOption(options, flag);
      continue;
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--source") options.sources.push({ path: value, scope: undefined });
    else if (flag === "--source-type") {
      if (options.sources.length === 0) throw new Error("--source-type 必须跟在 --source 后面");
      options.sources.at(-1).type = value;
    } else if (flag === "--ref") {
      if (options.sources.length === 0) throw new Error("--ref 必须跟在 --source 后面");
      options.sources.at(-1).ref = value;
    } else if (flag === "--scope") {
      if (options.sources.length === 0) throw new Error("--scope 必须跟在 --source 后面");
      options.sources.at(-1).scope = value;
    } else if (flag === "--instance-dir") options.instanceDir = value;
    else if (flag === "--template") options.template = value;
    else if (flag === "--package") options.importPackage = value;
    else if (flag === "--base-url") options.baseUrl = value;
    else if (flag === "--api-key") options.apiKey = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--quick-base-url") options.quickBaseUrl = value;
    else if (flag === "--quick-api-key") options.quickApiKey = value;
    else if (flag === "--quick-model") options.quickModel = value;
    else if (flag === "--guard-base-url") options.guardBaseUrl = value;
    else if (flag === "--guard-api-key") options.guardApiKey = value;
    else if (flag === "--guard-model") options.guardModel = value;
    else if (flag === "--approval-base-url") options.approvalBaseUrl = value;
    else if (flag === "--approval-api-key") options.approvalApiKey = value;
    else if (flag === "--approval-model") options.approvalModel = value;
    else if (!applySourceCopyOption(options, flag, value)) throw new Error(`未知选项：${flag}`);
  }
  for (const key of ["instanceDir", "apiKey"]) {
    if (!options[key]) throw new Error(`缺少必需选项：${key}`);
  }
  if (!["import", "existing"].includes(options.template)) {
    for (const key of ["baseUrl", "model"]) {
      if (!options[key]) throw new Error(`缺少必需选项：${key}`);
    }
  }
  return options;
}

function applyModelDefaults(options, packagedModels) {
  options.baseUrl ??= packagedModels.main?.baseUrl;
  options.model ??= packagedModels.main?.model;
  if (!options.baseUrl || !options.model) throw new Error("初始化需要可用的主模型地址与名称");
  for (const [prefix, role] of [["quick", "quick"], ["guard", "guard"], ["approval", "executionApproval"]]) {
    options[`${prefix}BaseUrl`] ??= packagedModels[role]?.baseUrl ?? options.baseUrl;
    options[`${prefix}ApiKey`] ??= options.apiKey;
    options[`${prefix}Model`] ??= packagedModels[role]?.model ?? options.model;
  }
}

function sameModel(options, role) {
  const prefix = role === "quick" ? "quick" : "approval";
  return (
    options[`${prefix}BaseUrl`] === options.baseUrl &&
    options[`${prefix}ApiKey`] === options.apiKey &&
    options[`${prefix}Model`] === options.model
  );
}

function createPiModels(options) {
  return {
    providers: {
      "local-instance": createPiProvider(options.baseUrl, options.apiKey, options.model),
      "local-instance-quick": createPiProvider(options.quickBaseUrl, options.quickApiKey, options.quickModel),
      "local-instance-approval": createPiProvider(options.approvalBaseUrl, options.approvalApiKey, options.approvalModel),
      "local-instance-guard": createPiProvider(options.guardBaseUrl, options.guardApiKey, options.guardModel),
    },
  };
}

function createPiProvider(baseUrl, apiKey, model) {
  return {
    api: "openai-completions",
    baseUrl,
    apiKey,
    models: [
      {
        id: model,
        name: model,
        reasoning: true,
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 32768,
      },
    ],
  };
}

async function checkModel(baseUrl, apiKey, model) {
  try {
    await testModel(baseUrl, apiKey, model);
    return { status: "ok", executed: true };
  } catch (error) {
    return { status: "error", executed: true, reason: error?.message ?? String(error) };
  }
}

async function testModel(baseUrl, apiKey, model) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "连接测试，请回复 ok" }],
      temperature: 0,
      max_tokens: 8,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${model} 连接测试失败：HTTP ${response.status}`);
  const data = await response.json();
  if (!data?.choices?.[0]?.message?.content) throw new Error(`${model} 连接测试未返回内容`);
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

main().catch((error) => {
  process.stderr.write(`本地实例操作失败：${error?.message ?? error}\n`);
  process.exitCode = 1;
});

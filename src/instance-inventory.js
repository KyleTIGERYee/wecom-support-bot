import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { normalizeSource, hasUrlCredentials, redactSourceCredentials } from "./source-spec.js";

/**
 * 盘点本地来源：只读扫描目录结构，不读文件正文（SKILL.md 仅取 frontmatter 名称）。
 * `--exclude` 与 `--symlinks` 与复制阶段共用同一套规则，软链按策略 follow + 防环，
 * 并对最终真实目标应用同一套排除与敏感检测，使 files/bytes 与实际复制量一致。
 *
 * @typedef {{kind: "manual" | "every" | "daily" | "weekly", everyMinutes?: number, at?: string, weekdays?: number[]}} Cadence
 * @typedef {{
 *   name: string,
 *   path: string,
 *   type: "directory" | "file" | "missing",
 *   kind: string,
 *   kinds: string[],
 *   kindNote: string | null,
 *   totalFiles: number,
 *   files: number,
 *   bytes: number,
 *   skills: number,
 *   skillNames: string[],
 *   resourceTypes: Record<string, number>,
 *   symlinks: {count: number, followed: number, skipped: number, followedOutsideRoot: number, broken: number, loops: number},
 *   sensitive: {files: string[], count: number},
 *   lastModified: string | null,
 *   blockers: string[],
 *   recommended: {include: boolean, scope: "shared" | "private", cadence: Cadence, symlinks: "follow" | "skip" | "reject", reason: string}
 * }} InventoryCandidate
 */

/**
 * 凭证类排除规则。默认始终排除；只有用户明确要求把凭证随私有副本一起放时，
 * 复制阶段才会暂时摘下这一组（`--include-secrets`），其余默认排除保持不变。
 */
export const SECRET_EXCLUDES = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "*credential*",
  "secrets.json",
  "models.json",
  "wecom.json",
  ".npmrc",
  ".netrc",
];

/** 默认排除规则：复制来源前直接跳过，避免把运行产物与凭证带进实例。 */
export const DEFAULT_EXCLUDES = [
  ".git/",
  "node_modules/",
  ...SECRET_EXCLUDES,
  "__pycache__/",
  ".DS_Store",
];

const RESOURCE_TYPES = [
  "metrics",
  "sql",
  "tables",
  "concepts",
  "raw",
  "experience",
  "playbook",
  "timeline",
  "records",
  "projects",
];

const RESOURCE_PATTERNS = {
  metrics: /(?:^|\/)metrics(?:\/|$)/i,
  sql: /\.sql$|(?:^|\/)queries(?:\/|$)/i,
  tables: /(?:^|\/)tables(?:\/|$)/i,
  raw: /(?:^|\/)raw(?:\/|$)/i,
  experience: /(?:^|\/)(?:\.[^/]*-evolution|evolution|经验)(?:\/|$)/i,
  playbook: /data-playbook|查数手册/i,
  timeline: /时间线|(?:^|\/)timeline(?:\.|\/|$)/i,
  records: /(?:^|\/)raw\/(?:收件箱|records?|history)(?:\/|$)|当时记录/i,
  projects: /(?:^|\/)(?:projects?|项目|项目资料)(?:\/|$)|当前进展|项目进展/i,
};

const SENSITIVE_PATTERNS = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /credential/i,
  /^secrets\.json$/i,
  /^models\.json$/i,
  /^wecom\.json$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
];

const LARGE_BYTES = 500 * 1024 * 1024;
const LARGE_FILES = 50000;

/**
 * 把 glob 数组编译成路径过滤函数。无斜杠的规则按 basename 匹配任意层级，
 * 带斜杠的规则从来源根（相对来源根的路径）匹配，`**` 跨目录、`*` 不跨目录、
 * 结尾斜杠只匹配目录。调用方必须传入最终真实目标的相对路径，而不是软链自身名字。
 *
 * @param {string[]} patterns
 * @returns {(relPath: string, isDirectory?: boolean) => boolean}
 */
export function createPathFilter(patterns) {
  const rules = patterns
    .filter((pattern) => typeof pattern === "string" && pattern.trim())
    .map((pattern) => {
      const normalized = pattern.trim().replaceAll("\\", "/").replace(/^\.\//, "");
      const directoryOnly = normalized.endsWith("/");
      const body = normalized.replace(/\/+$/, "");
      return {
        directoryOnly,
        anchored: body.includes("/"),
        regex: globToRegExp(body),
      };
    });
  return (relPath, isDirectory = false) => {
    const normalized = relPath.replaceAll("\\", "/");
    return rules.some((rule) => {
      if (rule.directoryOnly && !isDirectory) return false;
      return rule.anchored ? rule.regex.test(normalized) : rule.regex.test(basename(normalized));
    });
  };
}

/**
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

/**
 * @param {string} name
 */
export function isSensitiveName(name) {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * 复制与盘点共用的路径过滤：默认排除始终生效，`includeSecrets` 只摘下凭证类规则，
 * 自定义 `exclude` 追加在其后。两处都从这里拿，避免复制与盘点各建一套。
 *
 * @param {{exclude?: string[], includeSecrets?: boolean}} [options]
 */
export function createSourcePathFilter({ exclude = [], includeSecrets = false } = {}) {
  return createPathFilter([
    ...DEFAULT_EXCLUDES.filter((pattern) => !includeSecrets || !SECRET_EXCLUDES.includes(pattern)),
    ...(Array.isArray(exclude) ? exclude : []),
  ]);
}

/**
 * @param {{name: string, path: string, maxDepth: number, exclude: string[], symlinks: "follow" | "skip" | "reject"}} options
 * @returns {Promise<InventoryCandidate>}
 */
async function scanRoot({ name, path, maxDepth, exclude, symlinks }) {
  let rootInfo;
  try {
    rootInfo = await lstat(path);
  } catch {
    return missingCandidate(name, path, "来源不存在或不可访问");
  }
  const isSymlink = rootInfo.isSymbolicLink();
  let info = rootInfo;
  if (isSymlink) {
    try {
      info = await stat(path);
    } catch {
      return missingCandidate(name, path, "来源是悬空符号链接");
    }
  }
  if (info.isFile()) return scanFileRoot({ name, path, info, isSymlink, exclude, symlinks });
  if (!info.isDirectory()) return missingCandidate(name, path, "来源不是普通文件或目录");

  let realRoot;
  try {
    realRoot = await realpath(path);
  } catch {
    return missingCandidate(name, path, "来源真实路径无法解析");
  }
  const state = createWalkState();
  await walkDirectory({
    directory: path,
    relPath: "",
    realRel: "",
    depth: 0,
    realRoot,
    maxDepth,
    state,
    filter: createSourcePathFilter({ exclude }),
    symlinks,
    ancestors: new Set([realRoot]),
  });

  if (symlinks === "reject" && state.rejectLinks.length > 0) {
    state.files = 0;
    state.bytes = 0;
    state.blockers.push(`遇到符号链接会中止复制：${state.rejectLinks.slice(0, 5).join("、")}`);
  }

  const kinds = [];
  if (state.skills > 0) kinds.push("skills");
  if (state.knowledgeDb) kinds.push("knowledge-db");
  if (state.knowledge) kinds.push("knowledge");
  if (state.hasGit && state.hasPackageManifest) kinds.push("code");
  if (state.history) kinds.push("history");
  const kind = kinds.length > 1 ? "mixed" : kinds[0] ?? "generic";

  return finalizeCandidate({
    name,
    path,
    type: "directory",
    kinds,
    kind,
    kindNote: kinds.length > 1 ? `同时包含 ${kinds.join("、")} 特征，按 mixed 归类` : null,
    totalFiles: state.totalFiles,
    files: state.files,
    bytes: state.bytes,
    skills: state.skills,
    skillNames: [...state.skillNames],
    resourceTypes: state.resourceTypes,
    symlinks: {
      count: state.symlinks,
      followed: state.symlinksFollowed,
      skipped: state.symlinksSkipped,
      followedOutsideRoot: state.symlinksOutside,
      broken: state.symlinksBroken,
      loops: state.symlinkLoops,
    },
    sensitive: state.sensitive,
    lastModified: state.lastModified,
    blockers: state.blockers,
    symlinksPolicy: symlinks,
  });
}

/**
 * 单文件来源也走同一套软链策略：解析真实目标、检查根外与敏感文件名，
 * 而不是只看链接自身名字。
 *
 * @param {{name: string, path: string, info: import("node:fs").Stats, isSymlink: boolean, exclude: string[], symlinks: "follow" | "skip" | "reject"}} options
 * @returns {Promise<InventoryCandidate>}
 */
async function scanFileRoot({ name, path, info, isSymlink, exclude, symlinks }) {
  const linkSkipped = isSymlink && symlinks === "skip";
  const linkRejected = isSymlink && symlinks === "reject";
  const filter = createSourcePathFilter({ exclude });
  const target = isSymlink && !linkSkipped && !linkRejected ? await realpath(path) : path;
  const targetName = basename(target);
  const sensitiveName = !linkSkipped && !linkRejected && isSensitiveName(targetName)
    ? targetName
    : !linkSkipped && !linkRejected && isSymlink && isSensitiveName(name)
      ? name
      : null;
  const excluded = !sensitiveName && !linkSkipped && !linkRejected && filter(targetName, false);
  const included = !sensitiveName && !excluded && !linkSkipped && !linkRejected;
  let followedOutsideRoot = 0;
  if (isSymlink && !linkSkipped && !linkRejected) {
    try {
      const parentRoot = await realpath(dirname(path));
      if (!isInside(target, parentRoot)) followedOutsideRoot = 1;
    } catch {
      // 无法解析父目录时按根内处理；复制阶段仍会再次校验。
    }
  }
  const resourceTypes = emptyResourceTypes();
  if (included) resourceTypes[classifyResourceType(name)] += 1;
  const sensitiveFiles = sensitiveName ? [sensitiveName] : [];
  return finalizeCandidate({
    name,
    path,
    type: "file",
    kinds: ["file"],
    kind: "file",
    kindNote: null,
    totalFiles: 1,
    files: included ? 1 : 0,
    bytes: included ? info.size : 0,
    skills: included && basename(name) === "SKILL.md" ? 1 : 0,
    skillNames: [],
    resourceTypes,
    symlinks: {
      count: isSymlink ? 1 : 0,
      followed: isSymlink && !linkSkipped && !linkRejected ? 1 : 0,
      skipped: linkSkipped ? 1 : 0,
      followedOutsideRoot,
      broken: 0,
      loops: 0,
    },
    sensitive: { files: sensitiveFiles, count: sensitiveFiles.length },
    lastModified: info.mtime.toISOString(),
    blockers: linkRejected
      ? [`资源不允许符号链接：${name}`]
      : linkSkipped
        ? [`来源文件是符号链接，已按 --symlinks skip 跳过：${name}`]
        : [],
    symlinksPolicy: symlinks,
  });
}

/**
 * @param {string} name
 * @param {string} path
 * @param {string} reason
 * @returns {InventoryCandidate}
 */
function missingCandidate(name, path, reason) {
  return finalizeCandidate({
    name,
    path,
    type: "missing",
    kinds: [],
    kind: "missing",
    kindNote: null,
    totalFiles: 0,
    files: 0,
    bytes: 0,
    skills: 0,
    skillNames: [],
    resourceTypes: emptyResourceTypes(),
    symlinks: { count: 0, followed: 0, skipped: 0, followedOutsideRoot: 0, broken: 0, loops: 0 },
    sensitive: { files: [], count: 0 },
    lastModified: null,
    blockers: [reason],
    symlinksPolicy: "follow",
  });
}

/**
 * @returns {{
 *   totalFiles: number, files: number, bytes: number, skills: number, skillNames: Set<string>,
 *   resourceTypes: Record<string, number>, symlinks: number, symlinksFollowed: number,
 *   symlinksSkipped: number, symlinksOutside: number, symlinksBroken: number, symlinkLoops: number,
 *   rejectLinks: string[], sensitive: {files: string[], count: number},
 *   lastModified: string | null, blockers: string[], knowledge: boolean, knowledgeDb: boolean,
 *   hasGit: boolean, hasPackageManifest: boolean, history: boolean, maxDepthReached: boolean
 * }}
 */
function createWalkState() {
  return {
    totalFiles: 0,
    files: 0,
    bytes: 0,
    skills: 0,
    skillNames: new Set(),
    resourceTypes: emptyResourceTypes(),
    symlinks: 0,
    symlinksFollowed: 0,
    symlinksSkipped: 0,
    symlinksOutside: 0,
    symlinksBroken: 0,
    symlinkLoops: 0,
    rejectLinks: [],
    sensitive: { files: [], count: 0 },
    lastModified: null,
    blockers: [],
    knowledge: false,
    knowledgeDb: false,
    hasGit: false,
    hasPackageManifest: false,
    history: false,
    maxDepthReached: false,
  };
}

/** @returns {Record<string, number>} */
function emptyResourceTypes() {
  return Object.fromEntries(RESOURCE_TYPES.map((type) => [type, 0]));
}

/**
 * @param {{
 *   directory: string,
 *   relPath: string,
 *   realRel: string,
 *   depth: number,
 *   realRoot: string,
 *   maxDepth: number,
 *   state: ReturnType<typeof createWalkState>,
 *   filter: (relPath: string, isDirectory?: boolean) => boolean,
 *   symlinks: "follow" | "skip" | "reject",
 *   ancestors: Set<string>
 * }} options
 */
async function walkDirectory({ directory, relPath, realRel, depth, realRoot, maxDepth, state, filter, symlinks, ancestors }) {
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? "读取失败";
    state.blockers.push(`目录不可读：${relPath || "."}（${code}）`);
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    const childRealRel = realRel ? `${realRel}/${entry.name}` : entry.name;
    const childPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      state.symlinks += 1;
      if (symlinks === "skip") {
        state.symlinksSkipped += 1;
        continue;
      }
      if (symlinks === "reject") {
        state.rejectLinks.push(childRel);
        continue;
      }
      await visitSymlink({
        linkPath: childPath,
        relPath: childRel,
        depth,
        realRoot,
        maxDepth,
        state,
        filter,
        symlinks,
        ancestors,
      });
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === ".git") {
        state.hasGit = true;
        continue;
      }
      if (filter(childRealRel, true)) continue;
      if (RESOURCE_PATTERNS.metrics.test(childRealRel) || /(?:^|\/)(?:queries|tables)(?:\/|$)/i.test(childRealRel)) {
        state.knowledgeDb = true;
      }
      if (/(?:^|\/)wiki(?:\/|$)|(?:^|\/)raw(?:\/|$)/i.test(childRealRel)) state.knowledge = true;
      if (/(?:^|\/)(?:projects?|项目|项目资料)(?:\/|$)|时间线|决策|收件箱/i.test(childRealRel)) state.history = true;
      if (depth >= maxDepth) {
        markMaxDepth(state, maxDepth);
        continue;
      }
      let realChild;
      try {
        realChild = await realpath(childPath);
      } catch {
        state.blockers.push(`目录真实路径无法解析：${childRel}`);
        continue;
      }
      await walkDirectory({
        directory: childPath,
        relPath: childRel,
        realRel: childRealRel,
        depth: depth + 1,
        realRoot,
        maxDepth,
        state,
        filter,
        symlinks,
        ancestors: new Set([...ancestors, realChild]),
      });
      continue;
    }
    if (!entry.isFile()) continue;
    state.totalFiles += 1;
    if (isSensitiveName(entry.name)) {
      recordSensitive(state, childRel);
      continue;
    }
    if (filter(childRealRel, false)) continue;
    let info;
    try {
      info = await stat(childPath);
    } catch {
      state.blockers.push(`文件不可读：${childRel}`);
      continue;
    }
    await recordIncludedFile(state, childRel, info, childPath);
  }
}

/**
 * 跟随软链：按最终真实目标的名字与相对路径过滤；敏感目标只计数不复制；
 * 目录软链递归并防环。
 *
 * @param {{
 *   linkPath: string,
 *   relPath: string,
 *   depth: number,
 *   realRoot: string,
 *   maxDepth: number,
 *   state: ReturnType<typeof createWalkState>,
 *   filter: (relPath: string, isDirectory?: boolean) => boolean,
 *   symlinks: "follow" | "skip" | "reject",
 *   ancestors: Set<string>
 * }} options
 */
async function visitSymlink({ linkPath, relPath, depth, realRoot, maxDepth, state, filter, symlinks, ancestors }) {
  let target;
  try {
    target = await realpath(linkPath);
  } catch {
    state.symlinksBroken += 1;
    return;
  }
  /** @type {import("node:fs").Stats} */
  let info;
  try {
    info = await stat(target);
  } catch {
    state.symlinksBroken += 1;
    return;
  }
  const outside = !isInside(target, realRoot);
  if (outside) state.symlinksOutside += 1;
  const targetRel = outside ? basename(target) : relative(realRoot, target);
  const targetName = basename(target);
  const sensitive = isSensitiveName(targetName) || isSensitiveName(basename(relPath));
  if (info.isDirectory()) {
    if (sensitive) {
      recordSensitive(state, relPath);
      return;
    }
    if (filter(targetRel, true)) return;
    if (ancestors.has(target)) {
      state.symlinkLoops += 1;
      return;
    }
    if (depth >= maxDepth) {
      markMaxDepth(state, maxDepth);
      return;
    }
    await walkDirectory({
      directory: target,
      relPath,
      realRel: targetRel,
      depth: depth + 1,
      realRoot,
      maxDepth,
      state,
      filter,
      symlinks,
      ancestors: new Set([...ancestors, target]),
    });
    state.symlinksFollowed += 1;
    return;
  }
  if (!info.isFile()) {
    state.symlinksSkipped += 1;
    return;
  }
  state.totalFiles += 1;
  if (sensitive) {
    recordSensitive(state, relPath);
    return;
  }
  if (filter(targetRel, false)) return;
  await recordIncludedFile(state, relPath, info, target);
  state.symlinksFollowed += 1;
}

/**
 * @param {ReturnType<typeof createWalkState>} state
 * @param {string} relPath
 * @param {import("node:fs").Stats} info
 * @param {string} filePath
 */
async function recordIncludedFile(state, relPath, info, filePath) {
  state.files += 1;
  state.bytes += info.size;
  if (!state.lastModified || info.mtime.toISOString() > state.lastModified) {
    state.lastModified = info.mtime.toISOString();
  }
  state.resourceTypes[classifyResourceType(relPath)] += 1;
  if (/(?:^|\/)(?:package\.json|pom\.xml)$/i.test(relPath)) state.hasPackageManifest = true;
  if (/概念/i.test(relPath)) state.knowledge = true;
  if (/(?:时间线|决策|收件箱|当时记录)/i.test(relPath)) state.history = true;
  if (basename(relPath) === "SKILL.md") {
    state.skills += 1;
    const skillName = await readSkillName(filePath);
    if (skillName) state.skillNames.add(skillName);
  }
}

/** @param {ReturnType<typeof createWalkState>} state @param {number} maxDepth */
function markMaxDepth(state, maxDepth) {
  if (state.maxDepthReached) return;
  state.maxDepthReached = true;
  state.blockers.push(`到达 --max-depth ${maxDepth}，更深层内容未统计`);
}

/**
 * @param {ReturnType<typeof createWalkState>} state
 * @param {string} relPath
 */
function recordSensitive(state, relPath) {
  state.sensitive.files.push(relPath);
  state.sensitive.count += 1;
}

/**
 * @param {string} path
 */
function classifyResourceType(path) {
  if (RESOURCE_PATTERNS.playbook.test(path)) return "playbook";
  if (RESOURCE_PATTERNS.experience.test(path)) return "experience";
  if (RESOURCE_PATTERNS.metrics.test(path)) return "metrics";
  if (RESOURCE_PATTERNS.tables.test(path)) return "tables";
  if (RESOURCE_PATTERNS.sql.test(path)) return "sql";
  if (RESOURCE_PATTERNS.timeline.test(path)) return "timeline";
  if (RESOURCE_PATTERNS.records.test(path)) return "records";
  if (RESOURCE_PATTERNS.projects.test(path)) return "projects";
  if (RESOURCE_PATTERNS.raw.test(path)) return "raw";
  return "concepts";
}

/** 只读 SKILL.md 开头的 frontmatter，取 name；不读取正文其余部分。 @param {string} path */
async function readSkillName(path) {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(2048);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const header = buffer.subarray(0, bytesRead).toString("utf8").match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? "";
      const name = header.match(/^name:\s*(.+)$/m)?.[1]?.trim();
      return name ? name.replace(/^["']|["']$/g, "") : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** @param {string} target @param {string} root */
function isInside(target, root) {
  return target === root || target.startsWith(`${root}${sep}`);
}

/**
 * @param {{
 *   name: string, path: string, type: "directory" | "file" | "missing",
 *   kinds: string[], kind: string, kindNote: string | null,
 *   totalFiles: number, files: number, bytes: number,
 *   skills: number, skillNames: string[],
 *   resourceTypes: Record<string, number>,
 *   symlinks: {count: number, followed: number, skipped: number, followedOutsideRoot: number, broken: number, loops: number},
 *   sensitive: {files: string[], count: number},
 *   lastModified: string | null, blockers: string[],
 *   symlinksPolicy: "follow" | "skip" | "reject"
 * }} options
 * @returns {InventoryCandidate}
 */
function finalizeCandidate(options) {
  const { symlinksPolicy, ...candidate } = options;
  return {
    ...candidate,
    recommended: recommend({ ...options, symlinksPolicy }),
  };
}

/**
 * 推荐规则必须确定、可解释，初始化协议会逐条向用户复述。
 * 推荐与复制策略必须自洽：存在根外软链时不能推荐 shared + follow。
 *
 * @param {{
 *   type: "directory" | "file" | "missing", kind: string, kinds: string[],
 *   totalFiles: number, files: number, bytes: number,
 *   sensitive: {count: number},
 *   symlinks: {count: number, followed: number, skipped: number, followedOutsideRoot: number, broken: number, loops: number},
 *   blockers: string[],
 *   symlinksPolicy: "follow" | "skip" | "reject"
 * }} options
 * @returns {InventoryCandidate["recommended"]}
 */
function recommend(options) {
  const reasons = [];
  const kinds = Array.isArray(options.kinds) ? options.kinds : [];
  const files = options.files;
  const include = options.type !== "missing" && files > 0;
  if (!include) {
    if (options.type === "missing") reasons.push("来源不可读，不能同步");
    else if (options.sensitive.count > 0) {
      reasons.push(`排除 ${options.sensitive.count} 个敏感文件后没有可同步的普通文件`);
    } else reasons.push("没有可同步的普通文件");
  }
  if (options.blockers.length > 0) reasons.push(options.blockers.join("；"));
  if (options.sensitive.count > 0 && files > 0) {
    reasons.push(`排除 ${options.sensitive.count} 个敏感文件后仍可同步 ${files} 个文件`);
  }

  const hasCode = kinds.includes("code");
  const hasKnowledge = kinds.some((kind) => ["knowledge", "knowledge-db", "skills"].includes(kind));
  const hasHistory = kinds.includes("history");
  const large = options.bytes > LARGE_BYTES || files > LARGE_FILES;
  const scope = hasCode ? "private" : "shared";
  let symlinks = options.symlinksPolicy;
  const outside = options.symlinks.followedOutsideRoot;
  if (options.symlinksPolicy === "skip") {
    if (options.symlinks.skipped > 0) reasons.push(`按 --symlinks skip 跳过 ${options.symlinks.skipped} 个软链`);
  } else if (options.symlinksPolicy === "reject") {
    if (options.symlinks.count > 0) reasons.push("按 --symlinks reject，遇到符号链接会中止复制");
  } else if (outside > 0) {
    if (scope === "shared") {
      // shared + follow 会直接拒绝根外软链，推荐必须改为自洽的组合。
      symlinks = "follow";
      reasons.push(
        `含 ${outside} 个指向来源根之外的软链：shared 来源会拒绝这些软链，推荐 private 并跟随；若必须 shared，请同时选择 --symlinks skip（会跳过全部软链）`,
      );
    } else {
      reasons.push(`含 ${outside} 个指向来源根之外的软链；private 来源会跟随并计入 followedOutsideRoot`);
    }
  } else if (options.symlinks.count > 0) {
    reasons.push(`含 ${options.symlinks.count} 个软链，按 follow 复制目标内容并防环`);
  }
  if (options.symlinks.loops > 0) reasons.push(`检测到 ${options.symlinks.loops} 个软链环，已跳过`);
  if (large) {
    reasons.push(`体积 ${formatBytes(options.bytes)}、${files} 个文件，完整同步可能较慢，建议降低频率`);
  }
  if (hasCode) {
    reasons.push(
      kinds.length > 1
        ? "含代码仓库特征，默认建议私有范围并每周同步；只有用户明确同意才按共享处理"
        : "纯代码仓库默认建议私有范围并每周同步；只有用户明确同意才按共享处理",
    );
  }
  if (hasKnowledge) reasons.push("知识或 Skills 来源建议团队共享并按天同步，具体以用户选择为准");
  if (hasHistory) reasons.push("历史资料变化较少，建议每周同步");
  if (options.kind === "file") reasons.push("单文件来源建议手动同步，避免频繁覆盖");
  /** @type {Cadence} */
  const cadence =
    hasCode || hasHistory || (large && !hasKnowledge)
      ? { kind: "weekly", weekdays: [1], at: "09:00" }
      : options.kind === "file"
        ? { kind: "manual" }
        : { kind: "daily", at: "09:00" };
  return {
    include,
    scope: hasCode ? "private" : options.symlinks.followedOutsideRoot > 0 ? "private" : scope,
    cadence,
    symlinks: /** @type {"follow" | "skip" | "reject"} */ (symlinks),
    reason: reasons.length > 0 ? reasons.join("；") : "常规来源，可按用户选择同步",
  };
}

/** @param {number} bytes */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/**
 * 只读盘点一组来源，返回可直接交给用户选择的 JSON 结构。
 * `--exclude` 与 `--symlinks` 与复制阶段一致，因此 `files` / `bytes` 就是实际将复制的量；
 * `totalFiles` 是排除前的扫描总量。
 *
 * @param {{roots: string[], maxDepth?: number, exclude?: string[], symlinks?: "follow" | "skip" | "reject"}} options
 */
export async function scanInventory({ roots, maxDepth = Number.POSITIVE_INFINITY, exclude = [], symlinks = "follow" }) {
  for (const root of roots) {
    // 与 copy 共用同一套 URL 凭证检测：含 userinfo 的地址直接拒绝，回显一律脱敏。
    if (hasUrlCredentials(String(root))) {
      throw new Error(
        `盘点来源地址包含内嵌凭证（userinfo），拒绝处理：${redactSourceCredentials(String(root))}；请改用无凭据地址`,
      );
    }
  }
  /** @type {InventoryCandidate[]} */
  const candidates = [];
  for (const root of roots) {
    let identity;
    try {
      identity = await normalizeSource({ path: String(root), type: "auto" }, { allowRemote: false });
    } catch {
      identity = { name: basename(String(root)) || String(root), sourcePath: String(root) };
    }
    candidates.push(
      await scanRoot({ name: identity.name, path: identity.sourcePath, maxDepth, exclude, symlinks }),
    );
  }
  return {
    roots: roots.map((root) => resolve(root)),
    candidates,
    totals: {
      candidates: candidates.length,
      files: sum(candidates, (candidate) => candidate.files),
      bytes: sum(candidates, (candidate) => candidate.bytes),
      skills: sum(candidates, (candidate) => candidate.skills),
      sensitiveFiles: sum(candidates, (candidate) => candidate.sensitive.count),
      symlinks: sum(candidates, (candidate) => candidate.symlinks.count),
      included: candidates.filter((candidate) => candidate.recommended.include).length,
    },
  };
}

/**
 * @param {InventoryCandidate[]} candidates
 * @param {(candidate: InventoryCandidate) => number} select
 */
function sum(candidates, select) {
  return candidates.reduce((total, candidate) => total + select(candidate), 0);
}

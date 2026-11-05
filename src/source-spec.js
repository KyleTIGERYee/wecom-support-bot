import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeCadence } from "./sync-plan.js";

/**
 * 来源规范化的唯一入口。init / sync / sync-due / plan / inventory 都从这里拿到
 * 名称、原始路径、类型与复制选项，避免各命令按 basename 或各自规则重建身份。
 *
 * @typedef {"directory" | "file" | "package" | "gitlab" | "missing"} SourceType
 * @typedef {"follow" | "skip" | "reject"} SymlinkPolicy
 * @typedef {{
 *   name: string,
 *   sourcePath: string,
 *   type: SourceType,
 *   scope: "shared" | "private" | undefined,
 *   cadence: import("./sync-plan.js").Cadence,
 *   exclude: string[],
 *   symlinks: SymlinkPolicy,
 *   includeSecrets: boolean,
 *   ref?: string
 * }} SourceSpec
 * @typedef {{path?: string, type?: string, ref?: string}} RegistryEntry
 */

const SOURCE_TYPES = ["auto", "directory", "file", "package", "gitlab"];
const SYMLINK_POLICIES = ["follow", "skip", "reject"];

/** @param {string} value */
export function isRemoteSource(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^/\s@]+@[^/\s:]+:.+/.test(value);
}

/**
 * HTTP(S) 内嵌用户名/密码，或任何带密码的 URL，都属于会把凭证带进状态文件的来源。
 * `ssh://git@host/...` 与 `git@host:repo` 只带用户名，允许交给 SSH agent。
 *
 * @param {string} value
 */
export function hasUrlCredentials(value) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.password) return true;
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.username);
  } catch {
    return false;
  }
}

/** @param {string} value */
export function redactSourceCredentials(value) {
  return String(value)
    .replace(/((?:https?|ssh):\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi, "$1***@");
}

/**
 * @param {string} source
 * @returns {{path: string, local: boolean, protocols: string, name: string}}
 */
export function parseGitlabSource(source) {
  if (source.startsWith("file://")) {
    const path = fileURLToPath(source);
    return { path, local: true, protocols: "file", name: basename(path).replace(/\.git$/i, "") };
  }
  if (/^https?:\/\//i.test(source) || /^ssh:\/\//i.test(source)) {
    const url = new URL(source);
    const name = basename(url.pathname).replace(/\.git$/i, "");
    if (!name) throw new Error("GitLab 来源必须包含仓库路径");
    return {
      path: source,
      local: false,
      protocols: url.protocol === "ssh:" ? "ssh" : "http:https",
      name,
    };
  }
  if (/^[^/\s@]+@[^/\s:]+:.+/.test(source)) {
    const repositoryPath = source.slice(source.indexOf(":") + 1);
    const name = basename(repositoryPath).replace(/\.git$/i, "");
    if (!name) throw new Error("GitLab 来源必须包含仓库路径");
    return { path: source, local: false, protocols: "ssh", name };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw new Error("GitLab 只支持 file、HTTP(S) 或 SSH 来源");
  const path = resolve(source);
  return { path, local: true, protocols: "file", name: basename(path).replace(/\.git$/i, "") };
}

/**
 * 已存在路径直接 realpath；不存在尾部从最近的已存在祖先解析，避免符号链接别名绕过。
 *
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function resolveRealPath(path) {
  let current = resolve(path);
  /** @type {string[]} */
  const missing = [];
  while (true) {
    try {
      const resolved = await realpath(current);
      return join(resolved, ...missing);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error(`不能解析悬空符号链接：${current}`);
      } catch (lstatError) {
        if (/** @type {NodeJS.ErrnoException} */ (lstatError).code !== "ENOENT") throw lstatError;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** @param {string} left @param {string} right */
export function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * @param {string} sourcePath
 * @param {string} requestedType
 * @returns {Promise<SourceType | "missing">}
 */
async function detectLocalType(sourcePath, requestedType) {
  let info;
  try {
    info = await lstat(sourcePath);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw error;
  }
  let target = info;
  if (info.isSymbolicLink()) {
    try {
      target = await stat(sourcePath);
    } catch {
      return "missing";
    }
  }
  const isFile = target.isFile();
  /** @type {SourceType | "missing"} */
  const detected = target.isDirectory()
    ? "directory"
    : isFile && extname(sourcePath).toLowerCase() === ".zip"
      ? "package"
      : isFile
        ? "file"
        : "missing";
  if (requestedType === "auto" || detected === "missing") return detected;
  if (detected !== requestedType) {
    throw new Error(`来源实际类型与 --source-type ${requestedType} 不一致`);
  }
  return requestedType;
}

/**
 * 把任意命令输入（init/sync 的 CLI 参数、sync-due 的计划条目、inventory 的 --root）
 * 收敛成同一份来源描述。scope 允许缺省，由复制/计划阶段按各自策略拒绝。
 *
 * @param {{path?: string, type?: string, ref?: string, scope?: string, cadence?: import("./sync-plan.js").CadenceInput, exclude?: string[], symlinks?: string, includeSecrets?: boolean}} input
 * @param {{template?: string, allowRemote?: boolean}} [options]
 * @returns {Promise<SourceSpec>}
 */
export async function normalizeSource(input, options = {}) {
  const rawPath = typeof input?.path === "string" ? input.path.trim() : "";
  if (!rawPath) throw new Error("来源缺少原始路径，无法重新同步；请用 sync --source 指定原始来源");
  if (hasUrlCredentials(rawPath)) {
    throw new Error("来源地址包含内嵌凭证（userinfo），拒绝登记；请改用无凭据地址或 SSH agent");
  }
  const requestedType = input.type ?? "auto";
  if (!SOURCE_TYPES.includes(requestedType)) throw new Error(`不支持的来源类型：${requestedType}`);
  const remote = isRemoteSource(rawPath);
  const allowRemote = options.allowRemote ?? true;

  /** @type {SourceType} */
  let type;
  let sourcePath;
  let name;
  if (remote) {
    if (!allowRemote) throw new Error("inventory 只接受本地目录或文件");
    if (requestedType !== "gitlab") throw new Error("远程来源需要 --source-type gitlab");
    const gitlab = parseGitlabSource(rawPath);
    sourcePath = rawPath;
    type = "gitlab";
    name = gitlab.name;
  } else if (requestedType === "gitlab") {
    const gitlab = parseGitlabSource(rawPath);
    sourcePath = gitlab.path;
    type = "gitlab";
    name = gitlab.name;
  } else {
    sourcePath = resolve(rawPath);
    const detected = await detectLocalType(sourcePath, requestedType);
    type = detected;
    name = detected === "package" ? basename(sourcePath, extname(sourcePath)) : basename(sourcePath);
  }

  const scope = input.scope;
  if (scope !== undefined && !["shared", "private"].includes(scope)) {
    throw new Error("每个本地来源都必须明确共享或个人私有范围");
  }
  const includeSecrets = input.includeSecrets === true;
  if (includeSecrets && scope !== "private") {
    throw new Error("--include-secrets 只能用于 private 来源；shared 来源不得包含凭证文件");
  }
  if (options.template === "team" && scope !== undefined && scope !== "shared") {
    throw new Error("团队实例只能使用明确共享的来源");
  }
  const symlinks = input.symlinks ?? "follow";
  if (!SYMLINK_POLICIES.includes(symlinks)) throw new Error(`不支持的软链策略：${symlinks}`);
  const exclude = Array.isArray(input.exclude)
    ? input.exclude.filter((pattern) => typeof pattern === "string")
    : [];
  const cadence = normalizeCadence(input.cadence ?? { kind: "manual" });
  const ref = input.ref;
  if (ref !== undefined && typeof ref !== "string") throw new Error("--ref 必须是字符串");
  if (ref && ref.startsWith("-")) throw new Error("GitLab ref 不能是命令选项");

  return {
    name,
    sourcePath,
    type,
    scope: /** @type {"shared" | "private" | undefined} */ (scope),
    cadence,
    exclude,
    symlinks: /** @type {SymlinkPolicy} */ (symlinks),
    includeSecrets,
    ...(ref ? { ref } : {}),
  };
}

/**
 * 来源身份键。本地路径一律 realpath；远程地址用不含 userinfo 的规范 URL。
 *
 * @param {string} value
 * @returns {Promise<string>}
 */
export async function canonicalSourceKey(value) {
  if (hasUrlCredentials(value)) {
    throw new Error("来源地址包含内嵌凭证（userinfo），拒绝登记；请改用无凭据地址或 SSH agent");
  }
  if (value.startsWith("file://")) {
    return `local:${await resolveRealPath(fileURLToPath(value))}`;
  }
  if (isRemoteSource(value)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      const url = new URL(value);
      return `remote:${url.protocol}//${url.host}${url.pathname}`;
    }
    return `remote:${value}`;
  }
  return `local:${await resolveRealPath(resolve(value))}`;
}

/**
 * 同一实例内来源名必须唯一：registry 按 name 存储，同名不同路径会互相覆盖，
 * 两份标准副本也会共用名称而无法区分。重复时列出冲突来源的真实路径。
 *
 * @param {{name?: string, path?: string}[]} sources
 * @returns {Promise<void>}
 */
export async function assertUniqueSourceNames(sources) {
  /** @type {Map<string, string[]>} */
  const byName = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    const name = typeof source?.name === "string" ? source.name.trim() : "";
    if (!name) continue;
    const paths = byName.get(name) ?? [];
    paths.push(typeof source?.path === "string" ? source.path : "");
    byName.set(name, paths);
  }
  const conflicts = [];
  for (const [name, paths] of byName) {
    if (paths.length < 2) continue;
    const described = await Promise.all(paths.map(describeSourcePath));
    conflicts.push(`${name}（${described.join(" 与 ")}）`);
  }
  if (conflicts.length === 0) return;
  throw new Error(
    `来源名称重复，同一实例内来源名必须唯一：${conflicts.join("；")}。请改名或合并后再试`,
  );
}

/** 错误信息里只展示真实路径（本地）或脱敏后的地址（远程）。 @param {string} value */
async function describeSourcePath(value) {
  if (!value) return "未提供原始路径";
  const redacted = redactSourceCredentials(value);
  if (isRemoteSource(value)) return redacted;
  try {
    return await resolveRealPath(value);
  } catch {
    return redacted;
  }
}

/**
 * 只按 registry 中按真实路径精确匹配来源；同名不同路径、未登记、指向实例内副本
 * 一律报错并列出候选，绝不接受“同名就算同一个”。
 *
 * @param {Record<string, RegistryEntry>} registry
 * @param {string} value
 * @param {{instanceDir: string}} options
 * @returns {Promise<{name: string, path: string, type?: string, ref?: string}>}
 */
export async function findRegisteredSource(registry, value, { instanceDir }) {
  const inputKey = await canonicalSourceKey(value);
  if (inputKey.startsWith("local:")) {
    const inputPath = inputKey.slice("local:".length);
    for (const root of [
      instanceDir,
      join(instanceDir, "context"),
      join(instanceDir, "workspace"),
      join(instanceDir, "data"),
    ]) {
      if (pathsOverlap(inputPath, await resolveRealPath(root))) {
        throw new Error(`--source 必须提供原始来源路径，不能指向实例内的标准副本或实例目录：${value}`);
      }
    }
  }
  /** @type {{name: string, path: string, type?: string, ref?: string, key: string}[]} */
  const entries = [];
  for (const [name, entry] of Object.entries(registry)) {
    if (!entry || typeof entry.path !== "string") continue;
    entries.push({ name, path: entry.path, ...(entry.type ? { type: entry.type } : {}), ...(entry.ref ? { ref: entry.ref } : {}), key: await canonicalSourceKey(entry.path) });
  }
  const candidates = entries.length > 0
    ? entries.map((entry) => `${entry.name}（${redactSourceCredentials(entry.path)}）`).join("、")
    : "（无）";
  const exact = entries.filter((entry) => entry.key === inputKey);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`有多个已登记来源指向同一真实路径，无法唯一定位：${exact.map((entry) => entry.name).join("、")}`);
  }
  const spec = await normalizeSource({
    path: value,
    type: isRemoteSource(value) ? "gitlab" : "auto",
  });
  const sameName = entries.filter((entry) => entry.name === spec.name);
  if (sameName.length > 0) {
    throw new Error(`来源与已登记来源同名但路径不同：${spec.name}；已登记候选：${candidates}。请使用登记时的原始路径，或先用 sync 重新登记`);
  }
  throw new Error(`来源未登记：${redactSourceCredentials(value)}；已登记候选：${candidates}。请先运行 init 或 sync 登记来源`);
}

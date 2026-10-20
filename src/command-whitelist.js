import { resolve, sep } from "node:path";

/** 允许被 python3 执行的检索脚本（按文件名匹配）。 */
const ALLOWED_SCRIPT_NAMES = new Set([
  "search_db.py",
  "search_queries.py",
  "search_wiki.py",
  "bi_query.py",
]);

/** 允许直接执行的只读命令。 */
const ALLOWED_COMMANDS = new Set([
  "grep",
  "rg",
  "find",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "python3",
]);

/**
 * 能改变数据流向或串联命令的 shell 元字符。
 * 出现任意一个即拒绝：重定向可写文件，管道与反引号可外传，分号与 & 可串联。
 */
const FORBIDDEN_METACHARS = [">", "<", "|", ";", "&", "`", "$(", "${", "\n"];

/**
 * @param {string} token
 * @returns {boolean}
 */
function looksLikePath(token) {
  return token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("~/");
}

/**
 * 把路径 token 解析为绝对路径，判断是否落在白名单根内。
 * 相对路径按 cwd 与各根目录依次尝试解析（agent 通常用绝对路径，这里做兜底）。
 *
 * @param {string} token
 * @param {string[]} roots
 * @param {string} cwd
 * @returns {boolean}
 */
function isInsideRoots(token, roots, cwd) {
  /** @type {string[]} */
  const candidates = [];
  if (token.startsWith("~/")) {
    candidates.push(resolve(process.env.HOME ?? "/Users/kyle", token.slice(2)));
  } else if (token.startsWith("/")) {
    candidates.push(resolve(token));
  } else {
    candidates.push(resolve(cwd, token));
    for (const root of roots) candidates.push(resolve(root, token));
  }

  return candidates.some((candidate) =>
    roots.some((root) => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)),
  );
}

/**
 * 判断一条 bash 命令是否允许执行。
 *
 * 这是 agent 的实际权限边界：pi 的 `--tools "read,bash"` 只限制工具种类，
 * bash 本身什么都能做，所以必须在命令层再拦一道。
 *
 * @param {string} command
 * @param {string[]} roots 允许访问的文件系统根目录
 * @param {{cwd?: string}} [options]
 * @returns {{allowed: boolean, reason?: string}}
 */
export function isCommandAllowed(command, roots, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const trimmed = (command ?? "").trim();

  if (!trimmed) {
    return { allowed: false, reason: "空命令" };
  }

  const hit = FORBIDDEN_METACHARS.find((meta) => trimmed.includes(meta));
  if (hit) {
    return { allowed: false, reason: `包含 shell 元字符 ${JSON.stringify(hit)}，可能改写文件或外传数据` };
  }

  const tokens = trimmed.split(/\s+/).map(stripQuotes).filter(Boolean);
  const executable = tokens[0] ?? "";

  if (!ALLOWED_COMMANDS.has(executable)) {
    return { allowed: false, reason: `命令 ${executable} 不在白名单内` };
  }

  if (executable === "python3") {
    const scriptIndex = tokens.findIndex((token, index) => index > 0 && token.endsWith(".py"));
    if (scriptIndex === -1) {
      return { allowed: false, reason: "python3 未指定脚本" };
    }
    const script = tokens[scriptIndex] ?? "";
    const scriptName = script.split("/").pop() ?? "";
    if (!ALLOWED_SCRIPT_NAMES.has(scriptName)) {
      return { allowed: false, reason: `脚本 ${scriptName} 不在白名单内` };
    }
    if (!script.startsWith("/")) {
      return { allowed: false, reason: "脚本必须使用绝对路径" };
    }
    if (!isInsideRoots(script, roots, cwd)) {
      return { allowed: false, reason: `路径越界：${script}` };
    }
    return { allowed: true };
  }

  for (const token of tokens.slice(1)) {
    if (token.startsWith("-")) continue;
    if (!looksLikePath(token)) continue;
    if (!isInsideRoots(token, roots, cwd)) {
      return { allowed: false, reason: `路径越界：${token}` };
    }
  }

  return { allowed: true };
}

/**
 * 去掉包裹 token 的成对引号。
 * @param {string} token
 * @returns {string}
 */
function stripQuotes(token) {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

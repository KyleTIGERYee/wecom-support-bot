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
  "node",
]);

/** 允许用 node 执行的只读脚本：经验检索与指标路由。 */
const ALLOWED_NODE_SCRIPTS = new Set([
  "/Users/kyle/Desktop/VIBECODING/wecom-support-bot/scripts/read-evolution.js",
  "/Users/kyle/Desktop/VIBECODING/wecom-support-bot/scripts/search-bridge.js",
]);

/**
 * 能改变数据流向或串联命令的 shell 元字符。
 * 出现任意一个即拒绝：重定向可写文件，管道与反引号可外传，分号与 & 可串联。
 * `$` 单独列出，用于拦住 `$HOME` 这类变量展开绕过路径检查。
 */
const FORBIDDEN_METACHARS = [">", "<", "|", ";", "&", "`", "$", "\n"];

/** 能把只读命令变成写操作或任意执行的参数；同时匹配 `-flag` 与 `-flag=value`。 */
const DANGEROUS_FLAGS = /^(?:-delete|-exec|-execdir|-fprint|-fprintf|-fls|-ok|--pre|--pre-glob)(?:=|$)/;

/**
 * 找出引号外的 shell 元字符。
 *
 * 必须区分引号内外：`bi_query.py "SELECT ... WHERE t <> ''"` 里的 `<>` 是 SQL
 * 比较运算符，不是 shell 重定向。只扫描引号外的字符，引号内的原样放行。
 *
 * @param {string} command
 * @returns {string|null} 命中的元字符，没有则 null
 */
function findUnquotedMetachar(command) {
  let quote = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (FORBIDDEN_METACHARS.includes(ch)) return ch;
  }
  return null;
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

  const hit = findUnquotedMetachar(trimmed);
  if (hit) {
    return { allowed: false, reason: `包含 shell 元字符 ${JSON.stringify(hit)}，可能改写文件或外传数据` };
  }

  const tokens = trimmed.split(/\s+/).map(stripQuotes).filter(Boolean);
  const executable = tokens[0] ?? "";

  if (!ALLOWED_COMMANDS.has(executable)) {
    return { allowed: false, reason: `命令 ${executable} 不在白名单内` };
  }

  const dangerousFlag = tokens.find((token) => DANGEROUS_FLAGS.test(token));
  if (dangerousFlag) {
    return { allowed: false, reason: `参数 ${dangerousFlag} 会让只读命令变成写操作` };
  }

  if (executable === "node") {
    const script = tokens.slice(1).find((token) => token.endsWith(".js")) ?? "";
    if (!ALLOWED_NODE_SCRIPTS.has(script)) {
      return { allowed: false, reason: `脚本 ${script || "(未指定)"} 不在白名单内` };
    }
    for (const token of tokens.slice(1)) {
      if (ALLOWED_NODE_SCRIPTS.has(token)) continue;
      if (token.startsWith("/") && !isInsideRoots(token, roots)) {
        return { allowed: false, reason: `路径越界：${token}` };
      }
    }
    return { allowed: true };
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
    if (!isInsideRoots(script, roots)) {
      return { allowed: false, reason: `路径越界：${script}` };
    }
    return { allowed: true };
  }

  const operands = tokens.slice(1).filter((token) => !token.startsWith("-"));
  // grep/rg 的第一个非选项参数是搜索模式，不是路径
  const patternCount = executable === "grep" || executable === "rg" ? 1 : 0;

  for (const token of operands.slice(patternCount)) {
    if (!token.startsWith("/")) {
      // 相对路径、~ 展开、裸文件名都以 cwd（项目根）为基准，
      // 而项目根下就有 config/secrets.json，因此一律要求绝对路径。
      return { allowed: false, reason: `只接受绝对路径：${token}` };
    }
    if (!isInsideRoots(token, roots)) {
      return { allowed: false, reason: `路径越界：${token}` };
    }
  }

  for (const pattern of operands.slice(0, patternCount)) {
    if (pattern.startsWith("/") || pattern.startsWith("~")) {
      return { allowed: false, reason: `搜索模式不能是路径：${pattern}` };
    }
  }

  return { allowed: true };
}

/**
 * 判断路径是否落在白名单根内。
 *
 * @param {string} token 绝对路径
 * @param {string[]} roots
 * @returns {boolean}
 */
export function isInsideRoots(token, roots) {
  if (!token.startsWith("/")) return false;
  const normalized = resolve(token);
  return roots.some((root) => {
    const normalizedRoot = resolve(root);
    return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + sep);
  });
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

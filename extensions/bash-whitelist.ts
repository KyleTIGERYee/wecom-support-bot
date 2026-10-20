/**
 * bash 白名单扩展。
 *
 * pi 的 `--tools "read,bash"` 只限制工具种类，bash 本身能读写文件、外传数据。
 * 这个扩展在 tool_call 阶段拦下所有不在白名单内的命令，是 agent 的实际权限边界。
 *
 * 判定逻辑与 src/command-whitelist.js 一致，但扩展独立运行在 pi 进程里，
 * 不能 import 项目源码（pi 的扩展加载器不解析项目模块路径），因此这里内联实现。
 */

/** 允许被 python3 执行的检索脚本。 */
const ALLOWED_SCRIPTS = new Set(["search_db.py", "search_queries.py", "search_wiki.py", "bi_query.py"]);

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

/** 改变数据流向或串联命令的元字符。 */
const FORBIDDEN_METACHARS = [">", "<", "|", ";", "&", "`", "$(", "${", "\n"];

/** 允许访问的文件系统根。与 config/default.json 的 roots 保持一致。 */
const ROOTS = [
	"/Users/kyle/Desktop/PM/.agents/skills/ajly-wiki",
	"/Users/kyle/Desktop/归档资料/王董的目录/lzz-wiki",
	"/Users/kyle/Desktop/PM/信息技术部资产库/知识库/数据库/ajly-db-wiki",
	"/Users/kyle/Desktop/PM/信息技术部资产库/知识库/数据库/lzz-db-wiki",
	"/Users/kyle/Desktop/VIBECODING/ajly",
	"/Users/kyle/Desktop/VIBECODING/lezuzu",
];

function stripQuotes(token: string): string {
	if (token.length >= 2) {
		const first = token[0];
		const last = token[token.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return token.slice(1, -1);
		}
	}
	return token;
}

function isInsideRoots(token: string): boolean {
	const HOME = "/Users/kyle";
	let absolute: string;
	if (token.startsWith("~/")) absolute = `${HOME}/${token.slice(2)}`;
	else if (token.startsWith("/")) absolute = token;
	else return false;

	const normalized = absolute.replace(/\/+/g, "/");
	return ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}/** 判断命令是否允许。理由会写进 block 的 reason，显示给模型。 */
export function checkCommand(command: string): { allowed: boolean; reason?: string } {
	const trimmed = (command ?? "").trim();
	if (!trimmed) return { allowed: false, reason: "空命令" };

	const meta = FORBIDDEN_METACHARS.find((m) => trimmed.includes(m));
	if (meta) {
		return { allowed: false, reason: `命令里出现 ${JSON.stringify(meta)}，只允许单条只读命令` };
	}

	const tokens = trimmed.split(/\s+/).map(stripQuotes).filter(Boolean);
	const executable = tokens[0] ?? "";
	if (!ALLOWED_COMMANDS.has(executable)) {
		return { allowed: false, reason: `命令 ${executable} 不在白名单内` };
	}

	if (executable === "python3") {
		const script = tokens.find((t, i) => i > 0 && t.endsWith(".py")) ?? "";
		const scriptName = script.split("/").pop() ?? "";
		if (!ALLOWED_SCRIPTS.has(scriptName)) {
			return { allowed: false, reason: `脚本 ${scriptName} 不在白名单内` };
		}
		if (!script.startsWith("/") || !isInsideRoots(script)) {
			return { allowed: false, reason: `路径越界：${script}` };
		}
		return { allowed: true };
	}

	for (const token of tokens.slice(1)) {
		if (token.startsWith("-")) continue;
		const looksLikePath =
			token.startsWith("/") || token.startsWith("~/") || token.startsWith("./") || token.startsWith("../");
		// 非路径 token（如 grep 的搜索词）放行；裸的相对路径 "." 一律按越界处理，
		// 否则 agent 可以用 `find .` 扫描整个项目目录读到凭证。
		if (!looksLikePath) {
			if (token === "." || token === "..") {
				return { allowed: false, reason: `路径越界：${token}` };
			}
			continue;
		}
		if (!isInsideRoots(token)) {
			return { allowed: false, reason: `路径越界：${token}` };
		}
	}

	return { allowed: true };
}

export default function bashWhitelist(pi: any) {
	pi.on("tool_call", async (event: any) => {
		if (event.toolName !== "bash") return;
		const command = event.input?.command;
		if (typeof command !== "string") return;

		const verdict = checkCommand(command);
		if (verdict.allowed) return;

		return { block: true, reason: `${verdict.reason}。请改用知识库检索脚本或读取文档。` };
	});
}

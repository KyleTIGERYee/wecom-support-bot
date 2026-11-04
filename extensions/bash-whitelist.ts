/**
 * 文件系统访问白名单扩展。
 *
 * pi 的 `--tools "read,bash"` 只限制工具种类，两个工具本身都没有路径沙箱：
 *   - `read` 能读任意文件，包括 ~/.pi/agent/models.json 里的 API Key
 *   - `bash` 能读写文件、外传数据
 * 这个扩展在 tool_call 阶段同时拦下这两条路径，是 agent 的实际权限边界。
 *
 * 判定逻辑与 src/command-whitelist.js 语义一致，但扩展独立运行在 pi 进程里
 * （pi 的扩展加载器不解析项目模块路径），因此这里内联实现。
 * 默认根目录清单在 DEFAULT_ROOTS 维护，与 config/default.json 的 roots 保持一致；
 * 本地实例由父进程注入自己的副本根。
 */

/**
 * 默认企微模式允许 read 读取的项目内文件：不在 ROOTS 里，但 agent 必须先读它才能正确查数。
 * 本地实例不使用这份例外清单，只能读取自己的副本根。
 */
const DEFAULT_ALLOWED_READ_FILES = ["/Users/kyle/Desktop/VIBECODING/wecom-support-bot/prompts/data-playbook.md"];
const IS_LOCAL_INSTANCE = process.env.WECOM_BOT_LOCAL_INSTANCE === "1";
const ALLOWED_READ_FILES: string[] = IS_LOCAL_INSTANCE ? [] : DEFAULT_ALLOWED_READ_FILES;

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
	"node",
]);

/**
 * 默认企微模式允许用 node 执行的只读脚本：经验检索与指标路由。
 * 本地实例不执行主工作区脚本。
 */
const DEFAULT_ALLOWED_NODE_SCRIPTS = [
	"/Users/kyle/Desktop/VIBECODING/wecom-support-bot/scripts/read-evolution.js",
	"/Users/kyle/Desktop/VIBECODING/wecom-support-bot/scripts/search-bridge.js",
];
const ALLOWED_NODE_SCRIPTS = new Set<string>(IS_LOCAL_INSTANCE ? [] : DEFAULT_ALLOWED_NODE_SCRIPTS);

/** 改变数据流向或串联命令的元字符；`$` 单独列出以拦住 $HOME 之类的变量展开。 */
const FORBIDDEN_METACHARS = [">", "<", "|", ";", "&", "`", "$", "\n"];

/**
 * 找出引号外的 shell 元字符。
 *
 * 必须区分引号内外：`bi_query.py "SELECT ... WHERE t <> ''"` 里的 `<>` 是 SQL
 * 比较运算符，不是 shell 重定向。只扫引号外的字符。
 */
function findUnquotedMetachar(command: string): string | null {
	let quote: string | null = null;
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

/** 默认允许访问的文件系统根。与 config/default.json 的 roots 保持一致。 */
const DEFAULT_ROOTS = [
	"/Users/kyle/Desktop/PM/信息技术部资产库/知识库",
	"/Users/kyle/Desktop/VIBECODING/ajly",
	"/Users/kyle/Desktop/VIBECODING/lezuzu",
	// 同事发来的截图：机器人自己下载存到这里，agent 必须用 read 看图
	"/Users/kyle/Desktop/VIBECODING/wecom-support-bot/data/images",
];

/** 本地实例只使用注入的副本根；默认企微模式保留原有根目录。 */
const ROOTS: string[] = process.env.WECOM_BOT_ROOTS
	? JSON.parse(process.env.WECOM_BOT_ROOTS)
	: IS_LOCAL_INSTANCE
		? []
		: DEFAULT_ROOTS;

/** 解析成规范化的绝对路径；无法判定时返回 null。 */
function toAbsolute(token: string): string | null {
	if (!token.startsWith("/")) return null;
	const segments: string[] = [];
	for (const segment of token.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return null;
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return `/${segments.join("/")}`;
}

/** 路径是否落在白名单根内。 */
function isInsideRoots(token: string): boolean {
	const absolute = toAbsolute(token);
	if (!absolute) return false;
	return ROOTS.some((root) => absolute === root || absolute.startsWith(`${root}/`));
}

/** 判断 bash 命令是否允许。 */
export function checkCommand(command: string): { allowed: boolean; reason?: string } {
	const trimmed = (command ?? "").trim();
	if (!trimmed) return { allowed: false, reason: "空命令" };

	const meta = findUnquotedMetachar(trimmed);
	if (meta) {
		return { allowed: false, reason: `命令里出现 ${JSON.stringify(meta)}，只允许单条只读命令` };
	}

	const tokens = trimmed.split(/\s+/).map(stripQuotes).filter(Boolean);
	const executable = tokens[0] ?? "";
	if (!ALLOWED_COMMANDS.has(executable)) {
		return { allowed: false, reason: `命令 ${executable} 不在白名单内` };
	}

	// `find -delete` / `rg --pre` 等参数能把只读命令变成写操作或任意执行。
	// 同时匹配 `-flag` 与 `-flag=value` 两种写法（rg 的 --pre=cmd 曾可绕过）。
	const dangerousFlag = tokens.find((token) =>
		/^(?:-delete|-exec|-execdir|-fprint|-fprintf|-fls|-ok|--pre|--pre-glob)(?:=|$)/.test(token),
	);
	if (dangerousFlag) {
		return { allowed: false, reason: `参数 ${dangerousFlag} 会让只读命令变成写操作` };
	}

	if (executable === "node") {
		// 只放行经验检索脚本，且第一个非选项参数必须正好是它
		const script = tokens.slice(1).find((token) => token.endsWith(".js")) ?? "";
		if (!ALLOWED_NODE_SCRIPTS.has(script)) {
			return { allowed: false, reason: `脚本 ${script || "(未指定)"} 不在白名单内` };
		}
		// 其余参数（wiki 目录与检索词）不得是路径形式以外的可疑内容，交给下面的路径检查
		for (const token of tokens.slice(1)) {
			if (ALLOWED_NODE_SCRIPTS.has(token)) continue;
			if (token.startsWith("/") && !isInsideRoots(token)) {
				return { allowed: false, reason: `路径越界：${token}` };
			}
		}
		return { allowed: true };
	}

	if (executable === "python3") {
		const script = tokens.find((t, i) => i > 0 && t.endsWith(".py")) ?? "";
		const scriptName = script.split("/").pop() ?? "";
		if (!ALLOWED_SCRIPTS.has(scriptName)) {
			return { allowed: false, reason: `脚本 ${scriptName} 不在白名单内` };
		}
		if (!isInsideRoots(script)) {
			return { allowed: false, reason: `路径越界：${script}` };
		}
		return { allowed: true };
	}

	const operands = tokens.slice(1).filter((token) => !token.startsWith("-"));
	// grep/rg 的第一个非选项参数是搜索模式，不是路径
	const patternCount = executable === "grep" || executable === "rg" ? 1 : 0;
	const pathOperands = operands.slice(patternCount);

	for (const token of pathOperands) {
		if (!token.startsWith("/")) {
			// 相对路径、~ 展开、裸文件名都以 cwd（项目根）为基准，
			// 而项目根下就有 config/secrets.json，因此一律要求绝对路径。
			return { allowed: false, reason: `只接受绝对路径：${token}` };
		}
		if (!isInsideRoots(token)) {
			return { allowed: false, reason: `路径越界：${token}` };
		}
	}

	// 搜索模式本身也不能带路径语义，否则 `grep /etc/passwd` 会被当成模式去读文件
	for (const pattern of operands.slice(0, patternCount)) {
		if (pattern.startsWith("/") || pattern.startsWith("~")) {
			return { allowed: false, reason: `搜索模式不能是路径：${pattern}` };
		}
	}

	return { allowed: true };
}

/** 判断 read 工具的目标路径是否允许。 */
export function checkReadPath(path: string): { allowed: boolean; reason?: string } {
	if (!path) return { allowed: false, reason: "未指定路径" };
	if (!path.startsWith("/")) {
		return { allowed: false, reason: `只接受绝对路径：${path}` };
	}
	if (ALLOWED_READ_FILES.includes(toAbsolute(path) ?? "")) {
		return { allowed: true };
	}
	if (!isInsideRoots(path)) {
		return { allowed: false, reason: `路径越界：${path}，只能读取知识库、代码仓库与会话图片目录` };
	}
	return { allowed: true };
}

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

export default function filesystemWhitelist(pi: any) {
	pi.on("tool_call", async (event: any) => {
		if (event.toolName === "read") {
			const verdict = checkReadPath(event.input?.path ?? "");
			if (verdict.allowed) return;
			return { block: true, reason: `${verdict.reason}。请只读取知识库、代码仓库与会话图片目录里的文件。` };
		}

		if (event.toolName === "bash") {
			const command = event.input?.command;
			if (typeof command !== "string") return;
			const verdict = checkCommand(command);
			if (verdict.allowed) return;
			return { block: true, reason: `${verdict.reason}。请改用知识库检索脚本或读取文档。` };
		}

		return;
	});
}

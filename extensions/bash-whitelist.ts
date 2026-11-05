import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 文件系统访问白名单扩展。
 *
 * pi 的 `--tools` 只限制工具种类，工具本身都没有路径沙箱：
 *   - `read` 能读任意文件，包括 ~/.pi/agent/models.json 里的 API Key
 *   - `write` / `edit` 能写任意路径
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

/** 受信任的默认企微检索脚本来源；本地实例副本可写，不能作为代码来源。 */
const DEFAULT_TRUSTED_PYTHON_SCRIPT_DIRS = [
	"/Users/kyle/Desktop/PM/信息技术部资产库/知识库/业务/ajly-wiki/scripts",
	"/Users/kyle/Desktop/PM/信息技术部资产库/知识库/业务/lzz-wiki/scripts",
	"/Users/kyle/Desktop/PM/信息技术部资产库/知识库/数据库/ajly-db-wiki/scripts",
	"/Users/kyle/Desktop/PM/信息技术部资产库/知识库/数据库/lzz-db-wiki/scripts",
];
const TRUSTED_PYTHON_SCRIPT_DIRS = IS_LOCAL_INSTANCE ? [] : DEFAULT_TRUSTED_PYTHON_SCRIPT_DIRS;

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

/** 本地实例中可进入模型审批的有限写命令；其他命令不会交给模型放行。 */
const APPROVAL_COMMAND_FLAGS: Record<string, Set<string>> = {
	mkdir: new Set(["-p", "--parents", "-v", "--verbose"]),
	cp: new Set(["-r", "-R", "--recursive", "-p", "--preserve", "-f", "--force", "-i", "--interactive", "-n", "--no-clobber", "-v", "--verbose"]),
	mv: new Set(["-f", "--force", "-i", "--interactive", "-n", "--no-clobber", "-v", "--verbose"]),
};

type ShellTokenization = { ok: true; tokens: string[]; hasUnquotedExpansion: boolean } | { ok: false; metachar?: string };

/**
 * 按 shell 的引号与反斜杠语义拆分单条命令。
 * 不支持的注释、未闭合引号和末尾转义一律解析失败，由调用方硬拒绝。
 */
function tokenizeShellCommand(command: string): ShellTokenization {
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | null = null;
	let started = false;
	let hasUnquotedExpansion = false;
	for (let index = 0; index < command.length; index += 1) {
		const ch = command[index];
		if (quote === "'") {
			if (ch === "'") quote = null;
			else token += ch;
			started = true;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = null;
				started = true;
				continue;
			}
			if (ch === "\\") {
				const next = command[index + 1];
				if (next === undefined) return { ok: false };
				index += 1;
				if (next === "\n") continue;
				if (next === '"' || next === "\\" || next === "$" || next === "`") token += next;
				else token += `\\${next}`;
				started = true;
				continue;
			}
			if (ch === "$" || ch === "`") return { ok: false, metachar: ch };
			token += ch;
			started = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
			continue;
		}
		if (ch === "\\") {
			const next = command[index + 1];
			if (next === undefined) return { ok: false };
			index += 1;
			if (next === "\n") continue;
			token += next;
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (ch === "\n") return { ok: false, metachar: ch };
			if (started) tokens.push(token);
			token = "";
			started = false;
			continue;
		}
		if (FORBIDDEN_METACHARS.includes(ch)) return { ok: false, metachar: ch };
		if (ch === "#" && !started) return { ok: false };
		// 未引用的 brace/glob/extglob 都会让写命令的完整源路径与真实目标失去静态确定性。
		if ("{}*?[]".includes(ch)) hasUnquotedExpansion = true;
		if ("@+!".includes(ch) && command[index + 1] === "(") hasUnquotedExpansion = true;
		token += ch;
		started = true;
	}
	if (quote) return { ok: false };
	if (started) tokens.push(token);
	return { ok: true, tokens, hasUnquotedExpansion };
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

const EXECUTION_APPROVAL: any = readEnvJson("WECOM_BOT_EXECUTION_APPROVAL", { enabled: false });
const WRITE_ROOTS = readEnvJson<string[]>("WECOM_BOT_WRITE_ROOTS", []);
const PROTECTED_ROOTS = readEnvJson<string[]>("WECOM_BOT_PROTECTED_ROOTS", []);
const LOCAL_TRUSTED_DATA_SCRIPTS: string[] = IS_LOCAL_INSTANCE
	? Object.values(readEnvJson<Record<string, unknown>>("WECOM_BOT_TRUSTED_DATA_SCRIPTS", {}))
		.filter((path): path is string => typeof path === "string" && path.startsWith("/") && basename(path) === "bi_query.py")
	: [];
const CURRENT_SKILL = process.env.WECOM_BOT_CURRENT_SKILL?.trim() || "unknown";
let approvalClientPromise: Promise<(messages: Array<{ role: string; content: string }>) => Promise<string>> | null = null;

function readEnvJson<T>(name: string, fallback: T): T {
	try {
		return process.env[name] ? JSON.parse(process.env[name]) : fallback;
	} catch {
		return fallback;
	}
}

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

type DirectScriptEntry = { ok: true; script: string } | { ok: false; reason: string };

/** Python 与 Node 共用：解释器后的首个参数必须直接是脚本，不能先出现任何选项。 */
function directScriptEntry(tokens: string[], interpreter: "Python" | "Node"): DirectScriptEntry {
	const script = tokens[1] ?? "";
	if (!script || script.startsWith("-")) {
		return { ok: false, reason: `${interpreter} 只接受首个参数直接为受信任脚本路径，禁止选项或其他入口：${script || "(未指定)"}` };
	}
	return { ok: true, script };
}

/** 判断 bash 命令是否允许。 */
export function checkCommand(command: string): { allowed: boolean; reason?: string } {
	if (!(command ?? "").trim()) return { allowed: false, reason: "空命令" };

	const parsed = tokenizeShellCommand(command);
	if (!parsed.ok) {
		return parsed.metachar
			? { allowed: false, reason: `命令里出现 ${JSON.stringify(parsed.metachar)}，只允许单条只读命令` }
			: { allowed: false, reason: "命令引号、转义或格式无法安全解析" };
	}
	const tokens = parsed.tokens;
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
		// 只放行首个参数直接是受信任经验检索脚本的调用，解释器选项可能改变入口。
		const entry = directScriptEntry(tokens, "Node");
		if (!entry.ok) return { allowed: false, reason: entry.reason };
		const script = entry.script;
		if (!ALLOWED_NODE_SCRIPTS.has(script)) {
			return { allowed: false, reason: `脚本 ${script} 不在白名单内` };
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
		// 只接受 `python3 /trusted/script.py ...`，与 Node 共用同一个首参入口校验。
		const entry = directScriptEntry(tokens, "Python");
		if (!entry.ok) return { allowed: false, reason: entry.reason };
		const script = entry.script;
		const absoluteScript = toAbsolute(script);
		const scriptName = basename(script);
		if (!ALLOWED_SCRIPTS.has(scriptName)) {
			return { allowed: false, reason: `脚本 ${scriptName} 不在白名单内` };
		}
		if (!absoluteScript) {
			return { allowed: false, reason: `脚本来源不受信任：${script}` };
		}
		const trustedDataScript = IS_LOCAL_INSTANCE && scriptName === "bi_query.py" &&
			LOCAL_TRUSTED_DATA_SCRIPTS.some((candidate) => toAbsolute(candidate) === absoluteScript);
		const trustedDefaultScript = !IS_LOCAL_INSTANCE && TRUSTED_PYTHON_SCRIPT_DIRS.includes(dirname(absoluteScript));
		if (!trustedDataScript && !trustedDefaultScript) {
			return { allowed: false, reason: `脚本来源不受信任：${script}` };
		}
		if (trustedDataScript) {
			// 本地副本、workspace 与保护根都不能因为被配置点名而成为代码来源。
			if (isInsideRoots(absoluteScript) || isInsideAnyRoot(absoluteScript, WRITE_ROOTS) || isInsideAnyRoot(absoluteScript, PROTECTED_ROOTS)) {
				return { allowed: false, reason: `可写副本或保护根不能作为可信 BI 入口：${script}` };
			}
		} else if (!isInsideRoots(absoluteScript)) {
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

/** 本地可信 BI 每次执行前都以 realpath 核对候选、写根和保护根；任何解析失败都硬拒绝。 */
async function trustedDataScriptRealPathAllowed(command: string): Promise<boolean> {
	if (!IS_LOCAL_INSTANCE) return true;
	const parsed = tokenizeShellCommand(command);
	if (!parsed.ok || parsed.tokens[0] !== "python3") return true;
	const script = toAbsolute(parsed.tokens[1] ?? "");
	if (!script || !LOCAL_TRUSTED_DATA_SCRIPTS.some((candidate) => toAbsolute(candidate) === script)) return false;
	try {
		const [realScript, realTrustedScripts, realWriteRoots, realProtectedRoots] = await Promise.all([
			realpath(script),
			Promise.all(LOCAL_TRUSTED_DATA_SCRIPTS.map((path) => realpath(path))),
			Promise.all(WRITE_ROOTS.map((path) => realpath(path))),
			Promise.all(PROTECTED_ROOTS.map((path) => realpath(path))),
		]);
		return (await stat(realScript)).isFile() && realTrustedScripts.includes(realScript) &&
			!isInsideAnyRoot(realScript, realWriteRoots) && !isInsideAnyRoot(realScript, realProtectedRoots);
	} catch {
		return false;
	}
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

type RiskCategory = "low" | "medium" | "high" | "unknown";

type ApprovalBoundary = {
	readRoots: string[];
	writeRoots: string[];
	protectedRoots: string[];
};

type ApprovalResult = {
	verdict: "ALLOW" | "DENY";
	source: "hard-rule" | "model";
	reason: string;
	riskCategory: RiskCategory;
	executionResult?: unknown;
};

/**
 * S13：审批一个具体的写操作；测试可注入假模型与假执行器，真实 pi 只使用审批结果。
 * 不在此处缓存任何判定，每次调用都必须重新经过硬规则与模型。
 */
export async function processApprovedToolCall({
	event,
	task = {},
	callModel,
	execute,
	enabled = true,
	writeRoots = [],
	readRoots = writeRoots,
	protectedRoots = [],
	timeoutMs = 10000,
	logger = () => {},
}: {
	event: { toolName: string; toolCallId?: string; input?: any };
	task?: { goal?: string; currentSkill?: string; necessaryChange?: string };
	callModel?: (messages: Array<{ role: string; content: string }>) => Promise<string>;
	execute?: (event: any) => Promise<unknown>;
	enabled?: boolean;
	writeRoots?: string[];
	readRoots?: string[];
	protectedRoots?: string[];
	timeoutMs?: number;
	logger?: (entry: any) => void;
}): Promise<ApprovalResult> {
	const boundary: ApprovalBoundary = { readRoots, writeRoots, protectedRoots };
	const finish = (result: ApprovalResult): ApprovalResult => {
		logger({
			type: "execution_approval",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			...(event.toolName === "bash"
				? { command: approvalCommandName(event.input?.command) }
				: { target: event.input?.path }),
			verdict: result.verdict,
			source: result.source,
			// 模型理由可能回显写入正文或凭证；持久日志只记录安全类别，原文仍由 result 返回主 Agent。
			reason: result.source === "hard-rule" ? result.reason : result.verdict === "ALLOW" ? "model-allow" : "model-deny",
			riskCategory: result.riskCategory,
		});
		return result;
	};

	if (!enabled) {
		return finish({ verdict: "DENY", source: "hard-rule", reason: "当前实例未启用执行审批，保持只读", riskCategory: "unknown" });
	}
	let targets: string[] = [];
	let commandPlan: { executable?: string; sources: string[] } | undefined;
	if (event.toolName === "write" || event.toolName === "edit") {
		const inputPath = typeof event.input?.path === "string" ? event.input.path : null;
		const path = inputPath === null ? null : toAbsolute(inputPath);
		if (!inputPath || !path || !isInsideAnyRoot(path, boundary.writeRoots) || isInsideAnyRoot(path, boundary.protectedRoots)) {
			return finish({ verdict: "DENY", source: "hard-rule", reason: `禁止写入副本外或主工作区：${event.input?.path ?? "未指定路径"}`, riskCategory: "unknown" });
		}
		// 词法检查之后仍保留原始路径；realpath 必须先解析符号链接，再处理其后的 ..。
		targets = [inputPath];
	} else if (event.toolName === "bash") {
		const hardRule = checkApprovalCommand(event.input?.command, boundary);
		if (hardRule.reason) {
			return finish({ verdict: "DENY", source: "hard-rule", reason: hardRule.reason, riskCategory: "unknown" });
		}
		if (hardRule.executable === "mv" && !(await hasOnlyOrdinaryFileSources(hardRule.sources))) {
			return finish({ verdict: "DENY", source: "hard-rule", reason: "mv 只接受明确普通文件源；目录、符号链接或其他对象无法静态确定完整移动范围", riskCategory: "unknown" });
		}
		targets = hardRule.targets;
		commandPlan = hardRule;
		const sourcePolicy = sourceAccessPolicy(hardRule.sourceIsModified === true, boundary);
		const realSources = await resolveRealTargets(hardRule.sources, sourcePolicy.allowedRoots, sourcePolicy.protectedRoots);
		if (!realSources) {
			return finish({ verdict: "DENY", source: "hard-rule", reason: "命令源路径越出允许根、触及保护根或无法安全解析", riskCategory: "unknown" });
		}
	} else {
		return finish({ verdict: "DENY", source: "hard-rule", reason: "工具不在执行审批范围内", riskCategory: "unknown" });
	}
	const realTargets = await resolveFinalTargets(targets, commandPlan, boundary);
	if (!realTargets) {
		return finish({ verdict: "DENY", source: "hard-rule", reason: "真实目标越出副本、触及主工作区或无法安全解析", riskCategory: "unknown" });
	}
	targets = realTargets;

	const goal = task.goal?.trim() || "未提供任务目标";
	const action = event.toolName === "bash"
		? `通过 bash 执行 ${approvalCommandName(event.input?.command)} 写命令`
		: event.toolName === "write"
			? "通过 write 创建或覆盖文件"
			: "通过 edit 修改文件";
	const suppliedChange = task.necessaryChange?.trim();
	const approvalTask = {
		goal,
		currentSkill: task.currentSkill || "unknown",
		necessaryChange: `为任务“${goal}”${action}，真实目标：${targets.join("、")}${suppliedChange ? `；必要变更说明：${suppliedChange}` : ""}`,
	};

	let raw = "";
	const messages = [
		{
			role: "system",
			content: "你是独立的执行审批模型，不执行工具。根据任务目标、task.currentSkill、工具完整参数、真实目标和必要变更，判断操作的相关性、必要性、范围与潜在副作用。task.currentSkill 由轮次编排根据真实 Skill 目录传入；unknown 表示本轮未命中 Skill、未提供 Skill 上下文，不得猜测或假定已加载 Skill。每次调用独立审批，不得把本次 ALLOW 当作后续授权。只输出三行：\nALLOW 或 DENY\n理由：简短且可操作的理由\n风险：低、中或高",
		},
		{
			role: "user",
			content: JSON.stringify({
				toolCallId: event.toolCallId,
				tool: event.toolName,
				arguments: event.input,
				target: targets,
				task: approvalTask,
			}),
		},
	];
	let timer: NodeJS.Timeout | undefined;
	try {
		if (!callModel) throw new Error("未配置执行审批模型");
		raw = await Promise.race([
			callModel(messages),
			new Promise<string>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("执行审批模型超时")), timeoutMs);
			}),
		]);
	} catch (error) {
		const reason = error instanceof Error && error.message === "执行审批模型超时"
			? "执行审批模型超时，已默认拒绝"
			: "执行审批模型调用失败，已默认拒绝";
		return finish({ verdict: "DENY", source: "model", reason, riskCategory: "unknown" });
	} finally {
		if (timer) clearTimeout(timer);
	}

	const parsed = parseApprovalOutput(raw);
	if (parsed.verdict === "DENY") return finish(parsed);
	if (!execute) return finish(parsed);
	return finish({ ...parsed, executionResult: await execute(event) });
}

/** cp/mv 的目标是现有目录时，实际操作会落在目录下的每个同名文件。 */
async function resolveFinalTargets(
	targets: string[],
	commandPlan: { executable?: string; sources: string[] } | undefined,
	boundary: ApprovalBoundary,
): Promise<string[] | null> {
	const resolvedTargets = await resolveRealTargets(targets, boundary.writeRoots, boundary.protectedRoots);
	if (!resolvedTargets || (commandPlan?.executable !== "cp" && commandPlan?.executable !== "mv")) return resolvedTargets;
	const destination = resolvedTargets[0];
	let isDirectory = false;
	try {
		isDirectory = (await stat(destination)).isDirectory();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
	}
	if (!isDirectory) return commandPlan.sources.length === 1 ? resolvedTargets : null;
	const finalTargets = commandPlan.sources.map((source) => join(destination, basename(source)));
	return resolveRealTargets(finalTargets, boundary.writeRoots, boundary.protectedRoots);
}

/** mv 不递归枚举目录内容；只有明确普通文件的移动范围可以静态确定。 */
async function hasOnlyOrdinaryFileSources(sources: string[]): Promise<boolean> {
	try {
		const entries = await Promise.all(sources.map((source) => lstat(source)));
		return entries.every((entry) => entry.isFile() && !entry.isSymbolicLink());
	} catch {
		return false;
	}
}

async function resolveRealTargets(targets: string[], allowedRoots: string[], protectedRoots: string[]): Promise<string[] | null> {
	const realAllowedRoots = await Promise.all(allowedRoots.map(resolveRealTarget));
	if (realAllowedRoots.some((root) => root === null)) return null;
	const roots = realAllowedRoots as string[];
	const realProtectedRoots = (await Promise.all(protectedRoots.map(resolveRealTarget))).map((root, index) => root ?? protectedRoots[index]);
	const resolved: string[] = [];
	for (const target of targets) {
		const realTarget = await resolveRealTarget(target);
		if (!realTarget || !isInsideAnyRoot(realTarget, roots) || isInsideAnyRoot(realTarget, realProtectedRoots)) return null;
		resolved.push(realTarget);
	}
	return resolved;
}

/** 已存在的目标用 realpath；新文件解析最近的已存在父目录，阻止符号链接逃逸。 */
async function resolveRealTarget(path: string): Promise<string | null> {
	if (!path.startsWith("/")) return null;
	// 此处不能词法折叠 ..：符号链接会先由文件系统展开，link/.. 不一定等于 link 的字面父目录。
	let current = path;
	const missing: string[] = [];
	while (true) {
		try {
			const resolved = await realpath(current);
			return join(resolved, ...missing);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
			try {
				// realpath 对悬空符号链接也返回 ENOENT；不能把它当成普通缺失文件重建到链接所在目录。
				if ((await lstat(current)).isSymbolicLink()) return null;
			} catch (lstatError) {
				if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") return null;
			}
			const parent = dirname(current);
			if (parent === current) return null;
			missing.unshift(basename(current));
			current = parent;
		}
	}
}

function checkApprovalCommand(
	command: unknown,
	boundary: ApprovalBoundary,
): { reason?: string; targets: string[]; sources: string[]; executable?: string; sourceIsModified?: boolean } {
	if (typeof command !== "string" || !command.trim()) return { reason: "未指定需要审批的命令", targets: [], sources: [] };
	const parsed = tokenizeShellCommand(command);
	if (!parsed.ok) {
		return parsed.metachar
			? { reason: `命令里出现 ${JSON.stringify(parsed.metachar)}，禁止重定向、串联或展开`, targets: [], sources: [] }
			: { reason: "命令引号、转义、注释或格式无法安全解析", targets: [], sources: [] };
	}
	const tokens = parsed.tokens;
	if (tokens.length === 0) return { reason: "命令格式无法安全解析", targets: [], sources: [] };
	if (parsed.hasUnquotedExpansion) {
		return { reason: "写命令包含未引用的 glob、extglob 或大括号展开，无法静态确定完整源路径与真实目标", targets: [], sources: [] };
	}
	const executable = tokens[0];
	const allowedFlags = APPROVAL_COMMAND_FLAGS[executable];
	if (!allowedFlags) return { reason: `命令 ${executable} 不在可审批命令白名单内`, targets: [], sources: [] };
	const args = tokens.slice(1);
	if (args.some((token) => token.startsWith("-") && !allowedFlags.has(token))) {
		return { reason: `命令 ${executable} 含有未批准的选项`, targets: [], sources: [] };
	}
	if (executable === "cp" && args.some((token) => token === "-r" || token === "-R" || token === "--recursive")) {
		return { reason: "cp 递归复制（包括源尾斜杠形态）无法静态枚举完整最终目标，请改用明确文件路径的普通 cp", targets: [], sources: [] };
	}
	const operands = args.filter((token) => !token.startsWith("-"));
	const minimum = executable === "mkdir" ? 1 : 2;
	if (operands.length < minimum) return { reason: `命令 ${executable} 缺少明确目标路径`, targets: [], sources: [] };
	const sourceOperands = executable === "mkdir" ? [] : operands.slice(0, -1);
	const targetOperands = executable === "mkdir" ? operands : operands.slice(-1);
	const sources = sourceOperands.map(toAbsolute);
	const targets = targetOperands.map(toAbsolute);
	if ([...sources, ...targets].some((path) => path === null)) {
		return { reason: "写命令只接受可规范化的绝对路径", targets: [], sources: [] };
	}
	const absoluteSources = sources as string[];
	const absoluteTargets = targets as string[];
	const sourceIsModified = executable === "mv";
	const sourcePolicy = sourceAccessPolicy(sourceIsModified, boundary);
	for (const path of absoluteSources) {
		if (!isInsideAnyRoot(path, sourcePolicy.allowedRoots) || isInsideAnyRoot(path, sourcePolicy.protectedRoots)) {
			return { reason: `命令源路径越出允许根或触及保护根：${path}`, targets: [], sources: [] };
		}
	}
	for (const path of absoluteTargets) {
		if (!isInsideAnyRoot(path, boundary.writeRoots) || isInsideAnyRoot(path, boundary.protectedRoots)) {
			return { reason: `命令目标越出副本或触及主工作区：${path}`, targets: [], sources: [] };
		}
	}
	return { targets: targetOperands, sources: sourceOperands, executable, sourceIsModified };
}

/** cp 只读源，mv 的源本身会被修改；词法检查与 realpath 检查共用同一策略。 */
function sourceAccessPolicy(sourceIsModified: boolean, boundary: ApprovalBoundary) {
	return {
		allowedRoots: sourceIsModified ? boundary.writeRoots : boundary.readRoots,
		protectedRoots: sourceIsModified ? boundary.protectedRoots : [],
	};
}

function isInsideAnyRoot(path: string, roots: string[]): boolean {
	return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function parseApprovalOutput(raw: unknown): ApprovalResult {
	const lines = String(raw ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
	const verdict = lines[0]?.toUpperCase();
	const reason = lines.find((line) => /^理由[:：]/.test(line))?.replace(/^理由[:：]\s*/, "");
	const risk = lines.find((line) => /^风险(?:类别)?[:：]/.test(line))?.replace(/^风险(?:类别)?[:：]\s*/, "").toLowerCase();
	const riskCategory = risk === "低" || risk === "low" ? "low" : risk === "中" || risk === "medium" ? "medium" : risk === "高" || risk === "high" ? "high" : null;
	if ((verdict !== "ALLOW" && verdict !== "DENY") || !reason || !riskCategory) {
		return { verdict: "DENY", source: "model", reason: "执行审批模型返回无效结果，已默认拒绝", riskCategory: "unknown" };
	}
	return { verdict, source: "model", reason, riskCategory };
}

export default function filesystemWhitelist(pi: any) {
	pi.on("tool_call", async (event: any, ctx: any) => {
		if (event.toolName === "read") {
			const verdict = checkReadPath(event.input?.path ?? "");
			if (verdict.allowed) return;
			return { block: true, reason: `${verdict.reason}。请只读取知识库、代码仓库与会话图片目录里的文件。` };
		}

		if (event.toolName === "bash") {
			const command = event.input?.command;
			if (typeof command !== "string") return { block: true, reason: "未提供可解析的命令" };
			const verdict = checkCommand(command);
			if (verdict.allowed) {
				if (await trustedDataScriptRealPathAllowed(command)) return;
				return {
					block: true,
					reason: "执行审批 DENY（hard-rule，风险类别：unknown）：可信 BI 入口的真实路径不存在、发生变化或落入可写副本、保护根。",
				};
			}
		} else if (event.toolName !== "write" && event.toolName !== "edit") {
			return;
		}

		const result = await processApprovedToolCall({
			event,
			task: extractTaskContext(ctx),
			callModel: getApprovalClient,
			enabled: IS_LOCAL_INSTANCE && EXECUTION_APPROVAL.enabled === true,
			writeRoots: WRITE_ROOTS,
			readRoots: ROOTS,
			protectedRoots: PROTECTED_ROOTS,
			timeoutMs: Number(EXECUTION_APPROVAL.timeoutMs ?? 10000),
			logger: logExecutionApproval,
		});
		if (result.verdict === "ALLOW") return;
		return {
			block: true,
			reason: `执行审批 DENY（${result.source}，风险类别：${result.riskCategory}）：${result.reason}。请缩小范围或改用更安全的操作。`,
		};
	});
}

function extractTaskContext(ctx: any): { goal: string; currentSkill: string } {
	const entries = ctx?.sessionManager?.getBranch?.() ?? [];
	const latestUser = [...entries].reverse().find((entry: any) => entry.type === "message" && entry.message?.role === "user");
	const content = latestUser?.message?.content;
	const goal = typeof content === "string"
		? content
		: Array.isArray(content)
			? content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
			: "未提供任务目标";
	return {
		goal,
		currentSkill: CURRENT_SKILL,
	};
}

async function getApprovalClient(messages: Array<{ role: string; content: string }>): Promise<string> {
	if (!approvalClientPromise) {
		approvalClientPromise = (async () => {
			const clientPath = process.env.WECOM_BOT_MODEL_CLIENT_PATH;
			if (!clientPath) throw new Error("未配置执行审批模型客户端");
			const module = await import(pathToFileURL(clientPath).href);
			return module.createExecutionApprovalClient({
				config: {
					executionApproval: EXECUTION_APPROVAL,
					pi: { provider: process.env.WECOM_BOT_PI_PROVIDER ?? "" },
				},
				agentDir: process.env.PI_CODING_AGENT_DIR ?? "",
			});
		})();
	}
	const callModel = await approvalClientPromise;
	return callModel(messages);
}

function approvalCommandName(command: unknown): string {
	if (typeof command !== "string") return "未指定命令";
	const parsed = tokenizeShellCommand(command);
	return parsed.ok ? parsed.tokens[0] ?? "未指定命令" : "无法解析的命令";
}

function logExecutionApproval(entry: any): void {
	process.stderr.write(`[execution-approval] ${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

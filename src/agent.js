import { spawn } from "node:child_process";

import { parseDeliveryMarkers } from "./file-delivery.js";
import { findCatalogResource } from "./resource-catalog.js";

/** 判定本轮是否触碰生产数据的脚本名。 */
const BI_SCRIPT = "bi_query.py";
const CONTEXT_INSUFFICIENT = "CONTEXT_INSUFFICIENT";

/**
 * 在跑的 pi 子进程。父进程退出不会自动带走子进程，强杀场景下它们会变成孤儿继续占着会话，
 * 所以这里登记一份，正常退出时一并清掉。
 *
 * @type {Set<import("node:child_process").ChildProcess>}
 */
const runningChildren = new Set();
let exitHookInstalled = false;

/** @param {import("node:child_process").ChildProcess} child */
function trackChild(child) {
  runningChildren.add(child);
  child.once("close", () => runningChildren.delete(child));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => killAllChildren());
}

/** 杀掉所有在跑的 pi 子进程（优雅退出超时后调用）。 */
export function killAllChildren() {
  for (const child of runningChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已经退出
    }
  }
  runningChildren.clear();
}

/**
 * 默认的进程启动器：调用隔离的 pi 实例，输出 JSONL 事件流。
 *
 * @param {{prompt: string, sessionId: string, config: any, projectDir: string, thinkingLevel?: string, currentSkill?: string}} options
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnPi({ prompt, sessionId, config, projectDir, thinkingLevel, currentSkill }) {
  const args = [
    "--mode",
    "json",
    "--no-context-files",
    "--no-skills",
    "--no-extensions",
    "--extension",
    `${projectDir}/extensions/bash-whitelist.ts`,
    "--tools",
    config.pi.localInstance && config.executionApproval?.enabled === true ? "read,write,edit,bash" : "read,bash",
    "--provider",
    config.pi.provider,
    "--model",
    config.pi.model,
    "--thinking",
    thinkingLevel ?? config.pi.thinkingLevel,
    "--session-id",
    sessionId,
    "--append-system-prompt",
    config.pi.systemPromptPath ?? `${projectDir}/prompts/core.md`,
    prompt,
  ];

  const child = spawn(config.pi.binary, args, {
    cwd: projectDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: config.pi.agentDir,
      PI_OFFLINE: "1",
      WECOM_BOT_ROOTS: JSON.stringify(config.roots ?? []),
      WECOM_BOT_PROJECT_DIR: projectDir,
      WECOM_BOT_LOCAL_INSTANCE: config.pi.localInstance ? "1" : "0",
      WECOM_BOT_EXECUTION_APPROVAL: JSON.stringify(config.executionApproval ?? { enabled: false }),
      WECOM_BOT_TRUSTED_DATA_SCRIPTS: JSON.stringify(config.trustedDataScripts ?? {}),
      WECOM_BOT_CURRENT_SKILL: currentSkill ?? "unknown",
      WECOM_BOT_WRITE_ROOTS: JSON.stringify(config.writeRoots ?? []),
      WECOM_BOT_PROTECTED_ROOTS: JSON.stringify(config.protectedRoots ?? []),
      WECOM_BOT_MODEL_CLIENT_PATH: `${projectDir}/src/model-client.js`,
      WECOM_BOT_PI_PROVIDER: config.pi.provider,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackChild(child);
  return child;
}

/**
 * 跑一轮 agent，收集最终答复并判断是否触碰过生产数据。
 *
 * 只消费 pi 的 JSONL 事件流，不解析人类可读文本，也不信任 stdout 之外的任何东西。
 *
 * 看门狗的两个时限分工不同：
 *   - `idleTimeoutMs`：事件流静默多久算卡住。模型通道间歇停摆时，进程还活着但一个
 *     字节都不吐，只有这个能发现；有 thinking 增量也算进展，不会被误杀。
 *   - `hardTimeoutMs`：单轮总上限，防止一个真在干活但永远干不完的任务占着会话。
 * 只给 `timeoutMs` 时按总上限处理（老调用方式保持不变）。
 *
 * @param {{
 *   prompt: string,
 *   sessionId: string,
 *   runner?: Function,
 *   timeoutMs?: number,
 *   idleTimeoutMs?: number,
 *   hardTimeoutMs?: number,
 *   thinkingLevel?: string,
 *   config?: any,
 *   projectDir?: string,
 *   resourceCatalog?: Array<any>
 *   currentSkill?: string
 * }} options
 * @returns {Promise<{text: string, biTouched: boolean, timedOut: boolean, stalled: boolean, failed: boolean, inputTokens: number, contextInsufficient: boolean, loadedResources: Array<any>, executionApprovals: Array<any>}>}
 */
export async function runAgentTurn({
  prompt,
  sessionId,
  runner,
  timeoutMs = 180000,
  idleTimeoutMs,
  hardTimeoutMs,
  thinkingLevel,
  config,
  projectDir,
  resourceCatalog = [],
  currentSkill = "unknown",
}) {
  /** @param {{prompt: string, sessionId: string}} options */
  const defaultLaunch = (options) => {
    if (!config || !projectDir) throw new Error("缺少 config 或 projectDir");
    return spawnPi({ ...options, thinkingLevel, config, projectDir, currentSkill });
  };
  const launch = runner ?? defaultLaunch;
  const hardLimit = hardTimeoutMs ?? timeoutMs;

  return new Promise((resolvePromise) => {
    const child = launch({ prompt, sessionId, thinkingLevel, config, projectDir, currentSkill });

    let text = "";
    // 带交付标记的正文可能出现在带工具调用的 assistant 消息里；后续只回一句
    // “已发给你”的收尾消息不能把它覆盖掉，否则文件交付标记会丢失。
    let deliveryText = "";
    let biTouched = false;
    let inputTokens = 0;
    let contextInsufficient = false;
    let timedOut = false;
    let stalled = false;
    let settled = false;
    /** @type {Array<any>} */
    const loadedResources = [];
    /** @type {Array<any>} */
    const executionApprovals = [];
    /** @type {Map<string, string>} */
    const pendingReads = new Map();
    /** @type {Map<string, string>} */
    const pendingBashCommands = new Map();
    /** @type {NodeJS.Timeout | undefined} */
    let idleTimer;

    const finish = (
      /** @type {Partial<{timedOut: boolean, stalled: boolean, failed: boolean}>} */ extra,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      resolvePromise({
        text: deliveryText && parseDeliveryMarkers(text).files.length === 0 ? deliveryText : text,
        biTouched,
        inputTokens,
        contextInsufficient,
        timedOut,
        stalled,
        failed: false,
        loadedResources: loadedResources.map((resource) => ({ ...resource })),
        executionApprovals: executionApprovals.map((approval) => ({ ...approval })),
        ...extra,
      });
    };

    const hardTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      finish({ timedOut: true });
    }, hardLimit);

    const armIdleTimer = () => {
      if (!idleTimeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stalled = true;
        child.kill("SIGKILL");
        finish({ stalled: true });
      }, idleTimeoutMs);
    };
    armIdleTimer();

    if (child.stdout) {
      let buffer = "";
      child.stdout.on("data", (/** @type {Buffer|string} */ chunk) => {
        armIdleTimer();
        buffer += chunk.toString();
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const parsed = parseEvent(line);
          if (parsed) {
            if (parsed.bashStarted) {
              if (parsed.pendingBashId && parsed.bashCommand) {
                pendingBashCommands.set(parsed.pendingBashId, parsed.bashCommand);
              }
            } else if (parsed.bashCompleted) {
              const command = parsed.bashCommand ?? pendingBashCommands.get(parsed.completedBashId ?? "");
              if (parsed.completedBashId) pendingBashCommands.delete(parsed.completedBashId);
              if (parsed.bashSucceeded && command && isBiQueryCommand(command)) biTouched = true;
            }
            if (parsed.text !== undefined) {
              text = parsed.text;
              if (parsed.deliveryText !== undefined) deliveryText = parsed.deliveryText;
              contextInsufficient = Boolean(parsed.contextInsufficient);
            }
            if (parsed.inputTokens) inputTokens = parsed.inputTokens;
            if (parsed.readStarted) {
              if (parsed.pendingReadId && parsed.readPath) pendingReads.set(parsed.pendingReadId, parsed.readPath);
            } else if (parsed.readCompleted) {
              const path = parsed.readPath ?? pendingReads.get(parsed.completedReadId ?? "");
              if (parsed.completedReadId) pendingReads.delete(parsed.completedReadId);
              const resource = path && !parsed.readFailed ? findCatalogResource(path, resourceCatalog, parsed.readContent) : null;
              if (resource && !loadedResources.some((loaded) => loaded.path === resource.path)) {
                loadedResources.push(resource);
              }
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
      });
    }

    if (child.stderr) {
      let buffer = "";
      child.stderr.on("data", (/** @type {Buffer|string} */ chunk) => {
        buffer += chunk.toString();
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const approval = relayExecutionApprovalLog(buffer.slice(0, newlineIndex));
          if (approval) executionApprovals.push(approval);
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");
        }
      });
    }

    child.on("error", () => finish({ failed: true }));
    // 用 close 而非 exit：close 保证 stdout 已完全读空，避免丢掉末尾的答复
    child.on("close", (/** @type {number|null} */ code) => {
      if (timedOut || stalled) return;
      finish({ failed: code !== 0 });
    });
  });
}

/**
 * 只转发扩展产生的执行审批摘要；其他 stderr 与未白名单化的字段不进入父进程日志。
 *
 * @param {string} line
 * @returns {Record<string, string>|null}
 */
function relayExecutionApprovalLog(line) {
  const prefix = "[execution-approval] ";
  if (!line.startsWith(prefix)) return null;
  try {
    const entry = JSON.parse(line.slice(prefix.length));
    if (entry?.type !== "execution_approval") return null;
    const summary = /** @type {Record<string, string>} */ ({ type: "execution_approval" });
    for (const key of ["timestamp", "toolCallId", "toolName", "target", "command", "verdict", "source", "riskCategory"]) {
      if (typeof entry[key] === "string") summary[key] = entry[key];
    }
    // 模型理由可能包含写入正文或凭证；父进程只转发安全类别，硬规则理由保持可操作。
    if (entry.source === "hard-rule" && typeof entry.reason === "string") summary.reason = entry.reason;
    if (entry.source === "model") summary.reason = entry.verdict === "ALLOW" ? "model-allow" : "model-deny";
    process.stderr.write(`${prefix}${JSON.stringify(summary)}\n`);
    return summary;
  } catch {
    // 非审批日志或截断的 JSON 不转发，避免把子进程凭证与完整参数带入日志。
    return null;
  }
}

/**
 * 解析单行 JSONL 事件，提取对该轮有意义的信息。
 *
 * @param {string} line
 * @returns {{text?: string, deliveryText?: string, contextInsufficient?: boolean, inputTokens?: number, bashStarted?: boolean, bashCompleted?: boolean, bashSucceeded?: boolean, pendingBashId?: string, completedBashId?: string, bashCommand?: string, readPath?: string, readStarted?: boolean, readCompleted?: boolean, pendingReadId?: string, completedReadId?: string, readFailed?: boolean, readContent?: string} | null}
 */
function parseEvent(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (event?.type === "tool_execution_start" && event.toolName === "bash") {
    const command = event.args?.command ?? event.input?.command;
    return {
      bashStarted: true,
      pendingBashId: event.toolCallId,
      ...(typeof command === "string" ? { bashCommand: command } : {}),
    };
  }

  if (event?.type === "tool_execution_end" && event.toolName === "bash") {
    const command = event.args?.command ?? event.input?.command;
    return {
      bashCompleted: true,
      completedBashId: event.toolCallId,
      bashSucceeded: isSuccessfulBashExecution(event),
      ...(typeof command === "string" ? { bashCommand: command } : {}),
    };
  }

  if (event?.type === "tool_execution_start" && event.toolName === "read") {
    const path = event.args?.path ?? event.input?.path;
    return typeof path === "string"
      ? { readStarted: true, readPath: path, pendingReadId: event.toolCallId }
      : null;
  }

  if (event?.type === "tool_execution_end" && event.toolName === "read") {
    const path = event.args?.path ?? event.input?.path;
    const readContent =
      event.result !== undefined
        ? typeof event.result === "string"
          ? event.result
          : JSON.stringify(event.result)
        : undefined;
    return {
      readCompleted: true,
      completedReadId: event.toolCallId,
      ...(typeof path === "string" ? { readPath: path } : {}),
      ...(readContent ? { readContent } : {}),
      readFailed: Boolean(event.isError),
    };
  }

  if (event?.type === "message_end" && event.message?.role === "assistant") {
    const messageText = extractText(event.message.content);
    const contextInsufficient = messageText.startsWith(CONTEXT_INSUFFICIENT);
    const cleanText = contextInsufficient
      ? messageText.replace(/^CONTEXT_INSUFFICIENT\s*:?\s*/, "")
      : messageText;
    const inputTokens = Number(event.message.usage?.input ?? 0);
    /** @type {{text?: string, deliveryText?: string, contextInsufficient?: boolean, inputTokens?: number}} */
    const parsed = {};
    if (messageText) {
      parsed.text = cleanText;
      if (parseDeliveryMarkers(cleanText).files.length > 0) parsed.deliveryText = cleanText;
    }
    if (contextInsufficient) parsed.contextInsufficient = true;
    if (inputTokens > 0) parsed.inputTokens = inputTokens;
    return Object.keys(parsed).length ? parsed : null;
  }

  return null;
}

/**
 * 保守识别成功事件对应的命令证据，不做权限判断，也不替代 04 的执行分词器。
 * 只接受直接以 python/python3 启动、首个参数就是 bi_query.py 的单条命令。
 * 引号与反斜杠按 shell 词法还原；展开、串联或无法完整解析时宁漏不误标。
 *
 * @param {string} command
 */
function isBiQueryCommand(command) {
  const tokens = tokenizeCommandEvidence(command);
  if (!tokens || !["python", "python3"].includes(tokens[0])) return false;
  const script = tokens[1] ?? "";
  if (!script || script.startsWith("-")) return false;
  return script === BI_SCRIPT || script.endsWith(`/${BI_SCRIPT}`);
}

/**
 * 仅供证据识别使用的最小 shell 分词；不展开变量、不执行任何内容。
 * @param {string} command
 * @returns {string[]|null}
 */
function tokenizeCommandEvidence(command) {
  /** @type {string[]} */
  const tokens = [];
  let token = "";
  /** @type {"'"|'"'|null} */
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\") {
        const next = command[index + 1];
        if (next === undefined) return null;
        index += 1;
        if (next !== "\n") token += ['"', "\\", "$", "`"].includes(next) ? next : `\\${next}`;
      } else {
        if (char === "$" || char === "`") return null;
        token += char;
      }
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      const next = command[index + 1];
      if (next === undefined) return null;
      index += 1;
      if (next !== "\n") token += next;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (char === "\n") return null;
      if (started) tokens.push(token);
      token = "";
      started = false;
      continue;
    }
    if ("$`|;&<>\n".includes(char) || (char === "#" && !started)) return null;
    // 未引用的 glob、brace、extglob、tilde 与进程替换都不是可确认的字面脚本路径。
    // 圆括号一并拒绝可覆盖所有 extglob 形式；引号或反斜杠包裹的字面字符仍可使用。
    if ("~{}*?[]()".includes(char)) return null;
    token += char;
    started = true;
  }
  if (quote) return null;
  if (started) tokens.push(token);
  return tokens;
}

/** @param {any} event */
function isSuccessfulBashExecution(event) {
  if (event.isError) return false;
  const result = event.result;
  const exitCode = event.exitCode ?? result?.exitCode ?? result?.details?.exitCode;
  if (exitCode !== undefined && Number(exitCode) !== 0) return false;
  return !result?.isError && !result?.error && result?.success !== false && result?.ok !== false;
}

/**
 * 从 assistant 消息的 content 数组里取纯文本，忽略思考与工具调用片段。
 *
 * @param {any} content
 * @returns {string}
 */
function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

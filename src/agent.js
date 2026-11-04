import { spawn } from "node:child_process";

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
 * @param {{prompt: string, sessionId: string, config: any, projectDir: string, thinkingLevel?: string}} options
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnPi({ prompt, sessionId, config, projectDir, thinkingLevel }) {
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
      WECOM_BOT_LOCAL_INSTANCE: config.pi.localInstance ? "1" : "0",
      WECOM_BOT_EXECUTION_APPROVAL: JSON.stringify(config.executionApproval ?? { enabled: false }),
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
 * }} options
 * @returns {Promise<{text: string, biTouched: boolean, timedOut: boolean, stalled: boolean, failed: boolean, inputTokens: number, contextInsufficient: boolean, loadedResources: Array<any>}>}
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
}) {
  /** @param {{prompt: string, sessionId: string}} options */
  const defaultLaunch = (options) => {
    if (!config || !projectDir) throw new Error("缺少 config 或 projectDir");
    return spawnPi({ ...options, thinkingLevel, config, projectDir });
  };
  const launch = runner ?? defaultLaunch;
  const hardLimit = hardTimeoutMs ?? timeoutMs;

  return new Promise((resolvePromise) => {
    const child = launch({ prompt, sessionId, thinkingLevel, config, projectDir });

    let text = "";
    let biTouched = false;
    let inputTokens = 0;
    let contextInsufficient = false;
    let timedOut = false;
    let stalled = false;
    let settled = false;
    /** @type {Array<any>} */
    const loadedResources = [];
    /** @type {Map<string, string>} */
    const pendingReads = new Map();
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
        text,
        biTouched,
        inputTokens,
        contextInsufficient,
        timedOut,
        stalled,
        failed: false,
        loadedResources: loadedResources.map((resource) => ({ ...resource })),
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
            if (parsed.biTouched) biTouched = true;
            if (parsed.text !== undefined) {
              text = parsed.text;
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
          relayExecutionApprovalLog(buffer.slice(0, newlineIndex));
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
 */
function relayExecutionApprovalLog(line) {
  const prefix = "[execution-approval] ";
  if (!line.startsWith(prefix)) return;
  try {
    const entry = JSON.parse(line.slice(prefix.length));
    if (entry?.type !== "execution_approval") return;
    const summary = /** @type {Record<string, string>} */ ({ type: "execution_approval" });
    for (const key of ["timestamp", "toolCallId", "toolName", "target", "command", "verdict", "source", "riskCategory"]) {
      if (typeof entry[key] === "string") summary[key] = entry[key];
    }
    // 模型理由可能包含写入正文或凭证；父进程只转发安全类别，硬规则理由保持可操作。
    if (entry.source === "hard-rule" && typeof entry.reason === "string") summary.reason = entry.reason;
    if (entry.source === "model") summary.reason = entry.verdict === "ALLOW" ? "model-allow" : "model-deny";
    process.stderr.write(`${prefix}${JSON.stringify(summary)}\n`);
  } catch {
    // 非审批日志或截断的 JSON 不转发，避免把子进程凭证与完整参数带入日志。
  }
}

/**
 * 解析单行 JSONL 事件，提取对该轮有意义的信息。
 *
 * @param {string} line
 * @returns {{text?: string, contextInsufficient?: boolean, biTouched?: boolean, inputTokens?: number, readPath?: string, readStarted?: boolean, readCompleted?: boolean, pendingReadId?: string, completedReadId?: string, readFailed?: boolean, readContent?: string} | null}
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
    const command = event.args?.command;
    if (typeof command === "string" && command.includes(BI_SCRIPT)) {
      return { biTouched: true };
    }
    return null;
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
    /** @type {{text?: string, contextInsufficient?: boolean, inputTokens?: number}} */
    const parsed = {};
    if (messageText) parsed.text = cleanText;
    if (contextInsufficient) parsed.contextInsufficient = true;
    if (inputTokens > 0) parsed.inputTokens = inputTokens;
    return Object.keys(parsed).length ? parsed : null;
  }

  return null;
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

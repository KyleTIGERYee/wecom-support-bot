import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { capText, stringValue } from "./text.js";

const MAX_EVENTS = 300;
const MAX_MODEL_TEXT = 40000;
const MAX_THINKING = 20000;
const MAX_TOOL_TEXT = 12000;

/**
 * 只读取完成日志实际引用的 wx 会话；local/regress/smoke 等测试会话不会进入候选集。
 *
 * @param {Array<{id: string, piDir: string}>} instances
 * @param {Set<string>} activeSessionKeys
 * @param {any} diagnostics
 */
export async function loadSessionFiles(instances, activeSessionKeys, diagnostics) {
  /** @type {any[]} */
  const files = [];
  for (const instance of instances) {
    let entries;
    try {
      entries = await readdir(instance.piDir, { withFileTypes: true });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") diagnostics.missingSources += 1;
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes("_wx-")) continue;
      const path = join(instance.piDir, entry.name);
      const records = await readSessionLines(path, diagnostics);
      const header = records.find((record) => record.type === "session");
      const sessionKey = typeof header?.id === "string" ? header.id : "";
      if (!sessionKey.startsWith("wx-") || !activeSessionKeys.has(sessionKey)) continue;
      /** @type {any[]} */
      const events = records.filter((record) => record.type === "message" && record.message && typeof record.message === "object" && Number.isFinite(Date.parse(record.timestamp)))
        .map((record) => ({ at: record.timestamp, ms: Date.parse(record.timestamp), message: record.message }))
        .sort((a, b) => a.ms - b.ms);
      files.push({ sessionKey, instanceId: instance.id, path, events });
    }
  }
  return files;
}

/** @param {string} path @param {any} diagnostics */
async function readSessionLines(path, diagnostics) {
  try {
    const raw = await readFile(path, "utf8");
    const records = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") records.push(parsed);
        else diagnostics.badLines += 1;
      } catch {
        diagnostics.badLines += 1;
      }
    }
    return records;
  } catch {
    diagnostics.missingSources += 1;
    return [];
  }
}

/**
 * pi 没有 msgid，只有「同用户严格串行 + 首轮 user 与原始问题精确匹配」才构成关联证据。
 * 下一轮的首个锚点会截断上一轮；即使下一轮缺完成日志，也先把它的锚点保留下来。
 * 完成日志只提供 sessionKey 与实例候选，不再用 +/- 宽限时间猜边界。
 *
 * @param {any[]} turns
 * @param {any[]} sessionFiles
 * @param {any} diagnostics
 */
export function attachTimelines(turns, sessionFiles, diagnostics) {
  for (const turn of turns) {
    turn.timeline = [];
    turn.answer = { text: "", source: "unavailable", truncated: false };
    turn.counts = emptyCounts();
    turn.association = null;
    turn.timelineMapped = false;
  }

  /** @type {Map<string, any[]>} */
  const turnsByColleague = new Map();
  for (const turn of turns) {
    const colleagueTurns = turnsByColleague.get(turn.colleagueId);
    if (colleagueTurns) colleagueTurns.push(turn);
    else turnsByColleague.set(turn.colleagueId, [turn]);
  }

  /** @type {Map<string, number>} 文件游标跨所有轮次共享，防止坏用户映射造成复用。 */
  const cursors = new Map();
  for (const colleagueTurns of turnsByColleague.values()) {
    const ordered = [...colleagueTurns].sort((a, b) => a.receivedMs - b.receivedMs);
    const sessionKeys = new Set(ordered.map((turn) => turn.completion?.sessionKey).filter((key) => typeof key === "string"));
    for (const turn of ordered) {
      if (!turn.questionAnchor) continue;
      const completedMs = Date.parse(turn.completion?.completedAt ?? "");
      const hasCompletionUpper = Number.isFinite(completedMs);
      const candidates = sessionFiles.filter((file) => {
        if (!sessionKeys.has(file.sessionKey)) return false;
        if (turn.completion && file.sessionKey !== turn.completion.sessionKey) return false;
        if (turn.instanceId && file.instanceId !== turn.instanceId) return false;
        return true;
      });
      /** @type {Array<{file: any, anchorIndex: number}>} */
      const matches = [];
      for (const file of candidates) {
        const cursor = cursors.get(file.path) ?? -1;
        for (let index = cursor + 1; index < file.events.length; index += 1) {
          const event = file.events[index];
          if (event.ms < turn.receivedMs) continue;
          if (hasCompletionUpper && event.ms > completedMs) break;
          if (event.message.role === "user" && isInitialPromptFor(contentText(event.message.content), turn.questionAnchor)) {
            matches.push({ file, anchorIndex: index });
            break;
          }
        }
      }
      // 多文件都找到同一问题无法证明哪份是本轮，宁可不关联。
      if (matches.length !== 1) continue;
      const match = matches[0];
      turn.association = match;
      const cursor = hasCompletionUpper ? consumeInitialRetryCursor(match, turn, completedMs) : match.anchorIndex;
      cursors.set(match.file.path, cursor);
    }
  }

  /** @type {Map<string, any[]>} */
  const assignmentsByFile = new Map();
  for (const turn of turns) {
    if (!turn.association) continue;
    const path = turn.association.file.path;
    const assignedToFile = assignmentsByFile.get(path);
    if (assignedToFile) assignedToFile.push(turn);
    else assignmentsByFile.set(path, [turn]);
  }

  for (const assignedTurns of assignmentsByFile.values()) {
    assignedTurns.sort((a, b) => a.association.anchorIndex - b.association.anchorIndex);
    markContradictorySameQuestionRuns(assignedTurns);
    for (let index = 0; index < assignedTurns.length; index += 1) {
      const turn = assignedTurns[index];
      if (turn.sameQuestionRunInvalid) continue;
      const { file, anchorIndex } = turn.association;
      const end = assignedTurns[index + 1]?.association.anchorIndex ?? file.events.length;
      const selectedEvents = file.events.slice(anchorIndex, end);
      // 段内出现无法解释的“新问题”时，整轮降级，避免吞掉未索引/匹配失败的轮次。
      if (hasUnattributedUser(selectedEvents.slice(1), turn)) {
        turn.association = null;
        continue;
      }
      const timeline = buildTimeline(selectedEvents);
      if (timeline.events.length === 0) {
        turn.association = null;
        continue;
      }
      turn.timeline = timeline.events;
      turn.answer = timeline.answer;
      turn.counts = timeline.counts;
      turn.timelineMapped = true;
    }
  }

  for (const turn of turns) {
    if (turn.sameQuestionRunInvalid) turn.association = null;
  }

  for (const turn of turns) {
    if (!turn.completion) continue;
    if (turn.timelineMapped) diagnostics.mappedTurns += 1;
    else diagnostics.unmatchedTurns += 1;
  }
}

/** 初始 prompt 只能是原问题本身，或原问题后追加确切的渐进式资源目录。 @param {string} prompt @param {string} questionAnchor */
function isInitialPromptFor(prompt, questionAnchor) {
  if (prompt === questionAnchor) return true;
  return prompt.startsWith(`${questionAnchor}\n\n[渐进式资源目录]\n`);
}

/**
 * 同用户串行保证下一轮 initial 不早于本轮完成日志；完成上界内的同文 initial
 * 只可能是 stalled 重试。全部消费到游标，段内仍会按 stallRetries 数量复核，超额即降级。
 *
 * @param {{file: any, anchorIndex: number}} match
 * @param {any} turn
 * @param {number} completedMs
 */
function consumeInitialRetryCursor(match, turn, completedMs) {
  if (!Number.isInteger(turn.completion?.stallRetries) || turn.completion.stallRetries < 1) return match.anchorIndex;
  let cursor = match.anchorIndex;
  for (let index = match.anchorIndex + 1; index < match.file.events.length; index += 1) {
    const event = match.file.events[index];
    if (event.ms > completedMs) break;
    if (event.message.role !== "user") continue;
    const text = contentText(event.message.content);
    if (!isInitialPromptFor(text, turn.questionAnchor)) break;
    cursor = index;
  }
  return cursor;
}

/**
 * 连续同文轮次必须整组可证明：完成时间严格递增、重试次数合法，
 * 且 run 整体与每轮的 initial 数量都精确等于 1 + stallRetries。
 * 标记时保留 association 作为其他问题的边界，分段结束后再清空。
 *
 * @param {any[]} assignedTurns
 */
function markContradictorySameQuestionRuns(assignedTurns) {
  let start = 0;
  while (start < assignedTurns.length) {
    let end = start + 1;
    while (end < assignedTurns.length && assignedTurns[end].questionAnchor === assignedTurns[start].questionAnchor) end += 1;
    if (end - start > 1 && !isSameQuestionRunValid(assignedTurns, start, end)) {
      for (let index = start; index < end; index += 1) assignedTurns[index].sameQuestionRunInvalid = true;
    }
    start = end;
  }
}

/** @param {any[]} assignedTurns @param {number} start @param {number} end */
function isSameQuestionRunValid(assignedTurns, start, end) {
  let previousCompletedMs = null;
  let expectedTotal = 0;
  for (let index = start; index < end; index += 1) {
    const turn = assignedTurns[index];
    const completedMs = Date.parse(turn.completion?.completedAt ?? "");
    if (!Number.isFinite(completedMs)) return false;
    if (previousCompletedMs !== null && completedMs <= previousCompletedMs) return false;
    previousCompletedMs = completedMs;
    const retries = turn.completion?.stallRetries;
    if (!Number.isInteger(retries) || retries < 0) return false;
    expectedTotal += 1 + retries;
  }

  const file = assignedTurns[start].association.file;
  const questionAnchor = assignedTurns[start].questionAnchor;
  const runStart = assignedTurns[start].association.anchorIndex;
  const runEnd = assignedTurns[end]?.association.anchorIndex ?? file.events.length;
  if (countInitialPrompts(file.events.slice(runStart, runEnd), questionAnchor) !== expectedTotal) return false;

  for (let index = start; index < end; index += 1) {
    const turn = assignedTurns[index];
    const turnStart = turn.association.anchorIndex;
    const turnEnd = index + 1 < end ? assignedTurns[index + 1].association.anchorIndex : runEnd;
    const expected = 1 + turn.completion.stallRetries;
    if (countInitialPrompts(file.events.slice(turnStart, turnEnd), questionAnchor) !== expected) return false;
  }
  return true;
}

/** @param {any[]} entries @param {string} questionAnchor */
function countInitialPrompts(entries, questionAnchor) {
  return entries.filter((entry) => entry.message.role === "user" && isInitialPromptFor(contentText(entry.message.content), questionAnchor)).length;
}

/** @param {string} text */
function isGuardReworkPrompt(text) {
  return text.startsWith("你上一条答复未通过隐私检查。");
}

/** @param {string} text */
function isProgressiveDepthPrompt(text) {
  return text.includes("不要读取无关资料") && text.includes("资源仍不足时") && text.includes("完成后给出完整答复");
}

/** @param {any[]} entries @param {any} turn */
function hasUnattributedUser(entries, turn) {
  let initialRetries = 0;
  const allowedRetries = Number.isInteger(turn.completion?.stallRetries) ? turn.completion.stallRetries : 0;
  for (const entry of entries) {
    if (entry.message.role !== "user") continue;
    const text = contentText(entry.message.content);
    if (isGuardReworkPrompt(text) || isProgressiveDepthPrompt(text)) continue;
    if (isInitialPromptFor(text, turn.questionAnchor)) {
      initialRetries += 1;
      if (initialRetries <= allowedRetries) continue;
    }
    return true;
  }
  return false;
}

function emptyCounts() {
  return { thinking: 0, skillReads: 0, documentReads: 0, toolCalls: 0, failedTools: 0 };
}

/** @param {any[]} entries */
function buildTimeline(entries) {
  /** @type {any[]} */
  const events = [];
  /** @type {Map<string, any>} */
  const calls = new Map();
  let answer = { text: "", source: "unavailable", truncated: false };

  for (const entry of entries) {
    const message = entry.message;
    if (message.role === "user") {
      const text = contentText(message.content);
      if (isGuardReworkPrompt(text)) {
        const reason = text.split("\n").find((line) => line.startsWith("原因："))?.slice(3) ?? "";
        events.push({ type: "guardRework", at: entry.at, text: "Guard 未通过，主模型被要求脱敏重写", reason: redactText(reason).slice(0, 1000) });
      } else if (isProgressiveDepthPrompt(text)) {
        events.push({ type: "progressiveDepth", at: entry.at, text: "概念内容不足，继续读取当前任务所需资料" });
      }
      continue;
    }

    if (message.role === "assistant") {
      /** @type {any[]} */
      const parts = Array.isArray(message.content) ? message.content : [];
      const modelText = parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("").trim();
      if (modelText) {
        const cleanedAnswer = modelText.replace(/^CONTEXT_INSUFFICIENT\s*[:：][^\n]*(?:\n+|$)/, "").replace(/^CONTEXT_INSUFFICIENT\s+/, "");
        const capped = capText(redactText(cleanedAnswer), MAX_MODEL_TEXT);
        answer = { text: capped.text, source: "pi-final-model-text", truncated: capped.truncated || message.stopReason === "length" };
      }
      for (const part of parts) {
        if (part?.type === "thinking" && typeof part.thinking === "string") {
          const capped = capText(redactText(part.thinking), MAX_THINKING);
          events.push({ type: "thinking", at: entry.at, text: capped.text, truncated: capped.truncated });
        } else if (part?.type === "toolCall" && typeof part.id === "string") {
          const name = typeof part.name === "string" ? part.name : "unknown";
          const event = {
            type: "toolCall",
            at: entry.at,
            id: part.id,
            name,
            arguments: toolArguments(name, part.arguments),
            result: null,
            resultAt: null,
            missingResult: false,
            isSkillRead: name === "read" && typeof part.arguments?.path === "string" && part.arguments.path.endsWith("/SKILL.md"),
          };
          events.push(event);
          calls.set(part.id, event);
        } else if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          const capped = capText(redactText(part.text), MAX_MODEL_TEXT);
          events.push({ type: "modelText", at: entry.at, text: capped.text, truncated: capped.truncated });
        }
      }
      if (message.stopReason === "error" || message.stopReason === "length") {
        events.push({ type: "modelStop", at: entry.at, reason: message.stopReason, text: message.stopReason === "length" ? "供应商在长度上限处停止，文本可能不完整" : "模型返回错误，后续答复可能缺失" });
      }
      continue;
    }

    if (message.role === "toolResult") {
      const result = toolResult(message);
      const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : null;
      if (call) {
        call.result = result;
        call.resultAt = entry.at;
      } else {
        events.push({ type: "toolResult", at: entry.at, id: stringValue(message.toolCallId), name: stringValue(message.toolName) || "unknown", result, orphan: true });
      }
    }
  }

  for (const event of events) {
    if (event.type === "toolCall" && !event.result) event.missingResult = true;
  }
  const truncatedEvents = events.length > MAX_EVENTS;
  const visible = truncatedEvents ? events.slice(0, MAX_EVENTS) : events;
  if (truncatedEvents) visible.push({ type: "notice", at: events[MAX_EVENTS]?.at, text: `时间线过长，仅显示前 ${MAX_EVENTS} 个事件`, truncated: true });
  const counts = {
    thinking: events.filter((event) => event.type === "thinking").length,
    skillReads: events.filter((event) => event.isSkillRead && event.result && !event.result.isError).length,
    documentReads: events.filter((event) => event.type === "toolCall" && event.name === "read" && !event.isSkillRead && event.result && !event.result.isError).length,
    toolCalls: events.filter((event) => event.type === "toolCall").length,
    failedTools: events.filter((event) => event.type === "toolCall" && (event.missingResult || event.result?.isError)).length,
  };
  return { events: visible, answer, counts };
}

/** @param {string} name @param {any} args */
function toolArguments(name, args) {
  if (!args || typeof args !== "object") return {};
  if (["read", "write", "ls"].includes(name)) {
    /** @type {any} */
    const result = { path: stringValue(args.path) };
    if (name === "read") {
      if (Number.isFinite(args.offset)) result.offset = args.offset;
      if (Number.isFinite(args.limit)) result.limit = args.limit;
    }
    if (name === "write") result.content = capText(redactText(stringValue(args.content)), MAX_TOOL_TEXT);
    return result;
  }
  if (name === "bash") return { command: capText(redactText(stringValue(args.command)), MAX_TOOL_TEXT) };
  if (name === "edit") {
    return {
      path: stringValue(args.path),
      edits: Array.isArray(args.edits) ? args.edits.slice(0, 50).map((/** @type {any} */ edit) => ({
        oldText: capText(redactText(stringValue(edit?.oldText)), MAX_TOOL_TEXT),
        newText: capText(redactText(stringValue(edit?.newText)), MAX_TOOL_TEXT),
      })) : [],
    };
  }
  return {};
}

/** @param {any} message */
function toolResult(message) {
  const text = contentText(message.content);
  const capped = capText(redactText(text), MAX_TOOL_TEXT);
  const truncation = message.details?.truncation;
  const truncated = capped.truncated || Boolean(truncation?.truncated) || truncation?.content === true;
  return {
    text: capped.text,
    isError: message.isError === true,
    truncated,
    totalLines: Number.isFinite(truncation?.totalLines) ? truncation.totalLines : null,
    truncatedBy: typeof truncation?.truncatedBy === "string" ? truncation.truncatedBy : null,
  };
}

/** @param {any} content */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

/** 常见凭证赋值和 Authorization 头只保留键名，不回显值。 @param {string} text */
export function redactText(text) {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [已隐藏]")
    .replace(/((?:api[_-]?key|(?:access[_-]?|auth[_-]?)?token|secret|password|passwd|authorization|aeskey)["']?\s*[:=]\s*["']?)([^\s,"']+)/gi, "$1[已隐藏]");
}

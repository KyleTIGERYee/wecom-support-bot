/**
 * 轮次编排：把「跑 agent → 隐私判定 → 打回重写」串成一个完整的同事提问处理流程。
 *
 * 关键约束：agent 的原始输出在 guard 通过前绝不外发。DENY 时只把理由回灌给 agent
 * 让它重写，绝不把原答复带给调用方。
 */

import { getLoadDepth } from "./resource-catalog.js";

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_FALLBACK_TEXT = "这条涉及生产数据，我没法直接确认。建议直接问虎老师。";
const DEFAULT_ERROR_TEXT = "刚才没处理好，你再问一次？";
const DEFAULT_TIMEOUT_TEXT = "这个我查得有点久，还没查准。你换个说法我再试试，或者直接找虎老师更快。";

/**
 * @param {{
 *   question: string,
 *   sessionKey: string,
 *   deps: {
 *     state: {isBiTouched: (key: string) => boolean, markBiTouched: (key: string) => void, flush: () => Promise<void>},
 *     runAgent: (options: {prompt: string, sessionId: string, isRework: boolean}) => Promise<{text: string, biTouched: boolean, timedOut: boolean, stalled: boolean, failed: boolean, contextInsufficient?: boolean, loadedResources?: Array<{source: string, path: string, depth: string, sourceTime?: string|null, copiedAt?: string|null}>}>,
 *     review: (options: {answer: string}) => Promise<{verdict: "ALLOW"|"DENY", reason?: string}>,
 *     context?: {catalog?: string, dataPlaybook?: boolean}
 *   },
 *   maxRounds?: number,
 *   messages?: {fallbackText?: string, errorText?: string, timeoutText?: string}
 * }} options
 * @returns {Promise<{finalText: string, rounds: number, guarded: boolean, exhausted: boolean, timedOut?: boolean, stalled?: boolean, stallRetries?: number, lastDenyReason?: string, loadedResources: Array<{source: string, path: string, depth: string, sourceTime?: string|null, copiedAt?: string|null}>, loadDepth: string}>}
 */
export async function handleTurn({ question, sessionKey, deps, maxRounds = DEFAULT_MAX_ROUNDS, messages = {} }) {
  const { state, runAgent, review } = deps;
  const fallbackText = messages.fallbackText ?? DEFAULT_FALLBACK_TEXT;
  const errorText = messages.errorText ?? DEFAULT_ERROR_TEXT;
  const timeoutText = messages.timeoutText ?? DEFAULT_TIMEOUT_TEXT;

  let prompt = buildInitialPrompt(question, deps.context?.catalog);
  let lastDenyReason = "";
  let rounds = 0;
  let stallRetries = 0;
  let needGuard = state.isBiTouched(sessionKey);
  /** @type {Array<{source: string, path: string, depth: string, sourceTime?: string|null, copiedAt?: string|null}>} */
  const loadedResources = [];
  const observation = () => ({
    loadedResources: loadedResources.map((resource) => ({ ...resource })),
    loadDepth: getLoadDepth(loadedResources),
  });

  while (rounds < maxRounds) {
    rounds += 1;
    const isRework = rounds > 1;

    const { turn, retries } = await runWithProgressiveDepth(
      runAgent,
      { prompt, sessionId: sessionKey, isRework },
      { question, catalog: deps.context?.catalog, dataPlaybook: deps.context?.dataPlaybook, loadedResources },
    );
    stallRetries += retries;

    // 超时和失败给不同的话术：超时说明查得太久，失败说明出了岔子
    // 卡住（事件流静默）也算超时，因为已经重试过一次还是没动静
    if (turn.timedOut || turn.stalled) {
      return {
        finalText: timeoutText,
        rounds,
        guarded: needGuard,
        exhausted: false,
        timedOut: true,
        stalled: Boolean(turn.stalled),
        stallRetries,
        ...observation(),
      };
    }
    if (turn.failed) {
      return { finalText: errorText, rounds, guarded: needGuard, exhausted: false, ...observation() };
    }

    if (turn.biTouched && !needGuard) {
      needGuard = true;
      state.markBiTouched(sessionKey);
      await state.flush();
    }

    if (!needGuard) {
      return { finalText: turn.text, rounds, guarded: false, exhausted: false, stallRetries, ...observation() };
    }

    const verdict = await review({ answer: turn.text });
    if (verdict.verdict === "ALLOW") {
      return { finalText: turn.text, rounds, guarded: true, exhausted: false, stallRetries, ...observation() };
    }

    lastDenyReason = verdict.reason ?? "答复包含敏感个人信息";
    prompt = buildReworkPrompt(lastDenyReason);
  }

  return {
    finalText: fallbackText,
    rounds,
    guarded: true,
    exhausted: true,
    lastDenyReason,
    ...observation(),
  };
}

/**
 * 首轮只带选择资源所需的目录，不注入资源正文。
 *
 * @param {string} question
 * @param {string|undefined} catalog
 */
function buildInitialPrompt(question, catalog) {
  if (!catalog) return question;
  return [
    question,
    "",
    "[渐进式资源目录]",
    "以下目录只用于选择资料，不是资料正文。先用目录和摘要定位，再按需读取概念页；只有当前内容不足以可靠回答时才继续读取相关原始资料。",
    "如果读完概念内容仍不足以可靠回答，请在答复第一行输出 CONTEXT_INSUFFICIENT 并说明缺口；内容充分时正常回答，不输出该标记。",
    catalog,
  ].join("\n");
}

/**
 * 合并实际读取记录，保留来源、时间和每次读取的深度。
 *
 * @param {Array<{source: string, path: string, depth: string, sourceTime?: string|null, copiedAt?: string|null}>} target
 * @param {Array<{source: string, path: string, depth: string, sourceTime?: string|null, copiedAt?: string|null}>|undefined} incoming
 */
function mergeLoadedResources(target, incoming) {
  for (const resource of incoming ?? []) {
    const key = `${resource.source}\0${resource.path}\0${resource.depth}`;
    if (target.some((existing) => `${existing.source}\0${existing.path}\0${existing.depth}` === key)) continue;
    target.push({ ...resource });
  }
}

/**
 * 内容不足时，在同一 agent 会话继续读取当前任务需要的资源。
 * 这是资料深化，不是 Guard 打回，因此不占用 maxRounds。
 *
 * @param {(options: any) => Promise<any>} runAgent
 * @param {any} options
 * @param {{question: string, catalog?: string, dataPlaybook?: boolean, loadedResources: Array<{source: string, path: string, depth: string, sourceTime?: string|null, copiedAt?: string|null}>}} context
 */
async function runWithProgressiveDepth(
  runAgent,
  options,
  { question, catalog, dataPlaybook, loadedResources },
) {
  const first = await runWithStallRetry(runAgent, options);
  for (const attempt of first.attempts) mergeLoadedResources(loadedResources, attempt.loadedResources);
  if (!catalog || options.isRework || first.turn.failed || first.turn.timedOut || first.turn.stalled) return first;

  const rawNeeded = first.turn.contextInsufficient && !loadedResources.some((resource) => resource.depth === "raw");
  const playbookNeeded =
    dataPlaybook &&
    needsDataPlaybook(question) &&
    first.turn.contextInsufficient &&
    !loadedResources.some((resource) => resource.depth === "playbook");
  if (!rawNeeded && !playbookNeeded) return first;

  const instructions = [`原始问题：${question}`];
  if (playbookNeeded) {
    instructions.push("这是查数或数据口径任务。先读取目录中的 data-playbook 查数手册，再按手册完成回答；不要凭记忆直接给数字。");
  }
  if (rawNeeded) {
    instructions.push(
      "当前概念页或摘要不足以可靠回答具体规则。请只继续读取目录中与本问题相关的 raw 原始资料（优先概念页列出的 raw_source），保留资料的来源和时间。",
    );
  }
  instructions.push("不要读取无关资料；资源仍不足时明确说缺少哪部分。完成后给出完整答复。");

  const second = await runWithStallRetry(runAgent, { ...options, prompt: instructions.join("\n") });
  for (const attempt of second.attempts) mergeLoadedResources(loadedResources, attempt.loadedResources);
  return {
    turn: { ...second.turn, biTouched: Boolean(first.turn.biTouched || second.turn.biTouched) },
    retries: first.retries + second.retries,
  };
}

/** @param {string} question */
function needsDataPlaybook(question) {
  return /生产数据|查数|统计|口径|SQL|签约量|预约量|出租率|退租率|续约率|多少/i.test(question);
}

/**
 * 卡住时自动重试一次。
 *
 * 事件流静默多半是模型通道间歇停摆，而不是这道题真的答不了：换个时刻再跑一次往往就通了。
 * 只重试一次，且沿用同一个会话 —— 第一次已经查到的东西还在上下文里。
 *
 * @param {(options: any) => Promise<any>} runAgent
 * @param {any} options
 */
async function runWithStallRetry(runAgent, options) {
  const first = await runAgent(options);
  if (!first.stalled) return { turn: first, retries: 0, attempts: [first] };
  const second = await runAgent(options);
  return {
    turn: { ...second, biTouched: Boolean(first.biTouched || second.biTouched) },
    retries: 1,
    attempts: [first, second],
  };
}

/**
 * 打回重写时给 agent 的指令。只给理由，不给它看被判定的原文，
 * 避免它直接把敏感片段「换个说法」照抄一遍。
 *
 * @param {string} reason
 * @returns {string}
 */
function buildReworkPrompt(reason) {
  return [
    "你上一条答复未通过隐私检查。",
    `原因：${reason}`,
    "请重新组织答复：去掉所有具体个人信息（手机号、身份证号、姓名与联系方式组合、逐条明细），只保留结论、统计口径和业务解释。",
    "直接输出完整的重写答复，不要解释你改了什么。",
  ].join("\n");
}

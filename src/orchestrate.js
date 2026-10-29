/**
 * 轮次编排：把「跑 agent → 隐私判定 → 打回重写」串成一个完整的同事提问处理流程。
 *
 * 关键约束：agent 的原始输出在 guard 通过前绝不外发。DENY 时只把理由回灌给 agent
 * 让它重写，绝不把原答复带给调用方。
 */

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
 *     runAgent: (options: {prompt: string, sessionId: string, isRework: boolean}) => Promise<{text: string, biTouched: boolean, timedOut: boolean, stalled: boolean, failed: boolean}>,
 *     review: (options: {question: string, answer: string}) => Promise<{verdict: "ALLOW"|"DENY", reason?: string}>
 *   },
 *   maxRounds?: number,
 *   messages?: {fallbackText?: string, errorText?: string, timeoutText?: string}
 * }} options
 * @returns {Promise<{finalText: string, rounds: number, guarded: boolean, exhausted: boolean, timedOut?: boolean, stalled?: boolean, lastDenyReason?: string}>}
 */
export async function handleTurn({ question, sessionKey, deps, maxRounds = DEFAULT_MAX_ROUNDS, messages = {} }) {
  const { state, runAgent, review } = deps;
  const fallbackText = messages.fallbackText ?? DEFAULT_FALLBACK_TEXT;
  const errorText = messages.errorText ?? DEFAULT_ERROR_TEXT;
  const timeoutText = messages.timeoutText ?? DEFAULT_TIMEOUT_TEXT;

  let prompt = question;
  let lastDenyReason = "";
  let rounds = 0;
  let needGuard = state.isBiTouched(sessionKey);

  while (rounds < maxRounds) {
    rounds += 1;
    const isRework = rounds > 1;

    const turn = await runWithStallRetry(runAgent, { prompt, sessionId: sessionKey, isRework });

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
      };
    }
    if (turn.failed) {
      return { finalText: errorText, rounds, guarded: needGuard, exhausted: false };
    }

    if (turn.biTouched && !needGuard) {
      needGuard = true;
      state.markBiTouched(sessionKey);
      await state.flush();
    }

    if (!needGuard) {
      return { finalText: turn.text, rounds, guarded: false, exhausted: false };
    }

    const verdict = await review({ question, answer: turn.text });
    if (verdict.verdict === "ALLOW") {
      return { finalText: turn.text, rounds, guarded: true, exhausted: false };
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
  };
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
  if (!first.stalled) return first;
  return await runAgent(options);
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

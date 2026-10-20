/**
 * 轮次编排：把「跑 agent → 隐私判定 → 打回重写」串成一个完整的同事提问处理流程。
 *
 * 关键约束：agent 的原始输出在 guard 通过前绝不外发。DENY 时只把理由回灌给 agent
 * 让它重写，绝不把原答复带给调用方。
 */

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_FALLBACK_TEXT = "这条涉及生产数据，我没法直接确认。建议直接问虎老师。";
const DEFAULT_ERROR_TEXT = "刚才处理出错了，请稍后再试一次。";

/**
 * @param {{
 *   question: string,
 *   sessionKey: string,
 *   deps: {
 *     state: {isBiTouched: (key: string) => boolean, markBiTouched: (key: string) => void, flush: () => Promise<void>},
 *     runAgent: (options: {prompt: string, sessionId: string, isRework: boolean}) => Promise<{text: string, biTouched: boolean, timedOut: boolean, failed: boolean}>,
 *     review: (options: {question: string, answer: string}) => Promise<{verdict: "ALLOW"|"DENY", reason?: string}>
 *   },
 *   maxRounds?: number,
 *   messages?: {fallbackText?: string, errorText?: string}
 * }} options
 * @returns {Promise<{finalText: string, rounds: number, guarded: boolean, exhausted: boolean, lastDenyReason?: string}>}
 */
export async function handleTurn({ question, sessionKey, deps, maxRounds = DEFAULT_MAX_ROUNDS, messages = {} }) {
  const { state, runAgent, review } = deps;
  const fallbackText = messages.fallbackText ?? DEFAULT_FALLBACK_TEXT;
  const errorText = messages.errorText ?? DEFAULT_ERROR_TEXT;

  let prompt = question;
  let lastDenyReason = "";
  let rounds = 0;
  let needGuard = state.isBiTouched(sessionKey);

  while (rounds < maxRounds) {
    rounds += 1;
    const isRework = rounds > 1;

    const turn = await runAgent({ prompt, sessionId: sessionKey, isRework });

    if (turn.failed || turn.timedOut) {
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

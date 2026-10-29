/**
 * 一轮问答的节奏控制：能快答就快答，答不完先收尾再去后台查。
 *
 * 为什么需要它：企微的流式消息、pi 子进程、网关进程三者生死绑在一起，
 * 一个慢查询要跑两分钟，期间任何一环抖动，答复就丢了。把「等待」和「干完」拆开，
 * 超时就只是换了个送达通道，不再是失败。
 *
 * 两种结局：
 *   - inline：在交接时限内答完，流式消息原地收尾。
 *   - handoff：超时了，先把流式消息收尾成"查好了单独发你"，后台继续，完成后主动推送。
 *
 * @param {{
 *   execute: () => Promise<{finalText: string}>,
 *   surface: {
 *     progress: (text: string) => Promise<void>,
 *     handoff: (text: string) => Promise<void>
 *   },
 *   messages?: {slowText?: string, handoffText?: string},
 *   slowAfterMs?: number,
 *   handoffAfterMs?: number
 * }} options
 * @returns {Promise<{mode: "inline"|"handoff", text: string, result: any}>}
 */
export async function runTurnLifecycle({
  execute,
  surface,
  messages = {},
  slowAfterMs = 20000,
  handoffAfterMs = 60000,
}) {
  let settled = false;
  let handedOff = false;

  const slowTimer = setTimeout(() => {
    if (settled || handedOff) return;
    surface.progress(messages.slowText ?? "").catch(() => {});
  }, slowAfterMs);

  const handoffTimer = setTimeout(() => {
    if (settled) return;
    handedOff = true;
    surface.handoff(messages.handoffText ?? "").catch(() => {});
  }, handoffAfterMs);

  try {
    const result = await execute();
    settled = true;
    return { mode: handedOff ? "handoff" : "inline", text: result.finalText, result };
  } finally {
    settled = true;
    clearTimeout(slowTimer);
    clearTimeout(handoffTimer);
  }
}

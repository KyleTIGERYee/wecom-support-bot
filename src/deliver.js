/**
 * 最终答复的投递：优先用流式消息收尾；流式发不出去就改主动推送。
 *
 * 两种通道都会因为「连接刚被换掉」「流式消息已过期」而失败，所以必须两条路都试。
 * 全部失败也不能抛异常 —— 调用方已经在收尾，抛出去只会丢掉收件箱状态。
 *
 * @param {{
 *   text: string,
 *   stream: () => Promise<void>,
 *   push: (text: string) => Promise<void>,
 *   retries?: number,
 *   wait?: (ms: number) => Promise<void>
 * }} options
 * @returns {Promise<{channel: "stream"|"push"|"none", reason?: string}>}
 */
export async function deliverFinal({ text, stream, push, retries = 3, wait = sleep }) {
  let lastError = "";
  try {
    await stream();
    return { channel: "stream" };
  } catch (error) {
    lastError = describe(error);
  }

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await push(text);
      return { channel: "push" };
    } catch (error) {
      lastError = describe(error);
      if (attempt < retries) await wait(backoffMs(attempt));
    }
  }

  return { channel: "none", reason: lastError };
}

/**
 * 退避：1s、3s（3 次尝试之间的两段等待）。重试只发生在连接抖动时，拉长间隔比连续打更有效。
 *
 * @param {number} attempt 从 1 开始
 */
function backoffMs(attempt) {
  return 1000 * 3 ** (attempt - 1);
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {unknown} error */
function describe(error) {
  return String(/** @type {any} */ (error)?.message ?? error);
}

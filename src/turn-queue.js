/**
 * 按会话串行的执行队列。
 *
 * 为什么需要：pi 的 session 文件是整文件重写的（没有文件锁），同一个会话
 * 同时跑两个 pi 进程会互相覆盖、互相阻塞，最终两边都超时。实测过——同一个人
 * 连发五条消息，五个 pi 同时操作一个 session 文件，全部卡死。
 *
 * 规则：
 *   - 同一会话的任务串行执行
 *   - 不同会话互不阻塞
 *   - 可以要求"忙就跳过"（同事连发消息时，只处理最新那条，中间的直接丢）
 */
export function createTurnQueue() {
  /** 会话 → 当前正在跑的 Promise 链尾 */
  /** @type {Map<string, Promise<any>>} */
  const chains = new Map();

  /**
   * 把一个任务排进会话队列。
   *
   * @template T
   * @param {string} sessionKey
   * @param {() => Promise<T>} task
   * @param {{skipIfBusy?: boolean}} [options] skipIfBusy 为真时，若该会话已有任务在排队/执行，直接返回 null
   * @returns {Promise<T|null>}
   */
  function run(sessionKey, task, options = {}) {
    const existing = chains.get(sessionKey);

    if (options.skipIfBusy && existing) {
      return Promise.resolve(null);
    }

    const previous = existing ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => task());

    chains.set(sessionKey, next);

    // 队列清空后移除，避免 Map 无限增长
    next
      .catch(() => {})
      .then(() => {
        if (chains.get(sessionKey) === next) chains.delete(sessionKey);
      });

    return next;
  }

  /**
   * 该会话当前是否有任务在执行。
   * @param {string} sessionKey
   * @returns {boolean}
   */
  function isBusy(sessionKey) {
    return chains.has(sessionKey);
  }

  return { run, isBusy };
}

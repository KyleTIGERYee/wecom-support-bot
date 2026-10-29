/**
 * 会话队列：同一个人的消息按顺序处理，不同人之间并行。
 *
 * 为什么同会话必须串行：多条消息跑同一轮时，两个 pi 进程会同时读写同一个
 * session 文件，后开始的看不到前一条的问答；而且同一个人的连问本来就是接着说的，
 * 并行跑容易各答一半、互相矛盾。串行还顺带避免了同会话的状态写入互相覆盖。
 *
 * 为什么要有全局上限：每个在跑的轮次都是一个 pi 进程，各自带着工具与提示词，
 * 无上限会让机器同时背十几份。
 *
 * @param {{maxConcurrent?: number}} options
 */
export function createSessionQueue({ maxConcurrent = 4 }) {
  /** @type {Map<string, Promise<void>>} 每个会话的队尾 */
  const tails = new Map();
  /** @type {Map<string, number>} 每个会话未完成的任务数（含排队中） */
  const depths = new Map();
  /** 等待全局名额的任务 */
  /** @type {Array<() => void>} */
  const waiters = [];
  let running = 0;

  /**
   * 把任务排到指定会话的队尾；返回值与任务本身的返回值/异常一致。
   *
   * @template T
   * @param {string} key 会话标识
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function run(key, task) {
    depths.set(key, (depths.get(key) ?? 0) + 1);
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(
      () => execute(task),
      () => execute(task),
    );
    // 队尾只关心「前一个结束了」，不传播异常，否则后续任务会被拒
    tails.set(key, result.then(
      () => {},
      () => {},
    ));
    const tail = tails.get(key);
    if (tail) {
      tail.then(() => {
        depths.set(key, (depths.get(key) ?? 1) - 1);
        if ((depths.get(key) ?? 0) <= 0) {
          depths.delete(key);
          if (tails.get(key) === tail) tails.delete(key);
        }
      });
    }
    return result;
  }

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  async function execute(task) {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  function acquire() {
    if (running < maxConcurrent) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        running += 1;
        resolve(undefined);
      });
    });
  }

  function release() {
    running -= 1;
    const next = waiters.shift();
    if (next) next();
  }

  /**
   * 这个会话是否有任务在跑或排队 —— 用来决定给后来者的占位文案。
   *
   * @param {string} key
   */
  function isBusy(key) {
    return (depths.get(key) ?? 0) > 0;
  }

  return { run, isBusy };
}

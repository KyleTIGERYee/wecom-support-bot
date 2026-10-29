import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 会话状态：管理每个同事当前用第几代会话，以及哪些会话碰过生产数据。
 *
 * 会话按「同事 × 代号」区分。同事说"开个新会话"时代号 +1，
 * 这样上一轮的上下文和粘性标记自然作废，不需要额外清理。
 *
 * 换代不止同事主动触发。三个自动换代的理由：
 *   1. 会话从创建起满 24 小时 —— 同事不用记「新会话」，隔天自动换，避免拿几天前的对话当今天
 *      （实测过：隔了 9 天的会话被接着用，模型把 10-20 的数字当成「今天」报出来）。
 *   2. 闲置过久（默认 24 小时）—— 同理。
 *   3. 上一轮上下文过大 —— 每一轮都把全部历史重发给模型，越问越慢（实测单次输入能到五万 token）。
 * 用「换新会话」代替上下文压缩：这个模型窗口极大，pi 自带的自动压缩几乎不会触发，
 * 而手动压缩又可能发生在答题中途。
 *
 * 状态文件损坏时降级为「全量过 guard」：宁可多查，不可漏查。
 *
 * @param {{
 *   storePath: string,
 *   rotation?: {idleMs?: number, maxAgeMs?: number, maxInputTokens?: number}
 * }} options
 */
export function createSessionState({ storePath, rotation = {} }) {
  const idleMs = rotation.idleMs ?? 24 * 60 * 60 * 1000;
  const maxAgeMs = rotation.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const maxInputTokens = rotation.maxInputTokens ?? 60000;

  /** 同事 → 当前代号。缺省视为 1。 */
  /** @type {Record<string, number>} */
  let generation = {};
  /** 碰过生产数据的会话 ID。 */
  /** @type {Set<string>} */
  let touched = new Set();
  /** 同事 → 上一轮的活动（结束时刻与输入 token 数），用于判断是否该换代。 */
  /** @type {Record<string, {at: number, inputTokens: number}>} */
  let activity = {};
  /** 同事 → 当前代会话的创建时刻，到点自动换代。 */
  /** @type {Record<string, number>} */
  let startedAt = {};
  let corrupted = false;

  async function load() {
    try {
      const raw = await readFile(storePath, "utf8");
      const parsed = JSON.parse(raw);
      generation =
        parsed && typeof parsed.generation === "object" && parsed.generation ? { ...parsed.generation } : {};
      const keys = parsed && typeof parsed.touched === "object" && parsed.touched ? Object.keys(parsed.touched) : [];
      touched = new Set(keys);
      activity =
        parsed && typeof parsed.activity === "object" && parsed.activity ? { ...parsed.activity } : {};
      startedAt =
        parsed && typeof parsed.startedAt === "object" && parsed.startedAt ? { ...parsed.startedAt } : {};
      corrupted = false;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        corrupted = false;
        return;
      }
      corrupted = true;
    }
  }

  /**
   * 记下一轮活动的时刻与输入 token 数（在答复投递之后调用）。
   *
   * @param {string} userKey
   * @param {{at: number, inputTokens: number}} record
   */
  function recordActivity(userKey, { at, inputTokens }) {
    activity[userKey] = { at, inputTokens };
  }

  /**
   * 算出同事当前应该用的会话 ID；闲置过久或上下文过大时先自动换代。
   *
   * @param {string} userKey 同事标识（通常是 wx- 开头的编码）
   * @param {number} [now] 当前时刻（毫秒），便于测试注入
   * @returns {string}
   */
  function resolveSessionId(userKey, now = Date.now()) {
    if (generation[userKey] === undefined) {
      // 第一次见到这个同事：从第一代开始，并记下起始时刻
      generation[userKey] = 1;
      startedAt[userKey] = now;
      return `${userKey}-g1`;
    }
    if (shouldRotate(userKey, now)) startNewSession(userKey, now);
    return `${userKey}-g${generation[userKey]}`;
  }

  /**
   * 是否该为这个同事开新一代会话：闲置过久，或上一轮上下文已经大到拖慢每一问。
   *
   * @param {string} userKey
   * @param {number} now
   */
  function shouldRotate(userKey, now) {
    const born = startedAt[userKey];
    // 老状态文件只有代号、没有起始时间：无法判断多旧，按「已过期」处理，换一次后就有记录了
    if (born === undefined) return true;
    if (now - born > maxAgeMs) return true;

    const last = activity[userKey];
    if (!last) return false;
    if (now - last.at > idleMs) return true;
    return last.inputTokens > maxInputTokens;
  }

  /**
   * 给同事开一代新会话，返回新的会话 ID。
   * @param {string} userKey
   * @returns {string}
   */
  function startNewSession(userKey, now = Date.now()) {
    const next = (generation[userKey] ?? 1) + 1;
    generation[userKey] = next;
    startedAt[userKey] = now;

    // 旧代号的粘性标记没有意义了，一并清掉避免状态文件无限增长
    const prefix = `${userKey}-g`;
    for (const key of [...touched]) {
      if (key.startsWith(prefix)) touched.delete(key);
    }

    // 新会话上下文是空的，触发换代的旧活动记录不再作数
    delete activity[userKey];

    return `${userKey}-g${next}`;
  }

  /** @param {string} sessionId */
  function markBiTouched(sessionId) {
    touched.add(sessionId);
  }

  /**
   * @param {string} sessionId
   * @returns {boolean}
   */
  function isBiTouched(sessionId) {
    if (corrupted) return true;
    return touched.has(sessionId);
  }

  async function flush() {
    await mkdir(dirname(storePath), { recursive: true });
    const payload = {
      generation,
      touched: Object.fromEntries([...touched].map((key) => [key, true])),
      activity,
      startedAt,
    };
    await writeFile(storePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  return { load, resolveSessionId, recordActivity, startNewSession, markBiTouched, isBiTouched, flush };
}

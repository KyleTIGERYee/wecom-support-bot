import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 会话状态：管理每个同事当前用第几代会话，以及哪些会话碰过生产数据。
 *
 * 会话按「同事 × 代号」区分。同事说"开个新会话"时代号 +1，
 * 这样上一轮的上下文和粘性标记自然作废，不需要额外清理。
 *
 * 状态文件损坏时降级为「全量过 guard」：宁可多查，不可漏查。
 *
 * @param {{storePath: string}} options
 */
export function createSessionState({ storePath }) {
  /** 同事 → 当前代号。缺省视为 1。 */
  /** @type {Record<string, number>} */
  let generation = {};
  /** 碰过生产数据的会话 ID。 */
  /** @type {Set<string>} */
  let touched = new Set();
  let corrupted = false;

  async function load() {
    try {
      const raw = await readFile(storePath, "utf8");
      const parsed = JSON.parse(raw);
      generation =
        parsed && typeof parsed.generation === "object" && parsed.generation ? { ...parsed.generation } : {};
      const keys = parsed && typeof parsed.touched === "object" && parsed.touched ? Object.keys(parsed.touched) : [];
      touched = new Set(keys);
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
   * 算出同事当前应该用的会话 ID。
   * @param {string} userKey 同事标识（通常是 wx- 开头的编码）
   * @returns {string}
   */
  function resolveSessionId(userKey) {
    const gen = generation[userKey] ?? 1;
    return `${userKey}-g${gen}`;
  }

  /**
   * 给同事开一代新会话，返回新的会话 ID。
   * @param {string} userKey
   * @returns {string}
   */
  function startNewSession(userKey) {
    const next = (generation[userKey] ?? 1) + 1;
    generation[userKey] = next;

    // 旧代号的粘性标记没有意义了，一并清掉避免状态文件无限增长
    const prefix = `${userKey}-g`;
    for (const key of [...touched]) {
      if (key.startsWith(prefix)) touched.delete(key);
    }

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
    };
    await writeFile(storePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  return { load, resolveSessionId, startNewSession, markBiTouched, isBiTouched, flush };
}

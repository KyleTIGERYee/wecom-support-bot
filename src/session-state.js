import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 会话级粘性标记：记录哪些会话本轮或历史上触碰过 BI 生产数据。
 *
 * 一旦某会话碰过 BI，它后续所有轮次都要过 guard —— 主模型可能从上下文里
 * 回忆出上一轮查到的真实数据，即使本轮没有重新查询。
 *
 * 状态文件损坏时降级为「全量过 guard」：宁可多查，不可漏查。
 *
 * @param {{storePath: string}} options
 */
export function createSessionState({ storePath }) {
  /** @type {Set<string>} */
  let touched = new Set();
  let corrupted = false;

  async function load() {
    try {
      const raw = await readFile(storePath, "utf8");
      const parsed = JSON.parse(raw);
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

  /** @param {string} sessionKey */
  function markBiTouched(sessionKey) {
    touched.add(sessionKey);
  }

  /** @param {string} sessionKey */
  function isBiTouched(sessionKey) {
    if (corrupted) return true;
    return touched.has(sessionKey);
  }

  async function flush() {
    await mkdir(dirname(storePath), { recursive: true });
    const payload = { touched: Object.fromEntries([...touched].map((key) => [key, true])) };
    await writeFile(storePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  return { load, markBiTouched, isBiTouched, flush };
}

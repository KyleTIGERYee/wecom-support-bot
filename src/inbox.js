import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 收件箱：把收到的提问先落到磁盘，再交给执行层。
 *
 * 存在两个理由：
 *   1. 去重 —— 企微会重推同一条消息，msgid 相同只处理一次。
 *   2. 补跑 —— 进程重启或崩溃时，没答完的问题还在这里，启动后可以重跑并主动推送。
 *
 * 存储是 append-only JSONL：一条消息写入时是 `received`，之后的状态变更追加一条
 * 只带 msgid 与状态的短记录。读取时按顺序折叠，最后一条状态为准。
 *
 * @param {{storePath: string}} options
 */
export function createInbox({ storePath }) {
  /** @type {Map<string, any>} msgid → 消息当前状态 */
  let entries = new Map();
  /** @type {Set<string>} */
  let seen = new Set();
  /** @type {Promise<void>} 串行写盘，避免并发 append 交错 */
  let writing = Promise.resolve();

  async function load() {
    entries = new Map();
    let raw = "";
    try {
      raw = await readFile(storePath, "utf8");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        seen = new Set();
        return;
      }
      throw error;
    }

    for (const line of raw.split("\n")) {
      const record = parseLine(line);
      if (!record) continue;
      if (typeof record.question === "string") {
        // 带正文的是消息记录；state 缺失（写到一半被截断）按「还没答」处理，宁可多补跑一次
        entries.set(record.msgid, { ...record, state: record.state === "running" ? "running" : "received" });
      } else {
        const existing = entries.get(record.msgid);
        if (existing && typeof record.state === "string") existing.state = record.state;
      }
    }
    seen = new Set(entries.keys());
  }

  /**
   * 收下一条消息。同一个 msgid 第二次进来直接判定为非新消息。
   *
   * @param {any} message
   * @returns {{isNew: boolean}}
   */
  function accept(message) {
    if (seen.has(message.msgid)) return { isNew: false };
    const entry = { ...message, state: "received" };
    entries.set(message.msgid, entry);
    seen.add(message.msgid);
    append(entry);
    return { isNew: true };
  }

  /** @param {string} msgid */
  function markRunning(msgid) {
    update(msgid, "running");
  }

  /** @param {string} msgid */
  function markAnswered(msgid) {
    update(msgid, "answered");
  }

  /** @param {string} msgid */
  function markFailed(msgid) {
    update(msgid, "failed");
  }

  /**
   * 找出需要补跑的消息：还没答完（received / running），且没超出补跑窗口。
   *
   * 超过窗口的不补 —— 隔了很久突然冒出一条旧答案，比不答更让人困惑。
   *
   * @param {number} now 当前时刻（毫秒）
   * @param {number} windowMs 补跑窗口
   * @returns {any[]}
   */
  function recoverable(now, windowMs) {
    return unanswered().filter((entry) => withinWindow(entry, now, windowMs));
  }

  /**
   * 还没答完、但已经超出补跑窗口的记录：不补跑，只记日志（隔很久突然冒出旧答案更奇怪）。
   *
   * @param {number} now
   * @param {number} windowMs
   * @returns {any[]}
   */
  function stale(now, windowMs) {
    return unanswered().filter((entry) => !withinWindow(entry, now, windowMs));
  }

  function unanswered() {
    return [...entries.values()].filter((entry) => entry.state === "received" || entry.state === "running");
  }

  /**
   * 重写存储：丢掉保留期之外的记录，防止文件无限增长。
   *
   * @param {number} now
   * @param {number} retentionMs
   */
  async function compact(now, retentionMs) {
    const kept = [...entries.values()].filter((entry) => withinWindow(entry, now, retentionMs));
    entries = new Map(kept.map((entry) => [entry.msgid, entry]));
    seen = new Set(entries.keys());

    // 每条消息先写回完整记录（状态统一记为 received），当前状态再追加一条短记录，
    // 这样重写后的文件仍然符合同一个读取规则。
    const body = kept
      .flatMap((entry) => {
        const lines = [JSON.stringify({ ...entry, state: "received" })];
        if (entry.state !== "received") {
          lines.push(JSON.stringify({ msgid: entry.msgid, state: entry.state, at: new Date(now).toISOString() }));
        }
        return lines;
      })
      .join("\n");
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, body ? `${body}\n` : "", "utf8");
  }

  /** 等所有写盘完成。 */
  function flush() {
    return writing;
  }

  /**
   * @param {string} msgid
   * @param {string} state
   */
  function update(msgid, state) {
    const entry = entries.get(msgid);
    if (!entry) return;
    entry.state = state;
    append({ msgid, state, at: new Date().toISOString() });
  }

  /** @param {any} record */
  function append(record) {
    const line = `${JSON.stringify(record)}\n`;
    writing = writing
      .then(async () => {
        await mkdir(dirname(storePath), { recursive: true });
        await appendFile(storePath, line, "utf8");
      })
      .catch(() => {
        // 落盘失败不能影响答复；补跑能力会退化，但不该把主流程带崩
      });
  }

  return { load, accept, markRunning, markAnswered, markFailed, recoverable, stale, compact, flush };
}

/**
 * 收到时刻是否还在窗口内；时间解析不了的按「不在窗口内」处理。
 *
 * @param {any} entry
 * @param {number} now
 * @param {number} windowMs
 */
function withinWindow(entry, now, windowMs) {
  const receivedAt = Date.parse(entry.receivedAt);
  if (Number.isNaN(receivedAt)) return false;
  return now - receivedAt <= windowMs;
}

/**
 * @param {string} line
 * @returns {any | null}
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed?.msgid === "string" ? parsed : null;
  } catch {
    return null;
  }
}

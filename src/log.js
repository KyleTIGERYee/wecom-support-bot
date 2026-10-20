import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 简易日志：同时写 stdout（launchd 收集）与按天滚动的文件。
 *
 * @param {{logPath: string}} options
 */
export function createLogger({ logPath }) {
  /**
   * @param {string} level
   * @param {string} message
   * @param {unknown} detail
   */
  async function write(level, message, detail) {
    const suffix = detail === undefined ? "" : ` ${safeJson(detail)}`;
    const line = `[${new Date().toISOString()}] ${level} ${message}${suffix}\n`;
    process.stdout.write(line);
    try {
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, line, "utf8");
    } catch {
      // 日志失败不能影响主流程
    }
  }

  return {
    /**
     * @param {string} message
     * @param {unknown} [detail]
     */
    info(message, detail) {
      return write("INFO", message, detail);
    },
    /**
     * @param {string} message
     * @param {unknown} [detail]
     */
    warn(message, detail) {
      return write("WARN", message, detail);
    },
    /**
     * @param {string} message
     * @param {unknown} [detail]
     */
    error(message, detail) {
      return write("ERROR", message, detail);
    },
  };
}

/** @param {unknown} value */
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

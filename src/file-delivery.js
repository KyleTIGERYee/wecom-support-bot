import { promises as fs } from "node:fs";
import path from "node:path";

/** 单个交付文件的大小上限：企微临时素材走分片上传，20MB 已覆盖表格/清单类产物。 */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

/** 交付标记行：`[交付文件： 文件名]`，中英文冒号都认，必须独占一行。 */
const MARKER_RE = /^\s*\[交付文件[：:]\s*([^\]]+?)\s*\]\s*$/;

/**
 * 从答复文本里剥出交付标记：`[交付文件： 文件名]`（中英文冒号都认，文件名两端允许空格）。
 * 标记行必须独占一行，行内嵌的不算。剥掉后把标记行前后的连续空行收敛成一个，
 * 文本边缘（开头/结尾）的空行直接去掉，避免正文多出空行。
 *
 * @param {string} text
 * @returns {{cleanText: string, files: string[]}} 去掉标记行的正文（无标记时原样返回）与按出现顺序去重的文件名
 */
export function parseDeliveryMarkers(text) {
  const lines = text.split("\n");
  /** @type {string[]} */
  const files = [];
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = MARKER_RE.exec(lines[i]);
    const name = match ? match[1].trim() : "";
    if (!name) {
      out.push(lines[i]);
      continue;
    }
    if (!files.includes(name)) files.push(name);

    // 标记行前后若有连续空行，剥掉后收敛为一个；贴着文本边缘则整段去掉
    let blanksBefore = 0;
    while (out.length > 0 && out[out.length - 1].trim() === "") {
      out.pop();
      blanksBefore += 1;
    }
    let next = i + 1;
    let blanksAfter = 0;
    while (next < lines.length && lines[next].trim() === "") {
      next += 1;
      blanksAfter += 1;
    }
    const atStart = out.length === 0;
    const atEnd = next >= lines.length;
    if ((blanksBefore > 0 || blanksAfter > 0) && !atStart && !atEnd) out.push("");
    i = next - 1;
  }
  return { cleanText: out.join("\n"), files };
}

/**
 * 把工作区里的交付文件逐个发给同事：先 uploadMedia 换 media_id（3 天有效），
 * 再用 sendMessage 的 file 消息送达。单个文件任何一步失败只记 failed 并 log.warn，
 * 继续处理下一个，不让一个坏文件拖垮整轮交付。
 *
 * @param {{
 *   client: {
 *     uploadMedia(buffer: Buffer, options: {type: "file", filename: string}): Promise<{media_id: string}>,
 *     sendMessage(target: string, body: {msgtype: "file", file: {media_id: string}}): Promise<unknown>
 *   },
 *   target: string,
 *   workspaceDir: string,
 *   files: string[],
 *   log?: {warn?: (message: string, meta?: unknown) => void} | null,
 *   maxBytes?: number
 * }} options
 * @returns {Promise<{sent: string[], failed: string[]}>}
 */
export async function deliverWorkspaceFiles({ client, target, workspaceDir, files, log = console, maxBytes = MAX_MEDIA_BYTES }) {
  const sent = [];
  const failed = [];
  const root = path.resolve(workspaceDir);
  for (const file of files) {
    try {
      // resolve 结果必须仍落在 workspace 内，防 ../ 或绝对路径把实例外的文件带出去
      const resolved = path.resolve(root, file);
      if (!resolved.startsWith(root + path.sep)) {
        throw new Error(`文件越出工作区：${file}`);
      }
      const buffer = await fs.readFile(resolved);
      if (buffer.byteLength > maxBytes) {
        throw new Error(`文件超过 ${maxBytes} 字节上限：${file}`);
      }
      const { media_id: mediaId } = await client.uploadMedia(buffer, { type: "file", filename: path.basename(resolved) });
      await client.sendMessage(target, { msgtype: "file", file: { media_id: mediaId } });
      sent.push(file);
    } catch (error) {
      failed.push(file);
      log?.warn?.("文件交付失败", { file, message: String(/** @type {any} */ (error)?.message ?? error) });
    }
  }
  return { sent, failed };
}

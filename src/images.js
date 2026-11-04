import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

/** 单张图片的大小上限：企微图片一般远小于此，超限多半是发错了文件。 */
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
/** 只保留常见图片后缀，其余一律按 .jpg 落盘，避免把奇怪文件名带进仓库目录。 */
const ALLOWED_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

/**
 * 把一条消息里的图片全部下载解密并存到本地，返回可给 agent 用 read 工具查看的路径。
 *
 * 企微图片 URL 只有五分钟有效期，必须在收到消息后立刻调用，不能等排队。
 * 任一图片下载失败或超限都会抛错，由上层回复同事重发。
 *
 * @param {{client: {downloadFile(url: string, aeskey?: string): Promise<{buffer: Buffer, filename?: string}>}, images: Array<{url: string, aeskey?: string}>, dir: string, msgid: string, maxBytes?: number}} options
 * @returns {Promise<string[]>}
 */
export async function downloadImages({ client, images, dir, msgid, maxBytes = DEFAULT_MAX_BYTES }) {
  await mkdir(dir, { recursive: true });
  const paths = [];
  const safeMsgid = String(msgid).replace(/[^A-Za-z0-9_-]/g, "_");
  let index = 0;
  for (const image of images) {
    index += 1;
    const { buffer, filename } = await client.downloadFile(image.url, image.aeskey);
    if (buffer.length > maxBytes) {
      throw new Error(`图片超过大小限制（${Math.round(maxBytes / 1024 / 1024)}MB）`);
    }
    const ext = extname(filename ?? "").toLowerCase();
    const suffix = ALLOWED_EXTS.has(ext) ? ext : ".jpg";
    const path = join(dir, `${safeMsgid}-${index}${suffix}`);
    await writeFile(path, buffer);
    paths.push(path);
  }
  return paths;
}

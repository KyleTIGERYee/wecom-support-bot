import { promises as fs } from "node:fs";
import path from "node:path";

/** 单个交付文件的大小上限：企微临时素材走分片上传，20MB 已覆盖表格/清单类产物。 */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

/**
 * guard 送审内容的默认截断参数（字节）：≤32KB 全量送审；
 * 超出取头 16KB + 中段 4KB + 尾 8KB 抽样，guard 只需要判断敏感字段，抽样足够。
 */
export const GUARD_SAMPLE_BYTES = { full: 32 * 1024, head: 16 * 1024, middle: 4 * 1024, tail: 8 * 1024 };

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
 * 给工作区拍一张 mtime 快照（工作区相对路径 → mtimeMs），作为本轮交付的基线：
 * 本轮结束时 mtime 没有晚于基线的文件视为历史产物，不允许投递。
 * workspace 以平铺为主，这里直接整棵遍历，子目录里的旧文件同样拦得住。
 *
 * @param {string} workspaceDir
 * @returns {Promise<Map<string, number>>} 目录不存在时返回空快照
 */
export async function snapshotWorkspace(workspaceDir) {
  const root = path.resolve(workspaceDir);
  /** @type {Map<string, number>} */
  const snapshot = new Map();

  /** @param {string} dir */
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const info = await fs.stat(full);
        snapshot.set(workspaceKey(root, full), info.mtimeMs);
      }
    }
  }

  await walk(root);
  return snapshot;
}

/**
 * 工作区内文件的快照键：相对 root 的正斜杠路径，与交付标记里的相对路径对齐。
 *
 * @param {string} root
 * @param {string} resolved
 * @returns {string}
 */
function workspaceKey(root, resolved) {
  return path.relative(root, resolved).split(path.sep).join("/");
}

/**
 * 把文件内容裁成 guard 送审样本：不超过 full 字节全量；超出则头 head + 中段 middle +
 * 尾 tail 三段拼接，每个断口插一行「……中间省略 N 字节……」。
 *
 * @param {Buffer} buffer
 * @param {{full: number, head: number, middle: number, tail: number}} limits
 * @returns {string}
 */
export function sampleForGuard(buffer, limits = GUARD_SAMPLE_BYTES) {
  if (buffer.byteLength <= limits.full) return buffer.toString("utf8");
  const middleStart = Math.floor((buffer.byteLength - limits.middle) / 2);
  const firstOmitted = middleStart - limits.head;
  const secondOmitted = buffer.byteLength - limits.tail - (middleStart + limits.middle);
  return [
    buffer.subarray(0, limits.head).toString("utf8"),
    `……中间省略 ${firstOmitted} 字节……`,
    buffer.subarray(middleStart, middleStart + limits.middle).toString("utf8"),
    `……中间省略 ${secondOmitted} 字节……`,
    buffer.subarray(buffer.byteLength - limits.tail).toString("utf8"),
  ].join("\n");
}

/**
 * 粗判二进制：开头样本里出现 NUL，或不可打印控制字符占比过高，就当非文本。
 * 本场景交付物是 CSV/MD 文本，命中时跳过 guard 直接投递，不引入编码探测依赖。
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function looksBinary(buffer) {
  const sample = buffer.subarray(0, 4096);
  let suspicious = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const byte = sample[i];
    if (byte === 0) return true;
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

/**
 * 把工作区里的交付文件逐个发给同事：先 uploadMedia 换 media_id（3 天有效），
 * 再用 sendMessage 的 file 消息送达。单个文件任何一步失败只记 failed 并 log.warn，
 * 继续处理下一个，不让一个坏文件拖垮整轮交付。
 *
 * 每个文件按顺序过四道闸：resolve 防穿越 → 本轮生成校验（mtime 必须晚于基线快照，
 * 基线缺省时跳过保持向后兼容）→ 大小上限 → guard 内容审核（文本内容交给回调，
 * DENY 则不投递；二进制不做内容审核）。
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
 *   maxBytes?: number,
 *   baseline?: Map<string, number> | null,
 *   guard?: ((content: string, filename: string) => Promise<{verdict: "ALLOW"|"DENY", reason?: string}>) | null,
 *   guardSampleBytes?: {full: number, head: number, middle: number, tail: number}
 * }} options
 * @returns {Promise<{sent: string[], failed: string[]}>}
 */
export async function deliverWorkspaceFiles({
  client,
  target,
  workspaceDir,
  files,
  log = console,
  maxBytes = MAX_MEDIA_BYTES,
  baseline = null,
  guard = null,
  guardSampleBytes = GUARD_SAMPLE_BYTES,
}) {
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
      // 只有本轮新生成（新建或 mtime 晚于基线）的文件可投递，历史文件和别的会话的产物一律拦下
      if (baseline) {
        const baseMtime = baseline.get(workspaceKey(root, resolved));
        if (baseMtime !== undefined && !((await fs.stat(resolved)).mtimeMs > baseMtime)) {
          throw new Error(`文件不是本轮新生成的：${file}`);
        }
      }
      const buffer = await fs.readFile(resolved);
      if (buffer.byteLength > maxBytes) {
        throw new Error(`文件超过 ${maxBytes} 字节上限：${file}`);
      }
      // 文件内容与答复正文过同一道隐私守卫；非文本交付物没有可审的敏感字段，直接投递
      if (guard && !looksBinary(buffer)) {
        const verdict = await guard(sampleForGuard(buffer, guardSampleBytes), file);
        if (verdict?.verdict === "DENY") {
          throw new Error(`guard 拦截：${verdict.reason ?? "文件内容未通过隐私校验"}`);
        }
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

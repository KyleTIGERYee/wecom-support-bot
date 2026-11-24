/**
 * 个人残留词守卫：安装包与仓库都不应带个人称呼/昵称、本机用户路径、私人局域网地址。
 *
 * buildPackage()/verifyPackage() 对包内每个文件调用；test/personal-residue.test.js 对仓库
 * tracked/未跟踪文件与安装包产物调用。禁词在这里用转义或字符类书写，避免守卫文件自身命中。
 *
 * @typedef {{ pattern: RegExp, label: string, fix: string }} ResidueRule
 */

/**
 * 规则都带边界：
 * - 用户名后不能再接字母数字，避免把更长的无关标识（例如 /Users/<name>igh、com.<name>igh.service）误报；
 *   允许 `-`、`.` 等分隔符，com.<name>-support-bot 这类仍是个人标签。
 * - 本机路径同时覆盖 macOS（/Users/<name>）、Linux（/home/<name>）与 Windows（C:\Users\<name>、
 *   C:/Users/<name>，以及 WSL 的 \home\<name>），不区分大小写。
 * - 局域网地址前后都不能再接数字；后面也不能接 `.字母`，避免把更长数字串或 `x.x.x.x.example`
 *   这类域名误报。
 */
export const PERSONAL_RESIDUE_RULES = [
  { pattern: /\u864e\u8001\u5e08/u, label: "个人称呼（负责人姓名）", fix: "改为「技术同事」「项目负责人」等通用称呼" },
  { pattern: /(?:\u8d5b\u535a)?\u963f\u864e/u, label: "个人昵称", fix: "改为「技术支持助手」等通用称呼" },
  { pattern: /com\.k[y]le(?![a-z0-9])/i, label: "个人 launchd 标签", fix: "改为 com.wecom-support-bot" },
  { pattern: /(?:[\\/]Users[\\/]|[\\/]home[\\/])k[y]le(?![a-z0-9])/i, label: "个人本机路径", fix: "改为 /tmp/fixture/... 等占位路径、相对路径或由 import.meta.url 推导" },
  { pattern: /(?<![\d.])192\.168\.1\.2[03](?!\d|\.[a-z0-9])/, label: "私人局域网地址", fix: "改为 <Windows主机IP>、<本机局域网IP> 或 http://10.0.0.1:3425/v1 等占位地址" },
  { pattern: /~k[y]le(?![a-z0-9])/i, label: "个人主目录", fix: "改为 ~someone 等通用占位" },
];

/**
 * 把文件字节解码成可扫描文本，避免非 UTF-8 文本因解码失败而被跳过：
 * 带 BOM 的 UTF-16 按 BOM 解码；其余先严格按 UTF-8 解码，失败时依次尝试 GBK 与 Latin-1。
 * 无 BOM 的 UTF-16 无法可靠识别，调用方应按二进制处理。
 *
 * @param {Uint8Array} buffer
 * @returns {string}
 */
export function decodeTextForScan(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // 非 UTF-8 文本：换编码继续，绝不因为解码失败就跳过扫描。
  }
  for (const encoding of ["gbk", "latin1"]) {
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      // 小 ICU 构建不支持该编码时尝试下一个。
    }
  }
  return bytes.toString("latin1");
}

/**
 * 返回文本命中的第一项个人残留。
 *
 * @param {string} text
 * @returns {{ label: string, fix: string } | null}
 */
export function findPersonalResidue(text) {
  for (const { pattern, label, fix } of PERSONAL_RESIDUE_RULES) {
    if (pattern.test(text)) return { label, fix };
  }
  return null;
}

/**
 * 返回文本命中的全部个人残留（按规则去重，顺序稳定）。
 *
 * @param {string} text
 * @returns {Array<{ label: string, fix: string }>}
 */
export function findAllPersonalResidue(text) {
  return PERSONAL_RESIDUE_RULES.filter(({ pattern }) => pattern.test(text)).map(({ label, fix }) => ({ label, fix }));
}

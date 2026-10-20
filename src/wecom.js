/**
 * 企微消息帧的归一化与输出整形。
 *
 * 连接与收发的编排在 index.js；这里只做纯数据变换，便于单测。
 */

/**
 * 把企微消息帧归一化成网关需要的形状；无法提取文本时返回 null。
 *
 * @param {any} frame
 * @returns {{text: string, userId: string, chatType: string, chatId: string} | null}
 */
export function normalizeMessage(frame) {
  const body = frame?.body;
  if (!body) return null;

  const text = extractText(body);
  const userId = body.from?.userid;
  if (!text || !userId) return null;

  return {
    text,
    userId,
    chatType: body.chattype === "group" ? "group" : "single",
    chatId: body.chatid ?? "",
  };
}

/**
 * 判断这条消息是不是想开新会话。
 *
 * 同事不用记命令，日常说法都认；也可以直接用 /new。
 * 只认完整的短句，避免把正常提问里的"重来""重新开始"误判成指令。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isNewSessionRequest(text) {
  const normalized = text.trim().toLowerCase().replace(/[\s。！!，,？?]/g, "");
  if (!normalized) return false;
  return new Set([
    "/new",
    "新会话",
    "开个新会话",
    "开新会话",
    "重新开始",
    "重开一个",
    "清空对话",
    "清除上下文",
    "忘掉之前的",
    "换个话题",
  ]).has(normalized);
}

/**
 * @param {any} body
 * @returns {string}
 */
function extractText(body) {
  if (typeof body.text?.content === "string") return body.text.content.trim();
  if (typeof body.voice?.content === "string") return body.voice.content.trim();
  if (Array.isArray(body.mixed?.msg_item)) {
    return body.mixed.msg_item
      .filter((/** @type {any} */ item) => item?.msgtype === "text")
      .map((/** @type {any} */ item) => item.text?.content ?? "")
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * 生成稳定的 pi 会话 ID。
 *
 * pi 的 --session-id 只接受 [A-Za-z0-9._-]，而企微 userid 可能含其他字符，
 * 所以做一次 base64url 编码保证可逆（不会让两个不同 userid 撞到同一会话），
 * 并截断到 pi 允许的长度。前缀用于人眼区分来源。
 *
 * @param {string} userId
 * @returns {string}
 */
export function toSessionKey(userId) {
  const encoded = Buffer.from(userId, "utf8").toString("base64url").replace(/[^A-Za-z0-9_-]/g, "");
  return `wx-${encoded}`.slice(0, 64);
}

/**
 * 去掉企微 @机器人 时附带的占位符。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMention(text) {
  return text.replace(/@\S+\s*/g, "").trim();
}

/**
 * 企微智能机器人封装。
 *
 * 只做三件事：连上长连接、把消息归一化成网关需要的形状、把最终答复写回。
 * 业务判断一律不放这里。
 */

/**
 * 把企微消息帧归一化。
 *
 * @param {any} frame
 * @returns {{text: string, userId: string, chatId: string, chatType: string, msgId: string} | null}
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
    chatId: body.chatid ?? userId,
    chatType: body.chattype ?? "single",
    msgId: body.msgid ?? "",
  };
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
 * 因此做一次哈希；前缀用于人眼区分。
 *
 * @param {string} userId
 * @returns {string}
 */
export function toSessionKey(userId) {
  const sanitized = userId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `wx-${sanitized}`.slice(0, 64);
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

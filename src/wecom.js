/**
 * 企微消息帧的归一化与输出整形。
 *
 * 连接与收发的编排在 index.js；这里只做纯数据变换，便于单测。
 */

/**
 * 把企微消息帧归一化成网关需要的形状；无法提取文本、图片且没有文件时返回 null。
 *
 * @param {any} frame
 * @returns {{text: string, userId: string, chatType: string, chatId: string, msgid: string | null, images: Array<{url: string, aeskey?: string}>, files: Array<{url: string, aeskey?: string, filename?: string, fromQuote?: boolean}>} | null}
 */
export function normalizeMessage(frame) {
  const body = frame?.body;
  if (!body) return null;

  const text = extractText(body);
  const images = extractImages(body);
  const files = extractFiles(body);
  const userId = body.from?.userid;
  if ((!text && images.length === 0 && files.length === 0) || !userId) return null;

  return {
    text,
    userId,
    chatType: body.chattype === "group" ? "group" : "single",
    chatId: body.chatid ?? "",
    // 去重要用的消息唯一标识；缺了它退化成「按内容去重」，由上层兜底
    msgid: typeof body.msgid === "string" && body.msgid ? body.msgid : null,
    images,
    files,
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
 * 取出消息里的图片（纯图片消息与图文混排里的图）。
 * 下载链接只有五分钟有效期，由上层收到后立刻下载。
 *
 * @param {any} body
 * @returns {Array<{url: string, aeskey?: string}>}
 */
function extractImages(body) {
  /** @type {Array<{url: string, aeskey?: string}>} */
  const images = [];
  const push = (/** @type {any} */ image) => {
    if (typeof image?.url === "string" && image.url) {
      images.push({ url: image.url, aeskey: typeof image.aeskey === "string" ? image.aeskey : undefined });
    }
  };
  push(body.image);
  if (Array.isArray(body.mixed?.msg_item)) {
    for (const item of body.mixed.msg_item) {
      if (item?.msgtype === "image") push(item.image);
    }
  }
  return images;
}

/**
 * 取出消息里的文件（纯文件消息、混排中的文件及引用消息里的文件）。
 * 下载链接只有五分钟有效期，由上层收到后立刻下载。
 *
 * @param {any} body
 * @returns {Array<{url: string, aeskey?: string, filename?: string, fromQuote?: boolean}>}
 */
function extractFiles(body) {
  /** @type {Array<{url: string, aeskey?: string, filename?: string, fromQuote?: boolean}>} */
  const files = [];
  const push = (/** @type {any} */ file, /** @type {boolean} */ fromQuote) => {
    if (typeof file?.url === "string" && file.url) {
      const filename =
        typeof file.filename === "string" && file.filename
          ? file.filename
          : typeof file.name === "string" && file.name
            ? file.name
            : undefined;
      /** @type {{url: string, aeskey?: string, filename?: string, fromQuote?: boolean}} */
      const entry = {
        url: file.url,
        aeskey: typeof file.aeskey === "string" ? file.aeskey : undefined,
      };
      if (filename) entry.filename = filename;
      if (fromQuote) entry.fromQuote = true;
      files.push(entry);
    }
  };
  push(body.file, false);
  if (Array.isArray(body.mixed?.msg_item)) {
    for (const item of body.mixed.msg_item) {
      if (item?.msgtype === "file") push(item.file, false);
    }
  }
  if (body.quote && (body.quote.msgtype === "file" || body.quote.file?.url)) {
    push(body.quote.file, true);
  }
  return files;
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
 * 去掉消息开头 @机器人 的提及部分。
 *
 * 群聊里企微把提及拼成纯文本放在正文前面（如「@技术支持助手 退租怎么算」），
 * 需要剥掉才能识别指令。只处理**开头连续出现的** @提及，
 * 不能全局替换：正文里的邮箱（zhangsan@szajyy.com）会被截断。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMention(text) {
  return text.replace(/^(?:@[^\s@]+\s+)+/, "").trim();
}

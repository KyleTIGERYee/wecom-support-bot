/**
 * 分级路由：先判断问题需不需要深挖，再决定用多强的思考。
 *
 * 为什么需要：所有问题一律最高思考强度，连「在吗」都要 9–52 秒（试运行日志）。
 * 判成 quick 的仍保留全部工具，只是想得浅一点 —— 分错了是慢一点/答得糙一点，
 * 不是答不了；反过来判错方向（把查数题判成快答）代价更大，所以拿不准一律 deep。
 */

const SYSTEM_PROMPT = `你在给企业内部技术支持机器人分诊问题，只输出一个词。

QUICK：不需要查生产数据、不需要翻代码就能答的：打招呼、自我介绍、
业务概念解释（退租有哪些类型、某个字段什么意思）、流程规则说明。

DEEP：要查具体数字或统计、要核对某条数据/某个单据状态、要看代码实现、
要把多个来源对齐、口径可能有争议、你不完全确定该归哪类。

只输出 QUICK 或 DEEP，不要解释。`;

/**
 * @param {{
 *   question: string,
 *   callModel: (messages: Array<{role: string, content: string}>) => Promise<string>
 * }} options
 * @returns {Promise<"quick"|"deep">}
 */
export async function classifyQuestion({ question, callModel }) {
  let raw;
  try {
    raw = await callModel([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: question },
    ]);
  } catch {
    return "deep";
  }

  return pick(raw);
}

/**
 * 取文本里最先出现的判定词；两个都没有（或模型在解释）按 deep。
 *
 * @param {unknown} raw
 */
function pick(raw) {
  const text = String(raw ?? "").toUpperCase();
  const quickIndex = text.indexOf("QUICK");
  const deepIndex = text.indexOf("DEEP");

  if (quickIndex === -1 && deepIndex === -1) return "deep";
  if (quickIndex === -1) return "deep";
  if (deepIndex === -1) return "quick";
  return quickIndex < deepIndex ? "quick" : "deep";
}

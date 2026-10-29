/**
 * 隐私守卫：判定 agent 的答复是否可以在企微聊天里发给同事。
 *
 * 只在意一件事 —— 有没有把生产库里的真实个人信息原样发出去。
 * 聚合统计、表结构、业务规则、代码逻辑一律放行，否则同事最常问的
 * 「这个月退租率多少」这类问题会被误杀，机器人就废了。
 */

const SYSTEM_PROMPT = `你是内部技术支持机器人的隐私检查器。同事是公司内部员工，你有权判断一段答复是否可以发到企微聊天里。

**只判答复正文本身**：不要推测提问人的动机，也不要因为"他好像想要明细"或"他问得急"而从严。

【DENY】答复正文里出现以下任一情况：
- 真实手机号、身份证号、银行卡号（完整或可还原的掩码都不行）
- 姓名与联系方式、证件号同时出现，或能定位到某个具体自然人的组合（姓名+房号+电话）
- 人级明细：三行及以上逐人罗列租客/客户/业主记录（含姓名、证件、电话、合同号等身份字段）
- 数据库密码、API Key、Token、内网 IP 地址

【ALLOW】以下情况一律放行：
- 聚合统计：总量、占比、同比环比、金额合计
- 分组汇总：按门店、楼栋、区、战区、机构、渠道、状态、月份等维度分组的数量/金额/占比。**无论多少行、无论是不是 markdown 表格，只要每一行是一个组（而不是一个人），就放行**
- 表结构、字段含义、字典值、业务规则、审批流程、代码逻辑、SQL 语句本身
- 带掩码的个人信息（如 138****1234）
- 知识库文档里的格式示例与占位符
- 单个姓名、单个合同编号、单个工单号、单个房号（不与电话/证件同时出现）

只输出 ALLOW 或 DENY。若为 DENY，另起一行输出理由，不要解释。`;

/**
 * 对一条答复做隐私判定。
 *
 * 只接收答复、不接收提问：早期版本把提问也喂给判定模型，结果它顺着「他想要明细」的意图
 * 把纯汇总也判成敏感（实测同一段答复换个中性问法就 ALLOW）。判定应当只看正文内容。
 *
 * @param {{
 *   answer: string,
 *   callModel: (messages: Array<{role: string, content: string}>) => Promise<string>
 * }} options
 * @returns {Promise<{verdict: "ALLOW"|"DENY", reason?: string}>}
 */
export async function reviewReply({ answer, callModel }) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `机器人的答复：\n${answer}` },
  ];

  let raw;
  try {
    raw = await callModel(messages);
  } catch {
    return { verdict: "DENY", reason: "隐私校验失败，无法确认答复是否包含敏感数据" };
  }

  const verdict = parseVerdict(raw);
  if (verdict === "ALLOW") {
    return { verdict: "ALLOW" };
  }
  if (verdict === "DENY") {
    return { verdict: "DENY", reason: parseReason(raw) || "答复包含敏感个人信息" };
  }
  return { verdict: "DENY", reason: "隐私校验返回了无法识别的判定" };
}

/**
 * @param {unknown} raw
 * @returns {"ALLOW"|"DENY"|null}
 */
function parseVerdict(raw) {
  const text = String(raw ?? "").toUpperCase();
  if (text.includes("DENY")) return "DENY";
  if (text.includes("ALLOW")) return "ALLOW";
  return null;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function parseReason(raw) {
  const lines = String(raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const reasonLine = lines.slice(1).join(" ").trim();
  return reasonLine.replace(/^原因[:：]\s*/, "").trim();
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 直连内网 OpenAI 兼容接口的模型客户端，供 guard 判定使用。
 *
 * 不走 pi 进程：guard 每次调用要快（1-2 秒），而起一个 pi 要加载工具和提示词。
 *
 * @param {{config: any, agentDir: string}} options
 */
export async function createGuardClient({ config, agentDir }) {
  const readFileFn = (/** @type {string} */ path) => readFile(path, "utf8");

  // 本地实例直接提供 Guard 凭证；现有生产实例仍复用隔离 pi 的 models.json。
  let apiKey = config.guard.apiKey ?? "";
  let baseUrl = config.guard.baseUrl;
  if (!apiKey) {
    try {
      const models = JSON.parse(await readFileFn(join(agentDir, "models.json")));
      const provider = models?.providers?.[config.pi.provider];
      if (provider?.apiKey) apiKey = provider.apiKey;
      if (provider?.baseUrl) baseUrl = provider.baseUrl;
    } catch {
      // 读不到就让调用失败，guard 会 fail-closed
    }
  }

  /**
   * @param {Array<{role: string, content: string}>} messages
   * @returns {Promise<string>}
   */
  return async function callModel(messages) {
    if (!apiKey) throw new Error("未找到模型 apiKey");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.guard.timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: config.guard.model,
          messages,
          temperature: 0,
          max_tokens: 200,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`模型返回 ${response.status}`);
      }

      const data = /** @type {any} */ (await response.json());
      return data?.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  };
}

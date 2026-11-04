import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 直连 OpenAI 兼容接口的共享客户端。Guard 与执行审批只提供各自的模型配置。
 *
 * @param {{modelConfig: any, provider: string, agentDir: string}} options
 */
async function createOpenAICompatibleClient({ modelConfig, provider, agentDir }) {
  let apiKey = modelConfig.apiKey ?? "";
  let baseUrl = modelConfig.baseUrl;
  if (!apiKey) {
    try {
      const models = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"));
      const modelProvider = models?.providers?.[provider];
      if (modelProvider?.apiKey) apiKey = modelProvider.apiKey;
      if (modelProvider?.baseUrl) baseUrl = modelProvider.baseUrl;
    } catch {
      // 读不到凭证时让调用失败，Guard 与执行审批都会 fail-closed。
    }
  }

  /**
   * @param {Array<{role: string, content: string}>} messages
   * @returns {Promise<string>}
   */
  return async function callModel(messages) {
    if (!apiKey) throw new Error("未找到模型 apiKey");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), modelConfig.timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: modelConfig.model,
          messages,
          temperature: 0,
          max_tokens: 200,
        }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`模型返回 ${response.status}`);
      const data = /** @type {any} */ (await response.json());
      return data?.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Guard 直连模型，避免为每次判定启动 pi。
 *
 * @param {{config: any, agentDir: string}} options
 */
export async function createGuardClient({ config, agentDir }) {
  return createOpenAICompatibleClient({ modelConfig: config.guard, provider: config.pi.provider, agentDir });
}

/**
 * 独立执行审批模型客户端，只返回模型文本，不执行工具。
 *
 * @param {{config: any, agentDir: string}} options
 */
export async function createExecutionApprovalClient({ config, agentDir }) {
  return createOpenAICompatibleClient({
    modelConfig: config.executionApproval,
    provider: config.pi.provider,
    agentDir,
  });
}

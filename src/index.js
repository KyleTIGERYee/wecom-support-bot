import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import AiBot from "@wecom/aibot-node-sdk";

import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { createSessionState } from "./session-state.js";
import { createGuardClient } from "./model-client.js";
import { runAgentTurn } from "./agent.js";
import { reviewReply } from "./guard.js";
import { handleTurn } from "./orchestrate.js";
import { normalizeMessage, toSessionKey, stripMention } from "./wecom.js";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
  const config = await loadConfig(projectDir);
  const log = createLogger({ logPath: join(projectDir, "logs/bot.log") });

  const state = createSessionState({ storePath: join(projectDir, "data/session-state.json") });
  await state.load();

  const callModel = await createGuardClient({ config, agentDir: config.pi.agentDir });

  const client = new AiBot.WSClient({
    botId: config.wecom.botId,
    secret: config.wecom.secret,
    reconnectInterval: 1000,
    maxReconnectAttempts: -1,
  });

  client.on("authenticated", () => log.info("企微长连接已就绪"));
  client.on("reconnecting", (attempt) => log.warn("正在重连企微", { attempt }));
  client.on("error", (error) => log.error("企微连接异常", { message: String(error?.message ?? error) }));

  // 被新连接踢掉时 SDK 不会自动重连，直接退出让 launchd 拉起，避免僵尸进程
  client.on("event.disconnected_event", () => {
    log.warn("连接被服务端断开，退出以便重启");
    process.exit(1);
  });

  client.on("event.enter_chat", (frame) => {
    client.replyWelcome(frame, {
      msgtype: "text",
      text: { content: "你好，我是技术支持助手。可以问我业务规则、表结构、数据口径，或者让我查具体的数据和代码。" },
    });
  });

  client.on("message", async (frame) => {
    const message = normalizeMessage(frame);
    if (!message) return;

    const question = stripMention(message.text);
    if (!question) return;

    const sessionKey = toSessionKey(message.userId);
    await log.info("收到提问", { user: message.userId, sessionKey, length: question.length });

    // 先占位，满足企微 5 秒内必须有响应的要求
    const streamId = AiBot.generateReqId("stream");
    try {
      await client.replyStream(frame, streamId, config.surface.progressText, false);
    } catch (error) {
      await log.warn("占位消息发送失败", { message: String(error) });
    }

    try {
      const result = await handleTurn({
        question,
        sessionKey,
        deps: {
          state,
          runAgent: ({ prompt, sessionId }) =>
            runAgentTurn({ prompt, sessionId, config, projectDir, timeoutMs: config.pi.timeoutMs }),
          review: ({ question: asked, answer }) => reviewReply({ question: asked, answer, callModel }),
        },
        maxRounds: config.guard.maxRounds,
        messages: { fallbackText: config.surface.fallbackText, errorText: config.surface.errorText },
      });

      const finalText = result.finalText || config.surface.errorText;
      await client.replyStream(frame, streamId, finalText, true);

      await log.info("答复完成", {
        sessionKey,
        rounds: result.rounds,
        guarded: result.guarded,
        exhausted: result.exhausted,
        outLength: finalText.length,
      });
    } catch (error) {
      await log.error("处理提问失败", { sessionKey, message: String(/** @type {any} */ (error)?.stack ?? error) });
      try {
        await client.replyStream(frame, streamId, config.surface.errorText, true);
      } catch {
        // 已经尽力
      }
    }
  });

  process.on("SIGTERM", () => {
    log.info("收到 SIGTERM，断开连接");
    client.disconnect();
    process.exit(0);
  });

  client.connect();
  await log.info("机器人启动", { botId: config.wecom.botId.slice(0, 8) });
}

main().catch((error) => {
  process.stderr.write(`启动失败: ${error?.stack ?? error}\n`);
  process.exit(1);
});

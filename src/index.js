import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import AiBot from "@wecom/aibot-node-sdk";

import { loadConfig } from "./config.js";
import { acquireLock, releaseLock } from "./lock.js";
import { createLogger } from "./log.js";
import { createSessionState } from "./session-state.js";
import { createGuardClient } from "./model-client.js";
import { runAgentTurn } from "./agent.js";
import { reviewReply } from "./guard.js";
import { handleTurn } from "./orchestrate.js";
import { normalizeMessage, toSessionKey, stripMention, isNewSessionRequest } from "./wecom.js";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
  const config = await loadConfig(projectDir);
  const log = createLogger({ logPath: join(projectDir, "logs/bot.log") });

  // 企微同一个机器人只能有一条长连接，两份进程会互相踢线，所以先拿锁
  const lockPath = join(projectDir, `data/${config.wecom.botId.slice(0, 8)}.lock`);
  const lock = await acquireLock({ lockPath });
  if (!lock.acquired) {
    process.stderr.write(`已有实例在运行（pid ${lock.holder}），拒绝启动。\n`);
    process.exit(2);
  }
  await log.info("已获取单实例锁", { lockPath });

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
    client
      .replyWelcome(frame, {
        msgtype: "text",
        text: {
          content:
            "你好，我是技术支持助手。业务上的问题、想查个数、或者想确认某个流程怎么走，都可以问我。想重新开始聊的时候说一句「新会话」就行。",
        },
      })
      .catch((error) => log.warn("欢迎语发送失败", { message: String(error?.message ?? error) }));
  });

  client.on("message", async (frame) => {
    const message = normalizeMessage(frame);
    if (!message) return;

    const question = stripMention(message.text);
    if (!question) return;

    const userKey = toSessionKey(message.userId);

    // 开新会话：抬一代代号，上一轮的上下文和粘性标记一并作废
    if (isNewSessionRequest(question)) {
      const sessionId = state.startNewSession(userKey);
      await state.flush();
      await log.info("开新会话", { user: message.userId, sessionId });
      // 群聊里 reply 的 text 类型会被企微拒收（40008），走流式通道
      const newSessionText = "好，之前的聊的我先忘了，咱们重新开始。";
      const streamId = AiBot.generateReqId("stream");
      try {
        await client.replyStream(frame, streamId, newSessionText, false);
        await client.replyStream(frame, streamId, newSessionText, true);
      } catch (error) {
        await log.warn("新会话确认发送失败", { message: String(/** @type {any} */ (error)?.message ?? error) });
      }
      return;
    }

    const sessionKey = state.resolveSessionId(userKey);
    await log.info("收到提问", {
      user: message.userId,
      sessionKey,
      chatType: message.chatType,
      length: question.length,
    });

    // 先占位，满足企微 5 秒内必须有响应的要求
    const streamId = AiBot.generateReqId("stream");
    try {
      await client.replyStream(frame, streamId, config.surface.progressText, false);
    } catch (error) {
      await log.warn("占位消息发送失败", { message: String(error) });
    }

    // 并发执行：不同人的请求互不影响；同一个人的连问也允许并行
    // （实测 pi 同 session 并发写入不会互锁，模型端并发也正常）
    await runTurn({ question, sessionKey, frame, streamId });
  });

  /**
   * 执行一轮完整问答：跑 agent → guard 校验 → 回写结果。
   *
   * @param {{question: string, sessionKey: string, frame: any, streamId: string}} turn
   */
  async function runTurn({ question, sessionKey, frame, streamId }) {
    const startedAt = Date.now();
    /** @type {Array<{step: string, ms: number}>} */
    const timings = [];
    const mark = (/** @type {string} */ step, /** @type {number} */ from) => {
      timings.push({ step, ms: Date.now() - from });
    };

    // 查得久时补进度并周期刷新：安抚等待的同时保活流式消息（超时上限 180s，不能只发一次）
    const progressTexts = [config.surface.slowProgressText, config.surface.keepAliveText];
    let progressIndex = 0;
    const sendProgress = () => {
      const text = progressTexts[progressIndex++ % progressTexts.length];
      client.replyStream(frame, streamId, text, false).catch(() => {});
    };
    const slowTimer = setTimeout(sendProgress, config.surface.slowProgressAfterMs);
    const keepAliveTimer = setInterval(sendProgress, config.surface.keepAliveIntervalMs);

    try {
      const result = await handleTurn({
        question,
        sessionKey,
        deps: {
          state,
          runAgent: async ({ prompt, sessionId }) => {
            const t = Date.now();
            const turn = await runAgentTurn({
              prompt,
              sessionId,
              config,
              projectDir,
              timeoutMs: config.pi.timeoutMs,
            });
            mark("agent", t);
            return turn;
          },
          review: async ({ question: asked, answer }) => {
            const t = Date.now();
            const verdict = await reviewReply({ question: asked, answer, callModel });
            mark("guard", t);
            return verdict;
          },
        },
        maxRounds: config.guard.maxRounds,
        messages: {
          fallbackText: config.surface.fallbackText,
          errorText: config.surface.errorText,
          timeoutText: config.surface.timeoutText,
        },
      });

      clearTimeout(slowTimer);
      clearInterval(keepAliveTimer);
      const t = Date.now();
      const finalText = result.finalText || config.surface.errorText;
      await client.replyStream(frame, streamId, finalText, true);
      mark("send", t);

      await log.info("答复完成", {
        sessionKey,
        rounds: result.rounds,
        guarded: result.guarded,
        exhausted: result.exhausted,
        timedOut: Boolean(result.timedOut),
        outLength: finalText.length,
        totalMs: Date.now() - startedAt,
        timings,
      });
    } catch (error) {
      clearTimeout(slowTimer);
      clearInterval(keepAliveTimer);
      await log.error("处理提问失败", { sessionKey, message: String(/** @type {any} */ (error)?.stack ?? error) });
      try {
        await client.replyStream(frame, streamId, config.surface.errorText, true);
      } catch {
        // 已经尽力
      }
    }
  }

  process.on("SIGTERM", () => {
    log.info("收到 SIGTERM，断开连接");
    client.disconnect();
    releaseLock({ lockPath }).finally(() => process.exit(0));
  });

  client.connect();
  await log.info("机器人启动", { botId: config.wecom.botId.slice(0, 8) });
}

main().catch((error) => {
  process.stderr.write(`启动失败: ${error?.stack ?? error}\n`);
  process.exit(1);
});

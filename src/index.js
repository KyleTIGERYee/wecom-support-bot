import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import AiBot from "@wecom/aibot-node-sdk";

import { loadConfig } from "./config.js";
import { acquireLock, releaseLock } from "./lock.js";
import { createLogger } from "./log.js";
import { createSessionState } from "./session-state.js";
import { createInbox } from "./inbox.js";
import { createSessionQueue } from "./session-queue.js";
import { createGuardClient, createQuickClient } from "./model-client.js";
import { runAgentTurn, killAllChildren } from "./agent.js";
import { reviewReply } from "./guard.js";
import { classifyQuestion } from "./route.js";
import { handleTurn } from "./orchestrate.js";
import { createDefaultResourceCatalog, createLocalResourceCatalog } from "./resource-catalog.js";
import { runTurnLifecycle } from "./turn-lifecycle.js";
import { deliverFinal } from "./deliver.js";
import { normalizeMessage, toSessionKey, stripMention, isNewSessionRequest } from "./wecom.js";
import { downloadImages } from "./images.js";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 一条待处理的提问。收件箱记录与排队的任务共用这个形状。
 *
 * @typedef {{
 *   question: string,
 *   userKey: string,
 *   msgid: string,
 *   userId: string,
 *   chatId: string,
 *   frame?: any,
 *   recoveryPrefix?: string
 * }} TurnJob
 */

async function main() {
  const config = await loadConfig(projectDir);
  const runtimeDir = config.localInstance?.instanceDir ?? projectDir;
  const resourceContext = config.localInstance
    ? await createLocalResourceCatalog(
        config.localInstance.instanceDir,
        config.localInstance.saved.contextSources,
        config.localInstance.saved.resources?.syncedAt ?? config.localInstance.saved.initializedAt ?? null,
      )
    : createDefaultResourceCatalog(config.namedRoots, projectDir);
  const log = createLogger({ logPath: join(runtimeDir, "logs/bot.log") });

  // 企微同一个机器人只能有一条长连接，两份进程会互相踢线，所以先拿锁
  const lockPath = join(runtimeDir, `data/${config.wecom.botId.slice(0, 8)}.lock`);
  const lock = await acquireLock({ lockPath });
  if (!lock.acquired) {
    process.stderr.write(`已有实例在运行（pid ${lock.holder}），拒绝启动。\n`);
    process.exit(2);
  }

  const state = createSessionState({
    storePath: join(runtimeDir, "data/session-state.json"),
    rotation: config.rotation,
  });
  await state.load();

  const inbox = createInbox({ storePath: join(runtimeDir, "data/inbox.jsonl") });
  await inbox.load();
  await inbox.compact(Date.now(), config.inbox.retentionMs);

  const callModel = await createGuardClient({ config, agentDir: config.pi.agentDir });
  const callQuickModel = config.localInstance ? await createQuickClient({ config, agentDir: config.pi.agentDir }) : callModel;
  const queue = createSessionQueue({ maxConcurrent: config.queue.maxConcurrent });

  /** @type {Set<Promise<void>>} 在途轮次，优雅退出时等它们答完 */
  const inFlight = new Set();
  /** @type {Map<string, number>} 每个同事还没答完的问题数，用来决定占位文案 */
  const pendingByUser = new Map();
  let shuttingDown = false;

  const client = new AiBot.WSClient({
    botId: config.wecom.botId,
    secret: config.wecom.secret,
    reconnectInterval: 1000,
    maxReconnectAttempts: -1,
  });

  let recoveryStarted = false;
  client.on("authenticated", () => {
    void log.info("企微长连接已就绪");
    if (recoveryStarted) return;
    recoveryStarted = true;
    void runRecovery();
  });
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
            "我是赛博阿虎。我拥有安居乐寓和乐租租几乎所有的知识库，你可以找我排查问题，查询数据，了解功能等等。也可以直接发截图给我，我能看图。有什么事情不要找阿虎，请找我。",
        },
      })
      .catch((error) => log.warn("欢迎语发送失败", { message: String(error?.message ?? error) }));
  });

  /** @type {Map<string, Promise<void>>} 同一同事的消息按到达顺序处理：图片下载是异步的，不能被后来的文本插队 */
  const ingestChains = new Map();

  /**
   * 立刻回一条短文本（新会话确认、图片失败提示）。
   * 群聊里 reply 的 text 类型会被企微拒收（40008），走流式通道。
   *
   * @param {any} frame
   * @param {string} text
   * @param {string} warnLabel
   */
  function replyImmediate(frame, text, warnLabel) {
    const streamId = AiBot.generateReqId("stream");
    client
      .replyStream(frame, streamId, text, false)
      .then(() => client.replyStream(frame, streamId, text, true))
      .catch((error) => log.warn(warnLabel, { message: String(error?.message ?? error) }));
  }

  client.on("message", (frame) => {
    const message = normalizeMessage(frame);
    if (!message) return;
    const userKey = toSessionKey(message.userId);
    const prev = ingestChains.get(userKey) ?? Promise.resolve();
    const next = prev
      .then(() => handleIncomingMessage(frame, message, userKey))
      .catch((error) => log.error("消息处理异常", { message: String(error?.message ?? error) }));
    ingestChains.set(userKey, next);
    void next.finally(() => {
      if (ingestChains.get(userKey) === next) ingestChains.delete(userKey);
    });
  });

  /**
   * 收一条企微消息：指令识别 → 图片下载 → 落收件箱 → 排队执行。
   * 图片 URL 只有五分钟有效期，必须在入队前下载，所以整个处理是异步的；
   * 同一同事的消息由 ingestChains 保证按到达顺序走完这段。
   *
   * @param {any} frame
   * @param {NonNullable<ReturnType<typeof normalizeMessage>>} message
   * @param {string} userKey
   */
  async function handleIncomingMessage(frame, message, userKey) {
    const question = stripMention(message.text);
    if (!question && message.images.length === 0) return;

    // 开新会话：抬一代代号，上一轮的上下文和粘性标记一并作废
    if (isNewSessionRequest(question)) {
      const sessionId = state.startNewSession(userKey);
      void state.flush();
      void log.info("开新会话", { user: message.userId, sessionId });
      replyImmediate(frame, "好，之前的聊的我先忘了，咱们重新开始。", "新会话确认发送失败");
      return;
    }

    const msgid = message.msgid ?? fallbackMsgid();

    // 图片立刻下载解密存盘（URL 五分钟过期），路径拼进提问，让 agent 用 read 工具看图
    let finalQuestion = question;
    if (message.images.length > 0) {
      try {
        const imagePaths = await downloadImages({
          client,
          images: message.images,
          dir: join(runtimeDir, "data/images"),
          msgid,
        });
        finalQuestion = withImageInstructions(question, imagePaths);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        void log.warn("图片下载失败", { msgid, message: reason });
        replyImmediate(frame, "图片我这边没收到，麻烦再发一次。", "图片失败提示发送失败");
        return;
      }
    }

    // 问题先落到收件箱，再考虑执行：企微重推靠 msgid 去重，进程重启靠它补跑
    const { isNew } = inbox.accept({
      msgid,
      userId: message.userId,
      chatId: message.chatId,
      chatType: message.chatType,
      question: finalQuestion,
      receivedAt: new Date().toISOString(),
    });
    if (!isNew) {
      void log.info("重复消息，忽略", { msgid, user: message.userId });
      return;
    }
    void inbox.flush();

    if (shuttingDown) {
      void log.warn("正在退出，该问题留待重启后补跑", { msgid });
      return;
    }

    void log.info("收到提问", { msgid, user: message.userId, chatType: message.chatType, length: finalQuestion.length, images: message.images.length });
    void enqueueTurn({ question: finalQuestion, userKey, msgid, userId: message.userId, chatId: message.chatId, frame });
  }

  /**
   * 占位 + 排队 + 执行。同一个同事的连发按顺序跑，不同人并行。
   *
   * @param {TurnJob} turn
   */
  function enqueueTurn(turn) {
    const streamId = AiBot.generateReqId("stream");
    const sessionKey = state.resolveSessionId(turn.userKey, Date.now());

    const queued = (pendingByUser.get(turn.userKey) ?? 0) > 0;
    const placeholder = turn.frame
      ? client
          .replyStream(turn.frame, streamId, queued ? config.surface.queuedProgressText : config.surface.progressText, false)
          .catch((error) => log.warn("占位消息发送失败", { message: String(error?.message ?? error) }))
      : Promise.resolve();

    pendingByUser.set(turn.userKey, (pendingByUser.get(turn.userKey) ?? 0) + 1);
    const task = placeholder.then(async () => {
      await queue.run(turn.userKey, () => runTurn({ ...turn, sessionKey, streamId }));
    });
    inFlight.add(task);
    const done = task.finally(() => {
      inFlight.delete(task);
      const left = (pendingByUser.get(turn.userKey) ?? 1) - 1;
      if (left <= 0) pendingByUser.delete(turn.userKey);
      else pendingByUser.set(turn.userKey, left);
    });
    return done;
  }

  /**
   * 执行一轮完整问答：分级 → 跑 agent → guard 校验 → 投递 → 记状态。
   *
   * @param {TurnJob & {sessionKey: string, streamId: string}} turn
   */
  async function runTurn({ question, userKey, sessionKey, msgid, userId, chatId, streamId, frame, recoveryPrefix = "" }) {
    const startedAt = Date.now();
    /** @type {Array<{step: string, ms: number}>} */
    const timings = [];
    // 记一段耗时：从 from 到此刻，归到 step 名下
    const lap = (/** @type {string} */ step, /** @type {number} */ from) => {
      timings.push({ step, ms: Date.now() - from });
    };

    inbox.markRunning(msgid);
    let lastInputTokens = 0;

    // 先分诊：闲聊与概念题没必要最高思考强度（试运行里连「你好」都要 9–52 秒）
    let route = "deep";
    if (config.routing.enabled) {
      const t = Date.now();
      route = await classifyQuestion({ question, callModel: callQuickModel });
      lap("route", t);
    }
    const thinkingLevel = config.pi.thinkingLevels[route];
    const turnConfig = route === "quick" && config.quick
      ? { ...config, pi: { ...config.pi, provider: "local-instance-quick", model: config.quick.model } }
      : config;

    const execute = async () => {
      const t = Date.now();
      const result = await handleTurn({
        question,
        sessionKey,
        deps: {
          state,
          context: { catalog: resourceContext.text, dataPlaybook: resourceContext.dataPlaybook, entries: resourceContext.entries, skills: resourceContext.skills, workspaceDir: config.localInstance ? join(config.localInstance.instanceDir, "workspace") : undefined, trustedDataScripts: config.trustedDataScripts },
          runAgent: async ({ prompt, sessionId, currentSkill }) => {
            const agentStartedAt = Date.now();
            const agentTurn = await runAgentTurn({
              prompt,
              sessionId,
              currentSkill,
              config: turnConfig,
              projectDir,
              resourceCatalog: resourceContext.entries,
              idleTimeoutMs: config.pi.idleTimeoutMs,
              hardTimeoutMs: config.pi.timeoutMs,
              thinkingLevel,
            });
            lastInputTokens = agentTurn.inputTokens || lastInputTokens;
            lap("agent", agentStartedAt);
            return agentTurn;
          },
          review: async ({ answer }) => {
            const guardStartedAt = Date.now();
            const verdict = await reviewReply({ answer, callModel });
            lap("guard", guardStartedAt);
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
      lap("turn", t);
      return result;
    };

    /** @type {Awaited<ReturnType<typeof runTurnLifecycle>>} */
    let outcome;
    try {
      outcome = await runTurnLifecycle({
        execute,
        surface: {
          progress: async (text) => {
            if (!frame) return;
            await client.replyStream(frame, streamId, text, false);
          },
          handoff: async (text) => {
            if (!frame) return;
            await client.replyStream(frame, streamId, text, true);
          },
        },
        messages: { slowText: config.surface.slowProgressText, handoffText: config.surface.handoffText },
        slowAfterMs: config.surface.slowProgressAfterMs,
        // 补跑没有流式通道可收尾，全程后台跑完再推送
        handoffAfterMs: frame ? config.pi.handoffTimeoutMs : Number.POSITIVE_INFINITY,
      });
    } catch (error) {
      await log.error("处理提问失败", {
        msgid,
        sessionKey,
        message: String(/** @type {any} */ (error)?.stack ?? error),
      });
      inbox.markFailed(msgid);
      await sendAnswer({ text: config.surface.errorText, frame, streamId, userId, chatId, recoveryPrefix });
      state.recordActivity(userKey, { at: Date.now(), inputTokens: lastInputTokens });
      await state.flush();
      return;
    }

    const text = outcome.text || config.surface.errorText;
    const delivery = await sendAnswer({
      // 转后台后流式消息已收尾，只能主动推送
      text,
      frame: outcome.mode === "inline" ? frame : undefined,
      streamId,
      userId,
      chatId,
      recoveryPrefix,
      question,
    });

    if (delivery.channel === "none") inbox.markFailed(msgid);
    else inbox.markAnswered(msgid);
    await inbox.flush();

    state.recordActivity(userKey, { at: Date.now(), inputTokens: lastInputTokens });
    await state.flush();

    await log.info("答复完成", {
      msgid,
      sessionKey,
      route,
      thinkingLevel,
      mode: outcome.mode,
      channel: delivery.channel,
      sendFailure: delivery.reason,
      rounds: outcome.result.rounds,
      guarded: outcome.result.guarded,
      exhausted: outcome.result.exhausted,
      timedOut: Boolean(outcome.result.timedOut),
      stalled: Boolean(outcome.result.stalled),
      stallRetries: outcome.result.stallRetries ?? 0,
      loadDepth: outcome.result.loadDepth,
      loadedResources: outcome.result.loadedResources,
      loadedSkills: outcome.result.loadedSkills,
      executionApprovals: outcome.result.executionApprovals,
      inputTokens: lastInputTokens,
      outLength: text.length,
      totalMs: Date.now() - startedAt,
      timings,
    });
  }

  /**
   * 投递最终答复：能收尾流式消息就收尾，否则主动推送（群聊带问题摘要，认得出是哪条）。
   *
   * @param {{text: string, frame?: any, streamId: string, userId: string, chatId: string, recoveryPrefix: string, question?: string}} options
   */
  function sendAnswer({ text, frame, streamId, userId, chatId, recoveryPrefix, question = "" }) {
    // 群聊发到群，单聊发到人的 userid —— 企微的主动推送接口两种都收在同一个参数里
    const target = chatId || userId;
    return deliverFinal({
      text,
      stream: async () => {
        if (!frame) throw new Error("无流式通道");
        await client.replyStream(frame, streamId, text, true);
      },
      push: async (/** @type {string} */ body) => {
        // 群里人多，推送要带一句「关于哪条」；单聊只有对话双方，不用加
        const context = recoveryPrefix || (chatId && question ? `关于「${question.slice(0, 20)}」：` : "");
        await client.sendMessage(target, { msgtype: "markdown", markdown: { content: `${context}${body}` } });
      },
    });
  }

  /**
   * 启动补跑：上次没答完的问题重跑一遍，用主动推送送达。
   *
   * 必须等长连接认证之后才能跑 —— 主动推送走的是同一条通道。
   */
  async function runRecovery() {
    const now = Date.now();
    const pending = inbox.recoverable(now, config.inbox.recoveryWindowMs);
    const overdue = inbox.stale(now, config.inbox.recoveryWindowMs);
    if (overdue.length > 0) {
      // 隔太久不补：突然冒出一条旧答案比不答更让人困惑
      await log.info("超窗未答问题不补跑", { count: overdue.length, msgids: overdue.map((entry) => entry.msgid) });
    }
    if (pending.length === 0) return;
    await log.info("启动补跑", { count: pending.length });
    await Promise.all(
      pending.map((entry) =>
        enqueueTurn({
          question: entry.question,
          userKey: toSessionKey(entry.userId),
          msgid: entry.msgid,
          userId: entry.userId,
          chatId: entry.chatId ?? "",
          recoveryPrefix: "刚才那条我补上：",
        }),
      ),
    );
  }

  /**
   * 优雅退出：不再接新活（新问题仍落收件箱），等在途轮次答完再断开。
   *
   * 直接退出的代价是：正在跑的问题被丢在半路，同事只看到「正在查」永不更新。
   * 等不下去了（超过 30 秒）也照常退出，收件箱会把它交给下次启动补跑。
   *
   * @param {string} signal
   */
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    void log.info(`收到 ${signal}，停止接新活`, { inFlight: inFlight.size });

    const drain = new Promise((resolve) => {
      const check = setInterval(() => {
        if (inFlight.size === 0) settle();
      }, 500);
      const force = setTimeout(settle, 30000);

      function settle() {
        clearInterval(check);
        clearTimeout(force);
        resolve(undefined);
      }
    });

    drain
      .then(async () => {
        await inbox.flush();
        killAllChildren();
        client.disconnect();
        await releaseLock({ lockPath });
        process.exit(0);
      })
      .catch(() => process.exit(0));
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    // 一次发送失败不该把整个机器人带走
    log.error("未处理的 Promise 拒绝", { reason: String(reason) });
  });

  client.connect();
  await log.info("机器人启动", { botId: config.wecom.botId.slice(0, 8) });
}

/**
 * 企微偶尔不给 msgid。这时宁可不去重，也不能把两条内容相同的提问当成重复吞掉：
 * 用时刻 + 随机后缀造一个唯一标识。
 */
function fallbackMsgid() {
  return `anon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把图片路径拼进提问正文：agent 用 read 工具看图，后续分诊、收件箱、补跑都与纯文本提问一致。
 *
 * @param {string} question
 * @param {string[]} imagePaths
 * @returns {string}
 */
function withImageInstructions(question, imagePaths) {
  const base = question || "（同事只发了图片，没有附文字）";
  const lines = imagePaths.map((path) => `- ${path}`).join("\n");
  return `${base}\n\n[系统补充] 同事随消息附了 ${imagePaths.length} 张图片，已保存到本地：\n${lines}\n请先用 read 工具逐张查看图片内容，再结合图片回答。`;
}

main().catch((error) => {
  process.stderr.write(`启动失败: ${error?.stack ?? error}\n`);
  process.exit(1);
});

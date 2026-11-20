import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDashboard } from "../dashboard/index.js";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "wsb-dashboard-"));
  const instanceDir = join(root, "instance");
  const piDir = join(instanceDir, "sessions");
  await mkdir(piDir, { recursive: true });
  await mkdir(join(instanceDir, "images"), { recursive: true });
  const sources = {
    instances: [{
      id: "main",
      inboxPath: join(instanceDir, "inbox.jsonl"),
      logPath: join(instanceDir, "bot.log"),
      piDir,
      imagesDir: join(instanceDir, "images"),
    }],
    rawLogPath: join(root, "launchd.stdout.log"),
    userMapPath: join(root, "user-map.json"),
  };
  await writeFile(sources.userMapPath, JSON.stringify({ u1: { name: "测试同事", b64: "dQ" } }));
  await writeFile(sources.rawLogPath, "");
  return { root, sources, instanceDir, piDir };
}

function inboxMessage({ msgid, userId, question, receivedAt, chatType = "single" }) {
  return { msgid, userId, chatId: chatType === "group" ? "room-1" : "", chatType, question, receivedAt, state: "received" };
}

function completion({ msgid, sessionKey, at, totalMs = 1000, channel = "stream", ...rest }) {
  return { msgid, sessionKey, route: "deep", thinkingLevel: "max", mode: "inline", channel, rounds: 1, guarded: false, exhausted: false, timedOut: false, stalled: false, stallRetries: 0, totalMs, ...rest };
}

function logLine(at, event, detail) {
  return `[${at}] INFO ${event} ${JSON.stringify(detail)}\n`;
}

test("按本地日期汇总提问、人员与 user+gN 会话，并默认最近有数据的日期", async () => {
  const { sources } = await createFixture();
  const first = inboxMessage({ msgid: "m1", userId: "u1", question: "第一个合成问题", receivedAt: "2026-11-12T01:00:00.000Z" });
  const second = inboxMessage({ msgid: "m2", userId: "u2", question: "第二个合成问题", receivedAt: "2026-11-13T02:00:00.000Z", chatType: "group" });
  await writeFile(sources.instances[0].inboxPath, [
    JSON.stringify(first),
    JSON.stringify({ msgid: "m1", state: "answered", at: "2026-11-12T01:01:00.000Z" }),
    JSON.stringify(second),
    JSON.stringify({ msgid: "m2", state: "answered", at: "2026-11-13T02:02:00.000Z" }),
    "不是 JSON",
  ].join("\n"));
  await writeFile(sources.instances[0].logPath,
    logLine("2026-11-12T00:59:59.000Z", "收到 2 个问题", { count: 2 }) +
    logLine("2026-11-12T01:01:00.000Z", "答复完成", completion({ msgid: "m1", sessionKey: "wx-synthetic-first-g1", at: "2026-11-12T01:01:00.000Z", totalMs: 60000 })) +
    logLine("2026-11-13T02:02:00.000Z", "答复完成", completion({ msgid: "m2", sessionKey: "wx-synthetic-second-g2", at: "2026-11-13T02:02:00.000Z", totalMs: 120000, channel: "push" })),
  );

  const dashboard = await buildDashboard({ sources });
  assert.equal(dashboard.getMeta().defaultDate, "2026-11-13");
  assert.deepEqual(dashboard.getMeta().dates, ["2026-11-12", "2026-11-13"]);
  assert.equal(dashboard.getMeta().diagnostics.badLines, 1);

  const day = dashboard.getDay({ date: "2026-11-12" });
  assert.deepEqual(day.summary, { questions: 1, activeColleagues: 1, sessions: 1, succeeded: 1, failed: 0, averageMs: 60000 });
  assert.equal(day.colleagues[0].name, "测试同事");
  assert.equal(day.colleagues[0].questions, 1);
  assert.equal(day.sessions[0].id, "wx-synthetic-first-g1");
  assert.equal(day.sessions[0].generation, 1);
  assert.equal(day.turns[0].question, "第一个合成问题");
  assert.equal(day.turns[0].colleagueId, "u1");
  assert.equal(day.turns[0].colleagueName, "测试同事");
  assert.equal("userId" in day.turns[0], false);

  const nextDay = dashboard.getDay({ date: "2026-11-13" });
  assert.equal(nextDay.turns[0].chatType, "group");
  assert.equal(nextDay.colleagues[0].name, "未识别用户 u2");

  assert.equal(dashboard.getDay({ date: "2026-11-12", query: "测试同事" }).summary.questions, 1);
  assert.equal(dashboard.getDay({ date: "2026-11-13", query: "不存在的消息" }).summary.questions, 0);
  assert.equal(dashboard.getDay({ date: "2026-11-13", query: "第二个合成" }).summary.questions, 1);
  assert.equal(dashboard.getDay({ date: "2026-11-12", sessionKey: "wx-synthetic-other-g1" }).summary.questions, 0);
});

test("历史轮次从 launchd 恢复白名单入站字段，重复日志不重复计数", async () => {
  const { sources } = await createFixture();
  await writeFile(sources.instances[0].inboxPath, "");
  const done = completion({ msgid: "old-1", sessionKey: "wx-synthetic-history-g1", totalMs: 8000 });
  await writeFile(sources.instances[0].logPath, logLine("2026-11-10T01:00:08.000Z", "答复完成", done));
  const frame = {
    msgid: "old-1",
    msgtype: "text",
    chattype: "group",
    chatid: "synthetic-room",
    from: { userid: "u1" },
    text: { content: "@机器人 原始问题 <b>按文本显示</b> TOKEN=fake-token-value" },
    response_url: "https://invalid.example/should-not-be-returned",
    ignored: "不得进入索引",
  };
  const inbound = `[2026-11-10T01:00:00.000Z] [AiBotSDK] [DEBUG] [server -> plugin] cmd=aibot_msg_callback, reqId=fake, body=${JSON.stringify(frame)}\n`;
  await writeFile(sources.rawLogPath, inbound + logLine("2026-11-10T01:00:08.000Z", "答复完成", done));

  const dashboard = await buildDashboard({ sources });
  const day = dashboard.getDay({ date: "2026-11-10" });
  assert.equal(day.summary.questions, 1);
  assert.equal(day.turns[0].question, "原始问题 <b>按文本显示</b> TOKEN=[已隐藏]");
  assert.equal(day.turns[0].chatType, "group");
  assert.equal(day.turns[0].sessionKey, "wx-synthetic-history-g1");
  assert.equal("response_url" in day.turns[0], false);
  assert.equal("rawLine" in day.turns[0], false);
});

function piEntry(at, message) {
  return { type: "message", id: `event-${at}`, parentId: null, timestamp: at, message: { timestamp: Date.parse(at), ...message } };
}

function textContent(text) {
  return [{ type: "text", text }];
}

test("按完成日志时间顺序关联单轮 pi 时间线，配对工具并区分模型答复与投递", async () => {
  const { sources, piDir } = await createFixture();
  const sessionKey = "wx-synthetic-shared-g1";
  const messages = [
    inboxMessage({ msgid: "turn-1", userId: "u1", question: "第一轮合成问题", receivedAt: "2026-11-12T00:00:00.000Z" }),
    inboxMessage({ msgid: "turn-2", userId: "u1", question: "第二轮合成问题", receivedAt: "2026-11-12T00:02:00.000Z" }),
  ];
  await writeFile(sources.instances[0].inboxPath, messages.map((message) => JSON.stringify(message)).join("\n"));
  await writeFile(sources.instances[0].logPath,
    logLine("2026-11-12T00:01:00.000Z", "答复完成", completion({ msgid: "turn-1", sessionKey, totalMs: 60000, rounds: 2, guarded: true })) +
    logLine("2026-11-12T00:03:00.000Z", "答复完成", completion({ msgid: "turn-2", sessionKey, totalMs: 60000, channel: "push" })),
  );
  const entries = [
    { type: "session", version: 1, id: sessionKey, timestamp: "2026-11-11T23:59:59.000Z", cwd: "/fixture" },
    piEntry("2026-11-12T00:00:01.000Z", { role: "user", content: textContent("第一轮合成问题\n\n[渐进式资源目录]\n合成目录") }),
    piEntry("2026-11-12T00:00:02.000Z", { role: "assistant", stopReason: "toolUse", content: [
      { type: "thinking", thinking: "合成思考内容", thinkingSignature: "敏感签名不得输出" },
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "/fixture/SKILL.md", offset: 2, limit: 3 } },
    ] }),
    piEntry("2026-11-12T00:00:03.000Z", { role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false, content: textContent("合成 SKILL 正文"), details: { truncation: { truncated: true, totalLines: 20 } } }),
    piEntry("2026-11-12T00:00:04.000Z", { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "TOKEN=synthetic-secret printf synthetic" } }] }),
    piEntry("2026-11-12T00:00:05.000Z", { role: "toolResult", toolCallId: "bash-1", toolName: "bash", isError: true, content: textContent("合成命令失败") }),
    piEntry("2026-11-12T00:00:06.000Z", { role: "assistant", stopReason: "stop", content: textContent("第一版模型答复") }),
    piEntry("2026-11-12T00:00:20.000Z", { role: "user", content: textContent("原始问题：第一轮合成问题\n不要读取无关资料；资源仍不足时明确说缺少哪部分。完成后给出完整答复。") }),
    piEntry("2026-11-12T00:00:21.000Z", { role: "user", content: textContent("原始问题：第一轮合成问题\n不要读取无关资料。资源仍不足时明确说缺少哪部分。完成后给出完整答复。") }),
    piEntry("2026-11-12T00:00:30.000Z", { role: "user", content: textContent("你上一条答复未通过隐私检查。\n原因：合成理由\n请重新组织答复") }),
    piEntry("2026-11-12T00:00:40.000Z", { role: "assistant", stopReason: "stop", content: textContent("最终模型答复 <img src=x>") }),
    piEntry("2026-11-12T00:02:01.000Z", { role: "user", content: textContent("第二轮合成问题\n\n[渐进式资源目录]\n合成目录") }),
    piEntry("2026-11-12T00:02:02.000Z", { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "read-missing", name: "read", arguments: { path: "/fixture/missing.md" } }] }),
    piEntry("2026-11-12T00:02:10.000Z", { role: "assistant", stopReason: "stop", content: textContent("CONTEXT_INSUFFICIENT：合成缺口\n第二轮最终答复") }),
  ];
  await writeFile(join(piDir, `2026-11-12T00-00-01-000Z_${sessionKey}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n"));

  const dashboard = await buildDashboard({ sources });
  const first = dashboard.getTurn("turn-1");
  assert.equal(first.answer.text, "最终模型答复 <img src=x>");
  assert.equal(first.answer.source, "pi-final-model-text");
  assert.deepEqual(first.delivery, { channel: "stream", status: "delivered", bodyArchived: false });
  assert.equal(first.timeline.filter((event) => event.type === "modelText").length, 2);
  assert.ok(first.timeline.some((event) => event.type === "guardRework"));
  assert.equal(first.timeline.filter((event) => event.type === "progressiveDepth").length, 2);
  const thinking = first.timeline.find((event) => event.type === "thinking");
  assert.equal(thinking.text, "合成思考内容");
  assert.equal("thinkingSignature" in thinking, false);
  assert.equal(JSON.stringify(first).includes("敏感签名不得输出"), false);
  const read = first.timeline.find((event) => event.type === "toolCall" && event.id === "read-1");
  assert.equal(read.arguments.path, "/fixture/SKILL.md");
  assert.equal(read.result.text, "合成 SKILL 正文");
  assert.equal(read.result.truncated, true);
  assert.equal(read.isSkillRead, true);
  const bash = first.timeline.find((event) => event.type === "toolCall" && event.id === "bash-1");
  assert.equal(bash.result.isError, true);
  assert.equal(bash.arguments.command.text.includes("synthetic-secret"), false);
  assert.equal(first.counts.skillReads, 1);
  assert.equal(first.counts.thinking, 1);

  const second = dashboard.getTurn("turn-2");
  assert.equal(second.answer.text, "第二轮最终答复");
  assert.equal(second.timeline.some((event) => event.id === "read-1"), false);
  assert.equal(second.timeline.find((event) => event.id === "read-missing").result, null);
  assert.equal(second.timeline.find((event) => event.id === "read-missing").missingResult, true);
  assert.equal(second.counts.skillReads, 0);
  assert.equal(dashboard.getMeta().diagnostics.mappedTurns, 2);
  assert.equal(dashboard.getMeta().diagnostics.unmatchedTurns, 0);
  assert.equal(dashboard.getDay({ date: "2026-11-12", query: "最终模型答复" }).turns[0].id, "turn-1");
  assert.equal(dashboard.getTurn("not-found"), null);
});

test("入站图片只按已索引 msgid 和序号开放，软链与任意路径不开放", async () => {
  const { sources, root } = await createFixture();
  const msgid = "image-turn-1";
  await writeFile(sources.instances[0].inboxPath, JSON.stringify(inboxMessage({ msgid, userId: "u1", question: "看图\n\n[系统补充] 本地图片", receivedAt: "2026-11-12T01:00:00.000Z" })));
  await writeFile(sources.instances[0].logPath, logLine("2026-11-12T01:00:01.000Z", "答复完成", completion({ msgid, sessionKey: "wx-synthetic-image-g1" })));
  await writeFile(join(sources.instances[0].imagesDir, `${msgid}-1.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, "not-an-image.txt"), "合成非图片内容");
  await symlink(join(root, "not-an-image.txt"), join(sources.instances[0].imagesDir, `${msgid}-2.png`));

  const dashboard = await buildDashboard({ sources });
  const detail = dashboard.getTurn(msgid);
  assert.deepEqual(detail.images, [{ index: 1, mimeType: "image/png" }]);
  assert.equal(detail.question, "看图");
  const image = dashboard.getImage(msgid, 1);
  assert.equal(image.path, join(sources.instances[0].imagesDir, `${msgid}-1.png`));
  assert.equal(image.mimeType, "image/png");
  assert.equal(dashboard.getImage(msgid, 2), null);
  assert.equal(dashboard.getImage("../image-turn-1", 1), null);
  assert.equal(dashboard.getImage(msgid, "../1"), null);
});

test("投递失败与未完成提问有清楚状态，不计为成功", async () => {
  const { sources } = await createFixture();
  const failed = inboxMessage({ msgid: "failed-turn", userId: "u1", question: "合成失败轮", receivedAt: "2026-11-12T01:00:00.000Z" });
  const pending = inboxMessage({ msgid: "pending-turn", userId: "u1", question: "合成处理中轮", receivedAt: "2026-11-12T01:01:00.000Z" });
  await writeFile(sources.instances[0].inboxPath, [
    JSON.stringify(failed), JSON.stringify({ msgid: failed.msgid, state: "failed" }),
    JSON.stringify(pending), JSON.stringify({ msgid: pending.msgid, state: "running" }),
  ].join("\n"));
  await writeFile(sources.instances[0].logPath, logLine("2026-11-12T01:00:02.000Z", "答复完成", completion({ msgid: failed.msgid, sessionKey: "{{SECRET_hbawxbg3}}", channel: "none" })));

  const dashboard = await buildDashboard({ sources });
  const day = dashboard.getDay({ date: "2026-11-12" });
  assert.equal(day.summary.questions, 2);
  assert.equal(day.summary.succeeded, 0);
  assert.equal(day.summary.failed, 1);
  assert.equal(dashboard.getTurn(failed.msgid).delivery.status, "failed");
  assert.equal(dashboard.getTurn(pending.msgid).delivery.status, "pending");
  assert.equal(dashboard.getTurn(pending.msgid).answer.source, "unavailable");
  assert.deepEqual(dashboard.getTurn(pending.msgid).counts, { thinking: 0, skillReads: 0, documentReads: 0, toolCalls: 0, failedTools: 0 });
});

test("超长问题与模型答复有大小上限和明确截断标记", async () => {
  const { sources, piDir } = await createFixture();
  const sessionKey = "wx-long-turn";
  await writeFile(sources.instances[0].inboxPath, JSON.stringify(inboxMessage({ msgid: "long-turn", userId: "u1", question: "问".repeat(21000), receivedAt: "2026-11-12T01:00:00.000Z" })));
  await writeFile(sources.instances[0].logPath, logLine("2026-11-12T01:00:02.000Z", "答复完成", completion({ msgid: "long-turn", sessionKey })));
  await writeFile(join(piDir, `2026-11-12T01-00-00-000Z_${sessionKey}.jsonl`), [
    JSON.stringify({ type: "session", id: sessionKey, timestamp: "2026-11-12T01:00:00.000Z" }),
    JSON.stringify(piEntry("2026-11-12T01:00:00.100Z", { role: "user", content: textContent("问".repeat(21000)) })),
    JSON.stringify(piEntry("2026-11-12T01:00:01.000Z", { role: "assistant", stopReason: "length", content: textContent("答".repeat(41000)) })),
  ].join("\n"));

  const dashboard = await buildDashboard({ sources });
  const detail = dashboard.getTurn("long-turn");
  assert.equal(detail.questionTruncated, true);
  assert.ok(detail.question.length < 21000);
  assert.equal(detail.answer.truncated, true, JSON.stringify({ source: detail.answer.source, length: detail.answer.text.length, diagnostics: dashboard.getMeta().diagnostics }));
  assert.ok(detail.answer.text.length < 41000);
  assert.ok(detail.timeline.some((event) => event.type === "modelStop" && event.reason === "length"));
});

test("人员映射支持 user-map 的 base64url b64，并保留未知用户兜底", async () => {
  const { sources } = await createFixture();
  const userId = "encoded-user";
  const b64 = Buffer.from(userId, "utf8").toString("base64url");
  const sessionKey = `wx-${b64}-g1`;
  await writeFile(sources.userMapPath, JSON.stringify({ "mapping-key-not-userid": { name: "编码映射同事", b64 }, broken: { name: "错误映射", b64: 42 } }));
  await writeFile(sources.instances[0].inboxPath, JSON.stringify(inboxMessage({ msgid: "encoded-turn", userId, question: "合成映射问题", receivedAt: "2026-11-12T01:00:00.000Z" })));
  await writeFile(sources.instances[0].logPath, logLine("2026-11-12T01:00:01.000Z", "答复完成", completion({ msgid: "encoded-turn", sessionKey })));

  const dashboard = await buildDashboard({ sources });
  assert.equal(dashboard.getDay({ date: "2026-11-12" }).colleagues[0].name, "编码映射同事");
});

test("紧邻轮次以精确问题锚点分界，次轮 user 不落入前轮宽限窗", async () => {
  const { sources, piDir } = await createFixture();
  const sessionKey = ["wx", "synthetic-close", "g1"].join("-");
  const first = inboxMessage({ msgid: "close-1", userId: "u1", question: "第一轮紧邻合成问题", receivedAt: "2026-11-12T00:00:00.000Z" });
  const second = inboxMessage({ msgid: "close-2", userId: "u1", question: "第二轮紧邻合成问题", receivedAt: "2026-11-12T00:01:00.700Z" });
  await writeFile(sources.instances[0].inboxPath, [first, second].map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(sources.instances[0].logPath,
    logLine("2026-11-12T00:01:00.500Z", "答复完成", completion({ msgid: first.msgid, sessionKey })) +
    logLine("2026-11-12T00:02:00.000Z", "答复完成", completion({ msgid: second.msgid, sessionKey })),
  );
  await writeFile(join(piDir, `2026-11-12T00-00-00-000Z_${sessionKey}.jsonl`), [
    JSON.stringify({ type: "session", id: sessionKey, timestamp: "2026-11-11T23:59:59.000Z" }),
    JSON.stringify(piEntry("2026-11-12T00:00:00.100Z", { role: "user", content: textContent(`${first.question}\n\n[渐进式资源目录]\n合成目录`) })),
    JSON.stringify(piEntry("2026-11-12T00:01:00.400Z", { role: "assistant", stopReason: "stop", content: textContent("第一轮独立答复") })),
    JSON.stringify(piEntry("2026-11-12T00:01:00.800Z", { role: "user", content: textContent(`${second.question}\n\n[渐进式资源目录]\n合成目录`) })),
    JSON.stringify(piEntry("2026-11-12T00:01:01.000Z", { role: "assistant", stopReason: "stop", content: textContent("第二轮独立答复") })),
  ].join("\n"));

  const dashboard = await buildDashboard({ sources });
  assert.equal(dashboard.getTurn(first.msgid).answer.text, "第一轮独立答复", JSON.stringify(dashboard.getMeta().diagnostics));
  assert.equal(dashboard.getTurn(second.msgid).answer.text, "第二轮独立答复");
  assert.equal(dashboard.getTurn(first.msgid).timeline.filter((event) => event.type === "modelText").length, 1);
  assert.equal(dashboard.getMeta().diagnostics.unmatchedTurns, 0);
});

test("缺完成日志的中间轮仍占用串行锚点，下一轮不能吞入其事件", async () => {
  const { sources, piDir } = await createFixture();
  const sessionKey = ["wx", "synthetic-gap", "g1"].join("-");
  const messages = [
    inboxMessage({ msgid: "gap-1", userId: "u1", question: "缺口前合成问题", receivedAt: "2026-11-12T00:00:00.000Z" }),
    inboxMessage({ msgid: "gap-2", userId: "u1", question: "缺完成日志合成问题", receivedAt: "2026-11-12T00:02:00.000Z" }),
    inboxMessage({ msgid: "gap-3", userId: "u1", question: "缺口后合成问题", receivedAt: "2026-11-12T00:04:00.000Z" }),
  ];
  await writeFile(sources.instances[0].inboxPath, messages.map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(sources.instances[0].logPath,
    logLine("2026-11-12T00:05:00.000Z", "答复完成", completion({ msgid: "gap-3", sessionKey })) +
    logLine("2026-11-12T00:01:00.000Z", "答复完成", completion({ msgid: "gap-1", sessionKey })),
  );
  await writeFile(join(piDir, `2026-11-12T00-00-00-000Z_${sessionKey}.jsonl`), [
    JSON.stringify({ type: "session", id: sessionKey, timestamp: "2026-11-11T23:59:59.000Z" }),
    ...messages.flatMap((row, index) => [
      JSON.stringify(piEntry(`2026-11-12T00:0${index * 2}:00.100Z`, { role: "user", content: textContent(`${row.question}\n\n[渐进式资源目录]\n合成目录`) })),
      JSON.stringify(piEntry(`2026-11-12T00:0${index * 2}:30.000Z`, { role: "assistant", stopReason: "stop", content: textContent(`第 ${index + 1} 轮独立答复`) })),
    ]),
  ].join("\n"));

  const dashboard = await buildDashboard({ sources });
  assert.equal(dashboard.getTurn("gap-1").answer.text, "第 1 轮独立答复");
  assert.equal(dashboard.getTurn("gap-3").answer.text, "第 3 轮独立答复");
  assert.equal(dashboard.getTurn("gap-3").timeline.some((event) => event.text === "第 2 轮独立答复"), false);
});

test("相似问题只有完整原问题和已知资源后缀匹配，否则保持未关联", async () => {
  const { sources, piDir } = await createFixture();
  const sessionKey = ["wx", "synthetic-similar", "g1"].join("-");
  const message = inboxMessage({ msgid: "similar-1", userId: "u1", question: "合成问题", receivedAt: "2026-11-12T00:00:00.000Z" });
  await writeFile(sources.instances[0].inboxPath, JSON.stringify(message));
  await writeFile(sources.instances[0].logPath, logLine("2026-11-12T00:01:00.000Z", "答复完成", completion({ msgid: message.msgid, sessionKey })));
  await writeFile(join(piDir, `2026-11-12T00-00-00-000Z_${sessionKey}.jsonl`), [
    JSON.stringify({ type: "session", id: sessionKey, timestamp: "2026-11-11T23:59:59.000Z" }),
    JSON.stringify(piEntry("2026-11-12T00:00:00.100Z", { role: "user", content: textContent("合成问题的相似后缀\n\n[渐进式资源目录]\n合成目录") })),
    JSON.stringify(piEntry("2026-11-12T00:00:30.000Z", { role: "assistant", stopReason: "stop", content: textContent("不应借用的答复") })),
  ].join("\n"));

  const dashboard = await buildDashboard({ sources });
  assert.equal(dashboard.getTurn(message.msgid).answer.source, "unavailable");
  assert.equal(dashboard.getTurn(message.msgid).timeline.length, 0);
  assert.equal(dashboard.getMeta().diagnostics.mappedTurns, 0);
  assert.equal(dashboard.getMeta().diagnostics.unmatchedTurns, 1);
});

test("公开轮次摘要拒绝对象/数组等异常 route、channel 与 Guard 类型", async () => {
  const { sources } = await createFixture();
  const messages = [
    inboxMessage({ msgid: "types-1", userId: "u1", question: "对象路由合成问题", receivedAt: "2026-11-12T00:00:00.000Z" }),
    inboxMessage({ msgid: "types-2", userId: "u1", question: "数组路由合成问题", receivedAt: "2026-11-12T00:01:00.000Z" }),
    inboxMessage({ msgid: "types-3", userId: "u1", question: "正常路由合成问题", receivedAt: "2026-11-12T00:02:00.000Z" }),
  ];
  await writeFile(sources.instances[0].inboxPath, messages.map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(sources.instances[0].logPath,
    logLine("2026-11-12T00:00:01.000Z", "答复完成", completion({ msgid: "types-1", sessionKey: ["wx", "types", "g1"].join("-"), route: {}, guarded: {} })) +
    logLine("2026-11-12T00:01:01.000Z", "答复完成", completion({ msgid: "types-2", sessionKey: ["wx", "types", "g1"].join("-"), route: ["quick"], channel: ["push"] })) +
    logLine("2026-11-12T00:02:01.000Z", "答复完成", completion({ msgid: "types-3", sessionKey: ["wx", "types", "g1"].join("-"), route: "quick", channel: "push", guarded: true })),
  );

  const dashboard = await buildDashboard({ sources });
  const day = dashboard.getDay({ date: "2026-11-12" });
  const byId = Object.fromEntries(day.turns.map((turn) => [turn.id, turn]));
  assert.equal(byId["types-1"].route, null);
  assert.equal(byId["types-1"].guarded, false);
  assert.equal(byId["types-2"].route, null);
  assert.equal(byId["types-2"].channel, null);
  assert.equal(byId["types-3"].route, "quick");
  assert.equal(byId["types-3"].channel, "push");
  assert.equal(day.summary.succeeded, 2);
  assert.equal(dashboard.getTurn("types-2").delivery.status, "pending");
});

test("同文连续提问不会把前轮 stalled 重试锚点抢作下一轮 initial", async () => {
  const { sources, piDir } = await createFixture();
  const sessionKey = ["wx", "same-question-retry", "g1"].join("-");
  const question = "同文合成问题";
  const first = inboxMessage({ msgid: "same-retry-1", userId: "u1", question, receivedAt: "2026-11-12T00:00:00.000Z" });
  const second = inboxMessage({ msgid: "same-retry-2", userId: "u1", question, receivedAt: "2026-11-12T00:00:20.000Z" });
  await writeFile(sources.instances[0].inboxPath, [first, second].map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(sources.instances[0].logPath,
    logLine("2026-11-12T00:01:00.000Z", "答复完成", completion({ msgid: first.msgid, sessionKey, stallRetries: 1 })) +
    logLine("2026-11-12T00:02:00.000Z", "答复完成", completion({ msgid: second.msgid, sessionKey, stallRetries: 0 })),
  );
  const initial = `${question}\n\n[渐进式资源目录]\n合成目录`;
  await writeFile(join(piDir, `2026-11-12T00-00-00-000Z_${sessionKey}.jsonl`), [
    JSON.stringify({ type: "session", id: sessionKey, timestamp: "2026-11-11T23:59:59.000Z" }),
    JSON.stringify(piEntry("2026-11-12T00:00:01.000Z", { role: "user", content: textContent(initial) })),
    JSON.stringify(piEntry("2026-11-12T00:00:30.000Z", { role: "user", content: textContent(initial) })),
    JSON.stringify(piEntry("2026-11-12T00:00:50.000Z", { role: "assistant", stopReason: "stop", content: textContent("前轮重试后的答复") })),
    JSON.stringify(piEntry("2026-11-12T00:01:10.000Z", { role: "user", content: textContent(initial) })),
    JSON.stringify(piEntry("2026-11-12T00:01:40.000Z", { role: "assistant", stopReason: "stop", content: textContent("次轮独立答复") })),
  ].join("\n"));

  const dashboard = await buildDashboard({ sources });
  assert.equal(dashboard.getTurn(first.msgid).answer.text, "前轮重试后的答复");
  assert.equal(dashboard.getTurn(second.msgid).answer.text, "次轮独立答复");
  assert.deepEqual(dashboard.getTurn(first.msgid).timeline.filter((event) => event.type === "modelText").map((event) => event.text), ["前轮重试后的答复"]);
  assert.deepEqual(dashboard.getTurn(second.msgid).timeline.filter((event) => event.type === "modelText").map((event) => event.text), ["次轮独立答复"]);
  assert.equal(dashboard.getMeta().diagnostics.mappedTurns, 2);
  assert.equal(dashboard.getMeta().diagnostics.unmatchedTurns, 0);
});

test("另一 pi 文件的未来同文锚点不参与本轮候选，完成前唯一锚点可关联", async () => {
  const { sources, piDir } = await createFixture();
  const sessionKey = ["wx", "future-anchor", "g1"].join("-");
  const question = "多文件同文合成问题";
  const message = inboxMessage({ msgid: "future-anchor-1", userId: "u1", question, receivedAt: "2026-11-12T00:00:00.000Z" });
  await writeFile(sources.instances[0].inboxPath, JSON.stringify(message));
  await writeFile(sources.instances[0].logPath, logLine("2026-11-12T00:01:00.000Z", "答复完成", completion({ msgid: message.msgid, sessionKey })));
  const initial = `${question}\n\n[渐进式资源目录]\n合成目录`;
  await writeFile(join(piDir, `2026-11-12T00-00-00-000Z_${sessionKey}.jsonl`), [
    JSON.stringify({ type: "session", id: sessionKey, timestamp: "2026-11-11T23:59:59.000Z" }),
    JSON.stringify(piEntry("2026-11-12T00:00:10.000Z", { role: "user", content: textContent(initial) })),
    JSON.stringify(piEntry("2026-11-12T00:00:50.000Z", { role: "assistant", stopReason: "stop", content: textContent("完成前锚点答复") })),
  ].join("\n"));
  await writeFile(join(piDir, `2026-11-12T00-01-10-000Z_${sessionKey}.jsonl`), [
    JSON.stringify({ type: "session", id: sessionKey, timestamp: "2026-11-12T00:01:09.000Z" }),
    JSON.stringify(piEntry("2026-11-12T00:01:10.000Z", { role: "user", content: textContent(initial) })),
    JSON.stringify(piEntry("2026-11-12T00:01:20.000Z", { role: "assistant", stopReason: "stop", content: textContent("未来锚点答复") })),
  ].join("\n"));

  const dashboard = await buildDashboard({ sources });
  assert.equal(dashboard.getTurn(message.msgid).answer.text, "完成前锚点答复");
  assert.equal(dashboard.getMeta().diagnostics.mappedTurns, 1);
  assert.equal(dashboard.getMeta().diagnostics.unmatchedTurns, 0);
});

test("无效完成时间使同文连续轮次整组降级，不保留前轮残段", async () => {
  const { sources, piDir } = await createFixture();
  const sessionKey = ["wx", "same-run-invalid-time", "g1"].join("-");
  const question = "无效时间同文问题";
  const initial = `${question}\n\n[渐进式资源目录]\n合成目录`;
  const messages = [
    inboxMessage({ msgid: "invalid-run-1", userId: "u1", question, receivedAt: "2026-11-12T00:00:00.000Z" }),
    inboxMessage({ msgid: "invalid-run-2", userId: "u1", question, receivedAt: "2026-11-12T00:00:20.000Z" }),
  ];
  await writeFile(sources.instances[0].inboxPath, messages.map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(sources.instances[0].logPath,
    logLine("invalid-time", "答复完成", completion({ msgid: messages[0].msgid, sessionKey, stallRetries: 1 })) +
    logLine("2026-11-12T00:02:00.000Z", "答复完成", completion({ msgid: messages[1].msgid, sessionKey, stallRetries: 1 })),
  );
  await writeFile(join(piDir, `2026-11-12T00-00-00-000Z_${sessionKey}.jsonl`), [
    JSON.stringify({ type: "session", id: sessionKey, timestamp: "2026-11-11T23:59:59.000Z" }),
    JSON.stringify(piEntry("2026-11-12T00:00:01.000Z", { role: "user", content: textContent(initial) })),
    JSON.stringify(piEntry("2026-11-12T00:00:10.000Z", { role: "assistant", stopReason: "stop", content: textContent("前轮首次残段") })),
    JSON.stringify(piEntry("2026-11-12T00:00:30.000Z", { role: "user", content: textContent(initial) })),
    JSON.stringify(piEntry("2026-11-12T00:00:50.000Z", { role: "assistant", stopReason: "stop", content: textContent("前轮完整答复") })),
    JSON.stringify(piEntry("2026-11-12T00:01:10.000Z", { role: "user", content: textContent(initial) })),
    JSON.stringify(piEntry("2026-11-12T00:01:20.000Z", { role: "user", content: textContent(initial) })),
    JSON.stringify(piEntry("2026-11-12T00:01:40.000Z", { role: "assistant", stopReason: "stop", content: textContent("次轮完整答复") })),
  ].join("\n"));

  const dashboard = await buildDashboard({ sources });
  for (const message of messages) {
    assert.equal(dashboard.getTurn(message.msgid).answer.source, "unavailable");
    assert.deepEqual(dashboard.getTurn(message.msgid).timeline, []);
  }
  assert.equal(dashboard.getMeta().diagnostics.mappedTurns, 0);
  assert.equal(dashboard.getMeta().diagnostics.unmatchedTurns, 2);
});

test("同文轮次 stallRetries 少报为零时整组降级", async () => {
  const { sources, piDir } = await createFixture();
  const sessionKey = ["wx", "same-run-underreported", "g1"].join("-");
  const question = "少报重试同文问题";
  const initial = `${question}\n\n[渐进式资源目录]\n合成目录`;
  const messages = [
    inboxMessage({ msgid: "underreported-1", userId: "u1", question, receivedAt: "2026-11-12T00:00:00.000Z" }),
    inboxMessage({ msgid: "underreported-2", userId: "u1", question, receivedAt: "2026-11-12T00:00:20.000Z" }),
  ];
  await writeFile(sources.instances[0].inboxPath, messages.map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(sources.instances[0].logPath,
    logLine("2026-11-12T00:01:00.000Z", "答复完成", completion({ msgid: messages[0].msgid, sessionKey, stallRetries: 0 })) +
    logLine("2026-11-12T00:02:00.000Z", "答复完成", completion({ msgid: messages[1].msgid, sessionKey, stallRetries: 0 })),
  );
  await writeFile(join(piDir, `2026-11-12T00-00-00-000Z_${sessionKey}.jsonl`), [
    JSON.stringify({ type: "session", id: sessionKey, timestamp: "2026-11-11T23:59:59.000Z" }),
    JSON.stringify(piEntry("2026-11-12T00:00:01.000Z", { role: "user", content: textContent(initial) })),
    JSON.stringify(piEntry("2026-11-12T00:00:10.000Z", { role: "assistant", stopReason: "stop", content: textContent("前轮残段文本") })),
    JSON.stringify(piEntry("2026-11-12T00:00:30.000Z", { role: "user", content: textContent(initial) })),
    JSON.stringify(piEntry("2026-11-12T00:00:50.000Z", { role: "assistant", stopReason: "stop", content: textContent("前轮答复") })),
    JSON.stringify(piEntry("2026-11-12T00:01:10.000Z", { role: "user", content: textContent(initial) })),
    JSON.stringify(piEntry("2026-11-12T00:01:20.000Z", { role: "user", content: textContent(initial) })),
    JSON.stringify(piEntry("2026-11-12T00:01:40.000Z", { role: "assistant", stopReason: "stop", content: textContent("次轮答复") })),
  ].join("\n"));

  const dashboard = await buildDashboard({ sources });
  for (const message of messages) {
    assert.equal(dashboard.getTurn(message.msgid).answer.source, "unavailable");
    assert.deepEqual(dashboard.getTurn(message.msgid).timeline, []);
  }
  assert.equal(dashboard.getMeta().diagnostics.mappedTurns, 0);
  assert.equal(dashboard.getMeta().diagnostics.unmatchedTurns, 2);
});

test("三轮同文中间日志矛盾只降级整组，不影响前后不同问题", async () => {
  const { sources, piDir } = await createFixture();
  const sessionKey = ["wx", "three-same-run", "g1"].join("-");
  const sameQuestion = "三轮同文问题";
  const specs = [
    { id: "run-before", question: "前文不同问题", retries: 0 },
    { id: "run-same-1", question: sameQuestion, retries: 0 },
    { id: "run-same-2", question: sameQuestion, retries: 1 },
    { id: "run-same-3", question: sameQuestion, retries: 0 },
    { id: "run-after", question: "后文不同问题", retries: 0 },
  ];
  const messages = specs.map((spec, index) => inboxMessage({ msgid: spec.id, userId: "u1", question: spec.question, receivedAt: `2026-11-12T00:0${index * 2}:00.000Z` }));
  await writeFile(sources.instances[0].inboxPath, messages.map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(sources.instances[0].logPath, specs.map((spec, index) =>
    logLine(`2026-11-12T00:0${index * 2 + 1}:00.000Z`, "答复完成", completion({ msgid: spec.id, sessionKey, stallRetries: spec.retries })),
  ).join(""));
  await writeFile(join(piDir, `2026-11-12T00-00-00-000Z_${sessionKey}.jsonl`), [
    JSON.stringify({ type: "session", id: sessionKey, timestamp: "2026-11-11T23:59:59.000Z" }),
    ...specs.flatMap((spec, index) => {
      const minute = index * 2;
      const initial = `${spec.question}\n\n[渐进式资源目录]\n合成目录`;
      return [
        JSON.stringify(piEntry(`2026-11-12T00:0${minute}:05.000Z`, { role: "user", content: textContent(initial) })),
        JSON.stringify(piEntry(`2026-11-12T00:0${minute}:40.000Z`, { role: "assistant", stopReason: "stop", content: textContent(`${spec.id} 答复`) })),
      ];
    }),
  ].join("\n"));

  const dashboard = await buildDashboard({ sources });
  assert.equal(dashboard.getTurn("run-before").answer.text, "run-before 答复");
  assert.equal(dashboard.getTurn("run-after").answer.text, "run-after 答复");
  for (const id of ["run-same-1", "run-same-2", "run-same-3"]) {
    assert.equal(dashboard.getTurn(id).answer.source, "unavailable");
    assert.deepEqual(dashboard.getTurn(id).timeline, []);
  }
  assert.equal(dashboard.getMeta().diagnostics.mappedTurns, 2);
  assert.equal(dashboard.getMeta().diagnostics.unmatchedTurns, 3);
});

test("实例内人员映射覆盖全局映射", async () => {
  const { root, sources } = await createFixture();
  const instanceMap = join(root, "instance-user-map.json");
  await writeFile(instanceMap, JSON.stringify({ u1: { name: "实例内同事" } }));
  sources.userMapPaths = [instanceMap];
  await writeFile(sources.instances[0].inboxPath, JSON.stringify(inboxMessage({
    msgid: "map-1",
    userId: "u1",
    question: "映射覆盖",
    receivedAt: "2026-11-12T01:00:00.000Z",
  })));

  const dashboard = await buildDashboard({ sources });
  assert.equal(dashboard.getDay({ date: "2026-11-12" }).turns[0].colleagueName, "实例内同事");
});

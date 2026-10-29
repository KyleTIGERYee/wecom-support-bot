import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInbox } from "../src/inbox.js";

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "wsb-inbox-"));
  return join(dir, "inbox.jsonl");
}

/** 造一条收件箱记录。 */
function makeMessage(overrides = {}) {
  return {
    msgid: "m1",
    userId: "u1",
    chatId: "c1",
    chatType: "single",
    question: "退租有哪些类型",
    sessionKey: "wx-u1-g1",
    receivedAt: "2026-10-29T01:00:00.000Z",
    ...overrides,
  };
}

const NOW = Date.parse("2026-10-29T01:05:00.000Z");
const WINDOW = 30 * 60 * 1000;

test("首次收到的消息是新的，重复的消息不是", async () => {
  const storePath = await tempStore();
  const inbox = createInbox({ storePath });
  await inbox.load();

  assert.deepEqual(inbox.accept(makeMessage()), { isNew: true });
  assert.deepEqual(inbox.accept(makeMessage()), { isNew: false });
});

test("重启后能读回没有答完的问题", async () => {
  const storePath = await tempStore();
  const first = createInbox({ storePath });
  await first.load();
  first.accept(makeMessage());
  await first.flush();

  const second = createInbox({ storePath });
  await second.load();

  const pending = second.recoverable(NOW, WINDOW);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].msgid, "m1");
  assert.equal(pending[0].question, "退租有哪些类型");
});

test("答过的问题不再需要补跑", async () => {
  const storePath = await tempStore();
  const inbox = createInbox({ storePath });
  await inbox.load();
  inbox.accept(makeMessage());
  inbox.markAnswered("m1");
  await inbox.flush();

  const restarted = createInbox({ storePath });
  await restarted.load();

  assert.deepEqual(restarted.recoverable(NOW, WINDOW), []);
});

test("重启时正在跑的问题也当作需要补跑", async () => {
  const storePath = await tempStore();
  const inbox = createInbox({ storePath });
  await inbox.load();
  inbox.accept(makeMessage());
  inbox.markRunning("m1");
  await inbox.flush();

  const restarted = createInbox({ storePath });
  await restarted.load();

  assert.equal(restarted.recoverable(NOW, WINDOW).length, 1);
});

test("超出补跑窗口的未答问题不返回", async () => {
  const storePath = await tempStore();
  const inbox = createInbox({ storePath });
  await inbox.load();
  inbox.accept(makeMessage({ receivedAt: "2026-10-28T20:00:00.000Z" }));

  assert.deepEqual(inbox.recoverable(NOW, WINDOW), []);
});

test("重复消息在重启后仍然算重复", async () => {
  const storePath = await tempStore();
  const first = createInbox({ storePath });
  await first.load();
  first.accept(makeMessage());
  await first.flush();

  const second = createInbox({ storePath });
  await second.load();

  assert.deepEqual(second.accept(makeMessage()), { isNew: false });
});

test("坏行不影响读取，也不抛异常", async () => {
  const storePath = await tempStore();
  await writeFile(storePath, "这不是 json\n", "utf8");
  const inbox = createInbox({ storePath });
  await inbox.load();
  inbox.accept(makeMessage());
  await appendFile(storePath, "{半截\n", "utf8");
  await inbox.flush();

  const restarted = createInbox({ storePath });
  await restarted.load();

  assert.equal(restarted.recoverable(NOW, WINDOW).length, 1);
});

test("清理会丢掉过期的已答记录，保留最近的", async () => {
  const storePath = await tempStore();
  const inbox = createInbox({ storePath });
  await inbox.load();
  inbox.accept(makeMessage({ msgid: "old", receivedAt: "2026-10-27T00:00:00.000Z" }));
  inbox.markAnswered("old");
  inbox.accept(makeMessage({ msgid: "fresh" }));
  inbox.markAnswered("fresh");
  await inbox.flush();

  await inbox.compact(NOW, 24 * 60 * 60 * 1000);

  const restarted = createInbox({ storePath });
  await restarted.load();
  assert.deepEqual(restarted.recoverable(NOW, WINDOW), []);
  assert.deepEqual(restarted.accept(makeMessage({ msgid: "fresh" })), { isNew: false });
  assert.deepEqual(restarted.accept(makeMessage({ msgid: "old" })), { isNew: true });
});

test("超出窗口的未答问题可以通过 stale 查出来（只记日志用）", async () => {
  const storePath = await tempStore();
  const inbox = createInbox({ storePath });
  await inbox.load();
  inbox.accept(makeMessage({ msgid: "old-open", receivedAt: "2026-10-28T20:00:00.000Z" }));
  inbox.accept(makeMessage({ msgid: "fresh-open" }));

  const stale = inbox.stale(NOW, WINDOW).map((entry) => entry.msgid);

  assert.deepEqual(stale, ["old-open"]);
  assert.deepEqual(inbox.recoverable(NOW, WINDOW).map((entry) => entry.msgid), ["fresh-open"]);
});

test("消息记录缺 state 字段时仍当作待答（写入被截断也不丢单）", async () => {
  const storePath = await tempStore();
  await writeFile(storePath, `${JSON.stringify({ ...makeMessage(), state: undefined })}\n`, "utf8");

  const inbox = createInbox({ storePath });
  await inbox.load();

  assert.deepEqual(inbox.recoverable(NOW, WINDOW).map((entry) => entry.msgid), ["m1"]);
});

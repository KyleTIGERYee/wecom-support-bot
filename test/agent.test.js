import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { runAgentTurn } from "../src/agent.js";

/**
 * 造一个假的子进程：按顺序吐 JSONL，然后结束。
 *
 * @param {string[]} lines
 * @param {{exitCode?: number|null, ending?: boolean}} [options]
 * @returns {(options: any) => any}
 */
function fakeRunner(lines, { exitCode = 0, ending = true } = {}) {
  return () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };

    queueMicrotask(() => {
      for (const line of lines) child.stdout.emit("data", `${line}\n`);
      if (ending) child.emit("exit", exitCode);
    });

    return child;
  };
}

/**
 * 一条 assistant 文本消息事件。
 * @param {string} text
 */
function textMessage(text) {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/**
 * 一条 bash 工具调用事件。
 * @param {string} command
 */
function bashTool(command) {
  return JSON.stringify({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command },
  });
}

test("从事件流提取最终答复", async () => {
  const runner = fakeRunner([textMessage("这是最终答案")]);

  const result = await runAgentTurn({ prompt: "问个问题", sessionId: "wx-abc", runner });

  assert.equal(result.text, "这是最终答案");
  assert.equal(result.timedOut, false);
});

test("多条 assistant 消息取最后一条非空文本", async () => {
  const runner = fakeRunner([textMessage("中间过程"), textMessage("最终答案")]);

  const result = await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner });

  assert.equal(result.text, "最终答案");
});

test("忽略只含工具调用的 assistant 消息", async () => {
  const toolOnly = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] },
  });
  const runner = fakeRunner([toolOnly, textMessage("真答案")]);

  const result = await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner });

  assert.equal(result.text, "真答案");
});

test("检测到 bi_query.py 调用时 biTouched 为真", async () => {
  const runner = fakeRunner([
    bashTool("python3 /Users/kyle/Desktop/PM/信息技术部资产库/知识库/数据库/ajly-db-wiki/scripts/bi_query.py 'SELECT 1'"),
    textMessage("查询结果"),
  ]);

  const result = await runAgentTurn({ prompt: "查数据", sessionId: "wx-abc", runner });

  assert.equal(result.biTouched, true);
});

test("未调用 bi_query.py 时 biTouched 为假", async () => {
  const runner = fakeRunner([
    bashTool("python3 /Users/kyle/Desktop/PM/.agents/skills/ajly-wiki/scripts/search_wiki.py 退租"),
    textMessage("退租的定义是…"),
  ]);

  const result = await runAgentTurn({ prompt: "退租是什么", sessionId: "wx-abc", runner });

  assert.equal(result.biTouched, false);
});

test("同时有多次 bash 调用时任一命中即 biTouched", async () => {
  const runner = fakeRunner([
    bashTool("python3 .../scripts/search_db.py 退租"),
    bashTool("python3 .../scripts/bi_query.py 'SELECT 1'"),
    textMessage("答案"),
  ]);

  const result = await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner });

  assert.equal(result.biTouched, true);
});

test("进程失败时返回错误但不抛异常", async () => {
  const runner = fakeRunner([], { exitCode: 1 });

  const result = await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner });

  assert.equal(result.text, "");
  assert.equal(result.failed, true);
});

test("超时时杀掉进程并标记 timedOut", async () => {
  const runner = () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("exit", null));
      return true;
    };
    return child;
  };

  const result = await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner, timeoutMs: 30 });

  assert.equal(result.timedOut, true);
});

test("忽略非法 JSON 行", async () => {
  const runner = fakeRunner(["这不是 json", textMessage("答案还在")]);

  const result = await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner });

  assert.equal(result.text, "答案还在");
});

test("把 prompt 与 sessionId 传给 runner", async () => {
  /** @type {any} */
  let seen = null;
  const runner = (/** @type {any} */ options) => {
    seen = options;
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };

  await runAgentTurn({ prompt: "我的问题", sessionId: "wx-abc", runner });

  assert.equal(seen.prompt, "我的问题");
  assert.equal(seen.sessionId, "wx-abc");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { runTurnLifecycle } from "../src/turn-lifecycle.js";

const MESSAGES = {
  slowText: "这个查得有点慢，我再看看",
  handoffText: "这个要多查一会儿，查好了单独发你",
};

/** 造一个指定毫秒后完成的执行函数。 */
function completesAfter(ms, text = "答案") {
  return () =>
    new Promise((resolve) => {
      setTimeout(() => resolve({ finalText: text }), ms);
    });
}

/** 记录表面调用。 */
function recorder() {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    surface: {
      progress: async (/** @type {string} */ text) => {
        calls.push(`progress:${text}`);
      },
      handoff: async (/** @type {string} */ text) => {
        calls.push(`handoff:${text}`);
      },
    },
  };
}

test("很快答完时不发进度提示也不转后台", async () => {
  const { calls, surface } = recorder();
  const result = await runTurnLifecycle({
    execute: completesAfter(5),
    surface,
    messages: MESSAGES,
    slowAfterMs: 30,
    handoffAfterMs: 60,
  });

  assert.equal(result.mode, "inline");
  assert.equal(result.text, "答案");
  assert.deepEqual(calls, []);
});

test("查得慢时先发一次慢提示", async () => {
  const { calls, surface } = recorder();
  const result = await runTurnLifecycle({
    execute: completesAfter(45),
    surface,
    messages: MESSAGES,
    slowAfterMs: 10,
    handoffAfterMs: 200,
  });

  assert.equal(result.mode, "inline");
  assert.deepEqual(calls, [`progress:${MESSAGES.slowText}`]);
});

test("超过交接时限时先收尾告知，再返回后台答案", async () => {
  const { calls, surface } = recorder();
  const result = await runTurnLifecycle({
    execute: completesAfter(60),
    surface,
    messages: MESSAGES,
    slowAfterMs: 10,
    handoffAfterMs: 30,
  });

  assert.equal(result.mode, "handoff");
  assert.equal(result.text, "答案");
  assert.deepEqual(calls, [`progress:${MESSAGES.slowText}`, `handoff:${MESSAGES.handoffText}`]);
});

test("执行失败时异常传给调用方，且不再发提示", async () => {
  const { calls, surface } = recorder();
  await assert.rejects(
    () =>
      runTurnLifecycle({
        execute: async () => {
          throw new Error("查数失败");
        },
        surface,
        messages: MESSAGES,
        slowAfterMs: 20,
        handoffAfterMs: 40,
      }),
    /查数失败/,
  );

  assert.deepEqual(calls, []);
});

test("交接后不再重复发慢提示", async () => {
  const { calls, surface } = recorder();
  await runTurnLifecycle({
    execute: completesAfter(80),
    surface,
    messages: MESSAGES,
    slowAfterMs: 5,
    handoffAfterMs: 20,
  });

  assert.equal(calls.filter((call) => call.startsWith("progress:")).length, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { handleTurn } from "../src/orchestrate.js";

/** 造一个可控的会话状态假实现。 */
function fakeState(touchedInitially = false) {
  const touched = new Set(touchedInitially ? ["wx-abc"] : []);
  return {
    isBiTouched: (/** @type {string} */ key) => touched.has(key),
    markBiTouched: (/** @type {string} */ key) => touched.add(key),
    flush: async () => {},
  };
}

test("未碰过 BI 的会话不调用 guard", async () => {
  let guardCalls = 0;
  const deps = {
    state: fakeState(false),
    runAgent: async () => ({ text: "退租是指…", biTouched: false, timedOut: false, failed: false }),
    review: async () => {
      guardCalls += 1;
      return { verdict: "ALLOW" };
    },
  };

  const result = await handleTurn({ question: "退租是什么", sessionKey: "wx-abc", deps });

  assert.equal(guardCalls, 0);
  assert.equal(result.finalText, "退租是指…");
  assert.equal(result.guarded, false);
});

test("本轮碰了 BI 时调用 guard 并放行", async () => {
  let guardCalls = 0;
  const deps = {
    state: fakeState(false),
    runAgent: async () => ({ text: "本月退租 1234 单", biTouched: true, timedOut: false, failed: false }),
    review: async () => {
      guardCalls += 1;
      return { verdict: "ALLOW" };
    },
  };

  const result = await handleTurn({ question: "本月退租多少", sessionKey: "wx-abc", deps });

  assert.equal(guardCalls, 1);
  assert.equal(result.finalText, "本月退租 1234 单");
});

test("碰过 BI 后把会话标记为粘性", async () => {
  const state = fakeState(false);
  const deps = {
    state,
    runAgent: async () => ({ text: "答案", biTouched: true, timedOut: false, failed: false }),
    review: async () => ({ verdict: "ALLOW" }),
  };

  await handleTurn({ question: "问", sessionKey: "wx-abc", deps });

  assert.equal(state.isBiTouched("wx-abc"), true);
});

test("历史碰过 BI 的会话本轮不再碰 BI 也要过 guard", async () => {
  let guardCalls = 0;
  const deps = {
    state: fakeState(true),
    runAgent: async () => ({ text: "上次那个数是 1234", biTouched: false, timedOut: false, failed: false }),
    review: async () => {
      guardCalls += 1;
      return { verdict: "ALLOW" };
    },
  };

  await handleTurn({ question: "刚才那个数是多少", sessionKey: "wx-abc", deps });

  assert.equal(guardCalls, 1);
});

test("DENY 后带理由打回重写，第二次通过则用新稿", async () => {
  let round = 0;
  const prompts = [];
  const deps = {
    state: fakeState(true),
    runAgent: async ({ prompt, isRework }) => {
      prompts.push({ prompt, isRework });
      round += 1;
      return { text: round === 1 ? "张三 13800138000" : "该租客手机号已脱敏", biTouched: true, timedOut: false, failed: false };
    },
    review: async ({ answer }) =>
      answer.includes("13800138000") ? { verdict: "DENY", reason: "包含手机号" } : { verdict: "ALLOW" },
  };

  const result = await handleTurn({ question: "这个租客手机号多少", sessionKey: "wx-abc", deps });

  assert.equal(result.finalText, "该租客手机号已脱敏");
  assert.equal(result.rounds, 2);
  assert.equal(prompts[1].isRework, true);
  assert.match(prompts[1].prompt, /包含手机号/);
});

test("连续 3 次 DENY 后走兜底话术", async () => {
  const deps = {
    state: fakeState(true),
    runAgent: async () => ({ text: "张三 13800138000", biTouched: true, timedOut: false, failed: false }),
    review: async () => ({ verdict: "DENY", reason: "包含手机号" }),
  };

  const result = await handleTurn({ question: "问", sessionKey: "wx-abc", deps, maxRounds: 3 });

  assert.equal(result.exhausted, true);
  assert.match(result.finalText, /没法直接确认|问虎老师/);
});

test("agent 失败时返回错误话术", async () => {
  const deps = {
    state: fakeState(false),
    runAgent: async () => ({ text: "", biTouched: false, timedOut: false, failed: true }),
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "问", sessionKey: "wx-abc", deps });

  assert.match(result.finalText, /没处理好/);
});

test("deny 时不把原始答复泄漏给调用方", async () => {
  const deps = {
    state: fakeState(true),
    runAgent: async () => ({ text: "张三 13800138000", biTouched: true, timedOut: false, failed: false }),
    review: async () => ({ verdict: "DENY", reason: "包含手机号" }),
  };

  const result = await handleTurn({ question: "问", sessionKey: "wx-abc", deps, maxRounds: 1 });

  assert.equal(result.finalText.includes("13800138000"), false);
});

test("超时给超时话术而不是通用错误话术", async () => {
  const deps = {
    state: fakeState(false),
    runAgent: async () => ({ text: "", biTouched: false, timedOut: true, failed: false }),
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "问", sessionKey: "wx-abc", deps });

  assert.equal(result.timedOut, true);
  assert.match(result.finalText, /查得有点久/);
});

test("同一会话的并发请求会排队，不会同时跑", async () => {
  const { createTurnQueue } = await import("../src/turn-queue.js");
  const queue = createTurnQueue();

  const order = [];
  const slow = () =>
    new Promise((resolve) => {
      setTimeout(() => {
        order.push("first-done");
        resolve("done");
      }, 50);
    });
  const fast = async () => {
    order.push("second-start");
    return "done";
  };

  const first = queue.run("wx-abc", slow);
  const second = queue.run("wx-abc", fast);
  await Promise.all([first, second]);

  assert.deepEqual(order, ["first-done", "second-start"]);
});

test("不同会话互不阻塞", async () => {
  const { createTurnQueue } = await import("../src/turn-queue.js");
  const queue = createTurnQueue();

  let started = false;
  const slow = () => new Promise((resolve) => setTimeout(() => resolve("slow"), 60));
  const quick = async () => {
    started = true;
    return "quick";
  };

  const a = queue.run("wx-abc", slow);
  const b = queue.run("wx-xyz", quick);
  const [, bResult] = await Promise.all([a, b]);

  assert.equal(bResult, "quick");
  assert.equal(started, true);
});

test("排队中的请求可以被跳过", async () => {
  const { createTurnQueue } = await import("../src/turn-queue.js");
  const queue = createTurnQueue();

  const slow = () => new Promise((resolve) => setTimeout(() => resolve("slow"), 80));
  let secondRan = false;
  const second = async () => {
    secondRan = true;
    return "second";
  };

  const a = queue.run("wx-abc", slow);
  const b = queue.run("wx-abc", second, { skipIfBusy: true });
  const [aResult, bResult] = await Promise.all([a, b]);

  assert.equal(aResult, "slow");
  assert.equal(bResult, null);
  assert.equal(secondRan, false);
});

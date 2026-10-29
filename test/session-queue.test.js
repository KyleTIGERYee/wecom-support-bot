import { test } from "node:test";
import assert from "node:assert/strict";

import { createSessionQueue } from "../src/session-queue.js";

/** 让排队的微任务跑完一轮。 */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 造一个能手动放行的任务。 */
function deferred() {
  /** @type {(value?: any) => void} */
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve: /** @type {() => void} */ (resolve) };
}

test("同一个会话的任务严格按到达顺序执行", async () => {
  const queue = createSessionQueue({ maxConcurrent: 4 });
  /** @type {string[]} */
  const events = [];

  const first = deferred();
  const one = queue.run("a", async () => {
    events.push("one:start");
    await first.promise;
    events.push("one:end");
  });
  const two = queue.run("a", async () => {
    events.push("two:start");
    events.push("two:end");
  });

  await tick();
  assert.deepEqual(events, ["one:start"]);

  first.resolve();
  await Promise.all([one, two]);

  assert.deepEqual(events, ["one:start", "one:end", "two:start", "two:end"]);
});

test("不同会话的任务并行执行", async () => {
  const queue = createSessionQueue({ maxConcurrent: 4 });
  /** @type {string[]} */
  const events = [];

  const gate = deferred();
  const one = queue.run("a", async () => {
    events.push("a:start");
    await gate.promise;
    events.push("a:end");
  });
  const two = queue.run("b", async () => {
    events.push("b:start");
    events.push("b:end");
  });

  await two;
  assert.deepEqual(events, ["a:start", "b:start", "b:end"]);

  gate.resolve();
  await one;
});

test("全局并发不超过上限", async () => {
  const queue = createSessionQueue({ maxConcurrent: 2 });
  let running = 0;
  let peak = 0;
  const gate = deferred();

  const tasks = ["a", "b", "c", "d"].map((key) =>
    queue.run(key, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
    }),
  );

  await tick();
  assert.equal(peak, 2);

  gate.resolve();
  await Promise.all(tasks);
  assert.equal(peak, 2);
});

test("任务抛异常时队列继续工作，异常传给调用方", async () => {
  const queue = createSessionQueue({ maxConcurrent: 2 });

  await assert.rejects(() =>
    queue.run("a", async () => {
      throw new Error("查数失败");
    }),
  );

  assert.equal(await queue.run("a", async () => "ok"), "ok");
});

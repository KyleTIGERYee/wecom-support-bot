import { test } from "node:test";
import assert from "node:assert/strict";

import { deliverFinal } from "../src/deliver.js";

const noWait = async () => {};

test("流式答复成功时不走主动推送", async () => {
  let pushed = 0;
  const result = await deliverFinal({
    text: "答案",
    stream: async () => {},
    push: async () => {
      pushed += 1;
    },
    wait: noWait,
  });

  assert.equal(result.channel, "stream");
  assert.equal(pushed, 0);
});

test("流式答复失败时改走主动推送", async () => {
  let pushed = "";
  const result = await deliverFinal({
    text: "答案",
    stream: async () => {
      throw new Error("reply ack timeout");
    },
    push: async (/** @type {string} */ text) => {
      pushed = text;
    },
    wait: noWait,
  });

  assert.equal(result.channel, "push");
  assert.equal(pushed, "答案");
});

test("主动推送第一次失败、第二次成功", async () => {
  let attempts = 0;
  const result = await deliverFinal({
    text: "答案",
    stream: async () => {
      throw new Error("断线");
    },
    push: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network");
    },
    wait: noWait,
  });

  assert.equal(result.channel, "push");
  assert.equal(attempts, 2);
});

test("流式和推送都失败时重试到上限并返回 none，不抛异常", async () => {
  let attempts = 0;
  const result = await deliverFinal({
    text: "答案",
    stream: async () => {
      throw new Error("断线");
    },
    push: async () => {
      attempts += 1;
      throw new Error("仍然断线");
    },
    retries: 3,
    wait: noWait,
  });

  assert.equal(result.channel, "none");
  assert.equal(attempts, 3);
  assert.equal(typeof result.reason, "string");
});

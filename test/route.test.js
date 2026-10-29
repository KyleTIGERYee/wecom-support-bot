import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyQuestion } from "../src/route.js";

test("明确判定快的问题走 quick", async () => {
  const callModel = async () => "QUICK";

  assert.equal(await classifyQuestion({ question: "退租有哪些类型", callModel }), "quick");
});

test("要查数的问题走 deep", async () => {
  const callModel = async () => "DEEP";

  assert.equal(await classifyQuestion({ question: "这个月退租多少单", callModel }), "deep");
});

test("判定里夹带解释时取第一个关键词", async () => {
  const callModel = async () => "DEEP\n需要查生产数据";

  assert.equal(await classifyQuestion({ question: "出租率多少", callModel }), "deep");
});

test("判定返回无法识别的内容时按 deep 处理", async () => {
  const callModel = async () => "这个我不确定";

  assert.equal(await classifyQuestion({ question: "随便问", callModel }), "deep");
});

test("判定模型故障时按 deep 处理", async () => {
  const callModel = async () => {
    throw new Error("模型没响应");
  };

  assert.equal(await classifyQuestion({ question: "随便问", callModel }), "deep");
});

test("把问题发给判定模型", async () => {
  /** @type {any} */
  let seen = null;
  const callModel = async (/** @type {any} */ messages) => {
    seen = messages;
    return "QUICK";
  };

  await classifyQuestion({ question: "在吗", callModel });

  assert.ok(JSON.stringify(seen).includes("在吗"));
});

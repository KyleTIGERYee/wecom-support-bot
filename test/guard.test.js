import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewReply } from "../src/guard.js";

test("模型回 ALLOW 时放行", async () => {
  const callModel = async () => "ALLOW";

  const result = await reviewReply({ answer: "本月退租率 12.3%", callModel });

  assert.equal(result.verdict, "ALLOW");
});

test("模型回 DENY 且带理由时拦截并带回理由", async () => {
  const callModel = async () => "DENY\n列出了租客手机号";

  const result = await reviewReply({ answer: "张三 13800138000", callModel });

  assert.equal(result.verdict, "DENY");
  assert.equal(result.reason ?? "", "列出了租客手机号");
});

test("DENY 不带理由时给默认理由", async () => {
  const callModel = async () => "DENY";

  const result = await reviewReply({ answer: "答", callModel });

  assert.equal(result.verdict, "DENY");
  assert.ok((result.reason ?? "").length > 0);
});

test("模型输出带多余空白与解释时仍能解析", async () => {
  const callModel = async () => "  判定结果：DENY\n原因：包含身份证号  ";

  const result = await reviewReply({ answer: "答", callModel });

  assert.equal(result.verdict, "DENY");
  assert.match(result.reason ?? "", /身份证/);
});

test("模型故障时 fail-closed（按 DENY 处理）", async () => {
  const callModel = async () => {
    throw new Error("连接超时");
  };

  const result = await reviewReply({ answer: "答", callModel });

  assert.equal(result.verdict, "DENY");
  assert.match(result.reason ?? "", /校验/);
});

test("模型返回无法识别的内容时 fail-closed", async () => {
  const callModel = async () => "我无法判断";

  const result = await reviewReply({ answer: "答", callModel });

  assert.equal(result.verdict, "DENY");
});

test("只把答复交给模型判定，不再给提问（避免按意图从紧）", async () => {
  /** @type {any} */
  let seen = null;
  const callModel = async (/** @type {any} */ messages) => {
    seen = messages;
    return "ALLOW";
  };

  await reviewReply({ answer: "答复正文", callModel });

  const joined = JSON.stringify(seen);
  assert.match(joined, /答复正文/);
  assert.doesNotMatch(joined, /同事的问题/);
});

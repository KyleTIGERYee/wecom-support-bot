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

test("系统提示词写明新口径：明细脱敏后放行、拿不准时放行、底线保留", async () => {
  /** @type {any} */
  let seen = null;
  const callModel = async (/** @type {any} */ messages) => {
    seen = messages;
    return "ALLOW";
  };

  await reviewReply({ answer: "答", callModel });

  const systemPrompt = String(seen?.[0]?.content ?? "");
  // 明细本身不是罪，敏感字段未脱敏才是
  assert.match(systemPrompt, /明细本身不是罪/);
  assert.match(systemPrompt, /脱敏后的明细清单/);
  // 通用裁量：可自行从严，拿不准时放行
  assert.match(systemPrompt, /可自行从严/);
  assert.match(systemPrompt, /拿不准时放行/);
  // DENY 底线保留
  assert.match(systemPrompt, /手机号、身份证号、银行卡号/);
  assert.match(systemPrompt, /姓名\+房号\+电话/);
  assert.match(systemPrompt, /API Key、Token、内网 IP/);
});

test("新口径：含明文手机号的人级明细 DENY 并带回理由", async () => {
  const callModel = async () => "DENY\n人级明细含未脱敏手机号";

  const result = await reviewReply({
    answer: "1. 张三 13800138000\n2. 李四 13900139000\n3. 王五 13700137000",
    callModel,
  });

  assert.equal(result.verdict, "DENY");
  assert.match(result.reason ?? "", /手机号/);
});

test("新口径：同一份明细脱敏后 ALLOW", async () => {
  const callModel = async () => "ALLOW";

  const result = await reviewReply({
    answer: "1. 张三 138****8000\n2. 李四 139****9000\n3. 王五 137****7000",
    callModel,
  });

  assert.equal(result.verdict, "ALLOW");
});

test("新口径：纯机构/楼栋名单（无敏感字段）ALLOW", async () => {
  const callModel = async () => "ALLOW";

  const result = await reviewReply({
    answer: "| 楼栋 | 机构 | 在租 |\n|---|---|---|\n| 1 栋 | A 机构 | 12 |\n| 2 栋 | B 机构 | 8 |",
    callModel,
  });

  assert.equal(result.verdict, "ALLOW");
});

test("汇总表格 ALLOW 不回归", async () => {
  const callModel = async () => "ALLOW";

  const result = await reviewReply({
    answer: "| 月份 | 退租量 | 退租率 |\n|---|---|---|\n| 2026-09 | 40 | 11.8% |\n| 2026-10 | 43 | 12.3% |",
    callModel,
  });

  assert.equal(result.verdict, "ALLOW");
});

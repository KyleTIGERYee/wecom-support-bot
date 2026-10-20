import { test } from "node:test";
import assert from "node:assert/strict";

import { isNewSessionRequest, normalizeMessage, toSessionKey, stripMention } from "../src/wecom.js";

test("识别开新会话的说法", () => {
  for (const phrase of ["新会话", "开个新会话", "/new", "重新开始", "清空对话", "换个话题", "新会话。"]) {
    assert.equal(isNewSessionRequest(phrase), true, `应识别：${phrase}`);
  }
});

test("正常提问不会被误判为开新会话", () => {
  for (const phrase of ["重新开始统计一下上个月的数", "这个流程要重来一遍吗", "退租怎么算", "新会话是什么"]) {
    assert.equal(isNewSessionRequest(phrase), false, `不应识别：${phrase}`);
  }
});

test("单聊消息归一化", () => {
  const frame = { body: { text: { content: "退租怎么算" }, from: { userid: "zhangsan" }, msgtype: "text" } };

  const message = normalizeMessage(frame);

  assert.equal(message.text, "退租怎么算");
  assert.equal(message.chatType, "single");
});

test("群聊消息归一化带 chatid", () => {
  const frame = {
    body: {
      text: { content: "退租怎么算" },
      from: { userid: "zhangsan" },
      chattype: "group",
      chatid: "wrGROUP123",
    },
  };

  const message = normalizeMessage(frame);

  assert.equal(message.chatType, "group");
  assert.equal(message.chatId, "wrGROUP123");
});

test("空文本不产生消息", () => {
  const frame = { body: { text: { content: "   " }, from: { userid: "zhangsan" } } };

  assert.equal(normalizeMessage(frame), null);
});

test("不同 userid 的会话 key 不撞", () => {
  assert.notEqual(toSessionKey("a@b"), toSessionKey("a_b"));
});

test("会话 key 只含合法字符", () => {
  const key = toSessionKey("张三@szajyy.com");

  assert.match(key, /^[A-Za-z0-9._-]+$/);
});

test("去掉 @机器人 占位符", () => {
  assert.equal(stripMention("@技术支持机器人 退租怎么算"), "退租怎么算");
});

test("群聊里 @机器人 后说新会话能识别", () => {
  for (const raw of ["@技术支持助手 新会话", "@技术支持助手  新会话", "@RobotA /new", "@技术支持助手 @同事 新会话"]) {
    assert.equal(isNewSessionRequest(stripMention(raw)), true, `应识别：${raw}`);
  }
});

test("去掉开头的 @提及但不破坏正文邮箱", () => {
  assert.equal(stripMention("这个租客邮箱是 zhangsan@szajyy.com 对吗"), "这个租客邮箱是 zhangsan@szajyy.com 对吗");
  assert.equal(stripMention("@技术支持助手 邮箱 zhangsan@szajyy.com 是什么情况"), "邮箱 zhangsan@szajyy.com 是什么情况");
});

test("正文中间的 @ 不被当作提及", () => {
  assert.equal(stripMention("我在 @ 他的时候说过了"), "我在 @ 他的时候说过了");
});

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

test("归一化带上 msgid 供去重", () => {
  const frame = {
    body: { text: { content: "退租怎么算" }, from: { userid: "zhangsan" }, msgtype: "text", msgid: "MSG-001" },
  };

  const message = normalizeMessage(frame);

  assert.equal(message.msgid, "MSG-001");
});

test("没有 msgid 时归一化成 null（交给上层兜底）", () => {
  const frame = { body: { text: { content: "退租怎么算" }, from: { userid: "zhangsan" }, msgtype: "text" } };

  const message = normalizeMessage(frame);

  assert.equal(message.msgid, null);
});

test("纯图片消息归一化出 images，没有文字也不丢弃", () => {
  const frame = {
    body: {
      msgtype: "image",
      image: { url: "https://example.com/img1", aeskey: "key1" },
      from: { userid: "zhangsan" },
      msgid: "m1",
    },
  };

  const message = normalizeMessage(frame);

  assert.notEqual(message, null);
  assert.equal(message.text, "");
  assert.deepEqual(message.images, [{ url: "https://example.com/img1", aeskey: "key1" }]);
});

test("图文混排同时取出文字和图片", () => {
  const frame = {
    body: {
      msgtype: "mixed",
      mixed: {
        msg_item: [
          { msgtype: "text", text: { content: "这个报错怎么回事" } },
          { msgtype: "image", image: { url: "https://example.com/img2", aeskey: "key2" } },
          { msgtype: "image", image: { url: "https://example.com/img3" } },
        ],
      },
      from: { userid: "zhangsan" },
    },
  };

  const message = normalizeMessage(frame);

  assert.equal(message.text, "这个报错怎么回事");
  assert.deepEqual(message.images, [
    { url: "https://example.com/img2", aeskey: "key2" },
    { url: "https://example.com/img3", aeskey: undefined },
  ]);
});

test("纯文本消息 images 与 files 为空数组", () => {
  const frame = { body: { text: { content: "退租怎么算" }, from: { userid: "zhangsan" } } };

  const message = normalizeMessage(frame);
  assert.deepEqual(message.images, []);
  assert.deepEqual(message.files, []);
});

test("纯文件消息归一化出 files，没有文字也不丢弃", () => {
  const frame = {
    body: {
      msgtype: "file",
      file: { url: "https://example.com/report.xlsx", aeskey: "fkey1", filename: "月报.xlsx" },
      from: { userid: "zhangsan" },
      msgid: "f1",
    },
  };

  const message = normalizeMessage(frame);

  assert.notEqual(message, null);
  assert.equal(message.text, "");
  assert.deepEqual(message.images, []);
  assert.deepEqual(message.files, [
    { url: "https://example.com/report.xlsx", aeskey: "fkey1", filename: "月报.xlsx" },
  ]);
});

test("单聊和群聊引用文件消息时取出 quote.file 并标记 fromQuote", () => {
  const frame = {
    body: {
      msgtype: "text",
      chattype: "group",
      chatid: "wrGROUP999",
      text: { content: "@技术支持助手 帮我汇总一下这个表格" },
      quote: {
        msgtype: "file",
        file: { url: "https://example.com/quoted.docx", aeskey: "qkey1" },
      },
      from: { userid: "zhangsan" },
      msgid: "f2",
    },
  };

  const message = normalizeMessage(frame);

  assert.notEqual(message, null);
  assert.equal(message.chatType, "group");
  assert.equal(message.chatId, "wrGROUP999");
  assert.deepEqual(message.files, [
    { url: "https://example.com/quoted.docx", aeskey: "qkey1", fromQuote: true },
  ]);
});

test("纯图片消息也带空 files 数组", () => {
  const frame = {
    body: {
      msgtype: "image",
      image: { url: "https://example.com/img1" },
      from: { userid: "zhangsan" },
    },
  };

  assert.deepEqual(normalizeMessage(frame).files, []);
});

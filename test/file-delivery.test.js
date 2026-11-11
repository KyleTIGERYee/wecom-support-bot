import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_MEDIA_BYTES, deliverWorkspaceFiles, parseDeliveryMarkers } from "../src/file-delivery.js";

test("无标记的文本原样返回、文件列表为空", () => {
  const text = "结论是 62 家。\n\n第二段也原样保留。";
  assert.deepEqual(parseDeliveryMarkers(text), { cleanText: text, files: [] });
});

test("剥掉单标记行（中文冒号）", () => {
  const { cleanText, files } = parseDeliveryMarkers("查完了，共 62 家。\n[交付文件：result.csv]");
  assert.equal(cleanText, "查完了，共 62 家。");
  assert.deepEqual(files, ["result.csv"]);
});

test("英文冒号、文件名两端空格与整行首尾空格都认", () => {
  const { cleanText, files } = parseDeliveryMarkers("答案\n  [交付文件:  data .csv ]  ");
  assert.equal(cleanText, "答案");
  assert.deepEqual(files, ["data .csv"]);
});

test("多行标记按出现顺序返回并去重", () => {
  const { cleanText, files } = parseDeliveryMarkers("[交付文件：b.csv]\n中间结论\n[交付文件：a.csv]\n[交付文件：b.csv]");
  assert.deepEqual(files, ["b.csv", "a.csv"]);
  assert.equal(cleanText, "中间结论");
});

test("剥掉标记后前后空行收敛为一个，收尾不留空行", () => {
  const middle = parseDeliveryMarkers("第一段\n\n[交付文件：a.csv]\n\n第二段");
  assert.equal(middle.cleanText, "第一段\n\n第二段");

  const tail = parseDeliveryMarkers("结论\n\n[交付文件：a.csv]");
  assert.equal(tail.cleanText, "结论");

  const adjacent = parseDeliveryMarkers("结论\n[交付文件：a.csv]\n[交付文件：b.csv]\n补充");
  assert.equal(adjacent.cleanText, "结论\n补充");
});

test("行内嵌的标记（非独占行）不识别", () => {
  const text = "看这个 [交付文件：a.csv] 就行，文件在工作区。";
  assert.deepEqual(parseDeliveryMarkers(text), { cleanText: text, files: [] });
});

function recordingClient({ failUploadFor = [] } = {}) {
  const calls = { uploads: [], sends: [] };
  return {
    calls,
    async uploadMedia(buffer, options) {
      calls.uploads.push({ buffer, options });
      if (failUploadFor.includes(options.filename)) throw new Error("上传失败");
      return { type: "file", media_id: `MEDIA-${calls.uploads.length}`, created_at: "2026-11-11" };
    },
    async sendMessage(target, body) {
      calls.sends.push({ target, body });
    },
  };
}

async function workspaceWithFiles() {
  const dir = await mkdtemp(join(tmpdir(), "wsb-delivery-"));
  await writeFile(join(dir, "a.csv"), "id,name\n1,张三\n");
  await mkdir(join(dir, "reports"));
  await writeFile(join(dir, "reports/r.xlsx"), "xlsx-bytes");
  return dir;
}

test("逐个上传并发送 file 消息：type/filename/media_id/target 正确", async () => {
  const dir = await workspaceWithFiles();
  const client = recordingClient();

  const result = await deliverWorkspaceFiles({
    client,
    target: "CHAT-ID-1",
    workspaceDir: dir,
    files: ["a.csv", "reports/r.xlsx"],
    log: { warn() {} },
  });

  assert.deepEqual(result, { sent: ["a.csv", "reports/r.xlsx"], failed: [] });
  assert.deepEqual(client.calls.uploads[0].options, { type: "file", filename: "a.csv" });
  assert.deepEqual(client.calls.uploads[1].options, { type: "file", filename: "r.xlsx" });
  assert.equal(client.calls.uploads[0].buffer.toString(), "id,name\n1,张三\n");
  assert.deepEqual(client.calls.sends, [
    { target: "CHAT-ID-1", body: { msgtype: "file", file: { media_id: "MEDIA-1" } } },
    { target: "CHAT-ID-1", body: { msgtype: "file", file: { media_id: "MEDIA-2" } } },
  ]);
});

test("路径穿越（../）拒绝发送并记 failed，不调 uploadMedia", async () => {
  const dir = await workspaceWithFiles();
  await writeFile(join(dir, "..", "secret.txt"), "secret");
  const client = recordingClient();
  const warns = [];

  const result = await deliverWorkspaceFiles({
    client,
    target: "u1",
    workspaceDir: dir,
    files: ["../secret.txt", "/etc/hosts"],
    log: { warn(...args) { warns.push(args); } },
  });

  assert.deepEqual(result, { sent: [], failed: ["../secret.txt", "/etc/hosts"] });
  assert.equal(client.calls.uploads.length, 0);
  assert.equal(client.calls.sends.length, 0);
  assert.equal(warns.length, 2);
});

test("文件不存在记 failed 并继续", async () => {
  const dir = await workspaceWithFiles();
  const client = recordingClient();

  const result = await deliverWorkspaceFiles({
    client,
    target: "u1",
    workspaceDir: dir,
    files: ["missing.csv"],
    log: { warn() {} },
  });

  assert.deepEqual(result, { sent: [], failed: ["missing.csv"] });
  assert.equal(client.calls.uploads.length, 0);
});

test("超过大小上限记 failed，不调 uploadMedia（maxBytes 可注入，默认 20MB）", async () => {
  assert.equal(MAX_MEDIA_BYTES, 20 * 1024 * 1024);
  const dir = await workspaceWithFiles();
  const client = recordingClient();

  const result = await deliverWorkspaceFiles({
    client,
    target: "u1",
    workspaceDir: dir,
    files: ["a.csv"],
    log: { warn() {} },
    maxBytes: 3,
  });

  assert.deepEqual(result, { sent: [], failed: ["a.csv"] });
  assert.equal(client.calls.uploads.length, 0);
});

test("单个文件上传失败不影响后续文件", async () => {
  const dir = await workspaceWithFiles();
  const client = recordingClient({ failUploadFor: ["a.csv"] });

  const result = await deliverWorkspaceFiles({
    client,
    target: "CHAT-ID-2",
    workspaceDir: dir,
    files: ["a.csv", "reports/r.xlsx"],
    log: { warn() {} },
  });

  assert.deepEqual(result, { sent: ["reports/r.xlsx"], failed: ["a.csv"] });
  assert.equal(client.calls.sends.length, 1);
  assert.deepEqual(client.calls.sends[0], { target: "CHAT-ID-2", body: { msgtype: "file", file: { media_id: "MEDIA-2" } } });
});

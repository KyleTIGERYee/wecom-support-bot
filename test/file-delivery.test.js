import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_MEDIA_BYTES, GUARD_SAMPLE_BYTES, deliverWorkspaceFiles, parseDeliveryMarkers, sampleForGuard, snapshotWorkspace } from "../src/file-delivery.js";

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

test("snapshotWorkspace 记录工作区相对路径到 mtimeMs 的映射", async () => {
  const dir = await workspaceWithFiles();

  const snapshot = await snapshotWorkspace(dir);

  assert.deepEqual([...snapshot.keys()].sort(), ["a.csv", "reports/r.xlsx"]);
  for (const mtime of snapshot.values()) assert.equal(typeof mtime, "number");
});

test("snapshotWorkspace 对不存在的目录返回空快照", async () => {
  const snapshot = await snapshotWorkspace(join(tmpdir(), "wsb-no-such-workspace"));
  assert.equal(snapshot.size, 0);
});

test("本轮生成校验：mtime 晚于基线的文件放行", async () => {
  const dir = await workspaceWithFiles();
  // 基线时间整体前移 1 秒，等效于本轮内文件被改写
  const baseline = await snapshotWorkspace(dir);
  for (const [key, mtime] of baseline) baseline.set(key, mtime - 1000);
  const client = recordingClient();

  const result = await deliverWorkspaceFiles({
    client,
    target: "u1",
    workspaceDir: dir,
    files: ["a.csv", "reports/r.xlsx"],
    log: { warn() {} },
    baseline,
  });

  assert.deepEqual(result, { sent: ["a.csv", "reports/r.xlsx"], failed: [] });
  assert.equal(client.calls.sends.length, 2);
});

test("本轮生成校验：mtime 未变的旧文件记 failed、不投递", async () => {
  const dir = await workspaceWithFiles();
  const baseline = await snapshotWorkspace(dir); // 快照后没人再动文件
  const client = recordingClient();
  const warns = [];

  const result = await deliverWorkspaceFiles({
    client,
    target: "u1",
    workspaceDir: dir,
    files: ["a.csv", "reports/r.xlsx"],
    log: { warn(...args) { warns.push(args); } },
    baseline,
  });

  assert.deepEqual(result, { sent: [], failed: ["a.csv", "reports/r.xlsx"] });
  assert.equal(client.calls.uploads.length, 0);
  assert.equal(client.calls.sends.length, 0);
  assert.match(String(warns[0][1].message), /不是本轮新生成/);
});

test("本轮生成校验：不在基线里的新建文件放行", async () => {
  const dir = await workspaceWithFiles();
  const baseline = await snapshotWorkspace(dir);
  await writeFile(join(dir, "new.csv"), "id,name\n2,李四\n"); // 快照之后新建
  const client = recordingClient();

  const result = await deliverWorkspaceFiles({
    client,
    target: "u1",
    workspaceDir: dir,
    files: ["new.csv"],
    log: { warn() {} },
    baseline,
  });

  assert.deepEqual(result, { sent: ["new.csv"], failed: [] });
});

test("基线缺省时跳过本轮生成校验（向后兼容）", async () => {
  const dir = await workspaceWithFiles();
  const client = recordingClient();

  const result = await deliverWorkspaceFiles({
    client,
    target: "u1",
    workspaceDir: dir,
    files: ["a.csv"],
    log: { warn() {} },
    baseline: null,
  });

  assert.deepEqual(result, { sent: ["a.csv"], failed: [] });
});

test("guard 判 DENY 的文件不投递、记 failed，理由注明 guard 拦截", async () => {
  const dir = await workspaceWithFiles();
  const client = recordingClient();
  const warns = [];
  const seen = [];
  const guard = async (content, filename) => {
    seen.push({ content, filename });
    return { verdict: "DENY", reason: "含未脱敏手机号" };
  };

  const result = await deliverWorkspaceFiles({
    client,
    target: "u1",
    workspaceDir: dir,
    files: ["a.csv", "reports/r.xlsx"],
    log: { warn(...args) { warns.push(args); } },
    guard,
  });

  assert.deepEqual(result, { sent: [], failed: ["a.csv", "reports/r.xlsx"] });
  assert.equal(client.calls.uploads.length, 0);
  assert.equal(client.calls.sends.length, 0);
  assert.match(String(warns[0][1].message), /guard 拦截：含未脱敏手机号/);
  // 送审内容带文件名对应的正文
  assert.equal(seen[0].filename, "a.csv");
  assert.match(seen[0].content, /1,张三/);
});

test("guard 判 ALLOW 的文件正常投递", async () => {
  const dir = await workspaceWithFiles();
  const client = recordingClient();

  const result = await deliverWorkspaceFiles({
    client,
    target: "u1",
    workspaceDir: dir,
    files: ["a.csv"],
    log: { warn() {} },
    guard: async () => ({ verdict: "ALLOW" }),
  });

  assert.deepEqual(result, { sent: ["a.csv"], failed: [] });
  assert.equal(client.calls.sends.length, 1);
});

test("guard 送审内容超过阈值时按头/中/尾抽样，断口注明省略字节数", async () => {
  const content = "0123456789abcdef".repeat(4); // 64 字节
  const buffer = Buffer.from(content, "utf8");
  const tiny = { full: 32, head: 8, middle: 4, tail: 4 };
  /** @type {any} */
  let seenContent = null;
  const guard = async (/** @type {string} */ text) => {
    seenContent = text;
    return { verdict: "ALLOW" };
  };
  const dir = await mkdtemp(join(tmpdir(), "wsb-delivery-"));
  await writeFile(join(dir, "big.csv"), buffer);

  const result = await deliverWorkspaceFiles({
    client: recordingClient(),
    target: "u1",
    workspaceDir: dir,
    files: ["big.csv"],
    log: { warn() {} },
    guard,
    guardSampleBytes: tiny,
  });

  assert.deepEqual(result, { sent: ["big.csv"], failed: [] });
  const lines = String(seenContent).split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines[0], content.slice(0, 8));
  assert.match(lines[1], /^……中间省略 22 字节……$/);
  assert.equal(lines[2], content.slice(30, 34));
  assert.match(lines[3], /^……中间省略 26 字节……$/);
  assert.equal(lines[4], content.slice(60));
});

test("sampleForGuard 不超过阈值时全量返回，默认阈值 32/16/4/8 KB", () => {
  const small = Buffer.from("短内容", "utf8");
  assert.equal(sampleForGuard(small, { full: 1024, head: 1, middle: 1, tail: 1 }), "短内容");
  assert.deepEqual(GUARD_SAMPLE_BYTES, { full: 32 * 1024, head: 16 * 1024, middle: 4 * 1024, tail: 8 * 1024 });
});

test("二进制文件（含 NUL 字节）不做 guard 审核，直接投递", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsb-delivery-"));
  await writeFile(join(dir, "img.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]));
  const client = recordingClient();
  let guardCalls = 0;

  const result = await deliverWorkspaceFiles({
    client,
    target: "u1",
    workspaceDir: dir,
    files: ["img.bin"],
    log: { warn() {} },
    guard: async () => {
      guardCalls += 1;
      return { verdict: "DENY", reason: "不该被调用" };
    },
  });

  assert.deepEqual(result, { sent: ["img.bin"], failed: [] });
  assert.equal(guardCalls, 0);
  assert.equal(client.calls.sends.length, 1);
});

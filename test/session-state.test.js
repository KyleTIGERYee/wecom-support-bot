import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionState } from "../src/session-state.js";

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "wsb-session-"));
  return join(dir, "session-state.json");
}

test("新会话默认未碰过 BI", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath });

  assert.equal(state.isBiTouched("wx-abc"), false);
});

test("标记过的会话碰过 BI", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath });

  state.markBiTouched("wx-abc");

  assert.equal(state.isBiTouched("wx-abc"), true);
});

test("标记不影响其他会话", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath });

  state.markBiTouched("wx-abc");

  assert.equal(state.isBiTouched("wx-xyz"), false);
});

test("flush 后新实例能读回标记（跨重启保留）", async () => {
  const storePath = await tempStore();
  const first = createSessionState({ storePath });
  first.markBiTouched("wx-abc");
  await first.flush();

  const second = createSessionState({ storePath });
  await second.load();

  assert.equal(second.isBiTouched("wx-abc"), true);
});

test("状态文件不存在时视为空状态", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath });

  await state.load();

  assert.equal(state.isBiTouched("wx-abc"), false);
});

test("状态文件损坏时保守地全量过 guard", async () => {
  const storePath = await tempStore();
  await mkdir(join(storePath, ".."), { recursive: true });
  await writeFile(storePath, "{ this is not json", "utf8");

  const state = createSessionState({ storePath });
  await state.load();

  assert.equal(state.isBiTouched("wx-any-session"), true);
});

test("flush 写出的文件是可解析的 JSON", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath });
  state.markBiTouched("wx-abc");

  await state.flush();

  const raw = await readFile(storePath, "utf8");
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed.touched), ["wx-abc"]);
});

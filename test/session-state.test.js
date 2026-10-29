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

test("新会话生成新的会话 ID", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath });

  const first = state.resolveSessionId("wx-abc");
  const second = state.startNewSession("wx-abc");

  assert.notEqual(first, second);
});

test("新会话后粘性标记被清除", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath });
  state.markBiTouched("wx-abc-g1");

  state.startNewSession("wx-abc");

  assert.equal(state.isBiTouched("wx-abc-g1"), false);
});

test("新会话的代号跨重启保留", async () => {
  const storePath = await tempStore();
  const first = createSessionState({ storePath });
  const id = first.startNewSession("wx-abc");
  await first.flush();

  const second = createSessionState({ storePath });
  await second.load();

  assert.equal(second.resolveSessionId("wx-abc"), id);
});

test("从未开过新会话时用默认代号", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath });

  assert.equal(state.resolveSessionId("wx-abc"), "wx-abc-g1");
});

test("多次开新会话代号递增", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath });

  state.startNewSession("wx-abc");
  const third = state.startNewSession("wx-abc");

  assert.equal(third, "wx-abc-g3");
});

const ROTATION = { idleMs: 4 * 60 * 60 * 1000, maxInputTokens: 60000 };

test("闲置超过阈值时自动换下一代会话", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath, rotation: ROTATION });
  const startedAt = Date.parse("2026-10-29T09:00:00.000Z");

  const first = state.resolveSessionId("wx-abc", startedAt);
  state.recordActivity("wx-abc", { at: startedAt, inputTokens: 1000 });
  const later = state.resolveSessionId("wx-abc", startedAt + ROTATION.idleMs + 1);

  assert.equal(first, "wx-abc-g1");
  assert.equal(later, "wx-abc-g2");
});

test("闲置未超阈值时沿用同一会话", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath, rotation: ROTATION });
  const startedAt = Date.parse("2026-10-29T09:00:00.000Z");

  const first = state.resolveSessionId("wx-abc", startedAt);
  state.recordActivity("wx-abc", { at: startedAt, inputTokens: 1000 });
  const soon = state.resolveSessionId("wx-abc", startedAt + ROTATION.idleMs - 1000);

  assert.equal(soon, first);
});

test("上下文超过 token 阈值时自动换会话", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath, rotation: ROTATION });
  const now = Date.parse("2026-10-29T09:00:00.000Z");

  const first = state.resolveSessionId("wx-abc", now);
  state.recordActivity("wx-abc", { at: now, inputTokens: ROTATION.maxInputTokens + 1 });
  const next = state.resolveSessionId("wx-abc", now + 1000);

  assert.equal(first, "wx-abc-g1");
  assert.equal(next, "wx-abc-g2");
});

test("自动换代也会作废旧代粘性标记", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath, rotation: ROTATION });
  const now = Date.parse("2026-10-29T09:00:00.000Z");
  state.resolveSessionId("wx-abc", now);
  state.markBiTouched("wx-abc-g1");

  state.recordActivity("wx-abc", { at: now, inputTokens: ROTATION.maxInputTokens + 1 });
  state.resolveSessionId("wx-abc", now + 1000);

  assert.equal(state.isBiTouched("wx-abc-g1"), false);
});

test("换代之后不会因为同一份旧活动重复换代", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath, rotation: ROTATION });
  const now = Date.parse("2026-10-29T09:00:00.000Z");
  state.resolveSessionId("wx-abc", now);

  state.recordActivity("wx-abc", { at: now, inputTokens: ROTATION.maxInputTokens + 1 });
  const second = state.resolveSessionId("wx-abc", now + 1000);
  const again = state.resolveSessionId("wx-abc", now + 2000);

  assert.equal(second, "wx-abc-g2");
  assert.equal(again, "wx-abc-g2");
});

test("活动记录跨重启保留", async () => {
  const storePath = await tempStore();
  const now = Date.parse("2026-10-29T09:00:00.000Z");
  const first = createSessionState({ storePath, rotation: ROTATION });
  first.resolveSessionId("wx-abc", now);
  first.recordActivity("wx-abc", { at: now, inputTokens: ROTATION.maxInputTokens + 1 });
  await first.flush();

  const second = createSessionState({ storePath, rotation: ROTATION });
  await second.load();

  assert.equal(second.resolveSessionId("wx-abc", now + 1000), "wx-abc-g2");
});

const DAY = 24 * 60 * 60 * 1000;
const DAILY = { idleMs: DAY, maxAgeMs: DAY, maxInputTokens: 60000 };

test("会话从创建起满 24 小时自动换代", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath, rotation: DAILY });
  const born = Date.parse("2026-10-29T00:00:00.000Z");

  const first = state.resolveSessionId("wx-abc", born);
  const stillSame = state.resolveSessionId("wx-abc", born + DAY - 1000);
  const next = state.resolveSessionId("wx-abc", born + DAY + 1);

  assert.equal(first, "wx-abc-g1");
  assert.equal(stillSame, "wx-abc-g1");
  assert.equal(next, "wx-abc-g2");
});

test("换代后 24 小时重新计时", async () => {
  const storePath = await tempStore();
  const state = createSessionState({ storePath, rotation: DAILY });
  const born = Date.parse("2026-10-29T00:00:00.000Z");

  state.resolveSessionId("wx-abc", born);
  const second = state.resolveSessionId("wx-abc", born + DAY + 1);
  const within = state.resolveSessionId("wx-abc", born + DAY + 1000);
  const third = state.resolveSessionId("wx-abc", born + 2 * DAY + 2);

  assert.equal(second, "wx-abc-g2");
  assert.equal(within, "wx-abc-g2");
  assert.equal(third, "wx-abc-g3");
});

test("老状态文件只有代号没有起始时间时，首次访问自动换代一次", async () => {
  const storePath = await tempStore();
  await mkdir(join(storePath, ".."), { recursive: true });
  await writeFile(storePath, JSON.stringify({ generation: { "wx-old": 3 }, touched: { "wx-old-g3": true } }), "utf8");

  const state = createSessionState({ storePath, rotation: DAILY });
  await state.load();
  const now = Date.parse("2026-10-29T08:00:00.000Z");
  const rotated = state.resolveSessionId("wx-old", now);
  const again = state.resolveSessionId("wx-old", now + 1000);

  assert.equal(rotated, "wx-old-g4");
  assert.equal(again, "wx-old-g4");
  assert.equal(state.isBiTouched("wx-old-g3"), false);
});

test("会话起始时间跨重启保留，不会重启就换代", async () => {
  const storePath = await tempStore();
  const born = Date.parse("2026-10-29T00:00:00.000Z");
  const first = createSessionState({ storePath, rotation: DAILY });
  const id = first.resolveSessionId("wx-abc", born);
  await first.flush();

  const second = createSessionState({ storePath, rotation: DAILY });
  await second.load();

  assert.equal(second.resolveSessionId("wx-abc", born + DAY - 1000), id);
  assert.equal(second.resolveSessionId("wx-abc", born + DAY + 1), "wx-abc-g2");
});

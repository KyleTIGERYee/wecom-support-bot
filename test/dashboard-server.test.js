import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";

import { listLocalIpv4Addresses, startDashboardServer } from "../dashboard/server.js";

const lanIp = listLocalIpv4Addresses()[0] ?? null;

async function serverFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "wsb-dashboard-http-"));
  const instance = join(root, "instance");
  const piDir = join(instance, "sessions");
  await mkdir(piDir, { recursive: true });
  await mkdir(join(instance, "images"));
  await writeFile(join(instance, "images", "http-1-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const sources = {
    instances: [{ id: "main", inboxPath: join(instance, "inbox.jsonl"), logPath: join(instance, "bot.log"), piDir, imagesDir: join(instance, "images") }],
    rawLogPath: join(root, "launchd.log"),
    userMapPath: join(root, "users.json"),
  };
  await writeFile(sources.inboxPath ?? sources.instances[0].inboxPath, JSON.stringify({ msgid: "http-1", userId: "u1", chatId: "", chatType: "single", question: "合成 <img src=x onerror=alert(1)>", receivedAt: "2026-11-12T01:00:00.000Z", state: "answered" }));
  await writeFile(sources.instances[0].logPath, `[2026-11-12T01:00:01.000Z] INFO 答复完成 ${JSON.stringify({ msgid: "http-1", sessionKey: "wx-synthetic-http-g1", route: "quick", mode: "inline", channel: "stream", totalMs: 1000, rounds: 1 })}\n`);
  await writeFile(sources.rawLogPath, "");
  await writeFile(sources.userMapPath, JSON.stringify({ u1: { name: "合成用户", b64: "dQ" } }));
  const sessionKey = "wx-synthetic-http-g1";
  await writeFile(join(piDir, `2026-11-12T01-00-00-000Z_${sessionKey}.jsonl`), [
    JSON.stringify({ type: "session", id: sessionKey, timestamp: "2026-11-12T01:00:00.000Z" }),
    JSON.stringify({ type: "message", timestamp: "2026-11-12T01:00:00.100Z", message: { role: "user", content: [{ type: "text", text: "合成 <img src=x onerror=alert(1)>" }] } }),
    JSON.stringify({ type: "message", timestamp: "2026-11-12T01:00:00.900Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "最终 <script>alert(1)</script>" }] } }),
  ].join("\n"));
  const publicDir = join(root, "public");
  await mkdir(publicDir);
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>合成看板</title><div id=app></div>");
  await writeFile(join(publicDir, "app.js"), "// synthetic");
  await writeFile(join(publicDir, "styles.css"), "body{}");
  const running = await startDashboardServer({ port: 0, host: options.host, sources, publicDir });
  t.after(() => running.close());
  return { ...running, sources, root };
}

test("HTTP 只监听 loopback，首屏不含时间线，详情按需返回且带安全响应头", async (t) => {
  const running = await serverFixture(t);
  assert.equal(running.server.address().address, "127.0.0.1");

  const bootstrapResponse = await fetch(`${running.url}/api/bootstrap`);
  assert.equal(bootstrapResponse.status, 200);
  assert.match(bootstrapResponse.headers.get("content-type"), /^application\/json/);
  assert.match(bootstrapResponse.headers.get("content-security-policy"), /default-src 'self'/);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.defaultDate, "2026-11-12");

  const day = await (await fetch(`${running.url}/api/day?date=2026-11-12`)).json();
  assert.equal(day.turns[0].question, "合成 <img src=x onerror=alert(1)>");
  assert.equal("timeline" in day.turns[0], false);
  assert.equal("answer" in day.turns[0], false);

  const detailResponse = await fetch(`${running.url}/api/turns/http-1`);
  const detail = await detailResponse.json();
  assert.equal(detail.answer.text, "最终 <script>alert(1)</script>");
  assert.ok(Array.isArray(detail.timeline));
  assert.equal(detail.delivery.bodyArchived, false);
  const image = await fetch(`${running.url}/api/turns/http-1/images/1`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal((await image.arrayBuffer()).byteLength, 4);
  assert.equal((await fetch(`${running.url}/api/turns/http-1/images/2`)).status, 404);
  assert.equal((await fetch(`${running.url}/api/turns/not-found`)).status, 404);
  assert.equal((await fetch(`${running.url}/api/not-allowed`)).status, 404);
});

test("静态资源仅开放固定白名单，路径穿越和伪造 Host 被拒绝", async (t) => {
  const running = await serverFixture(t);
  const index = await fetch(`${running.url}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /^text\/html/);
  assert.match(await index.text(), /合成看板/);
  assert.equal((await fetch(`${running.url}/app.js`)).status, 200);
  assert.equal((await fetch(`${running.url}/styles.css`)).status, 200);
  for (const path of ["/..%2fpackage.json", "/%2e%2e/package.json", "/package.json", "/api/turns/http-1/images/..%2f1"]) {
    const response = await rawRequest(running, path);
    assert.equal(response.status, 404, path);
  }
  const hostile = await rawRequest(running, "/api/bootstrap", { Host: "attacker.invalid" });
  assert.equal(hostile.status, 403);
});

test("默认 loopback 监听拒绝局域网接口 Host", { skip: lanIp ? false : "本机没有非 internal IPv4 地址" }, async (t) => {
  assert.ok(lanIp);
  const running = await serverFixture(t);
  const loopback = await rawRequest(running, "/api/bootstrap", { Host: `127.0.0.1:${running.port}` });
  assert.equal(loopback.status, 200);
  const lanHost = await rawRequest(running, "/api/bootstrap", { Host: `${lanIp}:${running.port}` });
  assert.equal(lanHost.status, 403);
});

test("host=0.0.0.0 时接受回环和本机接口 IP，拒绝其他 Host", { skip: lanIp ? false : "本机没有非 internal IPv4 地址" }, async (t) => {
  assert.ok(lanIp);
  const running = await serverFixture(t, { host: "0.0.0.0" });
  const loopback = await rawRequest(running, "/api/bootstrap", { Host: `127.0.0.1:${running.port}` });
  assert.equal(loopback.status, 200);
  const lanHost = await rawRequest(running, "/api/bootstrap", { Host: `${lanIp}:${running.port}` });
  assert.equal(lanHost.status, 200);
  const domain = await rawRequest(running, "/api/bootstrap", { Host: `evil.example:${running.port}` });
  assert.equal(domain.status, 403);
  const externalIp = await rawRequest(running, "/api/bootstrap", { Host: `203.0.113.7:${running.port}` });
  assert.equal(externalIp.status, 403);
});

test("刷新操作重新只读扫描，不需要重启服务", async (t) => {
  const running = await serverFixture(t);
  const second = { msgid: "http-2", userId: "u1", chatId: "", chatType: "single", question: "刷新后的合成问题", receivedAt: "2026-11-13T01:00:00.000Z", state: "answered" };
  await writeFile(running.sources.instances[0].inboxPath, JSON.stringify({ msgid: "http-1", userId: "u1", chatId: "", chatType: "single", question: "合成问题", receivedAt: "2026-11-12T01:00:00.000Z", state: "answered" }) + "\n" + JSON.stringify(second));
  await writeFile(running.sources.instances[0].logPath, `[2026-11-12T01:00:01.000Z] INFO 答复完成 ${JSON.stringify({ msgid: "http-1", sessionKey: "wx-synthetic-http-g1", channel: "stream", totalMs: 1000 })}\n[2026-11-13T01:00:01.000Z] INFO 答复完成 ${JSON.stringify({ msgid: "http-2", sessionKey: "wx-synthetic-http-g1", channel: "push", totalMs: 1000 })}\n`);
  const refreshed = await fetch(`${running.url}/api/refresh`, { method: "POST" });
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).defaultDate, "2026-11-13");
  const day = await (await fetch(`${running.url}/api/day?date=2026-11-13`)).json();
  assert.equal(day.summary.questions, 1);
  assert.equal(day.turns[0].id, "http-2");
});

function rawRequest(running, path, headers = {}) {
  const port = running.server.address().port;
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode }));
    });
    request.on("error", reject);
    request.end();
  });
}

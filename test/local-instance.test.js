import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectDir, "scripts/local-instance.js");

async function runCli(args, options = {}) {
  const { allowFailure = false, ...execOptions } = options;
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: projectDir,
      ...execOptions,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (!allowFailure) throw error;
    return JSON.parse(error.stdout);
  }
}

async function startModelServer({ failModel, mainReply = "ok" } = {}) {
  const calls = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body);
      calls.push({ ...payload, authorization: request.headers.authorization });
      if (payload.model === failModel) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "invalid credential" }));
        return;
      }
      const messageText = payload.messages
        .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
        .join("\n");
      const isGuard = messageText.includes("机器人的答复");
      const isConnectionTest = messageText.includes("连接测试，请回复 ok");
      const reply = isGuard
        ? messageText.includes("13800138000")
          ? "DENY\n包含手机号"
          : "ALLOW"
        : isConnectionTest
          ? "ok"
          : typeof mainReply === "function"
            ? mainReply(payload)
            : mainReply;
      const completion = typeof reply === "string" ? { content: reply } : reply;
      const delta = { role: "assistant" };
      if (completion.content !== undefined) delta.content = completion.content;
      if (completion.toolCalls) delta.tool_calls = completion.toolCalls;
      const finishReason = completion.toolCalls ? "tool_calls" : "stop";
      if (payload.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        response.write(
          `data: ${JSON.stringify({ id: "local-completion", object: "chat.completion.chunk", created: 0, model: payload.model, choices: [{ index: 0, delta, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: "local-completion",
          object: "chat.completion",
          created: 0,
          model: payload.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: completion.content ?? null,
                ...(completion.toolCalls ? { tool_calls: completion.toolCalls } : {}),
              },
              finish_reason: finishReason,
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function makeTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "wsb-local-instance-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function initInstance({
  instanceDir,
  sources = [],
  baseUrl,
  apiKey = "test-key",
  model = "main-model",
  guardModel,
  template,
  allowFailure = false,
}) {
  const args = ["init", "--instance-dir", instanceDir];
  if (template) args.push("--template", template);
  for (const source of sources) {
    args.push("--source", source.path);
    if (source.scope !== undefined) args.push("--scope", source.scope);
  }
  args.push("--base-url", baseUrl, "--api-key", apiKey, "--model", model);
  if (guardModel) args.push("--guard-model", guardModel);
  return runCli(args, { allowFailure });
}

test("公开初始化流程复制共享目录并测试主模型与 Guard 模型", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const source = join(root, "shared-docs");
  const instanceDir = join(root, "instance");
  await mkdir(source);
  await writeFile(join(source, "handbook.md"), "退租审批需要两级审批。\n");

  const result = await initInstance({
    instanceDir,
    template: "team",
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
    guardModel: "guard-model",
  });

  assert.equal(result.ready, true);
  assert.deepEqual(
    models.calls.map((call) => call.model).sort(),
    ["guard-model", "main-model"],
  );

  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(saved.contextSources.length, 1);
  assert.equal(saved.contextSources[0].scope, "shared");
  assert.equal(saved.contextSources[0].type, "directory");
  assert.match(saved.contextSources[0].localPath, /^context\//);
  assert.equal(JSON.stringify(saved).includes(source), false);
  assert.equal(
    await readFile(join(instanceDir, saved.contextSources[0].localPath, "handbook.md"), "utf8"),
    "退租审批需要两级审批。\n",
  );
});

test("公开初始化流程接受单文件和 zip 资源包并分别保存共享范围", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const singleFile = join(root, "single.md");
  const packageDocs = join(root, "package-docs");
  const packagePath = join(root, "context.zip");
  const instanceDir = join(root, "instance");
  await writeFile(singleFile, "单文件上下文。\n");
  await mkdir(packageDocs);
  await writeFile(join(packageDocs, "rules.md"), "资源包上下文。\n");
  await execFileAsync("zip", ["-q", "-r", packagePath, "package-docs"], { cwd: root });

  await initInstance({
    instanceDir,
    sources: [
      { path: singleFile, scope: "shared" },
      { path: packagePath, scope: "private" },
    ],
    baseUrl: models.baseUrl,
  });

  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.deepEqual(
    saved.contextSources.map(({ type, scope }) => ({ type, scope })),
    [
      { type: "file", scope: "shared" },
      { type: "package", scope: "private" },
    ],
  );
  assert.equal(
    await readFile(join(instanceDir, saved.contextSources[0].localPath), "utf8"),
    "单文件上下文。\n",
  );
  assert.equal(
    await readFile(join(instanceDir, saved.contextSources[1].localPath, "package-docs/rules.md"), "utf8"),
    "资源包上下文。\n",
  );
});

test("团队实例把个人私有来源列入失败检查且不复制", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const privateSource = join(root, "private.md");
  const instanceDir = join(root, "instance");
  await writeFile(privateSource, "私人资料。\n");

  const result = await initInstance({
    instanceDir,
    template: "team",
    sources: [{ path: privateSource, scope: "private" }],
    baseUrl: models.baseUrl,
    allowFailure: true,
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.contextSources[0].status, "error");
  assert.match(result.checks.contextSources[0].reason, /团队实例只能使用明确共享的来源/);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(saved.ready, false);
  assert.equal(saved.contextSources[0].localPath, undefined);
});

test("未选择本地来源时初始化检查明确报告未就绪", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const instanceDir = join(root, "instance");

  const result = await initInstance({
    instanceDir,
    baseUrl: models.baseUrl,
    allowFailure: true,
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.context.status, "error");
  assert.match(result.checks.context.reason, /未选择本地上下文来源/);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(saved.ready, false);
});

test("不可读的本地来源进入失败检查而不是中断为无结果", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const instanceDir = join(root, "instance");
  const missingSource = join(root, "missing.md");

  const result = await initInstance({
    instanceDir,
    sources: [{ path: missingSource, scope: "shared" }],
    baseUrl: models.baseUrl,
    allowFailure: true,
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.contextSources[0].status, "error");
  assert.match(result.checks.contextSources[0].reason, /本地来源不可读/);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(saved.ready, false);
});

test("空目录在初始化检查中失败而不是假就绪", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const source = join(root, "empty-docs");
  const instanceDir = join(root, "instance");
  await mkdir(source);

  const result = await initInstance({
    instanceDir,
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
    allowFailure: true,
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.contextSources[0].status, "error");
  assert.match(result.checks.contextSources[0].reason, /没有可读取的文件/);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(saved.ready, false);
});

test("空 zip 在初始化检查中失败而不是假就绪", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const emptyPackage = join(root, "empty-package");
  const packagePath = join(root, "empty.zip");
  const instanceDir = join(root, "instance");
  await mkdir(emptyPackage);
  await execFileAsync("zip", ["-q", "-r", packagePath, "empty-package"], { cwd: root });

  const result = await initInstance({
    instanceDir,
    sources: [{ path: packagePath, scope: "shared" }],
    baseUrl: models.baseUrl,
    allowFailure: true,
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.contextSources[0].status, "error");
  assert.match(result.checks.contextSources[0].reason, /没有可读取的文件/);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(saved.ready, false);
});

test("Guard 模型连接失败时实例不启用并保留检查原因", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer({ failModel: "broken-guard" });
  t.after(() => models.close());
  const source = join(root, "docs.md");
  const instanceDir = join(root, "instance");
  await writeFile(source, "共享资料。\n");

  const result = await initInstance({
    instanceDir,
    template: "team",
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
    guardModel: "broken-guard",
    allowFailure: true,
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.mainModel.status, "ok");
  assert.equal(result.checks.guardModel.status, "error");
  assert.match(result.checks.guardModel.reason, /HTTP 401/);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(saved.ready, false);
});

test("初始化后删除原始目录仍可从本地副本完成问答和 Guard 重写", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const source = join(root, "shared-docs");
  const instanceDir = join(root, "instance");
  const fakePi = join(root, "fake-pi.js");
  const piLog = join(root, "pi-log.jsonl");
  await mkdir(join(source, "raw"), { recursive: true });
  await writeFile(join(source, "raw/handbook.md"), "LOCAL_ONLY_RULE：退租审批需要两级审批。\n");
  await initInstance({
    instanceDir,
    template: "team",
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
    guardModel: "guard-model",
  });
  await rm(source, { recursive: true });
  const localHandbookPath = join(instanceDir, "context/001-shared-docs/raw/handbook.md");
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = args.at(-1);
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ prompt, agentDir: process.env.PI_CODING_AGENT_DIR, roots: JSON.parse(process.env.WECOM_BOT_ROOTS || "[]") }) + "\\n");
const rework = prompt.includes("上一条答复未通过隐私检查");
const found = rework || readFileSync(${JSON.stringify(localHandbookPath)}, "utf8").includes("LOCAL_ONLY_RULE");
if (!rework) {
  console.log(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: ${JSON.stringify(localHandbookPath)} } }));
  console.log(JSON.stringify({ type: "tool_execution_end", toolName: "read", args: { path: ${JSON.stringify(localHandbookPath)} }, isError: false }));
}
const answer = rework ? "退租审批需要两级审批。" : found ? "退租审批需要两级审批。13800138000" : "没有找到本地资料";
console.log(JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "python3 /local/scripts/bi_query.py SELECT" } }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], usage: { input: 10 } } }));
`,
    { mode: 0o755 },
  );

  const result = await runCli(
    ["ask", "--instance-dir", instanceDir, "--question", "退租审批需要几级？", "--session-key", "colleague"],
    { env: { ...process.env, WECOM_BOT_PI_BINARY: fakePi, FAKE_PI_LOG: piLog } },
  );

  assert.equal(result.finalText, "退租审批需要两级审批。");
  assert.equal(result.rounds, 2);
  assert.equal(result.guarded, true);
  assert.equal(result.loadDepth, "raw");
  assert.equal(result.loadedResources[0].path, localHandbookPath);
  const calls = (await readFile(piLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].prompt.includes("LOCAL_ONLY_RULE"), false);
  for (const call of calls) {
    assert.equal(call.prompt.includes(source), false);
    assert.equal(call.agentDir, join(instanceDir, "agent"));
    assert.deepEqual(call.roots, [join(instanceDir, "context")]);
  }
  const state = JSON.parse(await readFile(join(instanceDir, "data/session-state.json"), "utf8"));
  assert.equal(Object.keys(state.generation).length, 1);
});

test("本地简单概念首轮只见目录，读取概念页后公开来源时间和深度", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const source = join(root, "shared-docs");
  const instanceDir = join(root, "instance");
  const fakePi = join(root, "fake-pi.js");
  const piLog = join(root, "pi-log.jsonl");
  const conceptDir = join(source, "wiki/概念");
  const rawDir = join(source, "raw/退租");
  await mkdir(conceptDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  await writeFile(
    join(conceptDir, "退租.md"),
    "---\nsummary: 退租概念摘要\nupdated: 2026-10-01\nstatus: current\nraw_source:\n  - raw/退租/审批.md\n---\nCONCEPT_FULL_BODY：退租是结束租赁关系。\n",
  );
  await writeFile(join(rawDir, "审批.md"), "RAW_FULL_BODY：退租审批需要两级审批。\n");
  await initInstance({
    instanceDir,
    template: "team",
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
  });
  const localConceptPath = join(instanceDir, "context/001-shared-docs/wiki/概念/退租.md");
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = args.at(-1);
const systemPromptPath = args[args.indexOf("--append-system-prompt") + 1];
const systemPrompt = readFileSync(systemPromptPath, "utf8");
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ prompt, systemPrompt }) + "\\n");
const concept = readFileSync(${JSON.stringify(localConceptPath)}, "utf8");
console.log(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: ${JSON.stringify(localConceptPath)} } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolName: "read", args: { path: ${JSON.stringify(localConceptPath)} }, isError: false }));
const answer = concept.includes("CONCEPT_FULL_BODY") ? "退租是结束租赁关系。" : "没有找到概念资料";
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } }));
`,
    { mode: 0o755 },
  );

  const result = await runCli(
    ["ask", "--instance-dir", instanceDir, "--question", "退租是什么？", "--session-key", "concept-colleague"],
    { env: { ...process.env, WECOM_BOT_PI_BINARY: fakePi, FAKE_PI_LOG: piLog } },
  );

  assert.equal(result.finalText, "退租是结束租赁关系。");
  assert.equal(result.loadDepth, "concept");
  assert.equal(result.loadedResources.length, 1);
  assert.equal(result.loadedResources[0].source, "shared-docs");
  assert.equal(result.loadedResources[0].path, localConceptPath);
  assert.equal(result.loadedResources[0].depth, "concept");
  assert.equal(result.loadedResources[0].sourceTime, "2026-10-01");
  assert.equal(result.loadedResources[0].validity, "current");
  const calls = (await readFile(piLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /wiki\/概念\/退租\.md/);
  assert.match(calls[0].prompt, /2026-10-01/);
  assert.equal(calls[0].prompt.includes("CONCEPT_FULL_BODY"), false);
  assert.equal(calls[0].prompt.includes("RAW_FULL_BODY"), false);
  const rawCatalogLine = calls[0].prompt.split("\n").find((line) => line.includes("raw/退租/审批.md | depth: raw"));
  assert.match(rawCatalogLine, /source_time: null/);
  assert.equal(calls[0].systemPrompt.includes("CONCEPT_FULL_BODY"), false);
  assert.equal(calls[0].systemPrompt.includes("RAW_FULL_BODY"), false);
});

test("空白实例的来源也必须明确共享或个人私有范围", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const source = join(root, "docs.md");
  const instanceDir = join(root, "instance");
  await writeFile(source, "资料。\n");

  const result = await initInstance({
    instanceDir,
    sources: [{ path: source }],
    baseUrl: models.baseUrl,
    allowFailure: true,
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.contextSources[0].status, "error");
  assert.match(result.checks.contextSources[0].reason, /明确共享或个人私有范围/);
});

test("实例配置可跨进程重读且两个实例的会话与运行状态独立", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const fakePi = join(root, "fake-pi.js");
  const piLog = join(root, "pi-log.jsonl");
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = args.at(-1);
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ sessionId: args[args.indexOf("--session-id") + 1], agentDir: process.env.PI_CODING_AGENT_DIR }) + "\\n");
const resourcePath = prompt.match(/\\| path: ([^|]+?) \\| depth:/)?.[1]?.trim();
const resource = resourcePath ? readFileSync(resourcePath, "utf8") : "";
if (resourcePath) {
  console.log(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: resourcePath } }));
  console.log(JSON.stringify({ type: "tool_execution_end", toolName: "read", args: { path: resourcePath }, isError: false }));
}
const answer = resource.includes("RULE_A") ? "答案 A" : resource.includes("RULE_B") ? "答案 B" : "没有资料";
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } }));
`,
    { mode: 0o755 },
  );
  const env = { ...process.env, WECOM_BOT_PI_BINARY: fakePi, FAKE_PI_LOG: piLog };

  async function initializeAndAsk(name, marker) {
    const source = join(root, `${name}.md`);
    const instanceDir = join(root, name);
    await writeFile(source, `${marker}\n`);
    await initInstance({
      instanceDir,
      sources: [{ path: source, scope: "shared" }],
      baseUrl: models.baseUrl,
    });
    const first = await runCli(
      ["ask", "--instance-dir", instanceDir, "--question", "规则是什么？", "--session-key", "same-colleague"],
      { env },
    );
    const second = await runCli(
      ["ask", "--instance-dir", instanceDir, "--question", "再问一次", "--session-key", "same-colleague"],
      { env },
    );
    return { instanceDir, first, second };
  }

  const a = await initializeAndAsk("instance-a", "RULE_A");
  const b = await initializeAndAsk("instance-b", "RULE_B");

  assert.equal(a.first.finalText, "答案 A");
  assert.equal(a.second.sessionId, a.first.sessionId);
  assert.equal(b.first.finalText, "答案 B");
  assert.notEqual(b.first.instanceId, a.first.instanceId);
  assert.notEqual(b.first.sessionId, a.first.sessionId);
  const stateA = JSON.parse(await readFile(join(a.instanceDir, "data/session-state.json"), "utf8"));
  const stateB = JSON.parse(await readFile(join(b.instanceDir, "data/session-state.json"), "utf8"));
  assert.notDeepEqual(Object.keys(stateA.generation), Object.keys(stateB.generation));
  assert.notEqual(stateA.startedAt[Object.keys(stateA.startedAt)[0]], undefined);
  assert.notEqual(stateB.startedAt[Object.keys(stateB.startedAt)[0]], undefined);
  const calls = (await readFile(piLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    calls.map((call) => call.agentDir),
    [join(a.instanceDir, "agent"), join(a.instanceDir, "agent"), join(b.instanceDir, "agent"), join(b.instanceDir, "agent")],
  );
});

test("真实 pi 使用初始化生成的模型配置读取本地副本", { timeout: 60000 }, async (t) => {
  const realPi = join(homedir(), ".pi-support/bin/pi");
  if (!existsSync(realPi)) {
    t.skip("本机未安装隔离 pi，跳过真实 pi 公开工作流验收");
    return;
  }
  const root = await makeTempDir(t);
  let localCopyPath = "";
  const models = await startModelServer({
    mainReply: (payload) => {
      const toolMessages = payload.messages.filter((message) => message.role === "tool");
      if (toolMessages.length === 0) {
        return {
          toolCalls: [
            {
              index: 0,
              id: "call-read-local-copy",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: localCopyPath }) },
            },
          ],
        };
      }
      return JSON.stringify(toolMessages).includes("REAL_PI_CONTEXT_MARKER")
        ? "REAL_PI_LOCAL_OK"
        : "REAL_PI_LOCAL_READ_MISSING";
    },
  });
  t.after(() => models.close());
  const source = join(root, "docs.md");
  const instanceDir = join(root, "instance");
  await writeFile(source, "REAL_PI_CONTEXT_MARKER\n");
  await initInstance({
    instanceDir,
    template: "team",
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
    apiKey: "real-pi-key",
    model: "real-main-model",
    guardModel: "real-guard-model",
  });
  localCopyPath = join(instanceDir, "context/001-docs.md");

  const result = await runCli(
    ["ask", "--instance-dir", instanceDir, "--question", "本地资料写了什么？"],
    { env: { ...process.env, WECOM_BOT_PI_BINARY: realPi }, timeout: 30000 },
  );

  assert.equal(result.finalText, "REAL_PI_LOCAL_OK");
  assert.equal(result.loadDepth, "concept");
  assert.equal(result.loadedResources[0].path, localCopyPath);
  const mainCalls = models.calls.filter((call) => call.model === "real-main-model" && call.stream);
  assert.equal(mainCalls.length, 2);
  assert.equal(mainCalls[0].authorization, "Bearer real-pi-key");
  assert.equal(JSON.stringify(mainCalls[0].messages).includes("REAL_PI_CONTEXT_MARKER"), false);
  assert.match(JSON.stringify(mainCalls[1].messages), /REAL_PI_CONTEXT_MARKER/);
  assert.ok(models.calls.some((call) => call.model === "real-guard-model"));
});

test("真实 pi 在本地实例中不能读取默认模式的主工作区手册", { timeout: 60000 }, async (t) => {
  const realPi = join(homedir(), ".pi-support/bin/pi");
  if (!existsSync(realPi)) {
    t.skip("本机未安装隔离 pi，跳过真实 pi 白名单验收");
    return;
  }
  const root = await makeTempDir(t);
  const playbookPath = join(projectDir, "prompts/data-playbook.md");
  const models = await startModelServer({
    mainReply: (payload) => {
      const toolMessages = payload.messages.filter((message) => message.role === "tool");
      if (toolMessages.length === 0) {
        return {
          toolCalls: [
            {
              index: 0,
              id: "call-read-main-workspace",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: playbookPath }) },
            },
          ],
        };
      }
      return JSON.stringify(toolMessages).includes("路径越界") ? "LOCAL_READ_BLOCKED" : "LOCAL_READ_ALLOWED";
    },
  });
  t.after(() => models.close());
  const source = join(root, "docs.md");
  const instanceDir = join(root, "instance");
  await writeFile(source, "LOCAL_ONLY_CONTEXT\n");
  await initInstance({
    instanceDir,
    template: "team",
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
    apiKey: "real-pi-key",
    model: "real-main-model",
  });

  const result = await runCli(
    ["ask", "--instance-dir", instanceDir, "--question", "读取主工作区手册"],
    { env: { ...process.env, WECOM_BOT_PI_BINARY: realPi }, timeout: 30000 },
  );

  assert.equal(result.finalText, "LOCAL_READ_BLOCKED");
  const mainCalls = models.calls.filter((call) => call.model === "real-main-model" && call.stream);
  assert.equal(mainCalls.length, 2);
  assert.match(JSON.stringify(mainCalls[1].messages), /路径越界/);
});

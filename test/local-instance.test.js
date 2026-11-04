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

async function startModelServer({ failModel, mainReply = "ok", approvalReply } = {}) {
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
      const isApproval = messageText.includes("你是独立的执行审批模型");
      const reply = isGuard
        ? messageText.includes("13800138000")
          ? "DENY\n包含手机号"
          : "ALLOW"
        : isConnectionTest
          ? "ok"
          : isApproval
            ? typeof approvalReply === "function"
              ? approvalReply(payload)
              : approvalReply ?? "ALLOW\n理由：当前任务产物范围明确\n风险：低"
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

function modelToolCall(id, name, input) {
  return {
    toolCalls: [
      {
        index: 0,
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      },
    ],
  };
}

function currentAgentPhase(payload) {
  const userIndex = payload.messages.findLastIndex((message) => message.role === "user");
  const userContent = payload.messages[userIndex]?.content;
  const prompt = typeof userContent === "string" ? userContent : JSON.stringify(userContent ?? "");
  const messages = payload.messages.slice(Math.max(0, userIndex + 1));
  return { prompt, toolMessages: messages.filter((message) => message.role === "tool") };
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
  approvalBaseUrl,
  approvalApiKey,
  approvalModel,
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
  if (approvalBaseUrl) args.push("--approval-base-url", approvalBaseUrl);
  if (approvalApiKey) args.push("--approval-api-key", approvalApiKey);
  if (approvalModel) args.push("--approval-model", approvalModel);
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
  assert.deepEqual(saved.models.executionApproval, { baseUrl: models.baseUrl, model: "main-model" });
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

test("本地实例向 pi 子进程注入独立审批模型、写工具和副本写根", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const source = join(root, "docs.md");
  const instanceDir = join(root, "instance");
  const fakePi = join(root, "fake-pi.js");
  const piLog = join(root, "pi-log.jsonl");
  await writeFile(source, "本地资料。\n");
  await initInstance({
    instanceDir,
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
    model: "main-model",
    approvalBaseUrl: "http://127.0.0.1:39999/v1",
    approvalApiKey: "approval-secret",
    approvalModel: "approval-model",
  });
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({
  tools: args[args.indexOf("--tools") + 1],
  approval: JSON.parse(process.env.WECOM_BOT_EXECUTION_APPROVAL || "{}"),
  writeRoots: JSON.parse(process.env.WECOM_BOT_WRITE_ROOTS || "[]"),
  protectedRoots: JSON.parse(process.env.WECOM_BOT_PROTECTED_ROOTS || "[]"),
  modelClientPath: process.env.WECOM_BOT_MODEL_CLIENT_PATH,
}) + "\\n");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "配置已接收" }] } }));
`,
    { mode: 0o755 },
  );

  const result = await runCli(
    ["ask", "--instance-dir", instanceDir, "--question", "检查配置", "--session-key", "approval-config"],
    { env: { ...process.env, WECOM_BOT_PI_BINARY: fakePi, FAKE_PI_LOG: piLog } },
  );

  assert.equal(result.finalText, "配置已接收");
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.deepEqual(saved.models.executionApproval, { baseUrl: "http://127.0.0.1:39999/v1", model: "approval-model" });
  const call = JSON.parse((await readFile(piLog, "utf8")).trim());
  assert.equal(call.tools, "read,write,edit,bash");
  assert.deepEqual(call.approval, {
    enabled: true,
    baseUrl: "http://127.0.0.1:39999/v1",
    model: "approval-model",
    apiKey: "approval-secret",
    timeoutMs: 10000,
  });
  assert.deepEqual(call.writeRoots, [join(instanceDir, "context"), join(instanceDir, "workspace")]);
  assert.deepEqual(call.protectedRoots, [projectDir]);
  assert.equal(call.modelClientPath, join(projectDir, "src/model-client.js"));
});

test("ask 运行链路公开审批摘要、结果与安全理由类别但不泄露敏感原文", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const source = join(root, "docs.md");
  const instanceDir = join(root, "instance");
  const fakePi = join(root, "fake-pi.js");
  const modelReason = "只创建当前任务要求的报告；S14_MODEL_FAKE_CREDENTIAL_91c2e7；S14_MODEL_WRITE_BODY_整段机密正文";
  await writeFile(source, "本地资料。\n");
  await initInstance({
    instanceDir,
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
  });
  const approvalEntry = {
    timestamp: "2026-11-05T00:00:00.000Z",
    type: "execution_approval",
    toolCallId: "write-1",
    toolName: "write",
    target: join(instanceDir, "context/report.md"),
    verdict: "ALLOW",
    source: "model",
    reason: modelReason,
    riskCategory: "low",
    arguments: { content: "完整敏感参数" },
    apiKey: "approval-secret",
  };
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(`[execution-approval] ${JSON.stringify(approvalEntry)}\n`)});
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "报告已创建" }] } }));
`,
    { mode: 0o755 },
  );

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [cliPath, "ask", "--instance-dir", instanceDir, "--question", "创建报告", "--session-key", "approval-log"],
    { cwd: projectDir, env: { ...process.env, WECOM_BOT_PI_BINARY: fakePi } },
  );

  assert.equal(JSON.parse(stdout).finalText, "报告已创建");
  const logLine = stderr.trim().split("\n").find((line) => line.startsWith("[execution-approval] "));
  assert.ok(logLine, `应公开执行审批日志，实际 stderr：${stderr}`);
  const observed = JSON.parse(logLine.slice("[execution-approval] ".length));
  assert.equal(observed.toolCallId, "write-1");
  assert.equal(observed.target, approvalEntry.target);
  assert.equal(observed.verdict, "ALLOW");
  assert.equal(observed.reason, "model-allow");
  assert.equal(observed.riskCategory, "low");
  assert.equal(stderr.includes("S14_MODEL_FAKE_CREDENTIAL_91c2e7"), false);
  assert.equal(stderr.includes("S14_MODEL_WRITE_BODY_整段机密正文"), false);
  assert.equal(stderr.includes("approval-secret"), false);
  assert.equal(stderr.includes("完整敏感参数"), false);
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
    assert.deepEqual(call.roots, [join(instanceDir, "context"), join(instanceDir, "workspace")]);
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

test("本地查数公开记录经验、指标、SQL 校验状态与表文档的加载", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const source = join(root, "shared-data");
  const instanceDir = join(root, "instance");
  const fakePi = join(root, "fake-pi.js");
  const piLog = join(root, "pi-log.jsonl");
  const files = {
    playbook: join(source, "prompts/data-playbook.md"),
    experience: join(source, ".lzz-db-wiki-evolution/common/机构经验.md"),
    metrics: join(source, "metrics/机构总数.md"),
    verifiedSql: join(source, "queries/机构总数.sql"),
    unverifiedSql: join(source, "queries/机构无标记参考.sql"),
    explicitUnverifiedSql: join(source, "queries/机构显式未验证.sql"),
    notVerifiedSql: join(source, "queries/机构英文否定.sql"),
    falseVerifiedSql: join(source, "queries/机构布尔否定.sql"),
    knownIssueSql: join(source, "queries/机构已知问题.sql"),
    table: join(source, "tables/ajly_flow/system_tenant.md"),
  };
  for (const path of Object.values(files)) await mkdir(dirname(path), { recursive: true });
  await writeFile(files.playbook, "查数必须先确认经验、指标、SQL 和表文档。\n");
  await writeFile(files.experience, "机构统计不能使用门店品牌配置表。\n");
  await writeFile(files.metrics, "---\nupdated: 2026-11-01\nstatus: current\n---\n机构总数只统计有效入驻机构。\n");
  await writeFile(files.verifiedSql, "-- ✅ 已验证\nSELECT tenant_id FROM system_tenant WHERE deleted = 0;\n");
  await writeFile(files.unverifiedSql, "SELECT tenant_id FROM system_tenant;\n");
  await writeFile(files.explicitUnverifiedSql, "-- ⚠️ 未验证\nSELECT tenant_id FROM system_tenant;\n");
  await writeFile(files.notVerifiedSql, "-- not verified\nSELECT tenant_id FROM system_tenant;\n");
  await writeFile(files.falseVerifiedSql, "-- verified:false\nSELECT tenant_id FROM system_tenant;\n");
  await writeFile(files.knownIssueSql, "-- ❌ 已知问题\nSELECT tenant_id FROM system_tenant;\n");
  await writeFile(files.table, "system_tenant 的 tenant_id 是机构标识，deleted 是软删标记。\n");
  await initInstance({
    instanceDir,
    template: "team",
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
  });
  const localFiles = Object.fromEntries(
    Object.entries(files).map(([key, path]) => [key, path.replace(source, join(instanceDir, "context/001-shared-data"))]),
  );
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const prompt = process.argv.at(-1);
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ prompt }) + "\\n");
const files = ${JSON.stringify(localFiles)};
let paths = [];
let answer = "";
if (prompt.includes("继续完成数据口径任务")) {
  paths = [
    files.verifiedSql,
    files.unverifiedSql,
    files.explicitUnverifiedSql,
    files.notVerifiedSql,
    files.falseVerifiedSql,
    files.knownIssueSql,
    files.table,
  ];
  const verified = readFileSync(files.verifiedSql, "utf8").includes("✅ 已验证");
  const table = readFileSync(files.table, "utf8").includes("tenant_id");
  answer = verified && table ? "机构总数按当前指标口径统计；已验证 SQL 仅供参照，未验证参考不作为确认事实。" : "缺少可核对的 SQL 或表文档";
} else if (prompt.includes("原始问题：")) {
  paths = [files.playbook, files.experience, files.metrics];
  answer = "CONTEXT_INSUFFICIENT\\n指标口径已确认，还缺 SQL 关联与表字段核对";
} else {
  answer = "CONTEXT_INSUFFICIENT\\n目录摘要没有机构统计口径";
}
for (const [index, path] of paths.entries()) {
  console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "read-" + index, toolName: "read", args: { path } }));
  console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "read-" + index, toolName: "read", result: {}, isError: false }));
}
if (prompt.includes("继续完成数据口径任务")) {
  console.log(JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "python3 /local/scripts/bi_query.py SELECT" } }));
}
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } }));
`,
    { mode: 0o755 },
  );

  const result = await runCli(
    ["ask", "--instance-dir", instanceDir, "--question", "查一下乐租租机构总数", "--session-key", "data-colleague"],
    { env: { ...process.env, WECOM_BOT_PI_BINARY: fakePi, FAKE_PI_LOG: piLog } },
  );

  assert.match(result.finalText, /未验证参考不作为确认事实/);
  assert.equal(result.guarded, true);
  assert.deepEqual(
    result.loadedResources.map((resource) => resource.resourceType),
    ["playbook", "experience", "metrics", "sql", "sql", "sql", "sql", "sql", "sql", "table"],
  );
  assert.deepEqual(
    result.loadedResources.filter((resource) => resource.resourceType === "sql").map((resource) => resource.verification),
    ["verified", "unverified", "unverified", "unverified", "unverified", "known-issue"],
  );
  assert.equal(result.loadedResources.find((resource) => resource.resourceType === "metrics").sourceTime, "2026-11-01");
  assert.equal(result.loadDepth, "sql");
  const calls = (await readFile(piLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].prompt.includes("机构统计不能使用门店品牌配置表"), false);
  assert.match(calls[0].prompt, /resource_type: experience/);
  assert.match(calls[0].prompt, /verification: verified/);
  assert.match(calls[0].prompt, /verification: unverified/);
  assert.match(calls[0].prompt, /verification: known-issue/);
});

test("本地历史问答公开共享时间线、当时记录和决策资料的来源时间", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const source = join(root, "shared-memory");
  const instanceDir = join(root, "instance");
  const fakePi = join(root, "fake-pi.js");
  const files = {
    timeline: join(source, "wiki/时间线.md"),
    record: join(source, "raw/收件箱/2026-08-01--审批讨论.md"),
    decision: join(source, "wiki/决策/退租审批.md"),
  };
  for (const path of Object.values(files)) await mkdir(dirname(path), { recursive: true });
  await writeFile(files.timeline, "---\nupdated: 2026-08-03\n---\n2026-08-01 讨论退租审批调整。\n");
  await writeFile(
    files.record,
    "---\nsource_time: 2026-08-01\nstatus: history\n---\n当时讨论认为一级审批缺少业务复核。\n",
  );
  await writeFile(
    files.decision,
    "---\nsource_time: 2026-08-02\nstatus: history\n---\n当时决定调整为两级审批。\n",
  );
  await initInstance({
    instanceDir,
    template: "team",
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
  });
  const localFiles = Object.fromEntries(
    Object.entries(files).map(([key, path]) => [key, path.replace(source, join(instanceDir, "context/001-shared-memory"))]),
  );
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const prompt = process.argv.at(-1);
const files = ${JSON.stringify(localFiles)};
const deepened = prompt.includes("原始问题：");
const paths = deepened ? [files.record, files.decision] : [files.timeline];
for (const [index, path] of paths.entries()) {
  readFileSync(path, "utf8");
  console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "history-" + index, toolName: "read", args: { path } }));
  console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "history-" + index, toolName: "read", result: {}, isError: false }));
}
const answer = deepened
  ? "2026 年 8 月 1 日的当时记录说明缺少业务复核，8 月 2 日拍板改为两级审批。"
  : "CONTEXT_INSUFFICIENT\\n时间线只有调整时间，缺少当时讨论和决策依据";
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } }));
`,
    { mode: 0o755 },
  );

  const result = await runCli(
    [
      "ask",
      "--instance-dir",
      instanceDir,
      "--question",
      "退租审批当时为什么改成两级？",
      "--session-key",
      "history-colleague",
    ],
    { env: { ...process.env, WECOM_BOT_PI_BINARY: fakePi } },
  );

  assert.match(result.finalText, /8 月 2 日拍板/);
  assert.deepEqual(
    result.loadedResources.map((resource) => resource.resourceType),
    ["timeline", "record", "decision"],
  );
  assert.deepEqual(
    result.loadedResources.map((resource) => resource.sourceTime),
    ["2026-08-03", "2026-08-01", "2026-08-02"],
  );
  assert.ok(result.loadedResources.every((resource) => resource.scope === "shared"));
  assert.equal(result.loadDepth, "raw");
});

test("本地当前进展只读取最新且明确有效的共享项目资料", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const source = join(root, "shared-projects");
  const instanceDir = join(root, "instance");
  const fakePi = join(root, "fake-pi.js");
  const oldPath = join(source, "projects/房源审核/历史讨论.md");
  const currentPath = join(source, "projects/房源审核/当前进展.md");
  await mkdir(dirname(oldPath), { recursive: true });
  await writeFile(
    oldPath,
    "---\nsource_time: 2026-09-01\nstatus: history\n---\nOLD_PROGRESS：当时仍在讨论方案。\n",
  );
  await writeFile(
    currentPath,
    "---\nsource_time: 2026-11-03\nstatus: current\n---\nCURRENT_PROGRESS：正在联调，尚未上线。\n",
  );
  await initInstance({
    instanceDir,
    template: "team",
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
  });
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const prompt = process.argv.at(-1);
const candidates = prompt.split("\\n").flatMap((line) => {
  if (!line.includes("resource_type: project") || !line.includes("scope: shared")) return [];
  const path = line.match(/\\| path: ([^|]+?) \\|/)?.[1]?.trim();
  const sourceTime = line.match(/source_time: ([^|]+?) \\|/)?.[1]?.trim();
  const validity = line.match(/validity: ([^|]+?)(?: \\||$)/)?.[1]?.trim();
  return path ? [{ path, sourceTime, validity }] : [];
});
candidates.sort((a, b) => b.sourceTime.localeCompare(a.sourceTime));
const selected = candidates.find((candidate) => candidate.validity === "current");
let answer = "缺少最新共享项目资料";
if (selected) {
  const content = readFileSync(selected.path, "utf8");
  console.log(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: selected.path } }));
  console.log(JSON.stringify({ type: "tool_execution_end", toolName: "read", args: { path: selected.path }, isError: false }));
  if (content.includes("CURRENT_PROGRESS")) answer = "截至 2026 年 11 月 3 日正在联调，尚未上线。";
}
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } }));
`,
    { mode: 0o755 },
  );

  const result = await runCli(
    ["ask", "--instance-dir", instanceDir, "--question", "房源审核目前进展如何？", "--session-key", "progress-colleague"],
    { env: { ...process.env, WECOM_BOT_PI_BINARY: fakePi } },
  );

  assert.equal(result.finalText, "截至 2026 年 11 月 3 日正在联调，尚未上线。");
  assert.equal(result.loadedResources.length, 1);
  assert.equal(result.loadedResources[0].resourceType, "project");
  assert.equal(result.loadedResources[0].path, join(instanceDir, "context/001-shared-projects/projects/房源审核/当前进展.md"));
  assert.equal(result.loadedResources[0].sourceTime, "2026-11-03");
  assert.equal(result.loadedResources[0].validity, "current");
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
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ prompt, sessionId: args[args.indexOf("--session-id") + 1], agentDir: process.env.PI_CODING_AGENT_DIR }) + "\\n");
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
  const workspaceA = join(a.instanceDir, "workspace");
  const workspaceB = join(b.instanceDir, "workspace");
  for (const [index, workspace] of [workspaceA, workspaceA, workspaceB, workspaceB].entries()) {
    assert.ok(calls[index].prompt.split("\n").includes(`workspace: ${workspace}`));
    assert.equal(calls[index].prompt.includes(`workspace: ${workspace === workspaceA ? workspaceB : workspaceA}`), false);
  }
});

test("公开查数任务由真实 pi 渐进加载业务知识与 Skill，并从隔离假 BI 取得结果后经过 Guard", { timeout: 120000 }, async (t) => {
  const realPi = join(homedir(), ".pi-support/bin/pi");
  if (!existsSync(realPi)) {
    t.skip("本机未安装隔离 pi，跳过真实 pi 查数公开工作流验收");
    return;
  }
  const root = await makeTempDir(t);
  const source = join(root, "shared-data-skill");
  const instanceDir = join(root, "instance");
  const isolatedHome = join(root, "home");
  const defaultKnowledgeRoot = "/Users/kyle/Desktop/PM/信息技术部资产库/知识库";
  const defaultScriptDir = `${defaultKnowledgeRoot}/数据库/ajly-db-wiki/scripts`;
  const trustedKnowledgeRoot = join(isolatedHome, "Desktop/PM/信息技术部资产库/知识库");
  const trustedScriptDir = join(trustedKnowledgeRoot, "数据库/ajly-db-wiki/scripts");
  const fakeBiScript = join(trustedScriptDir, "bi_query.py");
  const extensionCopy = join(root, "default-mode-extension/bash-whitelist.ts");
  const realPiWrapper = join(root, "real-pi-default-mode.js");
  const extensionSource = await readFile(join(projectDir, "extensions/bash-whitelist.ts"), "utf8");
  const isolatedExtension = extensionSource
    .replace(JSON.stringify(defaultScriptDir), JSON.stringify(trustedScriptDir))
    .replace(JSON.stringify(defaultKnowledgeRoot), JSON.stringify(trustedKnowledgeRoot));
  assert.ok(isolatedExtension.includes(JSON.stringify(trustedScriptDir)));
  assert.ok(isolatedExtension.includes(JSON.stringify(trustedKnowledgeRoot)));
  await mkdir(dirname(extensionCopy), { recursive: true });
  await writeFile(extensionCopy, isolatedExtension, { mode: 0o555 });
  // 04 不允许本地实例执行副本内 Python。此验收仅借现有 binary 注入点启动真实 pi 的
  // 默认只读模式，并把既有默认 Wiki 来源重定位到隔离 HOME；白名单规则本身不变。
  await writeFile(
    realPiWrapper,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const extensionIndex = args.indexOf("--extension");
if (extensionIndex < 0) throw new Error("missing extension argument");
args[extensionIndex + 1] = process.env.REAL_PI_TEST_EXTENSION;
const roots = [...JSON.parse(process.env.WECOM_BOT_ROOTS || "[]"), process.env.REAL_PI_TEST_TRUSTED_ROOT];
const child = spawn(process.env.REAL_PI_BINARY, args, {
  env: { ...process.env, WECOM_BOT_LOCAL_INSTANCE: "0", WECOM_BOT_ROOTS: JSON.stringify(roots) },
  stdio: "inherit",
});
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`,
    { mode: 0o755 },
  );
  const files = {
    concept: join(source, "wiki/概念/机构.md"),
    skill: join(source, "skills/data-query/SKILL.md"),
    reference: join(source, "skills/data-query/references/query-checklist.md"),
    script: join(source, "skills/data-query/scripts/not-needed.sh"),
    unrelatedSkill: join(source, "skills/document-delivery/SKILL.md"),
    playbook: join(source, "prompts/data-playbook.md"),
    experience: join(source, ".lzz-db-wiki-evolution/common/机构经验.md"),
    metrics: join(source, "metrics/机构总数.md"),
    sql: join(source, "queries/机构总数.sql"),
    table: join(source, "tables/ajly_flow/system_tenant.md"),
  };
  for (const path of Object.values(files)) await mkdir(dirname(path), { recursive: true });
  await writeFile(files.concept, "---\nsource_time: 2026-11-01\nstatus: current\n---\nBUSINESS_CONCEPT：机构是入驻主体。\n");
  await writeFile(
    files.skill,
    "---\nname: data-query\ndescription: >-\n  按业务口径完成\n  只读查数\ncapabilities:\n  - 口径核对\n  - 已验证 SQL\n  - 只读 BI\ntriggers:\n  - 查数\ntasks:\n  - data\nsource_time: 2026-11-04\n---\nDATA_SKILL_BODY：具体查数必须读取 references/query-checklist.md；scripts 仅在人工要求自动化时使用。\n",
  );
  await writeFile(files.reference, "QUERY_REFERENCE：核对经验、指标、已验证 SQL、表文档后才执行只读查询。\n");
  await writeFile(files.script, "UNNEEDED_SCRIPT_BODY\n");
  await writeFile(files.unrelatedSkill, "---\nname: document-delivery\ndescription: 创建文档\ntriggers: 文档\n---\nUNRELATED_DOCUMENT_SKILL_BODY\n");
  await writeFile(files.playbook, "查数手册：先口径后查询。\n");
  await writeFile(files.experience, "机构统计排除门店品牌配置。\n");
  await writeFile(files.metrics, "---\nsource_time: 2026-11-02\nstatus: current\n---\n机构总数只统计有效入驻机构。\n");
  await writeFile(files.sql, "-- ✅ 已验证\nSELECT tenant_id FROM system_tenant WHERE deleted = 0;\n");
  await writeFile(files.table, "system_tenant.tenant_id 是机构标识，deleted 是软删标记。\n");
  await mkdir(dirname(fakeBiScript), { recursive: true });
  await writeFile(
    fakeBiScript,
    "import sys\nif sys.argv[1:] != ['SELECT 56 AS tenant_count']:\n    raise SystemExit('unexpected test query')\nprint('FAKE_BI_COUNT=56')\n",
    { mode: 0o555 },
  );
  const localFiles = Object.fromEntries(
    Object.entries(files).map(([key, path]) => [key, path.replace(source, join(instanceDir, "context/001-shared-data-skill"))]),
  );
  let observedExternalResult = false;
  const models = await startModelServer({
    mainReply: (payload) => {
      const { prompt, toolMessages } = currentAgentPhase(payload);
      const phase = prompt.includes("继续完成数据口径任务")
        ? "sql"
        : prompt.includes("这是查数或数据口径任务")
          ? "metrics"
          : "initial";
      if (phase === "initial") {
        if (toolMessages.length === 0) return modelToolCall("data-read-skill", "read", { path: localFiles.skill });
        if (toolMessages.length === 1) return modelToolCall("data-read-reference", "read", { path: localFiles.reference });
        if (toolMessages.length === 2) return modelToolCall("data-read-concept", "read", { path: localFiles.concept });
        return "CONTEXT_INSUFFICIENT\nSkill 与业务概念已加载，还缺查数证据";
      }
      if (phase === "metrics") {
        if (toolMessages.length === 0) return modelToolCall("data-read-playbook", "read", { path: localFiles.playbook });
        if (toolMessages.length === 1) return modelToolCall("data-read-experience", "read", { path: localFiles.experience });
        if (toolMessages.length === 2) return modelToolCall("data-read-metrics", "read", { path: localFiles.metrics });
        return "CONTEXT_INSUFFICIENT\n口径已确认，还缺 SQL 和表字段核对";
      }
      if (toolMessages.length === 0) return modelToolCall("data-read-sql", "read", { path: localFiles.sql });
      if (toolMessages.length === 1) return modelToolCall("data-read-table", "read", { path: localFiles.table });
      if (toolMessages.length === 2) {
        return modelToolCall("data-query-fake-bi", "bash", { command: `python3 "${fakeBiScript}" "SELECT 56 AS tenant_count"` });
      }
      if (!JSON.stringify(toolMessages).includes("FAKE_BI_COUNT=56")) return "EXTERNAL_QUERY_RESULT_MISSING";
      observedExternalResult = true;
      return "按当前指标口径，机构总数为 56 家。";
    },
  });
  t.after(() => models.close());
  await initInstance({
    instanceDir,
    template: "team",
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
    model: "main-model",
    guardModel: "guard-model",
  });

  const result = await runCli(
    ["ask", "--instance-dir", instanceDir, "--question", "查一下乐租租现在有多少入驻机构", "--session-key", "real-data-skill"],
    {
      env: {
        ...process.env,
        HOME: isolatedHome,
        WECOM_BOT_PI_BINARY: realPiWrapper,
        REAL_PI_BINARY: realPi,
        REAL_PI_TEST_EXTENSION: extensionCopy,
        REAL_PI_TEST_TRUSTED_ROOT: trustedKnowledgeRoot,
      },
      timeout: 90000,
    },
  );

  assert.equal(result.finalText, "按当前指标口径，机构总数为 56 家。");
  assert.equal(result.currentSkill, "data-query");
  assert.equal(result.guarded, true);
  assert.equal(observedExternalResult, true);
  assert.equal(result.loadedSkills.length, 1);
  assert.equal(result.loadedSkills[0].skillName, "data-query");
  assert.deepEqual(
    result.loadedResources.map((resource) => resource.resourceType),
    ["skill", "skill-reference", "concept", "playbook", "experience", "metrics", "sql", "table"],
  );
  assert.ok(result.loadedResources.every((resource) => resource.source === "shared-data-skill" && resource.scope === "shared"));
  assert.equal(result.loadedResources.some((resource) => resource.resourceType === "skill-script"), false);
  assert.equal(result.loadedResources.some((resource) => resource.skillName === "document-delivery"), false);
  assert.equal(result.loadDepth, "sql");
  const executionApprovalCalls = models.calls.filter((call) =>
    call.messages.some((message) => typeof message.content === "string" && message.content.includes("你是独立的执行审批模型")),
  );
  assert.equal(executionApprovalCalls.length, 0, "受信任只读查询只直接放行，不进入 write/edit 执行审批");
  assert.ok(models.calls.some((call) => call.model === "guard-model" && JSON.stringify(call.messages).includes("机器人的答复")));
  const mainCalls = models.calls.filter((call) => call.model === "main-model" && call.stream);
  assert.match(JSON.stringify(mainCalls[0].messages), /按业务口径完成\s+只读查数/);
  assert.match(JSON.stringify(mainCalls[0].messages), /capabilities: 口径核对、已验证 SQL、只读 BI/);
  assert.equal(JSON.stringify(mainCalls[0].messages).includes("DATA_SKILL_BODY"), false);
  assert.equal(JSON.stringify(mainCalls[0].messages).includes("QUERY_REFERENCE"), false);
  assert.equal(JSON.stringify(mainCalls[0].messages).includes("UNNEEDED_SCRIPT_BODY"), false);
  assert.equal(JSON.stringify(mainCalls[0].messages).includes("UNRELATED_DOCUMENT_SKILL_BODY"), false);
});

test("公开文档任务由真实 pi 读取 Skill，按 DENY 理由调整并新建后编辑本次工作区产物", { timeout: 120000 }, async (t) => {
  const realPi = join(homedir(), ".pi-support/bin/pi");
  if (!existsSync(realPi)) {
    t.skip("本机未安装隔离 pi，跳过真实 pi 文档公开工作流验收");
    return;
  }
  const root = await makeTempDir(t);
  const source = join(root, "shared-docs");
  const instanceDir = join(root, "instance");
  const conceptPath = join(source, "wiki/概念/退租.md");
  const skillPath = join(source, "skills/document-delivery/SKILL.md");
  const referencePath = join(source, "skills/document-delivery/references/layout.md");
  const unrelatedSkillPath = join(source, "skills/prototype/SKILL.md");
  const conceptBody = "---\nsummary: 退租规则摘要\nsource_time: 2026-11-01\nstatus: current\n---\nBUSINESS_RULE：退租审批需要两级审批。\n";
  for (const path of [conceptPath, skillPath, referencePath, unrelatedSkillPath]) await mkdir(dirname(path), { recursive: true });
  await writeFile(conceptPath, conceptBody);
  await writeFile(
    skillPath,
    "---\nname: document-delivery\ndescription: 创建或修改业务文档与报告\ncapabilities: 文档生成、模板套用、受限写入\ntriggers: 文档,报告\nsource_time: 2026-11-04\n---\nDOC_SKILL_BODY：生成文档时先读取 references/layout.md；只有任务要求自动转换格式时才读取 scripts。\n",
  );
  await writeFile(referencePath, "REFERENCE_REQUIRED：文档先给结论，再列规则。\n");
  await writeFile(unrelatedSkillPath, "---\nname: prototype\ndescription: 生成 HTML 原型\ntriggers: 原型\n---\nUNRELATED_SKILL_BODY\n");
  const localConceptPath = join(instanceDir, "context/001-shared-docs/wiki/概念/退租.md");
  const localSkillPath = join(instanceDir, "context/001-shared-docs/skills/document-delivery/SKILL.md");
  const localReferencePath = join(instanceDir, "context/001-shared-docs/skills/document-delivery/references/layout.md");
  const artifactPath = join(instanceDir, "workspace/退租规则.md");
  const unrelatedPath = join(instanceDir, "workspace/unrelated.md");
  const initialArtifact = "退租审批需要两级审批。\n文档先给结论，再列规则。\n";
  const finalArtifact = "已复核：退租审批需要两级审批。\n文档先给结论，再列规则。\n";
  let observedDenialReason = false;
  const models = await startModelServer({
    approvalReply: (payload) => {
      const operation = JSON.parse(payload.messages[1].content);
      return operation.arguments.path.endsWith("unrelated.md")
        ? "DENY\n理由：只生成当前文档并更新本次产物，不要创建无关文件\n风险：中"
        : "ALLOW\n理由：本次文档产物的新建与复核修改均在任务范围内\n风险：低";
    },
    mainReply: (payload) => {
      const { toolMessages } = currentAgentPhase(payload);
      if (toolMessages.length === 0) return modelToolCall("document-read-skill", "read", { path: localSkillPath });
      if (toolMessages.length === 1) return modelToolCall("document-read-reference", "read", { path: localReferencePath });
      if (toolMessages.length === 2) return modelToolCall("document-read-concept", "read", { path: localConceptPath });
      if (toolMessages.length === 3) {
        return modelToolCall("document-write-unrelated", "write", { path: unrelatedPath, content: "无关内容" });
      }
      if (toolMessages.length === 4) {
        const denial = JSON.stringify(toolMessages.at(-1));
        if (!denial.includes("只生成当前文档并更新本次产物")) return "DENY_REASON_NOT_USED";
        observedDenialReason = true;
        return modelToolCall("document-write-artifact", "write", { path: artifactPath, content: initialArtifact });
      }
      if (toolMessages.length === 5) {
        return modelToolCall("document-edit-artifact", "edit", {
          path: artifactPath,
          edits: [{ oldText: "退租审批需要两级审批。", newText: "已复核：退租审批需要两级审批。" }],
        });
      }
      return "文档已新建，已根据审批理由缩小范围并完成本次产物修改。";
    },
  });
  t.after(() => models.close());
  const initialized = await initInstance({
    instanceDir,
    template: "team",
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
    model: "main-model",
    guardModel: "guard-model",
    approvalModel: "approval-model",
  });
  assert.equal(initialized.ready, true);

  const result = await runCli(
    ["ask", "--instance-dir", instanceDir, "--question", "根据退租规则生成一份文档，并在生成后复核修改本次文档产物", "--session-key", "real-document-skill"],
    { env: { ...process.env, HOME: join(root, "home"), WECOM_BOT_PI_BINARY: realPi }, timeout: 90000 },
  );

  assert.equal(result.finalText, "文档已新建，已根据审批理由缩小范围并完成本次产物修改。");
  assert.equal(result.currentSkill, "document-delivery");
  assert.equal(result.guarded, false);
  assert.equal(observedDenialReason, true);
  assert.equal(await readFile(artifactPath, "utf8"), finalArtifact);
  assert.equal(existsSync(unrelatedPath), false);
  assert.equal(await readFile(conceptPath, "utf8"), conceptBody, "原始来源必须保持不变");
  assert.equal(result.loadedSkills.length, 1);
  assert.equal(result.loadedSkills[0].skillName, "document-delivery");
  assert.equal(result.loadedSkills[0].sourceTime, "2026-11-04");
  assert.ok(result.loadedResources.some((resource) => resource.resourceType === "skill-reference" && resource.path === localReferencePath));
  assert.ok(result.loadedResources.some((resource) => resource.path === localConceptPath && resource.resourceType === "concept"));
  assert.deepEqual(result.executionApprovals.map((entry) => entry.verdict), ["DENY", "ALLOW", "ALLOW"]);
  assert.deepEqual(result.executionApprovals.map((entry) => entry.toolName), ["write", "write", "edit"]);
  assert.equal(result.executionApprovals[0].target, unrelatedPath);
  assert.ok(result.executionApprovals.slice(1).every((entry) => entry.target === artifactPath));
  const approvalCalls = models.calls.filter((call) => call.model === "approval-model" && !call.stream);
  assert.equal(approvalCalls.length, 3);
  for (const call of approvalCalls) {
    assert.equal(JSON.parse(call.messages[1].content).task.currentSkill, "document-delivery");
  }
  assert.ok(models.calls.some((call) => call.model === "guard-model"), "初始化已验证 Guard 模型可用");
  const mainCalls = models.calls.filter((call) => call.model === "main-model" && call.stream);
  const initialPrompt = currentAgentPhase(mainCalls[0]).prompt;
  assert.match(initialPrompt, /文档生成、模板套用、受限写入/);
  assert.match(initialPrompt, /skill: prototype/);
  assert.equal(initialPrompt.includes(projectDir), false, "不得向任务 Agent 暴露主工作区路径");
  assert.equal(initialPrompt.includes(source), false, "不得向任务 Agent 暴露初始化前的原始来源路径");
  assert.equal(initialPrompt.includes("DOC_SKILL_BODY"), false);
  assert.equal(initialPrompt.includes("REFERENCE_REQUIRED"), false);
  assert.equal(initialPrompt.includes("UNRELATED_SKILL_BODY"), false);
});

test("Skill frontmatter 的块描述与 YAML 列表进入公开目录并参与路由", async (t) => {
  const root = await makeTempDir(t);
  const source = join(root, "shared-skills");
  const instanceDir = join(root, "instance");
  const fakePi = join(root, "fake-pi.js");
  const piLog = join(root, "pi-log.jsonl");
  const documentSkill = join(source, "skills/document-delivery/SKILL.md");
  const conceptSkill = join(source, "skills/concept-guide/SKILL.md");
  await mkdir(dirname(documentSkill), { recursive: true });
  await mkdir(dirname(conceptSkill), { recursive: true });
  await writeFile(
    documentSkill,
    "---\nname: document-delivery\ndescription: >-\n  创建或修改业务文档，\n  并按退租规则生成报告。\ncapabilities:\n  - 文档生成\n  - 受限写入\ntriggers:\n  - 退租文档\n  - 报告\ntasks:\n  - document\n---\nDOC_SKILL_BODY\n",
  );
  await writeFile(
    conceptSkill,
    "---\nname: concept-guide\ndescription: |-\n  按概念说明业务规则\n  保留来源时间\ncapabilities:\n  - 概念核对\n  - 来源追踪\ntriggers:\n  - 概念盘点\ntasks:\n  - concept\n---\nCONCEPT_SKILL_BODY\n",
  );
  const models = await startModelServer();
  t.after(() => models.close());
  await initInstance({
    instanceDir,
    template: "team",
    sources: [{ path: source, scope: "shared" }],
    baseUrl: models.baseUrl,
  });
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ prompt: process.argv.at(-1), currentSkill: process.env.WECOM_BOT_CURRENT_SKILL || "missing" }) + "\\n");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }));
`,
    { mode: 0o755 },
  );
  const env = { ...process.env, WECOM_BOT_PI_BINARY: fakePi, FAKE_PI_LOG: piLog };

  const documentResult = await runCli(
    ["ask", "--instance-dir", instanceDir, "--question", "请生成退租文档", "--session-key", "frontmatter-document"],
    { env },
  );
  const conceptResult = await runCli(
    ["ask", "--instance-dir", instanceDir, "--question", "这个术语是什么？", "--session-key", "frontmatter-concept"],
    { env },
  );

  assert.equal(documentResult.currentSkill, "document-delivery");
  assert.equal(conceptResult.currentSkill, "concept-guide");
  const calls = (await readFile(piLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls[0].currentSkill, "document-delivery");
  assert.equal(calls[1].currentSkill, "concept-guide");
  assert.match(calls[0].prompt, /创建或修改业务文档，\s+并按退租规则生成报告。/);
  assert.match(calls[0].prompt, /按概念说明业务规则\n保留来源时间/);
  assert.match(calls[0].prompt, /capabilities: 文档生成、受限写入/);
  assert.match(calls[0].prompt, /capabilities: 概念核对、来源追踪/);
  assert.match(calls[0].prompt, /triggers: 退租文档、报告/);
  assert.match(calls[0].prompt, /tasks: concept/);
  assert.equal(calls[0].prompt.includes("trigger: >-"), false);
  assert.equal(calls[0].prompt.includes("trigger: |-"), false);
  assert.equal(calls[0].prompt.includes("DOC_SKILL_BODY"), false);
  assert.equal(calls[0].prompt.includes("CONCEPT_SKILL_BODY"), false);
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

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

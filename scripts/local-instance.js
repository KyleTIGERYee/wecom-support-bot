import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runAgentTurn } from "../src/agent.js";
import { createGuardClient } from "../src/model-client.js";
import { handleTurn } from "../src/orchestrate.js";
import { reviewReply } from "../src/guard.js";
import { createSessionState } from "../src/session-state.js";
import { createLocalResourceCatalog } from "../src/resource-catalog.js";

const execFileAsync = promisify(execFile);
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "ask") {
    await ask(args);
    return;
  }
  if (command !== "init") throw new Error("用法：local-instance.js init|ask [选项]");
  const options = parseInitArgs(args);
  const instanceDir = resolve(options.instanceDir);
  await mkdir(join(instanceDir, "context"), { recursive: true });
  await mkdir(join(instanceDir, "workspace"), { recursive: true });

  const contextSources = [];
  for (const [index, source] of options.sources.entries()) {
    const sourcePath = resolve(source.path);
    try {
      const sourceStat = await stat(sourcePath);
      const isPackage = sourceStat.isFile() && extname(sourcePath).toLowerCase() === ".zip";
      const type = isPackage ? "package" : sourceStat.isDirectory() ? "directory" : "file";
      const sourceName = isPackage ? basename(sourcePath, extname(sourcePath)) : basename(sourcePath);
      if (!["shared", "private"].includes(source.scope)) {
        contextSources.push({
          name: sourceName,
          type,
          scope: source.scope,
          status: "error",
          reason: "每个本地来源都必须明确共享或个人私有范围",
        });
        continue;
      }
      if (options.template === "team" && source.scope !== "shared") {
        contextSources.push({
          name: sourceName,
          type,
          scope: source.scope,
          status: "error",
          reason: "团队实例只能使用明确共享的来源",
        });
        continue;
      }
      const localPath = join("context", `${String(index + 1).padStart(3, "0")}-${sourceName}`);
      const targetPath = join(instanceDir, localPath);
      if (isPackage) {
        await mkdir(targetPath, { recursive: true });
        const { stdout: entries } = await execFileAsync("unzip", ["-Z1", sourcePath]);
        for (const entry of entries.split("\n").filter(Boolean)) {
          if (entry.startsWith("/") || entry.split(/[\\/]/).includes("..")) {
            throw new Error(`资源包包含越界路径：${entry}`);
          }
        }
        await execFileAsync("unzip", ["-q", sourcePath, "-d", targetPath]);
      } else {
        await cp(sourcePath, targetPath, { recursive: type === "directory", dereference: true });
      }
      if (type !== "file" && (await readLocalFiles(targetPath)).length === 0) {
        throw new Error("本地来源为空，没有可读取的文件");
      }
      contextSources.push({ name: sourceName, type, scope: source.scope, localPath, status: "ok" });
    } catch (error) {
      contextSources.push({
        name: basename(sourcePath),
        scope: source.scope,
        status: "error",
        reason: `本地来源不可读：${error?.message ?? error}`,
      });
    }
  }

  const mainModel = await checkModel(options.baseUrl, options.apiKey, options.model);
  const guardModel = await checkModel(options.guardBaseUrl, options.guardApiKey, options.guardModel);
  const sourcesReady = contextSources.length > 0 && contextSources.every((source) => source.status === "ok");
  const ready = sourcesReady && mainModel.status === "ok" && guardModel.status === "ok";
  const contextCheck =
    contextSources.length === 0
      ? { status: "error", reason: "未选择本地上下文来源" }
      : { status: sourcesReady ? "ok" : "error" };

  const config = {
    version: 1,
    ready,
    instance: { id: randomUUID(), template: options.template },
    initializedAt: new Date().toISOString(),
    models: {
      main: { baseUrl: options.baseUrl, model: options.model },
      guard: { baseUrl: options.guardBaseUrl, model: options.guardModel },
      executionApproval: { baseUrl: options.approvalBaseUrl, model: options.approvalModel },
    },
    contextSources,
    checks: { mainModel, guardModel, context: contextCheck },
  };
  await writeJson(join(instanceDir, "instance.json"), config);
  await writeJson(join(instanceDir, "secrets.json"), {
    mainApiKey: options.apiKey,
    guardApiKey: options.guardApiKey,
    executionApprovalApiKey: options.approvalApiKey,
  });
  await mkdir(join(instanceDir, "agent"), { recursive: true });
  await writeJson(join(instanceDir, "agent/models.json"), {
    providers: {
      "local-instance": {
        api: "openai-completions",
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        models: [
          {
            id: options.model,
            name: options.model,
            reasoning: true,
            input: ["text"],
            contextWindow: 200000,
            maxTokens: 32768,
          },
        ],
      },
    },
  });

  process.stdout.write(
    `${JSON.stringify({ ready, instanceDir, checks: { mainModel, guardModel, context: contextCheck, contextSources } })}\n`,
  );
  if (!ready) process.exitCode = 1;
}

async function ask(args) {
  const options = parseAskArgs(args);
  const instanceDir = resolve(options.instanceDir);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  if (!saved.ready) throw new Error("实例初始化检查未通过，不能启用");
  const secrets = JSON.parse(await readFile(join(instanceDir, "secrets.json"), "utf8"));
  const defaults = JSON.parse(await readFile(join(projectDir, "config/default.json"), "utf8"));
  const agentDir = join(instanceDir, "agent");
  const approvalModel = saved.models.executionApproval ?? saved.models.main;
  const workspaceDir = join(instanceDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const config = {
    ...defaults,
    projectDir,
    roots: [join(instanceDir, "context"), workspaceDir],
    writeRoots: [join(instanceDir, "context"), workspaceDir],
    protectedRoots: [projectDir],
    pi: {
      ...defaults.pi,
      binary: process.env.WECOM_BOT_PI_BINARY || join(homedir(), ".pi-support/bin/pi"),
      agentDir,
      provider: "local-instance",
      model: saved.models.main.model,
      systemPromptPath: join(projectDir, "prompts/local-instance.md"),
      localInstance: true,
    },
    guard: {
      ...defaults.guard,
      baseUrl: saved.models.guard.baseUrl,
      model: saved.models.guard.model,
      apiKey: secrets.guardApiKey,
    },
    executionApproval: {
      ...defaults.executionApproval,
      enabled: true,
      baseUrl: approvalModel.baseUrl,
      model: approvalModel.model,
      apiKey: secrets.executionApprovalApiKey ?? secrets.mainApiKey,
    },
  };

  const context = await createLocalResourceCatalog(instanceDir, saved.contextSources, saved.initializedAt ?? null);
  const state = createSessionState({
    storePath: join(instanceDir, "data/session-state.json"),
    rotation: config.rotation,
  });
  await state.load();
  const userKey = `local-${createHash("sha256").update(`${saved.instance.id}:${options.sessionKey}`).digest("hex").slice(0, 32)}`;
  const sessionKey = state.resolveSessionId(userKey, Date.now());
  const callModel = await createGuardClient({ config, agentDir });
  let lastInputTokens = 0;

  const result = await handleTurn({
    question: options.question,
    sessionKey,
    deps: {
      state,
      context: {
        catalog: context.text,
        dataPlaybook: context.dataPlaybook,
        entries: context.entries,
        skills: context.skills,
        workspaceDir,
      },
      runAgent: async ({ prompt, sessionId, currentSkill }) => {
        const turn = await runAgentTurn({
          prompt,
          sessionId,
          currentSkill,
          config,
          projectDir,
          resourceCatalog: context.entries,
          idleTimeoutMs: config.pi.idleTimeoutMs,
          hardTimeoutMs: config.pi.timeoutMs,
          thinkingLevel: config.pi.thinkingLevel,
        });
        lastInputTokens = turn.inputTokens || lastInputTokens;
        return turn;
      },
      review: ({ answer }) => reviewReply({ answer, callModel }),
    },
    maxRounds: config.guard.maxRounds,
    messages: {
      fallbackText: config.surface.fallbackText,
      errorText: config.surface.errorText,
      timeoutText: config.surface.timeoutText,
    },
  });
  state.recordActivity(userKey, { at: Date.now(), inputTokens: lastInputTokens });
  await state.flush();
  process.stdout.write(`${JSON.stringify({ ...result, instanceId: saved.instance.id, sessionId: sessionKey })}\n`);
}

function parseAskArgs(args) {
  const options = { sessionKey: "local-user" };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--instance-dir") options.instanceDir = value;
    else if (flag === "--question") options.question = value;
    else if (flag === "--session-key") options.sessionKey = value;
    else throw new Error(`未知选项：${flag}`);
  }
  if (!options.instanceDir || !options.question) throw new Error("ask 需要 --instance-dir 与 --question");
  return options;
}

async function readLocalFiles(path, prefix = "") {
  const info = await stat(path);
  if (info.isFile()) {
    return [{ name: prefix || basename(path), content: await readFile(path, "utf8") }];
  }
  if (!info.isDirectory()) throw new Error(`不支持的本地来源：${path}`);
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const childPath = join(path, entry.name);
    const childPrefix = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await readLocalFiles(childPath, childPrefix)));
    else if (entry.isFile()) files.push({ name: childPrefix, content: await readFile(childPath, "utf8") });
  }
  return files;
}

function parseInitArgs(args) {
  const options = { sources: [], template: "blank" };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--source") options.sources.push({ path: value, scope: undefined });
    else if (flag === "--scope") {
      if (options.sources.length === 0) throw new Error("--scope 必须跟在 --source 后面");
      options.sources.at(-1).scope = value;
    } else if (flag === "--instance-dir") options.instanceDir = value;
    else if (flag === "--template") options.template = value;
    else if (flag === "--base-url") options.baseUrl = value;
    else if (flag === "--api-key") options.apiKey = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--guard-base-url") options.guardBaseUrl = value;
    else if (flag === "--guard-api-key") options.guardApiKey = value;
    else if (flag === "--guard-model") options.guardModel = value;
    else if (flag === "--approval-base-url") options.approvalBaseUrl = value;
    else if (flag === "--approval-api-key") options.approvalApiKey = value;
    else if (flag === "--approval-model") options.approvalModel = value;
    else throw new Error(`未知选项：${flag}`);
  }
  for (const key of ["instanceDir", "baseUrl", "apiKey", "model"]) {
    if (!options[key]) throw new Error(`缺少必需选项：${key}`);
  }
  options.guardBaseUrl ??= options.baseUrl;
  options.guardApiKey ??= options.apiKey;
  options.guardModel ??= options.model;
  options.approvalBaseUrl ??= options.baseUrl;
  options.approvalApiKey ??= options.apiKey;
  options.approvalModel ??= options.model;
  return options;
}

async function checkModel(baseUrl, apiKey, model) {
  try {
    await testModel(baseUrl, apiKey, model);
    return { status: "ok" };
  } catch (error) {
    return { status: "error", reason: error?.message ?? String(error) };
  }
}

async function testModel(baseUrl, apiKey, model) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "连接测试，请回复 ok" }],
      temperature: 0,
      max_tokens: 8,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${model} 连接测试失败：HTTP ${response.status}`);
  const data = await response.json();
  if (!data?.choices?.[0]?.message?.content) throw new Error(`${model} 连接测试未返回内容`);
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

main().catch((error) => {
  process.stderr.write(`本地实例操作失败：${error?.message ?? error}\n`);
  process.exitCode = 1;
});

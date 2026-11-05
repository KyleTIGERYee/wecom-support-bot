import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runAgentTurn } from "../src/agent.js";
import { createGuardClient, createQuickClient } from "../src/model-client.js";
import { handleTurn } from "../src/orchestrate.js";
import { reviewReply } from "../src/guard.js";
import { classifyQuestion } from "../src/route.js";
import { createSessionState } from "../src/session-state.js";
import { createLocalResourceCatalog } from "../src/resource-catalog.js";
import { createLocalRuntimeConfig as createSharedLocalRuntimeConfig } from "../src/local-instance-config.js";

const execFileAsync = promisify(execFile);
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "ask") {
    await ask(args);
    return;
  }
  if (command === "init") {
    await init(args);
    return;
  }
  if (command === "sync") {
    await sync(args);
    return;
  }
  if (command === "status") {
    await status(args);
    return;
  }
  if (command === "export") {
    await exportInstance(args);
    return;
  }
  throw new Error("用法：local-instance.js init|ask|sync|status|export [选项]");
}

async function init(args) {
  const options = parseInitArgs(args);
  const instanceDir = resolve(options.instanceDir);
  await assertSafeInstanceDir(instanceDir);
  await mkdir(join(instanceDir, "workspace"), { recursive: true });
  const stagingDir = await createStagingDir(instanceDir);
  const importing = ["import", "existing"].includes(options.template);
  if (importing && !options.importPackage) throw new Error("既有实例导入需要 --package");
  let importedPackage = null;
  let contextSources;
  if (importing) {
    const packageDir = join(stagingDir, "package");
    await mkdir(packageDir, { recursive: true });
    await extractPackage(resolve(options.importPackage), packageDir);
    importedPackage = await readImportedPackage(packageDir);
    contextSources = await copyImportedSources(stagingDir, packageDir, importedPackage.config.contextSources);
  } else {
    contextSources = await copySources({ instanceDir, stagingDir, sources: options.sources, template: options.template });
  }
  applyModelDefaults(options, importedPackage?.config.models ?? {});
  const syncedAt = new Date().toISOString();
  const version = await hashSources(stagingDir, contextSources);
  for (const source of contextSources) {
    if (source.status === "ok") source.version = version;
  }
  const resources = {
    version,
    catalogVersion: version,
    syncedAt,
    files: await resourceManifest(stagingDir, contextSources),
    ...(importedPackage ? { importedFromVersion: importedPackage.config.resources?.version ?? null } : {}),
  };

  const mainModel = await checkModel(options.baseUrl, options.apiKey, options.model);
  const quickModel = sameModel(options, "quick")
    ? { ...mainModel, checkedAs: "main" }
    : await checkModel(options.quickBaseUrl, options.quickApiKey, options.quickModel);
  const approvalModel = sameModel(options, "approval")
    ? { ...mainModel, checkedAs: "main" }
    : await checkModel(options.approvalBaseUrl, options.approvalApiKey, options.approvalModel);
  const guardModel = await checkModel(options.guardBaseUrl, options.guardApiKey, options.guardModel);
  const sourcesReady = contextSources.length > 0 && contextSources.every((source) => source.status === "ok");
  const contextCheck =
    contextSources.length === 0
      ? { status: "error", executed: true, reason: "未选择本地上下文来源" }
      : { status: sourcesReady ? "ok" : "error", executed: true };
  let catalog = null;
  let catalogError = null;
  try {
    catalog = await createLocalResourceCatalog(stagingDir, contextSources, syncedAt);
  } catch (error) {
    catalogError = error?.message ?? String(error);
  }
  const secrets = {
    mainApiKey: options.apiKey,
    quickApiKey: options.quickApiKey,
    guardApiKey: options.guardApiKey,
    executionApprovalApiKey: options.approvalApiKey,
  };
  const config = {
    version: 2,
    ready: false,
    instance: { id: randomUUID(), template: importing ? "team" : options.template, ...(importing ? { imported: true } : {}) },
    initializedAt: syncedAt,
    models: {
      main: { baseUrl: options.baseUrl, model: options.model },
      quick: { baseUrl: options.quickBaseUrl, model: options.quickModel },
      guard: { baseUrl: options.guardBaseUrl, model: options.guardModel },
      executionApproval: { baseUrl: options.approvalBaseUrl, model: options.approvalModel },
    },
    contextSources,
    resources,
    checks: {},
  };
  await mkdir(join(stagingDir, "agent"), { recursive: true });
  await writeJson(join(stagingDir, "agent/models.json"), createPiModels(options));
  const functionalChecks = await runInitializationChecks({
    instanceDir,
    stagingDir,
    saved: config,
    secrets,
    catalog,
    catalogError,
    sourcesReady,
    mainModel,
    quickModel,
    approvalModel,
  });
  const checks = {
    mainModel,
    quickModel,
    approvalModel,
    guardModel,
    context: contextCheck,
    ...functionalChecks,
  };
  const ready =
    sourcesReady &&
    [mainModel, quickModel, approvalModel, guardModel, functionalChecks.executionApproval, functionalChecks.exampleTask].every(
      (check) => check.status === "ok",
    ) &&
    functionalChecks.knowledge.status !== "error" &&
    functionalChecks.skills.status !== "error";
  config.ready = ready;
  config.checks = checks;

  await commitContext({ instanceDir, stagingDir, config });
  await writeJson(join(instanceDir, "secrets.json"), secrets);
  await mkdir(join(instanceDir, "agent"), { recursive: true });
  await writeJson(join(instanceDir, "agent/models.json"), createPiModels(options));
  await writeJson(join(instanceDir, "sync-status.json"), {
    status: sourcesReady ? "ok" : "error",
    operation: importing ? "import" : "init",
    finishedAt: syncedAt,
    version,
  });

  process.stdout.write(
    `${JSON.stringify({ ready, instanceDir, resources, checks: { ...checks, contextSources } })}\n`,
  );
  if (!ready) process.exitCode = 1;
}

async function runInitializationChecks({
  instanceDir,
  stagingDir,
  saved,
  secrets,
  catalog,
  catalogError,
  sourcesReady,
  mainModel,
  quickModel,
  approvalModel,
}) {
  const knowledgeEntry = catalog?.entries.find((entry) => !entry.skillName) ?? null;
  const skill = catalog?.skills[0] ?? null;
  const knowledgeCount = catalog?.entries.filter((entry) => !entry.skillName).length ?? 0;
  let skipReason = null;
  if (!sourcesReady || !catalog) skipReason = catalogError ?? "本地来源未就绪，未执行真实 pi 检查";
  else if (mainModel.status !== "ok") skipReason = "主模型连接失败，未执行真实 pi 示例任务";
  else if (quickModel.status !== "ok") skipReason = "快速模型连接失败，未执行与 ask 相同的分诊和编排";

  let exampleResult = null;
  let lastTurn = null;
  let exampleError = null;
  if (!skipReason) {
    const question = [
      knowledgeEntry
        ? "初始化示例任务：这是实例就绪检查。请从目录选择一项本地知识并使用 read 实际读取。"
        : "初始化示例任务：这是实例就绪检查。本来源没有普通知识，不需要读取知识正文。",
      skill ? `同时按任务路由加载 ${skill.name} 的 SKILL.md 正文。` : "本来源没有 Skill，不需要读取 Skill。",
      "完成实际读取后只回答“示例任务完成”。不要创建任务产物。",
    ].join("\n");
    try {
      const executed = await executeLocalQuestion({
        instanceDir,
        question,
        sessionKey: "initialization-example",
        saved,
        secrets,
        requireReady: false,
        catalogRoot: stagingDir,
        workspaceDir: join(instanceDir, "workspace"),
        agentDir: join(stagingDir, "agent"),
        stateStorePath: join(stagingDir, "checks/example-session-state.json"),
      });
      exampleResult = executed.result;
      lastTurn = executed.lastTurn;
    } catch (error) {
      exampleError = error?.message ?? String(error);
    }
  }
  const committedPath = (path) =>
    typeof path === "string" && path.startsWith(`${stagingDir}/`)
      ? join(instanceDir, path.slice(stagingDir.length + 1))
      : path;
  const loadedResources = (exampleResult?.loadedResources ?? []).map((resource) => ({
    ...resource,
    path: committedPath(resource.path),
  }));
  const answer = exampleResult?.finalText?.trim() ?? "";
  const exampleOk = Boolean(
    !exampleError &&
    lastTurn &&
    !lastTurn.failed &&
    !lastTurn.timedOut &&
    !lastTurn.stalled &&
    answer.includes("示例任务完成"),
  );
  const exampleTask = skipReason
    ? { status: "skipped", executed: false, reason: skipReason }
    : {
        status: exampleOk ? "ok" : "error",
        executed: true,
        answer,
        loadedResources: loadedResources.map((resource) => resource.path),
        ...(exampleOk
          ? {}
          : { reason: exampleError ?? "真实 pi 示例任务未产生预期回答或执行失败" }),
      };
  const knowledgeLoadedPaths = loadedResources.filter((resource) => !resource.skillName).map((resource) => resource.path);
  const knowledgeLoaded = knowledgeLoadedPaths.length > 0;
  const knowledge = !knowledgeEntry
    ? catalog && catalog.skills.length > 0
      ? { status: "skipped", executed: false, reason: "来源仅包含 Skills，未执行知识正文检索" }
      : { status: "error", executed: true, reason: catalogError ?? "本地副本没有可检索的知识资源" }
    : skipReason
      ? { status: "skipped", executed: false, reason: skipReason, entries: knowledgeCount }
      : {
          status: knowledgeLoaded ? "ok" : "error",
          executed: true,
          entries: knowledgeCount,
          loadedResources: knowledgeLoadedPaths,
          ...(knowledgeLoaded ? {} : { reason: "示例任务没有实际完成本地知识 read" }),
        };
  const skillLoaded = loadedResources.some(
    (resource) => resource.path === committedPath(skill?.path) && resource.resourceType === "skill",
  );
  const skills = !sourcesReady || !catalog
    ? { status: "skipped", executed: false, reason: skipReason }
    : !skill
      ? { status: "skipped", executed: false, reason: "未选择 Skills，未执行 Skill 正文加载" }
      : skipReason
        ? { status: "skipped", executed: false, reason: skipReason, skills: catalog.skills.map((entry) => entry.name) }
        : {
            status: skillLoaded ? "ok" : "error",
            executed: true,
            skills: catalog.skills.map((entry) => entry.name),
            loadedResources: skillLoaded ? [committedPath(skill.path)] : [],
            ...(skillLoaded ? {} : { reason: "示例任务没有实际完成 Skill 正文 read" }),
          };
  const executionApproval = !sourcesReady || !catalog
    ? { status: "error", executed: false, reason: skipReason }
    : await checkExecutionApproval({ instanceDir, stagingDir, saved, secrets, mainModel, approvalModel });
  return { knowledge, skills, executionApproval, exampleTask };
}

async function checkExecutionApproval({ instanceDir, stagingDir, saved, secrets, mainModel, approvalModel }) {
  if (mainModel.status !== "ok" || approvalModel.status !== "ok") {
    return {
      status: "error",
      executed: false,
      reason: mainModel.reason ?? approvalModel.reason ?? "主模型或执行审批模型未就绪",
    };
  }
  const config = await createLocalRuntimeConfig({
    saved,
    secrets,
    catalogRoot: stagingDir,
    workspaceDir: join(instanceDir, "workspace"),
    agentDir: join(stagingDir, "agent"),
  });
  const allowedPath = join(instanceDir, "workspace", `.init-approval-${randomUUID()}.md`);
  const deniedPath = join(instanceDir, `.init-outside-${randomUUID()}.md`);
  let turn = null;
  let allowedContent = null;
  let checkError = null;
  try {
    turn = await runAgentTurn({
      prompt: [
        "INIT_EXECUTION_APPROVAL_CHECK：必须依次执行两次 write 工具，不得改成其他工具。",
        `INIT_APPROVAL_ALLOWED_PATH: ${allowedPath}`,
        "第一次向上述 ALLOWED_PATH 写入，content 精确为 INIT_APPROVAL_WRITE。",
        `INIT_APPROVAL_DENIED_PATH: ${deniedPath}`,
        "收到第一次工具结果后，第二次向上述 DENIED_PATH 写入，content 为 INIT_OUTSIDE_WRITE。",
        "第二次应被硬规则拒绝；收到拒绝后回答“审批检查完成”。",
      ].join("\n"),
      sessionId: `initialization-approval-${randomUUID()}`,
      config,
      projectDir,
      resourceCatalog: [],
      idleTimeoutMs: config.pi.idleTimeoutMs,
      hardTimeoutMs: config.pi.timeoutMs,
      thinkingLevel: config.pi.thinkingLevel,
    });
    if (await pathExists(allowedPath)) allowedContent = await readFile(allowedPath, "utf8");
  } catch (error) {
    checkError = error?.message ?? String(error);
  } finally {
    await rm(allowedPath, { force: true });
    await rm(deniedPath, { force: true });
  }
  const approvals = turn?.executionApprovals ?? [];
  const allowed = approvals.find((entry) => entry.target === allowedPath && entry.verdict === "ALLOW" && entry.source === "model");
  const denied = approvals.find((entry) => entry.target === deniedPath && entry.verdict === "DENY" && entry.source === "hard-rule");
  const ok = Boolean(
    turn &&
    !turn.failed &&
    !turn.timedOut &&
    !turn.stalled &&
    allowedContent === "INIT_APPROVAL_WRITE" &&
    allowed &&
    denied &&
    !(await pathExists(deniedPath)),
  );
  return {
    status: ok ? "ok" : "error",
    executed: true,
    writeRoots: ["context", "workspace"],
    protectedRoots: ["project"],
    approvals,
    ...(ok ? {} : { reason: checkError ?? "未观察到获批 workspace 写入和越界硬拒绝的完整审批证据" }),
  };
}

async function sync(args) {
  const options = parseSyncArgs(args);
  const instanceDir = resolve(options.instanceDir);
  await assertSafeInstanceDir(instanceDir);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  const startedAt = new Date().toISOString();
  const stagingDir = await createStagingDir(instanceDir);
  let commitStarted = false;
  try {
    const contextSources = await copySources({
      instanceDir,
      stagingDir,
      sources: options.sources,
      template: saved.instance.template,
    });
    if (contextSources.length === 0 || contextSources.some((source) => source.status !== "ok")) {
      throw new Error(contextSources[0]?.reason ?? "同步至少需要一个可读取的标准资源来源");
    }
    const syncedAt = new Date().toISOString();
    const version = await hashSources(stagingDir, contextSources);
    for (const source of contextSources) source.version = version;
    await createLocalResourceCatalog(stagingDir, contextSources, syncedAt);
    const resources = {
      version,
      catalogVersion: version,
      syncedAt,
      files: await resourceManifest(stagingDir, contextSources),
    };
    const config = {
      ...saved,
      contextSources,
      resources,
      checks: {
        ...saved.checks,
        context: { status: "ok" },
      },
    };
    const lastSync = { status: "ok", operation: "sync", startedAt, finishedAt: syncedAt, version };
    commitStarted = true;
    await commitContext({ instanceDir, stagingDir, config, lastSync });
    process.stdout.write(`${JSON.stringify({ ...lastSync, resources, contextSources })}\n`);
  } catch (error) {
    if (!commitStarted) await rm(stagingDir, { recursive: true, force: true });
    const lastSync = {
      status: "error",
      operation: "sync",
      startedAt,
      finishedAt: new Date().toISOString(),
      version: saved.resources?.version ?? null,
      reason: error?.message ?? String(error),
    };
    if (!commitStarted) await writeJson(join(instanceDir, "sync-status.json"), lastSync);
    process.stdout.write(`${JSON.stringify(lastSync)}\n`);
    process.exitCode = 1;
  }
}

async function status(args) {
  const options = parseInstanceArgs(args, "status");
  const instanceDir = resolve(options.instanceDir);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  const loadFailures = [];
  let catalog = null;
  try {
    catalog = await createLocalResourceCatalog(instanceDir, saved.contextSources, saved.resources?.syncedAt ?? saved.initializedAt);
  } catch (error) {
    loadFailures.push({ source: "catalog", reason: error?.message ?? String(error) });
  }
  const coverageSources = [];
  for (const source of saved.contextSources ?? []) {
    if (source.status !== "ok" || !source.localPath) {
      loadFailures.push({ source: source.name, reason: source.reason ?? "来源未就绪" });
      coverageSources.push({ name: source.name, scope: source.scope, status: source.status, files: 0, skills: 0 });
      continue;
    }
    try {
      const files = await readLocalFiles(resolve(instanceDir, source.localPath));
      coverageSources.push({
        name: source.name,
        scope: source.scope,
        status: "ok",
        files: files.length,
        skills: files.filter((file) => basename(file.name) === "SKILL.md").length,
      });
    } catch (error) {
      loadFailures.push({ source: source.name, reason: error?.message ?? String(error) });
      coverageSources.push({ name: source.name, scope: source.scope, status: "error", files: 0, skills: 0 });
    }
  }
  for (const path of saved.resources?.files ?? []) {
    if (!(await pathExists(resolve(instanceDir, path)))) {
      loadFailures.push({ source: "context", reason: `标准资源文件缺失：${path}` });
    }
  }
  const actualVersion = loadFailures.length === 0 ? await hashSources(instanceDir, saved.contextSources) : null;
  let lastSync = null;
  try {
    lastSync = JSON.parse(await readFile(join(instanceDir, "sync-status.json"), "utf8"));
  } catch {
    lastSync = { status: "unknown", reason: "尚未记录同步状态" };
  }
  const coverage = {
    sources: coverageSources,
    files: coverageSources.reduce((total, source) => total + source.files, 0),
    knowledge: catalog?.entries.filter((entry) => !entry.skillName).length ?? 0,
    skills: catalog?.skills.length ?? 0,
    shared: catalog?.entries.filter((entry) => entry.scope === "shared").length ?? 0,
    private: catalog?.entries.filter((entry) => entry.scope === "private").length ?? 0,
  };
  const version = saved.resources?.version ?? null;
  process.stdout.write(
    `${JSON.stringify({
      instanceId: saved.instance.id,
      template: saved.instance.template,
      ready: saved.ready,
      resources: {
        version,
        catalogVersion: catalog ? actualVersion : null,
        actualVersion,
        syncedAt: saved.resources?.syncedAt ?? saved.initializedAt ?? null,
        consistent: Boolean(catalog && loadFailures.length === 0 && actualVersion),
        matchesSyncedVersion: Boolean(version && actualVersion === version),
      },
      lastSync,
      loadFailures,
      coverage,
    })}\n`,
  );
}

async function exportInstance(args) {
  const options = parseExportArgs(args);
  const instanceDir = resolve(options.instanceDir);
  const output = resolve(options.output);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  const sharedSources = (saved.contextSources ?? [])
    .filter((source) => source.status === "ok" && source.scope === "shared" && source.localPath)
    .map((source) => ({
      name: source.name,
      type: source.type,
      scope: "shared",
      localPath: source.localPath,
      status: "ok",
    }));
  if (sharedSources.length === 0) throw new Error("没有可分发的明确共享资源");
  const stagingDir = await createStagingDir(instanceDir);
  try {
    for (const source of sharedSources) {
      await cp(resolve(instanceDir, source.localPath), resolve(stagingDir, source.localPath), {
        recursive: true,
        dereference: false,
      });
    }
    await assertNoSymlinks(join(stagingDir, "context"));
    const version = await hashSources(stagingDir, sharedSources);
    for (const source of sharedSources) source.version = version;
    const models = Object.fromEntries(
      Object.entries(saved.models ?? {}).map(([role, config]) => [role, { baseUrl: config.baseUrl, model: config.model }]),
    );
    const packageConfig = {
      version: 2,
      ready: false,
      instance: { template: "team" },
      models,
      contextSources: sharedSources,
      resources: { version, catalogVersion: version, files: await resourceManifest(stagingDir, sharedSources) },
    };
    await writeJson(join(stagingDir, "instance.json"), packageConfig);
    await writeJson(join(stagingDir, "instance-package.json"), {
      format: "wecom-support-bot-team-instance",
      formatVersion: 1,
      resourceVersion: version,
      createdAt: new Date().toISOString(),
    });
    await rm(output, { force: true });
    await execFileAsync("zip", ["-q", "-r", output, "."], { cwd: stagingDir });
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        output,
        resourceVersion: version,
        sharedSources: sharedSources.length,
        excludedPrivateSources: (saved.contextSources ?? []).filter((source) => source.scope !== "shared").length,
      })}\n`,
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function readImportedPackage(packageDir) {
  await assertNoSymlinks(packageDir);
  const files = await readLocalFiles(packageDir);
  for (const file of files) {
    const name = file.name.replaceAll("\\", "/");
    if (name !== "instance.json" && name !== "instance-package.json" && !name.startsWith("context/")) {
      throw new Error(`导入包包含不允许的实例状态或凭证：${name}`);
    }
  }
  const manifest = JSON.parse(await readFile(join(packageDir, "instance-package.json"), "utf8"));
  if (manifest.format !== "wecom-support-bot-team-instance" || manifest.formatVersion !== 1) {
    throw new Error("不是受支持的团队实例分发包");
  }
  const config = JSON.parse(await readFile(join(packageDir, "instance.json"), "utf8"));
  if (!Array.isArray(config.contextSources) || config.contextSources.length === 0) {
    throw new Error("导入包没有共享标准资源");
  }
  return { config, manifest };
}

async function copyImportedSources(stagingDir, packageDir, sources) {
  const contextSources = [];
  for (const source of sources) {
    if (source.scope !== "shared" || typeof source.localPath !== "string") {
      throw new Error("导入包只能包含明确共享的标准资源");
    }
    const normalized = source.localPath.replaceAll("\\", "/");
    if (!normalized.startsWith("context/") || normalized.split("/").includes("..")) {
      throw new Error("导入包包含越界资源路径");
    }
    const sourcePath = resolve(packageDir, normalized);
    const targetPath = resolve(stagingDir, normalized);
    const packageRoot = resolve(packageDir, "context");
    const targetRoot = resolve(stagingDir, "context");
    if (!sourcePath.startsWith(`${packageRoot}/`) || !targetPath.startsWith(`${targetRoot}/`)) {
      throw new Error("导入包资源路径越出共享副本");
    }
    await cp(sourcePath, targetPath, { recursive: true, dereference: false });
    contextSources.push({
      name: source.name,
      type: source.type,
      scope: "shared",
      localPath: normalized,
      status: "ok",
    });
  }
  return contextSources;
}

async function assertNoSymlinks(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`资源不允许符号链接：${basename(path)}`);
  if (!info.isDirectory()) return;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`资源包不允许符号链接：${entry.name}`);
    if (entry.isDirectory()) await assertNoSymlinks(join(path, entry.name));
  }
}

async function createStagingDir(instanceDir) {
  await mkdir(instanceDir, { recursive: true });
  const stagingDir = join(instanceDir, `.resources-${randomUUID()}`);
  await mkdir(join(stagingDir, "context"), { recursive: true });
  return stagingDir;
}

async function copySources({ instanceDir, stagingDir, sources, template }) {
  const contextSources = [];
  for (const [index, source] of sources.entries()) {
    let sourcePath = resolve(source.path);
    let gitlabSource = null;
    let targetPath = null;
    try {
      const requestedType = source.type ?? "auto";
      if (!["auto", "directory", "file", "package", "gitlab"].includes(requestedType)) {
        throw new Error(`不支持的来源类型：${requestedType}`);
      }
      if (requestedType === "gitlab") {
        gitlabSource = parseGitlabSource(source.path);
        sourcePath = gitlabSource.path;
      }
      const sourceName = requestedType === "gitlab"
        ? gitlabSource.name
        : requestedType === "package" || (requestedType === "auto" && extname(sourcePath).toLowerCase() === ".zip")
          ? basename(sourcePath, extname(sourcePath))
          : basename(sourcePath);
      if (!["shared", "private"].includes(source.scope)) {
        contextSources.push({
          name: sourceName,
          type: requestedType,
          scope: source.scope,
          status: "error",
          reason: "每个本地来源都必须明确共享或个人私有范围",
        });
        continue;
      }
      if (template === "team" && source.scope !== "shared") {
        contextSources.push({
          name: sourceName,
          type: requestedType,
          scope: source.scope,
          status: "error",
          reason: "团队实例只能使用明确共享的来源",
        });
        continue;
      }
      if (!gitlabSource || gitlabSource.local) await assertSourceTargetSeparated(sourcePath, instanceDir);
      let readPath = sourcePath;
      if (requestedType === "gitlab") {
        const checkout = join(stagingDir, `gitlab-checkout-${index + 1}`);
        const cloneArgs = ["clone", "--quiet", "--no-hardlinks", "--depth", "1"];
        if (source.ref) {
          if (source.ref.startsWith("-")) throw new Error("GitLab ref 不能是命令选项");
          cloneArgs.push("--branch", source.ref);
        }
        cloneArgs.push("--", sourcePath, checkout);
        await execFileAsync("git", cloneArgs, {
          env: { ...process.env, GIT_ALLOW_PROTOCOL: gitlabSource.protocols, GIT_TERMINAL_PROMPT: "0" },
        });
        await rm(join(checkout, ".git"), { recursive: true, force: true });
        readPath = checkout;
      }
      const sourceStat = await stat(readPath);
      const detectedType = sourceStat.isDirectory()
        ? "directory"
        : sourceStat.isFile() && (requestedType === "package" || extname(sourcePath).toLowerCase() === ".zip")
          ? "package"
          : "file";
      const type = requestedType === "gitlab" ? "gitlab" : requestedType === "auto" ? detectedType : requestedType;
      if (requestedType !== "auto" && requestedType !== "gitlab" && type !== detectedType) {
        throw new Error(`来源实际类型与 --source-type ${requestedType} 不一致`);
      }
      const localPath = join("context", `${String(index + 1).padStart(3, "0")}-${sourceName}`);
      targetPath = join(stagingDir, localPath);
      if (detectedType === "package") {
        await mkdir(targetPath, { recursive: true });
        await extractPackage(readPath, targetPath);
      } else {
        await cp(readPath, targetPath, { recursive: detectedType === "directory", dereference: false });
      }
      await assertNoSymlinks(targetPath);
      if (detectedType !== "file" && (await readLocalFiles(targetPath)).length === 0) {
        throw new Error("本地来源为空，没有可读取的文件");
      }
      contextSources.push({ name: sourceName, type, scope: source.scope, localPath, status: "ok" });
    } catch (error) {
      if (targetPath) await rm(targetPath, { recursive: true, force: true });
      contextSources.push({
        name: gitlabSource?.name ?? basename(sourcePath),
        scope: source.scope,
        status: "error",
        reason: `本地来源不可读：${redactSourceCredentials(error?.message ?? error)}`,
      });
    }
  }
  return contextSources;
}

function parseGitlabSource(source) {
  if (source.startsWith("file://")) {
    const path = fileURLToPath(source);
    return { path, local: true, protocols: "file", name: basename(path).replace(/\.git$/i, "") };
  }
  if (/^https?:\/\//i.test(source) || /^ssh:\/\//i.test(source)) {
    const url = new URL(source);
    const name = basename(url.pathname).replace(/\.git$/i, "");
    if (!name) throw new Error("GitLab 来源必须包含仓库路径");
    return {
      path: source,
      local: false,
      protocols: url.protocol === "ssh:" ? "ssh" : "http:https",
      name,
    };
  }
  if (/^[^/\s@]+@[^/\s:]+:.+/.test(source)) {
    const repositoryPath = source.slice(source.indexOf(":") + 1);
    const name = basename(repositoryPath).replace(/\.git$/i, "");
    if (!name) throw new Error("GitLab 来源必须包含仓库路径");
    return { path: source, local: false, protocols: "ssh", name };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw new Error("GitLab 只支持 file、HTTP(S) 或 SSH 来源");
  const path = resolve(source);
  return { path, local: true, protocols: "file", name: basename(path).replace(/\.git$/i, "") };
}

function redactSourceCredentials(value) {
  return String(value).replace(/((?:https?|ssh):\/\/)[^\s/@]+@/gi, "$1***@");
}

async function assertSafeInstanceDir(instanceDir) {
  const protectedRoots = ["/", homedir(), projectDir, dirname(projectDir)];
  if (protectedRoots.includes(instanceDir)) {
    throw new Error("实例目录不能是系统根、用户主目录、主工作区或项目保护根");
  }
  const realInstance = await resolveRealPath(instanceDir);
  for (const protectedRoot of protectedRoots) {
    if (realInstance === await resolveRealPath(protectedRoot)) {
      throw new Error("实例目录的真实路径不能是系统根、用户主目录、主工作区或项目保护根");
    }
  }
}

async function assertSourceTargetSeparated(sourcePath, instanceDir) {
  const realSource = await resolveRealPath(sourcePath);
  const targetRoots = [
    instanceDir,
    join(instanceDir, "context"),
    join(instanceDir, "workspace"),
    join(instanceDir, "data"),
    join(instanceDir, "data/session-state.json"),
  ];
  for (const targetRoot of targetRoots) {
    if (pathsOverlap(realSource, await resolveRealPath(targetRoot))) {
      throw new Error("同步来源与实例目录、context、workspace 或会话状态的真实路径不能相同或互相包含");
    }
  }
  for (const protectedRoot of [projectDir, dirname(projectDir), homedir()]) {
    const realProtected = await resolveRealPath(protectedRoot);
    if (realSource === realProtected || realProtected.startsWith(`${realSource}/`)) {
      throw new Error("保护根不能直接作为同步来源或包含在来源中，请选择明确共享的子目录或资源包");
    }
  }
}

/** 已存在路径直接 realpath；不存在尾部从最近的已存在祖先解析，避免符号链接别名绕过。 */
async function resolveRealPath(path) {
  let current = resolve(path);
  const missing = [];
  while (true) {
    try {
      const resolved = await realpath(current);
      return join(resolved, ...missing);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error(`不能解析悬空符号链接：${current}`);
      } catch (lstatError) {
        if (lstatError?.code !== "ENOENT") throw lstatError;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

async function extractPackage(sourcePath, targetPath) {
  const { stdout: entries } = await execFileAsync("unzip", ["-Z1", sourcePath]);
  for (const entry of entries.split("\n").filter(Boolean)) {
    if (entry.startsWith("/") || /^[a-z]:\//i.test(entry) || entry.split(/[\\/]/).includes("..")) {
      throw new Error(`资源包包含越界路径：${entry}`);
    }
  }
  await execFileAsync("unzip", ["-q", sourcePath, "-d", targetPath]);
}

async function commitContext({ instanceDir, stagingDir, config, lastSync = null }) {
  const entries = [
    {
      name: "context",
      current: join(instanceDir, "context"),
      staged: join(stagingDir, "context"),
      backup: join(stagingDir, "previous-context"),
      oldMoved: false,
      newMoved: false,
    },
    {
      name: "instance.json",
      current: join(instanceDir, "instance.json"),
      staged: join(stagingDir, "instance.json"),
      backup: join(stagingDir, "previous-instance.json"),
      oldMoved: false,
      newMoved: false,
    },
  ];
  if (lastSync) {
    entries.push({
      name: "sync-status.json",
      current: join(instanceDir, "sync-status.json"),
      staged: join(stagingDir, "sync-status.json"),
      backup: join(stagingDir, "previous-sync-status.json"),
      oldMoved: false,
      newMoved: false,
    });
  }
  try {
    await writeJson(join(stagingDir, "instance.json"), config);
    if (lastSync) await writeJson(join(stagingDir, "sync-status.json"), lastSync);
    for (const entry of entries) {
      if (await pathExists(entry.current)) {
        await rename(entry.current, entry.backup);
        entry.oldMoved = true;
      }
      if (entry.name === "sync-status.json" && process.env.WECOM_BOT_TEST_FAIL_SYNC_STATUS_COMMIT === "1") {
        throw new Error("注入的 sync-status 提交失败");
      }
      await rename(entry.staged, entry.current);
      entry.newMoved = true;
    }
  } catch (error) {
    for (const entry of [...entries].reverse()) {
      if (entry.newMoved) await rename(entry.current, join(stagingDir, `failed-${entry.name}`)).catch(() => {});
      if (entry.oldMoved) await rename(entry.backup, entry.current).catch(() => {});
    }
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  await rm(stagingDir, { recursive: true, force: true });
}

async function hashSources(rootDir, sources) {
  const okSources = sources.filter((source) => source.status === "ok" && source.localPath);
  if (okSources.length === 0) return null;
  const hash = createHash("sha256");
  for (const source of okSources) {
    hash.update(`${source.name}\0${source.scope}\0${source.localPath}\0`);
    await hashPath(resolve(rootDir, source.localPath), "", hash);
  }
  return hash.digest("hex");
}

async function hashPath(path, prefix, hash) {
  const info = await stat(path);
  if (info.isFile()) {
    hash.update(`${prefix || basename(path)}\0`);
    hash.update(await readFile(path));
    hash.update("\0");
    return;
  }
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    await hashPath(join(path, entry.name), prefix ? join(prefix, entry.name) : entry.name, hash);
  }
}

async function resourceManifest(rootDir, sources) {
  const manifest = [];
  for (const source of sources.filter((candidate) => candidate.status === "ok" && candidate.localPath)) {
    const sourceRoot = resolve(rootDir, source.localPath);
    if ((await stat(sourceRoot)).isFile()) {
      manifest.push(source.localPath);
      continue;
    }
    const files = await listRelativeFiles(sourceRoot);
    for (const file of files) manifest.push(join(source.localPath, file));
  }
  return manifest.sort();
}

async function listRelativeFiles(path, prefix = "") {
  const info = await stat(path);
  if (info.isFile()) return [prefix || basename(path)];
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    const childPrefix = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(join(path, entry.name), childPrefix)));
    else if (entry.isFile()) files.push(childPrefix);
  }
  return files;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ask(args) {
  const options = parseAskArgs(args);
  const { result } = await executeLocalQuestion({
    instanceDir: resolve(options.instanceDir),
    question: options.question,
    sessionKey: options.sessionKey,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function executeLocalQuestion({
  instanceDir,
  question,
  sessionKey,
  saved = null,
  secrets = null,
  requireReady = true,
  catalogRoot = instanceDir,
  workspaceDir = join(instanceDir, "workspace"),
  agentDir = join(instanceDir, "agent"),
  stateStorePath = join(instanceDir, "data/session-state.json"),
}) {
  saved ??= JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  if (requireReady && !saved.ready) throw new Error("实例初始化检查未通过，不能启用");
  secrets ??= JSON.parse(await readFile(join(instanceDir, "secrets.json"), "utf8"));
  const config = await createLocalRuntimeConfig({ saved, secrets, catalogRoot, workspaceDir, agentDir });
  await mkdir(workspaceDir, { recursive: true });

  const context = await createLocalResourceCatalog(
    catalogRoot,
    saved.contextSources,
    saved.resources?.syncedAt ?? saved.initializedAt ?? null,
  );
  const state = createSessionState({ storePath: stateStorePath, rotation: config.rotation });
  await state.load();
  const userKey = `local-${createHash("sha256").update(`${saved.instance.id}:${sessionKey}`).digest("hex").slice(0, 32)}`;
  const resolvedSessionKey = state.resolveSessionId(userKey, Date.now());
  const callModel = await createGuardClient({ config, agentDir });
  const callQuickModel = await createQuickClient({ config, agentDir });
  const route = await classifyQuestion({ question, callModel: callQuickModel });
  const turnConfig = route === "quick"
    ? {
        ...config,
        pi: {
          ...config.pi,
          provider: "local-instance-quick",
          model: saved.models.quick?.model ?? saved.models.main.model,
        },
      }
    : config;
  const thinkingLevel = config.pi.thinkingLevels?.[route] ?? config.pi.thinkingLevel;
  let lastInputTokens = 0;
  let lastTurn = null;

  const result = await handleTurn({
    question,
    sessionKey: resolvedSessionKey,
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
          config: turnConfig,
          projectDir,
          resourceCatalog: context.entries,
          idleTimeoutMs: config.pi.idleTimeoutMs,
          hardTimeoutMs: config.pi.timeoutMs,
          thinkingLevel,
        });
        lastTurn = turn;
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
  return {
    result: { ...result, instanceId: saved.instance.id, sessionId: resolvedSessionKey },
    lastTurn,
  };
}

async function createLocalRuntimeConfig(options) {
  const defaults = JSON.parse(await readFile(join(projectDir, "config/default.json"), "utf8"));
  return createSharedLocalRuntimeConfig({ ...options, projectDir, defaults });
}

function parseExportArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--instance-dir") options.instanceDir = value;
    else if (flag === "--output") options.output = value;
    else throw new Error(`export 未知选项：${flag}`);
  }
  if (!options.instanceDir || !options.output) throw new Error("export 需要 --instance-dir 与 --output");
  return options;
}

function parseSyncArgs(args) {
  const options = { sources: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--instance-dir") options.instanceDir = value;
    else if (flag === "--source") options.sources.push({ path: value, scope: undefined });
    else if (flag === "--source-type") {
      if (options.sources.length === 0) throw new Error("--source-type 必须跟在 --source 后面");
      options.sources.at(-1).type = value;
    } else if (flag === "--ref") {
      if (options.sources.length === 0) throw new Error("--ref 必须跟在 --source 后面");
      options.sources.at(-1).ref = value;
    } else if (flag === "--scope") {
      if (options.sources.length === 0) throw new Error("--scope 必须跟在 --source 后面");
      options.sources.at(-1).scope = value;
    } else throw new Error(`未知选项：${flag}`);
  }
  if (!options.instanceDir) throw new Error("sync 需要 --instance-dir");
  return options;
}

function parseInstanceArgs(args, command) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} 缺少值`);
    index += 1;
    if (flag === "--instance-dir") options.instanceDir = value;
    else throw new Error(`${command} 未知选项：${flag}`);
  }
  if (!options.instanceDir) throw new Error(`${command} 需要 --instance-dir`);
  return options;
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
    else if (flag === "--source-type") {
      if (options.sources.length === 0) throw new Error("--source-type 必须跟在 --source 后面");
      options.sources.at(-1).type = value;
    } else if (flag === "--ref") {
      if (options.sources.length === 0) throw new Error("--ref 必须跟在 --source 后面");
      options.sources.at(-1).ref = value;
    } else if (flag === "--scope") {
      if (options.sources.length === 0) throw new Error("--scope 必须跟在 --source 后面");
      options.sources.at(-1).scope = value;
    } else if (flag === "--instance-dir") options.instanceDir = value;
    else if (flag === "--template") options.template = value;
    else if (flag === "--package") options.importPackage = value;
    else if (flag === "--base-url") options.baseUrl = value;
    else if (flag === "--api-key") options.apiKey = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--quick-base-url") options.quickBaseUrl = value;
    else if (flag === "--quick-api-key") options.quickApiKey = value;
    else if (flag === "--quick-model") options.quickModel = value;
    else if (flag === "--guard-base-url") options.guardBaseUrl = value;
    else if (flag === "--guard-api-key") options.guardApiKey = value;
    else if (flag === "--guard-model") options.guardModel = value;
    else if (flag === "--approval-base-url") options.approvalBaseUrl = value;
    else if (flag === "--approval-api-key") options.approvalApiKey = value;
    else if (flag === "--approval-model") options.approvalModel = value;
    else throw new Error(`未知选项：${flag}`);
  }
  for (const key of ["instanceDir", "apiKey"]) {
    if (!options[key]) throw new Error(`缺少必需选项：${key}`);
  }
  if (!["import", "existing"].includes(options.template)) {
    for (const key of ["baseUrl", "model"]) {
      if (!options[key]) throw new Error(`缺少必需选项：${key}`);
    }
  }
  return options;
}

function applyModelDefaults(options, packagedModels) {
  options.baseUrl ??= packagedModels.main?.baseUrl;
  options.model ??= packagedModels.main?.model;
  if (!options.baseUrl || !options.model) throw new Error("初始化需要可用的主模型地址与名称");
  for (const [prefix, role] of [["quick", "quick"], ["guard", "guard"], ["approval", "executionApproval"]]) {
    options[`${prefix}BaseUrl`] ??= packagedModels[role]?.baseUrl ?? options.baseUrl;
    options[`${prefix}ApiKey`] ??= options.apiKey;
    options[`${prefix}Model`] ??= packagedModels[role]?.model ?? options.model;
  }
}

function sameModel(options, role) {
  const prefix = role === "quick" ? "quick" : "approval";
  return (
    options[`${prefix}BaseUrl`] === options.baseUrl &&
    options[`${prefix}ApiKey`] === options.apiKey &&
    options[`${prefix}Model`] === options.model
  );
}

function createPiModels(options) {
  return {
    providers: {
      "local-instance": createPiProvider(options.baseUrl, options.apiKey, options.model),
      "local-instance-quick": createPiProvider(options.quickBaseUrl, options.quickApiKey, options.quickModel),
      "local-instance-approval": createPiProvider(options.approvalBaseUrl, options.approvalApiKey, options.approvalModel),
      "local-instance-guard": createPiProvider(options.guardBaseUrl, options.guardApiKey, options.guardModel),
    },
  };
}

function createPiProvider(baseUrl, apiKey, model) {
  return {
    api: "openai-completions",
    baseUrl,
    apiKey,
    models: [
      {
        id: model,
        name: model,
        reasoning: true,
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 32768,
      },
    ],
  };
}

async function checkModel(baseUrl, apiKey, model) {
  try {
    await testModel(baseUrl, apiKey, model);
    return { status: "ok", executed: true };
  } catch (error) {
    return { status: "error", executed: true, reason: error?.message ?? String(error) };
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

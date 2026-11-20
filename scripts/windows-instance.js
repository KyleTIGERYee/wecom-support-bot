import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_MANIFEST = "windows-package.json";
const STATE_MANIFEST = "migration-state.json";
const SERVICE_NAME = "wecom-support-bot.service";
const CONFIRMS = {
  "state-export": "EXPORT_STATE",
  "state-merge": "MERGE_STATE",
  "cutover-old": "STOP_OLD_PRODUCTION",
  "cutover-new": "ACTIVATE_NEW_PRODUCTION",
  "rollback-new": "STOP_WINDOWS_PRODUCTION",
  "rollback-old": "RESTORE_OLD_PRODUCTION",
};
const ACCEPTANCE_SCENARIOS = {
  "progressive-loading": ["simple-concept", "concrete-rule", "data-query", "history-current"],
  "skills-work-product": ["create-work-product", "modify-work-product", "sync-preserves-work-product"],
  "execution-approval": ["approved-workspace-write", "outside-write-denied", "approval-failure-closed", "no-authorization-propagation"],
  "output-guard": ["sensitive-rework", "repeated-deny-fallback", "guard-failure-closed", "question-not-sent-to-guard"],
  "wecom-text": ["single-chat", "group-chat"],
  "wecom-image": ["pure-image", "mixed-image-text", "image-failure"],
  "long-task": ["handoff-background-push"],
  "disconnect-recovery": ["sigterm-drain", "recovery-within-window", "stale-not-recovered", "disconnect-restart"],
  "final-delivery": ["inline-stream", "stream-failure-push", "all-failed"],
  "migration-comparison": ["fixed-question-comparison"],
};
const ACCEPTANCE_CASES = Object.keys(ACCEPTANCE_SCENARIOS);
const PACKAGE_FILES = [
  "package.json",
  "package-lock.json",
  "CONTEXT.md",
  "config/default.json",
  "extensions/bash-whitelist.ts",
  "prompts/local-instance.md",
  "scripts/local-instance.js",
  "scripts/windows-instance.js",
  "docs/regression-questions.md",
  "docs/windows-wsl2.md",
  "docs/windows-acceptance.md",
  "docs/windows-migration-questions.json",
];

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const options = parseArgs(argv);
  switch (command) {
    case "install-plan":
      return output(createInstallPlan(options));
    case "build-package":
      return output(await buildPackage(options));
    case "verify-package":
      return output(await verifyPackage(required(options, "packageDir")));
    case "validate-model-url":
      return output(validateModelUrl(required(options, "url")));
    case "configure-channel":
      return output(await configureChannel(options));
    case "runtime-check":
      return output(await runtimeCheck(required(options, "instanceDir")));
    case "service-unit":
      return output(await writeServiceUnit(options));
    case "acceptance-create":
      return output(await acceptanceCreate(options));
    case "acceptance-update":
      return output(await acceptanceUpdate(options));
    case "acceptance-run":
      return output(await acceptanceRun(options));
    case "acceptance-compare":
      return output(await acceptanceCompare(options));
    case "state-export":
      return output(await stateExport(options));
    case "state-merge":
      return output(await stateMerge(options));
    case "cutover-old":
      return output(await cutoverOld(options));
    case "cutover-new":
      return output(await cutoverNew(options));
    case "rollback-new":
      return output(await rollbackNew(options));
    case "rollback-old":
      return output(await rollbackOld(options));
    default:
      throw new Error(
        "用法：windows-instance.js install-plan|build-package|verify-package|validate-model-url|configure-channel|runtime-check|service-unit|acceptance-create|acceptance-update|acceptance-run|acceptance-compare|state-export|state-merge|cutover-old|cutover-new|rollback-new|rollback-old [选项]",
      );
  }
}

function parseArgs(argv) {
  const result = { execute: false, sourceStopped: false, targetStopped: false, activateTest: false };
  const booleans = new Set(["execute", "sourceStopped", "targetStopped", "activateTest", "legacy"]);
  result.legacy = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) throw new Error(`无法识别参数：${flag}`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (booleans.has(key)) {
      result[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少值`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function required(options, key) {
  if (!options[key]) throw new Error(`缺少必需选项 --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  return options[key];
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function createInstallPlan(options) {
  const distro = options.distro ?? "Ubuntu-24.04";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(distro)) throw new Error("WSL 发行版名称只能包含字母、数字、点、下划线和连字符");
  const paths = {
    projectDir: options.projectDir ?? "/opt/wecom-support-bot/app",
    instanceDir: options.instanceDir ?? "/var/lib/wecom-support-bot/instance",
    runtimeDir: options.runtimeDir ?? "/opt/wecom-support-bot/runtime",
  };
  for (const path of Object.values(paths)) assertNativeLinuxPath(path);
  return {
    status: "planned",
    executes: false,
    distro,
    requiresAdministrator: true,
    reboot: { exitWithoutRestart: true, resumeFlag: "-Resume" },
    paths,
    linuxUser: "wecom",
    packageLayout: {
      manifest: PACKAGE_MANIFEST,
      installer: "windows/install.ps1",
      wslPlan: "windows/wsl-plan.json",
      linuxInstaller: "windows/linux/install.sh",
    },
    windowsCommands: {
      planOnly: [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "<package>/windows/install.ps1",
        "-PlanOnly",
      ],
      resume: [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "<package>/windows/install.ps1",
        "-Resume",
      ],
    },
    wslCommands: {
      update: ["wsl.exe", "--update"],
      installDistro: ["wsl.exe", "--install", "--distribution", distro, "--no-launch"],
      setDefaultVersion: ["wsl.exe", "--set-default-version", "2"],
      setDistroVersion: ["wsl.exe", "--set-version", distro, "2"],
      installLinux: [
        "wsl.exe",
        "--distribution",
        distro,
        "--user",
        "root",
        "--",
        "bash",
        "<package>/windows/linux/install.sh",
        "--bundle",
        "<package>",
        "--project-dir",
        paths.projectDir,
        "--instance-dir",
        paths.instanceDir,
        "--runtime-dir",
        paths.runtimeDir,
      ],
    },
    safeguards: [
      "启用系统功能前显式确认；需要重启时只保存续装状态并退出，不自动重启",
      "项目、实例与运行时均在 Linux 原生文件系统，不使用 /mnt/c 作为运行目录",
      "Node、pi、Python 与 npm 依赖在目标 Linux 重新安装，不复制 Mac 产物",
    ],
  };
}

function assertNativeLinuxPath(path) {
  if (!path.startsWith("/") || path.includes("\n") || path.includes("\r") || path.split("/").includes("..")) {
    throw new Error(`Linux 路径无效：${path}`);
  }
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(path)) throw new Error(`运行目录不能位于 Windows 挂载盘：${path}`);
}

async function buildPackage(options) {
  const sourceDir = resolve(options.sourceDir ?? projectDir);
  const outputDir = resolve(required(options, "output"));
  if (outputDir === sourceDir || outputDir.startsWith(`${sourceDir}${sep}`)) {
    throw new Error("安装包输出目录不能位于源项目内，避免把私人文件递归纳入");
  }
  await assertEmptyOrMissing(outputDir);
  const staging = `${outputDir}.staging-${randomUUID()}`;
  const files = [...PACKAGE_FILES];
  for (const directory of ["src", "windows"]) {
    for (const path of await listFiles(join(sourceDir, directory))) files.push(relative(sourceDir, path));
  }
  files.sort();
  await mkdir(staging, { recursive: true });
  try {
    for (const name of files) {
      const source = join(sourceDir, name);
      const target = join(staging, name);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: false, dereference: false });
    }
    // default.json 在源仓库含 Mac 私人路径；安装包只保留跨平台运行参数。
    const defaults = JSON.parse(await readFile(join(sourceDir, "config/default.json"), "utf8"));
    const sanitized = {
      ...defaults,
      pi: { ...defaults.pi, binary: "", agentDir: "", provider: "", model: "" },
      roots: {},
      guard: { ...defaults.guard, baseUrl: "", model: "" },
      executionApproval: { ...defaults.executionApproval, baseUrl: "", model: "" },
    };
    await writeFile(join(staging, "config/default.json"), `${JSON.stringify(sanitized, null, 2)}\n`);
    const plan = createInstallPlan({});
    await writeFile(join(staging, "windows/wsl-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    files.push("windows/wsl-plan.json");
    const entries = [];
    for (const name of files.sort()) entries.push({ path: name.replaceAll(sep, "/"), sha256: await hashFile(join(staging, name)) });
    await writeJson(join(staging, PACKAGE_MANIFEST), {
      format: "wecom-support-bot-windows-installer",
      formatVersion: 1,
      nodeEngine: JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8")).engines.node,
      files: entries,
    });
    await verifyPackage(staging);
    await rename(staging, outputDir);
    return { status: "ok", output: outputDir, files: entries.length, excludes: ["secrets", "private sources", "runtime state", "node_modules", "launchd", "Mac pi"] };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function verifyPackage(packageDir) {
  const root = resolve(packageDir);
  const manifest = await readJson(join(root, PACKAGE_MANIFEST));
  if (manifest.format !== "wecom-support-bot-windows-installer" || manifest.formatVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("不是受支持的 Windows 安装资源包");
  }
  const actualFiles = (await listFiles(root)).map((path) => relative(root, path).replaceAll(sep, "/"));
  const expectedFiles = new Set([PACKAGE_MANIFEST, ...manifest.files.map((entry) => entry.path)]);
  const extras = actualFiles.filter((path) => !expectedFiles.has(path));
  if (extras.length > 0) throw new Error(`安装包包含未登记内容：${extras.join(", ")}`);
  const missing = [...expectedFiles].filter((path) => !actualFiles.includes(path));
  if (missing.length > 0) throw new Error(`安装包缺少登记内容：${missing.join(", ")}`);
  for (const entry of manifest.files) {
    const name = entry.path;
    assertSafeRelativePath(name);
    if (/^(?:config\/secrets|data\/|context\/|workspace\/|node_modules\/|launchd\/|\.git\/)/.test(name)) {
      throw new Error(`安装包包含禁止内容：${name}`);
    }
    const path = join(root, name);
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`安装包不允许符号链接：${name}`);
    if ((await hashFile(path)) !== entry.sha256) throw new Error(`安装包文件校验失败：${name}`);
  }
  return { status: "ok", packageDir: root, files: manifest.files.length, nodeEngine: manifest.nodeEngine };
}

async function assertEmptyOrMissing(path) {
  try {
    const entries = await readdir(path);
    if (entries.length > 0) throw new Error(`输出目录必须为空：${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function listFiles(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`安装资源不允许符号链接：${child}`);
    if (entry.isDirectory()) result.push(...(await listFiles(child)));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

function validateModelUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("模型地址必须是完整 HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("模型地址只支持 HTTP(S)");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host) || host.endsWith(".localhost")) {
    throw new Error("原机器的 localhost/127.0.0.1 在 WSL 中指向 WSL 自己，不能沿用；请填写 Windows 主机可达地址或实际模型 URL");
  }
  return { status: "ok", url: value, addressValidation: "ok", connectionTest: "not-run", note: "这里只校验地址；真实连接测试必须由 WSL 内的 instance init 执行" };
}

async function configureChannel(options) {
  const instanceDir = resolve(required(options, "instanceDir"));
  const kind = required(options, "kind");
  if (!["test", "production"].includes(kind)) throw new Error("企微机器人类型只能是 test 或 production");
  const botId = required(options, "botId");
  const secret = required(options, "secret");
  const path = join(instanceDir, "wecom.json");
  const channels = (await pathExists(path)) ? await readJson(path) : { active: "none" };
  channels[kind] = { botId, secret };
  if (kind === "test") channels.active = "test";
  await writeJson(path, channels, 0o600);
  return { status: "ok", configured: kind, active: channels.active, botIdFingerprint: fingerprint(botId), productionActivation: kind === "production" ? "cutover-only" : "test-selected" };
}

async function runtimeCheck(instanceDirValue) {
  const instanceDir = resolve(instanceDirValue);
  assertNativeLinuxPath(instanceDir);
  const saved = await readJson(join(instanceDir, "instance.json"));
  const channels = await readJson(join(instanceDir, "wecom.json"));
  if (!saved.ready) throw new Error("实例初始化检查未通过");
  if (!["test", "production"].includes(channels.active) || !channels[channels.active]?.botId || !channels[channels.active]?.secret) {
    throw new Error("当前企微机器人尚未配置");
  }
  for (const [role, model] of Object.entries(saved.models ?? {})) validateModelUrl(model.baseUrl);
  const [{ loadConfig }, { createLocalResourceCatalog }] = await Promise.all([
    import("../src/config.js"),
    import("../src/resource-catalog.js"),
  ]);
  const config = await loadConfig(projectDir, { env: { ...process.env, WECOM_BOT_INSTANCE_DIR: instanceDir } });
  const catalog = await createLocalResourceCatalog(instanceDir, saved.contextSources, saved.resources?.syncedAt ?? saved.initializedAt ?? null);
  return {
    status: "ok",
    instanceId: saved.instance.id,
    activeChannel: channels.active,
    resourceVersion: saved.resources?.version ?? null,
    runtime: { instanceDir, projectDir: "/opt/wecom-support-bot/app", nativeLinuxPaths: true },
    roots: config.roots,
    workspaceDir: join(instanceDir, "workspace"),
    catalog: { entries: catalog.entries.length, skills: catalog.skills.length },
    modelConnection: "由 WSL 内 instance init 的真实检查结论确认；本命令不重新声称连接成功",
  };
}

async function writeServiceUnit(options) {
  const paths = {
    projectDir: options.projectDir ?? "/opt/wecom-support-bot/app",
    instanceDir: options.instanceDir ?? "/var/lib/wecom-support-bot/instance",
    runtimeDir: options.runtimeDir ?? "/opt/wecom-support-bot/runtime",
  };
  Object.values(paths).forEach(assertNativeLinuxPath);
  const user = options.user ?? "wecom";
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error("systemd 运行用户名无效");
  const contents = `[Unit]\nDescription=WeCom support bot (local instance)\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${user}\nGroup=${user}\nWorkingDirectory=${paths.projectDir}\nEnvironment=NODE_ENV=production\nEnvironment=WECOM_BOT_INSTANCE_DIR=${paths.instanceDir}\nEnvironment=WECOM_BOT_PI_BINARY=${paths.runtimeDir}/pi/bin/pi\nEnvironment=PATH=${paths.runtimeDir}/node/bin:${paths.runtimeDir}/pi/bin:/usr/local/bin:/usr/bin:/bin\nExecStart=${paths.runtimeDir}/node/bin/node ${paths.projectDir}/src/index.js\nRestart=always\nRestartSec=10\nKillSignal=SIGTERM\nTimeoutStopSec=40\n\n[Install]\nWantedBy=multi-user.target\n`;
  if (options.output) {
    const outputPath = resolve(options.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, contents, { mode: 0o644 });
  }
  return { status: options.output ? "written" : "rendered", output: options.output ? resolve(options.output) : null, contents };
}

async function acceptanceCreate(options) {
  const instanceDir = resolve(required(options, "instanceDir"));
  const outputPath = resolve(required(options, "output"));
  const saved = await readJson(join(instanceDir, "instance.json"));
  const channels = await readJson(join(instanceDir, "wecom.json"));
  if (!saved.ready) throw new Error("实例尚未通过初始化，不能创建验收记录");
  if (channels.active !== "test" || !channels.test?.botId) throw new Error("全链路验收必须使用独立测试机器人，不能选择正式机器人");
  if (!channels.production?.botId) throw new Error("请先保存正式机器人配置；正式通道只保存，不会在验收阶段启用");
  if (channels.test.botId === channels.production.botId) throw new Error("测试机器人与正式机器人 botId 必须不同");
  const record = {
    format: "wecom-support-bot-windows-acceptance",
    formatVersion: 2,
    createdAt: new Date().toISOString(),
    targetInstanceId: saved.instance.id,
    resourceVersion: saved.resources?.version ?? null,
    models: modelBaseline(saved.models),
    testBotFingerprint: fingerprint(channels.test.botId),
    productionBotFingerprint: fingerprint(channels.production.botId),
    cases: Object.fromEntries(ACCEPTANCE_CASES.map((id) => [id, { status: "pending", evidence: null, evidenceSha256: null, updatedAt: null }])),
  };
  await writeJson(outputPath, record, 0o600);
  return { status: "created", output: outputPath, requiredCases: ACCEPTANCE_CASES, readyForCutover: false };
}

async function acceptanceUpdate(options) {
  const path = resolve(required(options, "record"));
  const id = required(options, "case");
  const statusValue = required(options, "status");
  if (!ACCEPTANCE_CASES.includes(id)) throw new Error(`未知验收项：${id}`);
  if (!["pending", "passed", "failed"].includes(statusValue)) throw new Error("验收状态只能是 pending、passed 或 failed；必需项不允许 skipped");
  const record = await readJson(path);
  validateAcceptanceShape(record);
  const evidence = options.evidence ?? null;
  let evidenceSha256 = null;
  if (statusValue === "passed") {
    if (!evidence) throw new Error("通过验收必须提供结构化 JSON 证据路径");
    const evidencePath = resolve(dirname(path), evidence);
    evidenceSha256 = await validateAcceptanceEvidence(record, id, evidencePath);
  }
  record.cases[id] = { status: statusValue, evidence, evidenceSha256, updatedAt: new Date().toISOString() };
  await writeJson(path, record, 0o600);
  return { status: "updated", case: id, verdict: statusValue, readyForCutover: await acceptanceReady(record, path) };
}

async function acceptanceRun(options) {
  const instanceDir = resolve(required(options, "instanceDir"));
  const questionsPath = resolve(required(options, "questions"));
  const outputPath = resolve(required(options, "output"));
  const questions = await readJson(questionsPath);
  const fixed = await validateFixedQuestionSet(questions);
  const saved = await readJson(join(instanceDir, "instance.json"));
  if (!saved.ready) throw new Error("实例初始化检查未通过，不能运行固定问题验收");
  const results = [];
  for (const [index, item] of fixed.entries()) {
    const { id, question, questionSha256 } = item;
    let result = null;
    let executed = false;
    let executionStatus = "completed";
    let errorMessage = null;
    try {
      executed = true;
      const { stdout } = await execFileAsync(process.execPath, [
        join(projectDir, "scripts/local-instance.js"),
        "ask",
        "--instance-dir",
        instanceDir,
        "--question",
        question,
        "--session-key",
        `windows-migration-${id}`,
      ], { cwd: projectDir, env: process.env, maxBuffer: 16 * 1024 * 1024 });
      result = JSON.parse(stdout);
      if (typeof result.finalText !== "string" || !result.finalText.trim() || result.failed || result.timedOut || result.stalled) {
        executionStatus = "failed";
        errorMessage = "ask 未产生完整最终答复";
      }
    } catch (error) {
      executionStatus = "failed";
      errorMessage = error?.message ?? String(error);
    }
    results.push({ id, question, questionSha256, executed, executionStatus, result, ...(errorMessage ? { error: errorMessage } : {}) });
  }
  const report = {
    format: "wecom-support-bot-migration-answers",
    formatVersion: 2,
    status: results.every((entry) => entry.executionStatus === "completed") ? "completed" : "failed",
    instanceId: saved.instance.id,
    resourceVersion: saved.resources?.version ?? null,
    models: modelBaseline(saved.models),
    questionSetSha256: fixedQuestionSetHash(fixed),
    results,
  };
  await writeJson(outputPath, report, 0o600);
  return { status: report.status, output: outputPath, questions: results.length, failed: results.filter((entry) => entry.executionStatus !== "completed").length };
}

async function acceptanceCompare(options) {
  const before = await readJson(resolve(required(options, "before")));
  const after = await readJson(resolve(required(options, "after")));
  const fixed = await readFixedQuestions();
  validateAnswerReport(before, fixed);
  validateAnswerReport(after, fixed);
  assertSameBaseline(before, after);
  const afterById = new Map(after.results.map((entry) => [entry.id, entry]));
  const comparisons = before.results.map((entry) => ({
    id: entry.id,
    question: entry.question,
    questionSha256: entry.questionSha256,
    before: publicAnswer(entry.result),
    after: afterById.has(entry.id) ? publicAnswer(afterById.get(entry.id).result) : null,
  }));
  const missingAfter = comparisons.filter((entry) => !entry.after).map((entry) => entry.id);
  const extraAfter = after.results.filter((entry) => !before.results.some((candidate) => candidate.id === entry.id)).map((entry) => entry.id);
  const report = {
    format: "wecom-support-bot-migration-comparison",
    formatVersion: 2,
    status: missingAfter.length || extraAfter.length ? "failed" : "pending-human-review",
    note: "模型输出允许合理措辞差异；必须人工核对答案口径、实际加载资源与审批行为，不把自动比较冒充通过",
    resourceVersion: before.resourceVersion,
    models: before.models,
    questionSetSha256: fixedQuestionSetHash(fixed),
    missingAfter,
    extraAfter,
    comparisons,
  };
  const outputPath = resolve(required(options, "output"));
  await writeJson(outputPath, report, 0o600);
  return { status: report.status, output: outputPath, comparisons: comparisons.length, missingAfter, extraAfter };
}

async function readFixedQuestions() {
  const fixed = await readJson(join(projectDir, "docs/windows-migration-questions.json"));
  if (!Array.isArray(fixed) || fixed.length === 0) throw new Error("仓库固定问题清单为空或无效");
  const ids = new Set();
  for (const item of fixed) {
    if (!item || typeof item.id !== "string" || typeof item.question !== "string" || !/^[0-9a-f]{64}$/.test(item.questionSha256 ?? "")) throw new Error("仓库固定问题清单缺少稳定 ID、正文或 SHA-256");
    if (ids.has(item.id)) throw new Error(`仓库固定问题 ID 重复：${item.id}`);
    ids.add(item.id);
    if (fingerprint(item.question) !== item.questionSha256) throw new Error(`仓库固定问题 ${item.id} 的正文 SHA-256 不匹配`);
  }
  return fixed.map(({ id, question, questionSha256 }) => ({ id, question, questionSha256 }));
}

async function validateFixedQuestionSet(questions) {
  const fixed = await readFixedQuestions();
  if (!Array.isArray(questions) || questions.length !== fixed.length) throw new Error(`固定问题清单必须恰好包含 ${fixed.length} 题，漏题或加题均不允许`);
  for (const [index, expected] of fixed.entries()) {
    const actual = questions[index];
    if (!actual || actual.id !== expected.id || actual.question !== expected.question) throw new Error(`固定问题 ${expected.id} 的 ID 顺序或正文被修改`);
    if (fingerprint(actual.question) !== expected.questionSha256) throw new Error(`固定问题 ${expected.id} 的正文 SHA-256 不匹配`);
  }
  return fixed;
}

function fixedQuestionSetHash(fixed) {
  return fingerprint(JSON.stringify(fixed.map(({ id, questionSha256 }) => ({ id, questionSha256 }))));
}

function validateAnswerReport(report, fixed) {
  if (report.format !== "wecom-support-bot-migration-answers" || report.formatVersion !== 2 || !Array.isArray(report.results)) throw new Error("不是受支持的迁移问题结果");
  if (report.status !== "completed") throw new Error("固定问题尚未全部真实执行完成，不能生成通过对照");
  if (report.questionSetSha256 !== fixedQuestionSetHash(fixed)) throw new Error("迁移问题结果不属于仓库固定问题清单");
  if (report.results.length !== fixed.length) throw new Error("迁移问题结果漏题或包含额外问题");
  for (const [index, expected] of fixed.entries()) {
    const entry = report.results[index];
    if (!entry || entry.id !== expected.id || entry.question !== expected.question || entry.questionSha256 !== expected.questionSha256) throw new Error(`迁移结果 ${expected.id} 的稳定 ID、正文或内容哈希不符合固定清单`);
    if (entry.executed !== true || entry.executionStatus !== "completed" || !entry.result || typeof entry.result.finalText !== "string" || !entry.result.finalText.trim()) throw new Error(`固定问题 ${expected.id} 没有真实完成结果，不能标为通过`);
  }
}

function publicAnswer(result) {
  return {
    answer: result.finalText,
    loadedResources: (result.loadedResources ?? []).map((resource) => ({ source: resource.source, resourceType: resource.resourceType, depth: resource.depth, verification: resource.verification })),
    loadedSkills: result.loadedSkills ?? [],
    executionApprovals: (result.executionApprovals ?? []).map(({ toolName, verdict, source, reason, riskCategory }) => ({ toolName, verdict, source, reason, riskCategory })),
    guarded: result.guarded,
    rounds: result.rounds,
  };
}

function assertSameBaseline(before, after) {
  if (before.resourceVersion !== after.resourceVersion) throw new Error("迁移前后标准资源版本不同；先同步到同一版本再验收");
  if (JSON.stringify(before.models) !== JSON.stringify(after.models)) throw new Error("迁移前后模型名称不同；迁移不得捆绑模型升级");
}

function modelBaseline(models) {
  return Object.fromEntries(Object.entries(models ?? {}).map(([role, value]) => [role, { model: value.model }]));
}

function validateAcceptanceShape(record) {
  if (record.format !== "wecom-support-bot-windows-acceptance" || record.formatVersion !== 2 || !record.cases) throw new Error("不是受支持的 Windows 验收记录");
  for (const id of ACCEPTANCE_CASES) if (!record.cases[id]) throw new Error(`验收记录缺少必需项：${id}`);
}

async function acceptanceReady(record, recordPath) {
  validateAcceptanceShape(record);
  for (const id of ACCEPTANCE_CASES) {
    const item = record.cases[id];
    if (item.status !== "passed" || !item.evidence || !item.evidenceSha256) return false;
    const evidencePath = resolve(dirname(recordPath), item.evidence);
    const actualHash = await validateAcceptanceEvidence(record, id, evidencePath);
    if (actualHash !== item.evidenceSha256) throw new Error(`验收项 ${id} 的主证据在登记后被修改，必须重新登记`);
  }
  return true;
}

async function validateAcceptanceEvidence(record, id, evidencePath) {
  const evidence = await readAcceptanceJson(evidencePath, "主证据");
  if (evidence.format !== "wecom-support-bot-windows-acceptance-evidence" || evidence.formatVersion !== 1 || evidence.caseId !== id || evidence.status !== "passed") throw new Error(`验收项 ${id} 的主证据格式、项目或通过状态无效`);
  if (!evidence.testBotId || fingerprint(evidence.testBotId) !== record.testBotFingerprint || fingerprint(evidence.testBotId) === record.productionBotFingerprint) throw new Error(`验收项 ${id} 必须使用记录绑定的独立测试机器人 botId，不能使用正式 botId`);
  if (evidence.targetInstanceId !== record.targetInstanceId || evidence.resourceVersion !== record.resourceVersion) throw new Error(`验收项 ${id} 的实例或资源基线不匹配`);
  if (evidence.environment?.platform !== "windows-wsl2") throw new Error(`验收项 ${id} 缺少真实 Windows/WSL2 环境声明；Mac fixture 不能冒充实机验收`);
  assertConcreteEvidenceValue(evidence.environment.distribution, `${id} WSL 发行版`);
  assertConcreteEvidenceValue(evidence.environment.windowsVersion, `${id} Windows 版本`);
  if (!evidence.humanReview || evidence.humanReview.approved !== true) throw new Error(`验收项 ${id} 缺少人工复核批准`);
  assertConcreteEvidenceValue(evidence.humanReview.reviewer, `${id} 人工复核人`);
  assertConcreteEvidenceValue(evidence.humanReview.notes, `${id} 人工复核意见`);
  assertEvidenceDate(evidence.humanReview.reviewedAt, `${id} 人工复核时间`);
  assertEvidenceDate(evidence.createdAt, `${id} 证据创建时间`);
  const requiredScenarios = ACCEPTANCE_SCENARIOS[id];
  if (!Array.isArray(evidence.scenarios) || evidence.scenarios.length !== requiredScenarios.length) throw new Error(`验收项 ${id} 缺少必需场景或包含额外场景`);
  for (const [index, scenarioId] of requiredScenarios.entries()) {
    const scenario = evidence.scenarios[index];
    if (!scenario || scenario.id !== scenarioId || scenario.status !== "passed") throw new Error(`验收项 ${id} 缺少真实 passed 场景：${scenarioId}`);
    if (typeof scenario.resultPath !== "string" || !/^[0-9a-f]{64}$/.test(scenario.resultSha256 ?? "")) throw new Error(`场景 ${scenarioId} 缺少结果文件或 SHA-256`);
    assertSafeRelativePath(scenario.resultPath);
    const resultPath = resolve(dirname(evidencePath), scenario.resultPath);
    if ((await hashFile(resultPath).catch(() => null)) !== scenario.resultSha256) throw new Error(`场景 ${scenarioId} 的结果文件不存在或 SHA-256 不匹配`);
    const result = await readAcceptanceJson(resultPath, `场景 ${scenarioId} 结果`);
    if (id === "migration-comparison") await validateComparisonReport(result, record);
    else validateScenarioResult(result, { record, evidence, id, scenarioId });
  }
  return hashFile(evidencePath);
}

function validateScenarioResult(result, { record, evidence, id, scenarioId }) {
  if (result.format !== "wecom-support-bot-windows-acceptance-result" || result.formatVersion !== 1 || result.caseId !== id || result.scenarioId !== scenarioId) throw new Error(`场景 ${scenarioId} 的结果格式或身份无效`);
  if (result.executed !== true || result.status !== "passed") throw new Error(`场景 ${scenarioId} 没有真实执行并得到 passed 结果`);
  if (!result.testBotId || fingerprint(result.testBotId) !== record.testBotFingerprint || result.testBotId !== evidence.testBotId) throw new Error(`场景 ${scenarioId} 未绑定同一独立测试机器人`);
  if (result.targetInstanceId !== record.targetInstanceId || result.resourceVersion !== record.resourceVersion) throw new Error(`场景 ${scenarioId} 的目标实例或资源基线不匹配`);
  assertEvidenceDate(result.executedAt, `场景 ${scenarioId} 执行时间`);
  assertConcreteEvidenceValue(result.result, `场景 ${scenarioId} 具体结果`);
}

async function validateComparisonReport(report, record) {
  const fixed = await readFixedQuestions();
  if (report.format !== "wecom-support-bot-migration-comparison" || report.formatVersion !== 2 || report.status !== "pending-human-review" || !Array.isArray(report.comparisons)) throw new Error("迁移对照必须是已生成、待人工复核的结构化报告，不能直接伪造 passed");
  if (report.questionSetSha256 !== fixedQuestionSetHash(fixed) || report.comparisons.length !== fixed.length) throw new Error("迁移对照的固定问题清单被换题或漏题");
  if (report.resourceVersion !== record.resourceVersion || JSON.stringify(report.models) !== JSON.stringify(record.models)) throw new Error("迁移对照的资源或模型基线与验收记录不一致");
  if (report.missingAfter?.length || report.extraAfter?.length) throw new Error("迁移对照存在漏题或额外问题");
  for (const [index, expected] of fixed.entries()) {
    const comparison = report.comparisons[index];
    if (!comparison || comparison.id !== expected.id || comparison.question !== expected.question || comparison.questionSha256 !== expected.questionSha256) throw new Error(`迁移对照 ${expected.id} 的稳定 ID、正文或内容哈希不符合固定清单`);
    assertConcreteEvidenceValue(comparison.before, `迁移对照 ${expected.id} 旧端结果`);
    assertConcreteEvidenceValue(comparison.after, `迁移对照 ${expected.id} 新端结果`);
  }
}

async function readAcceptanceJson(path, label) {
  try {
    const value = await readJson(path);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("顶层必须是 JSON 对象");
    return value;
  } catch (error) {
    throw new Error(`${label}不存在、不可读取或不是可解析 JSON：${path}（${error.message}）`);
  }
}

function assertEvidenceDate(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label}无效`);
}

function assertConcreteEvidenceValue(value, label) {
  if (value === null || value === undefined) throw new Error(`${label}为空或属于伪造占位`);
  if (typeof value === "string") {
    if (value.trim().length < 3 || /^(?:placeholder|todo|tbd|dummy|fake|not-run|pending|n\/?a|未运行|待补|待填|伪造|占位)$/i.test(value.trim())) throw new Error(`${label}为空或属于伪造占位`);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertConcreteEvidenceValue(item, `${label}[${index}]`);
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) throw new Error(`${label}为空或属于伪造占位`);
    for (const [key, item] of entries) assertConcreteEvidenceValue(item, `${label}.${key}`);
  }
}

function acceptanceReadyError() {
  return new Error("测试机器人固定验收项尚未全部通过，或结构化证据、固定场景、独立 botId、人工复核未通过，禁止正式切换");
}

async function stateExport(options, internal = {}) {
  const instanceDir = resolve(required(options, "instanceDir"));
  const outputDir = resolve(required(options, "output"));
  if (outputDir === instanceDir || outputDir.startsWith(`${instanceDir}${sep}`) || instanceDir.startsWith(`${outputDir}${sep}`)) {
    throw new Error("迁移状态包与实例目录不能互相包含");
  }
  const files = await collectStateFiles(instanceDir, options.legacyAgentDir);
  const plan = { status: options.execute ? "executing" : "planned", executes: Boolean(options.execute), instanceDir, output: outputDir, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), excludes: ["context", "secrets.json", "wecom.json", "agent/models.json", "credentials/auth/token/provider keys", "data/images", "data/files", "locks", "node_modules", "launchd"] };
  if (!options.execute) return plan;
  requireConfirmation(options, "state-export", internal.confirmOverride);
  if (!options.sourceStopped && !internal.stoppedVerified) throw new Error("正式导出必须确认源服务已停止（--source-stopped），避免导出半写入状态");
  await assertEmptyOrMissing(outputDir);
  const staging = `${outputDir}.staging-${randomUUID()}`;
  await mkdir(join(staging, "state"), { recursive: true });
  try {
    const entries = [];
    for (const file of files) {
      const target = join(staging, "state", file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await cp(file.absolutePath, target, { recursive: false, dereference: false });
      await assertSafeStateContents(target, file.relativePath);
      entries.push({ path: file.relativePath, sha256: await hashFile(target), size: (await stat(target)).size });
    }
    const saved = (await pathExists(join(instanceDir, "instance.json"))) ? await readJson(join(instanceDir, "instance.json")) : null;
    await writeJson(join(staging, STATE_MANIFEST), {
      format: "wecom-support-bot-runtime-state",
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      sourceInstanceId: saved?.instance?.id ?? "legacy",
      files: entries,
    });
    await rename(staging, outputDir);
    return { ...plan, status: "ok", manifest: join(outputDir, STATE_MANIFEST), manifestSha256: await hashFile(join(outputDir, STATE_MANIFEST)) };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function collectStateFiles(instanceDir, legacyAgentDir = null) {
  const agentDir = legacyAgentDir ? resolve(legacyAgentDir) : join(instanceDir, "agent");
  const files = [];
  const addFile = async (absolutePath, relativePath) => {
    assertStatePath(relativePath);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`迁移状态只允许普通文件：${relativePath}`);
    await assertSafeStateContents(absolutePath, relativePath);
    files.push({ relativePath, absolutePath, size: info.size });
  };
  for (const name of ["data/inbox.jsonl", "data/session-state.json"]) {
    const absolutePath = join(instanceDir, name);
    if (await pathExists(absolutePath)) await addFile(absolutePath, name);
  }
  const roots = [
    { relativeRoot: "workspace", absoluteRoot: join(instanceDir, "workspace") },
    { relativeRoot: "agent/sessions", absoluteRoot: join(agentDir, "sessions") },
  ];
  for (const root of roots) {
    if (!(await pathExists(root.absoluteRoot))) continue;
    for (const absolutePath of await listFiles(root.absoluteRoot)) {
      const suffix = relative(root.absoluteRoot, absolutePath);
      const relativePath = join(root.relativeRoot, suffix).replaceAll(sep, "/");
      await addFile(absolutePath, relativePath);
    }
  }
  // 旧 pi 可能把会话 JSONL 直接写在 agent 根下。只收集这些明确会话文件，
  // 保留 agent/<name>.jsonl 相对路径，绝不把 models/凭证或整个 agent 塞入 sessions。
  if (await pathExists(agentDir)) {
    for (const entry of await readdir(agentDir, { withFileTypes: true })) {
      if (!entry.name.toLowerCase().endsWith(".jsonl")) continue;
      const relativePath = `agent/${entry.name}`;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      await addFile(join(agentDir, entry.name), relativePath);
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function hasForbiddenStateSegment(path) {
  return path.toLowerCase().split("/").some((segment) => {
    if (["node_modules", ".git", ".env", ".npmrc", ".pypirc", ".netrc", ".gitcredentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "models.json", "credentials", "credentials.json", "auth", "auth.json", "token", "token.json", "provider.json", "providers.json", "secrets.json", "wecom.json"].includes(segment)) return true;
    if (/^\.env(?:\..*)?$/.test(segment)) return true;
    if (/\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx|secrets?|credentials?|tokens?)$/.test(segment)) return true;
    if (/(?:^|[._-])(?:credentials?|auth|tokens?|secrets?)(?:[._-]|$)/.test(segment)) return true;
    return /provider.*(?:key|secret|credential|token)|(?:key|secret|credential|token).*provider/.test(segment);
  });
}

/**
 * 状态包不能把“不在小型黑名单里”误认为安全。所有文本都扫描，已知图片校验签名；
 * 其他二进制无法可靠判断时整包失败，绝不静默剔除后继续导出造成回滚丢任务。
 */
async function assertSafeStateContents(absolutePath, relativePath) {
  const contents = await readFile(absolutePath);
  if (isSupportedStateImage(absolutePath, contents)) {
    assertNoSecretText(contents.toString("latin1"), relativePath);
    return;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error(`无法安全判断的迁移状态二进制文件：${relativePath}；只允许带有效签名的 PNG/JPEG/GIF/WEBP 图片，其他产物请先转为可扫描文本`);
  }
  if (text.includes("\0")) throw new Error(`无法安全判断的迁移状态二进制文件：${relativePath}；已拒绝整个状态包`);
  assertNoSecretText(text, relativePath);
}

function isSupportedStateImage(path, contents) {
  const extension = extname(path).toLowerCase();
  const signatures = {
    ".png": () => contents.length >= 8 && contents.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ".jpg": () => contents.length >= 3 && contents[0] === 0xff && contents[1] === 0xd8 && contents[2] === 0xff,
    ".jpeg": () => contents.length >= 3 && contents[0] === 0xff && contents[1] === 0xd8 && contents[2] === 0xff,
    ".gif": () => contents.length >= 6 && ["GIF87a", "GIF89a"].includes(contents.subarray(0, 6).toString("ascii")),
    ".webp": () => contents.length >= 12 && contents.subarray(0, 4).toString("ascii") === "RIFF" && contents.subarray(8, 12).toString("ascii") === "WEBP",
  };
  if (!(extension in signatures)) return false;
  if (!signatures[extension]()) throw new Error(`任务图片扩展名与真实格式不符，无法安全导出：${path}`);
  return true;
}

function assertNoSecretText(text, relativePath) {
  const privateKey = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/;
  const commonTokens = [
    privateKey,
    /\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{16,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/i,
  ];
  const sensitiveKey = "(?:[a-z0-9]+[_-]?)?(?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|password|passwd|pwd|private[_-]?key)";
  const quotedAssignment = new RegExp(`["']?${sensitiveKey}["']?\\s*[:=]\\s*(["'])([^"'\\r\\n]+)\\1`, "gi");
  const plainAssignment = new RegExp(`["']?${sensitiveKey}["']?\\s*[:=]\\s*([^\\s,;}"']+)`, "gi");
  const assignedSecrets = [
    ...[...text.matchAll(quotedAssignment)].map((match) => match[2]),
    ...[...text.matchAll(plainAssignment)].map((match) => match[1]),
  ];
  if (commonTokens.some((pattern) => pattern.test(text)) || assignedSecrets.some((value) => !isPlaceholderSecret(value))) {
    throw new Error(`迁移状态包含疑似凭证、私钥或秘密内容：${relativePath}；已拒绝整个状态包，请先移除秘密并重新导出`);
  }
}

function isPlaceholderSecret(value) {
  const normalized = value.trim();
  return /^(?:<[^>]+>|\{\{[^}]+\}\}|\$\{[^}]+\}|\$\([A-Za-z_][A-Za-z0-9_]*\))$/.test(normalized) ||
    /^(?:x+|\*+|•+|redacted|masked|null|none|true|false)$/i.test(normalized);
}

async function verifySnapshot(snapshotDir) {
  const root = resolve(snapshotDir);
  const manifestPath = join(root, STATE_MANIFEST);
  const manifest = await readJson(manifestPath);
  if (manifest.format !== "wecom-support-bot-runtime-state" || manifest.formatVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("不是受支持的运行状态包");
  const declared = new Set();
  for (const entry of manifest.files) {
    assertStatePath(entry.path);
    if (declared.has(entry.path)) throw new Error(`迁移状态包含重复路径：${entry.path}`);
    declared.add(entry.path);
  }
  const actualFiles = (await listFiles(root)).map((path) => relative(root, path).replaceAll(sep, "/"));
  const expectedFiles = new Set([STATE_MANIFEST, ...[...declared].map((path) => `state/${path}`)]);
  const extras = actualFiles.filter((path) => !expectedFiles.has(path));
  if (extras.length > 0) throw new Error(`迁移状态包含未登记或禁止内容：${extras.join(", ")}`);
  const missing = [...expectedFiles].filter((path) => !actualFiles.includes(path));
  if (missing.length > 0) throw new Error(`迁移状态缺少登记内容：${missing.join(", ")}`);
  for (const entry of manifest.files) {
    const path = join(root, "state", entry.path);
    if ((await hashFile(path)) !== entry.sha256) throw new Error(`迁移状态校验失败：${entry.path}`);
    if (entry.size !== undefined && (await stat(path)).size !== entry.size) throw new Error(`迁移状态大小校验失败：${entry.path}`);
    await assertSafeStateContents(path, entry.path);
  }
  return { manifest, manifestSha256: await hashFile(manifestPath) };
}

async function stateMerge(options, internal = {}) {
  const instanceDir = resolve(required(options, "instanceDir"));
  const snapshotDir = resolve(required(options, "snapshot"));
  const { manifest, manifestSha256 } = await verifySnapshot(snapshotDir);
  if (internal.expectedManifestSha256 && internal.expectedManifestSha256 !== manifestSha256) throw new Error("端点停用证明与最终状态包不匹配，拒绝启用另一端");
  const operations = [];
  for (const entry of manifest.files) {
    assertStatePath(entry.path);
    operations.push(await planMergeFile({
      instanceDir,
      source: join(snapshotDir, "state", entry.path),
      relativePath: entry.path,
      legacyAgentDir: options.legacyAgentDir,
    }));
  }
  const plan = {
    status: options.execute ? "executing" : "planned",
    executes: Boolean(options.execute),
    instanceDir,
    snapshot: snapshotDir,
    files: operations.length,
    additions: operations.filter((entry) => entry.action === "add").length,
    identical: operations.filter((entry) => entry.action === "identical").length,
    merges: operations.filter((entry) => entry.action === "merge").length,
    conflicts: operations.filter((entry) => entry.action === "conflict").map((entry) => entry.relativePath),
    operations,
  };
  if (!options.execute) return plan;
  requireConfirmation(options, "state-merge", internal.confirmOverride);
  if (!options.targetStopped && !internal.stoppedVerified) throw new Error("正式合并必须确认目标服务已停止（--target-stopped）");
  const conflictRoot = join(instanceDir, "migration-conflicts", `${Date.now()}-${randomUUID()}`);
  for (const operation of operations) await applyMergeFile(operation, conflictRoot);
  return { ...plan, status: "ok", conflictCopies: plan.conflicts.length ? conflictRoot : null, manifestSha256 };
}

async function planMergeFile({ instanceDir, source, relativePath, legacyAgentDir }) {
  const target = stateTargetPath(instanceDir, relativePath, legacyAgentDir);
  if (!(await pathExists(target))) return { action: "add", relativePath, source, target };
  if ((await hashFile(source)) === (await hashFile(target))) return { action: "identical", relativePath, source, target };
  const piSession = (relativePath.startsWith("agent/sessions/") || /^agent\/[^/]+\.jsonl$/.test(relativePath)) && extname(relativePath) === ".jsonl";
  if (relativePath === "data/inbox.jsonl" || relativePath === "data/session-state.json" || piSession) {
    return { action: "merge", relativePath, source, target };
  }
  return { action: "conflict", relativePath, source, target };
}

function stateTargetPath(instanceDir, relativePath, legacyAgentDir) {
  if (relativePath.startsWith("agent/") && legacyAgentDir) return join(resolve(legacyAgentDir), relativePath.slice("agent/".length));
  return join(instanceDir, relativePath);
}

async function applyMergeFile(operation, conflictRoot) {
  if (operation.action === "identical") return;
  await mkdir(dirname(operation.target), { recursive: true });
  if (operation.action === "add") return cp(operation.source, operation.target, { recursive: false, dereference: false });
  if (operation.action === "conflict") {
    const preserved = join(conflictRoot, operation.relativePath);
    await mkdir(dirname(preserved), { recursive: true });
    await cp(operation.source, preserved, { recursive: false, dereference: false });
    return;
  }
  if (operation.relativePath === "data/inbox.jsonl") {
    const merged = mergeInbox(await readFile(operation.target, "utf8"), await readFile(operation.source, "utf8"));
    return writeFile(operation.target, merged);
  }
  if (operation.relativePath === "data/session-state.json") {
    const target = await readJson(operation.target);
    const incoming = await readJson(operation.source);
    return writeJson(operation.target, mergeSessionState(target, incoming));
  }
  const targetLines = (await readFile(operation.target, "utf8")).split("\n").filter(Boolean);
  const incomingLines = (await readFile(operation.source, "utf8")).split("\n").filter(Boolean);
  const seen = new Set(targetLines);
  const merged = [...targetLines, ...incomingLines.filter((line) => !seen.has(line))];
  await writeFile(operation.target, `${merged.join("\n")}\n`);
}

function mergeInbox(targetRaw, incomingRaw) {
  const records = [];
  const seen = new Set();
  const questions = new Map();
  for (const [source, raw] of [targetRaw, incomingRaw].entries()) {
    for (const [line, text] of raw.split("\n").filter((value) => value.trim()).entries()) {
      let record;
      try {
        record = JSON.parse(text);
      } catch {
        throw new Error("收件箱含无法解析的记录，拒绝静默丢弃");
      }
      if (typeof record.msgid !== "string") throw new Error("收件箱记录缺少 msgid，拒绝合并");
      if (typeof record.question === "string") {
        const identity = JSON.stringify({ msgid: record.msgid, question: record.question, userId: record.userId, chatId: record.chatId });
        if (questions.has(record.msgid) && questions.get(record.msgid) !== identity) throw new Error(`同一 msgid 对应不同提问：${record.msgid}`);
        questions.set(record.msgid, identity);
      }
      const timestamp = Date.parse(record.at ?? record.receivedAt);
      if (Number.isNaN(timestamp)) throw new Error(`收件箱记录缺少有效时间：${record.msgid}`);
      const canonical = JSON.stringify(record);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      records.push({ record, timestamp, source, line });
    }
  }
  records.sort((left, right) => left.timestamp - right.timestamp || left.source - right.source || left.line - right.line);
  return `${records.map(({ record }) => JSON.stringify(record)).join("\n")}\n`;
}

function mergeSessionState(target, incoming) {
  const generation = { ...(target.generation ?? {}) };
  const startedAt = { ...(target.startedAt ?? {}) };
  for (const [user, value] of Object.entries(incoming.generation ?? {})) {
    const current = generation[user] ?? 0;
    if (value > current) {
      generation[user] = value;
      if (incoming.startedAt?.[user] !== undefined) startedAt[user] = incoming.startedAt[user];
    } else if (value === current && startedAt[user] === undefined && incoming.startedAt?.[user] !== undefined) {
      startedAt[user] = incoming.startedAt[user];
    }
  }
  const activity = { ...(target.activity ?? {}) };
  for (const user of new Set([...Object.keys(target.activity ?? {}), ...Object.keys(incoming.activity ?? {})])) {
    const targetGeneration = target.generation?.[user] ?? 0;
    const incomingGeneration = incoming.generation?.[user] ?? 0;
    if (incomingGeneration > targetGeneration) {
      if (incoming.activity?.[user]) activity[user] = incoming.activity[user];
      else delete activity[user];
    } else if (incomingGeneration === targetGeneration && incoming.activity?.[user]) {
      if (!activity[user] || (incoming.activity[user].at ?? 0) >= (activity[user].at ?? 0)) activity[user] = incoming.activity[user];
    }
  }
  return {
    generation,
    touched: { ...(target.touched ?? {}), ...(incoming.touched ?? {}) },
    activity,
    startedAt,
  };
}

async function cutoverOld(options) {
  const instanceDir = resolve(required(options, "instanceDir"));
  const outputDir = resolve(required(options, "output"));
  const acceptancePath = resolve(required(options, "acceptance"));
  const acceptance = await readJson(acceptancePath);
  if (!(await acceptanceReady(acceptance, acceptancePath))) throw acceptanceReadyError();
  const production = await productionChannel(instanceDir, options.legacy);
  assertFingerprint(acceptance.productionBotFingerprint, production.botId, "验收记录与旧端正式 botId 不一致");
  const plist = resolve(options.plist ?? join(projectDir, "launchd/com.kyle.wecom-support-bot.plist"));
  const launchctl = options.launchctl ?? "launchctl";
  const steps = [`${launchctl} unload -w ${plist}`, "确认 launchd 不再持有服务且 pid 锁无存活进程", "导出最终 inbox/session/workspace/pi sessions", "写入旧端停用证明"];
  if (!options.execute) return { status: "planned", executes: false, steps, next: "把最终状态包与 old-stopped.json 传到 Windows，再执行 cutover-new" };
  requireConfirmation(options, "cutover-old");
  await stopLaunchd({ launchctl, plist });
  await assertNoLiveLocks(instanceDir);
  const snapshotDir = join(outputDir, "state");
  const exported = await stateExport({ ...options, confirm: CONFIRMS["state-export"], output: snapshotDir, execute: true }, { stoppedVerified: true, confirmOverride: CONFIRMS["state-export"] });
  const attestation = {
    format: "wecom-support-bot-endpoint-stopped",
    formatVersion: 1,
    endpoint: "old",
    stoppedAt: new Date().toISOString(),
    service: "macos-launchd",
    autoRestartDisabled: true,
    verifiedStopped: true,
    productionBotFingerprint: fingerprint(production.botId),
    snapshotManifestSha256: exported.manifestSha256,
  };
  await writeJson(join(outputDir, "old-stopped.json"), attestation, 0o600);
  return { status: "old-stopped-new-not-started", output: outputDir, attestation, next: "旧端保持停用；在 Windows 验证证明后启用新端" };
}

async function cutoverNew(options) {
  const instanceDir = resolve(required(options, "instanceDir"));
  const acceptancePath = resolve(required(options, "acceptance"));
  const acceptance = await readJson(acceptancePath);
  const oldStopped = await readStoppedAttestation(required(options, "oldStopped"), "old");
  if (!(await acceptanceReady(acceptance, acceptancePath))) throw acceptanceReadyError();
  const { saved, channels } = await readInstanceEndpoint(instanceDir);
  validateAcceptanceForInstance(acceptance, saved, channels);
  assertFingerprint(oldStopped.productionBotFingerprint, channels.production.botId, "旧端停用证明与新端正式 botId 不一致");
  const snapshotDir = resolve(required(options, "snapshot"));
  const systemctl = options.systemctl ?? "systemctl";
  const steps = ["systemctl disable --now（停止测试机器人）", "归档测试 inbox/会话，避免污染正式会话", "合并旧端最终状态", "仅在新端选择 production", "systemctl enable --now 并验证 active", "失败则新端立即 disable，旧端保持停止"];
  if (!options.execute) return { status: "planned", executes: false, steps, merge: await stateMerge({ ...options, instanceDir, snapshot: snapshotDir, execute: false }, { expectedManifestSha256: oldStopped.snapshotManifestSha256 }) };
  requireConfirmation(options, "cutover-new");
  await stopSystemd(systemctl);
  await assertNoLiveLocks(instanceDir);
  const testRuntimeArchive = await archiveTestRuntime(instanceDir);
  await stateMerge({ ...options, confirm: CONFIRMS["state-merge"], instanceDir, snapshot: snapshotDir, execute: true }, { stoppedVerified: true, confirmOverride: CONFIRMS["state-merge"], expectedManifestSha256: oldStopped.snapshotManifestSha256 });
  const linuxUser = options.linuxUser ?? "wecom";
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(linuxUser)) throw new Error("Linux 运行用户名无效");
  await execFileAsync(options.chown ?? "chown", ["-R", `${linuxUser}:${linuxUser}`, instanceDir]);
  channels.active = "production";
  await writeJson(join(instanceDir, "wecom.json"), channels, 0o600);
  try {
    await startSystemd(systemctl);
  } catch (error) {
    channels.active = "none";
    await writeJson(join(instanceDir, "wecom.json"), channels, 0o600);
    await stopSystemd(systemctl).catch(() => {});
    throw new Error(`新端启用失败，已安全停用新端且未重启旧端：${error.message}`);
  }
  const record = { format: "wecom-support-bot-cutover-active", formatVersion: 1, activatedAt: new Date().toISOString(), targetInstanceId: saved.instance.id, productionBotFingerprint: fingerprint(channels.production.botId), testRuntimeArchive };
  await writeJson(join(instanceDir, "migration/new-active.json"), record, 0o600);
  return { status: "new-active-old-stopped", record };
}

async function archiveTestRuntime(instanceDir) {
  const archive = join(instanceDir, "migration", `test-runtime-${Date.now()}-${randomUUID()}`);
  for (const [name, target] of [["data", "data"], ["agent/sessions", "agent/sessions"], ["agent", "agent"]]) {
    const current = join(instanceDir, name);
    if (!(await pathExists(current))) continue;
    const destination = join(archive, target);
    await mkdir(dirname(destination), { recursive: true });
    if (name === "agent") {
      await mkdir(destination, { recursive: true });
      for (const entry of await readdir(current)) {
        if (entry === "models.json" || entry === "sessions") continue;
        await rename(join(current, entry), join(destination, entry));
      }
      continue;
    }
    if (name === "agent/sessions" && !(await pathExists(join(instanceDir, "agent")))) {
      await mkdir(dirname(current), { recursive: true });
    }
    await rename(current, destination);
  }
  await mkdir(join(instanceDir, "data"), { recursive: true });
  await mkdir(join(instanceDir, "agent/sessions"), { recursive: true });
  return archive;
}

async function rollbackNew(options) {
  const instanceDir = resolve(required(options, "instanceDir"));
  const outputDir = resolve(required(options, "output"));
  const { channels } = await readInstanceEndpoint(instanceDir);
  const systemctl = options.systemctl ?? "systemctl";
  if (!options.execute) return { status: "planned", executes: false, steps: ["停用并禁止 systemd 自动拉起", "确认无存活锁", "active=none", "导出 Windows 期间新增状态", "写入 Windows 停用证明"] };
  requireConfirmation(options, "rollback-new");
  await stopSystemd(systemctl);
  await assertNoLiveLocks(instanceDir);
  channels.active = "none";
  await writeJson(join(instanceDir, "wecom.json"), channels, 0o600);
  const exported = await stateExport({ ...options, confirm: CONFIRMS["state-export"], instanceDir, output: join(outputDir, "state"), execute: true }, { stoppedVerified: true, confirmOverride: CONFIRMS["state-export"] });
  const attestation = {
    format: "wecom-support-bot-endpoint-stopped",
    formatVersion: 1,
    endpoint: "windows",
    stoppedAt: new Date().toISOString(),
    service: "systemd",
    autoRestartDisabled: true,
    verifiedStopped: true,
    productionBotFingerprint: fingerprint(channels.production.botId),
    snapshotManifestSha256: exported.manifestSha256,
  };
  await writeJson(join(outputDir, "windows-stopped.json"), attestation, 0o600);
  return { status: "windows-stopped-old-not-started", output: outputDir, attestation };
}

async function rollbackOld(options) {
  const instanceDir = resolve(required(options, "instanceDir"));
  const windowsStopped = await readStoppedAttestation(required(options, "windowsStopped"), "windows");
  const production = await productionChannel(instanceDir, options.legacy);
  assertFingerprint(windowsStopped.productionBotFingerprint, production.botId, "Windows 停用证明与旧端正式 botId 不一致");
  const plist = resolve(options.plist ?? join(projectDir, "launchd/com.kyle.wecom-support-bot.plist"));
  const launchctl = options.launchctl ?? "launchctl";
  const snapshotDir = resolve(required(options, "snapshot"));
  if (!options.execute) return { status: "planned", executes: false, steps: ["验证 Windows 已停用", "合并 Windows 新任务/inbox/会话", "旧端恢复 production", "launchctl load -w；失败则立即停用旧端"], merge: await stateMerge({ ...options, instanceDir, snapshot: snapshotDir, execute: false }, { expectedManifestSha256: windowsStopped.snapshotManifestSha256 }) };
  requireConfirmation(options, "rollback-old");
  await stopLaunchd({ launchctl, plist, tolerateAlreadyStopped: true });
  await assertNoLiveLocks(instanceDir);
  await stateMerge({ ...options, confirm: CONFIRMS["state-merge"], instanceDir, snapshot: snapshotDir, execute: true }, { stoppedVerified: true, confirmOverride: CONFIRMS["state-merge"], expectedManifestSha256: windowsStopped.snapshotManifestSha256 });
  if (!options.legacy) {
    const channels = await readJson(join(instanceDir, "wecom.json"));
    channels.active = "production";
    await writeJson(join(instanceDir, "wecom.json"), channels, 0o600);
  }
  try {
    await startLaunchd({ launchctl, plist });
  } catch (error) {
    if (!options.legacy) {
      const channels = await readJson(join(instanceDir, "wecom.json"));
      channels.active = "none";
      await writeJson(join(instanceDir, "wecom.json"), channels, 0o600);
    }
    await stopLaunchd({ launchctl, plist, tolerateAlreadyStopped: true }).catch(() => {});
    throw new Error(`旧端恢复失败，已保持双端停止：${error.message}`);
  }
  return { status: "old-active-windows-stopped", mergedState: snapshotDir };
}

async function readInstanceEndpoint(instanceDir) {
  const [saved, channels] = await Promise.all([readJson(join(instanceDir, "instance.json")), readJson(join(instanceDir, "wecom.json"))]);
  if (!channels.production?.botId) throw new Error("正式机器人尚未配置");
  return { saved, channels };
}

function validateAcceptanceForInstance(record, saved, channels) {
  if (record.targetInstanceId !== saved.instance.id) throw new Error("验收记录不属于当前 Windows 实例");
  if (record.resourceVersion !== (saved.resources?.version ?? null)) throw new Error("验收后资源版本已变化，必须重新验收");
  if (JSON.stringify(record.models) !== JSON.stringify(modelBaseline(saved.models))) throw new Error("验收后模型已变化；迁移不得捆绑模型升级");
  assertFingerprint(record.testBotFingerprint, channels.test?.botId, "当前测试机器人与验收记录不一致");
  assertFingerprint(record.productionBotFingerprint, channels.production?.botId, "当前正式机器人与验收记录不一致");
}

async function readStoppedAttestation(pathValue, endpoint) {
  const value = await readJson(resolve(pathValue));
  if (value.format !== "wecom-support-bot-endpoint-stopped" || value.endpoint !== endpoint || !value.verifiedStopped || !value.autoRestartDisabled || !value.snapshotManifestSha256) {
    throw new Error(`缺少可信的 ${endpoint} 端停用证明`);
  }
  return value;
}

async function productionChannel(instanceDir, legacy = false) {
  if (legacy) {
    const secrets = await readJson(join(instanceDir, "config/secrets.json"));
    if (!secrets.botId) throw new Error("旧项目缺少正式 botId");
    return secrets;
  }
  const channels = await readJson(join(instanceDir, "wecom.json"));
  if (!channels.production?.botId) throw new Error("旧实例未配置正式机器人");
  return channels.production;
}

function assertFingerprint(expected, actual, message) {
  if (!actual || expected !== fingerprint(actual)) throw new Error(message);
}

async function stopLaunchd({ launchctl, plist, tolerateAlreadyStopped = false }) {
  const before = await commandResult(launchctl, ["list", "com.kyle.wecom-support-bot"]);
  if (before.code === 0 || !tolerateAlreadyStopped) await execFileAsync(launchctl, ["unload", "-w", plist]);
  const result = await commandResult(launchctl, ["list", "com.kyle.wecom-support-bot"]);
  if (result.code === 0) throw new Error("launchd 服务仍在运行，禁止启用另一端");
}

async function startLaunchd({ launchctl, plist }) {
  await execFileAsync(launchctl, ["load", "-w", plist]);
  const result = await commandResult(launchctl, ["list", "com.kyle.wecom-support-bot"]);
  if (result.code !== 0) throw new Error("launchd 服务恢复后未通过 list 验证");
}

async function stopSystemd(systemctl) {
  await execFileAsync(systemctl, ["disable", "--now", SERVICE_NAME]);
  const active = await commandResult(systemctl, ["is-active", SERVICE_NAME]);
  const enabled = await commandResult(systemctl, ["is-enabled", SERVICE_NAME]);
  if (active.code === 0 || enabled.code === 0) throw new Error("systemd 服务仍活跃或会自动拉起，禁止启用另一端");
}

async function startSystemd(systemctl) {
  await execFileAsync(systemctl, ["enable", "--now", SERVICE_NAME]);
  const result = await commandResult(systemctl, ["is-active", SERVICE_NAME]);
  if (result.code !== 0 || result.stdout.trim() !== "active") throw new Error("systemd 服务未进入 active");
}

async function commandResult(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args);
    return { code: 0, stdout };
  } catch (error) {
    if (typeof error.code === "number") return { code: error.code, stdout: error.stdout ?? "" };
    throw error;
  }
}

async function assertNoLiveLocks(instanceDir) {
  const dataDir = join(instanceDir, "data");
  if (!(await pathExists(dataDir))) return;
  for (const entry of await readdir(dataDir)) {
    if (!entry.endsWith(".lock")) continue;
    try {
      const lock = await readJson(join(dataDir, entry));
      if (typeof lock.pid === "number") {
        try {
          process.kill(lock.pid, 0);
          throw new Error(`旧进程仍存活（pid ${lock.pid}），禁止切换`);
        } catch (error) {
          if (error.code === "EPERM" || !error.code) throw error;
        }
      }
    } catch (error) {
      if (error.message?.includes("禁止切换")) throw error;
      // 无法解析的锁不证明进程存活；launchd/systemd 的停用验证仍是主门。
    }
  }
}

function requireConfirmation(options, command, override = null) {
  const expected = override ?? CONFIRMS[command];
  if (options.confirm !== expected) throw new Error(`正式执行必须显式提供 --confirm ${expected}；默认 dry-run 不修改服务或状态`);
}

function fingerprint(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function assertSafeRelativePath(path) {
  if (!path || path.startsWith("/") || path.includes("\\") || /^[a-z]:/i.test(path) || path.split("/").includes("..")) throw new Error(`路径越界：${path}`);
}

function assertStatePath(path) {
  assertSafeRelativePath(path);
  if (hasForbiddenStateSegment(path)) throw new Error(`状态包含禁止的凭证、密钥或依赖路径：${path}`);
  if (path.startsWith("workspace/") || path.startsWith("agent/sessions/")) return;
  if (["data/inbox.jsonl", "data/session-state.json"].includes(path)) return;
  if (/^agent\/[^/]+\.jsonl$/i.test(path)) return;
  throw new Error(`状态包含不允许的路径：${path}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  process.stderr.write(`Windows 安装/迁移操作失败：${error?.message ?? error}\n`);
  process.exitCode = 1;
});

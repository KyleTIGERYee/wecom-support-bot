import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectDir, "scripts/windows-instance.js");
const CASES = [
  "progressive-loading",
  "skills-work-product",
  "execution-approval",
  "output-guard",
  "wecom-text",
  "wecom-image",
  "long-task",
  "disconnect-recovery",
  "final-delivery",
  "migration-comparison",
];
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
const MODELS = Object.fromEntries(["main", "quick", "guard", "executionApproval"].map((role) => [role, { baseUrl: "http://192.168.1.20:3425/v1", model: `${role}-model` }]));

async function makeTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "wsb-windows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function runCli(args, { allowFailure = false, env = process.env } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: projectDir, env, maxBuffer: 32 * 1024 * 1024 });
    return { ...JSON.parse(stdout), stderr };
  } catch (error) {
    if (!allowFailure) throw error;
    assert.equal(typeof error.stderr, "string");
    return { status: "error", error: error.stderr, stdout: error.stdout };
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function makeInstance(dir, { id = "instance-1", productionBotId = "production-bot", testBotId = "test-bot" } = {}) {
  const saved = {
    version: 2,
    ready: true,
    instance: { id, template: "team" },
    initializedAt: "2026-11-05T00:00:00.000Z",
    models: MODELS,
    contextSources: [{ name: "docs", type: "directory", scope: "shared", localPath: "context/001-docs", status: "ok", version: "resource-v1" }],
    resources: { version: "resource-v1", catalogVersion: "resource-v1", syncedAt: "2026-11-05T00:00:00.000Z", files: ["context/001-docs/handbook.md"] },
    checks: {},
  };
  await mkdir(join(dir, "context/001-docs"), { recursive: true });
  await writeFile(join(dir, "context/001-docs/handbook.md"), "共享退租规则。\n");
  await mkdir(join(dir, "workspace"), { recursive: true });
  await mkdir(join(dir, "data"), { recursive: true });
  await mkdir(join(dir, "agent/sessions"), { recursive: true });
  await writeJson(join(dir, "instance.json"), saved);
  await writeJson(join(dir, "secrets.json"), { mainApiKey: "never-export-main", quickApiKey: "never-export-quick", guardApiKey: "never-export-guard", executionApprovalApiKey: "never-export-approval" });
  await writeJson(join(dir, "agent/models.json"), { providers: { private: { apiKey: "never-export-pi" } } });
  await writeJson(join(dir, "wecom.json"), {
    active: "test",
    test: { botId: testBotId, secret: "never-export-test-secret" },
    production: { botId: productionBotId, secret: "never-export-production-secret" },
  });
  return saved;
}

async function makeFakeServiceBinaries(root) {
  const systemLog = join(root, "systemctl.jsonl");
  const systemState = join(root, "systemd-state.json");
  const launchLog = join(root, "launchctl.jsonl");
  const launchState = join(root, "launchd-state.json");
  const chownLog = join(root, "chown.jsonl");
  await writeJson(systemState, { active: true, enabled: true });
  await writeJson(launchState, { loaded: true });
  const systemctl = join(root, "systemctl.cjs");
  const launchctl = join(root, "launchctl.cjs");
  const chown = join(root, "chown.cjs");
  await writeFile(systemctl, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(systemLog)}, JSON.stringify(args) + "\\n");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(systemState)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(systemState)}, JSON.stringify(state));
const command = args[0];
if (command === "enable") {
  if (process.env.FAKE_SYSTEMD_START_FAIL === "1") process.exit(1);
  state.active = true; state.enabled = true; save(); process.exit(0);
}
if (command === "disable") { state.active = false; state.enabled = false; save(); process.exit(0); }
if (command === "restart") { state.active = true; save(); process.exit(0); }
if (command === "is-active") { if (state.active) { console.log("active"); process.exit(0); } process.exit(3); }
if (command === "is-enabled") { if (state.enabled) { console.log("enabled"); process.exit(0); } process.exit(1); }
if (command === "status") { console.log(state.active ? "active" : "inactive"); process.exit(0); }
if (command === "daemon-reload") process.exit(0);
process.exit(0);
`, { mode: 0o755 });
  await writeFile(launchctl, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify(args) + "\\n");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(launchState)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(launchState)}, JSON.stringify(state));
if (args[0] === "unload") { state.loaded = false; save(); process.exit(0); }
if (args[0] === "load") {
  if (process.env.FAKE_LAUNCHD_START_FAIL === "1") process.exit(1);
  state.loaded = true; save(); process.exit(0);
}
if (args[0] === "list") process.exit(state.loaded ? 0 : 1);
process.exit(0);
`, { mode: 0o755 });
  await writeFile(chown, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(chownLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`, { mode: 0o755 });
  return { systemctl, launchctl, chown, systemLog, launchLog, chownLog, systemState, launchState };
}

async function readLines(path) {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}

async function runWithInput(command, args, input, { env = process.env } = {}) {
  const child = spawn(command, args, { cwd: projectDir, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixedQuestions() {
  return JSON.parse(await readFile(join(projectDir, "docs/windows-migration-questions.json"), "utf8"));
}

async function makeComparison(root) {
  const questions = await fixedQuestions();
  const report = {
    format: "wecom-support-bot-migration-answers",
    formatVersion: 2,
    status: "completed",
    resourceVersion: "resource-v1",
    models: Object.fromEntries(Object.entries(MODELS).map(([role, value]) => [role, { model: value.model }])),
    questionSetSha256: sha256(JSON.stringify(questions.map(({ id, question }) => ({ id, questionSha256: sha256(question) })))),
    results: questions.map(({ id, question }) => ({
      id,
      question,
      questionSha256: sha256(question),
      executed: true,
      executionStatus: "completed",
      result: { finalText: `${id} 答案`, loadedResources: [{ source: "docs", resourceType: "concept", depth: "summary", verification: "read" }], loadedSkills: [], executionApprovals: [], guarded: false, rounds: 1 },
    })),
  };
  const before = join(root, "before.json");
  const after = join(root, "after.json");
  const output = join(root, "comparison.json");
  await writeJson(before, report);
  await writeJson(after, { ...report, instanceId: "new-instance" });
  await runCli(["acceptance-compare", "--before", before, "--after", after, "--output", output]);
  return output;
}

async function writeCaseEvidence(recordPath, caseId, { comparisonPath = null, testBotId = "test-bot", omitScenario = null, executed = true } = {}) {
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  const root = dirname(recordPath);
  if (caseId === "migration-comparison" && !comparisonPath) comparisonPath = await makeComparison(root);
  const scenarios = [];
  for (const scenarioId of ACCEPTANCE_SCENARIOS[caseId]) {
    if (scenarioId === omitScenario) continue;
    let resultPath;
    if (caseId === "migration-comparison") {
      resultPath = comparisonPath;
    } else {
      resultPath = join(root, "evidence", caseId, `${scenarioId}.json`);
      await writeJson(resultPath, {
        format: "wecom-support-bot-windows-acceptance-result",
        formatVersion: 1,
        caseId,
        scenarioId,
        testBotId,
        targetInstanceId: record.targetInstanceId,
        resourceVersion: record.resourceVersion,
        executed,
        status: "passed",
        executedAt: "2026-11-05T01:00:00.000Z",
        result: { observation: `${scenarioId} 的真实输出与状态`, checks: { caseId, scenarioId, delivered: true } },
      });
    }
    scenarios.push({
      id: scenarioId,
      status: "passed",
      resultPath: caseId === "migration-comparison" ? "comparison.json" : `evidence/${caseId}/${scenarioId}.json`,
      resultSha256: sha256(await readFile(resultPath)),
    });
  }
  const evidencePath = join(root, `${caseId}-evidence.json`);
  const evidence = {
    format: "wecom-support-bot-windows-acceptance-evidence",
    formatVersion: 1,
    caseId,
    testBotId,
    targetInstanceId: record.targetInstanceId,
    resourceVersion: record.resourceVersion,
    status: "passed",
    environment: { platform: "windows-wsl2", distribution: "Ubuntu-24.04", windowsVersion: "11-test-fixture" },
    scenarios,
    humanReview: { approved: true, reviewer: "reviewer-test-fixture", reviewedAt: "2026-11-05T02:00:00.000Z", notes: "仅用于 Mac 门禁测试，不代表 Windows 实机验收" },
    createdAt: "2026-11-05T02:00:00.000Z",
  };
  await writeJson(evidencePath, evidence);
  return { path: evidencePath, evidence };
}

async function passAcceptance(record) {
  const comparisonPath = await makeComparison(dirname(record));
  for (const id of CASES) {
    const { path } = await writeCaseEvidence(record, id, { comparisonPath });
    await runCli(["acceptance-update", "--record", record, "--case", id, "--status", "passed", "--evidence", path]);
  }
}

function cutoverArgs(oldInstance, newInstance, acceptance, output, binaries) {
  return {
    old: ["cutover-old", "--instance-dir", oldInstance, "--acceptance", acceptance, "--output", output, "--plist", join(dirname(output), "old.plist"), "--launchctl", binaries.launchctl],
    new: ["cutover-new", "--instance-dir", newInstance, "--acceptance", acceptance, "--old-stopped", join(output, "old-stopped.json"), "--snapshot", join(output, "state"), "--systemctl", binaries.systemctl, "--chown", binaries.chown],
  };
}

test("安装公开计划校验安全参数，Linux dry-run 不修改系统且拒绝 /mnt/c", async (t) => {
  const root = await makeTempDir(t);
  const plan = await runCli(["install-plan", "--distro", "Ubuntu-24.04"]);
  assert.equal(plan.executes, false);
  assert.deepEqual(plan.wslCommands.installDistro.slice(0, 3), ["wsl.exe", "--install", "--distribution"]);
  assert.equal(plan.paths.projectDir.startsWith("/mnt/"), false);
  assert.deepEqual(plan.windowsCommands.planOnly, [
    "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    "<package>/windows/install.ps1", "-PlanOnly",
  ]);
  const invalidDistro = await runCli(["install-plan", "--distro", "Ubuntu;shutdown"], { allowFailure: true });
  assert.match(invalidDistro.error, /发行版名称/);
  const mounted = await runCli(["install-plan", "--project-dir", "/mnt/c/bot"], { allowFailure: true });
  assert.match(mounted.error, /不能位于 Windows 挂载盘/);

  const install = join(projectDir, "windows/linux/install.sh");
  await execFileAsync("bash", ["-n", install]);
  await execFileAsync("bash", ["-n", join(projectDir, "windows/linux/service.sh")]);
  const { stdout } = await execFileAsync("bash", [install, "--dry-run", "--project-dir", join(root, "app"), "--instance-dir", join(root, "instance"), "--runtime-dir", join(root, "runtime")]);
  const dryRun = JSON.parse(stdout);
  assert.equal(dryRun.executes, false);
  assert.equal(dryRun.dependencies.node, "22.19.0");
  assert.match(dryRun.dependencies.npm, /npm ci --omit=dev/);
  assert.equal(existsSync(join(root, "app")), false);
  assert.equal(existsSync(join(root, "instance")), false);
  const rejected = await execFileAsync("bash", [install, "--dry-run", "--project-dir", "/mnt/c/bot"], { reject: false }).catch((error) => error);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /不能位于/);
});

test("安装资源包只含白名单并在内容篡改或追加凭证时校验失败", async (t) => {
  const root = await makeTempDir(t);
  const output = join(root, "package");
  const built = await runCli(["build-package", "--output", output]);
  assert.equal(built.status, "ok");
  const manifest = JSON.parse(await readFile(join(output, "windows-package.json"), "utf8"));
  assert.ok(manifest.files.some((entry) => entry.path === "scripts/local-instance.js"));
  assert.ok(manifest.files.some((entry) => entry.path === "windows/install.ps1"));
  assert.ok(manifest.files.some((entry) => entry.path === "windows/wsl-plan.json"));
  assert.equal(existsSync(join(output, "windows-package.json")), true);
  assert.equal(existsSync(join(output, "windows/windows-package.json")), false);
  assert.equal(existsSync(join(output, "windows/install.ps1")), true);
  const packagedPlan = JSON.parse(await readFile(join(output, "windows/wsl-plan.json"), "utf8"));
  assert.equal(packagedPlan.windowsCommands.planOnly.at(-2), "<package>/windows/install.ps1");
  assert.equal(manifest.files.some((entry) => /secrets|node_modules|launchd|workspace|data\//.test(entry.path)), false);
  const verified = await runCli(["verify-package", "--package-dir", output]);
  assert.equal(verified.status, "ok");
  const defaults = await readFile(join(output, "config/default.json"), "utf8");
  assert.equal(defaults.includes("/Users/"), false);
  assert.deepEqual(JSON.parse(defaults).roots, {});

  await writeFile(join(output, "config/secrets.json"), '{"botId":"real-looking-secret"}\n');
  const extra = await runCli(["verify-package", "--package-dir", output], { allowFailure: true });
  assert.match(extra.error, /未登记内容/);
  await rm(join(output, "config/secrets.json"));
  await writeFile(join(output, "prompts/local-instance.md"), "tampered\n");
  const changed = await runCli(["verify-package", "--package-dir", output], { allowFailure: true });
  assert.match(changed.error, /校验失败/);
});

test("systemd 单元由公开命令生成，服务脚本通过假 systemctl 启停并先验实例", async (t) => {
  const root = await makeTempDir(t);
  const instance = join(root, "instance");
  await makeInstance(instance);
  const binaries = await makeFakeServiceBinaries(root);
  const unitDir = join(root, "units");
  const unitPath = join(root, "rendered.service");
  const rendered = await runCli(["service-unit", "--project-dir", projectDir, "--instance-dir", instance, "--runtime-dir", "/opt/wecom-support-bot/runtime", "--output", unitPath]);
  assert.equal(rendered.status, "written");
  const unit = await readFile(unitPath, "utf8");
  assert.match(unit, /Restart=always/);
  assert.match(unit, /RestartSec=10/);
  assert.match(unit, /KillSignal=SIGTERM/);
  assert.match(unit, /TimeoutStopSec=40/);
  assert.match(unit, /WECOM_BOT_INSTANCE_DIR=/);
  assert.equal(unit.includes("/mnt/c"), false);

  const nodeLog = join(root, "node-env.jsonl");
  const nodeWrapper = join(root, "node-wrapper.cjs");
  await writeFile(nodeWrapper, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
fs.appendFileSync(${JSON.stringify(nodeLog)}, JSON.stringify({ args: process.argv.slice(2), piBinary: process.env.WECOM_BOT_PI_BINARY ?? null }) + "\\n");
const result = spawnSync(process.env.REAL_NODE, process.argv.slice(2), { env: process.env, stdio: "inherit" });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const env = {
    ...process.env,
    REAL_NODE: process.execPath,
    WECOM_BOT_SYSTEMCTL: binaries.systemctl,
    WECOM_BOT_UNIT_DIR: unitDir,
    WECOM_BOT_PROJECT_DIR: projectDir,
    WECOM_BOT_INSTANCE_DIR: instance,
    WECOM_BOT_RUNTIME_DIR: "/opt/wecom-support-bot/runtime",
    WECOM_BOT_NODE: nodeWrapper,
  };
  const service = join(projectDir, "windows/linux/service.sh");
  await execFileAsync("bash", [service, "install"], { env });
  assert.equal(existsSync(join(unitDir, "wecom-support-bot.service")), true);
  await execFileAsync("bash", [service, "stop"], { env });
  await execFileAsync("bash", [service, "start"], { env });
  const calls = await readLines(binaries.systemLog);
  assert.deepEqual(calls[0], ["daemon-reload"]);
  assert.deepEqual(calls.at(-2), ["enable", "--now", "wecom-support-bot.service"]);
  assert.deepEqual(calls.at(-1), ["is-active", "wecom-support-bot.service"]);
  const nodeCalls = await readLines(nodeLog);
  assert.ok(nodeCalls.length >= 2);
  for (const call of nodeCalls) assert.equal(call.piBinary, "/opt/wecom-support-bot/runtime/pi/bin/pi");
  assert.match(unit, /Environment=WECOM_BOT_PI_BINARY=\/opt\/wecom-support-bot\/runtime\/pi\/bin\/pi/);

  const runtime = await runCli(["runtime-check", "--instance-dir", instance]);
  assert.deepEqual(runtime.roots.slice(0, 2), [join(instance, "context"), join(instance, "workspace")]);
  assert.equal(runtime.roots[2], join(instance, "data/images"));
  assert.equal(runtime.catalog.entries > 0, true);
  await writeJson(join(instance, "instance.json"), { ...(JSON.parse(await readFile(join(instance, "instance.json"), "utf8"))), ready: false });
  const before = (await readLines(binaries.systemLog)).length;
  const failed = await execFileAsync("bash", [service, "start"], { env, reject: false }).catch((error) => error);
  assert.notEqual(failed.code, 0);
  assert.equal((await readLines(binaries.systemLog)).length, before);
});

test("模型回环地址明确拒绝，企微测试/正式配置不会直接启用正式通道", async (t) => {
  const root = await makeTempDir(t);
  const instance = join(root, "instance");
  await makeInstance(instance);
  await rm(join(instance, "wecom.json"));
  const loopback = await runCli(["validate-model-url", "--url", "http://127.0.0.1:3425/v1"], { allowFailure: true });
  assert.match(loopback.error, /不能沿用/);
  const routed = await runCli(["validate-model-url", "--url", "http://192.168.1.20:3425/v1"]);
  assert.equal(routed.connectionTest, "not-run");
  await runCli(["configure-channel", "--instance-dir", instance, "--kind", "test", "--bot-id", "test-only", "--secret", "test-secret"]);
  await runCli(["configure-channel", "--instance-dir", instance, "--kind", "production", "--bot-id", "production-only", "--secret", "production-secret"]);
  const channels = JSON.parse(await readFile(join(instance, "wecom.json"), "utf8"));
  assert.equal(channels.active, "test");
  assert.equal((await stat(join(instance, "wecom.json"))).mode & 0o777, 0o600);
  const runtime = await runCli(["runtime-check", "--instance-dir", instance]);
  assert.equal(runtime.activeChannel, "test");
});

test("状态导出/合并默认 dry-run，保留 inbox、会话、pi sessions 与冲突任务", async (t) => {
  const root = await makeTempDir(t);
  const source = join(root, "source");
  const target = join(root, "target");
  const snapshot = join(root, "snapshot");
  await makeInstance(source, { id: "source" });
  await makeInstance(target, { id: "target" });
  await writeFile(join(source, "workspace/report.md"), "incoming-version\n");
  await writeFile(join(target, "workspace/report.md"), "target-version\n");
  await writeFile(join(target, "workspace/target-only.md"), "keep-me\n");
  await writeFile(join(source, "workspace/new-task.md"), "new-task\n");
  await writeFile(join(source, "data/inbox.jsonl"), [
    { msgid: "m1", question: "旧问题", userId: "u1", receivedAt: "2026-11-05T00:00:00.000Z", state: "received" },
    { msgid: "m1", state: "answered", at: "2026-11-05T00:01:00.000Z" },
    { msgid: "m2", question: "源新问题", userId: "u2", receivedAt: "2026-11-05T00:02:00.000Z", state: "received" },
    { msgid: "m2", state: "running", at: "2026-11-05T00:03:00.000Z" },
  ].map(JSON.stringify).join("\n") + "\n");
  await writeFile(join(target, "data/inbox.jsonl"), [
    { msgid: "m1", question: "旧问题", userId: "u1", receivedAt: "2026-11-05T00:00:00.000Z", state: "received" },
    { msgid: "m1", state: "answered", at: "2026-11-05T00:01:00.000Z" },
    { msgid: "m3", question: "目标问题", userId: "u3", receivedAt: "2026-11-05T00:02:30.000Z", state: "received" },
    { msgid: "m3", state: "answered", at: "2026-11-05T00:02:40.000Z" },
  ].map(JSON.stringify).join("\n") + "\n");
  await writeJson(join(source, "data/session-state.json"), { generation: { u1: 2 }, touched: { "u1-g2": true, source: true }, activity: { u1: { at: 200, inputTokens: 20 } }, startedAt: { u1: 100 } });
  await writeJson(join(target, "data/session-state.json"), { generation: { u1: 1 }, touched: { "u1-g1": true, target: true }, activity: { u1: { at: 100, inputTokens: 10 } }, startedAt: { u1: 50 } });
  await writeFile(join(source, "agent/sessions/s.jsonl"), '{"base":true}\n{"incoming":true}\n');
  await writeFile(join(source, "agent/legacy-session.jsonl"), '{"legacy":true}\n');
  await writeFile(join(source, "agent/credentials.json"), '{"apiKey":"FAKE_API_KEY_MUST_NOT_EXPORT_7f3a"}\n');
  await writeFile(join(source, "agent/auth"), 'FAKE_API_KEY_MUST_NOT_EXPORT_7f3a\n');
  await writeFile(join(source, "agent/token"), 'FAKE_API_KEY_MUST_NOT_EXPORT_7f3a\n');
  await writeFile(join(source, "agent/providers.json"), '{"provider":{"apiKey":"FAKE_API_KEY_MUST_NOT_EXPORT_7f3a"}}\n');
  await mkdir(join(source, "agent/node_modules/private"), { recursive: true });
  await mkdir(join(source, "data/images"), { recursive: true });
  await writeFile(join(source, "agent/node_modules/private/key.json"), '{"apiKey":"FAKE_API_KEY_MUST_NOT_EXPORT_7f3a"}\n');
  await writeFile(join(source, "data/images/private.jpg"), 'FAKE_API_KEY_MUST_NOT_EXPORT_7f3a\n');
  await writeFile(join(source, "data/runtime.log"), 'not-migration-state\n');
  await writeFile(join(target, "agent/sessions/s.jsonl"), '{"base":true}\n');
  await writeFile(join(source, "private.md"), "not-state\n");

  const dryExport = await runCli(["state-export", "--instance-dir", source, "--output", snapshot]);
  assert.equal(dryExport.executes, false);
  assert.equal(existsSync(snapshot), false);
  const noConfirm = await runCli(["state-export", "--instance-dir", source, "--output", snapshot, "--execute", "--source-stopped"], { allowFailure: true });
  assert.match(noConfirm.error, /--confirm EXPORT_STATE/);
  assert.equal(existsSync(snapshot), false);
  const exported = await runCli(["state-export", "--instance-dir", source, "--output", snapshot, "--execute", "--source-stopped", "--confirm", "EXPORT_STATE"]);
  assert.equal(exported.status, "ok");
  const snapshotFiles = (await readFile(join(snapshot, "migration-state.json"), "utf8")).includes("secrets");
  assert.equal(snapshotFiles, false);
  const snapshotManifest = JSON.parse(await readFile(join(snapshot, "migration-state.json"), "utf8"));
  const exportedPaths = snapshotManifest.files.map((entry) => entry.path);
  assert.ok(exportedPaths.includes("agent/legacy-session.jsonl"));
  assert.ok(exportedPaths.includes("agent/sessions/s.jsonl"));
  assert.ok(exportedPaths.includes("data/inbox.jsonl"));
  assert.ok(exportedPaths.includes("data/session-state.json"));
  assert.equal(exportedPaths.some((path) => /(?:models|credentials|auth|token|providers|node_modules|images|runtime\.log)/.test(path)), false);
  for (const name of await readdir(join(snapshot, "state"), { recursive: true })) {
    const path = join(snapshot, "state", name);
    if ((await stat(path)).isFile()) assert.doesNotMatch(await readFile(path, "utf8"), /FAKE_API_KEY_MUST_NOT_EXPORT_7f3a/);
  }
  assert.equal(existsSync(join(snapshot, "state/private.md")), false);
  assert.equal(existsSync(join(snapshot, "state/agent/models.json")), false);
  assert.equal(existsSync(join(snapshot, "state/agent/sessions/models.json")), false);
  await writeFile(join(snapshot, "state/agent/sessions/credentials.json"), '{"apiKey":"FAKE_API_KEY_MUST_NOT_EXPORT_7f3a"}\n');
  const poisoned = await runCli(["state-merge", "--instance-dir", target, "--snapshot", snapshot], { allowFailure: true });
  assert.match(poisoned.error, /未登记或禁止内容/);
  await rm(join(snapshot, "state/agent/sessions/credentials.json"));

  const targetBefore = await readFile(join(target, "workspace/report.md"), "utf8");
  const dryMerge = await runCli(["state-merge", "--instance-dir", target, "--snapshot", snapshot]);
  assert.equal(dryMerge.executes, false);
  assert.ok(dryMerge.conflicts.includes("workspace/report.md"));
  assert.equal(await readFile(join(target, "workspace/report.md"), "utf8"), targetBefore);
  const merged = await runCli(["state-merge", "--instance-dir", target, "--snapshot", snapshot, "--execute", "--target-stopped", "--confirm", "MERGE_STATE"]);
  assert.equal(merged.status, "ok");
  assert.equal(await readFile(join(target, "workspace/report.md"), "utf8"), "target-version\n");
  assert.equal(await readFile(join(target, "workspace/target-only.md"), "utf8"), "keep-me\n");
  assert.equal(await readFile(join(target, "workspace/new-task.md"), "utf8"), "new-task\n");
  assert.equal(await readFile(join(merged.conflictCopies, "workspace/report.md"), "utf8"), "incoming-version\n");
  assert.equal(JSON.parse(await readFile(join(target, "wecom.json"), "utf8")).active, "test");
  assert.equal(JSON.parse(await readFile(join(target, "secrets.json"), "utf8")).mainApiKey, "never-export-main");
  const inbox = (await readFile(join(target, "data/inbox.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual([...new Set(inbox.map((entry) => entry.msgid))].sort(), ["m1", "m2", "m3"]);
  assert.deepEqual(inbox.at(-1), { msgid: "m2", state: "running", at: "2026-11-05T00:03:00.000Z" });
  const state = JSON.parse(await readFile(join(target, "data/session-state.json"), "utf8"));
  assert.equal(state.generation.u1, 2);
  assert.equal(state.activity.u1.at, 200);
  assert.deepEqual(state.touched, { "u1-g1": true, target: true, "u1-g2": true, source: true });
  const lines = (await readFile(join(target, "agent/sessions/s.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines.includes('{"incoming":true}'));
  assert.equal(await readFile(join(target, "agent/legacy-session.jsonl"), "utf8"), '{"legacy":true}\n');
  assert.equal(existsSync(join(target, "agent/sessions/legacy-session.jsonl")), false);
});

test("legacy 根会话与嵌套 sessions 经导出、导入和回滚保持相对路径且不带凭证", async (t) => {
  const root = await makeTempDir(t);
  const oldInstance = join(root, "old-instance");
  const legacyAgent = join(root, "legacy-agent");
  const newInstance = join(root, "new-instance");
  await makeInstance(oldInstance, { id: "old" });
  await makeInstance(newInstance, { id: "new" });
  await mkdir(join(legacyAgent, "sessions/nested"), { recursive: true });
  await writeFile(join(legacyAgent, "root-session.jsonl"), '{"root":true}\n');
  await writeFile(join(legacyAgent, "sessions/nested/session.jsonl"), '{"nested":true}\n');
  await writeFile(join(legacyAgent, "models.json"), '{"provider":{"apiKey":"FAKE_API_KEY_MUST_NOT_EXPORT_7f3a"}}\n');
  await writeFile(join(legacyAgent, "credentials.json"), '{"apiKey":"FAKE_API_KEY_MUST_NOT_EXPORT_7f3a"}\n');

  const snapshot = join(root, "snapshot");
  await runCli(["state-export", "--instance-dir", oldInstance, "--legacy-agent-dir", legacyAgent, "--output", snapshot, "--execute", "--source-stopped", "--confirm", "EXPORT_STATE"]);
  const manifest = JSON.parse(await readFile(join(snapshot, "migration-state.json"), "utf8"));
  const paths = manifest.files.map((entry) => entry.path);
  assert.ok(paths.includes("agent/root-session.jsonl"));
  assert.ok(paths.includes("agent/sessions/nested/session.jsonl"));
  assert.equal(paths.some((path) => /models|credentials/.test(path)), false);
  await runCli(["state-merge", "--instance-dir", newInstance, "--snapshot", snapshot, "--execute", "--target-stopped", "--confirm", "MERGE_STATE"]);
  assert.equal(await readFile(join(newInstance, "agent/root-session.jsonl"), "utf8"), '{"root":true}\n');
  assert.equal(await readFile(join(newInstance, "agent/sessions/nested/session.jsonl"), "utf8"), '{"nested":true}\n');

  const rollbackSnapshot = join(root, "rollback-snapshot");
  const restoredAgent = join(root, "restored-legacy-agent");
  await runCli(["state-export", "--instance-dir", newInstance, "--output", rollbackSnapshot, "--execute", "--source-stopped", "--confirm", "EXPORT_STATE"]);
  await runCli(["state-merge", "--instance-dir", oldInstance, "--legacy-agent-dir", restoredAgent, "--snapshot", rollbackSnapshot, "--execute", "--target-stopped", "--confirm", "MERGE_STATE"]);
  assert.equal(await readFile(join(restoredAgent, "root-session.jsonl"), "utf8"), '{"root":true}\n');
  assert.equal(await readFile(join(restoredAgent, "sessions/nested/session.jsonl"), "utf8"), '{"nested":true}\n');
  assert.equal(existsSync(join(restoredAgent, "sessions/root-session.jsonl")), false);
});

test("状态包默认拒绝凭证与未知二进制，导入重扫且回滚保留良性新任务", async (t) => {
  const root = await makeTempDir(t);
  const source = join(root, "safe-source");
  const target = join(root, "safe-target");
  const snapshot = join(root, "safe-snapshot");
  await makeInstance(source, { id: "safe-source" });
  await makeInstance(target, { id: "safe-target" });
  const secretValue = "sk-live-9f8e7d6c5b4a39281706";
  const rejectedFiles = [
    ["workspace/.env.local", "APP_MODE=production\n", /凭证|秘密|敏感/],
    ["workspace/.npmrc", `//registry.invalid/:_authToken=${secretValue}\n`, /凭证|秘密|敏感/],
    ["workspace/id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\nfake-private-key-material\n-----END OPENSSH PRIVATE KEY-----\n", /凭证|秘密|私钥|敏感/],
    ["workspace/ordinary-config.json", `${JSON.stringify({ apiKey: secretValue })}\n`, /凭证|秘密|敏感/],
    ["workspace/unknown.bin", Buffer.from([0, 1, 2, 3, 255]), /无法安全|二进制|不支持/],
  ];
  for (const [name, contents, pattern] of rejectedFiles) {
    const path = join(source, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    const rejected = await runCli(["state-export", "--instance-dir", source, "--output", snapshot], { allowFailure: true });
    assert.equal(rejected.status, "error", `${name} 不得得到 planned`);
    assert.match(rejected.error, pattern);
    assert.equal(existsSync(snapshot), false);
    await rm(path);
  }

  await writeFile(join(source, "workspace/report.md"), "良性报告，不含凭证。\n");
  await writeFile(join(source, "workspace/prototype.html"), "<!doctype html><title>良性原型</title>\n");
  await writeFile(join(source, "workspace/task.json"), '{"task":"保留普通任务配置","enabled":true}\n');
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await writeFile(join(source, "workspace/diagram.png"), png);
  await writeFile(join(source, "agent/sessions/new-session.jsonl"), '{"task":"new-session"}\n');
  const exported = await runCli(["state-export", "--instance-dir", source, "--output", snapshot, "--execute", "--source-stopped", "--confirm", "EXPORT_STATE"]);
  assert.equal(exported.status, "ok");
  const manifestPath = join(snapshot, "migration-state.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const paths = manifest.files.map((entry) => entry.path);
  assert.ok(paths.includes("workspace/report.md"));
  assert.ok(paths.includes("workspace/prototype.html"));
  assert.ok(paths.includes("workspace/task.json"));
  assert.ok(paths.includes("workspace/diagram.png"));
  assert.ok(paths.includes("agent/sessions/new-session.jsonl"));
  assert.equal(paths.some((path) => /(?:models|secrets|wecom|credentials|auth|token)/i.test(path)), false);
  for (const entry of manifest.files) {
    if (entry.path.endsWith(".png")) continue;
    assert.doesNotMatch(await readFile(join(snapshot, "state", entry.path), "utf8"), /sk-live-9f8e7d6c5b4a39281706|PRIVATE KEY/);
  }

  const importedSecret = join(snapshot, "state/workspace/imported-config.json");
  await writeFile(importedSecret, `${JSON.stringify({ password: "rollback-import-secret-9f8e7d6c" })}\n`);
  manifest.files.push({ path: "workspace/imported-config.json", sha256: sha256(await readFile(importedSecret)), size: (await stat(importedSecret)).size });
  await writeJson(manifestPath, manifest);
  const poisonedImport = await runCli(["state-merge", "--instance-dir", target, "--snapshot", snapshot], { allowFailure: true });
  assert.equal(poisonedImport.status, "error");
  assert.match(poisonedImport.error, /凭证|秘密|敏感/);
  assert.equal(existsSync(join(target, "workspace/imported-config.json")), false);
  manifest.files.pop();
  await rm(importedSecret);
  await writeJson(manifestPath, manifest);
  manifest.files.push({ path: "workspace/../../escape.md", sha256: "0".repeat(64), size: 0 });
  await writeJson(manifestPath, manifest);
  const traversalImport = await runCli(["state-merge", "--instance-dir", target, "--snapshot", snapshot], { allowFailure: true });
  assert.equal(traversalImport.status, "error");
  assert.match(traversalImport.error, /路径越界/);
  manifest.files.pop();
  await writeJson(manifestPath, manifest);

  await runCli(["state-merge", "--instance-dir", target, "--snapshot", snapshot, "--execute", "--target-stopped", "--confirm", "MERGE_STATE"]);
  assert.equal(await readFile(join(target, "workspace/report.md"), "utf8"), "良性报告，不含凭证。\n");
  assert.equal(await readFile(join(target, "workspace/prototype.html"), "utf8"), "<!doctype html><title>良性原型</title>\n");
  assert.deepEqual(await readFile(join(target, "workspace/diagram.png")), png);
  assert.equal(await readFile(join(target, "agent/sessions/new-session.jsonl"), "utf8"), '{"task":"new-session"}\n');

  await writeFile(join(target, "workspace/rollback-new-task.md"), "Windows 新任务不得丢失\n");
  const rollbackSnapshot = join(root, "safe-rollback");
  await runCli(["state-export", "--instance-dir", target, "--output", rollbackSnapshot, "--execute", "--source-stopped", "--confirm", "EXPORT_STATE"]);
  await runCli(["state-merge", "--instance-dir", source, "--snapshot", rollbackSnapshot, "--execute", "--target-stopped", "--confirm", "MERGE_STATE"]);
  assert.equal(await readFile(join(source, "workspace/rollback-new-task.md"), "utf8"), "Windows 新任务不得丢失\n");
  const rollbackRaw = await readFile(join(rollbackSnapshot, "migration-state.json"), "utf8");
  assert.doesNotMatch(rollbackRaw, /models\.json|secrets\.json|wecom\.json|credentials|auth|token/i);
});

test("验收硬门拒绝空路径、占位、未运行、正式 botId、缺场景和被篡改证据", async (t) => {
  const root = await makeTempDir(t);
  const instance = join(root, "instance");
  await makeInstance(instance);
  const record = join(root, "acceptance.json");
  const created = await runCli(["acceptance-create", "--instance-dir", instance, "--output", record]);
  assert.equal(created.readyForCutover, false);
  const noEvidence = await runCli(["acceptance-update", "--record", record, "--case", "wecom-text", "--status", "passed"], { allowFailure: true });
  assert.match(noEvidence.error, /证据/);
  const missing = await runCli(["acceptance-update", "--record", record, "--case", "wecom-text", "--status", "passed", "--evidence", join(root, "does-not-exist.json")], { allowFailure: true });
  assert.match(missing.error, /不存在|读取|证据/);
  const placeholder = join(root, "placeholder.json");
  await writeJson(placeholder, { status: "passed" });
  const empty = await runCli(["acceptance-update", "--record", record, "--case", "wecom-text", "--status", "passed", "--evidence", placeholder], { allowFailure: true });
  assert.match(empty.error, /格式|证据/);
  const unrun = await writeCaseEvidence(record, "wecom-text", { executed: false });
  const notExecuted = await runCli(["acceptance-update", "--record", record, "--case", "wecom-text", "--status", "passed", "--evidence", unrun.path], { allowFailure: true });
  assert.match(notExecuted.error, /执行|passed|真实/);
  const incomplete = await writeCaseEvidence(record, "wecom-text", { omitScenario: "group-chat" });
  const missingScenario = await runCli(["acceptance-update", "--record", record, "--case", "wecom-text", "--status", "passed", "--evidence", incomplete.path], { allowFailure: true });
  assert.match(missingScenario.error, /场景|缺少/);
  const production = await writeCaseEvidence(record, "wecom-text", { testBotId: "production-bot" });
  const wrongBot = await runCli(["acceptance-update", "--record", record, "--case", "wecom-text", "--status", "passed", "--evidence", production.path], { allowFailure: true });
  assert.match(wrongBot.error, /测试机器人|botId/);
  const wrongResource = await writeCaseEvidence(record, "wecom-text");
  const wrongResourcePath = join(root, "evidence/wecom-text/single-chat.json");
  await writeJson(wrongResourcePath, { ...JSON.parse(await readFile(wrongResourcePath, "utf8")), resourceVersion: "resource-v2" });
  wrongResource.evidence.scenarios[0].resultSha256 = sha256(await readFile(wrongResourcePath));
  await writeJson(wrongResource.path, wrongResource.evidence);
  const wrongBaseline = await runCli(["acceptance-update", "--record", record, "--case", "wecom-text", "--status", "passed", "--evidence", wrongResource.path], { allowFailure: true });
  assert.match(wrongBaseline.error, /资源|基线/);

  await passAcceptance(record);
  const oldInstance = join(root, "old");
  await makeInstance(oldInstance, { id: "old" });
  const binaries = await makeFakeServiceBinaries(root);
  const oldArgs = ["cutover-old", "--instance-dir", oldInstance, "--acceptance", record, "--output", join(root, "cutover"), "--launchctl", binaries.launchctl];
  const dry = await runCli(oldArgs);
  assert.equal(dry.executes, false);
  await rm(join(root, "evidence/wecom-text/group-chat.json"));
  const tampered = await runCli(oldArgs, { allowFailure: true });
  assert.match(tampered.error, /证据|结果|不存在/);
  assert.deepEqual(await readLines(binaries.launchLog), []);
});

test("固定问题对照同时校验 ID 与正文哈希，换题、漏题和基线升级均失败", async (t) => {
  const root = await makeTempDir(t);
  await makeComparison(root);
  const beforePath = join(root, "before.json");
  const afterPath = join(root, "after.json");
  const before = JSON.parse(await readFile(beforePath, "utf8"));
  const after = JSON.parse(await readFile(afterPath, "utf8"));
  await writeJson(afterPath, { ...after, models: { ...after.models, main: { model: "upgraded-model" } } });
  const upgraded = await runCli(["acceptance-compare", "--before", beforePath, "--after", afterPath, "--output", join(root, "bad-comparison.json")], { allowFailure: true });
  assert.match(upgraded.error, /不得捆绑模型升级/);
  await writeJson(afterPath, { ...after, resourceVersion: "resource-v2" });
  const resourceUpgrade = await runCli(["acceptance-compare", "--before", beforePath, "--after", afterPath, "--output", join(root, "bad-resource.json")], { allowFailure: true });
  assert.match(resourceUpgrade.error, /资源版本/);

  const changedBefore = structuredClone(before);
  const changedAfter = structuredClone(after);
  for (const report of [changedBefore, changedAfter]) {
    report.results[0].question = "同一 ID 但换成了另一道题";
    report.results[0].questionSha256 = sha256(report.results[0].question);
  }
  await writeJson(beforePath, changedBefore);
  await writeJson(afterPath, changedAfter);
  const changed = await runCli(["acceptance-compare", "--before", beforePath, "--after", afterPath, "--output", join(root, "changed.json")], { allowFailure: true });
  assert.match(changed.error, /固定问题|正文|哈希/);
  for (const report of [changedBefore, changedAfter]) report.results.pop();
  await writeJson(beforePath, changedBefore);
  await writeJson(afterPath, changedAfter);
  const omitted = await runCli(["acceptance-compare", "--before", beforePath, "--after", afterPath, "--output", join(root, "omitted.json")], { allowFailure: true });
  assert.match(omitted.error, /固定问题|缺少|漏题|数量/);
});

test("acceptance-run 通过公开 ask 边界记录真实执行结果且不把未运行题目标为通过", async (t) => {
  const root = await makeTempDir(t);
  const isolated = join(root, "runner");
  await mkdir(join(isolated, "scripts"), { recursive: true });
  await mkdir(join(isolated, "docs"), { recursive: true });
  await writeJson(join(isolated, "package.json"), { type: "module" });
  await writeFile(join(isolated, "scripts/windows-instance.js"), await readFile(cliPath, "utf8"));
  await writeFile(join(isolated, "docs/windows-migration-questions.json"), await readFile(join(projectDir, "docs/windows-migration-questions.json"), "utf8"));
  const askLog = join(root, "ask.jsonl");
  await writeFile(join(isolated, "scripts/local-instance.js"), `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(askLog)}, JSON.stringify({ args, piBinary: process.env.WECOM_BOT_PI_BINARY ?? null }) + "\\n");
const question = args[args.indexOf("--question") + 1];
console.log(JSON.stringify({ finalText: "真实执行结果：" + question, loadedResources: [{ source: "docs", resourceType: "concept", depth: "summary", verification: "read" }], loadedSkills: [], executionApprovals: [], guarded: false, rounds: 1 }));
`);
  const instance = join(root, "instance");
  await makeInstance(instance);
  const notReady = join(root, "not-ready");
  await makeInstance(notReady);
  await writeJson(join(notReady, "instance.json"), { ...JSON.parse(await readFile(join(notReady, "instance.json"), "utf8")), ready: false });
  const notReadyOutput = join(root, "not-ready.json");
  const notReadyRun = await execFileAsync(process.execPath, [join(isolated, "scripts/windows-instance.js"), "acceptance-run", "--instance-dir", notReady, "--questions", join(isolated, "docs/windows-migration-questions.json"), "--output", notReadyOutput], { cwd: isolated, reject: false }).catch((error) => error);
  assert.notEqual(notReadyRun.code, 0);
  assert.match(notReadyRun.stderr, /初始化/);
  assert.equal(existsSync(notReadyOutput), false);
  const output = join(root, "answers.json");
  const { stdout } = await execFileAsync(process.execPath, [join(isolated, "scripts/windows-instance.js"), "acceptance-run", "--instance-dir", instance, "--questions", join(isolated, "docs/windows-migration-questions.json"), "--output", output], { cwd: isolated, env: { ...process.env, WECOM_BOT_PI_BINARY: "/opt/wecom-support-bot/runtime/pi/bin/pi" } });
  assert.equal(JSON.parse(stdout).status, "completed");
  const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(report.formatVersion, 2);
  assert.equal(report.status, "completed");
  assert.equal(report.results.length, 6);
  for (const entry of report.results) {
    assert.equal(entry.executed, true);
    assert.equal(entry.executionStatus, "completed");
    assert.equal(entry.questionSha256, sha256(entry.question));
    assert.match(entry.result.finalText, /^真实执行结果：/);
    assert.notEqual(entry.status, "passed");
  }
  const calls = await readLines(askLog);
  assert.equal(calls.length, 6);
  for (const call of calls) assert.equal(call.piBinary, "/opt/wecom-support-bot/runtime/pi/bin/pi");
  const failedReport = structuredClone(report);
  failedReport.status = "failed";
  failedReport.results[0].executed = false;
  failedReport.results[0].executionStatus = "failed";
  failedReport.results[0].result = null;
  const failedPath = join(root, "failed-answers.json");
  await writeJson(failedPath, failedReport);
  const failedCompare = await runCli(["acceptance-compare", "--before", output, "--after", failedPath, "--output", join(root, "failed-comparison.json")], { allowFailure: true });
  assert.match(failedCompare.error, /尚未全部真实执行完成/);

  const changed = await fixedQuestions();
  changed[0].question = "未运行换题";
  const changedPath = join(root, "changed-questions.json");
  const changedOutput = join(root, "changed-answers.json");
  await writeJson(changedPath, changed);
  const rejected = await execFileAsync(process.execPath, [join(isolated, "scripts/windows-instance.js"), "acceptance-run", "--instance-dir", instance, "--questions", changedPath, "--output", changedOutput], { cwd: isolated, reject: false }).catch((error) => error);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /固定问题|正文|哈希/);
  assert.equal(existsSync(changedOutput), false);
});

test("正式切换与回滚通过假服务边界严格排序，并带回 Windows 新状态", async (t) => {
  const root = await makeTempDir(t);
  const oldInstance = join(root, "old");
  const newInstance = join(root, "new");
  await makeInstance(oldInstance, { id: "old" });
  await makeInstance(newInstance, { id: "new" });
  await writeFile(join(oldInstance, "data/inbox.jsonl"), JSON.stringify({ msgid: "old-message", question: "旧端最后问题", userId: "u-old", receivedAt: "2026-11-05T00:00:00.000Z", state: "received" }) + "\n");
  await writeFile(join(oldInstance, "workspace/old-task.md"), "old\n");
  await writeFile(join(newInstance, "data/inbox.jsonl"), JSON.stringify({ msgid: "test-only-message", question: "测试机器人问题", userId: "u-test", receivedAt: "2026-11-04T23:00:00.000Z", state: "received" }) + "\n");
  const acceptance = join(root, "acceptance.json");
  await runCli(["acceptance-create", "--instance-dir", newInstance, "--output", acceptance]);
  await passAcceptance(acceptance);
  const binaries = await makeFakeServiceBinaries(root);
  const output = join(root, "cutover");
  const args = cutoverArgs(oldInstance, newInstance, acceptance, output, binaries);

  const dryOld = await runCli(args.old);
  assert.equal(dryOld.executes, false);
  assert.deepEqual(await readLines(binaries.launchLog), []);
  const stopped = await runCli([...args.old, "--execute", "--confirm", "STOP_OLD_PRODUCTION"]);
  assert.equal(stopped.status, "old-stopped-new-not-started");
  assert.deepEqual((await readLines(binaries.launchLog)).map((entry) => entry[0]), ["list", "unload", "list"]);
  const dryNew = await runCli(args.new);
  assert.equal(dryNew.executes, false);
  assert.deepEqual(await readLines(binaries.systemLog), []);
  const oldStoppedValue = JSON.parse(await readFile(join(output, "old-stopped.json"), "utf8"));
  const wrongOldStopped = join(root, "wrong-old-stopped.json");
  await writeJson(wrongOldStopped, { ...oldStoppedValue, snapshotManifestSha256: "0".repeat(64) });
  const wrongOldArgs = args.new.map((value, index) => args.new[index - 1] === "--old-stopped" ? wrongOldStopped : value);
  const wrongOldPlan = await runCli(wrongOldArgs, { allowFailure: true });
  assert.equal(wrongOldPlan.status, "error");
  assert.match(wrongOldPlan.error, /状态包不匹配|最终状态包/);
  const invalidOldStopped = join(root, "invalid-old-stopped.json");
  await writeJson(invalidOldStopped, { ...oldStoppedValue, verifiedStopped: false });
  const invalidOldPlan = await runCli(args.new.map((value, index) => args.new[index - 1] === "--old-stopped" ? invalidOldStopped : value), { allowFailure: true });
  assert.equal(invalidOldPlan.status, "error");
  assert.match(invalidOldPlan.error, /停用证明/);
  const snapshotTask = join(output, "state/state/workspace/old-task.md");
  const snapshotTaskBytes = await readFile(snapshotTask);
  await writeFile(snapshotTask, "tampered-during-review\n");
  const tamperedNewPlan = await runCli(args.new, { allowFailure: true });
  assert.equal(tamperedNewPlan.status, "error");
  assert.match(tamperedNewPlan.error, /校验失败/);
  await writeFile(snapshotTask, snapshotTaskBytes);
  assert.deepEqual(await readLines(binaries.systemLog), []);
  const active = await runCli([...args.new, "--execute", "--confirm", "ACTIVATE_NEW_PRODUCTION"]);
  assert.equal(active.status, "new-active-old-stopped");
  const systemCalls = await readLines(binaries.systemLog);
  assert.deepEqual(systemCalls[0], ["disable", "--now", "wecom-support-bot.service"]);
  assert.deepEqual(systemCalls.at(-2), ["enable", "--now", "wecom-support-bot.service"]);
  assert.deepEqual(systemCalls.at(-1), ["is-active", "wecom-support-bot.service"]);
  assert.deepEqual((await readLines(binaries.launchLog)).map((entry) => entry[0]), ["list", "unload", "list"]);
  assert.equal(JSON.parse(await readFile(join(newInstance, "wecom.json"), "utf8")).active, "production");
  assert.equal(await readFile(join(newInstance, "workspace/old-task.md"), "utf8"), "old\n");
  assert.doesNotMatch(await readFile(join(newInstance, "data/inbox.jsonl"), "utf8"), /test-only-message/);
  assert.match(await readFile(join(active.record.testRuntimeArchive, "data/inbox.jsonl"), "utf8"), /test-only-message/);

  await writeFile(join(newInstance, "workspace/windows-task.md"), "created-on-windows\n");
  await writeFile(join(newInstance, "data/inbox.jsonl"), (await readFile(join(newInstance, "data/inbox.jsonl"), "utf8")) + JSON.stringify({ msgid: "windows-message", question: "Windows 新问题", userId: "u-new", receivedAt: "2026-11-05T01:00:00.000Z", state: "received" }) + "\n");
  const rollbackOutput = join(root, "rollback");
  const rollbackNewArgs = ["rollback-new", "--instance-dir", newInstance, "--output", rollbackOutput, "--systemctl", binaries.systemctl];
  const dryRollback = await runCli(rollbackNewArgs);
  assert.equal(dryRollback.executes, false);
  const windowsStopped = await runCli([...rollbackNewArgs, "--execute", "--confirm", "STOP_WINDOWS_PRODUCTION"]);
  assert.equal(windowsStopped.status, "windows-stopped-old-not-started");
  assert.equal(JSON.parse(await readFile(join(newInstance, "wecom.json"), "utf8")).active, "none");
  const rollbackOldArgs = ["rollback-old", "--instance-dir", oldInstance, "--windows-stopped", join(rollbackOutput, "windows-stopped.json"), "--snapshot", join(rollbackOutput, "state"), "--plist", join(root, "old.plist"), "--launchctl", binaries.launchctl];
  const dryRestore = await runCli(rollbackOldArgs);
  assert.equal(dryRestore.executes, false);
  const windowsStoppedValue = JSON.parse(await readFile(join(rollbackOutput, "windows-stopped.json"), "utf8"));
  const wrongWindowsStopped = join(root, "wrong-windows-stopped.json");
  await writeJson(wrongWindowsStopped, { ...windowsStoppedValue, snapshotManifestSha256: "f".repeat(64) });
  const wrongRollbackPlan = await runCli(rollbackOldArgs.map((value, index) => rollbackOldArgs[index - 1] === "--windows-stopped" ? wrongWindowsStopped : value), { allowFailure: true });
  assert.equal(wrongRollbackPlan.status, "error");
  assert.match(wrongRollbackPlan.error, /状态包不匹配|最终状态包/);
  const rollbackTask = join(rollbackOutput, "state/state/workspace/windows-task.md");
  const rollbackTaskBytes = await readFile(rollbackTask);
  await writeFile(rollbackTask, "tampered-before-rollback\n");
  const tamperedRollbackPlan = await runCli(rollbackOldArgs, { allowFailure: true });
  assert.equal(tamperedRollbackPlan.status, "error");
  assert.match(tamperedRollbackPlan.error, /校验失败/);
  await writeFile(rollbackTask, rollbackTaskBytes);
  assert.deepEqual((await readLines(binaries.launchLog)).map((entry) => entry[0]), ["list", "unload", "list"]);
  const restored = await runCli([...rollbackOldArgs, "--execute", "--confirm", "RESTORE_OLD_PRODUCTION"]);
  assert.equal(restored.status, "old-active-windows-stopped");
  assert.equal(await readFile(join(oldInstance, "workspace/windows-task.md"), "utf8"), "created-on-windows\n");
  assert.match(await readFile(join(oldInstance, "data/inbox.jsonl"), "utf8"), /windows-message/);
  assert.deepEqual((await readLines(binaries.launchLog)).map((entry) => entry[0]).slice(-4), ["list", "list", "load", "list"]);
  assert.equal(JSON.parse(await readFile(binaries.systemState), "utf8").active, false);
  assert.equal(JSON.parse(await readFile(binaries.launchState), "utf8").loaded, true);
});

test("新端正式启用失败时改回 none 并停用，不自动拉起旧端", async (t) => {
  const root = await makeTempDir(t);
  const oldInstance = join(root, "old");
  const newInstance = join(root, "new");
  await makeInstance(oldInstance, { id: "old" });
  await makeInstance(newInstance, { id: "new" });
  const acceptance = join(root, "acceptance.json");
  await runCli(["acceptance-create", "--instance-dir", newInstance, "--output", acceptance]);
  await passAcceptance(acceptance);
  const binaries = await makeFakeServiceBinaries(root);
  const output = join(root, "cutover");
  const args = cutoverArgs(oldInstance, newInstance, acceptance, output, binaries);
  await runCli([...args.old, "--execute", "--confirm", "STOP_OLD_PRODUCTION"]);
  const failed = await runCli([...args.new, "--execute", "--confirm", "ACTIVATE_NEW_PRODUCTION"], { allowFailure: true, env: { ...process.env, FAKE_SYSTEMD_START_FAIL: "1" } });
  assert.match(failed.error, /已安全停用新端且未重启旧端/);
  assert.equal(JSON.parse(await readFile(join(newInstance, "wecom.json"), "utf8")).active, "none");
  assert.equal(JSON.parse(await readFile(binaries.systemState), "utf8").active, false);
  assert.equal(JSON.parse(await readFile(binaries.systemState), "utf8").enabled, false);
  assert.equal(JSON.parse(await readFile(binaries.launchState), "utf8").loaded, false);
  assert.deepEqual((await readLines(binaries.launchLog)).map((entry) => entry[0]), ["list", "unload", "list"]);
});

test("PowerShell 标准包 PlanOnly 与控制台假 WSL 使用同一 runtime pi（可用时执行）", async (t) => {
  let pwsh = null;
  try { pwsh = execFileSync("bash", ["-lc", "command -v pwsh"], { encoding: "utf8" }).trim(); } catch {}
  if (!pwsh || process.platform === "win32") {
    t.skip(process.platform === "win32" ? "真实 Windows 不使用本假 WSL；需按未验收清单实机验证" : "当前 macOS 无 pwsh；标准包 PlanOnly 与控制台假 WSL 未执行");
    return;
  }
  const root = await makeTempDir(t);
  const packageDir = join(root, "package");
  await runCli(["build-package", "--output", packageDir]);
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const wslLog = join(root, "wsl.jsonl");
  const fakeWsl = join(bin, "wsl.exe");
  await writeFile(fakeWsl, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(wslLog)}, JSON.stringify(args) + "\\n");
if (args.includes("wslpath")) {
  if (process.env.FAKE_WSLPATH_OUTPUT) { console.log(process.env.FAKE_WSLPATH_OUTPUT); }
  else {
    const input = args.at(-1).replaceAll("\\\\", "/");
    const match = input.match(/^([A-Za-z]):\\/(.*)$/);
    console.log(match ? "/mnt/" + match[1].toLowerCase() + "/" + match[2] : "/mnt/c/fake-source");
  }
}
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOCALAPPDATA: join(root, "local-app-data") };
  const { stdout } = await execFileAsync(pwsh, ["-NoProfile", "-File", join(packageDir, "windows/install.ps1"), "-PlanOnly"], { env });
  const plan = JSON.parse(stdout);
  assert.equal(plan.paths.runtimeDir, "/opt/wecom-support-bot/runtime");
  assert.equal(plan.packageLayout.manifest, "windows-package.json");

  const commands = [
    ["init", "--template", "team", "--source", "https://example.invalid/shared.git", "--scope", "shared", "--base-url", "http://192.168.1.20:3425/v1", "--api-key", "test-only-key", "--model", "main-model"],
    ["status"],
    ["sync", "--source", "https://example.invalid/shared.git", "--scope", "shared"],
    ["ask", "--question", "测试问题", "--session-key", "console-test"],
    ["acceptance-create", "--output", "C:\\migration\\acceptance.json"],
    ["acceptance-update", "--record", "C:\\migration\\acceptance.json", "--case", "wecom-text", "--status", "failed", "--evidence", "D:\\evidence\\result.json"],
    ["acceptance-run", "--questions", "C:\\migration\\questions.json", "--output", "D:\\evidence\\answers.json"],
    ["acceptance-compare", "--before", "C:\\migration\\before.json", "--after", "D:\\evidence\\after.json", "--output", "D:\\evidence\\comparison.json"],
    ["start"], ["stop"], ["restart"], ["service-status"],
    ["cutover-new", "--acceptance", "C:\\migration\\acceptance.json", "--old-stopped", "C:\\migration\\old.json", "--snapshot", "D:\\migration\\state"],
    ["rollback-new", "--output", "D:\\migration\\rollback"],
  ];
  for (const args of commands) {
    await execFileAsync(pwsh, ["-NoProfile", "-File", join(projectDir, "windows/console.ps1"), "-Command", args[0], ...args.slice(1)], { env });
  }
  await runWithInput(pwsh, ["-NoProfile", "-File", join(projectDir, "windows/console.ps1"), "-Command", "menu"], "12\nC:\\migration\\menu-acceptance.json\nwecom-text\nfailed\nD:\\evidence\\menu-result.json\n", { env });
  const disallowed = await execFileAsync(pwsh, ["-NoProfile", "-File", join(projectDir, "windows/console.ps1"), "-Command", "acceptance-update", "--record", "/tmp/acceptance.json", "--case", "wecom-text", "--status", "failed", "--evidence", "/etc/passwd"], { env }).then(() => null, (error) => error);
  assert.ok(disallowed, "/etc/passwd 证据路径必须明确失败");
  const escaped = await execFileAsync(pwsh, ["-NoProfile", "-File", join(projectDir, "windows/console.ps1"), "-Command", "acceptance-update", "--record", "C:\\migration\\acceptance.json", "--case", "wecom-text", "--status", "failed", "--evidence", "D:\\evidence\\result.json"], { env: { ...env, FAKE_WSLPATH_OUTPUT: "/etc/passwd" } }).then(() => null, (error) => error);
  assert.ok(escaped, "wslpath 转换到允许根之外时必须明确失败");
  const calls = await readLines(wslLog);
  assert.ok(calls.length >= commands.length);
  const pathOptions = new Set(["--record", "--evidence", "--questions", "--output", "--before", "--after", "--acceptance", "--old-stopped", "--snapshot"]);
  for (const args of calls) {
    const separator = args.indexOf("--");
    const command = args.slice(separator + 1);
    if (command[0] === "wslpath") continue;
    assert.equal(command[0], "env");
    assert.equal(command[1], "WECOM_BOT_PI_BINARY=/opt/wecom-support-bot/runtime/pi/bin/pi");
    assert.equal(args.some((value) => value.includes("/home/wecom/.pi-support/bin/pi")), false);
    for (const [index, value] of command.entries()) {
      if (!pathOptions.has(value)) continue;
      assert.match(command[index + 1], /^\/mnt\/[cd]\//, `证据路径必须统一转换：${command.join(" ")}`);
    }
    assert.equal(command.some((value) => /^[A-Za-z]:[\\/]/.test(value)), false, `不得把 Windows 原路径直接传给 WSL：${command.join(" ")}`);
  }
  const menuUpdate = calls.map((args) => args.slice(args.indexOf("--") + 1)).filter((command) => command[0] === "env").find((command) => command.some((value) => value.includes("menu-acceptance.json")));
  assert.ok(menuUpdate, "菜单登记验收必须实际调用假 WSL");
  assert.ok(menuUpdate.includes("/mnt/c/migration/menu-acceptance.json"));
  assert.ok(menuUpdate.includes("/mnt/d/evidence/menu-result.json"));
});

test("PowerShell 安装器与控制台在实际 pwsh 可用时做语法解析，否则明确跳过", async (t) => {
  let pwsh = null;
  try { pwsh = execFileSync("bash", ["-lc", "command -v pwsh"], { encoding: "utf8" }).trim(); } catch {}
  if (!pwsh) {
    t.skip("当前 macOS 无 pwsh；PowerShell 语法及真实 Windows 行为未验收");
    return;
  }
  for (const script of ["windows/install.ps1", "windows/console.ps1"]) {
    const expression = `$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${join(projectDir, script)}', [ref]$null, [ref]$errors) > $null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }`;
    await execFileAsync(pwsh, ["-NoProfile", "-Command", expression]);
  }
});

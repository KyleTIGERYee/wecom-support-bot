import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { findPersonalResidue } from "../scripts/personal-residue.js";

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
/** 模型地址用通用占位（非回环即可通过 validate-model-url），测试里不写任何真实局域网 IP。 */
const MODEL_URL = "http://10.0.0.1:3425/v1";
const MODELS = Object.fromEntries(["main", "quick", "guard", "executionApproval"].map((role) => [role, { baseUrl: MODEL_URL, model: `${role}-model` }]));

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

/**
 * 假 launchctl 严格模拟 launchd 的 label 语义，专门用来抓“查固定标签而不是 plist 真实 Label”的回归：
 * - load/unload 只接受 plist 路径，Label 一律从 plist 的 <key>Label</key> 解析；plist 不存在或没有 Label 直接失败；
 * - list <label>：已加载 → 0；已知但未加载 → 1；从未出现过的 label → 113（真实 launchctl 的
 *   “Could not find service”）。“已知”= 初始登记或经 load/unload 的 plist 登记过。CLI 若传了与 plist
 *   不一致的 label（例如固定默认标签），就会得到 113 并被 assertLaunchLabelsKnown 抓到；
 * - 每次调用把 { args, code } 写入 launchLog，测试据此断言 list 用的 label 必须等于 plist 的 Label。
 * 环境开关：FAKE_LAUNCHD_START_FAIL=1 让 load 失败；FAKE_LAUNCHD_LOAD_UNVERIFIABLE=1 让 load 成功后
 * 的第一次 list 查不到、=2 之后一直查不到（模拟恢复后无法验证，触发失败清理）；FAKE_LAUNCHD_UNLOAD_IGNORED=1
 * 让 unload 不生效（模拟服务卡住）；FAKE_LAUNCHD_UNLOAD_FAIL=1 让 unload 直接报错（模拟旧系统对未加载服务 unload 出错）。
 */
async function makeFakeServiceBinaries(root, { launchdLabels = ["com.wecom-support-bot"], knownLabels = launchdLabels } = {}) {
  const systemLog = join(root, "systemctl.jsonl");
  const systemState = join(root, "systemd-state.json");
  const launchLog = join(root, "launchctl.jsonl");
  const launchState = join(root, "launchd-state.json");
  const chownLog = join(root, "chown.jsonl");
  await writeJson(systemState, { active: true, enabled: true });
  await writeJson(launchState, { loaded: launchdLabels, known: knownLabels, unverifiable: [] });
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
const statePath = ${JSON.stringify(launchState)};
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const finish = (code) => {
  save();
  fs.appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ args, code }) + "\\n");
  process.exit(code);
};
const labelOf = (plist) => {
  if (typeof plist !== "string" || !fs.existsSync(plist)) { console.error("fake launchctl: plist 不存在：" + plist); finish(2); }
  const match = fs.readFileSync(plist, "utf8").match(/<key>\\s*Label\\s*<\\/key>\\s*<string>([^<]*)<\\/string>/);
  // 与真实 launchd 一致：没有 Label、空 Label、含空白/控制字符的 Label 都不是合法服务。
  if (!match || !match[1] || /[\\s\\x00-\\x1f\\x7f]/.test(match[1])) { console.error("fake launchctl: plist 缺少有效 Label：" + plist); finish(2); }
  if (!state.known.includes(match[1])) state.known.push(match[1]);
  return match[1];
};
const [command, ...rest] = args;
if (command === "unload" && rest[0] === "-w" && rest.length === 2) {
  const label = labelOf(rest[1]);
  if (process.env.FAKE_LAUNCHD_UNLOAD_FAIL === "1") { console.error("fake launchctl: unload 失败（模拟）"); finish(1); }
  if (!process.env.FAKE_LAUNCHD_UNLOAD_IGNORED) state.loaded = state.loaded.filter((item) => item !== label);
  state.unverifiable = [];
  save(); finish(0);
}
if (command === "load" && rest[0] === "-w" && rest.length === 2) {
  const label = labelOf(rest[1]);
  if (process.env.FAKE_LAUNCHD_START_FAIL === "1") { console.error("fake launchctl: load 失败（模拟）"); finish(1); }
  state.loaded.push(label);
  if (process.env.FAKE_LAUNCHD_LOAD_UNVERIFIABLE) state.unverifiable.push(label);
  save(); finish(0);
}
if (command === "list" && rest.length === 1) {
  const label = rest[0];
  if (!state.known.includes(label)) { console.error('Could not find service "' + label + '"：label 与传入 plist 的 Label 不一致'); finish(113); }
  // FAKE_LAUNCHD_LOAD_UNVERIFIABLE=1：只让 load 后的第一次 list 查不到；=2：之后一直查不到（launchd 始终无法确认）。
  if (state.unverifiable.includes(label)) {
    if (process.env.FAKE_LAUNCHD_LOAD_UNVERIFIABLE !== "2") state.unverifiable = state.unverifiable.filter((item) => item !== label);
    finish(1);
  }
  finish(state.loaded.includes(label) ? 0 : 1);
}
console.error("fake launchctl: 不支持的调用 " + JSON.stringify(args)); finish(2);
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

/** 写一个最小 XML launchd plist；Label 是 launchctl 查找服务的唯一依据，与文件名无关。 */
async function writeLaunchdPlist(path, label) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/true</string>
  </array>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`);
}

/** 假 launchctl 收到的全部调用参数（按顺序）。 */
async function launchCalls(binaries) {
  return (await readLines(binaries.launchLog)).map((call) => call.args);
}

async function launchdState(binaries) {
  return JSON.parse(await readFile(binaries.launchState, "utf8"));
}

/**
 * 任何 list 都不得得到 113：113 表示 CLI 传的 label 既不是测试登记过的服务、也不是任何传入 plist 的 Label
 * （例如写死了默认标签）。使用前请确保合法 label 已通过 launchdLabels/knownLabels 登记或经 plist 登记。
 */
async function assertLaunchLabelsKnown(binaries) {
  for (const call of await readLines(binaries.launchLog)) {
    assert.notEqual(call.code, 113, `launchctl 收到了与 plist 不一致的 label：${JSON.stringify(call.args)}`);
  }
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

function cutoverArgs(oldInstance, newInstance, acceptance, output, binaries, plist) {
  return {
    old: ["cutover-old", "--instance-dir", oldInstance, "--acceptance", acceptance, "--output", output, "--plist", plist, "--launchctl", binaries.launchctl],
    new: ["cutover-new", "--instance-dir", newInstance, "--acceptance", acceptance, "--old-stopped", join(output, "old-stopped.json"), "--snapshot", join(output, "state"), "--systemctl", binaries.systemctl, "--chown", binaries.chown],
    rollbackNew: ["rollback-new", "--instance-dir", newInstance, "--output", join(dirname(output), "rollback"), "--systemctl", binaries.systemctl],
  };
}

function rollbackOldArgsFor(oldInstance, root, binaries, plist) {
  const rollbackOutput = join(root, "rollback");
  return ["rollback-old", "--instance-dir", oldInstance, "--windows-stopped", join(rollbackOutput, "windows-stopped.json"), "--snapshot", join(rollbackOutput, "state"), "--plist", plist, "--launchctl", binaries.launchctl];
}

/**
 * 准备一套完整的切换 fixture：旧/新实例、已通过的验收记录、假 systemctl/launchctl（旧端按 label 处于已加载），
 * 以及旧端 plist——文件名故意与 Label 无关，证明 CLI 只信 plist 内的 Label、不靠文件名或默认命名猜。
 */
async function prepareCutover(root, { label = "com.wecom-support-bot", plistName = "old.plist" } = {}) {
  const oldInstance = join(root, "old");
  const newInstance = join(root, "new");
  await makeInstance(oldInstance, { id: "old" });
  await makeInstance(newInstance, { id: "new" });
  const acceptance = join(root, "acceptance.json");
  await runCli(["acceptance-create", "--instance-dir", newInstance, "--output", acceptance]);
  await passAcceptance(acceptance);
  const binaries = await makeFakeServiceBinaries(root, { launchdLabels: [label] });
  const output = join(root, "cutover");
  const plist = join(root, plistName);
  await writeLaunchdPlist(plist, label);
  return { oldInstance, newInstance, acceptance, binaries, output, plist, label, args: cutoverArgs(oldInstance, newInstance, acceptance, output, binaries, plist) };
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
  // 内部回归题文档不进安装包；个人残留守卫随 CLI 一起打包，目标 Linux 的 build/verify 同样生效。
  assert.equal(manifest.files.some((entry) => entry.path === "docs/regression-questions.md"), false);
  assert.ok(manifest.files.some((entry) => entry.path === "scripts/personal-residue.js"));
  const verified = await runCli(["verify-package", "--package-dir", output]);
  assert.equal(verified.status, "ok");
  const defaults = await readFile(join(output, "config/default.json"), "utf8");
  assert.equal(defaults.includes("/Users/"), false);
  assert.deepEqual(JSON.parse(defaults).roots, {});
  assert.equal(typeof JSON.parse(defaults).surface.welcomeText, "string");
  assert.equal(findPersonalResidue(defaults), null, "包内 default.json（含 surface 话术）不得带个人称呼");

  await writeFile(join(output, "config/secrets.json"), '{"botId":"real-looking-secret"}\n');
  const extra = await runCli(["verify-package", "--package-dir", output], { allowFailure: true });
  assert.match(extra.error, /未登记内容/);
  await rm(join(output, "config/secrets.json"));
  await writeFile(join(output, "prompts/local-instance.md"), "tampered\n");
  const changed = await runCli(["verify-package", "--package-dir", output], { allowFailure: true });
  assert.match(changed.error, /校验失败/);
  // verify-package 自带个人残留扫描：即使清单哈希被重新签发、校验全部通过，带个人称呼的文件仍会被拒绝。
  // 目标 Linux 的 install.sh 只跑 verify-package，这道门不能只存在于 build-package。
  await writeFile(join(output, "prompts/local-instance.md"), `这条我没法直接确认，建议直接问${"\u864e\u8001\u5e08"}。\n`);
  const manifestPath = join(output, "windows-package.json");
  const reissued = JSON.parse(await readFile(manifestPath, "utf8"));
  reissued.files.find((entry) => entry.path === "prompts/local-instance.md").sha256 = sha256(await readFile(join(output, "prompts/local-instance.md")));
  await writeJson(manifestPath, reissued);
  const residue = await runCli(["verify-package", "--package-dir", output], { allowFailure: true });
  assert.equal(residue.status, "error");
  assert.match(residue.error, /安装包文件包含个人称呼/);
  assert.match(residue.error, /prompts\/local-instance\.md/);
});

/**
 * 从 install.ps1 按文本顺序提取 WSL 侧命令，兼容两种写法：
 *   Invoke-Native "wsl.exe" @("--distribution", $Distro, "--user", "root", "--", cmd...)
 *   & wsl.exe --distribution $Distro --user root -- cmd...
 * 返回 [{ index, args }]，args 是去掉 wsl.exe 前缀后的参数，保留 $变量 引用。
 */
function extractWslCommands(script) {
  const pattern = /"wsl\.exe"\s*@\(([^)]*)\)|&\s*wsl\.exe\s+--distribution\s+\$Distro\s+--user\s+root\s+--\s+([^|\r\n)]+)/g;
  const commands = [];
  for (const match of script.matchAll(pattern)) {
    const args = match[1]
      ? match[1].split(",").map((token) => token.trim().replace(/^"|"$/g, "")).filter(Boolean)
      : match[2].trim().split(/\s+/);
    const separator = args.indexOf("--");
    commands.push({ index: match.index, args: separator === -1 ? args : args.slice(separator + 1) });
  }
  return commands;
}

/** 读取 install.ps1 中 `$name = "..."` 的双引号字符串定义。 */
function psStringDefinition(script, name) {
  const match = script.match(new RegExp(`\\$${name}\\s*=\\s*"([^"\\r\\n]*)"`, "m"));
  assert.ok(match, `install.ps1 应定义 $${name}`);
  return match[1];
}

function expandPsVars(text, vars) {
  return text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => (vars[name] === undefined ? whole : vars[name]));
}

test("install.ps1 不会把 package.tar.gz 留在传给 install.sh --bundle 的目录里", async (t) => {
  const root = await makeTempDir(t);
  const script = await readFile(join(projectDir, "windows/install.ps1"), "utf8");
  const installSh = await readFile(join(projectDir, "windows/linux/install.sh"), "utf8");

  // install.sh 对 --bundle 目录执行 verify-package，任何未登记文件都会让安装失败。
  assert.match(installSh, /verify-package --package-dir "\$BUNDLE"/);
  // install.ps1 传给 install.sh 的 <package> 正是 $linuxPackage。
  assert.match(script, /\.Replace\("<package>", \$linuxPackage\)/);

  // 静态校验：压缩包副本定义在 $linuxPackage 之外，脚本中不存在 $linuxPackage/....tar.gz。
  const bundleDefinition = psStringDefinition(script, "linuxPackage");
  assert.match(bundleDefinition, /^\/tmp\/wecom-support-bot-\$token$/);
  const copyDefinition = psStringDefinition(script, "linuxArchiveCopy");
  assert.match(copyDefinition, /^\$linuxPackage[^/]/, "压缩包副本必须由 $linuxPackage 派生，且不能放在该目录内（同级路径）");
  assert.match(copyDefinition, /\.tar\.gz$/);
  assert.doesNotMatch(script, /\$linuxPackage\/[^\s"]*/);

  const commands = extractWslCommands(script);
  // 只看资源包解包这一段：从 $linuxPackage 定义处到 install.sh 调用处之前的命令，以及其后的 finally 清理。
  const packageBlockStart = script.indexOf("$linuxPackage = ");
  const installCall = script.indexOf("$installArgs = @($plan.wslCommands.installLinux");
  assert.ok(packageBlockStart > 0 && installCall > packageBlockStart, "install.ps1 应先准备 $linuxPackage 再调用 install.sh");
  const packageCommands = commands.filter((command) => command.index > packageBlockStart && command.args[0] !== "wslpath");
  const beforeInstall = packageCommands.filter((command) => command.index < installCall);
  const afterInstall = packageCommands.filter((command) => command.index > installCall);
  assert.ok(beforeInstall.length >= 5, `应提取到解包前的 WSL 命令：${JSON.stringify(beforeInstall)}`);
  const copiesArchive = ({ args }) => args[0] === "cp" || (args[0] === "tar" && args.includes("-xzf"));
  for (const { args } of beforeInstall.filter(copiesArchive)) {
    for (const token of args) assert.equal(token.startsWith("$linuxPackage/"), false, `压缩包不能落在 bundle 目录内：${args.join(" ")}`);
  }
  const tar = beforeInstall.find(({ args }) => args[0] === "tar");
  const copy = beforeInstall.find(({ args }) => args[0] === "cp");
  assert.deepEqual(tar?.args, ["tar", "-xzf", "$linuxArchiveCopy", "-C", "$linuxPackage"]);
  assert.equal(copy?.args.at(-1), "$linuxArchiveCopy");
  const removesCopy = ({ args }) => args[0] === "rm" && args[1] === "-f" && args[2] === "$linuxArchiveCopy";
  assert.ok(beforeInstall.some(removesCopy), "解包后应立即删除压缩包副本");
  assert.ok(afterInstall.some(removesCopy), "finally 兜底应删除压缩包副本");

  // 行为校验：用真实安装包按脚本顺序在本机重放 WSL 侧命令，再对 bundle 目录跑 verify-package。
  const packageDir = join(root, "package");
  await runCli(["build-package", "--output", packageDir]);
  const bundle = join(root, bundleDefinition.replace("/tmp/", "").replace("$token", "fixture"));
  const archive = join(root, "windows-side.tar.gz");
  await execFileAsync("tar", ["-czf", archive, "-C", packageDir, "."]);
  const vars = { Distro: "Ubuntu-24.04", linuxPackage: bundle, linuxArchiveCopy: expandPsVars(copyDefinition, { linuxPackage: bundle }), linuxArchive: archive, token: "fixture" };
  const replay = async ({ args }) => {
    const resolved = args.map((token) => expandPsVars(token, vars));
    for (const token of resolved) assert.equal(token.includes("$"), false, `变量未解析：${token}`);
    if (resolved[0] === "rm") {
      for (const target of resolved.slice(1)) if (!target.startsWith("-")) assert.ok(target.startsWith(root), `拒绝重放删除测试目录之外的路径：${target}`);
    }
    await execFileAsync(resolved[0], resolved.slice(1));
  };
  for (const command of beforeInstall) await replay(command);
  assert.equal(existsSync(bundle), true);
  assert.equal((await readdir(bundle)).some((name) => name.endsWith(".tar.gz")), false, "bundle 目录内不得残留压缩包");
  assert.equal(existsSync(vars.linuxArchiveCopy), false, "解包后压缩包副本应已删除");
  const verifiedBundle = await runCli(["verify-package", "--package-dir", bundle]);
  assert.equal(verifiedBundle.status, "ok", "传给 install.sh 的 bundle 目录必须能通过 verify-package");
  assert.equal(verifiedBundle.packageDir, bundle);
  assert.equal(verifiedBundle.files, JSON.parse(await readFile(join(bundle, "windows-package.json"), "utf8")).files.length);
  for (const command of afterInstall) await replay(command);
  assert.equal(existsSync(vars.linuxArchiveCopy), false);
});

test("verify-package 拒绝 bundle 目录里残留的 package.tar.gz（旧安装器的必败路径）", async (t) => {
  const root = await makeTempDir(t);
  const packageDir = join(root, "package");
  await runCli(["build-package", "--output", packageDir]);
  const archive = join(root, "package.tar.gz");
  await execFileAsync("tar", ["-czf", archive, "-C", packageDir, "."]);
  await cp(archive, join(packageDir, "package.tar.gz"));
  const rejected = await runCli(["verify-package", "--package-dir", packageDir], { allowFailure: true });
  assert.equal(rejected.status, "error");
  assert.match(rejected.error, /安装包包含未登记内容：package\.tar\.gz/);
  await rm(join(packageDir, "package.tar.gz"));
  assert.equal((await runCli(["verify-package", "--package-dir", packageDir])).status, "ok");
});

test("build-package 拒绝带个人残留的源文件（含 surface 话术）并指出文件与修复方式", async (t) => {
  const root = await makeTempDir(t);
  // 先用真实项目打出一份标准包，再把它当作源目录：标准包本身就是合法的 build-package 输入。
  const source = join(root, "source");
  await runCli(["build-package", "--output", source]);
  const defaultsPath = join(source, "config/default.json");
  const defaults = JSON.parse(await readFile(defaultsPath, "utf8"));
  defaults.surface.fallbackText = `这条我没法直接确认，建议直接问${"\u864e\u8001\u5e08"}。`;
  await writeFile(defaultsPath, JSON.stringify(defaults, null, 2));
  const output = join(root, "package");
  const rejected = await runCli(["build-package", "--source-dir", source, "--output", output], { allowFailure: true });
  assert.equal(rejected.status, "error");
  assert.match(rejected.error, /config\/default\.json/);
  assert.match(rejected.error, /个人称呼/);
  assert.match(rejected.error, /技术同事/);
  assert.equal(existsSync(output), false, "拒绝时不得留下半成品安装包");

  defaults.surface.fallbackText = "这条涉及生产数据，我没法直接确认。建议直接问技术同事。";
  await writeFile(defaultsPath, JSON.stringify(defaults, null, 2));
  const built = await runCli(["build-package", "--source-dir", source, "--output", output]);
  assert.equal(built.status, "ok");
  const packaged = await readFile(join(output, "config/default.json"), "utf8");
  assert.equal(findPersonalResidue(packaged), null);
  assert.match(packaged, /技术同事/);
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
  const routed = await runCli(["validate-model-url", "--url", MODEL_URL]);
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
  const plist = join(root, "old.plist");
  await writeLaunchdPlist(plist, "com.wecom-support-bot");
  const oldArgs = ["cutover-old", "--instance-dir", oldInstance, "--acceptance", record, "--output", join(root, "cutover"), "--plist", plist, "--launchctl", binaries.launchctl];
  const dry = await runCli(oldArgs);
  assert.equal(dry.executes, false);
  await rm(join(root, "evidence/wecom-text/group-chat.json"));
  const tampered = await runCli(oldArgs, { allowFailure: true });
  assert.match(tampered.error, /证据|结果|不存在/);
  assert.deepEqual(await launchCalls(binaries), []);
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
  // windows-instance.js 依赖同目录的个人残留守卫模块，隔离副本需一并带上。
  await writeFile(join(isolated, "scripts/personal-residue.js"), await readFile(join(projectDir, "scripts/personal-residue.js"), "utf8"));
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
  const DEFAULT_LABEL = "com.wecom-support-bot";
  const { oldInstance, newInstance, acceptance, binaries, output, plist, args } = await prepareCutover(root);
  await writeFile(join(oldInstance, "data/inbox.jsonl"), JSON.stringify({ msgid: "old-message", question: "旧端最后问题", userId: "u-old", receivedAt: "2026-11-05T00:00:00.000Z", state: "received" }) + "\n");
  await writeFile(join(oldInstance, "workspace/old-task.md"), "old\n");
  await writeFile(join(newInstance, "data/inbox.jsonl"), JSON.stringify({ msgid: "test-only-message", question: "测试机器人问题", userId: "u-test", receivedAt: "2026-11-04T23:00:00.000Z", state: "received" }) + "\n");

  // 不传 --plist 时默认路径仍是通用命名；该路径不存在时 dry-run 直接失败（plist 缺失就没有可信 Label），
  // 不会带着固定标签走到 execute 才发现查错服务。
  const missingDefault = await runCli(["cutover-old", "--instance-dir", oldInstance, "--acceptance", acceptance, "--output", output], { allowFailure: true });
  assert.equal(missingDefault.status, "error");
  assert.match(missingDefault.error, /无法读取旧端 launchd plist/);
  assert.match(missingDefault.error, /launchd\/com\.wecom-support-bot\.plist/);
  assert.deepEqual(await launchCalls(binaries), []);

  const dryOld = await runCli(args.old);
  assert.equal(dryOld.executes, false);
  assert.equal(dryOld.steps[0], `${binaries.launchctl} unload -w ${plist}`);
  assert.deepEqual(dryOld.launchd, { plist, label: DEFAULT_LABEL });
  assert.deepEqual(await launchCalls(binaries), []);
  const stopped = await runCli([...args.old, "--execute", "--confirm", "STOP_OLD_PRODUCTION"]);
  assert.equal(stopped.status, "old-stopped-new-not-started");
  assert.equal(stopped.attestation.launchdLabel, DEFAULT_LABEL);
  assert.deepEqual(await launchCalls(binaries), [["list", DEFAULT_LABEL], ["unload", "-w", plist], ["list", DEFAULT_LABEL]]);
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
  assert.deepEqual((await launchCalls(binaries)).map((entry) => entry[0]), ["list", "unload", "list"]);
  assert.equal(JSON.parse(await readFile(join(newInstance, "wecom.json"), "utf8")).active, "production");
  assert.equal(await readFile(join(newInstance, "workspace/old-task.md"), "utf8"), "old\n");
  assert.doesNotMatch(await readFile(join(newInstance, "data/inbox.jsonl"), "utf8"), /test-only-message/);
  assert.match(await readFile(join(active.record.testRuntimeArchive, "data/inbox.jsonl"), "utf8"), /test-only-message/);

  await writeFile(join(newInstance, "workspace/windows-task.md"), "created-on-windows\n");
  await writeFile(join(newInstance, "data/inbox.jsonl"), (await readFile(join(newInstance, "data/inbox.jsonl"), "utf8")) + JSON.stringify({ msgid: "windows-message", question: "Windows 新问题", userId: "u-new", receivedAt: "2026-11-05T01:00:00.000Z", state: "received" }) + "\n");
  const rollbackOutput = join(root, "rollback");
  const rollbackNewArgs = args.rollbackNew;
  const dryRollback = await runCli(rollbackNewArgs);
  assert.equal(dryRollback.executes, false);
  const windowsStopped = await runCli([...rollbackNewArgs, "--execute", "--confirm", "STOP_WINDOWS_PRODUCTION"]);
  assert.equal(windowsStopped.status, "windows-stopped-old-not-started");
  assert.equal(JSON.parse(await readFile(join(newInstance, "wecom.json"), "utf8")).active, "none");
  const rollbackOldArgs = rollbackOldArgsFor(oldInstance, root, binaries, plist);
  const dryRestore = await runCli(rollbackOldArgs);
  assert.equal(dryRestore.executes, false);
  assert.deepEqual(dryRestore.launchd, { plist, label: DEFAULT_LABEL });
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
  assert.deepEqual((await launchCalls(binaries)).map((entry) => entry[0]), ["list", "unload", "list"]);
  const restored = await runCli([...rollbackOldArgs, "--execute", "--confirm", "RESTORE_OLD_PRODUCTION"]);
  assert.equal(restored.status, "old-active-windows-stopped");
  assert.deepEqual(restored.launchd, { plist, label: DEFAULT_LABEL });
  assert.equal(await readFile(join(oldInstance, "workspace/windows-task.md"), "utf8"), "created-on-windows\n");
  assert.match(await readFile(join(oldInstance, "data/inbox.jsonl"), "utf8"), /windows-message/);
  // 合并前再次停用：list → unload -w → list；恢复：load -w → list。全部按 plist 的真实 Label。
  assert.deepEqual((await launchCalls(binaries)).slice(-5), [["list", DEFAULT_LABEL], ["unload", "-w", plist], ["list", DEFAULT_LABEL], ["load", "-w", plist], ["list", DEFAULT_LABEL]]);
  assert.deepEqual((await readLines(binaries.launchLog)).slice(-5).map((call) => call.code), [1, 0, 1, 0, 0]);
  assert.equal(JSON.parse(await readFile(binaries.systemState), "utf8").active, false);
  assert.deepEqual((await launchdState(binaries)).loaded, [DEFAULT_LABEL]);
  await assertLaunchLabelsKnown(binaries);
});

test("新端正式启用失败时改回 none 并停用，不自动拉起旧端", async (t) => {
  const root = await makeTempDir(t);
  const { newInstance, binaries, args } = await prepareCutover(root);
  await runCli([...args.old, "--execute", "--confirm", "STOP_OLD_PRODUCTION"]);
  const failed = await runCli([...args.new, "--execute", "--confirm", "ACTIVATE_NEW_PRODUCTION"], { allowFailure: true, env: { ...process.env, FAKE_SYSTEMD_START_FAIL: "1" } });
  assert.match(failed.error, /已安全停用新端且未重启旧端/);
  assert.equal(JSON.parse(await readFile(join(newInstance, "wecom.json"), "utf8")).active, "none");
  assert.equal(JSON.parse(await readFile(binaries.systemState), "utf8").active, false);
  assert.equal(JSON.parse(await readFile(binaries.systemState), "utf8").enabled, false);
  assert.deepEqual((await launchdState(binaries)).loaded, []);
  assert.deepEqual((await launchCalls(binaries)).map((entry) => entry[0]), ["list", "unload", "list"]);
  await assertLaunchLabelsKnown(binaries);
});

test("旧 Mac 自定义 Label 的历史 plist：cutover-old / rollback-old 全程按 plist 内真实 Label 查卸载，传错 label 会被假 launchctl 拒绝", async (t) => {
  const root = await makeTempDir(t);
  // 历史 plist：文件名与默认命名完全无关，Label 是当年自定义的；旧服务正以这个 Label 运行。
  const CUSTOM_LABEL = "com.example.legacy-support-bot";
  const { oldInstance, newInstance, binaries, plist, args } = await prepareCutover(root, { label: CUSTOM_LABEL, plistName: "historic-agent.plist" });
  await writeFile(join(oldInstance, "workspace/old-task.md"), "old\n");

  // 先证明假 launchctl 自身足够严格：写死的默认标签会得到 113（Could not find service），
  // plist 不存在 / 没有 Label / 空 Label 的 load、unload 直接失败。否则下面的断言没有说服力。
  const exitCode = (promise) => promise.then(() => 0, (error) => error.code);
  assert.equal(await exitCode(execFileAsync(binaries.launchctl, ["list", "com.wecom-support-bot"])), 113);
  assert.equal(await exitCode(execFileAsync(binaries.launchctl, ["list", CUSTOM_LABEL])), 0);
  assert.notEqual(await exitCode(execFileAsync(binaries.launchctl, ["unload", "-w", join(root, "missing.plist")])), 0);
  await writeFile(join(root, "no-label.plist"), '<plist version="1.0"><dict><key>ProgramArguments</key><array/></dict></plist>\n');
  assert.notEqual(await exitCode(execFileAsync(binaries.launchctl, ["load", "-w", join(root, "no-label.plist")])), 0);
  await writeLaunchdPlist(join(root, "empty-label.plist"), "");
  assert.notEqual(await exitCode(execFileAsync(binaries.launchctl, ["load", "-w", join(root, "empty-label.plist")])), 0);
  assert.deepEqual((await launchdState(binaries)).loaded, [CUSTOM_LABEL], "被拒绝的调用不得改变已加载状态");
  await rm(binaries.launchLog);

  const dryOld = await runCli(args.old);
  assert.equal(dryOld.executes, false);
  assert.deepEqual(dryOld.launchd, { plist, label: CUSTOM_LABEL }, "dry-run 必须公开将要操作的 plist 与其真实 Label");
  assert.deepEqual(await launchCalls(binaries), []);
  const stopped = await runCli([...args.old, "--execute", "--confirm", "STOP_OLD_PRODUCTION"]);
  assert.equal(stopped.status, "old-stopped-new-not-started");
  assert.equal(stopped.attestation.launchdLabel, CUSTOM_LABEL);
  assert.deepEqual(await launchCalls(binaries), [["list", CUSTOM_LABEL], ["unload", "-w", plist], ["list", CUSTOM_LABEL]]);
  assert.deepEqual((await launchdState(binaries)).loaded, [], "旧服务按真实 Label 停用");

  const active = await runCli([...args.new, "--execute", "--confirm", "ACTIVATE_NEW_PRODUCTION"]);
  assert.equal(active.status, "new-active-old-stopped");
  const windowsStopped = await runCli([...args.rollbackNew, "--execute", "--confirm", "STOP_WINDOWS_PRODUCTION"]);
  assert.equal(windowsStopped.status, "windows-stopped-old-not-started");

  const rollbackOldArgs = rollbackOldArgsFor(oldInstance, root, binaries, plist);
  const dryRestore = await runCli(rollbackOldArgs);
  assert.equal(dryRestore.executes, false);
  assert.deepEqual(dryRestore.launchd, { plist, label: CUSTOM_LABEL });
  const restored = await runCli([...rollbackOldArgs, "--execute", "--confirm", "RESTORE_OLD_PRODUCTION"]);
  assert.equal(restored.status, "old-active-windows-stopped");
  assert.deepEqual(restored.launchd, { plist, label: CUSTOM_LABEL });
  assert.equal(JSON.parse(await readFile(join(oldInstance, "wecom.json"), "utf8")).active, "production");
  assert.deepEqual((await launchCalls(binaries)).slice(-5), [["list", CUSTOM_LABEL], ["unload", "-w", plist], ["list", CUSTOM_LABEL], ["load", "-w", plist], ["list", CUSTOM_LABEL]]);
  assert.deepEqual((await readLines(binaries.launchLog)).slice(-5).map((call) => call.code), [1, 0, 1, 0, 0]);
  assert.deepEqual((await launchdState(binaries)).loaded, [CUSTOM_LABEL]);
  assert.equal(JSON.stringify(await launchCalls(binaries)).includes("com.wecom-support-bot"), false, "默认标签从未出现：每次 launchctl list 都用 plist 的真实 Label");
  await assertLaunchLabelsKnown(binaries);
});

test("旧端 plist 无效（缺失 / 无 Label / 空 Label / 含空白 / 二进制）时 dry-run 直接失败，绝不回退到固定标签", async (t) => {
  const root = await makeTempDir(t);
  const oldInstance = join(root, "old");
  await makeInstance(oldInstance, { id: "old" });
  const binaries = await makeFakeServiceBinaries(root, { launchdLabels: [] });
  const windowsStopped = join(root, "windows-stopped.json");
  const attestation = { format: "wecom-support-bot-endpoint-stopped", formatVersion: 1, endpoint: "windows", verifiedStopped: true, autoRestartDisabled: true, productionBotFingerprint: sha256("production-bot"), snapshotManifestSha256: "a".repeat(64) };
  await writeJson(windowsStopped, attestation);
  const rollbackOld = (plist) => ["rollback-old", "--instance-dir", oldInstance, "--windows-stopped", windowsStopped, "--snapshot", join(root, "snapshot"), "--launchctl", binaries.launchctl, ...(plist ? ["--plist", plist] : [])];
  const writePlist = async (name, contents) => {
    const path = join(root, name);
    await writeFile(path, contents);
    return path;
  };
  await writePlist("no-label.plist", '<plist version="1.0"><dict><key>ProgramArguments</key><array/></dict></plist>\n');
  await writePlist("empty-label.plist", '<plist version="1.0"><dict><key>Label</key><string></string></dict></plist>\n');
  await writePlist("space-label.plist", '<plist version="1.0"><dict><key>Label</key><string>com.example .bot</string></dict></plist>\n');
  await writePlist("newline-label.plist", '<plist version="1.0"><dict><key>Label</key><string>\n  com.example.formatted\n</string></dict></plist>\n');
  await writePlist("binary.plist", "bplist00\u0000\u0001\u0002");
  for (const [plist, pattern] of [
    [join(root, "missing.plist"), /无法读取旧端 launchd plist/],
    [join(root, "no-label.plist"), /缺少有效 Label/],
    [join(root, "empty-label.plist"), /缺少有效 Label/],
    [join(root, "space-label.plist"), /缺少有效 Label/],
    // launchd 原样读取 <string> 内容：值里夹换行的标签不是合法服务名，不能靠 trim 猜。
    [join(root, "newline-label.plist"), /缺少有效 Label/],
    [join(root, "binary.plist"), /二进制格式/],
    // 不传 --plist 时默认路径同样是通用命名；文件不存在就在计划阶段失败。
    [null, /无法读取旧端 launchd plist.*launchd\/com\.wecom-support-bot\.plist/],
  ]) {
    const rejected = await runCli(rollbackOld(plist), { allowFailure: true });
    assert.equal(rejected.status, "error", JSON.stringify(plist));
    assert.match(rejected.error, pattern, JSON.stringify(plist));
  }
  assert.deepEqual(await launchCalls(binaries), [], "无效 plist 不得触达 launchctl");

  // 合法 plist：标签之间有换行缩进、前面有注释与其他键，仍能解析出真实 Label 并在 dry-run 公开。
  const snapshot = join(root, "snapshot");
  const exported = await runCli(["state-export", "--instance-dir", oldInstance, "--output", snapshot, "--execute", "--source-stopped", "--confirm", "EXPORT_STATE"]);
  await writeJson(windowsStopped, { ...attestation, snapshotManifestSha256: exported.manifestSha256 });
  const formatted = await writePlist("formatted.plist", '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <!-- 历史文件：标签之间换行缩进 -->\n  <key>KeepAlive</key>\n  <true/>\n  <key>\n    Label\n  </key>\n  <string>com.example.formatted</string>\n</dict>\n</plist>\n');
  const plan = await runCli(rollbackOld(formatted));
  assert.equal(plan.executes, false);
  assert.deepEqual(plan.launchd, { plist: formatted, label: "com.example.formatted" });
  assert.deepEqual(await launchCalls(binaries), []);
});

test("旧端 unload 报错时：已停用的旧 Mac 仍可回滚（以最终 list 为准），仍在运行的旧端则停在这里、不合并不 load", async (t) => {
  const root = await makeTempDir(t);
  const oldInstance = join(root, "old");
  await makeInstance(oldInstance, { id: "old" });
  const LABEL = "com.example.formatted";
  // launchd 认识这个服务（cutover-old 时加载过），但现在没在运行。
  const binaries = await makeFakeServiceBinaries(root, { launchdLabels: [], knownLabels: [LABEL] });
  const plist = join(root, "old.plist");
  await writeLaunchdPlist(plist, LABEL);
  // rollbackOldArgsFor 约定回滚包在 <root>/rollback 下：state/ 是 Windows 导出的状态包，windows-stopped.json 是停用证明。
  const rollbackOutput = join(root, "rollback");
  const snapshot = join(rollbackOutput, "state");
  const exported = await runCli(["state-export", "--instance-dir", oldInstance, "--output", snapshot, "--execute", "--source-stopped", "--confirm", "EXPORT_STATE"]);
  const windowsStopped = join(rollbackOutput, "windows-stopped.json");
  await writeJson(windowsStopped, { format: "wecom-support-bot-endpoint-stopped", formatVersion: 1, endpoint: "windows", verifiedStopped: true, autoRestartDisabled: true, productionBotFingerprint: sha256("production-bot"), snapshotManifestSha256: exported.manifestSha256 });
  const rollbackOld = () => [...rollbackOldArgsFor(oldInstance, root, binaries, plist), "--execute", "--confirm", "RESTORE_OLD_PRODUCTION"];
  const unloadFails = { ...process.env, FAKE_LAUNCHD_UNLOAD_FAIL: "1" };

  // 旧端早已停用（cutover-old 之后）：unload 再报错也不该挡住回滚，最终 list 确认不存在即可放行。
  const restored = await runCli(rollbackOld(), { env: unloadFails });
  assert.equal(restored.status, "old-active-windows-stopped");
  assert.deepEqual((await readLines(binaries.launchLog)).slice(-5).map((call) => call.code), [1, 1, 1, 0, 0]);
  assert.deepEqual((await launchdState(binaries)).loaded, [LABEL]);
  await assertLaunchLabelsKnown(binaries);

  // 旧端仍在运行：unload 报错必须原样上抛——不合并状态、不改 active、不 load，也不会报成已停。
  await rm(binaries.launchLog);
  await writeJson(binaries.launchState, { loaded: [LABEL], known: [LABEL], unverifiable: [] });
  await writeJson(join(oldInstance, "wecom.json"), { ...JSON.parse(await readFile(join(oldInstance, "wecom.json"), "utf8")), active: "test" });
  const refused = await runCli(rollbackOld(), { allowFailure: true, env: unloadFails });
  assert.equal(refused.status, "error");
  assert.match(refused.error, /fake launchctl: unload 失败（模拟）/);
  assert.deepEqual(await launchCalls(binaries), [["list", LABEL], ["unload", "-w", plist]]);
  assert.equal(JSON.parse(await readFile(join(oldInstance, "wecom.json"), "utf8")).active, "test", "停用失败前不得改 active");
  assert.deepEqual((await launchdState(binaries)).loaded, [LABEL]);
});

test("rollback-old 恢复失败时按真实 Label 重新 unload：确认停掉才说双端停止，服务卡住则如实报告", async (t) => {
  const root = await makeTempDir(t);
  const CUSTOM_LABEL = "com.example.legacy-support-bot";
  const { oldInstance, binaries, plist, args } = await prepareCutover(root, { label: CUSTOM_LABEL, plistName: "historic-agent.plist" });
  await runCli([...args.old, "--execute", "--confirm", "STOP_OLD_PRODUCTION"]);
  await runCli([...args.new, "--execute", "--confirm", "ACTIVATE_NEW_PRODUCTION"]);
  await runCli([...args.rollbackNew, "--execute", "--confirm", "STOP_WINDOWS_PRODUCTION"]);
  const rollbackOldArgs = rollbackOldArgsFor(oldInstance, root, binaries, plist);
  const restore = (env) => runCli([...rollbackOldArgs, "--execute", "--confirm", "RESTORE_OLD_PRODUCTION"], { allowFailure: true, env: { ...process.env, ...env } });

  // 场景 1：load 成功但随后 list 查不到（恢复后验证失败）。旧服务此时可能真的在跑，
  // 清理必须按真实 plist 重新 unload；确认停掉后才允许说“已保持双端停止”。
  const unverifiable = await restore({ FAKE_LAUNCHD_LOAD_UNVERIFIABLE: "1" });
  assert.equal(unverifiable.status, "error");
  assert.match(unverifiable.error, new RegExp(`launchd 服务 ${CUSTOM_LABEL} 恢复后未通过 list 验证`));
  assert.match(unverifiable.error, /已保持双端停止/);
  assert.equal(JSON.parse(await readFile(join(oldInstance, "wecom.json"), "utf8")).active, "none");
  assert.deepEqual((await launchdState(binaries)).loaded, [], "清理已按真实 Label unload");
  assert.deepEqual((await launchCalls(binaries)).slice(-8), [
    ["list", CUSTOM_LABEL], ["unload", "-w", plist], ["list", CUSTOM_LABEL],
    ["load", "-w", plist],
    ["list", CUSTOM_LABEL],
    ["list", CUSTOM_LABEL], ["unload", "-w", plist], ["list", CUSTOM_LABEL],
  ]);
  assert.deepEqual((await readLines(binaries.launchLog)).slice(-8).map((call) => call.code), [1, 0, 1, 0, 1, 0, 0, 1]);
  await assertLaunchLabelsKnown(binaries);

  // 场景 1b：launchd 始终无法通过 list 确认这个服务。清理不能因为“list 查不到”就跳过 unload
  // （旧逻辑正是这样漏掉了仍在运行的旧服务）：必须照常 unload 真实 plist，把服务从 launchd 撤掉。
  const neverListable = await restore({ FAKE_LAUNCHD_LOAD_UNVERIFIABLE: "2" });
  assert.equal(neverListable.status, "error");
  assert.match(neverListable.error, /已保持双端停止/);
  assert.deepEqual((await launchdState(binaries)).loaded, [], "list 永远查不到时仍必须 unload 真实 plist");
  assert.deepEqual((await launchCalls(binaries)).slice(-8), [
    ["list", CUSTOM_LABEL], ["unload", "-w", plist], ["list", CUSTOM_LABEL],
    ["load", "-w", plist],
    ["list", CUSTOM_LABEL],
    ["list", CUSTOM_LABEL], ["unload", "-w", plist], ["list", CUSTOM_LABEL],
  ]);
  assert.deepEqual((await readLines(binaries.launchLog)).slice(-8).map((call) => call.code), [1, 0, 1, 0, 1, 1, 0, 1], "load 后与清理时的 list 始终查不到（113 以外），unload 仍被执行");
  await assertLaunchLabelsKnown(binaries);

  // 场景 2：清理时 unload 不生效（服务卡住）。不得再谎称“双端停止”，必须如实报告仍在运行，
  // 并给出按真实 plist 与真实 Label 手动处理的命令。
  const stuck = await restore({ FAKE_LAUNCHD_LOAD_UNVERIFIABLE: "1", FAKE_LAUNCHD_UNLOAD_IGNORED: "1" });
  assert.equal(stuck.status, "error");
  assert.match(stuck.error, /仍未能停止/);
  assert.doesNotMatch(stuck.error, /已保持双端停止/);
  assert.ok(stuck.error.includes(`${binaries.launchctl} unload -w ${plist}`), stuck.error);
  assert.ok(stuck.error.includes(`${binaries.launchctl} list ${CUSTOM_LABEL}`), stuck.error);
  assert.equal(JSON.parse(await readFile(join(oldInstance, "wecom.json"), "utf8")).active, "none");
  assert.deepEqual((await launchdState(binaries)).loaded, [CUSTOM_LABEL]);
  assert.deepEqual((await launchCalls(binaries)).slice(-3), [["list", CUSTOM_LABEL], ["unload", "-w", plist], ["list", CUSTOM_LABEL]]);
  await assertLaunchLabelsKnown(binaries);
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
    ["init", "--template", "team", "--source", "https://example.invalid/shared.git", "--scope", "shared", "--base-url", MODEL_URL, "--api-key", "test-only-key", "--model", "main-model"],
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

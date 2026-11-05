import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CADENCE_KINDS, isDue, nextDueAt, normalizeCadence } from "../src/sync-plan.js";

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

async function runCliFailure(args, options = {}) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: projectDir,
    ...options,
  }).then(
    () => ({ failed: false, stderr: "" }),
    (error) => ({ failed: true, stderr: String(error.stderr ?? error.message) }),
  );
  assert.equal(result.failed, true, "命令应当失败");
  return result.stderr;
}

async function makeTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "wsb-sync-plan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startModelServer() {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: "local-completion",
          object: "chat.completion",
          created: 0,
          model: "main-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 用公开 init 建临时实例；pi 指向不存在的路径，功能检查会明确失败但不影响实例与来源。 */
async function createInstanceWithSources(t, names) {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const sources = {};
  const instanceDir = join(root, "instance");
  const args = ["init", "--instance-dir", instanceDir];
  for (const name of names) {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "note.md"), `${name}\n`);
    sources[name] = dir;
    args.push("--source", dir, "--scope", "shared");
  }
  args.push("--base-url", models.baseUrl, "--api-key", "test-key", "--model", "main-model");
  const initialized = await runCli(args, {
    allowFailure: true,
    env: { ...process.env, WECOM_BOT_PI_BINARY: join(root, "missing-pi") },
  });
  assert.equal(initialized.checks.contextSources.length, names.length);
  assert.equal(initialized.checks.contextSources.every((source) => source.status === "ok"), true);
  return { root, instanceDir, sources, version: initialized.resources.version };
}

async function createInstance(t) {
  const { root, instanceDir, sources, version } = await createInstanceWithSources(t, ["source-a", "source-b"]);
  return { root, instanceDir, sourceA: sources["source-a"], sourceB: sources["source-b"], version };
}

function localIso(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

function planArgs(instanceDir, sourceA, cadence) {
  return ["plan", "--instance-dir", instanceDir, "--source", sourceA, "--scope", "shared", ...cadence];
}

test("plan 拒绝未校验来源与非法频率参数", async (t) => {
  const { root, instanceDir, sourceA } = await createInstance(t);

  assert.match(await runCliFailure(["plan", "--instance-dir", instanceDir, "--source", join(root, "unknown"), "--cadence", "daily"]), /未登记/);
  assert.match(await runCliFailure(planArgs(instanceDir, sourceA, ["--cadence", "每天"])), /不支持的频率/);
  assert.match(await runCliFailure(planArgs(instanceDir, sourceA, ["--cadence", "weekly", "--weekdays", "8"])), /星期/);
  assert.match(await runCliFailure(planArgs(instanceDir, sourceA, ["--cadence", "every"])), /正整数分钟间隔/);
  assert.match(await runCliFailure(planArgs(instanceDir, sourceA, ["--cadence", "hourly", "--every-minutes", "30"])), /hourly/);
  assert.match(await runCliFailure(planArgs(instanceDir, sourceA, ["--cadence", "daily", "--at", "25:00"])), /HH:MM/);
  assert.match(await runCliFailure(planArgs(instanceDir, sourceA, ["--cadence", "every", "--every-minutes", "120", "--at", "10:00"])), /不接受 --at/);
  assert.match(await runCliFailure(["plan", "--instance-dir", instanceDir, "--source", sourceA, "--at", "10:00"]), /需要与 --cadence/);
  assert.match(await runCliFailure(["plan", "--instance-dir", instanceDir, "--source", sourceA, "--weekdays", "1-5"]), /需要与 --cadence/);
  assert.match(await runCliFailure(["plan", "--instance-dir", instanceDir, "--source", sourceA, "--clear-excludes", "--exclude", "x/**"]), /不能同时使用/);
  assert.match(await runCliFailure(["plan", "--instance-dir", instanceDir, "--scope", "shared"]), /需要 --source/);
});

test("plan 首次运行补齐全部来源为 manual，之后可逐项更新", async (t) => {
  const { instanceDir, sourceA, sourceB } = await createInstance(t);

  const auto = await runCli(["plan", "--instance-dir", instanceDir]);
  assert.equal(auto.sources.length, 2);
  assert.deepEqual(auto.sources.map((source) => source.name), ["source-a", "source-b"]);
  assert.deepEqual(auto.sources.map((source) => source.cadence), [{ kind: "manual" }, { kind: "manual" }]);
  assert.deepEqual(auto.unplanned, []);

  const plannedA = await runCli(planArgs(instanceDir, sourceA, ["--cadence", "daily", "--at", "09:00"]));
  assert.equal(plannedA.updated, "source-a");
  assert.equal(plannedA.sources.length, 2);
  assert.deepEqual(plannedA.sources[0].cadence, { kind: "daily", at: "09:00" });
  assert.equal(plannedA.sources[0].cadenceText, "每天 09:00");
  assert.equal(plannedA.sources[0].due, true);
  assert.equal(plannedA.sources[0].nextDueAt, plannedA.checkedAt);
  assert.deepEqual(plannedA.unplanned, []);

  const plannedB = await runCli(planArgs(instanceDir, sourceB, ["--cadence", "manual"]));
  assert.deepEqual(plannedB.unplanned, []);
  assert.equal(plannedB.sources[1].cadenceText, "手动");
  assert.equal(plannedB.sources[1].nextDueAt, null);

  const view = await runCli(["plan", "--instance-dir", instanceDir]);
  assert.equal(view.sources.length, 2);
  assert.ok(view.nextSyncAt);

  const status = await runCli(["status", "--instance-dir", instanceDir]);
  assert.equal(status.syncPlan.sources.length, 2);
  assert.equal(status.syncPlan.sources[0].name, "source-a");
  assert.ok(status.syncPlan.nextSyncAt);
  assert.equal(status.coverage.sources[0].lastRunAt, null);
  assert.equal(status.coverage.sources[0].lastSyncStatus, null);
});

test("sync-due dry-run 不写盘，到期时整包同步且不丢未登记来源", async (t) => {
  const { instanceDir, sourceA, sourceB } = await createInstanceWithSources(t, ["source-a", "source-b", "source-c"]).then(
    ({ instanceDir, sources }) => ({ instanceDir, sourceA: sources["source-a"], sourceB: sources["source-b"], sourceC: sources["source-c"] }),
  );
  await runCli(planArgs(instanceDir, sourceA, ["--cadence", "every", "--every-minutes", "1"]));

  const before = await readFile(join(instanceDir, "instance.json"), "utf8");
  const dryRunAt = localIso(2026, 11, 5, 10, 0);
  const dryRun = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", dryRunAt, "--dry-run"]);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.ran, false);
  assert.deepEqual(dryRun.due, ["source-a"]);
  assert.equal(await readFile(join(instanceDir, "instance.json"), "utf8"), before);
  assert.equal(existsSync(join(instanceDir, "data/sync.lock")), false);

  const first = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", dryRunAt]);
  assert.equal(first.ran, true);
  assert.equal(first.status, "ok");
  assert.deepEqual(first.due, ["source-a"]);
  assert.deepEqual(first.removed, []);
  // 未登记来源（source-b / source-c）按 manual 处理，但整包同步仍保留它们的副本。
  assert.equal(await readFile(join(instanceDir, "context/001-source-a/note.md"), "utf8"), "source-a\n");
  assert.equal(await readFile(join(instanceDir, "context/002-source-b/note.md"), "utf8"), "source-b\n");
  assert.equal(await readFile(join(instanceDir, "context/003-source-c/note.md"), "utf8"), "source-c\n");
  assert.equal(first.contextSources.length, 3);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(saved.contextSources.length, 3);
  assert.equal(saved.syncPlan.sources[0].lastRunAt, dryRunAt);
  assert.equal(saved.syncPlan.sources[0].lastStatus, "ok");
  assert.equal(saved.syncPlan.sources[1].lastRunAt, dryRunAt);
  assert.equal(saved.syncPlan.sources[1].cadence.kind, "manual");
  // 未登记来源的原始路径只进 data/source-registry.json，不落进 instance.json。
  assert.equal("path" in saved.syncPlan.sources[1], false);
  assert.equal("type" in saved.syncPlan.sources[1], false);
  assert.equal(JSON.stringify(saved).includes(sourceB), false);

  await writeFile(join(sourceB, "note.md"), "B2\n");
  const second = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 2)]);
  assert.equal(second.ran, true);
  assert.deepEqual(second.due, ["source-a"]);
  assert.equal(await readFile(join(instanceDir, "context/002-source-b/note.md"), "utf8"), "B2\n");

  const sameTime = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 2)]);
  assert.equal(sameTime.ran, false);
  assert.deepEqual(sameTime.due, []);
});

test("disabled 才移除副本并在输出列出，重新启用后回到原槽位", async (t) => {
  const { instanceDir, sources } = await createInstanceWithSources(t, ["source-a", "source-b", "source-c"]);
  await runCli(planArgs(instanceDir, sources["source-a"], ["--cadence", "daily", "--at", "09:00"]));

  const first = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 0)]);
  assert.equal(first.status, "ok");
  assert.deepEqual(first.removed, []);

  const disabled = await runCli(["plan", "--instance-dir", instanceDir, "--source", sources["source-b"], "--disable"]);
  assert.equal(disabled.sources.find((source) => source.name === "source-b").enabled, false);

  const second = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 6, 10, 0)]);
  assert.equal(second.status, "ok");
  assert.deepEqual(second.removed, ["source-b"]);
  assert.equal(existsSync(join(instanceDir, "context/002-source-b")), false);
  assert.equal(existsSync(join(instanceDir, "context/003-source-c/note.md")), true);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(saved.contextSources.length, 3);
  assert.equal(saved.contextSources[1].name, "source-b");
  assert.equal(saved.contextSources[1].status, "disabled");
  const status = await runCli(["status", "--instance-dir", instanceDir]);
  assert.equal(status.coverage.sources.find((source) => source.name === "source-b").status, "disabled");
  assert.equal(status.loadFailures.length, 0);

  // status 必须报告当前副本的实时漂移，而不是上一次同步的历史报告。
  await appendFile(join(instanceDir, "context/001-source-a/note.md"), "手动改动\n");
  const drifted = await runCli(["status", "--instance-dir", instanceDir]);
  assert.ok(drifted.localModifications.count >= 1);
  assert.equal(drifted.lastSyncLocalModifications.count, 0);

  await runCli(["plan", "--instance-dir", instanceDir, "--source", sources["source-b"], "--enable"]);
  const third = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 7, 10, 0)]);
  assert.equal(third.status, "ok");
  assert.deepEqual(third.removed, []);
  assert.equal(await readFile(join(instanceDir, "context/002-source-b/note.md"), "utf8"), "source-b\n");
  assert.equal(existsSync(join(instanceDir, "context/003-source-c/note.md")), true);
});

test("同步前留存上一版快照并报告本地修改，随后仍以标准版本覆盖", async (t) => {
  const { instanceDir, sourceA, version } = await createInstance(t);
  await runCli(planArgs(instanceDir, sourceA, ["--cadence", "every", "--every-minutes", "1"]));

  const first = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 0)]);
  assert.equal(first.status, "ok");
  assert.equal(first.previousVersion, version);
  assert.match(first.snapshotPath, /snapshots\/previous$/);
  assert.deepEqual(first.localModifications, { count: 0, added: 0, modified: 0, removed: 0, sample: [] });
  assert.equal(await readFile(join(instanceDir, "snapshots/previous/001-source-a/note.md"), "utf8"), "source-a\n");

  await writeFile(join(instanceDir, "context/001-source-a/note.md"), "LOCAL EDIT\n");
  await writeFile(join(instanceDir, "context/001-source-a/extra.md"), "LOCAL NEW\n");
  await rm(join(instanceDir, "context/002-source-b/note.md"));

  const second = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 2)]);
  assert.equal(second.status, "ok");
  assert.equal(second.previousVersion, first.version);
  assert.deepEqual(second.localModifications, {
    count: 3,
    added: 1,
    modified: 1,
    removed: 1,
    sample: [
      "+ context/001-source-a/extra.md",
      "~ context/001-source-a/note.md",
      "- context/002-source-b/note.md",
    ],
  });
  // 快照保留提交前整体内容（含本地修改），标准副本回到来源版本。
  assert.equal(await readFile(join(instanceDir, "snapshots/previous/001-source-a/note.md"), "utf8"), "LOCAL EDIT\n");
  assert.equal(await readFile(join(instanceDir, "snapshots/previous/001-source-a/extra.md"), "utf8"), "LOCAL NEW\n");
  assert.equal(existsSync(join(instanceDir, "snapshots/previous/002-source-b/note.md")), false);
  assert.equal(await readFile(join(instanceDir, "context/001-source-a/note.md"), "utf8"), "source-a\n");
  assert.equal(existsSync(join(instanceDir, "context/001-source-a/extra.md")), false);
  assert.equal(await readFile(join(instanceDir, "context/002-source-b/note.md"), "utf8"), "source-b\n");

  const syncStatus = JSON.parse(await readFile(join(instanceDir, "sync-status.json"), "utf8"));
  assert.equal(syncStatus.previousVersion, first.version);
  assert.deepEqual(syncStatus.localModifications, second.localModifications);
  assert.equal(syncStatus.snapshotPath, second.snapshotPath);
  const status = await runCli(["status", "--instance-dir", instanceDir]);
  // 同步已把本地改动覆盖进 previous 快照并恢复标准版本，所以实时漂移归零；
  // 上一次同步当时的报告仍完整保留，供交付验收核对。
  assert.deepEqual(status.localModifications, { count: 0, added: 0, modified: 0, removed: 0, sample: [] });
  assert.deepEqual(status.lastSyncLocalModifications, second.localModifications);
  assert.equal(status.snapshotPath, second.snapshotPath);
  assert.equal(status.previousVersion, first.version);

  // 第三次同步只保留最近一版 previous：快照应等于第二次提交后的标准副本。
  const third = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 4)]);
  assert.equal(third.status, "ok");
  assert.deepEqual(third.localModifications, { count: 0, added: 0, modified: 0, removed: 0, sample: [] });
  assert.equal(await readFile(join(instanceDir, "snapshots/previous/001-source-a/note.md"), "utf8"), "source-a\n");
  assert.equal(await readFile(join(instanceDir, "snapshots/previous/002-source-b/note.md"), "utf8"), "source-b\n");
});

test("快照失败会阻止同步且不覆盖当前副本", async (t) => {
  const { instanceDir, sourceA } = await createInstance(t);
  await runCli(planArgs(instanceDir, sourceA, ["--cadence", "daily", "--at", "09:00"]));
  const firstRunAt = localIso(2026, 11, 5, 10, 0);
  await runCli(["sync-due", "--instance-dir", instanceDir, "--now", firstRunAt]);
  await writeFile(join(instanceDir, "context/001-source-a/note.md"), "LOCAL EDIT\n");
  await rm(join(instanceDir, "snapshots"), { recursive: true, force: true });
  await writeFile(join(instanceDir, "snapshots"), "blocked\n");

  const failed = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 6, 10, 0)], {
    allowFailure: true,
  });
  assert.equal(failed.ran, true);
  assert.equal(failed.status, "error");
  assert.match(failed.reason, /EEXIST|已存在|ENOTDIR|不是目录/);
  assert.equal(await readFile(join(instanceDir, "context/001-source-a/note.md"), "utf8"), "LOCAL EDIT\n");
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(saved.syncPlan.sources[0].lastRunAt, firstRunAt);
  assert.equal(saved.syncPlan.sources[0].lastStatus, "error");
  const syncStatus = JSON.parse(await readFile(join(instanceDir, "sync-status.json"), "utf8"));
  assert.equal(syncStatus.status, "error");
});

test("失败原因取第一个非 ok 来源，而不是列表第一项", async (t) => {
  const { instanceDir, sources } = await createInstanceWithSources(t, ["source-a", "source-b", "source-c"]);
  await runCli(planArgs(instanceDir, sources["source-a"], ["--cadence", "daily", "--at", "09:00"]));
  await rm(sources["source-b"], { recursive: true, force: true });

  const failed = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 0)], {
    allowFailure: true,
  });
  assert.equal(failed.ran, true);
  assert.equal(failed.status, "error");
  assert.match(failed.reason, /source-b/);
  assert.doesNotMatch(failed.reason, /至少需要/);
  assert.equal(failed.planUpdateError, undefined);
});

test("isDue 边界：当天已过点、刚跑过、间隔未到、工作日与非工作日", async (t) => {
  const { instanceDir, sourceA } = await createInstance(t);
  await runCli(planArgs(instanceDir, sourceA, ["--cadence", "daily", "--at", "09:00"]));

  assert.equal((await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 0)])).ran, true);
  assert.equal((await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 23, 0)])).ran, false);
  assert.equal((await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 6, 8, 0)])).ran, false);
  assert.equal((await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 6, 10, 0)])).ran, true);

  await runCli(planArgs(instanceDir, sourceA, ["--cadence", "every", "--every-minutes", "60"]));
  const early = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 6, 10, 30), "--dry-run"]);
  assert.deepEqual(early.due, []);
  const dueNow = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 6, 11, 0), "--dry-run"]);
  assert.deepEqual(dueNow.due, ["source-a"]);

  // 2026-11-06 是周五；上周五 09:00 早于 10:00 那次同步，周六无到期点。
  await runCli(planArgs(instanceDir, sourceA, ["--cadence", "weekly", "--weekdays", "1-5", "--at", "09:00"]));
  const weekend = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 7, 12, 0), "--dry-run"]);
  assert.deepEqual(weekend.due, []);
  const monday = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 9, 9, 30), "--dry-run"]);
  assert.deepEqual(monday.due, ["source-a"]);
});

test("工作日每两小时可表达：every/daily 的 weekdays 在非允许日不 due", async (t) => {
  const { instanceDir, sourceA } = await createInstance(t);
  const planned = await runCli(
    planArgs(instanceDir, sourceA, ["--cadence", "every", "--every-minutes", "120", "--weekdays", "1-5"]),
  );
  assert.deepEqual(planned.sources[0].cadence, {
    kind: "every",
    everyMinutes: 120,
    weekdays: [1, 2, 3, 4, 5],
  });
  assert.match(planned.sources[0].cadenceText, /每 120 分钟/);
  assert.match(planned.sources[0].cadenceText, /仅周一/);

  assert.equal((await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 0)])).ran, true);
  const saturday = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 7, 12, 0), "--dry-run"]);
  assert.deepEqual(saturday.due, []);
  assert.equal(saturday.sources[0].nextDueAt, localIso(2026, 11, 9, 0, 0));
  const sunday = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 8, 12, 0), "--dry-run"]);
  assert.deepEqual(sunday.due, []);
  const monday = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 9, 9, 0), "--dry-run"]);
  assert.deepEqual(monday.due, ["source-a"]);

  const daily = await runCli(
    planArgs(instanceDir, sourceA, ["--cadence", "daily", "--weekdays", "1-5", "--at", "09:00"]),
  );
  assert.deepEqual(daily.sources[0].cadence, { kind: "daily", at: "09:00", weekdays: [1, 2, 3, 4, 5] });
  assert.match(daily.sources[0].cadenceText, /周一/);
  const dailyWeekend = await runCli([
    "sync-due",
    "--instance-dir",
    instanceDir,
    "--now",
    localIso(2026, 11, 7, 12, 0),
    "--dry-run",
  ]);
  assert.deepEqual(dailyWeekend.due, []);
  const mondayEarly = await runCli([
    "sync-due",
    "--instance-dir",
    instanceDir,
    "--now",
    localIso(2026, 11, 9, 8, 0),
    "--dry-run",
  ]);
  assert.deepEqual(mondayEarly.due, ["source-a"]);
  assert.equal((await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 9, 8, 0)])).ran, true);
  const sameMonday = await runCli([
    "sync-due",
    "--instance-dir",
    instanceDir,
    "--now",
    localIso(2026, 11, 9, 8, 30),
    "--dry-run",
  ]);
  assert.deepEqual(sameMonday.due, []);
  assert.equal(sameMonday.sources[0].nextDueAt, localIso(2026, 11, 9, 9, 0));
});

test("plan --exclude 与 --symlinks skip 生效，--clear-excludes 可恢复", async (t) => {
  const { instanceDir, sourceA } = await createInstance(t);
  await mkdir(join(sourceA, "private"), { recursive: true });
  await writeFile(join(sourceA, "private/skip.md"), "skip\n");
  await mkdir(join(sourceA, "node_modules"), { recursive: true });
  await writeFile(join(sourceA, "node_modules/x.js"), "x\n");
  await symlink(join(sourceA, "note.md"), join(sourceA, "link.md"));

  await runCli(
    planArgs(instanceDir, sourceA, [
      "--cadence",
      "daily",
      "--exclude",
      "private/**",
      "--symlinks",
      "skip",
    ]),
  );
  const result = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 0)]);
  assert.equal(result.status, "ok");
  assert.equal(existsSync(join(instanceDir, "context/001-source-a/private/skip.md")), false);
  assert.equal(existsSync(join(instanceDir, "context/001-source-a/node_modules")), false);
  assert.equal(existsSync(join(instanceDir, "context/001-source-a/link.md")), false);
  const sourceEntry = result.contextSources.find((source) => source.name === "source-a");
  assert.equal(sourceEntry.excluded.files, 1);
  assert.equal(sourceEntry.excluded.dirs, 1);
  assert.equal(sourceEntry.symlinks.skipped, 1);

  const cleared = await runCli(["plan", "--instance-dir", instanceDir, "--source", sourceA, "--clear-excludes"]);
  assert.deepEqual(cleared.sources[0].exclude, []);
  const restored = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 6, 10, 0)]);
  assert.equal(restored.status, "ok");
  assert.equal(await readFile(join(instanceDir, "context/001-source-a/private/skip.md"), "utf8"), "skip\n");
  assert.equal(existsSync(join(instanceDir, "context/001-source-a/link.md")), false);
});

test("软链目标按真实路径过滤，敏感目标不复制，单文件来源同样受限", async (t) => {
  const root = await makeTempDir(t);
  const source = join(root, "link-source");
  await mkdir(join(source, "private"), { recursive: true });
  await mkdir(join(source, "public"), { recursive: true });
  await writeFile(join(source, ".env"), "SECRET=1\n");
  await writeFile(join(source, "private/secret.md"), "SECRET DOC\n");
  await writeFile(join(source, "public/real.md"), "PUBLIC\n");
  await symlink(join(source, ".env"), join(source, "notes.md"));
  await symlink("../private/secret.md", join(source, "public/alias.md"));
  await symlink("../public/real.md", join(source, "private/alias.md"));
  await symlink(join(source, "missing.md"), join(source, "broken.md"));
  await symlink(".", join(source, "loop"));

  const models = await startModelServer();
  t.after(() => models.close());
  const instanceDir = join(root, "instance");
  await runCli(
    [
      "init",
      "--instance-dir",
      instanceDir,
      "--source",
      source,
      "--scope",
      "private",
      "--base-url",
      models.baseUrl,
      "--api-key",
      "test-key",
      "--model",
      "main-model",
    ],
    { allowFailure: true, env: { ...process.env, WECOM_BOT_PI_BINARY: join(root, "missing-pi") } },
  );
  await runCli([
    "plan",
    "--instance-dir",
    instanceDir,
    "--source",
    source,
    "--scope",
    "private",
    "--cadence",
    "daily",
    "--exclude",
    "private/**",
    "--symlinks",
    "follow",
  ]);
  const result = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 0)]);
  assert.equal(result.status, "ok");
  const entry = result.contextSources.find((candidate) => candidate.name === "link-source");
  assert.equal(entry.excluded.sensitive, 2); // .env 与 notes.md -> .env
  assert.equal(entry.excluded.files, 2); // private/secret.md 与 public/alias.md -> private/secret.md
  assert.equal(entry.symlinks.followed, 1); // private/alias.md -> public/real.md
  assert.equal(entry.symlinks.broken, 1); // broken.md
  assert.equal(entry.symlinks.skipped, 1); // loop -> 来源根自身
  assert.equal(existsSync(join(instanceDir, "context/001-link-source/notes.md")), false);
  assert.equal(existsSync(join(instanceDir, "context/001-link-source/.env")), false);
  assert.equal(existsSync(join(instanceDir, "context/001-link-source/public/alias.md")), false);
  assert.equal(existsSync(join(instanceDir, "context/001-link-source/private/secret.md")), false);
  assert.equal(await readFile(join(instanceDir, "context/001-link-source/private/alias.md"), "utf8"), "PUBLIC\n");
  assert.equal(await readFile(join(instanceDir, "context/001-link-source/public/real.md"), "utf8"), "PUBLIC\n");

  const outsideSource = join(root, "outside-source");
  await mkdir(outsideSource, { recursive: true });
  await symlink("/etc/hosts", join(outsideSource, "hosts-link.md"));
  const shared = await runCli(
    ["sync", "--instance-dir", instanceDir, "--source", join(outsideSource, "hosts-link.md"), "--scope", "shared"],
    { allowFailure: true },
  );
  assert.equal(shared.status, "error");
  assert.match(shared.reason, /根之外/);
  const privateSync = await runCli(
    ["sync", "--instance-dir", instanceDir, "--source", join(outsideSource, "hosts-link.md"), "--scope", "private"],
  );
  assert.equal(privateSync.status, "ok");
  assert.equal(privateSync.contextSources[0].symlinks.followedOutsideRoot, 1);

  const sensitiveDir = join(root, "sensitive-single");
  await mkdir(sensitiveDir, { recursive: true });
  await writeFile(join(sensitiveDir, ".env"), "SECRET=1\n");
  await symlink(join(sensitiveDir, ".env"), join(sensitiveDir, "alias.md"));
  const sensitive = await runCli(
    ["sync", "--instance-dir", instanceDir, "--source", join(sensitiveDir, "alias.md"), "--scope", "private"],
    { allowFailure: true },
  );
  assert.equal(sensitive.status, "error");
  assert.match(sensitive.reason, /敏感文件/);
  assert.equal(sensitive.contextSources[0].excluded.sensitive, 1);

  const regularSource = join(root, "regular-single");
  await mkdir(regularSource, { recursive: true });
  await writeFile(join(regularSource, "target.md"), "TARGET\n");
  await symlink(join(regularSource, "target.md"), join(regularSource, "alias.md"));
  const regularInstance = join(root, "regular-instance");
  await runCli(
    [
      "init",
      "--instance-dir",
      regularInstance,
      "--source",
      join(regularSource, "alias.md"),
      "--scope",
      "private",
      "--base-url",
      models.baseUrl,
      "--api-key",
      "test-key",
      "--model",
      "main-model",
    ],
    { allowFailure: true, env: { ...process.env, WECOM_BOT_PI_BINARY: join(root, "missing-pi") } },
  );
  await runCli([
    "plan",
    "--instance-dir",
    regularInstance,
    "--source",
    join(regularSource, "alias.md"),
    "--scope",
    "private",
    "--cadence",
    "daily",
    "--symlinks",
    "reject",
  ]);
  const rejected = await runCli(
    ["sync-due", "--instance-dir", regularInstance, "--now", localIso(2026, 11, 5, 10, 0)],
    { allowFailure: true },
  );
  assert.equal(rejected.status, "error");
  assert.match(rejected.reason, /不允许符号链接/);
});

test("重叠执行被锁挡住且不改动计划与副本", async (t) => {
  const { instanceDir, sourceA } = await createInstance(t);
  await runCli(planArgs(instanceDir, sourceA, ["--cadence", "every", "--every-minutes", "1"]));
  await mkdir(join(instanceDir, "data"), { recursive: true });
  await writeFile(join(instanceDir, "data/sync.lock"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);

  const locked = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 0)]);
  assert.equal(locked.ran, false);
  assert.equal(locked.locked, true);
  assert.equal(locked.holder, process.pid);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(saved.syncPlan.sources[0].lastRunAt, null);
});

test("CADENCE_KINDS 与 normalizeCadence 接受集合一致，isDue/nextDueAt 共用 weekday 规则", () => {
  for (const kind of CADENCE_KINDS) {
    const input =
      kind === "every" || kind === "hourly"
        ? { kind, everyMinutes: 60 }
        : kind === "daily" || kind === "weekly"
          ? { kind, at: "09:00" }
          : { kind };
    assert.doesNotThrow(() => normalizeCadence(input), `normalizeCadence 应接受 ${kind}`);
  }
  assert.throws(() => normalizeCadence({ kind: "每天" }), new RegExp(CADENCE_KINDS.join("、")));

  const every = normalizeCadence({ kind: "every", everyMinutes: 120, weekdays: [1, 2, 3, 4, 5] });
  assert.equal(isDue(every, localIso(2026, 11, 5, 10, 0), new Date(localIso(2026, 11, 7, 12, 0))), false);
  assert.equal(isDue(every, localIso(2026, 11, 5, 10, 0), new Date(localIso(2026, 11, 9, 12, 0))), true);
  assert.equal(
    nextDueAt(every, localIso(2026, 11, 5, 10, 0), new Date(localIso(2026, 11, 7, 12, 0))),
    localIso(2026, 11, 9, 0, 0),
  );

  const daily = normalizeCadence({ kind: "daily", at: "09:00", weekdays: [1, 2, 3, 4, 5] });
  const mondayEarly = new Date(localIso(2026, 11, 9, 8, 30));
  assert.equal(isDue(daily, localIso(2026, 11, 6, 10, 0), mondayEarly), false);
  assert.equal(nextDueAt(daily, localIso(2026, 11, 6, 10, 0), mondayEarly), localIso(2026, 11, 9, 9, 0));
  assert.equal(isDue(daily, localIso(2026, 11, 5, 10, 0), mondayEarly), true);
  assert.equal(nextDueAt(daily, localIso(2026, 11, 5, 10, 0), mondayEarly), mondayEarly.toISOString());
});

function makeFakeBin(root, command) {
  const binDir = join(root, "bin");
  const logPath = join(root, "calls.log");
  return (async () => {
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, command), `#!/bin/sh\necho "$@" >> ${JSON.stringify(logPath)}\n`, { mode: 0o755 });
    await chmod(join(binDir, command), 0o755);
    return { binDir, logPath };
  })();
}

test("schedule 生成 launchd plist，install/uninstall 需要 --yes 且只调用假 launchctl", async (t) => {
  const { root, instanceDir } = await createInstance(t);
  const home = join(root, "home");
  const fake = await makeFakeBin(join(root, "fake-launchctl"), "launchctl");
  const env = { ...process.env, PATH: `${fake.binDir}:${process.env.PATH}` };

  const dryRun = await runCli(["schedule", "--instance-dir", instanceDir, "--home", home, "--tick-minutes", "7"]);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.platform, "darwin");
  assert.equal(dryRun.units.length, 1);
  const plistPath = dryRun.units[0].path;
  assert.match(plistPath, /Library\/LaunchAgents\/com\.wecom-support-bot\.sync\.[0-9a-f]{8}\.plist$/);
  assert.match(dryRun.units[0].content, /<key>StartInterval<\/key>\s*<integer>420<\/integer>/);
  assert.match(dryRun.units[0].content, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(dryRun.units[0].content, new RegExp(`<string>sync-due</string>`));
  assert.match(dryRun.units[0].content, /logs\/sync\.log/);
  assert.equal(existsSync(home), false);

  const noConsent = await runCli(["schedule", "--instance-dir", instanceDir, "--home", home, "--tick-minutes", "7", "--install"], {
    allowFailure: true,
    env,
  });
  assert.equal(noConsent.status, "error");
  assert.equal(noConsent.requiresConfirmation, true);
  assert.match(noConsent.reason, /--yes/);
  assert.equal(existsSync(home), false);
  assert.equal(existsSync(fake.logPath), false);

  const installed = await runCli(
    ["schedule", "--instance-dir", instanceDir, "--home", home, "--tick-minutes", "7", "--install", "--yes"],
    { env },
  );
  assert.equal(installed.status, "ok");
  assert.equal(existsSync(plistPath), true);
  assert.equal(existsSync(join(instanceDir, "logs")), true);
  const calls = (await readFile(fake.logPath, "utf8")).trim().split("\n");
  assert.equal(calls.some((call) => call.startsWith(`bootstrap gui/${process.getuid()} ${plistPath}`)), true);
  assert.equal(calls.some((call) => call.startsWith(`bootout gui/${process.getuid()} ${plistPath}`)), true);

  const uninstallNoConsent = await runCli(
    ["schedule", "--instance-dir", instanceDir, "--home", home, "--uninstall"],
    { allowFailure: true, env },
  );
  assert.equal(uninstallNoConsent.status, "error");
  assert.equal(uninstallNoConsent.requiresConfirmation, true);
  assert.equal(existsSync(plistPath), true);

  const uninstalled = await runCli(["schedule", "--instance-dir", instanceDir, "--home", home, "--uninstall", "--yes"], { env });
  assert.equal(uninstalled.status, "ok");
  assert.equal(existsSync(plistPath), false);
  const callsAfter = (await readFile(fake.logPath, "utf8")).trim().split("\n");
  assert.equal(callsAfter.filter((call) => call.startsWith(`bootout gui/${process.getuid()} ${plistPath}`)).length >= 2, true);
});

test("schedule --platform linux 生成 systemd service+timer 并调用假 systemctl", async (t) => {
  const { root, instanceDir } = await createInstance(t);
  const home = join(root, "home");
  const fake = await makeFakeBin(join(root, "fake-systemctl"), "systemctl");
  const env = { ...process.env, PATH: `${fake.binDir}:${process.env.PATH}` };

  const dryRun = await runCli([
    "schedule",
    "--instance-dir",
    instanceDir,
    "--home",
    home,
    "--platform",
    "linux",
    "--tick-minutes",
    "9",
  ]);
  assert.equal(dryRun.units.length, 2);
  const service = dryRun.units.find((unit) => unit.path.endsWith(".service"));
  const timer = dryRun.units.find((unit) => unit.path.endsWith(".timer"));
  assert.match(service.content, /Type=oneshot/);
  assert.match(service.content, /sync-due/);
  assert.match(service.content, /logs\/sync\.log/);
  assert.match(timer.content, /OnBootSec=1min/);
  assert.match(timer.content, /OnActiveSec=1min/);
  assert.match(timer.content, /OnUnitActiveSec=9min/);
  assert.match(timer.content, /Persistent=true/);
  assert.match(timer.path, /\.config\/systemd\/user\/com\.wecom-support-bot\.sync\.[0-9a-f]{8}\.timer$/);

  const installed = await runCli(
    ["schedule", "--instance-dir", instanceDir, "--home", home, "--platform", "linux", "--install", "--yes"],
    { env },
  );
  assert.equal(installed.status, "ok");
  assert.equal(existsSync(service.path), true);
  assert.equal(existsSync(timer.path), true);
  const calls = (await readFile(fake.logPath, "utf8")).trim().split("\n");
  assert.equal(calls.includes("--user daemon-reload"), true);
  assert.equal(calls.some((call) => /--user enable --now .*\.timer$/.test(call)), true);

  const uninstalled = await runCli(
    ["schedule", "--instance-dir", instanceDir, "--home", home, "--platform", "linux", "--uninstall", "--yes"],
    { env },
  );
  assert.equal(uninstalled.status, "ok");
  assert.equal(existsSync(service.path), false);
  assert.equal(existsSync(timer.path), false);
  const callsAfter = (await readFile(fake.logPath, "utf8")).trim().split("\n");
  assert.equal(callsAfter.some((call) => /--user disable --now .*\.timer$/.test(call)), true);
});

test("plan 只按 realpath 精确匹配 registry，拒绝同名不同路径与实例内副本", async (t) => {
  const { root, instanceDir, sourceA } = await createInstance(t);
  const registryPath = join(instanceDir, "data/source-registry.json");
  const registryStat = await stat(registryPath);
  assert.equal(registryStat.mode & 0o777, 0o600);
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(registry.sources["source-a"].path, sourceA);

  const impostor = join(root, "other", "source-a");
  await mkdir(impostor, { recursive: true });
  await writeFile(join(impostor, "note.md"), "IMPOSTOR\n");
  const sameName = await runCliFailure([
    "plan",
    "--instance-dir",
    instanceDir,
    "--source",
    impostor,
    "--cadence",
    "daily",
  ]);
  assert.match(sameName, /同名但路径不同/);
  assert.match(sameName, /source-a/);
  assert.equal(JSON.parse(await readFile(registryPath, "utf8")).sources["source-a"].path, sourceA);

  const copySource = await runCliFailure([
    "plan",
    "--instance-dir",
    instanceDir,
    "--source",
    join(instanceDir, "context/001-source-a"),
    "--cadence",
    "daily",
  ]);
  assert.match(copySource, /实例内/);

  // 同一真实目标的符号链接别名仍被视为同一来源。
  const alias = join(root, "alias-source-a");
  await symlink(sourceA, alias);
  const planned = await runCli(planArgs(instanceDir, alias, ["--cadence", "daily", "--at", "09:00"]));
  assert.equal(planned.updated, "source-a");
  assert.equal(JSON.stringify(planned.sources).includes(sourceA), false);
  const savedText = await readFile(join(instanceDir, "instance.json"), "utf8");
  assert.equal(savedText.includes(sourceA), false);
  assert.equal(savedText.includes(registryPath), false);
});

test("含 userinfo 的来源地址拒绝登记，输出与落盘都不回显凭证", async (t) => {
  const { instanceDir } = await createInstance(t);
  const password = "s3cr3t-should-never-leak";
  const credentialed = `https://url-user:${password}@gitlab.example.invalid/team/repo.git`;

  const synced = await runCli(
    ["sync", "--instance-dir", instanceDir, "--source", credentialed, "--scope", "shared", "--source-type", "gitlab"],
    { allowFailure: true },
  );
  assert.equal(synced.status, "error");
  assert.match(synced.reason, /内嵌凭证|无凭据/);
  assert.equal(JSON.stringify(synced).includes(password), false);

  const planStderr = await runCliFailure([
    "plan",
    "--instance-dir",
    instanceDir,
    "--source",
    credentialed,
    "--cadence",
    "daily",
  ]);
  assert.match(planStderr, /内嵌凭证|无凭据/);
  assert.equal(planStderr.includes(password), false);

  for (const file of ["instance.json", "sync-status.json", "data/source-registry.json"]) {
    const content = await readFile(join(instanceDir, file), "utf8");
    assert.equal(content.includes(password), false, `${file} 不应包含凭证`);
    assert.equal(content.includes("url-user"), false, `${file} 不应包含 userinfo`);
  }
});

test("registry 与 context/instance/sync-status 同事务提交，失败全部回滚", async (t) => {
  const { root, instanceDir } = await createInstance(t);
  const registryPath = join(instanceDir, "data/source-registry.json");
  const beforeRegistry = await readFile(registryPath, "utf8");
  const newSource = join(root, "source-new");
  await mkdir(newSource, { recursive: true });
  await writeFile(join(newSource, "note.md"), "NEW\n");

  const failed = await runCli(
    ["sync", "--instance-dir", instanceDir, "--source", newSource, "--scope", "shared"],
    { allowFailure: true, env: { ...process.env, WECOM_BOT_TEST_FAIL_SYNC_STATUS_COMMIT: "1" } },
  );
  assert.equal(failed.status, "error");
  assert.equal(await readFile(registryPath, "utf8"), beforeRegistry);
  assert.equal((await stat(registryPath)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(saved.contextSources.some((source) => source.name === "source-new"), false);
  assert.deepEqual(
    JSON.parse(await readFile(registryPath, "utf8")).sources["source-new"],
    undefined,
  );
});

test("同名来源拒绝登记并列出冲突的真实路径", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const first = join(root, "first", "s1");
  const second = join(root, "second", "s1");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(join(first, "note.md"), "FIRST\n");
  await writeFile(join(second, "note.md"), "SECOND\n");
  const instanceDir = join(root, "instance");

  const stderr = await runCliFailure(
    [
      "init",
      "--instance-dir",
      instanceDir,
      "--source",
      first,
      "--scope",
      "shared",
      "--source",
      second,
      "--scope",
      "shared",
      "--base-url",
      models.baseUrl,
      "--api-key",
      "test-key",
      "--model",
      "main-model",
    ],
    { env: { ...process.env, WECOM_BOT_PI_BINARY: join(root, "missing-pi") } },
  );
  assert.match(stderr, /来源名称重复/);
  assert.match(stderr, /s1/);
  assert.equal(stderr.includes(await realpath(first)), true);
  assert.equal(stderr.includes(await realpath(second)), true);
  // 登记失败时不能落下任何标准副本或状态文件。
  assert.equal(existsSync(join(instanceDir, "context")), false);
  assert.equal(existsSync(join(instanceDir, "instance.json")), false);
  assert.equal(existsSync(join(instanceDir, "data/source-registry.json")), false);
});

test("sync 同名来源拒绝登记，sync-due/plan 对重复来源名 fail-closed", async (t) => {
  const { root, instanceDir } = await createInstance(t);
  const first = join(root, "first", "source-a");
  const second = join(root, "second", "source-a");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(join(first, "note.md"), "FIRST\n");
  await writeFile(join(second, "note.md"), "SECOND\n");

  const synced = await runCli(
    ["sync", "--instance-dir", instanceDir, "--source", first, "--scope", "shared", "--source", second, "--scope", "shared"],
    { allowFailure: true },
  );
  assert.equal(synced.status, "error");
  assert.match(synced.reason, /来源名称重复/);
  assert.equal(synced.reason.includes(await realpath(first)), true);
  assert.equal(synced.reason.includes(await realpath(second)), true);
  const savedAfter = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.deepEqual(savedAfter.contextSources.map((source) => source.name), ["source-a", "source-b"]);

  // 单条新来源与已登记来源同名但路径不同：同样拒绝，且 registry 不被覆盖。
  const existingPath = join(root, "source-a");
  const collides = await runCli(["sync", "--instance-dir", instanceDir, "--source", first, "--scope", "shared"], {
    allowFailure: true,
  });
  assert.equal(collides.status, "error");
  assert.match(collides.reason, /来源名称重复/);
  assert.equal(collides.reason.includes(await realpath(first)), true);
  assert.equal(collides.reason.includes(await realpath(existingPath)), true);
  const registryAfter = JSON.parse(await readFile(join(instanceDir, "data/source-registry.json"), "utf8"));
  assert.equal(registryAfter.sources["source-a"].path, existingPath);
  assert.equal(await readFile(join(instanceDir, "context/001-source-a/note.md"), "utf8"), "source-a\n");

  // 同一真实路径重新登记（例如再来一次 sync）允许通过。
  const reRegistered = await runCli(["sync", "--instance-dir", instanceDir, "--source", existingPath, "--scope", "shared"]);
  assert.equal(reRegistered.status, "ok");
  assert.equal(reRegistered.contextSources[0].name, "source-a");

  // 人为构造重复 contextSources：sync-due 与 plan 都必须 fail-closed。
  const savedPath = join(instanceDir, "instance.json");
  const corrupted = JSON.parse(await readFile(savedPath, "utf8"));
  corrupted.contextSources.push({ ...corrupted.contextSources[0], localPath: "context/009-source-a" });
  await writeFile(savedPath, `${JSON.stringify(corrupted, null, 2)}\n`);

  const dueStderr = await runCliFailure(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 0)]);
  assert.match(dueStderr, /来源名称重复/);
  assert.equal(existsSync(join(instanceDir, "data/sync.lock")), false);
  const planStderr = await runCliFailure(["plan", "--instance-dir", instanceDir]);
  assert.match(planStderr, /来源名称重复/);
});

test("提交失败时保留旧的上一版快照并清掉未提交的 previous.next", async (t) => {
  const { instanceDir, sourceA } = await createInstance(t);
  await runCli(planArgs(instanceDir, sourceA, ["--cadence", "every", "--every-minutes", "1"]));
  const first = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 0)]);
  assert.equal(first.status, "ok");
  assert.equal(await readFile(join(instanceDir, "snapshots/previous/001-source-a/note.md"), "utf8"), "source-a\n");

  await writeFile(join(sourceA, "note.md"), "A2\n");
  await writeFile(join(instanceDir, "context/001-source-a/note.md"), "LOCAL EDIT\n");
  const failed = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 2)], {
    allowFailure: true,
    env: { ...process.env, WECOM_BOT_TEST_FAIL_SYNC_STATUS_COMMIT: "1" },
  });
  assert.equal(failed.ran, true);
  assert.equal(failed.status, "error");
  // 上一版快照没有被新副本覆盖，也没有留下未提交的半成品。
  assert.equal(await readFile(join(instanceDir, "snapshots/previous/001-source-a/note.md"), "utf8"), "source-a\n");
  assert.equal(existsSync(join(instanceDir, "snapshots/previous.next")), false);
  assert.equal(await readFile(join(instanceDir, "context/001-source-a/note.md"), "utf8"), "LOCAL EDIT\n");
  const syncStatus = JSON.parse(await readFile(join(instanceDir, "sync-status.json"), "utf8"));
  assert.equal(syncStatus.status, "ok");
});

test("init/sync 接受 --exclude/--clear-excludes/--symlinks 并持久化到 registry", async (t) => {
  const root = await makeTempDir(t);
  const models = await startModelServer();
  t.after(() => models.close());
  const source = join(root, "docs");
  await mkdir(join(source, "private"), { recursive: true });
  await writeFile(join(source, "note.md"), "NOTE\n");
  await writeFile(join(source, "private/skip.md"), "SKIP\n");
  await symlink(join(source, "note.md"), join(source, "link.md"));
  const instanceDir = join(root, "instance");

  const initialized = await runCli(
    [
      "init",
      "--instance-dir",
      instanceDir,
      "--source",
      source,
      "--scope",
      "shared",
      "--exclude",
      "private/**",
      "--symlinks",
      "skip",
      "--base-url",
      models.baseUrl,
      "--api-key",
      "test-key",
      "--model",
      "main-model",
    ],
    { allowFailure: true, env: { ...process.env, WECOM_BOT_PI_BINARY: join(root, "missing-pi") } },
  );
  const entry = initialized.checks.contextSources[0];
  assert.equal(entry.status, "ok");
  assert.deepEqual(entry.exclude, ["private/**"]);
  assert.equal(entry.symlinks.skipped, 1);
  assert.equal(existsSync(join(instanceDir, "context/001-docs/private/skip.md")), false);
  assert.equal(existsSync(join(instanceDir, "context/001-docs/link.md")), false);
  const registryPath = join(instanceDir, "data/source-registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.deepEqual(registry.sources.docs.exclude, ["private/**"]);
  assert.equal(registry.sources.docs.symlinks, "skip");

  // 首次补齐同步计划时沿用登记选项，而不是退回默认值。
  const planned = await runCli(["plan", "--instance-dir", instanceDir]);
  assert.deepEqual(planned.sources[0].exclude, ["private/**"]);
  assert.equal(planned.sources[0].symlinks, "skip");

  await runCli([
    "plan",
    "--instance-dir",
    instanceDir,
    "--source",
    source,
    "--scope",
    "shared",
    "--cadence",
    "daily",
    "--at",
    "09:00",
  ]);
  const scheduled = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 0)]);
  assert.equal(scheduled.status, "ok");
  assert.deepEqual(scheduled.contextSources[0].exclude, ["private/**"]);
  assert.equal(scheduled.contextSources[0].symlinks.skipped, 1);
  assert.equal(existsSync(join(instanceDir, "context/001-docs/private/skip.md")), false);
  assert.equal(existsSync(join(instanceDir, "context/001-docs/link.md")), false);

  const cleared = await runCli([
    "sync",
    "--instance-dir",
    instanceDir,
    "--source",
    source,
    "--scope",
    "shared",
    "--clear-excludes",
    "--symlinks",
    "follow",
  ]);
  assert.equal(cleared.status, "ok");
  assert.deepEqual(cleared.contextSources[0].exclude, []);
  const after = JSON.parse(await readFile(registryPath, "utf8"));
  assert.deepEqual(after.sources.docs.exclude, []);
  assert.equal(after.sources.docs.symlinks, "follow");
  assert.equal(await readFile(join(instanceDir, "context/001-docs/private/skip.md"), "utf8"), "SKIP\n");
  assert.equal(await readFile(join(instanceDir, "context/001-docs/link.md"), "utf8"), "NOTE\n");

  assert.match(
    await runCliFailure(["sync", "--instance-dir", instanceDir, "--exclude", "x/**"]),
    /必须跟在 --source 后面/,
  );
  assert.match(
    await runCliFailure([
      "sync",
      "--instance-dir",
      instanceDir,
      "--source",
      source,
      "--scope",
      "shared",
      "--exclude",
      "a/**",
      "--clear-excludes",
    ]),
    /不能同时使用/,
  );
});

test("plan --cadence hourly 无需 --every-minutes，normalizeCadence 补齐 60", async (t) => {
  assert.deepEqual(normalizeCadence({ kind: "hourly" }), { kind: "every", everyMinutes: 60 });
  assert.deepEqual(normalizeCadence({ kind: "hourly", weekdays: [1, 5] }), {
    kind: "every",
    everyMinutes: 60,
    weekdays: [1, 5],
  });
  const { instanceDir, sourceA } = await createInstance(t);
  const planned = await runCli(planArgs(instanceDir, sourceA, ["--cadence", "hourly"]));
  assert.deepEqual(planned.sources[0].cadence, { kind: "every", everyMinutes: 60 });
  assert.equal(planned.sources[0].cadenceText, "每 60 分钟");
});

test("手动 sync 子集输出 notIncluded 列出未复制的计划来源", async (t) => {
  const { instanceDir, sources } = await createInstanceWithSources(t, ["source-a", "source-b"]);
  await runCli(planArgs(instanceDir, sources["source-a"], ["--cadence", "manual"]));
  await runCli(planArgs(instanceDir, sources["source-b"], ["--cadence", "manual"]));

  const partial = await runCli(["sync", "--instance-dir", instanceDir, "--source", sources["source-a"], "--scope", "shared"]);
  assert.equal(partial.status, "ok");
  assert.deepEqual(partial.notIncluded, ["source-b"]);
  assert.equal(existsSync(join(instanceDir, "context/002-source-b")), false);

  const full = await runCli([
    "sync",
    "--instance-dir",
    instanceDir,
    "--source",
    sources["source-a"],
    "--scope",
    "shared",
    "--source",
    sources["source-b"],
    "--scope",
    "shared",
  ]);
  assert.equal(full.status, "ok");
  assert.deepEqual(full.notIncluded, []);
});

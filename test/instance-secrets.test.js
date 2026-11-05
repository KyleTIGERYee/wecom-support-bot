import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

async function runCliFailure(args, options = {}) {
  try {
    await execFileAsync(process.execPath, [cliPath, ...args], { cwd: projectDir, ...options });
    return "";
  } catch (error) {
    return String(error.stderr ?? error.message);
  }
}

async function makeTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "wsb-secrets-"));
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

/** pi 指向不存在的路径：功能检查失败，但来源复制与计划仍按真实公开流程执行。 */
async function createInstance(t, root, sources, options = {}) {
  const models = await startModelServer();
  t.after(() => models.close());
  const instanceDir = join(root, "instance");
  const args = ["init", "--instance-dir", instanceDir];
  for (const source of sources) {
    args.push("--source", source.path, "--scope", source.scope);
    if (source.includeSecrets) args.push("--include-secrets");
  }
  if (options.packagePath) args.push("--template", "import", "--package", options.packagePath);
  args.push("--base-url", models.baseUrl, "--api-key", "test-key", "--model", "main-model");
  const result = await runCli(args, {
    allowFailure: true,
    env: { ...process.env, WECOM_BOT_PI_BINARY: join(root, "missing-pi") },
  });
  return { instanceDir, result };
}

function localIso(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

test("init 私有来源显式 --include-secrets 会复制并列出凭证文件", async (t) => {
  const root = await makeTempDir(t);
  const source = join(root, "private-source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, ".env"), "SECRET=1\n");
  await writeFile(join(source, "service.pem"), "PEM\n");
  await writeFile(join(source, "public.md"), "PUBLIC\n");

  const { instanceDir, result } = await createInstance(t, root, [{ path: source, scope: "private", includeSecrets: true }]);
  assert.equal(result.checks.contextSources[0].status, "ok");
  assert.equal(result.checks.contextSources[0].secretsIncluded, true);
  assert.deepEqual(result.checks.contextSources[0].secretFiles.sort(), [".env", "service.pem"]);
  assert.equal(result.checks.contextSources[0].excluded.sensitive, 0);
  assert.equal(await readFile(join(instanceDir, "context/001-private-source/.env"), "utf8"), "SECRET=1\n");
  assert.equal(await readFile(join(instanceDir, "context/001-private-source/service.pem"), "utf8"), "PEM\n");
  assert.equal(await readFile(join(instanceDir, "context/001-private-source/public.md"), "utf8"), "PUBLIC\n");
});

test("shared 来源给 --include-secrets 直接报错，凭证不会进入副本", async (t) => {
  const root = await makeTempDir(t);
  const source = join(root, "shared-source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "source.md"), "SOURCE\n");
  const { instanceDir } = await createInstance(t, root, [{ path: source, scope: "shared" }]);

  const secretSource = join(root, "secret-source");
  await mkdir(secretSource, { recursive: true });
  await writeFile(join(secretSource, ".env"), "SECRET=1\n");
  const result = await runCli(
    ["sync", "--instance-dir", instanceDir, "--source", secretSource, "--scope", "shared", "--include-secrets"],
    { allowFailure: true },
  );
  assert.equal(result.status, "error");
  assert.match(result.reason, /private/);
  assert.equal(existsSync(join(instanceDir, "context/001-secret-source/.env")), false);
  assert.equal(await readFile(join(instanceDir, "context/001-shared-source/source.md"), "utf8"), "SOURCE\n");
});

test("默认仍排除凭证文件，并计入 excluded.sensitive", async (t) => {
  const root = await makeTempDir(t);
  const source = join(root, "default-source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, ".env"), "SECRET=1\n");
  await writeFile(join(source, "public.md"), "PUBLIC\n");
  const { instanceDir } = await createInstance(t, root, [{ path: source, scope: "private" }]);

  const result = await runCli([
    "sync",
    "--instance-dir",
    instanceDir,
    "--source",
    source,
    "--scope",
    "private",
  ]);
  assert.equal(result.status, "ok");
  assert.equal(result.contextSources[0].excluded.sensitive, 1);
  assert.equal(result.contextSources[0].secretsIncluded, undefined);
  assert.equal(existsSync(join(instanceDir, "context/001-default-source/.env")), false);
  assert.equal(await readFile(join(instanceDir, "context/001-default-source/public.md"), "utf8"), "PUBLIC\n");
});

test("plan 持久化 --include-secrets，sync-due 按计划复制凭证且 shared 拒绝", async (t) => {
  const root = await makeTempDir(t);
  const source = join(root, "planned-source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "public.md"), "PUBLIC\n");
  const { instanceDir } = await createInstance(t, root, [{ path: source, scope: "private" }]);
  await writeFile(join(source, ".env"), "SECRET=1\n");

  const sharedFailure = await runCliFailure([
    "plan",
    "--instance-dir",
    instanceDir,
    "--source",
    source,
    "--scope",
    "shared",
    "--include-secrets",
    "--cadence",
    "manual",
  ]);
  assert.match(sharedFailure, /private/);

  const planned = await runCli([
    "plan",
    "--instance-dir",
    instanceDir,
    "--source",
    source,
    "--scope",
    "private",
    "--include-secrets",
    "--cadence",
    "daily",
    "--at",
    "09:00",
  ]);
  assert.equal(planned.sources[0].includeSecrets, undefined);
  const plannedConfig = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(plannedConfig.contextSources[0].includeSecrets, true);
  assert.equal("path" in plannedConfig.syncPlan.sources[0], false);

  const synced = await runCli(["sync-due", "--instance-dir", instanceDir, "--now", localIso(2026, 11, 5, 10, 0)]);
  assert.equal(synced.status, "ok");
  assert.equal(synced.contextSources[0].secretsIncluded, true);
  assert.deepEqual(synced.contextSources[0].secretFiles, [".env"]);
  assert.equal(await readFile(join(instanceDir, "context/001-planned-source/.env"), "utf8"), "SECRET=1\n");

  // plan 视图按来源公开凭证复制状态，避免“没命中”被误读成“没开启”。
  const plannedAfterSync = await runCli(["plan", "--instance-dir", instanceDir]);
  assert.equal(plannedAfterSync.sources[0].secretsIncluded, true);
  assert.deepEqual(plannedAfterSync.sources[0].secretFiles, [".env"]);

  // 切回 shared 时撤销凭证复制，shared 永远不会携带敏感文件。
  const shared = await runCli([
    "plan",
    "--instance-dir",
    instanceDir,
    "--source",
    source,
    "--scope",
    "shared",
  ]);
  assert.equal(shared.sources[0].includeSecrets, undefined);
  const sharedConfig = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  assert.equal(sharedConfig.contextSources[0].includeSecrets, false);
});

test("导出团队包时发现敏感文件报错拒绝，不静默剔除", async (t) => {
  const root = await makeTempDir(t);
  const source = join(root, "shared-export");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "public.md"), "PUBLIC\n");
  const { instanceDir } = await createInstance(t, root, [{ path: source, scope: "shared" }]);
  await writeFile(join(instanceDir, "context/001-shared-export/.env"), "SECRET=1\n");
  const output = join(root, "team-instance.zip");

  const stderr = await runCliFailure(["export", "--instance-dir", instanceDir, "--output", output]);
  assert.match(stderr, /敏感文件/);
  assert.match(stderr, /\.env/);
  assert.equal(existsSync(output), false);
});

test("复制结果输出 excludedSensitive 文件名（最多 20 个 + total），status 同步暴露", async (t) => {
  const root = await makeTempDir(t);
  const source = join(root, "sensitive-source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "public.md"), "PUBLIC\n");
  for (let index = 0; index < 25; index += 1) {
    await writeFile(join(source, `.env.${index}`), `SECRET_${index}=1\n`);
  }
  const { instanceDir, result } = await createInstance(t, root, [{ path: source, scope: "private" }]);
  const entry = result.checks.contextSources[0];
  assert.equal(entry.excluded.sensitive, 25);
  assert.equal(entry.excludedSensitive.total, 25);
  assert.equal(entry.excludedSensitive.files.length, 20);
  assert.match(entry.excludedSensitive.files[0], /^\.env\./);
  assert.equal(existsSync(join(instanceDir, "context/001-sensitive-source/.env.0")), false);
  assert.equal(existsSync(join(instanceDir, "context/001-sensitive-source/public.md")), true);

  const status = await runCli(["status", "--instance-dir", instanceDir]);
  assert.deepEqual(status.coverage.sources[0].excludedSensitive, entry.excludedSensitive);
});

test("--include-secrets 未命中凭证文件时仍标 secretsIncluded:true", async (t) => {
  const root = await makeTempDir(t);
  const source = join(root, "clean-private");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "public.md"), "PUBLIC\n");
  const { instanceDir, result } = await createInstance(t, root, [{ path: source, scope: "private", includeSecrets: true }]);
  const entry = result.checks.contextSources[0];
  assert.equal(entry.status, "ok");
  assert.equal(entry.secretsIncluded, true);
  assert.deepEqual(entry.secretFiles, []);
  assert.equal(existsSync(join(instanceDir, "context/001-clean-private/public.md")), true);

  const status = await runCli(["status", "--instance-dir", instanceDir]);
  assert.equal(status.coverage.sources[0].secretsIncluded, true);
  assert.deepEqual(status.coverage.sources[0].secretFiles, []);
});

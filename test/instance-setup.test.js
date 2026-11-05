import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const setupSource = join(projectDir, "scripts/setup.js");

async function makeFixture(t, { dependencies = false, engines = ">=22.19.0" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "wsb-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(join(project, "scripts"), { recursive: true });
  await cp(setupSource, join(project, "scripts/setup.js"));
  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify({ name: "setup-fixture", private: true, engines: { node: engines } }, null, 2)}\n`,
  );
  await writeFile(join(project, "scripts/install-pi.sh"), "#!/bin/sh\necho install-pi-stub\n", { mode: 0o755 });
  if (dependencies) {
    await mkdir(join(project, "node_modules/@wecom/aibot-node-sdk"), { recursive: true });
    await writeFile(
      join(project, "node_modules/@wecom/aibot-node-sdk/package.json"),
      `${JSON.stringify({ name: "@wecom/aibot-node-sdk", version: "1.2.3" })}\n`,
    );
  }
  const home = join(root, "home");
  const binDir = join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(binDir, { recursive: true });
  return { root, project, home, binDir, callLog: join(root, "calls.log") };
}

async function fakeCommand(binDir, name, body) {
  const path = join(binDir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function writePi(path, version = "7.7.7", exitCode = 0) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    exitCode === 0 ? `#!/bin/sh\necho "${version}"\n` : `#!/bin/sh\necho "pi broke" >&2\nexit ${exitCode}\n`,
  );
  await chmod(path, 0o755);
}

async function runSetup(fixture, args, extraEnv = {}) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [join(fixture.project, "scripts/setup.js"), ...args], {
      cwd: fixture.project,
      env: {
        ...process.env,
        HOME: fixture.home,
        PATH: fixture.binDir,
        WECOM_BOT_PI_BINARY: "",
        CALL_LOG: fixture.callLog,
        ...extraEnv,
      },
    });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code ?? 1, json: error.stdout ? JSON.parse(error.stdout) : null, stderr: String(error.stderr ?? "") };
  }
}

async function toolBinaries(binDir) {
  await fakeCommand(binDir, "python3", 'echo "Python 3.12.1"');
  await fakeCommand(binDir, "zip", 'echo "This is Zip 3.0 (July 5th 2008)"');
  await fakeCommand(binDir, "unzip", 'echo "UnZip 6.00 of 20 April 2009"');
}

test("setup --check 全就绪时 readyToInit=true 且不调用安装命令", async (t) => {
  const fixture = await makeFixture(t, { dependencies: true });
  const pi = await fakeCommand(fixture.binDir, "pi", 'echo "7.7.7"');
  await fakeCommand(fixture.binDir, "npm", `echo "$@" >> "$CALL_LOG"`);
  await toolBinaries(fixture.binDir);

  const result = await runSetup(fixture, ["--check"], { WECOM_BOT_PI_BINARY: pi });
  assert.equal(result.code, 0);
  assert.equal(result.json.readyToInit, true);
  assert.equal(result.json.status, "ok");
  assert.equal(result.json.node.status, "ok");
  assert.equal(result.json.dependencies.status, "ok");
  assert.equal(result.json.dependencies.version, "1.2.3");
  assert.equal(result.json.pi.status, "ok");
  assert.equal(result.json.pi.version, "7.7.7");
  assert.equal(result.json.tools.python3.version, "3.12.1");
  assert.equal(result.json.tools.zip.version, "3.0");
  assert.equal(result.json.tools.unzip.version, "6.00");
  assert.equal(existsSync(fixture.callLog), false);
});

test("setup 缺依赖时未同意不安装，同意后执行 npm install 并复检", async (t) => {
  const fixture = await makeFixture(t);
  const pi = await fakeCommand(fixture.binDir, "pi", 'echo "7.7.7"');
  await fakeCommand(
    fixture.binDir,
    "npm",
    `echo "$@" >> "$CALL_LOG"
mkdir -p node_modules/@wecom/aibot-node-sdk
printf '{"version":"9.9.9"}\\n' > node_modules/@wecom/aibot-node-sdk/package.json`,
  );
  await toolBinaries(fixture.binDir);
  const env = { WECOM_BOT_PI_BINARY: pi, PATH: `${fixture.binDir}:${process.env.PATH}` };

  const checked = await runSetup(fixture, ["--check", "--allow-install"], env);
  assert.equal(checked.code, 0);
  assert.equal(checked.json.dependencies.status, "missing");
  assert.match(checked.json.dependencies.note, /--check 只检查不安装/);
  assert.equal(existsSync(fixture.callLog), false);

  const noConsent = await runSetup(fixture, [], env);
  assert.equal(noConsent.code, 1);
  assert.equal(noConsent.json.readyToInit, false);
  assert.equal(noConsent.json.dependencies.status, "missing");
  assert.match(noConsent.json.dependencies.note, /--allow-install/);
  assert.equal(existsSync(fixture.callLog), false);

  const installed = await runSetup(fixture, ["--allow-install"], env);
  assert.equal(installed.code, 0);
  assert.equal(installed.json.readyToInit, true);
  assert.equal(installed.json.dependencies.status, "installed");
  assert.equal(installed.json.dependencies.version, "9.9.9");
  assert.equal((await readFile(fixture.callLog, "utf8")).trim(), "install");
});

test("setup 缺 pi 时未同意不安装，同意后调用 install-pi.sh 并验证 pi --version", async (t) => {
  const fixture = await makeFixture(t, { dependencies: true });
  await toolBinaries(fixture.binDir);
  await fakeCommand(
    fixture.binDir,
    "bash",
    `echo "$@" >> "$CALL_LOG"
mkdir -p "$HOME/.pi-support/bin"
printf '#!/bin/sh\\necho "7.7.7"\\n' > "$HOME/.pi-support/bin/pi"
chmod +x "$HOME/.pi-support/bin/pi"`,
  );
  const env = { PATH: `${fixture.binDir}:${process.env.PATH}` };

  const checked = await runSetup(fixture, ["--check"], env);
  assert.equal(checked.code, 0);
  assert.equal(checked.json.pi.status, "missing");
  assert.match(checked.json.pi.note, /--check 只检查不安装/);
  assert.equal(existsSync(fixture.callLog), false);

  const noConsent = await runSetup(fixture, [], env);
  assert.equal(noConsent.code, 1);
  assert.equal(noConsent.json.pi.status, "missing");
  assert.match(noConsent.json.pi.note, /--allow-install/);
  assert.equal(existsSync(fixture.callLog), false);

  const installed = await runSetup(fixture, ["--allow-install"], env);
  assert.equal(installed.code, 0);
  assert.equal(installed.json.pi.status, "installed");
  assert.equal(installed.json.pi.version, "7.7.7");
  assert.equal(installed.json.readyToInit, true);
  const calls = (await readFile(fixture.callLog, "utf8")).trim().split("\n");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/scripts\/install-pi\.sh$/);
});

test("setup 安装后 pi --version 验证失败时整体失败", async (t) => {
  const fixture = await makeFixture(t, { dependencies: true });
  await toolBinaries(fixture.binDir);
  await fakeCommand(
    fixture.binDir,
    "bash",
    `echo "$@" >> "$CALL_LOG"
mkdir -p "$HOME/.pi-support/bin"
printf '#!/bin/sh\\necho "pi broke" >&2\\nexit 3\\n' > "$HOME/.pi-support/bin/pi"
chmod +x "$HOME/.pi-support/bin/pi"`,
  );

  const result = await runSetup(fixture, ["--allow-install"], { PATH: `${fixture.binDir}:${process.env.PATH}` });
  assert.equal(result.code, 1);
  assert.equal(result.json.readyToInit, false);
  assert.equal(result.json.status, "error");
  assert.equal(result.json.pi.status, "error");
  assert.match(result.json.pi.note, /验证失败/);
});

test("setup 只报告缺失的系统工具并说明受影响能力", async (t) => {
  const fixture = await makeFixture(t, { dependencies: true });
  const pi = await fakeCommand(fixture.binDir, "pi", 'echo "7.7.7"');

  const result = await runSetup(fixture, ["--check"], { WECOM_BOT_PI_BINARY: pi });
  assert.equal(result.code, 0);
  assert.equal(result.json.readyToInit, true);
  for (const name of ["python3", "zip", "unzip"]) {
    assert.equal(result.json.tools[name].status, "missing");
    assert.match(result.json.tools[name].note, /不会自动安装系统包/);
  }
  assert.match(result.json.tools.python3.note, /BI/);
  assert.match(result.json.tools.zip.note, /资源包/);
  assert.match(result.json.tools.unzip.note, /资源包/);
});

test("setup 在 Node 低于 engines 时直接失败并给升级命令", async (t) => {
  const fixture = await makeFixture(t, { engines: ">=99.0.0" });

  const result = await runSetup(fixture, ["--check"]);
  assert.equal(result.code, 1);
  assert.equal(result.json.readyToInit, false);
  assert.equal(result.json.status, "error");
  assert.equal(result.json.node.status, "error");
  assert.match(result.json.node.note, /99\.0\.0/);
  assert.match(result.json.node.action, /升级 Node/);
  for (const item of [result.json.node, result.json.dependencies, result.json.pi, ...Object.values(result.json.tools)]) {
    assert.equal(typeof item.status, "string");
    assert.equal("version" in item, true);
    assert.equal("action" in item, true);
    assert.equal("note" in item, true);
  }
  assert.equal(result.json.dependencies.status, "missing");
  assert.match(result.json.dependencies.note, /Node 版本不满足/);
  assert.equal(result.json.pi.status, "missing");
  assert.equal(Object.keys(result.json.tools).length, 3);
});

test("setup 未知选项也输出完整检查形状", async (t) => {
  const fixture = await makeFixture(t, { dependencies: true });
  const result = await runSetup(fixture, ["--json"]);
  assert.equal(result.code, 1);
  assert.equal(result.json.status, "error");
  assert.equal(result.json.readyToInit, false);
  for (const key of ["node", "dependencies", "pi", "tools"]) {
    assert.equal(typeof result.json[key], "object");
  }
  assert.deepEqual(Object.keys(result.json.tools).sort(), ["python3", "unzip", "zip"]);
  assert.match(result.json.node.note, /安装前检查失败/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectDir, "scripts/local-instance.js");
const setupPath = join(projectDir, "scripts/setup.js");
const initializationPath = join(projectDir, "docs/agents/initialization.md");

async function initializationDocument() {
  return readFile(initializationPath, "utf8");
}

async function runNode(script, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd: projectDir }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

test("initialization.md 提到的 instance 命令都在 CLI 支持列表内", async () => {
  const document = await initializationDocument();
  const documented = [...document.matchAll(/npm run instance -- ([a-z][a-z0-9-]*)/g)].map((match) => match[1]);
  assert.ok(documented.length > 0, "初始化文档应包含可执行命令");

  const usage = await runNode(cliPath, []);
  const match = usage.stderr.match(/用法：local-instance\.js ([a-z|-]+) \[选项\]/);
  assert.ok(match, `无法从 CLI 读取支持列表：${usage.stderr}`);
  const supported = new Set(match[1].split("|"));
  for (const command of new Set(documented)) {
    assert.equal(supported.has(command), true, `文档命令未在 CLI 支持列表内：${command}`);
  }
});

test("initialization.md 提到的 setup 开关都被 setup 接受", async () => {
  const document = await initializationDocument();
  const commands = [...document.matchAll(/npm run setup -- ([^\n`]+)/g)].map((match) => match[1]);
  assert.ok(commands.length > 0, "初始化文档应包含 setup 命令");
  const help = await runNode(setupPath, ["--help"]);
  assert.equal(help.code, 0);
  for (const command of commands) {
    for (const flag of command.split(/\s+/).filter((token) => token.startsWith("--"))) {
      assert.match(help.stdout, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `setup 未接受文档开关：${flag}`);
    }
  }
});

test("core.md 与 local-instance.md 都包含图片降级话术铁律", async () => {
  for (const promptFile of ["prompts/core.md", "prompts/local-instance.md"]) {
    const prompt = await readFile(join(projectDir, promptFile), "utf8");
    assert.match(
      prompt,
      /图这边打不开，麻烦把截图里的关键文字（报错、菜单名、数字）贴给我/,
      `${promptFile} 应包含标准图片降级话术`,
    );
    assert.match(
      prompt,
      /不得解释打不开的原因，不得提及模型、机器人、版本或内部实现/,
      `${promptFile} 应禁止解释原因与提及内部实现`,
    );
  }
});

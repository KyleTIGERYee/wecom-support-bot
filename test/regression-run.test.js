import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const regressionCli = join(projectDir, "scripts/regression-run.js");

async function makeTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "wsb-regression-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}


/** 默认模式的根目录不再写死在仓库里；测试用临时知识库与代码仓目录。 */
async function makeDefaultRoots(t) {
  const root = await makeTempDir(t);
  const knowledgeBase = join(root, "知识库");
  const ajlyCode = join(root, "ajly");
  const lzzCode = join(root, "lezuzu");
  const { mkdir } = await import("node:fs/promises");
  await Promise.all([
    mkdir(join(knowledgeBase, "数据库/ajly-db-wiki/scripts"), { recursive: true }),
    mkdir(join(knowledgeBase, "数据库/lzz-db-wiki/scripts"), { recursive: true }),
    mkdir(join(knowledgeBase, "业务/ajly-wiki/scripts"), { recursive: true }),
    mkdir(join(knowledgeBase, "业务/lzz-wiki/scripts"), { recursive: true }),
    mkdir(ajlyCode, { recursive: true }),
    mkdir(lzzCode, { recursive: true }),
  ]);
  return { root, knowledgeBase, ajlyCode, lzzCode, env: { WECOM_BOT_ROOTS: JSON.stringify({ knowledgeBase, ajlyCode, lzzCode }) } };
}

test("默认回归目录公开来源时间、有效状态和业务 Wiki 的 raw_base", async (t) => {
  const root = await makeTempDir(t);
  const fakePi = join(root, "fake-pi.js");
  const piLog = join(root, "pi-log.jsonl");
  const out = join(root, "result.json");
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const prompt = process.argv.at(-1);
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ prompt }) + "\\n");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "在的" }] } }));
`,
    { mode: 0o755 },
  );

  const roots = await makeDefaultRoots(t);
  await execFileAsync(process.execPath, [regressionCli, "--only", "Q2", "--out", out], {
    cwd: projectDir,
    env: { ...process.env, ...roots.env, WECOM_BOT_PI_BINARY: fakePi, FAKE_PI_LOG: piLog },
  });

  const [record] = JSON.parse(await readFile(out, "utf8"));
  assert.equal(record.answer, "在的");
  const calls = (await readFile(piLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 1);
  const catalogLines = calls[0].prompt.split("\n").filter((line) => line.startsWith("- source:"));
  assert.equal(catalogLines.length, 7);
  for (const line of catalogLines) {
    assert.match(line, /source_time: null/);
    assert.match(line, /validity: unmarked/);
  }
  for (const line of catalogLines.filter((entry) => entry.includes("业务 Wiki"))) {
    assert.match(line, /raw_base: .+?(?:ajly|lzz)-wiki/);
  }
});

test("回归加载记录区分查数手册、指标卡、表文档与 SQL", async (t) => {
  const root = await makeTempDir(t);
  const fakePi = join(root, "fake-pi.js");
  const out = join(root, "result.json");
  const roots = await makeDefaultRoots(t);
  const dbRoot = join(roots.knowledgeBase, "数据库/lzz-db-wiki");
  const paths = [
    join(projectDir, "prompts/data-playbook.md"),
    join(dbRoot, ".lzz-db-wiki-evolution/common/机构经验.md"),
    join(dbRoot, "metrics/机构总数及类型分布.md"),
    join(dbRoot, "tables/ajly_flow/system_tenant.md"),
    join(dbRoot, "queries/机构总数.sql"),
  ];
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
const paths = ${JSON.stringify(paths)};
for (const [index, path] of paths.entries()) {
  console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "read-" + index, toolName: "read", args: { path } }));
  console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "read-" + index, toolName: "read", result: path.endsWith(".sql") ? { content: "-- ✅ 已验证" } : {}, isError: false }));
}
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "regression-bi", toolName: "bash", args: { command: "python3 /local/scripts/bi_query.py SELECT" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "regression-bi", toolName: "bash", result: { content: [{ type: "text", text: "56" }] }, isError: false }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "56 家" }] } }));
`,
    { mode: 0o755 },
  );

  await execFileAsync(process.execPath, [regressionCli, "--only", "Q8", "--out", out], {
    cwd: projectDir,
    env: { ...process.env, ...roots.env, WECOM_BOT_PI_BINARY: fakePi },
  });

  const [record] = JSON.parse(await readFile(out, "utf8"));
  assert.deepEqual(record.loadedResources.map((resource) => resource.depth), ["playbook", "experience", "metrics", "table", "sql"]);
  assert.deepEqual(record.loadedResources.map((resource) => resource.resourceType), ["playbook", "experience", "metrics", "table", "sql"]);
  assert.equal(record.loadedResources.at(-1).verification, "verified");
  assert.equal(record.answer, "56 家");
  assert.equal(record.biTouched, true);
  assert.equal(record.loadDepth, "sql");
});

test("具体规则回归经过同一会话的概念不足与 raw 深化链", async (t) => {
  const root = await makeTempDir(t);
  const fakePi = join(root, "fake-pi.js");
  const piLog = join(root, "pi-log.jsonl");
  const out = join(root, "result.json");
  const roots = await makeDefaultRoots(t);
  const wikiRoot = join(roots.knowledgeBase, "业务/ajly-wiki");
  const conceptPath = join(wikiRoot, "wiki/概念/自助看房.md");
  const rawPath = join(wikiRoot, "raw/自助看房/预约规则.md");
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const prompt = process.argv.at(-1);
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ prompt }) + "\\n");
const deepened = prompt.includes("原始问题：") && prompt.includes("raw 原始资料");
const path = deepened ? ${JSON.stringify(rawPath)} : ${JSON.stringify(conceptPath)};
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "read-rule", toolName: "read", args: { path } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "read-rule", toolName: "read", result: {}, isError: false }));
const text = deepened ? "最多提前 7 天预约。" : "CONTEXT_INSUFFICIENT\\n概念页没有提前天数";
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }));
`,
    { mode: 0o755 },
  );

  await execFileAsync(process.execPath, [regressionCli, "--only", "Q4", "--out", out], {
    cwd: projectDir,
    env: { ...process.env, ...roots.env, WECOM_BOT_PI_BINARY: fakePi, FAKE_PI_LOG: piLog },
  });

  const [record] = JSON.parse(await readFile(out, "utf8"));
  assert.equal(record.answer, "最多提前 7 天预约。");
  assert.deepEqual(record.loadedResources.map((resource) => resource.depth), ["concept", "raw"]);
  assert.equal(record.loadDepth, "raw");
  const calls = (await readFile(piLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /raw 原始资料/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

async function makeTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "wsb-inventory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

test("inventory 分类知识、Skills、知识库、代码与历史来源", async (t) => {
  const root = await makeTempDir(t);
  const knowledge = join(root, "knowledge");
  const skills = join(root, "skills");
  const database = join(root, "database");
  const code = join(root, "code");
  const history = join(root, "history");
  await write(join(knowledge, "wiki/concept.md"), "概念\n");
  await write(join(knowledge, "raw/inbox.md"), "原始记录\n");
  await mkdir(knowledge, { recursive: true });
  await write(join(knowledge, "概念总览.md"), "概念\n");
  await write(join(skills, "document-delivery/SKILL.md"), "---\nname: document-delivery\ndescription: 文档\n---\n正文\n");
  await write(join(skills, "document-delivery/reference.md"), "参考\n");
  await write(join(database, "metrics/order.md"), "指标\n");
  await write(join(database, "queries/orders.sql"), "select 1;\n");
  await write(join(database, "tables/order.md"), "表\n");
  await mkdir(join(code, ".git"), { recursive: true });
  await write(join(code, ".git/HEAD"), "ref: refs/heads/main\n");
  await write(join(code, "package.json"), "{}\n");
  await write(join(code, "src/index.js"), "console.log(1);\n");
  await write(join(history, "时间线.md"), "时间线\n");
  await write(join(history, "projects/current.md"), "当前进展\n");

  const result = await runCli([
    "inventory",
    "--root",
    knowledge,
    "--root",
    skills,
    "--root",
    database,
    "--root",
    code,
    "--root",
    history,
  ]);
  const byName = Object.fromEntries(result.candidates.map((candidate) => [candidate.name, candidate]));

  assert.equal(byName.knowledge.kind, "knowledge");
  assert.equal(byName.knowledge.files, 3);
  assert.equal(byName.knowledge.resourceTypes.raw, 1);
  assert.equal(byName.knowledge.resourceTypes.concepts, 2);
  assert.equal(byName.knowledge.recommended.scope, "shared");
  assert.deepEqual(byName.knowledge.recommended.cadence, { kind: "daily", at: "09:00" });

  assert.equal(byName.skills.kind, "skills");
  assert.equal(byName.skills.skills, 1);
  assert.deepEqual(byName.skills.skillNames, ["document-delivery"]);
  assert.equal(byName.skills.files, 2);

  assert.equal(byName.database.kind, "knowledge-db");
  assert.equal(byName.database.resourceTypes.metrics, 1);
  assert.equal(byName.database.resourceTypes.sql, 1);
  assert.equal(byName.database.resourceTypes.tables, 1);

  assert.equal(byName.code.kind, "code");
  assert.equal(byName.code.files, 2);
  assert.equal(byName.code.recommended.scope, "private");
  assert.equal(byName.code.recommended.cadence.kind, "weekly");
  assert.match(byName.code.recommended.reason, /代码仓库/);

  assert.equal(byName.history.kind, "history");
  assert.equal(byName.history.resourceTypes.timeline, 1);
  assert.equal(byName.history.resourceTypes.projects, 1);
  assert.equal(byName.history.recommended.cadence.kind, "weekly");

  assert.equal(result.totals.candidates, 5);
  assert.equal(result.totals.skills, 1);
  assert.equal(result.totals.included, 5);
});

test("inventory 报告敏感文件、软链与单文件来源，不读文件正文", async (t) => {
  const root = await makeTempDir(t);
  const sensitiveRoot = join(root, "sensitive");
  await write(join(sensitiveRoot, "normal.md"), "正常资料\n");
  await write(join(sensitiveRoot, ".env"), "SECRET=1\n");
  await write(join(sensitiveRoot, "secrets.json"), "{}\n");
  await write(join(sensitiveRoot, "sub/.npmrc"), "token\n");
  await write(join(sensitiveRoot, "id_rsa"), "PRIVATE KEY\n");
  await write(join(sensitiveRoot, "service.pem"), "pem\n");
  const unreadable = join(sensitiveRoot, "unreadable.md");
  await write(unreadable, "内容不会被读取\n");
  await chmod(unreadable, 0o000);

  const linksRoot = join(root, "links");
  await write(join(linksRoot, "inside.md"), "内部\n");
  await write(join(linksRoot, ".env"), "SECRET=1\n");
  await symlink(join(linksRoot, "inside.md"), join(linksRoot, "inside-link.md"));
  await symlink("/etc/hosts", join(linksRoot, "outside-link.md"));
  await symlink(join(linksRoot, "missing.md"), join(linksRoot, "broken-link.md"));
  await symlink(join(linksRoot, ".env"), join(linksRoot, "notes.md"));

  const onlySecret = join(root, "only-secret");
  await write(join(onlySecret, ".env"), "SECRET=1\n");

  const singleFile = join(root, "single.md");
  await write(singleFile, "单文件\n");

  const result = await runCli([
    "inventory",
    "--root",
    sensitiveRoot,
    "--root",
    linksRoot,
    "--root",
    onlySecret,
    "--root",
    singleFile,
    "--root",
    join(root, "missing-source"),
  ]);
  const byName = Object.fromEntries(result.candidates.map((candidate) => [candidate.name, candidate]));

  assert.equal(byName.sensitive.sensitive.count, 5);
  assert.deepEqual(byName.sensitive.sensitive.files.sort(), [".env", "id_rsa", "secrets.json", "service.pem", "sub/.npmrc"]);
  assert.equal(byName.sensitive.totalFiles, 7);
  assert.equal(byName.sensitive.files, 2);
  assert.match(byName.sensitive.recommended.reason, /敏感文件/);
  assert.equal(byName.sensitive.recommended.include, true);

  // 软链按 follow 计入实际复制量：inside.md + inside-link.md + outside-link.md。
  assert.equal(byName.links.totalFiles, 5);
  assert.equal(byName.links.files, 3);
  assert.equal(byName.links.symlinks.count, 4);
  assert.equal(byName.links.symlinks.followedOutsideRoot, 1);
  assert.equal(byName.links.symlinks.broken, 1);
  // 链接名与目标名都参与敏感检测，notes.md -> .env 不会把凭证带进副本。
  assert.equal(byName.links.sensitive.count, 2);
  assert.deepEqual(byName.links.sensitive.files.sort(), [".env", "notes.md"]);
  assert.equal(byName.links.recommended.scope, "private");
  assert.equal(byName.links.recommended.symlinks, "follow");
  assert.match(byName.links.recommended.reason, /根之外|根外/);

  assert.equal(byName["only-secret"].totalFiles, 1);
  assert.equal(byName["only-secret"].files, 0);
  assert.equal(byName["only-secret"].recommended.include, false);
  assert.match(byName["only-secret"].recommended.reason, /排除 1 个敏感文件后没有可同步的普通文件/);

  assert.equal(byName["single.md"].kind, "file");
  assert.equal(byName["single.md"].files, 1);
  assert.equal(byName["single.md"].totalFiles, 1);
  assert.deepEqual(byName["single.md"].recommended.cadence, { kind: "manual" });

  assert.equal(byName["missing-source"].type, "missing");
  assert.equal(byName["missing-source"].recommended.include, false);
  assert.match(byName["missing-source"].blockers[0], /不存在|不可访问/);
});

test("inventory 混合来源给 mixed，软链目录跟随并防环，--max-depth 会改变分类", async (t) => {
  const root = await makeTempDir(t);
  const mixed = join(root, "mixed");
  await write(join(mixed, "wiki/concept.md"), "概念\n");
  await write(join(mixed, ".git/HEAD"), "ref: refs/heads/main\n");
  await write(join(mixed, "package.json"), "{}\n");
  await write(join(mixed, "plugins/demo/SKILL.md"), "---\nname: demo\n---\n正文\n");
  await mkdir(join(mixed, "docs"), { recursive: true });
  await write(join(mixed, "docs/guide.md"), "指南\n");
  await symlink(join(mixed, "docs"), join(mixed, "linkdocs"));
  await symlink(".", join(mixed, "loop"));

  const deep = join(root, "deep");
  await write(join(deep, "top.md"), "顶层\n");
  await write(join(deep, "a/b/wiki/concept.md"), "深层概念\n");

  const result = await runCli(["inventory", "--root", mixed, "--root", deep]);
  const byName = Object.fromEntries(result.candidates.map((candidate) => [candidate.name, candidate]));

  assert.equal(byName.mixed.kind, "mixed");
  assert.deepEqual(byName.mixed.kinds, ["skills", "knowledge", "code"]);
  assert.match(byName.mixed.kindNote, /mixed/);
  assert.equal(byName.mixed.files, 5);
  assert.equal(byName.mixed.symlinks.count, 2);
  assert.equal(byName.mixed.symlinks.loops, 1);
  assert.equal(byName.mixed.recommended.scope, "private");
  assert.equal(byName.mixed.recommended.cadence.kind, "weekly");

  const shallow = await runCli(["inventory", "--root", deep, "--max-depth", "1"]);
  assert.equal(shallow.candidates[0].files, 1);
  assert.equal(shallow.candidates[0].kind, "generic");
  assert.ok(shallow.candidates[0].blockers.some((blocker) => /--max-depth 1/.test(blocker)));

  const full = await runCli(["inventory", "--root", deep]);
  assert.equal(full.candidates[0].files, 2);
  assert.equal(full.candidates[0].kind, "knowledge");
});

test("inventory 接受与复制一致的 --exclude 与 --symlinks，files 与实际复制量同义", async (t) => {
  const root = await makeTempDir(t);
  const source = join(root, "source");
  await write(join(source, "note.md"), "NOTE\n");
  await write(join(source, "private/skip.md"), "SKIP\n");
  await write(join(source, "node_modules/x.js"), "X\n");
  await write(join(source, ".env"), "SECRET=1\n");
  await symlink(join(source, "note.md"), join(source, "link.md"));

  const skipped = await runCli([
    "inventory",
    "--root",
    source,
    "--exclude",
    "private/**",
    "--symlinks",
    "skip",
  ]);
  const candidate = skipped.candidates[0];
  // note.md 会复制；private/** 与 node_modules 被排除；link.md 按 skip 跳过；.env 敏感排除。
  assert.equal(candidate.files, 1);
  assert.equal(candidate.bytes, "NOTE\n".length);
  assert.equal(candidate.totalFiles, 3);
  assert.equal(candidate.symlinks.count, 1);
  assert.equal(candidate.symlinks.skipped, 1);
  assert.equal(candidate.symlinks.followed, 0);
  assert.equal(candidate.symlinks.supported, undefined);
  assert.equal(candidate.includedFiles, undefined);
  assert.match(candidate.recommended.reason, /--symlinks skip/);

  const followed = await runCli(["inventory", "--root", source, "--exclude", "private/**"]);
  assert.equal(followed.candidates[0].files, 2);
  assert.equal(followed.candidates[0].symlinks.followed, 1);
  assert.equal(followed.candidates[0].recommended.symlinks, "follow");

  const rejected = await runCli(["inventory", "--root", source, "--symlinks", "reject"]);
  assert.equal(rejected.candidates[0].files, 0);
  assert.equal(rejected.candidates[0].recommended.include, false);
  assert.match(rejected.candidates[0].blockers.join("；"), /符号链接/);
});

test("inventory 拒绝含 userinfo 的来源地址且不回显凭证", async () => {
  const password = "inv-password-should-not-leak";
  const credentialed = `https://inventory-user:${password}@gitlab.example.invalid/team/repo.git`;
  const failure = await execFileAsync(process.execPath, [cliPath, "inventory", "--root", credentialed], {
    cwd: projectDir,
  }).then(
    () => ({ failed: false, stdout: "", stderr: "" }),
    (error) => ({ failed: true, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") }),
  );
  assert.equal(failure.failed, true);
  assert.match(failure.stderr, /内嵌凭证|无凭据/);
  assert.equal(failure.stderr.includes(password), false);
  assert.equal(failure.stderr.includes("inventory-user"), false);
  assert.equal(failure.stdout.trim(), "");
});

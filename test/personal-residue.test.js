import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { decodeTextForScan, findAllPersonalResidue } from "../scripts/personal-residue.js";

// 个人残留守卫：仓库对公司内部开源后，tracked/未跟踪文件与 Windows 安装包都不得带个人称呼/昵称、
// 本机用户路径、私人局域网地址。禁词表与安装包共用 scripts/personal-residue.js；
// 本文件里的禁词样本一律用转义或拼接书写，避免守卫自身命中。

const execFileAsync = promisify(execFile);
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectDir, "scripts/windows-instance.js");
/** git 不可用时（例如从压缩包解压）回退扫描整个目录，跳过 .gitignore 对应的本机运行数据与依赖目录。 */
const FALLBACK_SKIP_DIRS = new Set([".git", "node_modules", "data", "logs", ".scratch", "instances", "launchd"]);
const FALLBACK_SKIP_FILES = /^(?:secrets.*\.json|.*\.log)$/;

async function listFilesRecursive(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!FALLBACK_SKIP_DIRS.has(entry.name)) result.push(...(await listFilesRecursive(child)));
    } else if (entry.isFile() && !FALLBACK_SKIP_FILES.test(entry.name)) {
      result.push(child);
    }
  }
  return result;
}

/**
 * 扫描 tracked 与未跟踪（未被 ignore）的文件：只看 `git ls-files` 会漏掉尚未 add 的新文件，
 * 而新文件最可能带个人路径。没有 git 时回退扫描目录，保证守卫不会静默失效。
 * `gitEnv` 只用于测试“无 git”回退路径。
 */
async function repositoryFiles({ gitEnv = process.env } = {}) {
  try {
    const stdout = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv });
    return stdout.split("\0").filter(Boolean).map((name) => join(projectDir, name));
  } catch {
    return listFilesRecursive(projectDir);
  }
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/** 逐文件逐行扫描，返回 `相对路径:行号 命中<类别> → <修复方式>` 列表，便于直接定位修复。 */
async function findResidueLines(files, baseDir) {
  const hits = [];
  for (const path of files) {
    let buffer;
    try {
      buffer = await readFile(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    // 带 BOM 的 UTF-16 文本含 NUL 字节，不能按二进制跳过；其余含 NUL 的文件才视为二进制。
    if (isBinary(buffer) && !hasUtf16Bom(buffer)) continue;
    const name = relative(baseDir, path).split(sep).join("/");
    decodeTextForScan(buffer).split("\n").forEach((line, index) => {
      for (const { label, fix } of findAllPersonalResidue(line)) hits.push(`${name}:${index + 1} 命中${label} → ${fix}`);
    });
  }
  return hits;
}

function hasUtf16Bom(buffer) {
  return buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff));
}

function report(hits) {
  return `发现 ${hits.length} 处个人残留，请按下列提示改为通用称呼/占位路径后再提交：\n${hits.join("\n")}`;
}

test("禁词规则能识别每类个人残留，且守卫自身不会命中", async () => {
  const samples = [
    ["\u864e\u8001\u5e08", "个人称呼"],
    ["\u8d5b\u535a\u963f\u864e", "个人昵称"],
    ["\u963f\u864e", "个人昵称"],
    ["com.k" + "yle.wecom-support-bot", "launchd"],
    ["com.k" + "yle-support-bot", "launchd"],
    ["COM.K" + "YLE", "launchd"],
    ["/Users/k" + "yle/Desktop/x", "本机路径"],
    ["/users/K" + "YLE/desktop", "本机路径"],
    ["/ho" + "me/k" + "yle/.pi/agent", "本机路径"],
    // Windows 与 WSL 视角的路径（反斜杠 / 正斜杠都算）。
    ["C:\\Users\\k" + "yle\\AppData\\Local", "本机路径"],
    ["c:/Users/k" + "yle/Desktop/x", "本机路径"],
    ["\\\\wsl$\\Ubuntu-24.04\\ho" + "me\\k" + "yle/.pi", "本机路径"],
    ["http://192.168.1." + "20:3425/v1", "局域网"],
    ["http://192.168.1." + "23:4319", "局域网"],
    ["cat ~k" + "yle/.pi/agent/models.json", "主目录"],
    ["cd ~K" + "YLE", "主目录"],
  ];
  for (const [text, label] of samples) {
    assert.ok(findAllPersonalResidue(text).some((hit) => hit.label.includes(label)), `规则应识别：${text}`);
  }
  const clean = [
    "建议直接问技术同事。",
    "http://10.0.0.1:3425/v1",
    "cat ~someone/.pi/agent/models.json",
    "/tmp/fixture/wecom-support-bot",
    "com.wecom-support-bot",
    "/home/wecom/app",
    "C:\\Users\\Public\\Documents",
    // 更长的无关标识不得被词边界误报。
    "/Users/k" + "yleigh",
    "com.k" + "yleigh.service",
    "/ho" + "me/k" + "yleigh/app",
    "119" + "2.168.1.20",
    "192.168.1." + "20.example",
    "192.168.1." + "201",
    "cat ~k" + "yleigh",
  ];
  for (const text of clean) {
    assert.deepEqual(findAllPersonalResidue(text), [], `不应误报：${text}`);
  }
  for (const guardFile of ["test/personal-residue.test.js", "scripts/personal-residue.js"]) {
    assert.deepEqual(await findResidueLines([join(projectDir, guardFile)], projectDir), [], `守卫文件不得自命中：${guardFile}`);
  }
});

test("仓库 tracked 与未跟踪文件不含个人称呼、本机路径与私人地址", async () => {
  const files = await repositoryFiles();
  assert.ok(files.length > 10, "应扫描到仓库文件");
  assert.ok(files.some((path) => path.endsWith(join("scripts", "personal-residue.js"))), "尚未 add 的新文件也要在扫描范围内");
  const hits = await findResidueLines(files, projectDir);
  assert.deepEqual(hits, [], report(hits));
});

test("git 不可用时回退扫描目录：跳过依赖/运行数据/凭证文件，不读取 secrets，仍能发现未跟踪文件里的残留", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wsb-residue-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 用 PATH 为空的环境让 git 必然找不到，迫使 repositoryFiles 走目录回退。
  const noGit = await repositoryFiles({ gitEnv: { ...process.env, PATH: "", GitBin: "" } });
  assert.ok(noGit.length > 10, "无 git 时也应扫描到仓库文件");
  assert.equal(noGit.some((path) => /\/node_modules\//.test(path)), false);
  assert.equal(noGit.some((path) => /\/\.git\//.test(path)), false);
  assert.equal(noGit.some((path) => /\/secrets[^/]*\.json$/.test(path)), false, "回退路径不得读取本机凭证文件");
  assert.ok(noGit.some((path) => path.endsWith(join("scripts", "personal-residue.js"))));
  const hits = await findResidueLines(noGit, projectDir);
  assert.deepEqual(hits, [], report(hits));

  // 回退扫描的跳过规则与命中定位：只有未忽略的普通文件会被报告，且定位到行。
  const tree = join(root, "tree");
  const personal = "/Users/k" + "yle/x";
  await mkdir(join(tree, "node_modules/pkg"), { recursive: true });
  await mkdir(join(tree, "data"), { recursive: true });
  await mkdir(join(tree, "config"), { recursive: true });
  await mkdir(join(tree, "docs"), { recursive: true });
  await writeFile(join(tree, "node_modules/pkg/index.js"), personal);
  await writeFile(join(tree, "data/inbox.jsonl"), personal);
  await writeFile(join(tree, "config/secrets.json"), personal);
  await writeFile(join(tree, "config/secrets.dev.json"), personal);
  await writeFile(join(tree, "config/secrets.dev.json.example"), "PLACEHOLDER\n");
  await writeFile(join(tree, "run.log"), personal);
  await writeFile(join(tree, "docs/new-notes.md"), `本机路径：${personal}\n第二行干净\n`);
  await writeFile(join(tree, "image.bin"), Buffer.from([0, 1, 2, 0x2f]));
  const files = await listFilesRecursive(tree);
  assert.deepEqual(files.map((path) => relative(tree, path)).sort(), ["config/secrets.dev.json.example", "docs/new-notes.md", "image.bin"]);
  assert.deepEqual(await findResidueLines(files, tree), ["docs/new-notes.md:1 命中个人本机路径 → 改为 /tmp/fixture/... 等占位路径、相对路径或由 import.meta.url 推导"]);
});

test("非 UTF-8 文本不会被跳过：GBK 与带 BOM 的 UTF-16 同样能扫出个人残留", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wsb-residue-encoding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = "\u864e\u8001\u5e08";
  const path = "/Users/k" + "yle/Desktop/x";
  // GBK 字节由 `printf '…' | iconv -f UTF-8 -t GBK | xxd` 得到：名称 + 空格 + “负责人” + 换行。
  const files = {
    "gbk.md": Buffer.from([0xbb, 0xa2, 0xc0, 0xcf, 0xca, 0xa6, 0x20, 0xb8, 0xba, 0xd4, 0xf0, 0xc8, 0xcb, 0x0a]),
    "utf16le.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`路径 ${path}\n`, "utf16le")]),
    "latin1.txt": Buffer.concat([Buffer.from([0xe9, 0x20]), Buffer.from(path)]),
    "binary.bin": Buffer.from([0, 1, 2, 0x2f, 0x55, 0x73, 0x65, 0x72, 0x73]),
  };
  for (const [name_, bytes] of Object.entries(files)) await writeFile(join(root, name_), bytes);
  assert.equal(decodeTextForScan(files["gbk.md"]), `${name} 负责人\n`);
  assert.equal(decodeTextForScan(files["utf16le.txt"]), `路径 ${path}\n`);
  const hits = await findResidueLines(Object.keys(files).map((name_) => join(root, name_)), root);
  assert.deepEqual(hits, [
    "gbk.md:1 命中个人称呼（负责人姓名） → 改为「技术同事」「项目负责人」等通用称呼",
    "utf16le.txt:1 命中个人本机路径 → 改为 /tmp/fixture/... 等占位路径、相对路径或由 import.meta.url 推导",
    "latin1.txt:1 命中个人本机路径 → 改为 /tmp/fixture/... 等占位路径、相对路径或由 import.meta.url 推导",
  ]);
});

test("build-package 产物的每个文件都不含个人残留", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wsb-personal-residue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "package");
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "build-package", "--output", output], { cwd: projectDir });
  assert.equal(JSON.parse(stdout).status, "ok");
  const hits = await findResidueLines(await listFilesRecursive(output), output);
  assert.deepEqual(hits, [], report(hits));
});

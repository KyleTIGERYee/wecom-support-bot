/**
 * 一致性检查：config/default.json 的 roots 必须与扩展里的 ROOTS 完全一致。
 *
 * 根目录清单物理上存在于两处（配置给网关、扩展给 pi 进程内），
 * 因为 pi 的扩展加载器不解析项目模块。这个脚本把「两处必须同步」
 * 从口头约定变成可执行的检查，接进 npm test。
 */
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

const config = JSON.parse(await readFile(join(projectDir, "config/default.json"), "utf8"));
const extensionSource = await readFile(join(projectDir, "extensions/bash-whitelist.ts"), "utf8");

const match = extensionSource.match(/const ROOTS = \[([\s\S]*?)\];/);
if (!match) {
  console.error("未能在扩展里找到 ROOTS 定义");
  process.exit(1);
}

const extensionRoots = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const configRoots = Object.values(config.roots);

const missingInExtension = configRoots.filter((root) => !extensionRoots.includes(root));
const missingInConfig = extensionRoots.filter((root) => !configRoots.includes(root));

if (missingInExtension.length || missingInConfig.length) {
  console.error("白名单根目录不一致：");
  if (missingInExtension.length) console.error(`  扩展缺少: ${missingInExtension.join(", ")}`);
  if (missingInConfig.length) console.error(`  配置缺少: ${missingInConfig.join(", ")}`);
  process.exit(1);
}

const filesMatch = extensionSource.match(/const ALLOWED_FILES = \[([\s\S]*?)\];/);
const allowedFiles = filesMatch ? [...filesMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
const corePrompt = await readFile(join(projectDir, "prompts/core.md"), "utf8");

// 手册路径物理上存在于两处（扩展放行清单、核心提示词里的指引），写错一处 agent 就读不到
const unlisted = allowedFiles.filter((file) => !corePrompt.includes(file));
if (unlisted.length) {
  console.error("扩展放行的文件未在核心提示词中出现：\n  " + unlisted.join("\n  "));
  process.exit(1);
}

for (const file of allowedFiles) {
  if (!(await exists(file))) {
    console.error(`扩展放行的文件不存在：${file}`);
    process.exit(1);
  }
}

console.log(`白名单根目录一致（${configRoots.length} 项），放行文件 ${allowedFiles.length} 项`);

/** @param {string} path */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

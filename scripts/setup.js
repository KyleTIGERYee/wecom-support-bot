#!/usr/bin/env node
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const DEPENDENCY = "@wecom/aibot-node-sdk";
const PI_INSTALL_SCRIPT = join(projectDir, "scripts/install-pi.sh");
const CONSENT_NOTE = "需要用户明确同意后加 --allow-install";

const TOOLS = [
  {
    name: "python3",
    args: ["--version"],
    note: "可信 BI 适配器需要本机 python3；缺失时 BI 查数不可用",
  },
  {
    name: "zip",
    args: ["-v"],
    note: "资源包导入导出与团队打包依赖 zip；缺失时 export 不可用",
  },
  {
    name: "unzip",
    args: ["-v"],
    note: "资源包导入依赖 unzip；缺失时无法导入 zip 来源",
  },
];

function parseArgs(args) {
  const options = { check: false, allowInstall: false, help: false };
  for (const arg of args) {
    if (arg === "--check") options.check = true;
    else if (arg === "--allow-install") options.allowInstall = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知选项：${arg}；用法：setup --check | --allow-install`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("用法：npm run setup -- [--check] [--allow-install]（固定输出 JSON）\n");
    return;
  }
  const packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
  const node = checkNode(packageJson.engines?.node);
  const installAllowed = node.status === "ok" && options.allowInstall;
  const dependencies = await checkDependencies({ ...options, allowInstall: installAllowed, installBlocked: node.status !== "ok" });
  const pi = await checkPi({ ...options, allowInstall: installAllowed, installBlocked: node.status !== "ok" });
  const tools = {};
  for (const tool of TOOLS) tools[tool.name] = await checkTool(tool);

  const required = [node, dependencies, pi];
  const readyToInit = required.every((item) => item.status === "ok" || item.status === "installed");
  const items = [...required, ...Object.values(tools)];
  const hasError = items.some((item) => item.status === "error");
  const status = readyToInit ? "ok" : hasError ? "error" : "needs-action";
  emit({ status, readyToInit, checkOnly: options.check, allowInstall: options.allowInstall, node, dependencies, pi, tools });
  process.exitCode = hasError || (!options.check && !readyToInit) ? 1 : 0;
}

function emit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/**
 * @param {string | undefined} engine
 * @returns {{status: string, version: string | null, action: string | null, note: string}}
 */
function checkNode(engine) {
  const required = String(engine ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!required) {
    return {
      status: "error",
      version: process.versions.node,
      action: null,
      note: "package.json 缺少可解析的 engines.node，无法确认最低 Node 版本",
    };
  }
  const minimum = [Number(required[1]), Number(required[2]), Number(required[3])];
  const minimumText = minimum.join(".");
  if (compareVersions(process.versions.node, minimumText) >= 0) {
    return { status: "ok", version: process.versions.node, action: null, note: `满足 engines.node ${engine}` };
  }
  return {
    status: "error",
    version: process.versions.node,
    action: `升级 Node 到 >= ${minimumText}：brew install node@22 或 nvm install 22 && nvm use 22`,
    note: `当前 Node ${process.versions.node} 低于 engines.node ${engine}，不能继续初始化`,
  };
}

async function checkDependencies(options) {
  const installed = await dependencyVersion();
  if (installed) {
    return { status: "ok", version: installed, action: null, note: `已安装 ${DEPENDENCY}` };
  }
  if (options.check || !options.allowInstall) {
    return {
      status: "missing",
      version: null,
      action: "npm install",
      note: `${options.installBlocked ? "Node 版本不满足，未尝试安装；" : ""}${
        options.check ? `缺少 ${DEPENDENCY}；--check 只检查不安装` : `缺少 ${DEPENDENCY}；${CONSENT_NOTE}`
      }`,
    };
  }
  try {
    await execFileAsync("npm", ["install"], { cwd: projectDir, timeout: 600000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    return {
      status: "error",
      version: null,
      action: "npm install",
      note: `npm install 失败：${firstLine(error?.stderr || error?.message || String(error))}`,
    };
  }
  const version = await dependencyVersion();
  return version
    ? { status: "installed", version, action: "npm install", note: `已执行 npm install 安装 ${DEPENDENCY}` }
    : {
        status: "error",
        version: null,
        action: "npm install",
        note: `npm install 执行后仍未找到 ${DEPENDENCY}`,
      };
}

async function dependencyVersion() {
  try {
    const path = join(projectDir, "node_modules", ...DEPENDENCY.split("/"), "package.json");
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return null;
  }
}

async function checkPi(options) {
  let resolved = await resolvePi();
  if (resolved.path) {
    const probe = await probeCommand(resolved.path, ["--version"]);
    if (probe.ok) {
      return {
        status: "ok",
        version: probe.version,
        action: null,
        note: [`已找到 ${resolved.path}`, ...resolved.notes].join("；"),
      };
    }
    return {
      status: "error",
      version: null,
      action: "修复或重装：bash scripts/install-pi.sh",
      note: [`${resolved.path} 无法执行 pi --version：${probe.reason}`, ...resolved.notes].join("；"),
    };
  }
  if (options.check || !options.allowInstall) {
    return {
      status: "missing",
      version: null,
      action: "bash scripts/install-pi.sh",
      note: [
        options.installBlocked ? "Node 版本不满足，未尝试安装" : null,
        "未找到 pi（依次检查 WECOM_BOT_PI_BINARY 与 ~/.pi-support/bin/pi）",
        ...resolved.notes,
        options.check ? "--check 只检查不安装" : CONSENT_NOTE,
      ].filter(Boolean).join("；"),
    };
  }

  let installError = null;
  try {
    await execFileAsync("bash", [PI_INSTALL_SCRIPT], { cwd: projectDir, timeout: 900000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    installError = firstLine(error?.stderr || error?.message || String(error));
  }
  resolved = await resolvePi();
  if (!resolved.path) {
    return {
      status: "error",
      version: null,
      action: "bash scripts/install-pi.sh",
      note: installError
        ? `install-pi.sh 失败：${installError}，且仍未找到 pi`
        : "install-pi.sh 执行后仍未找到 pi 可执行文件",
    };
  }
  const probe = await probeCommand(resolved.path, ["--version"]);
  if (!probe.ok) {
    return {
      status: "error",
      version: null,
      action: "bash scripts/install-pi.sh",
      note: `安装后 pi --version 验证失败：${probe.reason}`,
    };
  }
  return {
    status: "installed",
    version: probe.version,
    action: "bash scripts/install-pi.sh",
    note: `已安装并验证 ${resolved.path}${installError ? `（安装脚本有非零退出：${installError}）` : ""}`,
  };
}

/**
 * 只认 WECOM_BOT_PI_BINARY 与 ~/.pi-support/bin/pi，避免误用 PATH 里的日常 pi。
 *
 * @returns {Promise<{path: string | null, notes: string[]}>}
 */
async function resolvePi() {
  const notes = [];
  const configured = process.env.WECOM_BOT_PI_BINARY;
  if (configured) {
    const candidate = isAbsolute(configured) ? configured : resolve(projectDir, configured);
    if (await isExecutableFile(candidate)) return { path: candidate, notes };
    notes.push(`WECOM_BOT_PI_BINARY 指向的路径不可执行：${candidate}`);
  }
  const isolated = join(homedir(), ".pi-support/bin/pi");
  if (await isExecutableFile(isolated)) return { path: isolated, notes };
  return { path: null, notes };
}

async function isExecutableFile(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function checkTool(tool) {
  const probe = await probeCommand(tool.name, tool.args);
  if (probe.ok) {
    return { status: "ok", version: probe.version, action: null, note: tool.note };
  }
  if (probe.code === "ENOENT") {
    return {
      status: "missing",
      version: null,
      action: `安装 ${tool.name}`,
      note: `${tool.note}；本脚本不会自动安装系统包`,
    };
  }
  return {
    status: "error",
    version: null,
    action: `检查 ${tool.name}`,
    note: `${tool.name} 不可用：${probe.reason}；${tool.note}`,
  };
}

async function probeCommand(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 15000, maxBuffer: 1024 * 1024 });
    return { ok: true, version: versionFromOutput(`${stdout}\n${stderr}`) };
  } catch (error) {
    return {
      ok: false,
      code: error?.code,
      reason: firstLine(error?.stderr || error?.message || String(error)),
    };
  }
}

function versionFromOutput(output) {
  const text = String(output);
  const match = text.match(/\b(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\b/);
  if (match) return match[1];
  return firstLine(text) || null;
}

function firstLine(value) {
  return String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
}

function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

main().catch((error) => {
  const note = `安装前检查失败：${firstLine(error?.message ?? String(error))}`;
  /** @type {{status: string, version: string | null, action: string | null, note: string}} */
  const failed = { status: "error", version: null, action: null, note };
  emit({
    status: "error",
    readyToInit: false,
    node: { ...failed, version: process.versions.node },
    dependencies: failed,
    pi: failed,
    tools: Object.fromEntries(TOOLS.map((tool) => [tool.name, failed])),
  });
  process.exitCode = 1;
});

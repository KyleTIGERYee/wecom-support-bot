import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { listLocalIpv4Addresses, startDashboardServer } from "./server.js";
import { createDefaultDashboardSources } from "./sources.js";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const rawPort = process.env.WECOM_DASHBOARD_PORT ?? "4319";
const rawBind = process.env.WECOM_DASHBOARD_BIND ?? "127.0.0.1";
const port = Number(rawPort);
const bind = normalizeBind(rawBind);

/** @param {string} value @returns {string|null} */
function normalizeBind(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  if (["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(normalized)) return normalized;
  return listLocalIpv4Addresses().includes(trimmed) ? trimmed : null;
}

const USAGE = `用法：npm run dashboard -- [--instance-dir <目录> ...]

默认自动发现：
  ~/.wecom-support-bot/instances/*  和  <仓库>/instances/*
也可以用环境变量指定多个目录（按系统路径分隔符拆开）：
  WECOM_DASHBOARD_INSTANCE_DIRS=/path/a:/path/b npm run dashboard`;

/**
 * @param {string[]} argv
 * @returns {{help: boolean, instanceDirs: string[]}}
 */
function parseArgs(argv) {
  const instanceDirs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true, instanceDirs };
    if (arg === "--instance-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--instance-dir 需要一个目录");
      instanceDirs.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--instance-dir=")) {
      const value = arg.slice("--instance-dir=".length);
      if (!value) throw new Error("--instance-dir 需要一个目录");
      instanceDirs.push(value);
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return { help: false, instanceDirs };
}

const envInstanceDirs = (process.env.WECOM_DASHBOARD_INSTANCE_DIRS ?? "")
  .split(delimiter)
  .map((value) => value.trim())
  .filter(Boolean);

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
  process.exitCode = 1;
}

if (args?.help) {
  process.stdout.write(`${USAGE}\n`);
} else if (args && (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535)) {
  process.stderr.write("WECOM_DASHBOARD_PORT 必须是 1–65535 的整数。\n");
  process.exitCode = 1;
} else if (args && !bind) {
  process.stderr.write("WECOM_DASHBOARD_BIND 必须是 127.0.0.1、localhost、::1、0.0.0.0 或本机局域网 IPv4 地址。\n");
  process.exitCode = 1;
} else if (args) {
  try {
    const sources = await createDefaultDashboardSources({
      projectDir,
      instanceDirs: [
        ...(process.env.WECOM_BOT_INSTANCE_DIR ? [process.env.WECOM_BOT_INSTANCE_DIR] : []),
        ...envInstanceDirs,
        ...args.instanceDirs,
      ],
      ...(process.env.WECOM_DASHBOARD_RAW_LOG ? { rawLogPath: process.env.WECOM_DASHBOARD_RAW_LOG } : {}),
    });
    if (sources.instances.length === 0) {
      process.stderr.write(
        `没有发现任何机器人实例。\n先确认已用 instance init 初始化，或显式指定实例目录：\n\n${USAGE}\n`,
      );
      process.exitCode = 1;
    } else {
      const running = await startDashboardServer({ port, host: /** @type {string} */ (bind), sources });
      const localOnly = bind === "127.0.0.1" || bind === "localhost" || bind === "::1";
      const listenHost = running.listenHost.includes(":") ? `[${running.listenHost}]` : running.listenHost;
      process.stdout.write(`看板实例：${sources.instances.map((instance) => instance.id).join("、")}\n`);
      process.stdout.write(`对话审计看板已启动：${running.url}\n`);
      process.stdout.write(`监听地址：${listenHost}:${running.port}（${localOnly ? "仅本机" : "局域网可访问"}）\n`);
      if (localOnly) {
        process.stdout.write("仅本机可访问；手机访问请设置 WECOM_DASHBOARD_BIND=0.0.0.0 后重启。\n");
      } else {
        const addresses = listLocalIpv4Addresses();
        if (addresses.length) {
          for (const address of addresses) process.stdout.write(`手机访问：http://${address}:${running.port}\n`);
        } else {
          process.stdout.write("未找到本机局域网 IPv4 地址。\n");
        }
      }
      process.stdout.write("源数据保持只读；按 Ctrl+C 停止。\n");
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await running.close();
      };
      process.once("SIGINT", () => { void stop(); });
      process.once("SIGTERM", () => { void stop(); });
    }
  } catch (error) {
    const message = error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE"
      ? `端口 ${port} 已被占用，可设置 WECOM_DASHBOARD_PORT 换端口。`
      : `看板启动失败：${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

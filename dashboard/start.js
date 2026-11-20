import { dirname } from "node:path";
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

if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write("WECOM_DASHBOARD_PORT 必须是 1–65535 的整数。\n");
  process.exitCode = 1;
} else if (!bind) {
  process.stderr.write("WECOM_DASHBOARD_BIND 必须是 127.0.0.1、localhost、::1、0.0.0.0 或本机局域网 IPv4 地址。\n");
  process.exitCode = 1;
} else {
  try {
    const running = await startDashboardServer({
      port,
      host: bind,
      sources: createDefaultDashboardSources({ projectDir }),
    });
    const localOnly = bind === "127.0.0.1" || bind === "localhost" || bind === "::1";
    const listenHost = running.listenHost.includes(":") ? `[${running.listenHost}]` : running.listenHost;
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
  } catch (error) {
    const message = error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE"
      ? `端口 ${port} 已被占用，可设置 WECOM_DASHBOARD_PORT 换端口。`
      : `看板启动失败：${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDashboard } from "./index.js";

const DEFAULT_PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** 收集本机非 internal 的 IPv4 地址，用于判断 Host 头是否来自本机接口。 */
export function listLocalIpv4Addresses() {
  /** @type {Set<string>} */
  const addresses = new Set();
  for (const entries of Object.values(networkInterfaces())) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.internal || String(entry.family) !== "IPv4") continue;
      if (entry.address) addresses.add(entry.address.toLowerCase());
    }
  }
  return [...addresses].sort();
}

/** @param {string} bindHost */
function allowedHostNames(bindHost) {
  const allowed = new Set(LOOPBACK_HOSTS);
  const normalized = bindHost.trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(normalized)) {
    for (const address of listLocalIpv4Addresses()) allowed.add(address);
  }
  return allowed;
}

/** 从 Host 头取主机名；支持 localhost、IPv4、[::1] 以及可选的数字端口。 @param {string|undefined} value */
function hostnameFromHostHeader(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return null;
    const hostname = raw.slice(1, end).trim();
    const rest = raw.slice(end + 1);
    if (!hostname || (rest && !isPortSuffix(rest))) return null;
    return hostname.toLowerCase();
  }
  const colonCount = [...raw].filter((char) => char === ":").length;
  if (colonCount === 0) return raw.toLowerCase();
  if (colonCount === 1) {
    const colon = raw.indexOf(":");
    const hostname = raw.slice(0, colon).trim();
    const rest = raw.slice(colon);
    if (!hostname || !isPortSuffix(rest)) return null;
    return hostname.toLowerCase();
  }
  // 未加方括号的 IPv6 只可能是纯主机名，不能同时带端口。
  if (/^[0-9a-f:.]+$/i.test(raw)) return raw.toLowerCase();
  return null;
}

/** @param {string} value */
function isPortSuffix(value) {
  const match = /^:(\d{1,5})$/.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535;
}

/**
 * 启动只读服务。host 默认仅绑定 IPv4 loopback，显式传入时才开放其他接口。
 *
 * @param {{port?: number, host?: string, sources: any, publicDir?: string}} options
 */
export async function startDashboardServer({ port = 4319, host = "127.0.0.1", sources, publicDir = DEFAULT_PUBLIC_DIR }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("看板端口无效");
  if (typeof host !== "string" || !host.trim()) throw new Error("看板监听地址无效");
  const bindHost = host.trim();
  const allowedHosts = allowedHostNames(bindHost);
  let dashboard = await buildDashboard({ sources });
  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const actualPort = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
      const requestHostname = hostnameFromHostHeader(request.headers.host);
      if (!requestHostname || !allowedHosts.has(requestHostname)) {
        sendJson(response, 403, { error: "只允许从本机看板地址访问" });
        return;
      }
      if (!request.url || request.url.length > 4096) {
        sendJson(response, 414, { error: "请求地址过长" });
        return;
      }
      const url = new URL(request.url, `http://127.0.0.1:${actualPort}`);
      if (url.pathname === "/api/bootstrap" && request.method === "GET") {
        sendJson(response, 200, dashboard.getMeta());
        return;
      }
      if (url.pathname === "/api/day" && request.method === "GET") {
        const date = url.searchParams.get("date") || null;
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          sendJson(response, 400, { error: "日期格式应为 YYYY-MM-DD" });
          return;
        }
        const query = url.searchParams.get("q") ?? "";
        if (query.length > 200) {
          sendJson(response, 400, { error: "搜索内容过长" });
          return;
        }
        sendJson(response, 200, dashboard.getDay({ date, query, colleagueId: url.searchParams.get("colleague") ?? "", sessionKey: url.searchParams.get("session") ?? "" }));
        return;
      }
      const imageMatch = url.pathname.match(/^\/api\/turns\/([^/]+)\/images\/([0-9]+)$/);
      if (imageMatch && request.method === "GET") {
        const image = dashboard.getImage(decodeURIComponent(imageMatch[1]), Number(imageMatch[2]));
        if (!image) {
          sendJson(response, 404, { error: "没有找到这张入站图片" });
          return;
        }
        try {
          const info = await stat(image.path);
          if (!info.isFile() || info.size > 15 * 1024 * 1024) {
            sendJson(response, 404, { error: "图片不可用或超过大小上限" });
            return;
          }
          const body = await readFile(image.path);
          response.writeHead(200, { "Content-Type": image.mimeType, "Cache-Control": "no-store" });
          response.end(body);
        } catch {
          sendJson(response, 404, { error: "图片不可用" });
        }
        return;
      }
      const turnMatch = url.pathname.match(/^\/api\/turns\/([^/]+)$/);
      if (turnMatch && request.method === "GET") {
        const detail = dashboard.getTurn(decodeURIComponent(turnMatch[1]));
        if (!detail) sendJson(response, 404, { error: "没有找到这轮提问" });
        else sendJson(response, 200, detail);
        return;
      }
      if (url.pathname === "/api/refresh" && request.method === "POST") {
        dashboard = await buildDashboard({ sources });
        sendJson(response, 200, dashboard.getMeta());
        return;
      }
      const staticFile = STATIC_FILES.get(url.pathname);
      if (request.method === "GET" && staticFile) {
        const [filename, mimeType] = staticFile;
        try {
          const body = await readFile(join(publicDir, filename));
          response.writeHead(200, { "Content-Type": mimeType, "Cache-Control": "no-cache" });
          response.end(body);
        } catch {
          sendJson(response, 404, { error: "看板资源不存在" });
        }
        return;
      }
      sendJson(response, 404, { error: "没有这个看板操作" });
    } catch {
      if (!response.headersSent) sendJson(response, 400, { error: "请求无法处理" });
      else response.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindHost, () => resolve(undefined));
  });
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const urlHost = address.address === "0.0.0.0" || address.address === "::" ? "127.0.0.1" : address.address;
  const formattedHost = urlHost.includes(":") ? `[${urlHost}]` : urlHost;
  return {
    server,
    url: `http://${formattedHost}:${address.port}`,
    listenHost: address.address,
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined))),
  };
}

/** @param {import("node:http").ServerResponse} response */
function setSecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
}

/** @param {import("node:http").ServerResponse} response @param {number} status @param {any} body */
function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadLocalInstanceConfig } from "./local-instance-config.js";

/**
 * 加载配置：default.json 提供默认值，secrets.json 提供凭证。
 *
 * 凭证文件路径可由 `WECOM_BOT_SECRETS` 覆盖，用来把调试实例指向测试机器人：
 * 生产与开发必须用不同的机器人，否则两份进程会互相踢线（企微单连接约束），
 * 且调试重启会杀掉正在处理的生产问题。
 *
 * @param {string} projectDir
 * @param {{env?: Record<string, string | undefined>}} [options]
 * @returns {Promise<any>}
 */
export async function loadConfig(projectDir, { env = process.env } = {}) {
  if (env.WECOM_BOT_INSTANCE_DIR) return loadLocalInstanceConfig(projectDir, env.WECOM_BOT_INSTANCE_DIR, { env });
  const defaults = JSON.parse(await readFile(join(projectDir, "config/default.json"), "utf8"));
  const secretsPath = env.WECOM_BOT_SECRETS || join(projectDir, "config/secrets.json");
  const resolvedPath = resolveFrom(projectDir, secretsPath);
  const secrets = JSON.parse(await readFile(resolvedPath, "utf8"));

  if (!secrets.botId || !secrets.secret) {
    throw new Error(`凭证文件缺少 botId 或 secret: ${secretsPath}`);
  }

  // 默认模式的可执行路径不写进仓库：发行版里没有某台机器的绝对路径，
  // 由环境变量或用户主目录推导；实例模式另有自己的配置来源。
  const roots = Object.fromEntries(
    Object.entries(defaults.roots ?? {}).filter(([, value]) => typeof value === "string" && value),
  );
  // WECOM_BOT_ROOTS 既可以是数组（扩展的白名单），也可以是带名字的对象（默认模式的根目录清单）。
  const envRoots = env.WECOM_BOT_ROOTS ? JSON.parse(env.WECOM_BOT_ROOTS) : null;
  const namedRoots = envRoots && !Array.isArray(envRoots) ? { ...roots, ...envRoots } : roots;
  const baseRoots = Array.isArray(envRoots) ? envRoots : Object.values(namedRoots);
  const finalRoots = [...baseRoots];
  for (const dir of [join(projectDir, "data/images"), join(projectDir, "data/files")]) {
    if (!finalRoots.includes(dir)) finalRoots.push(dir);
  }
  return {
    ...defaults,
    projectDir,
    wecom: { botId: secrets.botId, secret: secrets.secret },
    pi: {
      ...defaults.pi,
      binary: env.WECOM_BOT_PI_BINARY || defaults.pi?.binary || join(homedir(), ".pi-support/bin/pi"),
      agentDir: defaults.pi?.agentDir || join(homedir(), ".pi-support/agent"),
    },
    roots: finalRoots,
    namedRoots,
  };
}

/**
 * 相对路径按项目目录解析，绝对路径原样使用。
 *
 * @param {string} projectDir
 * @param {string} path
 */
function resolveFrom(projectDir, path) {
  return path.startsWith("/") ? path : join(projectDir, path);
}

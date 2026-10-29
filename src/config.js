import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
  const defaults = JSON.parse(await readFile(join(projectDir, "config/default.json"), "utf8"));
  const secretsPath = env.WECOM_BOT_SECRETS || join(projectDir, "config/secrets.json");
  const resolvedPath = resolveFrom(projectDir, secretsPath);
  const secrets = JSON.parse(await readFile(resolvedPath, "utf8"));

  if (!secrets.botId || !secrets.secret) {
    throw new Error(`凭证文件缺少 botId 或 secret: ${secretsPath}`);
  }

  return {
    ...defaults,
    projectDir,
    wecom: { botId: secrets.botId, secret: secrets.secret },
    roots: Object.values(defaults.roots),
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

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 加载配置：default.json 提供默认值，secrets.json 提供凭证。
 *
 * @param {string} projectDir
 * @returns {Promise<any>}
 */
export async function loadConfig(projectDir) {
  const defaults = JSON.parse(await readFile(join(projectDir, "config/default.json"), "utf8"));
  const secrets = JSON.parse(await readFile(join(projectDir, "config/secrets.json"), "utf8"));

  if (!secrets.botId || !secrets.secret) {
    throw new Error("config/secrets.json 缺少 botId 或 secret");
  }

  return {
    ...defaults,
    projectDir,
    wecom: { botId: secrets.botId, secret: secrets.secret },
    roots: Object.values(defaults.roots),
  };
}

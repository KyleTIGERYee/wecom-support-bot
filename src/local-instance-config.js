import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 本地实例共用的运行时配置。公开 ask 与企微入口必须使用同一份本地副本、
 * 模型、审批和 Guard 配置，避免控制台验收通过而服务实际走了另一套来源。
 *
 * @param {{
 *   projectDir: string,
 *   defaults: any,
 *   saved: any,
 *   secrets: any,
 *   catalogRoot: string,
 *   workspaceDir: string,
 *   agentDir: string,
 *   piBinary?: string,
 *   imagesDir?: string | null
 * }} options
 */
export function createLocalRuntimeConfig({
  projectDir,
  defaults,
  saved,
  secrets,
  catalogRoot,
  workspaceDir,
  agentDir,
  piBinary = process.env.WECOM_BOT_PI_BINARY || join(homedir(), ".pi-support/bin/pi"),
  imagesDir = null,
}) {
  const approvalModel = saved.models.executionApproval ?? saved.models.main;
  const quickModel = saved.models.quick ?? saved.models.main;
  const roots = [join(catalogRoot, "context"), workspaceDir, ...(imagesDir ? [imagesDir] : [])];
  return {
    ...defaults,
    projectDir,
    roots,
    namedRoots: Object.fromEntries(roots.map((path, index) => [`local${index + 1}`, path])),
    writeRoots: [join(catalogRoot, "context"), workspaceDir],
    protectedRoots: [projectDir],
    pi: {
      ...defaults.pi,
      binary: piBinary,
      agentDir,
      provider: "local-instance",
      model: saved.models.main.model,
      systemPromptPath: join(projectDir, "prompts/local-instance.md"),
      localInstance: true,
    },
    guard: {
      ...defaults.guard,
      baseUrl: saved.models.guard.baseUrl,
      model: saved.models.guard.model,
      apiKey: secrets.guardApiKey,
    },
    quick: {
      ...defaults.guard,
      baseUrl: quickModel.baseUrl,
      model: quickModel.model,
      apiKey: secrets.quickApiKey ?? secrets.mainApiKey,
    },
    executionApproval: {
      ...defaults.executionApproval,
      enabled: true,
      baseUrl: approvalModel.baseUrl,
      model: approvalModel.model,
      apiKey: secrets.executionApprovalApiKey ?? secrets.mainApiKey,
    },
  };
}

/**
 * 企微服务从控制台选择的本地实例加载配置与当前测试/正式机器人。
 * @param {string} projectDir
 * @param {string} instanceDir
 * @param {{env?: Record<string, string | undefined>}} [options]
 */
export async function loadLocalInstanceConfig(projectDir, instanceDir, { env = process.env } = {}) {
  const resolvedInstanceDir = resolve(instanceDir);
  const [defaults, saved, secrets, channels] = await Promise.all([
    readJson(join(projectDir, "config/default.json")),
    readJson(join(resolvedInstanceDir, "instance.json")),
    readJson(join(resolvedInstanceDir, "secrets.json")),
    readJson(join(resolvedInstanceDir, "wecom.json")),
  ]);
  if (!saved.ready) throw new Error("本地实例初始化检查未通过，不能启动企微服务");
  const active = channels.active;
  if (!["test", "production"].includes(active)) throw new Error("企微通道必须明确选择 test 或 production");
  const channel = channels[active];
  if (!channel?.botId || !channel?.secret) throw new Error(`当前 ${active} 企微机器人凭证未配置`);
  const config = createLocalRuntimeConfig({
    projectDir,
    defaults,
    saved,
    secrets,
    catalogRoot: resolvedInstanceDir,
    workspaceDir: join(resolvedInstanceDir, "workspace"),
    agentDir: join(resolvedInstanceDir, "agent"),
    piBinary: env.WECOM_BOT_PI_BINARY,
    imagesDir: join(resolvedInstanceDir, "data/images"),
  });
  return {
    ...config,
    wecom: { botId: channel.botId, secret: channel.secret },
    localInstance: { instanceDir: resolvedInstanceDir, saved, channel: active },
  };
}

/** @param {string} path */
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

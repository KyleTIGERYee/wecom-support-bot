import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 本机现有主实例与旧实例的固定只读来源。备份目录不列入，避免重复计数。
 *
 * @param {{projectDir: string, homeDir?: string}} options
 */
export function createDefaultDashboardSources({ projectDir, homeDir = homedir() }) {
  const mainInstance = join(homeDir, ".wecom-support-bot/instances/main");
  return {
    instances: [
      {
        id: "main",
        inboxPath: join(mainInstance, "data/inbox.jsonl"),
        logPath: join(mainInstance, "logs/bot.log"),
        piDir: join(mainInstance, "agent/sessions/--Users-kyle-Desktop-VIBECODING-wecom-support-bot--"),
        imagesDir: join(mainInstance, "data/images"),
      },
      {
        id: "legacy",
        inboxPath: join(projectDir, "data/inbox.jsonl"),
        logPath: join(projectDir, "logs/bot.log"),
        piDir: join(homeDir, ".pi-support/agent/sessions/--Users-kyle-Desktop-VIBECODING-wecom-support-bot--"),
        imagesDir: join(projectDir, "data/images"),
      },
    ],
    rawLogPath: join(projectDir, "logs/launchd.stdout.log"),
    userMapPath: join(homeDir, ".wecom-support-bot/user-map.json"),
  };
}

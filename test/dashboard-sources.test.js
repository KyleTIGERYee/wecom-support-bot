import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createDefaultDashboardSources } from "../dashboard/sources.js";

async function writeFileAt(path, content = "") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "wsb-dashboard-sources-"));
  const home = join(root, "home");
  const project = join(root, "repo");

  const main = join(home, ".wecom-support-bot/instances/main");
  await writeFileAt(join(main, "instance.json"), "{}");
  await writeFileAt(join(main, "data/inbox.jsonl"), "");
  await writeFileAt(join(main, "data/user-map.json"), JSON.stringify({ u1: { name: "主实例同事" } }));
  await writeFileAt(join(main, "agent/sessions/--Users-someone-project--/session.jsonl"), "");

  const team = join(project, "instances/team");
  await writeFileAt(join(team, "data/inbox.jsonl"), "");
  await writeFileAt(join(team, "agent/sessions/--srv-team--/session.jsonl"), "");

  // 普通目录不能被当成实例
  await mkdir(join(home, ".wecom-support-bot/instances/not-an-instance"), { recursive: true });

  await writeFileAt(join(project, "data/inbox.jsonl"), "");
  await writeFileAt(join(project, "logs/bot.log"), "");
  await writeFileAt(join(project, "logs/launchd.stdout.log"), "");
  await writeFileAt(join(home, ".pi-support/agent/sessions/--old-project--/session.jsonl"), "");
  await writeFileAt(join(home, ".wecom-support-bot/user-map.json"), JSON.stringify({ u9: { name: "全局同事" } }));

  return { root, home, project };
}

test("自动发现 home 与仓库 instances 下的实例，并推导 pi 会话目录", async () => {
  const { home, project } = await createFixture();
  const sources = await createDefaultDashboardSources({ projectDir: project, homeDir: home });

  assert.deepEqual(sources.instances.map((instance) => instance.id), ["main", "team", "legacy"]);
  const [main, team, legacy] = sources.instances;
  assert.equal(main.inboxPath, join(home, ".wecom-support-bot/instances/main/data/inbox.jsonl"));
  assert.equal(main.piDir, join(home, ".wecom-support-bot/instances/main/agent/sessions/--Users-someone-project--"));
  assert.equal(main.imagesDir, join(home, ".wecom-support-bot/instances/main/data/images"));
  assert.equal(team.piDir, join(project, "instances/team/agent/sessions/--srv-team--"));
  assert.equal(legacy.piDir, join(home, ".pi-support/agent/sessions/--old-project--"));
  assert.equal(legacy.inboxPath, join(project, "data/inbox.jsonl"));

  assert.equal(sources.userMapPath, join(home, ".wecom-support-bot/user-map.json"));
  assert.deepEqual(sources.userMapPaths, [join(home, ".wecom-support-bot/instances/main/data/user-map.json")]);
  assert.equal(sources.rawLogPath, join(project, "logs/launchd.stdout.log"));
});

test("显式实例目录优先且不会重复", async () => {
  const { root, home, project } = await createFixture();
  const custom = join(root, "elsewhere/custom");
  await writeFileAt(join(custom, "instance.json"), "{}");
  await writeFileAt(join(custom, "data/inbox.jsonl"), "");

  const sources = await createDefaultDashboardSources({
    projectDir: project,
    homeDir: home,
    instanceDirs: [custom, custom],
  });

  assert.equal(sources.instances[0].id, "custom");
  assert.equal(sources.instances.filter((instance) => instance.id === "custom").length, 1);
  assert.equal(sources.instances.some((instance) => instance.id === "main"), true);
});

test("没有实例时返回空列表，不虚构固定路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "wsb-dashboard-sources-empty-"));
  const sources = await createDefaultDashboardSources({ projectDir: join(root, "repo"), homeDir: join(root, "home") });
  assert.deepEqual(sources.instances, []);
  assert.equal("userMapPath" in sources, false);
  assert.equal("rawLogPath" in sources, false);
});

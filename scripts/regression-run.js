/**
 * 回归题集跑批：直连隔离 pi，逐题提问并记录耗时、答复、token 数。
 *
 * 与线上网关的差别只在「不经过企微、不调用真实 Guard 模型」——agent 启动参数与 agent.js 完全一致，
 * 轮次仍经过 handleTurn，因此概念/规则深化与加载观测和线上使用同一条链路。
 *
 * 用法：
 *   node scripts/regression-run.js                     # 跑全部题目
 *   node scripts/regression-run.js --only Q8,Q12       # 只跑指定题
 *   node scripts/regression-run.js --out docs/x.json   # 指定输出
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { runAgentTurn } from "../src/agent.js";
import { handleTurn } from "../src/orchestrate.js";
import { createDefaultResourceCatalog } from "../src/resource-catalog.js";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** 题集：与 docs/regression-questions.md 保持一致。 */
const QUESTIONS = [
  { id: "Q1", question: "介绍一下你自己" },
  { id: "Q2", question: "在吗" },
  { id: "Q3", question: "退租有哪些类型" },
  { id: "Q4", question: "自助看房最多提前几天预约" },
  { id: "Q5", question: "为什么深梦扬帆报名单没有导出按钮" },
  { id: "Q6", question: "乐租租管理APP上面的待审核房源目前是否同步到了工单APP" },
  {
    id: "Q7",
    question: "目前乐租租APP和工单APP都有房源审核这个功能，想问问是不是要立刻关了乐租租APP上的房源审核功能",
  },
  { id: "Q8", question: "查一下乐租租现在一共有多少入驻的机构" },
  { id: "Q9", question: "现在有几个机构？" },
  { id: "Q10", question: "截至目前自助看房预约量和签约量是多少" },
  { id: "Q11", question: "7-8月自助看房签约总量为多少" },
  { id: "Q12", question: "我说的是乐寓有多少租客，出租率多少" },
];

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? new Set((args[onlyIndex + 1] ?? "").split(",").filter(Boolean)) : null;
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : join(projectDir, "docs/regression-baseline.json");

const defaults = JSON.parse(await readFile(join(projectDir, "config/default.json"), "utf8"));
const config = {
  ...defaults,
  projectDir,
  roots: Object.values(defaults.roots),
  pi: { ...defaults.pi, binary: process.env.WECOM_BOT_PI_BINARY || defaults.pi.binary },
};
const resourceContext = createDefaultResourceCatalog(defaults.roots, projectDir);

const picked = QUESTIONS.filter((item) => !only || only.has(item.id));
const results = [];

for (const item of picked) {
  const startedAt = Date.now();
  let biTouched = false;
  let failed = false;
  const turn = await handleTurn({
    question: item.question,
    sessionKey: `regress-${item.id}-${Date.now()}`,
    deps: {
      // 每题独立状态；review 是不调用真实 Guard 模型的 ALLOW 替身。
      state: { isBiTouched: () => false, markBiTouched: () => {}, flush: async () => {} },
      context: { catalog: resourceContext.text, dataPlaybook: resourceContext.dataPlaybook, entries: resourceContext.entries },
      runAgent: async ({ prompt, sessionId }) => {
        const agentTurn = await runAgentTurn({
          prompt,
          sessionId,
          config,
          projectDir,
          resourceCatalog: resourceContext.entries,
          timeoutMs: Number(process.env.REGRESS_TIMEOUT_MS ?? 300000),
        });
        biTouched ||= agentTurn.biTouched;
        failed = agentTurn.failed;
        return agentTurn;
      },
      review: async () => ({ verdict: "ALLOW" }),
    },
  });
  const record = {
    id: item.id,
    question: item.question,
    elapsedMs: Date.now() - startedAt,
    biTouched,
    timedOut: Boolean(turn.timedOut),
    failed,
    loadedResources: turn.loadedResources,
    loadDepth: turn.loadDepth,
    answer: turn.finalText,
  };
  results.push(record);
  process.stdout.write(
    `${item.id} ${record.elapsedMs}ms bi=${record.biTouched} timedOut=${record.timedOut} failed=${record.failed} len=${turn.finalText.length}\n`,
  );
}

await writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
process.stdout.write(`\n结果写入 ${outPath}\n`);

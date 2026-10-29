/**
 * 回归题集跑批：直连隔离 pi，逐题提问并记录耗时、答复、token 数。
 *
 * 与线上网关的差别只在「不经过企微、不过 guard」——agent 启动参数与 agent.js 完全一致，
 * 所以给出的耗时与答案可以直接和改造后对比。
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
const config = { ...defaults, projectDir };

const picked = QUESTIONS.filter((item) => !only || only.has(item.id));
const results = [];

for (const item of picked) {
  const startedAt = Date.now();
  const turn = await runAgentTurn({
    prompt: item.question,
    sessionId: `regress-${item.id}-${Date.now()}`,
    config,
    projectDir,
    timeoutMs: Number(process.env.REGRESS_TIMEOUT_MS ?? 300000),
  });
  const record = {
    id: item.id,
    question: item.question,
    elapsedMs: Date.now() - startedAt,
    biTouched: turn.biTouched,
    timedOut: turn.timedOut,
    failed: turn.failed,
    answer: turn.text,
  };
  results.push(record);
  process.stdout.write(
    `${item.id} ${record.elapsedMs}ms bi=${record.biTouched} timedOut=${record.timedOut} failed=${record.failed} len=${turn.text.length}\n`,
  );
}

await writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
process.stdout.write(`\n结果写入 ${outPath}\n`);

/**
 * 端到端冒烟：用真实 pi 与真实 guard 跑一轮完整流程。
 *
 * 不经过企微，直接调用 handleTurn，验证：
 *   1. 查知识库能拿到答案
 *   2. 碰过生产数据后 guard 真的会拦敏感内容
 *
 * 用法：node scripts/smoke.js "你要问的问题"
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { loadConfig } from "../src/config.js";
import { createGuardClient } from "../src/model-client.js";
import { runAgentTurn } from "../src/agent.js";
import { reviewReply } from "../src/guard.js";
import { handleTurn } from "../src/orchestrate.js";
import { createSessionState } from "../src/session-state.js";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

const question = process.argv.slice(2).join(" ") || "本月退租了多少单？";

const config = await loadConfig(projectDir);
const callModel = await createGuardClient({ config, agentDir: config.pi.agentDir });

const logPath = join(await mkdtemp(join(tmpdir(), "wsb-smoke-")), "state.json");
const state = createSessionState({ storePath: logPath });

console.log(`\n问题：${question}\n`);
const started = Date.now();

const result = await handleTurn({
  question,
  sessionKey: "smoke-session",
  deps: {
    state,
    runAgent: ({ prompt, sessionId }) =>
      runAgentTurn({ prompt, sessionId, config, projectDir, timeoutMs: config.pi.timeoutMs }),
    review: ({ question: asked, answer }) => reviewReply({ question: asked, answer, callModel }),
  },
  maxRounds: config.guard.maxRounds,
});

console.log(`耗时：${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`轮数：${result.rounds}  过 guard：${result.guarded}  兜底：${result.exhausted}`);
console.log(`\n最终答复：\n${result.finalText}\n`);

// 直接对比：让 agent 原样查一次带个人信息的明细，看 guard 判什么
console.log("—".repeat(50));
console.log("隔离验证：guard 对含手机号的答复判决\n");

const denyCheck = await reviewReply({
  question: "帮我查一下这几个租客的手机号",
  answer: "以下是查询结果：\n张三 13800138000\n李四 13900139000\n王五 13700137000",
  callModel,
});
console.log(`判决：${denyCheck.verdict}`);
console.log(`理由：${denyCheck.reason ?? "—"}\n`);

const allowCheck = await reviewReply({
  question: "本月退租率多少",
  answer: "本月共退租 1234 单，退租率 8.7%，较上月下降 1.2 个百分点。",
  callModel,
});
console.log(`对照（聚合统计）：${allowCheck.verdict}\n`);
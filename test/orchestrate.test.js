import { test } from "node:test";
import assert from "node:assert/strict";

import { handleTurn } from "../src/orchestrate.js";

/** 造一个可控的会话状态假实现。 */
function fakeState(touchedInitially = false) {
  const touched = new Set(touchedInitially ? ["wx-abc"] : []);
  return {
    isBiTouched: (/** @type {string} */ key) => touched.has(key),
    markBiTouched: (/** @type {string} */ key) => touched.add(key),
    flush: async () => {},
  };
}

test("未碰过 BI 的会话不调用 guard", async () => {
  let guardCalls = 0;
  const deps = {
    state: fakeState(false),
    runAgent: async () => ({ text: "退租是指…", biTouched: false, timedOut: false, failed: false }),
    review: async () => {
      guardCalls += 1;
      return { verdict: "ALLOW" };
    },
  };

  const result = await handleTurn({ question: "退租是什么", sessionKey: "wx-abc", deps });

  assert.equal(guardCalls, 0);
  assert.equal(result.finalText, "退租是指…");
  assert.equal(result.guarded, false);
});

test("本轮碰了 BI 时调用 guard 并放行", async () => {
  let guardCalls = 0;
  const deps = {
    state: fakeState(false),
    runAgent: async () => ({ text: "本月退租 1234 单", biTouched: true, timedOut: false, failed: false }),
    review: async () => {
      guardCalls += 1;
      return { verdict: "ALLOW" };
    },
  };

  const result = await handleTurn({ question: "本月退租多少", sessionKey: "wx-abc", deps });

  assert.equal(guardCalls, 1);
  assert.equal(result.finalText, "本月退租 1234 单");
});

test("碰过 BI 后把会话标记为粘性", async () => {
  const state = fakeState(false);
  const deps = {
    state,
    runAgent: async () => ({ text: "答案", biTouched: true, timedOut: false, failed: false }),
    review: async () => ({ verdict: "ALLOW" }),
  };

  await handleTurn({ question: "问", sessionKey: "wx-abc", deps });

  assert.equal(state.isBiTouched("wx-abc"), true);
});

test("历史碰过 BI 的会话本轮不再碰 BI 也要过 guard", async () => {
  let guardCalls = 0;
  const deps = {
    state: fakeState(true),
    runAgent: async () => ({ text: "上次那个数是 1234", biTouched: false, timedOut: false, failed: false }),
    review: async () => {
      guardCalls += 1;
      return { verdict: "ALLOW" };
    },
  };

  await handleTurn({ question: "刚才那个数是多少", sessionKey: "wx-abc", deps });

  assert.equal(guardCalls, 1);
});

test("DENY 后带理由打回重写，第二次通过则用新稿", async () => {
  let round = 0;
  const prompts = [];
  const deps = {
    state: fakeState(true),
    runAgent: async ({ prompt, isRework }) => {
      prompts.push({ prompt, isRework });
      round += 1;
      return { text: round === 1 ? "张三 13800138000" : "该租客手机号已脱敏", biTouched: true, timedOut: false, failed: false };
    },
    review: async ({ answer }) =>
      answer.includes("13800138000") ? { verdict: "DENY", reason: "包含手机号" } : { verdict: "ALLOW" },
  };

  const result = await handleTurn({ question: "这个租客手机号多少", sessionKey: "wx-abc", deps });

  assert.equal(result.finalText, "该租客手机号已脱敏");
  assert.equal(result.rounds, 2);
  assert.equal(prompts[1].isRework, true);
  assert.match(prompts[1].prompt, /包含手机号/);
});

test("连续 3 次 DENY 后走兜底话术", async () => {
  const deps = {
    state: fakeState(true),
    runAgent: async () => ({ text: "张三 13800138000", biTouched: true, timedOut: false, failed: false }),
    review: async () => ({ verdict: "DENY", reason: "包含手机号" }),
  };

  const result = await handleTurn({ question: "问", sessionKey: "wx-abc", deps, maxRounds: 3 });

  assert.equal(result.exhausted, true);
  assert.match(result.finalText, /没法直接确认|问虎老师/);
});

test("agent 失败时返回错误话术", async () => {
  const deps = {
    state: fakeState(false),
    runAgent: async () => ({ text: "", biTouched: false, timedOut: false, failed: true }),
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "问", sessionKey: "wx-abc", deps });

  assert.match(result.finalText, /没处理好/);
});

test("deny 时不把原始答复泄漏给调用方", async () => {
  const deps = {
    state: fakeState(true),
    runAgent: async () => ({ text: "张三 13800138000", biTouched: true, timedOut: false, failed: false }),
    review: async () => ({ verdict: "DENY", reason: "包含手机号" }),
  };

  const result = await handleTurn({ question: "问", sessionKey: "wx-abc", deps, maxRounds: 1 });

  assert.equal(result.finalText.includes("13800138000"), false);
});

test("超时给超时话术而不是通用错误话术", async () => {
  const deps = {
    state: fakeState(false),
    runAgent: async () => ({ text: "", biTouched: false, timedOut: true, failed: false }),
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "问", sessionKey: "wx-abc", deps });

  assert.equal(result.timedOut, true);
  assert.match(result.finalText, /查得有点久/);
});

test("卡住时自动重试一次，第二次成功就正常答复", async () => {
  let calls = 0;
  const deps = {
    state: fakeState(false),
    runAgent: async () => {
      calls += 1;
      if (calls === 1) {
        return { text: "", biTouched: false, timedOut: false, stalled: true, failed: false };
      }
      return { text: "重试后答上了", biTouched: false, timedOut: false, stalled: false, failed: false };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "退租怎么算", sessionKey: "wx-abc", deps });

  assert.equal(calls, 2);
  assert.equal(result.finalText, "重试后答上了");
});

test("重试仍然卡住时给超时话术", async () => {
  const deps = {
    state: fakeState(false),
    runAgent: async () => ({ text: "", biTouched: false, timedOut: false, stalled: true, failed: false }),
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({
    question: "退租怎么算",
    sessionKey: "wx-abc",
    deps,
    messages: { timeoutText: "这个我查得有点久" },
  });

  assert.equal(result.finalText, "这个我查得有点久");
  assert.equal(result.stalled, true);
});

test("卡住重试次数回传给调用方（供上线后统计）", async () => {
  const deps = {
    state: fakeState(false),
    runAgent: async () => ({ text: "", biTouched: false, timedOut: false, stalled: true, failed: false }),
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "问", sessionKey: "wx-abc", deps });

  assert.equal(result.stallRetries, 1);
});

test("简单概念从薄目录开始，回答后公开浅层加载记录", async () => {
  let calls = 0;
  let firstPrompt = "";
  const concept = {
    source: "共享业务库",
    path: "wiki/概念/退租.md",
    depth: "concept",
    sourceTime: "2026-10-01",
  };
  const deps = {
    state: fakeState(false),
    context: {
      catalog: "共享业务库 | wiki/概念/退租.md | 概念摘要 | 2026-10-01",
    },
    runAgent: async ({ prompt }) => {
      calls += 1;
      firstPrompt ||= prompt;
      return {
        text: "退租是结束租赁关系。",
        biTouched: false,
        timedOut: false,
        failed: false,
        loadedResources: [concept],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "退租是什么", sessionKey: "wx-abc", deps });

  assert.equal(calls, 1);
  assert.match(firstPrompt, /共享业务库 \| wiki\/概念\/退租\.md/);
  assert.equal(firstPrompt.includes("RAW_FULL_BODY"), false);
  assert.deepEqual(result.loadedResources, [concept]);
  assert.equal(result.loadDepth, "concept");
});

test("具体规则概念内容已经足够时不因问题关键词重复深化", async () => {
  let calls = 0;
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享业务库 | wiki/概念/退租.md" },
    runAgent: async () => {
      calls += 1;
      return {
        text: "退租审批需要两级审批。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: [{ source: "共享业务库", path: "wiki/概念/退租.md", depth: "concept" }],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "退租审批需要几级？", sessionKey: "wx-abc", deps });

  assert.equal(calls, 1);
  assert.equal(result.finalText, "退租审批需要两级审批。");
});

test("具体审批规则在概念层不足时继续读取相关 raw 并保留来源时间", async () => {
  const prompts = [];
  const concept = {
    source: "共享业务库",
    path: "wiki/概念/退租.md",
    depth: "concept",
    sourceTime: "2026-09-01",
  };
  const raw = {
    source: "共享业务库",
    path: "raw/退租/退房审批.md",
    depth: "raw",
    sourceTime: "2026-10-15",
  };
  const deps = {
    state: fakeState(false),
    context: {
      catalog: "共享业务库 | wiki/概念/退租.md | raw_source: raw/退租/退房审批.md | 2026-10-15",
    },
    runAgent: async ({ prompt, isRework }) => {
      prompts.push({ prompt, isRework });
      const deepened = prompts.length === 2;
      return {
        text: deepened ? "退租审批需要两级审批，这是 10 月 15 日那版的规则。" : "概念摘要没有写审批级数。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: !deepened,
        loadedResources: deepened ? [raw] : [concept],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "退租审批需要几级？", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1].prompt, /原始资料|raw_source/);
  assert.equal(prompts[1].isRework, false);
  assert.equal(result.rounds, 1);
  assert.match(result.finalText, /两级审批/);
  assert.deepEqual(result.loadedResources, [concept, raw]);
  assert.equal(result.loadDepth, "raw");
});

test("违约金怎么算在概念不足时也进入 raw 深化", async () => {
  const prompts = [];
  const raw = { source: "共享业务库", path: "raw/退租/违约金.md", depth: "raw", sourceTime: "2026-10-20" };
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享业务库 | wiki/概念/退租.md | raw_source: raw/退租/违约金.md" },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const deepened = prompts.length === 2;
      return {
        text: deepened ? "违约金按合同约定的一个月租金计算。" : "概念页没有违约金公式。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: !deepened,
        loadedResources: deepened
          ? [raw]
          : [{ source: "共享业务库", path: "wiki/概念/退租.md", depth: "concept" }],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "违约金怎么算", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /原始资料|raw_source/);
  assert.equal(result.finalText, "违约金按合同约定的一个月租金计算。");
  assert.deepEqual(result.loadedResources.at(-1), raw);
});

test("数量型概念题概念页完整时不补读查数手册", async () => {
  let calls = 0;
  const concept = { source: "共享业务库", path: "wiki/概念/退租.md", depth: "concept" };
  const deps = {
    state: fakeState(false),
    context: {
      catalog: "共享业务库 | wiki/概念/退租.md\n共享查数资源 | prompts/data-playbook.md",
      dataPlaybook: true,
    },
    runAgent: async () => {
      calls += 1;
      return {
        text: "退租有七种类型。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: [concept],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "退租有多少种类型？", sessionKey: "wx-abc", deps });

  assert.equal(calls, 1);
  assert.equal(result.finalText, "退租有七种类型。");
  assert.equal(result.loadDepth, "concept");
});

test("查数任务按需补读详细手册，最终答复仍经过现有 Guard", async () => {
  const prompts = [];
  let guardCalls = 0;
  const playbook = {
    source: "共享查数资源",
    path: "prompts/data-playbook.md",
    depth: "playbook",
    sourceTime: "2026-11-01",
  };
  const deps = {
    state: fakeState(false),
    context: {
      catalog: "共享查数资源 | prompts/data-playbook.md | 查数前按需阅读 | 2026-11-01",
      dataPlaybook: true,
    },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const hasPlaybook = prompts.length === 2;
      return {
        text: hasPlaybook ? "现在有 56 家入驻机构。" : "我还没有确认机构口径。",
        biTouched: !hasPlaybook,
        timedOut: false,
        failed: false,
        contextInsufficient: !hasPlaybook,
        loadedResources: hasPlaybook ? [playbook] : [],
      };
    },
    review: async () => {
      guardCalls += 1;
      return { verdict: "ALLOW" };
    },
  };

  const result = await handleTurn({
    question: "查一下乐租租现在一共有多少入驻的机构",
    sessionKey: "wx-abc",
    deps,
  });

  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].includes("查数三步走"), false);
  assert.match(prompts[1], /查数手册|data-playbook/);
  assert.deepEqual(result.loadedResources, [playbook]);
  assert.equal(result.loadDepth, "playbook");
  assert.equal(result.finalText, "现在有 56 家入驻机构。");
  assert.equal(result.guarded, true);
  assert.equal(guardCalls, 1);
});

test("loadDepth 按 metrics、表文档和 SQL 等实际类型取最深层级", async () => {
  const resources = [
    { source: "共享数据库库", path: "wiki/概念/机构.md", depth: "concept" },
    { source: "共享数据库库", path: "metrics/机构总数.md", depth: "metrics" },
    { source: "共享数据库库", path: "tables/ajly_flow/system_tenant.md", depth: "table" },
    { source: "共享数据库库", path: "queries/机构总数.sql", depth: "sql" },
    { source: "共享查数资源", path: "prompts/data-playbook.md", depth: "playbook" },
  ];
  const deps = {
    state: fakeState(false),
    runAgent: async () => ({
      text: "已按口径核对",
      biTouched: false,
      timedOut: false,
      failed: false,
      loadedResources: resources,
    }),
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "核对口径", sessionKey: "wx-abc", deps });

  assert.deepEqual(result.loadedResources, resources);
  assert.equal(result.loadDepth, "sql");
});

test("卡住重试前已经读取的资源仍保留在本轮加载记录", async () => {
  const concept = { source: "共享业务库", path: "wiki/概念/退租.md", depth: "concept" };
  let calls = 0;
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享业务库 | wiki/概念/退租.md" },
    runAgent: async () => {
      calls += 1;
      return calls === 1
        ? { text: "", biTouched: false, timedOut: false, stalled: true, failed: false, loadedResources: [concept] }
        : { text: "重试后答上了", biTouched: false, timedOut: false, stalled: false, failed: false, loadedResources: [] };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "退租是什么", sessionKey: "wx-abc", deps });

  assert.equal(result.finalText, "重试后答上了");
  assert.deepEqual(result.loadedResources, [concept]);
  assert.equal(result.loadDepth, "concept");
});

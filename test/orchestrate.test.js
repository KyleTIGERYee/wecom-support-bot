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

/** @param {Record<string, any>} overrides */
function sharedTimeline(overrides = {}) {
  return {
    source: "共享记忆",
    path: "wiki/时间线.md",
    depth: "document",
    resourceType: "timeline",
    sourceTime: "2026-08-01",
    validity: "history",
    scope: "shared",
    ...overrides,
  };
}

/** @param {Record<string, any>} overrides */
function sharedRecord(overrides = {}) {
  return {
    source: "共享记忆",
    path: "raw/收件箱/2026-08-01--审批讨论.md",
    depth: "raw",
    resourceType: "record",
    sourceTime: "2026-08-01",
    validity: "history",
    scope: "shared",
    ...overrides,
  };
}

/** @param {Record<string, any>} overrides */
function sharedProject(overrides = {}) {
  return {
    source: "共享项目资料",
    path: "projects/房源审核/当前进展.md",
    depth: "document",
    resourceType: "project",
    sourceTime: "2026-11-03",
    validity: "current",
    scope: "shared",
    ...overrides,
  };
}

/** @param {string} verification */
function dataEvidence(verification = "verified") {
  return [
    { source: "共享数据库库", path: "evolution/机构经验.md", depth: "experience", resourceType: "experience" },
    { source: "共享数据库库", path: "metrics/机构总数.md", depth: "metrics", resourceType: "metrics" },
    { source: "共享数据库库", path: "queries/机构.sql", depth: "sql", resourceType: "sql", verification },
    { source: "共享数据库库", path: "tables/ajly_flow/system_tenant.md", depth: "table", resourceType: "table" },
  ];
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
  let firstPrompt = "";
  const concept = { source: "共享业务库", path: "wiki/概念/退租.md", depth: "concept" };
  const deps = {
    state: fakeState(false),
    context: {
      catalog: "共享业务库 | wiki/概念/退租.md\n共享查数资源 | prompts/data-playbook.md",
      dataPlaybook: true,
    },
    runAgent: async ({ prompt }) => {
      calls += 1;
      firstPrompt ||= prompt;
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
  assert.doesNotMatch(firstPrompt, /知识任务路由：数据口径/);
  assert.equal(result.finalText, "退租有七种类型。");
  assert.equal(result.loadDepth, "concept");
});

test("现在退租要不要违约金是概念规则而不是当前进展", async () => {
  const prompts = [];
  const concept = { source: "共享业务库", path: "wiki/概念/退租.md", depth: "concept", resourceType: "concept" };
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享业务库目录" },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        text: "是否收违约金要看退租类型和合同约定。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: [concept],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "现在退租要不要违约金？", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /知识任务路由：当前进展/);
  assert.equal(result.finalText, "是否收违约金要看退租类型和合同约定。");
});

test("现在退租状态有哪些是业务状态概念而不是当前进展", async () => {
  const prompts = [];
  const concept = { source: "共享业务库", path: "wiki/概念/退租.md", depth: "concept", resourceType: "concept" };
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享业务库目录" },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        text: "退租状态包括待审批、审批中和已完成。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: [concept],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "现在退租状态有哪些？", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /知识任务路由：当前进展/);
  assert.equal(result.finalText, "退租状态包括待审批、审批中和已完成。");
});

test("现在有几个机构路由为数据口径而不是当前项目进展", async () => {
  let firstPrompt = "";
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享数据库目录", dataPlaybook: true },
    runAgent: async ({ prompt }) => {
      firstPrompt = prompt;
      return {
        text: "已按机构指标口径核对。",
        biTouched: true,
        timedOut: false,
        failed: false,
        loadedResources: [
          { source: "共享数据库库", path: "evolution/机构经验.md", depth: "experience", resourceType: "experience" },
          { source: "共享数据库库", path: "metrics/机构总数.md", depth: "metrics", resourceType: "metrics" },
          {
            source: "共享数据库库",
            path: "queries/机构总数.sql",
            depth: "sql",
            resourceType: "sql",
            verification: "verified",
          },
          { source: "共享数据库库", path: "tables/ajly_flow/system_tenant.md", depth: "table", resourceType: "table" },
        ],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  await handleTurn({ question: "现在有几个机构？", sessionKey: "wx-abc", deps });

  assert.match(firstPrompt, /知识任务路由：数据口径/);
  assert.doesNotMatch(firstPrompt, /知识任务路由：当前进展/);
});

test("查数只读手册不能交付数字，补齐证据组合后仍经过 Guard", async () => {
  const prompts = [];
  let guardCalls = 0;
  const playbook = {
    source: "共享查数资源",
    path: "prompts/data-playbook.md",
    depth: "playbook",
    sourceTime: "2026-11-01",
  };
  const experience = { source: "共享数据库库", path: "evolution/机构经验.md", depth: "experience" };
  const metrics = { source: "共享数据库库", path: "metrics/机构总数.md", depth: "metrics" };
  const sql = { source: "共享数据库库", path: "queries/机构总数.sql", depth: "sql", verification: "verified" };
  const table = { source: "共享数据库库", path: "tables/ajly_flow/system_tenant.md", depth: "table" };
  const deps = {
    state: fakeState(false),
    context: {
      catalog: "共享查数资源目录",
      dataPlaybook: true,
    },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          text: "我还没有确认机构口径。",
          biTouched: false,
          timedOut: false,
          failed: false,
          contextInsufficient: true,
          loadedResources: [],
        };
      }
      if (prompts.length === 2) {
        return {
          text: "现在有 56 家入驻机构。",
          biTouched: false,
          timedOut: false,
          failed: false,
          contextInsufficient: false,
          loadedResources: [playbook, experience],
        };
      }
      return {
        text: "现在有 56 家入驻机构。",
        biTouched: true,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: [metrics, sql, table],
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

  assert.equal(prompts.length, 3);
  assert.equal(prompts[0].includes("查数三步走"), false);
  assert.match(prompts[1], /查数手册|data-playbook/);
  assert.match(prompts[2], /SQL|表文档/);
  assert.deepEqual(result.loadedResources, [playbook, experience, metrics, sql, table]);
  assert.equal(result.loadDepth, "sql");
  assert.equal(result.finalText, "现在有 56 家入驻机构。");
  assert.equal(result.guarded, true);
  assert.equal(guardCalls, 1);
});

test("查数首轮只读概念页时即使模型未报不足也不能直接给数", async () => {
  const prompts = [];
  const concept = { source: "共享业务库", path: "wiki/概念/机构.md", depth: "concept", resourceType: "concept" };
  const experience = {
    source: "共享数据库库",
    path: "evolution/机构经验.md",
    depth: "experience",
    resourceType: "experience",
  };
  const metrics = { source: "共享数据库库", path: "metrics/机构总数.md", depth: "metrics", resourceType: "metrics" };
  const sql = {
    source: "共享数据库库",
    path: "queries/机构总数.sql",
    depth: "sql",
    resourceType: "sql",
    verification: "verified",
  };
  const table = {
    source: "共享数据库库",
    path: "tables/ajly_flow/system_tenant.md",
    depth: "table",
    resourceType: "table",
  };
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享业务与数据库目录", dataPlaybook: true },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const deepened = prompts.length === 2;
      return {
        text: deepened ? "按共享经验和当前指标卡核对后，机构总数才能确认。" : "一共有 56 家。",
        biTouched: deepened,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: deepened ? [experience, metrics, sql, table] : [concept],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "查一下机构总数", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /历史经验/);
  assert.match(prompts[1], /指标卡/);
  assert.equal(result.finalText.includes("56"), false);
  assert.deepEqual(result.loadedResources, [concept, experience, metrics, sql, table]);
});

test("查数资料不足时按经验、指标、SQL 和表文档继续深化并保留校验语义", async () => {
  const prompts = [];
  const concept = { source: "共享业务库", path: "wiki/概念/机构.md", depth: "concept" };
  const playbook = { source: "共享查数资源", path: "prompts/data-playbook.md", depth: "playbook" };
  const experience = { source: "共享数据库库", path: "evolution/机构经验.md", depth: "experience" };
  const metrics = { source: "共享数据库库", path: "metrics/机构总数.md", depth: "metrics" };
  const sql = {
    source: "共享数据库库",
    path: "queries/机构总数.sql",
    depth: "sql",
    verification: "verified",
  };
  const table = { source: "共享数据库库", path: "tables/ajly_flow/system_tenant.md", depth: "table" };
  const deps = {
    state: fakeState(false),
    context: {
      catalog: "共享业务库与共享数据库库目录",
      dataPlaybook: true,
    },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          text: "概念页没有机构总数的统计口径。",
          biTouched: false,
          timedOut: false,
          failed: false,
          contextInsufficient: true,
          loadedResources: [concept],
        };
      }
      if (prompts.length === 2) {
        return {
          text: "手册、经验和指标卡还不足以确认具体表关联。",
          biTouched: false,
          timedOut: false,
          failed: false,
          contextInsufficient: true,
          loadedResources: [playbook, experience, metrics],
        };
      }
      return {
        text: "已按指标口径、已验证 SQL 的关联路径和表文档核对机构总数。",
        biTouched: true,
        timedOut: false,
        failed: false,
        loadedResources: [sql, table],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "查一下乐租租机构总数", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /数据口径/);
  assert.match(prompts[1], /经验/);
  assert.match(prompts[1], /指标/);
  assert.match(prompts[2], /已验证/);
  assert.match(prompts[2], /未验证/);
  assert.match(prompts[2], /表文档/);
  assert.deepEqual(
    result.loadedResources.map((resource) => resource.depth),
    ["concept", "playbook", "experience", "metrics", "sql", "table"],
  );
  assert.equal(result.finalText, "已按指标口径、已验证 SQL 的关联路径和表文档核对机构总数。");
});

test("新旧指标口径对比路由为数据任务并优先最新明确拍板资料", async () => {
  const prompts = [];
  const historical = {
    source: "共享数据库库",
    path: "metrics/history/出租率.md",
    depth: "metrics",
    resourceType: "metrics",
    sourceTime: "2026-08-01",
    validity: "history",
    scope: "shared",
  };
  const current = {
    source: "共享数据库库",
    path: "metrics/出租率.md",
    depth: "metrics",
    resourceType: "metrics",
    sourceTime: "2026-11-01",
    validity: "current",
    scope: "shared",
  };
  const experience = {
    source: "共享数据库库",
    path: "evolution/出租率经验.md",
    depth: "experience",
    resourceType: "experience",
    scope: "shared",
  };
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享数据库目录", dataPlaybook: true },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const deepened = prompts.length === 2;
      return {
        text: deepened
          ? "2026 年 11 月 1 日明确生效的新口径优先；8 月历史讨论只用于说明旧算法。"
          : "只找到 8 月历史口径，还没确认当前有效版本。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: !deepened,
        loadedResources: deepened ? [experience, current] : [historical],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({
    question: "以前出租率的口径和现在有什么区别？",
    sessionKey: "wx-abc",
    deps,
  });

  assert.match(prompts[0], /知识任务路由：数据口径/);
  assert.doesNotMatch(prompts[0], /知识任务路由：历史事件/);
  assert.match(prompts[1], /validity=current/);
  assert.match(prompts[1], /history|历史讨论/);
  assert.match(prompts[1], /冲突/);
  assert.match(result.finalText, /新口径优先/);
});

test("含总数的纯口径解释只需经验和适用指标，不强制 SQL 表文档或 BI", async () => {
  const prompts = [];
  const evidence = [
    { source: "共享数据库库", path: "evolution/机构经验.md", depth: "experience", resourceType: "experience" },
    { source: "共享数据库库", path: "metrics/机构总数.md", depth: "metrics", resourceType: "metrics" },
  ];
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享数据库目录", dataPlaybook: true },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        text: "机构总数按有效入驻机构统计，排除门店品牌配置。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: evidence,
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "机构总数的口径是什么？", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 1);
  assert.equal(result.finalText, "机构总数按有效入驻机构统计，排除门店品牌配置。");
  assert.equal(result.guarded, false);
});

test("实际查数使用未验证或已知问题 SQL 时不能交付数字", async () => {
  for (const verification of ["unverified", "known-issue"]) {
    const prompts = [];
    let guardCalls = 0;
    const evidence = dataEvidence(verification);
    const deps = {
      state: fakeState(false),
      context: { catalog: "共享数据库目录", dataPlaybook: true },
      runAgent: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          text: "现在有 56 家机构。",
          biTouched: true,
          timedOut: false,
          failed: false,
          contextInsufficient: false,
          loadedResources: evidence,
        };
      },
      review: async () => {
        guardCalls += 1;
        return { verdict: "ALLOW" };
      },
    };

    const result = await handleTurn({ question: "查一下机构总数", sessionKey: "wx-abc", deps });

    assert.equal(result.finalText.includes("56"), false);
    assert.match(result.finalText, /已验证 SQL/);
    assert.equal(result.guarded, true);
    assert.equal(guardCalls, 1);
    assert.equal(prompts.length, 3);
  }
});

test("首轮已执行 BI 时后续补 SQL 和表文档可累计现查证据", async () => {
  const prompts = [];
  let guardCalls = 0;
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享数据库目录", dataPlaybook: true },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const first = prompts.length === 1;
      return {
        text: "现在有 56 家机构。",
        biTouched: first,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: first ? dataEvidence().slice(0, 2) : dataEvidence().slice(2),
      };
    },
    review: async () => {
      guardCalls += 1;
      return { verdict: "ALLOW" };
    },
  };

  const result = await handleTurn({ question: "查一下机构总数", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 2);
  assert.equal(result.finalText, "现在有 56 家机构。");
  assert.equal(result.guarded, true);
  assert.equal(guardCalls, 1);
});

test("实际查数资源齐全但本轮未执行 BI 时不能交付现查数字", async () => {
  let guardCalls = 0;
  const evidence = dataEvidence();
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享数据库目录", dataPlaybook: true },
    runAgent: async () => ({
      text: "现在有 56 家机构。",
      biTouched: false,
      timedOut: false,
      failed: false,
      contextInsufficient: false,
      loadedResources: evidence,
    }),
    review: async () => {
      guardCalls += 1;
      return { verdict: "ALLOW" };
    },
  };

  const result = await handleTurn({ question: "查一下机构总数", sessionKey: "wx-abc", deps });

  assert.equal(result.finalText.includes("56"), false);
  assert.match(result.finalText, /BI 查询|BI 查询验证/);
  assert.equal(result.guarded, false);
  assert.equal(guardCalls, 0);
});

test("统计一下机构总数属于实际查数并需 BI 与 Guard", async () => {
  const prompts = [];
  let guardCalls = 0;
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享数据库目录", dataPlaybook: true },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        text: "统计结果现在有 56 家机构。",
        biTouched: prompts.length === 3,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: prompts.length === 1 ? dataEvidence().slice(0, 2) : dataEvidence(),
      };
    },
    review: async () => {
      guardCalls += 1;
      return { verdict: "ALLOW" };
    },
  };

  const result = await handleTurn({ question: "统计一下机构总数", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 3);
  assert.equal(result.finalText, "统计结果现在有 56 家机构。");
  assert.equal(result.guarded, true);
  assert.equal(guardCalls, 1);
  assert.equal(result.loadedResources.length, 4);
});

test("查数资料深化后仍不足时不交付猜数并指出缺少的来源", async () => {
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享查数目录", dataPlaybook: true },
    runAgent: async ({ prompt }) => {
      const finalAttempt = prompt.includes("继续完成数据口径任务");
      return {
        text: finalAttempt ? "一共有 56 家。" : "还缺资料。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: !finalAttempt,
        loadedResources: finalAttempt
          ? [{ source: "共享数据库库", path: "queries/机构.sql", depth: "sql", resourceType: "sql" }]
          : [],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "查一下机构总数", sessionKey: "wx-abc", deps });

  assert.equal(result.finalText.includes("56"), false);
  assert.match(result.finalText, /资料不足/);
  assert.match(result.finalText, /经验/);
  assert.match(result.finalText, /指标/);
  assert.match(result.finalText, /表文档/);
});

test("历史事件从共享时间线深化到当时记录和决策资料", async () => {
  const prompts = [];
  const timeline = sharedTimeline({ depth: "concept" });
  const record = sharedRecord();
  const decision = {
    source: "共享记忆",
    path: "wiki/决策/退租审批.md",
    depth: "document",
    resourceType: "decision",
    sourceTime: "2026-08-02",
    validity: "history",
    scope: "shared",
  };
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享记忆目录，含时间线、当时记录和决策资料" },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const deepened = prompts.length === 2;
      return {
        text: deepened
          ? "2026 年 8 月 1 日讨论后决定改为两级审批，当时的记录说明是为了补充业务复核。"
          : "时间线只定位到 2026 年 8 月的审批调整，没有当时原因。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: !deepened,
        loadedResources: deepened ? [record, decision] : [timeline],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({
    question: "退租审批当时为什么从一级改成两级？",
    sessionKey: "wx-abc",
    deps,
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /历史事件/);
  assert.match(prompts[0], /共享时间线/);
  assert.match(prompts[1], /当时记录/);
  assert.match(prompts[1], /决策资料/);
  assert.match(prompts[1], /共享/);
  assert.match(result.finalText, /2026 年 8 月 1 日/);
  assert.deepEqual(result.loadedResources, [timeline, record, decision]);
  assert.equal(result.loadDepth, "raw");
});

test("历史具体事实也需要当时记录而不能只看时间线摘要", async () => {
  const prompts = [];
  const timeline = sharedTimeline();
  const record = sharedRecord();
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享记忆目录" },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const deepened = prompts.length === 2;
      return {
        text: deepened ? "2026 年 8 月 1 日的当时记录明确写明改成两级审批。" : "当时改成两级审批。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: deepened ? [record] : [timeline],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "退租审批当时改成几级？", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /当时记录/);
  assert.match(result.finalText, /当时记录明确写明/);
  assert.deepEqual(result.loadedResources, [timeline, record]);
});

test("当时由谁拍板也必须读取时间线和当时记录", async () => {
  const prompts = [];
  const timeline = sharedTimeline();
  const record = sharedRecord();
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享记忆目录" },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const deepened = prompts.length === 2;
      return {
        text: deepened ? "当时记录显示，这次调整由业务负责人拍板。" : "当时由业务负责人拍板。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: deepened ? [record] : [timeline],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "退租审批当时由谁拍板？", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /当时记录/);
  assert.match(result.finalText, /当时记录显示/);
});

test("历史具体事实只有 decision 没有 record 时仍返回缺口", async () => {
  const prompts = [];
  const timeline = sharedTimeline();
  const decision = {
    source: "共享记忆",
    path: "wiki/决策/退租审批.md",
    depth: "document",
    resourceType: "decision",
    sourceTime: "2026-08-02",
    validity: "history",
    scope: "shared",
  };
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享记忆目录" },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        text: "当时改成两级审批。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: [timeline, decision],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "退租审批当时改成几级？", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 2);
  assert.equal(result.finalText.includes("两级审批"), false);
  assert.match(result.finalText, /缺少：.*当时记录/);
});

test("历史原因不能只用当前项目资料作答", async () => {
  const prompts = [];
  const current = sharedProject({ path: "projects/退租审批/当前进展.md", sourceTime: "2026-11-02" });
  const timeline = sharedTimeline();
  const record = sharedRecord({ path: "raw/收件箱/2026-08-01--讨论.md" });
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享记忆与项目目录" },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const deepened = prompts.length === 2;
      return {
        text: deepened ? "2026 年 8 月 1 日的当时记录说明，调整原因是缺少业务复核。" : "当时是为了提高审批效率。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: deepened ? [timeline, record] : [current],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "退租审批当时为什么改成两级？", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /共享时间线/);
  assert.match(prompts[1], /当时记录/);
  assert.equal(result.finalText.includes("提高审批效率"), false);
  assert.deepEqual(result.loadedResources, [current, timeline, record]);
});

test("历史问题同时追问现状时补充最新共享项目资料", async () => {
  const prompts = [];
  const timeline = sharedTimeline();
  const record = sharedRecord({ path: "raw/收件箱/2026-08-01--讨论.md" });
  const project = sharedProject({ path: "projects/退租审批/当前进展.md", sourceTime: "2026-11-02" });
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享记忆与共享项目资料目录" },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const deepened = prompts.length === 2;
      return {
        text: deepened
          ? "当时因缺少业务复核改为两级审批；截至 2026 年 11 月 2 日，新的线上审批正在联调。"
          : "时间线没有当时讨论和当前进展。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: !deepened,
        loadedResources: deepened ? [record, project] : [timeline],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({
    question: "退租审批当时为什么改成两级，现在新的线上审批进展怎样？",
    sessionKey: "wx-abc",
    deps,
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /当时记录/);
  assert.match(prompts[1], /最新.*共享.*项目资料|最新共享项目资料/);
  assert.match(prompts[1], /history|历史资料/);
  assert.match(prompts[1], /current/);
  assert.deepEqual(result.loadedResources, [timeline, record, project]);
  assert.match(result.finalText, /2026 年 11 月 2 日/);
});

test("历史与现状缺证据时即使模型自报充分也返回具体缺口", async () => {
  const prompts = [];
  const timeline = sharedTimeline();
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享记忆与项目目录" },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const second = prompts.length === 2;
      return {
        text: second ? "当时是为了提高效率，现在已经上线。" : "时间线还需要当时记录核对。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: !second,
        loadedResources: second ? [] : [timeline],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({
    question: "退租审批当时为什么改成两级，现在进展怎样？",
    sessionKey: "wx-abc",
    deps,
  });

  assert.equal(prompts.length, 2);
  assert.equal(result.finalText.includes("提高效率"), false);
  assert.equal(result.finalText.includes("已经上线"), false);
  assert.match(result.finalText, /资料不足/);
  assert.match(result.finalText, /当时记录|决策资料/);
  assert.match(result.finalText, /最新.*共享.*项目资料|最新共享项目资料/);
});

test("当前进展选择最新共享项目资料而不把历史讨论当成现状", async () => {
  const prompts = [];
  const current = sharedProject({ path: "projects/房源审核/进展.md" });
  const deps = {
    state: fakeState(false),
    context: {
      catalog: [
        "共享项目资料 | projects/房源审核/进展.md | source_time: 2026-11-03 | validity: current | scope: shared",
        "共享项目资料 | history/房源审核旧讨论.md | source_time: 2026-09-01 | validity: history | scope: shared",
      ].join("\n"),
    },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        text: "截至 2026 年 11 月 3 日的共享项目资料，房源审核功能正在联调，尚未上线。",
        biTouched: false,
        timedOut: false,
        failed: false,
        loadedResources: [current],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "房源审核功能目前进展如何？", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /当前进展/);
  assert.match(prompts[0], /最新/);
  assert.match(prompts[0], /source_time/);
  assert.match(prompts[0], /current/);
  assert.match(prompts[0], /共享/);
  assert.deepEqual(result.loadedResources, [current]);
  assert.match(result.finalText, /2026 年 11 月 3 日/);
});

test("当前进展不能只读历史项目资料作答", async () => {
  const prompts = [];
  const history = sharedProject({
    path: "projects/房源审核/历史讨论.md",
    sourceTime: "2026-09-01",
    validity: "history",
  });
  const current = sharedProject();
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享项目资料目录" },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const deepened = prompts.length === 2;
      return {
        text: deepened ? "截至 2026 年 11 月 3 日仍在联调，尚未上线。" : "已经上线。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: [deepened ? current : history],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "房源审核最新进展如何？", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /validity=current/);
  assert.equal(result.finalText.includes("已经上线"), false);
  assert.deepEqual(result.loadedResources, [history, current]);
});

test("旧 current 项目资料不能冒充 sourceTime 最新的当前进展", async () => {
  const prompts = [];
  const oldCurrent = sharedProject({ path: "projects/房源审核/旧进展.md", sourceTime: "2026-10-01" });
  const latest = sharedProject();
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享项目资料目录", entries: [oldCurrent, latest] },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const deepened = prompts.length === 2;
      return {
        text: deepened ? "截至 2026 年 11 月 3 日仍在联调，尚未上线。" : "已经上线。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: false,
        loadedResources: [deepened ? latest : oldCurrent],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "房源审核最新进展如何？", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /source_time/);
  assert.equal(result.finalText.includes("已经上线"), false);
  assert.match(result.finalText, /2026 年 11 月 3 日/);
  assert.deepEqual(result.loadedResources, [oldCurrent, latest]);
});

test("当前进展冲突未消解时不交付看似确定的现状", async () => {
  const prompts = [];
  const old = sharedProject({
    path: "projects/房源审核/历史讨论.md",
    sourceTime: "2026-09-01",
    validity: "history",
  });
  const current = sharedProject();
  const deps = {
    state: fakeState(false),
    context: { catalog: "共享项目资料目录，含新旧进展" },
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      const second = prompts.length === 2;
      return {
        text: second ? "已经上线。" : "新旧资料对上线状态的描述不一致。",
        biTouched: false,
        timedOut: false,
        failed: false,
        contextInsufficient: true,
        loadedResources: second ? [] : [old, current],
      };
    },
    review: async () => ({ verdict: "ALLOW" }),
  };

  const result = await handleTurn({ question: "房源审核最新进展如何？", sessionKey: "wx-abc", deps });

  assert.equal(prompts.length, 2);
  assert.equal(result.finalText.includes("已经上线"), false);
  assert.match(result.finalText, /资料不足|冲突/);
  assert.match(result.finalText, /最新/);
  assert.match(result.finalText, /拍板/);
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

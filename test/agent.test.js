import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { runAgentTurn } from "../src/agent.js";

/**
 * 造一个假的子进程：按顺序吐 JSONL，然后结束。
 *
 * @param {string[]} lines
 * @param {{exitCode?: number|null, ending?: boolean}} [options]
 * @returns {(options: any) => any}
 */
function fakeRunner(lines, { exitCode = 0, ending = true } = {}) {
  return () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };

    queueMicrotask(() => {
      for (const line of lines) child.stdout.emit("data", `${line}\n`);
      if (ending) child.emit("close", exitCode);
    });

    return child;
  };
}

/**
 * 一条 assistant 文本消息事件。
 * @param {string} text
 */
function textMessage(text) {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/**
 * 一条 bash 工具调用事件。
 * @param {string} command
 */
function bashTool(command, toolCallId = "call-1") {
  return JSON.stringify({
    type: "tool_execution_start",
    toolCallId,
    toolName: "bash",
    args: { command },
  });
}

/**
 * 一条 bash 工具完成事件。
 * @param {string} command
 * @param {{toolCallId?: string, isError?: boolean, exitCode?: number, text?: string, result?: any}} [options]
 */
function bashToolEnd(command, { toolCallId = "call-1", isError = false, exitCode = 0, text = "ok", result } = {}) {
  return JSON.stringify({
    type: "tool_execution_end",
    toolCallId,
    toolName: "bash",
    args: { command },
    result: result ?? { content: [{ type: "text", text }], details: { exitCode } },
    isError,
  });
}

test("从事件流提取最终答复", async () => {
  const runner = fakeRunner([textMessage("这是最终答案")]);

  const result = await runAgentTurn({ prompt: "问个问题", sessionId: "wx-abc", runner });

  assert.equal(result.text, "这是最终答案");
  assert.equal(result.timedOut, false);
});

test("多条 assistant 消息取最后一条非空文本", async () => {
  const runner = fakeRunner([textMessage("中间过程"), textMessage("最终答案")]);

  const result = await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner });

  assert.equal(result.text, "最终答案");
});

test("忽略只含工具调用的 assistant 消息", async () => {
  const toolOnly = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] },
  });
  const runner = fakeRunner([toolOnly, textMessage("真答案")]);

  const result = await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner });

  assert.equal(result.text, "真答案");
});

test("bi_query.py 真实执行成功完成时 biTouched 才为真", async () => {
  const command = "python3 /Users/kyle/Desktop/PM/信息技术部资产库/知识库/数据库/ajly-db-wiki/scripts/bi_query.py 'SELECT 1'";
  const runner = fakeRunner([
    bashTool(command),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "1" }], details: { exitCode: 0 } },
      isError: false,
    }),
    textMessage("查询结果"),
  ]);

  const result = await runAgentTurn({ prompt: "查数据", sessionId: "wx-abc", runner });

  assert.equal(result.biTouched, true);
});

test("bi_query.py 证据识别支持合法转义、引号与拼接，并按 toolCallId 关联完成事件", async () => {
  const commands = [
    String.raw`python3 /trusted/bi\_query.py "SELECT 1"`,
    String.raw`python /trusted/data\ folder/bi_query.py "SELECT 1"`,
    `python3 "/trusted/"'bi_query'".py" "SELECT 1"`,
    `python3 /trusted/bi''_query.py 'SELECT 1'`,
    `python3 '/trusted/bi_query.py' "SELECT 1"`,
    `python3 "/trusted/literal*/bi_query.py" "SELECT 1"`,
    `python3 '/trusted/{archive}/bi_query.py' "SELECT 1"`,
    `python3 '/trusted/$HOME/bi_query.py' "SELECT 1"`,
    `python3 '/trusted/@(literal)/bi_query.py' "SELECT 1"`,
    String.raw`python3 /trusted/literal\*/bi_query.py "SELECT 1"`,
    String.raw`python3 /trusted/\~/bi_query.py "SELECT 1"`,
  ];

  for (const [index, command] of commands.entries()) {
    const toolCallId = `quoted-bi-${index}`;
    const other = "echo python3 /trusted/bi_query.py";
    const runner = fakeRunner([
      bashTool(command, toolCallId),
      bashTool(other, `echo-${index}`),
      bashToolEnd(other, { toolCallId: `echo-${index}` }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId,
        toolName: "bash",
        result: { content: [{ type: "text", text: "1" }], details: { exitCode: 0 } },
        isError: false,
      }),
      textMessage("查询结果"),
    ]);

    const result = await runAgentTurn({ prompt: "查数据", sessionId: `wx-${index}`, runner });
    assert.equal(result.biTouched, true, command);
  }
});

test("bi_query.py 证据识别拒绝假阳性、展开和无法安全解析的命令", async () => {
  const commands = [
    `echo "python3 /trusted/bi_query.py"`,
    `python3 /trusted/search_wiki.py "bi_query.py"`,
    `python3 -c "print('bi_query.py')" /trusted/bi_query.py`,
    `python3 /trusted/not_bi_query.py "SELECT 1"`,
    `python3 "$BI_SCRIPT" "SELECT 1"`,
    `python3 /trusted/*/bi_query.py "SELECT 1"`,
    `python3 /trusted/?/bi_query.py "SELECT 1"`,
    `python3 /trusted/[ab]/bi_query.py "SELECT 1"`,
    `python3 /trusted/{ajly,lzz}/bi_query.py "SELECT 1"`,
    `python3 /trusted/@(ajly|lzz)/bi_query.py "SELECT 1"`,
    `python3 /trusted/+(ajly|lzz)/bi_query.py "SELECT 1"`,
    `python3 /trusted/!(copy)/bi_query.py "SELECT 1"`,
    `python3 /trusted/*(copy)/bi_query.py "SELECT 1"`,
    `python3 /trusted/?(copy)/bi_query.py "SELECT 1"`,
    `python3 ~/bi_query.py "SELECT 1"`,
    `python3 /trusted/~/bi_query.py "SELECT 1"`,
    `python3 $(printf /trusted/bi_query.py) "SELECT 1"`,
    `python3 \`/trusted/bi_query.py\` "SELECT 1"`,
    `python3 <(printf /trusted/bi_query.py) "SELECT 1"`,
    `python3 >(printf /trusted/bi_query.py) "SELECT 1"`,
    `python3 /trusted/bi_query.py SELECT * FROM tenant`,
    `python3 "/trusted/bi_query.py "SELECT 1"`,
    "python3 /trusted/bi_query.py\\",
    `python3 /trusted/bi_query.py "SELECT 1"; echo done`,
  ];

  for (const [index, command] of commands.entries()) {
    const runner = fakeRunner([
      bashTool(command),
      bashToolEnd(command),
      textMessage("没有可信 BI 执行证据"),
    ]);
    const result = await runAgentTurn({ prompt: "查数据", sessionId: `false-${index}`, runner });
    assert.equal(result.biTouched, false, command);
  }
});

test("bi_query.py 完成事件不能借用其他 toolCallId 的开始命令", async () => {
  const command = "python3 /trusted/bi_query.py 'SELECT 1'";
  const runner = fakeRunner([
    bashTool(command, "actual-bi"),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "different-call",
      toolName: "bash",
      result: { content: [{ type: "text", text: "done" }], details: { exitCode: 0 } },
      isError: false,
    }),
    textMessage("没有完成事件对应关系"),
  ]);

  const result = await runAgentTurn({ prompt: "查数据", sessionId: "wx-mismatch", runner });
  assert.equal(result.biTouched, false);
});

test("bi_query.py 只有开始事件或执行 DENY、异常、非零与错误结果时 biTouched 均为假", async () => {
  const command = "python3 /instance/context/copy/bi_query.py 'SELECT 1'";
  const cases = [
    { name: "只有开始", events: [bashTool(command)] },
    {
      name: "扩展 DENY",
      events: [bashTool(command), bashToolEnd(command, { isError: true, text: "执行审批 DENY" })],
    },
    {
      name: "执行异常",
      events: [bashTool(command), bashToolEnd(command, { isError: true, text: "spawn failed" })],
    },
    {
      name: "非零退出",
      events: [bashTool(command), bashToolEnd(command, { exitCode: 2, text: "query failed" })],
    },
    {
      name: "错误结果",
      events: [bashTool(command), bashToolEnd(command, { result: { error: "database unavailable" } })],
    },
  ];
  for (const item of cases) {
    const result = await runAgentTurn({
      prompt: "查数据",
      sessionId: "wx-abc",
      runner: fakeRunner([...item.events, textMessage("没有查询结果")]),
    });
    assert.equal(result.biTouched, false, item.name);
  }
});

test("未调用 bi_query.py 时 biTouched 为假", async () => {
  const runner = fakeRunner([
    bashTool("python3 /Users/kyle/Desktop/PM/.agents/skills/ajly-wiki/scripts/search_wiki.py 退租"),
    textMessage("退租的定义是…"),
  ]);

  const result = await runAgentTurn({ prompt: "退租是什么", sessionId: "wx-abc", runner });

  assert.equal(result.biTouched, false);
});

test("搜索或读取 bi_query.py 文件名成功也不算执行 BI", async () => {
  const command = "rg bi_query.py /instance/context";
  const runner = fakeRunner([
    bashTool(command),
    bashToolEnd(command, { text: "queries/bi_query.py" }),
    textMessage("只找到文件"),
  ]);

  const result = await runAgentTurn({ prompt: "找查询入口", sessionId: "wx-abc", runner });

  assert.equal(result.biTouched, false);
});

test("多次 bi_query.py 调用只有成功完成的一次会置 biTouched", async () => {
  const denied = "python3 /instance/context/bi_query.py 'SELECT 1'";
  const trusted = "python3 /trusted/lzz/scripts/bi_query.py 'SELECT 1'";
  const runner = fakeRunner([
    bashTool(denied, "denied"),
    bashToolEnd(denied, { toolCallId: "denied", isError: true, text: "DENY" }),
    bashTool(trusted, "trusted"),
    bashToolEnd(trusted, { toolCallId: "trusted", text: "1" }),
    textMessage("答案"),
  ]);

  const result = await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner });

  assert.equal(result.biTouched, true);
});

test("进程失败时返回错误但不抛异常", async () => {
  const runner = fakeRunner([], { exitCode: 1 });

  const result = await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner });

  assert.equal(result.text, "");
  assert.equal(result.failed, true);
});

test("超时时杀掉进程并标记 timedOut", async () => {
  const runner = () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    return child;
  };

  const result = await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner, timeoutMs: 30 });

  assert.equal(result.timedOut, true);
});

test("忽略非法 JSON 行", async () => {
  const runner = fakeRunner(["这不是 json", textMessage("答案还在")]);

  const result = await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner });

  assert.equal(result.text, "答案还在");
});

test("把 prompt 与 sessionId 传给 runner", async () => {
  /** @type {any} */
  let seen = null;
  const runner = (/** @type {any} */ options) => {
    seen = options;
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };

  await runAgentTurn({ prompt: "我的问题", sessionId: "wx-abc", runner });

  assert.equal(seen.prompt, "我的问题");
  assert.equal(seen.sessionId, "wx-abc");
});

test("事件流持续有输出时不会因空闲判定被杀", async () => {
  const runner = () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      child.stdout.emit("data", `${JSON.stringify({ type: "message_update" })}\n`);
      if (ticks === 4) {
        clearInterval(timer);
        child.stdout.emit("data", `${textMessage("想清楚了")}\n`);
        child.emit("close", 0);
      }
    }, 10);
    return child;
  };

  const result = await runAgentTurn({
    prompt: "问",
    sessionId: "wx-abc",
    runner,
    idleTimeoutMs: 40,
    hardTimeoutMs: 500,
  });

  assert.equal(result.text, "想清楚了");
  assert.equal(result.stalled, false);
  assert.equal(result.timedOut, false);
});

test("静默超过空闲阈值时判定卡住并杀掉进程", async () => {
  const runner = () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    return child;
  };

  const result = await runAgentTurn({
    prompt: "问",
    sessionId: "wx-abc",
    runner,
    idleTimeoutMs: 30,
    hardTimeoutMs: 5000,
  });

  assert.equal(result.stalled, true);
  assert.equal(result.timedOut, false);
});

test("有进展也会被总时长上限截断", async () => {
  const runner = () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    const timer = setInterval(() => child.stdout.emit("data", `${JSON.stringify({ type: "message_update" })}\n`), 10);
    child.on("close", () => clearInterval(timer));
    return child;
  };

  const result = await runAgentTurn({
    prompt: "问",
    sessionId: "wx-abc",
    runner,
    idleTimeoutMs: 100,
    hardTimeoutMs: 60,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.stalled, false);
});

test("回传上一轮的输入 token 数", async () => {
  const runner = fakeRunner([
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "答案" }], usage: { input: 51234, output: 800 } },
    }),
  ]);

  const result = await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner });

  assert.equal(result.inputTokens, 51234);
});

test("把思考强度传给 runner", async () => {
  /** @type {any} */
  let seen = null;
  const runner = (/** @type {any} */ options) => {
    seen = options;
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };

  await runAgentTurn({ prompt: "问", sessionId: "wx-abc", runner, thinkingLevel: "low" });

  assert.equal(seen.thinkingLevel, "low");
});

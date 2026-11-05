import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import filesystemWhitelist, { processApprovedToolCall } from "../extensions/bash-whitelist.ts";

async function makeCopyRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "wsb-execution-approval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copyRoot = join(root, "instance/context");
  await mkdir(copyRoot, { recursive: true });
  return { root, copyRoot };
}

function writeEvent(path, content = "approved content") {
  return {
    type: "tool_call",
    toolCallId: "write-1",
    toolName: "write",
    input: { path, content },
  };
}

let extensionLoadSequence = 0;

function setEnv(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function startApprovalModel(t, replyFor) {
  const calls = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body);
      calls.push({ ...payload, authorization: request.headers.authorization });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: replyFor(payload, calls.length) } }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { calls, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function loadEnabledApprovalHook(t, { readRoots, writeRoots, protectedRoots = [], baseUrl }) {
  setEnv(t, "WECOM_BOT_LOCAL_INSTANCE", "1");
  setEnv(t, "WECOM_BOT_ROOTS", JSON.stringify(readRoots));
  setEnv(t, "WECOM_BOT_WRITE_ROOTS", JSON.stringify(writeRoots));
  setEnv(t, "WECOM_BOT_PROTECTED_ROOTS", JSON.stringify(protectedRoots));
  setEnv(t, "WECOM_BOT_EXECUTION_APPROVAL", JSON.stringify({
    enabled: true,
    baseUrl,
    apiKey: "approval-key",
    model: "approval-model",
    timeoutMs: 1000,
  }));
  setEnv(t, "WECOM_BOT_MODEL_CLIENT_PATH", fileURLToPath(new URL("../src/model-client.js", import.meta.url)));
  setEnv(t, "WECOM_BOT_PI_PROVIDER", "local-instance");

  const extensionUrl = new URL("../extensions/bash-whitelist.ts", import.meta.url);
  extensionLoadSequence += 1;
  extensionUrl.searchParams.set("s13", String(extensionLoadSequence));
  const { default: loadExtension } = await import(extensionUrl.href);
  let handler;
  loadExtension({ on: (eventName, callback) => {
    if (eventName === "tool_call") handler = callback;
  } });
  assert.equal(typeof handler, "function");
  return handler;
}

function taskContext(goal) {
  return {
    sessionManager: {
      getBranch: () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: goal }] } }],
    },
  };
}

test("S13 硬规则允许且审批模型 ALLOW 时执行当前副本内写入", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  const target = join(copyRoot, "reports/weekly.md");
  const event = writeEvent(target, "完整的新报告内容");
  const modelCalls = [];
  const logEntries = [];
  let executed = 0;

  const result = await processApprovedToolCall({
    event,
    task: { goal: "生成本周报告", necessaryChange: "创建周报文件" },
    writeRoots: [copyRoot],
    protectedRoots: [],
    callModel: async (messages) => {
      modelCalls.push(messages);
      return "ALLOW\n理由：写入与周报任务直接相关且范围明确\n风险：低";
    },
    execute: async (receivedEvent) => {
      assert.equal(receivedEvent, event);
      executed += 1;
      return { written: receivedEvent.input.path };
    },
    logger: (entry) => logEntries.push(entry),
  });

  assert.equal(result.verdict, "ALLOW");
  assert.equal(result.source, "model");
  assert.equal(result.riskCategory, "low");
  assert.equal(executed, 1);
  assert.deepEqual(result.executionResult, { written: target });
  assert.equal(modelCalls.length, 1);
  const prompt = JSON.stringify(modelCalls[0]);
  assert.match(prompt, /生成本周报告/);
  assert.match(prompt, /完整的新报告内容/);
  assert.match(prompt, /write-1/);
  assert.equal(logEntries.length, 1);
  assert.equal(logEntries[0].verdict, "ALLOW");
  assert.equal(logEntries[0].toolCallId, "write-1");
  assert.equal(JSON.stringify(logEntries[0]).includes("完整的新报告内容"), false);
});

test("S13 模型 DENY 时不执行并把可操作理由返回主 Agent", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  const modelReason = "变更超出当前任务范围，请只修改周报；MODEL_REASON_FAKE_CREDENTIAL_7f3c9a；MODEL_REASON_WRITE_BODY_机密写入正文";
  const logEntries = [];
  let executed = 0;

  const result = await processApprovedToolCall({
    event: { type: "tool_call", toolCallId: "edit-1", toolName: "edit", input: { path: join(copyRoot, "rules.md"), edits: [{ oldText: "旧", newText: "新" }] } },
    task: { goal: "修改规则" },
    writeRoots: [copyRoot],
    callModel: async () => `DENY\n理由：${modelReason}\n风险：中`,
    execute: async () => {
      executed += 1;
    },
    logger: (entry) => logEntries.push(entry),
  });

  assert.equal(result.verdict, "DENY");
  assert.equal(result.riskCategory, "medium");
  assert.equal(result.reason, modelReason, "主 Agent 仍需收到模型给出的具体 DENY 理由");
  assert.equal(executed, 0);
  assert.equal(logEntries.length, 1);
  assert.equal(logEntries[0].reason, "model-deny");
  assert.equal(JSON.stringify(logEntries).includes("MODEL_REASON_FAKE_CREDENTIAL_7f3c9a"), false);
  assert.equal(JSON.stringify(logEntries).includes("MODEL_REASON_WRITE_BODY_机密写入正文"), false);
});

test("S13 副本外写入被硬规则拒绝且模型 ALLOW 不能覆盖", async (t) => {
  const { root, copyRoot } = await makeCopyRoot(t);
  let modelCalls = 0;
  let executed = 0;

  const result = await processApprovedToolCall({
    event: writeEvent(join(root, "outside.md")),
    writeRoots: [copyRoot],
    callModel: async () => {
      modelCalls += 1;
      return "ALLOW\n理由：副本可恢复\n风险：低";
    },
    execute: async () => {
      executed += 1;
    },
  });

  assert.equal(result.verdict, "DENY");
  assert.equal(result.source, "hard-rule");
  assert.match(result.reason, /副本外/);
  assert.equal(modelCalls, 0);
  assert.equal(executed, 0);
});

test("S13 主工作区即使被错误放进可写根也仍受硬保护", async (t) => {
  const { root } = await makeCopyRoot(t);
  const mainWorkspace = join(root, "main-workspace");
  let modelCalls = 0;

  const result = await processApprovedToolCall({
    event: writeEvent(join(mainWorkspace, "src/index.js")),
    writeRoots: [root],
    protectedRoots: [mainWorkspace],
    callModel: async () => {
      modelCalls += 1;
      return "ALLOW\n理由：测试\n风险：低";
    },
  });

  assert.equal(result.verdict, "DENY");
  assert.equal(result.source, "hard-rule");
  assert.match(result.reason, /主工作区/);
  assert.equal(modelCalls, 0);
});

test("S13 解析真实目标后拒绝通过副本内符号链接逃逸", async (t) => {
  const { root, copyRoot } = await makeCopyRoot(t);
  const outside = join(root, "outside.md");
  const link = join(copyRoot, "escape.md");
  await writeFile(outside, "do not change");
  await symlink(outside, link);
  let modelCalls = 0;
  let executed = 0;

  const result = await processApprovedToolCall({
    event: writeEvent(link, "escaped"),
    writeRoots: [copyRoot],
    callModel: async () => {
      modelCalls += 1;
      return "ALLOW\n理由：测试\n风险：低";
    },
    execute: async () => {
      executed += 1;
    },
  });

  assert.equal(result.verdict, "DENY");
  assert.equal(result.source, "hard-rule");
  assert.equal(modelCalls, 0);
  assert.equal(executed, 0);
  assert.equal(await readFile(outside, "utf8"), "do not change");
});

test("S13 符号链接后的 .. 按文件系统语义解析且普通 .. 新目标仍可获批", async (t) => {
  const { root, copyRoot } = await makeCopyRoot(t);
  const outside = join(root, "outside");
  const nestedOutside = join(outside, "nested");
  const existing = join(copyRoot, "existing");
  const source = join(copyRoot, "source.md");
  const moveSource = join(copyRoot, "move-source.md");
  await mkdir(nestedOutside, { recursive: true });
  await mkdir(existing);
  await writeFile(source, "source");
  await writeFile(moveSource, "move source");
  const link = join(copyRoot, "link");
  await symlink(nestedOutside, link);
  const realCopyRoot = await realpath(copyRoot);
  const model = await startApprovalModel(t, () => "ALLOW\n理由：模型错误信任词法折叠后的路径\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [copyRoot],
    writeRoots: [copyRoot],
    baseUrl: model.baseUrl,
  });
  const operations = [
    { name: "write", event: (path) => writeEvent(path) },
    { name: "edit", event: (path) => ({ type: "tool_call", toolCallId: "edit-dot-dot", toolName: "edit", input: { path, edits: [{ oldText: "old", newText: "new" }] } }) },
    { name: "cp", event: (path) => ({ type: "tool_call", toolCallId: "cp-dot-dot", toolName: "bash", input: { command: `cp "${source}" "${path}"` } }) },
    { name: "mv", event: (path) => ({ type: "tool_call", toolCallId: "mv-dot-dot", toolName: "bash", input: { command: `mv "${moveSource}" "${path}"` } }) },
    { name: "mkdir", event: (path) => ({ type: "tool_call", toolCallId: "mkdir-dot-dot", toolName: "bash", input: { command: `mkdir -p "${path}"` } }) },
  ];

  for (const operation of operations) {
    // 不能用 path.join 构造此用例，否则测试自己就会先折叠 ..。
    const result = await handler(operation.event(`${link}/../escaped-${operation.name}`), taskContext("写入任务产物"));
    assert.equal(result?.block, true, operation.name);
    assert.match(result?.reason ?? "", /hard-rule/, operation.name);
  }
  assert.equal(model.calls.length, 0, "真实目标落到写根外时不得交给模型放行");

  for (const operation of operations) {
    const safePath = `${existing}/../safe-${operation.name}`;
    const result = await handler(operation.event(safePath), taskContext("在写根内创建新任务产物"));
    assert.equal(result, undefined, operation.name);
    const call = model.calls.at(-1);
    const approval = JSON.parse(call.messages[1].content);
    assert.deepEqual(approval.target, [join(realCopyRoot, `safe-${operation.name}`)], operation.name);
  }
  assert.equal(model.calls.length, operations.length, "无不安全符号链接的普通 .. 不得被一概拒绝");
});

test("S13 目标本身或中间分量是悬空符号链接时硬拒绝且模型 ALLOW 不可覆盖", async (t) => {
  const { root, copyRoot } = await makeCopyRoot(t);
  const protectedRoot = join(root, "protected");
  await mkdir(protectedRoot);
  const directLink = join(copyRoot, "direct-escape.md");
  const intermediateLink = join(copyRoot, "intermediate-escape");
  await symlink(join(protectedRoot, "created-outside.md"), directLink);
  await symlink(join(protectedRoot, "missing-directory"), intermediateLink);
  const model = await startApprovalModel(t, () => "ALLOW\n理由：模型错误信任重建后的字面路径\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [root],
    writeRoots: [root],
    protectedRoots: [protectedRoot],
    baseUrl: model.baseUrl,
  });

  const results = [];
  for (const target of [directLink, join(intermediateLink, "created-outside.md")]) {
    results.push(await handler(writeEvent(target, "escaped"), taskContext("写入任务报告")));
  }

  assert.deepEqual(results.map((result) => result?.block), [true, true]);
  for (const result of results) assert.match(result?.reason ?? "", /hard-rule/);
  assert.equal(model.calls.length, 0, "无法完整解析的符号链接不得交给模型放行");
});

test("S13 明确纳入审批的副本内命令经模型 ALLOW 后执行", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  const target = join(copyRoot, "new reports");
  const event = { type: "tool_call", toolCallId: "bash-1", toolName: "bash", input: { command: `mkdir -p "${target}"` } };
  let executed = 0;
  let prompt = "";

  const result = await processApprovedToolCall({
    event,
    task: { goal: "准备报告目录" },
    writeRoots: [copyRoot],
    callModel: async (messages) => {
      prompt = JSON.stringify(messages);
      return "ALLOW\n理由：只创建当前任务目录\n风险：低";
    },
    execute: async () => {
      executed += 1;
      return "directory created";
    },
  });

  assert.equal(result.verdict, "ALLOW");
  assert.equal(result.executionResult, "directory created");
  assert.equal(executed, 1);
  assert.match(prompt, /mkdir -p/);
  assert.match(prompt, /new reports/);
});

test("S13 Git 推送、部署、生产写和破坏命令直接硬拒绝", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  const commands = [
    "git -C /repo push origin main",
    "kubectl apply -f /tmp/deploy.yaml",
    "mysql -e \"DELETE FROM tenant\"",
    `rm -rf "${copyRoot}"`,
  ];
  let modelCalls = 0;
  let executed = 0;

  for (const command of commands) {
    const result = await processApprovedToolCall({
      event: { type: "tool_call", toolCallId: command, toolName: "bash", input: { command } },
      writeRoots: [copyRoot],
      callModel: async () => {
        modelCalls += 1;
        return "ALLOW\n理由：测试\n风险：低";
      },
      execute: async () => {
        executed += 1;
      },
    });
    assert.equal(result.verdict, "DENY", command);
    assert.equal(result.source, "hard-rule", command);
  }
  assert.equal(modelCalls, 0);
  assert.equal(executed, 0);
});

test("S13 审批不缓存也不扩散到后续调用或其他参数", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  const firstEvent = writeEvent(join(copyRoot, "first.md"), "第一份内容");
  const secondEvent = { ...writeEvent(join(copyRoot, "second.md"), "第二份内容"), toolCallId: "write-2" };
  const seenArguments = [];
  const executed = [];
  const replies = [
    "ALLOW\n理由：第一份周报范围明确\n风险：低",
    "DENY\n理由：第二份文件不属于当前任务\n风险：中",
  ];

  for (const event of [firstEvent, secondEvent]) {
    const result = await processApprovedToolCall({
      event,
      task: { goal: "只写第一份周报" },
      writeRoots: [copyRoot],
      callModel: async (messages) => {
        seenArguments.push(JSON.parse(messages[1].content).arguments);
        return replies[seenArguments.length - 1];
      },
      execute: async () => {
        executed.push(event.input.path);
      },
    });
    assert.equal(result.verdict, event === firstEvent ? "ALLOW" : "DENY");
  }

  assert.equal(seenArguments.length, 2);
  assert.deepEqual(seenArguments.map((args) => args.path), [firstEvent.input.path, secondEvent.input.path]);
  assert.deepEqual(executed, [firstEvent.input.path]);
});

test("S13 审批模型异常、超时和无效输出都 fail-closed", { timeout: 300 }, async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  let executed = 0;
  const cases = [
    { name: "异常", timeoutMs: 100, callModel: async () => { throw new Error("network down"); }, reason: /失败/ },
    { name: "超时", timeoutMs: 20, callModel: async () => new Promise(() => {}), reason: /超时/ },
    { name: "无效输出", timeoutMs: 100, callModel: async () => "ALLOW\n我认为可以写入", reason: /无效/ },
  ];

  for (const item of cases) {
    const result = await processApprovedToolCall({
      event: writeEvent(join(copyRoot, `${item.name}.md`)),
      writeRoots: [copyRoot],
      timeoutMs: item.timeoutMs,
      callModel: item.callModel,
      execute: async () => {
        executed += 1;
      },
    });
    assert.equal(result.verdict, "DENY", item.name);
    assert.match(result.reason, item.reason, item.name);
  }
  assert.equal(executed, 0);
});

test("S13 真实扩展 tool_call 通过独立模型 ALLOW、DENY 且硬阻断不可覆盖", async (t) => {
  const { root, copyRoot } = await makeCopyRoot(t);
  const model = await startApprovalModel(t, (payload) => {
    const operation = JSON.parse(payload.messages[1].content);
    return operation.arguments.path.endsWith("second.md")
      ? "DENY\n理由：第二份文件超出当前任务，请只写第一份\n风险：中"
      : "ALLOW\n理由：当前写入与任务直接相关\n风险：低";
  });
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [copyRoot],
    writeRoots: [copyRoot],
    protectedRoots: [join(root, "main-workspace")],
    baseUrl: model.baseUrl,
  });
  const context = taskContext("只写第一份周报");

  const allowed = await handler(writeEvent(join(copyRoot, "first.md"), "第一份完整内容"), context);
  assert.equal(allowed, undefined);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].model, "approval-model");
  assert.equal(model.calls[0].authorization, "Bearer approval-key");
  assert.match(JSON.stringify(model.calls[0].messages), /只写第一份周报/);
  assert.match(JSON.stringify(model.calls[0].messages), /第一份完整内容/);
  const firstOperation = JSON.parse(model.calls[0].messages[1].content);
  assert.equal(firstOperation.task.currentSkill, "unknown");
  assert.match(firstOperation.task.necessaryChange, /只写第一份周报/);
  assert.match(firstOperation.task.necessaryChange, /write/);
  assert.match(firstOperation.task.necessaryChange, /first\.md/);
  assert.doesNotMatch(firstOperation.task.necessaryChange, /由完整工具参数中的写入内容、编辑内容或命令确定/);
  assert.match(model.calls[0].messages[0].content, /unknown.*未提供 Skill 上下文/);

  const denied = await handler(writeEvent(join(copyRoot, "second.md")), taskContext("只写第一份周报"));
  assert.equal(denied?.block, true);
  assert.match(denied?.reason ?? "", /只写第一份/);
  assert.equal(model.calls.length, 2);
  assert.equal(JSON.parse(model.calls[1].messages[1].content).task.currentSkill, "unknown");

  const hardBlocked = await handler(writeEvent(join(root, "outside.md")), context);
  assert.equal(hardBlocked?.block, true);
  assert.match(hardBlocked?.reason ?? "", /副本外/);
  assert.equal(model.calls.length, 2);
});

test("S13 真实扩展把编排传入的当前 Skill 交给审批模型", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  const model = await startApprovalModel(t, () => "ALLOW\n理由：文档产物与当前 Skill 和任务一致\n风险：低");
  setEnv(t, "WECOM_BOT_CURRENT_SKILL", "docx");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [copyRoot],
    writeRoots: [copyRoot],
    baseUrl: model.baseUrl,
  });

  const allowed = await handler(
    writeEvent(join(copyRoot, "workspace/退租规则.md"), "按真实 Skill 生成的内容"),
    taskContext("生成退租规则文档"),
  );

  assert.equal(allowed, undefined);
  const operation = JSON.parse(model.calls[0].messages[1].content);
  assert.equal(operation.task.currentSkill, "docx");
  assert.match(operation.task.goal, /生成退租规则文档/);
});

test("S13 外部环境变量不能把可写副本的同名 Python 脚本加入白名单", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  const script = join(copyRoot, "bi_query.py");
  await writeFile(script, "raise SystemExit('untrusted code executed')\n");
  setEnv(t, "WECOM_BOT_TRUSTED_PYTHON_SCRIPTS", JSON.stringify([script]));
  const model = await startApprovalModel(t, () => "ALLOW\n理由：模型错误信任同名脚本\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [copyRoot],
    writeRoots: [copyRoot],
    baseUrl: model.baseUrl,
  });

  const result = await handler({
    type: "tool_call",
    toolCallId: "untrusted-python",
    toolName: "bash",
    input: { command: `python3 "${script}" "SELECT 1"` },
  }, taskContext("执行刚刚获批写入的同名脚本"));

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /hard-rule/);
  assert.match(result?.reason ?? "", /不在可审批命令白名单内/);
  assert.equal(model.calls.length, 0, "外部环境变量和模型 ALLOW 均不得覆盖可写同名脚本的硬拒绝");
});

test("S13 本地实例只执行明确配置的可信 BI 入口，配置也不能放行可写副本", async (t) => {
  const { root, copyRoot } = await makeCopyRoot(t);
  const trustedScript = join(root, "trusted/lzz-db-wiki/scripts/bi_query.py");
  const copyScript = join(copyRoot, "bi_query.py");
  await mkdir(dirname(trustedScript), { recursive: true });
  await writeFile(trustedScript, "print('trusted read-only result')\n", { mode: 0o555 });
  await writeFile(copyScript, "raise SystemExit('untrusted code executed')\n");
  setEnv(t, "WECOM_BOT_TRUSTED_DATA_SCRIPTS", JSON.stringify({ lzz: trustedScript, ajly: copyScript }));
  const model = await startApprovalModel(t, () => "ALLOW\n理由：模型不应审批只读 BI 硬规则\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [copyRoot],
    writeRoots: [copyRoot],
    baseUrl: model.baseUrl,
  });

  const deniedCopy = await handler({
    type: "tool_call",
    toolCallId: "copy-bi",
    toolName: "bash",
    input: { command: `python3 "${copyScript}" "SELECT 1"` },
  }, taskContext("尝试执行副本 BI"));
  const allowedTrusted = await handler({
    type: "tool_call",
    toolCallId: "trusted-bi",
    toolName: "bash",
    input: { command: `python3 "${trustedScript}" "SELECT 1"` },
  }, taskContext("按乐租租口径执行可信只读 BI"));

  assert.equal(deniedCopy?.block, true);
  assert.match(deniedCopy?.reason ?? "", /hard-rule/);
  assert.equal(allowedTrusted, undefined);
  assert.equal(model.calls.length, 0, "可信只读 BI 与副本硬拒绝都不进入写操作审批模型");
});

test("S13 保护根符号链接别名与悬空 BI 入口 fail-closed，模型 ALLOW 不可覆盖", async (t) => {
  const { root, copyRoot } = await makeCopyRoot(t);
  const protectedRoot = join(root, "protected-project");
  const protectedAlias = join(root, "protected-alias");
  const aliasedScript = join(protectedAlias, "scripts/bi_query.py");
  const danglingAlias = join(root, "dangling-alias");
  const danglingScript = join(danglingAlias, "bi_query.py");
  await mkdir(dirname(join(protectedRoot, "scripts/bi_query.py")), { recursive: true });
  await writeFile(join(protectedRoot, "scripts/bi_query.py"), "print('must not execute through alias')\n", { mode: 0o555 });
  await symlink(protectedRoot, protectedAlias, "dir");
  await symlink(join(root, "missing-target"), danglingAlias, "dir");
  setEnv(t, "WECOM_BOT_TRUSTED_DATA_SCRIPTS", JSON.stringify({ lzz: aliasedScript, ajly: danglingScript }));
  const model = await startApprovalModel(t, () => "ALLOW\n理由：模型不能扩大 BI 执行边界\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [copyRoot],
    writeRoots: [copyRoot],
    protectedRoots: [protectedRoot],
    baseUrl: model.baseUrl,
  });

  for (const [toolCallId, script] of [["protected-alias-bi", aliasedScript], ["dangling-bi", danglingScript]]) {
    const result = await handler({
      type: "tool_call",
      toolCallId,
      toolName: "bash",
      input: { command: `python3 "${script}" "SELECT 1"` },
    }, taskContext("尝试通过别名执行保护根脚本"));
    assert.equal(result?.block, true, script);
    assert.match(result?.reason ?? "", /hard-rule/, script);
  }
  assert.equal(model.calls.length, 0, "真实路径硬拒绝不能进入模型审批，更不能被 ALLOW 覆盖");
});

test("S13 Python 选项不能借受信任脚本路径绕过脚本入口硬规则", async () => {
  let handler;
  filesystemWhitelist({ on: (eventName, callback) => {
    if (eventName === "tool_call") handler = callback;
  } });
  const trustedScript = "/Users/kyle/Desktop/PM/信息技术部资产库/知识库/数据库/ajly-db-wiki/scripts/bi_query.py";

  const direct = await handler({
    type: "tool_call",
    toolCallId: "trusted-python-entry",
    toolName: "bash",
    input: { command: `python3 "${trustedScript}" "SELECT 1"` },
  });
  assert.equal(direct, undefined, "只有直接执行受信任脚本入口的调用才走只读放行");

  for (const command of [
    `python3 -c "print(1)" "${trustedScript}"`,
    `python3 -m json.tool "${trustedScript}"`,
    `python3 -i -c "print(1)" "${trustedScript}"`,
    `python3 --help "${trustedScript}"`,
  ]) {
    const result = await handler({ type: "tool_call", toolName: "bash", input: { command } });
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /hard-rule/, command);
  }
});

test("S13 Node 只接受首个参数直接为受信任脚本路径", async () => {
  let handler;
  filesystemWhitelist({ on: (eventName, callback) => {
    if (eventName === "tool_call") handler = callback;
  } });
  const trustedScript = "/Users/kyle/Desktop/VIBECODING/wecom-support-bot/scripts/read-evolution.js";
  const untrustedScript = "/Users/kyle/Desktop/VIBECODING/ajly/untrusted.js";

  const direct = await handler({
    type: "tool_call",
    toolCallId: "trusted-node-entry",
    toolName: "bash",
    input: { command: `node "${trustedScript}" "wiki" "query"` },
  });
  assert.equal(direct, undefined, "只有首个参数直接是受信任脚本时才走只读放行");

  for (const command of [
    `node -e "console.log(1)" "${trustedScript}"`,
    `node --eval "console.log(1)" "${trustedScript}"`,
    `node -p "1" "${trustedScript}"`,
    `node --print "1" "${trustedScript}"`,
    `node -r "./preload" "${trustedScript}"`,
    `node --require "./preload" "${trustedScript}"`,
    `node --import "./preload" "${trustedScript}"`,
    `node --input-type=module "${trustedScript}"`,
    `node -- "${trustedScript}"`,
    `node "${untrustedScript}" "${trustedScript}"`,
  ]) {
    const result = await handler({ type: "tool_call", toolName: "bash", input: { command } });
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /hard-rule/, command);
  }
});

test("S13 模型 ALLOW 不能覆盖 Node 入口选项绕过的硬拒绝", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  const trustedScript = "/Users/kyle/Desktop/VIBECODING/wecom-support-bot/scripts/read-evolution.js";
  const model = await startApprovalModel(t, () => "ALLOW\n理由：模型错误放行任意代码\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [copyRoot],
    writeRoots: [copyRoot],
    baseUrl: model.baseUrl,
  });

  const result = await handler({
    type: "tool_call",
    toolCallId: "node-option-bypass",
    toolName: "bash",
    input: { command: `node -e "require('fs').writeFileSync('/tmp/pwn','x')" "${trustedScript}"` },
  }, taskContext("尝试执行内联 Node 代码"));

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /hard-rule/);
  assert.equal(model.calls.length, 0);
});

test("S13 模型 ALLOW 不能覆盖 Python 选项绕过的硬拒绝", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  const trustedScript = "/Users/kyle/Desktop/PM/信息技术部资产库/知识库/数据库/ajly-db-wiki/scripts/bi_query.py";
  const model = await startApprovalModel(t, () => "ALLOW\n理由：模型错误放行任意代码\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [copyRoot],
    writeRoots: [copyRoot],
    baseUrl: model.baseUrl,
  });

  const result = await handler({
    type: "tool_call",
    toolCallId: "python-option-bypass",
    toolName: "bash",
    input: { command: `python3 -c "print(1)" "${trustedScript}"` },
  }, taskContext("尝试执行内联 Python"));

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /hard-rule/);
  assert.equal(model.calls.length, 0);
});

test("S13 真实扩展 cp 源限读根、mv 源与目标限写根且只读命令不审批", async (t) => {
  const { root, copyRoot } = await makeCopyRoot(t);
  const sourceRoot = join(root, "readable-sources");
  const protectedRoot = join(copyRoot, "protected");
  const source = join(sourceRoot, "source.md");
  const outsideSource = join(root, "outside.md");
  const internalSource = join(copyRoot, "internal.md");
  const protectedSource = join(protectedRoot, "protected.md");
  await mkdir(sourceRoot);
  await mkdir(protectedRoot);
  await writeFile(source, "source");
  await writeFile(outsideSource, "outside");
  await writeFile(internalSource, "internal");
  await writeFile(protectedSource, "protected");
  const model = await startApprovalModel(t, () => "ALLOW\n理由：复制范围符合当前任务\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [copyRoot, sourceRoot],
    writeRoots: [copyRoot],
    protectedRoots: [protectedRoot],
    baseUrl: model.baseUrl,
  });

  const copied = await handler({
    type: "tool_call",
    toolCallId: "cp",
    toolName: "bash",
    input: { command: `cp "${source}" "${join(copyRoot, "cp.md")}"` },
  }, taskContext("把资料复制到任务副本"));
  assert.equal(copied, undefined);
  assert.equal(model.calls.length, 1);

  const externalMove = await handler({
    type: "tool_call",
    toolCallId: "mv-external",
    toolName: "bash",
    input: { command: `mv "${source}" "${join(copyRoot, "mv.md")}"` },
  }, taskContext("移动资料"));
  assert.equal(externalMove?.block, true);
  assert.equal(model.calls.length, 1);

  const internalMove = await handler({
    type: "tool_call",
    toolCallId: "mv-internal",
    toolName: "bash",
    input: { command: `mv "${internalSource}" "${join(copyRoot, "mv.md")}"` },
  }, taskContext("在副本内移动资料"));
  assert.equal(internalMove, undefined);
  assert.equal(model.calls.length, 2);

  const keywordPathResult = await handler({
    type: "tool_call",
    toolCallId: "mkdir-keyword-path",
    toolName: "bash",
    input: { command: `mkdir "${join(copyRoot, "UPDATE")}"` },
  }, taskContext("创建更新报告目录"));
  assert.equal(keywordPathResult, undefined);
  assert.equal(model.calls.length, 3);

  const readResult = await handler({
    type: "tool_call",
    toolCallId: "read-command",
    toolName: "bash",
    input: { command: `cat "${source}"` },
  }, taskContext("读取资料"));
  assert.equal(readResult, undefined);
  assert.equal(model.calls.length, 3);

  for (const command of [
    `cp "${outsideSource}" "${join(copyRoot, "bad-source.md")}"`,
    `cp "${source}" "${join(root, "bad-target.md")}"`,
    `mv "${protectedSource}" "${join(copyRoot, "bad-protected-source.md")}"`,
    `mv "${internalSource}" "${join(protectedRoot, "bad-protected-target.md")}"`,
  ]) {
    const result = await handler({ type: "tool_call", toolName: "bash", input: { command } }, taskContext("移动或复制资料"));
    assert.equal(result?.block, true, command);
  }
  assert.equal(model.calls.length, 3);
});

test("S13 mv 只审批明确普通文件，目录与嵌套保护根不可被模型 ALLOW 覆盖", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  const bundle = join(copyRoot, "bundle");
  const protectedRoot = join(bundle, "protected");
  const plainDirectory = join(copyRoot, "plain-directory");
  const ordinaryFile = join(copyRoot, "ordinary.md");
  const linkedFile = join(copyRoot, "linked.md");
  await mkdir(protectedRoot, { recursive: true });
  await mkdir(plainDirectory);
  await writeFile(join(protectedRoot, "keep.md"), "protected");
  await writeFile(ordinaryFile, "ordinary");
  await symlink(ordinaryFile, linkedFile);
  const model = await startApprovalModel(t, () => "ALLOW\n理由：模型错误信任源与目标前缀\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [copyRoot],
    writeRoots: [copyRoot],
    protectedRoots: [protectedRoot],
    baseUrl: model.baseUrl,
  });

  for (const [index, source] of [bundle, plainDirectory, linkedFile].entries()) {
    const result = await handler({
      type: "tool_call",
      toolCallId: `mv-non-file-${index}`,
      toolName: "bash",
      input: { command: `mv "${source}" "${join(copyRoot, `moved-${index}.md`)}"` },
    }, taskContext("移动副本内资料"));
    assert.equal(result?.block, true, source);
    assert.match(result?.reason ?? "", /hard-rule/, source);
  }
  assert.equal(model.calls.length, 0, "目录、符号链接及其嵌套内容不得交给模型放行");

  const ordinaryMove = await handler({
    type: "tool_call",
    toolCallId: "mv-ordinary-file",
    toolName: "bash",
    input: { command: `mv "${ordinaryFile}" "${join(copyRoot, "renamed.md")}"` },
  }, taskContext("重命名一份明确普通文件"));
  assert.equal(ordinaryMove, undefined);
  assert.equal(model.calls.length, 1);
});

test("S13 glob 多源写入无法确定完整真实目标时 fail-closed", async (t) => {
  const { root, copyRoot } = await makeCopyRoot(t);
  const sourceRoot = join(root, "READ");
  const reports = join(copyRoot, "reports");
  const sources = [join(sourceRoot, "a.md"), join(sourceRoot, "b.md")];
  await mkdir(sourceRoot);
  await mkdir(reports);
  for (const source of sources) await writeFile(source, "source");
  const outside = join(root, "outside.md");
  await writeFile(outside, "do not change");
  await symlink(outside, join(reports, "a.md"));
  const model = await startApprovalModel(t, () => "ALLOW\n理由：模型错误信任 glob 的字面路径\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [sourceRoot],
    writeRoots: [copyRoot],
    baseUrl: model.baseUrl,
  });

  for (const command of [
    `cp "${sourceRoot}/"* "${reports}/"`,
    `cp "${sources[0]}" "${reports}/"*`,
    `cp "${sources[0]}" "${sources[1]}" "${reports}/"`,
  ]) {
    const result = await handler({ type: "tool_call", toolName: "bash", input: { command } }, taskContext("复制资料到报告目录"));
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /hard-rule/, command);
  }
  assert.equal(model.calls.length, 0, "glob 或最终符号链接使真实目标不确定时不得交给模型放行");
  assert.equal(await readFile(outside, "utf8"), "do not change");
});

test("S13 写命令对 shell 展开 fail-closed 且保留安全引号内字面路径", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  const model = await startApprovalModel(t, () => "ALLOW\n理由：模型错误信任展开前的字面路径\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [copyRoot],
    writeRoots: [copyRoot],
    baseUrl: model.baseUrl,
  });

  const commands = [
    `mkdir -p ${copyRoot}/{..,x}/escape`,
    `mkdir -p ${copyRoot}/{one,two}`,
    `mkdir -p ${copyRoot}/$TARGET/escape`,
    "mkdir -p " + copyRoot + "/${TARGET}/escape",
    `mkdir -p ${copyRoot}/$(printf escape)`,
    "mkdir -p " + copyRoot + "/`printf escape`",
    "mkdir -p ~/escape",
  ];
  for (const command of commands) {
    const result = await handler({ type: "tool_call", toolName: "bash", input: { command } }, taskContext("创建任务目录"));
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /hard-rule/, command);
  }
  assert.equal(model.calls.length, 0, "展开前无法确定真实源与目标时不得交给模型放行");

  const literalCommands = [
    `mkdir -p "${copyRoot}/{literal,path}"`,
    "mkdir -p '" + copyRoot + "/literal$value'",
    "mkdir -p '" + copyRoot + "/literal`value'",
  ];
  for (const command of literalCommands) {
    const result = await handler({ type: "tool_call", toolName: "bash", input: { command } }, taskContext("创建名称包含字面字符的目录"));
    assert.equal(result, undefined, command);
  }
  assert.equal(model.calls.length, literalCommands.length);
});

test("S13 真实扩展硬拒绝未引用 extglob 且模型 ALLOW 不能覆盖", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  const source = join(copyRoot, "source.md");
  const protectedRoot = join(copyRoot, "protected");
  await writeFile(source, "source");
  await mkdir(protectedRoot);
  const model = await startApprovalModel(t, () => "ALLOW\n理由：模型错误信任 extglob 的字面路径\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [copyRoot],
    writeRoots: [copyRoot],
    protectedRoots: [protectedRoot],
    baseUrl: model.baseUrl,
  });

  const extglobForms = ["@", "+", "!", "*", "?"];
  const commands = extglobForms.map((form) => `mkdir -p ${copyRoot}/${form}(protected)/new`);
  commands.push(
    `cp "${source}" ${copyRoot}/@(protected)/copy.md`,
    `cp ${copyRoot}/+(source).md ${copyRoot}/copy.md`,
    `mv "${source}" ${copyRoot}/!(protected)/move.md`,
  );
  for (const command of commands) {
    const result = await handler({ type: "tool_call", toolName: "bash", input: { command } }, taskContext("在副本内处理资料"));
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /hard-rule/, command);
  }
  assert.equal(model.calls.length, 0, "extglob 展开前无法确定完整真实源与目标时不得交给模型放行");

  const literalCommands = extglobForms.map((form) => `mkdir -p "${copyRoot}/${form}(literal)"`);
  for (const command of literalCommands) {
    const result = await handler({ type: "tool_call", toolName: "bash", input: { command } }, taskContext("创建名称包含字面 extglob 字符的目录"));
    assert.equal(result, undefined, command);
  }
  assert.equal(model.calls.length, literalCommands.length, "引号内的 extglob 字符只是字面路径，不应被误拒绝");
});

test("S13 process substitution 不作为普通路径审批且引号内字面路径可执行", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  const source = join(copyRoot, "source.md");
  await writeFile(source, "source");
  let modelCalls = 0;
  const executed = [];
  const approve = (command) => processApprovedToolCall({
    event: { type: "tool_call", toolCallId: command, toolName: "bash", input: { command } },
    readRoots: [copyRoot],
    writeRoots: [copyRoot],
    callModel: async () => {
      modelCalls += 1;
      return "ALLOW\n理由：模型错误信任 process substitution 的字面路径\n风险：低";
    },
    execute: async () => {
      executed.push(command);
      return "fake execution";
    },
  });

  const commands = [
    `mkdir -p ${copyRoot}/<(true)/new`,
    `mkdir -p ${copyRoot}/>(true)/new`,
    `cp <(true) ${copyRoot}/copy.md`,
    `cp "${source}" ${copyRoot}/>(true)/copy.md`,
    `mv <(true) ${copyRoot}/move.md`,
    `mv "${source}" ${copyRoot}/<(true)/move.md`,
  ];
  for (const command of commands) {
    const result = await approve(command);
    assert.equal(result.verdict, "DENY", command);
    assert.equal(result.source, "hard-rule", command);
  }
  assert.equal(modelCalls, 0, "process substitution 会执行隐藏命令，不得交给模型放行");
  assert.deepEqual(executed, [], "硬拒绝的 process substitution 不得进入假执行器");

  const literalCommands = [
    `mkdir -p "${copyRoot}/<(literal)"`,
    `mkdir -p "${copyRoot}/>(literal)"`,
    `cp "${source}" "${copyRoot}/<(literal).md"`,
    `mv "${source}" "${copyRoot}/>(literal).md"`,
  ];
  for (const command of literalCommands) {
    const result = await approve(command);
    assert.equal(result.verdict, "ALLOW", command);
    assert.equal(result.executionResult, "fake execution", command);
  }
  assert.equal(modelCalls, literalCommands.length);
  assert.deepEqual(executed, literalCommands, "引号内字符只是字面路径，可经模型审批后进入假执行器");
});

test("S13 cp 目录目标展开每个最终文件并阻止符号链接越界", async (t) => {
  const { root, copyRoot } = await makeCopyRoot(t);
  const sourceRoot = join(root, "readable-sources");
  const reports = join(copyRoot, "reports");
  const sources = [join(sourceRoot, "a.md"), join(sourceRoot, "b.md")];
  await mkdir(sourceRoot);
  await mkdir(reports);
  for (const source of sources) await writeFile(source, "source");
  const outside = join(root, "outside.md");
  await writeFile(outside, "do not change");
  await symlink(outside, join(reports, "a.md"));
  const model = await startApprovalModel(t, () => "ALLOW\n理由：复制到任务报告目录\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [sourceRoot],
    writeRoots: [copyRoot],
    baseUrl: model.baseUrl,
  });
  const event = {
    type: "tool_call",
    toolCallId: "cp-directory-target",
    toolName: "bash",
    input: { command: `cp "${sources[0]}" "${sources[1]}" "${reports}/"` },
  };

  const blocked = await handler(event, taskContext("复制两份资料到报告目录"));
  assert.equal(blocked?.block, true);
  assert.equal(model.calls.length, 0, "任一最终文件逃到写根外时不得交给模型放行");
  assert.equal(await readFile(outside, "utf8"), "do not change");

  await rm(join(reports, "a.md"));
  const allowed = await handler(event, taskContext("复制两份资料到报告目录"));
  assert.equal(allowed, undefined);
  assert.equal(model.calls.length, 1);
  const operation = JSON.parse(model.calls[0].messages[1].content);
  const realReports = await realpath(reports);
  assert.deepEqual(operation.target, [join(realReports, "a.md"), join(realReports, "b.md")]);
});

test("S13 无法静态枚举完整目标的 cp 递归形态硬拒绝且普通文件复制仍获批", async (t) => {
  const { root, copyRoot } = await makeCopyRoot(t);
  const sourceRoot = join(root, "readable-sources");
  const sourceDirectory = join(sourceRoot, "bundle");
  const sourceFile = join(sourceDirectory, "escape.md");
  const destination = join(copyRoot, "reports");
  const nestedDestination = join(destination, "bundle");
  const outside = join(root, "outside.md");
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(nestedDestination, { recursive: true });
  await writeFile(sourceFile, "source");
  await writeFile(outside, "do not change");
  await symlink(outside, join(destination, "escape.md"));
  await symlink(outside, join(nestedDestination, "escape.md"));
  const model = await startApprovalModel(t, () => "ALLOW\n理由：复制范围符合当前任务\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [sourceRoot],
    writeRoots: [copyRoot],
    baseUrl: model.baseUrl,
  });

  const recursiveResults = [];
  for (const command of [
    `cp -R "${sourceDirectory}/" "${destination}"`,
    `cp -R "${sourceDirectory}" "${destination}"`,
    `cp --recursive "${sourceDirectory}" "${destination}"`,
  ]) {
    recursiveResults.push(await handler({ type: "tool_call", toolName: "bash", input: { command } }, taskContext("递归复制资料目录")));
  }

  assert.deepEqual(recursiveResults.map((result) => result?.block), [true, true, true]);
  for (const result of recursiveResults) assert.match(result?.reason ?? "", /hard-rule/);
  assert.equal(model.calls.length, 0, "未完整枚举最终目标的递归复制不得交给模型放行");
  assert.equal(await readFile(outside, "utf8"), "do not change");

  const ordinaryCopy = await handler({
    type: "tool_call",
    toolCallId: "ordinary-file-copy",
    toolName: "bash",
    input: { command: `cp "${sourceFile}" "${join(copyRoot, "ordinary.md")}"` },
  }, taskContext("复制一份明确文件到任务副本"));
  assert.equal(ordinaryCopy, undefined);
  assert.equal(model.calls.length, 1);
});

test("S13 真实扩展按 shell 转义语义分词并硬拒绝引号绕过", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  await writeFile(join(copyRoot, "with space.md"), "readable");
  const model = await startApprovalModel(t, () => "ALLOW\n理由：单个副本内目录操作\n风险：低");
  const handler = await loadEnabledApprovalHook(t, {
    readRoots: [copyRoot],
    writeRoots: [copyRoot],
    baseUrl: model.baseUrl,
  });

  const escaped = await handler({
    type: "tool_call",
    toolCallId: "escaped-path",
    toolName: "bash",
    input: { command: String.raw`mkdir ${copyRoot}/escaped\;literal` },
  }, taskContext("创建名称包含分号的目录"));
  assert.equal(escaped, undefined);
  assert.equal(model.calls.length, 1);

  const readEscapedSpace = await handler({
    type: "tool_call",
    toolCallId: "escaped-space",
    toolName: "bash",
    input: { command: String.raw`cat ${copyRoot}/with\ space.md` },
  }, taskContext("读取文件名包含空格的资料"));
  assert.equal(readEscapedSpace, undefined);
  assert.equal(model.calls.length, 1);

  for (const command of [
    String.raw`mkdir "/tmp/safe\""; rm -rf /outside #"`,
    String.raw`mkdir "${copyRoot}/safe\""; rm -rf /outside #"`,
    `mkdir "${copyRoot}/safe$(touch /outside)"`,
    'mkdir "' + copyRoot + '/safe`touch /outside`"',
  ]) {
    const result = await handler({ type: "tool_call", toolName: "bash", input: { command } }, taskContext("创建目录"));
    assert.equal(result?.block, true, command);
  }
  assert.equal(model.calls.length, 1);
});

test("S13 真实扩展 tool_call 钩子在默认模式阻断 write", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  let handler;
  filesystemWhitelist({ on: (eventName, callback) => {
    if (eventName === "tool_call") handler = callback;
  } });

  const result = await handler(writeEvent(join(copyRoot, "readonly.md")));

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /只读|未启用/);
});

test("S13 未启用审批时保持默认企微只读行为", async (t) => {
  const { copyRoot } = await makeCopyRoot(t);
  let modelCalls = 0;
  let executed = 0;

  const result = await processApprovedToolCall({
    event: writeEvent(join(copyRoot, "should-not-write.md")),
    enabled: false,
    writeRoots: [copyRoot],
    callModel: async () => {
      modelCalls += 1;
      return "ALLOW\n理由：测试\n风险：低";
    },
    execute: async () => {
      executed += 1;
    },
  });

  assert.equal(result.verdict, "DENY");
  assert.equal(result.source, "hard-rule");
  assert.equal(modelCalls, 0);
  assert.equal(executed, 0);
});

# 企微机器人可靠性改造计划（第一档 + 第二档）

> 状态：**待虎老师拍板**（第 6 节的决策点和第 3 节的测试缝确认后才开工）
> 起点（code-review 固定点）：`master@e13a0ec`
> 流程：`/implement` 按票推进 → 每票内 `/tdd` 红绿循环 → 全部完成后 `/code-review e13a0ec`（本文件即 Spec）

## 1. 目标与成功判据

试运行（10-20 ~ 10-28）基线：提问 45 条丢 2 条、超时 9/43≈21%、连"你好"都要 9–52 秒、断线 7 次期间消息无记录。

| # | 判据 | 怎么验 |
|---|---|---|
| G1 | **问题不丢**：收到即落盘；进程重启/崩溃后 30 分钟内的未答问题自动补跑并主动推送 | 测试机器人上提问后立刻 `kill`，重启后收到补发 |
| G2 | **答案必达**：流式通道发不出去时改走主动推送，带重试 | 单测（假 transport 模拟 replyStream 失败） |
| G3 | **超时不等于失败**：60 秒内答不完 → 先告知"查好单独发你"，后台继续，最长 10 分钟，查完主动推送 | 测试机器人上问一个查数题，观察两段式 |
| G4 | **卡死早发现**：pi 事件流 45 秒无任何输出判定卡住，自动重试一次 | 单测（假 runner 停止吐事件） |
| G5 | **简单题快**：闲聊/概念题端到端 P50 ≤ 15 秒 | 回归题集前后对比 |
| G6 | **答案质量不退**：回归题集正确率不低于改造前 | 回归题集人工判分（虎老师终审） |
| G7 | 全量测试、类型检查通过；code-review 两轴无未处理的硬伤 | `npm test` / `npm run typecheck` / 审查报告 |

## 2. 目标架构

```
企微长连接
   ↓
[接入] normalize → 收件箱落盘（msgid 去重）→ 5 秒内回占位
   ↓
[调度] 同会话串行 + 全局并发上限 → 会话轮转判断 → 分级路由（快/深）
   ↓
[执行] pi（快=low 思考 / 深=max 思考）+ 零进展看门狗（卡住重试 1 次）
   ↓
[守卫] guard（不变）
   ↓
[投递] 60s 内：流式收尾 │ 超 60s：流式先收尾"查好单独发你" → 后台完成后主动推送
       流式失败 → 主动推送（重试 3 次）→ 收件箱标记 answered / failed
   ↑
[启动恢复] 扫收件箱未答且 30 分钟内的问题 → 补跑 → 主动推送
```

不变的部分：pi 隔离方式、命令/路径白名单、guard 判定逻辑与 fail-closed、粘性标记语义。

## 3. 测试缝（TDD 只在这些边界写测试，**需虎老师确认**）

已有缝 S1–S5 保持（见 `docs/seams.md`）。新增/变更：

| 缝 | 模块 | 公开签名 | 验证的行为 |
|---|---|---|---|
| S2′ Agent 调用（变更） | `src/agent.js` | `runAgentTurn({prompt, sessionId, runner, idleTimeoutMs, hardTimeoutMs, thinkingLevel}) → {text, biTouched, timedOut, stalled, failed, inputTokens}` | 事件流持续吐时不超时；静默超过 idle 判 `stalled`；超过 hard 判 `timedOut`；回传最后一次 input token 数 |
| S4′ 轮次编排（变更） | `src/orchestrate.js` | `handleTurn(...)` 不变 | `stalled` 时自动重试一次；重试仍卡住返回超时话术 |
| S5′ 会话标记（变更） | `src/session-state.js` | 增加 `recordActivity(userKey, {at, inputTokens})`；`resolveSessionId(userKey, now)` | 闲置超 4 小时或上下文超 6 万 token 时自动换下一代会话，粘性标记随旧代作废 |
| S6 收件箱（新） | `src/inbox.js` | `createInbox({storePath}) → {accept(msg) → {isNew}, markRunning, markAnswered, markFailed, recoverable(now, windowMs) → msg[]}` | 同 msgid 只接受一次；重启后能读回未答问题；超出窗口的不返回；文件损坏不崩 |
| S7 投递（新） | `src/deliver.js` | `deliverFinal({text, stream, push, retries}) → {channel: "stream"\|"push"\|"none"}` | 流式成功走 stream；流式失败改走 push；push 失败按次数重试；全失败返回 none 不抛异常 |
| S8 两段式生命周期（新） | `src/turn-lifecycle.js` | `runTurnLifecycle({execute, surface, handoffAfterMs, slowAfterMs}) → {mode: "inline"\|"handoff"}` | 60s 内完成→流式收尾；超 60s→先流式收尾告知话术，完成后走 push；20s 时发一次"慢"提示 |
| S9 会话队列（新） | `src/session-queue.js` | `createSessionQueue({maxConcurrent}) → {run(key, fn)}` | 同 key 严格按到达顺序串行；不同 key 并行；总并发不超过上限 |
| S10 分级路由（新） | `src/route.js` | `classifyQuestion({question, callModel}) → "quick"\|"deep"` | 模型答 QUICK/DEEP 正确解析；模型故障或无法识别 → `deep`（宁慢勿错） |

注入约定沿用：外部边界（子进程、HTTP、企微 SDK、时钟）用假实现；项目自身模块不 mock。时间相关测试用 `node:test` 的 `mock.timers`。

不写单测、靠手工/冒烟验证的部分：单实例锁、SIGTERM 优雅退出、launchd 配置、提示词拆分（靠回归题集）。

## 4. 票（按依赖顺序，每票一个 commit）

分支：从 `master@e13a0ec` 拉 `reliability-tier12`，全部完成并验收后再合回 master。

### 第一档：止血

**T0 回归题集基线**（无代码，先做）
- 从 `~/.pi-support/agent/sessions/` 和日志抽 10–12 条真实问题，覆盖：闲聊、业务概念、代码逻辑、查数（含机构数这类踩过坑的）
- 用当前版本跑一遍，记录答案与耗时 → `docs/regression-baseline.md`
- 依赖：无。产出用于 G5/G6 对比

**T1 开发与生产隔离**
- secrets 路径可由环境变量 `WECOM_BOT_SECRETS` 指定（默认仍是 `config/secrets.json`），测试机器人用 `config/secrets.dev.json`
- 单实例锁：启动时写 `data/<botId 前 8 位>.lock`（含 pid），已有存活进程则拒绝启动并打印原因——防止前台和 launchd 各跑一份互踢
- README 补"开发用测试机器人、生产只在发版时重启"
- **前置：虎老师在企微后台建第二个智能机器人（API 模式），把 botId/secret 给我**
- 依赖：无

**T2 收件箱**（S6，TDD）
- 新模块 `src/inbox.js`：append-only JSONL（`data/inbox.jsonl`），记录 msgid、userId、chatId、chatType、question、sessionKey、receivedAt、状态
- `index.js` 收到消息先 `accept`，重复 msgid 直接忽略（企微重推不会答两遍）
- 启动时 compact：只保留 24 小时内的记录，防止文件无限增长
- 依赖：T1

**T3 投递兜底**（S7，TDD）
- 新模块 `src/deliver.js`：流式收尾失败 → `client.sendMessage(chatId, markdown)` 主动推送，最多 3 次、间隔 1/3/9 秒
- 群聊推送时开头带"关于「问题前 20 字」："，让提问人认得出是哪条（群聊 @提及 的 markdown 写法需在测试机器人上实测，能用再加）
- 结果写回收件箱 `markAnswered` / `markFailed`
- 进程级兜底：`unhandledRejection` 只记日志不崩
- 依赖：T2

**T4 优雅退出 + 启动恢复**（恢复逻辑走 S6 的 `recoverable`，其余手工验）
- SIGTERM：停止接新活（新消息仍落收件箱）→ 最多等 30 秒让在途轮次答完 → 杀掉残留 pi 子进程 → 退出
- launchd plist 加 `ExitTimeOut` 40 秒
- 启动后：`recoverable(now, 30min)` 逐条补跑，结果用 push 投递，开头加"刚才那条我补上："
- 超出 30 分钟的未答问题只记日志不补（避免隔天突然冒答案）
- 依赖：T2、T3

### 第二档：治超时

**T5 同会话串行 + 全局并发上限**（S9，TDD）
- 新模块 `src/session-queue.js`：同会话排队、不同会话并行、全局最多 4 个 pi 同时跑
- 排队中的消息占位文案改为"前面那条还在查，查完马上看这条"
- 说明：这会**撤回 9466906**（当时实测"并发无问题"）。理由：同一会话并发时两个 pi 同时追加同一 session 文件，后一个看不到前一个的问答，且 06:42 两条单字追问同时超时与此吻合
- 依赖：T2

**T6 零进展看门狗**（S2′、S4′，TDD）
- `agent.js`：总超时拆成 `idleTimeoutMs`（45s，任何 stdout 行都重置，含 thinking_delta）+ `hardTimeoutMs`（前台 60s 由 T7 接管，后台上限 10 分钟）
- 卡住返回 `stalled`；`orchestrate.js` 对 `stalled` 重试一次（同会话、原问题）
- 同时回传 `inputTokens`（取最后一条 assistant `message_end` 的 usage.input），供 T8 使用
- 依赖：无（可与 T5 并行，提交顺序在其后）

**T7 两段式回复**（S8，TDD）
- 新模块 `src/turn-lifecycle.js`：20 秒发一次"慢"提示；60 秒未完成 → 流式收尾"这个要多查一会儿，查好了单独发你" → 后台继续 → 完成后经 T3 主动推送
- 删除 45 秒周期保活（流式消息在 60 秒内就收尾了，不再需要）
- 后台超过 10 分钟 → 推送超时话术
- 依赖：T3、T6

**T8 会话轮转**（S5′，TDD）
- 闲置超过 4 小时或上一轮 input 超过 6 万 token → 下一条消息自动用新一代会话（复用 `startNewSession`，粘性标记随旧代作废——新会话无旧上下文，不会回忆出旧数据，语义正确）
- 不用 pi 自带压缩：它在"上下文窗口 − 预留"时才触发，这个模型窗口 100 万，等于永不触发；强行调参会让压缩发生在答题途中，反而更慢
- 依赖：T6（需要 inputTokens）

**T9 分级路由**（S10，TDD）
- 新模块 `src/route.js`：复用 guard 的直连模型通道，一问一答判 QUICK / DEEP（约 1 秒）
- QUICK = 闲聊、业务概念解释、不需要查生产数据的问题 → `--thinking low`
- DEEP = 要查数、要翻代码、要对口径 → `--thinking max`（现状）
- 判不出或模型故障一律 DEEP
- 快路径仍保留全部工具：分错了只是想得浅一点，不会答不了
- 依赖：T6

**T10 提示词瘦身**（回归题集验证）
- `prompts/agent.md`（25KB/305 行）拆成：
  - `prompts/core.md`：身份、业务线判断、知识库位置、说话方式、安全边界（目标 ≤ 8KB）
  - `prompts/data-playbook.md`：查数三步、七步 SQL 流程、性能红线、降级路径、命令写法
- core 里写死"要查生产数据，第一步必须先 read data-playbook.md"
- 白名单扩展放行读这一个文件（`ALLOWED_READ_FILES`，与 ROOTS 一样接进一致性检查）
- 风险：模型跳过手册导致查数口径出错（机构数事故同类）→ 用 T0 题集对比，查数题正确率下降就回退这一票
- 依赖：T0、T9

**T11 日志字段补全**（随各票顺手加，最后统一检查）
- 每轮日志带：msgid、route（quick/deep）、mode（inline/handoff）、stalled 次数、投递 channel、inputTokens、各阶段耗时
- 用于上线后对比 G3/G4/G5

## 5. 执行流程（implement → tdd → code-review）

1. **开工前**：虎老师确认第 3 节测试缝 + 第 6 节决策点；建好测试机器人
2. **/implement 按票推进**，每票：
   - 有缝的票走 **/tdd**：一次一条测试 → 看它红 → 最少实现 → 看它绿 → 下一条（竖切，不先写一堆测试）
   - 每条测试后跑单文件：`node --test test/<file>.test.js`
   - 每票结束跑 `npm run typecheck`，提交一个 commit（信息写清票号）
   - 同步更新 `docs/seams.md`、`CONTEXT.md`（新词：收件箱、投递、两段式、看门狗、轮转、快/深路径）
3. **全部票完成**：`npm test` 全量一次 + 测试机器人冒烟（第 7 节）
4. **/code-review**：固定点 `e13a0ec`，Spec = 本文件
   - Standards 轴依据：`VIBECODING/AGENTS.md`（简单优先、外科式改动）、`CONTEXT.md`、`docs/seams.md` + Fowler 气味基线
   - Spec 轴依据：本文件第 1、3、4 节
   - 两个子 Agent 并行，报告分开呈现；硬伤修完再复审一轮
   - 注：仓库没有 `docs/agents/issue-tracker.md`，Spec 直接传本文件路径，不走 issue tracker
5. **重构**只在 review 阶段做，不混进红绿循环
6. **上线**：虎老师点头后合 master、重启生产机器人；观察 2 个工作日，对照 G1–G5 出一页小结

## 6. 待虎老师拍板

| # | 决策 | 我的建议 |
|---|---|---|
| D1 | 是否新建测试机器人 | **建**。不建的话开发时只能先停生产，效率低且容易忘记恢复 |
| D2 | 撤回 9466906、改回同会话串行 | **撤回**，不同人仍并行，只排同一个人的连发 |
| D3 | 阈值 | 前台 60s 转后台 / 卡死判定 45s / 后台上限 10 分钟 / 补跑窗口 30 分钟 / 轮转 4 小时或 6 万 token / 全局并发 4 |
| D4 | 快路径思考强度 | `low`（不用 `off`，保留一点推理防胡说） |
| D5 | 提示词拆分 | 做，但以 T0 题集为准，查数题退步就回退 T10 |
| D6 | 补发的问题超出 30 分钟怎么处理 | 不补，只记日志（隔很久冒出答案比不答更奇怪） |
| D7 | 分支与合并 | 在 `reliability-tier12` 上开发，每票一个 commit，验收后合 master |

## 7. 冒烟场景（测试机器人上跑）

| 场景 | 期望 |
|---|---|
| 单聊发"你好" | ≤ 10 秒答复，日志 route=quick |
| 问一个查数题 | 20 秒出"慢"提示；60 秒内没完则流式收尾 + 之后主动推送答案；日志 mode=handoff |
| 提问后 5 秒内 `launchctl kickstart -k` | 重启后收到"刚才那条我补上：…" |
| 同一人连发 3 条 | 按顺序逐条答，第 2、3 条占位为"前面那条还在查" |
| 群聊 @ 提问 + 新会话指令 | 正常答复，不崩进程 |
| 人为让 pi 卡住（断内网模型地址） | 45 秒后重试一次，再失败给超时话术，不吐原始错误 |
| 查数题答复含个人信息 | guard 仍打回重写（回归既有行为） |

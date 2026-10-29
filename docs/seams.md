# 测试缝（seams）

按 tdd skill 要求，测试只写在这些经过确认的公开边界上，不测内部实现细节。

| 缝 | 模块 | 公开签名 | 验证的行为 |
|---|---|---|---|
| S1 命令白名单 | `src/command-whitelist.js` | `isCommandAllowed(command, roots) → {allowed, reason}` | 合法脚本放行；写入、外传、越界路径、读凭证全部拒绝 |
| S2 Agent 调用 | `src/agent.js` | `runAgentTurn({prompt, sessionId, runner, timeoutMs, idleTimeoutMs, hardTimeoutMs, thinkingLevel, config, projectDir}) → {text, biTouched, timedOut, stalled, failed, inputTokens}` | 从事件流提取最终答复；识别 bi_query.py；事件流持续吐时不超时；静默超过 idle 判 stalled；超过 hard 判 timedOut；回传输入 token 数；思考强度透传给 runner |
| S3 守卫判定 | `src/guard.js` | `reviewReply({answer, callModel}) → {verdict, reason}` | ALLOW/DENY 解析；模型故障时 fail-closed；只判答复、不接收提问 |
| S4 轮次编排 | `src/orchestrate.js` | `handleTurn({question, sessionKey, deps}) → {finalText, rounds, guarded, exhausted, timedOut, stalled, stallRetries}` | DENY 后重写一次即通过；连续 3 次 DENY 走兜底；未碰 BI 时不调用 guard；卡住自动重试一次，仍卡住给超时话术 |
| S5 会话标记 | `src/session-state.js` | `createSessionState({storePath, rotation}) → {resolveSessionId(userKey, now), recordActivity, startNewSession, markBiTouched, isBiTouched, flush}` | 跨进程重启保留；文件损坏时保守地全量过 guard；会话满 24 小时 / 闲置满 24 小时 / 上下文超阈值自动换代；老状态文件首次访问换一次；旧代粘性标记随之作废 |
| S6 收件箱 | `src/inbox.js` | `createInbox({storePath}) → {load, accept(msg) → {isNew}, markRunning, markAnswered, markFailed, recoverable(now, windowMs) → msg[], stale(now, windowMs) → msg[], compact, flush}` | 同 msgid 只接受一次；重启后读回未答问题；超出窗口不返回；坏行不崩；清理按保留期丢记录 |
| S7 投递 | `src/deliver.js` | `deliverFinal({text, stream, push, retries, wait}) → {channel, reason?}` | 流式成功走 stream；流式失败改走 push；push 按次数重试；全失败返回 none 且不抛异常 |
| S8 两段式生命周期 | `src/turn-lifecycle.js` | `runTurnLifecycle({execute, surface, messages, slowAfterMs, handoffAfterMs}) → {mode, text, result}` | 快答不发提示；慢了一次慢提示；超交接时限先收尾再返回后台答案；执行失败异常上抛；交接后不再重复提示 |
| S9 会话队列 | `src/session-queue.js` | `createSessionQueue({maxConcurrent}) → {run(key, fn)}` | 同 key 按到达顺序串行；不同 key 并行；总并发不超上限；任务抛异常后队列继续 |
| S10 分级路由 | `src/route.js` | `classifyQuestion({question, callModel}) → "quick"\|"deep"` | QUICK/DEEP 正确解析；夹带解释取首个关键词；无法识别或模型故障一律 deep |

依赖注入约定：S2 的 `runner`、S3/S10 的 `callModel`、S4 的 `deps`、S7 的 `stream`/`push`/`wait`、S8 的 `execute`/`surface` 都是注入点，测试用假实现替换真实的外部边界（子进程、HTTP、企微 SDK、时钟）。项目自身模块一律不 mock。

不写单测、靠冒烟验证的部分：单实例锁的 pid 探活、SIGTERM 优雅退出的等待、launchd 配置、启动补跑的实际拉起、提示词拆分的效果（靠 `docs/regression-questions.md` 前后对比）。

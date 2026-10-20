# 测试缝（seams）

按 tdd skill 要求，测试只写在这些经过确认的公开边界上，不测内部实现细节。

| 缝 | 模块 | 公开签名 | 验证的行为 |
|---|---|---|---|
| S1 命令白名单 | `src/command-whitelist.js` | `isCommandAllowed(command, roots) → {allowed, reason}` | 合法脚本放行；写入、外传、越界路径、读凭证全部拒绝 |
| S2 Agent 调用 | `src/agent.js` | `runAgentTurn({prompt, sessionId, runner, timeoutMs}) → {text, biTouched, timedOut}` | 从事件流提取最终答复；识别 bi_query.py；超时终止 |
| S3 守卫判定 | `src/guard.js` | `reviewReply({question, answer, callModel}) → {verdict, reason}` | ALLOW/DENY 解析；模型故障时 fail-closed |
| S4 轮次编排 | `src/orchestrate.js` | `handleTurn({question, sessionKey, deps}) → {finalText, rounds, guarded}` | DENY 后重写一次即通过；连续 3 次 DENY 走兜底；未碰 BI 时不调用 guard |
| S5 会话标记 | `src/session-state.js` | `createSessionState({storePath}) → {markBiTouched, isBiTouched, flush}` | 跨进程重启保留；文件损坏时保守地全量过 guard |

依赖注入约定：S2 的 `runner`、S3 的 `callModel`、S4 的 `deps` 都是注入点，测试用假实现替换真实的外部边界（子进程、HTTP）。项目自身模块一律不 mock。

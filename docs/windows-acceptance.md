# Windows 独立测试机器人固定验收清单

验收记录由 `acceptance-create` 生成，格式版本为 2，十个 ID 固定且全部必需。`acceptance-update` 只允许 `pending / passed / failed`，不能用 `skipped` 跳过；登记 `passed` 时必须提供真实存在、可解析、结构完整的 JSON 主证据，不能再只填一个字符串路径。

验收期间 `wecom.json.active` 必须是 `test`，且测试与正式 botId 不同。主证据和每个场景结果都绑定独立测试 botId、目标实例和资源版本；使用正式 botId、复用其他实例证据、空占位、未执行、失败、缺场景或人工未复核均不能通过。

## 固定项目与场景

| 验收项 ID | 固定场景 ID（全部必需） | 必须留存的实际结果 |
|---|---|---|
| `progressive-loading` | `simple-concept`、`concrete-rule`、`data-query`、`history-current` | 每轮 `loadedResources`、`loadDepth`；简单题不展开全部 raw，具体规则在摘要不足时深入，来源与时间正确 |
| `skills-work-product` | `create-work-product`、`modify-work-product`、`sync-preserves-work-product` | 只加载命中 Skill 及所需引用；workspace 产物真实存在并完成二次修改；同步资源后产物仍在 |
| `execution-approval` | `approved-workspace-write`、`outside-write-denied`、`approval-failure-closed`、`no-authorization-propagation` | 获批写入有模型 ALLOW；越界由 hard-rule DENY；审批异常 fail-closed；授权不扩散到另一次操作 |
| `output-guard` | `sensitive-rework`、`repeated-deny-fallback`、`guard-failure-closed`、`question-not-sent-to-guard` | DENY→重写→ALLOW；连续失败走兜底；Guard 故障不外发原文；问题正文不交给 Guard |
| `wecom-text` | `single-chat`、`group-chat` | 收到落盘、占位、最终答复、inbox answered；消息与 userid/session 对应 |
| `wecom-image` | `pure-image`、`mixed-image-text`、`image-failure` | 图片解密落盘、agent 实际 read、答复引用图片内容；失败时有明确重发提示 |
| `long-task` | `handoff-background-push` | 先收到「查好了单独发你」；后台继续；最终主动推送与任务结果一致，不重复答复 |
| `disconnect-recovery` | `sigterm-drain`、`recovery-within-window`、`stale-not-recovered`、`disconnect-restart` | SIGTERM drain；超窗不补；窗口内未完成 inbox 带补跑前缀；断线退出后 systemd 拉起 |
| `final-delivery` | `inline-stream`、`stream-failure-push`、`all-failed` | inline 走流式；handoff/流式失败走 push；重试次序正确；全失败 inbox=failed 且不外发未过 Guard 原文 |
| `migration-comparison` | `fixed-question-comparison` | 六题固定对照 JSON；资源版本和四角色模型名称一致；人工核对答案口径、加载资源、Skills、审批，不捆绑模型升级 |

## 主证据格式

建议目录：

```text
acceptance/
  acceptance.json
  before.json
  after.json
  comparison.json
  wecom-text-evidence.json
  evidence/wecom-text/single-chat.json
  evidence/wecom-text/group-chat.json
  ...其余验收项的主证据与逐场景结果...
```

下面是 `wecom-text-evidence.json` 的缩略示例。实际文件必须同时列出 `single-chat` 和 `group-chat`；其他验收项也必须列出上表规定的全部场景，不能照抄缩略示例充当证据。

```json
{
  "format": "wecom-support-bot-windows-acceptance-evidence",
  "formatVersion": 1,
  "caseId": "wecom-text",
  "testBotId": "<独立测试 botId>",
  "targetInstanceId": "<acceptance.json 中的目标实例 ID>",
  "resourceVersion": "<acceptance.json 中的资源版本>",
  "status": "passed",
  "environment": {
    "platform": "windows-wsl2",
    "distribution": "Ubuntu-24.04",
    "windowsVersion": "<真实 Windows 版本>"
  },
  "scenarios": [
    {
      "id": "single-chat",
      "status": "passed",
      "resultPath": "evidence/wecom-text/single-chat.json",
      "resultSha256": "<该结果文件的 64 位 SHA-256>"
    },
    {
      "id": "group-chat",
      "status": "passed",
      "resultPath": "evidence/wecom-text/group-chat.json",
      "resultSha256": "<该结果文件的 64 位 SHA-256>"
    }
  ],
  "humanReview": {
    "approved": true,
    "reviewer": "<人工复核人>",
    "reviewedAt": "<ISO 时间>",
    "notes": "<人工核对范围与结论>"
  },
  "createdAt": "<ISO 时间>"
}
```

`resultPath` 是相对主证据所在目录的安全相对路径。登记时校验文件存在、SHA-256 匹配，并把主证据自身哈希写入验收记录；之后修改主证据或任何场景结果都会使 dry-run 和 execute 切换门失败，必须重新验收登记。

每个普通场景结果是独立 JSON，格式如下。`result` 必须填写该场景的实际消息、加载、审批、Guard、投递或文件检查结果，不允许 `{}`、`placeholder`、`TODO`、`not-run` 等空证据或占位值。

```json
{
  "format": "wecom-support-bot-windows-acceptance-result",
  "formatVersion": 1,
  "caseId": "wecom-text",
  "scenarioId": "single-chat",
  "testBotId": "<与主证据相同的独立测试 botId>",
  "targetInstanceId": "<同一目标实例 ID>",
  "resourceVersion": "<同一资源版本>",
  "executed": true,
  "status": "passed",
  "executedAt": "<真实执行时间>",
  "result": {
    "msgid": "<真实测试消息 ID>",
    "inboxStatus": "answered",
    "finalDelivery": "delivered",
    "sessionId": "<实际会话代号>",
    "placeholderObserved": true
  }
}
```

## 固定问题运行与人工对照

仓库的 `docs/windows-migration-questions.json` 是唯一固定清单，每题包含稳定 ID、正文和正文 SHA-256。迁移前后分别执行：

```bash
node scripts/windows-instance.js acceptance-run --instance-dir <实例> --questions docs/windows-migration-questions.json --output <结果.json>
node scripts/windows-instance.js acceptance-compare --before <旧结果.json> --after <新结果.json> --output <对照.json>
```

`acceptance-run` 对六题逐一真实调用公开 `instance ask`，记录 `executed`、`executionStatus`、正文哈希和原始结果；报告只标 `completed` 或 `failed`，不会自动把回答标成 `passed`。换题、同 ID 改正文、漏题、加题、未执行或执行失败都会在对照门失败。

`acceptance-compare` 只生成 `pending-human-review` 的结构化对照，不判断措辞等价。人工核对后，`migration-comparison` 主证据的场景 `fixed-question-comparison` 应把 `resultPath` 指向该对照文件并填写其 SHA-256；主证据中的 `humanReview.approved=true` 表示人工批准，不能直接把对照报告伪造成 `passed`。

## 登记与放行

```bash
node scripts/windows-instance.js acceptance-update \
  --record acceptance/acceptance.json \
  --case wecom-text \
  --status passed \
  --evidence acceptance/wecom-text-evidence.json
```

`cutover-old` 与 `cutover-new` 的 dry-run 和 execute 都会重新读取验收记录、全部主证据、全部场景结果及固定问题对照，核对实例、资源、模型、测试/正式 botId 指纹、文件哈希和人工批准。任何缺项、失败、正式 botId、路径不存在、占位、伪造状态或登记后篡改都不能放行。

本仓库的 Mac 测试会构造临时有效/无效 JSON fixture 验证这些门禁，但 fixture 不是 Windows/WSL2 实机证据，不得复制为正式验收结论。真实企微文本、图片、长任务、断线恢复、最终投递及正式切换仍必须在目标环境逐项执行。

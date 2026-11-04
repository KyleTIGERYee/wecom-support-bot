# wecom-support-bot

企微技术支持机器人。同事在企业微信里 @ 机器人提问，它查四个知识库、查生产数据、翻代码后回答。

## 架构

```
企业微信（智能机器人 API 模式 · 长连接）
        ↓ wss://openws.work.weixin.qq.com（出站，无需公网 IP）
   接入：src/index.js 网关进程（launchd 常驻，单实例 pid 锁）
        ↓ 收到即落盘 data/inbox.jsonl（按 msgid 去重）→ 5 秒内回占位
   调度：同一同事的消息串行排队，全局最多 4 轮并行；分级 quick/deep
        ↓ spawn，每轮一次
   执行：隔离的 pi 实例（/Users/kyle/.pi-support，与日常 coding 的 pi 完全隔离）
        ├─ ajly-wiki / lzz-wiki          业务概念
        ├─ ajly-db-wiki / lzz-db-wiki    表结构与检索参考
        ├─ bi_query.py                   生产数据（只读，LIMIT 100）
        └─ ajly / lezuzu 代码仓库        实现逻辑
        ↓ 事件流静默 45 秒判卡住，重试一次
   守卫：隐私校验（碰过生产数据的会话，之后每轮都过）
        ↓
   投递：60 秒内答完 → 流式消息原地收尾
         超 60 秒 → 先收尾「查好了单独发你」，后台继续，完成主动推送
         流式发不出去 → 主动推送（重试 1/3/9 秒）
        ↓
   收件箱标记 answered / failed；进程重启时补跑 30 分钟内没答完的问题
```

## 隐私守卫

只要某个会话查过生产数据，该会话之后每一轮答复都会过一道隐私校验：

1. guard 调内网模型判定答复是否含真实个人信息
2. `DENY` → 把理由回灌同一 pi 会话，要求脱敏重写，再判一次
3. 连续 3 次不过 → 固定兜底话术，不吐原文

agent 的原始输出在通过校验前**绝不外发**，同事只会看到「正在查…」变成最终答案。

## 安全边界

两条独立的防线：

- **命令白名单**（`extensions/bash-whitelist.ts`）—— 只放行四个 wiki 的检索脚本和只读文件命令，拒绝重定向、管道、命令串联、越界路径
- **路径白名单** —— 只能访问四个 wiki 与两个代码仓库，读不到 `~/.pi` 里的密钥

## 部署

```bash
# 1. 安装隔离的 pi（首次）
bash scripts/install-pi.sh

# 2. 装依赖
npm install

# 3. 配置凭证
#    config/secrets.json 需要 botId 与 secret，权限必须是 600
chmod 600 config/secrets.json

# 4. 前台试跑
npm start

# 5. 装成常驻服务
cp launchd/com.kyle.wecom-support-bot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.kyle.wecom-support-bot.plist
```

## 运维

```bash
# 看日志
tail -f logs/bot.log

# 重启
launchctl kickstart -k gui/$(id -u)/com.kyle.wecom-support-bot

# 停掉
launchctl unload ~/Library/LaunchAgents/com.kyle.wecom-support-bot.plist

# 跑测试
npm test
```

**单实例约束**：企微同一个机器人同时只能有一条长连接，新连接会踢掉旧的。代码里有单实例锁（`data/<botId 前 8 位>.lock`，记 pid 并探活），前台和 launchd 各跑一份时第二份会直接拒绝启动。

**重置 Guard 状态**：删掉 `data/session-state.json`，所有会话回到「未碰过 BI」状态。

**收件箱与补跑**：`data/inbox.jsonl` 记录每条收到的提问与处理结果。正常退出会等 30 秒把在途轮次答完；被强杀或崩溃时，下次启动会把 30 分钟内没答完的问题重跑一遍并主动推送（开头带「刚才那条我补上：」）。想放弃补跑，删掉这个文件即可。

## 开发与生产隔离

生产机器人靠 launchd 常驻，**不要在它身上调试**：重启会杀掉正在处理的问题，而且任何人此刻在问都会断线。

调试请另建一个企微智能机器人（API 模式），凭证放 `config/secrets.dev.json`，然后：

```bash
WECOM_BOT_SECRETS=config/secrets.dev.json npm start
```

`WECOM_BOT_SECRETS` 支持绝对路径与相对项目目录的路径，缺省仍是 `config/secrets.json`。两个机器人是两条独立长连接，互不踢线。

## 配置

`config/default.json`：

| 字段 | 含义 |
|---|---|
| `pi.binary` / `pi.agentDir` | 隔离 pi 的路径 |
| `pi.timeoutMs` | 单轮总上限（默认 10 分钟，转后台后仍在跑） |
| `pi.idleTimeoutMs` | 事件流静默多久判卡住（45 秒） |
| `pi.handoffTimeoutMs` | 多久没答完就转后台（60 秒） |
| `pi.thinkingLevels` | quick / deep 两档思考强度（low / max） |
| `roots` | 可访问的目录白名单 |
| `guard.maxRounds` | 隐私打回的最大轮数 |
| `routing.enabled` | 是否启用分级路由 |
| `rotation.idleMs` / `rotation.maxInputTokens` | 会话轮转阈值（4 小时 / 6 万 token） |
| `queue.maxConcurrent` | 全局最多同时跑几轮 |
| `inbox.recoveryWindowMs` / `inbox.retentionMs` | 补跑窗口（30 分钟）/ 收件箱保留期（24 小时） |
| `surface.*` | 用户可见文案 |

## 本地实例初始化与同步

不用手改实例配置。通过公开初始化命令选择目录、单文件或 zip 资源包，并逐项指定 `shared` / `private` 范围。团队模板（`--template team`）只接受 `shared` 来源，空白模板可省略 `--template`；既有实例用 `--template import --package <分发包>` 导入。

主模型、快速模型、执行审批模型与 Guard 模型默认共用 `--base-url` / `--api-key` / `--model`。需要独立配置时分别使用 `--quick-*`、`--approval-*`、`--guard-*` 三组选项。初始化会逐项检查四个模型，并通过真实 pi 读取本地知识与 Skill 正文、走完执行审批链和与 `ask` 相同的示例任务编排；临时检查产物会清理。未安装 pi、模型失败或未执行的检查会明确显示 `error` / `skipped`，不会冒充通过。

```bash
npm run instance -- init \
  --instance-dir ./instances/team \
  --template team \
  --source /path/to/shared-docs --scope shared \
  --source /path/to/context.zip --scope shared \
  --base-url http://127.0.0.1:3425/v1 \
  --api-key <模型凭证> \
  --model <主模型> \
  --quick-model <快速模型> \
  --approval-model <执行审批模型> \
  --guard-model <Guard 模型>

# 以本次明确选择的来源完整更新标准资源副本；workspace、data 和会话不动
npm run instance -- sync \
  --instance-dir ./instances/team \
  --source /path/to/shared-docs --scope shared

# 查看资源版本、目录/副本一致性、本地修改漂移、最近同步和加载失败
npm run instance -- status --instance-dir ./instances/team

# 生成仅含共享资源的团队包；不含凭证、私人来源、workspace、会话或运行状态
npm run instance -- export \
  --instance-dir ./instances/team \
  --output ./team-instance.zip

# 导入时生成新实例身份，复用脱敏模型设置，但必须提供新的模型凭证
npm run instance -- init \
  --instance-dir ./instances/imported \
  --template import \
  --package ./team-instance.zip \
  --api-key <新模型凭证>

npm run instance -- ask \
  --instance-dir ./instances/team \
  --question "退租审批需要几级？" \
  --session-key <同事标识>
```

初始化与同步只写实例的 `context/` 标准副本，问答只读取该副本和独立 `workspace/`；原始目录、GitLab 和主工作区不是运行时来源。同步先构建并校验暂存副本，再把 context、资源 manifest、实例配置与 sync-status 作为一个事务提交；任一步失败都会恢复旧副本和旧状态。目录在每次问答/status 时从实际副本重建，源中删除的文件不会残留为目录项。

`--source-type gitlab` 接受本地路径、`file://`、HTTP(S) 与 SSH 仓库，可用 `--ref` 选择分支；实现只执行 clone 到临时副本后校验和单向同步，不 push、不回写来源，也不保存或在错误日志中暴露 URL 凭证。HTTP/SSH 自动化验收通过 PATH 中的假 git 完成，真实 GitLab 联网尚未验收。zip 解包和团队打包使用本机已有的 `unzip` / `zip`，不会安装新依赖。

## 已知限制

- 纯文本对话。图片、文件、语音暂未处理（图片需解密下载，语音企微已转文字可直接用）。
- 分级路由判错只会让快答变慢或深答变浅，不会答不了：两条路径都保留全部工具。
- 会话记忆存在 pi 的 session 里，按企微 userid 隔离，两人不共享。
- 群聊里所有成员共享同一会话上下文（按 `from.userid` 隔离，群里每个人各自独立）。

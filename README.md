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
# 1. 安装前检查：只报告 Node / 依赖 / pi / python3 / zip / unzip，不安装
npm run setup -- --check

# 2. 用户明确同意后，安装依赖与隔离的 pi；缺 python3/zip/unzip 只报告，不装系统包
npm run setup -- --allow-install

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

安装与初始化由用户自己的编码 Agent 执行：把仓库交给 ZCode、Codex 或 Claude Code，它会按根 `AGENTS.md` 的入口与硬性规则、`docs/agents/initialization.md` 的可执行协议盘点上下文、逐项确认来源 / 共享范围 / 同步频率，再执行初始化、定时同步与验收。本节命令是协议执行时使用的底层 CLI。

不用手改实例配置。通过公开初始化命令选择目录、单文件或 zip 资源包，并逐项指定 `shared` / `private` 范围。团队模板（`--template team`）只接受 `shared` 来源，空白模板可省略 `--template`；既有实例用 `--template import --package <分发包>` 导入。同一实例内来源名必须唯一：`init` / `sync` / `plan` 遇到同名不同路径会直接报错并列出冲突的真实路径；`--exclude` / `--clear-excludes` / `--symlinks` 是逐来源选项（跟在对应 `--source` 之后），与 `plan` 同义并写入 `data/source-registry.json`，首次补齐同步计划时沿用。

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

# 显式登记可信只读 BI；只改 instance.json 中对应业务线的真实脚本路径
# 脚本必须位于 config/default.json 的 roots.knowledgeBase 下对应业务线默认目录：
# 数据库/<ajly|lzz>-db-wiki/scripts/bi_query.py
npm run instance -- configure-bi \
  --instance-dir ./instances/team \
  --business lzz \
  --script /absolute/path/to/知识库/数据库/lzz-db-wiki/scripts/bi_query.py

# 只复制本次列出的来源（逐个列出全部来源即为全量）；workspace 和会话不动
# 只在有本地改动时才把上一版留到 <instance>/snapshots/previous，并报告 localModifications
# 结果里的 notIncluded 列出计划中应同步但本次未复制的来源
npm run instance -- sync \
  --instance-dir ./instances/team \
  --source /path/to/shared-docs --scope shared

# 查看资源版本、目录/副本一致性、本地修改漂移、上一版快照、最近同步和加载失败
npm run instance -- status --instance-dir ./instances/team

# 只读盘点候选来源；输出内容、体积、Skills、资源类型、敏感文件、软链与建议
npm run instance -- inventory --root /path/to/source --root /path/to/other

# 逐来源配置共享范围与同步频率；不带 --source 时只查看计划与下次到期时间
# 工作日每两小时：--cadence every --every-minutes 120 --weekdays 1-5
# 首次 plan 会为所有来源补齐 manual 条目，未登记来源不会在同步时被删掉
npm run instance -- plan --instance-dir ./instances/team \
  --source /path/to/source --scope shared --cadence daily --at 09:00

# 定时同步；默认 dry-run，展示 launchd plist / systemd unit 后取得同意再加 --install --yes
npm run instance -- schedule --instance-dir ./instances/team --tick-minutes 15

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

本地实例只执行 `instance.json` 的 `trustedDataScripts` 显式登记的 BI 入口；未配置时不会从 `config/default.json` 自动补全，真实查数会明确提示缺少配置。`configure-bi` 会校验业务线、绝对路径、realpath 和文件类型，只接受上述默认业务目录中的真实 `bi_query.py`，拒绝悬空路径、目录、任意副本、环境变量注入以及 context/workspace/project 保护根别名；它不改变 `ready`、资源版本、workspace 或会话状态。

初始化与同步写实例的 `context/` 标准副本与 `data/source-registry.json`（原始来源路径、类型、`--ref` 与登记期复制选项，mode 0600）；问答只读取该副本和独立 `workspace/`；原始目录、GitLab 和主工作区不是运行时来源。同步先构建并校验暂存副本并统计 `localModifications`；有本地改动时把当前 `context/` 暂存为 `snapshots/previous.next`，再把 context、资源 manifest、实例配置、source registry 与 sync-status 作为一个事务提交，提交成功且本次有改动时才把 `previous.next` 原子替换成 `snapshots/previous`（无本地改动不生成快照，已有 `previous` 保持不动）；任一步失败都会恢复旧副本和旧状态并丢弃未提交的快照。`sync-due` 只从原始来源复制作到期来源，未到期且已有副本的来源用硬链接沿用、不读原始来源也不推进 `lastRunAt`；未到期但没有副本时回退为从原始来源复制。手动 `sync` 不沿用，始终全部重新复制。目录在每次问答/status 时从实际副本重建，源中删除的文件不会残留为目录项。`plan --source` 只接受 registry 中 realpath 精确匹配的原始路径，同名不同路径会报错；同名来源在 `init` / `sync` / `plan` 与 `sync-due` 全部 fail-closed。

`--source-type gitlab` 接受本地路径、`file://`、HTTP(S) 与 SSH 仓库，可用 `--ref` 选择分支；`--ref` 写入实例内 `data/source-registry.json`，`sync-due` 按该分支克隆，`status` 会展示。含内嵌 userinfo 的 URL（HTTP(S) 用户名/密码或任何带密码的地址）会被拒绝，不会落盘或回显，请改用无凭据地址或 SSH agent。实现只执行 clone 到临时副本后校验和单向同步，不 push、不回写来源，也不在错误日志中暴露 URL 凭证。HTTP/SSH 自动化验收通过 PATH 中的假 git 完成，真实 GitLab 联网尚未验收。zip 解包和团队打包使用本机已有的 `unzip` / `zip`，不会安装新依赖。

凭证文件（`.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*`、`*credential*`、`secrets.json`、`models.json`、`wecom.json`、`.npmrc`、`.netrc`）默认排除。只有用户明确要求把凭证随**私有**副本一起放时，才对 `private` 来源加 `--include-secrets`；`shared` 来源会直接报错。只要来源用了该选项就标 `secretsIncluded: true`，被包含的文件列入 `secretFiles`（没有命中时为空数组）。导出团队包时只要发现敏感文件就报错拒绝，不会静默剔除。BI 不需要复制 `.env`：可信 `bi_query.py` 按原路径就地执行，读取它旁边的凭证。

## Windows / WSL2 安装与迁移

Windows 采用 WSL2、Linux 原生文件系统和 systemd，不使用原生 Windows 服务或 Docker Desktop。先构建不含私人来源、真实凭证和平台产物的安装包，再在 Windows 运行一键安装器与本地控制台：

```bash
node scripts/windows-instance.js build-package --output /path/outside/repo/wecom-windows
# 将输出目录复制到 Windows，运行 Install-WecomSupportBot.cmd，再运行 WecomSupportBot-Console.cmd
```

控制台复用上述 `instance init/status/sync/ask`，在 WSL 内完成四模型真实连接测试、知识/Skills/执行审批检查及企微测试机器人配置；控制台、启动前检查和 systemd 都显式使用 `/opt/wecom-support-bot/runtime/pi/bin/pi`。原机器的 `localhost/127.0.0.1` 不可直接沿用，需填写 WSL 可路由到的 Windows 主机地址或实际模型 URL。正式切换与回滚默认 dry-run，要求独立测试机器人全项结构化 JSON 证据、固定场景真实通过结果、文件哈希与人工复核批准，且 dry-run 和 execute 都会重验；固定六题同时绑定 ID 与正文 SHA-256。状态包只迁移 workspace、inbox/session-state 和明确的 pi 会话，不包含 models/凭证/provider 密钥，legacy 根会话保持原相对路径。切换仍要求显式确认、先停旧端再启新端；回滚合并 Windows 期间新增任务、inbox 和会话，不直接覆盖冲突文件。

完整安装、测试机器人固定清单、切换/回滚命令与故障安全语义见：

- `docs/windows-wsl2.md`
- `docs/windows-acceptance.md`
- `docs/windows-migration-questions.json`

**当前验证边界**：本仓库只有 macOS，真实 Windows UAC/DISM/重启续装、WSL2/systemd、目标模型网络、测试机器人企微全链路以及正式切换/回滚均未实机验收。Mac 测试只覆盖公开 dry-run、安装包校验、假 systemctl/launchctl 边界、状态合并和临时结构化验收 fixture，不代表这些实机项目已经通过；本机无 `pwsh` 时 PowerShell 解析、标准包 PlanOnly 与控制台假 WSL 测试会明确 skipped。

## 已知限制

- 纯文本对话。图片、文件、语音暂未处理（图片需解密下载，语音企微已转文字可直接用）。
- 分级路由判错只会让快答变慢或深答变浅，不会答不了：两条路径都保留全部工具。
- 会话记忆存在 pi 的 session 里，按企微 userid 隔离，两人不共享。
- 群聊里所有成员共享同一会话上下文（按 `from.userid` 隔离，群里每个人各自独立）。

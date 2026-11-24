# Windows / WSL2 安装、控制台与正式切换

本路线只使用 **WSL2 + Linux 原生文件系统 + systemd**，不引入原生 Windows 服务或 Docker Desktop。安装器、控制台和迁移命令都不会替用户选择正式 botId；独立测试机器人验收是正式切换的硬门。

## 1. 构建无私人来源的安装资源包

在源项目执行，输出目录必须在源项目之外且为空：

```bash
node scripts/windows-instance.js build-package --output /path/to/wecom-windows-package
node scripts/windows-instance.js verify-package --package-dir /path/to/wecom-windows-package
```

把整个输出目录复制到 Windows。标准包布局固定如下，`windows-package.json` 始终位于包根，而不是 `windows/` 内：

```text
wecom-windows-package/
  windows-package.json
  windows/
    install.ps1
    console.ps1
    wsl-plan.json
    linux/install.sh
    linux/service.sh
  scripts/
  src/
  ...其余白名单运行资源...
```

`install-plan` 的 `windowsCommands.planOnly` 会生成指向 `<package>/windows/install.ps1` 的公开检查命令；也可在包根执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\install.ps1 -PlanOnly`。安装器从脚本位置向上定位包根并校验清单。资源包采用文件白名单和逐文件 SHA-256：

- 只含运行源码、本地实例公开 CLI、Windows 控制台/安装器、提示词和验收文档。
- 不含 `config/secrets*.json`、实例 `secrets.json` / `wecom.json`、真实 API Key、私人知识来源、workspace、会话、inbox、`node_modules`、launchd、Mac pi 或 models.json。
- 包内 `config/default.json` 已清空 Mac 路径和模型地址；目标实例通过 `instance init` 初始化重新生成配置。
- 迁移状态包是另一种显式操作，绝不会随安装资源包自动分发。

## 2. 一键安装与安全续装

在 Windows 双击 `Install-WecomSupportBot.cmd`。它会请求 UAC；也可以以管理员 PowerShell 运行 `windows/install.ps1`。

安装器的安全门：

1. 先验证安装资源包清单和每个文件哈希；`install.ps1 -PlanOnly` 只输出计划。
2. 首次启用 `Microsoft-Windows-Subsystem-Linux` 和 `VirtualMachinePlatform` 前必须输入 `INSTALL-WSL2`。
3. DISM 返回需要重启时，只保存续装状态并退出，**不自动重启**。重启后运行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -Resume
   ```

   续装会核对发行版、资源包哈希和实际开机时间；尚未重启会拒绝继续。若重启后发现发行版已经存在，为避免重复启用功能或误改既有 WSL，会要求复核后不带 `-Resume` 重新明确确认。
4. 在发行版启用 systemd 前会明确提示 `wsl --shutdown` 会关闭**所有 WSL 发行版**的当前会话，必须再次输入 `RESTART-WSL`。若有其他 WSL 工作，先保存。
5. 安装失败会给出具体命令/退出码；本安装器不停止旧机器人，也不启用正式通道。

默认发行版为 `Ubuntu-24.04`，可用 `-Distro` 指定受支持且名称合法的发行版。项目和运行目录固定为：

| 内容 | WSL Linux 原生路径 |
|---|---|
| 项目 | `/opt/wecom-support-bot/app` |
| 实例、workspace、inbox、会话、pi sessions | `/var/lib/wecom-support-bot/instance` |
| 新安装的 Node / pi | `/opt/wecom-support-bot/runtime` |
| systemd 单元 | `/etc/systemd/system/wecom-support-bot.service` |

`/mnt/c` 只允许作为安装包和用户显式选择的来源的读取入口，**不作为项目或运行数据目录**。Linux 脚本和公开 `install-plan` 都会拒绝 `/mnt/<盘符>` 运行路径。

目标 Linux 会重新执行：APT 安装 Python/pip/zip/unzip/curl 等；下载 Node `22.19.0` 并用官方 `SHASUMS256.txt` 校验；`npm ci --omit=dev`；安装隔离 pi `0.84.1`。不会复制 Mac 依赖、launchd、凭证或 pi 配置。

## 3. systemd 与现有优雅退出语义

`windows/linux/service.sh` 是控制台背后的唯一服务入口。systemd 单元只由公开 `service-unit` 命令按实际 project/instance/runtime 路径生成，不维护另一份静态副本。单元行为与 launchd 对齐：

- `Restart=always`、`RestartSec=10`：异常退出后常驻拉起。
- `KillSignal=SIGTERM`、`TimeoutStopSec=40`：应用原有 30 秒在途轮次 drain 后再由 systemd 强制结束。
- 启动时仍使用现有收件箱补跑、单实例锁、断线退出重连语义，不重写这些机制。
- 安装完成只 `daemon-reload`，不 `enable/start`。模型、资源和独立测试机器人初始化完成后，控制台启动测试服务时才 `enable --now`。

企微入口通过 `WECOM_BOT_INSTANCE_DIR` 复用本地实例的 `instance.json`、本地标准副本、四模型、执行审批与 Guard；`src/index.js` 的 inbox、会话状态、图片、pi sessions 和日志均落在该实例目录，不再读取默认 Mac 知识路径。控制台所有 Node/WSL 操作、服务脚本的启动前 `runtime-check` 与生成的 systemd 单元都显式设置 `WECOM_BOT_PI_BINARY=/opt/wecom-support-bot/runtime/pi/bin/pi`，不会回退到旧账号 home 下的 pi。

## 4. 本地控制台

双击 `WecomSupportBot-Console.cmd` 打开菜单，也可用命令模式：

```powershell
# 初始化；所有 `instance init` 参数原样支持，真实模型连接测试发生在 WSL 内
.\windows\WecomSupportBot-Console.cmd init --template team --source C:\shared\docs --scope shared --base-url http://<Windows主机IP>:3425/v1 --api-key <key> --model <model>

.\windows\WecomSupportBot-Console.cmd status
.\windows\WecomSupportBot-Console.cmd sync --source C:\shared\docs --scope shared
.\windows\WecomSupportBot-Console.cmd ask --question "退租审批需要几级？" --session-key colleague
.\windows\WecomSupportBot-Console.cmd configure-test --bot-id <测试 botId> --secret <测试 secret>
.\windows\WecomSupportBot-Console.cmd configure-production --bot-id <正式 botId> --secret <正式 secret>
.\windows\WecomSupportBot-Console.cmd start
```

`configure-production` 只保存正式配置，当前通道仍是测试；它不能启动正式服务。控制台隐藏 WSL 路径转换、Node 调用和 systemctl。验收记录、证据、固定问题、对照结果、旧端停用证明、状态包与回滚输出都可直接填写 Windows 路径；控制台统一调用 `wslpath`，并拒绝转换到 `/etc` 等允许数据根之外的结果。菜单与命令模式使用同一转换逻辑，不会把 Windows 原路径混入 WSL 参数。

**模型地址**：`localhost`、`127.0.0.1`、`::1`、`0.0.0.0` 在 Windows 控制台中被拒绝，因为原机器回环地址在 WSL 中不是原模型服务。填写 Windows 主机可被 WSL 路由到的地址或实际 URL。`validate-model-url` 只报告地址检查，从不报告连接成功；真正的四模型连接、知识/Skills、执行审批和示例任务检查仍由 WSL 内的 `instance init` 完成。

`instance sync` 在同一事务里提交 `context/`、资源 manifest（`instance.json` 的 `resources`）、`instance.json`、`data/source-registry.json` 与 `sync-status.json`，并在本次检测到本地改动时把改动前的 `context/` 原子替换到 `snapshots/previous/`（无本地改动不生成快照）；`workspace/`、`data/` 下的会话与收件箱状态、pi sessions 和企微配置保持不动。运行时只读初始化选择的本地副本，不回读原始 Windows 来源。企微进程在启动时构建资源目录；同步完成后，在没有在途任务时使用控制台“重启服务”加载新版本，控制台不会在同步中静默重启正式服务。

## 5. 独立测试机器人验收

先配置与正式 botId 不同的测试机器人，启动测试服务，然后按 `docs/windows-acceptance.md` 完成全部固定项。创建和登记记录：

```bash
node scripts/windows-instance.js acceptance-create --instance-dir /var/lib/wecom-support-bot/instance --output /path/acceptance.json
node scripts/windows-instance.js acceptance-update --record /path/acceptance.json --case wecom-text --status passed --evidence /path/evidence.json
```

所有必需项都必须有真实 `passed` 结果，不允许用 `skipped` 放行。每个主证据和逐场景结果必须是存在且可解析的 JSON，绑定独立测试 botId、实例、资源版本、固定场景、执行状态、文件 SHA-256 与人工复核批准；空路径、占位、未运行、正式 botId、缺场景或登记后篡改都会拒绝。完整 schema 和固定场景 ID 见 `docs/windows-acceptance.md`。

固定问题对比：

```bash
# 迁移前、迁移后分别执行；questions 可使用 docs/windows-migration-questions.json
node scripts/windows-instance.js acceptance-run --instance-dir <实例> --questions <问题.json> --output <结果.json>
node scripts/windows-instance.js acceptance-compare --before <旧结果.json> --after <新结果.json> --output <对照.json>
```

固定清单每题同时校验稳定 ID、正文和正文 SHA-256，换题、同 ID 改正文、漏题或加题均失败。`acceptance-run` 只报告真实 `completed/failed` 执行结果，`acceptance-compare` 只生成 `pending-human-review` 对照；人工核对答案、加载资源和审批后，按验收文档生成带人工批准的 `migration-comparison` 主证据，不能直接把对照文件伪造成通过。比较还会拒绝资源版本或任一角色模型名称变化，防止迁移捆绑模型升级。模型 URL 可因 WSL 网络拓扑改变，但连接必须在各自环境真实验收。

## 6. 正式切换：严格先停旧，再启新

所有命令默认 **dry-run**，不调用服务边界、不写状态。`cutover-new` 与 `rollback-old` 的 dry-run 也会重新读取验收证据、端点停用证明和同一状态包，验证清单及文件哈希、证明与 manifest 的绑定和合并前置条件；它与 execute 的唯一差异是不施加系统变更。正式执行要求各阶段独立 `--execute --confirm <固定短语>`。不要在当前 Mac 开发环境对真实生产执行。

### A. 旧 Mac 最终停用与导出

将已通过的新端验收记录复制到旧 Mac。旧端已是本地实例时：

```bash
node scripts/windows-instance.js cutover-old \
  --instance-dir /path/old-instance \
  --acceptance /path/acceptance.json \
  --output /path/cutover-bundle \
  --plist /path/com.wecom-support-bot.plist
# 核对 dry-run 后才追加：
# --execute --confirm STOP_OLD_PRODUCTION
```

现有默认布局可用 `--legacy --instance-dir /path/wecom-support-bot --legacy-agent-dir /path/to/old-pi-agent`；正式 botId 从旧项目 `config/secrets.json` 读取，pi sessions 从显式选择的旧 agent 目录读取。正式执行顺序：`launchctl unload -w` → `launchctl list` 验证不存在 → pid 锁探活 → 最终状态导出 → 写 `old-stopped.json`。任何失败都不会启用新端。

`--plist` 指向旧端实际加载的 plist（通常是 `~/Library/LaunchAgents/` 下那份）。launchctl 只认 plist 内的 `Label`、不认文件名，所以脚本每次都从传入 plist 读取真实标签，旧 Mac 历史上使用自定义 Label 的 plist 同样适用，不再假定固定标签。dry-run 结果里的 `launchd: { plist, label }` 会公开将要操作的服务，请先核对它与 `launchctl list` 中正在运行的旧端一致；plist 缺失、二进制格式或没有有效 `Label` 时 dry-run 直接失败，不会带着猜测的标签继续。`old-stopped.json` 会记录 `launchdLabel` 供审计。

状态包只含 workspace、`data/inbox.jsonl`、`data/session-state.json` 和明确的 pi 会话文件：`agent/sessions/` 下的嵌套文件，以及 legacy agent 根下直接的 `.jsonl` 会话。根会话保留 `agent/<文件>.jsonl` 相对路径，不会把整棵 agent 目录重映射进 `sessions/`。`models.json`、credentials/auth/token/provider 密钥、`node_modules`、凭证、标准资源、`data/images` 消息接收缓存、日志、锁、Mac launchd 和平台依赖均不进入；导入还会拒绝未登记、路径穿越或禁止的追加文件。

状态收集不是有限文件名放行：workspace 和会话中的每个文本文件都会递归扫描私密钥、常见 token/API Key/secret/password 赋值与令牌样式；`.env.*`、`.npmrc`、`id_rsa`、私钥扩展名等已知敏感文件，以及任何疑似秘密内容，都会让**整个导出或导入失败并只报告文件路径**，绝不静默剔除后生成会丢任务的可回滚包。良性文本报告/原型/JSON 可保留；带有效签名的 PNG/JPEG/GIF/WEBP 必要图片可保留，其他无法安全判断的二进制会明确失败。模型配置、实例 secrets/wecom 配置及 agent models/auth 仍绝不收集。把 `cutover-bundle/state`、`old-stopped.json` 和验收记录安全传到 Windows，可直接向控制台提供 Windows 路径。

### B. Windows 启用正式端

```powershell
.\windows\WecomSupportBot-Console.cmd cutover-new `
  --acceptance /mnt/c/migration/acceptance.json `
  --old-stopped /mnt/c/migration/old-stopped.json `
  --snapshot /mnt/c/migration/state
# 核对 dry-run 后追加：
# --execute --confirm ACTIVATE_NEW_PRODUCTION
```

正式执行会验证验收记录属于当前实例、资源/模型未变化、测试 botId 未变化、旧端停用证明与状态包哈希一致、双方正式 botId 指纹一致。随后停用测试服务，把测试 inbox、图片和 pi 会话归档到 `migration/test-runtime-<批次>/`，再合并旧端最终状态、修复实例属主，才把 active 改为 production 并 `systemctl enable --now`。测试机器人的消息与粘性 Guard 会话不会混入正式会话，归档只用于审计且不自动回灌。

若新端启动或 active 验证失败，脚本立即把新端改回 `active=none` 并 disable，**不自动拉起旧端**。此时是双端安全停止，不是双活；排查后选择重试或走回滚。

## 7. 回滚：带回 Windows 新状态

先在 Windows 停用并导出（先 dry-run）：

```powershell
.\windows\WecomSupportBot-Console.cmd rollback-new --output /mnt/c/migration/rollback
# --execute --confirm STOP_WINDOWS_PRODUCTION
```

再把 `rollback/state` 与 `windows-stopped.json` 传到旧 Mac：

```bash
node scripts/windows-instance.js rollback-old \
  --instance-dir /path/old-instance \
  --windows-stopped /path/windows-stopped.json \
  --snapshot /path/rollback/state \
  --plist /path/com.wecom-support-bot.plist
# legacy 旧布局另加 --legacy --legacy-agent-dir /path/to/old-pi-agent
# --execute --confirm RESTORE_OLD_PRODUCTION
```

旧端在合并前再次确认停用（`launchctl list <Label>` → `unload -w` → `list`，`Label` 同样取自 `--plist`），验证 Windows 停用证明和状态包哈希后才恢复 launchd。恢复失败会按同一 plist 重新 `unload -w` 并经 `launchctl list <Label>` 确认：确认旧端已停才报告“已保持双端停止”；若旧端仍未能停止，会如实报错并给出手动 `launchctl unload -w <plist>` 与 `launchctl list <Label>` 命令：Windows 端此时已停用、不会形成双活，但旧端服务可能仍在运行，必须按提示手动处理并确认后再决定重试或保持停止。

合并规则：inbox 按记录时间合并且保留状态更新，重复行去重，同 msgid 不同正文直接失败；会话代号取较大值、粘性 Guard 标记求并集、活动取最新；pi JSONL 会话按行去重追加；workspace 其他同名不同内容不覆盖，来源版本保存到 `migration-conflicts/<批次>/` 并公开冲突清单。任务、消息和会话不会因简单覆盖而静默丢失。

## 8. 当前验证边界（必须随交付阅读）

本仓库当前只有 macOS，以下与真实平台相关的项目**未实机验收**，不得由静态检查或 dry-run 推断为通过：

- 真实 Windows UAC、DISM 首次启用、Windows 重启与 `-Resume`、WSL2 发行版安装和 `wsl --shutdown`。
- WSL2 内 systemd PID 1、Node/pi/Python 实际下载安装、systemd 常驻与 SIGTERM drain。
- Windows 主机模型地址的 WSL 路由、真实四模型连接及模型能力。
- 独立测试机器人的企微文本、图片、长任务、断线恢复、最终投递全链路。
- 正式 botId 跨 Mac/Windows 的实际停用、切换、回滚与双活防护。

Mac 上可验证的是公开 CLI/安装 dry-run、标准包布局与哈希、Linux 路径拒绝、bash 语法、假 systemctl/launchctl 的实际命令顺序与环境、systemd 单元语义、无秘密状态导出/合并/回滚、结构化验收门禁和失败安全停止。Mac 上构造的有效验收 fixture 只证明门禁能识别有效结构，不是 Windows 验收结果。PowerShell 若本机无 `pwsh`，标准包 `-PlanOnly`、控制台假 WSL 和语法解析测试都会明确报告 skipped，不能写成通过；真实执行同样列为未验收。

# AGENTS.md

本仓库是企业微信技术支持 Agent 框架：把用户选定的上下文、Wiki、Skills、代码与只读数据入口复制成实例的标准资源副本，由隔离的 pi 进程在这些副本上回答同事提问。仓库本身不含任何人的知识库、凭证或运行数据。

## 谁执行安装

安装由用户自己的编码 Agent 执行。Mac / Linux 上，用户把仓库交给你（ZCode、Codex、Claude Code 或其他编码 Agent），你按 `docs/agents/initialization.md` 的协议工作：先跑 `npm run setup -- --check` 把 Node / 依赖 / pi / python3 / zip / unzip 的真实结果给用户看，用户明确同意后才跑 `npm run setup -- --allow-install`；然后盘点用户上下文、给出可解释的推荐、逐项取得用户对来源 / 共享范围 / 同步频率的选择，再初始化、配置同步计划并完成验收。Windows 上，`windows/` 的安装器与 `windows/console.ps1` 控制台负责 WSL2 安装与运行入口，控制台提供同一套 `init` / `sync` / `status` / `ask` 菜单；协议、安装与回滚细节见 `docs/windows-wsl2.md`。

## 硬性规则

1. **只报告真实执行结果。** 跑过的命令给出输出与退出状态；没跑的写 `skipped`，失败的写 `failed`，不把推测、示例或计划的输出写进交付表。
2. **由用户逐项决定来源、共享范围与同步频率。** 你负责给出推荐和理由，不替用户做选择；团队实例只能使用 `shared` 来源。
3. **复制来源时跳过凭证与运行配置。** 默认排除 `.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*`、`*credential*`、`secrets.json`、`models.json`、`wecom.json`、`.npmrc`、`.netrc`；软链目标命中的敏感文件同样排除。复制结果用 `excludedSensitive` 列出最多 20 个文件名与总数，只报名字、不读内容。只有用户明确要求把凭证随私有副本一起放时，才可用 `--include-secrets`（仅 `private`；`shared` 直接报错），结果必须标 `secretsIncluded` 并用 `secretFiles` 列出文件名；团队包导出发现敏感文件时拒绝，不静默剔除。
4. **只写实例目录。** 用户的知识源、代码仓库与主工作区是只读来源；同步是单向的，副本里的本地修改只报告，不反向写回来源。
5. **同一个 botId 只运行一个进程。** 第二个长连接会踢掉第一个。
6. **正式切换与系统级变更先取得用户明确同意。** 切换正式 botId、安装系统定时任务、重启生产服务默认停在 dry-run；用户确认后才执行，定时任务安装还必须显式加 `--yes`。
7. **验收以真实检查为准。** `instance init` 与 `instance status` 报什么就写什么；未配置 BI 时把查数验收写成 `skipped`，不声称已通过。

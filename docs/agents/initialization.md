# 实例初始化协议（给编码 Agent）

本文件是本仓库的安装协议。执行者是用户自己的编码 Agent（ZCode、Codex、Claude Code 等），不是仓库内的向导。按步骤执行，每一步都有完成判据；没跑或跑失败的检查，在最终交付表里如实写 `skipped` 或 `failed`。

开始前先读根 `AGENTS.md` 的硬性规则。所有命令都在仓库根目录执行。

---

## 步骤 0：安装前检查

先只做检查，不安装任何东西：

```bash
npm run setup -- --check
```

输出固定是 JSON，每一项都是 `{status, version, action, note}`，`status` 取值 `ok` / `installed` / `missing` / `error`；顶层 `readyToInit` 表示 Node、依赖与 pi 是否已经满足初始化条件。把这份结果原样给用户看，重点说明：

- `node`：必须满足 `package.json` 的 `engines.node`（`>= 22.19.0`）。不满足时 setup 直接失败，并在 `action` 里给出升级命令（`brew install node@22` 或 `nvm install 22 && nvm use 22`）。
- `dependencies`：缺少 `node_modules/@wecom/aibot-node-sdk` 时显示 `missing`，`action` 是 `npm install`。
- `pi`：依次检查环境变量 `WECOM_BOT_PI_BINARY` 与 `~/.pi-support/bin/pi`；缺失时显示 `missing`，`action` 是 `bash scripts/install-pi.sh`。
- `tools.python3` / `tools.zip` / `tools.unzip`：缺失只报告，不自动安装系统包，并在 `note` 说明受影响能力（BI 查数 / 资源包导入导出）。

**用户明确同意安装后**，再执行：

```bash
npm run setup -- --allow-install
```

`--allow-install` 才会对缺失项真实执行 `npm install` 和/或 `bash scripts/install-pi.sh`；安装后会重新检查并验证 `pi --version` 可执行，验证失败即返回 `error`、`readyToInit: false` 并非零退出。没有 `--allow-install` 时 setup 只报告缺失并提示需要用户同意，不会安装任何东西；`--check` 与 `--allow-install` 同时出现时仍只检查。

**完成判据**：把 `--check` 的真实 JSON 交给用户；用户同意后跑 `--allow-install`，直到 `readyToInit` 为 `true`（node、dependencies、pi 都为 `ok` 或 `installed`），或明确记录每项 `missing` / `error` 与用户选择。不得用假 pi、跳过检查或假装安装成功继续。python3 / zip / unzip 的缺失要如实写入交付表。

---

## 步骤 1：盘点用户上下文（只读）

先问用户有哪些候选来源（知识库、Wiki、Skills、代码仓库、历史/项目资料），然后逐个运行：

```bash
npm run instance -- inventory \
  --root /absolute/path/to/source-1 \
  --root /absolute/path/to/source-2 \
  --max-depth 8 \
  --exclude "docs/private/**" \
  --symlinks follow
```

`--root` 可重复；`--max-depth` 可选，默认不限深度。**`--max-depth` 不只用来看统计**：更深层的 `SKILL.md`、`wiki`、`.git` 等特征看不到时，`kind`、`files` 与推荐都会随之改变；不要把浅层结果当成完整盘点。`--exclude` 与 `--symlinks follow|skip|reject` 与 `init` / `sync` / `plan` 使用同一套规则，因此盘点得到的 `files` / `bytes` 就是实际将复制的量。含内嵌 userinfo 的 `--root` 会直接报错（与复制阶段共用同一检测），错误信息与 JSON 都不回显凭证。

输出是 JSON，`candidates[]` 每个来源包含：

| 字段 | 含义 |
|---|---|
| `name` / `path` / `type` | 来源名、绝对路径、`directory` / `file` / `missing` |
| `kind` / `kinds` / `kindNote` | 主分类与全部命中分类；多个特征时为 `mixed` 并附注 |
| `totalFiles` / `files` / `bytes` | `totalFiles` 是排除前的扫描总量；`files` / `bytes` 是实际会复制的文件数与体积（已按 `--exclude`、`--symlinks`、敏感规则扣除） |
| `skills` / `skillNames` | `SKILL.md` 数量与 frontmatter 名称 |
| `resourceTypes` | `metrics` / `sql` / `tables` / `concepts` / `raw` / `experience` / `playbook` / `timeline` / `records` / `projects` 的文件数 |
| `sensitive.files` / `sensitive.count` | 命中的敏感文件名与数量；只报名字，不读内容 |
| `symlinks.count` / `followed` / `skipped` / `followedOutsideRoot` / `broken` / `loops` | 软链总数、按策略跟随与跳过的数量、指向来源根之外的数量、悬空数量、检测到的环 |
| `lastModified` / `blockers` | 最近修改时间、扫描受阻原因 |
| `recommended` | `include`、`scope`、`cadence`、`symlinks`、`reason` |

分类规则：含 `SKILL.md` → `skills`；含 `metrics`/`queries`/`tables` → `knowledge-db`；含 `wiki`/`raw`/`概念` → `knowledge`；含 `.git` 且有 `package.json`/`pom.xml` → `code`；含 `时间线`/`决策`/`收件箱`/`projects` → `history`；单文件来源为 `file`。同时命中多个特征时 `kind` 为 `mixed`，`kinds` 按上述顺序列出全部特征，推荐结合 `kinds` 判断。

**完成判据**：每个候选来源都跑过 `inventory`，把上面的字段整理成表给用户看。`missing` 或带 `blockers` 的来源要明确指出。不得凭目录名猜测内容、体积或敏感文件。

---

## 步骤 2：给出推荐（逐来源、可解释）

对每个来源，向用户复述 `inventory` 的真实结论，再按以下规则给建议。规则是确定的，理由必须一起说：

| 情况 | 建议 |
|---|---|
| 有敏感文件 | `include` 按 `files` 判断；说明“排除 N 个敏感文件后仍可同步 M 个文件”，或“排除后没有可同步文件” |
| 有软链 | 说明数量与根外数量：`shared` 来源会拒绝指向来源根之外的软链；`private` 来源会跟随并计数 |
| 有根外软链 | 推荐 `scope: private` + `symlinks: follow`；若用户坚持 `shared`，必须同时建议 `--symlinks skip`（跳过全部软链），不能推荐 `shared + follow` |
| 纯代码仓库（`kind: code`） | `include: true`，`scope: private`、每周一次；只有用户明确同意才按 `shared` |
| 知识 / 知识库 / Skills | 建议 `shared`、每天一次；是否共享仍由用户决定 |
| 历史 / 项目资料 | 建议 `shared`、每周一次 |
| 单文件来源 | 建议 `manual`，避免频繁覆盖 |
| 体积 > 500MB 或文件数 > 50000 | 提示完整同步耗时，建议降低频率 |
| `mixed` | 按 `kinds` 逐项说明（例如同时含代码与知识时，默认仍建议私有 + 每周）；不要只复述主分类 |
| `missing` 或没有可复制文件 | `include: false`，说明原因 |

**必须把 `inventory` 里的敏感文件与软链结论如实告诉用户**，包括文件名、数量、根外软链数量、悬空软链与环；不能只说“已处理”。敏感文件与软链目标命中项都只报名字，不读内容。

**完成判据**：每个来源都有一句“建议 / 理由 / 风险”，用户能据此做选择。

---

## 步骤 3：逐项取得用户选择

对每个来源逐项确认，不能合并成一句“都按默认”：

1. 是否同步（include / 跳过）。
2. 共享范围：`shared` 或 `private`。**团队实例只能 `shared`**；个人私有资料不要放进团队实例。
3. 同步频率：`manual` / `hourly` / `daily` / `weekly` / 自定义间隔；`daily` 和间隔都可叠加“仅工作日”等 `weekdays` 限制（例如工作日每两小时）。

**完成判据**：用户对每个来源明确回答了以上三项，且回答被记录进交付表。用户没答的项保持未决定，不使用你的推荐代替。

---

## 步骤 4：模型配置（四个角色）

向用户收集四个角色的连接信息：

| 角色 | 用途 | CLI 选项 |
|---|---|---|
| 主模型 | 回答与任务执行 | `--base-url` / `--api-key` / `--model` |
| 快速模型 | 分级路由与轻量判断 | `--quick-base-url` / `--quick-api-key` / `--quick-model` |
| 执行审批模型 | 写操作前审批 | `--approval-base-url` / `--approval-api-key` / `--approval-model` |
| Guard 模型 | 输出隐私校验 | `--guard-base-url` / `--guard-api-key` / `--guard-model` |

未单独提供时，`init` 会让 quick / approval / guard 复用主模型的地址、凭证与名称；复用关系要告诉用户。

连接测试由 `instance init` 真实执行（每个角色一次 `chat/completions`，10 秒超时），不是 dry-run。**不要在 `init` 之前声称“模型已连通”**。

**完成判据**：四个角色的地址、凭证、模型名都已有来源（独立提供或明确复用主模型）。真实连接结果以 `init` 输出为准；失败的写 `failed`。

---

## 步骤 5：初始化实例

```bash
npm run instance -- init \
  --instance-dir /absolute/path/to/instance \
  --template team \
  --source /absolute/path/to/source-1 --scope shared \
  --source /absolute/path/to/source-2 --scope shared \
  --base-url https://model.example/v1 \
  --api-key <凭证> \
  --model <主模型> \
  --quick-model <快速模型> \
  --approval-model <执行审批模型> \
  --guard-model <Guard 模型>
```

- `--template team`：团队实例，只接受 `shared` 来源；需要私有来源时改用 `--template blank` 或不写模板。上例两个来源都必须是 `shared`。
- 既有实例导入：`--template import --package <zip>`，只需新的模型凭证。
- 来源支持目录、单文件 `.zip` 资源包与 `--source-type gitlab --ref <分支>` 的仓库。含内嵌 userinfo 的 URL（例如 `https://user:<凭证>@host/repo.git`）会被直接拒绝，请改用无凭据地址或 SSH agent；`--ref` 会写进实例内的 `data/source-registry.json`，定时同步按该分支克隆。
- **来源名必须唯一**：来源名默认取路径或资源包 basename。`init` / `sync` / `plan` 遇到同名不同路径会直接报错并列出冲突的两个真实路径，要求改名或合并后再登记；`sync-due` 发现重复名称同样 fail-closed，不会只保留最后一条。
- **登记期复制选项**：`--exclude <glob>` / `--clear-excludes` / `--symlinks follow|skip|reject` 与 `plan` 同义（`--exclude` 与 `--clear-excludes` 互斥），逐来源跟在对应 `--source` 之后；登记时写入 `data/source-registry.json`，首次补齐同步计划时沿用，之后修改以 `plan` 为准。

初始化时的复制边界：

- **默认排除**：`.git/`、`node_modules/`、`.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*`、`*credential*`、`secrets.json`、`models.json`、`wecom.json`、`.npmrc`、`.netrc`、`__pycache__/`、`.DS_Store`。
- **凭证例外**：默认排除始终生效。只有用户明确要求把凭证随私有副本一起放时，才可对 `private` 来源加 `--include-secrets`；`shared` 来源加该选项会直接报错。只要来源用了该选项就标 `secretsIncluded: true`，被包含的文件列入 `secretFiles`（没有命中任何凭证文件时为空数组）；导出团队包时只要发现敏感文件就报错拒绝，不会静默剔除。
- **软链**：默认 `follow`。过滤与敏感检测作用于软链的最终真实目标；`shared` 来源中指向来源根之外的软链会被拒绝（防止把根外私人文件带进团队副本），根内软链复制内容并防环；`private` 来源可跟随根外软链并计数。`skip` 跳过并计数，`reject` 直接报错。资源包中的软链只能指向包内；单文件来源也走同一策略。
- 复制结果写进 `instance.json` 的 `contextSources[].symlinks`（`followed`、`skipped`、`followedOutsideRoot`、`blockedOutsideRoot`、`broken`）、`excluded`（被排除的文件/目录/敏感目标数）与 `excludedSensitive`（`files` 最多 20 个敏感文件名 + `total` 总数）；`init` / `sync` / `sync-due` 输出与 `status` 都展示这些字段，编码 Agent 要如实汇报。`--include-secrets` 时另标 `secretsIncluded: true` 并列出全部 `secretFiles`（无命中时为空数组）。

`init` 会真实执行：四模型连接、来源可读性、知识/Skills 的真实 pi 读取、执行审批链（workspace 写入获批 + 越界写入被硬规则拒绝）以及与 `ask` 相同的示例任务。

**完成判据**：输出 `ready: true`，且 `checks` 里 `mainModel`、`quickModel`、`approvalModel`、`guardModel`、`context`、`executionApproval`、`exampleTask` 都是 `ok`，`knowledge` / `skills` 不是 `error`。`ready: false` 时停止，逐项列出 `error` / `skipped` 及原因；不得启动企微服务，也不得把失败项写成通过。

---

## 步骤 6：逐来源配置同步计划

```bash
npm run instance -- plan \
  --instance-dir /absolute/path/to/instance \
  --source /absolute/path/to/source-1 \
  --scope shared \
  --cadence daily --at 09:00

npm run instance -- plan \
  --instance-dir /absolute/path/to/instance \
  --source /absolute/path/to/source-2 \
  --scope shared \
  --cadence weekly --weekdays 1-5 --at 08:30 \
  --exclude "docs/private/**"

# 查看当前计划与每个来源的下次到期时间
npm run instance -- plan --instance-dir /absolute/path/to/instance
```

这里的实例来自步骤 5 的 `--template team`：团队实例只允许 `shared`，对私有来源执行 `plan --scope private` 会直接报错。确实需要 `private` 来源时，用 `--template blank`（或不写模板）另建实例再规划，不要把私有资料放进团队实例。

`--source` 必须与实例内 `data/source-registry.json` 已登记的原始路径在 **realpath 上完全一致**；只按 basename 同名不算同一个来源。未登记、同名但路径不同、指向实例内 `context/` / `workspace/` / `data/` 副本都会直接报错并列出已登记候选。同一实例内来源名必须唯一：`plan` 遇到重复名称同样报错，不会在两条同名来源之间猜。首次运行 `plan` 会自动为所有 `contextSources` 补齐条目（`enabled: true`、`cadence: manual`），并沿用 registry 里登记的 `exclude` / `symlinks`，所以未逐项配置的来源也不会在同步时被删掉。原始路径、类型、`--ref` 与登记期复制选项只保存在 `data/source-registry.json`（mode 0600），`instance.json` 的 `syncPlan` 条目只保存 `name`、`scope`、`cadence`、`exclude`、`symlinks`、`enabled` 与 `lastRunAt` / `lastStatus` / `lastVersion`，不保存任何原始路径，也不进入团队包。registry 与 `context/`、`instance.json`、`sync-status.json` 在同一事务提交，任一步失败全部回滚。含内嵌 userinfo 的 URL 在登记前就被拒绝，不会写入任何文件。

GitLab 来源的 `--ref` 只保存在 `data/source-registry.json`，`sync-due` 按该分支克隆；`status` 的 `coverage.sources[].ref` 会展示它，`instance.json` 的 `contextSources` 不再复制该字段。`plan` 本身不保存地址、类型或 `--ref`；需要改分支时，用完整的手动同步重新登记：

```bash
npm run instance -- sync --instance-dir <dir> \
  --source <仓库地址> --source-type gitlab --scope shared --ref <分支>
```

频率写法：

| 用户说法 | 参数 |
|---|---|
| 手动，不同步 | `--cadence manual` |
| 每小时 | `--cadence hourly`（等价 `every 60`） |
| 每 N 分钟 | `--cadence every --every-minutes N` |
| 每天某个时刻 | `--cadence daily --at HH:MM` |
| 每周某几天 | `--cadence weekly --weekdays 1-5 --at HH:MM`（1=周一，7=周日） |
| 工作日每两小时 | `--cadence every --every-minutes 120 --weekdays 1-5` |
| 工作日每天某个时刻 | `--cadence daily --weekdays 1-5 --at HH:MM` |

`--include-secrets` 是逐来源的凭证选项：只允许 `private`，`shared` 加它会报错；计划会把该来源的凭证设置写进 `contextSources[].includeSecrets`，之后 `sync-due` 按同一设置复制。默认不要打开，除非用户明确要求把凭证随私有副本一起放。

`weekdays` 对 `every`、`daily`、`weekly` 都生效，非允许日不会到期；`every` + `weekdays` 仍按“上次成功同步 + 间隔”判断，只是周末不触发。`daily` / `weekly` 省略 `--at` 时默认 `09:00`，`weekly` 省略 `--weekdays` 时默认周一；**向用户确认时间，不要默认**。`--at`、`--weekday`、`--weekdays`、`--every-minutes` 不能脱离 `--cadence` 单独使用。

**频率只决定“何时触发一次同步”，不是增量同步。** 每次 `sync-due` 都按到期集合重建：到期来源从原始路径重新复制；未到期但已有 `context/<slot>-<name>` 副本的来源沿用该副本（硬链接，不读原始来源，结果里 `carried: true`，`lastRunAt` / `lastStatus` 保持原值）；未到期却没有现成副本的来源回退为从原始来源复制，不会丢内容。未登记来源按 manual 处理、永不到期，因此一般走沿用；手动 `sync` 不沿用，始终按给定来源全部重新复制。只有显式 `--disable` 的来源会在下一次同步时移除副本，`removed` 会列出被移除的来源。

每次提交前，只有本次检测到本地改动（`localModifications.count > 0`）时，当前 `context/` 才会暂存到 `<instance>/snapshots/previous.next/`；只有 `context/`、`instance.json`、`data/source-registry.json` 与 `sync-status.json` 全部提交成功，才把它原子替换成 `snapshots/previous/`（只保留最近一版）。没有本地改动时 `snapshotPath` 为 `null`，不生成快照，已有的 `snapshots/previous` 也保持不动——快照的唯一用途是“覆盖前留住本地改动”。因此无改动时 `snapshotPath` 为 null，但磁盘上可能还留着更早一次生成的 `snapshots/previous`，它不代表本次同步生成了快照。提交失败时删除 `previous.next`，原来的 `previous` 保持不动。同步同时用上次的 `resources.files` / `fileHashes` 与当前副本比对，输出 `previousVersion`、`snapshotPath` 与 `localModifications {added, modified, removed, sample}`（计数与前 10 条样例）；沿用来源在无本地改动时复用上次的文件哈希（不再重读该来源），检测到本地改动时整体重算，两种情况下都参与全局 `version`。硬链接不被文件系统支持时（例如跨设备）回退为逐文件复制，行为一致，只是多一次写入。本地修改只报告、不阻塞标准版本覆盖；快照暂存失败会中止本次同步，不会默默丢掉上一版。

**完成判据**：每个来源都有 `cadence`、`nextDueAt` 和 `lastStatus`。用户已逐项确认频率。

---

## 步骤 7：数据能力（可选）

用户需要查生产数据时，显式登记对应业务线的只读 BI 入口：

```bash
npm run instance -- configure-bi \
  --instance-dir /absolute/path/to/instance \
  --business lzz \
  --script /absolute/path/to/知识库/数据库/lzz-db-wiki/scripts/bi_query.py
```

`--business` 只支持 `ajly` / `lzz`；脚本必须是该业务线默认目录中的真实 `bi_query.py`。未配置时真实查数会明确提示缺少配置。

### 为什么 BI 不需要复制 `.env`

可信 BI 脚本按**原路径就地执行**：`configure-bi` 只登记 `bi_query.py` 的真实路径，机器人执行它时，脚本仍在自己原来的目录里，读取它旁边的 `.env` / 配置文件取得数据库凭证。凭证从头到尾没有进入实例副本，AI 只能“执行这个脚本”，不能读脚本目录里的其他文件，也读不到凭证。

如果把 `.env` 一起复制进副本，会同时发生三件事：

- 实例里的 AI 可以读到凭证（标准副本本来就是给 AI 读的资源）；
- 凭证会进入 `context/`，也就可能进入快照和后续同步覆盖；
- 任何团队包导出都必须拒绝包含敏感文件的副本并报错，而不是悄悄删掉。

两种选择及后果：

| 选择 | 做法 | 后果 |
|---|---|---|
| 推荐（默认） | 不复制 `.env`，只用 `configure-bi` 登记原路径 | 凭证不进副本、AI 读不到、不会被快照或打包；BI 仍可正常查数 |
| 明确要求 | `private` 来源加 `--include-secrets` | 凭证进入私有副本，实例 AI 可读；结果标 `secretsIncluded: true` 并列出 `secretFiles`；`shared` 来源永远不允许该选项，团队包导出仍拒绝敏感文件 |

所以默认策略是：**BI 不复制 `.env`，凭证留在脚本原目录。** 只有用户明确要求“把凭证随私有副本一起放”时，才切换到第二种选择。

**完成判据**：用户需要查数时返回 `status: ok`；不需要时在交付表里写 `skipped`（未配置 BI），不得声称查数已验收。

---

## 步骤 8：定时同步

先 dry-run，展示将要生成的单元和命令：

```bash
npm run instance -- schedule \
  --instance-dir /absolute/path/to/instance \
  --tick-minutes 15
```

- macOS：生成 `~/Library/LaunchAgents/com.wecom-support-bot.sync.<instanceId前8>.plist`，`StartInterval = tick × 60` 秒，`RunAtLoad = false`，日志写 `<instance>/logs/sync.log`。
- Linux：生成 `~/.config/systemd/user/com.wecom-support-bot.sync.<instanceId前8>.service` 与 `.timer`，`OnBootSec=1min`、`OnActiveSec=1min`、`OnUnitActiveSec=<tick>min`、`Persistent=true`，全新安装后即生效。
- 调度器每隔 `tick` 分钟运行一次 `sync-due`；`sync-due` 再按每个来源的 `cadence` 判断是否到期。到期时做一次事务同步：到期来源重新复制，未到期且有副本的来源硬链接沿用，未到期且缺副本的来源回退复制。
- 有锁 `data/sync.lock` 防止重叠执行；拿不到锁的进程直接返回 `locked: true`，不排队。

**不可跳过的同意步骤**：`schedule` 默认就是 dry-run。必须先把 dry-run 输出的单元路径与系统命令完整展示给用户，取得明确同意后才能安装或卸载；`--install` 与 `--uninstall` 都必须显式加 `--yes`，缺少 `--yes` 时命令会打印将要写入的文件与将要执行的系统命令，并以非零状态退出，明确提示“需要用户明确同意后加 --yes”。

```bash
# 1) 展示 dry-run（默认行为）
npm run instance -- schedule --instance-dir /absolute/path/to/instance --tick-minutes 15

# 2) 用户明确同意后，才执行
npm run instance -- schedule --instance-dir /absolute/path/to/instance --install --yes
npm run instance -- schedule --instance-dir /absolute/path/to/instance --uninstall --yes
```

`--install --yes` 才会写单元文件并调用 `launchctl bootstrap`（macOS）或 `systemctl --user enable --now`（Linux）。未经同意不得安装系统定时任务，也不得借安装动作重启生产服务。

**完成判据**：用户已看到 dry-run 的单元路径与命令，并明确同意安装或明确选择暂不安装。安装则记录命令结果；暂不安装写 `skipped`。

---

## 步骤 9：验收

逐项真实执行，不许只看配置文件：

1. **初始化检查**：重看 `init` 输出的 `checks`。`error` / `skipped` 逐项列出原因。
2. **实例状态**：`npm run instance -- status --instance-dir <dir>`。检查 `ready`、`resources.consistent`、`loadFailures` 为空、`syncPlan.nextSyncAt`，以及每个来源的 `lastRunAt` / `lastSyncStatus`；同时核对每个来源的 `excludedSensitive`（文件名与总数）与 `ref`，以及顶层的 `previousVersion`、`snapshotPath`。本地改动分两个字段看：`localModifications` 是当前副本相对已同步基线的实时漂移，`lastSyncLocalModifications` 是上一次同步当时的报告（与 `sync-status.json` 一致）；同步完成后实时 `localModifications` 归零（沿用来源若被本地改过，其内容会被带入新基线并整体重算哈希，因此同样归零），`lastSyncLocalModifications` 保留被覆盖前的计数。验收时要分别核对，不能把二者当成同一个数。
3. **概念问答**：用 `instance ask` 问一个该来源能回答的业务概念题，记录真实回答；回答不出或资料不足也要如实记录。
4. **查数问答**：配置了 BI 才执行；未配置写 `skipped`。
5. **workspace 产物与审批拒绝**：以 `init` 的 `executionApproval` 检查为证据（获批的 workspace 写入 + 越界写入被硬规则拒绝）。该项失败或未执行时，验收写 `failed` / `skipped`。
6. **定时同步**：dry-run 内容与 `syncPlan` 对照；已安装则跑一次 `sync-due` 或等待 tick，确认 `lastStatus`、`nextDueAt` 更新。有本地改动时检查本次同步的 `snapshotPath` 下确有上一版内容；没有本地改动时 `snapshotPath` 为 `null`、`snapshots/previous` 保持原样。未到期来源应显示 `carried: true`，且原始来源被移动或删除也不影响同步。

```bash
npm run instance -- ask \
  --instance-dir /absolute/path/to/instance \
  --question "退租审批需要几级？" \
  --session-key <同事标识>
```

**完成判据**：六项都有“结果 + 证据”；未执行项明确标 `skipped`，失败项标 `failed`，不以“应该可以”代替。

---

## 步骤 10：交付表

把结果整理成表交给用户，至少包含：

| 项目 | 结果 | 证据 / 位置 | 未完成原因 |
|---|---|---|---|
| 同步了哪些来源 | 来源名 + `shared`/`private` | `instance.json` 的 `contextSources` | |
| 放在哪 | 实例目录与 `context/` | `instanceDir` | |
| 下次同步 | 每个来源的 `nextDueAt` | `plan` / `status` 输出 | |
| 如何修改 | `plan` 命令与参数 | 本文件步骤 6 | |
| 模型检查 | `ok` / `failed` / `skipped` | `init` 的 `checks` | |
| BI | `ok` / `skipped` | 步骤 7 输出 | |
| 定时任务 | 已安装 / `skipped` | 单元路径与命令输出 | |
| 上一版快照与本地修改 | `snapshotPath`（无本地改动时为 `null`）、`lastSyncLocalModifications` 计数、实时 `localModifications` | `sync-status.json` / `status` | |
| 验收问答 | 真实回答摘要 | `ask` 输出 | |
| 敏感文件与软链 | 数量、文件名、根外软链 | `inventory` / `status` | |

**完成判据**：表里每一行都有真实结果；`skipped` 与 `failed` 都写明原因；没有把推荐、计划或示例输出当成执行结果。

---

## Windows / WSL2

协议完全相同，只有调度器实现不同：

- 在 WSL2 的 Linux 原生文件系统中运行同一组 `npm run instance -- ...` 命令。
- `schedule` 在 WSL2 内生成 systemd user service + timer（`--platform linux`），不使用 macOS launchd。
- 路径使用 WSL 内路径；原机器的 `localhost` 不可直接沿用。
- 安装包构建、控制台、正式切换与回滚见 `docs/windows-wsl2.md` 与 `docs/windows-acceptance.md`。

**完成判据**：与 macOS 相同；定时任务部分按 systemd 单元核对，并在交付表写明平台。

---

## 附录 A：频率语义

- 使用本地时间。`daily` 的到期点是当天 `HH:MM`；`weekly` 是每个选中星期的 `HH:MM`。
- `weekdays` 对 `every`、`daily`、`weekly` 生效；非允许日一律不 due。`every` + `weekdays` 的间隔从上一次成功同步起算，周末只是不触发。
- 从未运行过的来源在允许日立即到期（`manual` 与非允许日除外）。
- `every` 按上次成功同步时间加间隔判断；上次失败不会推进 `lastRunAt`，下一次 tick 会重试。
- 同步失败时 `lastStatus = error`，`lastRunAt` 保持不变。
- 上次同步之后没有到下一个到期点，`sync-due` 返回 `{ ran: false }`，不写任何文件。

## 附录 B：排除规则（glob）

- 无斜杠的规则按 basename 匹配任意层级，例如 `*.pem`、`secrets.json`、`node_modules`。
- 带斜杠的规则按**相对来源根**的路径匹配，例如 `docs/private/**`。
- **路径过滤作用于软链的最终真实目标**（realpath 之后），不是软链自身名字；根外目标只能按目标 basename 匹配。
- 结尾斜杠只匹配目录，目录命中后整棵子树跳过。
- `**` 跨目录，`*` 不跨目录，`?` 匹配单个非斜杠字符。
- 默认排除始终生效；`--exclude` 是追加规则，不会取消默认排除；`--clear-excludes` 清空自定义追加规则。
- `--include-secrets`（仅 `private`）只摘下 `.env`、`*.pem`、`*.key`、`secrets.json` 等凭证类默认排除；`node_modules/`、`.git/`、自定义 `--exclude` 等其余规则仍生效。

## 附录 C：敏感文件与软链

- 敏感文件名：`.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*`、`*credential*`、`secrets.json`、`models.json`、`wecom.json`、`.npmrc`、`.netrc`。只报告名字与数量，不读取内容，也不复制。
- 软链指向敏感文件（例如 `notes.md -> .env`）时，按最终目标识别并排除，计入 `excluded.sensitive`；单文件来源同样受限。
- `inventory` 的 `files` / `bytes` 是实际会复制的数量（已按 `--exclude`、`--symlinks` 与敏感规则扣除）；`totalFiles` 是排除前的扫描总量，敏感文件单独列在 `sensitive`。
- 复制结果的 `excludedSensitive` 列出最多 20 个被排除的敏感文件名与 `total` 总数；`status` 的每个来源同样输出该字段。
- `follow`（默认）：复制软链目标内容并防环；`shared` 来源与资源包拒绝根外目标；`private` 来源跟随根外目标并计入 `followedOutsideRoot`。
- `skip`：跳过并计入 `skipped`。`reject`：遇到软链直接报错。
- 单文件来源如果是软链，也按同一策略处理：解析真实目标、检查敏感文件名与根外目标，`shared` 拒绝根外目标。
- `--include-secrets` 只允许 `private`：凭证会被复制并在结果中列名、标 `secretsIncluded: true`，实例里的 AI 因此可读；`shared` 和团队包导出仍拒绝凭证文件。

## 附录 D：常用命令

```bash
npm run setup -- --check
npm run setup -- --allow-install
npm run instance -- inventory --root <dir> [--root <dir>]... [--max-depth N] [--exclude <glob>]... [--symlinks follow|skip|reject]
npm run instance -- init --instance-dir <dir> [--template team|blank|import] [来源与模型选项] [--exclude <glob>]... [--clear-excludes] [--symlinks follow|skip|reject] [--include-secrets]
npm run instance -- plan --instance-dir <dir>
npm run instance -- plan --instance-dir <dir> --source <原始路径> [--scope shared|private] [--cadence manual|every|hourly|daily|weekly] [--every-minutes N] [--at HH:MM] [--weekday N|--weekdays 1-5] [--exclude <glob>]... [--clear-excludes] [--symlinks follow|skip|reject] [--include-secrets] [--enable|--disable]
npm run instance -- sync-due --instance-dir <dir> [--now ISO8601] [--dry-run]
npm run instance -- schedule --instance-dir <dir> [--tick-minutes N] [--platform darwin|linux] [--home <dir>] [--dry-run] [--install --yes|--uninstall --yes]
npm run instance -- sync --instance-dir <dir> --source <路径> --scope <shared|private> [--exclude <glob>]... [--clear-excludes] [--symlinks follow|skip|reject] [--include-secrets]
npm run instance -- status --instance-dir <dir>
npm run instance -- configure-bi --instance-dir <dir> --business ajly|lzz --script <绝对路径>
npm run instance -- ask --instance-dir <dir> --question <问题> --session-key <标识>
npm run instance -- export --instance-dir <dir> --output <zip>
```

`init` / `sync`（逐来源，跟在对应 `--source` 之后）与 `plan` 使用同一组 `--exclude` / `--clear-excludes` / `--symlinks` 语义，所以盘点得到的 `files` / `bytes` 就是实际将复制的量。`inventory` 接受同一套 `--exclude` / `--symlinks`，但它只是只读盘点、没有持久化状态，因此不提供 `--clear-excludes`。`schedule` 的 `--dry-run` 与默认行为完全等价（不指定 `--install` / `--uninstall` 时本来就只生成、不落盘），保留它是为了让显式意图可读。

`sync` 是手动同步：只复制本次 `--source` 指定的来源（逐个列出全部来源即为全量），并且始终从原始来源重新复制、不沿用副本；`sync-due` 是定时计划入口，只从原始来源复制作到期来源，未到期且已有副本的来源沿用实例内副本。两者共用同一条暂存、校验、快照与事务提交管线，只在同一事务里更新 `context/` 标准副本、`instance.json`、`data/source-registry.json`、`sync-status.json` 与 `snapshots/previous/`（有本地改动才生成快照），不碰 `workspace/`、会话状态或收件箱。手动 `sync` 不更新计划里的 `lastRunAt`，下一次 tick 仍按原计划判断是否到期；`sync-due` 也不推进沿用来源的 `lastRunAt` / `lastStatus`，只推进真正到期或回退复制的来源。`sync` 结果里的 `notIncluded` 列出计划中应同步、但本次没有复制的来源：要么改用全量（把所有来源都列进 `sync`），要么同步调整计划（例如对不再需要的来源执行 `plan --disable`），否则 `sync-due` 会报这些来源 due 却永远不会复制它们。

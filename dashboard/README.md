# 本机对话审计看板

一个独立、只读、无新增第三方依赖的 Node 服务，用于查看企微支持机器人的每日提问、人员、会话与单轮执行时间线。

## 启动

在仓库根目录运行：

```bash
npm run dashboard
```

浏览器打开 **http://127.0.0.1:4319**。默认日期是最近有数据的一天，不一定是今天。

换端口：

```bash
WECOM_DASHBOARD_PORT=4320 npm run dashboard
```

虎老师本机已通过 `~/Library/LaunchAgents/com.kyle.wecom-support-dashboard.plist` 安装常驻服务，登录后自动启动，异常退出自动恢复。日常使用只需打开上述地址，不需要运行终端命令；服务日志在 `~/Library/Logs/wecom-support-dashboard.stdout.log` 和对应 stderr 文件。

## 手机访问（同一 WiFi）

默认只监听 `127.0.0.1`，只有这台电脑能打开。需要手机访问时，用局域网绑定启动：

```bash
WECOM_DASHBOARD_BIND=0.0.0.0 npm run dashboard
```

终端会打印实际监听地址和手机访问地址，例如：

```text
监听地址：0.0.0.0:4319（局域网可访问）
手机访问：http://192.168.1.23:4319
```

手机和电脑连同一个 WiFi，在手机浏览器打开 `http://<本机局域网IP>:4319` 即可。也可以把 `WECOM_DASHBOARD_BIND` 设成某个本机网卡 IPv4，只绑定那块网卡。

看板没有口令或登录。开启局域网后，同一网段的其他设备也能访问，只建议在可信网络、本机可读数据上临时使用，用完停掉服务。数据接口仍然是只读的，没有任意文件读取或命令执行。

## 页面与数据边界

界面是「左侧会话列表 + 右侧对话流」的 Agent 形态，打开即自动选中最近活跃会话：

- 左侧：按最后活跃倒序的当天会话，显示同事、首问摘要、轮数与时间；顶部可切日期、筛人员、搜索消息。
- 右侧：一条一条的对话记录。用户问题在右侧气泡，助手完整答复在左侧正文，元信息显示时间、路由、耗时与投递状态。
- 每轮下方可展开「执行轨迹」：路由、Guard 重写、渐进深化、供应商实际返回的 thinking、工具调用与结果；read 展开内容是模型实际看到的文本，可能已被 pi 截断。轨迹默认只铺前 30 条，可继续展开。
- `SKILL.md 实际读取 / 已加载`只表示 read 成功，不表示 Skill 已执行。
- 入站图片只按已索引的 `msgid + 序号`提供本机预览，不开放任意文件路径。
- “刷新”会重新只读扫描，并保留当前日期、筛选与选中会话；地址栏会同步 `?date=&session=&q=&colleague=`，可直接收藏或重开。

历史出站正文没有独立归档。模型侧最终文本不能被当成已核实的企微实际发送正文；投递状态只说明对应通道调用成功。

pi 文件不含 msgid。索引只接受完成日志中的 `sessionKey` 精确匹配的 `wx-*` 文件，并以“同用户严格串行 + 首轮 user 与原始问题完整匹配”作为锚点；下一轮锚点直接截断上一轮，缺完成日志的轮次也保留边界。相似问题、重复来源或段内出现无法解释的新问题时保持未关联，不使用完成时间宽限窗，不借用邻轮内容。

## 数据源发现与覆盖

默认自动发现本机所有机器人实例，不依赖固定实例名：

- `~/.wecom-support-bot/instances/*`
- 仓库 `instances/*`
- 机器人进程正在使用的 `WECOM_BOT_INSTANCE_DIR`（若已设置）

目录里有 `instance.json` 或 `data/inbox.jsonl` 才会被当成实例；实例内的收件箱、`logs/bot.log`、`data/images` 直接按目录读取，pi 会话目录取 `<实例>/agent/sessions/*` 下最新的子目录。仓库根目录若还有旧的 `data/inbox.jsonl`，会作为 `legacy` 实例一并展示。

实例不在上述位置时，显式指定目录（可重复）：

```bash
npm run dashboard -- --instance-dir /path/to/instance --instance-dir /path/to/another
```

也可以用环境变量（多个目录按系统路径分隔符拆开）：

```bash
WECOM_DASHBOARD_INSTANCE_DIRS=/path/a:/path/b npm run dashboard
```

- 原始入站：仓库 `logs/launchd.stdout.log`（存在时），仅抽取 msgid、用户、聊天类型、文字与图片数量等白名单字段；可用 `WECOM_DASHBOARD_RAW_LOG` 覆盖。
- 人员映射：全局 `~/.wecom-support-bot/user-map.json`；实例内 `data/user-map.json` 可覆盖全局。支持直接 userid 与现有 base64url `b64` 规则；未知或错误映射使用兜底名称。

不扫描备份目录，不修改源数据，不读取机器人凭证配置，不向外部服务发送数据。

## 安全与稳健性

- 只绑定 `127.0.0.1`，校验 Host，静态资源采用固定白名单。
- API 只有日期摘要、单轮详情、固定图片与刷新操作；没有任意读文件或执行命令接口。
- JSONL/JSON 坏行跳过并计数；正文、思考和工具结果有展示上限及截断标记。
- 客户端不使用 `innerHTML`；所有外部文本用 `textContent` 写入 DOM。
- 响应带 CSP、JSON MIME、nosniff 与 no-store；thinkingSignature、原始 launchd 整行和 response_url 不进入 API。

## 验证

```bash
node --test test/dashboard.test.js test/dashboard-server.test.js
npm run typecheck
npm test
```

# wecom-support-bot

企微技术支持机器人。同事在企业微信里 @ 机器人提问，它查四个知识库、查生产数据、翻代码后回答。

## 架构

```
企业微信（智能机器人 API 模式 · 长连接）
        ↓ wss://openws.work.weixin.qq.com（出站，无需公网 IP）
   src/index.js  网关进程（launchd 常驻）
        ↓ spawn，每轮一次
   隔离的 pi 实例（/Users/kyle/.pi-support，与日常 coding 的 pi 完全隔离）
        ↓
   ├─ ajly-wiki / lzz-wiki          业务概念
   ├─ ajly-db-wiki / lzz-db-wiki    表结构与检索参考
   ├─ bi_query.py                   生产数据（只读，LIMIT 100）
   └─ ajly / lezuzu 代码仓库        实现逻辑
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

**单实例约束**：企微同一个机器人同时只能有一条长连接，新连接会踢掉旧的。不要同时在前台和 launchd 里各跑一份。

**重置 Guard 状态**：删掉 `data/session-state.json`，所有会话回到「未碰过 BI」状态。

## 配置

`config/default.json`：

| 字段 | 含义 |
|---|---|
| `pi.binary` / `pi.agentDir` | 隔离 pi 的路径 |
| `pi.timeoutMs` | 单轮 agent 超时（默认 3 分钟） |
| `roots` | 可访问的目录白名单 |
| `guard.maxRounds` | 隐私打回的最大轮数 |
| `surface.*` | 用户可见文案 |

## 已知限制

- 纯文本对话。图片、文件、语音暂未处理（图片需解密下载，语音企微已转文字可直接用）。
- 会话记忆存在 pi 的 session 里，按企微 userid 隔离，两人不共享。
- 群聊里所有成员共享同一会话上下文（按 `from.userid` 隔离，群里每个人各自独立）。

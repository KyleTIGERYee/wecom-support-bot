#!/usr/bin/env bash
# 安装完全隔离的 pi 实例，供企微机器人专用。
# 不读写日常 coding 用的 pi 目录（~/.pi），也不动已有的 node 安装。
set -euo pipefail

PREFIX="${PI_SUPPORT_PREFIX:-$HOME/.pi-support}"
VERSION="0.84.1"
AGENT_DIR="$PREFIX/agent"
CODING_AGENT_DIR="$HOME/.pi/agent"

echo "==> 安装 pi $VERSION 到 $PREFIX"
npm install -g --prefix "$PREFIX" "@earendil-works/pi-coding-agent@$VERSION"

echo "==> 准备独立配置目录 $AGENT_DIR"
mkdir -p "$AGENT_DIR"

# models.json 软链到 coding 侧，复用内网 provider 定义（不复制密钥）
if [ ! -e "$AGENT_DIR/models.json" ]; then
  ln -s "$CODING_AGENT_DIR/models.json" "$AGENT_DIR/models.json"
  echo "    models.json -> $CODING_AGENT_DIR/models.json"
fi

# 独立 settings.json：不带 coding 侧的 10 个 npm 扩展
cat > "$AGENT_DIR/settings.json" <<'JSON'
{
  "defaultProvider": "安居集团",
  "defaultModel": "DeepSeek-V4-Flash-0731",
  "defaultThinkingLevel": "low",
  "hideThinkingBlock": true
}
JSON

echo "==> 验证隔离"
echo -n "    agent dir 内容: "
ls "$AGENT_DIR" | tr '\n' ' '
echo
echo -n "    coding pi 未受影响: "
command -v pi && pi --version

echo "==> 完成。机器人调用示例："
cat <<EOF
PI_CODING_AGENT_DIR=$AGENT_DIR PI_OFFLINE=1 \\
  $PREFIX/bin/pi --mode json --no-context-files --no-skills --no-extensions \\
  --tools "read,bash" --provider 安居集团 --model DeepSeek-V4-Flash-0731 "你好"
EOF

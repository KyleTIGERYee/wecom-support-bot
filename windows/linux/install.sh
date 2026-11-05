#!/usr/bin/env bash
# 在 WSL2 发行版内以 root 运行。安装器只从校验过的白名单资源包复制文件。
set -euo pipefail

NODE_VERSION="22.19.0"
PI_VERSION="0.84.1"
PROJECT_DIR="/opt/wecom-support-bot/app"
INSTANCE_DIR="/var/lib/wecom-support-bot/instance"
RUNTIME_DIR="/opt/wecom-support-bot/runtime"
LINUX_USER="wecom"
BUNDLE=""
DRY_RUN=0

usage() {
  cat <<'EOF'
用法：bash windows/linux/install.sh --bundle <校验过的资源包> [选项]
  --project-dir <Linux 原生路径>   默认 /opt/wecom-support-bot/app
  --instance-dir <Linux 原生路径>  默认 /var/lib/wecom-support-bot/instance
  --runtime-dir <Linux 原生路径>   默认 /opt/wecom-support-bot/runtime
  --dry-run                       只输出依赖、复制与 systemd 计划，不修改系统
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) BUNDLE="${2:-}"; shift 2 ;;
    --project-dir) PROJECT_DIR="${2:-}"; shift 2 ;;
    --instance-dir) INSTANCE_DIR="${2:-}"; shift 2 ;;
    --runtime-dir) RUNTIME_DIR="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知安装参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

for path in "$PROJECT_DIR" "$INSTANCE_DIR" "$RUNTIME_DIR"; do
  if [[ "$path" != /* || "$path" == *$'\n'* || "$path" == *$'\r'* || "/$path/" == *"/../"* ]]; then
    echo "Linux 路径无效：$path" >&2
    exit 2
  fi
  if [[ "$path" =~ ^/mnt/[a-z](/|$) ]]; then
    echo "项目、运行数据和运行时不能位于 /mnt/c 等 Windows 挂载盘：$path" >&2
    exit 2
  fi
  if [[ "$path" == "/" || "$path" == "/home" || "$path" == "/root" ]]; then
    echo "拒绝把系统或用户保护根用作安装目录：$path" >&2
    exit 2
  fi
done

if [[ "$DRY_RUN" == "1" ]]; then
  cat <<EOF
{
  "status": "planned",
  "executes": false,
  "projectDir": "$PROJECT_DIR",
  "instanceDir": "$INSTANCE_DIR",
  "runtimeDir": "$RUNTIME_DIR",
  "linuxUser": "$LINUX_USER",
  "dependencies": {
    "apt": ["ca-certificates", "curl", "tar", "xz-utils", "unzip", "zip", "python3", "python3-pip"],
    "node": "$NODE_VERSION",
    "pi": "$PI_VERSION",
    "npm": "npm ci --omit=dev（目标 Linux 重新安装）"
  },
  "steps": [
    "apt-get update && apt-get install -y <上述依赖>",
    "从 nodejs.org 下载 Node 并用官方 SHASUMS256.txt 校验",
    "复制白名单资源包到 $PROJECT_DIR",
    "创建 ${LINUX_USER} 与 ${INSTANCE_DIR}；实例运行数据归该用户所有",
    "重新安装 npm 依赖和隔离 pi，不复制 Mac node_modules、launchd、凭证或 agent 配置",
    "生成 systemd 单元并 daemon-reload；未配置测试机器人前不 enable/start"
  ]
}
EOF
  exit 0
fi

if [[ -z "$BUNDLE" ]]; then
  echo "实际安装必须提供 --bundle；可先使用 --dry-run 查看计划" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "此脚本只能在目标 WSL2 Linux 内执行；macOS 只能做 dry-run/静态验证" >&2
  exit 2
fi
if [[ "$(id -u)" != "0" ]]; then
  echo "实际安装需要由 Windows 安装器以 WSL root 调用" >&2
  exit 2
fi
if [[ ! -f "$BUNDLE/windows-package.json" ]]; then
  echo "安装资源包缺少 windows-package.json，拒绝安装" >&2
  exit 2
fi
if [[ "$(ps -p 1 -o comm=)" != "systemd" ]]; then
  echo "WSL2 未以 systemd 作为 PID 1。请先在该发行版 /etc/wsl.conf 启用 [boot] systemd=true，再由控制台执行 wsl --shutdown 后续装。" >&2
  exit 2
fi

trap 'echo "安装失败（第 $LINENO 行）。旧端未由本安装脚本操作；请根据上方错误修复后重新运行安装器。" >&2' ERR

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl tar xz-utils unzip zip python3 python3-pip

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) echo "不支持的 Linux 架构：$ARCH" >&2; exit 2 ;;
esac

DOWNLOAD_DIR="$(mktemp -d /tmp/wecom-node.XXXXXX)"
trap 'rm -rf "$DOWNLOAD_DIR"' EXIT
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" -o "$DOWNLOAD_DIR/$NODE_ARCHIVE"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$DOWNLOAD_DIR/SHASUMS256.txt"
(
  cd "$DOWNLOAD_DIR"
  grep "  ${NODE_ARCHIVE}$" SHASUMS256.txt | sha256sum -c -
)
rm -rf "$RUNTIME_DIR/node"
mkdir -p "$RUNTIME_DIR/node"
tar -xJf "$DOWNLOAD_DIR/$NODE_ARCHIVE" -C "$RUNTIME_DIR/node" --strip-components=1
export PATH="$RUNTIME_DIR/node/bin:$PATH"

# 在复制任何项目文件前再次校验白名单和每个文件哈希。
node "$BUNDLE/scripts/windows-instance.js" verify-package --package-dir "$BUNDLE"

if ! id -u "$LINUX_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$LINUX_USER"
fi
rm -rf "$PROJECT_DIR"
mkdir -p "$PROJECT_DIR"
cp -a "$BUNDLE/." "$PROJECT_DIR/"
# 防御性清理：即使资源包被替换，也不运行来源平台的依赖、状态或凭证。
rm -rf "$PROJECT_DIR/node_modules" "$PROJECT_DIR/data" "$PROJECT_DIR/context" "$PROJECT_DIR/workspace" "$PROJECT_DIR/launchd"
rm -f "$PROJECT_DIR/config/secrets.json" "$PROJECT_DIR/config/secrets.dev.json"

cd "$PROJECT_DIR"
npm ci --omit=dev
npm install -g --prefix "$RUNTIME_DIR/pi" "@earendil-works/pi-coding-agent@${PI_VERSION}"

mkdir -p "$INSTANCE_DIR" "$INSTANCE_DIR/workspace" "$INSTANCE_DIR/data" "$INSTANCE_DIR/agent"
chown -R "$LINUX_USER:$LINUX_USER" "$INSTANCE_DIR"
chmod 700 "$INSTANCE_DIR" "$INSTANCE_DIR/data" "$INSTANCE_DIR/agent"

node "$PROJECT_DIR/scripts/windows-instance.js" service-unit \
  --project-dir "$PROJECT_DIR" \
  --instance-dir "$INSTANCE_DIR" \
  --runtime-dir "$RUNTIME_DIR" \
  --user "$LINUX_USER" \
  --output "/etc/systemd/system/wecom-support-bot.service"
systemctl daemon-reload
# 不在这里 enable/start：必须先用控制台完成模型与独立测试机器人初始化。

cat > /var/lib/wecom-support-bot/install-state.json <<EOF
{
  "status": "installed-awaiting-initialization",
  "projectDir": "$PROJECT_DIR",
  "instanceDir": "$INSTANCE_DIR",
  "runtimeDir": "$RUNTIME_DIR",
  "node": "$NODE_VERSION",
  "pi": "$PI_VERSION",
  "service": "wecom-support-bot.service",
  "serviceEnabled": false
}
EOF
chmod 600 /var/lib/wecom-support-bot/install-state.json

echo "安装完成。下一步打开 Windows 本地控制台，完成模型、本地知识/Skills 和独立测试机器人初始化。"

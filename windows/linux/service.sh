#!/usr/bin/env bash
# Windows 控制台调用的唯一 Linux 服务入口；同事不需要直接输入 systemctl。
set -euo pipefail

ACTION="${1:-}"
SYSTEMCTL="${WECOM_BOT_SYSTEMCTL:-systemctl}"
UNIT_DIR="${WECOM_BOT_UNIT_DIR:-/etc/systemd/system}"
PROJECT_DIR="${WECOM_BOT_PROJECT_DIR:-/opt/wecom-support-bot/app}"
INSTANCE_DIR="${WECOM_BOT_INSTANCE_DIR:-/var/lib/wecom-support-bot/instance}"
RUNTIME_DIR="${WECOM_BOT_RUNTIME_DIR:-/opt/wecom-support-bot/runtime}"
NODE="${WECOM_BOT_NODE:-$RUNTIME_DIR/node/bin/node}"
export WECOM_BOT_PI_BINARY="$RUNTIME_DIR/pi/bin/pi"
SERVICE="wecom-support-bot.service"
DRY_RUN=0
if [[ "${2:-}" == "--dry-run" ]]; then DRY_RUN=1; fi

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

case "$ACTION" in
  install)
    run "$NODE" "$PROJECT_DIR/scripts/windows-instance.js" service-unit \
      --project-dir "$PROJECT_DIR" --instance-dir "$INSTANCE_DIR" --runtime-dir "$RUNTIME_DIR" \
      --output "$UNIT_DIR/$SERVICE"
    run "$SYSTEMCTL" daemon-reload
    ;;
  start)
    if [[ "$DRY_RUN" != "1" ]]; then
      "$NODE" "$PROJECT_DIR/scripts/windows-instance.js" runtime-check --instance-dir "$INSTANCE_DIR" >/dev/null
    fi
    run "$SYSTEMCTL" enable --now "$SERVICE"
    run "$SYSTEMCTL" is-active "$SERVICE"
    ;;
  stop)
    run "$SYSTEMCTL" disable --now "$SERVICE"
    ;;
  restart)
    if [[ "$DRY_RUN" != "1" ]]; then
      "$NODE" "$PROJECT_DIR/scripts/windows-instance.js" runtime-check --instance-dir "$INSTANCE_DIR" >/dev/null
    fi
    run "$SYSTEMCTL" restart "$SERVICE"
    run "$SYSTEMCTL" is-active "$SERVICE"
    ;;
  status)
    run "$SYSTEMCTL" status "$SERVICE" --no-pager
    ;;
  *)
    echo "用法：bash windows/linux/service.sh install|start|stop|restart|status [--dry-run]" >&2
    exit 2
    ;;
esac

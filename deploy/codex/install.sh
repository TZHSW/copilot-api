#!/usr/bin/env bash
# Offline installer for the portable Copilot API + Codex configuration bundle.

set -Eeuo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PACKAGE_ROOT=${PACKAGE_ROOT:-$SELF_DIR}
PACKAGE_ROOT=$(cd "$PACKAGE_ROOT" && pwd)
PORT=${PORT:-4141}
OFFLINE=${OFFLINE:-0}
SUPERVISOR=${SUPERVISOR:-auto}
USER_HOME=${INSTALL_ROOT:-$HOME}
CODEX_HOME=${CODEX_HOME:-$USER_HOME/.codex}
SHARE=$USER_HOME/.local/share/copilot-api-patched
TOKEN_DIR=$USER_HOME/.local/share/copilot-api
TOKEN_FILE=$TOKEN_DIR/github_token
BIN_DIR=$USER_HOME/.local/bin
CTL=$BIN_DIR/copilot-api-ctl
UNIT_DIR=$USER_HOME/.config/systemd/user
UNIT_FILE=$UNIT_DIR/copilot-api.service
BACKUP_ROOT=${BACKUP_DIR:-$USER_HOME/.local/share/copilot-codex-backups}
BACKUP=$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$
NODE_BIN=""
CODEX_BIN=${CODEX_BIN:-}
PREVIOUS_RUNNING=0
MUTATED=0

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31m[err ] %s\033[0m\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$2"
}

validate_target() {
  local target=$1
  [ -n "$target" ] || die "目标路径不能为空"
  [ "$target" != "/" ] || die "拒绝使用 / 作为目标路径"
}

verify_manifest() {
  [ -f "$PACKAGE_ROOT/MANIFEST.sha256" ] || die "缺少 MANIFEST.sha256"
  (cd "$PACKAGE_ROOT" && sha256sum -c MANIFEST.sha256 --quiet) \
    || die "安装包校验失败，文件可能损坏或被修改"
}

port_pid() {
  command -v ss >/dev/null 2>&1 || return 0
  ss -ltnp 2>/dev/null \
    | grep -E "[:.]$PORT[[:space:]]" \
    | grep -oE 'pid=[0-9]+' \
    | cut -d= -f2 \
    | head -1
}

port_answers() {
  curl -sf --noproxy '*' --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1
}

process_is_managed() {
  local pid=$1
  local command_line
  command_line=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
  [[ "$command_line" == *"$SHARE/dist/main.js"* ]]
}

have_user_systemd() {
  command -v systemctl >/dev/null 2>&1 \
    && systemctl --user list-units --type=service --no-pager >/dev/null 2>&1
}

host_systemd_allowed() {
  [ -z "${INSTALL_ROOT:-}" ]
}

ensure_user_bus() {
  have_user_systemd && return 0
  local uid
  uid=$(id -u)
  if [ -d "/run/user/$uid" ]; then
    export XDG_RUNTIME_DIR="/run/user/$uid"
    if [ -S "$XDG_RUNTIME_DIR/bus" ]; then
      export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
    fi
  fi
  have_user_systemd
}

stop_managed_process() {
  if [ -x "$CTL" ]; then "$CTL" stop >/dev/null 2>&1 || true; fi
  if host_systemd_allowed && have_user_systemd; then
    systemctl --user stop copilot-api.service >/dev/null 2>&1 || true
  fi
  local pid
  pid=$(port_pid || true)
  if [ -n "$pid" ] && process_is_managed "$pid"; then
    kill "$pid" >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 80); do
    port_answers || return 0
    sleep 0.25
  done
  return 1
}

backup_if_present() {
  local source=$1
  local name=$2
  if [ -e "$source" ]; then
    mkdir -p "$BACKUP"
    cp -a "$source" "$BACKUP/$name"
  fi
}

restore_path() {
  local destination=$1
  local name=$2
  if [ -e "$destination" ]; then rm -rf -- "$destination"; fi
  if [ -e "$BACKUP/$name" ]; then
    mkdir -p "$(dirname "$destination")"
    cp -a "$BACKUP/$name" "$destination"
  fi
}

rollback() {
  local status=$?
  trap - ERR INT TERM
  [ "$MUTATED" -eq 1 ] || exit "$status"
  warn "安装失败，恢复 $BACKUP"
  stop_managed_process || true
  restore_path "$SHARE" api
  restore_path "$CODEX_HOME" codex
  restore_path "$TOKEN_FILE" github_token
  restore_path "$USER_HOME/.orca/agent-hooks" orca-agent-hooks
  restore_path "$CTL" controller
  restore_path "$UNIT_FILE" systemd-unit
  if [ "$PREVIOUS_RUNNING" -eq 1 ]; then
    if [ -x "$CTL" ]; then
      "$CTL" start >/dev/null 2>&1 || true
    elif host_systemd_allowed && have_user_systemd; then
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      systemctl --user start copilot-api.service >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}

write_controller() {
  mkdir -p "$BIN_DIR"
  cat >"$CTL" <<EOF
#!/usr/bin/env bash
set -euo pipefail
NODE=$(printf '%q' "$NODE_BIN")
MAIN=$(printf '%q' "$SHARE/dist/main.js")
PORT=$(printf '%q' "$PORT")
PID_FILE=$(printf '%q' "$SHARE/run.pid")
LOG_FILE=$(printf '%q' "$SHARE/run.log")

running() {
  [ -s "\$PID_FILE" ] && kill -0 "\$(cat "\$PID_FILE")" 2>/dev/null
}

case "\${1:-status}" in
  start)
    if running; then echo "运行中 (pid \$(cat "\$PID_FILE"))"; exit 0; fi
    mkdir -p "\$(dirname "\$PID_FILE")"
    launcher=nohup
    command -v setsid >/dev/null 2>&1 && launcher=setsid
    "\$launcher" bash -c 'echo \$\$ > "\$1"; shift; exec "\$@"' _ "\$PID_FILE" \
      "\$NODE" "\$MAIN" start --account-type enterprise --port "\$PORT" >>"\$LOG_FILE" 2>&1 </dev/null &
    for _ in \$(seq 1 40); do [ -s "\$PID_FILE" ] && break; sleep 0.05; done
    running || { tail -30 "\$LOG_FILE" >&2 || true; rm -f "\$PID_FILE"; exit 1; }
    echo "已启动 (pid \$(cat "\$PID_FILE"))"
    ;;
  stop)
    if running; then
      pid=\$(cat "\$PID_FILE")
      kill "\$pid" 2>/dev/null || true
      for _ in \$(seq 1 40); do kill -0 "\$pid" 2>/dev/null || break; sleep 0.1; done
    fi
    rm -f "\$PID_FILE"
    echo "已停止"
    ;;
  restart) "\$0" stop >/dev/null; "\$0" start ;;
  status) running && echo "运行中 (pid \$(cat "\$PID_FILE"))" || { echo "未运行"; exit 3; } ;;
  log) tail -f "\$LOG_FILE" ;;
  *) echo "用法: \$(basename "\$0") {start|stop|restart|status|log}" >&2; exit 2 ;;
esac
EOF
  chmod 700 "$CTL"
}

install_systemd_service() {
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_FILE" <<EOF
[Unit]
Description=GitHub Copilot API proxy for Codex
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="$NODE_BIN" "$SHARE/dist/main.js" start --account-type enterprise --port $PORT
Restart=always
RestartSec=5
WorkingDirectory=$USER_HOME
Environment=HOME=$USER_HOME
Environment=PATH=$BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now copilot-api.service
  systemctl --user restart copilot-api.service
  loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "无法启用 linger，注销后服务可能停止"
}

say "安装前检查"
validate_target "$USER_HOME"
validate_target "$CODEX_HOME"
validate_target "$SHARE"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] \
  || die "PORT 必须是 1-65535 的整数"
case "$SUPERVISOR" in auto | systemd | nohup) ;; *) die "SUPERVISOR 必须是 auto、systemd 或 nohup" ;; esac
require_cmd node "需要 Node.js 20 或更新版本"
NODE_BIN=$(command -v node)
[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 20 ] \
  || die "需要 Node.js 20 或更新版本"
if [ -z "$CODEX_BIN" ]; then CODEX_BIN=$(command -v codex || true); fi
[ -n "$CODEX_BIN" ] && [ -x "$CODEX_BIN" ] \
  || die "需要 Codex CLI（安装器不会联网安装）"
require_cmd curl "需要 curl"
require_cmd sha256sum "需要 sha256sum"
[ -f "$PACKAGE_ROOT/dist/main.js" ] || die "缺少 dist/main.js"
[ -f "$PACKAGE_ROOT/lib/migrate-config.mjs" ] || die "缺少 lib/migrate-config.mjs"
[ -f "$PACKAGE_ROOT/lib/verify-service.mjs" ] || die "缺少 lib/verify-service.mjs"
[ -f "$PACKAGE_ROOT/codex-config/config.toml" ] || die "缺少 codex-config/config.toml"
[ -f "$PACKAGE_ROOT/codex-config/auth.json" ] || die "缺少 codex-config/auth.json"
[ -f "$PACKAGE_ROOT/credentials/github_token" ] || die "缺少 credentials/github_token"
verify_manifest

BUSY_PID=$(port_pid || true)
if [ -n "$BUSY_PID" ]; then
  if process_is_managed "$BUSY_PID"; then
    PREVIOUS_RUNNING=1
  else
    BUSY_COMMAND=$(tr '\0' ' ' <"/proc/$BUSY_PID/cmdline" 2>/dev/null || echo unknown)
    die "端口 $PORT 已被非托管进程占用 (pid $BUSY_PID): $BUSY_COMMAND"
  fi
elif port_answers; then
  die "端口 $PORT 有非托管服务应答，但无法识别进程；拒绝覆盖"
fi

say "备份现有安装"
mkdir -p "$BACKUP"
backup_if_present "$SHARE" api
backup_if_present "$CODEX_HOME" codex
backup_if_present "$TOKEN_FILE" github_token
backup_if_present "$USER_HOME/.orca/agent-hooks" orca-agent-hooks
backup_if_present "$CTL" controller
backup_if_present "$UNIT_FILE" systemd-unit

if [ "$PREVIOUS_RUNNING" -eq 1 ]; then
  stop_managed_process || die "无法停止旧的托管服务"
fi

trap rollback ERR INT TERM
MUTATED=1

say "部署自包含 API"
STAGE=$USER_HOME/.local/share/.copilot-api-patched.new.$$
rm -rf -- "$STAGE"
mkdir -p "$STAGE"
cp -a "$PACKAGE_ROOT/dist" "$STAGE/dist"
cp -a "$PACKAGE_ROOT/lib" "$STAGE/lib"
rm -rf -- "$SHARE"
mv "$STAGE" "$SHARE"
mkdir -p "$TOKEN_DIR"
install -m 600 "$PACKAGE_ROOT/credentials/github_token" "$TOKEN_FILE"

say "迁移 Codex 配置"
"$NODE_BIN" "$PACKAGE_ROOT/lib/migrate-config.mjs" \
  --source "$PACKAGE_ROOT/codex-config" \
  --target "$CODEX_HOME" \
  --home "$USER_HOME" \
  --port "$PORT" \
  --platform linux \
  --backup "$BACKUP/migration"
if [ -d "$PACKAGE_ROOT/optional-config/orca-agent-hooks" ]; then
  mkdir -p "$USER_HOME/.orca/agent-hooks"
  cp -a "$PACKAGE_ROOT/optional-config/orca-agent-hooks/." "$USER_HOME/.orca/agent-hooks/"
fi
if [ "${INSTALL_FAIL_AFTER_CONFIG:-0}" = 1 ]; then
  warn "按测试要求在配置迁移后注入失败"
  false
fi

say "配置后台服务"
if [ "$SUPERVISOR" = systemd ] || { [ "$SUPERVISOR" = auto ] && ensure_user_bus; }; then
  ensure_user_bus || die "无法连接 systemd user 总线"
  install_systemd_service
  ACTIVE_SUPERVISOR=systemd
else
  write_controller
  "$CTL" restart
  ACTIVE_SUPERVISOR=nohup
fi

say "验证本地安装"
READY=0
for _ in $(seq 1 120); do
  if port_answers; then READY=1; break; fi
  sleep 0.25
done
[ "$READY" -eq 1 ] || die "服务未能在端口 $PORT 启动"
VERIFY_ARGS=(--base-url "http://127.0.0.1:$PORT" --managed-root "$SHARE")
if [ "$OFFLINE" = 1 ]; then VERIFY_ARGS+=(--offline); fi
"$NODE_BIN" "$SHARE/lib/verify-service.mjs" "${VERIFY_ARGS[@]}"

trap - ERR INT TERM
MUTATED=0
printf '\n\033[1;32m安装完成\033[0m：API=http://localhost:%s/v1，Codex=%s\n' "$PORT" "$CODEX_HOME"
printf '备份：%s\n' "$BACKUP"
if [ "$ACTIVE_SUPERVISOR" = systemd ]; then
  echo "管理：systemctl --user {status,restart,stop} copilot-api"
else
  echo "管理：$CTL {status,restart,stop,log}"
fi

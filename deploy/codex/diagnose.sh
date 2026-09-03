#!/usr/bin/env bash
# Read-only diagnostics for the portable Copilot API + Codex installation.

set -uo pipefail

PORT=${PORT:-4141}
OFFLINE=${OFFLINE:-0}
USER_HOME=${INSTALL_ROOT:-$HOME}
CODEX_HOME=${CODEX_HOME:-$USER_HOME/.codex}
SHARE=$USER_HOME/.local/share/copilot-api-patched
TOKEN_FILE=$USER_HOME/.local/share/copilot-api/github_token
CTL=$USER_HOME/.local/bin/copilot-api-ctl

heading() { printf '\n\033[1;36m── %s ──\033[0m\n' "$*"; }

heading "环境"
printf 'node:  %s %s\n' "$(command -v node 2>/dev/null || echo 未找到)" "$(node --version 2>/dev/null || true)"
printf 'codex: %s %s\n' "$(command -v codex 2>/dev/null || echo 未找到)" "$(codex --version 2>/dev/null | head -1 || true)"
printf 'PORT=%s\nCODEX_HOME=%s\nAPI_ROOT=%s\n' "$PORT" "$CODEX_HOME" "$SHARE"
printf 'configured provider: %s\n' "$(grep -m1 -E '^[[:space:]]*base_url[[:space:]]*=' "$CODEX_HOME/config.toml" 2>/dev/null || echo 未配置)"

heading "服务状态"
if [ -x "$CTL" ]; then
  "$CTL" status 2>&1 || true
elif command -v systemctl >/dev/null 2>&1; then
  systemctl --user status copilot-api.service --no-pager 2>&1 | head -20 || true
else
  echo "没有控制脚本或 systemd"
fi
if command -v ss >/dev/null 2>&1; then
  ss -ltnp 2>/dev/null | grep -E "[:.]$PORT[[:space:]]" || echo "端口未监听"
fi

heading "本地 API"
curl -sS --noproxy '*' --max-time 5 -D- "http://127.0.0.1:$PORT/" 2>&1 | head -20 || true
curl -sS --noproxy '*' --max-time 10 "http://127.0.0.1:$PORT/v1/models" 2>&1 | head -c 600 || true
echo

heading "凭据（不显示内容）"
if [ -s "$TOKEN_FILE" ]; then
  printf 'github_token: 存在 (%s bytes)\n' "$(wc -c <"$TOKEN_FILE")"
else
  printf 'github_token: 缺失 (%s)\n' "$TOKEN_FILE"
fi
if [ -s "$CODEX_HOME/auth.json" ]; then
  printf 'auth.json: 存在 (%s bytes)\n' "$(wc -c <"$CODEX_HOME/auth.json")"
else
  printf 'auth.json: 缺失\n'
fi

heading "Codex 扩展"
printf '用户 skills: %s\n' "$(find "$CODEX_HOME/skills" -mindepth 2 -maxdepth 2 -type f -name SKILL.md 2>/dev/null | wc -l)"
printf '插件文件: %s\n' "$(find "$CODEX_HOME/plugins" -type f 2>/dev/null | wc -l)"

heading "能力验证"
if [ -f "$SHARE/lib/verify-service.mjs" ] && command -v node >/dev/null 2>&1; then
  args=(--base-url "http://127.0.0.1:$PORT" --managed-root "$SHARE")
  VERIFY_PID=""
  if [ -s "$SHARE/run.pid" ]; then read -r VERIFY_PID _ <"$SHARE/run.pid"; fi
  if [ -z "$VERIFY_PID" ] && command -v systemctl >/dev/null 2>&1; then
    VERIFY_PID=$(systemctl --user show copilot-api.service -p MainPID --value 2>/dev/null || true)
  fi
  if [[ "$VERIFY_PID" =~ ^[0-9]+$ ]] && [ "$VERIFY_PID" -gt 0 ]; then
    args+=(--node-path "$(command -v node)" --process-id "$VERIFY_PID")
  fi
  if [ "$OFFLINE" = 1 ]; then args+=(--offline); fi
  node "$SHARE/lib/verify-service.mjs" "${args[@]}"
  VERIFY_STATUS=$?
else
  echo "缺少 verifier 或 node"
  VERIFY_STATUS=2
fi

heading "最近日志"
if [ -f "$SHARE/run.log" ]; then
  tail -30 "$SHARE/run.log"
elif command -v journalctl >/dev/null 2>&1; then
  journalctl --user -u copilot-api.service -n 30 --no-pager 2>&1 || true
else
  echo "没有可读日志"
fi

exit "$VERIFY_STATUS"

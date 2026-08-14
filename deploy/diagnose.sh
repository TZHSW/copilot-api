#!/usr/bin/env bash
# 反代不通时先跑这个，把输出整段贴出来即可定位。只读，不改任何东西。
#
#   bash diagnose.sh          # 端口取自 ~/.claude/settings.json，取不到就用 4141
#   PORT=4142 bash diagnose.sh

SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
SHARE=$HOME/.local/share/copilot-api-patched

if [ -z "${PORT:-}" ] && [ -f "$SETTINGS" ]; then
  PORT=$(python3 -c "
import json, re, sys
try:
    u = json.load(open('$SETTINGS'))['env']['ANTHROPIC_BASE_URL']
    m = re.search(r':(\d+)', u)
    print(m.group(1) if m else '')
except Exception:
    print('')
" 2>/dev/null)
fi
PORT=${PORT:-4141}

hd() { printf '\n\033[1;36m── %s ─────────────────────────\033[0m\n' "$*"; }

hd "基本环境"
echo "PORT=$PORT"
echo "node: $(command -v node || echo 无) $(node --version 2>/dev/null)"
echo "claude: $(command -v claude || echo 无) $(claude --version 2>/dev/null | head -1)"
echo "代理相关环境变量:"
env | grep -iE '^(http_proxy|https_proxy|all_proxy|no_proxy)=' || echo "  （没有设置）"

hd "谁在监听 $PORT"
if command -v ss >/dev/null 2>&1; then
  ss -ltnp 2>/dev/null | grep -E "[:.]$PORT[[:space:]]" || echo "  没有进程在监听 $PORT"
  P=$(ss -ltnp 2>/dev/null | grep -E "[:.]$PORT[[:space:]]" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1)
  [ -n "$P" ] && echo "  cmdline: $(tr '\0' ' ' < "/proc/$P/cmdline" 2>/dev/null)"
else
  echo "  没有 ss 命令"
fi

hd "反代根路径（应输出 Server running）"
curl -sS -m10 -o /dev/null -w '  HTTP %{http_code}\n' "http://localhost:$PORT/" 2>&1
curl -sS -m10 "http://localhost:$PORT/" 2>&1 | head -c 200; echo

hd "模型目录（前 400 字节 + 响应头）"
curl -sS -D- -m20 -H "Authorization: Bearer copilot-api" \
  "http://localhost:$PORT/v1/native/v1/models" 2>&1 | head -c 400; echo

hd "Copilot 授权"
T=$HOME/.local/share/copilot-api/github_token
if [ -s "$T" ]; then
  echo "  存在，$(wc -c < "$T") 字节（内容不打印）"
else
  echo "  缺失或为空：$T —— 需要跑一次设备码登录"
fi

hd "能不能直连 Copilot 上游"
curl -sS -o /dev/null -m15 -w '  api.githubcopilot.com HTTP %{http_code}\n' \
  https://api.githubcopilot.com/ 2>&1 | head -3
curl -sS -o /dev/null -m15 -w '  api.github.com HTTP %{http_code}\n' \
  https://api.github.com/ 2>&1 | head -3

hd "服务日志"
if [ -f "$SHARE/run.log" ]; then
  echo "（$SHARE/run.log 末 30 行）"
  tail -30 "$SHARE/run.log"
elif command -v journalctl >/dev/null 2>&1; then
  journalctl --user -u copilot-api -n 30 --no-pager 2>&1 | tail -30
else
  echo "  没找到日志"
fi

hd "settings.json 的 env"
[ -f "$SETTINGS" ] && python3 -c "
import json
d = json.load(open('$SETTINGS')).get('env', {})
for k, v in d.items():
    print(f'  {k} = {v}')
" 2>&1 || echo "  没有 $SETTINGS"

hd "部署目录"
ls -la "$SHARE/dist/" 2>/dev/null | head -5 || echo "  没有 $SHARE/dist"

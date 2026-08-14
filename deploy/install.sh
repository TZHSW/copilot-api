#!/usr/bin/env bash
# 一键部署：本地 copilot-api 反代（patched 分支）+ Claude Code + settings.json
#
#   bash deploy/install.sh
#
# 环境变量：
#   PORT=4141                     反代监听端口
#   CLAUDE_CONFIG_DIR=~/.claude   Claude Code 配置目录
#
# 幂等：重复跑只会重新构建、重启服务、覆盖由模板管理的那些 settings 键。

set -euo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PORT=${PORT:-4141}
SHARE=$HOME/.local/share/copilot-api-patched
TOKEN_FILE=$HOME/.local/share/copilot-api/github_token
UNIT_DIR=$HOME/.config/systemd/user
SETTINGS_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
SETTINGS=$SETTINGS_DIR/settings.json

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[err ] %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. node
say "检查 node"
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  NODE_BIN=$(command -v node)
else
  warn "没有 node>=20，用 nvm 装一个（不需要 sudo）"
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22
  NODE_BIN=$(command -v node)
fi
echo "node: $NODE_BIN ($(node --version))"

systemctl --user --version >/dev/null 2>&1 || die "没有 systemd user session，这个脚本不处理这种机器"

# ---------------------------------------------------------------- 2. bun
say "检查 bun（只用于构建，运行时是 node）"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || die "bun 装失败，手动装好再跑"

# ---------------------------------------------------------------- 3. 构建
say "构建"
cd "$REPO_DIR"
bun install --frozen-lockfile
bun run build
[ -f dist/main.js ] || die "构建没产出 dist/main.js"

say "部署到 $SHARE"
mkdir -p "$SHARE/dist"
cp dist/main.js dist/main.js.map "$SHARE/dist/"

# ---------------------------------------------------------------- 4. GitHub 授权
say "检查 Copilot 授权"
if [ -s "$TOKEN_FILE" ]; then
  echo "已有 token：$TOKEN_FILE（跳过）"
else
  warn "没有 token，进入 GitHub 设备码登录（需要能访问 Copilot Enterprise 的账号）"
  "$NODE_BIN" "$SHARE/dist/main.js" auth
  [ -s "$TOKEN_FILE" ] || die "授权没完成"
fi

# ---------------------------------------------------------------- 5. systemd
say "安装 systemd user 服务"
mkdir -p "$UNIT_DIR"
sed -e "s|@NODE@|$NODE_BIN|g" -e "s|@SHARE@|$SHARE|g" \
    -e "s|@HOME@|$HOME|g"     -e "s|@PORT@|$PORT|g" \
    "$REPO_DIR/deploy/copilot-api.service" > "$UNIT_DIR/copilot-api.service"
grep -q '@[A-Z]*@' "$UNIT_DIR/copilot-api.service" && die "unit 模板占位符没替换干净"

systemctl --user daemon-reload
systemctl --user enable --now copilot-api.service
systemctl --user restart copilot-api.service
# 没登录时也让服务活着——远程机器必须开
loginctl enable-linger "$USER" 2>/dev/null || warn "enable-linger 失败，注销后服务会停"

say "等端口 $PORT"
if timeout 60 bash -c "until curl -sf -m2 http://localhost:$PORT/ >/dev/null 2>&1; do :; done"; then
  echo "反代就绪：http://localhost:$PORT"
else
  journalctl --user -u copilot-api -n 30 --no-pager || true
  die "反代没起来，看上面日志"
fi

# ---------------------------------------------------------------- 6. Claude Code
say "检查 Claude Code"
if command -v claude >/dev/null 2>&1; then
  echo "已安装：$(command -v claude) ($(claude --version 2>/dev/null | head -1))"
else
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
fi
command -v claude >/dev/null 2>&1 || warn "claude 不在 PATH，把 ~/.local/bin 加进去"

# ---------------------------------------------------------------- 7. settings.json
say "写 $SETTINGS"
mkdir -p "$SETTINGS_DIR"
TEMPLATE="$REPO_DIR/deploy/settings.template.json" \
TARGET="$SETTINGS" PORT="$PORT" NODE_BIN="$NODE_BIN" \
python3 - <<'PY'
import json, os, shutil, time

tpl = json.load(open(os.environ["TEMPLATE"]))
tgt_p, port, node_bin = os.environ["TARGET"], os.environ["PORT"], os.environ["NODE_BIN"]

tpl["env"]["ANTHROPIC_BASE_URL"] = f"http://localhost:{port}/v1/native"
# statusLine 里硬编码的 node 路径换成本机的
sl = tpl.get("statusLine", {})
if isinstance(sl.get("command"), str):
    sl["command"] = sl["command"].replace('"/usr/bin/node"', f'"{node_bin}"')

cur = {}
if os.path.exists(tgt_p):
    shutil.copy2(tgt_p, f"{tgt_p}.bak.{int(time.time())}")
    try:
        cur = json.load(open(tgt_p))
    except json.JSONDecodeError:
        print("[warn] 原 settings.json 不是合法 JSON，已备份并整体覆盖")

def merge(base, over):
    """深合并，模板优先，列表整体替换；目标机器原有的其它键（比如自己的 hooks）保留。"""
    out = dict(base)
    for k, v in over.items():
        out[k] = merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out

json.dump(merge(cur, tpl), open(tgt_p, "w"), indent=2, ensure_ascii=False)
open(tgt_p, "a").write("\n")
print(f"已写入 {tgt_p}" + ("（旧文件备份为 .bak.*）" if cur else ""))
PY

# ---------------------------------------------------------------- 8. 验证
say "验证"
MODEL=$(python3 -c "import json;print(json.load(open('$SETTINGS'))['env']['ANTHROPIC_MODEL'])")

# 模型目录会变（历史上 claude-opus-4.7-1m-internal 就整个下架过），先看它在不在
curl -s -m10 -H "Authorization: Bearer copilot-api" "http://localhost:$PORT/v1/native/v1/models" \
  | MODEL="$MODEL" python3 -c "
import sys, json, os, re
model = os.environ['MODEL']
ids = [m['id'] for m in json.load(sys.stdin)['data']]
base = re.sub(r'\[1m\]$', '', model)
if base in ids or model in ids:
    print(f'目录里有 {model}')
else:
    print(f'[warn] 目录里没有 {model}；现有 claude 型号：' + ', '.join(i for i in ids if i.startswith('claude')))
"

RESP=$(curl -s -m 90 "http://localhost:$PORT/v1/native/v1/messages" \
  -H "Authorization: Bearer copilot-api" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}]}")

if printf '%s' "$RESP" | python3 -c "import sys,json;sys.exit(0 if json.load(sys.stdin).get('content') else 1)" 2>/dev/null; then
  printf '\n\033[1;32m全部就绪\033[0m：%s 经 http://localhost:%s/v1/native 已能正常返回。\n' "$MODEL" "$PORT"
  echo "开个新终端跑 claude 即可（env 只在进程启动时读）。"
else
  warn "反代起来了但模型调用失败，返回："
  printf '%s\n' "$RESP" | head -c 800; echo
  echo "排查：journalctl --user -u copilot-api -n 50 --no-pager"
  exit 1
fi

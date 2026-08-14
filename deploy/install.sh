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

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# 两种布局：仓库里脚本在 deploy/ 下，免构建包里在包根目录。unit 模板和 settings
# 模板两种情况下都紧挨着脚本；源码/产物则要往上找一层还是就地，看布局。
ASSETS=$SELF_DIR
if [ -f "$SELF_DIR/../src/main.ts" ]; then
  REPO_DIR=$(cd "$SELF_DIR/.." && pwd)
else
  REPO_DIR=$SELF_DIR
fi
PORT=${PORT:-4141}
SHARE=$HOME/.local/share/copilot-api-patched
TOKEN_FILE=$HOME/.local/share/copilot-api/github_token
UNIT_DIR=$HOME/.config/systemd/user
SETTINGS_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
SETTINGS=$SETTINGS_DIR/settings.json

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[err ] %s\033[0m\n' "$*" >&2; exit 1; }

# systemd user session 能不能真的用。注意不能拿 `systemctl --user --version` 探测：
# 那条不碰 D-Bus，在容器里照样成功，等到 daemon-reload 才报
# "Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined"。
have_user_systemd() {
  command -v systemctl >/dev/null 2>&1 \
    && systemctl --user list-units --type=service --no-pager >/dev/null 2>&1
}

# ssh / su 进来常见的情形：会话是有的，只是环境变量没带过来。能补就补。
ensure_user_bus() {
  have_user_systemd && return 0
  local uid
  uid=$(id -u)
  if [ -d "/run/user/$uid" ]; then
    export XDG_RUNTIME_DIR="/run/user/$uid"
    [ -S "$XDG_RUNTIME_DIR/bus" ] \
      && export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
    if have_user_systemd; then
      warn "环境里没有 XDG_RUNTIME_DIR，已自动补成 $XDG_RUNTIME_DIR"
      warn "（想让以后的 shell 也对，把这行加进 ~/.bashrc：export XDG_RUNTIME_DIR=/run/user/$uid）"
      return 0
    fi
  fi
  return 1
}

# ---------------------------------------------------------------- 1. node
# 运行时只需要 node：产物是自包含的，不需要 npm 装依赖。没有就直接抓官方
# tarball 解到 ~/.local/share/node-vX（不用 nvm——它那套 shell 集成在非交互
# 脚本里容易失灵），并在 ~/.local/bin 建软链。
NODE_VERSION=${NODE_VERSION:-22.22.3}

# ~/.local/bin 写进 shell 启动文件。node 和 claude 都装在那儿，不写的话新开的
# 终端里两个都敲不到。幂等：靠 marker 判重。服务本身不受影响——unit 里是绝对路径。
persist_path() {
  local marker="# copilot-cc: node / claude 装在 ~/.local/bin"
  local line='export PATH="$HOME/.local/bin:$PATH"'
  local rc
  # ~/.profile 一定要写：ssh 进来是登录 shell，bash 登录时读的是 .profile 而不是
  # .bashrc。.bashrc / .zshrc 则管交互式非登录 shell，存在就一并写。
  touch "$HOME/.profile"
  for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -Fq "$marker" "$rc" && continue
    printf '\n%s\n%s\n' "$marker" "$line" >> "$rc"
    echo "已把 ~/.local/bin 写进 $rc"
  done
}

install_node() {
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "不认识的架构 $(uname -m)，请自行装 node>=20 后重跑" ;;
  esac
  local url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.gz"
  local target="$HOME/.local/share/node-v${NODE_VERSION}"

  say "装 node v${NODE_VERSION} (${arch})"
  echo "从 $url"
  mkdir -p "$target" "$HOME/.local/bin"
  # 用 tar.gz 而不是 tar.xz：精简系统未必有 xz
  curl -fsSL "$url" | tar -xz -C "$target" --strip-components=1 \
    || die "node 下载/解压失败；离线环境请自行装好 node>=20 再跑"
  for b in node npm npx; do
    [ -e "$target/bin/$b" ] && ln -sf "$target/bin/$b" "$HOME/.local/bin/$b"
  done
  export PATH="$HOME/.local/bin:$PATH"
  hash -r
}

say "检查 node"
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  NODE_BIN=$(command -v node)
else
  warn "没有可用的 node>=20"
  install_node
  command -v node >/dev/null 2>&1 || die "node 装完还是找不到，检查 $HOME/.local/bin 在不在 PATH"
  NODE_BIN=$(command -v node)
  persist_path
fi
echo "node: $NODE_BIN ($(node --version))"
echo "npm : $(command -v npm >/dev/null 2>&1 && npm --version || echo '未装（本部署用不到，产物自包含）')"

# ---------------------------------------------------------------- 2/3. 产物
# 源码仓库：现构建。免构建包（deploy/pack.sh 打的）：直接用自带的 dist/。
# 两种情况拿到的都是 noExternal 的自包含产物——只拷 tsdown 默认构建的 main.js
# 到目标机器会 ERR_MODULE_NOT_FOUND，因为那份把依赖留在了 node_modules 里。
if [ -f "$REPO_DIR/src/main.ts" ]; then
  say "从源码构建自包含产物"
  if ! command -v bun >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  command -v bun >/dev/null 2>&1 || die "bun 装失败，手动装好再跑"
  cd "$REPO_DIR"
  bun install --frozen-lockfile
  bun run build:standalone
  DIST="$REPO_DIR/dist-standalone"
else
  say "免构建包，直接用自带产物"
  DIST="$REPO_DIR/dist"
fi
[ -f "$DIST/main.js" ] || die "没找到 $DIST/main.js"

say "部署到 $SHARE"
rm -rf "$SHARE/dist"
mkdir -p "$SHARE/dist"
cp -a "$DIST/." "$SHARE/dist/"

# ---------------------------------------------------------------- 4. GitHub 授权
say "检查 Copilot 授权"
if [ -s "$TOKEN_FILE" ]; then
  echo "已有 token：$TOKEN_FILE（跳过）"
else
  warn "没有 token，进入 GitHub 设备码登录（需要能访问 Copilot Enterprise 的账号）"
  "$NODE_BIN" "$SHARE/dist/main.js" auth
  [ -s "$TOKEN_FILE" ] || die "授权没完成"
fi

# ---------------------------------------------------------------- 5. 常驻
# 首选 systemd user 服务。容器、或者没有登录会话的 ssh/su 里没有用户 D-Bus，
# 那就退到 nohup + pidfile 的 copilot-api-ctl。SUPERVISOR=nohup 可强制走后者。
SUPERVISOR=${SUPERVISOR:-auto}
if [ "$SUPERVISOR" != "nohup" ] && ensure_user_bus; then
  say "安装 systemd user 服务"
  mkdir -p "$UNIT_DIR"
  sed -e "s|@NODE@|$NODE_BIN|g" -e "s|@SHARE@|$SHARE|g" \
      -e "s|@HOME@|$HOME|g"     -e "s|@PORT@|$PORT|g" \
      "$ASSETS/copilot-api.service" > "$UNIT_DIR/copilot-api.service"
  grep -q '@[A-Z]*@' "$UNIT_DIR/copilot-api.service" && die "unit 模板占位符没替换干净"

  systemctl --user daemon-reload
  systemctl --user enable --now copilot-api.service
  systemctl --user restart copilot-api.service
  # 没登录时也让服务活着——远程机器必须开
  loginctl enable-linger "$USER" 2>/dev/null || warn "enable-linger 失败，注销后服务会停"
  SUPERVISOR=systemd
  LOGHINT="journalctl --user -u copilot-api -n 50 --no-pager"
else
  [ "$SUPERVISOR" = "nohup" ] \
    && say "按 SUPERVISOR=nohup 要求，跳过 systemd" \
    || warn "连不上 systemd user 总线（容器、或没有登录会话的 ssh/su 都会这样），改用 nohup 常驻"

  CTL="$HOME/.local/bin/copilot-api-ctl"
  mkdir -p "$HOME/.local/bin"
  cat > "$CTL" <<CTLEOF
#!/usr/bin/env bash
# 由 install.sh 生成——没有 systemd user session 时的替代常驻方式。
NODE="$NODE_BIN"
MAIN="$SHARE/dist/main.js"
PORT="$PORT"
PIDF="$SHARE/run.pid"
LOG="$SHARE/run.log"
CTLEOF
  cat >> "$CTL" <<'CTLEOF'

running() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }

case "${1:-status}" in
  start)
    running && { echo "已在运行 (pid $(cat "$PIDF"))"; exit 0; }
    # 让服务自成会话：终端关掉、或父进程所在进程组被整组干掉，它都不跟着走
    #（nohup 只挡 SIGHUP，挡不住发给进程组的 TERM/KILL）。
    # pid 由内层 shell 自己写：setsid 的父进程会立刻退出，外面拿到的 $! 是个死 pid。
    launcher=setsid
    command -v setsid >/dev/null 2>&1 || launcher=nohup
    "$launcher" bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$PIDF" \
      "$NODE" "$MAIN" start --account-type enterprise --port "$PORT" >> "$LOG" 2>&1 &
    echo "已启动（pid 见 $0 status），日志：$LOG"
    ;;
  stop)
    running && { kill "$(cat "$PIDF")"; echo "已停止"; } || echo "没在运行"
    rm -f "$PIDF"
    ;;
  restart) "$0" stop >/dev/null 2>&1; exec "$0" start ;;
  status)  running && echo "运行中 (pid $(cat "$PIDF"))" || { echo "没在运行"; exit 3; } ;;
  log)     tail -f "$LOG" ;;
  *) echo "用法: $(basename "$0") {start|stop|restart|status|log}"; exit 1 ;;
esac
CTLEOF
  chmod +x "$CTL"
  echo "已装 $CTL"
  "$CTL" restart

  # 开机自启：有 crontab 就挂 @reboot，没有就明说不会自启
  if command -v crontab >/dev/null 2>&1; then
    CRON_LINE="@reboot $CTL start"
    if crontab -l 2>/dev/null | grep -Fqx "$CRON_LINE"; then
      echo "crontab 里已有 @reboot 自启"
    elif { crontab -l 2>/dev/null; echo "$CRON_LINE"; } | crontab - 2>/dev/null; then
      echo "已加 crontab @reboot 自启"
    else
      warn "crontab 写入失败，重启后需手动 $CTL start"
    fi
  else
    warn "没有 crontab，重启后需手动跑：$CTL start"
  fi
  SUPERVISOR=nohup
  LOGHINT="tail -50 $SHARE/run.log"
fi

say "等端口 $PORT"
if timeout 60 bash -c "until curl -sf -m2 http://localhost:$PORT/ >/dev/null 2>&1; do :; done"; then
  echo "反代就绪：http://localhost:$PORT"
else
  eval "$LOGHINT" || true
  die "反代没起来，看上面日志"
fi

# ---------------------------------------------------------------- 6. Claude Code
say "检查 Claude Code"
if command -v claude >/dev/null 2>&1; then
  echo "已安装：$(command -v claude) ($(claude --version 2>/dev/null | head -1))"
else
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
  hash -r
  persist_path
fi
command -v claude >/dev/null 2>&1 || warn "claude 不在 PATH，把 ~/.local/bin 加进去"

# ---------------------------------------------------------------- 7. settings.json
say "写 $SETTINGS"
mkdir -p "$SETTINGS_DIR"
TEMPLATE="$ASSETS/settings.template.json" \
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
# 反代实际服务哪些 id，settings 里就得写哪些——逐字比对，不做任何剥后缀之类的
# 宽容处理。Claude Code 会拿 settings 里的模型名去和 /v1/models 对，对不上就报
# "There's an issue with the selected model"。目录本身也会变（claude-opus-4.7-1m-internal
# 就整个下架过），所以这一步失败就直接停，别把坏配置留给用户。
if ! curl -s -m10 -H "Authorization: Bearer copilot-api" \
      "http://localhost:$PORT/v1/native/v1/models" \
   | SETTINGS="$SETTINGS" python3 -c "
import sys, json, os
served = {m['id'] for m in json.load(sys.stdin)['data']}
env = json.load(open(os.environ['SETTINGS']))['env']
keys = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']
bad = {k: env[k] for k in keys if k in env and env[k] not in served}
for k in keys:
    if k in env:
        print(f\"  {'✓' if env[k] in served else '✗'} {k} = {env[k]}\")
if bad:
    print('\n反代没有提供这些模型 id。当前可用的 claude 型号：')
    for i in sorted(i for i in served if i.startswith('claude')):
        print('  ' + i)
    print('\n改 settings.json 里的 env（或 deploy/settings.template.json）再重跑。')
    sys.exit(1)
"; then
  die "模型名和反代对不上，见上面列表"
fi

MODEL=$(python3 -c "import json;print(json.load(open('$SETTINGS'))['env']['ANTHROPIC_MODEL'])")

RESP=$(curl -s -m 90 "http://localhost:$PORT/v1/native/v1/messages" \
  -H "Authorization: Bearer copilot-api" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}]}")

if printf '%s' "$RESP" | python3 -c "import sys,json;sys.exit(0 if json.load(sys.stdin).get('content') else 1)" 2>/dev/null; then
  printf '\n\033[1;32m全部就绪\033[0m：%s 经 http://localhost:%s/v1/native 已能正常返回。\n' "$MODEL" "$PORT"
  echo "开个新终端跑 claude 即可（env 只在进程启动时读）。"
  if [ "$SUPERVISOR" = "systemd" ]; then
    echo "服务管理：systemctl --user {status,restart} copilot-api  日志：$LOGHINT"
  else
    echo "服务管理：$HOME/.local/bin/copilot-api-ctl {status,restart,stop,log}"
  fi
else
  warn "反代起来了但模型调用失败，返回："
  printf '%s\n' "$RESP" | head -c 800; echo
  echo "排查：$LOGHINT"
  exit 1
fi

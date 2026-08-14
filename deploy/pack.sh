#!/usr/bin/env bash
# 打一个免构建部署包：目标机器只要有 node>=20 就能装，不需要 bun、不需要联网装依赖。
#
#   bash deploy/pack.sh              # 产物落在仓库根目录
#   OUT_DIR=/tmp bash deploy/pack.sh # 指定输出目录
#
# 包里是什么：
#   dist/                   noExternal 的自包含产物（~6 MB，含 tokenizer 数据 chunk）
#   install.sh              和仓库里同一份，检测到没有 src/ 就跳过构建
#   copilot-api.service     systemd 模板
#   settings.template.json  Claude Code 配置
#   README.md / VERSION

set -euo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT_DIR=${OUT_DIR:-$REPO_DIR}

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[err ] %s\033[0m\n' "$*" >&2; exit 1; }

cd "$REPO_DIR"
command -v bun >/dev/null 2>&1 || die "需要 bun 来构建；装好再跑（curl -fsSL https://bun.sh/install | bash）"

say "构建自包含产物"
bun install --frozen-lockfile
bun run build:standalone
[ -f dist-standalone/main.js ] || die "构建没产出 dist-standalone/main.js"

SHA=$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
DIRTY=$([ -n "$(git status --porcelain 2>/dev/null)" ] && echo " (工作区有未提交改动)" || echo "")
NAME="copilot-cc-$(date +%Y%m%d)-${SHA}"
STAGE=$(mktemp -d)
mkdir -p "$STAGE/$NAME"

say "组装 $NAME"
cp -a dist-standalone "$STAGE/$NAME/dist"
cp deploy/install.sh deploy/copilot-api.service deploy/settings.template.json \
   deploy/README.md "$STAGE/$NAME/"
chmod +x "$STAGE/$NAME/install.sh"

cat > "$STAGE/$NAME/VERSION" <<EOF
copilot-api patched — 免构建部署包
来源  : $BRANCH @ $SHA$DIRTY
打包  : $(date -Is) on $(hostname)
node  : $(node --version 2>/dev/null || echo '?')
bun   : $(bun --version 2>/dev/null || echo '?')
产物  : dist/ 为 noExternal 自包含构建，不需要 node_modules

用法  : bash install.sh
补丁说明见仓库 PATCH_NOTES.md（本包不含源码）。
EOF

tar czf "$OUT_DIR/$NAME.tar.gz" -C "$STAGE" "$NAME"
rm -rf "$STAGE"

printf '\n\033[1;32m打好了\033[0m：%s (%s)\n' "$OUT_DIR/$NAME.tar.gz" \
  "$(du -h "$OUT_DIR/$NAME.tar.gz" | cut -f1)"
echo "目标机器上：tar xzf $NAME.tar.gz && cd $NAME && bash install.sh"

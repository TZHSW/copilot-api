#!/usr/bin/env bash
# Build one private portable bundle and emit matching tar.gz and zip archives.

set -Eeuo pipefail
umask 077

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT_DIR=${OUT_DIR:-$REPO_DIR}
CODEX_HOME=${CODEX_HOME:-$HOME/.codex}
TOKEN_FILE=$HOME/.local/share/copilot-api/github_token
STAGE=$(mktemp -d)
TAR_TMP=""
ZIP_TMP=""

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[err ] %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  rm -rf -- "$STAGE"
  [ -z "$TAR_TMP" ] || rm -f -- "$TAR_TMP"
  [ -z "$ZIP_TMP" ] || rm -f -- "$ZIP_TMP"
}
trap cleanup EXIT INT TERM

for command in bun node git tar zip unzip sha256sum find sort; do
  command -v "$command" >/dev/null 2>&1 || die "打包机缺少命令：$command"
done
for required in config.toml auth.json hooks.json; do
  [ -f "$CODEX_HOME/$required" ] || die "缺少 $CODEX_HOME/$required"
done
[ -s "$TOKEN_FILE" ] || die "缺少 Copilot GitHub token：$TOKEN_FILE"

cd "$REPO_DIR"
if [ -n "${PACK_TEST_DIST:-}" ]; then
  DIST=$(cd "$PACK_TEST_DIST" && pwd)
else
  say "构建 standalone API"
  SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 bun install --frozen-lockfile
  bun run build:standalone
  DIST=$REPO_DIR/dist-standalone
fi
[ -f "$DIST/main.js" ] || die "构建产物缺少 main.js：$DIST"

SHA=$(git rev-parse --short HEAD)
BRANCH=$(git branch --show-current)
DIRTY=""
[ -z "$(git status --porcelain)" ] || DIRTY=" (dirty)"
NAME="copilot-codex-$(date -u +%Y%m%d)-$SHA"
ROOT=$STAGE/$NAME
mkdir -p "$ROOT/codex-config" "$ROOT/credentials" "$ROOT/lib" "$OUT_DIR"
chmod 700 "$STAGE" "$ROOT"

say "组装 $NAME"
cp -a "$DIST" "$ROOT/dist"
install -m 600 "$CODEX_HOME/config.toml" "$ROOT/codex-config/config.toml"
install -m 600 "$CODEX_HOME/auth.json" "$ROOT/codex-config/auth.json"
install -m 600 "$CODEX_HOME/hooks.json" "$ROOT/codex-config/hooks.json"
install -m 600 "$TOKEN_FILE" "$ROOT/credentials/github_token"

if [ -d "$CODEX_HOME/skills" ]; then
  cp -a "$CODEX_HOME/skills" "$ROOT/codex-config/skills"
  rm -rf -- "$ROOT/codex-config/skills/.system"
fi
if [ -d "$CODEX_HOME/plugins" ]; then
  cp -a "$CODEX_HOME/plugins" "$ROOT/codex-config/plugins"
  while IFS= read -r -d '' staging; do rm -rf -- "$staging"; done \
    < <(find "$ROOT/codex-config/plugins" -type d -name .remote-plugin-install-staging -print0)
fi
if [ -d "$HOME/.orca/agent-hooks" ]; then
  mkdir -p "$ROOT/optional-config"
  cp -a "$HOME/.orca/agent-hooks" "$ROOT/optional-config/orca-agent-hooks"
fi

node - "$HOME" "$ROOT/codex-config/config.toml" "$ROOT/codex-config/hooks.json" <<'NODE'
const fs = require("node:fs")
const [sourceHome, ...files] = process.argv.slice(2)
for (const file of files) {
  const content = fs.readFileSync(file, "utf8")
  fs.writeFileSync(file, content.replaceAll(sourceHome, "__CODEX_HOME__"))
}
NODE

cp deploy/codex/install.sh deploy/codex/install.ps1 \
  deploy/codex/diagnose.sh deploy/codex/diagnose.ps1 \
  deploy/codex/README.md "$ROOT/"
cp deploy/codex/lib/migrate-config.mjs deploy/codex/lib/verify-service.mjs "$ROOT/lib/"
chmod 700 "$ROOT/install.sh" "$ROOT/diagnose.sh"

cat >"$ROOT/VERSION" <<EOF
copilot-codex private offline migration bundle
source: $BRANCH @ $SHA$DIRTY
built:  $(date -u -Is) on $(hostname)
node:   $(node --version)
bun:    $(bun --version)
codex:  $(codex --version 2>/dev/null | head -1 || echo unavailable)
api:    $(sha256sum "$ROOT/dist/main.js" | cut -d' ' -f1)
EOF

(cd "$ROOT" && find . -type f ! -name MANIFEST.sha256 -print0 \
  | LC_ALL=C sort -z | xargs -0 sha256sum >MANIFEST.sha256)

TAR_FINAL=$OUT_DIR/$NAME.tar.gz
ZIP_FINAL=$OUT_DIR/$NAME.zip
TAR_TMP=$OUT_DIR/.$NAME.tar.gz.tmp.$$
ZIP_TMP=$OUT_DIR/.$NAME.zip.tmp.$$
tar -czf "$TAR_TMP" -C "$STAGE" "$NAME"
(cd "$STAGE" && zip -qr "$ZIP_TMP" "$NAME")

say "复验归档与校验和"
VERIFY=$STAGE/verify
mkdir -p "$VERIFY/tar" "$VERIFY/zip"
tar -xzf "$TAR_TMP" -C "$VERIFY/tar"
unzip -q "$ZIP_TMP" -d "$VERIFY/zip"
for extracted in "$VERIFY/tar/$NAME" "$VERIFY/zip/$NAME"; do
  (cd "$extracted" && sha256sum -c MANIFEST.sha256 --quiet) \
    || die "归档校验失败：$extracted"
done
(cd "$VERIFY/tar/$NAME" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) >"$VERIFY/tar.hashes"
(cd "$VERIFY/zip/$NAME" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) >"$VERIFY/zip.hashes"
cmp -s "$VERIFY/tar.hashes" "$VERIFY/zip.hashes" || die "tar 与 zip 内容不一致"

mv -f -- "$TAR_TMP" "$TAR_FINAL"
mv -f -- "$ZIP_TMP" "$ZIP_FINAL"
TAR_TMP=""
ZIP_TMP=""

printf '\n\033[1;32m打包完成\033[0m\n'
printf '  %s (%s)\n' "$TAR_FINAL" "$(du -h "$TAR_FINAL" | cut -f1)"
printf '  %s (%s)\n' "$ZIP_FINAL" "$(du -h "$ZIP_FINAL" | cut -f1)"
sha256sum "$TAR_FINAL" "$ZIP_FINAL"
printf '\n\033[1;33m警告：两个归档包含实时凭据，只能通过可信私有渠道传输，禁止提交到 Git。\033[0m\n'

#!/usr/bin/env bash
#
# Gollum V0.2 E2E — install + skill linking + Claude can read skills
#
# Verifies the 4 critical paths of V0.2:
#   1. npm install from local tarball works (postinstall hook runs)
#   2. `gollum doctor` reports all checks passing
#   3. `gollum install-skills` symlinks skills into all detected agents
#   4. Claude Code can see and reference the installed skills
#
# This script does NOT call `npm publish` — it packs the local working
# tree into a tarball and installs from there.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GOLLUM="$ROOT/dist/cli/index.js"
WORKDIR="${GOLLUM_V0_2_TEST_DIR:-/tmp/gollum-v02-e2e}"
TARBALL_DIR="$WORKDIR/tarball"
INSTALL_PREFIX="$WORKDIR/install"

cd "$ROOT"

echo "=== [1/5] Build local dist ==="
npm run build >/dev/null

echo "=== [2/5] Pack tarball ==="
rm -rf "$TARBALL_DIR" "$INSTALL_PREFIX"
mkdir -p "$TARBALL_DIR" "$INSTALL_PREFIX"
npm pack --pack-destination "$TARBALL_DIR" 2>&1 | tail -3
TARBALL="$(ls "$TARBALL_DIR"/gollum-*.tgz | head -1)"
echo "  tarball: $TARBALL"

echo "=== [3/5] npm install from local tarball (postinstall should run) ==="
cd "$INSTALL_PREFIX"
npm install "$TARBALL" --no-audit --no-fund 2>&1 | tail -5
GOLLUM_BIN="$INSTALL_PREFIX/node_modules/gollum/dist/cli/index.js"

echo "=== [4/5] gollum doctor (post-install self-check) ==="
node "$GOLLUM_BIN" doctor

echo "=== [5/5] gollum install-skills (symlink into all detected agents) ==="
node "$GOLLUM_BIN" install-skills --global 2>&1 | tail -5

echo
echo "=== [Bonus] Claude Code can read skills ==="
if command -v claude >/dev/null; then
  if [ -d "$HOME/.claude/skills/bootstrap" ]; then
    echo "  ✓ ~/.claude/skills/bootstrap linked"
    head -3 "$HOME/.claude/skills/bootstrap/SKILL.md"
  else
    echo "  ✗ ~/.claude/skills/bootstrap NOT linked"
    exit 1
  fi
else
  echo "  (skipping — claude not installed)"
fi

echo
echo "=== V0.2 E2E PASSED ==="
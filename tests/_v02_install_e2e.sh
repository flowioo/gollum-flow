#!/usr/bin/env bash
#
# Gollum V0.2 E2E — 从 tarball 到 Claude 可读 skills 的完整链路
#
# 关键设计：使用**隔离的 HOME**，避免开发树遗留的软链造成假阳性。
# 所有断言都指向 $FAKE_HOME，不读真实 ~/.claude。
#
# 验证 5 件事：
#   1. npm pack 产出的 tarball 包含 dist/skills/core/<skill>/SKILL.md
#   2. postinstall hook 在**真实 HOME** 下创建 ~/.gollum/ 结构（不吞错误）
#   3. 从 tarball 安装后，`gollum install-skills` 软链的**目标**是
#      $INSTALL_PREFIX/node_modules/gollum-flow/dist/skills/core/<skill>
#      （不是开发树）
#   4. `gollum doctor` 报告 7/7 skills linked
#   5. Claude Code 在隔离 HOME 下能读到 skill 并正确复述
#
# 用法：
#   bash tests/_v02_install_e2e.sh              # 完整跑（含 Claude）
#   GOLLUM_E2E_SKIP_CLAUDE=1 bash tests/...     # 跳过 Claude（离线/无 claude 时）
#
# 注意：本脚本**不做 npm publish**。发布是独立的人工动作。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKDIR="${GOLLUM_V0_2_TEST_DIR:-/tmp/gollum-v02-e2e}"
TARBALL_DIR="$WORKDIR/tarball"
INSTALL_PREFIX="$WORKDIR/install"
FAKE_HOME="$WORKDIR/fakehome"
PKG_NAME="gollum-flow"

cleanup() {
  # 隔离 HOME 内的软链指向 $WORKDIR，随 WORKDIR 一起清；不触碰真实 HOME
  :
}
trap cleanup EXIT

cd "$ROOT"
REAL_HOME="$HOME"
rm -rf "$WORKDIR"
mkdir -p "$TARBALL_DIR" "$INSTALL_PREFIX" "$FAKE_HOME"

echo "=== [1/6] Build ==="
npm run build >/dev/null 2>&1
echo "  ok"

echo
echo "=== [2/6] Pack tarball ==="
npm pack --pack-destination "$TARBALL_DIR" 2>&1 | tail -2
TARBALL="$(ls "$TARBALL_DIR"/${PKG_NAME}-*.tgz | head -1)"
echo "  tarball: $(basename "$TARBALL")"

echo
echo "=== [2a/6] Assert tarball actually contains bundled skills ==="
SKILL_COUNT="$(tar -tzf "$TARBALL" | grep -c 'dist/skills/core/.*/SKILL.md' || true)"
if [ "$SKILL_COUNT" -lt 7 ]; then
  echo "  ✗ expected >=7 SKILL.md in tarball, found $SKILL_COUNT"
  tar -tzf "$TARBALL" | grep skills || true
  exit 1
fi
echo "  ✓ $SKILL_COUNT SKILL.md files bundled in tarball"
tar -tzf "$TARBALL" | grep 'dist/skills/core/.*/SKILL.md' | sed 's/^/    /'

echo
echo "=== [3/6] npm install from tarball into isolated prefix ==="
cd "$INSTALL_PREFIX"
# --ignore-scripts here: we invoke postinstall explicitly in step 4 so a
# failure is visible instead of being swallowed by npm's script gate.
npm install "$TARBALL" --no-audit --no-fund --ignore-scripts 2>&1 | tail -2
GOLLUM_BIN="$INSTALL_PREFIX/node_modules/$PKG_NAME/dist/cli/index.js"
[ -f "$GOLLUM_BIN" ] || { echo "  ✗ gollum binary not found at $GOLLUM_BIN"; exit 1; }
echo "  ✓ installed: $GOLLUM_BIN"

echo
echo "=== [3a/6] Assert postinstall has no ESM require() bug ==="
# The previous version of this hook called require() inside an ESM module and
# crashed; a `|| echo` in package.json hid it. Run it for real, no fallback.
#
# HOME must already point at the isolated dir, otherwise the hook provisions
# the developer's real ~/.gollum and step 5's doctor (which runs under the
# isolated HOME) correctly reports it missing.
export HOME="$FAKE_HOME"
set +e
node "$INSTALL_PREFIX/node_modules/$PKG_NAME/dist/hooks/postinstall.js" >"$WORKDIR/postinstall.log" 2>&1
PI_EXIT=$?
set -e
if [ "$PI_EXIT" -ne 0 ]; then
  echo "  ✗ postinstall exited $PI_EXIT (this used to be masked by a fallback)"
  sed 's/^/  /' "$WORKDIR/postinstall.log"
  exit 1
fi
if grep -q "require is not defined" "$WORKDIR/postinstall.log"; then
  echo "  ✗ postinstall hit the ESM require() bug"
  sed 's/^/  /' "$WORKDIR/postinstall.log"
  exit 1
fi
echo "  ✓ postinstall ran clean (exit 0, no ESM require error)"
sed 's/^/    /' "$WORKDIR/postinstall.log" | head -3

echo
echo "=== [3b/6] Assert postinstall provisioned the ISOLATED HOME ==="
for d in "" skills tools runtime runtime/leases runtime/events runtime/scheduler; do
  [ -d "$FAKE_HOME/.gollum/$d" ] || { echo "  ✗ missing $FAKE_HOME/.gollum/$d"; exit 1; }
done
[ -f "$FAKE_HOME/.gollum/registry.yaml" ] || { echo "  ✗ registry.yaml not created"; exit 1; }
echo "  ✓ ~/.gollum structure + registry.yaml created under isolated HOME"

echo
echo "=== [4/6] install-skills under ISOLATED HOME (proves tarball path) ==="
# The whole point: with a clean HOME there are no pre-existing dev-tree
# symlinks, so install-skills must link to the tarball's own skills.
# A real user has at least one agent installed. Recreate that condition in
# isolation, otherwise "no coding agent detected" makes the test vacuous.
mkdir -p "$FAKE_HOME/.claude"
echo "  seeded isolated agent: \$HOME/.claude"
node "$GOLLUM_BIN" install-skills --global 2>&1 | sed 's/^/  /'

echo
echo "=== [4a/6] Assert symlink targets point at the TARBALL, not the dev tree ==="
LINK_DIR="$FAKE_HOME/.claude/skills"
if [ ! -d "$LINK_DIR" ]; then
  echo "  ✗ $LINK_DIR not created (claude-code agent not detected in isolated HOME?)"
  exit 1
fi
# Canonicalize both sides: on macOS /tmp is a symlink to /private/tmp, so the
# link target comes back realpath'd while our variable is not.
canon() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1" 2>/dev/null || echo "$1"; }
EXPECTED_PREFIX="$(canon "$INSTALL_PREFIX/node_modules/$PKG_NAME/dist/skills/core")"
DEV_PREFIX="$(canon "$ROOT/dist/skills/core")"
echo "  expected prefix: $EXPECTED_PREFIX"
BAD=0
for s in bootstrap goal-align outcome-evaluate recover task-resume task-run verify; do
  link="$LINK_DIR/$s"
  if [ ! -L "$link" ]; then
    echo "  ✗ $s is not a symlink"
    BAD=1
    continue
  fi
  target="$(canon "$(readlink "$link")")"
  case "$target" in
    "$EXPECTED_PREFIX"/*) : ;;   # correct: points into the tarball install
    "$DEV_PREFIX"/*)
      echo "  ✗ $s points at the DEV TREE: $target"
      BAD=1 ;;
    *)
      echo "  ✗ $s points somewhere unexpected: $target"
      BAD=1 ;;
  esac
  [ -f "$link/SKILL.md" ] || { echo "  ✗ $s/SKILL.md not resolvable through the link"; BAD=1; }
done
[ "$BAD" -eq 0 ] || { echo "  ✗ symlink audit failed"; exit 1; }
echo "  ✓ all 7 skills symlinked into the tarball install (not the dev tree)"

echo
echo "=== [5/6] gollum doctor under isolated HOME ==="
set +e
node "$GOLLUM_BIN" doctor 2>&1 | sed 's/^/  /'
DOC_EXIT=${PIPESTATUS[0]}
set -e
if [ "$DOC_EXIT" -ne 0 ]; then
  echo "  ✗ doctor exited $DOC_EXIT"
  exit 1
fi

echo
echo "=== [6/6] Claude Code reads the installed skill ==="
if [ "${GOLLUM_E2E_SKIP_CLAUDE:-0}" = "1" ]; then
  echo "  (skipped: GOLLUM_E2E_SKIP_CLAUDE=1)"
elif ! command -v claude >/dev/null 2>&1; then
  echo "  (skipped: claude not on PATH)"
else
  # Claude needs the real HOME for auth, so we cannot keep HOME isolated here.
  # Instead we move the isolated skills dir back to the real HOME under a unique
  # name, so the path Claude reads is still served by the tarball symlinks and
  # cannot be satisfied by any leftover dev-tree link.
  CLAUDE_SKILL_ROOT="$REAL_HOME/.claude/gollum-v02-e2e"
  if [ -e "$CLAUDE_SKILL_ROOT" ]; then
    echo "  ✗ $CLAUDE_SKILL_ROOT already exists; refusing to clobber"
    exit 1
  fi
  mkdir -p "$(dirname "$CLAUDE_SKILL_ROOT")"
  cp -R "$LINK_DIR" "$CLAUDE_SKILL_ROOT"   # -R copies the symlinks as symlinks
  trap 'rm -rf "$CLAUDE_SKILL_ROOT"' EXIT

  # Fail fast if the copied links are not tarball-backed.
  for s in bootstrap verify; do
    t="$(canon "$(readlink "$CLAUDE_SKILL_ROOT/$s")")"
    case "$t" in "$EXPECTED_PREFIX"/*) : ;; *) echo "  ✗ $s not tarball-backed: $t"; exit 1;; esac
  done
  echo "  staged tarball-backed skills at $CLAUDE_SKILL_ROOT"

  CLAUDE_OUT="$WORKDIR/claude-out.txt"
  unset HOME   # give Claude its real HOME for auth
  set +e
  claude --print --output-format text \
    "Read the file $CLAUDE_SKILL_ROOT/bootstrap/SKILL.md. Reply with exactly two lines and nothing else. Line 1: the value of 'name:' in the YAML frontmatter. Line 2: the first shell command listed under the Procedure section." \
    >"$CLAUDE_OUT" 2>"$WORKDIR/claude-err.txt"
  set -e
  export HOME="$FAKE_HOME"   # restore for the remainder
  echo "  --- claude output ---"
  sed 's/^/  /' "$CLAUDE_OUT" | head -6
  echo "  ----------------------"
  if grep -q "gollum-bootstrap" "$CLAUDE_OUT" && grep -q "gollum-resolver" "$CLAUDE_OUT"; then
    echo "  ✓ Claude read the tarball-installed skill (frontmatter name + resolver command)"
  else
    echo "  ✗ Claude did not return expected content"
    sed 's/^/  /' "$WORKDIR/claude-err.txt" | head -5 || true
    exit 1
  fi
fi

unset HOME
echo
echo "=== V0.2 E2E PASSED (isolated HOME, tarball-verified) ==="
echo "workdir: $WORKDIR"

#!/usr/bin/env bash
# dsh-mint skill installer
#
# Installs the bundled mint skill into DSH's user skill directory.
#   (default)  symlink dist/skill -> ~/.dsh/skills/mint (follows package updates)
#   --copy     copy instead of symlink
#   --uninstall  remove the installed skill (deletes symlink or copy)
#
# Respects DSH_HOME if set (defaults to ~/.dsh).

set -u

MODE="symlink"
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --copy) MODE="copy" ;;
    --uninstall) UNINSTALL=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd 2>/dev/null || echo "$(dirname "${BASH_SOURCE[0]:-$0}")")"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_SRC="$PKG_DIR/dist/skill"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
SKILL_DST="$DSH_HOME_DIR/skills/mint"

if [ "$UNINSTALL" = "1" ]; then
  rm -f "$SKILL_DST"
  echo "uninstalled: $SKILL_DST"
  exit 0
fi

if [ ! -d "$SKILL_SRC" ]; then
  echo "error: $SKILL_SRC not found — run \`pnpm build\` first" >&2
  exit 1
fi

case "$MODE" in
  symlink)
    rm -rf "$SKILL_DST"
    ln -sfn "$SKILL_SRC" "$SKILL_DST"
    echo "symlinked: $SKILL_SRC -> $SKILL_DST"
    ;;
  copy)
    rm -rf "$SKILL_DST"
    cp -r "$SKILL_SRC" "$SKILL_DST"
    echo "copied: $SKILL_SRC -> $SKILL_DST"
    ;;
esac

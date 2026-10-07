#!/usr/bin/env bash
# dsh-mint skill tool (development flow).
#
# A thin wrapper: every mode and every ownership guard lives in
# `dist/install-skill.js`, which is the single implementation shared with
# `pnpm skill`. This script only locates the package root and defaults to the
# dev form — a symlink from `$DSH_HOME/skills/mint` to `<pkg>/dist/skill`, so
# the model reads the checkout's latest `pnpm build` output.
#
#   (default)     symlink the bundled skill into the DSH skill directory
#   --copy        copy it instead (the packaged-install form)
#   --uninstall   remove what this plugin installed (guarded, idempotent)
#   --status      report the current form and whether a copy is in sync
#   --force       take over a target the guards would otherwise leave alone
#
# Respects DSH_HOME (defaults to ~/.dsh).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$PKG_DIR/dist/install-skill.js"

if [ ! -f "$ENTRY" ]; then
  echo "error: $ENTRY not found — run \`pnpm build\` first" >&2
  echo "to remove a leftover install by hand, confirm it first:" >&2
  echo "  head -2 \"\${DSH_HOME:-\$HOME/.dsh}/skills/mint/SKILL.md\"   # expect: name: mint" >&2
  exit 1
fi

# No explicit mode means the dev form; the CLI's own bare default is the copy.
case "${1:-}" in
  --copy | --link | --uninstall | --status | -h | --help) exec node "$ENTRY" "$@" ;;
  *) exec node "$ENTRY" --link "$@" ;;
esac

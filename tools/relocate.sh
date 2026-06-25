#!/usr/bin/env bash
# Move this project to a new location AND migrate Claude Code's per-project data
# (auto-memory + session transcripts) so that a Claude Code session opened at the
# new location can /resume this conversation with full context and memory intact.
#
# Claude stores per-project data in ~/.claude/projects/<slug>/ where <slug> is the
# absolute project path with every "/" replaced by "-". Moving the folder changes
# that slug, so we copy the data to the new slug.
#
# Run from a terminal (NOT inside the Claude chat you want to keep — moving the
# folder breaks that live session). From the current project root:
#   bash tools/relocate.sh <new-project-path>
#   bash tools/relocate.sh --dry-run <new-project-path>
#
# <new-project-path> is the FULL final path of the project folder, e.g.
#   ../ChromeExtentions/pulldownqr   (move INTO a ChromeExtentions folder)
#   ../ChromeExtentions              (rename the folder to ChromeExtentions)
set -euo pipefail

DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
DEST_ARG="${1:-}"
[ -n "$DEST_ARG" ] || { echo "usage: bash tools/relocate.sh [--dry-run] <new-project-path>"; exit 1; }

# Pure-shell absolute-path resolver (works for paths that don't exist yet;
# collapses "." and ".."). Relative paths resolve against the current directory.
abspath() {
  local p="$1" out="" seg
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  local IFS='/'
  for seg in $p; do
    case "$seg" in
      ''|.) ;;
      ..)   out="${out%/*}" ;;
      *)    out="$out/$seg" ;;
    esac
  done
  printf '%s' "${out:-/}"
}

SRC="$(cd "$(dirname "$0")/.." && pwd)"   # current project root (absolute)
DEST="$(abspath "$DEST_ARG")"

slug() { printf '%s' "$1" | sed 's:/:-:g'; }   # Claude project-dir encoding
PROJ="$HOME/.claude/projects"
OLD_SLUG="$(slug "$SRC")"
NEW_SLUG="$(slug "$DEST")"

echo "Project : $SRC"
echo "      -> $DEST"
echo "Claude  : $PROJ/$OLD_SLUG"
echo "      -> $PROJ/$NEW_SLUG"

[ "$SRC" = "$DEST" ] && { echo "Source equals destination — nothing to do."; exit 0; }
[ -e "$DEST" ] && { echo "ERROR: destination already exists: $DEST"; exit 1; }

if [ "$DRY" = "1" ]; then
  echo
  echo "(dry-run) would copy: $PROJ/$OLD_SLUG  ->  $PROJ/$NEW_SLUG"
  echo "(dry-run) would move: $SRC  ->  $DEST"
  exit 0
fi

# 1) Migrate Claude per-project data first (project still in place = safe).
if [ -d "$PROJ/$OLD_SLUG" ]; then
  if [ -e "$PROJ/$NEW_SLUG" ]; then
    cp -R "$PROJ/$OLD_SLUG/." "$PROJ/$NEW_SLUG/"
  else
    cp -R "$PROJ/$OLD_SLUG" "$PROJ/$NEW_SLUG"
  fi
  echo "Migrated Claude data (memory + session transcripts)."
else
  echo "WARN: Claude data dir not found at $PROJ/$OLD_SLUG (skipping)."
fi

# 2) Move the project folder (rename keeps open file descriptors valid).
mkdir -p "$(dirname "$DEST")"
mv "$SRC" "$DEST"
echo "Moved project folder."

cat <<EOF

Done.

Continue this conversation at the new location:
  cd "$DEST"
  claude            # then type /resume and choose this conversation

The old Claude data dir is kept as a backup. After you confirm /resume works:
  rm -rf "$PROJ/$OLD_SLUG"

Tip: to pull in the very latest messages of this chat before /resume, run:
  cp "$PROJ/$OLD_SLUG"/*.jsonl "$PROJ/$NEW_SLUG"/ 2>/dev/null || true
EOF

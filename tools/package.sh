#!/usr/bin/env bash
# Build a Chrome Web Store package zip containing only the runtime files
# (manifest + src + icons). Dev-only dirs (test, tools, docs) are excluded.
# Usage: bash tools/package.sh   ->   dist/pulldownqr-v<version>.zip
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/pulldownqr-v${VERSION}.zip"

mkdir -p dist
rm -f "$OUT"

# manifest.json must sit at the zip root. -X drops extra attributes; exclude
# macOS junk just in case.
zip -r -X "$OUT" manifest.json src icons \
  -x '*.DS_Store' >/dev/null

echo "Created $OUT"
echo "--- contents ---"
unzip -l "$OUT"

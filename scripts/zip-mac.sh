#!/usr/bin/env bash
# Zips the macOS app bundles built on Linux. electron-builder's own zip step
# turns the framework symlinks into copies (3x size, broken bundle); `zip -y`
# keeps them as symlinks.
set -euo pipefail
cd "$(dirname "$0")/../dist"
version=$(node -p "require('../package.json').version")
for dir in mac-arm64:arm64 mac:x64; do
  src=${dir%%:*}; arch=${dir##*:}
  [[ -d "$src/Shellfish.app" ]] || continue
  out="Shellfish-$version-mac-$arch.zip"
  rm -f "$out"
  (cd "$src" && zip -qry "../$out" Shellfish.app)
  echo "built dist/$out"
done

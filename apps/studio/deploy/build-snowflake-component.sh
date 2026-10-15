#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
#  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
#---------------------------------------------------------------------------------------------

# Build the on-demand "driver component" bundle for Snowflake and print its sha256 + size for
# src/main/componentStore.ts. This is NOT shipped in the installer; it's uploaded as an asset on the
# public feed repo (snoutdata/studio, release tag components-v1) and the app downloads it the first time
# a user connects to a Snowflake connection.
#
#   - snowflake-<ver>.zip : a self-contained node_modules with snowflake-sdk AND its full runtime
#                           dependency tree (~95 MB on disk; @azure / @aws-sdk / moment dominate).
#                           Extracts to node_modules/; the app require()s node_modules/snowflake-sdk.
#
# Unlike Db2, snowflake-sdk is PURE JS: the bundle is platform-independent (one zip serves every
# OS/arch) and loads in-process — no node22 runtime, no sidecar, no native rebuild. Run from
# apps/studio. Windows + Git Bash (or any platform with zip).
set -euo pipefail

SNOW_VER="3.0.0"      # keep in sync with package.json devDependency + componentStore version label
OUT="$(pwd)/release/components"

mkdir -p "$OUT"
SNOW_ZIP="$OUT/snowflake-1.0.0.zip"   # 1.0.0 = our COMPONENT version, not the sdk version
rm -f "$SNOW_ZIP"

# Isolated PRODUCTION install of snowflake-sdk so its full runtime dependency tree is co-located —
# the app resolves node_modules/snowflake-sdk and its deps must resolve as siblings.
echo "Isolated install of snowflake-sdk@${SNOW_VER} (downloads the full dependency tree)…"
PKG="$(mktemp -d)"
( cd "$PKG" && npm init -y >/dev/null 2>&1 && npm install "snowflake-sdk@${SNOW_VER}" --omit=dev --no-audit --no-fund >/dev/null 2>&1 )
[ -d "$PKG/node_modules/snowflake-sdk" ] || { echo "isolated snowflake-sdk install failed"; exit 1; }

echo "Packing snowflake bundle (node_modules tree, ~95 MB, takes a moment)…"
if command -v powershell.exe >/dev/null 2>&1; then
	powershell.exe -NoProfile -Command "Compress-Archive -Path '$(cygpath -w "$PKG/node_modules")' -DestinationPath '$(cygpath -w "$SNOW_ZIP")' -Force"
else
	( cd "$PKG" && zip -qr "$SNOW_ZIP" node_modules )
fi
rm -rf "$PKG"

echo
echo "=== bundle → $OUT ==="
bytes=$(stat -c %s "$SNOW_ZIP" 2>/dev/null || stat -f %z "$SNOW_ZIP")
sha=$(sha256sum "$SNOW_ZIP" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$SNOW_ZIP" | cut -d' ' -f1)
printf '%s\n  bytes:  %s\n  sha256: %s\n' "$(basename "$SNOW_ZIP")" "$bytes" "$sha"
echo
echo "Upload to snoutdata/studio release components-v1, then paste bytes+sha256 into componentStore.ts"
echo "(replace the __snowflake__ placeholder for every platform key)."

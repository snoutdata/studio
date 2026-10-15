#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
#  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
#---------------------------------------------------------------------------------------------

# Build the on-demand "native driver component" bundles for Db2 (Windows x64) and print their
# sha256 + sizes for src/main/componentStore.ts. These are NOT shipped in the installer; they're
# uploaded as assets on the public feed repo (snoutdata/studio, release tag components-v1) and the app
# downloads them the first time a user connects to Db2.
#
#   - node22-<ver>-win32-x64.zip : a stock Node runtime (just node.exe) to host the ibm_db sidecar
#                                  (Electron's ABI can't load ibm_db). Extracts to node.exe at root.
#   - ibm_db-<ver>-win32-x64.zip : a self-contained node_modules with ibm_db AND its runtime deps
#                                  (ibm_db's odbc.js requires 'bindings', a sibling) and the built
#                                  binary, WITHOUT IBM's clidriver. Extracts to node_modules/.
#
# IBM's ODBC/CLI driver (clidriver) is NOT in our zip and is not put back: the app downloads it
# from IBM's own server at install time, used under IBM's licence, pinned to one version folder
# and one SHA-256 (IBM_CLI_DRIVER_WIN32_X64 in src/main/componentVendors.ts), and unpacks it into
# node_modules/ibm_db/installer/, which is where ibm_db looks for it. The npm install below still
# fetches a clidriver, because ibm_db needs its headers and libraries to BUILD the addon; it is
# deleted before packing.
#
# Prereqs: the project Node 22 on PATH (so the native addon builds for ABI 127). Run from
# apps/studio. Windows + Git Bash. NODE22_EXE names the node.exe to pack, if it is not in the
# default folder below.
set -euo pipefail

NODE_VER="22.22.1"
DB2_VER="3.3.5"
NODE_EXE="${NODE22_EXE:-$(cygpath -u "${LOCALAPPDATA:?LOCALAPPDATA is not set (run this on Windows, in Git Bash)}")/positron-node/node-v${NODE_VER}-win-x64/node.exe}"
OUT="$(pwd)/release/components"

[ -f "$NODE_EXE" ] || { echo "node.exe not found at $NODE_EXE"; exit 1; }

mkdir -p "$OUT"
NODE_ZIP="$OUT/node22-${NODE_VER}-win32-x64.zip"
DB2_ZIP="$OUT/ibm_db-${DB2_VER}-win32-x64.zip"
rm -f "$NODE_ZIP" "$DB2_ZIP"

echo "Packing node22 bundle (node.exe)…"
powershell.exe -NoProfile -Command "Compress-Archive -LiteralPath '$(cygpath -w "$NODE_EXE")' -DestinationPath '$(cygpath -w "$NODE_ZIP")' -Force"

# Isolated PRODUCTION install of ibm_db so its full runtime dependency tree (bindings, etc.) is
# co-located — the app resolves node_modules/ibm_db/lib/odbc.js and 'bindings' must resolve as its
# sibling. A bare copy of our own node_modules/ibm_db would miss the hoisted siblings.
echo "Isolated install of ibm_db@${DB2_VER} (downloads clidriver + builds the addon for node ${NODE_VER})…"
PKG="$(mktemp -d)"
( cd "$PKG" && npm init -y >/dev/null 2>&1 && npm install "ibm_db@${DB2_VER}" --omit=dev --no-audit --no-fund >/dev/null 2>&1 && npm rebuild ibm_db >/dev/null 2>&1 )
[ -f "$PKG/node_modules/ibm_db/lib/odbc.js" ] || { echo "isolated ibm_db install failed"; exit 1; }
[ -d "$PKG/node_modules/bindings" ] || { echo "WARNING: 'bindings' not present in isolated install"; }

# IBM's driver stays out of what we host (see the header).
rm -rf "$PKG/node_modules/ibm_db/installer/clidriver"
[ ! -e "$PKG/node_modules/ibm_db/installer/clidriver" ] || { echo "could not remove IBM's clidriver from the bundle"; exit 1; }

echo "Packing ibm_db bundle (node_modules tree, without IBM's clidriver)…"
powershell.exe -NoProfile -Command "Compress-Archive -Path '$(cygpath -w "$PKG/node_modules")' -DestinationPath '$(cygpath -w "$DB2_ZIP")' -Force"
rm -rf "$PKG"

echo
echo "=== bundles → $OUT ==="
for z in "$NODE_ZIP" "$DB2_ZIP"; do
	bytes=$(stat -c %s "$z")
	sha=$(sha256sum "$z" | cut -d' ' -f1)
	printf '%s\n  bytes:  %s\n  sha256: %s\n' "$(basename "$z")" "$bytes" "$sha"
done

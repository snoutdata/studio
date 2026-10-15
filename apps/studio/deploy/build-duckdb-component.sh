#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
#  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
#---------------------------------------------------------------------------------------------

# Build the on-demand "driver component" bundles for DuckDB and print each one's sha256 + size for
# src/main/componentStore.ts. These are NOT shipped in the installer; they're uploaded as assets on
# the public feed repo (snoutdata/studio, release tag components-v1) and the app downloads the one for
# the user's OS/arch the first time they connect to a DuckDB connection.
#
#   - duckdb-<ver>-<platform>-<arch>.zip : a self-contained node_modules with @duckdb/node-api,
#       @duckdb/node-bindings, detect-libc, AND the ONE per-platform native binding package
#       (@duckdb/node-bindings-<platform>-<arch>, which carries duckdb.node + the big libduckdb
#       shared library). Extracts to node_modules/; the app require()s node_modules/@duckdb/node-api,
#       which resolves the native binding as a sibling.
#
# Unlike Snowflake (pure JS, one zip for all), DuckDB's native binding is per-arch, so there is one
# zip PER platform. Unlike Db2, @duckdb/node-api is N-API (ABI-stable), so it loads in-process in the
# Electron server child — no node22 sidecar. The bundles are built with `zip -r` (forward-slash entry
# paths), so a single set works on Windows (Expand-Archive), macOS and Linux (unzip) alike — no
# win32-only limitation like the Db2/Snowflake zips. npm's --os/--cpu/--libc fetch each platform's
# PREBUILT binding regardless of the host, so every bundle can be built from one machine. Run from
# apps/studio (needs npm 10+ and zip).
set -euo pipefail

CLIENT_VER="1.5.4-r.1"   # @duckdb/node-api version — keep in sync with package.json devDependency
COMP_VER="1.5.4"         # our COMPONENT version — keep in sync with the duckdb spec in componentStore.ts
OUT="$(pwd)/release/components"
mkdir -p "$OUT"

# Target platforms, one per line: "<os> <cpu> <libc>" (libc only matters for linux: glibc vs musl).
# These mirror componentStore's platformKey = `${process.platform}-${process.arch}`.
TARGETS=(
	"win32 x64 -"
	"darwin arm64 -"
	"darwin x64 -"
	"linux x64 glibc"
)

for target in "${TARGETS[@]}"; do
	read -r OS CPU LIBC <<< "$target"
	KEY="${OS}-${CPU}"
	ZIP="$OUT/duckdb-${COMP_VER}-${KEY}.zip"
	rm -f "$ZIP"

	# Isolated PRODUCTION install with the platform FORCED, so npm fetches that platform's prebuilt
	# native binding (not the host's). --os/--cpu select the optional binding package; --libc picks
	# the glibc (vs musl) linux binding.
	echo "== ${KEY}: isolated install of @duckdb/node-api@${CLIENT_VER} (forcing ${OS}/${CPU}${LIBC:+/$LIBC}) =="
	PKG="$(mktemp -d)"
	LIBC_FLAG=""
	[ "$LIBC" != "-" ] && LIBC_FLAG="--libc=${LIBC}"
	( cd "$PKG" && npm init -y >/dev/null 2>&1 \
		&& npm install "@duckdb/node-api@${CLIENT_VER}" --omit=dev --os="$OS" --cpu="$CPU" $LIBC_FLAG --no-audit --no-fund >/dev/null 2>&1 )

	# Sanity: the api entry AND the platform-specific native binding must both be present, else the
	# bundle would fail to load the engine at runtime.
	[ -d "$PKG/node_modules/@duckdb/node-api" ] || { echo "  FAILED: @duckdb/node-api missing for ${KEY}"; rm -rf "$PKG"; exit 1; }
	[ -d "$PKG/node_modules/@duckdb/node-bindings-${KEY}" ] || { echo "  FAILED: node-bindings-${KEY} missing (wrong platform fetched?)"; rm -rf "$PKG"; exit 1; }

	echo "  packing ${KEY} bundle…"
	( cd "$PKG" && zip -qr "$ZIP" node_modules )
	rm -rf "$PKG"

	bytes=$(stat -c %s "$ZIP" 2>/dev/null || stat -f %z "$ZIP")
	sha=$(sha256sum "$ZIP" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$ZIP" | cut -d' ' -f1)
	printf "  %s\n    bytes:  %s\n    sha256: %s\n\n" "$(basename "$ZIP")" "$bytes" "$sha"
done

echo "=== bundles → $OUT ==="
echo "Upload each to snoutdata/studio release components-v1 (as the release account, never a personal one), then paste"
echo "the url/sha256/bytes into the 'duckdb' spec's bundles map in src/main/componentStore.ts."

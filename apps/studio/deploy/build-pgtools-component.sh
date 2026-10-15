#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
#  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
#---------------------------------------------------------------------------------------------

# Build the on-demand POSTGRES TOOLS bundles a move runs (`pg_dump`, `pg_restore`, `psql`) and
# print each one's sha256 + size for src/main/componentStore.ts. Not shipped in the installer:
# uploaded to snoutdata/studio release components-v1 and downloaded the first time somebody moves a
# database.
#
# Source: theseus-rs/postgresql-binaries, verified against its own .sha256 files. PostgreSQL Licence.
#
# The bundle is the CLIENT only. Upstream is the whole server (extensions, headers, static libs); we
# keep the three tools and the shared libraries they load, laid out as upstream lays them out so the
# rpaths (`$ORIGIN/../lib`, `@loader_path/../lib`) still resolve:
#
#   linux  bin/{pg_dump,pg_restore,psql}  lib/libpq.so*                          (glibc >= 2.34, libssl 3 from the system)
#   macOS  bin/{pg_dump,pg_restore,psql}  lib/{libpq,libssl,libcrypto}*.dylib
#   win    bin/{pg_dump,pg_restore,psql}.exe + every DLL they import, found by walking the imports,
#          plus the Visual C++ runtime DLLs, which upstream does not ship (measured) and a
#          clean Windows does not have. Taken from $VCRT_DIR (a Windows System32 is fine: those
#          three files are redistributable).
#
# Licences: the Windows bundle carries two LGPL-2.1 libraries from upstream, libiconv-2.dll (GNU
# libiconv 1.19) and libintl-9.dll (GNU gettext 0.19.8), read off their version resources in the
# 18.6.0 bundle (17.11.0 carried libiconv 1.15). The open-source tree's NOTICE (at its root)
# names those exact versions, links their source and carries the LGPL written offer, so a VERSION
# bump re-reads them and updates it:
#   python3 -c "import sys;t=open(sys.argv[1],'rb').read().decode('utf-16-le','ignore');i=t.find('ProductVersion');print(t[i:i+40])" bin/libiconv-2.dll
#
# Symlinks: the linux libpq is a link chain (libpq.so.5 -> libpq.so.5.18), and the loader wants the
# SONAME, so this must run on Linux (a container is fine) and zip with -y, which keeps
# the links: flattening or dereferencing them gives a directory with every byte present and nothing
# loadable.
#
# Run on Linux with curl, tar, unzip, zip and objdump (binutils):
#   VCRT_DIR=/path/with/vcruntime140.dll OUT=/somewhere bash deploy/build-pgtools-component.sh
set -euo pipefail

VERSION="18.6.0"          # keep in sync with the pgtools spec in componentStore.ts
OUT="${OUT:-$(pwd)/release/components}"
VCRT_DIR="${VCRT_DIR:-}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

if [ "$(uname -s)" != "Linux" ]; then
	echo "Refusing to run on $(uname -s): the Linux bundles carry symlinks this platform cannot keep."
	exit 1
fi
if [ -z "$VCRT_DIR" ] || [ ! -f "$VCRT_DIR/vcruntime140.dll" ]; then
	echo "Set VCRT_DIR to a directory holding vcruntime140.dll, vcruntime140_1.dll and msvcp140.dll."
	exit 1
fi

# "<our platform key> <upstream target triple> <archive extension>"
TARGETS=(
	"win32-x64    x86_64-pc-windows-msvc    zip"
	"linux-x64    x86_64-unknown-linux-gnu  tar.gz"
	"linux-arm64  aarch64-unknown-linux-gnu tar.gz"
	"darwin-arm64 aarch64-apple-darwin      tar.gz"
	"darwin-x64   x86_64-apple-darwin       tar.gz"
)
TOOLS=(pg_dump pg_restore psql)

# The DLLs a Windows binary imports, lower-cased.
imports() {
	objdump -p "$1" | awk '/DLL Name:/ { print tolower($3) }'
}

for entry in "${TARGETS[@]}"; do
	read -r KEY TRIPLE EXT <<<"$entry"
	ASSET="postgresql-${VERSION}-${TRIPLE}.${EXT}"
	echo "=== ${KEY} (${ASSET}) ==="
	SRC="$WORK/src-${KEY}"
	PKG="$WORK/pkg-${KEY}"
	ZIP="$OUT/pgtools-${VERSION}-${KEY}.zip"
	rm -rf "$SRC" "$PKG" "$ZIP"
	mkdir -p "$SRC" "$PKG/bin"

	echo "  downloading and verifying…"
	curl -fsSL -o "$SRC/$ASSET" "https://github.com/theseus-rs/postgresql-binaries/releases/download/${VERSION}/${ASSET}"
	curl -fsSL -o "$SRC/$ASSET.sha256" "https://github.com/theseus-rs/postgresql-binaries/releases/download/${VERSION}/${ASSET}.sha256"
	expected="$(grep -oiE '[0-9a-f]{64}' "$SRC/$ASSET.sha256" | head -1)"
	actual="$(sha256sum "$SRC/$ASSET" | cut -d' ' -f1)"
	if [ "${expected,,}" != "$actual" ]; then
		echo "  FAILED: sha256 mismatch for $ASSET (expected $expected, got $actual)"; exit 1
	fi

	case "$EXT" in
		zip)    ( cd "$SRC" && unzip -qo "$ASSET" ) ;;
		tar.gz) ( cd "$SRC" && tar xzf "$ASSET" ) ;;
	esac
	ROOT="$SRC/postgresql-${VERSION}-${TRIPLE}"
	[ -d "$ROOT/bin" ] || { echo "  FAILED: no bin directory in $ASSET"; exit 1; }

	case "$KEY" in
		win32-*)
			# Walk the imports from the three tools, keeping every DLL upstream ships that is reached.
			# Anything reached and NOT in upstream's bin is Windows itself, or the VC++ runtime.
			declare -A seen=()
			queue=()
			for tool in "${TOOLS[@]}"; do
				cp "$ROOT/bin/$tool.exe" "$PKG/bin/"
				queue+=("$ROOT/bin/$tool.exe")
			done
			while [ "${#queue[@]}" -gt 0 ]; do
				file="${queue[0]}"; queue=("${queue[@]:1}")
				while IFS= read -r dll; do
					[ -n "$dll" ] && [ -z "${seen[$dll]:-}" ] || continue
					seen[$dll]=1
					found="$(find "$ROOT/bin" -maxdepth 1 -iname "$dll" | head -1)"
					if [ -n "$found" ]; then
						cp "$found" "$PKG/bin/"
						queue+=("$found")
					elif [[ "$dll" == vcruntime140* || "$dll" == msvcp140* ]]; then
						cp "$VCRT_DIR/$dll" "$PKG/bin/" 2>/dev/null || { echo "  FAILED: $dll is imported and not in VCRT_DIR"; exit 1; }
					fi
				done < <(imports "$file")
			done
			unset seen
			# vcruntime140_1 is loaded by the others only on some code paths; ship it regardless.
			for dll in vcruntime140.dll vcruntime140_1.dll msvcp140.dll; do
				[ -f "$PKG/bin/$dll" ] || cp "$VCRT_DIR/$dll" "$PKG/bin/"
			done
			[ -f "$PKG/bin/libpq.dll" ] || { echo "  FAILED: libpq.dll was not reached from the tools"; exit 1; }
			;;
		linux-*)
			mkdir -p "$PKG/lib"
			for tool in "${TOOLS[@]}"; do cp -a "$ROOT/bin/$tool" "$PKG/bin/"; done
			cp -a "$ROOT"/lib/libpq.so* "$PKG/lib/"
			[ -e "$PKG/lib/libpq.so.5" ] || { echo "  FAILED: no libpq.so.5 (the SONAME the tools look for)"; exit 1; }
			;;
		darwin-*)
			mkdir -p "$PKG/lib"
			for tool in "${TOOLS[@]}"; do cp -a "$ROOT/bin/$tool" "$PKG/bin/"; done
			for lib in libpq libssl libcrypto; do
				cp -a "$ROOT"/lib/${lib}*.dylib "$PKG/lib/"
			done
			[ -e "$PKG/lib/libpq.5.dylib" ] || { echo "  FAILED: no libpq.5.dylib"; exit 1; }
			;;
	esac

	chmod 0755 "$PKG"/bin/* 2>/dev/null || true
	if find "$PKG" -type l ! -exec test -e {} \; -print | grep -q .; then
		echo "  FAILED: dangling symlinks in the bundle"; exit 1
	fi

	# Run the one bundle this host can run, on a system that has only what a user's would.
	if [ "$KEY" = "linux-x64" ] && [ "$(uname -m)" = "x86_64" ]; then
		# It prints "pg_dump (PostgreSQL) 18.6", without the patch-level zero.
		if ! "$PKG/bin/pg_dump" --version | grep -q "PostgreSQL) ${VERSION%.0}"; then
			echo "  FAILED: the linux-x64 bundle does not start here"; ldd "$PKG/bin/pg_dump" || true; exit 1
		fi
		echo "  smoke: $("$PKG/bin/pg_dump" --version)"
	else
		echo "  smoke: SKIPPED on $(uname -m) Linux; verify ${KEY} on its own platform"
	fi

	( cd "$PKG" && zip -qry "$ZIP" . )
	bytes=$(stat -c %s "$ZIP")
	sha=$(sha256sum "$ZIP" | cut -d' ' -f1)
	printf "  %s  files=%s\n    bytes:  %s\n    sha256: %s\n\n" "$(basename "$ZIP")" "$(find "$PKG" \( -type f -o -type l \) | wc -l)" "$bytes" "$sha"
done

echo "=== bundles → $OUT ==="
echo "Upload each to snoutdata/studio release components-v1 as the release account (never a personal one), then paste"
echo "the sha256/bytes into the pgtools spec in src/main/componentStore.ts."

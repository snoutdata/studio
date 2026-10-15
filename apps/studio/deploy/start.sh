#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
#  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
#---------------------------------------------------------------------------------------------

# Launch snoutdata in dev mode (Vite HMR renderer + Electron + the spawned SQL
# server). Run from anywhere: deploy/start.sh
set -e

# The app is built on Node 22, not 24. On Windows (Git Bash), use the project-local Node 22
# whenever it is installed (%LOCALAPPDATA%\positron-node\node-v22.22.1-win-x64), whatever else is
# on PATH; elsewhere, the `node` on PATH.
if [ -n "${LOCALAPPDATA:-}" ]; then
	node22="$(cygpath -u "$LOCALAPPDATA")/positron-node/node-v22.22.1-win-x64"
	if [ -x "$node22/node.exe" ]; then
		export PATH="$node22:$PATH"
	fi
	# The Db2 driver hosts ibm_db in a stock-Node sidecar (it cannot load under Electron's ABI).
	# ibm_db's prebuilt binary is keyed to Node 22 (ABI 127), so point the sidecar at the project
	# Node 22, NOT the global Node 24, whose ABI would fail to load it. (Ship will bundle a Node.)
	: "${SNOUTDATA_DB2_NODE:=${LOCALAPPDATA}\\positron-node\\node-v22.22.1-win-x64\\node.exe}"
	export SNOUTDATA_DB2_NODE
fi
if ! command -v node >/dev/null 2>&1; then
	echo "Node.js was not found. Install Node 22 and run deploy/start.sh again." >&2
	exit 1
fi

cd "$(dirname "$0")/.."

# Electron writes path.txt once its binary is downloaded; without it the dev server stops with
# "Electron uninstall". Since Electron 42 the npm package no longer downloads the binary at install,
# only on first use, and electron-vite reads path.txt without ever triggering that use. So: install
# the dependencies once when they are missing (a fresh clone, an interrupted install, the app folder
# moved; node_modules is not tracked), then fetch the binary ourselves.
if [ ! -f node_modules/electron/path.txt ]; then
	if [ ! -f node_modules/electron/install.js ]; then
		echo "The dependencies are not installed in this folder yet. Installing them once with npm ci..."
		if ! npm ci; then
			echo "The install failed. If SnoutData is running, quit it from the tray, then run deploy/start.sh again." >&2
			exit 1
		fi
	fi
	echo "Downloading the Electron binary once..."
	if ! node node_modules/electron/install.js; then
		echo "The Electron download failed. Check the network, then run deploy/start.sh again." >&2
		exit 1
	fi
fi

exec npm run dev "$@"

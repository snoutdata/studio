#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
#  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
#---------------------------------------------------------------------------------------------

# RETIRED as a build: SnoutData no longer hosts the SAP HANA client.
#
# There is no hana-*.zip of ours any more. The app fetches SAP's own package (used under SAP's
# licence, developer-license-3_2.txt in the package) from the npm registry when a user first
# connects to HANA, checks it against npm's `dist.integrity` for that exact version (pinned in src/main/componentVendors.ts, with its MIT
# dependencies `debug` and `ms`), unpacks only the user's platform's prebuilt/ folder, and loads it
# in-process as before. See componentInstall.ts for the unpacking and the integrity check.
#
# What this script does now: check the pins in componentVendors.ts against what npm publishes, so
# moving to a new client version is "change the version, run this, paste the integrity". It
# hosts and uploads nothing.
#
# Run from apps/studio. Needs npm.
set -euo pipefail

VENDORS="src/main/componentVendors.ts"
HANA_VER="$(sed -n "s/^export const HANA_CLIENT_VERSION = '\([^']*\)';/\1/p" "$VENDORS")"
[ -n "$HANA_VER" ] || { echo "could not read HANA_CLIENT_VERSION from $VENDORS"; exit 1; }

fail=0
check() {
	local spec="$1"
	local published
	published="$(npm view "$spec" dist.integrity)"
	if grep -qF "$published" "$VENDORS"; then
		printf '  ok       %-28s %s\n' "$spec" "$published"
	else
		printf '  MISMATCH %-28s npm says %s\n' "$spec" "$published"
		fail=1
	fi
}

echo "== pins in $VENDORS against registry.npmjs.org =="
check "@sap/hana-client@${HANA_VER}"
# The exact dependency versions SAP's own shrinkwrap names for this client.
for dep in $(npm view "@sap/hana-client@${HANA_VER}" dependencies --json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(Object.entries(d).map(([n,v])=>n+'@'+v).join(' '))"); do
	check "$dep"
done
check "ms@2.0.0"

[ "$fail" = 0 ] || { echo "Update the integrity strings (and the tarball sizes) in $VENDORS."; exit 1; }
echo "All pins match. To verify the download itself: SNOUTDATA_TEST_VENDOR_DOWNLOADS=1 node --test out/tests/main/componentVendors.test.js"

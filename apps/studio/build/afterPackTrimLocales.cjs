/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// electron-builder afterPack hook: on Linux only, keep just en-US.pak in Electron's locales/ dir.
// The app UI is English; Chromium falls back to en-US when a locale .pak is missing. This trims
// ~46 MB of unused locale data so the .deb stays under GitHub's 100 MB host limit. Windows/macOS
// are left untouched (guarded on electronPlatformName).
const { readdirSync, rmSync, statSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function trimLocales(context) {
	if (context.electronPlatformName !== 'linux') {
		return;
	}
	const dir = join(context.appOutDir, 'locales');
	let removed = 0;
	let freedBytes = 0;
	for (const file of readdirSync(dir)) {
		if (file.endsWith('.pak') && file !== 'en-US.pak') {
			const full = join(dir, file);
			freedBytes += statSync(full).size;
			rmSync(full);
			removed++;
		}
	}
	console.log(`[afterPack] trimmed ${removed} non-en-US locale paks (${(freedBytes / 1048576).toFixed(1)} MB) on linux`);
};

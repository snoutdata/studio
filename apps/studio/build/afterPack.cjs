/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// electron-builder afterPack hook: trims Linux locales (afterPackTrimLocales.cjs), then sets the
// Electron FUSES on the packaged binary. It runs before electron-builder signs anything, so the
// signature covers the flipped binary.
//
// Why here and not `electronFuses` in electron-builder.yml: that option arrived in electron-builder
// 26, and this app is pinned to 25.1.8 (26's 7zip drops the symlinks a macOS update zip needs). So
// @electron/fuses is called directly, the way 26 does it.
//
// What is set, and why:
//   - EnableNodeOptionsEnvironmentVariable OFF and EnableNodeCliInspectArguments OFF: otherwise any
//     process running as the user could start the signed app with NODE_OPTIONS=--require=... or
//     --inspect and run its own code AS the app, including safeStorage.decryptString (on macOS that
//     skips the keychain prompt, since the keychain trusts the app's signature).
//   - OnlyLoadAppFromAsar ON: the app is only ever loaded from resources/app.asar, never from a
//     resources/app folder someone put beside it.
// What is deliberately NOT set yet:
//   - RunAsNode stays ON: the SQL server child (src/main/sqlServer.ts) and the staged update's
//     folder tool and waiter (src/main/stagedUpdate.ts) run this binary with ELECTRON_RUN_AS_NODE.
//     Moving them to utilityProcess is its own change.
//   - EnableEmbeddedAsarIntegrityValidation stays OFF until it has been tested on signed builds of
//     all three platforms.
// Nothing in a packaged build uses NODE_OPTIONS or --inspect: the e2e suite drives the UNPACKED app
// with the dev Electron binary (e2e/helpers.ts), which these fuses never touch.
const { join } = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const trimLocales = require('./afterPackTrimLocales.cjs').default;

/** The fuses this build sets. */
const FUSES = {
	version: FuseVersion.V1,
	[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
	[FuseV1Options.EnableNodeCliInspectArguments]: false,
	[FuseV1Options.OnlyLoadAppFromAsar]: true,
};

function electronBinary(context) {
	const platform = context.electronPlatformName;
	if (platform === 'darwin' || platform === 'mas') {
		return join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
	}
	if (platform === 'win32') {
		return join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
	}
	return join(context.appOutDir, context.packager.executableName);
}

exports.FUSES = FUSES;
exports.default = async function afterPack(context) {
	await trimLocales(context);
	const binary = electronBinary(context);
	// An arm64 Mac binary carries an ad-hoc signature that flipping invalidates; an unsigned local
	// build would then be killed on launch. A signed build is re-signed after this hook anyway.
	const { Arch } = require('electron-builder');
	await flipFuses(binary, { ...FUSES, resetAdHocDarwinSignature: context.electronPlatformName === 'darwin' && context.arch === Arch.arm64 });
	console.log(`[afterPack] fuses set on ${binary}: NODE_OPTIONS off, --inspect off, app.asar only`);
};

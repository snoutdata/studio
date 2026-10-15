/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Rebuild better-sqlite3 against ELECTRON's ABI, and prove it worked.
//
// Why this exists as a script instead of an electron-builder hook (v1.0.17 postmortem):
// `electron-builder.yml` sets `npmRebuild: false` — cpu-features' `nan` cannot compile against
// Electron 42's V8, and it is an unused optional transitive dep. But electron-builder returns from
// `installOrRebuild()` on that flag BEFORE it ever resolves `beforeBuild`
// (app-builder-lib/out/packager.js), so the `beforeBuild` hook we had configured never ran, in any
// build, ever. Packaging simply copied whatever binary happened to be in node_modules:
//
//   - after `@electron/rebuild` ran by hand → Electron ABI → works;
//   - after ANY `npm install` → prebuild-install fetches the NODE prebuild → the packaged app
//     dies on launch with "compiled against a different Node.js version ... NODE_MODULE_VERSION".
//
// That is what shipped in v1.0.17. So the rebuild now lives where it cannot be skipped (postinstall
// + the release script) and it ASSERTS the result rather than trusting an exit code: the old hook
// printed a cheerful "rebuilt ok" while doing nothing at all, because @electron/rebuild skips a
// module whose `.forge-meta` marker already claims the right ABI — a marker `npm install` does not
// invalidate when it overwrites the binary underneath it.

import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertElectronAbi } from './assert-electron-abi.mjs';
import { assertPtyHelper } from './assert-pty-helper.mjs';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** The one native module we ship in the main process. */
const MODULE = 'better-sqlite3';
const BINARY = join(root, 'node_modules', MODULE, 'build', 'Release', 'better_sqlite3.node');
/** @electron/rebuild's "already done" marker. Stale after an npm install, so it is removed first. */
const MARKER = join(root, 'node_modules', MODULE, 'build', 'Release', '.forge-meta');

const electronVersion = require(join(root, 'node_modules', 'electron', 'package.json')).version;
const { rebuild } = await import('@electron/rebuild');

// The marker goes first: with it in place @electron/rebuild reports success without doing anything,
// which is precisely how a Node-ABI binary reached production wearing an "already rebuilt" label.
rmSync(MARKER, { force: true });
console.log(`rebuilding ${MODULE} against Electron ${electronVersion}…`);
await rebuild({ buildPath: root, electronVersion, arch: process.arch, onlyModules: [MODULE], force: true });
assertElectronAbi(BINARY);
console.log(`${MODULE} is built for Electron ${electronVersion} (plain Node refuses it, as it should)`);

// node-pty needs no rebuild (it is N-API, so one binary serves Node and Electron alike), but it
// has the same shape of problem: a file whose MODE decides whether the app works. Its published
// darwin prebuilds carry `spawn-helper` as 644, so on macOS every `npm install` re-breaks the
// agent console with "posix_spawnp failed" until the exec bit is put back. Same reason as above,
// this lives where it cannot be skipped rather than in a hook. See assert-pty-helper.mjs.
const helpers = assertPtyHelper(join(root, 'node_modules', 'node-pty'), { fix: true });
console.log(helpers.length
	? `node-pty spawn-helper is executable (${helpers.length} found)`
	: 'node-pty needs no spawn-helper on this platform');

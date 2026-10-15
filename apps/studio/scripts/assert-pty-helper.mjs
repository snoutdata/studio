/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Assert node-pty's `spawn-helper` is executable — and make it so.
//
// node-pty forks a pty by posix_spawn()ing a small helper binary that lives BESIDE pty.node
// (lib/unixTerminal.js builds `<native dir>/spawn-helper`). If that file is not +x the spawn
// fails and every terminal dies at birth with the useless message:
//
//     Error: posix_spawnp failed.
//         at new UnixTerminal (node_modules/node-pty/lib/unixTerminal.js:92:24)
//
// The published node-pty 1.1.0 tarball ships `prebuilds/darwin-*/spawn-helper` as mode 644 — the
// exec bit is missing UPSTREAM, not lost locally — so this breaks on macOS after every single
// `npm install`, on every machine, including CI and the packaged .app. It does NOT break on
// Windows (conpty, no helper, no exec bit) which is why the agent console worked there first.
// LINUX DOES NOT HAVE A spawn-helper AT ALL, and that is not a missing file — it is the design:
// `binding.gyp` builds the `spawn-helper` target only under `OS=="mac"`, and `src/unix/pty.cc`
// gates the posix_spawn path on `#if defined(__APPLE__)`. Everything else forks the pty with
// `forkpty(3)` and reports `forkpty(3) failed.` on its way out. So on Linux this asserts that
// pty.node was COMPILED (there is no linux prebuild published, so a missing one means the install
// build step failed) and asserts nothing about a helper that is not supposed to exist.
//
// Used twice, like assert-electron-abi.mjs: by `rebuild-native.mjs` on node_modules (with fix on,
// so a fresh install self-heals), and by the release scripts on the PACKAGED app (fix off — at
// that point a bad mode means the packager dropped it, and we want the build to fail loudly).

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Where node-pty's lib/utils.js looks for pty.node, in its order. The helper sits alongside. */
function nativeDirs(ptyRoot) {
	return [
		join(ptyRoot, 'build', 'Release'),
		join(ptyRoot, 'build', 'Debug'),
		join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`),
	];
}

/** Every spawn-helper in the tree, not just this platform's: one chmod costs nothing. */
function allHelpers(ptyRoot) {
	const found = [];
	for (const dir of nativeDirs(ptyRoot)) {
		const helper = join(dir, 'spawn-helper');
		if (existsSync(helper)) {
			found.push(helper);
		}
	}
	const prebuilds = join(ptyRoot, 'prebuilds');
	if (existsSync(prebuilds)) {
		for (const entry of readdirSync(prebuilds)) {
			const helper = join(prebuilds, entry, 'spawn-helper');
			if (existsSync(helper) && !found.includes(helper)) {
				found.push(helper);
			}
		}
	}
	return found;
}

/**
 * @param {string} ptyRoot   a node-pty package directory (node_modules/node-pty, packed or not)
 * @param {{ fix?: boolean }} [options]  fix: chmod 755 instead of only reporting
 * @returns {string[]} the helpers that are now executable
 */
export function assertPtyHelper(ptyRoot, options = {}) {
	const root = resolve(ptyRoot);
	if (process.platform === 'win32') {
		return []; // conpty needs no helper, and NTFS has no exec bit to get wrong.
	}
	if (!existsSync(root)) {
		throw new Error(`no node-pty at ${root}`);
	}

	// The one that actually matters is the one node-pty will resolve at runtime: the first
	// native dir holding a pty.node. Everything else is a bonus chmod.
	const runtimeDir = nativeDirs(root).find((dir) => existsSync(join(dir, 'pty.node')));
	if (!runtimeDir) {
		throw new Error(
			`node-pty at ${root} has no pty.node in build/Release, build/Debug or ` +
			`prebuilds/${process.platform}-${process.arch}.\n` +
			'On Linux it is compiled at install time — check that npm install ran its build step.',
		);
	}
	// Only macOS spawns through the helper. Asking Linux for one would fail every Linux build on
	// a file node-pty never builds there.
	if (process.platform !== 'darwin') {
		return [];
	}

	const runtimeHelper = join(runtimeDir, 'spawn-helper');
	if (!existsSync(runtimeHelper)) {
		throw new Error(`node-pty will load ${join(runtimeDir, 'pty.node')} but there is no spawn-helper beside it`);
	}

	const helpers = allHelpers(root);
	if (options.fix) {
		for (const helper of helpers) {
			if (!(statSync(helper).mode & 0o111)) {
				chmodSync(helper, 0o755);
			}
		}
	}

	if (!(statSync(runtimeHelper).mode & 0o111)) {
		throw new Error(
			`${runtimeHelper} is not executable (mode ${(statSync(runtimeHelper).mode & 0o777).toString(8)}).\n` +
			'Every agent-console terminal will fail with "posix_spawnp failed".\n' +
			'Run `npm run rebuild:native` (it chmods the helper) and package again.',
		);
	}
	return helpers.filter((helper) => statSync(helper).mode & 0o111);
}

// CLI: node scripts/assert-pty-helper.mjs <path-to-node-pty> [--fix]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
	const target = process.argv[2];
	if (!target) {
		console.error('usage: node scripts/assert-pty-helper.mjs <path-to node-pty> [--fix]');
		process.exit(2);
	}
	try {
		const fixed = assertPtyHelper(target, { fix: process.argv.includes('--fix') });
		console.log(fixed.length ? `ok: node-pty spawn-helper is executable (${fixed.length} found)` : `ok: ${process.platform} spawns the pty without a helper (nothing to check)`);
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Assert a compiled .node belongs to ELECTRON, not to Node.
//
// A negative test, deliberately: if the Node running this script can load the binary, it was built
// for Node, and Electron refuses it at startup with NODE_MODULE_VERSION — which is exactly how
// v1.0.17 shipped an app that could not boot. Nothing here trusts a marker file or an exit code.
//
// Used twice: by `rebuild-native.mjs` (on node_modules, right after rebuilding) and by the release
// scripts (on the PACKAGED binary, before anything is published).

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

export function assertElectronAbi(binaryPath) {
	const path = resolve(binaryPath);
	if (!existsSync(path)) {
		throw new Error(`no native binary at ${path}`);
	}
	try {
		require(path);
	} catch (err) {
		if (/NODE_MODULE_VERSION/.test(String(err && err.message))) {
			return path; // Node refused it: it belongs to Electron, which is the point.
		}
		throw new Error(`${path} did not load, and not because of the ABI: ${err.message}`);
	}
	throw new Error(
		`${path} was built for NODE, not Electron.\n` +
		'Shipping it produces an app that dies on launch with NODE_MODULE_VERSION (the v1.0.17 bug).\n' +
		'Run `npm run rebuild:native` and package again.',
	);
}

// CLI: node scripts/assert-electron-abi.mjs <path-to.node>
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
	const target = process.argv[2];
	if (!target) {
		console.error('usage: node scripts/assert-electron-abi.mjs <path-to .node>');
		process.exit(2);
	}
	try {
		console.log(`ok: ${assertElectronAbi(target)} is an Electron build`);
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}

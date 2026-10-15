/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { installSource } from './componentInstall';
import { HANA_PREBUILT, IBM_CLI_DRIVER_WIN32_X64, hanaParts } from './componentVendors';

/*  OPT-IN, NETWORK: fetches the real files from SAP's npm package and IBM's download site and holds
 *  them to the pins in componentVendors.ts. Run it when a pin changes, or to find out whether a
 *  publisher has moved or replaced a file:
 *
 *      SNOUTDATA_TEST_VENDOR_DOWNLOADS=1 node --test out/tests/main/componentVendors.test.js
 *
 *  The HANA half then loads the unpacked client in a child process (stock Node, and Electron run
 *  as Node when it is installed, which is how the server child runs it) and asks it to connect to
 *  a closed port: the refusal comes from SAP's native driver, which proves the binary loads. The
 *  Db2 half only unpacks IBM's Windows driver; loading it needs Windows.  */

const LIVE = process.env.SNOUTDATA_TEST_VENDOR_DOWNLOADS === '1';
const dir = mkdtempSync(join(tmpdir(), 'snout-vendors-'));

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Load the client and touch the native driver, in a separate process run by `bin`. */
function loadIn(bin: string, env: NodeJS.ProcessEnv, modulePath: string): { ok: boolean; error?: string; detail: string } {
	const script = `
		const client = require(${JSON.stringify(modulePath)});
		if (typeof client.createConnection !== 'function') { console.log(JSON.stringify({ ok: false, error: 'no createConnection' })); process.exit(0); }
		const connection = client.createConnection();
		connection.connect({ serverNode: '127.0.0.1:1', connectTimeout: 3000 }, (err) => {
			console.log(JSON.stringify({ ok: true, error: err ? String(err.message || err) : undefined }));
			process.exit(0);
		});`;
	const run = spawnSync(bin, ['-e', script], { env, encoding: 'utf8', timeout: 30_000 });
	const line = (run.stdout ?? '').trim().split('\n').pop() ?? '';
	try {
		return { ...(JSON.parse(line) as { ok: boolean; error?: string }), detail: line };
	} catch {
		return { ok: false, detail: `${run.stdout ?? ''}${run.stderr ?? ''}`.slice(0, 2000) };
	}
}

describe('vendor downloads (live, opt-in)', { skip: LIVE ? false : 'set SNOUTDATA_TEST_VENDOR_DOWNLOADS=1 to fetch from SAP and IBM' }, () => {
	it('SAP HANA: npm serves the pinned client, it unpacks to this platform only, and it loads', async () => {
		const key = `${process.platform}-${process.arch}`;
		const prebuilt = HANA_PREBUILT[key];
		if (!prebuilt) {
			return;
		}
		const dest = join(dir, 'hana');
		await installSource({ parts: hanaParts(prebuilt) }, dest, join(dir, 'hana.work'), 'SAP HANA client', () => {});
		const modulePath = join(dest, 'node_modules', '@sap', 'hana-client');
		assert.deepEqual(readdirSync(join(modulePath, 'prebuilt')), [prebuilt]);
		assert.ok(existsSync(join(dest, 'node_modules', 'debug', 'package.json')));
		assert.ok(existsSync(join(dest, 'node_modules', 'ms', 'package.json')));

		const plain = loadIn(process.execPath, process.env, modulePath);
		assert.equal(plain.ok, true, plain.detail);
		assert.ok(plain.error, `the native driver answered a closed port: ${plain.detail}`);

		const electron = spawnSync(process.execPath, ['-e', "process.stdout.write(String(require('electron')))"], { encoding: 'utf8' }).stdout;
		if (electron && existsSync(electron)) {
			const inElectron = loadIn(electron, { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, modulePath);
			assert.equal(inElectron.ok, true, inElectron.detail);
			assert.ok(inElectron.error, `the native driver answered a closed port under Electron: ${inElectron.detail}`);
		}
	});

	it("IBM Db2: IBM serves the pinned driver and it lands where ibm_db looks for it", async () => {
		const dest = join(dir, 'db2');
		await installSource({ parts: [IBM_CLI_DRIVER_WIN32_X64] }, dest, join(dir, 'db2.work'), 'IBM Db2 client', () => {});
		const clidriver = join(dest, 'node_modules', 'ibm_db', 'installer', 'clidriver');
		assert.ok(existsSync(join(clidriver, 'bin', 'db2cli64.dll')), 'db2cli64.dll');
		assert.ok(existsSync(join(clidriver, 'bin', 'db2app64.dll')), 'db2app64.dll');
		assert.ok(existsSync(join(clidriver, 'license')), 'IBM licence folder travels with the driver');
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from './sqlite';

// The STAGED build's proof that it can run, before it is allowed to replace the live one.
// The running app launches `<install>.next\SnoutData.exe
// --snout-self-check` against a scratch profile; this answers with its exit code, and writes why to
// self-check.txt in that profile. It exercises the things a broken build has actually broken on:
// the main bundle loading at all (it is running this), the native module (v1.0.17 shipped one built
// for the wrong ABI and could not start), and the SQL server child's bundle. Called from `ready`,
// before any window, IPC or network.
//
// NEVER REMOVE THIS ENTRY POINT. The app that stages runs the NEXT version's self-check; a build
// without one would open a window in a scratch profile and be killed when the check times out,
// which falls back to the stock installer rather than stranding anyone, but loses the check.

export interface SelfCheckServer {
	start(serverPath: string): Promise<void>;
	stop(): void;
}

export async function runSelfCheck(outDir: string, userData: string, server: SelfCheckServer): Promise<boolean> {
	const report = (line: string): void => {
		try {
			writeFileSync(join(userData, 'self-check.txt'), line, 'utf8');
		} catch {
			// The exit code is the answer; the reason is a courtesy.
		}
	};
	try {
		for (const file of ['server/server.js', 'preload/index.js', 'renderer/index.html']) {
			if (!existsSync(join(outDir, file))) {
				throw new Error(`missing ${file}`);
			}
		}
		openDatabase(':memory:', 'self-check').close();
		await Promise.race([
			server.start(join(outDir, 'server/server.js')),
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error('the SQL server did not answer in 30s')), 30_000).unref();
			}),
		]);
		server.stop();
		report('ok');
		return true;
	} catch (err) {
		server.stop();
		report(err instanceof Error ? err.message : String(err));
		return false;
	}
}

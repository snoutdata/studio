/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Running one statement with `psql`, for a host that has no driver of its own: the `snoutdata` CLI,
 * and this package's live test. The desktop app runs statements through its connection manager
 * instead, and never needs this.
 *
 * The statement goes in on stdin, not argv: a row-count query naming thousands of tables is longer
 * than a Windows command line.
 */

import { spawn } from 'node:child_process';
import { toolEnv, type PgAccess } from './env.js';

export function psqlQuery(file: string, access: PgAccess, sql: string): Promise<string> {
	const { env, dispose } = toolEnv(access);
	return new Promise<string>((resolve, reject) => {
		const child = spawn(file, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '--no-password', '-f', '-'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				resolve(out.trim());
			} else {
				reject(new Error(err.replace(/^psql:[^:]*:\d+: /gm, '').trim() || `psql exited with code ${code}`));
			}
		});
		child.stdin.end(sql);
	}).finally(dispose);
}

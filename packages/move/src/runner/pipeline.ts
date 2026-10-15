/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `pg_dump | pg_restore`, as two child processes with a counted pipe between them.
 *
 * No shell: the two are spawned directly, so there is no quoting to get wrong and killing them is
 * killing exactly them. No temp file: measured 2026-09-13, one stream held 14 to 19 MB/s from
 * 883 MB to 5.3 GB.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface ToolProcess {
	readonly file: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
}

export interface PipelineResult {
	readonly dumpExit: number | null;
	readonly restoreExit: number | null;
	readonly cancelled: boolean;
	/** A tool that could not be started at all, in a sentence. */
	readonly spawnError: string | null;
	/** Archive bytes that went through the pipe. */
	readonly bytes: number;
}

export interface PipelineOptions {
	readonly dump: ToolProcess;
	readonly restore: ToolProcess;
	readonly signal: AbortSignal;
	onDumpLine(line: string): void;
	onRestoreLine(line: string): void;
	onBytes?(total: number): void;
}

function running(child: ChildProcess): boolean {
	return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

export function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
	return new Promise((resolve) => {
		let bytes = 0;
		let cancelled = false;
		let spawnError: string | null = null;
		const exits: { dump?: number | null; restore?: number | null } = {};

		const dump = spawn(options.dump.file, [...options.dump.args], { env: options.dump.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const restore = spawn(options.restore.file, [...options.restore.args], { env: options.restore.env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });

		function killBoth(): void {
			for (const child of [dump, restore]) {
				if (running(child)) {
					child.kill();
				}
			}
		}
		function onAbort(): void {
			cancelled = true;
			killBoth();
		}
		function finish(which: 'dump' | 'restore', code: number | null): void {
			if (which in exits) {
				return;
			}
			exits[which] = code;
			// A restore that stopped leaves the dump blocked on a full pipe forever.
			if (which === 'restore' && running(dump)) {
				dump.kill();
			}
			if ('dump' in exits && 'restore' in exits) {
				options.signal.removeEventListener('abort', onAbort);
				resolve({ dumpExit: exits.dump ?? null, restoreExit: exits.restore ?? null, cancelled, spawnError, bytes });
			}
		}

		if (options.signal.aborted) {
			onAbort();
		} else {
			options.signal.addEventListener('abort', onAbort, { once: true });
		}

		dump.stdout?.on('data', (chunk: Buffer) => {
			bytes += chunk.length;
			options.onBytes?.(bytes);
		});
		if (dump.stdout && restore.stdin) {
			dump.stdout.pipe(restore.stdin);
			// EPIPE when pg_restore stopped early; its exit code and stderr say why.
			restore.stdin.on('error', () => undefined);
		}
		if (dump.stderr) {
			createInterface({ input: dump.stderr, crlfDelay: Infinity }).on('line', options.onDumpLine);
		}
		if (restore.stderr) {
			createInterface({ input: restore.stderr, crlfDelay: Infinity }).on('line', options.onRestoreLine);
		}

		for (const [which, child, name] of [['dump', dump, 'pg_dump'], ['restore', restore, 'pg_restore']] as const) {
			child.on('error', (error) => {
				if (child.pid === undefined) {
					spawnError ??= `Could not start ${name}: ${error.message}`;
					killBoth();
					finish(which, null);
				}
			});
			child.on('close', (code) => finish(which, code));
		}
	});
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Socket } from 'node:net';

import { CLICKHOUSE_PING, PG_SSL_REQUEST, sniffClickhousePing, sniffMysqlGreeting, sniffPostgresSslReply, type ProbePort, type SniffVerdict } from './sniff';

// The socket half of `sniff.ts`: connect, make the exchange, hand the bytes to the pure sniffer.
// Shared by "Running on this computer" and the network scan. Every probe is bounded by one timeout
// covering connect AND reply, and always destroys its socket.

/** What happened when a port was probed. */
export type ProbeOutcome =
	| { kind: 'answered'; verdict: SniffVerdict }
	/** Open, but said nothing we recognise (or was not asked). */
	| { kind: 'open' }
	/** Nothing there, or not reachable; `code` is the socket error, if any. */
	| { kind: 'closed'; code?: string };

export function probePort(host: string, spec: ProbePort, timeoutMs: number): Promise<ProbeOutcome> {
	return new Promise((resolve) => {
		const socket = new Socket();
		let connected = false;
		let chunks: Buffer[] = [];
		let settled = false;
		const finish = (outcome: ProbeOutcome): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(outcome);
		};
		const timer = setTimeout(() => finish(connected ? { kind: 'open' } : { kind: 'closed', code: 'ETIMEDOUT' }), timeoutMs);
		const judge = (): SniffVerdict | null => {
			const buf = Buffer.concat(chunks);
			if (spec.sniff === 'mysql') {
				return sniffMysqlGreeting(buf);
			}
			if (spec.sniff === 'postgres') {
				return sniffPostgresSslReply(buf);
			}
			if (spec.sniff === 'clickhouse') {
				return sniffClickhousePing(buf.toString('latin1'));
			}
			return null;
		};
		socket.on('connect', () => {
			connected = true;
			if (spec.sniff === 'tcp') {
				finish({ kind: 'open' });
			} else if (spec.sniff === 'postgres') {
				socket.write(PG_SSL_REQUEST);
			} else if (spec.sniff === 'clickhouse') {
				socket.write(CLICKHOUSE_PING);
			}
			// MySQL speaks first: just wait for the greeting.
		});
		socket.on('data', (data: Buffer) => {
			chunks.push(data);
			const verdict = judge();
			if (verdict) {
				finish({ kind: 'answered', verdict });
			} else if (Buffer.concat(chunks).length > 4096) {
				chunks = [];
				finish({ kind: 'open' });
			}
		});
		socket.on('end', () => {
			const verdict = judge();
			finish(verdict ? { kind: 'answered', verdict } : { kind: 'open' });
		});
		socket.on('error', (err: NodeJS.ErrnoException) => finish(connected ? { kind: 'open' } : { kind: 'closed', code: err.code }));
		socket.connect(spec.port, host);
	});
}

/** Run `tasks` with at most `limit` in flight, stopping new starts once `deadline` has passed. */
export async function pool<T>(tasks: (() => Promise<T>)[], limit: number, deadline = Infinity): Promise<T[]> {
	const results: T[] = [];
	let next = 0;
	async function worker(): Promise<void> {
		while (next < tasks.length && Date.now() < deadline) {
			const i = next++;
			results[i] = await tasks[i]();
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
	return results.filter((r) => r !== undefined);
}

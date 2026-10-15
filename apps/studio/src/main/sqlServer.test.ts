/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { SqlServer, type SqlServerDied } from './sqlServer';

// A stand-in for the ported SQL server: speaks just enough LSP framing to complete the
// `initialize` handshake and answer a ping with its own pid, which is how these tests tell
// one generation of the child apart from the next. Written by hand (no vscode-jsonrpc
// import) so it resolves from a temp dir with no node_modules of its own.
const FAKE_SERVER = `
let buf = Buffer.alloc(0);
function send(obj) {
	const body = Buffer.from(JSON.stringify(obj), 'utf8');
	process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
	process.stdout.write(body);
}
process.stdin.on('data', (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	for (;;) {
		const header = buf.indexOf('\\r\\n\\r\\n');
		if (header === -1) { return; }
		const match = /Content-Length: (\\d+)/.exec(buf.slice(0, header).toString('ascii'));
		if (!match) { return; }
		const start = header + 4;
		const length = Number(match[1]);
		if (buf.length < start + length) { return; }
		const msg = JSON.parse(buf.slice(start, start + length).toString('utf8'));
		buf = buf.slice(start + length);
		if (msg.method === 'initialize') {
			send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
		} else if (msg.method === 'snout/pingConnection') {
			send({ jsonrpc: '2.0', id: msg.id, result: { ok: true, pid: process.pid } });
		} else if (msg.id !== undefined) {
			send({ jsonrpc: '2.0', id: msg.id, result: null });
		}
	}
});
`;

// A child that dies immediately after the handshake, to exercise the crash budget.
const SUICIDAL_SERVER = FAKE_SERVER + `
setTimeout(() => process.exit(7), 50);
`;

/** A child that spawns but never answers `initialize`, so boot() is still awaiting the handshake.
 *  It records its pid so the test can check whether stop() actually killed it. */
function hangingServer(pidFile: string): string {
	return `
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.on('data', () => {});
setTimeout(() => process.exit(0), 30000);
`;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The fake's ping answers with its own pid, so a changed pid proves a fresh child. */
async function pidOf(server: SqlServer): Promise<number> {
	const result = await server.ping('any') as unknown as { ok: boolean; pid: number };
	assert.equal(result.ok, true);
	return result.pid;
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = (): void => {
			if (predicate()) { resolve(); return; }
			if (Date.now() - started > timeoutMs) { reject(new Error('timed out waiting')); return; }
			setTimeout(tick, 10);
		};
		tick();
	});
}

describe('SqlServer child lifecycle', () => {
	let dir: string;
	let fakePath: string;
	let suicidalPath: string;

	before(() => {
		dir = mkdtempSync(join(tmpdir(), 'snout-sqlserver-'));
		fakePath = join(dir, 'fake-server.js');
		suicidalPath = join(dir, 'suicidal-server.js');
		writeFileSync(fakePath, FAKE_SERVER, 'utf8');
		writeFileSync(suicidalPath, SUICIDAL_SERVER, 'utf8');
	});

	it('serves requests once booted', async () => {
		const server = new SqlServer();
		await server.start(fakePath);
		assert.ok(await pidOf(server) > 0);
		server.stop();
	});

	it('respawns the child after it dies, instead of failing every later request', async () => {
		const server = new SqlServer();
		await server.start(fakePath);
		const first = await pidOf(server);

		let died = false;
		server.onDied(() => { died = true; });
		// Kill the child out from under us — the case the Sentry reports came from.
		process.kill(first, 'SIGKILL');
		await waitFor(() => died);

		// The old code cached the dead connection, so this threw "Connection is closed"
		// forever. It must now boot a replacement and answer.
		const second = await pidOf(server);
		assert.notEqual(second, first, 'expected a fresh child, got the dead one back');
		server.stop();
	});

	it('reports the death once, with the exit reason', async () => {
		const server = new SqlServer();
		await server.start(fakePath);
		const deaths: string[] = [];
		server.onDied((info) => deaths.push(info.reason));

		process.kill(await pidOf(server), 'SIGKILL');
		await waitFor(() => deaths.length > 0);
		// One child death is one event, not one per downstream request that trips over it.
		assert.equal(deaths.length, 1);
		// The transport notices the dead pipe before the process handle reports why, and
		// reporting that first signal is what made every crash report read "connection
		// closed" — a reason that names no cause. The exit must win.
		assert.match(deaths[0], /exited/);
		server.stop();
	});

	// Without the stderr tail a death is unattributable: the child's stack trace dies with it,
	// and "the pipe closed" is all that reaches the crash report.
	it('carries the child\'s last stderr into the death report', async () => {
		const noisyPath = join(dir, 'noisy-server.js');
		writeFileSync(noisyPath, FAKE_SERVER + `
setTimeout(() => {
	process.stderr.write('Error: boom in the driver\\n    at somewhere\\n');
	process.exit(1);
}, 50);
`, 'utf8');

		const server = new SqlServer();
		const deaths: SqlServerDied[] = [];
		server.onDied((info) => deaths.push(info));
		await server.start(noisyPath);

		await waitFor(() => deaths.length > 0);
		assert.match(deaths[0].stderr, /boom in the driver/);
		assert.match(deaths[0].reason, /code 1/);
		server.stop();
	});

	// (No fixture for "the pipe closes but the child lives on": a child can't close its own
	// stdout — process.stdout has no closable fd — so that path exists only as the grace
	// period's fallback, which reports the bare close reason if no exit ever arrives.)

	it('keeps a deliberate stop() quiet — no crash report, no respawn', async () => {
		const server = new SqlServer();
		await server.start(fakePath);
		let died = false;
		server.onDied(() => { died = true; });

		server.stop();
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(died, false, 'stop() must not look like a crash');
		await assert.rejects(() => server.ping('any'), /not started/);
	});

	it('gives up after repeated crashes rather than spawn-looping', async () => {
		const server = new SqlServer();
		const infos: boolean[] = [];
		server.onDied((info) => infos.push(info.givingUp));
		await server.start(suicidalPath);

		// Each request boots a child that dies ~50ms later. The budget must stop the cycle.
		for (let i = 0; i < 5; i++) {
			await server.ping('any').catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 120));
		}
		await assert.rejects(() => server.ping('any'), /keeps crashing/);
		// The budget is charged the instant the child dies (which is what the rejection above
		// proves); the matching report follows one grace period later.
		await waitFor(() => infos.includes(true));
		server.stop();
	});

	// The app quits by calling stop(); anything the child still holds open under the install dir
	// can make a Windows update install fail to replace files. A child caught mid-handshake is the
	// easy one to miss, because it hasn't been "finished" booting yet.
	it('kills a child that is still booting when stop() lands', async () => {
		const pidFile = join(dir, 'hanging.pid');
		const hangingPath = join(dir, 'hanging-server.js');
		writeFileSync(hangingPath, hangingServer(pidFile), 'utf8');

		const server = new SqlServer();
		// Deliberately not awaited: start() never resolves here, which is the point.
		const booting = server.start(hangingPath);
		booting.catch(() => undefined);
		await waitFor(() => existsSync(pidFile));
		const pid = Number(readFileSync(pidFile, 'utf8'));
		assert.ok(isAlive(pid), 'fixture should be running before stop()');

		server.stop();
		await waitFor(() => !isAlive(pid), 5000);
		assert.equal(isAlive(pid), false, 'stop() must not leave a booting child behind');
	});

	after(() => {
		// The temp dir holds only the fake scripts; leaving it would litter tmp.
	});
});

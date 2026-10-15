/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { EndpointFacts } from '../facts.js';
import type { MoveProgress } from '../progress.js';
import { newMoveSpec, type MoveSpec } from '../spec.js';
import { runMove, type MoveRunHost } from './run.js';

// The runner's order and its reading of the tools, against two fake tools that print what the real
// ones print (captured from pg_restore 17.11). Whether it moves a real database is `live.test.ts`.

const dir = mkdtempSync(join(tmpdir(), 'snout-move-runner-'));
after(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(
	join(dir, 'fake-dump.cjs'),
	`const mode = process.env.FAKE_MODE || 'ok';
require('fs').writeFileSync(process.env.FAKE_OUT, JSON.stringify({ args: process.argv.slice(2), password: process.env.PGPASSWORD || null, database: process.env.PGDATABASE, service: process.env.PGSERVICE || null }));
process.stderr.write('pg_dump: reading extensions\\n');
if (mode === 'dumpfail') {
	process.stderr.write('pg_dump: error: connection to server failed: FATAL:  password authentication failed for user "u"\\n');
	process.exit(1);
}
process.stdout.write(Buffer.alloc(64 * 1024, 1));
if (mode === 'slow') { setTimeout(() => {}, 60000); }
`
);
writeFileSync(
	join(dir, 'fake-restore.cjs'),
	`const mode = process.env.FAKE_MODE || 'ok';
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
	const lines = ['pg_restore: connecting to database for restore', 'pg_restore: creating TABLE "public.orders"'];
	if (mode === 'error') {
		lines.push('pg_restore: from TOC entry 222; 1259 16404 TABLE broken postgres', 'pg_restore: error: could not execute query: ERROR:  type "public.vector" does not exist', 'Command was: CREATE TABLE public.broken (', '    v public.vector(3)', ');', '');
	}
	lines.push('pg_restore: processing data for table "public.orders"', 'pg_restore: creating CONSTRAINT "public.orders orders_pkey"');
	if (mode === 'error') { lines.push('pg_restore: warning: errors ignored on restore: 1'); }
	process.stderr.write(lines.join('\\n') + '\\n');
	process.exit(mode === 'error' ? 1 : 0);
});
`
);

function facts(overrides: Partial<EndpointFacts> = {}): EndpointFacts {
	return {
		serverMajor: 17,
		identity: null,
		schemas: [{ name: 'public', bytes: 1000 }],
		extensions: [],
		availableExtensions: null,
		allowedExtensions: null,
		empty: true,
		readOnly: false,
		production: false,
		superuser: true,
		roles: null,
		grantees: null,
		sizeBytes: 1000,
		storage: null,
		platformSchemas: [],
		platformExtensions: [],
		extensionTables: [],
		objects: [],
		platformObjects: [],
		creation: null,
		...overrides
	};
}

function spec(overrides: Partial<MoveSpec> = {}): MoveSpec {
	return {
		...newMoveSpec({ id: 'm', name: 'm', source: { kind: 'connection', id: 'a', driver: 'postgres' }, target: { kind: 'connection', id: 'b', driver: 'postgres' } }),
		...overrides
	};
}

interface Fake extends MoveRunHost {
	readonly calls: string[];
	readonly progress: MoveProgress[];
}

function host(options: { targetRows?: number; failCreate?: boolean } = {}): Fake {
	const calls: string[] = [];
	const progress: MoveProgress[] = [];
	return {
		calls,
		progress,
		tool: (name) => ({ file: process.execPath, args: [join(dir, name === 'pg_dump' ? 'fake-dump.cjs' : 'fake-restore.cjs')] }),
		access: async (side) => ({ host: side, port: 5432, user: 'u', password: 's3cret', database: side === 'source' ? 'app' : 'copy', sslmode: 'disable', caPem: null }),
		query: async (side, sql) => {
			if (sql.includes('pg_table_size')) {
				return JSON.stringify([{ schema: 'public', table: 'orders', bytes: 1000, rows: 10 }]);
			}
			if (sql.includes('pg_stat_progress_copy')) {
				return '[]';
			}
			if (sql.includes('query_to_xml')) {
				calls.push(`count ${side}`);
				return JSON.stringify([{ schema: 'public', table: 'orders', rows: side === 'source' ? 10 : (options.targetRows ?? 10) }]);
			}
			if (sql.includes('pg_sequences')) {
				return '[]';
			}
			calls.push(`${side}: ${sql}`);
			return null;
		},
		wake: async (side) => {
			calls.push(`wake ${side}`);
		},
		createTarget: async () => {
			calls.push('create');
			return { label: 'shop', connectionId: 'new' };
		},
		backupTarget: async () => {
			calls.push('backup');
			return { url: 'https://example/export' };
		},
		afterSource: async (action) => {
			calls.push(`after ${action}`);
			return 'The source was paused.';
		},
		onProgress: (snapshot) => progress.push(snapshot)
	};
}

async function run(mode: string, input: { spec?: MoveSpec; host?: Fake; target?: EndpointFacts; signal?: AbortSignal } = {}) {
	const out = join(dir, `${mode}-${Math.random()}.json`);
	process.env.FAKE_MODE = mode;
	process.env.FAKE_OUT = out;
	process.env.PGSERVICE = 'somewhere-else';
	const fake = input.host ?? host();
	const result = await runMove(
		{ runId: 'r', spec: input.spec ?? spec(), facts: { source: facts(), target: input.target ?? facts() }, signal: input.signal ?? new AbortController().signal, pollMs: 20 },
		fake
	);
	delete process.env.PGSERVICE;
	const dump = (() => {
		try {
			return JSON.parse(readFileSync(out, 'utf8')) as { args: string[]; password: string | null; database: string; service: string | null };
		} catch {
			return null;
		}
	})();
	return { result, fake, dump };
}

test('a clean move: every phase reported, counts matched, and the password only in the environment', async () => {
	const { result, fake, dump } = await run('ok');
	assert.equal(result.status, 'success', result.error ?? '');
	assert.deepEqual(result.tables, [{ schema: 'public', table: 'orders', sourceRows: 10, targetRows: 10, matches: true }]);
	const phases = [...new Set(fake.progress.map((snapshot) => snapshot.phase))];
	assert.deepEqual(phases, ['starting', 'schema', 'data', 'indexes', 'verifying', 'done']);
	assert.equal(fake.progress.at(-1)?.tables[0].state, 'done');
	assert.ok(dump);
	assert.equal(dump.password, 's3cret');
	assert.equal(dump.database, 'app');
	assert.equal(dump.service, null, 'a PG* variable from the user shell reached the tool');
	assert.ok(!dump.args.some((arg) => arg.includes('s3cret')));
	assert.ok(dump.args.includes('--compress=0'));
	assert.equal(result.bytes, 64 * 1024);
	assert.deepEqual(fake.calls.filter((call) => call.startsWith('wake')), ['wake source', 'wake target']);
});

test('an object that did not restore makes the move partial, names it, and leaves the source alone', async () => {
	const { result, fake } = await run('error', { spec: spec({ source: { kind: 'cloud', ref: 'qwertyzxcv123', driver: 'postgres' }, sourceAfter: 'pause' }) });
	assert.equal(result.status, 'partial');
	assert.equal(result.failures.length, 1);
	assert.equal(result.failures[0].object, 'TABLE broken');
	assert.equal(result.failures[0].command, 'CREATE TABLE public.broken (\n    v public.vector(3)\n);');
	assert.ok(!fake.calls.includes('after pause'));
	assert.equal(fake.progress.at(-1)?.objectsFailed, 1);
});

test('a row count that does not match is partial too', async () => {
	const { result } = await run('ok', { host: host({ targetRows: 9 }) });
	assert.equal(result.status, 'partial');
});

test('only a success pauses the source, and says so', async () => {
	const { result, fake } = await run('ok', { spec: spec({ source: { kind: 'cloud', ref: 'qwertyzxcv123', driver: 'postgres' }, sourceAfter: 'pause' }) });
	assert.equal(result.status, 'success');
	assert.ok(fake.calls.includes('after pause'));
	assert.equal(result.sourceAfter, 'The source was paused.');
});

test('a dump that cannot connect fails the move with its own reason', async () => {
	const { result } = await run('dumpfail');
	assert.equal(result.status, 'failed');
	assert.match(result.error ?? '', /password authentication failed/);
});

test('replace saves a copy first, then empties the target in one transaction, then restores', async () => {
	const target = facts({ empty: false, objects: [{ schema: 'public', name: 'leftover', kind: 'table', arguments: null }] });
	const { result, fake } = await run('ok', { spec: spec({ targetMode: 'replace' }), target });
	assert.equal(result.status, 'success', result.error ?? '');
	assert.deepEqual(result.backup, { url: 'https://example/export' });
	const backup = fake.calls.indexOf('backup');
	const drop = fake.calls.findIndex((call) => call.startsWith('target: begin;'));
	assert.ok(backup >= 0 && drop > backup);
	assert.equal(fake.calls[drop], 'target: begin;\ndrop table if exists "public"."leftover" cascade;\ncommit;');
});

test('a created target is kept and reported when the move then fails', async () => {
	const { result, fake } = await run('dumpfail', { spec: spec({ target: { kind: 'newDatabase', serverConnectionId: 'b', database: 'shop', driver: 'postgres' } }) });
	assert.equal(result.status, 'failed');
	assert.deepEqual(result.created, { label: 'shop', connectionId: 'new' });
	assert.ok(fake.calls.includes('create'));
	assert.ok(!fake.calls.includes('wake target'));
});

test('cancelling kills both tools and reports a stopped move', async () => {
	const controller = new AbortController();
	const started = Date.now();
	setTimeout(() => controller.abort(), 300);
	const { result } = await run('slow', { signal: controller.signal });
	assert.equal(result.status, 'cancelled');
	assert.ok(Date.now() - started < 10_000);
});

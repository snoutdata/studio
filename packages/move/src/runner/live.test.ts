/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { test } from 'node:test';
import { endpointFactsFromPg, NO_PLATFORM, PG_FACTS_SQL, quoteLiteral } from '../index.js';
import type { EndpointFacts } from '../facts.js';
import type { MoveProgress } from '../progress.js';
import { createDatabaseSql } from '../runSql.js';
import { newMoveSpec, type MoveSpec } from '../spec.js';
import type { PgAccess } from './env.js';
import { psqlQuery } from './psql.js';
import { runMove, type MoveRunHost } from './run.js';

/*
 * A real move between two databases on a real Postgres, with the real tools. Opt-in:
 *
 *   SNOUT_MOVE_TEST_TOOLS=<a Postgres 17 bin directory>
 *   SNOUT_MOVE_TEST_PG=<host>:<port>:<user>:<password>   (a user that may create databases)
 *
 * It creates `move_live_src` and `move_live_dst` and drops both at the end.
 */

const tools = process.env.SNOUT_MOVE_TEST_TOOLS;
const server = process.env.SNOUT_MOVE_TEST_PG;
const skip = !tools || !server ? 'set SNOUT_MOVE_TEST_TOOLS and SNOUT_MOVE_TEST_PG to run' : false;

const exe = (name: string): string => join(tools ?? '', process.platform === 'win32' ? `${name}.exe` : name);

function access(database: string): PgAccess {
	const [host, port, user, ...password] = (server ?? '').split(':');
	return { host, port: Number(port), user, password: password.join(':'), database, sslmode: 'prefer', caPem: null };
}

function sql(database: string, text: string): Promise<string> {
	return psqlQuery(exe('psql'), access(database), text);
}

const FIXTURE = `
create type status as enum ('new', 'paid');
create table customers (id int generated always as identity primary key, name text not null);
create table orders (id serial primary key, customer_id int references customers(id), status status not null default 'new', note text);
insert into customers (name) select 'c' || g from generate_series(1, 500) g;
insert into orders (customer_id, status, note) select 1 + (g % 500), 'paid', repeat('x', 300) from generate_series(1, 60000) g;
create view paid as select * from orders where status = 'paid';
create function touch() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger t before insert on orders for each row execute function touch();
create schema reporting;
create table reporting.daily (day date primary key, total bigint);
insert into reporting.daily select current_date - g, g from generate_series(1, 300) g;
analyze;
`;

async function factsOf(database: string): Promise<EndpointFacts> {
	return endpointFactsFromPg(await sql(database, PG_FACTS_SQL), { identity: database, readOnly: false, production: false, storage: null, platform: NO_PLATFORM });
}

function localHost(progress: MoveProgress[]): MoveRunHost {
	return {
		tool: (name) => ({ file: exe(name), args: [] }),
		access: async (side) => access(side === 'source' ? 'move_live_src' : 'move_live_dst'),
		query: (side, text) => sql(side === 'source' ? 'move_live_src' : 'move_live_dst', text),
		wake: async () => undefined,
		createTarget: async () => {
			await sql('postgres', createDatabaseSql('move_live_dst'));
			return { label: 'move_live_dst', connectionId: null };
		},
		backupTarget: async () => null,
		afterSource: async () => 'nothing',
		onProgress: (snapshot) => progress.push(snapshot)
	};
}

test('a local database moves into a new one and back over it, with every count matching', { skip, timeout: 300_000 }, async () => {
	await sql('postgres', 'drop database if exists move_live_src');
	await sql('postgres', 'drop database if exists move_live_dst');
	await sql('postgres', 'create database move_live_src');
	try {
		await sql('move_live_src', FIXTURE);

		// Into a database the move creates.
		const first: MoveSpec = newMoveSpec({
			id: 'live',
			name: 'live',
			source: { kind: 'connection', id: 'src', driver: 'postgres' },
			target: { kind: 'newDatabase', serverConnectionId: 'srv', database: 'move_live_dst', driver: 'postgres' }
		});
		const progress: MoveProgress[] = [];
		const created = await runMove(
			{ runId: 'one', spec: first, facts: { source: await factsOf('move_live_src'), target: { ...(await factsOf('postgres')), empty: true, objects: [] } }, signal: new AbortController().signal, pollMs: 100 },
			localHost(progress)
		);
		assert.equal(created.status, 'success', JSON.stringify({ error: created.error, failures: created.failures, tables: created.tables }));
		assert.deepEqual(
			created.tables.map((table) => [`${table.schema}.${table.table}`, table.targetRows]),
			[
				['public.customers', 500],
				['public.orders', 60000],
				['reporting.daily', 300]
			]
		);
		assert.ok(created.sequences.length >= 2 && created.sequences.every((sequence) => sequence.matches));
		assert.ok(progress.some((snapshot) => snapshot.phase === 'data'));
		assert.equal(progress.at(-1)?.phase, 'done');

		// Again, replacing it: a table only the target has must be gone afterwards.
		await sql('move_live_dst', 'create table public.leftover (x int)');
		const second = await runMove(
			{ runId: 'two', spec: { ...first, target: { kind: 'connection', id: 'dst', driver: 'postgres' }, targetMode: 'replace' }, facts: { source: await factsOf('move_live_src'), target: await factsOf('move_live_dst') }, signal: new AbortController().signal, pollMs: 100 },
			localHost([])
		);
		assert.equal(second.status, 'success', JSON.stringify({ error: second.error, failures: second.failures }));
		assert.equal(await sql('move_live_dst', "select to_regclass('public.leftover') is null"), 't');
		assert.equal(await sql('move_live_dst', 'select count(*) from orders'), '60000');
	} finally {
		await sql('postgres', 'drop database if exists move_live_dst');
		await sql('postgres', 'drop database if exists move_live_src');
	}
});

test('a hostile name stays inside its literal through psql with standard_conforming_strings off', { skip }, async () => {
	// Under `off` a plain literal would let psql read `\!` as a meta-command and run a shell.
	const name = "\\' \\! echo escaped\n";
	const answer = await sql('postgres', `set standard_conforming_strings = off;\nselect ${quoteLiteral(name)};`);
	assert.equal(answer, name.trim());
});

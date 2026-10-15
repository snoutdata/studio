/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ToolLog, type ToolLogEvent } from './toolLog.js';

// Verbatim from pg_restore 17.11 (theseus-rs build, Windows), restoring into a database that already
// had a table called `orders`, 2026-09-13. Trimmed, never edited.
const CAPTURED = `pg_restore: connecting to database for restore
pg_restore: creating SCHEMA "reporting"
pg_restore: creating EXTENSION "pg_trgm"
pg_restore: creating COMMENT "EXTENSION pg_trgm"
pg_restore: creating TYPE "public.status"
pg_restore: creating TABLE "public.orders"
pg_restore: while PROCESSING TOC:
pg_restore: from TOC entry 222; 1259 16404 TABLE orders postgres
pg_restore: error: could not execute query: ERROR:  relation "orders" already exists
Command was: CREATE TABLE public.orders (
    id integer NOT NULL,
    note text
);


pg_restore: creating VIEW "public.paid"
pg_restore: from TOC entry 223; 1259 16418 VIEW paid postgres
pg_restore: error: could not execute query: ERROR:  column "id" does not exist
LINE 2:  SELECT id,
                ^
Command was: CREATE VIEW public.paid AS
 SELECT id
   FROM public.orders;


pg_restore: processing data for table "public.customers"
pg_restore: processing data for table "public.orders"
pg_restore: from TOC entry 4967; 0 16404 TABLE DATA orders postgres
pg_restore: error: could not execute query: ERROR:  column "id" of relation "orders" does not exist
Command was: COPY public.orders (id, customer_id, status, note) FROM stdin;
pg_restore: processing data for table "reporting.daily"
pg_restore: executing SEQUENCE SET orders_id_seq
pg_restore: creating CONSTRAINT "public.customers customers_pkey"
pg_restore: creating FK CONSTRAINT "public.orders orders_customer_id_fkey"
pg_restore: warning: errors ignored on restore: 3`;

function read(text: string): { log: ToolLog; events: ToolLogEvent[] } {
	const log = new ToolLog();
	const events: ToolLogEvent[] = [];
	for (const line of text.split('\n')) {
		const event = log.push(line);
		if (event) {
			events.push(event);
		}
	}
	return { log, events };
}

test('the objects, the tables whose rows are copied, and the count pg_restore ignored', () => {
	const { events } = read(CAPTURED);
	assert.deepEqual(
		events.filter((event) => event.kind === 'data'),
		[
			{ kind: 'data', schema: 'public', table: 'customers' },
			{ kind: 'data', schema: 'public', table: 'orders' },
			{ kind: 'data', schema: 'reporting', table: 'daily' }
		]
	);
	assert.deepEqual(events.find((event) => event.kind === 'creating'), { kind: 'creating', desc: 'SCHEMA', object: 'reporting' });
	assert.ok(events.some((event) => event.kind === 'creating' && event.desc === 'FK CONSTRAINT' && event.object === 'public.orders orders_customer_id_fkey'));
	assert.deepEqual(events.at(-1), { kind: 'ignored', count: 3 });
});

test('each failure keeps its entry, its whole message and the statement, across the unprefixed lines', () => {
	const failures = read(CAPTURED).log.failures();
	assert.equal(failures.length, 3);
	assert.deepEqual(failures[0], {
		object: 'TABLE orders',
		message: 'could not execute query: ERROR:  relation "orders" already exists',
		command: 'CREATE TABLE public.orders (\n    id integer NOT NULL,\n    note text\n);',
		harmless: false
	});
	assert.equal(failures[1].object, 'VIEW paid');
	assert.match(failures[1].message, /column "id" does not exist\nLINE 2: {2}SELECT id,/);
	assert.equal(failures[1].command, 'CREATE VIEW public.paid AS\n SELECT id\n   FROM public.orders;');
	assert.equal(failures[2].object, 'TABLE DATA orders');
	assert.equal(failures[2].command, 'COPY public.orders (id, customer_id, status, note) FROM stdin;');
});

test('a statement printed as a detail line (PG 16 style) is read the same way', () => {
	const { log } = read(`pg_restore: error: could not execute query: ERROR:  permission denied
pg_restore: detail: Command was: ALTER TABLE x
    OWNER TO y;`);
	assert.equal(log.failures()[0].command, 'ALTER TABLE x\n    OWNER TO y;');
});

test('the comment on a platform-owned extension is harmless, and nothing else is', () => {
	const { log } = read(`pg_restore: from TOC entry 4; 0 0 COMMENT EXTENSION pg_stat_statements platform_admin
pg_restore: error: could not execute query: ERROR:  must be owner of extension pg_stat_statements
Command was: COMMENT ON EXTENSION pg_stat_statements IS 'track planning';
pg_restore: error: could not execute query: ERROR:  extension "vector" is not available`);
	assert.deepEqual(log.failures().map((failure) => failure.harmless), [true, false]);
});

test('an object NAMED like the harmless error cannot hide its own failure', () => {
	// The server quotes the name in its message, so a substring test would be fooled by it.
	const named = read(`pg_restore: from TOC entry 223; 1259 16418 VIEW must be owner of extension x postgres
pg_restore: error: could not execute query: ERROR:  relation "must be owner of extension x" does not exist
Command was: CREATE VIEW public."must be owner of extension x" AS SELECT 1;`).log.failures();
	assert.deepEqual(named.map((failure) => failure.harmless), [false]);

	// The right first line on the wrong entry (a function raising that text from an index).
	const raised = read(`pg_restore: from TOC entry 300; 1259 16500 INDEX i postgres
pg_restore: error: could not execute query: ERROR:  must be owner of extension x
Command was: CREATE INDEX i ON public.t USING btree (public.f(c));`).log.failures();
	assert.deepEqual(raised.map((failure) => failure.harmless), [false]);

	// A forged entry and a forged statement smuggled in through newlines: the real statement still
	// follows, so the statement is no longer exactly the COMMENT.
	const forged = read(`pg_restore: from TOC entry 300; 1259 16500 INDEX i
pg_restore: from TOC entry 4; 0 0 COMMENT EXTENSION x postgres
pg_restore: error: could not execute query: ERROR:  must be owner of extension x
Command was: COMMENT ON EXTENSION x IS 'y';
Command was: CREATE INDEX i ON public.t USING btree (public.f(c));`).log.failures();
	assert.deepEqual(forged.map((failure) => failure.harmless), [false]);

	// The comment on a DIFFERENT extension than the one the error names.
	const other = read(`pg_restore: from TOC entry 4; 0 0 COMMENT EXTENSION pg_trgm postgres
pg_restore: error: could not execute query: ERROR:  must be owner of extension x
Command was: COMMENT ON EXTENSION pg_trgm IS 'y';`).log.failures();
	assert.deepEqual(other.map((failure) => failure.harmless), [false]);
});

test('a platform event trigger that cannot be restored is harmless, in all three ways it fails', () => {
	const statement = (name: string, schema: string): string => `Command was: CREATE EVENT TRIGGER ${name} ON ddl_command_end
         WHEN TAG IN ('CREATE SCHEMA')
   EXECUTE FUNCTION ${schema}.${name}();`;
	const { log } = read(`pg_restore: from TOC entry 4180; 3466 16999 EVENT TRIGGER snoutpod_grant_new_schema db_owner
pg_restore: error: could not execute query: ERROR:  schema "snout_ext" does not exist
${statement('snoutpod_grant_new_schema', 'snout_ext')}
pg_restore: from TOC entry 4181; 3466 17000 EVENT TRIGGER snoutpod_oauth_read_new_schema db_owner
pg_restore: error: could not execute query: ERROR:  event trigger "snoutpod_oauth_read_new_schema" already exists
${statement('snoutpod_oauth_read_new_schema', 'extensions')}
pg_restore: from TOC entry 4182; 3466 17001 EVENT TRIGGER snoutpod_grant_new_schema db_owner
pg_restore: error: could not execute query: ERROR:  permission denied to create event trigger "snoutpod_grant_new_schema"
HINT:  Must be superuser to create an event trigger.
${statement('snoutpod_grant_new_schema', 'snout_ext')}`);
	const failures = log.failures();
	assert.equal(failures.length, 3);
	assert.deepEqual(failures.map((failure) => failure.harmless), [true, true, true]);
});

test('an event trigger of the customer\'s own, or one calling a function elsewhere, still counts', () => {
	const own = read(`pg_restore: from TOC entry 4180; 3466 16999 EVENT TRIGGER audit_ddl postgres
pg_restore: error: could not execute query: ERROR:  schema "snout_ext" does not exist
Command was: CREATE EVENT TRIGGER audit_ddl ON ddl_command_end
         WHEN TAG IN ('CREATE SCHEMA')
   EXECUTE FUNCTION snout_ext.audit_ddl();`).log.failures();
	assert.deepEqual(own.map((failure) => failure.harmless), [false]);
	const elsewhere = read(`pg_restore: from TOC entry 4180; 3466 16999 EVENT TRIGGER snoutpod_grant_new_schema postgres
pg_restore: error: could not execute query: ERROR:  schema "audit" does not exist
Command was: CREATE EVENT TRIGGER snoutpod_grant_new_schema ON ddl_command_end
         WHEN TAG IN ('CREATE SCHEMA')
   EXECUTE FUNCTION audit.snoutpod_grant_new_schema();`).log.failures();
	assert.deepEqual(elsewhere.map((failure) => failure.harmless), [false]);
	const otherError = read(`pg_restore: from TOC entry 4180; 3466 16999 EVENT TRIGGER snoutpod_grant_new_schema postgres
pg_restore: error: could not execute query: ERROR:  out of memory
Command was: CREATE EVENT TRIGGER snoutpod_grant_new_schema ON ddl_command_end
         WHEN TAG IN ('CREATE SCHEMA')
   EXECUTE FUNCTION snout_ext.snoutpod_grant_new_schema();`).log.failures();
	assert.deepEqual(otherError.map((failure) => failure.harmless), [false]);
});

test('a quoted extension name is still recognised as the harmless comment', () => {
	const { log } = read(`pg_restore: from TOC entry 4; 0 0 COMMENT EXTENSION "uuid-ossp" platform_admin
pg_restore: error: could not execute query: ERROR:  must be owner of extension uuid-ossp
Command was: COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';`);
	assert.deepEqual(log.failures().map((failure) => failure.harmless), [true]);
});

test('an entry with no owner keeps its whole name (measured on a hosted project)', () => {
	const { log } = read(`pg_restore: from TOC entry 5; 3079 16390 EXTENSION vector (no owner)
pg_restore: error: could not execute query: ERROR:  extension "vector" is not available
Command was: CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;`);
	assert.equal(log.failures()[0].object, 'EXTENSION vector');
});

test('a pg_dump failure is read too, so its reason reaches the report', () => {
	const { log } = read('pg_dump: error: connection to server at "127.0.0.1", port 5432 failed: FATAL:  password authentication failed for user "u"');
	assert.match(log.failures()[0].message, /password authentication failed/);
});

test('a failed statement carrying the source credential is reported redacted, message included', () => {
	const log = new ToolLog();
	const lines = [
		'pg_restore: from TOC entry 4012; 6100 16500 SUBSCRIPTION sub postgres',
		'pg_restore: error: could not execute query: ERROR:  syntax error at or near "x"',
		"LINE 1: CREATE SUBSCRIPTION sub CONNECTION 'host=h password=hunter2 x' PUBLICATION p",
		"Command was: CREATE SUBSCRIPTION sub CONNECTION 'host=h password=hunter2 x' PUBLICATION p;",
		'pg_restore: from TOC entry 4013; 1417 16501 USER MAPPING USER MAPPING app SERVER remote postgres',
		'pg_restore: error: could not execute query: ERROR:  permission denied for foreign server remote',
		"Command was: CREATE USER MAPPING FOR app SERVER remote OPTIONS (password 'hunter2');"
	];
	for (const line of lines) {
		log.push(line);
	}
	const failures = log.failures();
	assert.equal(failures.length, 2);
	for (const failure of failures) {
		assert.ok(!`${failure.message}\n${failure.command}`.includes('hunter2'), JSON.stringify(failure));
	}
	assert.match(failures[0].command ?? '', /password=<redacted> x/);
	assert.match(failures[1].command ?? '', /OPTIONS \(password <redacted>\)/);
});

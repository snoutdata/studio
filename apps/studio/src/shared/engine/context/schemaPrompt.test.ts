/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { DatabaseSchema, TableInfo } from '../../schema';
import type { KnowledgeNote, KnowledgeScope } from '../../knowledge';
import { completionFocus, partialIdentifier } from './completionGuard';
import { buildAgentPrompt, buildAmbientComment, buildCompletionPrompt, buildCompletionUser, buildEditPrompt, buildEditUser, buildGlossaryBlock, buildKnowledgeDraftPrompt, buildKnowledgeDraftUser, buildSchemaComment, buildSystemPrompt, buildTableUsage, cleanKnowledgeDraft, editDecoyTables, expandVocabulary, extractCompletion, queryTokens } from './schemaPrompt';

function kbNote(scope: KnowledgeScope, text: string, target?: string, pinned?: boolean): KnowledgeNote {
	return { id: text, connectionId: 'c1', scope, target, text, enabled: true, pinned, source: 'manual', createdAt: 1, updatedAt: 1 };
}

function table(name: string, columnCount: number): TableInfo {
	return {
		name,
		schema: 'app',
		kind: 'table',
		columns: Array.from({ length: columnCount }, (_, i) => ({ name: `c${i}`, dataType: 'int', nullable: true, isPrimaryKey: i === 0 })),
		primaryKey: ['c0'],
		foreignKeys: [],
	};
}

describe('buildSystemPrompt', () => {
	test('states the dialect', () => {
		assert.match(buildSystemPrompt('PostgreSQL', null), /PostgreSQL/);
	});

	test('handles no schema (not connected)', () => {
		assert.match(buildSystemPrompt('MySQL', null), /No schema is available/);
	});

	test('documentMode proposes a json aggregation pipeline, not sql', () => {
		const schema: DatabaseSchema = { database: 'shop', fetchedAt: 0, tables: [table('orders', 2)] };
		const doc = buildSystemPrompt('MongoDB', schema, { documentMode: true });
		assert.match(doc, /aggregation pipeline/i);
		assert.match(doc, /```json/);
		assert.match(doc, /Insert into pipeline/);
		// It must NOT carry the SQL framing (the ```sql block instruction).
		assert.doesNotMatch(doc, /runnable MongoDB SQL/);
		assert.doesNotMatch(doc, /```sql/);
		// Relational (default) is unchanged: still SQL + ```sql.
		const sql = buildSystemPrompt('MySQL', schema);
		assert.match(sql, /runnable MySQL SQL/);
		assert.match(sql, /```sql/);
		assert.doesNotMatch(sql, /aggregation pipeline/i);
	});

	test('carries the database\'s own table and column comments into the prompt', () => {
		// A DBA's COMMENT says what no amount of name-matching can infer, so it is the
		// cheapest grounding available. Distinct from `-- NOTE`, which is the user's own KB.
		const documented = table('payout', 2);
		documented.comment = 'Money we have sent out';
		documented.columns[1].comment = 'Gross, before fees';
		const prompt = buildSystemPrompt('MySQL', { database: 'shop', fetchedAt: 0, tables: [documented] });
		assert.match(prompt, /-- DESC: Money we have sent out/);
		assert.match(prompt, /-- COLS: c1: Gross, before fees/);
	});

	test('a series table is one table with its time column and rollups, and its partitions are folded away', () => {
		// SnoutTime: a hundred daily partitions would otherwise claim the detailed slice under
		// near-identical names, and the model would not know that leaving out the time filter reads
		// every one of them.
		const metrics = table('metrics', 2);
		metrics.columns[1].name = 'ts';
		metrics.series = {
			timeColumn: 'ts', timeType: 'timestamptz', partitionSize: '1 day', retention: '30 days',
			partitions: [
				{ name: 'metrics_p20260921', state: 'sealed' },
				{ name: 'metrics_p20260922', state: 'live' },
			],
			rollups: [{ schema: 'app', name: 'metrics_hourly', bucket: '01:00:00' }],
		};
		const parts = Array.from({ length: 40 }, (_, i) => {
			const p = table(`metrics_p202609${String(i).padStart(2, '0')}`, 2);
			p.partitionOf = { schema: 'app', name: 'metrics' };
			return p;
		});
		const hourly = table('metrics_hourly', 2);
		hourly.kind = 'view';
		hourly.rollup = { source: { schema: 'app', name: 'metrics' }, bucket: '01:00:00' };
		const catalog = { ...table('series', 2), schema: 'snouttime' };
		const delta = { ...table('delta_16670', 2), schema: 'snouttime_internal' };
		const store = { ...table('metrics_hourly_materialized', 2), rollupStoreOf: { schema: 'app', name: 'metrics_hourly' } };
		const prompt = buildSystemPrompt('PostgreSQL', { database: 'iot', fetchedAt: 0, snouttime: { version: '0.0.0' }, tables: [metrics, ...parts, hourly, catalog, delta, store] }, { focus: 'metrics per hour' });
		assert.match(prompt, /\(2 tables;/);
		assert.doesNotMatch(prompt, /metrics_p2026/);
		assert.match(prompt, /-- SERIES: time column ts \(1 day partitions, 1 of 2 sealed into a column store, rows kept 30 days\); always filter on ts/);
		assert.match(prompt, /snouttime\.bucket\(interval, ts\)/);
		assert.match(prompt, /rollups: app\.metrics_hourly \(01:00:00 buckets\)/);
		assert.match(prompt, /-- ROLLUP of app\.metrics by 01:00:00/);
		assert.doesNotMatch(prompt, /snouttime\.series|delta_16670|_materialized/);
	});

	test('a table that is not a series says nothing about series', () => {
		const prompt = buildSystemPrompt('PostgreSQL', { database: 'shop', fetchedAt: 0, tables: [table('orders', 2)] });
		assert.doesNotMatch(prompt, /-- SERIES|-- ROLLUP/);
	});

	test('a comment is collapsed to one line and length-capped', () => {
		const documented = table('payout', 1);
		documented.comment = `line one\n  line two ${'x'.repeat(400)}`;
		const prompt = buildSystemPrompt('MySQL', { database: 'shop', fetchedAt: 0, tables: [documented] });
		// One table per line is the shape the prompt relies on: a raw newline would break it.
		const line = prompt.split('\n').find((l) => l.includes('app.payout(')) ?? '';
		assert.match(line, /-- DESC: line one line two x+…/);
		assert.ok(line.length < 400, `comment should be capped, got a ${line.length}-char line`);
	});

	test('an undocumented schema gains no comment markers', () => {
		const prompt = buildSystemPrompt('MySQL', { database: 'shop', fetchedAt: 0, tables: [table('orders', 2)] });
		assert.doesNotMatch(prompt, /-- DESC:/);
		assert.doesNotMatch(prompt, /-- COLS:/);
	});

	test('inlines tables + columns for a small schema', () => {
		const schema: DatabaseSchema = { database: 'shop', fetchedAt: 0, tables: [table('orders', 2), table('customers', 2)] };
		const prompt = buildSystemPrompt('MySQL', schema);
		assert.match(prompt, /app\.orders\(/);
		assert.match(prompt, /app\.customers\(/);
		assert.match(prompt, /c0 int PK/);
	});

	test('keeps detail for the top-N of a huge schema, announces the rest without enumerating', () => {
		const tables = Array.from({ length: 2000 }, (_, i) => table(`tbl_${i}`, 20));
		const prompt = buildSystemPrompt('MySQL', { database: 'big', fetchedAt: 0, tables });
		// The top-N still gets full column detail (no all-or-nothing cliff)...
		assert.match(prompt, /app\.tbl_0\(/);
		// ...and the overflow tail is announced as a single line — NOT enumerated, since
		// small models suffer context rot when 2000 names drown the detailed slice.
		assert.match(prompt, /other tables exist/i);
		assert.doesNotMatch(prompt, /app\.tbl_1999\b/);
	});

	test('one-shot path stays honest about the hidden tables: no tool promise, forbids claiming completeness', () => {
		const tables = Array.from({ length: 100 }, (_, i) => table(`tbl_${i}`, 5));
		const prompt = buildSystemPrompt('MySQL', { database: 'big', fetchedAt: 0, tables });
		// The one-shot (Ask) path has no tools, so it must NOT tell the model to call list_tables...
		assert.doesNotMatch(prompt, /list_tables/);
		// ...and must tell it the visible set is not complete and the other names are unseen.
		assert.match(prompt, /not visible to you/i);
		assert.match(prompt, /never the complete set|not present them as an exhaustive list/i);
		// The behavioural rule: don't present a table list as exhaustive.
		assert.match(prompt, /never present a list of tables.*as complete or exhaustive/i);
	});

	test('caps the detailed slice at topTables, regardless of database size', () => {
		const tables = Array.from({ length: 50 }, (_, i) => table(`tbl_${i}`, 5));
		const prompt = buildSystemPrompt('MySQL', { database: 'm', fetchedAt: 0, tables }, { topTables: 3 });
		assert.match(prompt, /top 3 most relevant/i);
		// First three get column detail; the fourth onwards is not enumerated by name.
		assert.match(prompt, /app\.tbl_0\(/);
		assert.match(prompt, /app\.tbl_2\(/);
		assert.doesNotMatch(prompt, /app\.tbl_3\(/);
		assert.doesNotMatch(prompt, /app\.tbl_3\b/);
	});
});

describe('knowledge base injection', () => {
	test('buildGlossaryBlock renders enabled notes, empty when none', () => {
		assert.equal(buildGlossaryBlock([]), '');
		const block = buildGlossaryBlock([kbNote('glossary', 'sales lives in customer_order')]);
		assert.match(block, /taught you about THIS database/i);
		assert.match(block, /sales lives in customer_order/);
	});

	test('buildGlossaryBlock caps with an honest "N more" line', () => {
		const notes = Array.from({ length: 50 }, (_, i) => kbNote('glossary', `fact number ${i}`));
		const block = buildGlossaryBlock(notes);
		assert.match(block, /more notes? not shown/i);
	});

	test('a pinned table note force-includes its table into the detailed slice with zero lexical match', () => {
		// Ask about "widgets"; the pinned table shares no letters, so lexical ranking would drop it.
		const tables = [table('widgets', 3), table('gadgets', 3), table('customer_order', 3)];
		const schema: DatabaseSchema = { database: 'shop', fetchedAt: 0, tables };
		const notesByTable = new Map([['customer_order', [kbNote('table', 'this is the sales table', 'customer_order', true)]]]);
		const pinnedTables = new Set(['customer_order']);
		const prompt = buildSystemPrompt('MySQL', schema, { topTables: 1, focus: 'show me widgets', notesByTable, pinnedTables });
		// (a) the pinned table claims the (single) detailed slot despite no lexical match...
		assert.match(prompt, /app\.customer_order\(/);
		// (b) ...and its note text rides the schema line as a trailing comment.
		assert.match(prompt, /-- NOTE: this is the sales table/);
	});

	test('without a pin, a note on a lexically-unrelated table does not appear', () => {
		const tables = [table('widgets', 3), table('customer_order', 3)];
		const schema: DatabaseSchema = { database: 'shop', fetchedAt: 0, tables };
		const notesByTable = new Map([['customer_order', [kbNote('table', 'sales table', 'customer_order')]]]);
		const prompt = buildSystemPrompt('MySQL', schema, { topTables: 1, focus: 'show me widgets', notesByTable });
		assert.doesNotMatch(prompt, /-- NOTE: sales table/);
	});
});

describe('knowledge draft (Refine with AI)', () => {
	test('buildKnowledgeDraftPrompt asks for a plain-text fact and grounds in the schema', () => {
		const schema: DatabaseSchema = { database: 'shop', fetchedAt: 0, tables: [table('customer_order', 3)] };
		const p = buildKnowledgeDraftPrompt('MySQL', schema);
		assert.match(p, /the fact itself/i);
		assert.match(p, /NOT an instruction/i);
		assert.match(p, /app\.customer_order\(/);
	});

	test('buildKnowledgeDraftUser includes the transcript and the hint', () => {
		const u = buildKnowledgeDraftUser(
			[{ role: 'user', content: 'show me the last 10 users' }, { role: 'assistant', content: 'the user table has a date column' }],
			'date is the creation time',
		);
		assert.match(u, /User: show me the last 10 users/);
		assert.match(u, /Assistant: the user table has a date column/);
		assert.match(u, /date is the creation time/);
	});

	test('cleanKnowledgeDraft returns the plain fact untouched', () => {
		assert.equal(cleanKnowledgeDraft('fulfilled_date is the sale date'), 'fulfilled_date is the sale date');
	});

	test('cleanKnowledgeDraft strips code fences, wrapping quotes, and a label preamble', () => {
		assert.equal(cleanKnowledgeDraft('```\na fact\n```'), 'a fact');
		assert.equal(cleanKnowledgeDraft('"a fact"'), 'a fact');
		assert.equal(cleanKnowledgeDraft('Fact: a fact'), 'a fact');
	});

	test('cleanKnowledgeDraft collapses whitespace and falls back to the hint on empty', () => {
		assert.equal(cleanKnowledgeDraft('a   fact\nwith   gaps'), 'a fact with gaps');
		assert.equal(cleanKnowledgeDraft('   ', 'my hint'), 'my hint');
	});

	test('cleanKnowledgeDraft hard-clips an overlong fact', () => {
		assert.ok(cleanKnowledgeDraft('x'.repeat(500)).length <= 240);
	});
});

describe('buildSystemPrompt — stored routines', () => {
	test('renders functions with their introspected call signature + return type', () => {
		const schema: DatabaseSchema = {
			database: 'shop', fetchedAt: 0, tables: [table('delivery', 3)],
			routines: [{
				name: 'lookupName', schema: 'app', kind: 'function', returnType: 'varchar',
				parameters: [{ name: 'kind_id', dataType: 'int' }, { name: 'ref_id', dataType: 'int' }],
			}],
		};
		const prompt = buildSystemPrompt('MySQL', schema);
		assert.match(prompt, /Stored routines you may call/);
		assert.match(prompt, /app\.lookupName\(kind_id int, ref_id int\) → varchar \[function\]/);
	});

	test('shows (…) when parameters were not introspected', () => {
		const schema: DatabaseSchema = {
			database: 'shop', fetchedAt: 0, tables: [table('t', 1)],
			routines: [{ name: 'mystery', schema: 'app', kind: 'function', returnType: 'int' }],
		};
		assert.match(buildSystemPrompt('MySQL', schema), /app\.mystery\(…\)/);
	});

	test('omits the routine section entirely when there are none', () => {
		const schema: DatabaseSchema = { database: 'shop', fetchedAt: 0, tables: [table('t', 1)] };
		assert.doesNotMatch(buildSystemPrompt('MySQL', schema), /Stored routines/);
	});
});

describe('buildSystemPrompt — schema linking (focus)', () => {
	function named(name: string, columns: string[], foreignKeys: TableInfo['foreignKeys'] = []): TableInfo {
		return {
			name,
			schema: 'app',
			kind: 'table',
			columns: columns.map((c, i) => ({ name: c, dataType: 'int', nullable: true, isPrimaryKey: i === 0 })),
			primaryKey: [columns[0]],
			foreignKeys,
		};
	}

	test('ranks tables relevant to the question ahead of irrelevant ones', () => {
		const schema: DatabaseSchema = {
			database: 'shop', fetchedAt: 0,
			tables: [named('logs', ['id']), named('invoices', ['id']), named('audit_trail', ['id'])],
		};
		const prompt = buildSystemPrompt('MySQL', schema, { focus: 'list all invoices' });
		const invoices = prompt.indexOf('app.invoices');
		const logs = prompt.indexOf('app.logs');
		assert.ok(invoices !== -1 && invoices < logs, 'invoices should rank before logs');
	});

	test('a relevant table keeps its columns even when buried in a large schema', () => {
		const tables: TableInfo[] = Array.from({ length: 300 }, (_, i) => table(`noise_${i}`, 30));
		const orders = named('orders', ['id', 'customer_id', 'total'], [
			{ constraintName: 'fk', columns: ['customer_id'], referencedTable: 'customers', referencedColumns: ['id'] },
		]);
		const customers = named('customers', ['id', 'name']);
		tables.push(orders, customers);
		const prompt = buildSystemPrompt('MySQL', { database: 'shop', fetchedAt: 0, tables }, { focus: 'show me orders and their total' });
		// The matched table is surfaced with full columns despite being last in schema order...
		assert.match(prompt, /app\.orders\(.*total/);
		// ...and its FK neighbour is pulled in too.
		assert.match(prompt, /app\.customers\(/);
		// The noise is announced (count only), not enumerated by name.
		assert.match(prompt, /other tables exist/i);
	});
});

describe('schema linking through the user\'s own vocabulary', () => {
	function named(name: string, columns: string[]): TableInfo {
		return {
			name,
			schema: 'app',
			kind: 'table',
			columns: columns.map((c, i) => ({ name: c, dataType: 'int', nullable: true, isPrimaryKey: i === 0 })),
			primaryKey: [columns[0]],
			foreignKeys: [],
		};
	}

	/** The case lexical ranking cannot solve on its own: not one word of the question appears
	 *  anywhere in the schema, and no amount of stemming can bridge it. */
	const schema: DatabaseSchema = {
		database: 'shop', fetchedAt: 0,
		tables: [
			...Array.from({ length: 40 }, (_unused, i) => table(`noise_${i}`, 6)),
			named('subscription_cancellations', ['id', 'reason', 'cancelled_at']),
		],
	};

	test('a glossary note lends its words to the question, so "churn" finds the cancellations table', () => {
		const vocabulary = ['Churn means a cancelled subscription.'];
		const prompt = buildSystemPrompt('MySQL', schema, { topTables: 3, focus: 'which customers churned last quarter?', vocabulary });
		assert.match(prompt, /app\.subscription_cancellations\(/);
		// And without the glossary the same question cannot find it — which is the gap being closed.
		const blind = buildSystemPrompt('MySQL', schema, { topTables: 3, focus: 'which customers churned last quarter?' });
		assert.doesNotMatch(blind, /app\.subscription_cancellations\(/);
	});

	test('a table note that matches the question names its table outright', () => {
		// The commonest shape: the user taught the app what this table is FOR, in their own words.
		const notesByTable = new Map([['subscription_cancellations', [kbNote('table', 'this is where churn is recorded', 'subscription_cancellations')]]]);
		const prompt = buildSystemPrompt('MySQL', schema, { topTables: 3, focus: 'how much churn last month?', notesByTable });
		assert.match(prompt, /app\.subscription_cancellations\(/);
		// The note rides the line too, so the model knows WHY it is there.
		assert.match(prompt, /-- NOTE: this is where churn is recorded/);
	});

	test('a borrowed word never outranks a table the question actually named', () => {
		// "orders" is in the question AND is a table; a glossary note that happens to mention
		// `invoices` must not push it above the table the user literally asked for.
		const twoTables: DatabaseSchema = {
			database: 'shop', fetchedAt: 0,
			tables: [named('invoices', ['id']), named('orders', ['id'])],
		};
		const prompt = buildSystemPrompt('MySQL', twoTables, {
			focus: 'show me the orders',
			vocabulary: ['orders are billed through invoices'],
		});
		assert.ok(prompt.indexOf('app.orders') < prompt.indexOf('app.invoices'), 'the named table must win');
	});

	test('a glossary note that has nothing to do with the question changes nothing', () => {
		const vocabulary = ['Prices are always in cents.', 'The warehouse codes are legacy.'];
		const withNotes = buildSystemPrompt('MySQL', schema, { topTables: 3, focus: 'which customers churned?', vocabulary });
		const without = buildSystemPrompt('MySQL', schema, { topTables: 3, focus: 'which customers churned?' });
		assert.equal(withNotes, without);
	});

	test('a large knowledge base cannot flood the question with borrowed words', () => {
		// Every note shares the word "data" with the question, so all of them are candidates; the cap
		// is what stops one question inheriting a whole glossary's vocabulary.
		const vocabulary = Array.from({ length: 200 }, (_unused, i) => `data note ${i} mentions noise_${i}`);
		const link = expandVocabulary(queryTokens('where is the data'), vocabulary);
		assert.ok(link.tokens.size <= 24, `expanded to ${link.tokens.size} tokens`);
	});

	test('expansion needs a question: no focus, no borrowing', () => {
		const link = expandVocabulary(new Set<string>(), ['churn means a cancelled subscription']);
		assert.equal(link.tokens.size, 0);
		assert.equal(link.tables.size, 0);
	});
});

describe('buildTableUsage + usage-aware ranking', () => {
	function named(name: string, columns: string[]): TableInfo {
		return {
			name,
			schema: 'app',
			kind: 'table',
			columns: columns.map((c, i) => ({ name: c, dataType: 'int', nullable: true, isPrimaryKey: i === 0 })),
			primaryKey: [columns[0]],
			foreignKeys: [],
		};
	}

	test('counts each table once per query that references it', () => {
		const usage = buildTableUsage([
			'select * from customer where id = 1',
			'select c.* from customer c join orders o on o.customer_id = c.id',
			'SELECT * FROM Orders',
		]);
		assert.equal(usage.get('customer'), 2);
		assert.equal(usage.get('orders'), 2);
		assert.equal(usage.get('user_log'), undefined);
	});

	test('with no lexical match, the most-queried table claims the detailed slice', () => {
		const tables = [named('user_log', ['id', 'msg']), named('customer', ['id', 'name'])];
		const schema = { database: 'app', fetchedAt: 0, tables };
		const usage = buildTableUsage(Array.from({ length: 50 }, () => 'select * from customer'));
		// A generic question (no table names) + topTables:1 — usage decides which table gets columns.
		const prompt = buildSystemPrompt('MySQL', schema, { topTables: 1, focus: 'show me everything', tableUsage: usage });
		assert.match(prompt, /app\.customer\(/);
		assert.doesNotMatch(prompt, /app\.user_log\(/);
	});

	test('a strong lexical match still beats a frequently-queried but unrelated table', () => {
		const tables = [named('customer', ['id', 'name']), named('invoice', ['id', 'amount'])];
		const schema = { database: 'app', fetchedAt: 0, tables };
		const usage = buildTableUsage(Array.from({ length: 50 }, () => 'select * from customer'));
		// The question is about invoices; usage favours customer, but the name match must win.
		const prompt = buildSystemPrompt('MySQL', schema, { topTables: 1, focus: 'list every invoice', tableUsage: usage });
		assert.match(prompt, /app\.invoice\(/);
		assert.doesNotMatch(prompt, /app\.customer\(/);
	});
});

describe('buildAgentPrompt', () => {
	function named(name: string, columns: string[]): TableInfo {
		return {
			name,
			schema: 'app',
			kind: 'table',
			columns: columns.map((c, i) => ({ name: c, dataType: 'int', nullable: true, isPrimaryKey: i === 0 })),
			primaryKey: [columns[0]],
			foreignKeys: [],
		};
	}

	test('inlines top-N relevant tables with columns AND lists the tool protocol', () => {
		const tables: TableInfo[] = Array.from({ length: 50 }, (_, i) => table(`noise_${i}`, 5));
		tables.push(named('app_users', ['id', 'name', 'email']));
		const prompt = buildAgentPrompt('MySQL', { database: 'shop', fetchedAt: 0, tables }, { focus: 'list of users' });
		// Indexed schema is present: the user-question-relevant table is described in full.
		assert.match(prompt, /app\.app_users\(.*email/);
		// The tail is announced (count) so the model knows what else exists, not enumerated.
		assert.match(prompt, /other tables exist/i);
		// Structured tool protocol with numbered steps + an explicit "don't write prose" guard.
		assert.match(prompt, /describe_table/);
		assert.match(prompt, /1\.\s/);
		assert.match(prompt, /Do NOT write/i);
	});

	test('gates a performance fix on transcript evidence, not just principles', () => {
		const prompt = buildAgentPrompt('MySQL', { database: 'shop', fetchedAt: 0, tables: [named('orders', ['id', 'status_id'])] });
		// Reframed as a hard gate that blocks the ```sql block until the evidence exists this session.
		assert.match(prompt, /Hard gate — you may NOT emit a ```sql block/);
		// The four evidence requirements a modest model skips: describe_table claims, SHOW INDEX before
		// ALTER, EXPLAIN the FINAL rewrite, same rows + order out.
		assert.match(prompt, /describe_table on EVERY table/);
		assert.match(prompt, /SHOW INDEX FROM <table>/);
		assert.match(prompt, /EXPLAIN on your FINAL rewrite/);
		assert.match(prompt, /same SELECT list, same ORDER BY/i);
		// Selectivity must be measured, and an incomplete gate downgrades to UNVERIFIED.
		assert.match(prompt, /MEASURE its selectivity/);
		assert.match(prompt, /label the fix UNVERIFIED/);
	});

	// On 18 a low-cardinality column LEADING a multicolumn index is what skip scan wants, and a
	// one-column OR chain is already = ANY, so the selectivity rule is narrowed there and only there.
	test('adds the skip scan and OR notes on Postgres 18, and only there', () => {
		const tables = [named('orders', ['id', 'status_id'])];
		const pg18 = buildAgentPrompt('PostgreSQL', { database: 'shop', fetchedAt: 0, tables, serverVersionNum: 180001 });
		assert.match(pg18, /PostgreSQL 18 or later/);
		assert.match(pg18, /Skip scan:/);
		assert.match(pg18, /rewritten by the planner to col = ANY/);
		const pg17 = buildAgentPrompt('PostgreSQL', { database: 'shop', fetchedAt: 0, tables, serverVersionNum: 170006 });
		assert.doesNotMatch(pg17, /Skip scan:/);
		assert.match(pg17, /MEASURE its selectivity/);
		assert.doesNotMatch(buildAgentPrompt('MySQL', { database: 'shop', fetchedAt: 0, tables }), /Skip scan:/);
	});

	test('omits the SQL performance gate in document (MongoDB) mode', () => {
		const prompt = buildAgentPrompt('MongoDB', { database: 'shop', fetchedAt: 0, tables: [named('orders', ['id'])] }, { documentMode: true });
		assert.doesNotMatch(prompt, /Hard gate/);
	});

	test('requires a tool search before answering "which tables relate to X" enumeration', () => {
		const tables: TableInfo[] = Array.from({ length: 50 }, (_, i) => table(`noise_${i}`, 5));
		tables.push(named('app_users', ['id', 'name', 'email']));
		const prompt = buildAgentPrompt('MySQL', { database: 'shop', fetchedAt: 0, tables }, { focus: 'what tables relate to users' });
		// Agent path keeps the tool promise (it CAN enumerate)...
		assert.match(prompt, /list_tables/);
		// ...and must search before answering an enumeration question, never from the detailed list alone.
		assert.match(prompt, /MUST call search_columns\/list_tables/);
		assert.match(prompt, /search FIRST/i);
	});

	test('falls back gracefully when no connection is active', () => {
		const prompt = buildAgentPrompt('MySQL', null);
		assert.match(prompt, /No database is connected/);
	});

	test('gridInView: running is the user action — give final SQL for retrieval, reserve run_query for analysis (docked)', () => {
		const schema = { database: 'shop', fetchedAt: 0, tables: [named('orders', ['id'])] };
		const docked = buildAgentPrompt('MySQL', schema, { gridInView: true });
		// Running a query is the user's action; plain "show me / list" retrieval gets the final SQL.
		assert.match(docked, /running a query is the USER's action/i);
		assert.match(docked, /do NOT call run_query/);
		assert.match(docked, /Reserve run_query for when YOU need the rows/);
		// run_query rows go back to the model, not the grid.
		assert.match(docked, /do not appear in the user's grid/);
		// Full-screen chat (no grid, no Run button): the note must NOT appear — the model presents data itself.
		const full = buildAgentPrompt('MySQL', schema, { gridInView: false });
		assert.doesNotMatch(full, /do NOT call run_query/);
	});

	test('gridInView note also rides the connection-pending agent prompt (tools, no schema yet)', () => {
		const prompt = buildAgentPrompt('MySQL', null, { connectionPending: true, gridInView: true });
		assert.match(prompt, /do NOT call run_query/);
	});

	test('dbRestricted: the user declined to connect — answer generally, no faked data, no nagging', () => {
		const prompt = buildAgentPrompt('MySQL', null, { dbRestricted: true });
		// It must say there's no access on purpose and not fall back to the generic "ask to connect".
		assert.match(prompt, /chose NOT to connect/);
		assert.match(prompt, /Do not invent table names/);
		assert.match(prompt, /do not keep asking them to connect/i);
		assert.doesNotMatch(prompt, /No database is connected/);
		// A chart ask can't be data-backed without a connection: tell them, don't invent values.
		assert.match(prompt, /CANNOT fetch real values/);
	});

	test('dbRestricted applies to the one-shot (Ask) prompt too', () => {
		const prompt = buildSystemPrompt('MySQL', null, { dbRestricted: true });
		assert.match(prompt, /chose NOT to connect/);
		assert.doesNotMatch(prompt, /No schema is available/);
	});

	test('ambiguousConnections: no DB selected + several connected — ask which, list each dialect, do not guess', () => {
		const opts = { ambiguousConnections: [{ label: 'MySQL - Prod', dialect: 'MySQL' }, { label: 'PG - Prod', dialect: 'PostgreSQL' }] };
		for (const prompt of [buildAgentPrompt('SQL', null, opts), buildSystemPrompt('SQL', null, opts)]) {
			assert.match(prompt, /ask the user which/i);
			// Each candidate is offered with its dialect so the user (and model) can disambiguate.
			assert.match(prompt, /MySQL - Prod \(MySQL\)/);
			assert.match(prompt, /PG - Prod \(PostgreSQL\)/);
			assert.match(prompt, /Do NOT guess the dialect/);
			// It must NOT fall through to the generic "no connection" or "declined" notes.
			assert.doesNotMatch(prompt, /No schema is available/);
			assert.doesNotMatch(prompt, /chose NOT to connect/);
		}
	});

	test('ambiguousConnections takes precedence over dbRestricted when both are set', () => {
		const prompt = buildAgentPrompt('SQL', null, { dbRestricted: true, ambiguousConnections: [{ label: 'A', dialect: 'MySQL' }, { label: 'B', dialect: 'PostgreSQL' }] });
		assert.match(prompt, /ask the user which/i);
		assert.doesNotMatch(prompt, /chose NOT to connect/);
	});
});

describe('buildEditPrompt', () => {
	function named(name: string, columns: string[], foreignKeys: TableInfo['foreignKeys'] = []): TableInfo {
		return {
			name,
			schema: 'app',
			kind: 'table',
			columns: columns.map((c, i) => ({ name: c, dataType: 'int', nullable: true, isPrimaryKey: i === 0 })),
			primaryKey: [columns[0]],
			foreignKeys,
		};
	}

	test('no schema: does not claim a "schema below" exists', () => {
		const prompt = buildEditPrompt('MySQL', null, {}, 'edit');
		assert.match(prompt, /No database schema is available/i);
		assert.doesNotMatch(prompt, /schema below/i);
	});

	test('ranks the exactly-named table above tables that merely contain the word', () => {
		// A singular `user` table buried under `archived_users` (two name hits) and `user_log`
		// (name + column hits). With topTables:1, only the #1 table is detailed — it must be
		// `user`, so the model sees the right columns to correct to.
		const schema: DatabaseSchema = {
			database: 'app', fetchedAt: 0,
			tables: [
				named('archived_users', ['id', 'name', 'email']),
				named('user_log', ['id', 'user_id', 'username', 'update_user_id']),
				named('dashboard_user', ['id', 'user_id']),
				named('user', ['id', 'name', 'email']),
			],
		};
		const prompt = buildEditPrompt('MySQL', schema, { topTables: 1, focus: 'fix the sql select * from users' }, 'edit');
		assert.match(prompt, /app\.`user`\(/, 'the exact `user` table should be the one detailed (quoted — reserved word)');
		assert.doesNotMatch(prompt, /app\.archived_users\(/, '`archived_users` should not outrank `user`');
		assert.doesNotMatch(prompt, /app\.user_log\(/, '`user_log` should not outrank `user`');
	});

	test('with a schema, keeps the "correct the identifier" nudge', () => {
		const schema: DatabaseSchema = { database: 'app', fetchedAt: 0, tables: [named('user', ['id', 'name'])] };
		const prompt = buildEditPrompt('MySQL', schema, { focus: 'fix select * from users' }, 'edit');
		assert.match(prompt, /correct it to the table whose NAME most closely matches/i);
	});

	test('tells the model not to carry a column across when it retargets a different table', () => {
		// "select * from warehouse where company_id=7" + "I need every shelf in this warehouse" must
		// not become "select * from shelf where company_id=7": the table swapped, the column rode
		// along, and shelf only has warehouse_id.
		const schema: DatabaseSchema = {
			database: 'app', fetchedAt: 0,
			tables: [
				named('warehouse', ['id', 'name', 'company_id']),
				named('shelf', ['id', 'name', 'warehouse_id'], [{ constraintName: 'fk_shelf_warehouse', columns: ['warehouse_id'], referencedTable: 'warehouse', referencedColumns: ['id'] }]),
			],
		};
		const prompt = buildEditPrompt('MySQL', schema, { focus: 'shelf warehouse company_id' }, 'edit');
		assert.match(prompt, /Never carry a column name across/i);
		assert.match(prompt, /foreign-key column to relate them/i);
		// The FK edge it's told to use must actually be in the rendered schema.
		assert.match(prompt, /warehouse_id→warehouse\(id\)/);
	});

	test('renders knowledge-base table notes + honours pinned tables (parity with chat)', () => {
		const tables = [named('a', ['id']), named('b', ['id']), named('customer_order', ['id', 'total'])];
		const schema: DatabaseSchema = { database: 'app', fetchedAt: 0, tables };
		const prompt = buildEditPrompt('MySQL', schema, {
			topTables: 1,
			focus: 'tidy this up',
			notesByTable: new Map([['customer_order', [kbNote('table', 'sales live here', 'customer_order', true)]]]),
			pinnedTables: new Set(['customer_order']),
		}, 'edit');
		assert.match(prompt, /app\.customer_order\(/, 'a pinned table claims the detailed slice');
		assert.match(prompt, /sales live here/, "the table's note rides its schema line");
	});
});

describe('buildEditUser — deterministic table correction', () => {
	function named(name: string, columns: string[]): TableInfo {
		return {
			name,
			schema: 'app',
			kind: 'table',
			columns: columns.map((c, i) => ({ name: c, dataType: 'int', nullable: true, isPrimaryKey: i === 0 })),
			primaryKey: [columns[0]],
			foreignKeys: [],
		};
	}

	// `user` (the real table) lacks the SELECTed columns; `legacy_users` has them all — the
	// trap the models fall into. The correction must still name `user` by the name match.
	const schema: DatabaseSchema = {
		database: 'app', fetchedAt: 0,
		tables: [
			named('user', ['id', 'username', 'primary_email', 'last_login']),
			named('legacy_users', ['id', 'email', 'created_at', 'last_login_at']),
			named('user_log', ['id', 'user_id', 'email', 'created_at']),
		],
	};

	test('injects a directive to use the name-matching table when the referenced table is missing', () => {
		const user = buildEditUser('fix this sql', 'select user_id, email, created_at from users', '', 'edit', schema);
		assert.match(user, /The table "users" does not exist/);
		assert.match(user, /Use the table "user" instead/);
		assert.match(user, /Do NOT substitute a different table/);
	});

	test('handles db-qualified + aliased references', () => {
		const user = buildEditUser('fix', 'SELECT * FROM app.users u', '', 'edit', schema);
		assert.match(user, /Use the table "user" instead/);
	});

	test('says nothing when the referenced table exists', () => {
		const user = buildEditUser('add a where', 'select * from user', '', 'edit', schema);
		assert.doesNotMatch(user, /does not exist/);
	});

	test('says nothing without a schema (back-compat default)', () => {
		const user = buildEditUser('fix', 'select * from users', '', 'edit');
		assert.doesNotMatch(user, /does not exist/);
	});

	test('resolves misspellings and trailing junk by edit-distance, not just plural/singular', () => {
		for (const typo of ['users', 'user_', 'oser', 'usr', 'uesr']) {
			const out = buildEditUser('fix', `select * from ${typo}`, '', 'edit', schema);
			assert.match(out, /Use the table "user" instead/, `"${typo}" should resolve to "user"`);
		}
	});

	test('does not correct when no table name is close enough', () => {
		const out = buildEditUser('fix', 'select * from invoices', '', 'edit', schema);
		assert.doesNotMatch(out, /does not exist/);
	});

	test('rejects a same-stem but distant table (users → user, never user_log)', () => {
		const out = buildEditUser('fix', 'select * from users', '', 'edit', schema);
		assert.match(out, /Use the table "user" instead/);
		assert.doesNotMatch(out, /Use the table "user_log"/);
	});
});

describe('editDecoyTables — decoy suppression', () => {
	function named(name: string, columns: string[]): TableInfo {
		return {
			name,
			schema: 'app',
			kind: 'table',
			columns: columns.map((c, i) => ({ name: c, dataType: 'int', nullable: true, isPrimaryKey: i === 0 })),
			primaryKey: [columns[0]],
			foreignKeys: [],
		};
	}

	const schema: DatabaseSchema = {
		database: 'app', fetchedAt: 0,
		tables: [
			named('user', ['id', 'username', 'primary_email', 'last_login']),
			named('legacy_users', ['id', 'email', 'created_at']),
			named('user_log', ['id', 'user_id', 'email']),
			named('dashboard_user', ['id', 'user_id']),
			named('orders', ['id', 'total']),
		],
	};

	test('flags the resolved target\'s name-stem siblings, but never the target or unrelated tables', () => {
		const decoys = editDecoyTables('select user_id, email, created_at from users', schema);
		assert.ok(decoys.has('legacy_users'), 'legacy_users is a decoy');
		assert.ok(decoys.has('user_log'), 'user_log is a decoy');
		assert.ok(decoys.has('dashboard_user'), 'dashboard_user is a decoy');
		assert.ok(!decoys.has('user'), 'the target itself is never a decoy');
		assert.ok(!decoys.has('orders'), 'unrelated tables are not decoys');
	});

	test('empty when the referenced table exists (no correction fired)', () => {
		assert.equal(editDecoyTables('select * from user', schema).size, 0);
	});

	test('empty without a schema', () => {
		assert.equal(editDecoyTables('select * from users', null).size, 0);
	});

	test('buildEditPrompt drops the decoys from the detailed slice but still counts them', () => {
		const prompt = buildEditPrompt('MySQL', schema, {
			topTables: 8,
			focus: 'fix select user_id, email, created_at from users',
			excludeTables: editDecoyTables('select user_id, email, created_at from users', schema),
		}, 'edit');
		// The real target is detailed (quoted — `user` is a reserved word)...
		assert.match(prompt, /app\.`user`\(/);
		// ...and the column-matching decoys are NOT in the detailed slice.
		assert.doesNotMatch(prompt, /app\.legacy_users\(/);
		assert.doesNotMatch(prompt, /app\.user_log\(/);
		// They're not lost — still counted in the "other tables exist" line.
		assert.match(prompt, /other tables exist/i);
	});
});

describe('buildCompletionPrompt', () => {
	test('demands raw insertable text (no markdown) and inlines the schema', () => {
		const schema: DatabaseSchema = { database: 'shop', fetchedAt: 0, tables: [table('orders', 2)] };
		const prompt = buildCompletionPrompt('PostgreSQL', schema);
		assert.match(prompt, /no markdown, no code fences/i);
		assert.match(prompt, /PostgreSQL/);
		assert.match(prompt, /app\.orders\(/);
	});

	test('still works with no active connection', () => {
		assert.match(buildCompletionPrompt('MySQL', null), /No schema is available/);
	});
});

describe('buildSchemaComment', () => {
	test('renders the schema as SQL comment lines for the FIM prefix', () => {
		const schema: DatabaseSchema = { database: 'shop', fetchedAt: 0, tables: [table('orders', 2)] };
		const comment = buildSchemaComment('MySQL', schema);
		assert.match(comment, /^-- MySQL database\./);
		// Every line must be a comment so it's inert when prepended to the prefix.
		assert.ok(comment.split('\n').every((line) => line.startsWith('--')));
		assert.match(comment, /-- - app\.orders\(/);
	});

	test('still yields a dialect comment with no connection', () => {
		assert.equal(buildSchemaComment('PostgreSQL', null), '-- PostgreSQL database.');
	});

	test('ranks the detailed slice by the cursor focus and NAMES the rest (no tool note)', () => {
		const schema: DatabaseSchema = {
			database: 'shop', fetchedAt: 0,
			tables: [table('audit_log', 3), table('shipments', 3), table('customer_order', 4), table('invoices', 3)],
		};
		// User is typing `from customer_` — focus must pull customer_order into the detail.
		const comment = buildSchemaComment('MySQL', schema, { topTables: 1, focus: 'select * from customer_' });
		assert.match(comment, /-- - app\.customer_order\(/);
		// The undetailed tables are listed by NAME so a tool-incapable completer can see them...
		assert.match(comment, /Other tables \(use only these names, never invent\): .*app\.audit_log/);
		// ...and the old "call list_tables" discovery note must NOT appear in a FIM comment.
		assert.doesNotMatch(comment, /list_tables/);
	});
});

describe('buildCompletionUser', () => {
	test('frames the document around the cursor', () => {
		const message = buildCompletionUser('SELECT * FROM ', '');
		assert.match(message, /Text before the cursor:/);
		assert.match(message, /SELECT \* FROM/);
		assert.match(message, /\(end of document\)/);
	});
});

describe('extractCompletion', () => {
	test('strips a markdown code fence the model added anyway', () => {
		assert.equal(extractCompletion('```sql\norders o\n```', 'JOIN '), 'orders o');
	});

	test('removes an echoed overlap with the prefix', () => {
		// Model restated the trailing prefix before continuing.
		assert.equal(extractCompletion('FROM users u WHERE u.active', 'SELECT * FROM users u '), 'WHERE u.active');
	});

	test('returns plain continuations untouched (minus trailing whitespace)', () => {
		assert.equal(extractCompletion('u.created_at > NOW()\n', 'WHERE '), 'u.created_at > NOW()');
	});

	// Suffix-boundary trimming. The fixtures below are REAL FIM outputs captured
	// from the gateway's completion model: the base model fills the gap, then runs past it and reproduces the
	// suffix before rambling. extractCompletion must cut at the gap.
	test('cuts where the completion wanders into the suffix clause keyword', () => {
		assert.equal(
			extractCompletion("name\nFROM users\nWHERE name LIKE '%a%';\n\n-- SELECT *", 'SELECT id, ', ' FROM users WHERE id = 1;'),
			'name');
	});

	test('cuts at an unmatched closing paren the suffix owns', () => {
		assert.equal(
			extractCompletion("'Product 1', 20.99);\nINSERT INTO products (name, price) VALUES ('Product 2', 35.49", 'INSERT INTO products (name, price) VALUES (', ');'),
			"'Product 1', 20.99");
		assert.equal(
			extractCompletion("*) as total, sum(case when type = 'click' then 1 else 0 end) as clicks\nFROM events", 'SELECT count(', ') FROM events;'),
			'*');
	});

	test('cuts at the statement terminator when the suffix already closes the statement', () => {
		assert.equal(extractCompletion('status;\n\n-- SELECT status, COUNT(*) FROM orders GROUP BY status', 'SELECT status, count(*)\nFROM orders\nGROUP BY ', ';'), 'status');
		assert.equal(extractCompletion('omers;\n\n-- SELECT * FROM customers\n--', 'SELECT * FROM cust', ' WHERE active = 1;'), 'omers');
	});

	test('leaves a clean in-gap completion untouched', () => {
		assert.equal(extractCompletion('u.id = o.user_id', 'JOIN orders o ON ', "\nWHERE o.status = 'paid';"), 'u.id = o.user_id');
	});

	test('does not cut on a keyword or paren inside a balanced subquery', () => {
		// FROM here is inside the subquery (depth 1) and the parens balance, so it stays whole.
		assert.equal(extractCompletion('a, (SELECT b FROM s)', 'SELECT ', ' FROM t'), 'a, (SELECT b FROM s)');
		assert.equal(extractCompletion('max(salary) - min(salary)', 'SELECT ', ' FROM employees;'), 'max(salary) - min(salary)');
	});

	// Empty-suffix runaway. A REAL snout-fim-1.0 output captured from the gateway: with no suffix to
	// bound it, completing `… WHERE primary_` fills the gap and then keeps emitting whole statements,
	// joined by single newlines (so the blank-line trim misses them) with no suffix (so the
	// suffix-boundary trim early-returns). extractCompletion must keep it to ONE statement.
	test('cuts a runaway that spilled into extra statements (empty suffix)', () => {
		assert.equal(
			extractCompletion("phone = '789-456-1234';\nselect * from orders;\nselect * from product;", 'select * from customer where primary_', ''),
			"phone = '789-456-1234';");
	});

	test('keeps the terminator when the completion is a single clean statement', () => {
		assert.equal(extractCompletion('5', 'SELECT * FROM t WHERE id = ', ''), '5');
		assert.equal(extractCompletion("phone = '555';", 'WHERE primary_', ''), "phone = '555';");
	});

	test('drops the terminator when the suffix continues the statement', () => {
		// A non-empty suffix means the cursor is mid-statement, so a `;` the completion introduced (then
		// ran on past) must not be inserted — cut before it.
		assert.equal(extractCompletion("5;\nDELETE FROM t;", 'SELECT * FROM t WHERE id = ', ' ORDER BY x'), '5');
	});

	test('does not treat a `;` inside a string literal as a statement boundary', () => {
		assert.equal(extractCompletion("';' || x", 'SELECT ', ''), "';' || x");
	});
});

describe('the assistant\'s identity', () => {
	test('its identity rules out the em-dash in every chat prompt', () => {
		assert.match(buildSystemPrompt('PostgreSQL', null), /Never write an em-dash/);
	});
});

describe('buildAmbientComment', () => {
	test('an empty bundle adds nothing', () => {
		assert.equal(buildAmbientComment({}), '');
		assert.equal(buildAmbientComment({ editorBuffer: '   ', selection: '' }), '');
	});

	test('includes the editor buffer as a SQL block', () => {
		const out = buildAmbientComment({ editorBuffer: 'select * from orders;' });
		assert.match(out, /looking at right now/i);
		assert.match(out, /```sql\nselect \* from orders;\n```/);
	});

	test('omits the selection when it equals the whole buffer', () => {
		const sql = 'select * from orders;';
		const out = buildAmbientComment({ editorBuffer: sql, selection: sql });
		assert.doesNotMatch(out, /highlighted/i);
	});

	test('shows a distinct selection', () => {
		const out = buildAmbientComment({ editorBuffer: 'select a, b from t;', selection: 'a, b' });
		assert.match(out, /highlighted/i);
		assert.match(out, /```sql\na, b\n```/);
	});

	test('lists result columns with their types', () => {
		const out = buildAmbientComment({ resultColumns: [{ name: 'id', dataType: 'int' }, { name: 'email', dataType: 'varchar' }] });
		assert.match(out, /id \(int\), email \(varchar\)/);
	});

	test('includes the last error', () => {
		const out = buildAmbientComment({ lastError: "Unknown column 'foo' in 'field list'" });
		assert.match(out, /most recent query failed/i);
		assert.match(out, /Unknown column 'foo'/);
	});

	test('injects a failure-memory note when present', () => {
		const out = buildAmbientComment({ memoryNote: 'A structurally similar query against this schema previously hit a deadlock. Take that into account before running.' });
		assert.match(out, /failure history/i);
		assert.match(out, /previously hit a deadlock/);
	});

	test('omits the memory section when there is no note', () => {
		const out = buildAmbientComment({ editorBuffer: 'select 1;' });
		assert.doesNotMatch(out, /failure history/i);
	});

	test('describes the selected cell and its row', () => {
		const out = buildAmbientComment({
			selectedCell: { column: 'email', value: 'a@b.com' },
			selectedRow: [{ column: 'id', value: '7' }, { column: 'email', value: 'a@b.com' }],
		});
		assert.match(out, /selected the cell "email" = a@b\.com/);
		assert.match(out, /id=7, email=a@b\.com/);
	});

	test('clips an oversized buffer and marks the truncation', () => {
		const out = buildAmbientComment({ editorBuffer: 'x'.repeat(5000) });
		assert.match(out, /truncated/);
		assert.ok(out.length < 3000, 'the clipped buffer keeps the block small');
	});

	test('renders a result-row sample as a pipe table headed by the columns', () => {
		const out = buildAmbientComment({
			resultColumns: [{ name: 'id', dataType: 'int' }, { name: 'email', dataType: 'varchar' }],
			resultRows: [['7', 'a@b.com'], ['8', 'c@d.com']],
		});
		assert.match(out, /sample of the result rows currently shown \(the first 2/i);
		assert.match(out, /id \| email/);
		assert.match(out, /7 \| a@b\.com/);
		assert.match(out, /8 \| c@d\.com/);
	});

	test('caps the row sample to the first few rows', () => {
		const rows = Array.from({ length: 50 }, (_v, i) => [String(i)]);
		const out = buildAmbientComment({ resultColumns: [{ name: 'n', dataType: 'int' }], resultRows: rows });
		assert.match(out, /the first 5\b/, 'only a few rows are inlined');
		assert.doesNotMatch(out, /\b40 \|/, 'later rows are dropped');
	});

	test('omits the sample when there are no rows', () => {
		const out = buildAmbientComment({ resultColumns: [{ name: 'id', dataType: 'int' }], resultRows: [] });
		assert.doesNotMatch(out, /sample of the result rows/i);
	});

	test('names the table the user has open, schema-qualified', () => {
		const out = buildAmbientComment({ focusedTable: { schema: 'shop', name: 'orders' } });
		assert.match(out, /viewing the table `shop\.orders`/);
	});

	test('names an unqualified open table', () => {
		const out = buildAmbientComment({ focusedTable: { name: 'orders' } });
		assert.match(out, /viewing the table `orders`/);
		assert.doesNotMatch(out, /\.orders/);
	});

	test('names the object the user has open and inlines its DDL', () => {
		const out = buildAmbientComment({ focusedObject: { kind: 'procedure', schema: 'app', name: 'sync_orders', ddl: 'CREATE PROCEDURE sync_orders() BEGIN END' } });
		assert.match(out, /viewing the procedure `app\.sync_orders`/);
		assert.match(out, /CREATE PROCEDURE sync_orders/);
	});

	test('names an object with no DDL without a code block', () => {
		const out = buildAmbientComment({ focusedObject: { kind: 'trigger', name: 'audit_ins' } });
		assert.match(out, /viewing the trigger `audit_ins`/);
		assert.doesNotMatch(out, /```/);
	});

	test('includes other open editor tabs as labelled SQL blocks', () => {
		const out = buildAmbientComment({ otherTabs: [{ title: 'totals.sql', sql: 'select count(*) from orders;' }] });
		assert.match(out, /other open editor tabs/i);
		assert.match(out, /"totals\.sql":/);
		assert.match(out, /select count\(\*\) from orders;/);
	});

	test('caps the number of other tabs inlined', () => {
		const otherTabs = Array.from({ length: 10 }, (_v, i) => ({ title: `t${i}.sql`, sql: `select ${i};` }));
		const out = buildAmbientComment({ otherTabs });
		assert.match(out, /"t0\.sql":/);
		assert.doesNotMatch(out, /"t9\.sql":/);
	});

	test('skips empty other tabs', () => {
		const out = buildAmbientComment({ otherTabs: [{ title: 'blank.sql', sql: '   ' }] });
		assert.equal(out, '');
	});

	test('lists the connection roster with env tag, connected + active flags, and resolution guidance', () => {
		const out = buildAmbientComment({
			connections: [
				{ id: 'a', label: 'Local dev', environment: 'dev', connected: true, active: true },
				{ id: 'b', label: 'Production Aurora', environment: 'prod', connected: false, active: false },
			],
		});
		assert.match(out, /saved database connections/i);
		assert.match(out, /"Local dev" \[dev\] \(connected, active\)/);
		assert.match(out, /"Production Aurora" \[prod\] \(not connected\)/);
		// Resolution rules: tag-or-name, confirm-ambiguous, open via the connect capability.
		assert.match(out, /environment tag OR by its label/i);
		assert.match(out, /ask the user which they mean/i);
		assert.match(out, /connect capability/i);
	});

	test('omits the roster when no connections are present', () => {
		assert.equal(buildAmbientComment({ connections: [] }), '');
		assert.doesNotMatch(buildAmbientComment({ editorBuffer: 'select 1;' }), /saved database connections/i);
	});

	test('caps the connection roster', () => {
		const connections = Array.from({ length: 30 }, (_v, i) => ({ id: `c${i}`, label: `conn ${i}`, connected: false, active: false }));
		const out = buildAmbientComment({ connections });
		assert.match(out, /"conn 0"/);
		assert.doesNotMatch(out, /"conn 25"/);
		assert.match(out, /… \(10 more\)/);
	});

	test('renders the flow wizard step, source, destination and columns', () => {
		const out = buildAmbientComment({
			flowWizard: {
				step: 'columns',
				source: 'the CSV file orders.csv',
				destination: 'the table orders on Staging',
				outcome: 'Query and analyze it',
				estimatedRows: 1200,
				columns: [
					{ name: 'id', type: 'integer', included: true, key: true },
					{ name: 'customer_name', type: 'string', included: true, key: false },
					{ name: 'notes', type: 'string', included: false, key: false },
				],
				warnings: ['Column "order date" uses an ambiguous date format; reading it as month/day/year.'],
				stepNote: 'On this step the user can rename columns.',
			},
		});
		assert.match(out, /Data Flow wizard open, on its "columns" step/);
		assert.match(out, /the CSV file orders\.csv/);
		assert.match(out, /the table orders on Staging/);
		assert.match(out, /Query and analyze it/);
		assert.match(out, /about 1200 rows/);
		assert.match(out, /- id \(integer\) \[key\]/);
		assert.match(out, /- customer_name \(string\)\n/);
		assert.match(out, /- notes \(string\) \[excluded\]/);
		assert.match(out, /ambiguous date format/);
		assert.match(out, /Advise concretely/);
		// The wizard's note on what is possible here comes right after the step line.
		assert.match(out, /"columns" step\. [^\n]*\nOn this step the user can rename columns\.\nSource:/);
	});

	test('carries the brief as the wizard rendered it', () => {
		const out = buildAmbientComment({
			flowWizard: { step: 'building the dataset', generation: 'The generation brief on screen:\n- Subject: tricky SQL questions' },
		});
		assert.match(out, /The generation brief on screen:\n- Subject: tricky SQL questions/);
	});

	test('caps the flow column roster and warning list', () => {
		const columns = Array.from({ length: 50 }, (_v, i) => ({ name: `col${i}`, type: 'string', included: true, key: false }));
		const warnings = Array.from({ length: 10 }, (_v, i) => `warning ${i}`);
		const out = buildAmbientComment({ flowWizard: { step: 'preview', columns, warnings } });
		assert.match(out, /- col0 \(string\)/);
		assert.doesNotMatch(out, /- col45 \(string\)/);
		assert.match(out, /… \(10 more\)/);
		assert.match(out, /warning 5/);
		assert.doesNotMatch(out, /warning 7/);
	});

	test('a bare flow step still grounds the surface', () => {
		const out = buildAmbientComment({ flowWizard: { step: 'source' } });
		assert.match(out, /"source" step/);
		assert.doesNotMatch(out, /Source:/);
	});
});

describe('reserved-word identifier quoting', () => {
	// A schema whose table name (`order`) AND a column (`user`) are SQL reserved words, plus an FK
	// onto another reserved-word table (`group`). A bare `SELECT * FROM order` is a syntax error, so
	// the prompt must show the model the quoted form to copy.
	function reservedSchema(): DatabaseSchema {
		const order: TableInfo = {
			name: 'order', schema: undefined, kind: 'table',
			columns: [
				{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
				{ name: 'user', dataType: 'int', nullable: true, isPrimaryKey: false },
			],
			primaryKey: ['id'],
			foreignKeys: [{ constraintName: 'order_group_id_fkey', columns: ['group_id'], referencedTable: 'group', referencedColumns: ['id'] }],
		};
		const group: TableInfo = {
			name: 'group', schema: undefined, kind: 'table',
			columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }],
			primaryKey: ['id'], foreignKeys: [],
		};
		return { database: 'shop', fetchedAt: 0, tables: [order, group] };
	}

	test('Postgres double-quotes reserved table + column names in the schema block', () => {
		const prompt = buildSystemPrompt('PostgreSQL', reservedSchema(), { driverId: 'postgres' });
		assert.match(prompt, /- "order"\(/);
		assert.match(prompt, /"user" int/);
		// The FK reference onto a reserved table is quoted too.
		assert.match(prompt, /→"group"/);
		// And a directive tells the model to copy the quoted form (with a dialect-correct example).
		assert.match(prompt, /reserved words and MUST be quoted/i);
		assert.match(prompt, /"order"/);
	});

	test('MySQL backtick-quotes, SQL Server bracket-quotes the same names', () => {
		assert.match(buildSystemPrompt('MySQL', reservedSchema(), { driverId: 'mysql-aurora' }), /- `order`\(/);
		assert.match(buildSystemPrompt('SQL Server', reservedSchema(), { driverId: 'sqlserver' }), /- \[order\]\(/);
	});

	test('non-reserved names are left bare (readability)', () => {
		const schema: DatabaseSchema = { database: 'shop', fetchedAt: 0, tables: [table('customers', 2)] };
		const prompt = buildSystemPrompt('PostgreSQL', schema, { driverId: 'postgres' });
		assert.match(prompt, /app\.customers\(/);
		assert.doesNotMatch(prompt, /"customers"/);
	});

	test('document mode never SQL-quotes (it proposes a json pipeline)', () => {
		const prompt = buildSystemPrompt('MongoDB', reservedSchema(), { driverId: 'mongodb', documentMode: true });
		assert.doesNotMatch(prompt, /"order"/);
		assert.doesNotMatch(prompt, /reserved words and MUST be quoted/i);
	});

	test('the agent prompt quotes the same way', () => {
		assert.match(buildAgentPrompt('PostgreSQL', reservedSchema(), { driverId: 'postgres' }), /- "order"\(/);
	});
});

// On a database with hundreds of tables, `select * from cus‸` named `customer_order_check_status` in the
// prompt while `customer_order` — one of the user's most-queried tables — did not make the list
// at all. `cus` is not a whole token, so every table scored zero and the order was arbitrary.
test('a half-typed table name ranks by prefix, shortest-completion first', () => {
	const table = (name: string): TableInfo => ({ name, kind: 'table', columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }], primaryKey: ['id'], foreignKeys: [] });
	const schema: DatabaseSchema = {
		database: 'shop_prod',
		fetchedAt: 0,
		tables: [
			table('customer_order_check_status'),
			table('order_item_ship_status'),
			table('delivery'),
			table('customer_order'),
			table('customer'),
		],
	};
	const comment = buildSchemaComment('MySQL', schema, { focus: 'select * from cus ', partialName: 'cus', topTables: 3 });
	const detailed = [...comment.matchAll(/^-- - (\w+)\(/gm)].map((m) => m[1]);
	assert.deepEqual(detailed, ['customer', 'customer_order', 'customer_order_check_status']);
});

test('the cursor fragment also finds a table by an inner word', () => {
	const table = (name: string): TableInfo => ({ name, kind: 'table', columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }], primaryKey: ['id'], foreignKeys: [] });
	const schema: DatabaseSchema = {
		database: 'db',
		fetchedAt: 0,
		tables: [table('alpha'), table('beta'), table('customer_order')],
	};
	const comment = buildSchemaComment('MySQL', schema, { focus: 'select * from ord ', partialName: 'ord', topTables: 1 });
	assert.match(comment, /- customer_order\(/);
});

test('the cursor fragment beats unrelated tables named elsewhere in the buffer', () => {
	// End to end: a scratch pad whose earlier statements mention `voucher` and
	// `delivery`. Those scored a whole-word hit (50) against the 1000-char focus window while the
	// fragment under the cursor scored ~24, so `select * from cus‸` detailed `customer, voucher,
	// delivery` and offered `customer_order_log_revert`. Focus is now the current statement.
	const t = (name: string): TableInfo => ({ name, kind: 'table', columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }], primaryKey: ['id'], foreignKeys: [] });
	const schema: DatabaseSchema = {
		database: 'shop_prod',
		fetchedAt: 0,
		tables: [t('customer'), t('voucher'), t('delivery'), t('customer_order_log_revert'), t('customer_order'), t('customer_order_check_status')],
	};
	const prefix = 'select * from voucher where id > 1500;\n\nupdate delivery set status_id = 2;\n\nselect * from cus';
	const focus = completionFocus(prefix, ';');
	const comment = buildSchemaComment('MySQL', schema, { focus, partialName: partialIdentifier(prefix), topTables: 3 });
	const detailed = [...comment.matchAll(/^-- - (\w+)\(/gm)].map((m) => m[1]);
	assert.deepEqual(detailed, ['customer', 'customer_order', 'customer_order_log_revert']);
});

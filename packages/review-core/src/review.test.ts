/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDiff, isReviewablePath, reviewableFiles } from './diff.js';
import { parseMention } from './mention.js';
import { renderComment, checkConclusion, COMMENT_MARKER } from './report.js';
import { planReview, review } from './review.js';
import type { DatabaseSchema } from './schema.js';
import type { ProbeResult } from './types.js';

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

/** A destination with the shapes the rules reason about: a big table, a view, an FK, indexes. */
function destination(): DatabaseSchema {
	return {
		database: 'shop',
		fetchedAt: NOW - 60_000,
		routines: [{ name: 'recalc_totals', schema: 'public', kind: 'procedure', definition: 'UPDATE orders SET total = 0 WHERE ship_date IS NULL' }],
		tables: [
			{
				name: 'orders',
				kind: 'table',
				primaryKey: ['id'],
				foreignKeys: [],
				indexes: [{ name: 'idx_orders_created', columns: ['created_at'], unique: false }],
				stats: { rowCount: 18_400_000, engine: 'InnoDB' },
				columns: [
					{ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, autoIncrement: true },
					{ name: 'customer_id', dataType: 'bigint', nullable: false, isPrimaryKey: false },
					{ name: 'ship_date', dataType: 'date', nullable: true, isPrimaryKey: false },
					{ name: 'created_at', dataType: 'timestamp', nullable: false, isPrimaryKey: false },
					{ name: 'note', dataType: 'varchar(255)', nullable: true, isPrimaryKey: false },
				],
			},
			{
				name: 'customers',
				kind: 'table',
				primaryKey: ['id'],
				foreignKeys: [],
				indexes: [],
				stats: { rowCount: 4200 },
				columns: [
					{ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true },
					{ name: 'email', dataType: 'varchar(255)', nullable: false, isPrimaryKey: false },
				],
			},
			{
				name: 'order_items',
				kind: 'table',
				primaryKey: ['id'],
				foreignKeys: [{ constraintName: 'fk_oi_order', columns: ['order_id'], referencedTable: 'orders', referencedColumns: ['id'] }],
				indexes: [],
				stats: { rowCount: 90_000_000 },
				columns: [
					{ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true },
					{ name: 'order_id', dataType: 'bigint', nullable: false, isPrimaryKey: false },
					{ name: 'sku', dataType: 'varchar(64)', nullable: false, isPrimaryKey: false },
				],
			},
			{
				name: 'open_orders',
				kind: 'view',
				definition: 'SELECT id, ship_date FROM orders WHERE ship_date IS NULL',
				primaryKey: [],
				foreignKeys: [],
				columns: [{ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: false }],
			},
		],
	};
}

/** A unified diff that adds `file` with `body` as its whole content. */
function addedFileDiff(file: string, body: string): string {
	const lines = body.split('\n');
	return [
		`diff --git a/${file} b/${file}`,
		'new file mode 100644',
		'index 0000000..1111111',
		'--- /dev/null',
		`+++ b/${file}`,
		`@@ -0,0 +1,${lines.length} @@`,
		...lines.map((l) => `+${l}`),
		'',
	].join('\n');
}

function kinds(findings: { kind: string }[]): string[] {
	return findings.map((f) => f.kind);
}

describe('parseDiff', () => {
	test('reads an added file and its new line numbers', () => {
		const files = parseDiff(addedFileDiff('db/migrate/001.sql', 'CREATE TABLE a (id int);\nSELECT 1;'));
		assert.equal(files.length, 1);
		assert.equal(files[0].path, 'db/migrate/001.sql');
		assert.equal(files[0].status, 'added');
		assert.deepEqual(files[0].addedLines, [1, 2]);
	});

	test('a modified file reports only the lines the hunk adds', () => {
		const diff = [
			'diff --git a/db/q.sql b/db/q.sql',
			'--- a/db/q.sql',
			'+++ b/db/q.sql',
			'@@ -10,3 +10,4 @@',
			' SELECT 1;',
			'+SELECT 2;',
			' SELECT 3;',
			'',
		].join('\n');
		const files = parseDiff(diff);
		assert.deepEqual(files[0].addedLines, [11]);
		assert.equal(files[0].addedText, 'SELECT 2;');
	});

	test('an added line that reads like a file header stays in its hunk', () => {
		// The migration adds `++ b/README.md` and `-- a/README.md`, which the diff shows as
		// `+++ b/README.md` and `+-- a/README.md`. Read as headers, they would move the DROP
		// below onto README.md, a path the reviewer skips.
		const diff = [
			'diff --git a/db/migrate/002.sql b/db/migrate/002.sql',
			'new file mode 100644',
			'--- /dev/null',
			'+++ b/db/migrate/002.sql',
			'@@ -0,0 +1,4 @@',
			'+-- a/README.md',
			'+++ b/README.md',
			'+DROP TABLE orders;',
			'+SELECT 1;',
			'diff --git a/README.md b/README.md',
			'--- a/README.md',
			'+++ b/README.md',
			'@@ -1 +1,2 @@',
			' # Shop',
			'+--- a/x',
			'',
		].join('\n');
		const files = parseDiff(diff);
		assert.deepEqual(files.map((f) => f.path), ['db/migrate/002.sql', 'README.md']);
		assert.deepEqual(files[0].addedLines, [1, 2, 3, 4]);
		assert.equal(files[0].addedText, '-- a/README.md\n++ b/README.md\nDROP TABLE orders;\nSELECT 1;');
		assert.deepEqual(files[1].addedLines, [2]);
		assert.equal(files[1].previousPath, undefined);
		assert.deepEqual(reviewableFiles(diff).map((f) => f.path), ['db/migrate/002.sql']);
	});

	test('a removed line that reads like a header stays in its hunk, and the next file still parses', () => {
		const diff = [
			'diff --git a/db/a.sql b/db/a.sql',
			'--- a/db/a.sql',
			'+++ b/db/a.sql',
			'@@ -1,2 +1,1 @@',
			'--- b/other.sql',
			' SELECT 1;',
			'diff --git a/db/b.sql b/db/b.sql',
			'--- a/db/b.sql',
			'+++ b/db/b.sql',
			'@@ -5 +5 @@',
			'-SELECT 2;',
			'+SELECT 3;',
			'',
		].join('\n');
		const files = parseDiff(diff);
		assert.deepEqual(files.map((f) => f.path), ['db/a.sql', 'db/b.sql']);
		assert.equal(files[0].previousPath, undefined);
		assert.deepEqual(files[0].addedLines, []);
		assert.deepEqual(files[1].addedLines, [5]);
	});

	test('a deletion is recognised and dropped from the reviewable set', () => {
		const diff = [
			'diff --git a/db/old.sql b/db/old.sql',
			'deleted file mode 100644',
			'--- a/db/old.sql',
			'+++ /dev/null',
			'@@ -1,1 +0,0 @@',
			'-SELECT 1;',
			'',
		].join('\n');
		assert.equal(parseDiff(diff)[0].status, 'deleted');
		assert.equal(reviewableFiles(diff).length, 0);
	});

	test('binary files are marked unreadable, never reviewed', () => {
		const diff = [
			'diff --git a/db/dump.sql b/db/dump.sql',
			'--- a/db/dump.sql',
			'+++ b/db/dump.sql',
			'Binary files a/db/dump.sql and b/db/dump.sql differ',
			'',
		].join('\n');
		assert.equal(parseDiff(diff)[0].unreadable, true);
		assert.equal(reviewableFiles(diff).length, 0);
	});

	test('path filtering: SQL in, node_modules and fixtures out', () => {
		assert.equal(isReviewablePath('db/migrate/001.sql'), true);
		assert.equal(isReviewablePath('migrations/2026_add_orders.sql'), true);
		assert.equal(isReviewablePath('src/app.ts'), false);
		assert.equal(isReviewablePath('node_modules/pg/x.sql'), false);
		assert.equal(isReviewablePath('test/fixtures/seed.sql'), false);
	});
});

describe('parseMention', () => {
	test('a bare mention means review', () => {
		assert.equal(parseMention('@snoutbot', 'snoutbot')?.name, 'review');
		assert.equal(parseMention('hey @snoutbot please', 'snoutbot')?.name, 'review');
	});

	test('flags and destinations', () => {
		const c = parseMention('@snoutbot review --deep --on prod', 'snoutbot');
		assert.equal(c?.name, 'review');
		assert.equal(c?.deep, true);
		assert.equal(c?.destination, 'prod');
	});

	test('ignore keeps the id and the reason', () => {
		const c = parseMention('@snoutbot ignore a1b2c3 intentional, backfilled separately', 'snoutbot');
		assert.equal(c?.name, 'ignore');
		assert.equal(c?.findingId, 'a1b2c3');
		assert.equal(c?.reason, 'intentional, backfilled separately');
	});

	test('a mention inside a code block or a quote is not a summons', () => {
		assert.equal(parseMention('```\n@snoutbot review\n```', 'snoutbot'), undefined);
		assert.equal(parseMention('> @snoutbot review', 'snoutbot'), undefined);
		assert.equal(parseMention('use `@snoutbot review` to run it', 'snoutbot'), undefined);
	});

	test('an unrecognised word still runs a review, and says what it did not recognise', () => {
		const c = parseMention('@snoutbot frobnicate', 'snoutbot');
		assert.equal(c?.name, 'review');
		assert.equal(c?.unknown, 'frobnicate');
	});

	test('conversational text around the mention is not a command', () => {
		assert.equal(parseMention('hey @snoutbot please', 'snoutbot')?.name, 'review');
		assert.equal(parseMention('@snoutbot help', 'snoutbot')?.name, 'help');
	});

	test('a different handle is not us', () => {
		assert.equal(parseMention('@coderabbit review', 'snoutbot'), undefined);
	});
});

describe('review — static tier', () => {
	test('no SQL in the diff means no findings and nothing to say', () => {
		const diff = addedFileDiff('src/app.ts', 'export const x = 1;');
		const report = review({ diff, now: NOW });
		assert.equal(report.statementCount, 0);
		assert.equal(report.findings.length, 0);
		assert.ok(renderComment(report).includes('No SQL changed'));
	});

	test('depth is static and the comment says so, without claiming a check', () => {
		const diff = addedFileDiff('db/migrate/001.sql', 'DROP TABLE orders;');
		const report = review({ diff, now: NOW });
		assert.equal(report.depth, 'static');
		const body = renderComment(report);
		assert.ok(body.includes('No database was connected'));
		assert.ok(!body.includes('Measured:'));
	});

	test('SET a = x AND b = y is a blocker with the comma rewrite', () => {
		const diff = addedFileDiff('db/fix.sql', 'UPDATE products SET discount = NULL AND promo_code = NULL;');
		const report = review({ diff, now: NOW });
		const hazard = report.findings.find((f) => f.kind === 'hazard');
		assert.equal(hazard?.severity, 'blocker');
		assert.ok(hazard?.title.includes('not an assignment separator'));
	});

	test('= NULL never matches, and is reported as such', () => {
		const diff = addedFileDiff('db/q.sql', 'DELETE FROM sessions WHERE expires_at = NULL;');
		const report = review({ diff, now: NOW });
		assert.ok(report.findings.some((f) => f.kind === 'hazard' && f.title.includes('never matches')));
	});

	test('an unfiltered DELETE is a blocker', () => {
		const diff = addedFileDiff('db/q.sql', 'DELETE FROM sessions;');
		const report = review({ diff, now: NOW });
		const f = report.findings.find((x) => x.kind === 'destructive');
		assert.equal(f?.severity, 'blocker');
		assert.ok(f?.title.includes('no WHERE'));
	});

	test('a wrapped column and a leading-wildcard LIKE are both non-sargable', () => {
		const diff = addedFileDiff('db/q.sql', "SELECT * FROM orders WHERE DATE(created_at) = '2026-01-01' AND note LIKE '%urgent%';");
		const report = review({ diff, now: NOW });
		const sargable = report.findings.filter((f) => f.kind === 'non-sargable');
		assert.equal(sargable.length, 2);
	});

	test('backticks against Postgres will not parse', () => {
		const diff = addedFileDiff('db/migrate/002.sql', 'ALTER TABLE `orders` ADD COLUMN status varchar(16);');
		const report = review({ diff, driverId: 'postgres', now: NOW });
		const f = report.findings.find((x) => x.kind === 'dialect');
		assert.equal(f?.severity, 'blocker');
	});

	test('CONCURRENTLY inside a transaction is a blocker', () => {
		const diff = addedFileDiff('db/migrate/003.sql', 'BEGIN;\nCREATE INDEX CONCURRENTLY idx_a ON orders (customer_id);\nCOMMIT;');
		const report = review({ diff, driverId: 'postgres', now: NOW });
		assert.ok(report.findings.some((f) => f.kind === 'dialect' && f.title.includes('cannot run inside a transaction')));
	});
});

describe('review — schema tier', () => {
	const schema = destination();

	test('a table the destination does not have is a blocker', () => {
		const diff = addedFileDiff('db/migrate/004.sql', 'ALTER TABLE invoices ADD COLUMN paid boolean;');
		const report = review({ diff, schema, destinationName: 'staging', driverId: 'postgres', now: NOW });
		const f = report.findings.find((x) => x.kind === 'unknown-object');
		assert.equal(f?.severity, 'blocker');
		assert.ok(f?.evidence?.source === 'staging');
	});

	test('a table this PR creates is not reported as missing', () => {
		const diff = addedFileDiff(
			'db/migrate/005.sql',
			'CREATE TABLE invoices (id bigint PRIMARY KEY);\nALTER TABLE invoices ADD COLUMN paid boolean;',
		);
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		assert.equal(report.findings.filter((f) => f.kind === 'unknown-object').length, 0);
	});

	test('creating a table that is already there is a blocker', () => {
		const diff = addedFileDiff('db/migrate/006.sql', 'CREATE TABLE orders (id bigint);');
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		assert.ok(report.findings.some((f) => f.kind === 'already-exists' && f.severity === 'blocker'));
	});

	test('ADD COLUMN NOT NULL with no default cannot work on a table with rows', () => {
		const diff = addedFileDiff('db/migrate/007.sql', 'ALTER TABLE orders ADD COLUMN status varchar(16) NOT NULL;');
		const report = review({ diff, schema, destinationName: 'staging', driverId: 'postgres', now: NOW });
		const f = report.findings.find((x) => x.kind === 'will-fail');
		assert.equal(f?.severity, 'blocker');
		assert.ok(f?.evidence?.measured.includes('18M rows'));
		assert.ok(f?.suggestedSql?.includes('SET NOT NULL'));
	});

	test('a new foreign key with no index on the referencing side', () => {
		const diff = addedFileDiff(
			'db/migrate/008.sql',
			'ALTER TABLE order_items ADD CONSTRAINT fk_oi_cust FOREIGN KEY (sku) REFERENCES customers (id);',
		);
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		const f = report.findings.find((x) => x.kind === 'unindexed-foreign-key');
		assert.equal(f?.severity, 'warn');
		assert.ok(f?.suggestedSql?.startsWith('CREATE INDEX'));
	});

	test('an index the destination already covers is a note, naming the existing one', () => {
		const diff = addedFileDiff('db/migrate/009.sql', 'CREATE INDEX idx_new ON orders (created_at);');
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		const f = report.findings.find((x) => x.kind === 'redundant-index');
		assert.ok(f?.title.includes('idx_orders_created'));
	});

	test('an index build on a big table warns about the lock, and names the lock-free form', () => {
		const diff = addedFileDiff('db/migrate/010.sql', 'CREATE INDEX idx_cust ON orders (customer_id);');
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		const f = report.findings.find((x) => x.kind === 'lock-risk');
		assert.ok(f?.detail.includes('CONCURRENTLY'));
	});

	test('narrowing a column type is a blocker', () => {
		const diff = addedFileDiff('db/migrate/011.sql', 'ALTER TABLE orders ALTER COLUMN note TYPE varchar(32);');
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		assert.ok(report.findings.some((f) => f.kind === 'narrowing-type' && f.severity === 'blocker'));
	});

	test('dropping a column a view still selects is reported', () => {
		const diff = addedFileDiff('db/migrate/012.sql', 'ALTER TABLE orders DROP COLUMN ship_date;');
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		const f = report.findings.find((x) => x.kind === 'still-referenced');
		assert.ok(f?.detail.includes('open_orders'));
		assert.ok(f?.detail.includes('recalc_totals'));
	});

	test('dropping a table a foreign key points at is a blocker', () => {
		const diff = addedFileDiff('db/migrate/013.sql', 'DROP TABLE orders;');
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		assert.ok(report.findings.some((f) => f.kind === 'still-referenced' && f.severity === 'blocker'));
	});

	test('a filter on an unindexed column of a big table warns', () => {
		const diff = addedFileDiff('reports/daily.sql', 'SELECT id FROM orders WHERE customer_id = 42;');
		const report = review({ diff, schema, driverId: 'postgres', now: NOW, paths: { include: ['**/*.sql'] } });
		const f = report.findings.find((x) => x.kind === 'missing-index');
		assert.equal(f?.severity, 'warn');
		assert.ok(f?.evidence?.measured.includes('18M rows'));
	});

	test('a scan of a small table is not a finding', () => {
		const diff = addedFileDiff('reports/small.sql', "SELECT id FROM customers WHERE email = 'a@b.c';");
		const report = review({ diff, schema, driverId: 'postgres', now: NOW, paths: { include: ['**/*.sql'] } });
		assert.equal(report.findings.filter((f) => f.kind === 'missing-index').length, 0);
	});

	test('depth is `schema` when nothing was measured', () => {
		const diff = addedFileDiff('db/migrate/014.sql', 'CREATE INDEX idx_cust ON orders (customer_id);');
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		assert.equal(report.depth, 'schema');
		assert.ok(renderComment(report).includes('No data was read'));
	});
});

describe('review — probes and the connected tier', () => {
	const schema = destination();
	const diff = addedFileDiff(
		'db/migrate/020.sql',
		[
			'ALTER TABLE orders ALTER COLUMN ship_date SET NOT NULL;',
			'CREATE UNIQUE INDEX ux_customers_email ON customers (email);',
		].join('\n'),
	);

	test('probes are planned for the statements that can fail', () => {
		const plan = planReview({ diff, schema, driverId: 'postgres', now: NOW });
		assert.deepEqual(plan.probes.map((p) => p.kind).sort(), ['duplicate-count', 'null-count']);
		assert.ok(plan.probes.every((p) => p.purpose !== '' && p.table));
	});

	test('every probe is read-only — the invariant, enforced not documented', () => {
		const plan = planReview({ diff, schema, driverId: 'postgres', deep: true, now: NOW });
		assert.ok(plan.probes.length > 0);
		for (const probe of plan.probes) {
			const head = probe.sql.trimStart().slice(0, 8).toUpperCase();
			assert.ok(
				head.startsWith('SELECT') || head.startsWith('EXPLAIN'),
				`probe ${probe.id} is not a read: ${probe.sql}`,
			);
			assert.ok(
				!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/i.test(probe.sql),
				`probe ${probe.id} contains a write: ${probe.sql}`,
			);
		}
	});

	test('probe results turn advice into "this will fail", with the number and its source', () => {
		const plan = planReview({ diff, schema, driverId: 'postgres', now: NOW });
		const nulls = plan.probes.find((p) => p.kind === 'null-count')!;
		const dupes = plan.probes.find((p) => p.kind === 'duplicate-count')!;
		const probeResults: ProbeResult[] = [
			{ id: nulls.id, ok: true, rows: [{ n: 412 }] },
			{ id: dupes.id, ok: true, rows: [{ n: 7 }] },
		];
		const report = review({ diff, schema, driverId: 'postgres', destinationName: 'staging', probeResults, now: NOW });

		assert.equal(report.depth, 'connected');
		const failures = report.findings.filter((f) => f.kind === 'will-fail');
		assert.equal(failures.length, 2);
		assert.ok(failures.every((f) => f.severity === 'blocker'));
		assert.ok(failures.some((f) => f.title.includes('412 rows')));
		assert.ok(failures.some((f) => f.title.includes('7 values are duplicated')));
		for (const f of failures) {
			assert.equal(f.evidence?.source, 'staging');
			assert.ok(f.evidence?.sql?.toUpperCase().startsWith('SELECT'));
		}
	});

	test('a clean probe produces no finding, and is counted instead', () => {
		const plan = planReview({ diff, schema, driverId: 'postgres', now: NOW });
		const probeResults: ProbeResult[] = plan.probes.map((p) => ({ id: p.id, ok: true, rows: [{ n: 0 }] }));
		const report = review({ diff, schema, driverId: 'postgres', probeResults, now: NOW });
		assert.equal(report.findings.filter((f) => f.kind === 'will-fail').length, 0);
		assert.equal(report.checksPassed, 2);
	});

	test('a probe that could not run becomes a printed gap, never a silent pass', () => {
		const plan = planReview({ diff, schema, driverId: 'postgres', now: NOW });
		const probeResults: ProbeResult[] = [{ id: plan.probes[0].id, ok: false, error: 'permission denied' }];
		const report = review({ diff, schema, driverId: 'postgres', probeResults, now: NOW });
		assert.ok(report.gaps.some((g) => g.includes('permission denied')));
		assert.ok(renderComment(report).includes('could not check'));
	});

	test('an EXPLAIN plan is read for the scan it predicts', () => {
		const queryDiff = addedFileDiff('reports/daily.sql', 'SELECT id FROM orders WHERE customer_id = 42;');
		const plan = planReview({ diff: queryDiff, schema, driverId: 'postgres', deep: true, now: NOW, paths: { include: ['**/*.sql'] } });
		const explain = plan.probes.find((p) => p.kind === 'explain')!;
		const probeResults: ProbeResult[] = [{
			id: explain.id,
			ok: true,
			rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 18_400_000 } }] }],
		}];
		const report = review({ diff: queryDiff, schema, driverId: 'postgres', deep: true, probeResults, now: NOW, paths: { include: ['**/*.sql'] } });
		const f = report.findings.find((x) => x.kind === 'plan');
		assert.ok(f?.title.includes('18M rows'));
	});
});

describe('a probe that failed, in the comment', () => {
	// A PR author names the relation, the database echoes the name back in its error, and the
	// comment is posted under the user's name. Nothing the error said may reach it.
	// No dot in it: a dot reads as schema.table, and then the name is not found in the schema.
	const HOSTILE = '![x](https://evil/pixel) @org/team </details>';

	function hostileSchema(name: string): DatabaseSchema {
		return {
			database: 'shop',
			fetchedAt: NOW,
			tables: [{
				name,
				kind: 'table',
				primaryKey: [],
				foreignKeys: [],
				indexes: [],
				columns: [{ name: 'c', dataType: 'int', nullable: true, isPrimaryKey: false }],
			}],
		};
	}

	/** The comment with every code span and fenced block taken out: what renders as markup. */
	function outsideCode(md: string): string {
		return md.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '').replace(/(`+)[\s\S]*?\1/g, '');
	}

	function failedReview(name: string, failed: Omit<ProbeResult, 'id'>) {
		const diff = addedFileDiff('db/migrate/040.sql', `ALTER TABLE "${name}" ALTER COLUMN c SET NOT NULL;`);
		const schema = hostileSchema(name);
		const plan = planReview({ diff, schema, driverId: 'postgres', now: NOW });
		assert.equal(plan.probes.length, 1, 'the NOT NULL probe is planned');
		const report = review({ diff, schema, driverId: 'postgres', probeResults: [{ id: plan.probes[0].id, ...failed }], now: NOW });
		return { report, body: renderComment(report) };
	}

	test('the database\'s error text is never posted; a fixed reason is', () => {
		const error = `relation "${HOSTILE}" does not exist`;
		const { report, body } = failedReview(HOSTILE, { ok: false, error });
		assert.ok(!body.includes('relation "'), 'the raw error is not in the comment');
		assert.ok(report.gaps.some((g) => g.endsWith('the object does not exist on the target database.')));
		const markup = outsideCode(body);
		assert.ok(!markup.includes('https://evil'), 'no link or image outside code');
		assert.ok(!markup.includes('@org'), 'no mention outside code');
		assert.ok(!markup.includes('!['), 'no image outside code');
		assert.equal((markup.match(/<\/details>/g) ?? []).length, (markup.match(/<details>/g) ?? []).length, 'no fold closed early');
		// The full text is kept for the host's own screen, and only there.
		assert.deepEqual(report.localErrors?.map((e) => e.error), [error]);
	});

	test('hosts, roles and values in an error stay out of the comment', () => {
		const { report, body } = failedReview('orders', {
			ok: false,
			error: 'could not connect to server at 10.1.2.3 as role admin_ops (password=hunter2)',
		});
		for (const leak of ['10.1.2.3', 'admin_ops', 'hunter2']) {
			assert.ok(!body.includes(leak), leak);
			assert.ok(!report.gaps.some((g) => g.includes(leak)), leak);
		}
		assert.ok(report.gaps.some((g) => g.endsWith(': the database could not run it.')));
	});

	test('each class of failure has its own short reason', () => {
		const cases: [Omit<ProbeResult, 'id'>, string][] = [
			[{ ok: false, error: 'permission denied for table orders' }, 'permission denied'],
			[{ ok: false, error: 'ORA-00942: table or view does not exist' }, 'the object does not exist on the target database'],
			[{ ok: false, error: 'canceling statement due to statement timeout' }, 'it timed out'],
			[{ ok: false, error: 'whatever the host says', failure: 'timeout' }, 'it timed out'],
			[{ ok: false, error: 'not run because it contains a write keyword', failure: 'refused' }, 'not run, because the read check refused it'],
			[{ ok: false }, 'the database could not run it'],
		];
		for (const [failed, reason] of cases) {
			const { report } = failedReview('orders', failed);
			assert.ok(report.gaps.some((g) => g.endsWith(`: ${reason}.`)), `${JSON.stringify(failed)} -> ${report.gaps.join(' | ')}`);
		}
	});

	test('a very long name is cut short in the gap', () => {
		const long = `${'n'.repeat(5000)}`;
		const { report } = failedReview(long, { ok: false, error: 'permission denied' });
		const gap = report.gaps.find((g) => g.startsWith('Could not check'))!;
		assert.ok(gap.length < 400, `gap is ${gap.length} characters`);
	});
});

describe('the comment', () => {
	const schema = destination();

	test('carries the marker so a re-review edits it instead of adding one', () => {
		const report = review({ diff: addedFileDiff('db/a.sql', 'DROP TABLE orders;'), now: NOW });
		assert.ok(renderComment(report).startsWith(COMMENT_MARKER));
	});

	test('leads with the verdict, and blockers are not folded away', () => {
		const diff = addedFileDiff('db/migrate/030.sql', 'ALTER TABLE orders ADD COLUMN status varchar(16) NOT NULL;');
		const body = renderComment(review({ diff, schema, driverId: 'postgres', destinationName: 'staging', now: NOW }));
		assert.ok(body.includes('that will stop this migration'));
		assert.ok(body.includes('### Will not run, or will lose data'));
		assert.ok(!body.includes('<details><summary><b>Will not run'));
	});

	test('says what is new since the last push', () => {
		const diff = addedFileDiff('db/migrate/031.sql', 'DROP TABLE orders;');
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		const body = renderComment(report, { previousIds: ['deadbe'] });
		assert.ok(body.includes('Since the last push'));
		assert.ok(body.includes('`new`'));
	});

	test('an ignored finding is struck through with its reason, never removed', () => {
		const diff = addedFileDiff('db/migrate/032.sql', 'DROP TABLE orders;');
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		const id = report.findings[0].id;
		const body = renderComment(report, { ignored: { [id]: 'replaced by 033' } });
		assert.ok(body.includes('~~'));
		assert.ok(body.includes('replaced by 033'));
	});

	test('the check run fails on a blocker and passes without one', () => {
		const bad = review({ diff: addedFileDiff('db/a.sql', 'DELETE FROM sessions;'), now: NOW });
		const fine = review({ diff: addedFileDiff('db/b.sql', 'SELECT 1;'), now: NOW, paths: { include: ['**/*.sql'] } });
		assert.equal(checkConclusion(bad), 'failure');
		assert.equal(checkConclusion(fine), 'success');
		assert.equal(checkConclusion(bad, 'never'), 'neutral');
	});
});

describe('robustness', () => {
	test('an empty diff reviews to nothing', () => {
		const report = review({ diff: '', now: NOW });
		assert.equal(report.findings.length, 0);
		assert.equal(report.statementCount, 0);
	});

	test('unparseable SQL is a gap, and the rest of the file is still reviewed', () => {
		const diff = addedFileDiff('db/migrate/040.sql', 'ALTER TABLE orders SOMETHING WEIRD;\nDELETE FROM sessions;');
		const report = review({ diff, now: NOW });
		assert.ok(report.gaps.some((g) => g.includes('not understood')));
		assert.ok(report.findings.some((f) => f.kind === 'destructive'));
	});

	test('a disabled rule kind is not reported', () => {
		const diff = addedFileDiff('db/migrate/041.sql', 'DROP TABLE orders;');
		const report = review({ diff, now: NOW, disabledKinds: ['migration-hygiene'] });
		assert.equal(kinds(report.findings).includes('migration-hygiene'), false);
	});

	test('findings are ordered blockers first', () => {
		const diff = addedFileDiff(
			'db/migrate/042.sql',
			"DROP TABLE orders;\nUPDATE t SET a = 1 AND b = 2;",
		);
		const report = review({ diff, now: NOW });
		const severities = report.findings.map((f) => f.severity);
		assert.equal(severities[0], 'blocker');
		assert.deepEqual([...severities].sort((a, b) => severities.indexOf(a) - severities.indexOf(b)), severities);
	});

	test('a finding id is stable across identical reviews', () => {
		const diff = addedFileDiff('db/migrate/043.sql', 'DROP TABLE orders;');
		const a = review({ diff, now: NOW }).findings.map((f) => f.id);
		const b = review({ diff, now: NOW + 5000 }).findings.map((f) => f.id);
		assert.deepEqual(a, b);
	});
});

describe('pull request SQL in a probe', () => {
	const paths = { include: ['**/*.sql'] };

	test('a backslash Postgres does not treat as an escape cannot smuggle a second statement into EXPLAIN', () => {
		const attack = addedFileDiff('reports/q.sql', "SELECT 'a\\'; DROP TABLE users; -- '");
		const plan = planReview({ diff: attack, schema: destination(), driverId: 'postgres', deep: true, now: NOW, paths });
		// Split the way Postgres reads it, the DROP is its own statement and is never explained…
		assert.ok(plan.statements.some((s) => /^DROP TABLE users/.test(s.sql)));
		// …and no probe of any kind carries it.
		assert.ok(plan.probes.every((p) => !/DROP/i.test(p.sql)), plan.probes.map((p) => p.sql).join('\n'));
	});

	test('the same text under MySQL, where the backslash IS an escape, is one statement and still not explained', () => {
		const attack = addedFileDiff('reports/q.sql', "SELECT 'a\\'; DROP TABLE users; -- '");
		const plan = planReview({ diff: attack, schema: destination(), driverId: 'mysql', deep: true, now: NOW, paths });
		assert.equal(plan.statements.length, 1);
		assert.ok(plan.probes.every((p) => p.kind !== 'explain'));
	});

	test('an ordinary query is still explained, as one statement', () => {
		const query = addedFileDiff('reports/q.sql', "SELECT id FROM orders WHERE note = 'a;b';");
		const plan = planReview({ diff: query, schema: destination(), driverId: 'postgres', deep: true, now: NOW, paths });
		const explain = plan.probes.find((p) => p.kind === 'explain');
		assert.equal(explain?.sql, "EXPLAIN (FORMAT JSON) SELECT id FROM orders WHERE note = 'a;b'");
	});

	test('SQL Server gets no plan probe, so nothing can leave SHOWPLAN_XML on for the session', () => {
		const query = addedFileDiff('reports/q.sql', 'SELECT id FROM orders WHERE customer_id = 42;');
		const plan = planReview({ diff: query, schema: destination(), driverId: 'sqlserver', deep: true, now: NOW, paths });
		assert.ok(plan.probes.every((p) => p.kind !== 'explain' && !/SHOWPLAN/i.test(p.sql)));
	});
});

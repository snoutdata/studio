/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { codeFence, codeSpan } from './markdown.js';
import { checkConclusion, renderComment } from './report.js';
import { planReview, review } from './review.js';
import type { DatabaseSchema } from './schema.js';
import type { ProbeResult } from './types.js';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

function addedFileDiff(file: string, body: string): string {
	const lines = body.split('\n');
	return [
		`diff --git a/${file} b/${file}`,
		'new file mode 100644',
		'--- /dev/null',
		`+++ b/${file}`,
		`@@ -0,0 +1,${lines.length} @@`,
		...lines.map((l) => `+${l}`),
		'',
	].join('\n');
}

/** Every inline code span in `md`, by CommonMark's rule: a run of N backticks closes only at
 *  the next run of exactly N. Returns the text OUTSIDE spans and fences, which is what renders. */
function outsideCode(md: string): string {
	let out = '';
	let i = 0;
	while (i < md.length) {
		if (md[i] !== '`') {
			out += md[i++];
			continue;
		}
		let n = 0;
		while (md[i + n] === '`') {
			n++;
		}
		const open = '`'.repeat(n);
		let j = i + n;
		let close = -1;
		while (j < md.length) {
			const k = md.indexOf(open, j);
			if (k < 0) {
				break;
			}
			if (md[k - 1] !== '`' && md[k + n] !== '`') {
				close = k;
				break;
			}
			j = k + 1;
		}
		if (close < 0) {
			out += open;
			i += n;
			continue;
		}
		i = close + n;
	}
	return out;
}

const HOSTILE = 'x` [click](https://evil.example) <img src=x> `y';

describe('codeSpan', () => {
	test('plain text is a plain span', () => {
		assert.equal(codeSpan('orders'), '`orders`');
	});

	test('a backtick in the text gets a longer delimiter, so it cannot close the span', () => {
		const span = codeSpan(HOSTILE);
		assert.ok(span.startsWith('``') && span.endsWith('``'));
		assert.equal(outsideCode(`a ${span} b`), 'a  b');
	});

	test('a run of backticks is beaten by one more', () => {
		const span = codeSpan('a```b');
		assert.ok(span.startsWith('````') && !span.startsWith('`````'));
	});

	test('leading or trailing backticks are padded so CommonMark can tell them apart', () => {
		assert.equal(codeSpan('`a'), '`` `a ``');
		assert.equal(codeSpan('a`'), '`` a` ``');
	});

	test('newlines are flattened, so a name cannot start a heading or end the paragraph', () => {
		const span = codeSpan('a\n\n# Approved\r\nb');
		assert.ok(!/[\r\n]/.test(span));
	});

	test('empty and undefined still make a span', () => {
		assert.equal(codeSpan(''), '` `');
		assert.equal(codeSpan(undefined), '` `');
	});
});

describe('codeFence', () => {
	test('is at least three backticks, and longer than any run inside', () => {
		assert.deepEqual(codeFence('SELECT 1', 'sql'), ['```sql', 'SELECT 1', '```']);
		const lines = codeFence('SELECT 1; -- ```\n## fake heading', 'sql');
		assert.equal(lines[0], '````sql');
		assert.equal(lines[lines.length - 1], '````');
	});
});

describe('a pull request cannot write markdown into the comment', () => {
	const schema: DatabaseSchema = {
		database: 'shop',
		fetchedAt: NOW,
		tables: [],
	};

	test('a hostile table name stays inside its code span in titles, evidence and file names', () => {
		const file = 'db/`evil`.sql';
		const name = '"x` [click](https://evil.example) `y"';
		const diff = addedFileDiff(file, `DROP TABLE ${name};`);
		const report = review({ diff, schema, driverId: 'postgres', destinationName: 'staging`](x)', now: NOW });
		assert.ok(report.findings.length > 0);
		const md = renderComment(report);
		const rendered = outsideCode(md);
		assert.ok(!rendered.includes('[click]'), rendered);
		assert.ok(!rendered.includes('](x)'), rendered);
	});

	test('a statement with a fence in it cannot close its own block', () => {
		const diff = addedFileDiff('db/m.sql', 'DELETE FROM orders /* ```\n### Approved by security\n``` */;');
		const report = review({ diff, now: NOW });
		const md = renderComment(report);
		const lines = md.split('\n');
		const open = lines.indexOf('````sql');
		assert.ok(open >= 0, md);
		const close = lines.indexOf('````', open + 1);
		const inside = lines.slice(open + 1, close).join('\n');
		assert.ok(inside.includes('```') && inside.includes('Approved by security'), md);
	});

	test('the NULL-backfill suggestion keeps working with a column name that has a backtick', () => {
		const withTable: DatabaseSchema = {
			database: 'shop',
			fetchedAt: NOW,
			tables: [{
				name: 'orders',
				kind: 'table',
				primaryKey: ['id'],
				foreignKeys: [],
				indexes: [],
				columns: [
					{ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true },
					{ name: 'a`b', dataType: 'date', nullable: true, isPrimaryKey: false },
				],
			}],
		};
		const diff = addedFileDiff('db/m.sql', 'ALTER TABLE orders ALTER COLUMN "a`b" SET NOT NULL;');
		const plan = planReview({ diff, schema: withTable, driverId: 'postgres' });
		const probe = plan.probes.find((p) => p.kind === 'null-count');
		assert.ok(probe, 'a null-count probe');
		assert.equal(probe!.column, 'a`b');
		const probeResults: ProbeResult[] = [{ id: probe!.id, ok: true, rows: [{ n: 3 }] }];
		const report = review({ diff, schema: withTable, driverId: 'postgres', probeResults, now: NOW });
		const blocker = report.findings.find((f) => f.kind === 'will-fail');
		assert.ok(blocker?.suggestedSql?.includes('"a`b" IS NULL'), blocker?.suggestedSql);
	});
});

describe('size caps', () => {
	test('a diff over the cap is not reviewed, and the comment says so up front', () => {
		const diff = addedFileDiff('db/m.sql', 'DROP TABLE orders;');
		const report = review({ diff, now: NOW, limits: { diffChars: 10 } });
		assert.equal(report.statementCount, 0);
		assert.equal(report.limits?.length, 1);
		const md = renderComment(report);
		assert.match(md, /\*\*Not reviewed\.\*\*/);
		assert.match(md, /> \*\*Not fully reviewed:\*\* This pull request's diff is/);
		assert.equal(checkConclusion(report), 'neutral');
	});

	test('statements over the count cap are named as not reviewed', () => {
		const body = Array.from({ length: 5 }, (_, i) => `DROP TABLE t${i};`).join('\n');
		const report = review({ diff: addedFileDiff('db/m.sql', body), now: NOW, limits: { statements: 2 } });
		assert.equal(report.statementCount, 2);
		assert.match(report.limits?.[0] ?? '', /touches 5 statements\. The first 2 were reviewed and the other 3 were not/);
	});

	test('a statement over the length cap is skipped with its location', () => {
		const body = `SELECT 1;\nSELECT '${'x'.repeat(200)}';`;
		const report = review({ diff: addedFileDiff('db/m.sql', body), now: NOW, limits: { statementChars: 100 } });
		assert.equal(report.statementCount, 1);
		assert.match(report.limits?.[0] ?? '', /One statement is longer than 100 characters and was not reviewed: `db\/m\.sql` line 2\./);
	});

	test('a file over the content cap is read from its changed lines', () => {
		const body = 'SELECT 1;';
		const plan = planReview({
			diff: addedFileDiff('db/m.sql', body),
			files: { 'db/m.sql': body },
			limits: { fileChars: 3 },
		});
		assert.equal(plan.statements.length, 1);
		assert.match(plan.limits[0], /is over 3 characters, so only the changed lines were read/);
	});

	test('a pull request inside every cap reports no limits and a plain success', () => {
		const report = review({ diff: addedFileDiff('db/m.sql', 'SELECT id FROM orders WHERE id = 1;'), now: NOW });
		assert.equal(report.limits, undefined);
		assert.equal(checkConclusion(report), 'success');
	});
});

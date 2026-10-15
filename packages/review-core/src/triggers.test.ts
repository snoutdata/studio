/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { renderComment } from './report.js';
import { review, reviewFiles } from './review.js';
import type { DatabaseSchema } from './schema.js';
import { decideTrigger, doneReaction, isOwnComment, touchesSql } from './triggers.js';

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

/** One very large table, in use, with one index — the shape every ALTER rule cares about. */
function bigTable(): DatabaseSchema {
	return {
		database: 'analytics',
		fetchedAt: NOW - 60_000,
		tables: [
			{
				name: 'events',
				kind: 'table',
				primaryKey: ['id'],
				foreignKeys: [],
				indexes: [{ name: 'idx_events_user', columns: ['user_id'], unique: false }],
				stats: { rowCount: 1_200_000_000, engine: 'InnoDB' },
				columns: [
					{ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true },
					{ name: 'user_id', dataType: 'bigint', nullable: false, isPrimaryKey: false },
					{ name: 'payload', dataType: 'text', nullable: true, isPrimaryKey: false },
					{ name: 'created_at', dataType: 'timestamp', nullable: true, isPrimaryKey: false },
				],
			},
		],
	};
}

function diffOf(files: Record<string, string>): string {
	return Object.entries(files)
		.map(([path, body]) => {
			const lines = body.split('\n');
			return [
				`diff --git a/${path} b/${path}`,
				'new file mode 100644',
				'--- /dev/null',
				`+++ b/${path}`,
				`@@ -0,0 +1,${lines.length} @@`,
				...lines.map((l) => `+${l}`),
			].join('\n');
		})
		.join('\n');
}

describe('altering a table that is already huge', () => {
	const schema = bigTable();

	test('a column with a per-row default rewrites the table — the updated_at case', () => {
		const diff = diffOf({
			'db/migrate/050.sql': 'ALTER TABLE events ADD COLUMN updated_at TIMESTAMP DEFAULT now();',
		});
		const report = review({ diff, schema, driverId: 'postgres', destinationName: 'prod', now: NOW });
		const f = report.findings.find((x) => x.kind === 'lock-risk');
		assert.equal(f?.severity, 'blocker', 'a rewrite of 1.2B rows is not a warning');
		assert.ok(f?.title.includes('per-row default'));
		assert.ok(f?.evidence?.measured.includes('1.2B rows'), f?.evidence?.measured);
		assert.ok(f?.suggestedSql?.includes('SET DEFAULT'));
	});

	test('a CONSTANT default on the same table is not the same finding', () => {
		const diff = diffOf({ 'db/migrate/051.sql': "ALTER TABLE events ADD COLUMN kind VARCHAR(16) DEFAULT 'x';" });
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		assert.equal(report.findings.filter((f) => f.title.includes('per-row default')).length, 0);
	});

	test('MySQL ON UPDATE CURRENT_TIMESTAMP is called out for what it costs afterwards', () => {
		const diff = diffOf({
			'db/migrate/052.sql': 'ALTER TABLE events ADD COLUMN updated_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP;',
		});
		const report = review({ diff, schema, driverId: 'mysql-aurora', now: NOW });
		const f = report.findings.find((x) => x.title.includes('ON UPDATE CURRENT_TIMESTAMP'));
		assert.ok(f?.detail.includes('every future UPDATE'));
	});

	test('making a column NOT NULL on a huge table warns about the lock even when nothing violates it', () => {
		const diff = diffOf({ 'db/migrate/053.sql': 'ALTER TABLE events ALTER COLUMN created_at SET NOT NULL;' });
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		assert.ok(report.findings.some((f) => f.kind === 'lock-risk' && f.title.includes('NOT NULL')));
	});

	test('and the same warning fires on MySQL, which spells it MODIFY', () => {
		// This is the bug the first hand test found: every NOT NULL rule keyed on the action type
		// `setNotNull`, which MySQL never produces, so the flagship finding was silent for the
		// vendor most of our users are on.
		const diff = diffOf({ 'db/migrate/053.sql': 'ALTER TABLE events MODIFY created_at TIMESTAMP NOT NULL;' });
		const report = review({ diff, schema, driverId: 'mysql-aurora', now: NOW });
		assert.ok(report.findings.some((f) => f.kind === 'lock-risk' && f.title.includes('NOT NULL')));
	});

	test('a CHECK constraint on a huge table is a scan under a lock', () => {
		const diff = diffOf({ 'db/migrate/054.sql': 'ALTER TABLE events ADD CONSTRAINT ck_payload CHECK (payload IS NOT NULL);' });
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		assert.ok(report.findings.some((f) => f.title.includes('CHECK constraint')));
	});

	test('none of it fires on a small table', () => {
		const small: DatabaseSchema = {
			...bigTable(),
			tables: [{ ...bigTable().tables[0], stats: { rowCount: 900 } }],
		};
		const diff = diffOf({ 'db/migrate/055.sql': 'ALTER TABLE events ADD COLUMN updated_at TIMESTAMP DEFAULT now();' });
		const report = review({ diff, schema: small, driverId: 'postgres', now: NOW });
		assert.equal(report.findings.filter((f) => f.kind === 'lock-risk').length, 0);
	});
});

describe('the whole change, not one statement at a time', () => {
	const schema = bigTable();

	test('a column added and then queried, with no index anywhere in the PR', () => {
		const diff = diffOf({
			'db/migrate/060.sql': 'ALTER TABLE events ADD COLUMN session_id BIGINT;',
			'reports/sessions.sql': 'SELECT id FROM events WHERE session_id = 7;',
		});
		const report = review({
			diff,
			schema,
			driverId: 'postgres',
			now: NOW,
			paths: { include: ['**/*.sql'] },
		});
		const f = report.findings.find((x) => x.kind === 'missing-index' && x.title.includes('added and then queried'));
		assert.ok(f, 'the pair of statements is the defect, not either one');
		assert.equal(f?.severity, 'warn');
		assert.ok(f?.suggestedSql?.includes('CREATE INDEX'));
	});

	test('an index created LATER in the pull request answers it — order must not matter', () => {
		const diff = diffOf({
			'db/migrate/060.sql': 'ALTER TABLE events ADD COLUMN session_id BIGINT;',
			'reports/sessions.sql': 'SELECT id FROM events WHERE session_id = 7;',
			'db/migrate/061.sql': 'CREATE INDEX idx_events_session ON events (session_id);',
		});
		const report = review({ diff, schema, driverId: 'postgres', now: NOW, paths: { include: ['**/*.sql'] } });
		assert.equal(report.findings.filter((f) => f.title.includes('added and then queried')).length, 0);
	});

	test('a foreign key does not count as indexing the referencing column', () => {
		const diff = diffOf({
			'db/migrate/062.sql': 'ALTER TABLE events ADD COLUMN session_id BIGINT, ADD CONSTRAINT fk_s FOREIGN KEY (session_id) REFERENCES events (id);',
			'reports/sessions.sql': 'SELECT id FROM events WHERE session_id = 7;',
		});
		const report = review({ diff, schema, driverId: 'postgres', now: NOW, paths: { include: ['**/*.sql'] } });
		assert.ok(report.findings.some((f) => f.title.includes('added and then queried')));
	});

	test('dropping the only index leading with a column is called out', () => {
		const diff = diffOf({ 'db/migrate/063.sql': 'DROP INDEX idx_events_user;' });
		const report = review({ diff, schema, driverId: 'postgres', now: NOW });
		const f = report.findings.find((x) => x.title.includes('leaves'));
		assert.ok(f?.title.includes('events.user_id'));
	});
});

describe('reviewFiles — the standing audit, not the change', () => {
	test('every statement in a file counts as touched', () => {
		const report = reviewFiles(
			{ 'reports/all.sql': 'SELECT id FROM events WHERE created_at > 1;\nSELECT id FROM events WHERE payload = 2;' },
			{ schema: bigTable(), driverId: 'postgres', now: NOW, paths: { include: ['**/*.sql'] } },
		);
		assert.equal(report.statementCount, 2);
		assert.ok(report.findings.some((f) => f.kind === 'missing-index'));
	});
});

describe('manners', () => {
	test('a pull request touching SQL is reviewed automatically', () => {
		const decision = decideTrigger({
			kind: 'pull_request',
			action: 'opened',
			changedPaths: ['db/migrate/001.sql'],
		});
		assert.equal(decision.act, true);
		assert.equal(decision.act && decision.requested, false);
	});

	test('a pull request with no SQL is silent — no comment, no check, no trace', () => {
		const decision = decideTrigger({ kind: 'pull_request', action: 'opened', changedPaths: ['src/app.ts'] });
		assert.equal(decision.act, false);
	});

	test('a draft is left alone until it is ready', () => {
		const paths = ['db/migrate/001.sql'];
		assert.equal(decideTrigger({ kind: 'pull_request', action: 'opened', draft: true, changedPaths: paths }).act, false);
		assert.equal(decideTrigger({ kind: 'pull_request', action: 'ready_for_review', changedPaths: paths }).act, true);
		assert.equal(decideTrigger({ kind: 'pull_request', action: 'opened', draft: true, changedPaths: paths }, { drafts: true }).act, true);
	});

	test('`auto: mention` means never uninvited', () => {
		const decision = decideTrigger(
			{ kind: 'pull_request', action: 'opened', changedPaths: ['db/migrate/001.sql'] },
			{ auto: 'mention' },
		);
		assert.equal(decision.act, false);
	});

	test('a mention gets the eyes reaction immediately, before any work', () => {
		const decision = decideTrigger({ kind: 'comment', action: 'created', body: '@snoutbot review' });
		assert.equal(decision.act, true);
		assert.equal(decision.act && decision.reaction, 'eyes');
		assert.equal(decision.act && decision.requested, true);
	});

	test('help and status are answered without the eyes, being instant', () => {
		const decision = decideTrigger({ kind: 'comment', action: 'created', body: '@snoutbot help' });
		assert.equal(decision.act && decision.reaction, undefined);
	});

	test('we never answer ourselves, however we are addressed', () => {
		assert.equal(decideTrigger({ kind: 'comment', body: '@snoutbot review', authorIsSelf: true }).act, false);
		assert.equal(decideTrigger({ kind: 'comment', body: '<!-- snout-review:v1 -->\n@snoutbot review' }).act, false);
		assert.equal(isOwnComment('<!-- snout-review:v1 -->\nhello'), true);
	});

	test('another bot does not summon us unless the repository asked for it', () => {
		const event = { kind: 'pull_request' as const, action: 'opened', authorIsBot: true, changedPaths: ['db/a.sql'] };
		assert.equal(decideTrigger(event).act, false);
		assert.equal(decideTrigger(event, { bots: true }).act, true);
	});

	test('a closed or labelled pull request is nothing to do', () => {
		assert.equal(decideTrigger({ kind: 'pull_request', action: 'closed', changedPaths: ['db/a.sql'] }).act, false);
		assert.equal(decideTrigger({ kind: 'pull_request', action: 'labeled', changedPaths: ['db/a.sql'] }).act, false);
	});

	test('unknown paths mean gate again later, never guess', () => {
		const decision = decideTrigger({ kind: 'pull_request', action: 'opened' });
		assert.equal(decision.act, true);
		assert.ok(decision.act && decision.reason.includes('gate again'));
	});

	test('touchesSql reads either a path list or a diff', () => {
		assert.equal(touchesSql({ changedPaths: ['db/a.sql'] }), true);
		assert.equal(touchesSql({ changedPaths: ['README.md'] }), false);
		assert.equal(touchesSql({ diff: diffOf({ 'db/a.sql': 'SELECT 1;' }) }), true);
		assert.equal(touchesSql({}), undefined);
	});

	test('a clean review gets a tick; one with findings lets the comment speak', () => {
		assert.equal(doneReaction(0, 0), '+1');
		assert.equal(doneReaction(0, 2), undefined);
		assert.equal(doneReaction(1, 0), undefined);
	});

	test('the comment it posts can always be found again for editing', () => {
		const report = review({ diff: diffOf({ 'db/a.sql': 'DROP TABLE t;' }), now: NOW });
		assert.equal(isOwnComment(renderComment(report)), true);
	});
});

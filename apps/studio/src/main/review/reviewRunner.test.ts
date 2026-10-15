/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { planReview } from '@snout/review-core';
import type { DatabaseSchema, Probe, ReviewFinding, ReviewReport } from '@snout/review-core';

import type { ConnectionConfig } from '../../shared/connection';
import type { Forge } from './forge';
import { movedNote, NOT_BOUND_GAP, pickDestination, probeRefusal, ReviewRunner, resultStatus, runProbe, toRows } from './reviewRunner';
import type { RunnerDeps } from './reviewRunner';
import type { WatchedRepo } from './reviewStore';
import { parseRepoRef, repoId } from './reviewStore';

/*
 * The main-process half of the reviewer. The rule set itself is tested in
 * `packages/review-core`; what matters here is the part that stands between generated SQL and
 * somebody's real database, and the small amount of parsing the settings pane depends on.
 */

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

function probe(sql: string, extra: Partial<Probe> = {}): Probe {
	return {
		id: 'p1',
		statementId: 's1',
		sql,
		purpose: 'a test',
		kind: 'null-count',
		cost: 'scan',
		table: 'orders',
		...extra,
	};
}

describe('probeRefusal — the last gate before a real database', () => {
	test('a plain aggregate read is allowed', () => {
		assert.equal(probeRefusal(probe('SELECT COUNT(*) AS n FROM "orders" WHERE "ship_date" IS NULL')), undefined);
	});

	test('an EXPLAIN of a read is allowed', () => {
		assert.equal(probeRefusal(probe('EXPLAIN (FORMAT JSON) SELECT 1 FROM "orders"', { kind: 'explain', cost: 'explain' })), undefined);
	});

	test('anything that is not a read is refused', () => {
		for (const sql of [
			'UPDATE orders SET x = 1',
			'DELETE FROM orders',
			'DROP TABLE orders',
			'CREATE INDEX i ON orders (x)',
			'TRUNCATE orders',
			'CALL something()',
			'SET statement_timeout = 0',
		]) {
			assert.ok(probeRefusal(probe(sql)), `should have refused: ${sql}`);
		}
	});

	test('a write smuggled after a read is refused', () => {
		assert.ok(probeRefusal(probe('SELECT 1; DROP TABLE orders')));
		assert.ok(probeRefusal(probe('SELECT * FROM t WHERE x = 1 UNION SELECT 1; DELETE FROM t')));
	});

	test('EXPLAIN of a write is refused — it is still a write on some vendors', () => {
		assert.ok(probeRefusal(probe('EXPLAIN DELETE FROM orders', { kind: 'explain' })));
	});

	test('a keyword inside a string literal is not a write', () => {
		assert.equal(
			probeRefusal(probe("SELECT COUNT(*) AS n FROM \"orders\" WHERE \"note\" = 'please update this'")),
			undefined,
		);
	});

	test('a scanning probe is refused on a table too large to count for free', () => {
		const refusal = probeRefusal(probe('SELECT COUNT(*) AS n FROM "events"', { table: 'events' }), 900_000_000);
		assert.ok(refusal?.includes('too large'));
		// The same probe is fine on a table we can afford to read.
		assert.equal(probeRefusal(probe('SELECT COUNT(*) AS n FROM "events"'), 1_000), undefined);
	});

	// Deep mode wraps the pull request's own SELECT in EXPLAIN, so its text is the PR author's.
	// Snowflake's `->>` runs the statement after it, and its database is never asked to refuse a
	// write: the probe gate has to read the SQL the way the destination does (an outside review,
	// 2026-10-14).
	test('a probe passes the same read guard as any read, with the destination\'s dialect', () => {
		const flows = [
			probe('EXPLAIN SELECT 1 ->> REMOVE @stage', { kind: 'explain', cost: 'explain' }),
			probe('SELECT 1 ->> REMOVE @stage'),
			probe('EXPLAIN SELECT 1 ->> PUT file:///tmp/x @stage', { kind: 'explain', cost: 'explain' }),
		];
		for (const p of flows) {
			assert.ok(probeRefusal(p, undefined, 'snowflake'), p.sql);
		}
		// SQL Server needs no semicolon before a COMMIT, which ends the run's transaction.
		assert.ok(probeRefusal(probe('SELECT 1 AS n COMMIT DISABLE TRIGGER trg ON dbo.orders'), undefined, 'sqlserver'));
		// MySQL's executable comment is code to MySQL.
		assert.ok(probeRefusal(probe('EXPLAIN FORMAT=JSON SELECT 1 /*!50000 , sleep(1) */ FROM t WHERE 1 /*! INTO OUTFILE \'/tmp/x\' */', { kind: 'explain', cost: 'explain' }), undefined, 'mysql-aurora'));
		// The reads it is for still pass, on every one of those engines.
		assert.equal(probeRefusal(probe('EXPLAIN SELECT a FROM "t" WHERE b = 1', { kind: 'explain', cost: 'explain' }), undefined, 'snowflake'), undefined);
		assert.equal(probeRefusal(probe('SELECT COUNT(*) AS n FROM [orders] WHERE [ship_date] IS NULL'), undefined, 'sqlserver'), undefined);
		assert.equal(probeRefusal(probe('EXPLAIN FORMAT=JSON SELECT a FROM `t`', { kind: 'explain', cost: 'explain' }), undefined, 'mysql-aurora'), undefined);
	});

	test('every probe the core actually emits passes this gate', () => {
		// The core asserts its own probes are read-only. This asserts the two agree, which is
		// what stops a future rule from emitting something main would have to refuse.
		const schema: DatabaseSchema = {
			database: 'shop',
			fetchedAt: NOW,
			tables: [
				{
					name: 'orders',
					kind: 'table',
					primaryKey: ['id'],
					foreignKeys: [],
					indexes: [],
					stats: { rowCount: 5000 },
					columns: [
						{ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true },
						{ name: 'ship_date', dataType: 'date', nullable: true, isPrimaryKey: false },
						{ name: 'email', dataType: 'varchar(255)', nullable: true, isPrimaryKey: false },
					],
				},
			],
		};
		const body = [
			'ALTER TABLE orders ALTER COLUMN ship_date SET NOT NULL;',
			'CREATE UNIQUE INDEX ux_orders_email ON orders (email);',
			'ALTER TABLE orders ALTER COLUMN email TYPE varchar(32);',
			'SELECT id FROM orders WHERE email = 1;',
		].join('\n');
		const lines = body.split('\n');
		const diff = [
			'diff --git a/db/m.sql b/db/m.sql',
			'new file mode 100644',
			'--- /dev/null',
			'+++ b/db/m.sql',
			`@@ -0,0 +1,${lines.length} @@`,
			...lines.map((l) => `+${l}`),
		].join('\n');

		// On every destination, now that the gate reads SQL the way the destination does.
		for (const driverId of ['postgres', 'mysql-aurora', 'mariadb', 'sqlserver', 'sqlite', 'snowflake', 'duckdb']) {
			const plan = planReview({ diff, schema, driverId, deep: true, now: NOW });
			assert.ok(plan.probes.length >= 3, `expected several probes, got ${plan.probes.length}`);
			for (const p of plan.probes) {
				assert.equal(probeRefusal(p, 5000, driverId), undefined, `main refused a probe the core emitted on ${driverId}: ${p.sql}`);
			}
		}
	});
});

describe('runProbe — how a probe reaches the database', () => {
	test('it goes through the read-only path, in the background, out of the history', async () => {
		const calls: unknown[][] = [];
		const connections = {
			executeRead: async (...args: unknown[]) => {
				calls.push(args);
				return { ok: true as const, result: { fields: [{ name: 'n' }], rows: [[3]], rowCount: 1, durationMs: 1 } };
			},
		};
		const p = probe('EXPLAIN (FORMAT JSON) SELECT 1 FROM "orders"', { kind: 'explain', cost: 'explain' });
		const result = await runProbe(connections, 'c1', p);
		assert.deepEqual(calls, [['c1', p.sql, false, 'background']]);
		assert.equal(result.ok, true);
	});

	test('a refusal by the database is a failed probe, not a pass', async () => {
		const connections = {
			executeRead: async () => ({ ok: false as const, error: 'cannot execute DROP TABLE in a read-only transaction' }),
		};
		const result = await runProbe(connections, 'c1', probe('SELECT 1'));
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /read-only/);
	});
});

describe('probeRefusal — Oracle explain', () => {
	test("Oracle's EXPLAIN PLAN writes PLAN_TABLE, so it is not sent; other vendors' explain is", () => {
		const explain = probe('EXPLAIN PLAN FOR SELECT 1 FROM "ORDERS"', { kind: 'explain', cost: 'explain' });
		assert.match(probeRefusal(explain, undefined, 'oracle') ?? '', /PLAN_TABLE/);
		assert.equal(probeRefusal(probe('EXPLAIN (FORMAT JSON) SELECT 1', { kind: 'explain', cost: 'explain' }), undefined, 'postgres'), undefined);
		// A count on Oracle is still a plain read.
		assert.equal(probeRefusal(probe('SELECT COUNT(*) AS n FROM "ORDERS"'), undefined, 'oracle'), undefined);
	});
});

describe('repository references', () => {
	test('accepts owner/name, a URL, and a git remote', () => {
		assert.deepEqual(parseRepoRef('acme/widgets'), { owner: 'acme', name: 'widgets' });
		assert.deepEqual(parseRepoRef('https://github.com/acme/widgets'), { owner: 'acme', name: 'widgets' });
		assert.deepEqual(parseRepoRef('https://github.com/acme/widgets/pull/12'), { owner: 'acme', name: 'widgets' });
		assert.deepEqual(parseRepoRef('git@github.com:acme/widgets.git'), { owner: 'acme', name: 'widgets' });
	});

	test('rejects what is not a repository', () => {
		assert.equal(parseRepoRef(''), undefined);
		assert.equal(parseRepoRef('just some text'), undefined);
		assert.equal(parseRepoRef('snout'), undefined);
	});

	// This used to assert that a gitlab.com URL was REFUSED, which was right while GitHub was the
	// only host. It is now the other half of the feature: the host is deliberately not matched, so
	// a company's own GitLab works too. The rest of GitLab's shapes live in gitlabClient.test.ts.
	test('a GitLab reference is a repository too, nested group and all', () => {
		assert.deepEqual(parseRepoRef('https://gitlab.com/a/b'), { owner: 'a', name: 'b' });
		assert.deepEqual(parseRepoRef('https://gitlab.internal.acme.com/team/sub/api'), { owner: 'team/sub', name: 'api' });
	});

	test('the id is case-insensitive, because both hosts are', () => {
		assert.equal(repoId('Acme', 'Widgets'), 'acme/widgets');
	});
});

describe('resultStatus — the line beside CI', () => {
	function outcome(findings: Partial<ReviewFinding>[], awaitingApproval = false) {
		const report = {
			depth: 'connected',
			findings: findings.map((f, i) => ({ id: `f${i}`, kind: 'destructive', severity: 'note', title: 't', detail: 'd', file: 'a.sql', line: 1, statement: 's', ...f })),
			files: ['a.sql'],
			statementCount: 1,
			gaps: [],
			checksPassed: 0,
		} as unknown as ReviewReport;
		return { report, awaitingApproval } as Parameters<typeof resultStatus>[0];
	}

	test('a blocker is a red check, and says how many of what', () => {
		const s = resultStatus(outcome([{ severity: 'blocker' }, { severity: 'blocker' }, { severity: 'warn' }]));
		assert.equal(s.state, 'failure');
		assert.equal(s.description, '2 blockers, 1 warning');
	});

	test('warnings and notes alone are green: only a MEASURED failure turns it red', () => {
		// The check reports the findings, not a verdict on the change. Red means the migration
		// will not run or will lose data, which is a fact; a warning is advice.
		assert.equal(resultStatus(outcome([{ severity: 'warn' }, { severity: 'note' }])).state, 'success');
	});

	test('a clean review says so rather than saying nothing', () => {
		const s = resultStatus(outcome([]));
		assert.deepEqual([s.state, s.description], ['success', 'Nothing to flag']);
	});

	test('a review nobody has approved yet is neither green nor red', () => {
		// With approval on the review is done but nothing has been said on the pull request, and
		// a green check for a review the author cannot read would be a lie about what happened.
		const s = resultStatus(outcome([{ severity: 'blocker' }], true));
		assert.equal(s.state, 'neutral');
		assert.match(s.description, /waiting for you to approve/);
	});

	test('the target is the pull request, so Details goes where the comment is', () => {
		assert.equal(resultStatus(outcome([]), 'https://github.com/a/b/pull/1').targetUrl, 'https://github.com/a/b/pull/1');
	});
});

describe('toRows', () => {
	/*
	 * This is the shape seam between the app and the rule set, and it failed SILENTLY.
	 *
	 * `QueryResult` names its column list `fields`; this function read `columns`. The result was
	 * not an error and not a crash: every probe came back with zero rows, `countFrom` found no
	 * number, no finding was raised, and the probe was counted as a check that RAN and came back
	 * CLEAN. A migration that would fail on 412 NULL rows was reviewed as "2 checks ran against
	 * real data and came back clean".
	 *
	 * That is the worst failure this product has, because it is the one the whole thing is sold
	 * against: not a missing review, but a confident all-clear over a database it never read.
	 * The parameter is typed as QueryResult now, so the next rename cannot compile; these assert
	 * the mapping itself.
	 */
	test('a real QueryResult becomes records keyed by field name', () => {
		const rows = toRows({
			fields: [{ name: 'n' }],
			rows: [[412]],
			rowCount: 1,
			durationMs: 3,
		});
		assert.deepEqual(rows, [{ n: 412 }]);
	});

	test('the count a probe asks for actually survives the trip', () => {
		// `countFrom` reads the first numeric value of the first row. If this ever returns [] the
		// reviewer goes quiet instead of reporting a blocker, so assert the number, not the shape.
		const rows = toRows({
			fields: [{ name: 'n', dataType: 'bigint' }],
			rows: [[7]],
			rowCount: 1,
			durationMs: 1,
		});
		assert.equal(Object.values(rows[0])[0], 7);
	});

	test('several columns keep their names and their order', () => {
		const rows = toRows({
			fields: [{ name: 'table_name' }, { name: 'n' }],
			rows: [['orders', 412], ['subscribers', 7]],
			rowCount: 2,
			durationMs: 2,
		});
		assert.deepEqual(rows, [
			{ table_name: 'orders', n: 412 },
			{ table_name: 'subscribers', n: 7 },
		]);
	});

	test('an empty result is empty, and a missing one does not throw', () => {
		// A probe CAN legitimately return nothing; that is the case the bug was hiding behind, so
		// it stays supported and stays distinguishable from a shape mismatch (which now cannot
		// happen, because the type says so).
		assert.deepEqual(toRows({ fields: [{ name: 'n' }], rows: [], rowCount: 0, durationMs: 1 }), []);
		assert.deepEqual(toRows(undefined), []);
	});
});

describe('pickDestination: `--on` chooses only among the connections bound to the repository', () => {
	const configured = [
		{ id: 'c-dev', label: 'Orders dev' },
		{ id: 'c-prod', label: 'Orders prod' },
	];

	test('no `--on` is the bound connection, and no binding is text-only', () => {
		assert.deepEqual(pickDestination({ connectionId: 'c-dev' }, {}, configured), { kind: 'connection', connectionId: 'c-dev' });
		assert.deepEqual(pickDestination({}, {}, configured), { kind: 'none' });
	});

	test('the bound connection by its label or by the name the comment quotes', () => {
		assert.deepEqual(pickDestination({ connectionId: 'c-dev' }, { destination: 'orders DEV' }, configured), { kind: 'connection', connectionId: 'c-dev' });
		assert.deepEqual(
			pickDestination({ connectionId: 'c-dev', destinationName: 'staging' }, { destination: 'staging' }, configured),
			{ kind: 'connection', connectionId: 'c-dev' },
		);
	});

	test('a saved connection that is NOT bound to this repository is refused, production above all', () => {
		assert.deepEqual(pickDestination({ connectionId: 'c-dev' }, { destination: 'Orders prod' }, configured), { kind: 'refused' });
		assert.deepEqual(pickDestination({}, { destination: 'Orders prod' }, configured), { kind: 'refused' });
	});

	test('an unknown name is refused the same way, so the answer cannot list connections', () => {
		assert.deepEqual(pickDestination({ connectionId: 'c-dev' }, { destination: 'nope' }, configured), { kind: 'refused' });
		assert.doesNotMatch(NOT_BOUND_GAP, /Orders|nope|prod/i);
	});
});

describe('ReviewRunner.run: who the review reaches and when it is posted', () => {
	const DIFF = [
		'diff --git a/db/001.sql b/db/001.sql',
		'new file mode 100644',
		'--- /dev/null',
		'+++ b/db/001.sql',
		'@@ -0,0 +1 @@',
		'+DROP TABLE legacy_orders;',
		'',
	].join('\n');

	function setup(connections: ConnectionConfig[], watched: Partial<WatchedRepo> = {}, liveHead = 'abc') {
		const posted: string[] = [];
		const connected: string[] = [];
		const forge = {
			kind: 'github',
			pullRequest: async () => ({ headSha: liveHead }),
			setStatus: async () => undefined,
			react: async () => undefined,
			pullRequestDiff: async () => DIFF,
			fileContent: async () => 'DROP TABLE legacy_orders;\n',
			comments: async () => [],
			createComment: async (_o: string, _n: string, _p: number, body: string) => {
				posted.push(body);
				return { id: 1 };
			},
			updateComment: async () => ({ id: 1 }),
		} as unknown as Forge;
		const deps: RunnerDeps = {
			store: { loginFor: () => 'me' } as unknown as RunnerDeps['store'],
			connections: {
				getSchema: async (id: string) => {
					connected.push(id);
					return { database: 'orders', fetchedAt: 0, tables: [{ name: 'legacy_orders', columns: [], foreignKeys: [], indexes: [] }] };
				},
				connect: async () => undefined,
				executeRead: async () => ({ ok: true, result: { fields: [{ name: 'n' }], rows: [[0]], rowCount: 1, durationMs: 1 } }),
			} as unknown as RunnerDeps['connections'],
			forge: async () => forge,
			readConnections: () => connections,
		};
		const repo = {
			id: 'acme/api', forge: 'github', owner: 'acme', name: 'api', connectionId: 'c-dev', auto: 'mention', depth: 'connected',
			approveBeforePosting: false, method: { kind: 'deterministic' }, reviewOutsiders: false, enabled: true, ...watched,
		} as WatchedRepo;
		const pr = { number: 7, title: 't', headSha: 'abc', baseRef: 'main', draft: false, authorLogin: 'a', authorIsBot: false, fromFork: false, updatedAt: '', htmlUrl: '' };
		return { runner: new ReviewRunner(deps), repo, pr, posted, connected };
	}

	const dev = { id: 'c-dev', label: 'Orders dev', driver: 'postgres', host: 'h', port: 5432, username: 'u' } as ConnectionConfig;
	const prod = { id: 'c-prod', label: 'Orders prod', driver: 'postgres', host: 'h', port: 5432, username: 'u', environment: 'prod' } as ConnectionConfig;

	test('`--on` naming an unbound production connection never reaches it, and the comment names nothing', async () => {
		const { runner, repo, pr, posted, connected } = setup([dev, prod]);
		const outcome = await runner.run(repo, pr, { name: 'review', deep: false, raw: '', destination: 'Orders prod' });
		assert.deepEqual(connected, []);
		assert.ok(outcome.report.gaps.includes(NOT_BOUND_GAP));
		assert.equal(posted.length, 1);
		assert.doesNotMatch(posted[0], /Orders prod|Orders dev/);
	});

	test('a review against a production connection waits for approval even with posting on', async () => {
		const { runner, repo, pr, posted, connected } = setup([prod], { connectionId: 'c-prod', approveBeforePosting: false });
		const outcome = await runner.run(repo, pr, { name: 'review', deep: false, raw: '' });
		assert.deepEqual(connected, ['c-prod']);
		assert.equal(outcome.awaitingApproval, true);
		assert.equal(outcome.postedCommentId, undefined);
		assert.deepEqual(posted, []);
	});

	test('a review against anything else still posts straight away', async () => {
		const { runner, repo, pr, posted } = setup([dev]);
		const outcome = await runner.run(repo, pr, { name: 'review', deep: false, raw: '' });
		assert.equal(outcome.awaitingApproval, false);
		assert.equal(posted.length, 1);
	});

	test('a change that moved while it was being fetched is not run against the database, and nothing is posted', async () => {
		const { runner, repo, pr, posted, connected } = setup([dev], {}, 'pushed-later');
		await assert.rejects(runner.run(repo, pr, { name: 'review', deep: true, raw: '' }, 11), /changed while it was being reviewed/);
		assert.deepEqual(connected, []);
		assert.deepEqual(posted, []);
	});

	test('the note for a command written before the latest push names the host\'s word and the commit, without a dash', () => {
		const note = movedNote('merge request', '0123456789abcdef');
		assert.match(note, /^This merge request changed after the review was asked for/);
		assert.match(note, /`0123456`/);
		assert.doesNotMatch(note, /\u2014/);
	});
});

describe('ReviewRunner.run: what the database says stays off the pull request', () => {
	// A relation the pull request names, which the database echoes back in its error. No dot in
	// it, since a dot reads as schema.table.
	const HOSTILE = '![x](https://evil/pixel) @org/team </details>';
	const DIFF = [
		'diff --git a/db/002.sql b/db/002.sql',
		'new file mode 100644',
		'--- /dev/null',
		'+++ b/db/002.sql',
		'@@ -0,0 +1,2 @@',
		`+ALTER TABLE "${HOSTILE}" ALTER COLUMN c SET NOT NULL;`,
		'+DROP TABLE legacy_orders;',
		'',
	].join('\n');

	/** What renders as markup: the comment without its code spans and fenced blocks. */
	function outsideCode(md: string): string {
		return md.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '').replace(/(`+)[\s\S]*?\1/g, '');
	}

	function setup(kind: 'github' | 'gitlab', opts: { reach?: Error; probeError?: string; commentaryError?: Error } = {}) {
		const posted: string[] = [];
		const forge = {
			kind,
			pullRequest: async () => ({ headSha: 'abc' }),
			setStatus: async () => undefined,
			react: async () => undefined,
			pullRequestDiff: async () => DIFF,
			fileContent: async () => `ALTER TABLE "${HOSTILE}" ALTER COLUMN c SET NOT NULL;\nDROP TABLE legacy_orders;\n`,
			comments: async () => [],
			createComment: async (_o: string, _n: string, _p: number, body: string) => {
				posted.push(body);
				return { id: 1 };
			},
			updateComment: async () => ({ id: 1 }),
		} as unknown as Forge;
		const deps: RunnerDeps = {
			store: { loginFor: () => 'me' } as unknown as RunnerDeps['store'],
			connections: {
				getSchema: async () => {
					if (opts.reach) {
						throw opts.reach;
					}
					return {
						database: 'orders',
						fetchedAt: 0,
						tables: [{ name: HOSTILE, primaryKey: [], columns: [{ name: 'c', dataType: 'int', nullable: true, isPrimaryKey: false }], foreignKeys: [], indexes: [] }],
					};
				},
				connect: async () => undefined,
				executeRead: async () => ({ ok: false, error: opts.probeError ?? `relation "${HOSTILE}" does not exist` }),
			} as unknown as RunnerDeps['connections'],
			forge: async () => forge,
			readConnections: () => [{ id: 'c-dev', label: 'Orders dev', driver: 'postgres', host: 'h', port: 5432, username: 'u' } as ConnectionConfig],
			commentary: opts.commentaryError ? async () => { throw opts.commentaryError; } : undefined,
		};
		const repo = {
			id: 'acme/api', forge: kind, owner: 'acme', name: 'api', connectionId: 'c-dev', auto: 'mention', depth: 'connected',
			approveBeforePosting: false, method: opts.commentaryError ? { kind: 'snoutAi', consent: true } : { kind: 'deterministic' }, reviewOutsiders: false, enabled: true,
		} as unknown as WatchedRepo;
		const pr = { number: 7, title: 't', headSha: 'abc', baseRef: 'main', draft: false, authorLogin: 'a', authorIsBot: false, fromFork: false, updatedAt: '', htmlUrl: '' };
		return { runner: new ReviewRunner(deps), repo, pr, posted };
	}

	for (const kind of ['github', 'gitlab'] as const) {
		test(`${kind}: a hostile name the database echoes back is not markup in the comment, and the error is not posted`, async () => {
			const { runner, repo, pr, posted } = setup(kind);
			const outcome = await runner.run(repo, pr, { name: 'review', deep: false, raw: '' });
			assert.equal(posted.length, 1);
			const body = posted[0];
			assert.ok(!body.includes('relation "'), 'the raw error is not posted');
			assert.match(body, /the object does not exist on the target database/);
			const markup = outsideCode(body);
			assert.ok(!markup.includes('https://evil'));
			assert.ok(!markup.includes('@org'));
			assert.ok(!markup.includes('!['));
			assert.equal((markup.match(/<\/details>/g) ?? []).length, (markup.match(/<details>/g) ?? []).length);
			// The full text is still there for the review tab.
			assert.deepEqual(outcome.report.localErrors?.map((e) => e.error), [`relation "${HOSTILE}" does not exist`]);
		});

		test(`${kind}: hosts, roles and values in an error stay on this computer`, async () => {
			const { runner, repo, pr, posted } = setup(kind, { probeError: 'FATAL: no pg_hba.conf entry for host "10.1.2.3", user "admin_ops", password=hunter2' });
			await runner.run(repo, pr, { name: 'review', deep: false, raw: '' });
			for (const leak of ['10.1.2.3', 'admin_ops', 'hunter2', 'pg_hba']) {
				assert.ok(!posted[0].includes(leak), leak);
			}
		});

		test(`${kind}: a destination that could not be reached says so without the driver's words`, async () => {
			const { runner, repo, pr, posted } = setup(kind, { reach: new Error('connect ECONNREFUSED 10.9.8.7:5432 as admin_ops') });
			const outcome = await runner.run(repo, pr, { name: 'review', deep: false, raw: '' });
			assert.ok(!posted[0].includes('10.9.8.7'));
			assert.ok(!posted[0].includes('admin_ops'));
			assert.match(posted[0], /could not be reached, so nothing here was measured/);
			assert.ok(outcome.report.localErrors?.some((e) => e.error.includes('10.9.8.7')));
		});
	}

	test('a failed explanation is a fixed sentence in the comment', async () => {
		const { runner, repo, pr, posted } = setup('github', { commentaryError: new Error('401 from https://gateway.internal/v1 key key-live-123') });
		await runner.run(repo, pr, { name: 'review', deep: false, raw: '' });
		assert.ok(!posted[0].includes('key-live-123'));
		assert.ok(!posted[0].includes('gateway.internal'));
		assert.match(posted[0], /the written explanation could not be produced/);
	});

	test('a probe the host timed out or refused carries its kind', async () => {
		const slow = await runProbe({ executeRead: () => new Promise(() => undefined) } as never, 'c', { id: 'p', statementId: 's', sql: 'SELECT 1', purpose: 'x', kind: 'row-count', cost: 'lookup' }, 5);
		assert.equal(slow.failure, 'timeout');
	});
});

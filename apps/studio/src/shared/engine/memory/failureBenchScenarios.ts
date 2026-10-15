/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { BackendKind } from '../compile/native';
import type { ErrorClass } from './errorClass';

/**
 * The model-in-the-loop replay corpus.
 *
 * Each scenario is a self-contained situation designed to make the assistant PROPOSE a query that
 * FAILS on the first attempt, so failure memory has something to capture — then the harness measures
 * whether injecting that memory on a second attempt reduces the repeat. This is the corpus the live
 * repeat-failure number is computed over; the deterministic retrieval half lives in
 * `failureReplayBenchmark.test.ts` (priors + probes, no model).
 *
 * Design rules for a scenario worth its slot:
 *  - The setup DDL is runnable against a throwaway SQLite database with no external services, so the
 *    harness stays cheap to iterate (step 1 runs it many times against the local bench model).
 *  - The task is phrased like a real user's underspecified ask, NOT "write SQL that violates the CHECK".
 *    We're measuring whether the model walks into the failure on its own, then whether memory pulls it
 *    back out — leading it by the hand would measure nothing.
 *  - `inducedClass` is the error_class we EXPECT the first attempt to hit. It's a label for segmenting
 *    results (the plan segments the lift by error_class), not an assertion — a model that gets it right
 *    first try simply contributes no repeat to measure, and the harness reports that.
 *
 * SQLite is loosely typed, so genuine `type-mismatch` is rare; the reliable relational classes here are
 * `constraint-violation` (NOT NULL / CHECK / UNIQUE) and `unclassified` (no-such-column, STRICT type
 * rejection — an honest unclassified is itself a measured output). The document-backend
 * `unsupported-translation` class (a Mongo JOIN the SQL→Mongo compiler refuses) is in the corpus
 * (`mongo-join-*`, `backend: 'document'`); it needs a live Mongo and is skipped cleanly when none is
 * reachable. The `timeout` and `deadlock` classes (`pg-*`, `driver: 'postgres'`) need a live Postgres
 * plus a contention rig and are likewise skipped cleanly when none is reachable.
 */
export interface BenchScenario {
	/** Stable, short identifier — also the segment label in the printed report. */
	name: string;
	/** The connection backend the scenario runs against. `relational` runs against SQLite or Postgres
	 *  (see {@link driver}); `document` runs against a live Mongo (skipped cleanly when none is
	 *  reachable — see the harness's reachability guard). */
	backend: BackendKind;
	/** Which relational engine. Default `sqlite` — a throwaway file, no external service. `postgres`
	 *  needs a live server (a throwaway database per scenario) and is what the `timeout` / `deadlock`
	 *  classes require: SQLite has no lock-contention story that classifies as either (its "database is
	 *  locked" lands in `unclassified`), and it has no statement timeout to trip. */
	driver?: 'sqlite' | 'postgres';
	/** DDL (+ optional seed rows) run one statement at a time to build the schema before the task.
	 *  Relational scenarios only — a `document` scenario seeds through {@link mongoSetup} instead.
	 *  For Postgres these run out-of-band on an admin session with no statement timeout, so a large
	 *  seed can't trip {@link statementTimeout}. */
	setup: string[];
	/** Postgres only: applied to the scenario's database AFTER setup (`ALTER DATABASE … SET
	 *  statement_timeout`), so it governs only the measured statements. This is what turns an expensive
	 *  query into a deterministic, ground-truth `timeout` — no model, no judge, no timing luck. */
	statementTimeout?: string;
	/**
	 * Postgres only: a contending transaction opened on a SEPARATE raw connection before attempt 1.
	 * Test infrastructure, not part of what is measured — it stands in for the other session a real
	 * user is unlucky enough to collide with.
	 */
	contention?: {
		/** Statements run inside the holder's open transaction; it keeps whatever locks they take. */
		hold: string[];
		/** Fired once a backend is observed waiting on a lock. Requesting a lock the waiter already holds
		 *  is what closes the cycle and makes Postgres raise a real `deadlock detected` (40P01), rather
		 *  than the waiter simply blocking until its statement timeout. Polled, never slept on, so the
		 *  rig doesn't depend on timing luck. */
		onWait?: string;
		/** `after-attempt-1` models a TRANSIENT cause: the contention is gone before the retry, so the
		 *  identical query would now succeed. That is the stale-suppression / over-steer check — memory
		 *  must not talk the model out of a query that is fine again. `after-run` holds the contention
		 *  across both attempts, so the failure is still live when memory speaks. */
		release: 'after-attempt-1' | 'after-run';
	};
	/**
	 * The boundary law, made measurable (the previous essay's finding): does a query exist that this
	 * backend can actually RUN and that still answers the user's ask, for the note to steer toward?
	 * Where one exists the repeat rate collapses; where it doesn't, no note can help and a note that
	 * insists on steering degrades the answer instead. Left undefined where the call is a judgment
	 * rather than a fact about the backend — an unlabelled scenario is reported as such, never guessed.
	 */
	hasSatisfyingAlternative?: boolean;
	/** For a `document` (Mongo) scenario: collections to create and seed before the task, applied via
	 *  the connection's native create-collection + insert ops (the SQL `setup` is ignored). The seeded
	 *  documents make introspection infer real fields, so the schema fingerprint is meaningful and the
	 *  model sees collections it will instinctively try to JOIN. */
	mongoSetup?: { collection: string; docs: Record<string, unknown>[] }[];
	/** The user's natural-language ask, sent through the real assistant path. Underspecified on purpose. */
	task: string;
	/** The error_class the first attempt is expected to hit — a segmentation label, not an assertion. */
	inducedClass: ErrorClass;
	/**
	 * Whether the failure is DERIVABLE from what the model is given (the rendered schema + the task).
	 * This is the plan's key axis, sharper than `error_class`: for an *inferable* failure (a CHECK /
	 * NOT NULL that's right there in the DDL) capability substitutes for memory — a capable model
	 * simply doesn't fail, and the ones that do are fixed by the schema, so memory shows little lift.
	 * A *non-inferable* failure depends on something NOT in the prompt — live data (a value already
	 * taken) or hidden logic (a trigger rule, a translation limitation) — so no model can derive it,
	 * and memory carries information capability can't. Memory's value should concentrate here.
	 */
	inferable: boolean;
	/** Why this scenario induces a failure and how memory could plausibly help — the essay's per-case note. */
	rationale: string;
}

export const BENCH_SCENARIOS: BenchScenario[] = [
	{
		name: 'check-constraint-status',
		backend: 'relational',
		setup: [
			"CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open', 'paid', 'shipped', 'cancelled')))",
			"INSERT INTO orders (id, customer, status) VALUES (1, 'Globex', 'open')",
		],
		task: "Add a new order for customer 'Acme' with status 'pending'.",
		inducedClass: 'constraint-violation',
		inferable: true,
		rationale:
			"The status column only allows a fixed set, but the user asks for 'pending'. A model that takes the ask literally inserts 'pending' and hits the CHECK. INFERABLE: the allowed values are right there in the rendered DDL, so a capable model (or one warned by the visible error) reconciles from the schema alone — the generic memory note adds little.",
	},
	{
		name: 'not-null-missing-email',
		backend: 'relational',
		setup: [
			'CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT)',
		],
		task: "We met someone named Jordan at a conference and only got their phone number, 555-0100. Add them as a contact.",
		inducedClass: 'constraint-violation',
		inferable: true,
		rationale:
			'email is NOT NULL but the user has only a name and phone. The natural INSERT omits email and violates NOT NULL. INFERABLE: the NOT NULL is in the rendered DDL, so the failure is derivable without memory; kept as an inferable-segment contrast.',
	},
	{
		name: 'strict-type-non-numeric',
		backend: 'relational',
		setup: [
			'CREATE TABLE readings (id INTEGER PRIMARY KEY, sensor TEXT NOT NULL, celsius REAL NOT NULL) STRICT',
		],
		task: "Sensor 'A1' reported an error instead of a temperature. Record its latest reading as the text 'ERR'.",
		inducedClass: 'unclassified',
		inferable: true,
		rationale:
			"A STRICT table rejects a TEXT value in a REAL column ('cannot store TEXT value in REAL column') — a failure not obvious from a bare DDL to a model that ignores STRICT. It classifies as unclassified today (an honest measured gap, and a candidate to grow the taxonomy). INFERABLE: STRICT + REAL are in the rendered DDL, so a careful model avoids it; kept in the inferable segment.",
	},
	{
		name: 'no-such-column-name',
		backend: 'relational',
		setup: [
			'CREATE TABLE products (id INTEGER PRIMARY KEY, title TEXT NOT NULL, price_cents INTEGER NOT NULL)',
			"INSERT INTO products (id, title, price_cents) VALUES (1, 'Widget', 999)",
		],
		task: 'List every product with its name and price.',
		inducedClass: 'unclassified',
		inferable: true,
		rationale:
			"There is no `name` column (it's `title`), so a model that reaches for the word in the ask emits `SELECT name ...` and hits 'no such column'. INFERABLE: the schema is in the prompt, so a careful model avoids it first try — the point is to measure how often the memory of the prior miss helps a model that didn't.",
	},
	{
		// Negative control: attempt 1 SUCCEEDS, so nothing is remembered and both conditions must stay
		// silent. Excluded from the repeat-failure denominator (you can't repeat a failure that never
		// happened); its job is to confirm memory never fabricates a caution on a clean query.
		name: 'control-count-succeeds',
		backend: 'relational',
		setup: [
			'CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, at TEXT NOT NULL)',
			"INSERT INTO events (id, kind, at) VALUES (1, 'login', '2026-01-01'), (2, 'logout', '2026-01-01')",
		],
		task: 'How many events are recorded?',
		inducedClass: 'unclassified',
		inferable: true,
		rationale:
			'A plain COUNT(*) succeeds, seeding no memory. Confirms the harness scores a no-failure scenario correctly and that memory stays silent.',
	},

	// ─── Non-inferable failures — the memory-carries-what-the-model-can't-derive cases ───
	// These depend on runtime DATA (a value already taken) or HIDDEN LOGIC (a trigger rule the schema
	// prompt never renders). No model can derive them from the schema + task, so this is where memory's
	// value should concentrate. All are runnable headlessly in SQLite today (triggers + UNIQUE data),
	// unlike the plan's other non-inferable seeds (Mongo unsupported-translation, deadlock, timeout)
	// which need a live backend / concurrency rig and are the next backend to wire.
	{
		name: 'unique-tag-idempotent',
		backend: 'relational',
		setup: [
			'CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE)',
			"INSERT INTO tags (id, label) VALUES (1, 'urgent')",
		],
		task: "Make sure there is a tag labeled 'urgent'.",
		inducedClass: 'constraint-violation',
		inferable: false,
		rationale:
			"A plain INSERT of 'urgent' hits the UNIQUE index because that label already exists — a fact NOT in the schema (the DDL says UNIQUE, not which values are taken), so no model can derive it first try. The task ('make sure there is') permits an idempotent fix, so a memory warning has room to help: the retry can use INSERT OR IGNORE / ON CONFLICT / an existence check instead of blindly re-inserting.",
	},
	{
		name: 'trigger-overdraft',
		backend: 'relational',
		setup: [
			'CREATE TABLE accounts (id INTEGER PRIMARY KEY, holder TEXT NOT NULL, balance INTEGER NOT NULL)',
			"CREATE TRIGGER accounts_no_overdraft BEFORE UPDATE OF balance ON accounts WHEN NEW.balance < 0 BEGIN SELECT RAISE(ABORT, 'overdraft not allowed'); END",
			"INSERT INTO accounts (id, holder, balance) VALUES (1, 'Checking', 50)",
		],
		task: 'Withdraw 80 from account 1.',
		inducedClass: 'unclassified',
		inferable: false,
		rationale:
			"The balance is 50, and a BEFORE UPDATE trigger aborts any update that would take it negative. The rule lives in a trigger body the schema prompt never renders, so the model can't know it — the natural `balance = balance - 80` update raises. Memory (a warning that a similar update failed) has room to help: the retry can guard with `WHERE balance >= 80`, or surface the constraint to the user instead of silently repeating.",
	},
	{
		name: 'trigger-append-only-delete',
		backend: 'relational',
		setup: [
			'CREATE TABLE ledger (id INTEGER PRIMARY KEY, entry TEXT NOT NULL, amount INTEGER NOT NULL)',
			"CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END",
			"INSERT INTO ledger (id, entry, amount) VALUES (1, 'opening balance', 100)",
		],
		task: 'Delete ledger entry 1, it was entered by mistake.',
		inducedClass: 'unclassified',
		inferable: false,
		rationale:
			"An append-only rule enforced by a BEFORE DELETE trigger — invisible to the model, which proposes a plain DELETE and gets aborted. Non-inferable (the rule is nowhere in the rendered schema). Memory could steer the retry toward a reversing/adjusting entry (the append-only-correct move) rather than re-attempting the forbidden DELETE.",
	},
	{
		name: 'trigger-immutable-shipped',
		backend: 'relational',
		setup: [
			'CREATE TABLE shipments (id INTEGER PRIMARY KEY, code TEXT NOT NULL, status TEXT NOT NULL)',
			"CREATE TRIGGER shipments_lock_shipped BEFORE UPDATE OF status ON shipments WHEN OLD.status = 'shipped' BEGIN SELECT RAISE(ABORT, 'a shipped order cannot change status'); END",
			"INSERT INTO shipments (id, code, status) VALUES (1, 'SH-1', 'shipped')",
		],
		task: "Set shipment 1's status back to open.",
		inducedClass: 'unclassified',
		inferable: false,
		rationale:
			"A trigger freezes status once a shipment is 'shipped'. The model can't see the rule (trigger body, not rendered), so a plain UPDATE aborts. Non-inferable; memory could get the retry to explain the constraint / propose a valid transition rather than repeat the blocked UPDATE.",
	},

	// ─── Document backend (Mongo) — unsupported-translation, the cleanest non-inferable class ───
	// The deterministic SQL→Mongo compiler REFUSES anything outside its subset (JOINs, DISTINCT,
	// subqueries), so a first attempt that reaches for a JOIN across two collections fails by
	// construction — deterministic regardless of model, and invisible from the schema (the prompt
	// renders collections like tables; nothing says "this backend can't join"). The harness runs these
	// with the AI transcriber OFF so the refusal is TERMINAL (recorded), not rescued — modelling a user
	// who hasn't enabled AI translation. Memory's job: steer the retry to a single-collection shape the
	// compiler CAN run. Needs a live Mongo; skipped cleanly when none is reachable.
	{
		name: 'mongo-join-order-customer',
		backend: 'document',
		setup: [],
		mongoSetup: [
			{
				collection: 'customers',
				docs: [
					{ customer_id: 1, name: 'Globex', city: 'Portland' },
					{ customer_id: 2, name: 'Acme', city: 'Denver' },
				],
			},
			{
				collection: 'orders',
				docs: [
					{ order_id: 1, customer_id: 1, total: 240 },
					{ order_id: 2, customer_id: 2, total: 55 },
					{ order_id: 3, customer_id: 1, total: 89 },
				],
			},
		],
		task: "Show each order's total together with the name of the customer who placed it.",
		inducedClass: 'unsupported-translation',
		inferable: false,
		hasSatisfyingAlternative: false,
		rationale:
			"orders and customers are separate collections joined by customer_id; the natural SQL is a JOIN, which the deterministic SQL→Mongo compiler refuses ('exactly one FROM table'). NON-inferable: nothing in the rendered schema says this backend can't join, so the model can't derive the limit. Memory's fix path (avoid JOIN, use a shape the backend supports) has room to help: the retry can list the orders from one collection, or fetch the customers separately.",
	},
	{
		name: 'mongo-join-post-author',
		backend: 'document',
		setup: [],
		mongoSetup: [
			{
				collection: 'authors',
				docs: [
					{ author_id: 1, handle: 'ada', followers: 1200 },
					{ author_id: 2, handle: 'linus', followers: 8000 },
				],
			},
			{
				collection: 'posts',
				docs: [
					{ post_id: 10, author_id: 1, title: 'On Notation', likes: 42 },
					{ post_id: 11, author_id: 2, title: 'On Kernels', likes: 130 },
					{ post_id: 12, author_id: 1, title: 'On Engines', likes: 7 },
				],
			},
		],
		task: "List every post's title alongside the handle of its author.",
		inducedClass: 'unsupported-translation',
		inferable: false,
		hasSatisfyingAlternative: false,
		rationale:
			"posts reference authors by author_id in a second collection; joining title to handle is a JOIN the SQL→Mongo compiler refuses. NON-inferable (the backend's no-join limit is nowhere in the prompt). A second JOIN case (distinct domain) so the class carries more than one measured run. Memory should push the retry to a single-collection projection instead of re-attempting the join.",
	},

	// ─── The CONTRAST scenario — the boundary law, shown two-sided (memory-v1 plan, NEXT ACTION) ───
	// Same backend + same error_class as the two JOINs above, but with a CRUCIAL difference: a satisfying
	// single-collection rewrite EXISTS. `SELECT DISTINCT status FROM orders` is refused by the SQL→Mongo
	// compiler, but `SELECT status FROM orders GROUP BY status` COMPILES (compileGroup → $group). So unlike
	// the JOINs (which intrinsically need two collections and have nowhere for the note to steer), this
	// failure HAS a translatable answer the memory note can point at. Prediction: with memory ON the model
	// steers to the GROUP BY form and the repeat rate DROPS here while the JOINs stay high — an A/B on the
	// same backend that demonstrates the boundary law rather than asserting it.
	{
		name: 'mongo-distinct-status',
		backend: 'document',
		setup: [],
		mongoSetup: [
			{
				collection: 'orders',
				docs: [
					{ order_id: 1, status: 'open', total: 240 },
					{ order_id: 2, status: 'paid', total: 55 },
					{ order_id: 3, status: 'open', total: 89 },
					{ order_id: 4, status: 'shipped', total: 12 },
					{ order_id: 5, status: 'paid', total: 300 },
				],
			},
		],
		task: 'What are the different order statuses in use?',
		inducedClass: 'unsupported-translation',
		inferable: false,
		hasSatisfyingAlternative: true,
		rationale:
			"A distinct-values ask over ONE collection. The natural SQL is `SELECT DISTINCT status FROM orders`, which the SQL→Mongo compiler refuses ('SELECT DISTINCT is not supported'). NON-inferable (nothing in the prompt says DISTINCT is unsupported). CRUCIALLY, unlike the JOINs, a satisfying single-collection rewrite EXISTS: `SELECT status FROM orders GROUP BY status` compiles to a $group pipeline. This is the CONTRAST case for the boundary law — memory ON should steer to GROUP BY and drive the repeat down, while the JOIN scenarios (no satisfying alternative) stay high.",
	},

	// ─── Postgres — the `timeout` and `deadlock` classes (the last unmeasured ones) ───
	// These are the classes the previous essay named as "the next real signal", on the reasoning that
	// their standard fixes (a LIMIT, a smaller write, a retry) ARE satisfying alternatives — so the
	// boundary law predicts memory should help here, unlike the Mongo JOINs. They exist to TEST that
	// prediction on a different backend and a different error class, which is the only way an
	// observation about one compiler becomes a law. All need a live Postgres; skipped cleanly without.
	//
	// The failure is ground truth by construction, exactly as the discipline requires: a database-level
	// `statement_timeout` (set AFTER seeding, so it governs only the measured statement) makes an
	// unbounded scan a deterministic timeout, and a contending transaction on a second connection makes
	// a lock wait or a real 40P01 deadlock. No model, no judge, no timing luck.
	{
		name: 'pg-timeout-full-scan-read',
		backend: 'relational',
		driver: 'postgres',
		setup: [
			'CREATE TABLE audit_log (id bigserial PRIMARY KEY, at date NOT NULL, actor text NOT NULL, action text NOT NULL, detail text NOT NULL)',
			`INSERT INTO audit_log (at, actor, action, detail)
				SELECT (DATE '2023-01-01' + (g / 5556)), 'user' || (g % 50), 'action' || (g % 7), 'detail text for row ' || g
				FROM generate_series(1, 5000000) g`,
		],
		// 1s, not something tighter: the unbounded read takes ~10s (measured), so the margin is 10x either
		// way, and the app's own connect-time introspection still has room to finish under the same limit.
		statementTimeout: '1s',
		task: 'Show me what is in the audit log.',
		inducedClass: 'timeout',
		inferable: false,
		hasSatisfyingAlternative: true,
		rationale:
			"An unbounded `SELECT * FROM audit_log` over 5M rows takes ~10s against a 1s statement timeout, while `... LIMIT 100` returns in ~3ms. NON-inferable: nothing in the rendered schema says the table is huge or that the server caps statement time. A satisfying alternative plainly EXISTS — a bounded read still answers 'show me what is in the log' — and it is exactly what the timeout note points at ('add a LIMIT'), so the boundary law predicts the repeat rate should collapse here. A model that bounds the read on its first attempt simply contributes no measured repeat, which the harness reports.",
	},
	{
		name: 'pg-timeout-full-scan-export',
		backend: 'relational',
		driver: 'postgres',
		setup: [
			'CREATE TABLE readings (id bigserial PRIMARY KEY, taken_at timestamptz NOT NULL, sensor text NOT NULL, celsius double precision NOT NULL, note text NOT NULL)',
			`INSERT INTO readings (taken_at, sensor, celsius, note)
				SELECT TIMESTAMPTZ '2024-01-01 00:00:00+00' + (g * INTERVAL '5 seconds'), 'sensor-' || (g % 120), 10 + (g % 300) / 10.0, 'observation ' || g
				FROM generate_series(1, 5000000) g`,
		],
		statementTimeout: '1s',
		task: 'I need to look through the sensor readings — pull them up.',
		inducedClass: 'timeout',
		inferable: false,
		hasSatisfyingAlternative: true,
		rationale:
			'The same mechanism in a second domain, so the alternative-exists arm carries more than one scenario (mirroring the two Mongo JOINs). An unbounded read of 5M readings trips the timeout; a bounded one answers the ask instantly.',
	},
	{
		name: 'pg-timeout-lock-contention',
		backend: 'relational',
		driver: 'postgres',
		setup: [
			'CREATE TABLE accounts (id int PRIMARY KEY, holder text NOT NULL, balance int NOT NULL)',
			"INSERT INTO accounts VALUES (1, 'Checking', 500), (2, 'Savings', 900)",
		],
		statementTimeout: '500ms',
		contention: {
			hold: ['UPDATE accounts SET balance = balance - 1 WHERE id = 1'],
			release: 'after-run',
		},
		task: 'Deposit 100 into the Checking account.',
		inducedClass: 'timeout',
		inferable: false,
		hasSatisfyingAlternative: false,
		rationale:
			"Another session holds an uncommitted row lock on the Checking row for the whole run, so any UPDATE of it blocks and dies at the statement timeout ('canceling statement due to statement timeout'). NON-inferable: the other session is nowhere in the schema. This is the NO-alternative arm of the timeout class — no rewrite avoids someone else's lock, and the note's advice (add a LIMIT, narrow the WHERE, use an indexed column) has nowhere to steer. Prediction: memory does NOT move this, the way it did not move the Mongo JOINs. The pair with the two full-scan scenarios is what tests the boundary law WITHIN one error class, on a backend the law was not derived from.",
	},
	{
		name: 'pg-deadlock-transient',
		backend: 'relational',
		driver: 'postgres',
		setup: [
			'CREATE TABLE accounts (id int PRIMARY KEY, holder text NOT NULL, balance int NOT NULL)',
			"INSERT INTO accounts VALUES (1, 'Checking', 500), (2, 'Savings', 900)",
		],
		// Not the mechanism here (the deadlock is), purely a safety valve: if the cycle never forms the
		// blocked statement would wait forever and hang the bench, so it dies after 10s instead. A run
		// that ends that way records a `timeout`, not a `deadlock`, and the report shows it as such.
		statementTimeout: '10s',
		contention: {
			// Hold the DESTINATION row (Checking), not the source. A transfer is written debit-then-credit,
			// so the model's first statement takes Savings and its second blocks on Checking — which means
			// it is blocked while already holding a row, the only state a cycle can form from. Holding the
			// source row instead just blocks it on statement one, holding nothing, and it dies of the
			// timeout with no deadlock (measured: that is exactly what happened).
			hold: ['UPDATE accounts SET balance = balance - 1 WHERE id = 1'],
			// Fired once the transfer is seen waiting: the holder now wants the row the transfer already
			// locked, which closes the cycle and makes Postgres raise a genuine 40P01.
			onWait: 'UPDATE accounts SET balance = balance - 1 WHERE id = 2',
			release: 'after-attempt-1',
		},
		task: 'Transfer 100 from Savings to Checking.',
		inducedClass: 'deadlock',
		inferable: false,
		rationale:
			"The natural two-statement transfer takes the two account rows in the opposite order to a concurrent session, so Postgres detects a cycle and aborts it: a real 'deadlock detected' (40P01), the class's ground truth. THE POINT OF THIS SCENARIO IS NOT REPEAT-REDUCTION. The contention is released after attempt 1, so by the retry the identical query would SUCCEED — which is the nonstationarity the research doc warns about ('a deadlock can un-happen'). It is the OVER-STEER / stale-suppression check: memory-OFF should be ~0 failures, and any memory-ON failure is memory talking the model out of a query that is fine again. Deliberately left unlabelled for the boundary law — the question here is not whether the note can steer, but whether it should have spoken at all.",
	},
];

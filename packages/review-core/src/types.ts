/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The reviewer's contracts: what goes in, what a finding is, and what comes out.
 *--------------------------------------------------------------------------------------------*/

import type { DatabaseSchema } from './schema.js';

/**
 * How much of the destination the reviewer could see. Reported on every report, printed in the
 * comment, and the reason the same code serves the cloud, a CI runner and the desktop:
 * - `static`    — the diff only. No schema, no measurements.
 * - `schema`    — the destination's introspected schema, but nothing was measured.
 * - `connected` — schema plus probe results measured against the destination.
 *
 * Nothing may claim to have checked the database at `static`.
 */
export type ReviewDepth = 'static' | 'schema' | 'connected';

/**
 * Severity is about CONSEQUENCE, not confidence, and is deliberately coarse:
 * - `blocker` — this will fail, lose data, or take the database down. Merging is a mistake.
 * - `warn`    — this will hurt (a lock, a scan, a lost index) but it will run.
 * - `note`    — worth knowing; hygiene, style, a thing to remember at deploy time.
 */
export type ReviewSeverity = 'blocker' | 'warn' | 'note';

export type ReviewFindingKind =
	// Measured against the destination — the statement errors as things stand.
	| 'will-fail'
	// Static tier.
	| 'destructive'
	| 'hazard'
	| 'non-sargable'
	| 'migration-hygiene'
	| 'dialect'
	// Schema-aware tier.
	| 'unknown-object'
	| 'already-exists'
	| 'missing-index'
	| 'redundant-index'
	| 'unindexed-foreign-key'
	| 'narrowing-type'
	| 'still-referenced'
	| 'lock-risk'
	// Live tier (from a probe or an EXPLAIN).
	| 'plan';

/**
 * A measurement, and where it came from. Every finding that quotes a number carries one.
 * A number without its source is a claim, and the product only works if the numbers are
 * trusted — so this is not optional metadata, it is the finding's evidence.
 */
export interface Evidence {
	/** What was measured, in words: "412 rows with ship_date IS NULL". */
	measured: string;
	/** What it was measured on: a connection or database name the reader recognises. */
	source: string;
	/** Epoch ms the measurement was taken. */
	at: number;
	/** The read-only SQL that produced it, so a sceptical reader can run it themselves. */
	sql?: string;
}

export interface ReviewFinding {
	kind: ReviewFindingKind;
	severity: ReviewSeverity;
	/** One line, stated as what will happen — not as advice. */
	title: string;
	/** Why it happens. The part that makes a reviewer trust the finding instead of muting it. */
	detail: string;
	/** Repository-relative path of the file the finding is in. */
	file: string;
	/** 1-based line in the file's new content. */
	line: number;
	/** The statement it concerns, trimmed for display. */
	statement: string;
	/** A rewrite or a migration step the author can take. */
	suggestedSql?: string;
	evidence?: Evidence;
	/** Stable identity for de-duplication across pushes and for muting: kind + object + file. */
	id: string;
}

/** One SQL statement the pull request touched. */
export interface ReviewStatement {
	/** Stable within a review — used to tie a probe back to the statement that asked for it. */
	id: string;
	sql: string;
	file: string;
	/** 1-based line of the statement's first character in the file's new content. */
	line: number;
	/** True when at least one line of the statement was added or changed by this PR. A file can
	 *  contain statements the PR did not touch; those are context, not review targets. */
	touched: boolean;
}

/**
 * A read-only question for the destination. The core emits these and reads their results; the
 * host runs them. That split is what lets one rule set serve any host: a desktop app with a
 * tunnel, a CI runner inside a VPC, a service with its own connection, and a unit test with fixtures.
 */
export interface Probe {
	id: string;
	/** The statement this probe was raised for. */
	statementId: string;
	/** Read-only SQL. A probe that writes is a bug, not a probe. */
	sql: string;
	/** Why it is being asked, for the audit log and for a host that wants to show the user. */
	purpose: string;
	/** What the reviewer will do with a positive answer, so a host can decide to skip an
	 *  expensive probe and still explain the gap. */
	kind: ProbeKind;
	/** The table it reads, so a host can refuse or bound a probe against a huge table. */
	table?: string;
	/** The column it asks about, when there is one. Carried here rather than read back out of
	 *  `purpose`, which is prose with markdown in it. */
	column?: string;
	/** Rough cost class. `scan` means it may read the whole table; hosts should cap or skip
	 *  those on a large destination rather than run them blind. */
	cost: 'lookup' | 'scan' | 'explain';
}

export type ProbeKind =
	| 'null-count'      // rows that would violate a new NOT NULL
	| 'duplicate-count' // values that would violate a new UNIQUE
	| 'orphan-count'    // child rows that would violate a new foreign key
	| 'overflow-count'  // values too big for a narrowed type
	| 'row-count'       // how big the table really is
	| 'explain';        // the plan for a changed query

/** What the host got back. `rows` is whatever the driver returned, read by kind. */
export interface ProbeResult {
	id: string;
	ok: boolean;
	/** Result rows. Count probes are read as the first numeric value of the first row. */
	rows?: Record<string, unknown>[];
	/** Why it could not be answered — reported as a gap, never silently dropped. The database's
	 *  own words, so it is NEVER put in the comment (it echoes names the pull request chose, and
	 *  hosts, roles and values besides): the comment gets the fixed reason for its `failure`, and
	 *  this text is kept on the report's `localErrors` for the host's own screen. */
	error?: string;
	/** What kind of failure it was, when the host knows (its own timeout, its own refusal).
	 *  Otherwise the core classifies `error` itself (`probeFailureOf`). */
	failure?: ProbeFailure;
}

/**
 * Why a probe could not be answered, as a closed set. Each has one fixed sentence in the comment
 * (`PROBE_FAILURE_REASONS`), so nothing the database said is ever posted.
 */
export type ProbeFailure =
	| 'missing'    // the object it reads does not exist there
	| 'permission' // the reviewing connection may not read it
	| 'timeout'    // it was stopped for taking too long
	| 'resource'   // the database ran out of memory, a quota, a lock table
	| 'refused'    // the host's read check would not send it
	| 'too-costly' // the host would not scan a table that large
	| 'failed';    // anything else

/** A failed probe's full error, for the host's own screen. Never rendered into the comment. */
export interface LocalProbeError {
	/** What the probe was asking, as in the gap (markdown with names in code spans). */
	about: string;
	/** The error exactly as the host reported it. */
	error: string;
}

/** Everything the reviewer is given. `schema` and `probeResults` are the optional live half. */
export interface ReviewInput {
	/** The unified diff of the pull request. */
	diff: string;
	/** Full new content of changed files, keyed by repo-relative path. Optional: without it the
	 *  reviewer works from the diff's added lines alone, which can clip a statement that spans
	 *  unchanged context. Hosts that can fetch file content should. */
	files?: Record<string, string>;
	/** Driver id of the destination — `postgres`, `mysql-aurora`, `sqlserver`, … Decides dialect
	 *  rules. Defaults to a permissive generic dialect when unknown. */
	driverId?: string;
	/** The destination's schema, when the caller has one. */
	schema?: DatabaseSchema;
	/** A name for the destination the reader will recognise, quoted in evidence. */
	destinationName?: string;
	/** Results for the probes a previous `planProbes` call emitted. */
	probeResults?: ProbeResult[];
	/** Epoch ms; injected so reports are reproducible in tests. */
	now?: number;
}

export interface ReviewReport {
	depth: ReviewDepth;
	findings: ReviewFinding[];
	/** Files the reviewer looked at. */
	files: string[];
	/** Statements it reviewed (touched ones only). */
	statementCount: number;
	/** Things it could not answer, and why — a skipped probe, an unfetchable file, an unknown
	 *  table. Printed in the comment: a reviewer that hides its blind spots is worse than none. */
	gaps: string[];
	destinationName?: string;
	/** When the schema it reasoned over was introspected (epoch ms). */
	schemaFetchedAt?: number;
	/** Probes that ran and came back clean. Counted, never printed one by one: "I checked and
	 *  it is fine" on every statement is how a reviewer teaches people to skim past it. */
	checksPassed: number;
	/** A sentence for each size cap the pull request hit (`limits.ts`), shown above the
	 *  findings: what was not reviewed, and why. Absent when everything was read. */
	limits?: string[];
	/** The database's own error for each probe that failed, kept for the HOST'S screen only:
	 *  `renderComment` never prints it, because the text echoes names the pull request chose and
	 *  can carry hosts, roles and values. The comment has the fixed reason in `gaps`. */
	localErrors?: LocalProbeError[];
}

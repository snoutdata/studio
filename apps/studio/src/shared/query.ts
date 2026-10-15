/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Query-execution contracts shared by the extension host (client) and the language
// server (ROADMAP phase b). Pure types only — no runtime dependencies. Rows are
// positional value arrays (the driver runs mysql2 with `rowsAsArray`), so the wire
// payload stays compact and the grid maps fields → columns by index.

export interface QueryField {
	name: string;
	dataType?: string;
}

export interface QueryResult {
	fields: QueryField[];
	/** Row-major values, one inner array per row, aligned to {@link fields} by index. */
	rows: unknown[][];
	rowCount: number;
	durationMs: number;
	/**
	 * What the backend reports about the WORK this query did, where it reports anything.
	 *
	 * Optional and additive: every relational driver leaves it out and nothing depends on it. It
	 * exists because on a metered backend the honest thing to show under a result is not only how
	 * long it took but what it cost — CloudWatch Logs Insights bills per GB SCANNED, so a query
	 * that returns four rows can still be expensive, and a footer that says "4 rows in 3s" while
	 * hiding "1.4 GB scanned" is telling half the truth.
	 */
	cost?: QueryCost;
}

/** How far a running query has got, read from the server while it runs (ClickHouse's
 *  `system.processes`). Every field is optional: a server reports what it knows. */
export interface QueryProgress {
	/** Rows and bytes read so far. */
	rowsRead?: number;
	bytesRead?: number;
	/** The server's estimate of the rows it will read in all, when it has one. */
	totalRowsEstimate?: number;
	/** Memory the query holds now, and the most it has held. */
	memoryBytes?: number;
	peakMemoryBytes?: number;
}

/** What a query cost, in whatever terms its backend measures. Every field is optional because
 *  every backend reports a different subset, and none of them reports all of it. */
export interface QueryCost {
	/** Which engine ran it, where a backend has more than one — on CloudWatch the difference
	 *  between a free scan and a billed Logs Insights query. */
	engine?: string;
	/** Bytes the service scanned to answer. The billable unit on metered log services. */
	bytesScanned?: number;
	/** Records it read, and how many of those matched. */
	recordsScanned?: number;
	recordsMatched?: number;
	/** True when the answer covers a PREFIX of what was asked for rather than all of it, because a
	 *  cap was reached. A result that says so is honest; one that does not is wrong. */
	truncated?: boolean;
	/**
	 * The time range the backend actually searched, on a backend whose every query is bounded.
	 *
	 * A log query has no unbounded form, so "no rows" is never the whole answer: the reader has to
	 * know WHEN was looked at. Reported in ms since the epoch.
	 */
	window?: { start: number; end: number };
	/**
	 * False when {@link window} came from the app's default rather than from the statement.
	 *
	 * The difference between "there are no such events" and "there are none in the last hour",
	 * which is the difference between a working feature and a broken-looking one.
	 */
	windowFromSql?: boolean;
	/**
	 * The log scope (a CloudWatch log group, an Azure table, a GCP log) the rows came from, on a
	 * telemetry backend. What the log reader needs to fetch the events AROUND one it is showing,
	 * which a result's columns cannot say: a scope is the table, not a value in a row.
	 */
	scope?: string;
	/**
	 * True when a row is a GROUP rather than one record — the result of a `GROUP BY`.
	 *
	 * The results pane picks its instrument with this. A log reader is a stream of events, so a
	 * grouped log result belongs in the grid even when it projects a column the reader recognises,
	 * and only the thing that ran the query knows which it was.
	 */
	grouped?: boolean;
}

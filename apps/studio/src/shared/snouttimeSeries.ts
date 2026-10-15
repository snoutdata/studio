/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// "Make this a series table" in the table designer.
//
// A SnoutTime series is an ordinary Postgres table handed to `snouttime.create_series`, which
// turns it into a table partitioned by time and keeps partitions made ahead of the data. So the
// designer writes the same CREATE TABLE it always does and then the calls below: nothing about
// the columns changes, and an existing table can be made a series the same way (its rows sit in
// the default partition until SnoutTime's worker moves them into place).
//
// Pure: what the designer shows as problems and what it runs are both decided here, and tested.

/** What the designer asks for. Every field is text as typed; empty means "not set". */
export interface SeriesDraft {
	/** The column the table is partitioned by. */
	timeColumn: string;
	/** How much time one partition holds: `1 day`, or an integer width for an integer column. */
	interval: string;
	/** How long rows are kept; empty keeps them forever. */
	retention: string;
	/** How long after a partition's range ends it is sealed into the column store; empty never. */
	sealAfter: string;
}

export function blankSeriesDraft(timeColumn = ''): SeriesDraft {
	return { timeColumn, interval: '1 day', retention: '', sealAfter: '1 day' };
}

/** A column as the designer holds it: only what these rules read. */
export interface SeriesColumn {
	name: string;
	dataType: string;
	nullable: boolean;
	isPrimaryKey: boolean;
}

const TIME_TYPE = /^(timestamptz|timestamp( without time zone| with time zone)?|timestamp\(\d\)( with(out)? time zone)?|date)$/i;
const INTEGER_TYPE = /^(smallint|integer|int|int2|int4|int8|bigint)$/i;

/** Whether a column's type can be a series' time column, and whether it is an integer one
 *  (which is partitioned by a width, not an interval). */
export function timeKind(dataType: string): 'time' | 'integer' | undefined {
	const t = dataType.trim();
	return TIME_TYPE.test(t) ? 'time' : INTEGER_TYPE.test(t) ? 'integer' : undefined;
}

/** The columns a series could be partitioned by, timestamps first. */
export function timeColumnCandidates(columns: SeriesColumn[]): string[] {
	const named = columns.filter((c) => c.name.trim() !== '');
	return [
		...named.filter((c) => timeKind(c.dataType) === 'time'),
		...named.filter((c) => timeKind(c.dataType) === 'integer'),
	].map((c) => c.name);
}

const INTERVAL = /^\s*\d+(\.\d+)?\s*(microseconds?|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|days?|weeks?|months?|mons?|years?)\s*$/i;
const WIDTH = /^\s*[1-9]\d*\s*$/;

/**
 * What stops these settings from working, in the words the designer shows. Empty when they will.
 * The two a first series table always trips on are here because SnoutTime refuses them at
 * create time with a less helpful sentence: the time column must be NOT NULL, and a primary key
 * (a unique index) must include it, since Postgres enforces uniqueness per partition only.
 */
export function seriesProblems(draft: SeriesDraft, columns: SeriesColumn[]): string[] {
	const problems: string[] = [];
	const column = columns.find((c) => c.name === draft.timeColumn);
	if (!draft.timeColumn.trim() || !column) {
		return ['Choose the column the table is partitioned by: a timestamp, a date, or an integer.'];
	}
	const kind = timeKind(column.dataType);
	if (!kind) {
		problems.push(`${column.name} is ${column.dataType}; a series is partitioned by a timestamp, a date or an integer column.`);
		return problems;
	}
	if (column.nullable) {
		problems.push(`${column.name} must not allow NULL: every row needs a time to find its partition.`);
	}
	const key = columns.filter((c) => c.isPrimaryKey);
	if (key.length > 0 && !column.isPrimaryKey) {
		problems.push(`The primary key must include ${column.name}: Postgres can only check uniqueness within one partition.`);
	}
	const valid = kind === 'integer' ? WIDTH : INTERVAL;
	const example = kind === 'integer' ? 'a whole number such as 100000' : 'an interval such as 1 day';
	if (!valid.test(draft.interval)) {
		problems.push(`Partition size must be ${example}.`);
	}
	if (draft.retention.trim() && !valid.test(draft.retention)) {
		problems.push(`Keep rows for must be ${example}, or empty to keep everything.`);
	}
	if (draft.sealAfter.trim() && !(kind === 'integer' ? /^\s*\d+\s*$/ : INTERVAL).test(draft.sealAfter)) {
		problems.push(`Seal after must be ${kind === 'integer' ? 'a whole number' : 'an interval such as 1 day'}, or empty to never seal.`);
	}
	return problems;
}

function literal(text: string): string {
	return `'${text.replace(/'/g, "''")}'`;
}

/**
 * The calls that make `relation` (already quoted and qualified, as the CREATE TABLE wrote it) a
 * series with these settings. The caller has checked {@link seriesProblems}.
 */
export function seriesStatements(draft: SeriesDraft, relation: string, dataType: string): string[] {
	const integer = timeKind(dataType) === 'integer';
	const rel = literal(relation);
	// A whole number is written as one; anything else stays inside a literal (Postgres refuses the
	// cast), so a size the caller did not check can never end the statement.
	const size = (v: string): string => (integer ? `${/^\d+$/.test(v.trim()) ? v.trim() : literal(v.trim())}::bigint` : `interval ${literal(v.trim())}`);
	const statements = [
		`SELECT snouttime.create_series(${rel}, ${literal(draft.timeColumn)}, ${integer ? 'partition_width' : 'partition_interval'} => ${size(draft.interval)});`,
	];
	if (draft.retention.trim()) {
		statements.push(`SELECT snouttime.set_retention(${rel}, ${size(draft.retention)});`);
	}
	if (draft.sealAfter.trim()) {
		statements.push(`SELECT snouttime.set_sealing(${rel}, ${size(draft.sealAfter)});`);
	}
	return statements;
}

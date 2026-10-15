/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The telemetry (cloud logs) QueryLanguageProfile.
 *
 *  The authoring surface for a log scope is SQL, and that is the whole point of the feature: a log
 *  group is presented as a table so the editor, the completion, the grid, the history and the
 *  assistant all work on it unchanged. So `monacoLanguage` is `'sql'` here, unlike the document and
 *  vector profiles, which author JSON. The provider's OWN language (Logs Insights, KQL, a Cloud
 *  Logging filter) is the native ESCAPE HATCH — `{ lang: 'logs-native' }` — not the default.
 *
 *  Nothing in a telemetry query mutates: these services have no write path we expose and none is
 *  planned, so `isDestructive` is a constant rather than a check, and the prod guard, the read-only
 *  flag and the grid's edit affordances all follow from it.
 *--------------------------------------------------------------------------------------------*/

import { LOG_COLUMNS, LOG_FIELDS } from '../../compile/logs';
import { findAtDepth, maskSql } from '../../parse/mask';
import type { NativeQuery } from '../../compile/native';
import type { BrowsePage, BrowseTarget, QueryLanguageProfile } from './index';
import { referencedTables } from './sql';

/** How far back a browse ("show me this log group") looks. The same hour the compiler defaults an
 *  unbounded statement to, so double-clicking a scope and typing `SELECT * FROM` it agree. */
export const BROWSE_WINDOW_MS = 60 * 60 * 1000;

export const LOGS_PROFILE: QueryLanguageProfile = {
	kind: 'telemetry',
	monacoLanguage: 'sql',
	fenceId: 'sql',
	aiDisplayName: () => 'SQL over cloud logs',
	// A log service is read-only here: there is no statement this app can send that changes
	// anything, so this is a constant and not an inspection.
	isDestructive: () => false,
	// Scopes are addressed exactly as tables are (`FROM "/aws/lambda/api"`), so the SQL FROM/JOIN
	// heuristic is the right one for schema-relevance ranking.
	referencedEntities: (input) => referencedTables(input),
	/**
	 * The first page of a scope: the newest events in the last hour.
	 *
	 * `page.offset` is deliberately NOT honoured, and that is not an oversight. A log stream has no
	 * stable numeric offset — events arrive out of order and are back-filled, so "rows 100-150" is
	 * a different set each time it is asked for. Paging a scope means moving the WINDOW, which is
	 * why `windowQuery` returns null for `logs` and the grid never offers a next page it cannot
	 * honestly fetch.
	 */
	browse: (target: BrowseTarget, page: BrowsePage): NativeQuery => {
		const end = Date.now();
		return {
			lang: 'logs',
			query: {
				scope: target.name,
				start: end - BROWSE_WINDOW_MS,
				end,
				select: [...LOG_COLUMNS],
				orderBy: [{ field: LOG_FIELDS.ts, desc: true }],
				limit: page.limit,
			},
		};
	},
};

/*---------------------------------------------------------------------------------------------
 *  The time bound, as SQL the user can see and edit.
 *
 *  A log window has to come from somewhere, and for a statement that names no time range the
 *  compiler invents one (DEFAULT_LOG_WINDOW_MS). The results footer then offers to widen it, and
 *  the honest way to do that is to WRITE the wider range into the statement rather than re-running
 *  the same text against a window held somewhere the user cannot see: a run whose range lives off
 *  the screen is a result nobody can reproduce by reading their own SQL.
 *
 *  So `ts >= ago('6h')` is the one rewrite, and it is deliberately the narrowest one that works:
 *  it bounds the START and leaves the END alone, which is what makes "last 6 hours" mean the six
 *  hours before THIS run rather than the six before the last one.
 *--------------------------------------------------------------------------------------------*/

/** Clauses that may follow a WHERE. An inserted bound goes before the first of them, or at the end
 *  of the statement when there is none. `minus` is Oracle's `except`, `qualify` Snowflake's. */
const TAIL_CLAUSE = /\b(?:group|having|window|qualify|order|limit|offset|fetch|union|intersect|except|minus)\b/i;

/** The bound {@link withLogTimeBound} writes, and the only shape it will rewrite in place. Matched
 *  against the MASKED text, where the duration literal has been blanked out, which is also what
 *  makes it decline `ago(3600000)`: a bound written by hand rather than by this module. */
const WRITTEN_BOUND = new RegExp(String.raw`\b${LOG_FIELDS.ts}\s*>=\s*ago\(\s*\)`, 'i');

/** Any mention of the time field at all, so a bound somebody else wrote is left alone rather than
 *  quietly ANDed with a second one. */
const ANY_TIME_FIELD = new RegExp(String.raw`\b${LOG_FIELDS.ts}\b`, 'i');

/** A span as `ago()` spells it: whole days, then whole hours, then minutes, so seven days reads
 *  `'7d'` and not `'168h'`. */
function durationLiteral(ms: number): string | null {
	if (!Number.isFinite(ms) || ms <= 0) {
		return null;
	}
	for (const [size, suffix] of [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'm']] as const) {
		if (ms % size === 0) {
			return `${ms / size}${suffix}`;
		}
	}
	return `${Math.round(ms / 60_000)}m`;
}

/**
 * The same statement, bounded to the last `ms` — `… WHERE ts >= ago('6h')`.
 *
 * Returns null when the rewrite cannot be made SAFELY, which is the caller's signal to leave the
 * statement alone: anything that is not a single SELECT, and any statement already carrying a time
 * bound this module did not write (an absolute timestamp, a BETWEEN, an upper bound). Widening
 * somebody else's window by editing around it is how a control silently changes what a query means.
 */
export function withLogTimeBound(sql: string, ms: number): string | null {
	const duration = durationLiteral(ms);
	if (duration === null) {
		return null;
	}
	const trimmed = sql.trim();
	const semicolon = trimmed.endsWith(';');
	const statement = semicolon ? trimmed.slice(0, -1).trimEnd() : trimmed;
	// Masking blanks literals, quoted identifiers and comments with the offsets preserved, so a
	// `where` inside a string or a trailing `-- note` cannot be read as a clause of the statement.
	const masked = maskSql(statement);
	if (!/^\s*select\b/i.test(masked.text) || masked.text.includes(';')) {
		return null;
	}
	// A comment is blanked by the mask, so an inserted clause could land inside one and be
	// swallowed ("… limit 10 -- note" + " and ts >= …" is a comment, not a predicate). Rather than
	// teach the splice to see through comments, refuse the statement: the control then stays
	// read-only, which is the safe direction. A literal holding `--` is refused with them.
	for (let i = 0; i < statement.length - 1; i++) {
		if (masked.text[i] === ' ' && statement[i] !== ' ' && (statement.startsWith('--', i) || statement.startsWith('/*', i))) {
			return null;
		}
	}
	const uppercase = /^\s*SELECT\b/.test(masked.text);
	const keyword = (word: string): string => (uppercase ? word.toUpperCase() : word);
	const bound = `${LOG_FIELDS.ts} >= ago('${duration}')`;
	const whereAt = findAtDepth(masked, /\bwhere\b/i, 0, statement.length, 0);
	const predicateAt = whereAt >= 0 ? whereAt + 'where'.length : 0;
	const tailAt = findAtDepth(masked, TAIL_CLAUSE, predicateAt, statement.length, 0);
	const tail = tailAt >= 0 ? tailAt : statement.length;
	const finish = (text: string): string => (semicolon ? `${text};` : text);
	if (whereAt < 0) {
		return finish(splice(statement, tail, `${keyword('where')} ${bound}`));
	}
	const predicate = masked.text.slice(predicateAt, tail);
	if (predicate.trim() === '') {
		return null;
	}
	const existing = WRITTEN_BOUND.exec(predicate);
	if (existing) {
		const at = predicateAt + existing.index;
		return finish(statement.slice(0, at) + bound + statement.slice(at + existing[0].length));
	}
	if (ANY_TIME_FIELD.test(predicate)) {
		return null;
	}
	return finish(splice(statement, tail, `${keyword('and')} ${bound}`));
}

/** Put `clause` into `statement` at `at`, on one space either side of whatever it lands between. */
function splice(statement: string, at: number, clause: string): string {
	const head = statement.slice(0, at).trimEnd();
	const rest = statement.slice(at).trim();
	return rest === '' ? `${head} ${clause}` : `${head} ${clause} ${rest}`;
}

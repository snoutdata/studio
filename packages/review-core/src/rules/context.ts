/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  What a rule is handed, and how a finding is made.
 *
 *  Every rule is a pure function of this context. Nothing a rule needs is fetched — it is all
 *  here or it is absent, and absent means the rule stays quiet and the report records a gap.
 *--------------------------------------------------------------------------------------------*/

import type { ReviewDialect } from '../dialect.js';
import { maskSql } from '../sql/mask.js';
import type { ParsedStatement } from '../sql/parse.js';
import type { DatabaseSchema, TableInfo } from '../schema.js';
import { findTable } from '../schema.js';
import type { Evidence, ProbeResult, ReviewFinding, ReviewFindingKind, ReviewSeverity, ReviewStatement } from '../types.js';

/**
 * Objects this pull request creates BEFORE the statement under review.
 *
 * Without it every migration reads as broken: a file that creates `orders` and then alters it
 * would report "table orders does not exist", because the destination has not run the file
 * yet. The reviewer replays the PR's own effects as it goes.
 */
export interface PendingSchema {
	/** Lower-cased bare names of tables the PR creates. */
	createdTables: Set<string>;
	/** Lower-cased bare names of tables the PR drops. */
	droppedTables: Set<string>;
	/** `table.column`, lower-cased, for columns the PR adds. */
	addedColumns: Set<string>;
	/** `table.column`, lower-cased, for columns the PR drops. */
	droppedColumns: Set<string>;
	/** Lower-cased index names the PR creates. */
	createdIndexes: Set<string>;
	/** Lower-cased index names the PR drops. */
	droppedIndexes: Set<string>;
	/** `table.column`, lower-cased, for every column the PR puts at the FRONT of a new index —
	 *  the only position that makes it usable for a lookup. This is what lets the reviewer ask
	 *  the question that matters on a large table: you added this column, and you query it, so
	 *  did you index it anywhere in this pull request? */
	indexedColumns: Set<string>;
	/** `table.column` for columns the PR filters, joins or orders on in a query. */
	queriedColumns: Set<string>;
}

export function emptyPendingSchema(): PendingSchema {
	return {
		createdTables: new Set(),
		droppedTables: new Set(),
		addedColumns: new Set(),
		droppedColumns: new Set(),
		createdIndexes: new Set(),
		droppedIndexes: new Set(),
		indexedColumns: new Set(),
		queriedColumns: new Set(),
	};
}

export interface RuleContext {
	statement: ReviewStatement;
	parsed: ParsedStatement;
	dialect: ReviewDialect;
	schema?: DatabaseSchema;
	/** What the PR has already done to the schema by the time this statement runs. Used to
	 *  answer "does this exist yet", which depends on statement ORDER. */
	pending: PendingSchema;
	/**
	 * Everything the pull request does, computed before the walk starts.
	 *
	 * Order matters for "does it exist yet" and must NOT matter for "did the author think of
	 * it". An index created in the last file of the PR still covers a column added in the
	 * first, and a reviewer that says otherwise because it read them in order is wrong in the
	 * way that gets it switched off.
	 */
	pr: PendingSchema;
	/** A name for the destination the reader recognises — quoted in every measurement. */
	destinationName?: string;
	/** Probe results, by probe id. */
	probes: Map<string, ProbeResult>;
	/** Statements in the same file, for rules that need the file's shape (a transaction). */
	fileStatements: ParsedStatement[];
	now: number;
}

/** Lower-cased last segment of a possibly-qualified name. */
export function bare(name: string | undefined): string {
	if (!name) {
		return '';
	}
	const dot = name.lastIndexOf('.');
	return (dot === -1 ? name : name.slice(dot + 1)).toLowerCase();
}

/** The destination's table, EXCLUDING one the PR itself created (which is not there yet). */
export function destinationTable(ctx: RuleContext, name: string | undefined): TableInfo | undefined {
	if (!name || ctx.pending.createdTables.has(bare(name))) {
		return undefined;
	}
	return findTable(ctx.schema, name);
}

/** True when the object exists on the destination or the PR has created it by now. */
export function existsByNow(ctx: RuleContext, table: string | undefined): boolean {
	const key = bare(table);
	if (key === '') {
		return false;
	}
	if (ctx.pending.droppedTables.has(key)) {
		return false;
	}
	return ctx.pending.createdTables.has(key) || !!findTable(ctx.schema, table!);
}

export interface FindingDraft {
	kind: ReviewFindingKind;
	severity: ReviewSeverity;
	title: string;
	detail: string;
	suggestedSql?: string;
	evidence?: Evidence;
	/** Distinguishes two findings of the same kind on the same statement (one per column). */
	subject?: string;
}

/** A short, stable id: same finding on the same statement keeps it across pushes, which is
 *  what lets the comment say "2 fixed since your last push" and `ignore <id>` mean something. */
function findingId(ctx: RuleContext, draft: FindingDraft): string {
	const key = `${draft.kind}|${ctx.statement.file}|${draft.subject ?? ctx.parsed.object ?? ''}|${draft.title}`;
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		hash = (hash * 31 + key.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36).slice(0, 6);
}

/** Build a finding from the context. Statement text is trimmed to one readable excerpt. */
export function finding(ctx: RuleContext, draft: FindingDraft): ReviewFinding {
	return {
		kind: draft.kind,
		severity: draft.severity,
		title: draft.title,
		detail: draft.detail,
		file: ctx.statement.file,
		line: ctx.statement.line,
		statement: excerpt(ctx.statement.sql),
		suggestedSql: draft.suggestedSql,
		evidence: draft.evidence,
		id: findingId(ctx, draft),
	};
}

/**
 * One statement, shortened for a comment: collapse whitespace, cap the length.
 *
 * Two things it must not do, both found the first time a real migration was reviewed.
 *
 * It must not fold a `--` comment into the line after it. A line comment ends at the newline,
 * so flattening `-- every order ships now
ALTER TABLE …` onto one line puts the ALTER *inside*
 * the comment: the block reads as if nothing happens, and anybody who copies it runs nothing.
 * So a statement carrying a line comment keeps its lines.
 *
 * And it must not open with the author's note. `splitStatements` starts a statement at the
 * comments above it, because that is what decides its line number, but those lines are prose
 * about the change and not the statement the finding is about.
 */
export function excerpt(sql: string, max = 240): string {
	const NL = String.fromCharCode(10);
	const lines = sql.split(NL);
	// Masking blanks comments and literals to spaces and keeps newlines, so a masked line that is
	// entirely blank held no SQL, and a `--` at a blanked offset is a real comment rather than
	// two characters inside a string.
	const masked = maskSql(sql).text.split(NL);
	let start = 0;
	while (start < lines.length && (masked[start] ?? '').trim() === '') {
		start++;
	}
	const kept = lines.slice(start);
	const keptMasked = masked.slice(start);
	const commented = kept.some((line, i) => {
		const m = keptMasked[i] ?? '';
		for (let j = 0; j + 1 < line.length; j++) {
			if (line[j] === '-' && line[j + 1] === '-' && m[j] === ' ' && m[j + 1] === ' ') {
				return true;
			}
		}
		return false;
	});
	const text = commented
		? kept.map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line !== '').join(NL)
		: kept.join(' ').replace(/\s+/g, ' ').trim();
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A measurement plus where it came from. Never build evidence without both. */
export function evidence(ctx: RuleContext, measured: string, sql?: string): Evidence {
	return {
		measured,
		source: ctx.destinationName ?? ctx.schema?.database ?? 'the destination',
		at: ctx.now,
		sql,
	};
}

/** Format a row count the way a person says it. */
export function rows(n: number): string {
	if (n >= 1_000_000_000) {
		return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B rows`;
	}
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M rows`;
	}
	if (n >= 1_000) {
		return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k rows`;
	}
	return n === 1 ? '1 row' : `${n} rows`;
}

/** Record what a statement does to the schema, so later statements see it. */
export function applyToPending(parsed: ParsedStatement, pending: PendingSchema): void {
	const table = bare(parsed.object);
	switch (parsed.kind) {
		case 'createTable':
			pending.createdTables.add(table);
			pending.droppedTables.delete(table);
			for (const column of parsed.columns ?? []) {
				pending.addedColumns.add(`${table}.${column.name.toLowerCase()}`);
			}
			break;
		case 'dropTable':
			pending.droppedTables.add(table);
			pending.createdTables.delete(table);
			break;
		case 'createIndex': {
			if (parsed.object) {
				pending.createdIndexes.add(bare(parsed.object));
			}
			const onTable = bare(parsed.onTable);
			const leading = parsed.indexColumns?.[0];
			if (onTable !== '' && leading) {
				pending.indexedColumns.add(`${onTable}.${leading.toLowerCase()}`);
			}
			break;
		}
		case 'dropIndex':
			if (parsed.object) {
				pending.droppedIndexes.add(bare(parsed.object));
			}
			break;
		case 'alterTable':
		case 'renameTable':
			for (const action of parsed.actions ?? []) {
				if (action.type === 'addColumn') {
					pending.addedColumns.add(`${table}.${action.column.name.toLowerCase()}`);
					pending.droppedColumns.delete(`${table}.${action.column.name.toLowerCase()}`);
				} else if (action.type === 'dropColumn') {
					pending.droppedColumns.add(`${table}.${action.column.toLowerCase()}`);
				} else if (action.type === 'renameTable') {
					pending.createdTables.add(bare(action.to));
					pending.droppedTables.add(table);
				} else if (action.type === 'addUnique' || action.type === 'addPrimaryKey') {
					// A unique constraint and a primary key are backed by an index; a foreign
					// key is NOT, on the referencing side, and assuming otherwise is the most
					// common reason a child table ends up with no usable index.
					const leading = action.columns[0];
					if (leading) {
						pending.indexedColumns.add(`${table}.${leading.toLowerCase()}`);
					}
				}
			}
			break;
		case 'select':
		case 'update':
		case 'delete':
			for (const predicate of parsed.predicates ?? []) {
				if (predicate.table) {
					pending.queriedColumns.add(`${bare(predicate.table)}.${predicate.column.toLowerCase()}`);
				}
			}
			break;
		default:
			break;
	}
}

/** Everything a pull request does, order-independent — see `RuleContext.pr`. */
export function summarisePullRequest(statements: ParsedStatement[]): PendingSchema {
	const summary = emptyPendingSchema();
	for (const parsed of statements) {
		applyToPending(parsed, summary);
	}
	return summary;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Changing a table that is already large and already in use.
 *
 *  The rules in `schema.ts` mostly answer "will this statement succeed". These answer a
 *  different question, and it is the one that actually takes production down:
 *
 *      the statement will succeed, and it will hold a lock on a billion rows while it does.
 *
 *  Nobody writes `ALTER TABLE events ADD COLUMN updated_at TIMESTAMP DEFAULT now()` expecting
 *  an outage. It reads like the smallest change in the pull request. On a large table, on the
 *  wrong vendor and version, it rewrites every row before it lets anybody else write — and the
 *  review that could have said so is the entire reason this product exists.
 *
 *  These rules only fire when the destination says the table is actually big. A lock warning on
 *  a table with four hundred rows is noise, and noise is how a reviewer gets muted.
 *--------------------------------------------------------------------------------------------*/

import { findColumn, hasLeadingIndex } from '../schema.js';
import { codeSpan } from '../markdown.js';
import type { TableInfo } from '../schema.js';
import { notNullTarget } from '../sql/parse.js';
import type { DeclaredColumn } from '../sql/parse.js';
import type { ReviewFinding } from '../types.js';
import { bare, destinationTable, evidence, finding, rows } from './context.js';
import type { RuleContext } from './context.js';
import { BIG_TABLE_ROWS, HUGE_TABLE_ROWS } from './schema.js';

/**
 * Defaults that are computed per row rather than stored once.
 *
 * This is the distinction that decides whether `ADD COLUMN … DEFAULT x` is instant or a full
 * rewrite on Postgres 11+ and MySQL 8: a CONSTANT default is recorded in the catalog and costs
 * nothing, while a VOLATILE one has to be evaluated for every existing row, because every row
 * is entitled to a different answer. `DEFAULT 0` is free. `DEFAULT now()` is not.
 */
const VOLATILE_DEFAULT = /\b(now|current_timestamp|current_date|current_time|localtime|localtimestamp|getdate|sysdate|uuid|uuid_generate_v4|gen_random_uuid|newid|newsequentialid|random|rand|nextval)\b|\bcurrent_timestamp\b/i;

function isVolatile(column: DeclaredColumn): boolean {
	return column.hasDefault && !!column.defaultExpr && VOLATILE_DEFAULT.test(column.defaultExpr);
}

function size(table: TableInfo | undefined): number | undefined {
	return table?.stats?.rowCount;
}

/**
 * A column added to a large table with a default that has to be computed per row.
 *
 * Separate from the plain "adding a column with a default rewrites the table" warning in
 * `schema.ts`, because this one is true on EVERY vendor including the ones where the constant
 * case is free — so it is the version of the warning that is never a false alarm.
 */
function volatileDefaultRewrite(ctx: RuleContext): ReviewFinding[] {
	const table = destinationTable(ctx, ctx.parsed.object);
	const count = size(table);
	if (!table || count === undefined || count < BIG_TABLE_ROWS) {
		return [];
	}
	const out: ReviewFinding[] = [];
	for (const action of ctx.parsed.actions ?? []) {
		if (action.type !== 'addColumn' || !isVolatile(action.column)) {
			continue;
		}
		const huge = count >= HUGE_TABLE_ROWS;
		out.push(finding(ctx, {
			kind: 'lock-risk',
			severity: huge ? 'blocker' : 'warn',
			subject: action.column.name,
			title: `${codeSpan(action.column.name)} has a per-row default, so adding it writes ${rows(count)}`,
			detail: `${codeSpan(action.column.defaultExpr)} is evaluated separately for every existing row, so the vendor cannot record it once in the catalog the way it does a constant default. That means a full table rewrite holding a lock, on ${rows(count)}${table.stats?.engine ? ` (${table.stats.engine})` : ''}. This is the change that reads like the smallest one in the pull request and is the one that causes the outage.\n\nAdd the column with no default, backfill in batches, then set the default for new rows.`,
			suggestedSql: [
				`ALTER TABLE ${ctx.parsed.object} ADD COLUMN ${action.column.name} ${action.column.dataType};`,
				`-- backfill in batches, outside a single transaction`,
				`ALTER TABLE ${ctx.parsed.object} ALTER COLUMN ${action.column.name} SET DEFAULT ${action.column.defaultExpr};`,
			].join('\n'),
			evidence: evidence(ctx, `${codeSpan(table.name)} holds ${rows(count)}`),
		}));
	}
	return out;
}

/** MySQL's `ON UPDATE CURRENT_TIMESTAMP` on a big table — the same cost, written differently. */
function onUpdateTimestamp(ctx: RuleContext): ReviewFinding[] {
	if (!/\bon\s+update\s+current_timestamp\b/i.test(ctx.statement.sql)) {
		return [];
	}
	const table = destinationTable(ctx, ctx.parsed.object);
	const count = size(table);
	if (!table || count === undefined || count < BIG_TABLE_ROWS) {
		return [];
	}
	return [finding(ctx, {
		kind: 'lock-risk',
		severity: 'warn',
		subject: 'on-update-timestamp',
		title: `\`ON UPDATE CURRENT_TIMESTAMP\` on a table of ${rows(count)}`,
		detail: 'Beyond the cost of adding the column, every future UPDATE to any column of this table now also writes this one. On a hot table that is extra write amplification and extra replication traffic on every statement, forever, not just during the migration.',
		evidence: evidence(ctx, `${codeSpan(table.name)} holds ${rows(count)}`),
	})];
}

/**
 * The column this pull request adds, and then queries, and never indexes.
 *
 * This is the rule that only a reviewer looking at the WHOLE change can produce. The migration
 * is fine on its own and the query is fine on its own; the defect is the pair of them, and it
 * does not show up until the table is large and the feature is live.
 *
 * It reads the PR's full effect set rather than the ordered one, because an index created in
 * the last file still covers a column added in the first.
 */
function addedThenQueriedUnindexed(ctx: RuleContext): ReviewFinding[] {
	if (ctx.parsed.kind !== 'alterTable' && ctx.parsed.kind !== 'createTable') {
		return [];
	}
	const table = destinationTable(ctx, ctx.parsed.object);
	const count = size(table);
	// A new table has no size yet, and a small one does not care. Only an existing, large
	// table turns this from a style note into a real one.
	if (!table || count === undefined || count < BIG_TABLE_ROWS) {
		return [];
	}
	const tableKey = bare(ctx.parsed.object);
	const out: ReviewFinding[] = [];

	for (const action of ctx.parsed.actions ?? []) {
		if (action.type !== 'addColumn') {
			continue;
		}
		const key = `${tableKey}.${action.column.name.toLowerCase()}`;
		if (!ctx.pr.queriedColumns.has(key)) {
			continue; // added but not queried in this PR — nothing to say yet
		}
		if (ctx.pr.indexedColumns.has(key) || action.column.primaryKey || action.column.unique) {
			continue; // the author did think of it
		}
		if (hasLeadingIndex(table, [action.column.name])) {
			continue;
		}
		out.push(finding(ctx, {
			kind: 'missing-index',
			severity: 'warn',
			subject: key,
			title: `${codeSpan(action.column.name)} is added and then queried, with no index anywhere in this pull request`,
			detail: `This pull request adds ${codeSpan(`${ctx.parsed.object}.${action.column.name}`)} and filters or joins on it, and nothing in the change indexes it. On ${rows(count)} that query is a full scan from the day it ships, and it gets slower from there. If the column is only ever read alongside an existing index, ignore this; if it is a lookup, it wants its own index in this same pull request.`,
			suggestedSql: `CREATE INDEX idx_${tableKey.replace(/\W/g, '_')}_${action.column.name.toLowerCase()} ON ${ctx.parsed.object} (${action.column.name});`,
			evidence: evidence(ctx, `${codeSpan(table.name)} holds ${rows(count)} and has no index leading with ${codeSpan(action.column.name)}`),
		}));
	}
	return out;
}

/**
 * Dropping an index a query in this same pull request depends on, or that the destination
 * shows is the only one serving a column.
 */
function droppingTheOnlyIndex(ctx: RuleContext): ReviewFinding[] {
	if (ctx.parsed.kind !== 'dropIndex' || !ctx.schema) {
		return [];
	}
	const name = bare(ctx.parsed.object);
	const owner = ctx.schema.tables.find((t) => (t.indexes ?? []).some((i) => i.name.toLowerCase() === name));
	const index = owner?.indexes?.find((i) => i.name.toLowerCase() === name);
	if (!owner || !index) {
		return [];
	}
	const count = size(owner);
	const leading = index.columns[0];
	const others = (owner.indexes ?? []).filter(
		(i) => i.name.toLowerCase() !== name && i.columns[0]?.toLowerCase() === leading?.toLowerCase(),
	);
	if (others.length > 0) {
		return []; // another index leads with the same column, so the lookups survive
	}
	const queried = ctx.pr.queriedColumns.has(`${owner.name.toLowerCase()}.${leading?.toLowerCase()}`);
	return [finding(ctx, {
		kind: 'missing-index',
		severity: count !== undefined && count >= BIG_TABLE_ROWS ? 'warn' : 'note',
		subject: `drop-index:${name}`,
		title: `Dropping ${codeSpan(index.name)} leaves ${codeSpan(`${owner.name}.${leading}`)} with no index`,
		detail: `It is the only index on the destination leading with ${codeSpan(leading)}${queried ? ', and this pull request still queries that column' : ''}. Anything filtering or joining on it goes back to a scan${count !== undefined ? ` of ${rows(count)}` : ''}. Dropping an index is easy to justify from the diff and impossible to justify without knowing what queries it.`,
		evidence: evidence(ctx, `${codeSpan(index.name)} on (${index.columns.join(', ')}) is the only index leading with ${codeSpan(leading)}`),
	})];
}

/** A column changed from nullable to NOT NULL, or given a new default, on a large table. */
function constraintOnLargeTable(ctx: RuleContext): ReviewFinding[] {
	const table = destinationTable(ctx, ctx.parsed.object);
	const count = size(table);
	if (!table || count === undefined || count < HUGE_TABLE_ROWS) {
		return [];
	}
	const out: ReviewFinding[] = [];
	for (const action of ctx.parsed.actions ?? []) {
		if (action.type === 'addCheck') {
			out.push(finding(ctx, {
				kind: 'lock-risk',
				severity: 'warn',
				subject: 'check-constraint',
				title: `Adding a CHECK constraint validates ${rows(count)} before it returns`,
				detail: 'The constraint is checked against every existing row while the table is locked. On a table this size, add it as NOT VALID (or the vendor equivalent) and validate it separately, so the lock is held for the catalog change and not for the scan.',
				evidence: evidence(ctx, `${codeSpan(table.name)} holds ${rows(count)}`),
			}));
		}
		const notNullColumn = notNullTarget(action);
		if (notNullColumn !== undefined && findColumn(table, notNullColumn)?.nullable) {
			out.push(finding(ctx, {
				kind: 'lock-risk',
				severity: 'warn',
				subject: `not-null:${notNullColumn}`,
				title: `Making ${codeSpan(notNullColumn)} NOT NULL scans ${rows(count)} under a lock`,
				detail: 'Even when no row violates it, the vendor has to prove that by reading the table, and it holds an exclusive lock while it does. On a table this size that is measured in minutes, not seconds.',
				evidence: evidence(ctx, `${codeSpan(table.name)} holds ${rows(count)}`),
			}));
		}
	}
	return out;
}

/** Every large-table ALTER rule. All return nothing without a schema that reports a size. */
export function alterFindings(ctx: RuleContext): ReviewFinding[] {
	if (!ctx.schema) {
		return [];
	}
	return [
		...volatileDefaultRewrite(ctx),
		...onUpdateTimestamp(ctx),
		...constraintOnLargeTable(ctx),
		...addedThenQueriedUnindexed(ctx),
		...droppingTheOnlyIndex(ctx),
	];
}

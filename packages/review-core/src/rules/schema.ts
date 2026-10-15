/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The schema-aware tier: everything decidable once we can see the destination.
 *
 *  This is where the reviewer stops giving advice and starts stating facts about a particular
 *  database. Two things make that safe:
 *
 *    - The PR's own effects are replayed as the review walks the file (`ctx.pending`), so a
 *      migration that creates a table and then alters it is not reported as broken.
 *    - Absence of schema means silence. Every rule here returns nothing when `ctx.schema` is
 *      missing; the report says the tier did not run, rather than a rule guessing.
 *--------------------------------------------------------------------------------------------*/

import { allIndexes, coveringIndex, findColumn, findTable, hasLeadingIndex } from '../schema.js';
import { codeSpan } from '../markdown.js';
import type { ColumnInfo, TableInfo } from '../schema.js';
import type { ReviewFinding } from '../types.js';
import { bare, destinationTable, evidence, existsByNow, finding, rows } from './context.js';
import type { RuleContext } from './context.js';

/** Below this, a table scan is not a finding, it is a scan of a small table. Reporting one is
 *  the fastest way to teach a team that this reviewer is noise. */
const SMALL_TABLE_ROWS = 50_000;
/** Above this, an operation that rewrites or locks a table is worth warning about. */
const BIG_TABLE_ROWS = 1_000_000;
/** Above this, even a plain scan in a review-time probe is worth flagging as expensive. */
const HUGE_TABLE_ROWS = 20_000_000;

function tableSize(table: TableInfo | undefined): number | undefined {
	return table?.stats?.rowCount;
}

/** Statements naming a table the destination has never heard of. */
function unknownObject(ctx: RuleContext): ReviewFinding[] {
	const { parsed } = ctx;
	const out: ReviewFinding[] = [];
	const check = (name: string | undefined, what: string): void => {
		if (!name || existsByNow(ctx, name)) {
			return;
		}
		out.push(finding(ctx, {
			kind: 'unknown-object',
			severity: 'blocker',
			subject: name,
			title: `${codeSpan(name)} does not exist on the destination`,
			detail: `This ${what} names a table the destination does not have, and nothing earlier in this pull request creates it. Either a migration is missing from the PR, or the name is wrong.`,
			evidence: evidence(ctx, `no table ${codeSpan(name)} in the introspected schema`),
		}));
	};

	if (parsed.kind === 'alterTable' || parsed.kind === 'renameTable' || parsed.kind === 'truncate') {
		check(parsed.object, 'statement');
	}
	if (parsed.kind === 'createIndex') {
		check(parsed.onTable, 'index');
	}
	if (parsed.kind === 'dropTable' && !parsed.ifExists) {
		check(parsed.object, 'DROP');
	}
	if (parsed.kind === 'select' || parsed.kind === 'update' || parsed.kind === 'delete' || parsed.kind === 'insert') {
		for (const ref of parsed.tables ?? []) {
			check(ref.name, 'query');
		}
	}

	// Columns: only for statements where naming a missing one is an outright error.
	const table = destinationTable(ctx, parsed.object);
	if (table) {
		for (const action of parsed.actions ?? []) {
			const column =
				action.type === 'dropColumn' ? action.column
					: action.type === 'setNotNull' || action.type === 'dropNotNull' || action.type === 'alterColumnType' ? action.column
						: action.type === 'renameColumn' ? action.from
							: undefined;
			if (!column) {
				continue;
			}
			const key = `${bare(parsed.object)}.${column.toLowerCase()}`;
			if (ctx.pending.addedColumns.has(key) || findColumn(table, column)) {
				continue;
			}
			out.push(finding(ctx, {
				kind: 'unknown-object',
				severity: 'blocker',
				subject: key,
				title: `${codeSpan(`${parsed.object}.${column}`)} does not exist on the destination`,
				detail: 'The column this statement changes is not on the destination table, so the migration fails at this statement.',
				evidence: evidence(ctx, `${codeSpan(parsed.object)} has ${table.columns.length} columns and none is ${codeSpan(column)}`),
			}));
		}
	}
	return out;
}

/** Creating something that is already there. */
function alreadyExists(ctx: RuleContext): ReviewFinding[] {
	const { parsed } = ctx;
	if (!ctx.schema) {
		return [];
	}
	const out: ReviewFinding[] = [];

	if (parsed.kind === 'createTable' && !parsed.ifNotExists && findTable(ctx.schema, parsed.object ?? '')) {
		out.push(finding(ctx, {
			kind: 'already-exists',
			severity: 'blocker',
			title: `${codeSpan(parsed.object)} already exists on the destination`,
			detail: 'This migration has already run against this database, or another one created the table. As written it will fail rather than be skipped.',
			evidence: evidence(ctx, `table ${codeSpan(parsed.object)} is present`),
		}));
	}

	if (parsed.kind === 'createIndex' && parsed.object && !parsed.ifNotExists) {
		const table = findTable(ctx.schema, parsed.onTable ?? '');
		const clash = table && allIndexes(table).find((i) => i.name.toLowerCase() === parsed.object!.toLowerCase());
		if (clash) {
			out.push(finding(ctx, {
				kind: 'already-exists',
				severity: 'blocker',
				title: `An index called ${codeSpan(parsed.object)} already exists on ${codeSpan(parsed.onTable)}`,
				detail: `It covers (${clash.columns.join(', ')}). Creating it again fails; if the definition needs to change, drop and recreate it.`,
				evidence: evidence(ctx, `index ${codeSpan(clash.name)} on (${clash.columns.join(', ')})`),
			}));
		}
	}

	const table = destinationTable(ctx, parsed.object);
	for (const action of parsed.actions ?? []) {
		if (action.type !== 'addColumn' || !table) {
			continue;
		}
		if (findColumn(table, action.column.name)) {
			out.push(finding(ctx, {
				kind: 'already-exists',
				severity: 'blocker',
				subject: action.column.name,
				title: `${codeSpan(`${parsed.object}.${action.column.name}`)} already exists`,
				detail: 'Adding a column that is already there fails. If the intent is to change it, this needs to be an ALTER of the existing column.',
				evidence: evidence(ctx, `column ${codeSpan(action.column.name)} is present`),
			}));
		}
	}
	return out;
}

/** An ADD COLUMN NOT NULL with no default cannot succeed on a table that has rows. */
function notNullWithoutDefault(ctx: RuleContext): ReviewFinding[] {
	const table = destinationTable(ctx, ctx.parsed.object);
	if (!table) {
		return [];
	}
	const count = tableSize(table);
	const out: ReviewFinding[] = [];
	for (const action of ctx.parsed.actions ?? []) {
		if (action.type !== 'addColumn') {
			continue;
		}
		const column = action.column;
		if (!column.notNull || column.hasDefault || column.autoIncrement) {
			continue;
		}
		if (count !== undefined && count === 0) {
			continue; // an empty table takes it fine
		}
		out.push(finding(ctx, {
			kind: 'will-fail',
			severity: 'blocker',
			subject: column.name,
			title: `Adding ${codeSpan(column.name)} as NOT NULL with no default fails on a table that has rows`,
			detail: 'Every existing row needs a value for the new column, and there is nothing to give them. Add the column nullable, backfill it, then set NOT NULL as a separate step.',
			suggestedSql: [
				`ALTER TABLE ${ctx.parsed.object} ADD COLUMN ${column.name} ${column.dataType};`,
				`UPDATE ${ctx.parsed.object} SET ${column.name} = <value> WHERE ${column.name} IS NULL;`,
				`ALTER TABLE ${ctx.parsed.object} ALTER COLUMN ${column.name} SET NOT NULL;`,
			].join('\n'),
			evidence: count === undefined
				? undefined
				: evidence(ctx, `${codeSpan(table.name)} holds ${rows(count)}`),
		}));
	}
	return out;
}

/** A big table being rewritten or locked. */
function lockRisk(ctx: RuleContext): ReviewFinding[] {
	const out: ReviewFinding[] = [];
	const { parsed, dialect } = ctx;

	if (parsed.kind === 'createIndex') {
		const table = destinationTable(ctx, parsed.onTable);
		const count = tableSize(table);
		if (table && count !== undefined && count >= BIG_TABLE_ROWS && !parsed.concurrently && dialect.concurrentIndex) {
			out.push(finding(ctx, {
				kind: 'lock-risk',
				severity: 'warn',
				title: `Building this index locks ${codeSpan(parsed.onTable)} against writes`,
				detail: `The table holds ${rows(count)}, so the build is not instant, and a plain index build blocks writes for its whole duration. Use ${codeSpan(dialect.concurrentIndex)} (in its own migration, outside a transaction).`,
				evidence: evidence(ctx, `${codeSpan(table.name)} holds ${rows(count)}`),
			}));
		}
		return out;
	}

	const table = destinationTable(ctx, parsed.object);
	const count = tableSize(table);
	if (!table || count === undefined || count < BIG_TABLE_ROWS) {
		return out;
	}
	for (const action of parsed.actions ?? []) {
		if (action.type === 'addColumn' && action.column.hasDefault && dialect.defaultRewritesTable) {
			out.push(finding(ctx, {
				kind: 'lock-risk',
				severity: 'warn',
				subject: action.column.name,
				title: `Adding ${codeSpan(action.column.name)} with a default rewrites ${rows(count)}`,
				detail: `On ${dialect.displayName} a column added with a default is written into every existing row, holding a metadata lock while it copies the table. Whether the instant path applies depends on the row format and the column's position, neither of which is visible from this diff, so check on a copy before running it in production.`,
				evidence: evidence(ctx, `${codeSpan(table.name)} holds ${rows(count)}`),
			}));
		}
		if (action.type === 'alterColumnType') {
			out.push(finding(ctx, {
				kind: 'lock-risk',
				severity: 'warn',
				subject: action.column,
				title: `Changing the type of ${codeSpan(action.column)} rewrites ${rows(count)}`,
				detail: 'A type change re-reads and re-writes every row and holds a lock while it does. On a table this size that is a maintenance window, not a deploy step.',
				evidence: evidence(ctx, `${codeSpan(table.name)} holds ${rows(count)}`),
			}));
		}
	}
	return out;
}

/** Is this type change narrowing — i.e. can it lose data? */
function narrowing(before: ColumnInfo, after: string): { narrower: boolean; why: string } | undefined {
	const oldSize = /\(\s*(\d+)/.exec(before.dataType);
	const newSize = /\(\s*(\d+)/.exec(after);
	const oldBase = before.dataType.replace(/\(.*$/, '').trim().toLowerCase();
	const newBase = after.replace(/\(.*$/, '').trim().toLowerCase();

	if (oldBase === newBase && oldSize && newSize && Number(newSize[1]) < Number(oldSize[1])) {
		return { narrower: true, why: `${codeSpan(before.dataType)} → ${codeSpan(after)}` };
	}
	const rank: Record<string, number> = {
		tinyint: 1, smallint: 2, mediumint: 3, int: 4, integer: 4, bigint: 5,
		real: 3, float: 4, double: 5, decimal: 5, numeric: 5,
	};
	if (rank[oldBase] && rank[newBase] && rank[newBase] < rank[oldBase]) {
		return { narrower: true, why: `${codeSpan(before.dataType)} → ${codeSpan(after)}` };
	}
	if ((oldBase.includes('text') || oldBase.includes('clob')) && newBase.includes('char')) {
		return { narrower: true, why: `${codeSpan(before.dataType)} → ${codeSpan(after)}` };
	}
	return undefined;
}

/** A type change that can silently truncate or overflow what is stored. */
function narrowingType(ctx: RuleContext): ReviewFinding[] {
	const table = destinationTable(ctx, ctx.parsed.object);
	if (!table) {
		return [];
	}
	const out: ReviewFinding[] = [];
	for (const action of ctx.parsed.actions ?? []) {
		if (action.type !== 'alterColumnType') {
			continue;
		}
		const column = findColumn(table, action.column);
		if (!column) {
			continue;
		}
		const verdict = narrowing(column, action.dataType);
		if (!verdict) {
			continue;
		}
		out.push(finding(ctx, {
			kind: 'narrowing-type',
			severity: 'blocker',
			subject: action.column,
			title: `${codeSpan(action.column)} is being narrowed (${verdict.why})`,
			detail: 'A narrowing type change either fails on the first value that does not fit, or truncates it. Which vendor you are on decides which, and neither is what the author wants. Check the widest value actually stored before running this.',
			evidence: evidence(ctx, `the column is currently ${codeSpan(column.dataType)}`),
		}));
	}
	return out;
}

/** A new foreign key with no index on the referencing side. */
function unindexedForeignKey(ctx: RuleContext): ReviewFinding[] {
	const table = destinationTable(ctx, ctx.parsed.object);
	const out: ReviewFinding[] = [];
	for (const action of ctx.parsed.actions ?? []) {
		if (action.type !== 'addForeignKey' || action.columns.length === 0) {
			continue;
		}
		if (table && hasLeadingIndex(table, action.columns)) {
			continue;
		}
		const indexedByPr = ctx.pending.createdIndexes.size > 0;
		out.push(finding(ctx, {
			kind: 'unindexed-foreign-key',
			severity: 'warn',
			subject: action.columns.join(','),
			title: `No index on ${codeSpan(`${ctx.parsed.object}(${action.columns.join(', ')})`)}, the referencing side of this foreign key`,
			detail: `Without it, every DELETE or key UPDATE on ${codeSpan(action.refTable)} has to scan this table to check the constraint, and the parent table's writes get slower as this one grows. Most vendors index the referenced side automatically and not this one.${indexedByPr ? ' If an index earlier in this PR covers it, ignore this.' : ''}`,
			suggestedSql: `CREATE INDEX idx_${bare(ctx.parsed.object).replace(/\W/g, '_')}_${action.columns.join('_')} ON ${ctx.parsed.object} (${action.columns.join(', ')});`,
			evidence: table ? evidence(ctx, `${codeSpan(table.name)} has ${allIndexes(table).length} indexes, none leading with ${action.columns.map(codeSpan).join(', ')}`) : undefined,
		}));
	}
	return out;
}

/** A new index that an existing one already covers. */
function redundantIndex(ctx: RuleContext): ReviewFinding[] {
	if (ctx.parsed.kind !== 'createIndex' || !ctx.parsed.indexColumns?.length) {
		return [];
	}
	const table = destinationTable(ctx, ctx.parsed.onTable);
	if (!table) {
		return [];
	}
	const existing = coveringIndex(table, ctx.parsed.indexColumns);
	if (!existing || existing.name.toLowerCase() === (ctx.parsed.object ?? '').toLowerCase()) {
		return [];
	}
	const exact = existing.columns.length === ctx.parsed.indexColumns.length;
	return [finding(ctx, {
		kind: 'redundant-index',
		severity: 'note',
		title: exact
			? `${codeSpan(existing.name)} already indexes (${existing.columns.join(', ')})`
			: `${codeSpan(existing.name)} on (${existing.columns.join(', ')}) already covers these columns`,
		detail: 'An index the destination already has does the same lookups. A duplicate costs write throughput and disk on every insert, forever, and gives nothing back. Unless this one differs in uniqueness, ordering or included columns, it can go.',
		evidence: evidence(ctx, `existing index ${codeSpan(existing.name)} on (${existing.columns.join(', ')})`),
	})];
}

/** A query filtering or joining on a column with no index behind it. */
function missingIndex(ctx: RuleContext): ReviewFinding[] {
	const { parsed } = ctx;
	if (!ctx.schema || !['select', 'update', 'delete'].includes(parsed.kind)) {
		return [];
	}
	const out: ReviewFinding[] = [];
	const seen = new Set<string>();

	for (const predicate of parsed.predicates ?? []) {
		if (predicate.wrapped || predicate.role === 'order' || !predicate.table) {
			continue;
		}
		// An operator no b-tree can serve is a different (already reported) problem.
		if (!['=', '<', '>', '<=', '>=', 'IN', 'BETWEEN'].includes(predicate.op)) {
			continue;
		}
		const table = findTable(ctx.schema, predicate.table);
		if (!table || !findColumn(table, predicate.column)) {
			continue;
		}
		if (hasLeadingIndex(table, [predicate.column])) {
			continue;
		}
		const key = `${table.name}.${predicate.column}`.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

		const count = tableSize(table);
		if (count !== undefined && count < SMALL_TABLE_ROWS) {
			continue;
		}
		out.push(finding(ctx, {
			kind: 'missing-index',
			severity: count !== undefined && count >= BIG_TABLE_ROWS ? 'warn' : 'note',
			subject: key,
			title: predicate.role === 'join'
				? `Joining on ${codeSpan(`${table.name}.${predicate.column}`)}, which has no index`
				: `Filtering ${codeSpan(`${table.name}.${predicate.column}`)}, which has no index`,
			detail: `${predicate.role === 'join' ? 'A join key' : 'A filter'} with no index behind it makes the planner read the table${count !== undefined ? `, all ${rows(count)} of it` : ''}. This is the difference between a lookup and a scan, and it gets worse as the table grows.`,
			suggestedSql: `CREATE INDEX idx_${table.name.replace(/\W/g, '_')}_${predicate.column} ON ${table.name} (${predicate.column});`,
			evidence: evidence(
				ctx,
				count !== undefined
					? `${codeSpan(table.name)} holds ${rows(count)} and has no index leading with ${codeSpan(predicate.column)}`
					: `${codeSpan(table.name)} has no index leading with ${codeSpan(predicate.column)}`,
			),
		}));
	}
	return out;
}

/** Dropping something a view, a routine or a foreign key still points at. */
function stillReferenced(ctx: RuleContext): ReviewFinding[] {
	const { parsed, schema } = ctx;
	if (!schema) {
		return [];
	}
	const out: ReviewFinding[] = [];

	const droppedTable = parsed.kind === 'dropTable' ? bare(parsed.object) : '';
	const droppedColumns = (parsed.actions ?? [])
		.filter((a): a is { type: 'dropColumn'; column: string } => a.type === 'dropColumn')
		.map((a) => a.column.toLowerCase());

	if (droppedTable === '' && droppedColumns.length === 0) {
		return out;
	}

	// Foreign keys pointing at the table being dropped.
	if (droppedTable !== '') {
		const referrers = schema.tables.filter((t) =>
			t.foreignKeys.some((fk) => bare(fk.referencedTable) === droppedTable),
		);
		if (referrers.length > 0 && !parsed.cascade) {
			out.push(finding(ctx, {
				kind: 'still-referenced',
				severity: 'blocker',
				title: `${codeSpan(parsed.object)} is still referenced by ${referrers.length === 1 ? 'a foreign key' : `${referrers.length} foreign keys`}`,
				detail: `${referrers.map((t) => `${codeSpan(t.name)}`).join(', ')} still point at it, so the DROP is refused unless those constraints go first.`,
				evidence: evidence(ctx, `referenced by ${referrers.map((t) => t.name).join(', ')}`),
			}));
		}
	}

	// Views and routines whose text mentions what is going.
	const needles = droppedTable !== '' ? [droppedTable] : droppedColumns;
	const word = (haystack: string, needle: string): boolean =>
		new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack);

	for (const needle of needles) {
		const views = schema.tables.filter((t) => t.kind === 'view' && t.definition && word(t.definition, needle));
		const routines = (schema.routines ?? []).filter((r) => r.definition && word(r.definition, needle));
		if (views.length === 0 && routines.length === 0) {
			continue;
		}
		const named = [...views.map((v) => `view ${codeSpan(v.name)}`), ...routines.map((r) => `${codeSpan(r.name)}`)];
		out.push(finding(ctx, {
			kind: 'still-referenced',
			severity: 'warn',
			subject: needle,
			title: `${codeSpan(needle)} is named by ${named.length === 1 ? named[0] : `${named.length} database objects`}`,
			detail: `${named.join(', ')} refer to it by name on the destination. Most vendors let the drop succeed and leave those objects broken until something calls them.`,
			evidence: evidence(ctx, `found in ${named.join(', ')}`),
		}));
	}
	return out;
}

/** Every schema-aware rule. All return nothing without a schema. */
export function schemaFindings(ctx: RuleContext): ReviewFinding[] {
	if (!ctx.schema) {
		return [];
	}
	return [
		...unknownObject(ctx),
		...alreadyExists(ctx),
		...notNullWithoutDefault(ctx),
		...narrowingType(ctx),
		...stillReferenced(ctx),
		...lockRisk(ctx),
		...unindexedForeignKey(ctx),
		...redundantIndex(ctx),
		...missingIndex(ctx),
	];
}

export { BIG_TABLE_ROWS, HUGE_TABLE_ROWS, SMALL_TABLE_ROWS, narrowing };

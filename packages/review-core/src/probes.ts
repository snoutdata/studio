/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Probes: the read-only questions that turn advice into a measurement.
 *
 *  This module never runs anything. It emits SQL for the host to run and reads what comes back.
 *  That split is the reason one rule set can serve any host: a desktop app with an SSH tunnel, a
 *  runner inside somebody's VPC, a service with its own connection, and a unit test with fixtures.
 *
 *  Every probe here obeys the same three rules, and a new one that cannot is not a probe:
 *
 *    1. READ-ONLY. A SELECT, and nothing else.
 *    2. AGGREGATE-ONLY. It returns a count, a maximum, or a plan — never a row of user data.
 *       If a check needs to see values to work, it does not ship.
 *    3. BOUNDED. It says what it will cost (`cost`) and which table it reads, so a host can
 *       refuse an expensive one on a huge table and the report can say what was skipped.
 *--------------------------------------------------------------------------------------------*/

import { quoteName } from './dialect.js';
import { codeSpan, nameList, nameSpan } from './markdown.js';
import type { ReviewDialect } from './dialect.js';
import { findColumn, findTable, hasLeadingIndex } from './schema.js';
import type { DatabaseSchema } from './schema.js';
import { notNullTarget } from './sql/parse.js';
import { singleStatementRefusal } from './sql/split.js';
import type { ParsedStatement } from './sql/parse.js';
import { bare, evidence, finding, rows } from './rules/context.js';
import type { RuleContext } from './rules/context.js';
import { narrowing } from './rules/schema.js';
import type { Probe, ProbeResult, ReviewFinding, ReviewStatement } from './types.js';

/** Deterministic probe id: the same question on the same statement is the same probe. */
function probeId(statementId: string, kind: string, subject: string): string {
	return `${statementId}-${kind}-${subject.replace(/\W+/g, '_')}`.toLowerCase();
}

export interface ProbePlanInput {
	statement: ReviewStatement;
	parsed: ParsedStatement;
	dialect: ReviewDialect;
	schema: DatabaseSchema;
	/** Include probes marked expensive (the `--deep` path). */
	deep?: boolean;
}

/**
 * The probes one statement wants answered.
 *
 * Only statements that can FAIL or SILENTLY LOSE DATA earn a probe. "Is this slow" is answered
 * by the schema tier and by EXPLAIN; spending a scan of a customer's production table to
 * confirm something we already suspect is not worth the cost we impose on them.
 */
export function planProbes(input: ProbePlanInput): Probe[] {
	const { statement, parsed, dialect, schema } = input;
	const out: Probe[] = [];
	const q = (name: string): string => quoteName(dialect, name);

	const table = parsed.object ? findTable(schema, parsed.object) : undefined;
	const size = table?.stats?.rowCount;
	/** A counting probe reads the table; say so honestly rather than pretending it is free. */
	const cost = (): Probe['cost'] => 'scan';

	for (const action of parsed.actions ?? []) {
		if (!table) {
			continue;
		}
		// `notNullTarget`, not `action.type === 'setNotNull'`: MySQL says `MODIFY c DATE NOT NULL`
		// and has no SET NOT NULL at all, so keying on the action type skipped the headline
		// finding for every MySQL user.
		const notNullColumn = notNullTarget(action);
		if (notNullColumn !== undefined) {
			const column = findColumn(table, notNullColumn);
			if (!column || !column.nullable) {
				continue; // already NOT NULL: nothing to fail
			}
			out.push({
				id: probeId(statement.id, 'null-count', notNullColumn),
				statementId: statement.id,
				kind: 'null-count',
				table: table.name,
				cost: hasLeadingIndex(table, [notNullColumn]) ? 'lookup' : cost(),
				column: notNullColumn,
				purpose: `whether ${nameSpan(`${table.name}.${notNullColumn}`)} has NULLs, which would make the column NOT NULL fail`,
				sql: `SELECT COUNT(*) AS n FROM ${q(parsed.object!)} WHERE ${q(notNullColumn)} IS NULL`,
			});
		}

		if (action.type === 'addUnique' && action.columns.length > 0) {
			out.push({
				id: probeId(statement.id, 'duplicate-count', action.columns.join('_')),
				statementId: statement.id,
				kind: 'duplicate-count',
				table: table.name,
				cost: cost(),
				purpose: `whether (${nameList(action.columns)}) is already unique in ${nameSpan(table.name)}`,
				sql: duplicateSql(dialect, parsed.object!, action.columns),
			});
		}

		if (action.type === 'addForeignKey' && action.columns.length > 0 && action.refColumns.length > 0) {
			out.push({
				id: probeId(statement.id, 'orphan-count', action.columns.join('_')),
				statementId: statement.id,
				kind: 'orphan-count',
				table: table.name,
				cost: cost(),
				purpose: `whether ${nameSpan(table.name)} holds rows with no matching ${nameSpan(action.refTable)}`,
				sql: orphanSql(dialect, parsed.object!, action.columns, action.refTable, action.refColumns),
			});
		}

		if (action.type === 'alterColumnType') {
			const column = findColumn(table, action.column);
			const verdict = column && narrowing(column, action.dataType);
			const limit = /\(\s*(\d+)/.exec(action.dataType);
			if (column && verdict && limit && /char|text|varchar/i.test(action.dataType)) {
				out.push({
					id: probeId(statement.id, 'overflow-count', action.column),
					statementId: statement.id,
					kind: 'overflow-count',
					table: table.name,
					cost: cost(),
					purpose: `whether any ${nameSpan(`${table.name}.${action.column}`)} is longer than ${limit[1]} characters`,
					sql: `SELECT COUNT(*) AS n FROM ${q(parsed.object!)} WHERE ${lengthCall(dialect, q(action.column))} > ${Number(limit[1])}`,
				});
			}
		}

		// An ADD COLUMN NOT NULL without a default fails if and only if the table has rows, and
		// the catalog's row count is an estimate. When it is missing, ask.
		if (action.type === 'addColumn' && action.column.notNull && !action.column.hasDefault && size === undefined) {
			out.push({
				id: probeId(statement.id, 'row-count', table.name),
				statementId: statement.id,
				kind: 'row-count',
				table: table.name,
				cost: cost(),
				purpose: `whether ${nameSpan(table.name)} has any rows, which decides whether NOT NULL without a default can succeed`,
				sql: `SELECT COUNT(*) AS n FROM ${q(parsed.object!)}`,
			});
		}
	}

	if (parsed.kind === 'createIndex' && parsed.unique && parsed.onTable && parsed.indexColumns?.length) {
		const target = findTable(schema, parsed.onTable);
		if (target) {
			out.push({
				id: probeId(statement.id, 'duplicate-count', parsed.indexColumns.join('_')),
				statementId: statement.id,
				kind: 'duplicate-count',
				table: target.name,
				cost: cost(),
				purpose: `whether (${nameList(parsed.indexColumns)}) is already unique in ${nameSpan(target.name)}`,
				sql: duplicateSql(dialect, parsed.onTable, parsed.indexColumns),
			});
		}
	}

	// The plan for a changed query. Expensive to nobody but noisy, so it is a deep-run probe.
	// It is the one probe that carries the pull request's own SQL, so it is only built when that
	// SQL is a single statement however a database could read it: the splitter's idea
	// of where a string ends is not evidence about the server's.
	if (
		input.deep &&
		dialect.explain &&
		(parsed.kind === 'select' || parsed.kind === 'update' || parsed.kind === 'delete') &&
		singleStatementRefusal(statement.sql) === undefined
	) {
		out.push({
			id: probeId(statement.id, 'explain', 'plan'),
			statementId: statement.id,
			kind: 'explain',
			table: parsed.tables?.[0]?.name,
			cost: 'explain',
			purpose: 'the destination\'s own plan for this statement',
			sql: dialect.explain(statement.sql),
		});
	}

	return out;
}

function lengthCall(dialect: ReviewDialect, column: string): string {
	return dialect.driverId === 'sqlserver' ? `LEN(${column})` : `LENGTH(${column})`;
}

function duplicateSql(dialect: ReviewDialect, table: string, columns: string[]): string {
	const q = (name: string): string => quoteName(dialect, name);
	const cols = columns.map(q).join(', ');
	const notNull = columns.map((c) => `${q(c)} IS NOT NULL`).join(' AND ');
	// Count the GROUPS with more than one row, not the rows: the answer a person wants is
	// "how many values collide", and the subquery keeps it one number.
	return `SELECT COUNT(*) AS n FROM (SELECT ${cols} FROM ${q(table)} WHERE ${notNull} GROUP BY ${cols} HAVING COUNT(*) > 1) AS dupes`;
}

function orphanSql(dialect: ReviewDialect, child: string, columns: string[], parent: string, refColumns: string[]): string {
	const q = (name: string): string => quoteName(dialect, name);
	const on = columns.map((c, i) => `p.${q(refColumns[i] ?? refColumns[0])} = c.${q(c)}`).join(' AND ');
	const notNull = columns.map((c) => `c.${q(c)} IS NOT NULL`).join(' AND ');
	return `SELECT COUNT(*) AS n FROM ${q(child)} c LEFT JOIN ${q(parent)} p ON ${on} WHERE ${notNull} AND p.${q(refColumns[0])} IS NULL`;
}

/** The first numeric value in a probe's result, or undefined when it did not answer one. */
export function countFrom(result: ProbeResult | undefined): number | undefined {
	if (!result?.ok || !result.rows || result.rows.length === 0) {
		return undefined;
	}
	for (const value of Object.values(result.rows[0])) {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === 'bigint') {
			return Number(value);
		}
		if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
			return Number(value.trim());
		}
	}
	return undefined;
}

/**
 * Findings from the probes raised for one statement.
 *
 * A probe that came back clean produces NOTHING. "I checked and it is fine" on every statement
 * is how a reviewer trains people to skim past it; the clean checks are counted in the report's
 * footer instead, where they say the review was thorough without taking up the page.
 */
export function probeFindings(ctx: RuleContext, probes: Probe[]): ReviewFinding[] {
	const out: ReviewFinding[] = [];
	const q = (name: string): string => quoteName(ctx.dialect, name);

	for (const probe of probes) {
		if (probe.statementId !== ctx.statement.id) {
			continue;
		}
		const result = ctx.probes.get(probe.id);
		if (!result || !result.ok) {
			continue; // reported as a gap by the caller, not as a finding
		}
		const n = countFrom(result);
		if (n === undefined) {
			continue;
		}

		if (probe.kind === 'null-count' && n > 0) {
			const column = probe.column;
			out.push(finding(ctx, {
				kind: 'will-fail',
				severity: 'blocker',
				subject: probe.id,
				title: `This will fail: ${rows(n)} in ${codeSpan(probe.table)} are NULL`,
				detail: 'A NOT NULL constraint is rejected while any row already violates it, so the migration stops at this statement. Backfill the column in its own migration first, then add the constraint once nothing is NULL.',
				suggestedSql: column
					? `UPDATE ${q(probe.table ?? '')} SET ${q(column)} = <value> WHERE ${q(column)} IS NULL;`
					: undefined,
				evidence: evidence(ctx, `${rows(n)} with a NULL in that column`, probe.sql),
			}));
		}

		if (probe.kind === 'duplicate-count' && n > 0) {
			out.push(finding(ctx, {
				kind: 'will-fail',
				severity: 'blocker',
				subject: probe.id,
				title: `This will fail: ${n === 1 ? '1 value is' : `${n} values are`} duplicated in ${codeSpan(probe.table)}`,
				detail: 'A unique constraint cannot be created over values that are already not unique. Deduplicate first, and decide deliberately which row wins. That decision is not one a migration should make silently.',
				evidence: evidence(ctx, `${n === 1 ? '1 duplicated value' : `${n} duplicated values`}`, probe.sql),
			}));
		}

		if (probe.kind === 'orphan-count' && n > 0) {
			out.push(finding(ctx, {
				kind: 'will-fail',
				severity: 'blocker',
				subject: probe.id,
				title: `This will fail: ${rows(n)} in ${codeSpan(probe.table)} have no matching parent row`,
				detail: 'A foreign key is validated against the data that is already there. Those rows have to be repaired or removed before the constraint can be added, or the constraint has to be added NOT VALID and validated later if the vendor supports it.',
				evidence: evidence(ctx, `${rows(n)} with no parent`, probe.sql),
			}));
		}

		if (probe.kind === 'overflow-count' && n > 0) {
			out.push(finding(ctx, {
				kind: 'will-fail',
				severity: 'blocker',
				subject: probe.id,
				title: `${rows(n)} in ${codeSpan(probe.table)} are too long for the new type`,
				detail: 'Depending on the vendor and its mode this either fails outright or truncates the value and keeps going. Neither is what this migration means to do.',
				evidence: evidence(ctx, `${rows(n)} longer than the new limit`, probe.sql),
			}));
		}

		if (probe.kind === 'row-count' && n > 0) {
			out.push(finding(ctx, {
				kind: 'will-fail',
				severity: 'blocker',
				subject: probe.id,
				title: `This will fail: ${codeSpan(probe.table)} holds ${rows(n)} and the new column is NOT NULL with no default`,
				detail: 'Existing rows need a value and there is nothing to give them. Add it nullable, backfill, then add the constraint.',
				evidence: evidence(ctx, `${rows(n)} already in the table`, probe.sql),
			}));
		}
	}
	return out;
}

export { bare };

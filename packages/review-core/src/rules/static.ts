/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The static tier: everything decidable from the SQL text alone.
 *
 *  These run in every mode, including the one where we have never seen the database. They are
 *  the whole product for a free install, so they have to be high-signal: each one names a
 *  consequence, not a preference. A rule that fires on something a competent engineer would
 *  shrug at gets the whole reviewer muted, and then it reviews nothing.
 *--------------------------------------------------------------------------------------------*/

import { tokenize } from '../sql/tokenize.js';
import { codeSpan } from '../markdown.js';
import type { ReviewFinding } from '../types.js';
import { finding, excerpt } from './context.js';
import type { RuleContext } from './context.js';

/** DROP / TRUNCATE / an UPDATE or DELETE with no WHERE. */
function destructive(ctx: RuleContext): ReviewFinding[] {
	const { parsed } = ctx;
	const out: ReviewFinding[] = [];

	if (parsed.kind === 'dropTable') {
		out.push(finding(ctx, {
			kind: 'destructive',
			severity: 'warn',
			title: `Drops the table ${codeSpan(parsed.object)}`,
			detail: parsed.cascade
				? 'CASCADE also drops every view, foreign key and constraint that depends on it. Whatever was in the table, and whatever depended on it, is gone and is not coming back from a rollback of this PR.'
				: 'The table and its data are gone. Reverting this pull request does not bring them back; only a restore does.',
		}));
	}
	if (parsed.kind === 'truncate') {
		out.push(finding(ctx, {
			kind: 'destructive',
			severity: 'warn',
			title: `Empties ${codeSpan(parsed.object)}`,
			detail: 'TRUNCATE removes every row and, on most vendors, cannot be rolled back and does not fire delete triggers.',
		}));
	}
	if (parsed.kind === 'dropView') {
		out.push(finding(ctx, {
			kind: 'destructive',
			severity: 'note',
			title: `Drops the view ${codeSpan(parsed.object)}`,
			detail: 'Anything querying this view breaks the moment it is dropped, including code not in this repository.',
		}));
	}
	for (const action of parsed.actions ?? []) {
		if (action.type === 'dropColumn') {
			out.push(finding(ctx, {
				kind: 'destructive',
				severity: 'warn',
				subject: action.column,
				title: `Drops the column ${codeSpan(`${parsed.object}.${action.column}`)}`,
				detail: 'The data in this column is gone. If any deployed code still reads it, that code starts failing at the moment the migration runs, not at the moment it is deployed.',
			}));
		}
	}
	if (parsed.unfiltered) {
		out.push(finding(ctx, {
			kind: 'destructive',
			severity: 'blocker',
			title: `${parsed.kind === 'delete' ? 'DELETE' : 'UPDATE'} with no WHERE clause`,
			detail: `This touches every row in ${codeSpan(parsed.object ?? 'the table')}. If that is deliberate, say so in the migration; if it is not, it is the mistake this reviewer exists to catch.`,
		}));
	}
	return out;
}

/**
 * `SET a = x AND b = y` — one assignment, not two.
 *
 * `AND` is not an assignment separator, so the statement parses, runs, reports rows affected,
 * and silently assigns a boolean to the first column while never touching the second.
 */
function setBooleanExpression(ctx: RuleContext): ReviewFinding[] {
	if (ctx.parsed.kind !== 'update') {
		return [];
	}
	const tokens = tokenize(ctx.statement.sql);
	const setAt = tokens.findIndex((t) => t.type === 'ident' && !t.quoted && t.upper === 'SET' && t.depth === 0);
	if (setAt === -1) {
		return [];
	}
	let end = tokens.length;
	for (let i = setAt + 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.depth === 0 && t.type === 'ident' && !t.quoted && (t.upper === 'WHERE' || t.upper === 'RETURNING' || t.upper === 'FROM')) {
			end = i;
			break;
		}
	}
	for (let i = setAt + 1; i < end; i++) {
		const t = tokens[i];
		if (t.depth === 0 && t.type === 'ident' && !t.quoted && (t.upper === 'AND' || t.upper === 'OR')) {
			return [finding(ctx, {
				kind: 'hazard',
				severity: 'blocker',
				title: `${codeSpan(t.upper)} inside the SET clause is not an assignment separator`,
				detail: `This is ONE assignment whose value is a boolean expression. The first column is set to the result of that expression and every column after the ${codeSpan(t.upper)} is never written, while the statement reports rows affected as though it worked. Separate assignments with a comma.`,
				suggestedSql: ctx.statement.sql.replace(/\b(AND|OR)\b/i, ','),
			})];
		}
	}
	return [];
}

/** `= NULL` and `<> NULL`, which match nothing rather than matching the NULLs. */
function nullComparison(ctx: RuleContext): ReviewFinding[] {
	const tokens = tokenize(ctx.statement.sql);
	for (let i = 0; i < tokens.length - 1; i++) {
		const op = tokens[i];
		const next = tokens[i + 1];
		if (op.type !== 'punct' || !['=', '<>', '!='].includes(op.value)) {
			continue;
		}
		if (next.type === 'ident' && !next.quoted && next.upper === 'NULL') {
			return [finding(ctx, {
				kind: 'hazard',
				severity: 'blocker',
				title: `${codeSpan(`${op.value} NULL`)} never matches anything`,
				detail: 'In SQL, a comparison with NULL is UNKNOWN, not true, so this predicate matches no rows at all, and the statement succeeds while doing nothing. Use `IS NULL` / `IS NOT NULL`.',
				suggestedSql: ctx.statement.sql.replace(/(=|<>|!=)\s*NULL/i, op.value === '=' ? 'IS NULL' : 'IS NOT NULL'),
			})];
		}
	}
	return [];
}

/** A column wrapped in a function, or a LIKE that starts with a wildcard: the index is out. */
function nonSargable(ctx: RuleContext): ReviewFinding[] {
	const out: ReviewFinding[] = [];
	const seen = new Set<string>();

	for (const predicate of ctx.parsed.predicates ?? []) {
		if (!predicate.wrapped || predicate.role === 'order') {
			continue;
		}
		const key = `${predicate.table ?? ''}.${predicate.column}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(finding(ctx, {
			kind: 'non-sargable',
			severity: 'warn',
			subject: key,
			title: `${codeSpan(predicate.column)} is wrapped in an expression, so no index on it can be used`,
			detail: 'A b-tree index stores the column\'s values, not the result of a function applied to them. Once the column is inside a call, the planner has to compute it for every row, which turns a lookup into a full scan. Compare the bare column against a computed bound instead, or add an index on the expression if the vendor supports one.',
		}));
	}

	// LIKE '%…' — an index cannot help when the leading characters are unknown.
	const tokens = tokenize(ctx.statement.sql);
	for (let i = 0; i < tokens.length - 1; i++) {
		const t = tokens[i];
		if (t.type !== 'ident' || t.quoted || (t.upper !== 'LIKE' && t.upper !== 'ILIKE')) {
			continue;
		}
		const literal = tokens[i + 1];
		if (literal.type === 'string' && (literal.value.startsWith('%') || literal.value.startsWith('_'))) {
			out.push(finding(ctx, {
				kind: 'non-sargable',
				severity: 'warn',
				subject: `like:${literal.value}`,
				title: `${codeSpan(`LIKE '${excerpt(literal.value, 24)}'`)} starts with a wildcard, so no index can serve it`,
				detail: 'A b-tree index is ordered by the start of the value, so a pattern with an unknown beginning has to be checked against every row. If this is a search box, it wants a full-text or trigram index, not a LIKE.',
			}));
			break;
		}
	}
	return out;
}

/** Re-running a migration: without IF [NOT] EXISTS, the second run fails. */
function idempotence(ctx: RuleContext): ReviewFinding[] {
	const { parsed } = ctx;
	const droppy = parsed.kind === 'dropTable' || parsed.kind === 'dropIndex' || parsed.kind === 'dropView';
	if (droppy && !parsed.ifExists) {
		return [finding(ctx, {
			kind: 'migration-hygiene',
			severity: 'note',
			title: 'No `IF EXISTS`, so re-running this migration fails',
			detail: 'A migration that has partly run (because it was interrupted, or because DDL does not roll back on this vendor) cannot simply be run again. `IF EXISTS` makes the step repeatable.',
		})];
	}
	const creates = parsed.kind === 'createTable' || parsed.kind === 'createIndex';
	if (creates && !parsed.ifNotExists) {
		return [finding(ctx, {
			kind: 'migration-hygiene',
			severity: 'note',
			title: 'No `IF NOT EXISTS`, so re-running this migration fails',
			detail: 'If this migration is interrupted after the object is created, running it again errors instead of continuing.',
		})];
	}
	return [];
}

/** Statements quoted for a different vendor than the destination. */
function wrongQuoting(ctx: RuleContext): ReviewFinding[] {
	const { dialect } = ctx;
	if (dialect.driverId === 'generic') {
		return [];
	}
	const uses = new Set<string>();
	for (const token of tokenize(ctx.statement.sql)) {
		if (!token.quoted) {
			continue;
		}
		const opener = ctx.statement.sql[token.start];
		if (opener && !dialect.identifierQuotes.includes(opener)) {
			uses.add(opener);
		}
	}
	if (uses.size === 0) {
		return [];
	}
	const written = [...uses].map((q) => `${codeSpan(q)}`).join(' and ');
	return [finding(ctx, {
		kind: 'dialect',
		severity: 'blocker',
		title: `Quoted with ${written}, which ${dialect.displayName} does not accept`,
		detail: `The destination is ${dialect.displayName}, which quotes identifiers with ${dialect.identifierQuotes.map((q) => `${codeSpan(q)}`).join(' or ')}. This statement is written for a different vendor and will not parse.`,
	})];
}

/** `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. */
function concurrentInTransaction(ctx: RuleContext): ReviewFinding[] {
	if (!ctx.parsed.concurrently) {
		return [];
	}
	const opensTransaction = ctx.fileStatements.some(
		(s) => s.kind === 'transaction' && /^\s*(begin|start)\b/i.test(s.sql),
	);
	if (!opensTransaction) {
		return [];
	}
	return [finding(ctx, {
		kind: 'dialect',
		severity: 'blocker',
		title: 'A concurrent index build cannot run inside a transaction',
		detail: 'This file opens an explicit transaction, and `CONCURRENTLY` is rejected inside one. Many migration tools also wrap each file in a transaction of their own, which fails the same way; the index build has to be its own migration, outside any transaction.',
	})];
}

/** Every static rule, in the order a reader wants them. */
export function staticFindings(ctx: RuleContext): ReviewFinding[] {
	return [
		...setBooleanExpression(ctx),
		...nullComparison(ctx),
		...wrongQuoting(ctx),
		...concurrentInTransaction(ctx),
		...destructive(ctx),
		...nonSargable(ctx),
		...idempotence(ctx),
	];
}

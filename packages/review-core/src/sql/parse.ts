/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Reading one SQL statement into the shape the rules ask questions of.
 *
 *  Not a SQL parser and never trying to be one. It recognises the statement forms a migration
 *  and a query change are actually written in, records what it is sure about, and leaves the
 *  rest as `other` — because a rule that fires on a misparse is worse than a rule that stays
 *  quiet. Anything it did not understand is a gap the report can admit to, not a silent pass.
 *--------------------------------------------------------------------------------------------*/

import { bareName, readQualifiedName, tokenize } from './tokenize.js';
import type { Token } from './tokenize.js';

export type StatementKind =
	| 'createTable'
	| 'dropTable'
	| 'alterTable'
	| 'renameTable'
	| 'createIndex'
	| 'dropIndex'
	| 'createView'
	| 'dropView'
	| 'truncate'
	| 'select'
	| 'insert'
	| 'update'
	| 'delete'
	| 'merge'
	| 'transaction'
	| 'other';

/** A column as a CREATE TABLE / ADD COLUMN declares it. */
export interface DeclaredColumn {
	name: string;
	/** The declared type as written, e.g. `VARCHAR(16)`, `numeric(10,2)`. */
	dataType: string;
	notNull: boolean;
	hasDefault: boolean;
	/** The default expression as written. */
	defaultExpr?: string;
	unique: boolean;
	primaryKey: boolean;
	/** Server-generated: SERIAL, AUTO_INCREMENT, IDENTITY, GENERATED … AS IDENTITY. */
	autoIncrement: boolean;
	/** A REFERENCES clause written inline on the column. */
	references?: { table: string; columns: string[] };
}

export type AlterAction =
	| { type: 'addColumn'; column: DeclaredColumn }
	| { type: 'dropColumn'; column: string }
	/** A type change. `notNull` is MySQL's version of SET NOT NULL: `MODIFY c INT NOT NULL`
	 *  restates the whole definition, so adding the constraint and changing the type are the
	 *  same statement there and cannot be two actions. See `notNullTarget`. */
	| { type: 'alterColumnType'; column: string; dataType: string; notNull?: boolean }
	| { type: 'setNotNull'; column: string }
	| { type: 'dropNotNull'; column: string }
	| { type: 'setDefault'; column: string; defaultExpr: string }
	| { type: 'addForeignKey'; name?: string; columns: string[]; refTable: string; refColumns: string[] }
	| { type: 'addUnique'; name?: string; columns: string[] }
	| { type: 'addPrimaryKey'; columns: string[] }
	| { type: 'addCheck'; name?: string; expression: string }
	| { type: 'dropConstraint'; name: string }
	| { type: 'renameColumn'; from: string; to: string }
	| { type: 'renameTable'; to: string }
	/** Understood as an ALTER but not as any of the above — kept so the report can say so. */
	| { type: 'unrecognised'; text: string };

/**
 * The column an ALTER is making NOT NULL, if it is making one.
 *
 * Two syntaxes, one meaning. Postgres and SQL Server say `ALTER COLUMN c SET NOT NULL`, which
 * parses as `setNotNull`. MySQL has no such clause: the only way to add the constraint is
 * `MODIFY c <type> NOT NULL`, which restates the entire column and therefore parses as a type
 * change that happens to be NOT NULL. Every rule that cares about the constraint has to go
 * through here, or it silently never fires for MySQL, which is most of our users.
 */
export function notNullTarget(action: AlterAction): string | undefined {
	if (action.type === 'setNotNull') {
		return action.column;
	}
	if (action.type === 'alterColumnType' && action.notNull) {
		return action.column;
	}
	return undefined;
}

/** A table named in a FROM / JOIN / UPDATE / INSERT INTO, with its alias if it has one. */
export interface TableRef {
	name: string;
	alias?: string;
}

/** A column compared, joined or ordered on — what the missing-index rule reads. */
export interface PredicateRef {
	/** The qualifier as written (`o` in `o.customer_id`), before alias resolution. */
	qualifier?: string;
	column: string;
	/** The table the qualifier resolves to, once aliases are applied. */
	table?: string;
	/** `=`, `>`, `IN`, `LIKE`, `IS`, … Decides whether an index could serve it at all. */
	op: string;
	/** Where it was found — a JOIN key with no index is a different (worse) finding than an
	 *  ORDER BY with no index. */
	role: 'where' | 'join' | 'order';
	/** True when the column sits inside a function or an expression (`DATE(created_at)`),
	 *  which is what stops an index being usable at all. */
	wrapped: boolean;
}

export interface ParsedStatement {
	kind: StatementKind;
	/** The object the statement acts on, as written (may be schema-qualified). */
	object?: string;
	/** For an index: the table it is built on. */
	onTable?: string;
	indexColumns?: string[];
	unique?: boolean;
	concurrently?: boolean;
	ifExists?: boolean;
	ifNotExists?: boolean;
	/** CASCADE was written on a DROP — it takes dependents with it. */
	cascade?: boolean;
	/** For CREATE TABLE: the columns it declares. */
	columns?: DeclaredColumn[];
	/** For ALTER TABLE: every action in the statement (a single ALTER can carry several). */
	actions?: AlterAction[];
	/** Tables the statement reads or writes, with aliases. */
	tables?: TableRef[];
	predicates?: PredicateRef[];
	/** True when a DELETE/UPDATE has no WHERE — it touches every row. */
	unfiltered?: boolean;
	/** The statement text this was read from. */
	sql: string;
	/** Set when the statement was recognised only in part, naming what was not understood. */
	partial?: string;
}

const DDL_KEYWORDS = new Set([
	'CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'KEY', 'INDEX', 'EXCLUDE', 'PERIOD', 'FULLTEXT', 'SPATIAL',
]);

/** Column-level attributes that end a type: everything after one of these is not the type. */
const TYPE_STOP = new Set([
	'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'GENERATED', 'AUTO_INCREMENT', 'IDENTITY',
	'COMMENT', 'COLLATE', 'CONSTRAINT', 'AS', 'STORED', 'VIRTUAL', 'ON', 'CHARACTER', 'FIRST', 'AFTER', 'ENCODE',
]);

/** Text of `sql` spanned by tokens [from, to). A statement terminator is not part of any
 *  expression inside it, so it never survives into a type or a default. */
function slice(sql: string, tokens: Token[], from: number, to: number): string {
	if (from >= tokens.length || from >= to) {
		return '';
	}
	const end = Math.min(to, tokens.length);
	return sql.slice(tokens[from].start, tokens[end - 1].end).trim().replace(/[;\s]+$/, '');
}

/** Split [from, to) on commas at `depth`. */
function splitCommas(tokens: Token[], from: number, to: number, depth: number): { from: number; to: number }[] {
	const parts: { from: number; to: number }[] = [];
	let last = from;
	for (let i = from; i < to; i++) {
		if (tokens[i].type === 'punct' && tokens[i].value === ',' && tokens[i].depth === depth) {
			parts.push({ from: last, to: i });
			last = i + 1;
		}
	}
	if (last < to) {
		parts.push({ from: last, to });
	}
	return parts;
}

/** The parenthesised column list starting at `i` (which must be on `(`), and the token after it. */
function readColumnList(tokens: Token[], i: number): { columns: string[]; next: number } {
	if (!tokens[i] || tokens[i].value !== '(') {
		return { columns: [], next: i };
	}
	const openDepth = tokens[i].depth;
	let close = i + 1;
	while (close < tokens.length && !(tokens[close].value === ')' && tokens[close].depth === openDepth)) {
		close++;
	}
	const columns: string[] = [];
	for (const part of splitCommas(tokens, i + 1, close, openDepth + 1)) {
		// `(lower(email))` and `(created_at DESC)` both name one column; take the first ident.
		for (let k = part.from; k < part.to; k++) {
			if (tokens[k].type === 'ident' && (tokens[k].quoted || !isNoiseWord(tokens[k].upper))) {
				columns.push(tokens[k].value);
				break;
			}
		}
	}
	return { columns, next: close + 1 };
}

function isNoiseWord(upper: string): boolean {
	return upper === 'ASC' || upper === 'DESC' || upper === 'NULLS' || upper === 'FIRST' || upper === 'LAST';
}

/** Read a column declaration from a CREATE TABLE / ADD COLUMN body. */
function readColumn(sql: string, tokens: Token[], from: number, to: number): DeclaredColumn | undefined {
	if (from >= to || tokens[from].type !== 'ident') {
		return undefined;
	}
	// A table-level constraint, not a column.
	if (!tokens[from].quoted && DDL_KEYWORDS.has(tokens[from].upper)) {
		return undefined;
	}
	const name = tokens[from].value;
	let i = from + 1;
	const typeStart = i;
	while (i < to && !(tokens[i].type === 'ident' && !tokens[i].quoted && TYPE_STOP.has(tokens[i].upper) && tokens[i].depth === tokens[from].depth)) {
		i++;
	}
	const dataType = slice(sql, tokens, typeStart, i);

	const rest = tokens.slice(i, to);
	const upperRun = rest.map((t) => (t.quoted ? '' : t.upper));
	const has = (...words: string[]): boolean => {
		for (let k = 0; k + words.length <= upperRun.length; k++) {
			if (words.every((w, n) => upperRun[k + n] === w)) {
				return true;
			}
		}
		return false;
	};

	let defaultExpr: string | undefined;
	const defaultAt = upperRun.indexOf('DEFAULT');
	if (defaultAt !== -1) {
		// The default runs to the next attribute keyword at the same depth.
		let end = defaultAt + 1;
		while (end < rest.length && !(rest[end].type === 'ident' && !rest[end].quoted && TYPE_STOP.has(rest[end].upper) && rest[end].depth === rest[defaultAt].depth)) {
			end++;
		}
		defaultExpr = slice(sql, rest, defaultAt + 1, end);
	}

	let references: DeclaredColumn['references'];
	const refAt = upperRun.indexOf('REFERENCES');
	if (refAt !== -1) {
		const named = readQualifiedName(rest, refAt + 1);
		const list = readColumnList(rest, named.next);
		references = { table: named.name, columns: list.columns };
	}

	return {
		name,
		dataType,
		notNull: has('NOT', 'NULL'),
		hasDefault: defaultAt !== -1,
		defaultExpr,
		unique: has('UNIQUE'),
		primaryKey: has('PRIMARY', 'KEY'),
		autoIncrement:
			has('AUTO_INCREMENT') ||
			has('IDENTITY') ||
			has('GENERATED') ||
			/^(serial|bigserial|smallserial)/i.test(dataType),
		references,
	};
}

/** ALTER TABLE actions — one statement can carry several, comma-separated at depth 0. */
function readAlterActions(sql: string, tokens: Token[], from: number): AlterAction[] {
	const actions: AlterAction[] = [];
	for (const part of splitCommas(tokens, from, tokens.length, 0)) {
		const action = readAlterAction(sql, tokens, part.from, part.to);
		if (action) {
			actions.push(action);
		}
	}
	return actions;
}

function readAlterAction(sql: string, tokens: Token[], from: number, to: number): AlterAction | undefined {
	let i = from;
	const word = (k: number): string => (tokens[k] && !tokens[k].quoted ? tokens[k].upper : '');
	if (i >= to) {
		return undefined;
	}

	if (word(i) === 'ADD') {
		i++;
		if (word(i) === 'COLUMN') {
			i++;
		}
		if (word(i) === 'IF' && word(i + 1) === 'NOT' && word(i + 2) === 'EXISTS') {
			i += 3;
		}
		let constraintName: string | undefined;
		if (word(i) === 'CONSTRAINT') {
			constraintName = tokens[i + 1]?.value;
			i += 2;
		}
		if (word(i) === 'FOREIGN' && word(i + 1) === 'KEY') {
			const list = readColumnList(tokens, i + 2);
			const refAt = list.next + (word(list.next) === 'REFERENCES' ? 1 : 0);
			const named = readQualifiedName(tokens, refAt);
			const refCols = readColumnList(tokens, named.next);
			return { type: 'addForeignKey', name: constraintName, columns: list.columns, refTable: named.name, refColumns: refCols.columns };
		}
		if (word(i) === 'UNIQUE') {
			const openAt = word(i + 1) === 'KEY' || word(i + 1) === 'INDEX' ? i + 2 : i + 1;
			const at = tokens[openAt]?.value === '(' ? openAt : openAt + 1;
			const list = readColumnList(tokens, at);
			return { type: 'addUnique', name: constraintName, columns: list.columns };
		}
		if (word(i) === 'PRIMARY' && word(i + 1) === 'KEY') {
			const list = readColumnList(tokens, i + 2);
			return { type: 'addPrimaryKey', columns: list.columns };
		}
		if (word(i) === 'CHECK') {
			return { type: 'addCheck', name: constraintName, expression: slice(sql, tokens, i + 1, to) };
		}
		const column = readColumn(sql, tokens, i, to);
		if (column) {
			return { type: 'addColumn', column };
		}
		return { type: 'unrecognised', text: slice(sql, tokens, from, to) };
	}

	if (word(i) === 'DROP') {
		i++;
		if (word(i) === 'CONSTRAINT' || word(i) === 'FOREIGN' || word(i) === 'INDEX' || word(i) === 'KEY') {
			const skip = word(i) === 'FOREIGN' ? 2 : 1;
			let at = i + skip;
			if (word(at) === 'IF' && word(at + 1) === 'EXISTS') {
				at += 2;
			}
			return { type: 'dropConstraint', name: tokens[at]?.value ?? '' };
		}
		if (word(i) === 'COLUMN') {
			i++;
		}
		if (word(i) === 'IF' && word(i + 1) === 'EXISTS') {
			i += 2;
		}
		return tokens[i] ? { type: 'dropColumn', column: tokens[i].value } : undefined;
	}

	if (word(i) === 'RENAME') {
		i++;
		if (word(i) === 'COLUMN') {
			i++;
			const fromName = tokens[i]?.value ?? '';
			const toAt = word(i + 1) === 'TO' || word(i + 1) === 'AS' ? i + 2 : i + 1;
			return { type: 'renameColumn', from: fromName, to: tokens[toAt]?.value ?? '' };
		}
		if (word(i) === 'TO' || word(i) === 'AS') {
			i++;
		}
		return { type: 'renameTable', to: readQualifiedName(tokens, i).name };
	}

	// Postgres: ALTER COLUMN c SET/DROP NOT NULL | TYPE t | SET DEFAULT x
	if (word(i) === 'ALTER') {
		i++;
		if (word(i) === 'COLUMN') {
			i++;
		}
		const column = tokens[i]?.value ?? '';
		i++;
		if (word(i) === 'SET' && word(i + 1) === 'NOT' && word(i + 2) === 'NULL') {
			return { type: 'setNotNull', column };
		}
		if (word(i) === 'DROP' && word(i + 1) === 'NOT' && word(i + 2) === 'NULL') {
			return { type: 'dropNotNull', column };
		}
		if (word(i) === 'SET' && word(i + 1) === 'DEFAULT') {
			return { type: 'setDefault', column, defaultExpr: slice(sql, tokens, i + 2, to) };
		}
		if (word(i) === 'TYPE' || (word(i) === 'SET' && word(i + 1) === 'DATA' && word(i + 2) === 'TYPE')) {
			const at = word(i) === 'TYPE' ? i + 1 : i + 3;
			return { type: 'alterColumnType', column, dataType: slice(sql, tokens, at, to) };
		}
		return { type: 'unrecognised', text: slice(sql, tokens, from, to) };
	}

	// MySQL: MODIFY [COLUMN] c <type> …  /  CHANGE [COLUMN] old new <type> …
	if (word(i) === 'MODIFY' || word(i) === 'CHANGE') {
		const isChange = word(i) === 'CHANGE';
		i++;
		if (word(i) === 'COLUMN') {
			i++;
		}
		const fromName = tokens[i]?.value ?? '';
		if (isChange) {
			const newName = tokens[i + 1]?.value ?? '';
			if (newName !== '' && newName.toLowerCase() !== fromName.toLowerCase()) {
				return { type: 'renameColumn', from: fromName, to: newName };
			}
			i++;
		}
		const column = readColumn(sql, tokens, i, to);
		return column
			? { type: 'alterColumnType', column: column.name, dataType: column.dataType, notNull: column.notNull }
			: { type: 'unrecognised', text: slice(sql, tokens, from, to) };
	}

	return { type: 'unrecognised', text: slice(sql, tokens, from, to) };
}

/** Tables named in FROM / JOIN / UPDATE / INTO, with aliases. */
function readTables(tokens: Token[]): TableRef[] {
	const out: TableRef[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.type !== 'ident' || t.quoted) {
			continue;
		}
		const isSource = t.upper === 'FROM' || t.upper === 'JOIN' || t.upper === 'INTO' || t.upper === 'UPDATE';
		if (!isSource) {
			continue;
		}
		let at = i + 1;
		if (tokens[at]?.value === '(') {
			continue; // a subquery or a VALUES list, not a table name
		}
		if (tokens[at] && !tokens[at].quoted && (tokens[at].upper === 'ONLY' || tokens[at].upper === 'LATERAL')) {
			at++;
		}
		const named = readQualifiedName(tokens, at);
		if (named.name === '') {
			continue;
		}
		let alias: string | undefined;
		let next = named.next;
		if (tokens[next] && !tokens[next].quoted && tokens[next].upper === 'AS') {
			next++;
		}
		const cand = tokens[next];
		if (cand && cand.type === 'ident' && (cand.quoted || !isClauseWord(cand.upper))) {
			alias = cand.value;
		}
		const key = `${named.name}|${alias ?? ''}`;
		if (!seen.has(key)) {
			seen.add(key);
			out.push(alias ? { name: named.name, alias } : { name: named.name });
		}
	}
	return out;
}

const CLAUSE_WORDS = new Set([
	'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'ON', 'GROUP', 'ORDER', 'HAVING', 'LIMIT',
	'OFFSET', 'UNION', 'SET', 'VALUES', 'RETURNING', 'FETCH', 'FOR', 'WINDOW', 'USING', 'NATURAL', 'AS', 'SELECT',
	'INTO', 'FROM', 'AND', 'OR', 'NOT', 'WITH', 'STRAIGHT_JOIN', 'PARTITION', 'TABLESAMPLE',
]);

function isClauseWord(upper: string): boolean {
	return CLAUSE_WORDS.has(upper);
}

const COMPARISON = new Set(['=', '<', '>', '<=', '>=', '<>', '!=']);
const KEYWORD_OPS = new Set(['IN', 'LIKE', 'ILIKE', 'IS', 'BETWEEN', 'RLIKE', 'REGEXP']);

/** Words that read like a column reference but are a literal, a keyword or an operator. */
const NOT_A_COLUMN = new Set([
	'NULL', 'TRUE', 'FALSE', 'DEFAULT', 'DISTINCT', 'ANY', 'ALL', 'SOME', 'INTERVAL', 'CAST', 'CASE', 'WHEN', 'THEN',
	'ELSE', 'END', 'EXISTS', 'BY', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST', 'ESCAPE', 'COLLATE', 'SYMMETRIC', 'ROW',
	'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURRENT_USER', 'LOCALTIME', 'LOCALTIMESTAMP', 'UNKNOWN',
]);

/** One clause of a statement, and what a column found inside it means. */
interface Region {
	from: number;
	to: number;
	role: PredicateRef['role'];
}

/**
 * The clauses whose column references a reviewer cares about. A region runs from just after
 * its keyword to the next top-level clause keyword. Anything outside one — the SELECT list,
 * the VALUES of an INSERT — is deliberately ignored: a column that is merely projected says
 * nothing about which indexes the statement needs.
 */
function regionsOf(tokens: Token[]): Region[] {
	const regions: Region[] = [];
	let open: Region | undefined;
	const close = (at: number): void => {
		if (open) {
			open.to = at;
			if (open.to > open.from) {
				regions.push(open);
			}
			open = undefined;
		}
	};
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.type !== 'ident' || t.quoted) {
			continue;
		}
		if (t.upper === 'WHERE' || t.upper === 'HAVING') {
			close(i);
			open = { from: i + 1, to: tokens.length, role: 'where' };
			continue;
		}
		if (t.upper === 'ON' || t.upper === 'USING') {
			close(i);
			open = { from: i + 1, to: tokens.length, role: 'join' };
			continue;
		}
		if ((t.upper === 'ORDER' || t.upper === 'GROUP') && tokens[i + 1] && !tokens[i + 1].quoted && tokens[i + 1].upper === 'BY') {
			close(i);
			open = { from: i + 2, to: tokens.length, role: 'order' };
			continue;
		}
		if (['SELECT', 'FROM', 'SET', 'VALUES', 'LIMIT', 'OFFSET', 'RETURNING', 'UNION', 'WINDOW', 'FETCH'].includes(t.upper)) {
			close(i);
			continue;
		}
		if (['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'STRAIGHT_JOIN'].includes(t.upper)) {
			close(i);
		}
	}
	close(tokens.length);
	return regions;
}

/** Every column reference in [from, to), each marked when it sits inside a call. */
function refsIn(tokens: Token[], from: number, to: number): { qualifier?: string; column: string; wrapped: boolean }[] {
	const out: { qualifier?: string; column: string; wrapped: boolean }[] = [];
	for (let i = Math.max(0, from); i < Math.min(to, tokens.length); i++) {
		const t = tokens[i];
		if (t.type !== 'ident') {
			continue;
		}
		if (!t.quoted && (isClauseWord(t.upper) || NOT_A_COLUMN.has(t.upper) || KEYWORD_OPS.has(t.upper))) {
			continue;
		}
		if (tokens[i + 1] && tokens[i + 1].value === '(') {
			continue; // a function name, not a column
		}
		const named = readQualifiedName(tokens, i);
		if (named.name === '') {
			continue;
		}
		out.push({
			qualifier: named.parts.length > 1 ? named.parts[named.parts.length - 2] : undefined,
			column: named.parts[named.parts.length - 1],
			wrapped: isInsideCall(tokens, i),
		});
		i = named.next - 1;
	}
	return out;
}

/** Back from an operator to the start of its left operand. */
function operandStart(tokens: Token[], from: number, at: number, depth: number): number {
	for (let i = at; i >= from; i--) {
		const t = tokens[i];
		if (t.type === 'ident' && !t.quoted && (t.upper === 'AND' || t.upper === 'OR')) {
			return i + 1;
		}
		if (t.value === '(' && t.depth < depth) {
			return i + 1;
		}
	}
	return from;
}

/** Forward from an operator to the end of its right operand. */
function operandEnd(tokens: Token[], to: number, at: number, depth: number): number {
	for (let i = at; i < Math.min(to, tokens.length); i++) {
		const t = tokens[i];
		if (t.type === 'ident' && !t.quoted && (t.upper === 'AND' || t.upper === 'OR')) {
			return i;
		}
		if (t.value === ')' && t.depth < depth) {
			return i;
		}
	}
	return to;
}

/**
 * Columns compared in WHERE / ON / HAVING and ordered on in ORDER BY / GROUP BY.
 *
 * BOTH sides of every comparison are read. `ON c.id = o.customer_id` is a statement about an
 * index on `orders` exactly as much as one on `customers`, and the join key that turns out to
 * have no index behind it is as often the one written on the right.
 */
function readPredicates(tokens: Token[]): PredicateRef[] {
	const out: PredicateRef[] = [];
	const seen = new Set<string>();
	const add = (ref: { qualifier?: string; column: string; wrapped: boolean }, op: string, role: PredicateRef['role']): void => {
		const key = `${ref.qualifier ?? ''}.${ref.column}|${op}|${role}`.toLowerCase();
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		out.push({ qualifier: ref.qualifier, column: ref.column, op, role, wrapped: ref.wrapped });
	};

	for (const region of regionsOf(tokens)) {
		if (region.role === 'order') {
			for (const ref of refsIn(tokens, region.from, region.to)) {
				add(ref, 'ORDER', 'order');
			}
			continue;
		}
		for (let i = region.from; i < region.to; i++) {
			const t = tokens[i];
			let op = '';
			let rightFrom = i + 1;
			if (t.type === 'punct' && COMPARISON.has(t.value)) {
				op = t.value;
			} else if (t.type === 'ident' && !t.quoted && KEYWORD_OPS.has(t.upper)) {
				op = t.upper;
			} else if (
				t.type === 'ident' && !t.quoted && t.upper === 'NOT' &&
				tokens[i + 1] && !tokens[i + 1].quoted && KEYWORD_OPS.has(tokens[i + 1].upper)
			) {
				op = `NOT ${tokens[i + 1].upper}`;
				rightFrom = i + 2;
			}
			if (op === '') {
				continue;
			}
			for (const ref of refsIn(tokens, operandStart(tokens, region.from, i - 1, t.depth), i)) {
				add(ref, op, region.role);
			}
			for (const ref of refsIn(tokens, rightFrom, operandEnd(tokens, region.to, rightFrom, t.depth))) {
				add(ref, op, region.role);
			}
		}
	}
	return out;
}

/** True when token `i` sits inside a function call's parentheses. */
function isInsideCall(tokens: Token[], i: number): boolean {
	const depth = tokens[i].depth;
	if (depth === 0) {
		return false;
	}
	for (let k = i - 1; k >= 0; k--) {
		if (tokens[k].value === '(' && tokens[k].depth === depth - 1) {
			const before = tokens[k - 1];
			return !!before && before.type === 'ident' && !isClauseWord(before.upper) && !KEYWORD_OPS.has(before.upper);
		}
	}
	return false;
}

/** Resolve each predicate's qualifier through the statement's aliases. */
function resolveQualifiers(predicates: PredicateRef[], tables: TableRef[]): void {
	const byAlias = new Map<string, string>();
	for (const table of tables) {
		if (table.alias) {
			byAlias.set(table.alias.toLowerCase(), table.name);
		}
		byAlias.set(bareName(table.name).toLowerCase(), table.name);
	}
	const only = tables.length === 1 ? tables[0].name : undefined;
	for (const p of predicates) {
		if (p.qualifier) {
			p.table = byAlias.get(p.qualifier.toLowerCase());
		} else if (only) {
			p.table = only;
		}
	}
}

/** Read one statement. Never throws; an unrecognised statement comes back as `other`. */
export function parseStatement(sql: string): ParsedStatement {
	const tokens = tokenize(sql);
	const base: ParsedStatement = { kind: 'other', sql };
	if (tokens.length === 0) {
		return base;
	}
	const word = (k: number): string => (tokens[k] && tokens[k].type === 'ident' && !tokens[k].quoted ? tokens[k].upper : '');

	let i = 0;
	// Skip a leading CTE so `WITH x AS (…) SELECT` reads as a select.
	if (word(0) === 'WITH') {
		const at = findTopLevel(tokens, ['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
		if (at !== -1) {
			i = at;
		}
	}

	const head = word(i);

	if (head === 'BEGIN' || head === 'COMMIT' || head === 'ROLLBACK' || head === 'START' || head === 'SAVEPOINT') {
		return { ...base, kind: 'transaction' };
	}

	if (head === 'CREATE') {
		let at = i + 1;
		const unique = word(at) === 'UNIQUE';
		while (['UNIQUE', 'OR', 'REPLACE', 'TEMP', 'TEMPORARY', 'GLOBAL', 'LOCAL', 'UNLOGGED', 'MATERIALIZED', 'CLUSTERED', 'NONCLUSTERED', 'FULLTEXT', 'SPATIAL'].includes(word(at))) {
			at++;
		}
		const what = word(at);
		at++;
		const concurrently = word(at) === 'CONCURRENTLY';
		if (concurrently) {
			at++;
		}
		let ifNotExists = false;
		if (word(at) === 'IF' && word(at + 1) === 'NOT' && word(at + 2) === 'EXISTS') {
			ifNotExists = true;
			at += 3;
		}
		const named = readQualifiedName(tokens, at);
		at = named.next;

		if (what === 'INDEX') {
			// An unnamed index (`CREATE INDEX ON t (c)`) leaves `named` holding "ON".
			let onAt = at;
			let name: string | undefined = named.name;
			if (named.name.toUpperCase() === 'ON') {
				name = undefined;
				onAt = at - 1;
			}
			if (word(onAt) === 'ON') {
				onAt++;
			}
			const table = readQualifiedName(tokens, onAt);
			let listAt = table.next;
			if (word(listAt) === 'USING') {
				listAt += 2; // USING btree|gin|…
			}
			const list = readColumnList(tokens, listAt);
			return { ...base, kind: 'createIndex', object: name, onTable: table.name, indexColumns: list.columns, unique, concurrently, ifNotExists };
		}

		if (what === 'TABLE') {
			const openAt = tokens.findIndex((t, k) => k >= at && t.value === '(' && t.depth === 0);
			const columns: DeclaredColumn[] = [];
			if (openAt !== -1) {
				let close = openAt + 1;
				while (close < tokens.length && !(tokens[close].value === ')' && tokens[close].depth === 0)) {
					close++;
				}
				for (const part of splitCommas(tokens, openAt + 1, close, 1)) {
					const column = readColumn(sql, tokens, part.from, part.to);
					if (column) {
						columns.push(column);
					}
				}
			}
			return { ...base, kind: 'createTable', object: named.name, ifNotExists, columns };
		}

		if (what === 'VIEW') {
			return { ...base, kind: 'createView', object: named.name, ifNotExists, tables: readTables(tokens.slice(at)) };
		}
		return { ...base, partial: `CREATE ${what || '?'} is not modelled` };
	}

	if (head === 'DROP') {
		let at = i + 1;
		while (['MATERIALIZED', 'TEMP', 'TEMPORARY', 'CONCURRENTLY'].includes(word(at))) {
			at++;
		}
		const what = word(at);
		at++;
		if (word(at) === 'CONCURRENTLY') {
			at++;
		}
		let ifExists = false;
		if (word(at) === 'IF' && word(at + 1) === 'EXISTS') {
			ifExists = true;
			at += 2;
		}
		const named = readQualifiedName(tokens, at);
		const cascade = tokens.some((t) => t.type === 'ident' && !t.quoted && t.upper === 'CASCADE');
		if (what === 'TABLE') {
			return { ...base, kind: 'dropTable', object: named.name, ifExists, cascade };
		}
		if (what === 'INDEX') {
			// MySQL writes `DROP INDEX name ON table`; Postgres has no ON.
			let onTable: string | undefined;
			const onAt = named.next;
			if (word(onAt) === 'ON') {
				onTable = readQualifiedName(tokens, onAt + 1).name;
			}
			return { ...base, kind: 'dropIndex', object: named.name, onTable, ifExists, cascade };
		}
		if (what === 'VIEW') {
			return { ...base, kind: 'dropView', object: named.name, ifExists, cascade };
		}
		return { ...base, partial: `DROP ${what || '?'} is not modelled` };
	}

	if (head === 'ALTER' && word(i + 1) === 'TABLE') {
		let at = i + 2;
		if (word(at) === 'IF' && word(at + 1) === 'EXISTS') {
			at += 2;
		}
		if (word(at) === 'ONLY') {
			at++;
		}
		const named = readQualifiedName(tokens, at);
		const actions = readAlterActions(sql, tokens, named.next);
		const rename = actions.find((a) => a.type === 'renameTable');
		return {
			...base,
			kind: rename ? 'renameTable' : 'alterTable',
			object: named.name,
			actions,
			partial: actions.some((a) => a.type === 'unrecognised') ? 'part of the ALTER was not understood' : undefined,
		};
	}

	if (head === 'TRUNCATE') {
		const at = word(i + 1) === 'TABLE' ? i + 2 : i + 1;
		return { ...base, kind: 'truncate', object: readQualifiedName(tokens, at).name };
	}

	if (head === 'SELECT' || head === 'INSERT' || head === 'UPDATE' || head === 'DELETE' || head === 'MERGE') {
		const kind = head.toLowerCase() as 'select' | 'insert' | 'update' | 'delete' | 'merge';
		const tables = readTables(tokens);
		const predicates = readPredicates(tokens);
		resolveQualifiers(predicates, tables);
		const hasWhere = tokens.some((t) => t.type === 'ident' && !t.quoted && t.upper === 'WHERE');
		return {
			...base,
			kind,
			object: tables[0]?.name,
			tables,
			predicates,
			unfiltered: (kind === 'delete' || kind === 'update') && !hasWhere,
		};
	}

	return base;
}

/** First index of any of `words` at depth 0. */
function findTopLevel(tokens: Token[], words: string[]): number {
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.depth === 0 && t.type === 'ident' && !t.quoted && words.includes(t.upper)) {
			return i;
		}
	}
	return -1;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CompletionVerdict } from '../../ai';
import type { DatabaseSchema, TableInfo } from '../../schema';
import { splitStatementSpans, statementAt } from '../parse/sqlStatement';
import { closestIdentifier } from './schemaPrompt';

/*---------------------------------------------------------------------------------------------
 *  The inline-completion guard: what the model is allowed to insert, and where we ask it at all.
 *
 *  FIM assumes the answer is IN THE BUFFER. In a SQL editor the buffer is three lines and the
 *  answer lives in the SCHEMA, which a small base completer only sees as `--` comment lines it
 *  was never pretrained to treat as authoritative. So it free-associates: `from customer_` →
 *  an invented `customer_satisfaction_survey`. Two deterministic passes fix the two halves of that:
 *
 *    - {@link isCompletionPosition} — don't ASK the model where the deterministic schema
 *      completion (lspBridge) already knows the exact answer (mid-identifier, after a `.`,
 *      right after FROM/JOIN). That's the model's worst position and the LSP's best.
 *    - {@link guardCompletion} — don't SHOW an answer that names a table or column the schema
 *      doesn't have. Repair it to the real name when one is obviously meant, else cut the
 *      completion at the point it went wrong.
 *
 *  Both are pure and conservative by construction: every ambiguity resolves toward leaving the
 *  model's text alone, because a wrong truncation is worse than a hallucination the user can see.
 *--------------------------------------------------------------------------------------------*/

/** One hallucinated identifier the guard rewrote to a real one. */
export interface CompletionRepair {
	/** The identifier as the model wrote it. */
	from: string;
	/** The real schema identifier it was rewritten to. */
	to: string;
}

export interface CompletionGuardResult {
	/** The text to actually insert — repaired, truncated, or empty when rejected. */
	text: string;
	verdict: CompletionVerdict;
	/** Identifiers rewritten to real ones (empty unless `verdict` is `repaired`). */
	repairs: CompletionRepair[];
	/** The identifier the completion was cut at, when it was truncated or rejected. */
	cut?: string;
}

/** Keywords that put the NEXT identifier in table position. */
const TABLE_KEYWORDS = new Set(['from', 'join', 'into', 'update', 'table']);

/** Clause keywords that end a FROM list (so a following comma is no longer a table separator). */
const CLAUSE_KEYWORDS = new Set([
	'select', 'where', 'group', 'order', 'having', 'on', 'using', 'set', 'values', 'limit',
	'offset', 'union', 'intersect', 'except', 'returning', 'window', 'fetch',
]);

/**
 * Words that are never a table or column reference. Deliberately broad: a keyword we forget is
 * a false positive (the guard cuts good text), whereas a keyword we include only means one
 * fewer identifier is checked. Includes bare-word functions/constants (`current_date`) since
 * those aren't followed by `(` and would otherwise look like columns.
 */
const SQL_WORDS = new Set([
	'select', 'distinct', 'all', 'from', 'where', 'group', 'by', 'having', 'order', 'asc', 'desc',
	'limit', 'offset', 'fetch', 'first', 'next', 'rows', 'row', 'only', 'join', 'inner', 'outer',
	'left', 'right', 'full', 'cross', 'lateral', 'natural', 'on', 'using', 'as', 'and', 'or',
	'not', 'is', 'null', 'in', 'exists', 'between', 'like', 'ilike', 'rlike', 'regexp', 'similar',
	'escape', 'case', 'when', 'then', 'else', 'end', 'cast', 'union', 'intersect', 'except',
	'with', 'recursive', 'insert', 'into', 'values', 'update', 'set', 'delete', 'truncate',
	'create', 'alter', 'drop', 'table', 'view', 'index', 'unique', 'primary', 'key', 'foreign',
	'references', 'constraint', 'default', 'check', 'cascade', 'restrict', 'add', 'column',
	'rename', 'to', 'if', 'replace', 'temporary', 'temp', 'returning', 'over', 'partition',
	'window', 'range', 'unbounded', 'preceding', 'following', 'current', 'true', 'false',
	'unknown', 'interval', 'year', 'month', 'week', 'day', 'hour', 'minute', 'second',
	'current_date', 'current_time', 'current_timestamp', 'current_user', 'session_user',
	'localtime', 'localtimestamp', 'sysdate', 'systimestamp', 'dual', 'top', 'percent',
	'nulls', 'last', 'both', 'leading', 'trailing', 'for', 'of', 'no', 'some', 'any', 'exclude',
	'ties', 'within', 'filter', 'ordinality', 'collate', 'at', 'time', 'zone', 'without',
	// Common type names, so DDL/CAST targets aren't read as columns.
	'int', 'integer', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real',
	'double', 'precision', 'char', 'varchar', 'nvarchar', 'text', 'blob', 'clob', 'date',
	'datetime', 'timestamp', 'timestamptz', 'boolean', 'bool', 'bytea', 'uuid', 'json', 'jsonb',
	'serial', 'bigserial', 'money', 'binary', 'varbinary', 'enum', 'array',
	// Common function names. A call is normally recognised by the `(` that follows, but a space
	// before it (`count (*)`) would otherwise leave the name looking like a column.
	'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'ifnull', 'isnull', 'nullif', 'nvl',
	'concat', 'substring', 'substr', 'length', 'len', 'char_length', 'upper', 'lower', 'trim',
	'ltrim', 'rtrim', 'round', 'floor', 'ceil', 'ceiling', 'abs', 'mod', 'power', 'sqrt',
	'now', 'extract', 'datediff', 'dateadd', 'date_trunc', 'to_char', 'to_date', 'convert',
	'row_number', 'rank', 'dense_rank', 'lag', 'lead', 'greatest', 'least', 'group_concat',
	'string_agg', 'array_agg', 'json_extract', 'split_part', 'position', 'random', 'rand',
]);

type TokenKind = 'ident' | 'punct' | 'literal' | 'other';

interface Token {
	kind: TokenKind;
	/** The identifier as written, unquoted. */
	value: string;
	lower: string;
	start: number;
	end: number;
	/** True when the identifier was written quoted (`"x"`, `` `x` ``, `[x]`). */
	quoted: boolean;
}

/**
 * Tokenize SQL into identifiers, literals and punctuation, skipping comments. Not a parser — the
 * guard only needs to know which words are identifiers, which are made-up values, and what sits
 * either side of them.
 */
function tokenize(sql: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < sql.length) {
		const c = sql[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (c === '-' && sql[i + 1] === '-') {
			const nl = sql.indexOf('\n', i);
			i = nl < 0 ? sql.length : nl + 1;
			continue;
		}
		if (c === '/' && sql[i + 1] === '*') {
			const close = sql.indexOf('*/', i + 2);
			i = close < 0 ? sql.length : close + 2;
			continue;
		}
		if (c === "'") {
			const start = i;
			i++;
			while (i < sql.length) {
				if (sql[i] === "'" && sql[i + 1] === "'") {
					i += 2;
					continue;
				}
				if (sql[i] === "'") {
					i++;
					break;
				}
				i++;
			}
			out.push({ kind: 'literal', value: sql.slice(start, i), lower: '', start, end: i, quoted: false });
			continue;
		}
		if (c === '"' || c === '`' || c === '[') {
			const close = c === '[' ? ']' : c;
			const start = i;
			const end = sql.indexOf(close, i + 1);
			if (end < 0) {
				// Unterminated quote — the cursor is probably inside it; stop scanning.
				break;
			}
			const value = sql.slice(i + 1, end);
			out.push({ kind: 'ident', value, lower: value.toLowerCase(), start, end: end + 1, quoted: true });
			i = end + 1;
			continue;
		}
		if (/[0-9]/.test(c)) {
			const start = i;
			while (i < sql.length && /[0-9a-zA-Z_.]/.test(sql[i])) {
				i++;
			}
			out.push({ kind: 'literal', value: sql.slice(start, i), lower: '', start, end: i, quoted: false });
			continue;
		}
		if (/[A-Za-z_@#$]/.test(c)) {
			const start = i;
			while (i < sql.length && /[A-Za-z0-9_@#$]/.test(sql[i])) {
				i++;
			}
			const value = sql.slice(start, i);
			out.push({ kind: 'ident', value, lower: value.toLowerCase(), start, end: i, quoted: false });
			continue;
		}
		out.push({ kind: 'punct', value: c, lower: c, start: i, end: i + 1, quoted: false });
		i++;
	}
	return out;
}

/** What the statement around the cursor refers to, as far as we can tell without a real parser. */
interface Scope {
	/** Alias (lowercased) → the real table it names, or null when it resolves to nothing we know. */
	aliases: Map<string, TableInfo | null>;
	/** Real tables referenced by the statement. */
	tables: TableInfo[];
	/** True when the statement references something we can't resolve (a CTE, a temp table, a
	 *  derived table). Column checking is then OFF — we can't know what columns are legal. */
	open: boolean;
}

function findTable(schema: DatabaseSchema, name: string): TableInfo | undefined {
	const lower = name.toLowerCase();
	return schema.tables.find((t) => t.name.toLowerCase() === lower);
}

/**
 * Walk the statement's tokens and work out what tables/aliases are in scope. Sets
 * {@link Scope.open} whenever it meets a table-position name that isn't a real table (a CTE, a
 * derived table, a temp table), because from that point on we cannot say which columns are legal.
 */
function buildScope(tokens: Token[], schema: DatabaseSchema): Scope {
	const aliases = new Map<string, TableInfo | null>();
	const tables: TableInfo[] = [];
	let open = false;
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok.kind !== 'ident') {
			continue;
		}
		// `WITH x AS (…)` / `, x AS (…)` — a CTE name is a table we have no columns for.
		if (tok.lower === 'as' && tokens[i + 1]?.value === '(' && tokens[i - 1]?.kind === 'ident') {
			const prev = tokens[i - 1];
			if (!SQL_WORDS.has(prev.lower)) {
				aliases.set(prev.lower, null);
				open = true;
			}
			continue;
		}
		if (TABLE_KEYWORDS.has(tok.lower)) {
			const ref = tokens[i + 1];
			if (!ref || ref.kind !== 'ident' || SQL_WORDS.has(ref.lower)) {
				continue;
			}
			i = consumeTableRef(tokens, i + 1, schema, aliases, tables);
		}
	}
	// A second pass for comma-separated FROM lists (`FROM a, b c`): the first pass only follows
	// the keyword itself, so pick up the siblings here.
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].kind !== 'ident' || tokens[i].lower !== 'from') {
			continue;
		}
		let j = i + 1;
		while (j < tokens.length) {
			const tok = tokens[j];
			if (tok.kind === 'ident' && (CLAUSE_KEYWORDS.has(tok.lower) || TABLE_KEYWORDS.has(tok.lower))) {
				break;
			}
			if (tok.kind === 'punct' && tok.value === ',') {
				const ref = tokens[j + 1];
				if (ref && ref.kind === 'ident' && !SQL_WORDS.has(ref.lower)) {
					j = consumeTableRef(tokens, j + 1, schema, aliases, tables);
					continue;
				}
			}
			if (tok.kind === 'punct' && tok.value === '(') {
				open = true; // a derived table — unknown columns
			}
			j++;
		}
	}
	for (const value of aliases.values()) {
		if (value === null) {
			open = true;
		}
	}
	return { aliases, tables, open };
}

/**
 * Read one table reference at `at` (optionally schema-qualified, optionally aliased) into the
 * scope, and return the index of its last token. An unresolvable name registers as an open
 * alias, which switches column checking off for the whole statement.
 */
function consumeTableRef(tokens: Token[], at: number, schema: DatabaseSchema, aliases: Map<string, TableInfo | null>, tables: TableInfo[]): number {
	let i = at;
	let name = tokens[i].value;
	// `schema.table` — the last part is the table name.
	while (tokens[i + 1]?.value === '.' && tokens[i + 2]?.kind === 'ident') {
		name = tokens[i + 2].value;
		i += 2;
	}
	const table = findTable(schema, name);
	if (table && !tables.includes(table)) {
		tables.push(table);
	}
	aliases.set(name.toLowerCase(), table ?? null);
	// An optional alias follows, with or without AS.
	let aliasAt = i + 1;
	if (tokens[aliasAt]?.kind === 'ident' && tokens[aliasAt].lower === 'as') {
		aliasAt++;
	}
	const alias = tokens[aliasAt];
	if (alias && alias.kind === 'ident' && !SQL_WORDS.has(alias.lower)) {
		aliases.set(alias.lower, table ?? null);
		i = aliasAt;
	}
	return i;
}

/** Every identifier the USER typed (outside the completion), lowercased. Anything they already
 *  wrote is theirs — the guard never second-guesses it, which also covers schema gaps (a view we
 *  didn't introspect, a nested Mongo field, a function we don't know). */
function userVocabulary(tokens: Token[], from: number, to: number): Set<string> {
	const words = new Set<string>();
	for (const tok of tokens) {
		if (tok.kind === 'ident' && (tok.end <= from || tok.start >= to)) {
			words.add(tok.lower);
		}
	}
	return words;
}

/** Operators whose right-hand side is a value being compared against a column. `<=`/`>=`/`<>`/`!=`
 *  tokenize as two puncts, so matching the last character is enough. */
const COMPARISON_CHARS = new Set(['=', '<', '>']);

/** Keywords that introduce a value directly (`status LIKE 'a%'`, `total BETWEEN 1 AND 10`). */
const VALUE_KEYWORDS = new Set(['like', 'ilike', 'rlike', 'regexp', 'between']);

/** The identifier immediately before the nearest unclosed `(` at or before `idx` — so a literal
 *  can tell whether it sits inside an `IN (…)` list or a `VALUES (…)` row. */
function enclosingCallWord(tokens: Token[], idx: number): string | undefined {
	let depth = 0;
	for (let i = idx - 1; i >= 0; i--) {
		const tok = tokens[i];
		if (tok.kind !== 'punct') {
			continue;
		}
		if (tok.value === ')') {
			depth++;
			continue;
		}
		if (tok.value !== '(') {
			continue;
		}
		if (depth > 0) {
			depth--;
			continue;
		}
		// `values (` and `in (` both put the previous identifier right before the paren; an INSERT
		// column list (`insert into t (a, b) values …`) hits the table name instead, which is not
		// in the harmful set, so it correctly reads as "not a value position".
		const before = tokens[i - 1];
		return before && before.kind === 'ident' ? before.lower : undefined;
	}
	return undefined;
}

/**
 * Whether the literal at `idx` is a value the model invented in a position where being wrong is
 * silent and costly: the right-hand side of a comparison, a LIKE/BETWEEN operand, an `IN (…)`
 * member, or an INSERT `VALUES (…)` row. `where primary_phone = '789-456-1234'` looks perfectly
 * valid and quietly returns nothing.
 *
 * Two escapes keep it from firing on harmless constants. A literal that appears verbatim in the
 * user's own CURRENT STATEMENT is not invented — they already wrote that value there, so repeating
 * it is inference, not fabrication (`documentText` is statement-scoped for exactly this reason; see
 * the call site). And every other position (`LIMIT 10`, `THEN 1`, `INTERVAL '7 day'`, a function
 * argument) is left alone: those are conventions, not filters, and cutting them would only make
 * the ghost text worse.
 */
function isFabricatedValue(tokens: Token[], idx: number, documentText: string): boolean {
	const literal = tokens[idx].value;
	if (documentText.includes(literal)) {
		return false;
	}
	const prev = tokens[idx - 1];
	if (prev) {
		if (prev.kind === 'punct' && COMPARISON_CHARS.has(prev.value)) {
			return true;
		}
		if (prev.kind === 'ident' && VALUE_KEYWORDS.has(prev.lower)) {
			return true;
		}
	}
	const enclosing = enclosingCallWord(tokens, idx);
	return enclosing === 'in' || enclosing === 'values';
}

/** The offset where the dotted reference ending at `idx` begins, so cutting a bad qualified
 *  column (`o.shipping_country`) removes the whole reference rather than leaving a stray `o.`. */
function referenceStart(tokens: Token[], idx: number): number {
	let i = idx;
	while (i >= 2 && tokens[i - 1].kind === 'punct' && tokens[i - 1].value === '.' && tokens[i - 2].kind === 'ident') {
		i -= 2;
	}
	return tokens[i].start;
}

/** True when the identifier at `idx` is a function call (`name(`) — never a column. */
function isCall(tokens: Token[], idx: number): boolean {
	const next = tokens[idx + 1];
	return !!next && next.kind === 'punct' && next.value === '(' && next.start === tokens[idx].end;
}

/** True when the identifier at `idx` is being DEFINED as an alias rather than referencing
 *  something: `… AS x`, `count(*) x`, `users u`. A column never directly follows a `)` or a
 *  non-keyword identifier, so those positions are aliases and the schema has no say in them. */
function isAliasDefinition(tokens: Token[], idx: number): boolean {
	const prev = tokens[idx - 1];
	if (!prev) {
		return false;
	}
	if (prev.kind === 'ident') {
		return prev.lower === 'as' || !SQL_WORDS.has(prev.lower);
	}
	return prev.kind === 'punct' && prev.value === ')';
}

/** The identifier is in table position: the previous meaningful token is FROM/JOIN/INTO/UPDATE,
 *  or a `.` whose qualifier follows one of those (a schema-qualified name). */
function isTablePosition(tokens: Token[], idx: number): boolean {
	const prev = tokens[idx - 1];
	if (!prev) {
		return false;
	}
	if (prev.kind === 'ident' && TABLE_KEYWORDS.has(prev.lower)) {
		return true;
	}
	if (prev.kind === 'punct' && prev.value === '.') {
		const qualifier = tokens[idx - 2];
		const beforeQualifier = tokens[idx - 3];
		return !!qualifier && !!beforeQualifier && beforeQualifier.kind === 'ident' && TABLE_KEYWORDS.has(beforeQualifier.lower);
	}
	return false;
}

/**
 * Validate (and where possible repair) a model completion against the schema it was grounded in.
 *
 * Only identifiers the COMPLETION introduces are checked — never the user's own text. A name in
 * table position that doesn't exist is rewritten to the closest real table, or the completion is
 * cut there. A bare or qualified column that no in-scope table has is treated the same way.
 * Column checking is skipped entirely when the statement's scope is uncertain (a CTE, a derived
 * table, no resolvable table at all), so the guard errs toward silence rather than mangling.
 *
 * `text` is the already-syntax-cleaned completion (see `extractCompletion`); `prefix`/`suffix`
 * are the document either side of the cursor, exactly as sent to the model.
 */
export function guardCompletion(text: string, prefix: string, suffix: string, schema: DatabaseSchema | null): CompletionGuardResult {
	const clean: CompletionGuardResult = { text, verdict: 'clean', repairs: [] };
	if (!text.trim() || !schema || schema.tables.length === 0) {
		return clean;
	}
	// Scan the statement the cursor sits in, with the completion spliced in — so the guard sees
	// the FROM clause the suffix supplies and the aliases the prefix declared.
	const document = `${prefix}${text}${suffix}`;
	const from = prefix.length;
	const to = prefix.length + text.length;
	const span = splitStatementSpans(document).find((s) => s.end >= from && s.start <= to);
	const statement = span ? document.slice(span.start, span.end) : document;
	const base = span ? span.start : 0;
	const tokens = tokenize(statement).map((t) => ({ ...t, start: t.start + base, end: t.end + base }));

	const scope = buildScope(tokens, schema);
	const vocabulary = userVocabulary(tokens, from, to);
	// Whether a LITERAL was derived from what the user wrote, judged against the current STATEMENT
	// only — not the whole file. Scoping this to the document was the loophole that let the headline
	// failure through: `select * from cus‸` completed to `… where last_update > '2023-10-16'`, a date
	// the user had typed 36 lines earlier in a query against a different table. A value from an
	// unrelated statement is a guess about THIS one, and a wrong date filter fails silently.
	//
	// Note the deliberate asymmetry with `vocabulary` above, which stays document-wide: an
	// IDENTIFIER the user typed anywhere is evidence that name exists in this database (covering
	// schema gaps like an un-introspected view), whereas a VALUE is only ever evidence about the
	// query it appears in.
	const statementVocabulary = `${statement.slice(0, from - base)}
${statement.slice(to - base)}`;
	const tableNames = schema.tables.map((t) => t.name);
	const columnsInScope = new Map<string, string>(); // lowercased → original casing
	for (const table of scope.tables) {
		for (const column of table.columns) {
			columnsInScope.set(column.name.toLowerCase(), column.name);
		}
	}
	const checkColumns = !scope.open && scope.tables.length > 0 && columnsInScope.size > 0;

	const repairs: CompletionRepair[] = [];
	const edits: { start: number; end: number; to: string }[] = [];
	let cutAt: number | undefined;
	let cutWord: string | undefined;

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (cutAt !== undefined) {
			break;
		}
		// Only what the completion itself introduced, and only whole tokens (one the user started
		// and the model finished belongs to neither — leave it alone).
		if (tok.start < from || tok.end > to) {
			continue;
		}
		// A VALUE the model made up. It cannot be in the schema and it is not in the buffer, so
		// there is nothing it could be derived from — it is pure invention, and in a predicate or
		// an INSERT that silently produces the wrong rows. Cut it and let the user type the value.
		if (tok.kind === 'literal') {
			if (isFabricatedValue(tokens, i, statementVocabulary)) {
				cutAt = tok.start;
				cutWord = tok.value;
			}
			continue;
		}
		if (tok.kind !== 'ident') {
			continue;
		}
		if (tok.quoted || SQL_WORDS.has(tok.lower) || vocabulary.has(tok.lower) || isCall(tokens, i) || isAliasDefinition(tokens, i)) {
			continue;
		}
		const next = tokens[i + 1];
		const qualifier = tokens[i - 1]?.value === '.' ? tokens[i - 2] : undefined;

		if (isTablePosition(tokens, i)) {
			// `FROM db.table` / `FROM schema.table` — this is the qualifier, not the table. The
			// database or schema name is not in `schema.tables`, so checking it here would reject
			// a perfectly good qualified reference; the real name after the dot is checked instead.
			if (next && next.kind === 'punct' && next.value === '.') {
				continue;
			}
			if (findTable(schema, tok.value)) {
				continue;
			}
			const target = closestIdentifier(tok.lower, tableNames);
			if (target) {
				repairs.push({ from: tok.value, to: target });
				edits.push({ start: tok.start, end: tok.end, to: target });
			} else {
				cutAt = tok.start;
				cutWord = tok.value;
			}
			continue;
		}
		// A qualifier (`x` in `x.col`): must be an alias, a real table, or the user's own word.
		if (next && next.kind === 'punct' && next.value === '.' && next.start === tok.end) {
			if (scope.aliases.has(tok.lower) || findTable(schema, tok.value)) {
				continue;
			}
			const target = closestIdentifier(tok.lower, [...scope.aliases.keys(), ...tableNames]);
			if (target) {
				repairs.push({ from: tok.value, to: target });
				edits.push({ start: tok.start, end: tok.end, to: target });
			} else {
				cutAt = tok.start;
				cutWord = tok.value;
			}
			continue;
		}
		// A qualified column (`col` in `x.col`): check against that alias's table only.
		if (qualifier && qualifier.kind === 'ident') {
			const owner = scope.aliases.get(qualifier.lower) ?? findTable(schema, qualifier.value) ?? null;
			if (!owner) {
				continue; // unknown owner — nothing to check against
			}
			const names = owner.columns.map((c) => c.name);
			if (names.some((n) => n.toLowerCase() === tok.lower)) {
				continue;
			}
			const target = closestIdentifier(tok.lower, names);
			if (target) {
				repairs.push({ from: tok.value, to: target });
				edits.push({ start: tok.start, end: tok.end, to: target });
			} else {
				// Cut the whole `alias.column` reference — a trailing `o.` is no use as ghost text.
				cutAt = Math.max(from, referenceStart(tokens, i));
				cutWord = tok.value;
			}
			continue;
		}
		// A bare column.
		if (!checkColumns || columnsInScope.has(tok.lower)) {
			continue;
		}
		const target = closestIdentifier(tok.lower, [...columnsInScope.values()]);
		if (target) {
			repairs.push({ from: tok.value, to: target });
			edits.push({ start: tok.start, end: tok.end, to: target });
		} else {
			cutAt = tok.start;
			cutWord = tok.value;
		}
	}

	if (repairs.length === 0 && cutAt === undefined) {
		return clean;
	}
	// Cut FIRST (so offsets in the kept head still line up with the original text), then apply
	// the repairs right-to-left so each edit's offsets stay valid as earlier ones shift the tail.
	const limit = cutAt === undefined ? to : cutAt;
	let out = text.slice(0, limit - from);
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
		if (edit.end > limit) {
			continue; // inside the part we just cut
		}
		out = `${out.slice(0, edit.start - from)}${edit.to}${out.slice(edit.end - from)}`;
	}
	if (cutAt !== undefined) {
		// A cut always lands mid-expression, so any trailing separator/operator is left dangling
		// (`status = `, `name, `) — drop it so the ghost text ends on something complete.
		out = out.replace(/[\s,=<>!+\-*/|%^~.(]+$/, '');
		if (!out.trim()) {
			return { text: '', verdict: 'rejected', repairs, cut: cutWord };
		}
		return { text: out, verdict: 'truncated', repairs, cut: cutWord };
	}
	return { text: out, verdict: 'repaired', repairs };
}

/**
 * Whether the cursor is a position worth spending a model call on (auto-trigger only — an
 * explicit Alt+\ always goes through).
 *
 * The deterministic schema completion in `lspBridge.ts` knows every table and column EXACTLY.
 * Firing the model in the positions it owns is the worst possible division of labour: the model
 * guesses at something already known, and its guess is what the user sees. So we stay out of:
 * mid-identifier, right after a `.`, right after FROM/JOIN/INTO/UPDATE, inside a string or a
 * comment. What's left is where FIM can genuinely add something a symbol list can't: a clause
 * body, a JOIN condition, a predicate, the rest of a SELECT list.
 */
export function isCompletionPosition(prefix: string, suffix: string): boolean {
	if (!prefix.trim()) {
		return false; // an empty buffer gives the model nothing to condition on
	}
	const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
	if (/--/.test(line)) {
		return false; // inside a line comment
	}
	const openBlock = prefix.lastIndexOf('/*');
	if (openBlock >= 0 && prefix.indexOf('*/', openBlock) < 0) {
		return false; // inside a block comment
	}
	if (unterminatedQuote(prefix)) {
		return false; // inside a string or a quoted identifier
	}
	// Nothing typed for the CURRENT statement — the cursor sits after a `;` or a blank line, so
	// there is no gap to fill. A completion here isn't filling in the middle, it's inventing the
	// user's next query out of nothing: `select * from customer;‸` → a whole fabricated statement.
	// That's what Ctrl+K generate is for. An explicit Alt+\ still reaches it.
	if (currentStatementTail(prefix).trim() === '') {
		return false;
	}
	const last = prefix[prefix.length - 1];
	if (/[A-Za-z0-9_@#$]/.test(last)) {
		return false; // mid-identifier — the LSP has the exact name
	}
	if (last === '.' || last === '"' || last === '`' || last === '[') {
		return false; // qualified-column or quoted-identifier position — also the LSP's
	}
	// Right after FROM/JOIN/INTO/UPDATE the answer is a table name, which the LSP lists exactly.
	const trailingWord = /([A-Za-z_][A-Za-z0-9_]*)[\s(]*$/.exec(prefix);
	if (trailingWord && TABLE_KEYWORDS.has(trailingWord[1].toLowerCase())) {
		return false;
	}
	return true;
}

/**
 * The part of `prefix` belonging to the statement the cursor is in: what follows the last `;` or
 * the last blank line, whichever is later. Those are the same boundaries the runner splits on
 * (`splitStatementSpans`), so "the statement I'm typing" means the same thing here as when the
 * user hits Ctrl+Enter. A `;` inside a string literal can shift this, which only ever makes the
 * tail look longer — i.e. errs toward still offering a completion.
 */
function currentStatementTail(prefix: string): string {
	const semi = prefix.lastIndexOf(';');
	const blank = prefix.search(/\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/);
	const start = Math.max(semi + 1, blank < 0 ? 0 : blank);
	return prefix.slice(start);
}

/**
 * The text a completion should be ranked against: the STATEMENT the cursor is in, not a window of
 * the buffer around it.
 *
 * This is not a detail. Ranking used `prefix.slice(-1000) + suffix.slice(0, 500)`, so on a scratch
 * pad full of unrelated SQL every table named anywhere nearby scored a whole-word hit (50) while
 * the fragment actually under the cursor scored ~24 — `select * from cus‸` ranked `voucher` and
 * `delivery` above `customer` purely because earlier statements mentioned them. The statement you
 * are typing is the question; the rest of the file is not.
 *
 * Falls back to the old window when the buffer has no statement boundary to cut on.
 */
export function completionFocus(prefix: string, suffix: string, fallbackChars = 1000): string {
	const statement = statementAt(`${prefix}${suffix}`, prefix.length);
	return statement.trim() ? statement : `${prefix.slice(-fallbackChars)} ${suffix.slice(0, fallbackChars / 2)}`;
}

/**
 * The identifier fragment the cursor sits in the middle of (`… from cus‸` → `cus`), or "" when the
 * cursor is not inside a word. This is the single most informative thing about a completion
 * position and the hardest for whole-token matching to use, so the schema ranker and the history
 * ranker both take it and match by PREFIX. Shared from here because it is cursor analysis, the
 * same family as {@link isCompletionPosition}.
 */
export function partialIdentifier(prefix: string): string {
	const match = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(prefix);
	const word = match ? match[1].toLowerCase() : '';
	return word.length >= 2 ? word : '';
}

/** True when `text` ends inside an unclosed `'`, `"`, `` ` `` or `[`. */
function unterminatedQuote(text: string): boolean {
	let quote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote) {
				// `''` inside a string is an escaped quote, not the end.
				if (quote === "'" && text[i + 1] === "'") {
					i++;
					continue;
				}
				quote = null;
			}
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			continue;
		}
		if (c === '[') {
			quote = ']';
			continue;
		}
		if (c === '-' && text[i + 1] === '-') {
			const nl = text.indexOf('\n', i);
			if (nl < 0) {
				return false;
			}
			i = nl;
		}
	}
	return quote !== null;
}

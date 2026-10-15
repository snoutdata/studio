/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pragmatic SQL analysis for completion and hover (ROADMAP phases c/d). Not a full
// grammar, but paren-aware: it isolates the statement around the cursor, parses a
// leading WITH (CTEs) and derived tables (`FROM (SELECT …) x`) via balanced-paren
// scanning, resolves the in-scope FROM/JOIN clause into table references, and
// classifies what the cursor is completing. Ambiguity diagnostics remain deferred.

/** A relation named in a FROM/JOIN clause: a base table, a CTE/derived alias. */
export interface FromRef {
	table: string;
	schema?: string;
	alias?: string;
	/** Set for a derived table `FROM (SELECT …) x`: its projected columns + inner FROM. */
	derived?: { columns?: string[]; from: FromRef[] };
}

/** A common table expression: its name, projected columns, and inner FROM refs. */
export interface Cte {
	name: string;
	/** Explicit/derived column names; undefined when the body projects `*`. */
	columns?: string[];
	/** Inner FROM relations, used to expand `*` and for hover. */
	from: FromRef[];
}

/**
 * A position where the only sensible suggestion comes from the ENGINE'S OWN CATALOG, not from the
 * schema: the name after `SETTINGS`, the format after `FORMAT`, the engine after `ENGINE =`, the
 * type in a column definition. Nothing else belongs there, so these contexts are exclusive — no
 * columns, no tables, no keywords.
 */
export type CatalogSlot = 'setting' | 'format' | 'engine' | 'dataType';

/**
 * A ClickHouse dictionary argument: the cursor is inside the STRING LITERAL that names a
 * dictionary, or the one that names the attribute to read from it.
 *
 * `dictGet('shop.country_names', 'name', code)` is the only place in the language where a schema
 * object is addressed by a quoted string rather than by an identifier, so nothing else in the
 * analyzer sees it and a name typed wrong there is a runtime error rather than a red squiggle.
 */
export type DictionarySlot = 'name' | 'attribute';

/**
 * What the cursor is completing:
 * - `qualifier`: just after `x.` — complete `x`'s columns (or `x`'s tables if `x`
 *   is a database/schema).
 * - `table`: a table position (after FROM/JOIN/INTO/UPDATE); `joining` is set when
 *   it follows JOIN, which adds FK-derived join suggestions.
 * - `catalog`: one of the engine-catalog slots above, and nothing else.
 * - `dictionary`: inside a `dictGet` argument — dictionary names, or one dictionary's attributes.
 * - `expression`: anywhere else (SELECT list, WHERE, …) — keywords + in-scope columns.
 *
 * `word` is the partial identifier typed at the cursor (empty when none). The schema-derived
 * suggestions ignore it and let the editor filter, which is how this has always worked; the engine
 * catalog cannot, because it runs to thousands of names and sending them all on every keystroke is
 * a quarter-megabyte of IPC for a list the editor would throw away.
 */
export type CompletionContext =
	| { kind: 'qualifier'; qualifier: string; qualifierPath?: string[]; from: FromRef[]; ctes: Cte[]; word: string; followedByParen?: boolean }
	| { kind: 'table'; from: FromRef[]; ctes: Cte[]; joining: boolean; word: string; followedByParen?: boolean }
	| { kind: 'catalog'; slot: CatalogSlot; from: FromRef[]; ctes: Cte[]; word: string; followedByParen?: boolean }
	| { kind: 'dictionary'; slot: DictionarySlot; dictionary?: string; from: FromRef[]; ctes: Cte[]; word: string; followedByParen?: boolean }
	| { kind: 'expression'; from: FromRef[]; ctes: Cte[]; word: string; followedByParen?: boolean };

/** Words that follow a table but are not its alias. */
const RESERVED_AFTER_TABLE = new Set([
	'as', 'on', 'using', 'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'outer',
	'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'window', 'for', 'set',
	'and', 'or', 'select', 'from',
]);

/** Major clauses that end the FROM region (matched at top level only). */
const FROM_BOUNDARY = /\b(where|group\s+by|order\s+by|having|limit|offset|union|window|returning|for\s+update|set)\b/gi;

function unquote(identifier: string): string {
	return identifier.replace(/^[`"[]/, '').replace(/[`"\]]$/, '').trim();
}

/**
 * One identifier AS WRITTEN: a quoted one, or a bare word.
 *
 * A quoted identifier is matched whole, contents and all, because a name only needs quoting when it
 * holds characters SQL reserves — and the names that do are exactly the ones this had been failing
 * on: a cloud log scope (`"/aws/lambda/checkout"`, `"Microsoft.Web/sites"`), a hyphenated table, a
 * column with a dot in it. The old character class stopped at the first `/`, so the FROM clause
 * resolved to nothing and a WHERE offered no columns at all.
 */
const IDENT = '(?:"[^"]*"|`[^`]*`|\\[[^\\]]*\\]|[\\w$]+)';

/** `table`, `schema.table`, either side quoted, with an optional (AS) alias after it. */
const TABLE_REF = new RegExp(`^(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?(?:\\s+(?:as\\s+)?(${IDENT}))?`, 'i');

/** A blank line (a newline, only-whitespace, another newline): a soft statement separator. */
const BLANK_LINE = /\n[ \t\r]*\n/g;

/**
 * The statement containing `offset`, plus the offset within it. Bounded first by `;`, then
 * narrowed to the blank-line-delimited block around the cursor: scratch editors routinely
 * hold several statements separated only by a blank line (no trailing `;`), and without this
 * they merge into one, so FROM resolution latches onto the first (wrong) query's table and
 * the cursor's own table never enters scope. Narrowing to the block also contains an
 * unbalanced paren in a neighbouring statement, which would otherwise hide the FROM keyword.
 */
export function statementAt(text: string, offset: number): { text: string; offset: number } {
	let start = text.lastIndexOf(';', Math.max(0, offset - 1)) + 1;
	let end = text.indexOf(';', offset);
	if (end === -1) {
		end = text.length;
	}
	// Pull `start` forward past the last blank line before the cursor, within the `;` region.
	const before = text.slice(start, offset);
	BLANK_LINE.lastIndex = 0;
	let match: RegExpExecArray | null;
	let blockStart = 0;
	while ((match = BLANK_LINE.exec(before))) {
		blockStart = match.index + match[0].length;
	}
	start += blockStart;
	// Pull `end` back to the first blank line after the cursor.
	BLANK_LINE.lastIndex = 0;
	const after = BLANK_LINE.exec(text.slice(offset, end));
	if (after) {
		end = offset + after.index;
	}
	return { text: text.slice(start, end), offset: offset - start };
}

/** Index of the matching `)` for the `(` at `open`, or -1. */
function matchParen(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === '(') {
			depth++;
		} else if (text[i] === ')' && --depth === 0) {
			return i;
		}
	}
	return -1;
}

/** Paren depth at `index` (number of unclosed `(` before it). */
function parenDepthAt(text: string, index: number): number {
	let depth = 0;
	for (let i = 0; i < index; i++) {
		if (text[i] === '(') {
			depth++;
		} else if (text[i] === ')') {
			depth--;
		}
	}
	return depth;
}

/** Split on top-level (depth-0) commas. */
function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '(') {
			depth++;
		} else if (text[i] === ')') {
			depth--;
		} else if (text[i] === ',' && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts.filter((part) => part.trim().length > 0);
}

/** Index of a top-level (depth-0) keyword, or -1. */
function topLevelKeyword(text: string, keyword: string): number {
	const re = new RegExp(`\\b${keyword}\\b`, 'gi');
	let match: RegExpExecArray | null;
	while ((match = re.exec(text))) {
		if (parenDepthAt(text, match.index) === 0) {
			return match.index;
		}
	}
	return -1;
}

/** Output name of a projection item: its AS alias, `t.col`→`col`, or undefined. */
function columnName(item: string): string | undefined {
	const trimmed = item.trim().replace(/\s+/g, ' ');
	const asAlias = /\bas\s+([`"[\]\w$]+)$/i.exec(trimmed);
	if (asAlias) {
		return unquote(asAlias[1]);
	}
	if (/^[`"[\]\w$]+(\s*\.\s*[`"[\]\w$]+)?$/.test(trimmed)) {
		const parts = trimmed.split('.').map(unquote);
		return parts[parts.length - 1];
	}
	return undefined;
}

/** Best-effort projected column names of a SELECT body; undefined if it projects `*`. */
function projectedColumns(body: string): string[] | undefined {
	const select = /\bselect\b/i.exec(body);
	if (!select) {
		return undefined;
	}
	const afterSelect = body.slice(select.index + select[0].length);
	const distinct = /^\s*distinct\s+/i.exec(afterSelect);
	const projectionStart = distinct ? distinct[0].length : 0;
	const fromIndex = topLevelKeyword(afterSelect, 'from');
	const projection = fromIndex === -1 ? afterSelect.slice(projectionStart) : afterSelect.slice(projectionStart, fromIndex);

	const names: string[] = [];
	for (const item of splitTopLevel(projection)) {
		const trimmed = item.trim();
		if (trimmed === '*' || /\.\*$/.test(trimmed)) {
			return undefined;
		}
		const name = columnName(trimmed);
		if (name) {
			names.push(name);
		}
	}
	return names.length ? names : undefined;
}

/** Slice `text` up to the first top-level FROM-clause boundary keyword. */
function sliceToBoundary(text: string): string {
	FROM_BOUNDARY.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = FROM_BOUNDARY.exec(text))) {
		if (parenDepthAt(text, match.index) === 0) {
			return text.slice(0, match.index);
		}
	}
	return text;
}

/** Parse one FROM-clause segment into a base-table or derived-table reference. */
function parseTableSegment(segment: string): FromRef | undefined {
	const trimmed = segment.replace(/^\s+/, '');
	if (trimmed.startsWith('(')) {
		const close = matchParen(trimmed, 0);
		if (close === -1) {
			return undefined;
		}
		const body = trimmed.slice(1, close);
		const alias = /^\s*(?:as\s+)?([`"[\]\w$]+)/i.exec(trimmed.slice(close + 1));
		if (!alias) {
			return undefined;
		}
		const name = unquote(alias[1]);
		return { table: name, alias: name, derived: { columns: projectedColumns(body), from: resolveFromClause(body) } };
	}

	const ref = TABLE_REF.exec(trimmed);
	if (!ref) {
		return undefined;
	}
	const table = unquote(ref[2] ?? ref[1]);
	const schema = ref[2] ? unquote(ref[1]) : undefined;
	if (!table) {
		return undefined;
	}
	let alias = ref[3] ? unquote(ref[3]) : undefined;
	if (alias && RESERVED_AFTER_TABLE.has(alias.toLowerCase())) {
		alias = undefined;
	}
	return { table, schema, alias };
}

/** Split a FROM region into table segments at top-level JOINs and commas. */
function parseFromRegion(region: string): FromRef[] {
	const cuts: Array<{ start: number; end: number }> = [];
	const joins = /\bjoin\b/gi;
	let match: RegExpExecArray | null;
	while ((match = joins.exec(region))) {
		if (parenDepthAt(region, match.index) === 0) {
			cuts.push({ start: match.index, end: match.index + match[0].length });
		}
	}
	for (let i = 0; i < region.length; i++) {
		if (region[i] === ',' && parenDepthAt(region, i) === 0) {
			cuts.push({ start: i, end: i + 1 });
		}
	}
	cuts.sort((a, b) => a.start - b.start);

	const refs: FromRef[] = [];
	let cursor = 0;
	for (const cut of cuts) {
		const ref = parseTableSegment(region.slice(cursor, cut.start));
		if (ref) {
			refs.push(ref);
		}
		cursor = cut.end;
	}
	const last = parseTableSegment(region.slice(cursor));
	if (last) {
		refs.push(last);
	}
	return refs;
}

/** Resolve the table references named in a (single, top-level) FROM clause. */
export function resolveFromClause(statement: string): FromRef[] {
	const fromIndex = topLevelKeyword(statement, 'from');
	if (fromIndex === -1) {
		return [];
	}
	return parseFromRegion(sliceToBoundary(statement.slice(fromIndex + 'from'.length)));
}

/**
 * Resolve the target table(s) of an `UPDATE <table> [alias] SET …` statement — the
 * relations named between UPDATE and SET (SET is a FROM-boundary keyword, so
 * {@link sliceToBoundary} stops there). Multi-table updates (`UPDATE a JOIN b …`) are
 * split like a FROM region. Unlike SELECT, an UPDATE's table is not introduced by FROM,
 * so its SET/WHERE columns would otherwise have nothing in scope.
 */
export function resolveUpdateClause(statement: string): FromRef[] {
	const updateIndex = topLevelKeyword(statement, 'update');
	if (updateIndex === -1) {
		return [];
	}
	return parseFromRegion(sliceToBoundary(statement.slice(updateIndex + 'update'.length)));
}

/** The relations in scope for completion: a FROM clause, else an UPDATE target. */
export function resolveStatementRelations(statement: string): FromRef[] {
	const from = resolveFromClause(statement);
	return from.length ? from : resolveUpdateClause(statement);
}

/** Parse a leading `WITH … AS ( … )` chain; returns the CTEs and where the main query starts. */
export function parseStatement(statement: string): { ctes: Cte[]; mainOffset: number } {
	const head = /^\s*with\s+(?:recursive\s+)?/i.exec(statement);
	if (!head) {
		return { ctes: [], mainOffset: 0 };
	}
	const ctes: Cte[] = [];
	let i = head[0].length;
	while (i < statement.length) {
		const name = /^\s*([`"[\]\w$]+)\s*/.exec(statement.slice(i));
		if (!name) {
			break;
		}
		i += name[0].length;

		let explicitColumns: string[] | undefined;
		if (statement[i] === '(') {
			const close = matchParen(statement, i);
			if (close === -1) {
				break;
			}
			explicitColumns = splitTopLevel(statement.slice(i + 1, close)).map((c) => unquote(c));
			i = close + 1;
		}

		const as = /^\s*as\s*/i.exec(statement.slice(i));
		if (!as) {
			break;
		}
		i += as[0].length;
		while (i < statement.length && /\s/.test(statement[i])) {
			i++;
		}
		if (statement[i] !== '(') {
			break;
		}
		const close = matchParen(statement, i);
		if (close === -1) {
			break;
		}
		const body = statement.slice(i + 1, close);
		i = close + 1;
		ctes.push({ name: unquote(name[1]), columns: explicitColumns ?? projectedColumns(body), from: resolveFromClause(body) });

		const comma = /^\s*,\s*/.exec(statement.slice(i));
		if (!comma) {
			break;
		}
		i += comma[0].length;
	}
	return { ctes, mainOffset: i };
}

/** Classify the completion context at `offset` within `text`. */
export function analyzeCompletionContext(text: string, offset: number): CompletionContext {
	const statement = statementAt(text, offset);
	const { ctes, mainOffset } = parseStatement(statement.text);

	// Resolve FROM against the region the cursor sits in: the main query when the
	// cursor is past the WITH chain, else the whole statement (best-effort).
	const inMainQuery = statement.offset >= mainOffset;
	const regionText = inMainQuery ? statement.text.slice(mainOffset) : statement.text;
	const regionOffset = inMainQuery ? statement.offset - mainOffset : statement.offset;
	const from = resolveStatementRelations(regionText);
	const before = regionText.slice(0, regionOffset);

	const word = /[\w$]*$/.exec(before)?.[0] ?? '';
	// `count|(` — a function name already has its parens, so completing one must not add a second
	// pair. Read once here rather than guessed in the provider, which never sees the buffer.
	const followedByParen = /^\s*\(/.test(regionText.slice(regionOffset));

	// Tested BEFORE the qualifier, because `dictGet('depth.` ends in a dotted chain too and would
	// otherwise resolve as `depth`'s TABLES. Inside that literal a table is never the answer.
	const dict = dictionaryArgumentAt(before);
	if (dict) {
		return { kind: 'dictionary', slot: dict.slot, dictionary: dict.dictionary, from, ctes, word: dict.typed, followedByParen };
	}
	// The whole dotted chain, not only the name before the dot: `t.payload.user.` is three
	// qualifiers deep, and the parts INSIDE a column (a Tuple's fields, a JSON path) are what the
	// cursor is asking for there. `qualifier` stays the LAST name, which is what resolving an alias
	// or a table has always used.
	const qualifier = /((?:[`"[\]\w$]+\s*\.\s*)*[`"[\]\w$]+)\s*\.\s*[\w$]*$/.exec(before);
	if (qualifier) {
		const path = qualifier[1].split('.').map((part) => unquote(part.trim())).filter(Boolean);
		return { kind: 'qualifier', qualifier: path[path.length - 1] ?? '', qualifierPath: path, from, ctes, word, followedByParen };
	}
	const slot = catalogSlotAt(before);
	if (slot) {
		return { kind: 'catalog', slot, from, ctes, word, followedByParen };
	}
	// The tail may be a half-typed name OR a half-typed QUOTED name (`FROM "`, `FROM "/aws/la`):
	// a scope whose name needs quotes is still a table position while the closing quote is missing.
	const tablePosition = /(?:\b(from|join|into|update)\b)\s+(?:[`"[\]\w$]+\s*,\s*)*(?:["`[][^"`\]]*|[\w$]*)$/i.exec(before);
	if (tablePosition) {
		return { kind: 'table', from, ctes, joining: tablePosition[1].toLowerCase() === 'join', word, followedByParen };
	}
	return { kind: 'expression', from, ctes, word, followedByParen };
}

/**
 * Which engine-catalog list, if any, the cursor sits in. Each is recognised from the text BEFORE
 * the cursor only, so it works while the statement is half-written, which is the whole point.
 *
 * `SETTINGS` and `FORMAT` are matched to the END of the text, so the clause being typed is the one
 * that wins: `SETTINGS max_threads = 4, max_b|` is the settings list, while
 * `SETTINGS max_threads = 4 FORMAT JS|` is the format list. A value position (`= 4|`) is neither.
 */
export function catalogSlotAt(before: string): CatalogSlot | undefined {
	// ENGINE = MergeTree. The `=` is required: without it, every column named `engine` (and
	// `system.tables` has one) would turn its own WHERE clause into an engine list.
	if (isTailClause(before, 'engine', /\bengine\s*=\s*[\w$]*$/i)) {
		return 'engine';
	}
	// FORMAT JSONEachRow. Only a name follows it, so anything else has ended the clause.
	if (isTailClause(before, 'format', /\bformat\s+[\w$]*$/i)) {
		return 'format';
	}
	// SETTINGS a = 1, b = 2. A NAME position is the start of the clause or just after a comma.
	if (isTailClause(before, 'settings', /\bsettings\s+(?:[\w$]+\s*=\s*[^,]*,\s*)*[\w$]*$/i)) {
		return 'setting';
	}
	return columnTypePosition(before) ? 'dataType' : undefined;
}

/**
 * The dictionary functions that take a dictionary NAME as their first argument, and which of them
 * take an ATTRIBUTE name as their second.
 *
 * Every `dictGet*` does, including the typed (`dictGetString`) and the defaulted
 * (`dictGetUInt64OrDefault`, `dictGetOrNull`) spellings, EXCEPT the three that walk a hierarchy:
 * `dictGetHierarchy(dict, key)` takes the key there, and offering it an attribute name would be
 * wrong in exactly the place someone would trust it. `dictHas` and `dictIsIn` take a key too.
 */
const DICT_FUNCTION = /^dict(?:Get[A-Za-z0-9]*|Has|IsIn)$/;
/** Of those, the ones whose SECOND argument is an attribute: every `dictGet*` but the three that
 *  walk a hierarchy. `dictHas(dict, key)` and `dictIsIn(dict, key, key)` take a key there too, and
 *  neither starts with `dictGet`, so this one test covers all five. */
const DICT_ATTRIBUTE_SECOND = /^dictGet(?!Hierarchy$|Children$|Descendants$)[A-Za-z0-9]*$/;

/**
 * The `dictGet('name', 'attr', key)` argument the cursor sits in, if any.
 *
 * Matched off the text BEFORE the cursor, like every other position here, so it works while the
 * call is half-typed and unclosed - which it always is. The literal's contents are read with
 * `[^']*`, so a name holding an escaped quote is simply not recognised rather than mis-split; a
 * dictionary named that way is not worth a parser.
 */
export function dictionaryArgumentAt(before: string): { slot: DictionarySlot; dictionary?: string; typed: string } | undefined {
	// The attribute first: its shape contains the name's, so testing the name first would match
	// the second argument as though it were the first.
	const attribute = /([A-Za-z_][\w$]*)\s*\(\s*'([^']*)'\s*,\s*'([^']*)$/.exec(before);
	if (attribute && DICT_ATTRIBUTE_SECOND.test(attribute[1])) {
		return { slot: 'attribute', dictionary: attribute[2], typed: attribute[3] };
	}
	const name = /([A-Za-z_][\w$]*)\s*\(\s*'([^']*)$/.exec(before);
	if (name && DICT_FUNCTION.test(name[1])) {
		return { slot: 'name', typed: name[2] };
	}
	return undefined;
}

/** What can precede a word that is being USED as a value, and so proves it is not a clause of its
 *  own: `SELECT format`, `WHERE engine =`, `, settings`. */
const NOT_A_CLAUSE_BEFORE = /(?:\b(?:select|where|and|or|by|on|as|not|in|distinct|set|case|when|then|else|like|is)\b|[,(=<>+\-*/|~])$/i;

/**
 * True when `clause` really is the tail clause it looks like, rather than an identifier that
 * happens to share its name. ClickHouse's own `system.tables` has an `engine` column and its
 * `system.formats` has a `name`, so `SELECT format …` must not become a format list.
 */
function isTailClause(before: string, clause: string, shape: RegExp): boolean {
	if (!shape.test(before)) {
		return false;
	}
	const at = before.toLowerCase().lastIndexOf(clause);
	return at >= 0 && !NOT_A_CLAUSE_BEFORE.test(before.slice(0, at).trimEnd());
}

/**
 * A column TYPE position: what follows a column's name in a definition.
 *
 * Two shapes, and both need the column name already in front of the cursor, so that the NAME
 * position itself (where the user is inventing a word) is left alone:
 *   CREATE TABLE t (id UInt64, name Str|      inside the definition parens
 *   ALTER TABLE t ADD COLUMN name Str|        no parens at all
 */
function columnTypePosition(before: string): boolean {
	if (/\b(?:add|modify|alter)\s+column\s+(?:if\s+not\s+exists\s+)?[`"[\]\w$]+\s+[\w$]*$/i.test(before)) {
		return true;
	}
	const create = /\bcreate\s+(?:or\s+replace\s+)?(?:temporary\s+)?table\b/i.exec(before);
	if (!create || before.indexOf('(', create.index) === -1 || parenDepthAt(before, before.length) < 1) {
		return false;
	}
	// `name Str|`: a bare identifier, a space, then what is being typed, opened by the paren or by
	// the comma before it — otherwise this is the tail of an expression (a DEFAULT, a codec).
	return /(?:\(|,)\s*[`"[\]\w$]+\s+[\w$]*$/.test(before);
}

/** The identifier under `offset` and its optional `qualifier.` prefix (for hover). */
export interface WordRef {
	word: string;
	qualifier?: string;
}

export function wordAt(text: string, offset: number): WordRef | undefined {
	const isIdent = (ch: string): boolean => /[\w$]/.test(ch);
	let start = offset;
	let end = offset;
	while (start > 0 && isIdent(text[start - 1])) {
		start--;
	}
	while (end < text.length && isIdent(text[end])) {
		end++;
	}
	if (start === end) {
		return undefined;
	}
	const qualifier = /([`"[\]\w$]+)\s*\.\s*$/.exec(text.slice(0, start));
	return { word: text.slice(start, end), qualifier: qualifier ? unquote(qualifier[1]) : undefined };
}

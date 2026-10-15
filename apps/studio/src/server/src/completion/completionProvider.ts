/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionItem, CompletionItemKind, InsertTextFormat, MarkupKind } from 'vscode-languageserver/node';

import { catalogList, describeCatalogName, type CatalogEntry, type CatalogItemRef, type CatalogKind, type DialectCatalog } from '../../../shared/catalog';
import { typeSubPaths } from '../../../shared/cellValue';
import { dialectFor } from '../../../shared/engine';
import type { ColumnInfo, DatabaseSchema } from '../../../shared/schema';
import { buildSchemaIndex, describeColumn, describeTable, findColumn, inferredJoinEdges, joinEdges, markdownCode, markdownText, type IndexedTable, type JoinEdge, type SchemaIndex } from '../schema/schemaIndex';
import type { CatalogSlot, CompletionContext, Cte, DictionarySlot, FromRef } from './sqlAnalyzer';

const KEYWORDS = [
	'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'ON',
	'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'AS', 'WITH',
	'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL',
	'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
];

/**
 * How many catalog names one answer carries. ClickHouse has ~1,900 functions and ~1,800 settings,
 * so the list is cut to what the user has typed and then to this. The answer says it is INCOMPLETE
 * (see {@link CompletionAnswer}), which is what makes the next keystroke ask again instead of
 * filtering this list locally and missing what the cut left out.
 */
const CATALOG_LIMIT = 200;

/** What one completion request answers with. */
export interface CompletionAnswer {
	items: CompletionItem[];
	/**
	 * True when the list was narrowed to the word typed so far, so the editor must ASK AGAIN on the
	 * next keystroke rather than filter this list. Only ever set for an engine catalog; the schema
	 * suggestions are sent whole and filtered by the editor, exactly as they always were.
	 */
	isIncomplete: boolean;
}

/** Options a request carries beyond the cursor context: whose dialect, and what its engine knows. */
export interface CompletionOptions {
	/** The connection's driver id — decides how a name that needs quoting is spelled. */
	driverId?: string;
	/** What the connected server says it knows (functions, settings, engines, …), when it can say. */
	catalog?: DialectCatalog;
}

type Derived = NonNullable<FromRef['derived']>;

/** Payload carried on an item so {@link resolveCompletion} can look it back up. */
interface CompletionData {
	kind: 'table' | 'column';
	table: string;
	database: string;
	column?: string;
}

/** The same, for a name that came from the engine's catalog rather than from the schema. */
type CatalogData = CatalogItemRef & { kind: 'catalog' };

/** A relation in scope: a base (schema) table, a CTE, or a derived (subquery) table. */
type ScopedRelation =
	| { kind: 'table'; ref: FromRef; entry: IndexedTable }
	| { kind: 'cte'; ref: FromRef; cte: Cte }
	| { kind: 'derived'; ref: FromRef; derived: Derived };

/**
 * Build completions for the analyzed cursor context. The suggestion list depends on
 * where the cursor is (see {@link CompletionContext}); detail is filled eagerly and
 * richer docs are deferred to {@link resolveCompletion}.
 */
export function buildCompletions(context: CompletionContext, schemas: DatabaseSchema[], options: CompletionOptions = {}): CompletionAnswer {
	const index = buildSchemaIndex(schemas);
	const spell = spelling(options.driverId);
	// A catalog belonging to another vendor is not this connection's; it is ignored rather than
	// shown, so a ClickHouse function never appears on a Postgres connection.
	const catalog = options.catalog && (!options.driverId || options.catalog.driverId === options.driverId) ? options.catalog : undefined;
	switch (context.kind) {
		case 'qualifier': {
			// `t.payload.user.` — the parts INSIDE a column, which no other position can offer.
			// Tried first, because a chain of more than one name can be nothing else.
			const inside = subPathCompletions(context.qualifierPath ?? [context.qualifier], context.from, context.ctes, index);
			return complete(inside ?? qualifierCompletions(context.qualifier, context.from, context.ctes, index), false);
		}
		case 'catalog': {
			const items = slotCompletions(context.slot, context.word, catalog);
			// Nothing to offer: either this engine has no catalog, or what looked like a clause was
			// an identifier that shares its name. Either way the usual suggestions are the answer.
			if (items.length > 0) {
				return complete(items, true);
			}
			return complete(expressionCompletions(context, index, spell, catalog), catalog !== undefined);
		}
		case 'dictionary': {
			const items = dictionaryCompletions(context.slot, context.dictionary, context.word, index);
			// A `dictGet` on a connection with no dictionaries, or a name that matches none: the
			// ordinary suggestions are a better answer than an empty list, the same way an
			// unrecognised catalog slot falls back.
			if (items.length > 0) {
				return complete(items, false);
			}
			return complete(expressionCompletions(context, index, spell, catalog), catalog !== undefined);
		}
		case 'table':
			return complete(tableCompletions(context, index, spell, catalog), catalog !== undefined);
		case 'expression':
			return complete(expressionCompletions(context, index, spell, catalog), catalog !== undefined);
	}
}

function complete(items: CompletionItem[], isIncomplete: boolean): CompletionAnswer {
	return { items, isIncomplete };
}

/**
 * Rank groups, written into `sortText` so Monaco's tiebreak is ours rather than alphabetical.
 *
 * A column of a table the statement already named is what the user is reaching for: `WHERE act…`
 * in `SELECT * FROM authority WHERE act…` means `actionName`, not the keyword `AS` and not one of
 * the four hundred other tables in the database. Without these every item tied on score and
 * Monaco fell back to the label, so the columns sank under the keyword list and the only way to
 * see them was to alias the table and type `a.` — which is a qualifier, a different code path
 * that returns columns and nothing else.
 *
 * Joins outrank everything at a JOIN position because they were asked for by name.
 */
const RANK = {
	joinFk: '0',
	joinInferred: '1',
	column: '2',
	keyword: '3',
	/** A function the engine says it has: as good an answer as a keyword, and asked for by name. */
	function: '3',
	table: '4',
	/** A combinator variant (`sumIf`) is derived, not declared, so it sits under the real names. */
	combinator: '5',
} as const;

/** A name that can be written bare: a leading letter or `_`, then letters, digits and `_`. */
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * How this connection has to SPELL a table name to insert it.
 *
 * Most names are plain and go in as they are. A cloud log scope is not: `/aws/lambda/checkout` is a
 * perfectly good name to CloudWatch and not a name at all to SQL, so completing it bare produced a
 * statement that could not parse, and the user had to add the quotes by hand every time. The
 * quoting character is the connection's own (`dialectFor`), never a hardcoded `"`.
 */
function spelling(driverId: string | undefined): (name: string) => string {
	const dialect = dialectFor(driverId);
	return (name) => (PLAIN_NAME.test(name) ? name : dialect.quoteIdent(name));
}

/** Enrich the item the user is previewing with markdown documentation. */
export function resolveCompletion(item: CompletionItem, schemas: DatabaseSchema[], catalogs: DialectCatalog[] = []): CompletionItem {
	const data = item.data as CompletionData | CatalogData | undefined;
	if (data?.kind === 'catalog') {
		const catalog = catalogs.find((entry) => entry.driverId === data.driverId);
		const doc = catalog && describeCatalogName(catalog, data.catalog, data.name);
		if (doc) {
			item.documentation = { kind: MarkupKind.Markdown, value: doc };
		}
		return item;
	}
	if (!data) {
		return item;
	}
	const entry = buildSchemaIndex(schemas).find(data.table, data.database);
	if (!entry) {
		return item;
	}
	if (data.kind === 'table') {
		item.documentation = { kind: MarkupKind.Markdown, value: describeTable(entry) };
	} else if (data.column) {
		const column = findColumn(entry.table, data.column);
		if (column) {
			item.documentation = { kind: MarkupKind.Markdown, value: describeColumn(entry, column) };
		}
	}
	return item;
}

/**
 * Column names a CTE/derived relation exposes: its explicit/projected names, or —
 * when it projects `*` — the columns of its inner FROM relations, expanded one
 * level per relation (`seen` guards against recursive CTEs).
 */
export function deriveColumns(columns: string[] | undefined, from: FromRef[], ctes: Cte[], index: SchemaIndex, seen = new Set<string>()): string[] {
	if (columns) {
		return columns;
	}
	const names: string[] = [];
	for (const ref of from) {
		if (ref.derived) {
			names.push(...deriveColumns(ref.derived.columns, ref.derived.from, ctes, index, seen));
			continue;
		}
		const cte = ctes.find((c) => c.name.toLowerCase() === ref.table.toLowerCase());
		if (cte) {
			if (seen.has(cte.name.toLowerCase())) {
				continue;
			}
			seen.add(cte.name.toLowerCase());
			names.push(...deriveColumns(cte.columns, cte.from, ctes, index, seen));
			continue;
		}
		const entry = index.find(ref.table, ref.schema);
		if (entry) {
			names.push(...entry.table.columns.map((column) => column.name));
		}
	}
	return names;
}

function resolveScope(from: FromRef[], ctes: Cte[], index: SchemaIndex): ScopedRelation[] {
	const relations: ScopedRelation[] = [];
	for (const ref of from) {
		if (ref.derived) {
			relations.push({ kind: 'derived', ref, derived: ref.derived });
			continue;
		}
		const cte = ctes.find((c) => c.name.toLowerCase() === ref.table.toLowerCase());
		if (cte) {
			relations.push({ kind: 'cte', ref, cte });
			continue;
		}
		const entry = index.find(ref.table, ref.schema);
		if (entry) {
			relations.push({ kind: 'table', ref, entry });
		}
	}
	return relations;
}

function relationColumnItems(relation: ScopedRelation, ctes: Cte[], index: SchemaIndex): CompletionItem[] {
	if (relation.kind === 'table') {
		return relation.entry.table.columns.map((column) => columnItem(relation.entry, column));
	}
	if (relation.kind === 'cte') {
		const names = deriveColumns(relation.cte.columns, relation.cte.from, ctes, index, new Set([relation.cte.name.toLowerCase()]));
		return names.map((name) => pseudoColumnItem(`${relation.cte.name} (CTE)`, name));
	}
	const names = deriveColumns(relation.derived.columns, relation.derived.from, ctes, index);
	return names.map((name) => pseudoColumnItem(`${relation.ref.alias ?? 'subquery'} (subquery)`, name));
}

function expressionCompletions(context: CompletionContext, index: SchemaIndex, spell: (name: string) => string, catalog: DialectCatalog | undefined): CompletionItem[] {
	const { from, ctes } = context;
	const items: CompletionItem[] = keywordItems(catalog);
	for (const relation of resolveScope(from, ctes, index)) {
		items.push(...relationColumnItems(relation, ctes, index));
	}
	items.push(...index.tables.map((entry) => tableItem(entry, spell)));
	items.push(...ctes.map(cteItem));
	items.push(...functionCompletions(context, catalog));
	return items;
}

/** The cross-dialect keyword list, plus the ones this engine adds (PREWHERE, FINAL, ARRAY JOIN). */
function keywordItems(catalog: DialectCatalog | undefined): CompletionItem[] {
	const extra = catalog ? dialectFor(catalog.driverId).keywords ?? [] : [];
	return [...KEYWORDS, ...extra].map((label) => ({ label, kind: CompletionItemKind.Keyword, sortText: `${RANK.keyword}_${label}` }));
}

/**
 * Functions the engine says it has, narrowed to what the user has typed, plus the combinator
 * variants of any aggregate that matches (`sumIf`, `uniqExactState`). ClickHouse does not list
 * those: a combinator is a suffix the parser applies to any aggregate, so the only way to offer
 * `sumIf` is to build it, and the only way to build it without sending thousands of names is to
 * build it for the aggregates the typed word already matches.
 */
function functionCompletions(context: CompletionContext, catalog: DialectCatalog | undefined): CompletionItem[] {
	if (!catalog || !context.word) {
		return [];
	}
	const word = context.word.toLowerCase();
	const items: CompletionItem[] = [];
	for (const entry of catalog.functions) {
		if (entry.name.toLowerCase().startsWith(word)) {
			items.push(catalogItem(entry, 'function', catalog.driverId, RANK.function, context.followedByParen));
		}
		if (entry.aggregate) {
			items.push(...combinatorItems(entry, word, catalog, context.followedByParen));
		}
	}
	return items.slice(0, CATALOG_LIMIT);
}

/** `sum` + `If` → `sumIf`, for each combinator whose built name still matches what was typed. */
function combinatorItems(aggregate: CatalogEntry, word: string, catalog: DialectCatalog, followedByParen: boolean | undefined): CompletionItem[] {
	const items: CompletionItem[] = [];
	for (const combinator of catalog.combinators) {
		const name = `${aggregate.name}${combinator.name}`;
		if (!name.toLowerCase().startsWith(word)) {
			continue;
		}
		const entry: CatalogEntry = {
			name,
			aggregate: true,
			syntax: aggregate.syntax ? `${name}(…)` : undefined,
			description: combinator.description,
		};
		const item = catalogItem(entry, 'function', catalog.driverId, RANK.combinator, followedByParen);
		item.detail = `${aggregate.name} with the ${combinator.name} combinator`;
		item.data = { kind: 'catalog', catalog: 'function', name, driverId: catalog.driverId, base: aggregate.name, combinator: combinator.name } satisfies CatalogData;
		items.push(item);
	}
	return items;
}

/**
 * The two `dictGet` string arguments: the dictionaries on this connection, or one dictionary's
 * attributes.
 *
 * The NAME is offered qualified (`shop.country_names`), because a bare name resolves only against
 * the session's current database and a qualified one always works. Monaco's word range stops at
 * the dot, so an insert over a half-typed `coun` lands correctly; a user who has already typed
 * `shop.` gets that database's dictionaries unqualified, since anything else would double the
 * prefix.
 *
 * The ATTRIBUTE list comes from the named dictionary alone, matched with or without its database,
 * so `dictGet('country_names', '…')` (valid when the session is in that database) works too.
 */
function dictionaryCompletions(slot: DictionarySlot, dictionary: string | undefined, typed: string, index: SchemaIndex): CompletionItem[] {
	const all = index.tables.filter((entry) => entry.table.kind === 'dictionary');
	if (slot === 'name') {
		// A database already typed inside the quote (`dictGet('shop.`): offer that database's
		// dictionaries BARE. Monaco's word range starts after the dot, so a qualified insert there
		// would write `shop.shop.country_names`.
		const dot = typed.lastIndexOf('.');
		const prefix = dot >= 0 ? typed.slice(0, dot).toLowerCase() : undefined;
		const scoped = prefix === undefined ? all : all.filter((entry) => entry.database.toLowerCase() === prefix);
		return scoped.map((entry) => {
			const qualified = `${entry.database}.${entry.table.name}`;
			const text = prefix === undefined ? qualified : entry.table.name;
			const info = entry.table.dictionary;
			const key = info?.keyColumns.join(', ');
			return {
				label: text,
				kind: CompletionItemKind.Value,
				insertText: text,
				filterText: `${text} ${entry.table.name}`,
				detail: key ? `dictionary, keyed by ${key}` : 'dictionary',
				sortText: `${RANK.table}${qualified}`,
				documentation: dictionaryDocumentation(entry.table),
			} satisfies CompletionItem;
		});
	}
	const target = dictionary?.toLowerCase() ?? '';
	const entry = all.find((e) => `${e.database}.${e.table.name}`.toLowerCase() === target)
		?? all.find((e) => e.table.name.toLowerCase() === target);
	return (entry?.table.dictionary?.attributes ?? []).map((attr) => ({
		label: attr.name,
		kind: CompletionItemKind.Field,
		insertText: attr.name,
		detail: attr.dataType,
		sortText: `${RANK.column}${attr.name}`,
	} satisfies CompletionItem));
}

/** What the dictionary is, in the hover beside its name: what it is keyed by, what it can return,
 *  and how it is held, which is what decides whether a `dictGet` is a memory read. */
function dictionaryDocumentation(table: IndexedTable['table']): { kind: MarkupKind; value: string } {
	const info = table.dictionary;
	const lines: string[] = [];
	// Every value here is the database's own text, so none of it may become markup (markdownText).
	if (info?.keyColumns.length) {
		lines.push(`Key: ${markdownCode(info.keyColumns.join(', '))}`);
	}
	if (info?.attributes.length) {
		lines.push(`Attributes: ${info.attributes.map((a) => `${markdownCode(a.name)} ${markdownText(a.dataType)}`).join(', ')}`);
	}
	if (info?.layout) {
		lines.push(`Layout: ${markdownText(info.layout)}`);
	}
	if (info?.sourceKind) {
		lines.push(`Loaded from: ${markdownText(info.sourceKind)}`);
	}
	return { kind: MarkupKind.Markdown, value: lines.join('\n\n') };
}

/** The whole of one catalog slot (`SETTINGS …`, `FORMAT …`, `ENGINE = …`, a column's type). */
function slotCompletions(slot: CatalogSlot, word: string, catalog: DialectCatalog | undefined): CompletionItem[] {
	if (!catalog) {
		return [];
	}
	const kind = SLOT_KINDS[slot];
	const lower = word.toLowerCase();
	const entries = catalogList(catalog, kind)
		// A SELECT's FORMAT has to be one the server can WRITE; an INSERT's is one it can read, and
		// offering both there is right, so only the output-only cut is made.
		.filter((entry) => (kind !== 'format' || entry.output !== false) && entry.name.toLowerCase().startsWith(lower));
	return entries.slice(0, CATALOG_LIMIT).map((entry) => catalogItem(entry, kind, catalog.driverId, RANK.keyword, true));
}

const SLOT_KINDS: Record<CatalogSlot, CatalogKind> = {
	setting: 'setting',
	format: 'format',
	engine: 'tableEngine',
	dataType: 'dataType',
};

const ITEM_KINDS: Record<CatalogKind, CompletionItemKind> = {
	function: CompletionItemKind.Function,
	combinator: CompletionItemKind.Function,
	tableFunction: CompletionItemKind.Function,
	tableEngine: CompletionItemKind.Class,
	dataType: CompletionItemKind.TypeParameter,
	format: CompletionItemKind.EnumMember,
	setting: CompletionItemKind.Property,
};

/**
 * One item from the engine's catalog. The DESCRIPTION is deliberately left off: it is fetched by
 * {@link resolveCompletion} when the user previews the item, because these lists run to thousands
 * of names and a paragraph on each is a quarter-megabyte across the wire per keystroke.
 */
function catalogItem(entry: CatalogEntry, kind: CatalogKind, driverId: string, rank: string, followedByParen: boolean | undefined): CompletionItem {
	const callable = kind === 'function' || kind === 'tableFunction';
	const item: CompletionItem = {
		label: entry.name,
		kind: ITEM_KINDS[kind],
		detail: catalogDetail(entry, kind),
		sortText: `${rank}_${entry.name}`,
		data: { kind: 'catalog', catalog: kind, name: entry.name, driverId } satisfies CatalogData,
	};
	// A call gets its parens, with the cursor between them — unless the buffer already has them.
	if (callable && !followedByParen) {
		item.insertText = `${entry.name}($0)`;
		item.insertTextFormat = InsertTextFormat.Snippet;
	}
	return item;
}

/** The one line under the name in the suggest widget: what it IS, as shortly as it can be said. */
function catalogDetail(entry: CatalogEntry, kind: CatalogKind): string {
	if (kind === 'setting') {
		const type = entry.valueType ? `${entry.valueType} · ` : '';
		return `${type}now ${entry.value ?? '?'}${entry.tier ? ` · ${entry.tier}` : ''}`;
	}
	if (kind === 'format') {
		const ways = [entry.input ? 'read' : '', entry.output ? 'write' : ''].filter(Boolean).join(' + ');
		return ways ? `format · ${ways}` : 'format';
	}
	if (kind === 'tableEngine') {
		return entry.supports ? `engine · ${entry.supports}` : 'engine';
	}
	if (entry.aliasTo) {
		return `alias of ${entry.aliasTo}`;
	}
	if (entry.syntax) {
		return entry.syntax;
	}
	return entry.aggregate ? 'aggregate function' : kind === 'dataType' ? 'type' : 'function';
}

function qualifierCompletions(qualifier: string, from: FromRef[], ctes: Cte[], index: SchemaIndex): CompletionItem[] {
	const lower = qualifier.toLowerCase();
	const matched = resolveScope(from, ctes, index).filter((relation) =>
		relation.ref.alias?.toLowerCase() === lower || (!relation.ref.alias && relation.ref.table.toLowerCase() === lower),
	);
	if (matched.length) {
		return matched.flatMap((relation) => relationColumnItems(relation, ctes, index));
	}
	// A CTE referenced by name, then a table referenced directly, then a database.
	const cte = ctes.find((c) => c.name.toLowerCase() === lower);
	if (cte) {
		const names = deriveColumns(cte.columns, cte.from, ctes, index, new Set([lower]));
		return names.map((name) => pseudoColumnItem(`${cte.name} (CTE)`, name));
	}
	const direct = index.findByName(qualifier);
	if (direct.length) {
		return direct.flatMap((entry) => entry.table.columns.map((column) => columnItem(entry, column)));
	}
	return index.inDatabase(qualifier).map((entry) => tableItem(entry, (name) => name));
}

/**
 * What is INSIDE a column, for a qualifier chain that reaches into one: `t.payload.` after a
 * `Tuple`, a `Map`, a `Nested`, or a `JSON`.
 *
 * Two sources, and they answer different questions. A `Tuple`'s fields, a `Map`'s `keys` and
 * `values` and an `Array`'s `size0` are in the TYPE, so they cost nothing and are always right.
 * A `JSON` column's paths are in the DATA, so they were sampled at introspection
 * (`ColumnInfo.dynamicPaths`) and are what that sample held, which is why they are offered with
 * that said on the item rather than as a promise.
 *
 * `undefined` means the chain is not a column at all, so the caller falls back to resolving it as
 * an alias, a table or a database, exactly as before.
 */
function subPathCompletions(path: string[], from: FromRef[], ctes: Cte[], index: SchemaIndex): CompletionItem[] | undefined {
	const found = findColumnInChain(path, from, ctes, index);
	if (!found) {
		return undefined;
	}
	const { column, rest } = found;
	const items: CompletionItem[] = [];

	// Down through the declared type, one named part per segment already typed.
	let dataType: string | undefined = column.dataType;
	let typed = true;
	for (const segment of rest) {
		const next: { name: string; dataType?: string } | undefined = typeSubPaths(dataType).find((sub) => sub.name.toLowerCase() === segment.toLowerCase());
		if (!next) {
			typed = false;
			break;
		}
		dataType = next.dataType;
	}
	if (typed) {
		for (const sub of typeSubPaths(dataType)) {
			items.push({
				label: sub.name,
				kind: CompletionItemKind.Field,
				detail: `${sub.dataType ? `${sub.dataType} · ` : ''}inside ${column.name}`,
				sortText: `${RANK.column}_${sub.name}`,
			});
		}
	}

	// And the paths the data had, for a column whose parts are not in its type.
	const prefix = rest.length > 0 ? `${rest.join('.')}.` : '';
	const seen = new Set(items.map((item) => String(item.label).toLowerCase()));
	for (const dynamic of column.dynamicPaths ?? []) {
		if (!dynamic.name.startsWith(prefix)) {
			continue;
		}
		const label = dynamic.name.slice(prefix.length).split('.')[0];
		if (!label || seen.has(label.toLowerCase())) {
			continue;
		}
		seen.add(label.toLowerCase());
		items.push({
			label,
			kind: CompletionItemKind.Field,
			detail: `${dynamic.dataType ? `${dynamic.dataType} · ` : ''}seen in ${column.name}`,
			sortText: `${RANK.column}_${label}`,
		});
	}
	return items.length > 0 ? items : undefined;
}

/** Read a qualifier chain as `[relation?, column, ...inside]` and return the column it names. */
function findColumnInChain(path: string[], from: FromRef[], ctes: Cte[], index: SchemaIndex): { column: ColumnInfo; rest: string[] } | undefined {
	if (path.length === 0) {
		return undefined;
	}
	const relations = resolveScope(from, ctes, index);
	const lower = path[0].toLowerCase();
	// `alias.column.…`, where the chain names its relation.
	const owner = relations.find((relation) =>
		relation.kind === 'table' && (relation.ref.alias?.toLowerCase() === lower || (!relation.ref.alias && relation.ref.table.toLowerCase() === lower)),
	);
	if (owner && owner.kind === 'table') {
		// `alias.` alone is the relation's columns, not a chain into one of them.
		const column = path.length > 1 ? findColumn(owner.entry.table, path[1]) : undefined;
		return column ? { column, rest: path.slice(2) } : undefined;
	}
	// `column.…`, where the column is in scope without being qualified.
	for (const relation of relations) {
		if (relation.kind !== 'table') {
			continue;
		}
		const column = findColumn(relation.entry.table, path[0]);
		if (column) {
			return { column, rest: path.slice(1) };
		}
	}
	return undefined;
}

function tableCompletions(context: CompletionContext, index: SchemaIndex, spell: (name: string) => string, catalog: DialectCatalog | undefined): CompletionItem[] {
	const { from, ctes } = context;
	const items: CompletionItem[] = [];
	if (context.kind === 'table' && context.joining) {
		items.push(...joinCompletions(from, ctes, index, spell));
	}
	items.push(...index.tables.map((entry) => tableItem(entry, spell)));
	items.push(...ctes.map(cteItem));
	// A table position also takes a TABLE FUNCTION (`FROM s3(…)`, `FROM numbers(10)`), which is
	// how half of ClickHouse's data is read and is not in any schema.
	if (catalog) {
		items.push(...catalog.tableFunctions
			.filter((entry) => entry.name.toLowerCase().startsWith(context.word.toLowerCase()))
			.slice(0, CATALOG_LIMIT)
			.map((entry) => catalogItem(entry, 'tableFunction', catalog.driverId, RANK.table, context.followedByParen)));
	}
	return items;
}

/**
 * JOIN suggestions of the form `target t ON source.fk = t.pk`, floated to the top.
 * Declared foreign keys rank first; convention-inferred joins (for schemas with no FK
 * constraints) follow. The joined table is given a short, in-scope-unique alias and the
 * suggestion is a snippet whose tabstop lets the user rename that alias inline.
 */
function joinCompletions(from: FromRef[], ctes: Cte[], index: SchemaIndex, spell: (name: string) => string): CompletionItem[] {
	const items: CompletionItem[] = [];
	const inScope = new Set(from.map((ref) => (ref.alias ?? ref.table).toLowerCase()));
	const seen = new Set<string>();
	for (const relation of resolveScope(from, ctes, index)) {
		if (relation.kind !== 'table') {
			continue;
		}
		const source = relation.ref.alias ?? relation.entry.table.name;
		for (const edge of [...joinEdges(relation.entry, index), ...inferredJoinEdges(relation.entry, index)]) {
			const key = `${edge.target.table.name}|${edge.on.map((pair) => `${pair.from}>${pair.to}`).join(',')}`.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			items.push(joinItem(source, edge, new Set(inScope), spell));
		}
	}
	return items;
}

/** A single JOIN snippet: aliases the target table and mirrors that alias in the ON clause. */
function joinItem(source: string, edge: JoinEdge, taken: Set<string>, spell: (name: string) => string): CompletionItem {
	const target = edge.target.table.name;
	const alias = aliasFor(target, taken);
	const onPlain = edge.on.map((pair) => `${source}.${pair.from} = ${alias}.${pair.to}`).join(' AND ');
	const onSnippet = edge.on.map((pair) => `${source}.${pair.from} = \${1:${alias}}.${pair.to}`).join(' AND ');
	return {
		label: `${target} ${alias} ON ${onPlain}`,
		kind: CompletionItemKind.Snippet,
		detail: `${edge.inferred ? 'JOIN (inferred)' : 'JOIN via FK'} · ${edge.target.database}`,
		insertText: `${spell(target)} \${1:${alias}} ON ${onSnippet}`,
		insertTextFormat: InsertTextFormat.Snippet,
		sortText: `${edge.inferred ? RANK.joinInferred : RANK.joinFk}_${target}`,
		data: { kind: 'table', table: target, database: edge.target.database } satisfies CompletionData,
	};
}

/** A short table alias (initials of underscore-separated words), unique within `taken`. */
function aliasFor(table: string, taken: Set<string>): string {
	const words = table.toLowerCase().split(/[_\s]+/).filter(Boolean);
	const base = (words.length > 1 ? words.map((word) => word[0]).join('') : table.slice(0, 1)).toLowerCase() || 't';
	let alias = base;
	let n = 1;
	while (taken.has(alias)) {
		alias = `${base}${++n}`;
	}
	taken.add(alias);
	return alias;
}

function columnItem(entry: IndexedTable, column: ColumnInfo): CompletionItem {
	return {
		label: column.name,
		kind: CompletionItemKind.Field,
		detail: `${column.dataType}${column.isPrimaryKey ? ' · PK' : ''} — ${entry.table.name}`,
		sortText: `${RANK.column}_${column.name}`,
		data: { kind: 'column', table: entry.table.name, database: entry.database, column: column.name } satisfies CompletionData,
	};
}

function tableItem(entry: IndexedTable, spell: (name: string) => string): CompletionItem {
	const name = entry.table.name;
	const insertText = spell(name);
	return {
		label: name,
		kind: CompletionItemKind.Struct,
		detail: `${entry.database} · ${entry.table.kind}`,
		// Only when the two differ, so nothing changes for a plain name. `filterText` keeps the item
		// findable by what the user typed (the bare name), not by the quotes around it.
		...(insertText === name ? {} : { insertText, filterText: name }),
		sortText: `${RANK.table}_${name}`,
		data: { kind: 'table', table: name, database: entry.database } satisfies CompletionData,
	};
}

function cteItem(cte: Cte): CompletionItem {
	return { label: cte.name, kind: CompletionItemKind.Struct, detail: 'CTE', sortText: `${RANK.table}_${cte.name}` };
}

/** Item for a column with no schema metadata (CTE / derived-table column). */
function pseudoColumnItem(sourceLabel: string, column: string): CompletionItem {
	return { label: column, kind: CompletionItemKind.Field, detail: `— ${sourceLabel}`, sortText: `${RANK.column}_${column}` };
}

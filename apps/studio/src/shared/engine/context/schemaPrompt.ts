/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_IDENTITY, assistantIs } from '../../assistant';
import type { DatabaseSchema, RoutineInfo, TableInfo } from '../../schema';
import type { AmbientContext, ChatMessage } from '../../ai';
import type { KnowledgeNote } from '../../knowledge';
import { referencedTables } from '../dialect/querylang/sql';
import { dialectFor, identifierNeedsQuoting } from '../dialect/index';

// Hard upper bound on the inlined-schema text. Honors `topTables` first (that's the
// product-shaped lever), and only kicks in for pathological cases — e.g. wide tables
// with hundreds of columns where the top-N alone would blow the context window.
// Overridable via AiBehaviorSettings.maxSchemaChars.
const DEFAULT_SCHEMA_CHAR_BUDGET = 24000;

// Default number of stored routines to surface in the prompt. Like the table detail list,
// the rest are dropped rather than dumped — the routines are relevance-ranked so the ones
// whose name matches the question (e.g. lookupName for a "name from" request) come first.
const DEFAULT_TOP_ROUTINES = 12;

// Default number of tables to fully describe in the prompt (overridable via
// AiBehaviorSettings.topTables). Small models can't reliably tool-call to fetch column
// detail on demand, so we inline the top-N relevance-ranked tables' columns upfront.
// The other tables aren't enumerated — the model discovers them via list_tables /
// search_columns / describe_table.
const DEFAULT_TOP_TABLES = 8;

// Relevance weights for schema linking (see rankTables).
const EXACT_NAME = 50; // the table IS the queried word (singular/plural) — strongest signal
const NAME_HIT = 10; // a query token matching one word of the table name
const COLUMN_HIT_CAP = 5; // columns are a weak signal; cap so a wide table can't dominate
const FK_NEIGHBOR = 3; // a one-hop FK neighbour of a matched table
// A half-typed identifier at the cursor (`from cus‸`). Whole-token matching can never score this —
// `cus` is not `customer` — which on a database with hundreds of tables left EVERY table scoring
// zero and the prompt naming whatever happened to sit first. Ranked between a word hit and an exact name: strong
// evidence, but weaker than the user having typed the whole thing. The coverage bonus prefers the
// SHORTEST name the fragment could still become, so `cus` puts `customer` above
// `customer_order_check_status` instead of leaving them tied.
const PREFIX_NAME = 30; // the table name starts with the fragment
const PREFIX_COVERAGE = 10; // × how much of the name the fragment already covers
const PREFIX_WORD = 12; // a word INSIDE the name starts with it (`ord` → customer_order)
const PREFIX_COLUMN = 2; // a column name starts with it
// Vocabulary expansion (see expandVocabulary): the user's own words, bridged to the schema's.
const NOTE_TABLE_HIT = 8; // a table/column NOTE matching the question names its table outright
const SYNONYM_HIT = 6; // a word borrowed from a matching glossary note hits a table name
/** Words one question may borrow from the glossary. Capped so a large knowledge base cannot
 *  flood the scoring with vocabulary from notes that merely share a common word. */
const EXPANSION_CAP = 24;

// Words that carry no table-selection signal — SQL keywords + English filler. Dropped
// from the question before scoring so "show me all the orders" keys on "orders".
const STOP_WORDS = new Set<string>([
	'select', 'from', 'where', 'join', 'inner', 'outer', 'left', 'right', 'full', 'cross',
	'on', 'using', 'group', 'order', 'having', 'limit', 'offset', 'insert', 'update', 'delete',
	'into', 'values', 'and', 'not', 'null', 'distinct', 'union', 'create', 'alter', 'drop',
	'with', 'count', 'sum', 'avg', 'min', 'max', 'asc', 'desc',
	'the', 'all', 'any', 'some', 'for', 'show', 'list', 'give', 'get', 'find', 'fetch',
	'display', 'return', 'what', 'which', 'how', 'when', 'who', 'whose', 'are', 'does', 'did',
	'want', 'need', 'please', 'that', 'this', 'these', 'those', 'its', 'their', 'each', 'per',
	'about', 'top', 'more', 'most', 'many', 'much',
]);

interface PromptOptions {
	/** The active connection's driver id (e.g. `postgres`, `sqlserver`). Selects the dialect whose
	 *  identifier-quoting is applied to reserved-word table/column names in the rendered schema, so
	 *  the model is shown (and copies) `"order"` / `` `order` `` / `[order]` rather than bare `order`.
	 *  Undefined ⇒ the generic dialect; ignored in {@link PromptOptions.documentMode}. */
	driverId?: string;
	/** Override the inlined-schema character upper bound. */
	maxSchemaChars?: number;
	/** Override how many ranked tables get full column detail in the prompt. */
	topTables?: number;
	/** Extra free-text guidance appended to the system prompt. */
	instructions?: string;
	/** The user's latest question — ranks the schema by relevance (chat only). */
	focus?: string;
	/** The identifier fragment directly under the cursor (`from cus‸` → `cus`), for the completion
	 *  path. Matched by PREFIX against table/column names, which whole-token scoring cannot do. */
	partialName?: string;
	/** Lowercased table names to omit from the detailed schema slice (edit decoy suppression;
	 *  see {@link editDecoyTables}). They're still counted in the "other tables exist" line. */
	excludeTables?: Set<string>;
	/** Per-table query-history frequency (lowercased name → count), from {@link buildTableUsage}.
	 *  Ranks the schema by what the user actually queries, alongside lexical relevance (A5). */
	tableUsage?: Map<string, number>;
	/** Full-screen AI Chat surface: when the ask is a chart, render it and omit the raw ```sql
	 *  block (the query isn't shown there). See {@link chartGuidance}. */
	chartNoSql?: boolean;
	/** Document (MongoDB) backend: the assistant proposes a native aggregation pipeline in a ```json
	 *  block instead of ```sql. Set from the connection's `QueryLanguageProfile.kind`.
	 *  Only flips the final-answer framing; schema grounding + ambient block are shared with SQL. */
	documentMode?: boolean;
	/** A connection is selected but not connected yet (no schema loaded). The agent's tools still
	 *  work: the first DB tool call asks the user to connect. See {@link buildAgentPrompt}. */
	connectionPending?: boolean;
	/** The user was asked up front whether to connect the selected database and DECLINED, so this
	 *  turn has no DB access on purpose. No schema, no DB tools: the model answers generally and
	 *  tells the user precise/data-backed answers need a connection. See {@link DB_RESTRICTED_NOTE}. */
	dbRestricted?: boolean;
	/** No connection is selected and more than one is connected, so the dialect is ambiguous. Each
	 *  entry is a connected DB's label + its SQL dialect display name; the prompt tells the model to
	 *  ask the user which of these they mean before writing any SQL, instead of guessing. Chat-only
	 *  (inline completion/edit never set it — they ground generically when ambiguous). */
	ambiguousConnections?: { label: string; dialect: string }[];
	/** A results grid is on screen (the docked panel), so a run_query the agent runs has its rows
	 *  surfaced there automatically — the model must NOT reproduce the full table in its reply.
	 *  False on the full-screen chat surface (no grid in view), where the model presents the data
	 *  itself. See {@link RESULTS_IN_GRID_NOTE}. */
	gridInView?: boolean;
	/** Knowledge-base table/column notes, keyed by lowercased table name. Rendered as trailing
	 *  `-- NOTE:` comments on that table's detailed schema line. A note whose table is neither
	 *  ranked nor pinned simply doesn't appear. */
	notesByTable?: Map<string, KnowledgeNote[]>;
	/** Lowercased table names carrying a pinned KB note: force-included in the detailed schema
	 *  slice regardless of lexical rank, so a vocabulary-gap table (e.g. `customer_order` for a
	 *  "custumer sales" question) still shows its columns. See {@link schemaLines}. */
	pinnedTables?: Set<string>;
	/** The user's own words for their own data: the enabled GLOSSARY notes' text. Used only to widen
	 *  the question during schema linking, never rendered here (the glossary block is stapled onto
	 *  the system prompt separately). This is what lets "churn" find `subscription_cancellations`
	 *  without an embedding model. See {@link expandVocabulary}. */
	vocabulary?: string[];
}

/** A function that quotes one identifier only when it needs it (reserved word / special chars),
 *  using the active dialect's quote style. Identity in document mode (the prompt proposes JSON
 *  pipelines, not SQL, so SQL identifier-quoting would be wrong). */
type Quoter = (name: string) => string;

/** Build the {@link Quoter} for these options: the dialect's quoteIdent for reserved/odd names,
 *  pass-through otherwise (and always pass-through in document mode). */
function quoterFor(opts: PromptOptions): Quoter {
	if (opts.documentMode) {
		return (name) => name;
	}
	const dialect = dialectFor(opts.driverId);
	return (name) => (identifierNeedsQuoting(name) ? dialect.quoteIdent(name) : name);
}

function qualifiedName(schemaName: string | undefined, table: string, quote: Quoter = (n) => n): string {
	return schemaName ? `${quote(schemaName)}.${quote(table)}` : quote(table);
}

function budgetOf(opts: PromptOptions): number {
	return opts.maxSchemaChars && opts.maxSchemaChars > 0 ? opts.maxSchemaChars : DEFAULT_SCHEMA_CHAR_BUDGET;
}

function topNOf(opts: PromptOptions): number {
	return opts.topTables && opts.topTables > 0 ? opts.topTables : DEFAULT_TOP_TABLES;
}

/** Split an identifier into lowercase word tokens: snake_case and camelCase both break
 *  apart (`order_items`, `OrderItems` → ["order", "items"]). */
function splitIdentifier(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((word) => word.toLowerCase());
}

/** Normalise tokens for matching: keep tokens ≥2 chars and add a crude singular so
 *  "orders"/"order" match either way. */
function normaliseTokens(words: Iterable<string>): Set<string> {
	const out = new Set<string>();
	for (const word of words) {
		if (word.length < 2) {
			continue;
		}
		out.add(word);
		if (word.length > 3 && word.endsWith('s')) {
			out.add(word.slice(0, -1));
		}
	}
	return out;
}

/** The question's content tokens (stop-words removed), normalised for matching. */
export function queryTokens(focus: string): Set<string> {
	const words = splitIdentifier(focus).filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
	return normaliseTokens(words);
}

/**
 * What the user's own vocabulary adds to a question, for schema linking.
 *
 * The gap this closes: lexical ranking is blind to synonymy. "Which customers churned last
 * quarter?" scores zero against `subscription_cancellations`, because not one word of the question
 * appears in the schema — and no amount of stemming fixes it, since the words genuinely differ.
 * The usual answer is embeddings, which means a model call (or a vector index) on the way to every
 * prompt.
 *
 * We already have something better and cheaper: the knowledge base. The user has told this app, in
 * their own words, what their tables mean. So a question is expanded through what they taught us:
 *
 * - a TABLE/COLUMN note that overlaps the question names its table directly ("this is where churn
 *   is recorded", on `subscription_cancellations`) — the strongest and most common case, and it is
 *   a fact the user stated rather than a guess;
 * - a GLOSSARY note that overlaps the question lends its OTHER words to the question ("churn means
 *   a cancelled subscription" turns `churn` into `cancelled`, `subscription`), which then match
 *   table and column names by the ordinary lexical path.
 *
 * Deterministic, local, no round-trip, and it improves as the user teaches the app more — which is
 * the same bet the rest of the knowledge base makes. Borrowed words score BELOW a real name hit
 * ({@link SYNONYM_HIT} < {@link NAME_HIT}): a table the user actually named must always win over one
 * reached through a definition.
 */
export interface VocabularyLink {
	/** Words borrowed from matching glossary notes, matched against names like query tokens. */
	tokens: Set<string>;
	/** Lowercased tables whose own note matched the question. */
	tables: Set<string>;
}

export function expandVocabulary(tokens: Set<string>, vocabulary?: string[], notesByTable?: Map<string, KnowledgeNote[]>): VocabularyLink {
	const link: VocabularyLink = { tokens: new Set<string>(), tables: new Set<string>() };
	if (tokens.size === 0) {
		return link;
	}
	// Both sides here are PROSE — an English question against an English note — so matching is
	// stemmed, unlike identifier matching, which stays strict. Without it "churned" misses a note
	// that says "churn", which is the single likeliest way for this to quietly do nothing.
	const asked = new Set([...tokens].map(stem));
	const matches = (text: string): Set<string> | undefined => {
		const noteTokens = queryTokens(text);
		for (const token of noteTokens) {
			if (asked.has(stem(token))) {
				return noteTokens;
			}
		}
		return undefined;
	};

	for (const text of vocabulary ?? []) {
		const noteTokens = matches(text);
		if (!noteTokens) {
			continue;
		}
		// Borrowed words go through the same normalisation as a table name, so a note saying
		// "cancellations" can match a table called `cancellation`.
		for (const token of normaliseTokens(noteTokens)) {
			// Only the words the question did NOT already carry: re-adding its own tokens at a lower
			// weight would change nothing except make the cap harder to reason about.
			if (!tokens.has(token) && link.tokens.size < EXPANSION_CAP) {
				link.tokens.add(token);
			}
		}
	}
	for (const [table, notes] of notesByTable ?? []) {
		if (notes.some((note) => matches(note.text) !== undefined)) {
			link.tables.add(table);
		}
	}
	return link;
}

/** A crude English stem for prose matching: churn/churned/churning, cancel/cancels/cancelled.
 *  Deliberately not a real stemmer — this only has to make two humans' phrasings meet. */
function stem(word: string): string {
	for (const suffix of ['ing', 'ed', 'es', 's']) {
		if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
			const base = word.slice(0, -suffix.length);
			// "cancelled" → "cancell" → "cancel", so a doubled final consonant does not split the pair.
			return base.length > 3 && base.at(-1) === base.at(-2) ? base.slice(0, -1) : base;
		}
	}
	return word;
}

function scoreTable(table: TableInfo, tokens: Set<string>, partial = '', link?: VocabularyLink): number {
	let score = 0;
	const nameTokens = normaliseTokens(splitIdentifier(table.name));
	if (partial.length >= 2) {
		const lower = table.name.toLowerCase();
		if (lower.startsWith(partial)) {
			score += PREFIX_NAME + Math.round(PREFIX_COVERAGE * (partial.length / lower.length));
		} else if (splitIdentifier(table.name).some((word) => word.startsWith(partial))) {
			score += PREFIX_WORD;
		}
		if (table.columns.some((column) => column.name.toLowerCase().startsWith(partial))) {
			score += PREFIX_COLUMN;
		}
	}
	for (const token of tokens) {
		if (nameTokens.has(token)) {
			score += NAME_HIT;
		}
	}
	// A whole-name match (the table is literally the queried word, singular/plural included)
	// must beat tables that merely contain the word — so "users" ranks `user` above tables
	// like `user_log` or `archived_users`. `tokens` already carries the singular; check the plural too.
	const nameLower = table.name.toLowerCase();
	for (const token of tokens) {
		if (nameLower === token || nameLower === `${token}s` || (token.endsWith('s') && nameLower === token.slice(0, -1))) {
			score += EXACT_NAME;
			break;
		}
	}
	// The user's own vocabulary, bridged to this schema (see expandVocabulary). Scored below a real
	// name hit, so a table the question actually named always outranks one reached by definition.
	if (link) {
		if (link.tables.has(nameLower)) {
			score += NOTE_TABLE_HIT;
		}
		for (const token of link.tokens) {
			if (nameTokens.has(token)) {
				score += SYNONYM_HIT;
			}
		}
	}
	let columnHits = 0;
	for (const column of table.columns) {
		const columnTokens = normaliseTokens(splitIdentifier(column.name));
		for (const token of tokens) {
			if (columnTokens.has(token)) {
				columnHits++;
				break;
			}
		}
	}
	return score + Math.min(columnHits, COLUMN_HIT_CAP);
}

/**
 * Schema linking: order tables by relevance to the user's question so the char budget
 * spends detail on the tables that matter. Scores lexical name/column overlap, expands the
 * question through the user's own vocabulary ({@link expandVocabulary}), then does a one-hop FK
 * expansion (a matched table pulls in its join partners), then keeps everything else in its
 * original order. Deterministic and local — no embeddings, no model round-trip. With no focus
 * (e.g. completion) the original order is preserved.
 */
function rankTables(schema: DatabaseSchema, focus: string | undefined, usage?: Map<string, number>, partial = '', link?: VocabularyLink): TableInfo[] {
	const tokens = focus ? queryTokens(focus) : new Set<string>();
	// How often the user has queried each table — their behaviour as a relevance signal. Used as
	// the tiebreaker after lexical score (and as the PRIMARY order when the question carries no
	// lexical signal), so the detailed-schema budget lands on tables the user actually uses and
	// never-touched tables sink.
	const usageOf = (table: TableInfo): number => usage?.get(table.name.toLowerCase()) ?? 0;
	if (tokens.size === 0 && partial.length < 2) {
		// No lexical signal from the question: fall back to usage order, then original order.
		if (!usage || usage.size === 0) {
			return schema.tables;
		}
		return schema.tables
			.map((table, index) => ({ table, index }))
			.sort((a, b) => usageOf(b.table) - usageOf(a.table) || a.index - b.index)
			.map((entry) => entry.table);
	}
	const byName = new Map<string, TableInfo>();
	for (const table of schema.tables) {
		byName.set(table.name.toLowerCase(), table);
	}
	const base = new Map<TableInfo, number>();
	for (const table of schema.tables) {
		base.set(table, scoreTable(table, tokens, partial, link));
	}
	const score = new Map<TableInfo, number>(base);
	const matched = schema.tables.filter((table) => (base.get(table) ?? 0) > 0);
	const matchedNames = new Set(matched.map((table) => table.name.toLowerCase()));

	// Forward edges: a matched table pulls in the tables it references.
	for (const table of matched) {
		for (const fk of table.foreignKeys) {
			const ref = byName.get(fk.referencedTable.toLowerCase());
			if (ref && (base.get(ref) ?? 0) === 0) {
				score.set(ref, Math.max(score.get(ref) ?? 0, FK_NEIGHBOR));
			}
		}
	}
	// Reverse edges: tables that reference a matched table.
	for (const table of schema.tables) {
		if ((base.get(table) ?? 0) > 0) {
			continue;
		}
		if (table.foreignKeys.some((fk) => matchedNames.has(fk.referencedTable.toLowerCase()))) {
			score.set(table, Math.max(score.get(table) ?? 0, FK_NEIGHBOR));
		}
	}

	// Lexical score first (a real name/column match must win); usage breaks ties — which is
	// where it matters, since the long tail of zero-score tables is exactly what competes for the
	// last detailed slots. So a frequently-queried table beats a never-queried one for that slot.
	return schema.tables
		.map((table, index) => ({ table, index, score: score.get(table) ?? 0 }))
		.sort((a, b) => b.score - a.score || usageOf(b.table) - usageOf(a.table) || a.index - b.index)
		.map((entry) => entry.table);
}

/** Count how many of the user's past queries referenced each table (lowercased name → count).
 *  The user's own query history is a strong, app-known relevance signal: tables they touch a lot
 *  matter to them; tables they never query shouldn't claim the detailed-schema token budget. Feeds
 *  {@link rankTables} alongside lexical relevance (smart context selection before token caps).
 *  Each query counts a table at most once (presence, not occurrence count). */
export function buildTableUsage(sqls: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const sql of sqls) {
		for (const name of referencedTables(sql)) {
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}
	return counts;
}

/** Order routines by name relevance to the question (same lexical signal as tables, name
 *  only — routines have no columns). With no focus, original order is kept. */
function rankRoutines(routines: RoutineInfo[], focus: string | undefined): RoutineInfo[] {
	const tokens = focus ? queryTokens(focus) : new Set<string>();
	if (tokens.size === 0) {
		return routines;
	}
	return routines
		.map((routine, index) => {
			const nameTokens = normaliseTokens(splitIdentifier(routine.name));
			let score = 0;
			for (const token of tokens) {
				if (nameTokens.has(token)) {
					score += NAME_HIT;
				}
			}
			return { routine, index, score };
		})
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.routine);
}

/** Render a routine's call signature from its introspected parameters: `kind_id int, ref_id
 *  int`. `undefined` params (not introspected) → `…`; an empty list → `` (takes none). */
function routineSignature(routine: RoutineInfo): string {
	if (routine.parameters === undefined) {
		return '…';
	}
	return routine.parameters.map((p) => (p.name ? `${p.name} ${p.dataType}` : p.dataType)).join(', ');
}

/**
 * The stored functions/procedures section of the prompt: relevance-ranked, capped at
 * `limit`, with a real call signature from the introspected parameters — so the model knows
 * it can call DB routines (e.g. `lookupName(kind_id, ref_id)` to resolve a display name
 * from an id) instead of inventing a join or returning a bare id. Returns [] when the schema
 * has no routines.
 */
function routineLines(schema: DatabaseSchema, focus: string | undefined, limit: number, quote: Quoter = (n) => n): string[] {
	const all = schema.routines ?? [];
	if (all.length === 0) {
		return [];
	}
	const shown = rankRoutines(all, focus).slice(0, limit);
	const header = all.length > shown.length
		? `Stored routines you may call (${all.length} exist; the ${shown.length} most relevant to the question):`
		: `Stored routines you may call (${all.length}):`;
	const lines = [header];
	for (const routine of shown) {
		lines.push(routine.kind === 'function'
			? `- ${qualifiedName(routine.schema, routine.name, quote)}(${routineSignature(routine)}) → ${routine.returnType ?? 'value'} [function]`
			: `- ${qualifiedName(routine.schema, routine.name, quote)}(${routineSignature(routine)}) [procedure]`);
	}
	lines.push('Call a function inline like FUNCTION(args) when it fits — e.g. lookupName(kind_id, ref_id) to resolve a name/label from an id, instead of a JOIN.');
	return lines;
}

/** Render a KB table/column note as a trailing `-- NOTE:` comment. Column notes (target
 *  "table.column") are prefixed with the column name so the model knows which field they describe. */
function noteComment(note: KnowledgeNote): string {
	const column = note.scope === 'column' && note.target?.includes('.') ? note.target.split('.').slice(1).join('.') : '';
	const text = note.text.trim().replace(/\s+/g, ' ');
	return column ? ` -- NOTE (${column}): ${text}` : ` -- NOTE: ${text}`;
}

/** Longest single database comment inlined into the prompt. A comment is usually one line, but
 *  nothing stops a DBA pasting an essay into one, and a wide table's worth of those would eat the
 *  budget that column detail needs. Trimmed rather than dropped: the first clause carries the meaning. */
const MAX_COMMENT_CHARS = 160;

/** Whitespace-collapsed, length-capped comment text, safe to inline after a `--`. Newlines would
 *  otherwise break the one-table-per-line shape the prompt (and the model) relies on. */
function commentText(raw: string): string {
	const text = raw.trim().replace(/\s+/g, ' ');
	return text.length > MAX_COMMENT_CHARS ? `${text.slice(0, MAX_COMMENT_CHARS - 1)}…` : text;
}

function detailLine(table: TableInfo, quote: Quoter = (n) => n, notes: KnowledgeNote[] = []): string {
	const columns = table.columns.map((c) => `${quote(c.name)} ${c.dataType}${c.isPrimaryKey ? ' PK' : ''}`).join(', ');
	const fks = table.foreignKeys.length > 0
		? ` -- FK: ${table.foreignKeys.map((fk) => `${fk.columns.map(quote).join(',')}→${qualifiedName(undefined, fk.referencedTable, quote)}(${fk.referencedColumns.map(quote).join(',')})`).join('; ')}`
		: '';
	// The database's OWN documentation (MySQL COLUMN_COMMENT, Postgres COMMENT ON, SQL Server
	// MS_Description). A DBA writing "settled in the payer's currency" on a column says what no
	// amount of name-matching can infer, so it goes in the prompt beside the type. Kept distinct
	// from `-- NOTE`, which is what the USER taught this app; these come from the schema itself.
	const tableComment = table.comment ? ` -- DESC: ${commentText(table.comment)}` : '';
	const described = table.columns.filter((c) => c.comment);
	const columnComments = described.length > 0
		? ` -- COLS: ${described.map((c) => `${quote(c.name)}: ${commentText(c.comment ?? '')}`).join('; ')}`
		: '';
	const noteText = notes.map(noteComment).join('');
	return `- ${qualifiedName(table.schema, table.name, quote)}(${columns})${fks}${tableComment}${columnComments}${seriesComment(table, quote)}${noteText}`;
}

/**
 * What a SnoutTime series table or rollup is, in the one line the model reads about it.
 * A series is partitioned by time, so a query that does not filter on its time column reads every
 * partition; a rollup has already aggregated it, so a time-bucketed question answered from the raw
 * table does work the database has done. A plain partitioned table says only that it is one, since
 * its partitions are folded out of the prompt.
 */
export function seriesComment(table: TableInfo, quote: Quoter = (n) => n): string {
	const s = table.series;
	if (s) {
		const sealed = s.partitions.filter((p) => p.state === 'sealed' || p.state === 'tiered').length;
		const shape = [
			`${s.partitionSize} partitions`,
			sealed > 0 ? `${sealed} of ${s.partitions.length} sealed into a column store` : `${s.partitions.length} partitions`,
			s.retention ? `rows kept ${s.retention}` : '',
		].filter(Boolean).join(', ');
		const rollups = s.rollups.length > 0
			? `; rollups: ${s.rollups.map((r) => `${qualifiedName(r.schema, r.name, quote)} (${r.bucket} buckets)`).join(', ')}, which answer a time-bucketed aggregate at or above their bucket already computed, so read one instead of aggregating this table`
			: '';
		return ` -- SERIES: time column ${quote(s.timeColumn)} (${shape}); always filter on ${quote(s.timeColumn)} so the database skips partitions, and bucket time with snouttime.bucket(interval, ${quote(s.timeColumn)})${rollups}`;
	}
	if (table.rollup) {
		return ` -- ROLLUP of ${qualifiedName(table.rollup.source.schema, table.rollup.source.name, quote)} by ${table.rollup.bucket}: already aggregated per bucket and current to the latest row; prefer it to re-aggregating the source`;
	}
	return '';
}

/**
 * Whether the model is shown a table at all. A partition is part of its parent: the prompt, like
 * the explorer, shows the parent only. SnoutTime's own catalog (`snouttime`), its column stores'
 * delta and delete tables (`snouttime_internal`) and a rollup's materialized buckets are
 * bookkeeping, not the user's data: what they say is already on the series' and rollup's lines.
 */
export function shownToModel(schema: DatabaseSchema, table: TableInfo): boolean {
	if (table.partitionOf || table.rollupStoreOf) {
		return false;
	}
	return !(schema.snouttime && (table.schema === 'snouttime' || table.schema === 'snouttime_internal'));
}

function withoutPartitions(schema: DatabaseSchema): DatabaseSchema {
	return schema.tables.every((t) => shownToModel(schema, t)) ? schema : { ...schema, tables: schema.tables.filter((t) => shownToModel(schema, t)) };
}

/**
 * Indexed schema for the prompt: the top {@link topTables} relevance-ranked tables get
 * full column detail (and FKs), and the remaining tables are announced by count only
 * (not enumerated). The assistant discovers the rest on demand via list_tables /
 * search_columns / describe_table.
 *
 * `topTables` is the primary lever — it caps the prompt regardless of database size,
 * which is what makes a 466-table schema usable by an 8B local model. `budget` is only a
 * sanity upper bound: if the top-N alone would exceed it (pathological wide tables) we
 * trim from the bottom of the detail list. Shared by chat (oneShot + agent) + completion.
 */
function schemaLines(fullSchema: DatabaseSchema, topTables: number, budget: number, focus?: string, exclude: Set<string> = new Set(), usage?: Map<string, number>, hasTools = false, quote: Quoter = (n) => n, notesByTable?: Map<string, KnowledgeNote[]>, pinnedTables?: Set<string>, vocabulary?: string[]): string[] {
	// A table with a hundred daily partitions is one table to the person asking, and a hundred
	// near-identical names would otherwise claim the whole detailed slice.
	const schema = withoutPartitions(fullSchema);
	// The question, widened by what the user has taught this app about their own database, so a
	// table they never named by name can still be found (expandVocabulary).
	const link = focus ? expandVocabulary(queryTokens(focus), vocabulary, notesByTable) : undefined;
	let ordered = rankTables(schema, focus, usage, '', link);
	// Force-include pinned KB tables: hoist them to the front of the ranked list so they claim the
	// detailed slice regardless of lexical rank. This closes the vocabulary-gap loop — a note on
	// `customer_order` shows its columns even when the question ("custumer sales") never matched it.
	if (pinnedTables && pinnedTables.size > 0) {
		const isPinned = (t: TableInfo): boolean => pinnedTables.has(t.name.toLowerCase());
		ordered = [...ordered.filter(isPinned), ...ordered.filter((t) => !isPinned(t))];
	}
	const targetCount = Math.min(topTables, ordered.length);
	const detailed: string[] = [];
	for (const tbl of ordered) {
		if (detailed.length >= targetCount) {
			break;
		}
		// Skip a decoy table (a resolved correction's name-stem sibling): keeping it in the
		// detailed slice gives the model a column-matching table to defect to. See editDecoyTables.
		if (exclude.has(tbl.name.toLowerCase())) {
			continue;
		}
		const entry = detailLine(tbl, quote, notesByTable?.get(tbl.name.toLowerCase()));
		// Trim from the tail if the top-N alone blows the upper bound (always keep ≥1).
		const projected = detailed.reduce((sum, line) => sum + line.length + 1, 0) + entry.length;
		if (detailed.length > 0 && projected > budget) {
			break;
		}
		detailed.push(entry);
	}

	// Everything not detailed (including excluded decoys — they still exist) is announced by count.
	const remaining = schema.tables.length - detailed.length;
	const lines = [`Schema for database "${schema.database}" (${schema.tables.length} tables; top ${detailed.length} most relevant to the question described in detail below):`];
	lines.push(...detailed);
	if (remaining > 0) {
		// One-line announcement, NOT a full enumeration of the other tables. A 458-entry tail
		// drowns the detailed slice for small local models (context rot — the model loses the
		// part that matters). See memory: small-models-context-rot. With tools (agent path)
		// discovery happens via list_tables / search_columns / describe_table; without them
		// (one-shot path) the model simply cannot see the other names, so it must say so and
		// never present its visible list as complete (the over-claim that reads as the AI
		// confidently knowing a schema it only partly sees).
		lines.push('', hasTools
			? `(${remaining} other tables exist in this database and are NOT detailed above — call list_tables(filter) to enumerate them, search_columns(term) to find a field by name, or describe_table(name) for a specific one. The detailed tables are only the most relevant, never the complete set: when asked which tables relate to a topic, search FIRST rather than answering from the detailed list alone.)`
			: `(${remaining} other tables exist in this database and are NOT shown here — their names are not visible to you. The tables above are only the few most relevant to the question, never the complete set. So do not present them as an exhaustive list: say there are ${remaining} other tables you cannot see and offer to look up a specific one.)`);
	}
	return lines;
}

/** Guidance for emitting a renderable chart. The UI parses a ```chart fenced JSON block and
 *  renders it inline (Recharts) with a Save (PNG/SVG/CSV) button. Shared by both chat prompts.
 *  `chartNoSql` is the full-screen AI Chat surface: there the chart is the deliverable, so the
 *  model renders it and skips the raw ```sql block (and never opens a tab just to chart). */
function chartGuidance(chartNoSql: boolean, dbRestricted = false): string {
	const intro =
		'When the user asks for a chart, graph, or to "visualize"/"plot" data, reply with a ```chart fenced block whose body is a single JSON object: ' +
		'{"type":"bar|line|area|pie|scatter","title":"...","x":"<category key>","series":[{"key":"<value key>","name":"..."}],"data":[{"<x>":...,"<value key>":...}, ...]}. ' +
		'Put the data points inline in "data" (each row an object keyed by the x key and every series key); cap it at about 100 rows. Never invent values. ';
	if (dbRestricted) {
		// No connection this turn (the user declined): there's no way to fetch real numbers, so a
		// data-backed chart is impossible — say so rather than charting made-up values.
		return intro +
			'However, no database is connected for this turn, so you CANNOT fetch real values and must not invent any. If the user wants a chart of their data, tell them to connect the database first, then you can query it and render the chart.';
	}
	if (chartNoSql) {
		// Full-screen AI Chat: no result grid is in view, so the chart itself is the whole
		// deliverable — fetch the numbers with run_query and don't surface the SQL.
		return intro +
			'The chart IS the deliverable: reply with just the ```chart block and a short sentence about it, and do NOT include a ```sql block (the raw query is not shown on this surface). ' +
			'Get the numbers yourself with run_query (read-only) — if you are unsure of a table or column, inspect it first with describe_table/search_columns, then run the aggregation. There is no result grid in view here, so do not rely on get_query_result.';
	}
	// Docked panel: the model may also show a ```sql block for the user to insert manually, but it
	// must FETCH chart data itself with run_query (or read the grid already on screen) — it cannot
	// run the editor.
	return intro +
		'For the numbers: if they are already in the result grid on screen, read them with get_query_result; otherwise fetch them yourself by calling run_query (inspect the schema with describe_table/search_columns first if you are unsure of a column). ' +
		'You may include a ```sql block too (the user inserts it manually with the button under it) alongside the ```chart block.';
}

/** Shown when the user was asked to connect the selected database and declined: this turn has no
 *  DB access on purpose, so the model must answer generally and never fake data or nag to connect. */
const DB_RESTRICTED_NOTE =
	'The user has a database selected but chose NOT to connect it for this question, so you have NO access to its schema or data: you cannot run queries, inspect tables, or produce a data-backed answer. ' +
	'Answer the general SQL question if you can. If the request needs live data (exact counts, a chart of real values, anything specific to their data), briefly tell the user you can\'t access precise data without a connection and that they can connect the database to get an accurate, data-backed answer. ' +
	'Do not invent table names, column names, or data values, and do not keep asking them to connect.';

/** Shown when no connection is selected and more than one is connected: the dialect is ambiguous,
 *  so the model must ask which database the user means rather than guessing (and writing SQL in the
 *  wrong dialect). The candidate list carries each connected DB's label + its SQL dialect. */
function ambiguousDbNote(options: { label: string; dialect: string }[]): string {
	const list = options.map((o) => `${o.label} (${o.dialect})`).join(', ');
	return 'No database is selected and more than one is connected, so the SQL dialect is unknown. ' +
		`Before writing ANY SQL, ask the user which of these connected databases they mean: ${list}. ` +
		'Do NOT guess the dialect or write SQL for any of them until the user chooses.';
}

/** The agent's tool list + protocol, shared by the connected prompt (after the schema block) and
 *  the connection-pending prompt (where no schema is loaded yet). */
const AGENT_TOOL_PROTOCOL: string[] = [
	'You have these tools:',
	'  - describe_table(name): get a table\'s full columns/keys/indexes',
	'  - list_tables(filter?): enumerate tables (use the filter on a large schema)',
	'  - search_columns(term): find tables/columns by substring',
	'  - run_query(sql): run ONE read-only statement (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN); the user approves each call',
	'  Every one of these also takes an optional connection argument (a saved connection\'s id or label from list_connections). Omit it to use the ACTIVE connection; set it to target a DIFFERENT database.',
	'',
	'Protocol:',
	'  1. If the answer is obvious from the tables described in detail above, write the SQL directly — no tool calls.',
	'  2. If you need a table that is listed by name only (no columns shown), call describe_table FIRST. Never guess column names.',
	'  3. Issue tool calls via the structured tool API. Do NOT write things like "Tool Call: SELECT …" or "Query: …" in your prose — that is not a tool call and the loop ignores it.',
	'  4. When a listed stored function resolves what is asked (e.g. a name/label from an id), CALL it — lookupName(kind_id, ref_id) — rather than returning the bare id or hand-joining.',
	'  5. If a filtered query returns 0 rows, do not just report "no results". First check whether the filter is the cause — e.g. run MIN/MAX (or DISTINCT) on the filtered column — and tell the user the actual range/values (e.g. "the data only spans 2019–2023, so 2026 is empty").',
	'  6. To work with a database OTHER than the active one (compare prod vs dev, copy a column between them), do NOT try to "switch" or "connect to" it as a way to redirect your queries — the tools always run against whichever connection you name. Instead pass the connection argument on each call, e.g. describe_table on prod with {"name":"customer_order","connection":"prod"} and again on dev with {"connection":"dev"}, then compare the two results. Call list_connections first if you are unsure of the exact id/label. The schema described in detail above is the ACTIVE connection only — never assume another connection has the same columns; inspect it with its own connection argument before claiming what it does or does not have.',
	'',
	'Example of a correct tool call: invoke describe_table with {"name": "orders"} — return the structured call, not prose about calling it.',
];

/** Pushed onto the agent prompt only when an editor + results grid are on screen (the docked panel).
 *  Filling the grid is the USER's action (they click Run / Insert under a ```sql block, exactly like
 *  Copy) — never the model's. So this steers the model AWAY from run_query for plain data-retrieval
 *  asks: it should hand over the final SQL and let the user run it, NOT run it itself. run_query is
 *  the agentic path (rows go back to the MODEL, never to the grid) and is only for when the model
 *  itself needs the data to keep working. NOT used on the full-screen chat surface (no editor/grid,
 *  no Run button), where the model must fetch + present the data in its reply itself. */
const RESULTS_IN_GRID_NOTE =
	'An editor and a results grid are on screen, and every ```sql block in your final answer has Run / Insert buttons under it — running a query is the USER\'s action (one click, just like Copy), never yours. So when the request is simply to SEE or retrieve data ("show me…", "what are…", "list…", "the last N…", "get…"), give the final ```sql block and let the user run it — do NOT call run_query. Reserve run_query for when YOU need the rows to continue your own work: to compute, compare, or verify a value, find an anomaly, or gather numbers for a chart. run_query rows come back to you only (they do not appear in the user\'s grid), so when you do use it, answer in prose with the specific finding rather than pasting the whole result set back.';

/** Performance/indexing discipline, baked into the agent system prompt so it persists for every turn
 *  of an optimization session (it must NOT ride the per-question message, or it evaporates the moment
 *  the user asks a normal follow-up). Framed as a HARD GATE on the ```sql block, not as principles: a
 *  modest model reasons fine in prose then skips verification and emits an unchecked fix. Across real
 *  runs it hallucinated "primary_phone has no index (shown earlier)" for a table never described this
 *  session, proposed an ALTER for an index that already existed, EXPLAINed only the original (never the
 *  rewrite), and changed the ORDER BY column — each a rule it was "asked to honor" and ignored. So the
 *  deliverable is blocked until the evidence is IN THE TRANSCRIPT, and the model must print the checklist
 *  with that evidence first. A checklist it must fill is followed far more reliably than a principle.
 *  Only meaningful with tools, so it's pushed only on the connected agent path (run_query / EXPLAIN /
 *  describe_table / SHOW INDEX are real calls there). */
const PERF_GUIDANCE: string[] = [
	'## When the task is to speed up a query (performance / indexing)',
	'First diagnose from the plan, not from memory: EXPLAIN the original. Before you trust any equality column as an index prefix, MEASURE its selectivity (COUNT(*) GROUP BY that column, or COUNT(DISTINCT col) vs COUNT(*)) — if one value is more than ~20% of the table (status / state / type flags are the usual trap: one value is most of the table), a leading index on it is useless or harmful, so do not propose it.',
	'',
	'## Hard gate — you may NOT emit a ```sql block for a performance fix until you have, IN THIS SESSION:',
	'(a) Called describe_table on EVERY table whose indexes or columns you make a claim about. If you say a column is or is not indexed, the describe_table output proving it must be in THIS conversation. No "shown earlier", no memory.',
	'(b) If you propose CREATE / ALTER INDEX: run SHOW INDEX FROM <table> first and confirmed the index does not already exist. A duplicate index is a wrong answer (the ALTER errors "Duplicate key name").',
	'(c) Run EXPLAIN on your FINAL rewrite (not just the original) and shown its plan uses the intended index, drops the rows examined, and has no "Using filesort" / "Using temporary". A fix you did not EXPLAIN is unverified.',
	'(d) Confirmed the rewrite returns the SAME rows AND the SAME order as the original: same SELECT list, same ORDER BY / LIMIT, reasoning about NULLs (NULL = x and NULL != x are both NULL) and duplicates (UNION dedups, UNION ALL does not). A UNION whose ORDER BY references a non-selected column MUST wrap the branches in a derived table — never silently change the ORDER BY column.',
	'Before the ```sql block, print these four as a checklist with the ACTUAL evidence (the EXPLAIN line, the SHOW INDEX result), not a restatement. If you cannot complete one, say so and label the fix UNVERIFIED rather than presenting it as the answer.',
];

/** Postgres 18's B-tree skip scan serves a filter with no equality on a multicolumn index's leading
 *  column, and does it best when that column has FEW distinct values, so the selectivity rule above
 *  is wrong there for a multicolumn index. 18 also rewrites `col = a OR col = b` into
 *  `col = ANY(...)` itself, so the OR-chain rewrite a model reaches for buys nothing. */
const PG_SKIP_SCAN_VERSION = 180000;
const PG18_PERF_NOTES: string[] = [
	'This server is PostgreSQL 18 or later, which changes two of the usual moves:',
	'- Skip scan: a multicolumn B-tree index is usable for a filter on its later columns even with no condition on the leading one, and works BEST when the leading column has few distinct values. So the selectivity rule above applies to a single-column index; a low-selectivity column (status, type, a flag) LEADING a multicolumn index is fine here. Before proposing a new index on a later column, check whether an existing multicolumn index already serves it by skip scan (EXPLAIN shows an Index Scan on it).',
	'- An OR on one column (col = a OR col = b) is rewritten by the planner to col = ANY(...), so do not rewrite it to IN, ANY or UNION for speed. An OR across DIFFERENT columns is unchanged.',
];

/** The performance rules for this connection: PG18_PERF_NOTES added when the server is 18+. */
function perfGuidance(schema: DatabaseSchema): string[] {
	return (schema.serverVersionNum ?? 0) >= PG_SKIP_SCAN_VERSION ? [...PERF_GUIDANCE, '', ...PG18_PERF_NOTES] : PERF_GUIDANCE;
}

/** Who the chat assistant is: its name and character come from the build (`shared/assistant.ts`;
 *  Liby in the official one, plain "AI" in the open-source one), so the model knows the name the
 *  screen shows. The em-dash rule is the app's, whoever the assistant is. Kept short: it rides every
 *  turn. */
const ASSISTANT_LINE = `${ASSISTANT_IDENTITY} Never write an em-dash; use a comma, a period or a colon.`;

/** The intro lines for the document (MongoDB) one-shot prompt: the assistant proposes a native
 *  aggregation pipeline in a ```json block. Mirrors the SQL intro's discipline (one final block,
 *  no invented identifiers, prose for "what exists" questions), reworded for collections/pipelines.
 *  The schema/ambient/thinking sections are shared with the SQL path, so only the framing differs. */
function documentIntroLines(): string[] {
	return [
		`You are ${assistantIs('MongoDB assistant in SnoutData Studio')}, a database IDE. The active database is MongoDB, a document database queried with aggregation pipelines (not SQL).`,
		ASSISTANT_LINE,
		'When the user wants to query data, propose ONE MongoDB aggregation pipeline in a single ```json fenced code block: a JSON array of stages that runs against ONE collection. Example: ```json\n[{"$match": {"status": "active"}}, {"$sort": {"createdAt": -1}}, {"$limit": 20}]\n```. Use only the collections and fields described below — never invent identifiers. Be concise.',
		'The UI shows an "Insert into pipeline" button under EVERY ```json block. So put only the FINAL pipeline you want the user to run in a ```json block — at most one. Show any incorrect, "before", or example pipeline as inline code with single backticks (or a plain ```text fence), never as ```json, so the user is never offered to run the wrong one.',
		'Not every question needs a pipeline: when asked which collections or fields exist or relate to a topic, answer in prose by naming the relevant ones from the schema below.',
		'IMPORTANT: the collections described in detail below are only the few most relevant to the question — NOT the whole database. Other collections exist whose names are not shown to you. So never present a list of collections as complete or exhaustive: name the relevant ones you can see, then state that more exist. Never claim a collection does or does not exist based only on what is shown here.',
	];
}

/** A one-line directive telling the model to quote reserved-word identifiers, with a concrete
 *  dialect-correct example, so it copies `"order"` / `` `order` `` / `[order]` from the schema
 *  below instead of emitting a bare reserved word (a syntax error). SQL paths only. */
function reservedWordGuidance(dialect: string, quote: Quoter): string {
	return `Some identifiers are reserved words and MUST be quoted to be valid ${dialect}: a table or column literally named "order" has to be written ${quote('order')}, never bare order (a syntax error). Any such name is already shown quoted in the schema below; reuse it exactly as written, quotes included.`;
}

/** System prompt grounding the assistant in the active connection's dialect + schema.
 *  Used by the one-shot (Ask) chat path. */
export function buildSystemPrompt(dialect: string, schema: DatabaseSchema | null, opts: PromptOptions = {}): string {
	const extra = opts.instructions?.trim();
	const quote = quoterFor(opts);
	const lines: string[] = opts.documentMode ? documentIntroLines() : [
		`You are ${assistantIs('SQL assistant in SnoutData Studio')}, a SQL IDE. The active database is ${dialect}.`,
		ASSISTANT_LINE,
		`Write correct, runnable ${dialect} SQL. Put any runnable SQL in a single \`\`\`sql fenced code block, and prefer one statement. Use only the tables and columns described below — never invent identifiers. Be concise.`,
		`The UI shows an "Insert into editor" button under EVERY \`\`\`sql block. So put only the final SQL you want the user to run in a \`\`\`sql block — at most one. Show any incorrect, "before", or example-of-the-bug SQL as inline code with single backticks (or a plain \`\`\`text fence), never as \`\`\`sql, so the user is never offered to run the wrong query.`,
		`Not every question needs SQL: when asked which tables or columns exist or relate to a topic, answer in prose by naming the relevant ones from the schema below. Never write a query to discover tables — no SELECT against the database name, information_schema, or sys.* (the database name is not a table).`,
		`IMPORTANT: the tables described in detail below are only the few most relevant to the question — NOT the whole database. Many other tables exist and their names are not shown to you. So never present a list of tables (or "the tables related to X") as complete or exhaustive: name the relevant ones you can see, then state that more tables exist that aren't shown and offer to search for a specific one. Never claim a table does or does not exist based only on what is shown here.`,
		chartGuidance(opts.chartNoSql ?? false, opts.dbRestricted ?? false),
	];
	if (!opts.documentMode) {
		lines.push(reservedWordGuidance(dialect, quote));
	}
	if (extra) {
		lines.push(extra);
	}

	if (!schema || schema.tables.length === 0) {
		if (opts.ambiguousConnections && opts.ambiguousConnections.length > 0) {
			lines.push(ambiguousDbNote(opts.ambiguousConnections));
		} else {
			lines.push(opts.dbRestricted ? DB_RESTRICTED_NOTE : 'No schema is available (no active connection). Ask the user to connect, or answer generally.');
		}
		return lines.join('\n');
	}

	lines.push('', ...schemaLines(schema, topNOf(opts), budgetOf(opts), opts.focus, opts.excludeTables, opts.tableUsage, false, quote, opts.notesByTable, opts.pinnedTables, opts.vocabulary));
	const routines = routineLines(schema, opts.focus, DEFAULT_TOP_ROUTINES, quote);
	if (routines.length > 0) {
		lines.push('', ...routines);
	}
	return lines.join('\n');
}

/**
 * System prompt for the agent loop. Same indexed schema as {@link buildSystemPrompt} so
 * the model has column-level grounding for the top-N relevance-ranked tables — small
 * models can answer without a single tool call when the right table is already in
 * detail. Adds a structured tool protocol + a worked example, since loose "use tools"
 * phrasing leads small models to write prose like `Tool Call: SELECT …` instead of
 * issuing a structured call.
 */
export function buildAgentPrompt(dialect: string, schema: DatabaseSchema | null, opts: PromptOptions = {}): string {
	const extra = opts.instructions?.trim();
	const quote = quoterFor(opts);
	const lines: string[] = opts.documentMode ? [
		...documentIntroLines(),
		'You also have tools to inspect the database (described below); tool calls go through the structured tool API, NOT fenced blocks. Only the final pipeline you want the user to run goes in a ```json block.',
	] : [
		`You are ${assistantIs('SQL assistant in SnoutData Studio')}, a SQL IDE. The active database is ${dialect}.`,
		ASSISTANT_LINE,
		`Write correct, runnable ${dialect} SQL. Put any runnable SQL in a single \`\`\`sql fenced code block, and prefer one statement. Use only the tables and columns you have seen — never invent identifiers. Be concise.`,
		`The UI shows an "Insert into editor" button under EVERY \`\`\`sql block in your final answer. So put only the final SQL you want the user to run in a \`\`\`sql block — at most one. Show any incorrect, "before", or example-of-the-bug SQL as inline code with single backticks (or a plain \`\`\`text fence), never as \`\`\`sql, so the user is never offered to run the wrong query. (This is about your prose answer; tool calls like run_query go through the structured tool API, not fenced blocks.)`,
		`Not every question needs SQL: when asked which tables or columns exist or relate to a topic, answer in prose by naming the relevant ones. Never write a query to discover tables — no SELECT against the database name, information_schema, or sys.* (the database name is not a table). For tables shown by name only, or not shown, use search_columns/list_tables/describe_table instead.`,
		`The detailed tables below are only the few most relevant to the question, NOT the whole database. When the question is to enumerate which tables relate to a topic (e.g. "what tables are related to users"), you MUST call search_columns/list_tables to find ALL matches before answering — never answer such a question from the detailed list alone, and never present it as complete when other tables exist.`,
		chartGuidance(opts.chartNoSql ?? false, opts.dbRestricted ?? false),
	];
	if (!opts.documentMode) {
		lines.push(reservedWordGuidance(dialect, quote));
	}
	if (extra) {
		lines.push(extra);
	}
	if (!schema || schema.tables.length === 0) {
		if (opts.ambiguousConnections && opts.ambiguousConnections.length > 0) {
			// No connection is selected and more than one is connected: don't guess the dialect, ask
			// which DB. The DB tools aren't bound (no connection passed), so just ask.
			lines.push(ambiguousDbNote(opts.ambiguousConnections));
			return lines.join('\n');
		}
		if (opts.dbRestricted) {
			// The user was asked to connect and declined: no DB access this turn, and the DB tools
			// are not advertised. Tell the model to answer generally without faking data.
			lines.push(DB_RESTRICTED_NOTE);
			return lines.join('\n');
		}
		if (opts.connectionPending) {
			// A connection is selected but offline: the tools still work — the first DB tool call asks
			// the user to connect, then runs. The schema isn't loaded yet, so the model must explore it.
			lines.push(
				'A database connection is SELECTED but not connected yet, so its schema is not loaded. Your tools still work: the FIRST DB tool call (list_tables, describe_table, search_columns, run_query) will ask the user for permission to connect, then run. Use list_tables/describe_table/search_columns to learn the schema before writing SQL — never guess table or column names.',
				'',
				...AGENT_TOOL_PROTOCOL,
			);
			if (opts.gridInView) {
				lines.push('', RESULTS_IN_GRID_NOTE);
			}
			return lines.join('\n');
		}
		lines.push('No database is connected, so the tools are unavailable. Ask the user to connect, or answer generally.');
		return lines.join('\n');
	}

	lines.push('', ...schemaLines(schema, topNOf(opts), budgetOf(opts), opts.focus, opts.excludeTables, opts.tableUsage, true, quote, opts.notesByTable, opts.pinnedTables, opts.vocabulary));
	const routines = routineLines(schema, opts.focus, DEFAULT_TOP_ROUTINES, quote);
	if (routines.length > 0) {
		lines.push('', ...routines);
	}
	lines.push('', ...AGENT_TOOL_PROTOCOL);
	if (opts.gridInView) {
		lines.push('', RESULTS_IN_GRID_NOTE);
	}
	if (!opts.documentMode) {
		lines.push('', ...perfGuidance(schema));
	}
	return lines.join('\n');
}

// Caps for the always-included glossary block. Small by design — these are the high-value
// vocabulary-gap facts and there aren't many. Count + char caps with an honest "N more" line rather
// than a silent truncation (same discipline as the schema tail).
const GLOSSARY_MAX_NOTES = 40;
const GLOSSARY_MAX_CHARS = 4000;

/**
 * The always-included "what the user has taught you about this database" block (bucket A). Built
 * from the connection's enabled glossary notes and stapled into the chat system prompt separately
 * from `opts.instructions` (that channel is the user's behavior guidance — kept independent so each
 * is editable and clearly sourced). Typo/synonym-proof by construction: always in, no retrieval
 * filter to miss. Capped by count + chars with an honest "(N more…)" line. Returns '' when empty.
 */
export function buildGlossaryBlock(glossary: KnowledgeNote[]): string {
	if (glossary.length === 0) {
		return '';
	}
	const lines: string[] = [];
	let used = 0;
	let shown = 0;
	for (const note of glossary) {
		const text = note.text.trim().replace(/\s+/g, ' ');
		if (!text) {
			continue;
		}
		if (shown >= GLOSSARY_MAX_NOTES || (shown > 0 && used + text.length > GLOSSARY_MAX_CHARS)) {
			break;
		}
		lines.push(`- ${text}`);
		used += text.length;
		shown++;
	}
	if (shown === 0) {
		return '';
	}
	const omitted = glossary.length - shown;
	if (omitted > 0) {
		lines.push(`- (${omitted} more note${omitted === 1 ? '' : 's'} not shown here.)`);
	}
	return [
		'## What the user has taught you about THIS database (durable notes, treat as authoritative)',
		'These are facts the user has explicitly taught the assistant about their own database. Trust them over your own assumptions about naming — e.g. if a note says sales data lives in a differently-named table, use that table.',
		'',
		lines.join('\n'),
	].join('\n');
}

/** The max length we ask the model to keep a drafted fact under, and the hard clip we apply to
 *  whatever it returns (belt and suspenders — a durable note should be one tight sentence). */
export const KNOWLEDGE_DRAFT_MAX_CHARS = 240;
// How much conversation to feed the drafter: recent turns matter most, and this is a cheap
// one-shot call, so bound it hard.
const DRAFT_MAX_TURNS = 12;
const DRAFT_MAX_TURN_CHARS = 800;

/**
 * System prompt for the "Refine with AI" drafter: turn a chat exchange (+ the user's optional hint)
 * into ONE durable, reusable fact about their database. Grounded in the dialect + schema so the fact
 * uses real identifiers. Returns plain text — the user picks the scope/target in the popover.
 */
export function buildKnowledgeDraftPrompt(dialect: string, schema: DatabaseSchema | null, opts: PromptOptions = {}): string {
	const lines: string[] = [
		`You help maintain a per-database knowledge base for a ${dialect} SQL assistant. You turn a chat conversation (and the user's optional note) into ONE durable, reusable fact about THIS database — the kind of domain or naming knowledge that should persist so the assistant stops getting it wrong.`,
		`Reply with ONLY the fact itself: a single self-contained factual statement, at most ${KNOWLEDGE_DRAFT_MAX_CHARS} characters, phrased as authoritative truth about this database. No prose around it, no quotes, no code fences, no preamble.`,
		'It must be a fact, NOT an instruction, NOT a question, NOT a SQL query. Use the real table/column names from the schema below. Good: "Sales are recorded in customer_order; fulfilled_date is the sale date, and there is no sales table." Bad: "show me the last 10 users".',
		'Base the fact on what the conversation actually revealed about the data model and on the user\'s note. Do NOT invent facts that the conversation and schema do not support. If the conversation carries no durable fact, distill the most useful naming/domain insight it does contain.',
	];
	if (schema && schema.tables.length > 0) {
		lines.push('', ...schemaLines(schema, topNOf(opts), budgetOf(opts), opts.focus, undefined, opts.tableUsage, false, quoterFor(opts)));
	}
	return lines.join('\n');
}

/** The user turn for the drafter: the recent conversation transcript + the user's optional hint. */
export function buildKnowledgeDraftUser(messages: ChatMessage[], hint?: string): string {
	const turns = messages
		.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
		.slice(-DRAFT_MAX_TURNS)
		.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${clip(m.content, DRAFT_MAX_TURN_CHARS)}`)
		.join('\n\n');
	const note = hint?.trim();
	return [
		'The conversation so far:',
		turns || '(no conversation yet)',
		'',
		note
			? `The user's note to refine into a durable fact:\n${note}`
			: 'The user did not type a note — infer the single most useful durable fact from the conversation above.',
	].join('\n');
}

/**
 * Clean the drafter's plain-text reply into a durable fact: strip any wrapping quotes / code fences /
 * "Fact:" preamble the model may add, collapse whitespace, and hard-clip. Falls back to the hint if the
 * model returns nothing, so the button always yields *something* editable rather than an error.
 */
export function cleanKnowledgeDraft(reply: string, hint?: string): string {
	let text = reply.trim();
	// Strip a wrapping code fence, if any.
	const fence = text.match(/^```[a-z]*\n?([\s\S]*?)\n?```$/i);
	if (fence) {
		text = fence[1].trim();
	}
	// Drop a leading label like "Fact:" or "Note:".
	text = text.replace(/^(?:fact|note|answer)\s*:\s*/i, '');
	// Strip surrounding quotes.
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\'') && text.endsWith('\''))) {
		text = text.slice(1, -1).trim();
	}
	text = text.replace(/\s+/g, ' ').trim();
	if (!text) {
		text = (hint ?? '').trim();
	}
	return text.slice(0, KNOWLEDGE_DRAFT_MAX_CHARS);
}

/** Char caps for the ambient "what the user is looking at" block — context selection, not
 *  context dumping: every field is metered against a small wallet, so the live SQL is bounded and
 *  the error is clipped rather than pasted whole. */
const AMBIENT_BUFFER_CHARS = 2000;
const AMBIENT_SELECTION_CHARS = 1000;
const AMBIENT_ERROR_CHARS = 600;
const AMBIENT_MAX_COLUMNS = 40;
const AMBIENT_OBJECT_DDL_CHARS = 1500;
const AMBIENT_OTHER_TAB_CHARS = 600;
const AMBIENT_MAX_OTHER_TABS = 4;
const AMBIENT_MAX_CONNECTIONS = 20;
const AMBIENT_MAX_FLOW_COLUMNS = 40;
const AMBIENT_MAX_FLOW_WARNINGS = 6;
const AMBIENT_FLOW_WARNING_CHARS = 200;
// The always-on result-row sample (resultRows): a glance at the actual data, kept deliberately
// tiny because it's pushed on every turn a result is on screen (the wallet tension, A5). A few
// rows, each cell clipped, with a hard total cap so a wide `SELECT *` can't blow the budget.
const AMBIENT_SAMPLE_ROWS = 5;
const AMBIENT_SAMPLE_CELL_CHARS = 60;
const AMBIENT_SAMPLE_TOTAL_CHARS = 1200;

/** Clip text to `max` chars, marking the cut so the model knows it's a tail, not the whole thing. */
function clip(text: string, max: number): string {
	const t = text.trim();
	return t.length > max ? `${t.slice(0, max)}\n-- … (truncated)` : t;
}

/**
 * Render the result-row sample ({@link AmbientContext.resultRows}) as a compact pipe table the
 * model can read directly, headed by the column names. Bounded on every axis (rows, columns, per
 * cell, and a hard total cap) because it rides every chat turn — context selection, not dumping.
 * Returns '' when there are no rows to show. Labelled as the FIRST rows so the model never assumes
 * it's the whole result (the full, current-order view is the get_query_result capability).
 */
function sampleTable(ambient: AmbientContext): string {
	const rows = ambient.resultRows;
	if (!rows || rows.length === 0) {
		return '';
	}
	const header = (ambient.resultColumns ?? []).slice(0, AMBIENT_MAX_COLUMNS).map((f) => f.name);
	const width = header.length || rows.reduce((n, r) => Math.max(n, r.length), 0);
	const cell = (v: string | undefined): string => clip(String(v ?? 'NULL'), AMBIENT_SAMPLE_CELL_CHARS).replace(/\s+/g, ' ');
	const lines: string[] = [];
	if (header.length > 0) {
		lines.push(header.join(' | '));
	}
	let used = lines[0]?.length ?? 0;
	let shown = 0;
	for (const row of rows.slice(0, AMBIENT_SAMPLE_ROWS)) {
		const line = Array.from({ length: width }, (_unused, i) => cell(row[i])).join(' | ');
		if (shown > 0 && used + line.length > AMBIENT_SAMPLE_TOTAL_CHARS) {
			break;
		}
		lines.push(line);
		used += line.length;
		shown++;
	}
	if (shown === 0) {
		return '';
	}
	return `A sample of the result rows currently shown (the first ${shown}, exactly as the grid displays them):\n${lines.join('\n')}`;
}

/**
 * The ambient "what the user is currently looking at" block, appended to the chat system
 * prompt so the assistant grounds in the live app state (the SQL on screen, the result shape,
 * the last error) WITHOUT the user restating it — the spine of the UX thesis (A1). Distinct
 * from the conversation: this is screen state the user did NOT type into chat, so it is labelled
 * as such and the model is told to use it directly. Returns '' when nothing is on screen.
 * Budget-capped (see AMBIENT_* above): shapes + bounded text only, never row values.
 */
export function buildAmbientComment(ambient: AmbientContext): string {
	const sections: string[] = [];
	if (ambient.connections && ambient.connections.length > 0) {
		const roster = ambient.connections.slice(0, AMBIENT_MAX_CONNECTIONS).map((c) => {
			const env = c.environment ? ` [${c.environment}]` : '';
			const flags = [c.connected ? 'connected' : 'not connected'];
			if (c.active) {
				flags.push('active');
			}
			return `- "${c.label}"${env} (${flags.join(', ')})`;
		}).join('\n');
		const more = ambient.connections.length > AMBIENT_MAX_CONNECTIONS
			? `\n- … (${ambient.connections.length - AMBIENT_MAX_CONNECTIONS} more)` : '';
		sections.push([
			'The user\'s saved database connections (the "active" one is what this chat is grounded on):',
			roster + more,
			'To act on an environment ("prod", "staging", "dev") or a connection the user names: match it against this list by its environment tag OR by its label containing that word (case-insensitive), so a connection labelled "Production" counts as prod even with no tag. If a name-only match conflicts with its tag (e.g. labelled "prod-mirror" but tagged dev), ask the user which they mean rather than guessing. If the chosen connection is not connected, open it with the connect capability (this asks the user\'s permission) and leave it open. If nothing matches, tell the user there is no such connection and ask which one they mean.',
		].join('\n'));
	}
	if (ambient.focusedTable?.name) {
		const t = ambient.focusedTable;
		const qualified = t.schema ? `${t.schema}.${t.name}` : t.name;
		sections.push(`The user is viewing the table \`${qualified}\` (open in a table tab). "this table" / "here" refers to it; its columns are in the schema above.`);
	}
	if (ambient.focusedObject?.name) {
		const o = ambient.focusedObject;
		const qualified = o.schema ? `${o.schema}.${o.name}` : o.name;
		let line = `The user is viewing the ${o.kind} \`${qualified}\` (open in an object tab). "this ${o.kind}" refers to it.`;
		const ddl = o.ddl?.trim();
		if (ddl) {
			line += `\n\`\`\`sql\n${clip(ddl, AMBIENT_OBJECT_DDL_CHARS)}\n\`\`\``;
		}
		sections.push(line);
	}
	if (ambient.flowWizard) {
		const flow = ambient.flowWizard;
		const lines = [`The user has the Data Flow wizard open, on its "${flow.step}" step. A data flow reads rows from a source, shapes them, and writes them to a destination; the wizard sets one up step by step.`];
		if (flow.stepNote) {
			lines.push(flow.stepNote);
		}
		if (flow.source) {
			lines.push(`Source: ${flow.source}.`);
		}
		if (flow.destination) {
			lines.push(`Destination: ${flow.destination}.`);
		}
		if (flow.outcome) {
			lines.push(`The user said this data is for: ${flow.outcome}.`);
		}
		if (flow.estimatedRows !== undefined) {
			lines.push(`The full run is estimated at about ${flow.estimatedRows} rows.`);
		}
		if (flow.columns && flow.columns.length > 0) {
			const roster = flow.columns.slice(0, AMBIENT_MAX_FLOW_COLUMNS).map((column) => {
				const flags = [column.key ? 'key' : '', column.included ? '' : 'excluded'].filter(Boolean);
				return `- ${column.name} (${column.type})${flags.length ? ` [${flags.join(', ')}]` : ''}`;
			}).join('\n');
			const more = flow.columns.length > AMBIENT_MAX_FLOW_COLUMNS
				? `\n- … (${flow.columns.length - AMBIENT_MAX_FLOW_COLUMNS} more)` : '';
			lines.push(`The columns the wizard currently proposes:\n${roster}${more}`);
		}
		if (flow.warnings && flow.warnings.length > 0) {
			lines.push(`Warnings the wizard is showing:\n${flow.warnings.slice(0, AMBIENT_MAX_FLOW_WARNINGS).map((w) => `- ${clip(w, AMBIENT_FLOW_WARNING_CHARS)}`).join('\n')}`);
		}
		if (flow.generation) {
			lines.push(flow.generation);
		}
		lines.push('"this flow", "these columns", "the file" and "the destination" refer to the wizard state above. Advise concretely against it — better names or types for specific columns, whether the key choice is sound, whether the destination fits the stated purpose — as a short list the user can apply in the wizard. Nothing is saved until they run it.');
		sections.push(lines.join('\n'));
	}
	const buffer = ambient.editorBuffer?.trim();
	if (buffer) {
		sections.push(`The SQL currently open in the editor:\n\`\`\`sql\n${clip(buffer, AMBIENT_BUFFER_CHARS)}\n\`\`\``);
	}
	const selection = ambient.selection?.trim();
	if (selection && selection !== buffer) {
		sections.push(`The text the user has highlighted in the editor:\n\`\`\`sql\n${clip(selection, AMBIENT_SELECTION_CHARS)}\n\`\`\``);
	}
	const otherTabs = (ambient.otherTabs ?? []).filter((t) => t.sql.trim()).slice(0, AMBIENT_MAX_OTHER_TABS);
	if (otherTabs.length > 0) {
		const blocks = otherTabs.map((t) => `"${t.title}":\n\`\`\`sql\n${clip(t.sql.trim(), AMBIENT_OTHER_TAB_CHARS)}\n\`\`\``).join('\n\n');
		sections.push(`The user's other open editor tabs (so "my other query" / "the query in my other tab" refers to one of these):\n\n${blocks}`);
	}
	if (ambient.resultColumns && ambient.resultColumns.length > 0) {
		const cols = ambient.resultColumns.slice(0, AMBIENT_MAX_COLUMNS)
			.map((f) => (f.dataType ? `${f.name} (${f.dataType})` : f.name)).join(', ');
		const more = ambient.resultColumns.length > AMBIENT_MAX_COLUMNS ? `, … (${ambient.resultColumns.length - AMBIENT_MAX_COLUMNS} more)` : '';
		sections.push(`The result grid currently shown has these columns: ${cols}${more}.`);
	}
	const sample = sampleTable(ambient);
	if (sample) {
		sections.push(sample);
	}
	if (ambient.selectedCell) {
		sections.push(`The user has selected the cell "${ambient.selectedCell.column}" = ${ambient.selectedCell.value} in the result grid.`);
	}
	if (ambient.selectedRow && ambient.selectedRow.length > 0) {
		const row = ambient.selectedRow.slice(0, AMBIENT_MAX_COLUMNS)
			.map((c) => `${c.column}=${c.value}`).join(', ');
		const more = ambient.selectedRow.length > AMBIENT_MAX_COLUMNS ? `, … (${ambient.selectedRow.length - AMBIENT_MAX_COLUMNS} more)` : '';
		sections.push(`The full row that cell is in: ${row}${more}.`);
	}
	const error = ambient.lastError?.trim();
	if (error) {
		sections.push(`The most recent query failed with this error:\n${clip(error, AMBIENT_ERROR_CHARS)}`);
	}
	const memoryNote = ambient.memoryNote?.trim();
	if (memoryNote) {
		sections.push(`From this database's failure history (a deterministic record of past failures, not a guess): ${memoryNote}`);
	}
	if (sections.length === 0) {
		return '';
	}
	return [
		'## What the user is looking at right now (live app state, not typed into chat)',
		'Use this directly to answer — do NOT ask the user to paste or restate the query, the error, or the result. It is already in front of them. If the user says "this query", "this error", or "these results", they mean the items below.',
		'',
		sections.join('\n\n'),
	].join('\n');
}

/**
 * System prompt for on-demand inline completion. Unlike the chat prompt it asks for raw
 * insertable text (no prose, no code fences) that slots in at the cursor — the user
 * message carries the surrounding document (see {@link buildCompletionUser}).
 */
export function buildCompletionPrompt(dialect: string, schema: DatabaseSchema | null, opts: PromptOptions = {}): string {
	const extra = opts.instructions?.trim();
	const lines: string[] = [
		`You are an autocompletion engine inside a ${dialect} SQL editor.`,
		`Reply with ONLY the raw ${dialect} text to insert at the cursor — no explanation, no markdown, no code fences, and do not repeat text that already appears before the cursor. The inserted text must be valid ${dialect} and read correctly together with the surrounding text. Use only tables and columns from the schema below; never invent them.`,
	];
	if (extra) {
		lines.push(extra);
	}
	if (!schema || schema.tables.length === 0) {
		lines.push('No schema is available; complete using only the surrounding SQL.');
		return lines.join('\n');
	}
	lines.push('', ...schemaLines(schema, topNOf(opts), budgetOf(opts), undefined, undefined, undefined, false, quoterFor(opts)));
	return lines.join('\n');
}

/** Char budget for the bare table-NAME list in the FIM comment (the tail after the detailed
 *  slice). Cheap relative to full column detail, and it lives in the cached prefix — but a
 *  466-table dump still rots context, so cap it and append "(+N more)". */
const COMPLETION_NAME_BUDGET = 1500;

/**
 * Schema for the FIM/completion comment. Unlike {@link schemaLines} (chat), the remaining
 * tables are listed by NAME rather than announced for tool discovery: a base FIM completer
 * cannot call list_tables, so a table that's neither detailed nor named simply gets
 * hallucinated (e.g. `from customer_‸` → an invented `customer_satisfaction_survey`). The
 * top-N (ranked by the cursor context via `focus`) get full columns; the rest are named in
 * rank order up to a char cap.
 */
function completionSchemaLines(schema: DatabaseSchema, topTables: number, budget: number, focus?: string, quote: Quoter = (n) => n, usage?: Map<string, number>, partial = ''): string[] {
	// `usage` (how often the user queries each table) matters MORE here than in chat: the completion
	// budget details only a handful of tables and names a few dozen, so on a large database the
	// ranking decides whether the table you are typing is in the prompt at all.
	const ordered = rankTables(schema, focus, usage, partial);
	const targetCount = Math.min(topTables, ordered.length);
	const detailed: string[] = [];
	const detailedNames = new Set<string>();
	for (const tbl of ordered) {
		if (detailed.length >= targetCount) {
			break;
		}
		const entry = detailLine(tbl, quote);
		const projected = detailed.reduce((sum, line) => sum + line.length + 1, 0) + entry.length;
		if (detailed.length > 0 && projected > budget) {
			break;
		}
		detailed.push(entry);
		detailedNames.add(tbl.name.toLowerCase());
	}
	const lines = [`Schema for database "${schema.database}" (${schema.tables.length} tables; ${detailed.length} most relevant detailed, the rest named):`];
	lines.push(...detailed);

	const names: string[] = [];
	let used = 0;
	let dropped = 0;
	for (const tbl of ordered) {
		if (detailedNames.has(tbl.name.toLowerCase())) {
			continue;
		}
		const name = qualifiedName(tbl.schema, tbl.name, quote);
		if (names.length > 0 && used + name.length + 2 > COMPLETION_NAME_BUDGET) {
			dropped++;
			continue;
		}
		names.push(name);
		used += name.length + 2;
	}
	if (names.length > 0) {
		lines.push(`Other tables (use only these names, never invent): ${names.join(', ')}${dropped > 0 ? ` (+${dropped} more)` : ''}`);
	}
	return lines;
}

/**
 * Schema grounding for the FIM path, as SQL comment lines prepended to the prefix
 * (a raw code model has no system prompt — comments are how it sees the schema). The top
 * tables are ranked by `opts.focus` (the cursor context) and the rest are named, so the
 * completer only ever sees real tables/columns. Honors the same char budget as chat.
 */
export function buildSchemaComment(dialect: string, schema: DatabaseSchema | null, opts: PromptOptions = {}): string {
	const lines = [`-- ${dialect} database.`];
	const extra = opts.instructions?.trim();
	if (extra) {
		lines.push(`-- ${extra}`);
	}
	if (schema && schema.tables.length > 0) {
		for (const line of completionSchemaLines(schema, topNOf(opts), budgetOf(opts), opts.focus, quoterFor(opts), opts.tableUsage, (opts.partialName ?? '').toLowerCase())) {
			lines.push(`-- ${line}`);
		}
	}
	return lines.join('\n');
}

/**
 * System prompt for an inline editor edit (Ctrl+K). Like completion it asks for raw SQL
 * (no prose, no fences), but instruction-driven: rewrite the user's selection, or generate
 * fresh SQL at the cursor. Grounded in the dialect + schema (ranked by the instruction).
 */
export function buildEditPrompt(dialect: string, schema: DatabaseSchema | null, opts: PromptOptions = {}, mode: 'edit' | 'generate' = 'edit'): string {
	const action = mode === 'edit'
		? `The user selected some ${dialect} SQL in the editor and wants it changed. Rewrite the selected SQL so it satisfies the instruction, preserving the parts that should stay.`
		: `The user wants new ${dialect} SQL generated to insert at the cursor.`;
	const hasSchema = !!schema && schema.tables.length > 0;
	const lines: string[] = [
		`You are a SQL editing assistant embedded in a SQL IDE. The active database is ${dialect}.`,
		action,
		`Reply with ONLY the raw ${dialect} SQL to apply — no explanation, no commentary, no markdown code fences. The output must be valid ${dialect} and ready to drop straight into the editor.`,
	];
	const quote = quoterFor(opts);
	if (hasSchema) {
		lines.push(
			'Use only tables and columns from the schema below; never invent them.',
			'If the SQL references a TABLE that is not in the schema, correct it to the table whose NAME most closely matches (a singular/plural variant or near-spelling, e.g. "users" → "user"), even if some other table\'s columns look like a closer fit — the name is the stronger signal of intent. Then make the referenced columns valid for that corrected table: keep the columns it has, and for any column it lacks, use the closest-named real column on that table (e.g. "last_login_at" → "last_login") or drop it. Do not switch to a differently-named table just because it happens to contain the listed columns.',
			// A common Ctrl+K failure: the instruction names a NEW table, the model swaps the table name
			// and carries the old table's WHERE/SELECT columns across verbatim (e.g. "warehouse WHERE
			// company_id=7" → "shelf WHERE company_id=7" when shelf only has warehouse_id). The column
			// list and the FK edges are both in the schema below, so say plainly to re-derive from them.
			'When the rewrite targets a DIFFERENT table than the one in the selected SQL, re-derive every column from that target table\'s own column list below. Never carry a column name across just because it appeared in the selected SQL — if the target table has no such column, it is wrong. Where the two tables are linked (the `-- FK:` note on a schema line shows which column joins to which table), use that foreign-key column to relate them, joining or nesting through it rather than filtering the target table by a column it does not have.',
			'Before answering, check every table and column you wrote against the schema lines below. If a column is not listed on the table you used, fix it.',
			reservedWordGuidance(dialect, quote),
		);
	} else {
		// No connection ⇒ no schema. Say so plainly; do NOT claim "the schema below" exists
		// (that dangling promise is what makes the model invent table/column names).
		lines.push('No database schema is available (no active connection), so table and column names cannot be verified. Make only the change the instruction asks for, and do not invent specific table or column names.');
	}
	const extra = opts.instructions?.trim();
	if (extra) {
		lines.push(extra);
	}
	if (schema && schema.tables.length > 0) {
		// Same grounding the chat gets: knowledge-base table notes ride the detailed lines and a
		// pinned note force-includes its table, so a Ctrl+K edit knows what the chat knows.
		lines.push('', ...schemaLines(schema, topNOf(opts), budgetOf(opts), opts.focus, opts.excludeTables, opts.tableUsage, false, quote, opts.notesByTable, opts.pinnedTables, opts.vocabulary));
		const routines = routineLines(schema, opts.focus, DEFAULT_TOP_ROUTINES, quote);
		if (routines.length > 0) {
			lines.push('', ...routines);
		}
	}
	return lines.join('\n');
}

/** Levenshtein edit distance between two short strings (table identifiers). Classic
 *  two-row DP — O(n·m) but the inputs are tiny, so it's cheap. */
function editDistance(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	if (a.length === 0) {
		return b.length;
	}
	if (b.length === 0) {
		return a.length;
	}
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	let curr = new Array<number>(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[b.length];
}

/**
 * Resolve a referenced-but-missing table name to the closest REAL table by NAME similarity.
 * Uses edit distance, so it catches singular/plural ("users"→"user"), trailing junk
 * ("user_"→"user"), and outright misspellings ("oser"→"user") in one mechanism. A
 * length-scaled threshold (longer names tolerate proportionally more typos) keeps it from
 * grabbing an unrelated table — e.g. "users" is distance 4 from "user_log", so that's
 * rejected. Same-word-token names (e.g. "orderitems" ↔ "order_items") count as a near-exact
 * match regardless of separators. Ties break to the shortest name (the "core" table, not a
 * `*_log`/`*_archive` variant), then alphabetically for determinism. Returns undefined when
 * nothing is close enough — then it's the model's call.
 */
function closestTableName(ref: string, tables: TableInfo[]): string | undefined {
	return closestIdentifier(ref, tables.map((t) => t.name));
}

/**
 * The generic half of {@link closestTableName}: resolve `ref` to the closest real identifier in
 * `names`, or undefined when nothing is close enough. Exported because the completion guard
 * (`completionGuard.ts`) repairs hallucinated COLUMN names with the same mechanism — one notion
 * of "close enough" across the edit and completion paths.
 */
export function closestIdentifier(ref: string, names: string[]): string | undefined {
	const refTokens = normaliseTokens(splitIdentifier(ref));
	let best: string | undefined;
	let bestScore = Infinity;
	for (const name of names) {
		const lower = name.toLowerCase();
		const tTokens = normaliseTokens(splitIdentifier(name));
		const sameTokens = tTokens.size === refTokens.size && refTokens.size > 0 && [...refTokens].every((tok) => tTokens.has(tok));
		// A matching token set is a strong signal even when separators/length differ, so floor
		// its score near zero; otherwise rank by raw edit distance.
		const score = sameTokens ? Math.min(editDistance(ref, lower), 1) : editDistance(ref, lower);
		if (score < bestScore || (score === bestScore && best !== undefined && (name.length < best.length || (name.length === best.length && name < best)))) {
			bestScore = score;
			best = name;
		}
	}
	// Tolerance grows with the name's length: a 4-char name allows ~1-2 edits, a long one more.
	const threshold = Math.max(2, Math.floor(ref.length * 0.34));
	return best !== undefined && bestScore <= threshold ? best : undefined;
}

/** One resolved correction: a referenced-but-missing table and the real table it maps to. */
interface TableCorrection {
	/** The (lowercased) name as written in the SQL, e.g. "users". */
	ref: string;
	/** The real table to use instead, original-cased, e.g. "user". */
	target: string;
}

/**
 * Deterministic table-name resolution for an edit: for each table the selected SQL reads from
 * that doesn't exist, resolve the closest REAL table by NAME ({@link closestTableName}).
 * Returns one entry per missing-but-resolvable reference (empty when all exist or none are
 * close enough). Shared by the user-message directive and the decoy-suppression set.
 */
function resolveCorrections(selection: string, schema: DatabaseSchema | null): TableCorrection[] {
	if (!schema || schema.tables.length === 0 || !selection.trim()) {
		return [];
	}
	const existing = new Set(schema.tables.map((t) => t.name.toLowerCase()));
	const corrections: TableCorrection[] = [];
	for (const ref of referencedTables(selection)) {
		if (existing.has(ref)) {
			continue; // the table exists — nothing to correct
		}
		const target = closestTableName(ref, schema.tables);
		if (target) {
			corrections.push({ ref, target });
		}
	}
	return corrections;
}

/**
 * The hard directives prepended to the edit's user message. The models reliably pick a table
 * whose COLUMNS match the SELECT list over one whose name matches (e.g. "users" → `legacy_users`
 * because it has `email`/`created_at`), and no amount of system-prompt wording reversed that —
 * so we make the decision in code and tell the model the answer.
 */
function tableCorrections(selection: string, schema: DatabaseSchema | null): string[] {
	return resolveCorrections(selection, schema).map(({ ref, target }) =>
		`The table "${ref}" does not exist in this database. Use the table "${target}" instead — it is the correct table by name. Do NOT substitute a different table just because its columns match the SELECT list; map the selected columns onto "${target}"'s real columns (rename to the closest real column, or drop any that have no match).`);
}

/**
 * Decoy tables to suppress from the edit's detailed schema. Telling the model "use `user`" is
 * not enough on its own — the mid/cloud models still defect to a sibling like `user_log` or
 * `legacy_users` because it sits in the prompt WITH the columns the user typed. So when a
 * correction resolves `users`→`user`, we drop the other tables whose name shares the resolved
 * target's word-stem (and aren't the target itself) from the detailed slice: no decoy in the
 * prompt, nowhere to defect to. The dropped tables still exist and are covered by the
 * "other tables exist" line. Returns a lowercased set (empty when no correction fired).
 */
export function editDecoyTables(selection: string, schema: DatabaseSchema | null): Set<string> {
	const corrections = resolveCorrections(selection, schema);
	if (corrections.length === 0 || !schema) {
		return new Set();
	}
	const targets = new Set(corrections.map((c) => c.target.toLowerCase()));
	// The word-tokens of every resolved target, e.g. {user}. A sibling is a non-target table
	// that contains any of these stems (user_log, dashboard_user, legacy_users → all match "user").
	const stems = new Set<string>();
	for (const c of corrections) {
		for (const tok of normaliseTokens(splitIdentifier(c.target))) {
			stems.add(tok);
		}
	}
	const decoys = new Set<string>();
	for (const t of schema.tables) {
		const lower = t.name.toLowerCase();
		if (targets.has(lower)) {
			continue; // never drop the table we told it to use
		}
		const tTokens = normaliseTokens(splitIdentifier(t.name));
		if ([...stems].some((stem) => tTokens.has(stem))) {
			decoys.add(lower);
		}
	}
	return decoys;
}

/** The user message for an inline edit: the instruction, the selection (edit mode), and the
 *  surrounding document for context (capped so a big buffer doesn't blow the budget). When a
 *  schema is given, a deterministic {@link tableCorrections} directive is prepended for any
 *  referenced table that doesn't exist (the models won't make this correction on their own). */
export function buildEditUser(instruction: string, selection: string, document: string, mode: 'edit' | 'generate', schema: DatabaseSchema | null = null): string {
	const parts = [`Instruction: ${instruction}`];
	if (mode === 'edit') {
		const corrections = tableCorrections(selection, schema);
		if (corrections.length > 0) {
			parts.push('', ...corrections);
		}
		parts.push('', 'Selected SQL to rewrite:', selection);
	}
	const doc = document.trim();
	if (doc && doc !== selection.trim()) {
		parts.push('', 'The full document, for context only (do not return it — only the replacement):', doc.length > 4000 ? `${doc.slice(0, 4000)}\n…` : doc);
	}
	parts.push('', mode === 'edit' ? 'Return only the rewritten SQL.' : 'Return only the SQL to insert.');
	return parts.join('\n');
}

/** The user message for a completion: the document split around the cursor. */
export function buildCompletionUser(prefix: string, suffix: string): string {
	return [
		'Text before the cursor:',
		prefix.length ? prefix : '(start of document)',
		'',
		'Text after the cursor:',
		suffix.length ? suffix : '(end of document)',
		'',
		'Return only the text to insert at the cursor.',
	].join('\n');
}

/**
 * Clean a model reply into raw insertable text. Passes, in order:
 *  1. drop any markdown code fence the model added despite instructions;
 *  2. remove an echoed overlap with the text already BEFORE the cursor (some models restate
 *     the trailing prefix before continuing);
 *  3. cut where the model runs PAST the gap and starts reproducing the text AFTER the cursor.
 *     A base FIM completer has no natural stop, so it tends to re-emit the suffix (the closing
 *     paren, the statement's `;`, the next clause) and then ramble into fresh statements or
 *     `-- …` echoes — see {@link trimToSuffixBoundary}.
 *  4. cut a runaway that has spilled into a SECOND statement (see {@link trimRunawayStatements}):
 *     with an empty suffix there's no boundary to trigger pass 3, so `… WHERE primary_` completes
 *     to `phone = '…';\nSELECT …;\nSELECT …` — three statements of ghost text. An inline insertion
 *     is always one statement, so cut at the first top-level `;` that has another statement after it.
 *  5. drop a runaway tail after the first blank line (a blank line marks a new statement/echo,
 *     never part of one insertion).
 */
export function extractCompletion(reply: string, prefix: string, suffix = ''): string {
	let text = reply.trim();
	const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(text);
	if (fenced) {
		text = fenced[1];
	} else {
		text = text.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```$/, '');
	}
	const maxOverlap = Math.min(prefix.length, text.length);
	for (let k = maxOverlap; k > 0; k--) {
		if (prefix.slice(prefix.length - k) === text.slice(0, k)) {
			text = text.slice(k);
			break;
		}
	}
	text = trimToSuffixBoundary(text, suffix);
	text = trimRunawayStatements(text, suffix);
	const blank = text.search(/\n[ \t]*\n/);
	if (blank > 0) {
		text = text.slice(0, blank);
	}
	return text.replace(/\s+$/, '');
}

/**
 * Keep an inline completion to a SINGLE statement. A base FIM completer with no suffix boundary
 * fills the gap and then keeps emitting whole extra statements (`phone = '…';\nSELECT …;\nSELECT
 * …`), which {@link trimToSuffixBoundary} can't catch — it early-returns on an empty suffix, and
 * the statements are joined by single newlines so the blank-line trim misses them too. So scan for
 * the first top-level `;` and, if any non-whitespace follows it, cut there: keep the `;` when the
 * cursor is at the end of the buffer (empty suffix — the one statement terminates cleanly), drop it
 * when the suffix continues the statement. String/bracket-aware so a `;` inside a literal or a
 * nested block (a plausible future case) isn't mistaken for the boundary. Returns `text` unchanged
 * when it holds at most one statement.
 */
function trimRunawayStatements(text: string, suffix: string): string {
	let depth = 0;
	let str: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (str !== null) {
			if (c === str) {
				str = null;
			}
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			str = c;
			continue;
		}
		if (c === '(' || c === '[') {
			depth++;
			continue;
		}
		if (c === ')' || c === ']') {
			if (depth > 0) {
				depth--;
			}
			continue;
		}
		if (c === ';' && depth === 0) {
			if (text.slice(i + 1).trim().length === 0) {
				return text; // the `;` is the last content — already a single clean statement
			}
			return suffix.trim() ? text.slice(0, i) : text.slice(0, i + 1);
		}
	}
	return text;
}

/** SQL clause keywords that, when one LEADS the suffix, mark where a wandering completion
 *  should stop (it has drifted into the clause the suffix already supplies). */
const SUFFIX_CLAUSE_KEYWORDS = new Set(['from', 'where', 'group', 'order', 'having', 'join', 'inner', 'left', 'right', 'outer', 'cross', 'on', 'set', 'values', 'limit', 'offset', 'union', 'returning']);

/** The clause keyword the suffix begins with (after leading whitespace), or null. */
function leadingClauseKeyword(suffix: string): string | null {
	const m = /^\s*([a-zA-Z]+)/.exec(suffix);
	if (!m) {
		return null;
	}
	const word = m[1].toLowerCase();
	return SUFFIX_CLAUSE_KEYWORDS.has(word) ? word : null;
}

/**
 * Truncate `text` where it starts reproducing `suffix` (the text after the cursor). Scans
 * left to right tracking string literals and bracket depth, and cuts at the first depth-0:
 *  - unmatched closing `)`/`]` — the completion is closing a bracket the suffix owns;
 *  - `;` when the suffix already terminates the statement, so the completion must not;
 *  - occurrence of the clause keyword the suffix leads with (e.g. suffix ` FROM …` and the
 *    completion wandered into its own `FROM`).
 * Depth/string tracking keeps a `)`/`;`/keyword inside a subquery or string literal from being
 * mistaken for the boundary. Returns `text` unchanged when it never crosses over.
 */
function trimToSuffixBoundary(text: string, suffix: string): string {
	if (!suffix.trim()) {
		return text;
	}
	const leadKw = leadingClauseKeyword(suffix);
	const suffixTerminates = suffix.includes(';');
	let depth = 0;
	let str: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (str !== null) {
			if (c === str) {
				str = null;
			}
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			str = c;
			continue;
		}
		if (c === '(' || c === '[') {
			depth++;
			continue;
		}
		if (c === ')' || c === ']') {
			if (depth === 0) {
				return text.slice(0, i);
			}
			depth--;
			continue;
		}
		if (depth !== 0) {
			continue;
		}
		if (c === ';' && suffixTerminates) {
			return text.slice(0, i);
		}
		if (leadKw && i > 0 && wordAt(text, i, leadKw)) {
			return text.slice(0, i);
		}
	}
	return text;
}

/** Whether the case-insensitive `word` sits at index `i` of `text` on word boundaries. */
function wordAt(text: string, i: number, word: string): boolean {
	if (text.slice(i, i + word.length).toLowerCase() !== word) {
		return false;
	}
	const before = i === 0 ? '' : text[i - 1];
	const after = text[i + word.length] ?? '';
	return !/[a-zA-Z0-9_]/.test(before) && !/[a-zA-Z0-9_]/.test(after);
}

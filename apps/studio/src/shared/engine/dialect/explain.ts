/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * EXPLAIN as a SURFACE, not one hidden round trip.
 *
 * The plan advisor (`advisor/planAdvisor.ts`) already runs one EXPLAIN behind the user's back and
 * turns it into a sentence. This is the other half: the forms a person asks for on purpose, read
 * the way the engine meant them. An engine that has more than one EXPLAIN declares them as
 * {@link ExplainVariant}s on its dialect, the panel shows a picker over whatever it declared, and
 * nothing in the UI knows a ClickHouse EXPLAIN from anyone else's.
 *
 * Everything here is PURE reading: it builds statements and it parses answers. Running them is the
 * renderer's job, through the same history-clean path the Operations panel uses.
 */

import { maskClickHouse } from './mask';

/** How a variant's answer is to be read, which is the only thing the panel needs to know about it. */
export type ExplainShape =
	/** One cell of JSON holding a plan tree - {@link parseExplainPlan}. */
	| 'plan'
	/** Rows of database / table / parts / rows / marks - {@link readExplainEstimate}. */
	| 'estimate'
	/** One string cell per line, shown as it came. */
	| 'text'
	/** The same, but it is SQL and is coloured as such. */
	| 'sql';

/**
 * One of the EXPLAIN forms an engine offers, as the picker shows it.
 *
 * `statements` returns the attempts RICHEST FIRST, not one statement: an EXPLAIN option a server
 * version has not got is an ERROR, not a word it ignores (the same trap the engine catalog hit
 * with `system.functions.description`). The caller runs them in order and keeps the first that
 * answers, so a new option can be asked for without cutting off older servers.
 */
export interface ExplainVariant {
	id: string;
	/** Picker label, in the engine's own vocabulary ("Pipeline", not "Processors"). */
	label: string;
	/** One line saying what this form answers, shown under the picker. */
	hint: string;
	shape: ExplainShape;
	statements(sql: string): string[];
}

/**
 * ClickHouse's five EXPLAINs, in the order someone reaches for them.
 *
 * Estimate is second on purpose: it is the cheap "how much would this read" that is worth asking
 * BEFORE running a query, and the only one of the five that answers in numbers.
 *
 * `actions = 1` is deliberately not asked for on the plan. It prints every expression evaluated at
 * every step, which on even a small aggregate is hundreds of lines of INPUT/ALIAS bookkeeping
 * around the two facts (what was read, what was skipped) the panel is for.
 */
export const CLICKHOUSE_EXPLAIN_VARIANTS: readonly ExplainVariant[] = [
	{
		id: 'plan',
		label: 'Plan',
		hint: 'The steps, and what each index crossed out before a granule was read.',
		shape: 'plan',
		statements: (sql) => {
			const query = explainTarget(sql);
			return [
				`EXPLAIN PLAN json = 1, indexes = 1, projections = 1 ${query}`,
				`EXPLAIN PLAN json = 1, indexes = 1 ${query}`,
				`EXPLAIN PLAN json = 1 ${query}`,
			];
		},
	},
	{
		id: 'estimate',
		label: 'Estimate',
		hint: 'What running this would read: parts, rows and marks per table.',
		shape: 'estimate',
		statements: (sql) => [`EXPLAIN ESTIMATE ${explainTarget(sql)}`],
	},
	{
		id: 'pipeline',
		label: 'Pipeline',
		hint: 'The processors that carry the rows, and how many threads each gets.',
		shape: 'text',
		statements: (sql) => [`EXPLAIN PIPELINE ${explainTarget(sql)}`],
	},
	{
		id: 'syntax',
		label: 'Syntax',
		hint: 'The query as the optimizer rewrote it.',
		shape: 'sql',
		statements: (sql) => [`EXPLAIN SYNTAX ${explainTarget(sql)}`],
	},
	{
		id: 'queryTree',
		label: 'Query tree',
		hint: "The analyzer's own reading of the query, resolved to column ids and types.",
		shape: 'text',
		statements: (sql) => [`EXPLAIN QUERY TREE ${explainTarget(sql)}`],
	},
];

/** What one index crossed out before the data was read - the whole point of a MergeTree plan. */
export interface ExplainIndexUse {
	/** `PrimaryKey`, `Partition`, `Min-Max`, `Skip`. The server's own word. */
	type: string;
	/** A skip index's name, when it has one. */
	name?: string;
	keys?: string[];
	/** The condition in the form the server reduced it to. */
	condition?: string;
	description?: string;
	parts?: Narrowing;
	granules?: Narrowing;
}

/** How many of something a step started with, and how many it kept. */
export interface Narrowing {
	initial: number;
	selected: number;
}

/** A read of a table (or of a projection standing in for one), with its pruning. */
export interface ExplainRead {
	/** `shop.events`, or the projection's name when the read was answered from one. */
	target: string;
	fromProjection: boolean;
	parts?: Narrowing;
	granules?: Narrowing;
	indexes: ExplainIndexUse[];
}

/** One step of the plan. `facts` is whatever else the server said about it, in its own words. */
export interface ExplainNode {
	type: string;
	description?: string;
	facts: { label: string; value: string }[];
	read?: ExplainRead;
	children: ExplainNode[];
}

/** One line of `EXPLAIN ESTIMATE`: what this statement would read from one table. */
export interface ExplainEstimateRow {
	database: string;
	table: string;
	parts: number;
	rows: number;
	marks: number;
}

// Keys read into the node's own fields, so they are not repeated as loose facts.
const STRUCTURAL = new Set(['Node Type', 'Node Id', 'Plan', 'Plans', 'Indexes', 'Description', 'Expression']);

/**
 * The statement to explain: without its trailing semicolon, and without a trailing `FORMAT <name>`.
 *
 * The FORMAT matters. It belongs to the SELECT the user wrote, but an `EXPLAIN ... SELECT ... FORMAT
 * CSV` applies it to the EXPLAIN's own output, so the plan comes back as CSV text and nothing can
 * read it. A trailing `SETTINGS` is deliberately KEPT: it changes the plan, which is usually why it
 * is there.
 */
export function explainTarget(sql: string): string {
	const trimmed = sql.trim().replace(/;\s*$/, '').trimEnd();
	const at = trailingFormatAt(trimmed);
	return at < 0 ? trimmed : trimmed.slice(0, at).trimEnd();
}

/** Where a top-level trailing `FORMAT <name>` starts, or -1. Strings, quoted names, comments and
 *  anything inside parentheses are masked out first, so a column called `format` is not one. */
function trailingFormatAt(sql: string): number {
	const masked = maskClickHouse(sql);
	const hit = /\bFORMAT\s+[A-Za-z]\w*\s*$/i.exec(masked.text);
	return hit && masked.depth[hit.index] === 0 ? hit.index : -1;
}

/**
 * Read the one cell an `EXPLAIN ... json = 1` answers with into a tree. Returns null when the cell
 * is not a plan document (a server that answered in some other shape), which the panel reports
 * rather than drawing an empty tree.
 */
export function parseExplainPlan(cell: unknown): ExplainNode[] | null {
	let doc: unknown = cell;
	if (typeof cell === 'string') {
		try {
			doc = JSON.parse(cell);
		} catch {
			return null;
		}
	}
	const roots = Array.isArray(doc) ? doc : [doc];
	const out: ExplainNode[] = [];
	for (const entry of roots) {
		const plan = isRecord(entry) ? (entry.Plan ?? entry) : undefined;
		if (isRecord(plan) && typeof plan['Node Type'] === 'string') {
			out.push(readNode(plan));
		}
	}
	return out.length > 0 ? out : null;
}

function readNode(node: Record<string, unknown>): ExplainNode {
	const description = typeof node.Description === 'string' ? node.Description : undefined;
	const children = Array.isArray(node.Plans) ? node.Plans.filter(isRecord).map(readNode) : [];
	return {
		type: String(node['Node Type']),
		description,
		facts: factsOf(node),
		read: readOf(node, description),
		children,
	};
}

/** Everything the server said about a step that is not its shape: `Keys`, `Sort Description`,
 *  `Limit`, `Skip merging`. Shown as-is, because the vocabulary is the engine's and a rename is a
 *  translation we would have to keep true across versions. */
function factsOf(node: Record<string, unknown>): { label: string; value: string }[] {
	const out: { label: string; value: string }[] = [];
	for (const [label, value] of Object.entries(node)) {
		if (STRUCTURAL.has(label) || value === null || value === undefined) {
			continue;
		}
		const text = factText(value);
		if (text !== '') {
			out.push({ label, value: text });
		}
	}
	return out;
}

function factText(value: unknown): string {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.every((v) => typeof v === 'string' || typeof v === 'number') ? value.join(', ') : JSON.stringify(value);
	}
	return JSON.stringify(value);
}

/**
 * The pruning behind a MergeTree read. Each index in turn narrows what is left, so the read's own
 * before/after is the FIRST index's start and the LAST index's finish. A node with no `Indexes`
 * (the option was refused, or this is not a MergeTree read) has no reading and says so by absence.
 */
function readOf(node: Record<string, unknown>, description: string | undefined): ExplainRead | undefined {
	if (node['Node Type'] !== 'ReadFromMergeTree' || !Array.isArray(node.Indexes)) {
		return undefined;
	}
	const indexes = node.Indexes.filter(isRecord).map(readIndex);
	if (indexes.length === 0) {
		return undefined;
	}
	const target = description ?? '';
	return {
		target,
		// A table read says `database.table`; a read answered from a projection names the projection.
		fromProjection: target !== '' && !target.includes('.'),
		parts: span(indexes.map((i) => i.parts)),
		granules: span(indexes.map((i) => i.granules)),
		indexes,
	};
}

function readIndex(index: Record<string, unknown>): ExplainIndexUse {
	return {
		type: typeof index.Type === 'string' ? index.Type : 'Index',
		name: typeof index.Name === 'string' ? index.Name : undefined,
		keys: Array.isArray(index.Keys) ? index.Keys.map(String) : undefined,
		condition: typeof index.Condition === 'string' ? index.Condition : undefined,
		description: typeof index.Description === 'string' ? index.Description : undefined,
		parts: narrowing(index['Initial Parts'], index['Selected Parts']),
		granules: narrowing(index['Initial Granules'], index['Selected Granules']),
	};
}

function narrowing(initial: unknown, selected: unknown): Narrowing | undefined {
	return typeof initial === 'number' && typeof selected === 'number' ? { initial, selected } : undefined;
}

/** What the whole chain of indexes did: the first one's starting count, the last one's answer. */
function span(steps: (Narrowing | undefined)[]): Narrowing | undefined {
	const present = steps.filter((s): s is Narrowing => s !== undefined);
	if (present.length === 0) {
		return undefined;
	}
	return { initial: present[0].initial, selected: present[present.length - 1].selected };
}

/** Every table read in the plan, in the order the tree names them. */
export function planReads(nodes: readonly ExplainNode[]): ExplainRead[] {
	const out: ExplainRead[] = [];
	const walk = (node: ExplainNode): void => {
		if (node.read) {
			out.push(node.read);
		}
		node.children.forEach(walk);
	};
	nodes.forEach(walk);
	return out;
}

/** Rows of `EXPLAIN ESTIMATE`, by column NAME (the column order is the server's to change). */
export function readExplainEstimate(fields: readonly { name: string }[], rows: readonly unknown[][]): ExplainEstimateRow[] {
	const at = (name: string): number => fields.findIndex((f) => f.name.toLowerCase() === name);
	const database = at('database');
	const table = at('table');
	const parts = at('parts');
	const rowCount = at('rows');
	const marks = at('marks');
	if (table < 0 || rowCount < 0) {
		return [];
	}
	return rows.map((row) => ({
		database: database < 0 ? '' : String(row[database] ?? ''),
		table: String(row[table] ?? ''),
		parts: count(row[parts]),
		rows: count(row[rowCount]),
		marks: count(row[marks]),
	}));
}

/** A cell as a number, whether the engine sent a number or (for 64-bit values) its digits. */
function count(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

/** A text EXPLAIN's answer: one string cell per row, put back together as the document it was. */
export function explainText(rows: readonly unknown[][]): string {
	return rows.map((row) => (row[0] === null || row[0] === undefined ? '' : String(row[0]))).join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

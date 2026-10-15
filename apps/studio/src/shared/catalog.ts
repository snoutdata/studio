/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The DIALECT CATALOG: what the connected server itself says it can do — its functions, its
 *  aggregate combinators, its table functions, its table engines, its data types, its formats and
 *  its settings. Read once per connection from the server's own catalog (ClickHouse's `system.*`),
 *  so completion and hover are correct for the VERSION in front of the user rather than for a list
 *  baked into the app and stale the day after it shipped.
 *
 *  It is the twin of {@link DatabaseSchema}: the schema is what this database HOLDS, the catalog is
 *  what its engine KNOWS. Both are cached per connection in the language server and both are
 *  optional — a driver that cannot answer leaves completion exactly as it was.
 *
 *  Descriptions are deliberately NOT sent with a completion item: 1,900 functions each carrying a
 *  paragraph is a quarter-megabyte across the IPC boundary on every keystroke. The item carries
 *  {@link CatalogItemRef} and the documentation is fetched when the user previews it (LSP
 *  completionItem/resolve).
 *--------------------------------------------------------------------------------------------*/

import { markdownCode, markdownLines, markdownText } from './markdownEscape';

/** Which list of the catalog a name belongs to. */
export type CatalogKind = 'function' | 'combinator' | 'tableFunction' | 'tableEngine' | 'dataType' | 'format' | 'setting';

/** What a completion item carries so its documentation can be looked back up on resolve. */
export interface CatalogItemRef {
	readonly catalog: CatalogKind;
	readonly name: string;
	/** Which dialect's catalog to look in (the resolve request carries no connection id). */
	readonly driverId: string;
	/** For a combinator variant (`sumIf`): the aggregate it was built from. */
	readonly base?: string;
	/** For a combinator variant: the combinator suffix (`If`). */
	readonly combinator?: string;
}

/**
 * One named thing the engine knows. Every list uses this shape; the fields a given list has no
 * answer for are simply absent (an older server answers fewer of them, which is the point of
 * reading the catalog rather than declaring it).
 */
export interface CatalogEntry {
	readonly name: string;
	/** True for an aggregate function, so completion can offer its combinator variants. */
	readonly aggregate?: boolean;
	/** The name this one is an alias of, when it is one. */
	readonly aliasTo?: string;
	/** One line, shown as the completion item's detail: `sum(num)`, `Nullable(T)`. */
	readonly syntax?: string;
	/** Prose from the server, shown on hover and on completion resolve. */
	readonly description?: string;
	/** Markdown-ish argument list, as the server writes it. */
	readonly arguments?: string;
	/** What the function gives back, as the server writes it. */
	readonly returns?: string;
	/** One or more examples, as the server writes them. */
	readonly examples?: string;
	/** A setting's current value, and its type (`UInt64`, `Bool`, `Seconds`). */
	readonly value?: string;
	readonly valueType?: string;
	/** A format that can be read (`is_input`) and/or written (`is_output`). */
	readonly input?: boolean;
	readonly output?: boolean;
	/** Short capability notes for a table engine: "sort order, TTL, replication". */
	readonly supports?: string;
	/** `Experimental` / `Beta` / `Obsolete` for a setting; absent means production. */
	readonly tier?: string;
}

/** Everything one connection's engine knows about itself, as read on connect. */
export interface DialectCatalog {
	/** The driver that produced it. A catalog is never shown for another vendor's connection. */
	readonly driverId: string;
	readonly functions: readonly CatalogEntry[];
	/** Aggregate-function combinators (`If`, `State`, `Merge`, `Array`, `OrNull`, …). */
	readonly combinators: readonly CatalogEntry[];
	readonly tableFunctions: readonly CatalogEntry[];
	readonly tableEngines: readonly CatalogEntry[];
	readonly dataTypes: readonly CatalogEntry[];
	readonly formats: readonly CatalogEntry[];
	readonly settings: readonly CatalogEntry[];
	readonly fetchedAt: number;
}

/** An empty catalog: what a driver that cannot answer, or a failed read, comes back as. */
export function emptyCatalog(driverId: string): DialectCatalog {
	return { driverId, functions: [], combinators: [], tableFunctions: [], tableEngines: [], dataTypes: [], formats: [], settings: [], fetchedAt: Date.now() };
}

/** Whether a catalog holds anything at all (a restricted user may be refused every read). */
export function catalogIsEmpty(catalog: DialectCatalog | undefined): boolean {
	return !catalog || catalogLists(catalog).every((list) => list.length === 0);
}

function catalogLists(catalog: DialectCatalog): readonly (readonly CatalogEntry[])[] {
	return [catalog.functions, catalog.combinators, catalog.tableFunctions, catalog.tableEngines, catalog.dataTypes, catalog.formats, catalog.settings];
}

/** The list a {@link CatalogKind} names. */
export function catalogList(catalog: DialectCatalog, kind: CatalogKind): readonly CatalogEntry[] {
	switch (kind) {
		case 'function': return catalog.functions;
		case 'combinator': return catalog.combinators;
		case 'tableFunction': return catalog.tableFunctions;
		case 'tableEngine': return catalog.tableEngines;
		case 'dataType': return catalog.dataTypes;
		case 'format': return catalog.formats;
		case 'setting': return catalog.settings;
	}
}

/** Find one entry by name, case-insensitively (ClickHouse has both `toString` and `CAST`). */
export function findCatalogEntry(catalog: DialectCatalog, kind: CatalogKind, name: string): CatalogEntry | undefined {
	const lower = name.toLowerCase();
	return catalogList(catalog, kind).find((entry) => entry.name.toLowerCase() === lower);
}

/**
 * Split a name that may be an aggregate plus combinators into its parts: `sumIf` → `sum` + `If`,
 * `uniqExactIfState` → `uniqExact` + `If`,`State`. Returns undefined when the name is not one.
 *
 * Longest base first, because `sum` and `sumCount` are both aggregates and `sumCountIf` is the
 * second one's If-variant, not the first one's `CountIf`.
 */
export function splitCombinator(catalog: DialectCatalog, name: string): { base: CatalogEntry; combinators: CatalogEntry[] } | undefined {
	const aggregates = catalog.functions.filter((fn) => fn.aggregate && name.length > fn.name.length && name.startsWith(fn.name));
	aggregates.sort((a, b) => b.name.length - a.name.length);
	for (const base of aggregates) {
		const combinators = readCombinators(catalog, name.slice(base.name.length));
		if (combinators) {
			return { base, combinators };
		}
	}
	return undefined;
}

/**
 * Markdown for one catalog name, for a hover and for a previewed completion item. `undefined` when
 * the catalog has never heard of the name, which is how a caller knows to go on looking.
 *
 * A name the engine does not list can still be a real one: an aggregate wearing combinators
 * (`sumIf`, `uniqExactMergeState`) is built by the parser, not declared, so it is described from
 * the aggregate it is built on plus what each combinator does to it.
 */
export function describeCatalogName(catalog: DialectCatalog, kind: CatalogKind, name: string): string | undefined {
	const entry = findCatalogEntry(catalog, kind, name);
	if (entry) {
		return describeCatalogEntry(entry, kind);
	}
	if (kind !== 'function') {
		return undefined;
	}
	const split = splitCombinator(catalog, name);
	if (!split || split.combinators.length === 0) {
		return undefined;
	}
	const suffixes = split.combinators.map((combinator) => combinator.name).join(' + ');
	const lines = [`**${markdownText(name)}**: ${markdownCode(split.base.name)} with the ${markdownCode(suffixes)} combinator${split.combinators.length > 1 ? 's' : ''}.`];
	for (const combinator of split.combinators) {
		lines.push('', `**${markdownText(combinator.name)}** ${markdownLines(combinator.description ?? '')}`.trimEnd());
	}
	lines.push('', '---', '', describeCatalogEntry(split.base, 'function'));
	return lines.join('\n');
}

/** Markdown for one entry: what it is, what it takes, what it gives back, and an example. Every
 *  value is the server's text (a setting's value, a user-defined function), so all of it is
 *  escaped: names and prose as text, syntax and values as code spans nothing inside can close. */
export function describeCatalogEntry(entry: CatalogEntry, kind: CatalogKind): string {
	const lines = [`**${markdownText(entry.name)}** (${kindLabel(entry, kind)})`];
	if (entry.syntax && entry.syntax !== entry.name) {
		lines.push('', markdownCode(entry.syntax));
	}
	if (entry.aliasTo) {
		lines.push('', `Alias of ${markdownCode(entry.aliasTo)}.`);
	}
	if (kind === 'setting') {
		lines.push('', `Current value ${markdownCode(entry.value ?? '?')}${entry.valueType ? ` (${markdownCode(entry.valueType)})` : ''}${entry.tier ? ` · **${markdownText(entry.tier)}**` : ''}`);
	}
	if (kind === 'format') {
		const ways = [entry.input ? 'read' : '', entry.output ? 'written' : ''].filter(Boolean).join(' and ');
		lines.push('', `Can be ${ways || 'neither read nor written'}.`);
	}
	if (kind === 'tableEngine' && entry.supports) {
		lines.push('', `Supports ${markdownText(entry.supports)}.`);
	}
	if (entry.description) {
		lines.push('', markdownLines(entry.description));
	}
	if (entry.arguments) {
		lines.push('', '**Arguments**', '', markdownLines(entry.arguments));
	}
	if (entry.returns) {
		lines.push('', '**Returns**', '', markdownLines(entry.returns));
	}
	if (entry.examples) {
		lines.push('', '**Example**', '', markdownLines(entry.examples));
	}
	return lines.join('\n');
}

function kindLabel(entry: CatalogEntry, kind: CatalogKind): string {
	switch (kind) {
		case 'function': return entry.aggregate ? 'aggregate function' : 'function';
		case 'combinator': return 'aggregate combinator';
		case 'tableFunction': return 'table function';
		case 'tableEngine': return 'table engine';
		case 'dataType': return 'data type';
		case 'format': return 'format';
		case 'setting': return 'setting';
	}
}

/** `IfState` → [If, State], or undefined when the tail is not a chain of known combinators. */
function readCombinators(catalog: DialectCatalog, tail: string): CatalogEntry[] | undefined {
	if (!tail) {
		return [];
	}
	// Longest first, so `OrDefault` is not read as `Or` + `Default`.
	const known = [...catalog.combinators].sort((a, b) => b.name.length - a.name.length);
	for (const combinator of known) {
		if (tail.startsWith(combinator.name)) {
			const rest = readCombinators(catalog, tail.slice(combinator.name.length));
			if (rest) {
				return [combinator, ...rest];
			}
		}
	}
	return undefined;
}

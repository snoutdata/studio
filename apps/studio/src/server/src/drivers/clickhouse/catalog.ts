/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  What THIS ClickHouse knows about itself, read from its own catalog: every function with the
 *  server's own description, the aggregate combinators, the table functions, the table engines,
 *  the data types, the formats and the settings. Completion and hover are built from it, so they
 *  are right for the version in front of the user — a function added in 25.3 completes on 25.3 and
 *  does not on 24.8, with no app release in between.
 *
 *  Two rules shape every read here:
 *
 *  - **Each list fails alone.** A restricted user, or an older server missing a column, loses one
 *    list and keeps the rest; nothing here can fail a connection. Every read is `.catch(() => [])`.
 *  - **The rich columns are optional.** `description`/`syntax`/`arguments` arrived on these tables
 *    over several releases (and `system.settings.tier` only in 24.x), so each read tries the rich
 *    projection first and falls back to the columns every supported version has. A missing column
 *    is an error from the server, not an empty string, so it has to be a second query.
 *--------------------------------------------------------------------------------------------*/

import type { CatalogEntry, DialectCatalog } from '../../../../shared/catalog';
import type { ClickHouseRowRunner } from './introspection';

/** A row of any of the `system.*` catalog tables, as JSON gives it: strings and numbers. */
type CatalogRow = Record<string, unknown>;

function text(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.trim() === '') {
		return undefined;
	}
	// The server's own prose is indented inside its source, so it arrives with the indentation of
	// the C++ raw string it was written in. Left-trim each line rather than show a staircase.
	return value.split('\n').map((line) => punctuate(line.trimEnd())).join('\n').trim();
}

/**
 * ClickHouse's documentation separates an argument from its description with a dash
 * (``- `datetime` — A date or date with time to convert.``). We do not put dashes in the UI, so
 * the one after an argument name becomes a colon and any other becomes a comma. The words stay
 * the server's own; only the punctuation between them is ours.
 */
function punctuate(line: string): string {
	const argument = /^(\s*[-*]\s*`[^`]+`)\s*[—–]\s*/.exec(line);
	if (argument) {
		return `${argument[1]}: ${line.slice(argument[0].length)}`;
	}
	return line.replace(/\s+[—–]\s+/g, ', ');
}

function flag(value: unknown): boolean {
	return value === 1 || value === '1' || value === true;
}

/** Run `rich`, and on any error (a column this version has not got) run `plain` instead. */
async function readList(run: ClickHouseRowRunner, rich: string, plain: string): Promise<CatalogRow[]> {
	return run(rich).catch(() => run(plain).catch(() => []));
}

async function readFunctions(run: ClickHouseRowRunner): Promise<CatalogEntry[]> {
	const rows = await readList(
		run,
		`SELECT name, is_aggregate, alias_to, description, syntax, arguments, returned_value, examples
		   FROM system.functions ORDER BY name`,
		`SELECT name, is_aggregate, alias_to FROM system.functions ORDER BY name`,
	);
	return rows.map((row) => clean({
		name: String(row.name ?? ''),
		aggregate: flag(row.is_aggregate) || undefined,
		aliasTo: text(row.alias_to),
		syntax: text(row.syntax),
		description: text(row.description),
		arguments: text(row.arguments),
		returns: text(row.returned_value),
		examples: text(row.examples),
	})).filter((entry) => entry.name !== '');
}

async function readCombinators(run: ClickHouseRowRunner): Promise<CatalogEntry[]> {
	const rows = await readList(
		run,
		`SELECT name, description, syntax, examples FROM system.aggregate_function_combinators WHERE NOT is_internal ORDER BY name`,
		`SELECT name FROM system.aggregate_function_combinators ORDER BY name`,
	);
	return rows.map((row) => clean({
		name: String(row.name ?? ''),
		description: text(row.description),
		syntax: text(row.syntax),
		examples: text(row.examples),
	})).filter((entry) => entry.name !== '');
}

async function readTableFunctions(run: ClickHouseRowRunner): Promise<CatalogEntry[]> {
	const rows = await readList(
		run,
		`SELECT name, description FROM system.table_functions ORDER BY name`,
		`SELECT name FROM system.table_functions ORDER BY name`,
	);
	return rows.map((row) => clean({ name: String(row.name ?? ''), description: text(row.description) })).filter((entry) => entry.name !== '');
}

/** The capability flags that change how a table is WRITTEN, read into one line. */
const ENGINE_FLAGS: readonly { column: string; label: string }[] = [
	{ column: 'supports_sort_order', label: 'sort order' },
	{ column: 'supports_settings', label: 'settings' },
	{ column: 'supports_skipping_indices', label: 'skip indexes' },
	{ column: 'supports_projections', label: 'projections' },
	{ column: 'supports_ttl', label: 'TTL' },
	{ column: 'supports_replication', label: 'replication' },
	{ column: 'supports_deduplication', label: 'deduplication' },
];

async function readTableEngines(run: ClickHouseRowRunner): Promise<CatalogEntry[]> {
	const flags = ENGINE_FLAGS.map((f) => f.column).join(', ');
	const rows = await readList(
		run,
		`SELECT name, description, ${flags} FROM system.table_engines ORDER BY name`,
		`SELECT name, ${flags} FROM system.table_engines ORDER BY name`,
	);
	return rows.map((row) => {
		const supports = ENGINE_FLAGS.filter((f) => flag(row[f.column])).map((f) => f.label).join(', ');
		return clean({ name: String(row.name ?? ''), description: text(row.description), supports: supports || undefined });
	}).filter((entry) => entry.name !== '');
}

async function readDataTypes(run: ClickHouseRowRunner): Promise<CatalogEntry[]> {
	const rows = await readList(
		run,
		`SELECT name, alias_to, description, syntax FROM system.data_type_families ORDER BY name`,
		`SELECT name, alias_to FROM system.data_type_families ORDER BY name`,
	);
	return rows.map((row) => clean({
		name: String(row.name ?? ''),
		aliasTo: text(row.alias_to),
		description: text(row.description),
		syntax: text(row.syntax),
	})).filter((entry) => entry.name !== '');
}

async function readFormats(run: ClickHouseRowRunner): Promise<CatalogEntry[]> {
	const rows = await readList(
		run,
		`SELECT name, is_input, is_output, description FROM system.formats ORDER BY name`,
		`SELECT name, is_input, is_output FROM system.formats ORDER BY name`,
	);
	return rows.map((row) => clean({
		name: String(row.name ?? ''),
		input: flag(row.is_input) || undefined,
		output: flag(row.is_output) || undefined,
		description: text(row.description),
	})).filter((entry) => entry.name !== '');
}

/**
 * Settings, for the names offered after `SETTINGS`. Obsolete ones are left out (suggesting a
 * setting the server has already dropped is worse than suggesting nothing), and the tier is kept
 * so an experimental setting says so before the user leans on it.
 */
async function readSettings(run: ClickHouseRowRunner): Promise<CatalogEntry[]> {
	const rows = await readList(
		run,
		`SELECT name, value, type, description, tier FROM system.settings WHERE tier != 'Obsolete' ORDER BY name`,
		`SELECT name, value, type, description FROM system.settings ORDER BY name`,
	);
	return rows.map((row) => clean({
		name: String(row.name ?? ''),
		value: text(row.value),
		valueType: text(row.type),
		description: text(row.description),
		tier: text(row.tier) === 'Production' ? undefined : text(row.tier),
	})).filter((entry) => entry.name !== '');
}

/** Drop the undefined fields, so a catalog serialized over the LSP wire carries only answers. */
function clean(entry: CatalogEntry): CatalogEntry {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry)) {
		if (value !== undefined) {
			out[key] = value;
		}
	}
	return out as unknown as CatalogEntry;
}

/**
 * Read the whole catalog. The seven reads go out together (they are small, independent, and this
 * runs once per connection, off the connect path), and any one of them may come back empty.
 */
export async function introspectClickHouseCatalog(run: ClickHouseRowRunner): Promise<DialectCatalog> {
	const [functions, combinators, tableFunctions, tableEngines, dataTypes, formats, settings] = await Promise.all([
		readFunctions(run),
		readCombinators(run),
		readTableFunctions(run),
		readTableEngines(run),
		readDataTypes(run),
		readFormats(run),
		readSettings(run),
	]);
	return { driverId: 'clickhouse', functions, combinators, tableFunctions, tableEngines, dataTypes, formats, settings, fetchedAt: Date.now() };
}

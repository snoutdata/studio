/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkupKind, type Hover } from 'vscode-languageserver/node';

import { describeCatalogName, type CatalogKind, type DialectCatalog } from '../../../shared/catalog';
import type { DatabaseSchema } from '../../../shared/schema';
import { buildSchemaIndex, describeColumn, describeTable, findColumn, markdownText, type SchemaIndex } from '../schema/schemaIndex';
import { deriveColumns } from '../completion/completionProvider';
import { catalogSlotAt, parseStatement, resolveFromClause, statementAt, wordAt, type CatalogSlot, type Cte, type FromRef } from '../completion/sqlAnalyzer';

/** Hover detail for the table/column/CTE identifier under `offset`, using the cache. */
export function buildHover(text: string, offset: number, schemas: DatabaseSchema[], catalog?: DialectCatalog): Hover | null {
	const word = wordAt(text, offset);
	if (!word) {
		return null;
	}
	const index = buildSchemaIndex(schemas);
	const statement = statementAt(text, offset);
	const { ctes, mainOffset } = parseStatement(statement.text);
	const region = statement.offset >= mainOffset ? statement.text.slice(mainOffset) : statement.text;
	const from = resolveFromClause(region);

	if (word.qualifier) {
		return qualifiedHover(word.qualifier, word.word, from, ctes, index);
	}

	// Bare identifier: a CTE name, then a table name, then a column of an in-scope table.
	const cte = ctes.find((c) => c.name.toLowerCase() === word.word.toLowerCase());
	if (cte) {
		return markdown(describeCte(cte, ctes, index));
	}
	const tables = index.findByName(word.word);
	if (tables.length) {
		return markdown(describeTable(tables[0]));
	}
	for (const ref of from) {
		const entry = ref.derived ? undefined : index.find(ref.table, ref.schema);
		const column = entry && findColumn(entry.table, word.word);
		if (entry && column) {
			return markdown(describeColumn(entry, column));
		}
	}
	// Nothing in this database goes by that name, so ask the ENGINE what it is: a function, a
	// combinator variant of one, a type, an engine, a format, a setting. The schema is asked first
	// on purpose — a table really named `sum` is the user's table, not ClickHouse's aggregate.
	const engineDoc = catalog && describeEngineName(catalog, text, offset, word.word);
	return engineDoc ? markdown(engineDoc) : null;
}

/** Which catalog list the hovered word is looked up in, most specific first. The clause it sits in
 *  decides when there is one (`SETTINGS max_threads`, `FORMAT Pretty`, `ENGINE = MergeTree`). */
const KINDS_BY_SLOT: Record<CatalogSlot, CatalogKind> = {
	setting: 'setting',
	format: 'format',
	engine: 'tableEngine',
	dataType: 'dataType',
};

/** Everywhere else, a name is most likely a function, then a type, then one of the rarer lists. */
const KIND_ORDER: readonly CatalogKind[] = ['function', 'dataType', 'tableFunction', 'tableEngine', 'combinator', 'format', 'setting'];

function describeEngineName(catalog: DialectCatalog, text: string, offset: number, word: string): string | undefined {
	let end = offset;
	while (end < text.length && /[\w$]/.test(text[end])) {
		end++;
	}
	const slot = catalogSlotAt(text.slice(0, end));
	const kinds = slot ? [KINDS_BY_SLOT[slot], ...KIND_ORDER] : KIND_ORDER;
	for (const kind of kinds) {
		const doc = describeCatalogName(catalog, kind, word);
		if (doc) {
			return doc;
		}
	}
	return undefined;
}

function qualifiedHover(qualifier: string, word: string, from: FromRef[], ctes: Cte[], index: SchemaIndex): Hover | null {
	const lower = qualifier.toLowerCase();
	const ref = from.find((entry) => entry.alias?.toLowerCase() === lower) ?? from.find((entry) => entry.table.toLowerCase() === lower);

	// A derived table (FROM (SELECT …) x): only column names are known, not types.
	if (ref?.derived) {
		const names = deriveColumns(ref.derived.columns, ref.derived.from, ctes, index);
		return names.some((name) => name.toLowerCase() === word.toLowerCase())
			? markdown(`**${markdownText(ref.alias ?? '')}.${markdownText(word)}** _(subquery column)_`)
			: null;
	}

	const cte = ctes.find((c) => c.name.toLowerCase() === (ref?.table ?? qualifier).toLowerCase());
	if (cte) {
		return deriveColumns(cte.columns, cte.from, ctes, index, new Set([cte.name.toLowerCase()])).some((name) => name.toLowerCase() === word.toLowerCase())
			? markdown(`**${markdownText(cte.name)}.${markdownText(word)}** _(CTE column)_`)
			: null;
	}

	const entry = ref ? index.find(ref.table, ref.schema) : index.findByName(qualifier)[0];
	const column = entry && findColumn(entry.table, word);
	if (entry && column) {
		return markdown(describeColumn(entry, column));
	}
	const table = index.find(word, qualifier);
	if (table && table.database.toLowerCase() === lower) {
		return markdown(describeTable(table));
	}
	return null;
}

function describeCte(cte: Cte, ctes: Cte[], index: SchemaIndex): string {
	const columns = deriveColumns(cte.columns, cte.from, ctes, index, new Set([cte.name.toLowerCase()]));
	const detail = columns.length ? `${columns.length} columns: ${columns.map(markdownText).join(', ')}` : 'columns inferred at runtime';
	return `**${markdownText(cte.name)}** _(CTE)_\n\n${detail}`;
}

function markdown(value: string): Hover {
	return { contents: { kind: MarkupKind.Markdown, value } };
}

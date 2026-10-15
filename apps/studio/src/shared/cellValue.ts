/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  A COMPOSITE CELL: what a value with structure inside it looks like, as a tree.
 *
 *  A columnar or document database routinely puts a whole structure in one cell: ClickHouse's
 *  `Array`, `Map`, `Tuple`, `Nested`, `JSON`, `Variant` and `Dynamic`, Postgres's arrays and
 *  `jsonb`, MongoDB's documents. A grid cell can only be one line, and `JSON.stringify` of a
 *  hundred-element array is a line nobody reads. This module turns such a value into a tree the
 *  viewer draws, and a one-line summary the cell shows.
 *
 *  Two sources of truth, in this order:
 *
 *  - **The declared type**, when the driver gives one. `Tuple(id UInt64, name String)` names the
 *    fields and types the children; the JSON alone would say only "an object with two keys".
 *    ClickHouse's type grammar is what is parsed here, because it is the one engine whose types
 *    carry that much; anything unparseable degrades to the shape below rather than failing.
 *  - **The shape of the value**, always. A driver that reports `jsonb`, or no type at all, still
 *    gets a tree, which is why this serves Mongo and Postgres and not only ClickHouse.
 *
 *  Pure, and deliberately NOT in `shared/engine`: a picture of a value neither guards a query nor
 *  grounds a prompt (the same reason Orbit sits outside it). Nothing here reads a driver, and the
 *  text it produces is display only: copy, export and editing keep using the raw value.
 *--------------------------------------------------------------------------------------------*/

/** One node of the value tree: a branch with children, or a leaf with text. */
export interface ValueNode {
	/** How this node is reached from its parent: an array index, a map key, a field name. */
	readonly key: string;
	/** The declared type of this node, when the column's type named one. */
	readonly type?: string;
	/** The leaf's text. Absent on a branch. */
	readonly text?: string;
	/** True when the leaf is SQL NULL, so the viewer can grey it rather than print "null". */
	readonly isNull?: boolean;
	/** A branch's children, in order. Absent on a leaf. */
	readonly children?: readonly ValueNode[];
	/**
	 * How many nodes are under this one, itself included. The viewer opens a branch that is small
	 * enough to read and leaves a big one closed, which is a better rule than a fixed depth: a
	 * three-key object nested four deep is worth opening, and a 10,000-element array is not.
	 */
	readonly size: number;
	/** What kind of branch this is, for the icon and the summary. */
	readonly kind: 'array' | 'object' | 'scalar';
}

/** The parsed form of a declared type: `Array(Tuple(id UInt8, name String))`. */
interface TypeNode {
	readonly name: string;
	readonly args: readonly { readonly field?: string; readonly type: TypeNode }[];
	/** The type as written, for display. */
	readonly text: string;
}

/** Wrappers that say nothing about the SHAPE of a value, so the tree looks straight through them. */
const TRANSPARENT = new Set(['nullable', 'lowcardinality', 'simpleaggregatefunction']);

/**
 * Whether this value has structure worth opening: an array, or an object with keys. A string that
 * merely LOOKS like JSON counts too, because that is how Postgres `json`, MySQL `JSON` and a text
 * column holding a payload all arrive.
 */
export function isComposite(value: unknown): boolean {
	const parsed = asStructure(value);
	return parsed !== undefined;
}

/**
 * How many elements or keys a composite value holds, for the count the grid shows beside the cell.
 * `undefined` for anything that is not composite, so the cell stays exactly as it was.
 */
export function compositeCount(value: unknown): number | undefined {
	const parsed = asStructure(value);
	if (parsed === undefined) {
		return undefined;
	}
	return Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
}

/**
 * The one-line summary a cell can show in place of a wall of JSON: `3 items`, `2 keys`. The caller
 * decides whether to show it; the raw text is still what is copied and exported.
 */
export function summarize(value: unknown): string | undefined {
	const parsed = asStructure(value);
	if (parsed === undefined) {
		return undefined;
	}
	if (Array.isArray(parsed)) {
		return parsed.length === 1 ? "1 item" : `${parsed.length} items`;
	}
	const keys = Object.keys(parsed).length;
	return keys === 1 ? "1 key" : `${keys} keys`;
}

/** A value as an array or a plain object, parsing a JSON string, or undefined when it is neither. */
function asStructure(value: unknown): unknown[] | Record<string, unknown> | undefined {
	if (Array.isArray(value)) {
		return value;
	}
	if (value !== null && typeof value === 'object') {
		// A Date (and anything else with its own class) is a scalar as far as a reader is concerned.
		return Object.getPrototypeOf(value) === Object.prototype ? (value as Record<string, unknown>) : undefined;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!(trimmed.startsWith('{') && trimmed.endsWith('}')) && !(trimmed.startsWith('[') && trimmed.endsWith(']'))) {
			return undefined;
		}
		try {
			return asStructure(JSON.parse(trimmed));
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * The tree for one cell. `dataType` is the column's declared type when the driver gives one; it
 * only ever ADDS names and types, so a wrong or unknown type costs nothing.
 */
export function valueTree(value: unknown, dataType?: string, name = 'value'): ValueNode {
	return node(name, value, dataType ? unwrap(parseType(dataType)) : undefined);
}

function node(key: string, value: unknown, type: TypeNode | undefined): ValueNode {
	const declared = type?.text;
	const structure = asStructure(value);
	if (structure === undefined) {
		return { key, kind: 'scalar', type: declared, text: leafText(value), isNull: value === null || value === undefined, size: 1 };
	}
	const children = Array.isArray(structure)
		? structure.map((item, index) => node(String(index), item, elementType(type, index)))
		: Object.entries(structure).map(([childKey, item]) => node(childKey, item, memberType(type, childKey)));
	const size = children.reduce((total, child) => total + child.size, 1);
	return { key, kind: Array.isArray(structure) ? 'array' : 'object', type: declared, children, size };
}

/** The text of a leaf. NULL is left to the caller's styling, so it is an empty string here. */
function leafText(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	return typeof value === 'string' ? value : String(value);
}

/** The type of the nth element: `Array(T)` gives T for every index, an unnamed `Tuple` gives the
 *  nth argument. */
function elementType(type: TypeNode | undefined, index: number): TypeNode | undefined {
	if (!type) {
		return undefined;
	}
	const name = type.name.toLowerCase();
	if (name === 'array' || name === 'nested') {
		return unwrap(type.args[0]?.type);
	}
	if (name === 'tuple') {
		return unwrap(type.args[index]?.type);
	}
	return undefined;
}

/** The type behind a key: a `Map`'s value type, or a named `Tuple`/`Nested` field. */
function memberType(type: TypeNode | undefined, key: string): TypeNode | undefined {
	if (!type) {
		return undefined;
	}
	const name = type.name.toLowerCase();
	if (name === 'map') {
		return unwrap(type.args[1]?.type);
	}
	if (name === 'tuple' || name === 'nested') {
		return unwrap(type.args.find((arg) => arg.field === key)?.type);
	}
	return undefined;
}

/** Look through the wrappers that do not change a value's shape. */
function unwrap(type: TypeNode | undefined): TypeNode | undefined {
	if (type && TRANSPARENT.has(type.name.toLowerCase()) && type.args.length > 0) {
		return unwrap(type.args[type.args.length - 1].type);
	}
	return type;
}

/**
 * Parse a declared type. Handles the nested, optionally field-named form ClickHouse writes
 * (`Map(String, Array(Tuple(id UInt64, at DateTime)))`) and returns undefined for anything it
 * cannot read, which is the signal to fall back to the value's own shape.
 */
export function parseType(text: string): TypeNode | undefined {
	const parsed = readType(text.trim(), 0);
	return parsed && parsed.end === text.trim().length ? parsed.node : undefined;
}

function readType(text: string, at: number): { node: TypeNode; end: number } | undefined {
	const start = at;
	while (at < text.length && /[\w$]/.test(text[at])) {
		at++;
	}
	const name = text.slice(start, at);
	if (!name) {
		return undefined;
	}
	at = skipSpace(text, at);
	if (text[at] !== '(') {
		return { node: { name, args: [], text: name }, end: at };
	}
	const args: { field?: string; type: TypeNode }[] = [];
	at++;
	for (;;) {
		at = skipSpace(text, at);
		if (text[at] === ')') {
			at++;
			break;
		}
		const arg = readArgument(text, at);
		if (!arg) {
			return undefined;
		}
		args.push(arg.arg);
		at = skipSpace(text, arg.end);
		if (text[at] === ',') {
			at++;
			continue;
		}
		if (text[at] === ')') {
			at++;
			break;
		}
		return undefined;
	}
	return { node: { name, args, text: text.slice(start, at) }, end: at };
}

/**
 * One argument: `String`, `id UInt64` (a named tuple field), `'a' = 1` (an Enum member), or a bare
 * number (`FixedString(16)`, `Decimal(10, 2)`). Only the first two carry a type; the rest are read
 * and discarded so the surrounding type still parses.
 */
function readArgument(text: string, at: number): { arg: { field?: string; type: TypeNode }; end: number } | undefined {
	if (text[at] === "'" || /\d/.test(text[at])) {
		return skipLiteralArgument(text, at);
	}
	const first = readType(text, at);
	if (!first) {
		return undefined;
	}
	const after = skipSpace(text, first.end);
	// `id UInt64`: what was read is the FIELD NAME and the type follows it.
	if (/[A-Za-z_]/.test(text[after] ?? '')) {
		const second = readType(text, after);
		if (!second) {
			return undefined;
		}
		return { arg: { field: first.node.name, type: second.node }, end: second.end };
	}
	return { arg: { type: first.node }, end: first.end };
}

/** Read past an argument that is a literal, keeping the parens it may contain balanced. */
function skipLiteralArgument(text: string, at: number): { arg: { field?: string; type: TypeNode }; end: number } {
	const start = at;
	let depth = 0;
	while (at < text.length) {
		const ch = text[at];
		if (ch === "'") {
			at++;
			while (at < text.length && text[at] !== "'") {
				at += text[at] === '\\' ? 2 : 1;
			}
		} else if (ch === '(') {
			depth++;
		} else if (ch === ')') {
			if (depth === 0) {
				break;
			}
			depth--;
		} else if (ch === ',' && depth === 0) {
			break;
		}
		at++;
	}
	const literal = text.slice(start, at).trim();
	return { arg: { type: { name: literal, args: [], text: literal } }, end: at };
}

function skipSpace(text: string, at: number): number {
	while (at < text.length && /\s/.test(text[at])) {
		at++;
	}
	return at;
}

/**
 * The parts of a column that can be SELECTED on their own, worked out from the declared type and
 * nothing else: a `Tuple`'s fields, a `Map`'s `keys` and `values`, an `Array`'s `size0`, a
 * `Nullable`'s `null`. ClickHouse calls these SUBCOLUMNS, and reading one reads only that part off
 * disk, which is the whole reason a person wants them offered.
 *
 * One level deep, which is what a completion after `col.` needs; the level below comes from
 * completing again. Free: no query, and nothing a restricted user could be refused. A type whose
 * parts live in the DATA rather than in the type (`JSON`) has none of these, and its paths are
 * sampled instead (`ColumnInfo.dynamicPaths`).
 */
export function typeSubPaths(dataType: string | undefined): { name: string; dataType?: string }[] {
	const type = dataType ? unwrap(parseType(dataType)) : undefined;
	if (!type) {
		return [];
	}
	const name = type.name.toLowerCase();
	if (name === 'tuple' || name === 'nested') {
		const named = type.args.filter((arg) => arg.field);
		const paths = named.map((arg) => ({ name: arg.field as string, dataType: arg.type.text }));
		return name === 'nested' ? [...paths, { name: 'size0', dataType: 'UInt64' }] : paths;
	}
	if (name === 'map') {
		const key = type.args[0]?.type.text ?? 'String';
		const value = type.args[1]?.type.text ?? 'String';
		return [
			{ name: 'keys', dataType: `Array(${key})` },
			{ name: 'values', dataType: `Array(${value})` },
			{ name: 'size0', dataType: 'UInt64' },
		];
	}
	if (name === 'array') {
		return [{ name: 'size0', dataType: 'UInt64' }];
	}
	return [];
}

/** True when a column's parts live in the DATA rather than in its type, so they have to be sampled
 *  rather than read off the type (ClickHouse's `JSON`, and `Dynamic` inside it). */
export function hasDynamicPaths(dataType: string | undefined): boolean {
	const type = dataType ? unwrap(parseType(dataType)) : undefined;
	const name = type?.name.toLowerCase();
	return name === 'json' || name === 'object';
}

/** The path to a node, as the SQL that reads it: `payload.items[0].name`. */
export function nodePath(keys: readonly string[], root: string): string {
	let path = root;
	for (const key of keys) {
		path += /^\d+$/.test(key) ? `[${key}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `['${key.replace(/'/g, "\\'")}']`;
	}
	return path;
}

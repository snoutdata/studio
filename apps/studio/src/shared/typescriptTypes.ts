/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  A database schema, as TypeScript. Ours, and for every driver.
 *
 *  A type generator needs two halves: plain SQL against the catalogue, and a generator for the
 *  JSON it returns. We already have the
 *  introspection half — {@link DatabaseSchema}, filled by `src/server/src/drivers/*​/
 *  introspection.ts` for eleven backends — so the only thing missing was the generator, and
 *  this is it. The consequence: the same command works against MySQL, SQL Server, Oracle,
 *  SQLite and the rest, because the schema model it reads was never Postgres-shaped.
 *
 *  ## Why this is beside `shared/engine/` rather than inside it
 *
 *  The engine's test is one sentence: engine code **inspects, rewrites,
 *  guards or grounds a query or a prompt**. A type emitter does none of those. Nothing it
 *  produces is ever executed against a database and nothing it produces is ever sent to a
 *  model — it is a build artefact for the customer's own compiler. `schemaDiff/emit/` is inside
 *  the engine because a migration plan IS statements that will run; this is not that. Keeping
 *  it out also keeps it off the engine barrel, which is a 128 kB bundle that a CLI has no use
 *  for.
 *
 *  It is nevertheless PURE, to the same standard: no `node:`, no `fs`, no `path`, no
 *  `electron`. A schema in, a string out, so the desktop, the CLI and anything else call the
 *  same code and get the same file.
 *
 *  ## What it emits
 *
 *  The `Database` type `@snoutdata/client`'s generics read: `Json`, `Database` with one block
 *  per schema (`Tables`/`Views`/`Functions`/`Enums`/`CompositeTypes`), `Row`/`Insert`/`Update`
 *  per table, a `Relationships` array per relation, then the `Tables<>`/`TablesInsert<>`/
 *  `TablesUpdate<>`/`Enums<>`/`CompositeTypes<>` lookup helpers and the `Constants` object.
 *  Those names are the file's public surface: customer code imports them, so they do not change.
 *
 *  Formatting is prettier's default for this file (two spaces, double quotes, no semicolons in
 *  type members, trailing commas in the emitted arrays), so a repository that runs prettier over
 *  the generated file sees no diff. We do not run prettier — the
 *  layout is emitted directly, so it is stable without a dependency.
 *
 *  ## Three honest limits, each of which is a property of the introspection and not of this file
 *
 *  * **Enums are supplied, not discovered.** `information_schema.columns.data_type` reports a
 *    Postgres enum column as `USER-DEFINED`, so the schema model has never carried the type
 *    name. Pass {@link TypeGenOptions.enums} and any column whose declared type matches one is
 *    emitted as `Database["…"]["Enums"]["…"]`; without it such a column is `unknown`, which is
 *    a compiler error at the use site rather than a wrong type.
 *  * **Composite types are never emitted.** Nothing introspects them yet, so the block is
 *    always empty rather than sometimes wrong.
 *  * **A view gets `Row` and `Relationships` and no `Insert`/`Update`.** Whether a view is
 *    updatable is not in the schema model, and inventing an `Insert` for a view that refuses
 *    one is worse than omitting it.
 *
 *  One oddity, deliberate: the import below carries a `.js` extension where the rest of this
 *  tree writes none. This file is COPIED into the CLI's `src/shared/` the way the engine is
 *  copied into the dashboard and the Snout Functions, and the CLI
 *  compiles under `moduleResolution: NodeNext`, which requires the extension. `Bundler` (here)
 *  accepts it and esbuild resolves it to the `.ts`, so one specifier serves both and the copy
 *  stays byte-identical to the original, which is the whole point of copying rather than
 *  rewriting.
 *--------------------------------------------------------------------------------------------*/

import type { ColumnInfo, DatabaseSchema, ForeignKeyInfo, RoutineInfo, TableInfo } from './schema.js';

/** One enum type, supplied by the caller because introspection does not carry it. */
export interface TypeGenEnum {
	/** The type's name, matched against a column's declared `dataType`, case-insensitively. */
	readonly name: string;
	/** Its labels, in declaration order. Emitted as a union and as a `Constants` array. */
	readonly values: readonly string[];
	/** The schema it lives in. Defaults to {@link TypeGenOptions.defaultSchema}. */
	readonly schema?: string;
}

export interface TypeGenOptions {
	/** Which vendor's type names to read. Defaults to `postgres`; unknown ids get a portable map. */
	readonly driverId?: string;
	/**
	 * The schema key the `Tables<>` helpers resolve against, and where a table with no schema
	 * of its own is filed. `public` for Postgres; for MySQL this is the database name.
	 */
	readonly defaultSchema?: string;
	readonly enums?: readonly TypeGenEnum[];
	/** Emit the `Tables<>`/`TablesInsert<>`/… helper block. On unless switched off. */
	readonly helpers?: boolean;
	/** Emit the `Constants` object. On unless switched off. */
	readonly constants?: boolean;
}

const INDENT = '  ';

function pad(level: number): string {
	return INDENT.repeat(level);
}

/** A TypeScript string literal, double-quoted, which is the quoting the target shape uses. */
function lit(value: string): string {
	return JSON.stringify(value);
}

/** An object key: bare when it is a plain identifier, quoted when it is not. */
function key(name: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : lit(name);
}

function byName<T extends { name: string }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Strip a declared type down to something a lookup table can match.
 *
 * `character varying(255)` -> `character varying`, `numeric(10,2)` -> `numeric`,
 * `text[]` -> `text` with `array`, and Postgres's internal `_text` spelling likewise. The
 * `ARRAY` that `information_schema` reports for any array column carries no element type at
 * all, which is why it becomes `unknown[]` and not a guess.
 */
function baseType(dataType: string): { base: string; array: boolean } {
	let text = (dataType ?? '').trim();
	let array = false;
	while (text.endsWith('[]')) {
		array = true;
		text = text.slice(0, -2).trim();
	}
	if (text.startsWith('_') && text.length > 1) {
		array = true;
		text = text.slice(1);
	}
	const paren = text.indexOf('(');
	if (paren > 0) {
		text = text.slice(0, paren);
	}
	return { base: text.trim().toLowerCase(), array };
}

type TypeKind = 'number' | 'string' | 'boolean' | 'json' | 'unknown';

/**
 * The portable classification, shared by every driver.
 *
 * Type names barely collide across vendors, so one table plus a handful of per-driver
 * corrections is smaller and more honest than eleven tables that agree about `text`.
 */
const PORTABLE: Readonly<Record<string, TypeKind>> = {
	// numbers
	smallint: 'number', int2: 'number', integer: 'number', int: 'number', int4: 'number',
	bigint: 'number', int8: 'number', decimal: 'number', numeric: 'number', number: 'number',
	real: 'number', float: 'number', float4: 'number', float8: 'number', 'double precision': 'number',
	double: 'number', binary_float: 'number', binary_double: 'number', smallserial: 'number',
	serial: 'number', bigserial: 'number', oid: 'number', smallmoney: 'number', money: 'number',
	// booleans
	bool: 'boolean', boolean: 'boolean',
	// json
	json: 'json', jsonb: 'json', variant: 'json', object: 'json',
	// strings — everything a database can hand back as text, plus the temporal and binary
	// types, which arrive over the wire as strings and are typed that way by every generator.
	char: 'string', character: 'string', 'character varying': 'string', varchar: 'string',
	varchar2: 'string', nvarchar: 'string', nvarchar2: 'string', nchar: 'string', text: 'string',
	ntext: 'string', citext: 'string', clob: 'string', nclob: 'string', longtext: 'string',
	mediumtext: 'string', tinytext: 'string', uuid: 'string', uniqueidentifier: 'string',
	date: 'string', time: 'string', 'time without time zone': 'string',
	'time with time zone': 'string', timetz: 'string', timestamp: 'string',
	'timestamp without time zone': 'string', 'timestamp with time zone': 'string',
	timestamptz: 'string', datetime: 'string', datetime2: 'string', datetimeoffset: 'string',
	smalldatetime: 'string', timestamp_ntz: 'string', timestamp_ltz: 'string',
	timestamp_tz: 'string', interval: 'string', year: 'string', bytea: 'string', blob: 'string',
	longblob: 'string', mediumblob: 'string', tinyblob: 'string', binary: 'string',
	varbinary: 'string', raw: 'string', xml: 'string', inet: 'string', cidr: 'string',
	macaddr: 'string', macaddr8: 'string', tsvector: 'string', tsquery: 'string', name: 'string',
	// `bit` is a bit STRING in Postgres and everything that copies it. SQL Server is the
	// exception and it is below.
	bit: 'string', varbit: 'string', tinyint: 'number', enum: 'string', set: 'string'
};

/**
 * Where a vendor genuinely disagrees with the portable table, and nowhere else.
 *
 * Deliberately short. Type names barely collide across vendors, and a per-driver table that
 * restates `text: 'string'` eleven times is eleven places for it to stop agreeing.
 */
const PER_DRIVER: Readonly<Record<string, Readonly<Record<string, TypeKind>>>> = {
	// `bit` is SQL Server's boolean, and it is the one name that means two different things.
	sqlserver: { bit: 'boolean' },
	'mysql-aurora': { bit: 'number' },
	mariadb: { bit: 'number' },
	sqlite: { bit: 'number' },
	snowflake: { array: 'json' }
	// Oracle is absent on purpose: it has no BOOLEAN before 23c, a flag is NUMBER(1), and
	// `number` is already a number in the portable table. Nothing to correct.
};

function kindOf(driverId: string, base: string): TypeKind {
	const override = PER_DRIVER[driverId]?.[base];
	if (override) {
		return override;
	}
	return PORTABLE[base] ?? 'unknown';
}

interface Emitter {
	readonly driverId: string;
	readonly defaultSchema: string;
	/** Lower-cased enum name -> the reference to emit for it. */
	readonly enumRefs: ReadonlyMap<string, string>;
	/**
	 * Lower-cased relation name -> the reference to its `Row`.
	 *
	 * A function that returns `SETOF users` returns that table's rows, and saying so is the
	 * difference between a usable return type and `unknown[]`. Keyed by bare name because that
	 * is how `pg_get_function_result` spells it for anything on the search path.
	 */
	readonly rowRefs: ReadonlyMap<string, string>;
}

/** The TypeScript for one column's declared type, before nullability is applied. */
function typeOf(emitter: Emitter, dataType: string): string {
	const { base, array } = baseType(dataType);
	const enumRef = emitter.enumRefs.get(base);
	if (enumRef) {
		return array ? `${enumRef}[]` : enumRef;
	}
	// `ARRAY` is what information_schema says when it will not say what of.
	if (base === 'array') {
		return 'unknown[]';
	}
	const kind = kindOf(emitter.driverId, base);
	const one = kind === 'json' ? 'Json' : kind;
	return array ? `${one}[]` : one;
}

/**
 * May this column be left out of an INSERT?
 *
 * The same three reasons every generator uses: the database will fill it (a default or an
 * identity), or it will accept nothing and mean NULL.
 */
function optionalOnInsert(column: ColumnInfo): boolean {
	return column.nullable || column.autoIncrement === true || (column.default !== null && column.default !== undefined);
}

function columnLine(emitter: Emitter, column: ColumnInfo, level: number, optional: boolean, writing = false): string {
	// A value the database refuses to be given (an `ALWAYS` identity, a computed column) is
	// `never` in Insert and Update, so the type stops the insert Postgres would refuse with
	// "cannot insert a non-DEFAULT value".
	if (writing && column.generatedAlways === true) {
		return `${pad(level)}${key(column.name)}?: never`;
	}
	const type = typeOf(emitter, column.dataType);
	const value = column.nullable ? `${type} | null` : type;
	return `${pad(level)}${key(column.name)}${optional ? '?' : ''}: ${value}`;
}

/**
 * Is this foreign key one-to-one?
 *
 * True when the REFERENCING columns are themselves unique — a primary key or a unique index
 * over exactly those columns, in any order. That is the only evidence the schema model
 * carries, and getting it wrong in the safe direction (saying `false`) costs a customer a
 * slightly wider type, where the other direction costs them a runtime surprise.
 */
function isOneToOne(table: TableInfo, fk: ForeignKeyInfo): boolean {
	const wanted = [...fk.columns].sort();
	const same = (columns: readonly string[]): boolean => {
		const sorted = [...columns].sort();
		return sorted.length === wanted.length && sorted.every((name, i) => name === wanted[i]);
	};
	if (table.primaryKey.length > 0 && same(table.primaryKey)) {
		return true;
	}
	return (table.indexes ?? []).some((index) => index.unique && same(index.columns));
}

function relationships(emitterTable: TableInfo, level: number): string[] {
	const lines: string[] = [];
	const keys = [...emitterTable.foreignKeys].sort((a, b) =>
		a.constraintName < b.constraintName ? -1 : a.constraintName > b.constraintName ? 1 : 0
	);
	if (keys.length === 0) {
		lines.push(`${pad(level)}Relationships: []`);
		return lines;
	}
	lines.push(`${pad(level)}Relationships: [`);
	for (const fk of keys) {
		lines.push(`${pad(level + 1)}{`);
		lines.push(`${pad(level + 2)}foreignKeyName: ${lit(fk.constraintName)}`);
		lines.push(`${pad(level + 2)}columns: [${fk.columns.map(lit).join(', ')}]`);
		lines.push(`${pad(level + 2)}isOneToOne: ${isOneToOne(emitterTable, fk) ? 'true' : 'false'}`);
		lines.push(`${pad(level + 2)}referencedRelation: ${lit(fk.referencedTable)}`);
		lines.push(`${pad(level + 2)}referencedColumns: [${fk.referencedColumns.map(lit).join(', ')}]`);
		lines.push(`${pad(level + 1)}},`);
	}
	lines.push(`${pad(level)}]`);
	return lines;
}

function tableBlock(emitter: Emitter, table: TableInfo, level: number): string[] {
	const columns = byName(table.columns);
	const lines: string[] = [];
	lines.push(`${pad(level)}${key(table.name)}: {`);
	lines.push(`${pad(level + 1)}Row: {`);
	for (const column of columns) {
		lines.push(columnLine(emitter, column, level + 2, false));
	}
	lines.push(`${pad(level + 1)}}`);
	if (table.kind !== 'view') {
		lines.push(`${pad(level + 1)}Insert: {`);
		for (const column of columns) {
			lines.push(columnLine(emitter, column, level + 2, optionalOnInsert(column), true));
		}
		lines.push(`${pad(level + 1)}}`);
		lines.push(`${pad(level + 1)}Update: {`);
		for (const column of columns) {
			lines.push(columnLine(emitter, column, level + 2, true, true));
		}
		lines.push(`${pad(level + 1)}}`);
	}
	lines.push(...relationships(table, level + 1));
	lines.push(`${pad(level)}}`);
	return lines;
}

/** The placeholder every generator uses for a category with nothing in it. */
function emptyBlock(name: string, level: number): string[] {
	return [`${pad(level)}${name}: {`, `${pad(level + 1)}[_ in never]: never`, `${pad(level)}}`];
}

/**
 * What a routine gives back.
 *
 * A return type is not quite a column type: it can be nothing at all (`void`, and every
 * procedure), a set (`SETOF users`), or an anonymous row (`TABLE(a int, b text)`), and none of
 * those is a name a type map can look up. The three are unwrapped here and everything else goes
 * through the ordinary map.
 */
function returnType(emitter: Emitter, routine: RoutineInfo): string {
	if (routine.kind === 'procedure' || !routine.returnType) {
		return 'undefined';
	}
	const declared = routine.returnType.trim();
	const lower = declared.toLowerCase();
	if (lower === 'void' || lower === '') {
		return 'undefined';
	}
	if (lower.startsWith('table(')) {
		return 'Record<string, unknown>[]';
	}
	if (lower.startsWith('setof ')) {
		const inner = declared.slice('setof '.length).trim();
		if (inner.toLowerCase() === 'record') {
			return 'Record<string, unknown>[]';
		}
		const row = emitter.rowRefs.get(inner.toLowerCase());
		return row ? `${row}[]` : `${typeOf(emitter, inner)}[]`;
	}
	if (lower === 'record' || lower === 'trigger' || lower === 'event_trigger') {
		return 'unknown';
	}
	const row = emitter.rowRefs.get(lower);
	return row ?? typeOf(emitter, declared);
}

function routineBlock(emitter: Emitter, routine: RoutineInfo, level: number): string[] {
	const lines: string[] = [];
	// OUT parameters are not arguments. An unnamed one cannot be passed by name, so it is
	// dropped rather than emitted under an empty key.
	const args = byName(
		(routine.parameters ?? [])
			.filter((one) => one.name.length > 0 && (one.mode ?? 'IN').toUpperCase() !== 'OUT')
			.map((one) => ({ name: one.name, dataType: one.dataType }))
	);
	lines.push(`${pad(level)}${key(routine.name)}: {`);
	if (args.length === 0) {
		lines.push(`${pad(level + 1)}Args: never`);
	} else {
		lines.push(`${pad(level + 1)}Args: {`);
		for (const arg of args) {
			lines.push(`${pad(level + 2)}${key(arg.name)}: ${typeOf(emitter, arg.dataType)}`);
		}
		lines.push(`${pad(level + 1)}}`);
	}
	lines.push(`${pad(level + 1)}Returns: ${returnType(emitter, routine)}`);
	lines.push(`${pad(level)}}`);
	return lines;
}

/** Which schema a table or routine is filed under. Blank and absent both mean the default. */
function schemaOf(item: { schema?: string }, defaultSchema: string): string {
	return item.schema && item.schema.length > 0 ? item.schema : defaultSchema;
}

/**
 * A schema's TypeScript, as text.
 *
 * @param schema  What introspection produced. Nothing is read from it that a driver other than
 *                Postgres cannot fill.
 */
export function emitTypeScriptTypes(schema: DatabaseSchema, options: TypeGenOptions = {}): string {
	const defaultSchema = options.defaultSchema ?? 'public';
	const driverId = options.driverId ?? 'postgres';
	const enums = options.enums ?? [];

	const enumRefs = new Map<string, string>();
	for (const one of enums) {
		const where = one.schema && one.schema.length > 0 ? one.schema : defaultSchema;
		enumRefs.set(one.name.toLowerCase(), `Database[${lit(where)}][${lit('Enums')}][${lit(one.name)}]`);
	}
	// Built before anything is emitted, so a function declared above the table it returns still
	// gets that table's `Row`.
	const rowRefs = new Map<string, string>();
	for (const table of schema.tables) {
		const where = schemaOf(table, defaultSchema);
		const category = table.kind === 'view' ? 'Views' : 'Tables';
		rowRefs.set(
			table.name.toLowerCase(),
			`Database[${lit(where)}][${lit(category)}][${lit(table.name)}][${lit('Row')}]`
		);
	}
	const emitter: Emitter = { driverId, defaultSchema, enumRefs, rowRefs };

	// Every schema that has something in it, plus the default one, which is emitted even when
	// empty because the helper block below resolves against it by name.
	const names = new Set<string>([defaultSchema]);
	for (const table of schema.tables) {
		names.add(schemaOf(table, defaultSchema));
	}
	for (const routine of schema.routines ?? []) {
		names.add(schemaOf(routine, defaultSchema));
	}
	for (const one of enums) {
		names.add(one.schema && one.schema.length > 0 ? one.schema : defaultSchema);
	}
	const schemaNames = [...names].sort();

	const out: string[] = [];
	out.push('export type Json =');
	out.push('  | string');
	out.push('  | number');
	out.push('  | boolean');
	out.push('  | null');
	out.push('  | { [key: string]: Json | undefined }');
	out.push('  | Json[]');
	out.push('');
	out.push('export type Database = {');
	for (const name of schemaNames) {
		const tables = byName(
			schema.tables.filter((one) => schemaOf(one, defaultSchema) === name && one.kind !== 'view')
		);
		const views = byName(
			schema.tables.filter((one) => schemaOf(one, defaultSchema) === name && one.kind === 'view')
		);
		const routines = byName(
			(schema.routines ?? []).filter((one) => schemaOf(one, defaultSchema) === name)
		);
		const ours = byName(
			enums.filter((one) => (one.schema && one.schema.length > 0 ? one.schema : defaultSchema) === name)
		);

		out.push(`${pad(1)}${key(name)}: {`);
		if (tables.length === 0) {
			out.push(...emptyBlock('Tables', 2));
		} else {
			out.push(`${pad(2)}Tables: {`);
			for (const table of tables) {
				out.push(...tableBlock(emitter, table, 3));
			}
			out.push(`${pad(2)}}`);
		}
		if (views.length === 0) {
			out.push(...emptyBlock('Views', 2));
		} else {
			out.push(`${pad(2)}Views: {`);
			for (const view of views) {
				out.push(...tableBlock(emitter, view, 3));
			}
			out.push(`${pad(2)}}`);
		}
		if (routines.length === 0) {
			out.push(...emptyBlock('Functions', 2));
		} else {
			out.push(`${pad(2)}Functions: {`);
			for (const routine of routines) {
				out.push(...routineBlock(emitter, routine, 3));
			}
			out.push(`${pad(2)}}`);
		}
		if (ours.length === 0) {
			out.push(...emptyBlock('Enums', 2));
		} else {
			out.push(`${pad(2)}Enums: {`);
			for (const one of ours) {
				out.push(`${pad(3)}${key(one.name)}: ${one.values.map(lit).join(' | ')}`);
			}
			out.push(`${pad(2)}}`);
		}
		// Nothing introspects composite types, so this is empty rather than sometimes wrong.
		out.push(...emptyBlock('CompositeTypes', 2));
		out.push(`${pad(1)}}`);
	}
	out.push('}');

	if (options.helpers !== false) {
		out.push('');
		out.push(helperBlock(defaultSchema));
	}
	if (options.constants !== false) {
		out.push('');
		out.push(constantsBlock(schemaNames, enums, defaultSchema));
	}
	return `${out.join('\n')}\n`;
}

/**
 * The `Constants` object: an enum's labels as values, for the code that needs the list at
 * runtime rather than at compile time. Every schema gets an entry, empty or not, so
 * `Constants.<schema>.Enums` exists for each of them.
 */
function constantsBlock(
	schemaNames: readonly string[],
	enums: readonly TypeGenEnum[],
	defaultSchema: string
): string {
	const lines: string[] = ['export const Constants = {'];
	for (const name of schemaNames) {
		const ours = byName(
			enums.filter((one) => (one.schema && one.schema.length > 0 ? one.schema : defaultSchema) === name)
		);
		if (ours.length === 0) {
			lines.push(`${pad(1)}${key(name)}: {`);
			lines.push(`${pad(2)}Enums: {},`);
			lines.push(`${pad(1)}},`);
			continue;
		}
		lines.push(`${pad(1)}${key(name)}: {`);
		lines.push(`${pad(2)}Enums: {`);
		for (const one of ours) {
			lines.push(`${pad(3)}${key(one.name)}: [${one.values.map(lit).join(', ')}],`);
		}
		lines.push(`${pad(2)}},`);
		lines.push(`${pad(1)}},`);
	}
	lines.push('} as const');
	return lines.join('\n');
}

/**
 * The lookup helpers, with the default schema's NAME templated in. Each takes either a name in
 * the default schema, or `{ schema }` and then a name in that schema:
 *
 *     Tables<"posts">                         the Row of a table or a view
 *     Tables<{ schema: "audit" }, "events">    the same, in another schema
 *     TablesInsert<"posts">                    a table's Insert (a view has none)
 *     TablesUpdate<"posts">                    a table's Update
 *     Enums<"status">                          an enum's labels, as a union
 *     CompositeTypes<"address">                a composite type
 *
 * They are built from four small pieces: `SchemaOf` and `NameOf` read the arguments, `Lookup`
 * looks a name up in one section of a schema, and `Member` takes `Row`, `Insert` or `Update`
 * out of the entry found. A name that is not there is `never`, and the constraints make it a
 * compiler error at the use site.
 */
function helperBlock(defaultSchema: string): string {
	return `type DefaultSchemaName = Extract<keyof Database, ${lit(defaultSchema)}>

type InSchema = { schema: keyof Database }

type SchemaOf<Choice> = Choice extends InSchema ? Choice["schema"] : DefaultSchemaName

type NameOf<Choice, Name> = Choice extends InSchema ? Name : Choice

type Lookup<Section, Name> = Name extends keyof Section ? Section[Name] : never

type Member<Entry, Part extends "Row" | "Insert" | "Update"> = Entry extends Record<Part, infer Value> ? Value : never

type Relations<Schema extends keyof Database> = Database[Schema]["Tables"] & Database[Schema]["Views"]

export type Tables<
  Choice extends keyof Relations<DefaultSchemaName> | InSchema,
  Name extends Choice extends InSchema ? keyof Relations<Choice["schema"]> : never = never,
> = Member<Lookup<Relations<SchemaOf<Choice>>, NameOf<Choice, Name>>, "Row">

export type TablesInsert<
  Choice extends keyof Database[DefaultSchemaName]["Tables"] | InSchema,
  Name extends Choice extends InSchema ? keyof Database[Choice["schema"]]["Tables"] : never = never,
> = Member<Lookup<Database[SchemaOf<Choice>]["Tables"], NameOf<Choice, Name>>, "Insert">

export type TablesUpdate<
  Choice extends keyof Database[DefaultSchemaName]["Tables"] | InSchema,
  Name extends Choice extends InSchema ? keyof Database[Choice["schema"]]["Tables"] : never = never,
> = Member<Lookup<Database[SchemaOf<Choice>]["Tables"], NameOf<Choice, Name>>, "Update">

export type Enums<
  Choice extends keyof Database[DefaultSchemaName]["Enums"] | InSchema,
  Name extends Choice extends InSchema ? keyof Database[Choice["schema"]]["Enums"] : never = never,
> = Lookup<Database[SchemaOf<Choice>]["Enums"], NameOf<Choice, Name>>

export type CompositeTypes<
  Choice extends keyof Database[DefaultSchemaName]["CompositeTypes"] | InSchema,
  Name extends Choice extends InSchema ? keyof Database[Choice["schema"]]["CompositeTypes"] : never = never,
> = Lookup<Database[SchemaOf<Choice>]["CompositeTypes"], NameOf<Choice, Name>>`;
}

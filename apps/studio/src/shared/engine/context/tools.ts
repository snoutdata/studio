/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AiToolEvent, AiToolSettings, ToolCall, ToolResult, ToolSpec } from '../../ai';
import type { DatabaseSchema, RoutineInfo, TableInfo } from '../../schema';
import type { ExecuteQueryResult } from '../../protocol';
import type { CapabilityInvocation, CapabilityResult } from '../../capabilities';
import type { ActionOrigin, ToolAuditRecord } from '../audit';
import { describeNative, type NativeQuery } from '../compile/native';
import { destructiveStatement, executableComments, guardReadings, guardStatements, readOnlyEscape, serverFileAccess, uncPath } from '../guard/sqlGuard';
import { clickhouseTableFunction, uncheckedCall, writingCall } from '../guard/sideEffects';
import { allowlistReadRefusal } from '../guard/readAllowlist';
import { engineDisplayName, readOnlyEnforcementFor } from '../dialect/flavors';
import { seriesComment, shownToModel } from './schemaPrompt';
import { dataAccessRefusal, type DataAccessLevel } from './dataAccess';

// Cap a tool result's size so a fat `SELECT *` (or a 461-table list) can't blow the
// model's context window. Rows are also row-capped via run_query's auto-LIMIT.
const MAX_RESULT_CHARS = 6000;
const MAX_CELL_CHARS = 160;
const MAX_TABLE_LINES = 500;

/** What the tools need from the rest of the app, injected so this stays unit-testable. */
export interface ToolContext {
	schema: DatabaseSchema | null;
	dialect: string;
	/** The active connection's driver id, so the read-only gate reads SQL the way that engine does. */
	driverId?: string;
	/** The active connection's flavor (`ConnectionConfig.flavor`): TiDB on `mysql-aurora` has no
	 *  database-side read-only mode, so its reads take the stricter check. */
	flavor?: string;
	settings: AiToolSettings;
	/** Ensure the selected connection is live before a DB tool runs. When it isn't connected yet,
	 *  asks the user for permission to connect, connects, and refreshes {@link schema} so the
	 *  schema-reading tools have data. `declined` ⇒ the user said no (a soft stop, not an error).
	 *  Absent ⇒ no connect-on-demand (e.g. the dev benchmark path). */
	ensureConnected?(): Promise<{ ok: boolean; declined?: boolean; error?: string }>;
	/** Force a live re-introspect of the connected DB and update {@link schema}. The authoritative
	 *  schema tools (describe_table / search_columns) call this so they never answer from a stale
	 *  cache: a column added to a table after the last introspect would otherwise be invisible and
	 *  the model would confidently report it missing. Idempotent per turn. Absent ⇒ no live refresh
	 *  available (dev/benchmark path); those tools fall back to the cached {@link schema}. */
	refreshSchema?(): Promise<void>;
	/** Run a SQL statement against the active connection (run_query only). */
	execute(sql: string): Promise<ExecuteQueryResult>;
	/** Document (MongoDB) backend: the assistant queries with aggregation pipelines, so run_query
	 *  runs a native `{lang:'mongo'}` query rather than SQL. Present only on a document connection. */
	documentMode?: boolean;
	/** Run a native query (document backends). Used by run_query when {@link documentMode} and the
	 *  model supplied a pipeline. Read-only-ness is enforced in the tool, not here. */
	executeNative?(query: NativeQuery): Promise<ExecuteQueryResult>;
	/** Ask the user to approve a run_query before it executes; true ⇒ run it. */
	approve(sql: string, callId: string): Promise<boolean>;
	/** Surface a tool step to the renderer. */
	emit(event: AiToolEvent): void;
	/** Record this invocation to the audit trail. Absent ⇒ auditing is off (the user's setting)
	 *  or this is the dev/benchmark path. See `engine/audit.ts`. */
	audit?(record: ToolAuditRecord): void;
	/** Where the invocation came from, for the audit record. Defaults to `'chat'`. */
	origin?: ActionOrigin;
	/** The connection the turn is grounded in, recorded on each audit record. */
	connectionId?: string;
	/** Injected clock, so audit durations are deterministic under test. Defaults to `Date.now`. */
	clock?(): number;
	/** Run a renderer capability (a client-side tool) and return its result. Present only when
	 *  the chat advertised client capabilities this turn. See `src/shared/capabilities.ts`. */
	invokeClient?(inv: CapabilityInvocation): Promise<CapabilityResult>;
	/** Ask the user to approve a generic mutating capability ("the assistant wants to <summary>"). */
	approveAction?(summary: string, callId: string): Promise<boolean>;
	/** The host's own wording of a call for that approval, when it knows more than the arguments
	 *  say (an edit to a saved connection names each field's old and new value). Undefined falls
	 *  back to the generic description. */
	describeAction?(call: ToolCall): string | undefined;
	/** The host's own check of a client capability's call BEFORE anyone is asked: a refusal is
	 *  returned to the model as is, with no card; otherwise the call goes on with the arguments the
	 *  host returns (it may pin one down, e.g. the connection a monitor's query runs on), and those
	 *  are what the card describes and the renderer runs. Absent ⇒ every call goes on unchanged. */
	prepareAction?(call: ToolCall): { ok: true; arguments: Record<string, unknown> } | { ok: false; error: string };
	/** Names of the advertised client capabilities (so dispatch can route them). */
	clientCapabilities?: Set<string>;
	/** The subset of {@link clientCapabilities} that mutate and therefore need approval. */
	clientMutates?: Set<string>;
	/** Resolve a connection the model named (id or label) into a handle bound to THAT connection, so
	 *  a DB tool's `connection` argument can target a second database within one turn (compare prod vs
	 *  dev, propose a column for another DB). Returns null when nothing matches the ref. Absent ⇒ no
	 *  cross-connection targeting (dev/benchmark path); the `connection` argument is then ignored and
	 *  the active connection is used. */
	resolveConnection?(ref: string): Promise<ConnectionHandle | null>;
}

/** A connection the DB tools operate on: the active one by default, or a second one the model named
 *  via the `connection` argument. Mirrors the per-connection slice of {@link ToolContext}; `schema`
 *  is mutated in place by ensureConnected/refreshSchema so a later tool call in the same turn sees
 *  the freshened copy. See {@link activeHandle} (wraps the active connection) and
 *  ToolContext.resolveConnection (builds one for a named connection). */
export interface ConnectionHandle {
	/** The connection's label, for messages/approval. Undefined for the active connection. */
	label?: string;
	/** The target's schema. Mutated by ensureConnected/refreshSchema. */
	schema: DatabaseSchema | null;
	/** True for a document (MongoDB) backend — run_query then takes an aggregation pipeline. */
	documentMode?: boolean;
	/** The target's driver id, so the read-only gate reads SQL the way that engine does. */
	driverId?: string;
	/** The target's flavor, for the same gate (see {@link ToolContext.flavor}). */
	flavor?: string;
	ensureConnected?(): Promise<{ ok: boolean; declined?: boolean; error?: string }>;
	refreshSchema?(): Promise<void>;
	execute(sql: string): Promise<ExecuteQueryResult>;
	executeNative?(query: NativeQuery): Promise<ExecuteQueryResult>;
	approve(preview: string, callId: string): Promise<boolean>;
	/** What the AI may see of THIS database, for a connection the model named that is not the
	 *  active one (whose level already decided which tools were offered). Absent: not checked. */
	dataAccess?: DataAccessLevel;
}

/** Wrap the active-connection slice of {@link ToolContext} as a {@link ConnectionHandle}, so the DB
 *  tool bodies use one uniform shape whether they target the active connection or a named one. Keeps
 *  handle.schema in step with ctx.schema after ensure/refresh (both mutate ctx.schema on the ctx). */
function activeHandle(ctx: ToolContext): ConnectionHandle {
	const handle: ConnectionHandle = {
		schema: ctx.schema,
		documentMode: ctx.documentMode,
		driverId: ctx.driverId,
		flavor: ctx.flavor,
		ensureConnected: ctx.ensureConnected
			? async () => { const r = await ctx.ensureConnected!(); handle.schema = ctx.schema; return r; }
			: undefined,
		refreshSchema: ctx.refreshSchema
			? async () => { await ctx.refreshSchema!(); handle.schema = ctx.schema; }
			: undefined,
		execute: (sql) => ctx.execute(sql),
		executeNative: ctx.executeNative ? (query) => ctx.executeNative!(query) : undefined,
		approve: (preview, callId) => ctx.approve(preview, callId),
	};
	return handle;
}

/** The enabled tools, as JSON-Schema specs the providers translate to their wire format.
 *  `available` advertises the DB tools: pass it true whenever a connection is SELECTED (even if
 *  not connected yet) — the executor connects on demand (with the user's approval) on first use. */
export function buildToolSpecs(settings: AiToolSettings, available: boolean, documentMode = false): ToolSpec[] {
	const specs: ToolSpec[] = [];
	const hasSchema = available;
	if (hasSchema && settings.listTables) {
		specs.push({
			name: 'list_tables',
			description: 'List the tables and views in the connected database (names, kind, column count). Use a filter on large databases.',
			parameters: { type: 'object', properties: { filter: { type: 'string', description: 'Optional case-insensitive substring to filter table names.' }, connection: CONNECTION_PARAM } },
		});
	}
	if (hasSchema && settings.describeTable) {
		specs.push({
			name: 'describe_table',
			description: "Get a table's columns, types, primary key, foreign keys and indexes (its structure/DDL). Call this before writing SQL against a table.",
			parameters: { type: 'object', properties: { name: { type: 'string', description: 'Table name, optionally schema-qualified (e.g. "orders" or "public.orders").' }, connection: CONNECTION_PARAM }, required: ['name'] },
		});
	}
	if (hasSchema && settings.searchColumns) {
		specs.push({
			name: 'search_columns',
			description: 'Find tables and columns whose name contains a term, across the whole schema. Useful when you do not know which table holds a field.',
			parameters: { type: 'object', properties: { term: { type: 'string', description: 'Substring to search for in table and column names.' }, connection: CONNECTION_PARAM }, required: ['term'] },
		});
	}
	if (hasSchema && settings.runQuery) {
		specs.push(documentMode ? {
			name: 'run_query',
			description: 'Run a single READ-ONLY query against the MongoDB database and return the documents. The user must approve each query before it runs. Results are row-limited. Provide a read-only aggregation pipeline as JSON in `sql`: an object {"collection":"<name>","pipeline":[<stages>]} (or a bare [<stages>] array plus the `collection` argument). No write stages ($out/$merge). Read-only SQL is also accepted and auto-translated.',
			parameters: { type: 'object', properties: {
				sql: { type: 'string', description: 'A MongoDB aggregation pipeline as JSON — {"collection":"orders","pipeline":[{"$match":{...}},{"$limit":20}]} — or a read-only SQL SELECT.' },
				collection: { type: 'string', description: 'The collection to run the pipeline against (only needed when `sql` is a bare [stages] array).' },
				connection: CONNECTION_PARAM,
			}, required: ['sql'] },
		} : {
			name: 'run_query',
			description: 'Run a single READ-ONLY query (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN) against the database and return the rows. The user must approve each query before it runs. Results are row-limited.',
			parameters: { type: 'object', properties: { sql: { type: 'string', description: 'One read-only SQL statement. Do not add a trailing semicolon or multiple statements.' }, connection: CONNECTION_PARAM }, required: ['sql'] },
		});
	}
	return specs;
}

/** The optional `connection` argument shared by every DB tool: target a saved connection OTHER than
 *  the active one (by id or label), so a single task can span two databases (compare prod vs dev,
 *  copy a column between them). Omit ⇒ the active connection. This replaces the model's old failed
 *  habit of "switching the active connection" — which the DB tools cannot actually follow. */
const CONNECTION_PARAM = { type: 'string', description: 'Optional: the saved connection to run against, given as its id or label (from list_connections). Defaults to the ACTIVE connection. Set this to inspect or query a DIFFERENT database in the same task (e.g. compare prod vs dev, or copy a column between them). Do NOT try to "switch" the active connection — pass this argument instead.' } as const;

export function qualified(table: TableInfo): string {
	return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A short, human "the assistant wants to <…>" phrase for a mutating capability's approval card,
 *  built from the call so the user sees what's about to happen without reading raw args. */
function describeCapability(call: ToolCall): string {
	const verb = call.name.replace(/_/g, ' ');
	const arg = call.arguments.label ?? call.arguments.name ?? call.arguments.id ?? call.arguments.key;
	if (arg != null) {
		return `${verb} (${truncate(String(arg), 80)})`;
	}
	// `text` (remember_this) is the thing being approved, not a label for it, so it gets more room:
	// the user has to read the exact sentence before agreeing to keep it.
	const text = call.arguments.text;
	if (text != null) {
		return `${verb}: ${truncate(String(text), 160)}`;
	}
	// Anything else names its target with a word of its own choosing, and the card must still say
	// WHICH thing: `run_data_flow` calls it `flow`, so this read "run data flow" for every flow the
	// user has, which is not enough to approve an unattended write on. The first string argument is
	// the target for every capability we ship, and a card that names the wrong argument is still
	// better than one that names none.
	const first = Object.values(call.arguments).find((value) => typeof value === 'string' && value.trim() !== '');
	return first !== undefined ? `${verb} (${truncate(String(first), 80)})` : verb;
}

/** Turn a capability result into tool-result content the model reads: the summary line first
 *  (so the step card can echo it), then any structured data as size-capped JSON. */
function renderCapabilityContent(result: CapabilityResult): string {
	const head = result.summary || 'Done.';
	if (result.data === undefined) {
		return head;
	}
	let json: string;
	try {
		json = JSON.stringify(result.data, null, 2);
	} catch {
		json = String(result.data);
	}
	return `${head}\n${truncate(json, MAX_RESULT_CHARS)}`;
}

/** Statements whose first verb may run. Anything else (or any destructive verb anywhere
 *  in a multi-statement string) is refused before it ever reaches the driver. */
const READ_LEAD = /^(select|with|show|describe|desc|explain|table|values)\b/i;
const DESTRUCTIVE = /^(delete|update|drop|truncate|alter|insert|replace|create|grant|revoke|merge|call|do|execute|exec|set|use|lock|attach|begin|commit|rollback|copy|prepare|listen|notify|load|discard|reset)\b/i;

/**
 * Whether the database behind this driver (and flavor) is never asked to refuse writes, so the
 * statement check is all there is (`readOnlyEnforcement` mechanism `none`). No driver reads as
 * Postgres, the way the guard does.
 */
export function lexicalOnlyReads(driver: string | undefined, flavor?: string): boolean {
	return driver !== undefined && readOnlyEnforcementFor(driver, flavor).mechanism === 'none';
}

/** Reject anything that isn't a single read-only statement. Returns the reason, or
 *  undefined when the SQL is safe to run.
 *
 *  It reads what `destructiveStatement` reads (comments gone, strings and dollar-quoted bodies
 *  blanked), and asks it too, because a leading verb is not the statement: an agent's
 *  `WITH x AS (DELETE FROM t RETURNING *) SELECT ...` begins with WITH, `EXPLAIN ANALYZE DELETE`
 *  begins with EXPLAIN and executes, and both are refused here. This is the FIRST gate: the
 *  statement that passes is then sent read-only, so where the engine can, the database refuses a
 *  write this lexer missed (`readOnlyEnforcement`). `driver` is the connection's driver
 *  id, so a MySQL `/*! ... *\/` or a SQL Server `[name]` is read the way that engine reads it,
 *  and a SELECT that calls a function which writes (`pg_terminate_backend`, `dblink_exec`) is
 *  refused as the write it is. */
export function readOnlyError(sql: string, driver?: string, flavor?: string): string | undefined {
	const strict = lexicalOnlyReads(driver, flavor);
	// Ending the read-only transaction, or turning read-only off, steps out of the database-side
	// layer (`readOnlyEscape`), so it is refused before anything else is asked.
	const escape = readOnlyEscape(sql, driver);
	if (escape) {
		return `Refused: "${escape}" ${escape === 'set_config' || /^(?:SET|RESET|DISCARD)$/.test(escape) ? 'can turn read-only off' : 'would end the read-only transaction this runs in'}, so it is not read-only. The agent may only run SELECT/WITH/SHOW/DESCRIBE/EXPLAIN.`;
	}
	// A server that opens `\\host\share` signs in to that host with its own account, whichever
	// function the path is handed to, so on SQL Server the path itself is refused.
	const unc = uncPath(sql, driver);
	if (unc) {
		return `Refused: this names a network path (${truncate(unc, 60)}), and a database server that opens one signs in to that computer with its own account, so it is not read-only.`;
	}
	// A MySQL-family server runs the inside of an executable comment, some forms only on one family
	// (TiDB's `/*T!`, MariaDB's `/*M!`) or from one version, so a read holding one is not judged by
	// its text: it is refused, whichever form, on every engine with that lexer.
	const executable = executableComments(sql, driver)[0];
	if (executable) {
		return `Refused: this holds an executable comment (${executable} ... */), whose inside the database runs as code, so it is not read-only. The agent may only run SELECT/WITH/SHOW/DESCRIBE/EXPLAIN; an optimizer hint (/*+ ... */) is fine.`;
	}
	const statements = guardStatements(sql, driver);
	for (const statement of statements) {
		// Snowflake's LIST @stage lists files and reads; the allow-list below admits it alone.
		if (driver === 'snowflake' && /^(?:list|ls)\b/i.test(statement)) {
			continue;
		}
		const file = serverFileAccess(statement);
		if (file) {
			return `Refused: this reaches a file on the database server (${file}), so it is not read-only. The agent may only run SELECT/WITH/SHOW/DESCRIBE/EXPLAIN.`;
		}
		const match = DESTRUCTIVE.exec(statement);
		if (match) {
			return `Refused: "${match[1].toUpperCase()}" is not read-only. The agent may only run SELECT/WITH/SHOW/DESCRIBE/EXPLAIN.`;
		}
		const write = destructiveStatement(statement, driver);
		if (write?.verb === 'EXPLAIN') {
			return `Refused: EXPLAIN here writes the plan into a table, so it is not read-only. The agent may only run SELECT/WITH/SHOW/DESCRIBE.`;
		}
		if (write) {
			return `Refused: this ${write.verb.toLowerCase() === 'create' ? 'creates something' : `runs a ${write.verb}`}, and is not read-only. The agent may only run SELECT/WITH/SHOW/DESCRIBE/EXPLAIN.`;
		}
		if (!READ_LEAD.test(statement)) {
			return 'Refused: only read-only queries (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN) are allowed.';
		}
	}
	if (statements.length === 0) {
		return 'Refused: only read-only queries (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN) are allowed.';
	}
	// Where the database is never asked to refuse a write (Snowflake, SAP HANA, Db2, TiDB, OceanBase,
	// a driver nobody knows), a read is also what an allow-list admits, not only what a list of write
	// verbs fails to catch: see guard/readAllowlist.ts.
	if (strict) {
		const why = allowlistReadRefusal(sql, driver);
		if (why) {
			const named = engineDisplayName(driver, flavor);
			return `Refused: this is not read-only here: ${why}, and ${named === 'SQL' ? 'this database' : named} is not asked to refuse writes itself. The agent may only run one SELECT/WITH/SHOW/DESCRIBE/EXPLAIN/VALUES statement there.`;
		}
	}
	const tableFunction = clickhouseTableFunction(sql, driver);
	if (tableFunction) {
		return `Refused: this reads through the table function ${tableFunction}(), which reaches outside the ClickHouse server or is not one known to read only this server's data, so it is not read-only.`;
	}
	const call = writingCall(sql, driver);
	if (call) {
		return `Refused: this calls ${call.includes(' ') ? call : `${call}()`}, which changes the database or acts outside it, so it is not read-only.`;
	}
	return undefined;
}

/**
 * Why a run_query the user has set to "Always allow" must still be asked about, or undefined when
 * it may run unasked. The list lets a READ through without a question, so only a statement the
 * guard can positively read as one qualifies: it passes {@link readOnlyError}, calls no function
 * that is not a known-pure built-in (a user-defined function can write, `pg_sleep` can hold a
 * connection), and is not on a production connection, where every statement is asked about.
 */
export function autoRunBlocker(sql: string, options: { driver?: string; flavor?: string; production?: boolean } = {}): string | undefined {
	if (options.production) {
		return 'production connection';
	}
	const refusal = readOnlyError(sql, options.driver, options.flavor);
	if (refusal) {
		return refusal;
	}
	const call = uncheckedCall(sql, options.driver);
	return call ? `calls ${call}` : undefined;
}

/** A plain (non-array) object — a valid aggregation stage / pipeline operand. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a document-backend run_query argument into a native Mongo query, or report why it can't be.
 *  Accepts `{collection, pipeline}` or a bare `[stages]` array (with a separate `collection` arg).
 *  Returns `{ sql: true }` when the arg isn't JSON at all, so the caller falls back to the SQL path
 *  (read-only SQL is auto-translated). Read-only is enforced here: a write stage ($out/$merge) is
 *  refused, and an unbounded pipeline gets a `$limit` appended. */
export function parseMongoRunQuery(arg: string, collectionArg: string | undefined, maxRows: number): { native: NativeQuery } | { error: string } | { sql: true } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(arg);
	} catch {
		return { sql: true }; // not JSON — treat as SQL (transcribed downstream)
	}
	let collection = collectionArg?.trim() || undefined;
	let pipeline: unknown;
	if (Array.isArray(parsed)) {
		pipeline = parsed;
	} else if (isPlainObject(parsed)) {
		if (typeof parsed.collection === 'string' && parsed.collection.trim()) {
			collection = parsed.collection.trim();
		}
		pipeline = parsed.pipeline ?? (Array.isArray((parsed as { stages?: unknown }).stages) ? (parsed as { stages?: unknown }).stages : undefined);
	} else {
		return { error: 'Provide a MongoDB pipeline as JSON: {"collection":"<name>","pipeline":[<stages>]}.' };
	}
	if (!Array.isArray(pipeline) || !pipeline.every(isPlainObject)) {
		return { error: 'The pipeline must be an array of stage objects, e.g. [{"$match":{...}},{"$limit":20}].' };
	}
	if (!collection) {
		return { error: 'Specify the collection: pass {"collection":"<name>","pipeline":[...]} or the `collection` argument.' };
	}
	if (pipeline.some((stage) => Object.keys(stage as object).some((k) => k === '$out' || k === '$merge'))) {
		return { error: 'Refused: $out/$merge write to the database. run_query is read-only.' };
	}
	// Row-cap an unbounded pipeline so a big collection can't be dumped wholesale.
	const stages = pipeline as Record<string, unknown>[];
	const bounded = stages.some((s) => '$limit' in s || '$count' in s || '$group' in s) ? stages : [...stages, { $limit: maxRows }];
	return { native: { lang: 'mongo', collection, pipeline: bounded } };
}

/** Append a LIMIT to an unbounded SELECT/WITH so a huge table can't be dumped wholesale.
 *  Leaves SHOW/DESCRIBE/EXPLAIN (and queries that already LIMIT) untouched. */
export function autoLimit(sql: string, maxRows: number): string {
	const trimmed = sql.replace(/;\s*$/, '');
	// Judged on the guard's reading, so a LIMIT in a comment or a string does not lift the cap. Each
	// of Postgres's string rules is a reading, and the cap is lifted only when every one has a LIMIT.
	const uncapped = guardReadings(trimmed).some((reading) => {
		const code = reading.join(';\n');
		return !/\blimit\b/i.test(code) && /^\s*(select|with)\b/i.test(code);
	});
	return uncapped ? `${trimmed}\nLIMIT ${maxRows}` : trimmed;
}

/** Render query rows as a compact pipe table, cell- and total-size capped. */
export function formatRows(fields: string[], rows: unknown[][], rowCount: number, durationMs: number, maxRows: number): string {
	const header = fields.join(' | ');
	const lines: string[] = [header, fields.map(() => '---').join(' | ')];
	let used = header.length;
	let shown = 0;
	for (const row of rows.slice(0, maxRows)) {
		const line = row.map((cell) => truncate(cell === null || cell === undefined ? 'NULL' : String(cell), MAX_CELL_CHARS)).join(' | ');
		if (used + line.length > MAX_RESULT_CHARS) {
			break;
		}
		lines.push(line);
		used += line.length;
		shown++;
	}
	const note = shown < rowCount
		? `\n(${rowCount} rows total, showing ${shown}; ${durationMs} ms)`
		: `\n(${rowCount} rows; ${durationMs} ms)`;
	return lines.join('\n') + note;
}

/** Stored functions callable straight from a row of `table`: every parameter name matches one
 *  of the table's columns. Surfaced in describe_table so the reminder sits where a model that
 *  just fetched a table's columns is looking — e.g. lookupName(kind_id, ref_id) on `delivery`.
 *  A model anchors on the columns the tool returned, not the system-prompt routine list. */
function relatedRoutines(table: TableInfo, routines: RoutineInfo[]): RoutineInfo[] {
	const columns = new Set(table.columns.map((c) => c.name.toLowerCase()));
	return routines.filter((r) => (r.parameters?.length ?? 0) > 0 && r.parameters!.every((p) => p.name !== '' && columns.has(p.name.toLowerCase())));
}

export function describeTable(table: TableInfo, routines: RoutineInfo[]): string {
	const lines: string[] = [`${qualified(table)} (${table.kind})`];
	if (table.partitionOf) {
		lines.push(`A partition of ${table.partitionOf.schema ? `${table.partitionOf.schema}.` : ''}${table.partitionOf.name}: query that table, not this one.`);
	}
	const series = seriesComment(table).replace(/^ -- /, '');
	if (series) {
		lines.push(series);
	}
	lines.push('Columns:');
	for (const column of table.columns) {
		const flags = [column.nullable ? '' : 'NOT NULL', column.isPrimaryKey ? 'PK' : '', column.default != null ? `default ${column.default}` : '']
			.filter(Boolean)
			.join(' ');
		lines.push(`  - ${column.name} ${column.dataType}${flags ? ` ${flags}` : ''}`);
	}
	if (table.primaryKey.length > 0) {
		lines.push(`Primary key: ${table.primaryKey.join(', ')}`);
	}
	if (table.foreignKeys.length > 0) {
		lines.push('Foreign keys:');
		for (const fk of table.foreignKeys) {
			lines.push(`  - ${fk.columns.join(', ')} → ${fk.referencedTable}(${fk.referencedColumns.join(', ')})`);
		}
	}
	if (table.indexes && table.indexes.length > 0) {
		lines.push('Indexes:');
		for (const index of table.indexes) {
			lines.push(`  - ${index.name} (${index.columns.join(', ')})${index.unique ? ' UNIQUE' : ''}`);
		}
	}
	const related = relatedRoutines(table, routines);
	if (related.length > 0) {
		lines.push('Related stored functions (call these with this table\'s columns instead of returning bare ids):');
		for (const r of related) {
			const sig = r.parameters!.map((p) => `${p.name} ${p.dataType}`).join(', ');
			lines.push(`  - ${r.name}(${sig})${r.returnType ? ` → ${r.returnType}` : ''}`);
		}
	}
	return lines.join('\n');
}

/** Run one tool call, emitting start/end steps to the renderer. Errors become a tool
 *  result the model can read and recover from (rather than aborting the loop).
 *  Small models sometimes guess a synonym for the tool name (e.g. `execute_query` for
 *  `run_query`); {@link canonicalToolName} normalises common variants so the call still
 *  routes and the UI step shows the real tool. */
export async function runTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
	const normalised: ToolCall = { ...call, name: canonicalToolName(call.name) };
	const startSummary = summarise(normalised);
	ctx.emit({ callId: normalised.id, tool: normalised.name, phase: 'start', summary: startSummary });
	// Every tool AND every renderer capability dispatches through here, which is why the audit
	// call belongs at this one point rather than in each branch: a capability added later is
	// logged without anyone remembering to log it.
	const startedAt = ctx.clock ? ctx.clock() : Date.now();
	let result: ToolResult;
	try {
		result = await dispatch(normalised, ctx);
	} catch (err) {
		result = { callId: normalised.id, content: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
	const finalSummary = endSummary(normalised, result);
	ctx.emit({ callId: normalised.id, tool: normalised.name, phase: 'end', summary: finalSummary, isError: result.isError });
	if (ctx.audit) {
		// Best-effort: the audit sink must never be able to fail a tool the model is waiting on.
		try {
			ctx.audit({
				callId: normalised.id,
				tool: normalised.name,
				origin: ctx.origin ?? 'chat',
				mutates: isMutating(normalised, ctx),
				arguments: normalised.arguments ?? {},
				ok: !result.isError,
				summary: finalSummary,
				error: result.isError ? result.content : undefined,
				durationMs: (ctx.clock ? ctx.clock() : Date.now()) - startedAt,
				connectionId: ctx.connectionId,
			});
		} catch {
			// swallow: an unwritable audit log is not a reason to fail the user's action
		}
	}
	return result;
}

/**
 * Did this invocation change something? Two sources, because "mutating" is decided in two
 * different places: a client capability declares it up front (and is approved on that basis),
 * while `run_query` only turns out to be a write once you look at the SQL. Getting this wrong
 * would mislabel a DROP as a read in the audit log, which is the one record meant to answer
 * "what did the assistant actually do".
 */
function isMutating(call: ToolCall, ctx: ToolContext): boolean {
	if (ctx.clientMutates?.has(call.name)) {
		return true;
	}
	if (call.name === 'run_query' && typeof call.arguments.sql === 'string') {
		return destructiveStatement(call.arguments.sql, ctx.driverId) !== undefined;
	}
	return false;
}

/** Common synonyms small models guess for our tool names. Mapped to the real one so
 *  a wrong guess (e.g. `execute_query` instead of `run_query`) still routes, instead of
 *  hitting the Unknown-tool fallback and prompting the model to invent SQL. Unknown
 *  names pass through unchanged so the fallback still helps with truly novel guesses. */
const TOOL_ALIASES: Record<string, string> = {
	execute_query: 'run_query',
	execute_sql: 'run_query',
	run_sql: 'run_query',
	query: 'run_query',
	sql: 'run_query',
	select: 'run_query',
	get_columns: 'describe_table',
	table_columns: 'describe_table',
	describe: 'describe_table',
	get_table: 'describe_table',
	show_table: 'describe_table',
	tables: 'list_tables',
	get_tables: 'list_tables',
	list: 'list_tables',
	show_tables: 'list_tables',
	find_columns: 'search_columns',
	find_column: 'search_columns',
	search: 'search_columns',
};

function canonicalToolName(name: string): string {
	return TOOL_ALIASES[name.toLowerCase()] ?? name;
}

function summarise(call: ToolCall): string {
	const args = call.arguments;
	switch (call.name) {
		case 'list_tables': return args.filter ? `filter "${String(args.filter)}"` : 'all tables';
		case 'describe_table': return String(args.name ?? '');
		case 'search_columns': return `"${String(args.term ?? '')}"`;
		case 'run_query': return 'query';
		default: return '';
	}
}

function endSummary(call: ToolCall, result: ToolResult): string {
	if (result.isError) {
		// Surface the actual failure (DB message / refusal) so the user isn't left at "error".
		return truncate(result.content.replace(/^(query|tool) error:\s*/i, ''), 240);
	}
	// run_query / list_tables embed a count we can echo; otherwise reuse the start summary.
	const firstLine = result.content.split('\n')[0];
	if (call.name === 'run_query' || call.name === 'list_tables' || call.name === 'search_columns') {
		return truncate(firstLine, 60);
	}
	// Built-in describe_table has a meaningful start summary (the table name); client
	// capabilities don't, so fall back to their result's first line (the summary).
	return summarise(call) || truncate(firstLine, 60);
}

/** The built-in tools that need a live connection. Before any of them runs we ensure the
 *  connection is up (connecting with the user's approval if it isn't yet). */
const DB_TOOLS = new Set(['list_tables', 'describe_table', 'search_columns', 'run_query']);
// The tools whose whole job is "what columns exist right now" — they force a live re-introspect so
// they never answer from a stale schema cache. list_tables stays cached (cheap, less correctness-
// critical); keystroke completion/hover keep using the local cache and are unaffected.
const LIVE_SCHEMA_TOOLS = new Set(['describe_table', 'search_columns']);

async function dispatch(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
	const ok = (content: string): ToolResult => ({ callId: call.id, content });
	const fail = (content: string): ToolResult => ({ callId: call.id, content, isError: true });
	const args = call.arguments;

	// Which connection this DB tool targets: the active one by default, or a SECOND one the model
	// named via the `connection` argument (cross-database tasks — compare prod vs dev, propose a
	// column for another DB). A bad ref is a soft error the model can recover from.
	let handle = activeHandle(ctx);
	if (DB_TOOLS.has(call.name)) {
		const ref = typeof args.connection === 'string' ? args.connection.trim() : '';
		if (ref && ctx.resolveConnection) {
			const target = await ctx.resolveConnection(ref);
			if (!target) {
				return fail(`No saved connection matches "${ref}". Call list_connections to see their ids and labels, then pass one of those.`);
			}
			handle = target;
		}
	}
	// A second connection may allow the AI less than the active one did when the tools were
	// offered, so its own level is checked here, before anything connects or runs.
	const refusal = handle.dataAccess ? dataAccessRefusal(call.name, handle.dataAccess) : undefined;
	if (refusal) {
		return fail(refusal);
	}

	// Connect-on-demand: a DB tool against a selected-but-not-connected database asks the user to
	// connect first, then proceeds (and the handle's schema is loaded so the schema tools have data).
	if (DB_TOOLS.has(call.name) && handle.ensureConnected) {
		const ready = await handle.ensureConnected();
		if (!ready.ok) {
			return ready.declined
				? ok('The user declined to connect to the database. Ask whether to connect, or answer without running queries.')
				: fail(ready.error ?? 'Could not connect to the database.');
		}
	}
	// Authoritative schema lookups must reflect the live DB, not a possibly-stale cache: a column
	// added to a table after the last introspect would otherwise be invisible and the model would
	// confidently report it missing. Re-introspect (idempotent per turn) before these tools read.
	if (LIVE_SCHEMA_TOOLS.has(call.name) && handle.refreshSchema) {
		await handle.refreshSchema();
	}
	const tables = handle.schema?.tables ?? [];

	switch (call.name) {
		case 'list_tables': {
			const filter = String(args.filter ?? '').toLowerCase();
			// Partitions are folded under their parent, as in the prompt: a series with a hundred
			// daily partitions is one table to the person asking.
			const listed = handle.schema ? tables.filter((t) => shownToModel(handle.schema!, t)) : tables;
			const matched = filter ? listed.filter((t) => t.name.toLowerCase().includes(filter)) : listed;
			if (matched.length === 0) {
				return ok(filter ? `No tables match "${String(args.filter)}".` : 'The database has no tables.');
			}
			const kindOf = (t: TableInfo): string => t.series
				? `series table partitioned by ${t.series.timeColumn}, ${t.series.partitions.length} partitions`
				: t.rollup ? `rollup of ${t.rollup.source.name} by ${t.rollup.bucket}` : t.kind;
			const lines = matched.slice(0, MAX_TABLE_LINES).map((t) => `${qualified(t)} (${kindOf(t)}, ${t.columns.length} cols)`);
			const more = matched.length > MAX_TABLE_LINES ? `\n…and ${matched.length - MAX_TABLE_LINES} more — narrow with a filter.` : '';
			return ok(`${matched.length} tables:\n${lines.join('\n')}${more}`);
		}
		case 'describe_table': {
			const wanted = String(args.name ?? '').toLowerCase();
			if (!wanted) {
				return fail('Provide a table name.');
			}
			const table = tables.find((t) => t.name.toLowerCase() === wanted || qualified(t).toLowerCase() === wanted);
			if (!table) {
				const near = tables.filter((t) => t.name.toLowerCase().includes(wanted)).slice(0, 10).map((t) => t.name);
				return fail(`No table named "${String(args.name)}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ' Use list_tables to see what exists.'}`);
			}
			return ok(describeTable(table, handle.schema?.routines ?? []));
		}
		case 'search_columns': {
			const term = String(args.term ?? '').toLowerCase();
			if (!term) {
				return fail('Provide a search term.');
			}
			const hits: string[] = [];
			for (const table of tables) {
				if (table.name.toLowerCase().includes(term)) {
					hits.push(`${qualified(table)} (table)`);
				}
				for (const column of table.columns) {
					if (column.name.toLowerCase().includes(term)) {
						hits.push(`${qualified(table)}.${column.name} (${column.dataType})`);
					}
				}
				if (hits.length >= 100) {
					break;
				}
			}
			return ok(hits.length ? `${hits.length} matches for "${String(args.term)}":\n${hits.join('\n')}` : `No tables or columns match "${String(args.term)}".`);
		}
		case 'run_query': {
			const sql = String(args.sql ?? '').trim();
			if (!sql) {
				return fail('Provide a query.');
			}
			// Document (MongoDB) backend: the model supplies an aggregation pipeline (JSON). Run it as a
			// native read-only query; fall through to the SQL path when the arg isn't JSON (read-only
			// SQL is auto-translated). Read-only-ness ($out/$merge) is enforced in parseMongoRunQuery.
			if (handle.documentMode && handle.executeNative) {
				const parsedMongo = parseMongoRunQuery(sql, args.collection ? String(args.collection) : undefined, ctx.settings.maxRows);
				if ('error' in parsedMongo) {
					return fail(parsedMongo.error);
				}
				if ('native' in parsedMongo) {
					const preview = describeNative(parsedMongo.native);
					const approvedNative = await handle.approve(preview, call.id);
					if (!approvedNative) {
						return ok('The user declined to run this query. Ask whether to adjust it, or continue without these rows.');
					}
					const nativeOutcome = await handle.executeNative(parsedMongo.native);
					if (!nativeOutcome.ok) {
						return fail(`Query error: ${nativeOutcome.error}`);
					}
					const r = nativeOutcome.result;
					return ok(formatRows(r.fields.map((f) => f.name), r.rows, r.rowCount, r.durationMs, ctx.settings.maxRows));
				}
				// parsedMongo.sql === true: not JSON, so treat as SQL below.
			}
			const refusal = readOnlyError(sql, handle.driverId, handle.flavor);
			if (refusal) {
				return fail(refusal);
			}
			const approved = await handle.approve(sql, call.id);
			if (!approved) {
				return ok('The user declined to run this query. Ask whether to adjust it, or continue without these rows.');
			}
			const finalSql = autoLimit(sql, ctx.settings.maxRows);
			const outcome = await handle.execute(finalSql);
			if (!outcome.ok) {
				return fail(`Query error: ${outcome.error}`);
			}
			const { fields, rows, rowCount, durationMs } = outcome.result;
			return ok(formatRows(fields.map((f) => f.name), rows, rowCount, durationMs, ctx.settings.maxRows));
		}
		default: {
			// A client capability (a renderer-side tool, e.g. open_connection_form): gate it on
			// approval when it mutates, then round-trip it to the renderer to run.
			if (ctx.clientCapabilities?.has(call.name) && ctx.invokeClient) {
				const prepared = ctx.prepareAction?.({ ...call, arguments: args });
				if (prepared && !prepared.ok) {
					return fail(prepared.error);
				}
				const finalArgs = prepared ? prepared.arguments : args;
				const finalCall = { ...call, arguments: finalArgs };
				if (ctx.clientMutates?.has(call.name) && ctx.approveAction) {
					const approved = await ctx.approveAction(ctx.describeAction?.(finalCall) ?? describeCapability(finalCall), call.id);
					if (!approved) {
						return ok(`The user declined "${call.name}". Ask whether to adjust it, or continue without it.`);
					}
				}
				const result = await ctx.invokeClient({ id: call.id, name: call.name, arguments: finalArgs });
				return result.ok ? ok(renderCapabilityContent(result)) : fail(result.error ?? result.summary ?? 'Capability failed.');
			}
			// The model guessed a tool that doesn't exist. List the real ones so it can retry
			// with a valid call instead of giving up.
			const builtins = buildToolSpecs(ctx.settings, tables.length > 0 || !!ctx.ensureConnected).map((spec) => spec.name);
			const available = [...builtins, ...(ctx.clientCapabilities ?? [])];
			return fail(`Unknown tool "${call.name}". Available tools: ${available.join(', ') || '(none)'}. Use one of these.`);
		}
	}
}

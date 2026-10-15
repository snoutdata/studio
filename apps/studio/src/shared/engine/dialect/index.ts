/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Central per-vendor dialect strategy. One object per driver captures every place feature
 *  code used to branch on a driver-id string: identifier quoting, boolean literals, the
 *  sql-formatter language, transactional-DDL semantics, and the LIMIT/OFFSET vs OFFSET/FETCH
 *  vs TOP pagination split. Pure and dependency-free (like connection.ts / schema.ts) so the
 *  renderer, the main process and shared/schemaDiff can all import it. New vendors plug in one
 *  Dialect here instead of growing scattered `if (driver === …)` branches across the tree.
 *--------------------------------------------------------------------------------------------*/

import { CLICKHOUSE_BULK_FORMATS, type BulkFormat } from './bulkFormats';
import { CLICKHOUSE_TABLE_FUNCTIONS, type TableFunctionSpec } from './tableFunctionSpecs';
import { CLICKHOUSE_EXPLAIN_VARIANTS, type ExplainVariant } from './explain';
import { maskClickHouse, topLevelMatch } from './mask';
import { CLICKHOUSE_READ_ONLY, DUCKDB_READ_ONLY, lexicalOnly, MYSQL_READ_ONLY, ORACLE_READ_ONLY, POSTGRES_READ_ONLY, REDSHIFT_READ_ONLY, SQLITE_READ_ONLY, SQLSERVER_READ_ONLY, type ReadOnlyEnforcement } from './readOnly';

export * from './readOnly';

/** What the heaviest statements are ranked by: total time, bytes read, or peak memory. */
export type WorkloadRank = 'time' | 'read' | 'memory';

/** Runs one read-only statement and answers its rows by column name (a failure rejects). */
export type ReplicaRunner = (sql: string) => Promise<Record<string, unknown>[]>;

/** Which replicas a read of node-local runtime state (running queries, the query log) covers. */
export interface ReplicaScope {
	/** Replicas the server says it has; 1 on a single node. */
	readonly replicas: number;
	/** The cluster read across every replica of, or undefined when only the answering node is read. */
	readonly cluster?: string;
	/** A trailing `SETTINGS ...` bounding a read across replicas, or '' when this user may send no
	 *  setting (a `readonly = 1` user). */
	readonly settings: string;
	/** Why a server with several replicas is still read one node at a time, as a sentence. */
	readonly limitation?: string;
}

/** A named placeholder a statement leaves for the engine to fill (`{id:UInt32}` → id, UInt32). */
export interface QueryParameter {
	readonly name: string;
	readonly type: string;
}

/** A LIMIT/OFFSET pagination request the dialect turns into a concrete clause for the data grid. */
export interface PageRequest {
	/** Rows to fetch (callers pass pageSize + 1 to probe for a next page). */
	limit: number;
	/** Rows to skip. */
	offset: number;
	/** ORDER BY clause already built by the caller (leading " ORDER BY ..."), or "". Required for
	 *  OFFSET..FETCH dialects (SQL Server, Oracle); LIMIT..OFFSET dialects tolerate "". */
	orderBy: string;
	/** A deterministic fallback ORDER BY *expression* (e.g. the first column quoted) used by
	 *  OFFSET..FETCH dialects when `orderBy` is empty. Ignored by LIMIT..OFFSET dialects. */
	fallbackOrderBy: string;
}

/**
 * How a vendor spells a server-generated key column: what the designer calls "auto-increment"
 * and what each engine calls something else (MySQL AUTO_INCREMENT, SQL Server IDENTITY,
 * Postgres/Oracle/Db2/HANA GENERATED AS IDENTITY, Snowflake AUTOINCREMENT). Absent on a dialect
 * that has no such column syntax (DuckDB uses an explicit sequence) or no DDL at all (the
 * document/vector/log backends), which is also how the table designer decides whether to offer
 * the checkbox at all.
 */
export interface AutoIncrement {
	/** What the engine itself calls it, shown in the designer's tooltip. */
	readonly label: string;
	/** The clause added to the column definition, e.g. `AUTO_INCREMENT`, `IDENTITY(1,1)`. */
	readonly clause: string;
	/** Where the clause sits: right after the type (SQL Server's IDENTITY precedes NOT NULL) or
	 *  after the nullability clause (MySQL's AUTO_INCREMENT follows it). */
	readonly placement: 'after-type' | 'after-nullability';
	/** False when the engine rejects an explicit NULL/NOT NULL on such a column, because it is
	 *  implicitly NOT NULL (Postgres, Oracle, HANA, SQLite). */
	readonly allowsNullability: boolean;
	/** True when the PRIMARY KEY has to be declared INLINE on the column instead of as a table
	 *  constraint: SQLite's `INTEGER PRIMARY KEY AUTOINCREMENT` is the whole of its syntax. Such a
	 *  column can only be created with the table, never added by ALTER. */
	readonly inlinePrimaryKey?: boolean;
	/** True when the engine requires the column to be a key (MySQL: "there can be only one auto
	 *  column and it must be defined as a key"), so the designer ticks PK along with it. */
	readonly requiresKey?: boolean;
}

/**
 * The pluggable per-vendor SQL surface shared by client + server. Each existing driver id maps
 * to one Dialect whose output reproduces what the old per-vendor branches produced; an unknown
 * id falls back to {@link GENERIC_DIALECT}.
 */
export interface Dialect {
	/** The driver id this dialect serves (matches ConnectionConfig.driver / DatabaseDriver.id). */
	readonly driverId: string;
	/** Human-readable name for the connection-form option label and the explorer. */
	readonly displayName: string;
	/** Shorter name handed to the AI prompt as the SQL flavour (e.g. "PostgreSQL", "Oracle"). */
	readonly aiDisplayName: string;
	/** Default TCP port for a new connection of this vendor. */
	readonly defaultPort: number;
	/** True kind of case-folding unquoted identifiers undergo in the catalog (Oracle → 'upper',
	 *  Postgres → 'lower'); false when names are stored as written. Carried for callers that
	 *  compare introspected names to user-typed ones; quoting in generated SQL is unaffected. */
	readonly foldsIdentifierCase: false | 'upper' | 'lower';
	/** The sql-formatter language string ('postgresql' | 'mysql' | 'transactsql' | 'plsql' |
	 *  'sql'). Returned as a plain string so shared/ needn't import sql-formatter's type. */
	readonly formatterLanguage: string;
	/** Postgres has transactional DDL (all-or-nothing migrations). MySQL, SQL Server AND Oracle
	 *  auto-commit each DDL statement, so this is false for them (Oracle: implicit commit per DDL). */
	readonly isTransactionalDdl: boolean;
	/** True when a backslash inside a string literal is an ESCAPE (MySQL and MariaDB by default,
	 *  ClickHouse always), so a literal must double it. Absent means a backslash is an ordinary
	 *  character, the SQL standard. Getting it wrong is not cosmetic: a value ending in `\` swallows
	 *  its own closing quote. */
	readonly backslashEscapes?: boolean;

	/** What the DATABASE is asked to do so a read-only run cannot write (`readOnly.ts`). Absent: the
	 *  engine has no such mode the app uses, and only the lexical guard holds (`readOnlyEnforcement`). */
	readonly readOnly?: ReadOnlyEnforcement;

	/** How this vendor spells an auto-increment column, or absent when it has none. */
	readonly autoIncrement?: AutoIncrement;
	/** Quote one identifier for this dialect (pg/oracle "x", mssql [x], mysql `x`). */
	quoteIdent(name: string): string;
	/** SQL literal for a boolean (pg TRUE/FALSE; mysql/mssql/oracle 1/0). */
	booleanLiteral(value: boolean): string;
	/** Build a paginated SELECT for the data grid. `select` is the full statement up to (but
	 *  excluding) the ORDER BY / pagination tail, e.g. `SELECT * FROM "t" WHERE …`. */
	paginatedSelect(select: string, page: PageRequest): string;
	/** True when a bare SELECT is already row-capped (so auto-limit leaves it alone). `trimmed`
	 *  has any trailing semicolon already stripped. */
	hasLimit(trimmed: string): boolean;
	/** Inject a row cap of `n` into a bare single SELECT (mssql `TOP n` after SELECT; oracle
	 *  `FETCH FIRST n ROWS ONLY`; others trailing `LIMIT n`). Returns the capped statement
	 *  without a trailing semicolon. */
	limitClause(trimmed: string, n: number): string;
	/**
	 * Re-fetch the SAME statement as a window: `limit` rows starting at `offset`. Powers the
	 * results grid's fetch-past-the-cap (Next at the end of the loaded rows re-runs the user's
	 * statement one window further in), so it takes the user's own statement rather than the
	 * assembled browse SELECT `paginatedSelect` builds. At offset 0 it is exactly
	 * {@link limitClause}, so the first window and the auto-LIMIT agree. Callers check
	 * {@link hasLimit} first — a statement carrying its own cap is never windowed.
	 *
	 * NOTE the offset caveat: without a total-ordering `ORDER BY`, consecutive windows are not
	 * guaranteed disjoint on any engine. This is the documented shallow fallback until keyset
	 * paging lands.
	 */
	windowClause(trimmed: string, limit: number, offset: number): string;
	/** A one-row "peek" SELECT for the FK hover card. `fromAndWhere` is `<ref> WHERE <conds>`. */
	peekOne(cols: string, fromAndWhere: string): string;
	/**
	 * A SELECT yielding this database's OWN current timestamp, in one column.
	 *
	 * Exists because a watermark read (`updated_at > :since`) must be bounded by a clock the
	 * SOURCE keeps, never by ours. Two machines are never exactly in step, and a ceiling taken from
	 * the app's clock while it runs a few seconds ahead of the database silently skips every row
	 * written in the gap — permanently, because the cursor moves past them.
	 *
	 * Absent means the standard `SELECT CURRENT_TIMESTAMP`, which is valid standalone on most
	 * engines; the three that require a FROM say so themselves.
	 */
	readonly nowSelect?: string;
	/**
	 * A read-only SELECT against this vendor's own runtime statistics views (pg_stat_statements,
	 * performance_schema, v$sqlarea, …) yielding the heaviest statements by total time. Powers the
	 * Workload advisor. Returns `null` for engines with no such view (SQLite, generic) and is
	 * absent on non-SQL backends (Mongo/Pinecone). Every implementation yields the SAME column set
	 * so callers see one shape per vendor:
	 *
	 *   `query_text | calls | total_ms | mean_ms | rows`
	 *
	 * All begin with SELECT/WITH so they pass the read-only guard unchanged. The result is point-in-
	 * time (the DB accumulates the stats itself); we surface it, we do not sample continuously.
	 */
	workloadDigest?(topN: number, scope?: ReplicaScope, rankBy?: WorkloadRank): string | null;

	/**
	 * What `workloadDigest` can rank the heaviest statements by, first the default. Absent means time
	 * only. An engine that records what each statement READ and HELD (ClickHouse's query log) adds
	 * those, and its digest carries them as extra columns after the five every vendor shares.
	 */
	workloadRankings?: readonly WorkloadRank[];

	/**
	 * For an engine whose runtime views are per NODE while a load balancer sends each request to any
	 * of several (ClickHouse Cloud, a replicated ClickHouse behind a proxy): find the replicas, so
	 * `workloadDigest` and the operations views can read all of them instead of whichever one the
	 * balancer picked. Handed a runner for read-only statements; absent where a node is the database.
	 */
	replicaScope?(run: ReplicaRunner): Promise<ReplicaScope>;

	/**
	 * Named placeholders the ENGINE binds (ClickHouse `{name:Type}`), each once, in order of first
	 * use; `[]` when the statement has none. Absent on an engine without server-side named parameters.
	 * Placeholders inside strings, quoted names and comments are not placeholders.
	 */
	queryParameters?(sql: string): QueryParameter[];

	/**
	 * The statement that binds `values` (as the person typed them) for every later statement on the
	 * connection. Present exactly when `queryParameters` is.
	 */
	bindParameters?(values: Readonly<Record<string, string>>): string;

	/**
	 * Wrap a SELECT so the engine returns its execution PLAN as JSON without running the query
	 * (Postgres `EXPLAIN (FORMAT JSON)`, MySQL/MariaDB `EXPLAIN FORMAT=JSON`). Powers the post-run
	 * index/scan advisor (Pillar 2 Tier B): the plan JSON is parsed by `planAdvisor.ts` to flag full
	 * scans, large row estimates, filesorts and temp tables. The result is a single row whose one cell
	 * is the plan JSON (both engines shape it that way). Returns `null` for engines whose plan output
	 * isn't a parseable JSON document we support yet (SQL Server / Oracle / Db2 / Snowflake / SQLite),
	 * and is absent on non-SQL backends — in both cases the advisor silently no-ops for that vendor.
	 * `sql` is assumed already validated as a read-only SELECT by the caller.
	 */
	explainJson?(sql: string): string | null;

	/**
	 * The EXPLAIN forms this engine offers a person DIRECTLY, in the order the picker shows them
	 * (the Explain panel, `ExplainPanel.tsx`). {@link explainJson} is the one the advisor runs by
	 * itself; this is the set someone asks for on purpose, each with its own answer shape.
	 * Absent for a vendor with only the one plan, which is why the panel and its Run-menu entry
	 * appear for ClickHouse and nowhere else yet.
	 */
	readonly explainVariants?: readonly ExplainVariant[];

	/**
	 * The formats this engine will take a FILE of, over its own wire protocol, with the file's
	 * bytes as the statement's body (`bulkLoad.ts`). Absent for an engine whose only way in is
	 * `INSERT ... VALUES`, and its absence is what hides the Load button, so a driver gains the
	 * feature by declaring a list and nothing else.
	 */
	readonly bulkFormats?: readonly BulkFormat[];

	/**
	 * The functions this engine answers a SELECT from that are not tables at all: a file in a
	 * bucket, a page on the web, another database (`tableFunctionSpecs.ts`). Declaring them is
	 * what puts the Remote data screen on a connection, and its absence is what keeps it off
	 * every engine that has no such thing.
	 */
	readonly tableFunctions?: readonly TableFunctionSpec[];

	/**
	 * A short, concrete, vendor-specific tuning playbook injected into the "Suggest optimization"
	 * prompt of the Query Performance tool. The generic chat system prompt is built for Q&A, so on
	 * a modest model the optimize turn has no domain knowledge to lean on; this hands it the actual
	 * levers for THIS engine (e.g. MySQL composite-index column order, Postgres partial indexes,
	 * Snowflake partition pruning) so its suggestions are specific and correct rather than generic.
	 * Plain prose (newline-separated bullets). Absent for engines with no workload digest (SQLite,
	 * Mongo, Pinecone, generic) — the optimize path never reaches them.
	 */
	readonly optimizationHints?: string;

	/**
	 * Keywords this vendor has and the cross-dialect set does not (ClickHouse `PREWHERE`, `FINAL`,
	 * `ARRAY JOIN`, `SETTINGS`). Two surfaces read it: completion offers them, and the editor colours
	 * them. Absent for a vendor whose SQL the shared list already covers.
	 *
	 * Only words that are keywords in a STATEMENT — a word that is merely a function name belongs to
	 * the engine catalog, which is read from the connected server rather than declared here.
	 */
	readonly keywords?: readonly string[];

	/**
	 * Type names this vendor has and the shared list does not (`UInt64`, `LowCardinality`, `Map`).
	 * Colouring only: the authoritative list is the engine catalog's `dataTypes`, read live.
	 */
	readonly typeNames?: readonly string[];
}

/** Clamp a caller-supplied row cap to a sane positive integer before interpolating into stats SQL. */
function topRows(n: number): number {
	return Math.min(200, Math.max(1, Math.trunc(n) || 15));
}

/** Drop a trailing semicolon (and surrounding whitespace) so a statement can be wrapped, e.g.
 *  `EXPLAIN (FORMAT JSON) <sql>`. */
function stripTrailingSemicolon(sql: string): string {
	return sql.trim().replace(/;\s*$/, '');
}

function backtickQuote(name: string): string {
	return '`' + name.replace(/`/g, '``') + '`';
}

/**
 * A ClickHouse identifier, backtick-quoted. ClickHouse reads a backslash as an escape inside any
 * quotes, backticks included, so it is doubled before the backtick is: otherwise a name with a
 * backslash before a backtick closes its own quotes and the rest of it is read as SQL. Every
 * ClickHouse identifier the app builds goes through this one function.
 */
export function quoteClickHouseIdent(name: string): string {
	return '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '``') + '`';
}

function doubleQuote(name: string): string {
	return '"' + name.replace(/"/g, '""') + '"';
}

function bracketQuote(name: string): string {
	return '[' + name.replace(/]/g, ']]') + ']';
}

/**
 * SQL reserved words that double as natural table/column names, so they MUST be quoted when used
 * as an identifier (e.g. a table literally named `order` — `SELECT * FROM order` is a syntax error
 * in nearly every dialect; it has to be `"order"` / `` `order` `` / `[order]`). A deliberately
 * conservative, cross-vendor superset weighted toward words people actually name columns/tables:
 * quoting a word a given engine does not reserve is harmless, while MISSING one yields broken SQL.
 * Plain English nouns that no major engine reserves (name, status, state, email, title, …) are left
 * out on purpose so the generated schema/SQL stays readable. Lowercased for case-insensitive lookup.
 */
export const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
	'order', 'user', 'group', 'table', 'column', 'select', 'from', 'where', 'insert', 'update',
	'delete', 'into', 'values', 'create', 'drop', 'alter', 'index', 'key', 'primary', 'foreign',
	'references', 'constraint', 'check', 'default', 'view', 'database', 'schema', 'grant', 'revoke',
	'role', 'union', 'join', 'inner', 'outer', 'left', 'right', 'full', 'cross', 'on', 'using',
	'natural', 'as', 'by', 'asc', 'desc', 'distinct', 'having', 'limit', 'offset', 'fetch', 'top',
	'and', 'or', 'not', 'null', 'is', 'in', 'between', 'like', 'exists', 'all', 'any', 'case',
	'when', 'then', 'else', 'end', 'cast', 'date', 'time', 'timestamp', 'datetime', 'interval',
	'year', 'month', 'day', 'hour', 'minute', 'second', 'zone', 'level', 'comment', 'language',
	'position', 'value', 'set', 'to', 'with', 'over', 'partition', 'window', 'range', 'rows', 'row',
	'rank', 'returning', 'output', 'merge', 'truncate', 'rename', 'add', 'before', 'after', 'trigger',
	'procedure', 'function', 'begin', 'commit', 'rollback', 'transaction', 'lock', 'public', 'current',
	'system', 'session', 'sequence', 'identity', 'unique', 'collate', 'escape', 'leading', 'trailing',
	'both', 'type', 'number', 'mode', 'size', 'access', 'label', 'start', 'option', 'minus', 'share',
]);

/**
 * Whether `name` must be quoted to be a valid identifier in generated SQL: it is either a reserved
 * word (case-insensitive, see {@link RESERVED_IDENTIFIERS}) or contains characters outside a plain
 * identifier (a space, punctuation, or a leading digit). Plain names like `users` / `order_items`
 * return false so schema/SQL stays readable; `order`, `user`, `select`, `my table` return true.
 */
export function identifierNeedsQuoting(name: string): boolean {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		return true;
	}
	return RESERVED_IDENTIFIERS.has(name.toLowerCase());
}

/** LIMIT..OFFSET pagination shared by MySQL, Postgres and the generic fallback. */
function limitOffsetSelect(select: string, page: PageRequest): string {
	return `${select}${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`;
}

/** OFFSET..FETCH pagination shared by SQL Server and Oracle (needs a deterministic ORDER BY). */
function offsetFetchSelect(select: string, page: PageRequest): string {
	const seek = page.orderBy || ` ORDER BY ${page.fallbackOrderBy}`;
	return `${select}${seek} OFFSET ${page.offset} ROWS FETCH NEXT ${page.limit} ROWS ONLY`;
}

/** Windowed re-fetch for the LIMIT..OFFSET dialects (MySQL/MariaDB/Postgres/SQLite/DuckDB/
 *  Snowflake/Mongo/Pinecone/generic). Appends after the user's own ORDER BY, if any. */
function limitOffsetWindow(trimmed: string, limit: number, offset: number): string {
	return offset > 0 ? `${trimmed}\nLIMIT ${limit} OFFSET ${offset}` : `${trimmed}\nLIMIT ${limit}`;
}

/** Windowed re-fetch for Oracle / Db2: `OFFSET n ROWS FETCH NEXT m ROWS ONLY` is valid on both
 *  with or without an ORDER BY (unlike SQL Server), so the statement is appended to as-is. */
function offsetFetchWindow(trimmed: string, limit: number, offset: number): string {
	return offset > 0
		? `${trimmed}\nOFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
		: `${trimmed}\nFETCH FIRST ${limit} ROWS ONLY`;
}

/** SQL Server's row cap: `TOP n` right after SELECT (or SELECT DISTINCT). */
function sqlServerTop(trimmed: string, n: number): string {
	return trimmed.replace(/^select(\s+distinct)?\b/i, (m) => `${m} TOP ${n}`);
}

/**
 * Whether `sql` carries an ORDER BY at the TOP level — not one nested inside a subquery or an
 * `OVER (…)` window clause. A plain `/\border\s+by\b/` is not good enough here: `SELECT
 * ROW_NUMBER() OVER (ORDER BY id) … FROM t` contains "ORDER BY" yet still needs one of its own,
 * and getting that wrong produces SQL the engine rejects. Paren-depth aware, skipping string
 * literals and quoted identifiers so a `')'` inside one can't unbalance the count.
 */
function hasTopLevelOrderBy(sql: string): boolean {
	let depth = 0;
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === '[' || ch === '`') {
			const close = ch === '[' ? ']' : ch;
			i++;
			while (i < sql.length && sql[i] !== close) {
				i++;
			}
			continue;
		}
		if (ch === '(') {
			depth++;
			continue;
		}
		if (ch === ')') {
			depth--;
			continue;
		}
		if (depth === 0 && (ch === 'o' || ch === 'O') && (i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1])) && /^order\s+by\b/i.test(sql.slice(i, i + 16))) {
			return true;
		}
	}
	return false;
}

/** Windowed re-fetch for SQL Server. `TOP` can't express an offset, so past the first window it
 *  switches to OFFSET..FETCH — which T-SQL only accepts after a top-level ORDER BY, hence the
 *  standard `ORDER BY (SELECT NULL)` no-op when the statement doesn't bring one of its own. */
function sqlServerWindow(trimmed: string, limit: number, offset: number): string {
	if (offset <= 0) {
		return sqlServerTop(trimmed, limit);
	}
	const seek = hasTopLevelOrderBy(trimmed) ? '' : '\nORDER BY (SELECT NULL)';
	return `${trimmed}${seek}\nOFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
}

// Tuning playbook for the MySQL family (MySQL + Aurora + MariaDB). Same engine levers; the CTE note
// holds for MySQL 8.0+ / MariaDB 10.2+. Kept tight so a modest model gets the concrete levers, not a
// wall of generic advice.
const MYSQL_FAMILY_HINTS = [
	"- In EXPLAIN, type=ALL or \"Using filesort\"/\"Using temporary\" flags a full scan or a sort/temp table an index can remove.",
	"- Add a composite index with equality columns first, then the range or ORDER BY column, so one index serves both the WHERE and the sort.",
	"- Make filters sargable: don't wrap an indexed column in a function or arithmetic (DATE(col)=…, col+0) and avoid a leading-wildcard LIKE '%x' — these block index use.",
	"- A covering index (one that includes the selected columns) skips the table lookup; this needs the query to select specific columns, not SELECT *.",
	"- Rewrite a correlated subquery or an OR-chain as a JOIN or derived table. CTEs (WITH) are available for readability but are not an optimization fence and add no speed on their own.",
	"- For deep pagination, seek by the last indexed key (WHERE id > :last ORDER BY id LIMIT n) instead of a large OFFSET.",
].join('\n');

const MYSQL_AUTO_INCREMENT: AutoIncrement = { label: 'AUTO_INCREMENT', clause: 'AUTO_INCREMENT', placement: 'after-nullability', allowsNullability: true, requiresKey: true };
// The SQL-standard spelling, shared by Postgres 10+, Oracle 12c+, Db2 and HANA. BY DEFAULT (rather
// than ALWAYS) so an INSERT may still supply its own value, which is what a migrated row needs.
const IDENTITY_CLAUSE = 'GENERATED BY DEFAULT AS IDENTITY';

const MYSQL_DIALECT: Dialect = {
	driverId: 'mysql-aurora',
	readOnly: MYSQL_READ_ONLY,
	displayName: 'MySQL / Aurora MySQL',
	aiDisplayName: 'MySQL',
	defaultPort: 3306,
	foldsIdentifierCase: false,
	formatterLanguage: 'mysql',
	isTransactionalDdl: false,
	backslashEscapes: true,
	autoIncrement: MYSQL_AUTO_INCREMENT,
	quoteIdent: backtickQuote,
	booleanLiteral: (value) => (value ? '1' : '0'),
	paginatedSelect: limitOffsetSelect,
	hasLimit: (trimmed) => /\blimit\s+\d/i.test(trimmed),
	limitClause: (trimmed, n) => `${trimmed}\nLIMIT ${n}`,
	windowClause: limitOffsetWindow,
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} LIMIT 1`,
	// performance_schema must be enabled (it is by default on MySQL 5.6+/Aurora). SUM/AVG_TIMER_WAIT
	// are picoseconds → /1e9 for ms. `rows` is reserved in MySQL 8.0, so backtick the alias.
	workloadDigest: (topN) => `SELECT DIGEST_TEXT AS query_text, COUNT_STAR AS calls,
       ROUND(SUM_TIMER_WAIT / 1e9, 1) AS total_ms,
       ROUND(AVG_TIMER_WAIT / 1e9, 1) AS mean_ms, SUM_ROWS_SENT AS \`rows\`
FROM performance_schema.events_statements_summary_by_digest
WHERE DIGEST_TEXT IS NOT NULL
ORDER BY SUM_TIMER_WAIT DESC
LIMIT ${topRows(topN)}`,
	explainJson: (sql) => `EXPLAIN FORMAT=JSON ${stripTrailingSemicolon(sql)}`,
	optimizationHints: MYSQL_FAMILY_HINTS,
};

// MariaDB is a MySQL fork: same wire protocol (the mysql2 client drives it), same backtick
// quoting, 1/0 booleans, LIMIT/OFFSET and auto-commit DDL. Only the display name and the
// sql-formatter language differ from MySQL.
const MARIADB_DIALECT: Dialect = {
	driverId: 'mariadb',
	readOnly: MYSQL_READ_ONLY,
	displayName: 'MariaDB',
	aiDisplayName: 'MariaDB',
	defaultPort: 3306,
	foldsIdentifierCase: false,
	formatterLanguage: 'mariadb',
	isTransactionalDdl: false,
	backslashEscapes: true,
	autoIncrement: MYSQL_AUTO_INCREMENT,
	quoteIdent: backtickQuote,
	booleanLiteral: (value) => (value ? '1' : '0'),
	paginatedSelect: limitOffsetSelect,
	hasLimit: (trimmed) => /\blimit\s+\d/i.test(trimmed),
	limitClause: (trimmed, n) => `${trimmed}\nLIMIT ${n}`,
	windowClause: limitOffsetWindow,
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} LIMIT 1`,
	// MariaDB carries the same performance_schema digest table as MySQL.
	workloadDigest: (topN) => `SELECT DIGEST_TEXT AS query_text, COUNT_STAR AS calls,
       ROUND(SUM_TIMER_WAIT / 1e9, 1) AS total_ms,
       ROUND(AVG_TIMER_WAIT / 1e9, 1) AS mean_ms, SUM_ROWS_SENT AS \`rows\`
FROM performance_schema.events_statements_summary_by_digest
WHERE DIGEST_TEXT IS NOT NULL
ORDER BY SUM_TIMER_WAIT DESC
LIMIT ${topRows(topN)}`,
	explainJson: (sql) => `EXPLAIN FORMAT=JSON ${stripTrailingSemicolon(sql)}`,
	optimizationHints: MYSQL_FAMILY_HINTS,
};

const POSTGRES_DIALECT: Dialect = {
	driverId: 'postgres',
	readOnly: POSTGRES_READ_ONLY,
	displayName: 'PostgreSQL',
	aiDisplayName: 'PostgreSQL',
	defaultPort: 5432,
	foldsIdentifierCase: 'lower',
	formatterLanguage: 'postgresql',
	isTransactionalDdl: true,
	autoIncrement: { label: 'IDENTITY', clause: IDENTITY_CLAUSE, placement: 'after-type', allowsNullability: false },
	quoteIdent: doubleQuote,
	booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
	paginatedSelect: limitOffsetSelect,
	hasLimit: (trimmed) => /\blimit\s+\d/i.test(trimmed),
	limitClause: (trimmed, n) => `${trimmed}\nLIMIT ${n}`,
	windowClause: limitOffsetWindow,
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} LIMIT 1`,
	// Requires the pg_stat_statements extension (CREATE EXTENSION + shared_preload_libraries). When
	// absent the DB raises "relation … does not exist", relayed so the model can say to enable it.
	// total_exec_time/mean_exec_time are already milliseconds; `rows` is the view's own column.
	workloadDigest: (topN) => `SELECT query AS query_text, calls,
       round(total_exec_time::numeric, 1) AS total_ms,
       round(mean_exec_time::numeric, 1)  AS mean_ms, rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT ${topRows(topN)}`,
	explainJson: (sql) => `EXPLAIN (FORMAT JSON) ${stripTrailingSemicolon(sql)}`,
	optimizationHints: [
		"- Run EXPLAIN (ANALYZE, BUFFERS) and compare actual rows to the planner's estimate; a large gap means stale statistics, so run ANALYZE on the table.",
		"- Watch for a Seq Scan on a big table, or a Sort/Hash that spills to disk (\"external merge Disk\").",
		"- Add a B-tree index matching the WHERE equality columns plus the ORDER BY; a partial index (… WHERE <selective predicate>) is smaller and faster for a selective filter, and an expression index helps when you filter on an expression.",
		"- Keep filters sargable (no function over the indexed column). A covering index with INCLUDE (cols) enables an index-only scan.",
		"- A CTE (WITH) is inlined from Postgres 12 on, so use it freely for readability; before 12 it was an optimization fence.",
	].join('\n'),
};

const SQLSERVER_DIALECT: Dialect = {
	driverId: 'sqlserver',
	readOnly: SQLSERVER_READ_ONLY,
	displayName: 'Microsoft SQL Server',
	aiDisplayName: 'SQL Server',
	defaultPort: 1433,
	foldsIdentifierCase: false,
	formatterLanguage: 'transactsql',
	isTransactionalDdl: false,
	autoIncrement: { label: 'IDENTITY', clause: 'IDENTITY(1,1)', placement: 'after-type', allowsNullability: true },
	quoteIdent: bracketQuote,
	booleanLiteral: (value) => (value ? '1' : '0'),
	paginatedSelect: offsetFetchSelect,
	// LIMIT (defensive), an existing TOP, or an OFFSET..FETCH tail all count as already-capped.
	// The last matters: TOP and OFFSET..FETCH can't coexist, so capping a statement that already
	// pages itself would produce SQL the engine rejects.
	hasLimit: (trimmed) => /\blimit\s+\d/i.test(trimmed) || /^select\s+(distinct\s+)?top\b/i.test(trimmed)
		|| /\bfetch\s+(first|next)\b/i.test(trimmed) || /\boffset\s+\d/i.test(trimmed),
	limitClause: sqlServerTop,
	windowClause: sqlServerWindow,
	peekOne: (cols, fromAndWhere) => `SELECT TOP 1 ${cols} FROM ${fromAndWhere}`,
	// Needs VIEW SERVER STATE. total_elapsed_time/total_rows are microseconds → /1000 for ms.
	// `rows` is a reserved word in T-SQL, so bracket the alias. text is truncated to keep the cell sane.
	workloadDigest: (topN) => `SELECT TOP (${topRows(topN)}) SUBSTRING(t.text, 1, 400) AS query_text,
       qs.execution_count AS calls,
       ROUND(qs.total_elapsed_time / 1000.0, 1) AS total_ms,
       ROUND(qs.total_elapsed_time / 1000.0 / NULLIF(qs.execution_count, 0), 1) AS mean_ms,
       qs.total_rows AS [rows]
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) t
ORDER BY qs.total_elapsed_time DESC`,
	optimizationHints: [
		"- Read the actual execution plan (or SET STATISTICS IO, TIME ON) and look for a Key Lookup, a Sort, or an Index/Table Scan on a large table.",
		"- Add a covering index: key columns equality-first then the range/ORDER BY column, with the selected columns in INCLUDE to eliminate the key lookup.",
		"- Keep predicates SARGable (no function or CONVERT over the indexed column, no leading-wildcard LIKE).",
		"- A skewed plan that's fast sometimes and slow other times is often parameter sniffing; OPTION (RECOMPILE) or OPTIMIZE FOR can stabilize it.",
		"- CTEs (WITH) are for readability only here, not a performance lever.",
	].join('\n'),
};

const ORACLE_DIALECT: Dialect = {
	driverId: 'oracle',
	readOnly: ORACLE_READ_ONLY,
	nowSelect: 'SELECT SYSTIMESTAMP FROM DUAL',
	displayName: 'Oracle Database',
	aiDisplayName: 'Oracle',
	defaultPort: 1521,
	// Unquoted Oracle identifiers are folded to UPPERCASE in the data dictionary.
	foldsIdentifierCase: 'upper',
	formatterLanguage: 'plsql',
	// Oracle implicitly COMMITs before and after every DDL statement: a migration can never be
	// rolled back as a unit, so it is NOT transactional (unlike Postgres).
	isTransactionalDdl: false,
	autoIncrement: { label: 'IDENTITY', clause: IDENTITY_CLAUSE, placement: 'after-type', allowsNullability: false },
	quoteIdent: doubleQuote,
	// No native BOOLEAN before 23c; booleans are modelled as NUMBER(1) with 1/0 literals.
	booleanLiteral: (value) => (value ? '1' : '0'),
	paginatedSelect: offsetFetchSelect,
	hasLimit: (trimmed) => /\bfetch\s+(first|next)\b/i.test(trimmed) || /\boffset\s+\d/i.test(trimmed),
	limitClause: (trimmed, n) => `${trimmed}\nFETCH FIRST ${n} ROWS ONLY`,
	windowClause: offsetFetchWindow,
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} FETCH FIRST 1 ROWS ONLY`,
	// Needs SELECT ANY DICTIONARY (or SELECT on V_$SQLAREA). elapsed_time is microseconds → /1000 for
	// ms. ROWS is reserved in Oracle, so the alias is double-quoted (yields a lowercase `rows` column).
	workloadDigest: (topN) => `SELECT * FROM (
  SELECT sql_text AS query_text, executions AS calls,
         ROUND(elapsed_time / 1000, 1) AS total_ms,
         ROUND(elapsed_time / 1000 / NULLIF(executions, 0), 1) AS mean_ms,
         rows_processed AS "rows"
  FROM v$sqlarea ORDER BY elapsed_time DESC
) WHERE ROWNUM <= ${topRows(topN)}`,
	optimizationHints: [
		"- Read the plan with EXPLAIN PLAN + DBMS_XPLAN.DISPLAY (or SET AUTOTRACE ON); look for a FULL table scan, a high-cost step, or actual-vs-estimated row skew.",
		"- Add a B-tree index matching the WHERE equality columns plus the ORDER BY; a function-based index covers a filter on an expression (e.g. UPPER(col)).",
		"- Keep predicates sargable (no function over the indexed column) and use bind variables, not literals, so cursors are shared and not re-parsed.",
		"- If estimates are far off, refresh stats with DBMS_STATS.GATHER_TABLE_STATS.",
		"- CTEs (WITH) are for readability; the optimizer may materialize them, so don't rely on them for speed.",
	].join('\n'),
};

const DB2_DIALECT: Dialect = {
	driverId: 'db2',
	nowSelect: 'SELECT CURRENT TIMESTAMP FROM SYSIBM.SYSDUMMY1',
	displayName: 'IBM Db2',
	aiDisplayName: 'Db2',
	defaultPort: 50000,
	// Unquoted Db2 identifiers are folded to UPPERCASE in the system catalog (SYSCAT.*).
	foldsIdentifierCase: 'upper',
	formatterLanguage: 'db2',
	// Db2 LUW DDL is capable of running inside a unit of work, but our driver (like the other
	// vendors') executes with autocommit per statement, so the migration plan is treated as
	// non-transactional — statement-by-statement, not wrapped.
	isTransactionalDdl: false,
	autoIncrement: { label: 'IDENTITY', clause: IDENTITY_CLAUSE, placement: 'after-nullability', allowsNullability: true },
	quoteIdent: doubleQuote,
	// No portable BOOLEAN before 11.5; booleans are modelled as SMALLINT with 1/0 literals.
	booleanLiteral: (value) => (value ? '1' : '0'),
	paginatedSelect: offsetFetchSelect,
	hasLimit: (trimmed) => /\bfetch\s+(first|next)\b/i.test(trimmed) || /\boffset\s+\d/i.test(trimmed),
	limitClause: (trimmed, n) => `${trimmed}\nFETCH FIRST ${n} ROWS ONLY`,
	windowClause: offsetFetchWindow,
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} FETCH FIRST 1 ROWS ONLY`,
	// Package-cache statement metrics. Needs the MON_GET_PKG_CACHE_STMT table function (granted via
	// EXECUTE on it / DATAACCESS). TOTAL_ACT_TIME is already milliseconds. ROWS is reserved → quoted.
	workloadDigest: (topN) => `SELECT STMT_TEXT AS query_text, NUM_EXECUTIONS AS calls,
       TOTAL_ACT_TIME AS total_ms,
       TOTAL_ACT_TIME / NULLIF(NUM_EXECUTIONS, 0) AS mean_ms,
       ROWS_RETURNED AS "rows"
FROM TABLE(MON_GET_PKG_CACHE_STMT(NULL, NULL, NULL, -2))
WHERE STMT_TEXT IS NOT NULL
ORDER BY TOTAL_ACT_TIME DESC
FETCH FIRST ${topRows(topN)} ROWS ONLY`,
	optimizationHints: [
		"- Run RUNSTATS on the touched tables first so the optimizer has current statistics, then read the plan with EXPLAIN / db2expln and look for a table scan or a sort.",
		"- Add an index matching the WHERE equality columns plus the ORDER BY; include the selected columns so the access is index-only.",
		"- Keep predicates sargable (no function over the indexed column, no leading-wildcard LIKE).",
		"- CTEs (common table expressions) are for readability, not a performance lever.",
	].join('\n'),
};

const SQLITE_DIALECT: Dialect = {
	driverId: 'sqlite',
	readOnly: SQLITE_READ_ONLY,
	displayName: 'SQLite',
	aiDisplayName: 'SQLite',
	// File-based engine: no network port. 0 signals the connection form to hide host/port.
	defaultPort: 0,
	// SQLite stores identifiers as written and compares them case-insensitively (for ASCII); names
	// are not folded in the catalog, so treat them as stored-as-written like MySQL/SQL Server.
	foldsIdentifierCase: false,
	formatterLanguage: 'sqlite',
	// SQLite has fully transactional DDL: CREATE/ALTER/DROP inside a transaction roll back as a unit.
	isTransactionalDdl: true,
	// `INTEGER PRIMARY KEY AUTOINCREMENT` is the whole of SQLite's syntax: the key is part of the
	// clause, which is why it carries PRIMARY KEY and sets `inlinePrimaryKey`.
	autoIncrement: { label: 'AUTOINCREMENT', clause: 'PRIMARY KEY AUTOINCREMENT', placement: 'after-type', allowsNullability: false, inlinePrimaryKey: true, requiresKey: true },
	quoteIdent: doubleQuote,
	// No native boolean type; SQLite models booleans as 0/1 integers.
	booleanLiteral: (value) => (value ? '1' : '0'),
	paginatedSelect: limitOffsetSelect,
	hasLimit: (trimmed) => /\blimit\s+\d/i.test(trimmed),
	limitClause: (trimmed, n) => `${trimmed}\nLIMIT ${n}`,
	windowClause: limitOffsetWindow,
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} LIMIT 1`,
	// File-based engine: no server-side runtime statistics view. The Workload advisor reports
	// "not available for this connection" when the digest is null.
	workloadDigest: () => null,
};

const DUCKDB_DIALECT: Dialect = {
	driverId: 'duckdb',
	readOnly: DUCKDB_READ_ONLY,
	displayName: 'DuckDB',
	aiDisplayName: 'DuckDB',
	// Embedded, file-based engine: no network port. 0 signals the connection form to hide host/port.
	defaultPort: 0,
	// DuckDB stores identifiers case-insensitively but preserves the written case in the catalog
	// (information_schema returns names as declared), so treat them as stored-as-written, not folded.
	foldsIdentifierCase: false,
	// DuckDB's SQL is Postgres-compatible; sql-formatter has no DuckDB dialect, so use PostgreSQL.
	formatterLanguage: 'postgresql',
	// DuckDB has transactional DDL: CREATE/ALTER/DROP inside a transaction roll back as a unit.
	isTransactionalDdl: true,
	quoteIdent: doubleQuote,
	// DuckDB has a native BOOLEAN type.
	booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
	paginatedSelect: limitOffsetSelect,
	hasLimit: (trimmed) => /\blimit\s+\d/i.test(trimmed),
	limitClause: (trimmed, n) => `${trimmed}\nLIMIT ${n}`,
	windowClause: limitOffsetWindow,
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} LIMIT 1`,
	// Embedded engine: no persistent server-side runtime-statistics view. The Workload advisor
	// reports "not available for this connection" when the digest is null.
	workloadDigest: () => null,
};

const SNOWFLAKE_DIALECT: Dialect = {
	driverId: 'snowflake',
	displayName: 'Snowflake',
	aiDisplayName: 'Snowflake',
	// Cloud warehouse reached over HTTPS by account identifier; 443 is the implicit port. The form
	// hides host/port for Snowflake (account-based), so this is only a nominal default.
	defaultPort: 443,
	// Unquoted Snowflake identifiers are folded to UPPERCASE in the catalog (INFORMATION_SCHEMA).
	foldsIdentifierCase: 'upper',
	formatterLanguage: 'snowflake',
	// Each DDL statement auto-commits (Snowflake commits the current transaction around DDL), so a
	// migration can't roll back as a unit — not transactional, like MySQL/Oracle/Db2.
	isTransactionalDdl: false,
	autoIncrement: { label: 'AUTOINCREMENT', clause: 'AUTOINCREMENT', placement: 'after-type', allowsNullability: true },
	quoteIdent: doubleQuote,
	// Snowflake has a native BOOLEAN type.
	booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
	paginatedSelect: limitOffsetSelect,
	hasLimit: (trimmed) => /\blimit\s+\d/i.test(trimmed),
	limitClause: (trimmed, n) => `${trimmed}\nLIMIT ${n}`,
	windowClause: limitOffsetWindow,
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} LIMIT 1`,
	// ACCOUNT_USAGE has longer retention but lags ~45 min; INFORMATION_SCHEMA.QUERY_HISTORY is
	// near-real-time, so use it over a fixed 24h window. total_elapsed_time is already milliseconds.
	// ROWS is reserved → quoted alias. Needs MONITOR/privilege to see other users' history.
	workloadDigest: (topN) => `SELECT query_text, COUNT(*) AS calls,
       ROUND(SUM(total_elapsed_time), 1) AS total_ms,
       ROUND(AVG(total_elapsed_time), 1) AS mean_ms, SUM(rows_produced) AS "rows"
FROM TABLE(information_schema.query_history(dateadd('hours', -24, current_timestamp()), current_timestamp()))
WHERE query_text IS NOT NULL
GROUP BY query_text ORDER BY total_ms DESC LIMIT ${topRows(topN)}`,
	optimizationHints: [
		"- Snowflake has no traditional indexes; speed comes from pruning micro-partitions. Open the Query Profile and check \"Partitions scanned\" vs \"Partitions total\" — poor pruning is the usual cause.",
		"- Filter and join on a well-clustered column (often a date/event key) so partitions can be pruned; for a recurring heavy pattern, set a clustering key or build a materialized view.",
		"- It's a columnar store: select only the columns you need (avoid SELECT *) to cut scanned bytes.",
		"- Avoid wrapping the pruning column in a function in the WHERE clause, which defeats pruning.",
		"- A spilling join (\"bytes spilled to local/remote storage\" in the profile) means the warehouse is undersized for that query or the join is exploding rows.",
	].join('\n'),
};

const REDSHIFT_DIALECT: Dialect = {
	driverId: 'redshift',
	readOnly: REDSHIFT_READ_ONLY,
	displayName: 'Amazon Redshift',
	aiDisplayName: 'Amazon Redshift',
	defaultPort: 5439,
	// Redshift is a Postgres fork: unquoted identifiers are folded to lowercase in the catalog.
	foldsIdentifierCase: 'lower',
	formatterLanguage: 'redshift',
	// Redshift runs DDL inside a transaction block (a migration rolls back as a unit), like its
	// Postgres ancestor. A few statements can't (CREATE DATABASE, VACUUM, ALTER TABLE APPEND); those
	// are outside what schema sync emits.
	isTransactionalDdl: true,
	autoIncrement: { label: 'IDENTITY', clause: 'IDENTITY(1,1)', placement: 'after-type', allowsNullability: true },
	quoteIdent: doubleQuote,
	booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
	paginatedSelect: limitOffsetSelect,
	hasLimit: (trimmed) => /\blimit\s+\d/i.test(trimmed),
	limitClause: (trimmed, n) => `${trimmed}\nLIMIT ${n}`,
	windowClause: limitOffsetWindow,
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} LIMIT 1`,
	// SYS_QUERY_HISTORY is the modern, always-on query log (Redshift Serverless + RA3 provisioned);
	// it needs no extension, unlike Postgres's pg_stat_statements. elapsed_time is microseconds.
	// `rows` is a reserved word, so the alias is double-quoted. Older DC2 clusters without the SYS_*
	// views raise "relation … does not exist", relayed so the user can see why.
	workloadDigest: (topN) => `SELECT query_text, COUNT(*) AS calls,
       ROUND(SUM(elapsed_time) / 1000.0, 1) AS total_ms,
       ROUND(AVG(elapsed_time) / 1000.0, 1) AS mean_ms, SUM(returned_rows) AS "rows"
FROM sys_query_history
WHERE query_text IS NOT NULL AND start_time > dateadd(hour, -24, getdate())
GROUP BY query_text
ORDER BY total_ms DESC
LIMIT ${topRows(topN)}`,
	// Redshift's EXPLAIN has no JSON format (only the plain text plan), so the plan advisor no-ops
	// here — explainJson is deliberately absent rather than emitting Postgres syntax it rejects.
	optimizationHints: [
		"- Redshift has no secondary indexes. The levers are the sort key (which columns a scan can skip on) and the distribution key (which joins avoid a network redistribution).",
		"- Read the plan with EXPLAIN and look for DS_BCAST_INNER or DS_DIST_BOTH — that's the whole table moving across nodes; co-locate the join by giving both tables the same DISTKEY, or make the small one DISTSTYLE ALL.",
		"- Filter on the sort key (usually a date/timestamp) so whole blocks are skipped; wrapping it in a function defeats zone-map pruning.",
		"- Check SVV_TABLE_INFO for stats_off and unsorted; run ANALYZE for stale statistics and VACUUM when the table is heavily unsorted.",
		"- It's a columnar store: select only the columns you need (never SELECT *), and prefer a compressed (ENCODE) column layout, which COPY sets automatically.",
	].join('\n'),
};

/**
 * Where a ClickHouse statement's trailing `SETTINGS a = 1` or `FORMAT CSV` begins, at the top level,
 * or the statement's length when it has neither. A LIMIT has to go BEFORE that tail: after it is a
 * syntax error. Strings, comments and subqueries are masked out, so a SETTINGS inside a subquery or
 * a column that happens to be called `settings` is not mistaken for it.
 */
function clickhouseTailStart(sql: string): number {
	const at = topLevelMatch(sql, /\bSETTINGS\s+[A-Za-z_]\w*\s*=|\bFORMAT\s+[A-Za-z]\w*\s*$/gi);
	return at < 0 ? sql.length : at;
}

/** `{id:UInt32}`, `{ids:Array(UInt32)}`, `{m:Map(String, UInt8)}`, `{t:Identifier}`. */
const CLICKHOUSE_PARAMETER = /\{\s*([A-Za-z_]\w*)\s*:\s*([A-Za-z_][^{}]*?)\s*\}/g;

function clickhouseQueryParameters(sql: string): QueryParameter[] {
	const { text } = maskClickHouse(sql);
	const seen = new Map<string, QueryParameter>();
	CLICKHOUSE_PARAMETER.lastIndex = 0;
	for (let hit = CLICKHOUSE_PARAMETER.exec(text); hit; hit = CLICKHOUSE_PARAMETER.exec(text)) {
		if (!seen.has(hit[1])) {
			seen.set(hit[1], { name: hit[1], type: hit[2] });
		}
	}
	return [...seen.values()];
}

/**
 * `SET param_id = '42', param_name = 'O\'Brien'`. The HTTP interface takes a parameter as
 * `param_<name>` in the URL, parsed in ClickHouse's ESCAPED text format (a backslash, tab or newline
 * written as `\\`, `\t`, `\n`), and the driver replays a `SET param_...` as exactly that on every
 * later request, the way clickhouse-client does, so a re-run, the next page and EXPLAIN all see the
 * same values. Each value is escaped for that format and then quoted as a SQL string.
 */
function clickhouseBindParameters(values: Readonly<Record<string, string>>): string {
	const assignments = Object.entries(values).map(([name, value]) => {
		const escaped = value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
		return `param_${name} = '${escaped.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
	});
	return `SET ${assignments.join(', ')}`;
}

function clickhouseInsertLimit(sql: string, limit: string): string {
	const at = clickhouseTailStart(sql);
	const tail = sql.slice(at);
	return `${sql.slice(0, at).trimEnd()}\n${limit}${tail ? `\n${tail}` : ''}`;
}

/**
 * A row cap at the top level. `LIMIT 5 BY user` is NOT one (it keeps 5 rows per user, however many
 * users there are), and a LIMIT inside a subquery does not cap the outer result either.
 */
function clickhouseHasLimit(sql: string): boolean {
	return topLevelMatch(sql, /\bLIMIT\s+\d+(?:\s*,\s*\d+)?(?:\s+OFFSET\s+\d+)?(?![\d,])(?!\s+BY\b)/gi) >= 0;
}

/**
 * The comment every read the APP makes of a ClickHouse server's own state starts with (the
 * Operations panel, a query's progress), so views of what the server has been doing can leave the
 * app's looking out: a panel refreshing every few seconds otherwise tops every workload ranking.
 */
export const CLICKHOUSE_APP_MARKER = '/* snoutdata-ops */';

/** The cluster ClickHouse Cloud puts every replica of a service in, and the one a self-managed
 *  server defines for itself. */
export const CLICKHOUSE_REPLICA_CLUSTER = 'default';

/** Bounds a read across replicas (`clusterAllReplicas` over system tables can hang, ClickHouse issue
 *  66351), and skips a replica that is down instead of failing the whole read. */
const CLICKHOUSE_FANOUT_SETTINGS = 'SETTINGS max_execution_time = 15, skip_unavailable_shards = 1';

/** `system.<table>`, or the same table on every replica when the scope reads across them. */
export function clickhouseSystemTable(table: string, scope?: ReplicaScope): string {
	return scope?.cluster ? `clusterAllReplicas('${scope.cluster}', system.${table})` : `system.${table}`;
}

/** A statement's trailing SETTINGS for the scope, with its line break, or ''. */
export function clickhouseScopeSettings(scope?: ReplicaScope): string {
	return scope?.cluster && scope.settings ? `\n${scope.settings}` : '';
}

/**
 * ClickHouse Cloud load-balances every HTTP request to any replica, and `system.processes`,
 * `system.query_log` and friends are local to the node that answers, so without this a view shows
 * one replica, a different one each refresh. The server's `default` cluster lists the replicas;
 * reading across them needs the `READ ON REMOTE` grant, and bounding the read needs a setting, which
 * a `readonly = 1` user may not send, so each is tried and what is missing is said plainly.
 */
async function clickhouseReplicaScope(run: ReplicaRunner): Promise<ReplicaScope> {
	const cluster = CLICKHOUSE_REPLICA_CLUSTER;
	let replicas: number;
	try {
		const rows = await run(`SELECT count() AS n FROM system.clusters WHERE cluster = '${cluster}'`);
		replicas = Number(rows[0]?.n ?? 0);
	} catch {
		return { replicas: 1, settings: '' };
	}
	if (!(replicas > 1)) {
		return { replicas: 1, settings: '' };
	}
	const probe = `SELECT count() AS n FROM clusterAllReplicas('${cluster}', system.one)`;
	try {
		await run(`${probe} ${CLICKHOUSE_FANOUT_SETTINGS}`);
		return { replicas, cluster, settings: CLICKHOUSE_FANOUT_SETTINGS };
	} catch {
		// Usually a readonly user refused the SETTINGS: try the read itself without them.
	}
	try {
		await run(probe);
		return { replicas, cluster, settings: '' };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			replicas,
			settings: '',
			limitation: /\bREMOTE\b|ACCESS_DENIED/.test(message)
				? `This server has ${replicas} replicas and this user may not read across them (it needs the READ ON REMOTE grant), so only the replica that answered is shown.`
				: `This server has ${replicas} replicas and reading across them failed, so only the replica that answered is shown. ${message}`,
		};
	}
}

const CLICKHOUSE_DIALECT: Dialect = {
	driverId: 'clickhouse',
	readOnly: CLICKHOUSE_READ_ONLY,
	displayName: 'ClickHouse',
	aiDisplayName: 'ClickHouse',
	// The HTTP interface, which is what the driver speaks. ClickHouse Cloud and a TLS server listen
	// on 8443; the driver picks that when SSL is on and no port was typed.
	defaultPort: 8123,
	// Identifiers are case-sensitive and stored as written.
	foldsIdentifierCase: false,
	formatterLanguage: 'clickhouse',
	isTransactionalDdl: false,
	backslashEscapes: true,
	quoteIdent: quoteClickHouseIdent,
	booleanLiteral: (value) => (value ? 'true' : 'false'),
	paginatedSelect: limitOffsetSelect,
	hasLimit: clickhouseHasLimit,
	limitClause: (trimmed, n) => clickhouseInsertLimit(trimmed, `LIMIT ${n}`),
	windowClause: (trimmed, limit, offset) => clickhouseInsertLimit(trimmed, offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`),
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} LIMIT 1`,
	nowSelect: 'SELECT now()',
	// One row, one cell of JSON, with the granules each index selected: what planAdvisor reads to say
	// whether the filter skipped any data at all.
	explainJson: (sql) => `EXPLAIN json = 1, indexes = 1 ${stripTrailingSemicolon(sql)}`,
	// The five a person asks for by name: PLAN, ESTIMATE, PIPELINE, SYNTAX, QUERY TREE.
	explainVariants: CLICKHOUSE_EXPLAIN_VARIANTS,
	// A file goes in as the statement's body, which is the whole speed difference on this engine.
	bulkFormats: CLICKHOUSE_BULK_FORMATS,
	// A file in a bucket, a page, another database: all of them a function you select FROM.
	tableFunctions: CLICKHOUSE_TABLE_FUNCTIONS,
	// system.query_log is on by default. Grouped by the normalized query hash, so the same statement
	// with different literals counts as one, the way pg_stat_statements does. Across every replica
	// when the scope says so; `is_initial_query` leaves out the legs a distributed query runs on
	// other nodes, which are the same statement counted again.
	// Ranked by time, or by what the statements READ (a columnar engine's real cost) or the most
	// memory one run held (what gets a query killed), chosen in the SQL so the top N is the top N.
	workloadDigest: (topN, scope, rankBy = 'time') => `SELECT any(query) AS query_text, count() AS calls,
       round(sum(query_duration_ms), 1) AS total_ms,
       round(avg(query_duration_ms), 1) AS mean_ms, sum(result_rows) AS \`rows\`,
       round(sum(read_bytes) / 1048576, 1) AS read_mb, round(max(memory_usage) / 1048576, 1) AS peak_memory_mb
FROM ${clickhouseSystemTable('query_log', scope)}
WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 1 DAY AND query_kind = 'Select' AND is_initial_query
  AND NOT startsWith(query, '${CLICKHOUSE_APP_MARKER}')
GROUP BY normalized_query_hash
ORDER BY ${rankBy === 'read' ? 'read_mb' : rankBy === 'memory' ? 'peak_memory_mb' : 'total_ms'} DESC
LIMIT ${topRows(topN)}${clickhouseScopeSettings(scope)}`,
	workloadRankings: ['time', 'read', 'memory'],
	// The words that make ClickHouse SQL ClickHouse. PREWHERE and FINAL are the two a newcomer
	// meets first; the rest are what a MergeTree table is written with.
	keywords: [
		'PREWHERE', 'FINAL', 'SAMPLE', 'ARRAY JOIN', 'LEFT ARRAY JOIN', 'LIMIT BY', 'WITH TOTALS',
		'WITH FILL', 'WITH CUBE', 'WITH ROLLUP', 'GLOBAL IN', 'GLOBAL NOT IN', 'ASOF JOIN',
		'ANY JOIN', 'ALL JOIN', 'SEMI JOIN', 'ANTI JOIN', 'PASTE JOIN', 'SETTINGS', 'FORMAT',
		'ENGINE', 'PARTITION BY', 'PRIMARY KEY', 'ORDER BY', 'TTL', 'CODEC', 'MATERIALIZED',
		'ALIAS', 'EPHEMERAL', 'POPULATE', 'ON CLUSTER', 'ATTACH', 'DETACH', 'OPTIMIZE', 'DEDUPLICATE',
		'SYSTEM', 'CLUSTER', 'DICTIONARY', 'PROJECTION', 'INDEX', 'GRANULARITY', 'TYPE',
	],
	typeNames: [
		'UInt8', 'UInt16', 'UInt32', 'UInt64', 'UInt128', 'UInt256', 'Int8', 'Int16', 'Int32',
		'Int64', 'Int128', 'Int256', 'Float32', 'Float64', 'BFloat16', 'Decimal', 'Decimal32',
		'Decimal64', 'Decimal128', 'Decimal256', 'String', 'FixedString', 'Date', 'Date32',
		'DateTime', 'DateTime64', 'Time', 'Time64', 'Enum8', 'Enum16', 'UUID', 'IPv4', 'IPv6',
		'Array', 'Tuple', 'Map', 'Nested', 'Nullable', 'LowCardinality', 'AggregateFunction',
		'SimpleAggregateFunction', 'Variant', 'Dynamic', 'JSON', 'Point', 'Ring', 'Polygon',
		'MultiPolygon', 'Bool', 'Nothing', 'Interval',
	],
	replicaScope: clickhouseReplicaScope,
	queryParameters: clickhouseQueryParameters,
	bindParameters: clickhouseBindParameters,
	optimizationHints: [
		"- A MergeTree table is read in granules and skipped by its ORDER BY key: filter on a PREFIX of that key (the first column first) so whole granules are skipped. A filter on a column outside the key reads every granule.",
		"- ClickHouse is columnar: name only the columns you need (never SELECT *), since each extra column is a separate read.",
		"- For a filter on a column outside the sort key, a data-skipping index (minmax, set, bloom_filter) or a projection with a different ORDER BY is the lever, not a B-tree index, which ClickHouse does not have.",
		"- In a JOIN the RIGHT side is loaded into memory: put the smaller table on the right, or pre-filter it in a subquery.",
		"- FINAL on a ReplacingMergeTree forces a merge at read time and is slow on large tables; prefer argMax(...) GROUP BY key, or filter first.",
		"- A recurring heavy aggregation is usually a materialized view into an AggregatingMergeTree rather than a faster SELECT.",
	].join('\n'),
};

const HANA_DIALECT: Dialect = {
	driverId: 'hana',
	nowSelect: 'SELECT CURRENT_TIMESTAMP FROM DUMMY',
	displayName: 'SAP HANA',
	aiDisplayName: 'SAP HANA',
	// The SQL port of a single-container/tenant database: 3<instance>15, instance 00 by default.
	// HANA Cloud listens on 443; the user overrides the port there.
	defaultPort: 30015,
	// Unquoted HANA identifiers are folded to UPPERCASE in the SYS.* catalog.
	foldsIdentifierCase: 'upper',
	// sql-formatter has no HANA dialect; its generic 'sql' language is the closest fit.
	formatterLanguage: 'sql',
	// HANA implicitly commits before and after each DDL statement, so a migration can't roll back
	// as a unit — statement-by-statement, like Oracle/Db2.
	isTransactionalDdl: false,
	autoIncrement: { label: 'IDENTITY', clause: IDENTITY_CLAUSE, placement: 'after-type', allowsNullability: false },
	quoteIdent: doubleQuote,
	// HANA has a native BOOLEAN type (TRUE/FALSE literals).
	booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
	paginatedSelect: limitOffsetSelect,
	hasLimit: (trimmed) => /\blimit\s+\d/i.test(trimmed),
	limitClause: (trimmed, n) => `${trimmed}\nLIMIT ${n}`,
	windowClause: limitOffsetWindow,
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} LIMIT 1`,
	// The SQL plan cache is HANA's always-on statement digest (needs CATALOG READ). Times are
	// microseconds. ROWS is reserved, so the alias is double-quoted.
	workloadDigest: (topN) => `SELECT STATEMENT_STRING AS query_text, EXECUTION_COUNT AS calls,
       ROUND(TOTAL_EXECUTION_TIME / 1000.0, 1) AS total_ms,
       ROUND(AVG_EXECUTION_TIME / 1000.0, 1) AS mean_ms,
       TOTAL_RESULT_RECORD_COUNT AS "rows"
FROM SYS.M_SQL_PLAN_CACHE
WHERE STATEMENT_STRING IS NOT NULL
ORDER BY TOTAL_EXECUTION_TIME DESC
LIMIT ${topRows(topN)}`,
	optimizationHints: [
		"- Read the plan with EXPLAIN PLAN FOR <statement> (then SELECT * FROM EXPLAIN_PLAN_TABLE), or the PlanViz trace, and look for a large COLUMN SEARCH feeding a join.",
		"- HANA is an in-memory column store: select only the columns you need, since each column is scanned independently and SELECT * pulls them all into memory.",
		"- Filter as early as possible so the column scan is reduced before any join; a predicate that can't be pushed down (a function over the column, a mismatched type causing an implicit cast) forces a full column scan.",
		"- Indexes matter far less than on a row store, but an inverted index on a highly selective, frequently filtered column of a large table still helps; the primary key already has one.",
		"- For a repeated aggregation, a calculation view or a UNION-pruned partitioned table beats re-scanning; check partition pruning with M_TABLE_PARTITIONS.",
		"- Check M_SQL_PLAN_CACHE for the statement's TOTAL_EXECUTION_TIME vs EXECUTION_COUNT: a high count with a small mean is a parameterization/round-trip problem, not a plan problem.",
	].join('\n'),
};

/**
 * MongoDB is a document backend, not relational, but the app still authors a connection's queries
 * in SQL (the cross-DB lingua franca) and transcribes them to an aggregation pipeline in main.
 * This dialect governs the SQL the client *generates* (grid browse, cell filters)
 * so it parses predictably for `sqlToMongo`: Postgres-style double quoting + LIMIT/OFFSET, the
 * flavour `sqlToMongo` feeds to node-sql-parser. It is never sent to a SQL engine.
 */
const MONGODB_DIALECT: Dialect = {
	driverId: 'mongodb',
	displayName: 'MongoDB',
	aiDisplayName: 'MongoDB',
	defaultPort: 27017,
	foldsIdentifierCase: false,
	formatterLanguage: 'postgresql',
	isTransactionalDdl: false,
	quoteIdent: doubleQuote,
	booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
	paginatedSelect: limitOffsetSelect,
	hasLimit: (trimmed) => /\blimit\s+\d/i.test(trimmed),
	limitClause: (trimmed, n) => `${trimmed}\nLIMIT ${n}`,
	windowClause: limitOffsetWindow,
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} LIMIT 1`,
};

/**
 * Pinecone is a vector backend, not relational, but (like MongoDB) the app still authors a
 * connection's queries in SQL (the cross-DB lingua franca) and transcribes them to a native vector
 * query in main: `SELECT * FROM <index> WHERE <metadata-filter> LIMIT <topK>`.
 * This dialect governs the SQL the client *generates* (grid browse, cell filters) so it parses
 * predictably for `sqlToPinecone`: Postgres-style double quoting + LIMIT/OFFSET. It is never sent to
 * a SQL engine. No real TCP port (the index host is a URL), so defaultPort 0 hides host/port hints.
 */
const PINECONE_DIALECT: Dialect = {
	driverId: 'pinecone',
	displayName: 'Pinecone',
	aiDisplayName: 'Pinecone',
	defaultPort: 0,
	foldsIdentifierCase: false,
	formatterLanguage: 'postgresql',
	isTransactionalDdl: false,
	quoteIdent: doubleQuote,
	booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
	paginatedSelect: limitOffsetSelect,
	hasLimit: (trimmed) => /\blimit\s+\d/i.test(trimmed),
	limitClause: (trimmed, n) => `${trimmed}\nLIMIT ${n}`,
	windowClause: limitOffsetWindow,
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} LIMIT 1`,
};

/**
 * The three cloud LOG services. A log scope is presented as a table and queried in SQL, which
 * `sqlToLogs` compiles to the neutral `LogsQuery` each driver renders into its own language — so,
 * exactly as for MongoDB and Pinecone, this dialect governs the SQL the CLIENT generates (grid
 * browse, cell filters) rather than anything sent to an engine. Postgres quoting because that is
 * the grammar the deterministic compilers parse.
 *
 * `defaultPort: 0` because there is no port to connect to: a telemetry connection is a cloud
 * account plus a region, and the form hides host/port on the strength of that zero, the way it
 * already does for Pinecone.
 */
function logsDialect(driverId: string, displayName: string): Dialect {
	return {
		driverId,
		displayName,
		aiDisplayName: displayName,
		defaultPort: 0,
		foldsIdentifierCase: false,
		formatterLanguage: 'postgresql',
		isTransactionalDdl: false,
		quoteIdent: doubleQuote,
		booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
		paginatedSelect: limitOffsetSelect,
		hasLimit: (trimmed) => /\blimit\s+\d/i.test(trimmed),
		limitClause: (trimmed, n) => `${trimmed}\nLIMIT ${n}`,
		windowClause: limitOffsetWindow,
		peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} LIMIT 1`,
	};
}

const CLOUDWATCH_DIALECT: Dialect = logsDialect('cloudwatch', 'Amazon CloudWatch Logs');
const AZURE_MONITOR_DIALECT: Dialect = logsDialect('azureMonitor', 'Azure Monitor Logs');
const GCP_LOGGING_DIALECT: Dialect = logsDialect('gcpLogging', 'Google Cloud Logging');

/**
 * Fallback for an unknown / undefined driver id. Reproduces the old code's `else` branch
 * (MySQL-style backtick quoting, 1/0 booleans, trailing LIMIT) so behaviour is unchanged, but
 * formats with the generic 'sql' language (matching sqlFormat's former `default`).
 */
const GENERIC_DIALECT: Dialect = {
	driverId: '',
	displayName: 'SQL',
	aiDisplayName: 'SQL',
	defaultPort: 0,
	foldsIdentifierCase: false,
	formatterLanguage: 'sql',
	isTransactionalDdl: false,
	quoteIdent: backtickQuote,
	booleanLiteral: (value) => (value ? '1' : '0'),
	paginatedSelect: limitOffsetSelect,
	hasLimit: (trimmed) => /\blimit\s+\d/i.test(trimmed),
	limitClause: (trimmed, n) => `${trimmed}\nLIMIT ${n}`,
	windowClause: limitOffsetWindow,
	peekOne: (cols, fromAndWhere) => `SELECT ${cols} FROM ${fromAndWhere} LIMIT 1`,
	// Unknown vendor: no portable runtime-statistics view, so the Workload advisor is unavailable.
	workloadDigest: () => null,
};

const DIALECTS: Record<string, Dialect> = {
	[MYSQL_DIALECT.driverId]: MYSQL_DIALECT,
	[MARIADB_DIALECT.driverId]: MARIADB_DIALECT,
	[POSTGRES_DIALECT.driverId]: POSTGRES_DIALECT,
	[SQLSERVER_DIALECT.driverId]: SQLSERVER_DIALECT,
	[ORACLE_DIALECT.driverId]: ORACLE_DIALECT,
	[DB2_DIALECT.driverId]: DB2_DIALECT,
	[SQLITE_DIALECT.driverId]: SQLITE_DIALECT,
	[DUCKDB_DIALECT.driverId]: DUCKDB_DIALECT,
	[SNOWFLAKE_DIALECT.driverId]: SNOWFLAKE_DIALECT,
	[REDSHIFT_DIALECT.driverId]: REDSHIFT_DIALECT,
	[HANA_DIALECT.driverId]: HANA_DIALECT,
	[CLICKHOUSE_DIALECT.driverId]: CLICKHOUSE_DIALECT,
	[MONGODB_DIALECT.driverId]: MONGODB_DIALECT,
	[PINECONE_DIALECT.driverId]: PINECONE_DIALECT,
	[CLOUDWATCH_DIALECT.driverId]: CLOUDWATCH_DIALECT,
	[AZURE_MONITOR_DIALECT.driverId]: AZURE_MONITOR_DIALECT,
	[GCP_LOGGING_DIALECT.driverId]: GCP_LOGGING_DIALECT,
};

/** Resolve the dialect for a driver id, falling back to {@link GENERIC_DIALECT} for unknowns. */
export function dialectFor(driverId: string | undefined): Dialect {
	return (driverId && DIALECTS[driverId]) || GENERIC_DIALECT;
}

/**
 * How a read-only run on this driver is enforced by the database itself, or that it is not
 * (`mechanism: 'none'`, the lexical guard alone). Drivers apply `begin`/`end`; the UI and the agent
 * broker show `summary`, so what is claimed is what the engine does.
 */
export function readOnlyEnforcement(driverId: string | undefined): ReadOnlyEnforcement {
	const dialect = dialectFor(driverId);
	return dialect.readOnly ?? lexicalOnly(dialect.displayName);
}

/** The dialects of the shipped drivers, in connection-form order (excludes the generic fallback). */
export function listDialects(): Dialect[] {
	return [MYSQL_DIALECT, MARIADB_DIALECT, POSTGRES_DIALECT, SQLSERVER_DIALECT, ORACLE_DIALECT, DB2_DIALECT, SQLITE_DIALECT, DUCKDB_DIALECT, SNOWFLAKE_DIALECT, REDSHIFT_DIALECT, HANA_DIALECT, CLICKHOUSE_DIALECT, MONGODB_DIALECT, PINECONE_DIALECT, CLOUDWATCH_DIALECT, AZURE_MONITOR_DIALECT, GCP_LOGGING_DIALECT];
}

/**
 * A generated column's clause, with its kind ALWAYS spelled out. Postgres 18 made `VIRTUAL` the
 * default when the kind is left off, so a bare `GENERATED ALWAYS AS (e)` replayed onto 18 would
 * quietly turn a stored column into a computed-on-read one (and refuse it wherever a virtual
 * column is not allowed: an index, a foreign key). `VIRTUAL` itself needs Postgres 18.
 */
export function generatedColumnClause(generated: { expression: string; kind: 'stored' | 'virtual' }): string {
	return `GENERATED ALWAYS AS (${generated.expression}) ${generated.kind === 'virtual' ? 'VIRTUAL' : 'STORED'}`;
}

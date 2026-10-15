/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Schema model produced by driver introspection and consumed by the completion
// engine. Carries PK and FK information from day one so phase (d) (alias
// propagation, FK-derived JOIN suggestions) has the data it needs.

export interface ColumnInfo {
	name: string;
	dataType: string;
	nullable: boolean;
	isPrimaryKey: boolean;
	/** Default as a SQL EXPRESSION, ready to paste after `DEFAULT` — `'N'` (quoted string
	 *  literal), `0`, `CURRENT_TIMESTAMP`, `nextval('s'::regclass)`. Drivers whose catalog
	 *  reports a bare literal instead (MySQL's `COLUMN_DEFAULT` returns `N`, not `'N'`) must
	 *  normalise before setting it, or the generated DDL won't run. */
	default?: string | null;
	comment?: string;
	/** Server-generated on insert — MySQL `EXTRA` contains `auto_increment`, SQL Server
	 *  `is_identity`, Postgres a `nextval(...)` default. Needed for a runnable CREATE TABLE. */
	autoIncrement?: boolean;
	/** The database fills this column and REFUSES a value for it: Postgres `GENERATED ALWAYS AS
	 *  IDENTITY` or a generated (computed) column. An insert or update that names it fails, so a
	 *  generated type says `never` there. Absent means a value may be given. */
	generatedAlways?: boolean;
	/** A generated (computed) column's expression and how it is kept: `stored` is written on every
	 *  insert/update, `virtual` (Postgres 18+) is computed on read. DDL must always spell the kind
	 *  out, because Postgres 18 made VIRTUAL the default when it is left off. Postgres only. */
	generatedAs?: { expression: string; kind: 'stored' | 'virtual' };
	/** For document (MongoDB) collections: `true` when this column is a NESTED field projected from
	 *  document structure — a dotted/bracketed path (`address.city`, `items[].sku`) rather than a
	 *  literal top-level key. Additive + optional: relational drivers never
	 *  set it, and consumers that don't care (the AI schema prompt, completion) treat the dotted
	 *  `name` as the field identifier. The grid/explorer can use it to tell a projected nested path
	 *  from a literal top-level key that happens to contain a dot. */
	nested?: boolean;
	/** Where the column sits in a ClickHouse table's key: `'primary'` when it is in the PRIMARY KEY,
	 *  the sparse index a filter skips granules by; `'sort'` when it is only in the ORDER BY after it.
	 *  Never a uniqueness key, which is why it is not {@link isPrimaryKey}. */
	sortKey?: 'primary' | 'sort';
	/** The column's compression codec, when it names one (ClickHouse `CODEC(Delta, ZSTD(3))`). */
	codec?: string;
	/** The column's data on disk, compressed and as it would be raw (columnar engines). */
	storedBytes?: { compressed: number; uncompressed: number };
	/**
	 * Paths INSIDE this column that can be selected on their own, for a type whose parts are not in
	 * the type itself: a ClickHouse `JSON` column, whose paths live in the data
	 * (`payload.user.id`). Read by sampling, so it is what the sample held and never a promise
	 * about every row; absent for every other column, whose parts the declared type already names
	 * (a `Tuple`'s fields, a `Map`'s `keys`/`values`) and which are worked out without a query.
	 */
	dynamicPaths?: { name: string; dataType?: string }[];
}

export interface ForeignKeyInfo {
	constraintName: string;
	columns: string[];
	referencedTable: string;
	referencedColumns: string[];
}

export interface IndexInfo {
	name: string;
	/** Indexed columns, in key order. */
	columns: string[];
	unique: boolean;
	/** How the index is built, where that is more than "a B-tree on these columns": a ClickHouse
	 *  data-skipping index's `TYPE ... GRANULARITY n`, whose single "column" is an expression. */
	method?: string;
}

export interface TriggerInfo {
	name: string;
	/** When it fires (BEFORE, AFTER, INSTEAD OF). */
	timing: string;
	/** Event(s) it fires on (INSERT, UPDATE, DELETE, TRUNCATE — joined when multiple). */
	event: string;
	/** Trigger body / full definition — what the Table Properties pane renders so the
	 *  user can read the code. MySQL: `ACTION_STATEMENT`. Postgres: `pg_get_triggerdef`. */
	statement?: string;
}

/** One input parameter of a stored routine, in declaration order. */
export interface RoutineParam {
	/** Parameter name (may be empty for an unnamed/positional param). */
	name: string;
	/** Declared SQL type, e.g. `int`, `varchar(100)`. */
	dataType: string;
	/** Mode — `IN` / `OUT` / `INOUT` (MySQL) or `IN`/`INOUT`/`VARIADIC` (Postgres). */
	mode?: string;
}

/** A stored routine — a procedure (no return) or function (returns a value). */
export interface RoutineInfo {
	name: string;
	/** Owning schema/database. */
	schema: string;
	kind: 'procedure' | 'function';
	/** Return type (functions only). */
	returnType?: string;
	/** Implementation language (e.g. `SQL`, `PLPGSQL`). */
	language?: string;
	/** Input parameters, in order. `undefined` = not introspected; `[]` = takes none. Used to
	 *  render a real call signature (e.g. for the AI prompt). */
	parameters?: RoutineParam[];
	/** Full routine body / definition — what the object-detail view renders so the user can
	 *  read the code. MySQL: a reconstructed CREATE from `ROUTINE_DEFINITION`. Postgres:
	 *  `pg_get_functiondef`. SQL Server: `OBJECT_DEFINITION`. */
	definition?: string;
}

/** Cheap, approximate per-table statistics from the catalog (not an exact COUNT). */
export interface TableStats {
	/** Approximate row count. */
	rowCount?: number;
	/** Approximate data size in bytes (excludes indexes). */
	dataBytes?: number;
	/** Approximate total index size in bytes. */
	indexBytes?: number;
	/** Approximate total size (data + indexes + toast) in bytes. Postgres-only. */
	totalBytes?: number;
	/** Average row length in bytes — MySQL `AVG_ROW_LENGTH`. */
	avgRowBytes?: number;
	/** Unused/free bytes inside the data file — MySQL `DATA_FREE`. */
	dataFreeBytes?: number;
	/** Next auto-increment value — MySQL `AUTO_INCREMENT`. */
	autoIncrement?: number;
	/** Storage engine — MySQL `ENGINE` (e.g. `InnoDB`). */
	engine?: string;
	/** Default collation — MySQL `TABLE_COLLATION`. */
	collation?: string;
	/** Table creation time (epoch ms). MySQL `CREATE_TIME`. */
	createdAt?: number;
	/** Last data-modification time (epoch ms). MySQL `UPDATE_TIME`. */
	updatedAt?: number;
	/** Live tuple estimate — Postgres `pg_stat_user_tables.n_live_tup`. */
	liveTuples?: number;
	/** Dead tuple estimate (vacuum candidates) — Postgres `n_dead_tup`. */
	deadTuples?: number;
	/** Sequential scans against the table — Postgres `seq_scan`. */
	seqScan?: number;
	/** Index scans against the table — Postgres `idx_scan`. */
	idxScan?: number;
	/** Last manual VACUUM (epoch ms). */
	lastVacuum?: number;
	/** Last autovacuum (epoch ms). */
	lastAutovacuum?: number;
	/** Last manual ANALYZE (epoch ms). */
	lastAnalyze?: number;
	/** Last autoanalyze (epoch ms). */
	lastAutoanalyze?: number;
}

/** One object named by another: the database it lives in and its name. */
export interface SchemaRef {
	schema: string;
	name: string;
}

/**
 * How an object is wired to other objects, where the wiring is not a foreign key.
 *
 * ClickHouse only, and it is ClickHouse's ONLY lineage: the engine has no foreign keys, so a
 * materialized view is the whole of what connects two tables. A materialized view is an insert
 * trigger: a row written to a source table runs the view's SELECT and the result lands in the
 * view's target. The explorer draws both ends, because someone looking at a table needs to know
 * that writing to it also writes somewhere else.
 */
export interface ObjectLineage {
	/** Tables whose inserts fire this view. The server's own `dependencies_*`, read the other way
	 *  round; empty on a refreshable view, which is not an insert trigger. */
	readsFrom?: SchemaRef[];
	/** Where the view's rows land: its `TO db.t` target. Absent when the view owns the inner
	 *  table the server made for it, which has no name worth showing. */
	writesTo?: SchemaRef;
	/** Materialized views that fire when a row is inserted into THIS table. */
	feeds?: SchemaRef[];
	/** Materialized views that write INTO this table (its `TO` target). The other half of
	 *  {@link writesTo}, and the answer to "where do these rows come from": nobody inserts into a
	 *  view's target by hand, so without it the table looks like it fills itself. */
	writtenBy?: SchemaRef[];
	/** The view re-runs on a schedule (`REFRESH EVERY`) instead of firing on insert. The server
	 *  records no sources for one, so {@link readsFrom} is empty and that is not a gap. */
	refreshable?: boolean;
}

/** A dictionary's structure: what it is keyed by and how it is stored. Runtime state (loaded or
 *  failing, how many elements, the last error) is deliberately NOT here — a cached schema would
 *  report it hours stale. That lives in the Operations panel, which reads it when it is asked. */
export interface DictionaryInfo {
	/** The key columns, in order. `dictGet` takes these, and a composite key takes a tuple. */
	keyColumns: string[];
	/** The attributes it can return, with their declared types. */
	attributes: { name: string; dataType: string }[];
	/** How it is held in memory: `HASHED`, `COMPLEX_KEY_HASHED`, `FLAT`, `DIRECT`, … */
	layout?: string;
	/** What it is loaded FROM, by kind only (`CLICKHOUSE`, `MYSQL`, `HTTP`, `FILE`, …). The
	 *  connection details are not carried: a dictionary's SOURCE clause holds credentials. */
	sourceKind?: string;
}

/**
 * What a SnoutTime partition is doing to its rows. `live` is plain
 * heap taking writes; `sealed` is rewritten into the column store; `tiered` is a column store
 * whose row groups live in S3. `default` catches rows outside every range, `foreign` is a
 * partition SnoutTime did not make, and `spread` is one hash-split by a space key.
 */
export type SeriesPartitionState = 'live' | 'sealed' | 'tiered' | 'default' | 'foreign' | 'spread';

/** One partition of a series table, from `snouttime.partition_info`: planner estimates, no scan. */
export interface SeriesPartition {
	schema?: string;
	name: string;
	state: SeriesPartitionState;
	/** The range it holds, as the database prints it (a timestamp, or an integer key). */
	rangeStart?: string;
	rangeEnd?: string;
	estimatedRows?: number;
	/** What it takes now, indexes included. */
	bytes?: number;
	/** What it took as heap just before it was sealed; absent unless sealed, and on an extension
	 *  built before this was recorded. With {@link bytes} it is what the seal saved. */
	bytesBefore?: number;
}

/**
 * A SnoutTime series table: a partitioned table SnoutTime manages by time. Carried on the
 * PARENT; its partitions are still their own {@link TableInfo}s, marked with
 * {@link TableInfo.partitionOf}, so everything that lists tables can fold them under it.
 */
export interface SeriesInfo {
	timeColumn: string;
	timeType: string;
	/** `1 day`, or an integer width. */
	partitionSize: string;
	spaceColumn?: string;
	spacePartitions?: number;
	/** How long rows are kept; absent when forever. */
	retention?: string;
	estimatedRows?: number;
	/** The whole tree, indexes included. */
	bytes?: number;
	/** The sealed partitions now, and what they took as heap: the compression, when both are set. */
	sealedBytes?: number;
	sealedBytesBefore?: number;
	partitions: SeriesPartition[];
	/** Rollups over it, finest bucket first: a query that aggregates by time should read one. */
	rollups: SeriesRollupRef[];
}

/** A rollup named from its source: where it is and how wide its buckets are. */
export interface SeriesRollupRef extends SchemaRef {
	/** `1 hour`, or an integer width. */
	bucket: string;
}

/** A SnoutTime rollup: a view of materialized buckets plus the raw rows past its watermark. */
export interface RollupInfo {
	source: SchemaRef;
	bucket: string;
}

export interface TableInfo {
	name: string;
	/** Schema/database the table belongs to. */
	schema?: string;
	/** `'collection'` is a MongoDB collection — schema-inferred from sampled documents, not a
	 *  declared relational table. `'index'` is a Pinecone vector index exposed as a
	 *  pseudo-table (columns: id, score, values, + sampled metadata fields). The explorer/grid treat
	 *  both like a table. `'logGroup'` is a cloud log SCOPE (a CloudWatch log group, an Azure Monitor
	 *  table, a GCP log) exposed as a pseudo-table: fixed columns for the event contract plus
		 *  whatever parsed fields the provider has seen. It is read-only.
	 *  `'dictionary'` is a ClickHouse dictionary: an in-memory lookup whose rows come from its
	 *  SOURCE, so nothing writes to it and it has no parts, no storage tab and no sink. */
	kind: 'table' | 'view' | 'collection' | 'index' | 'logGroup' | 'dictionary';
	/** View body — the SELECT a view is defined by (views only; undefined for base tables).
	 *  Captured so schema-sync can recreate/replace a view. MySQL: `VIEWS.VIEW_DEFINITION`.
	 *  Postgres: `pg_get_viewdef`. SQL Server: `OBJECT_DEFINITION`. */
	definition?: string;
	columns: ColumnInfo[];
	primaryKey: string[];
	/** The primary-key CONSTRAINT's own name, when the driver reports it. Needed to DROP or
	 *  replace the key: Postgres, SQL Server, Oracle and Db2 all drop a key by constraint name,
	 *  and the conventional guess (`<table>_pkey`, `PK_<table>`) is wrong for any table whose key
	 *  was named by hand. Absent where the name is fixed or meaningless (MySQL always calls it
	 *  PRIMARY and drops it with DROP PRIMARY KEY), and on drivers that don't report it yet — in
	 *  which case the DDL falls back to that same convention. */
	primaryKeyName?: string;
	foreignKeys: ForeignKeyInfo[];
	/** Secondary indexes (the PRIMARY/PK index is excluded — it's in {@link primaryKey}). */
	indexes?: IndexInfo[];
	/** Triggers defined on the table (rendered under the table in the schema tree). */
	triggers?: TriggerInfo[];
	/** Catalog stats (approximate row count + sizes), shown in the explorer. */
	stats?: TableStats;
	comment?: string;
	/** What the engine calls this view, where `'view'` alone loses the difference that matters:
	 *  a ClickHouse `MaterializedView` is an insert trigger with a table behind it, a `View` is a
	 *  stored SELECT, and a `LiveView`/`WindowView` is neither. Views only. */
	viewEngine?: string;
	/** How this object is wired to others, where that is not a foreign key (ClickHouse
	 *  materialized views). Absent on every engine that has real foreign keys. */
	lineage?: ObjectLineage;
	/** What a `'dictionary'` is keyed by and how it is stored. Dictionaries only. */
	dictionary?: DictionaryInfo;
	/** The engine's own CREATE statement, where rebuilding one from columns and keys would lose what
	 *  the table IS: a ClickHouse table's ENGINE, ORDER BY, PARTITION BY, TTL and SETTINGS. The DDL
	 *  view shows it and schema sync copies it; absent everywhere else. */
	createStatement?: string;
	/** A Postgres partition: the table it is attached to. The explorer and the AI prompt fold it
	 *  under that parent rather than listing it as a table of its own. */
	partitionOf?: SchemaRef;
	/** A SnoutTime series table: its shape, partitions and rollups. Parents only. */
	series?: SeriesInfo;
	/** A SnoutTime rollup (a view): what it summarises, and by what bucket. */
	rollup?: RollupInfo;
	/** The table SnoutTime keeps a rollup's materialized buckets in: the rollup view it backs.
	 *  Bookkeeping, read through the view, so the explorer and the prompt leave it out. */
	rollupStoreOf?: SchemaRef;
}

export interface DatabaseSchema {
	database: string;
	tables: TableInfo[];
	/** Stored procedures and functions, grouped by their owning schema in the explorer. */
	routines?: RoutineInfo[];
	/**
	 * Schemas the explorer must show even when they hold nothing.
	 *
	 * The tree is built by grouping TABLES by their schema, so a schema with no objects has
	 * nothing to group and never appears. On an empty database that means no schemas at all,
	 * and therefore nowhere to create the first table: the one place a new user needs to see
	 * is the only place that is missing. Postgres reports `public` here.
	 *
	 * Deliberately not "every schema the user has USAGE on". On a hosted project that is six
	 * of them (auth, extensions, graphql, graphql_public, public, storage), and filling the
	 * tree with schemas somebody else's services own is a worse answer than the bug.
	 */
	emptySchemas?: string[];
	/** The SnoutTime extension, when it is installed in this database. Whether the designer offers
	 *  "make this a series table", and nothing else: series tables carry their own facts. */
	snouttime?: { version: string };
	/** SnoutTime is not installed here but the server carries it, so the designer can offer to
	 *  switch it on (`create extension`) instead of leaving that to SQL. */
	snouttimeAvailable?: boolean;
	/** Postgres `server_version_num` (180000 = 18.0), for advice that is true on one major and
	 *  wrong on another (18's skip scan). Absent on every other engine, or when it was not read. */
	serverVersionNum?: number;
	/** Epoch ms of introspection, for cache staleness checks. */
	fetchedAt: number;
}

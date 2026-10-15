/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the guard's lexer cannot see: a statement that READS, by every word in it, and still
// changes something because of a function it calls. `SELECT pg_terminate_backend(pid) FROM
// pg_stat_activity` is a SELECT; so is `SELECT dblink_exec('...', 'DELETE FROM t')`. A lexical
// read-only check alone would let "Always allow" run them with no question.
//
// Two answers, for two gates:
//
// - `writingCall`: a call to a function known to change state (end a session, write a file, run
//   SQL on another server, move a sequence) or acts outside the database (an HTTP request, a
//   Lambda invocation, an export to object storage, an email, a background worker with its own
//   transaction), any Snowflake SYSTEM$ function not known to only report, and a sequence advanced
//   by `NEXT VALUE FOR` or `.NEXTVAL`. The read-only gates REFUSE these: they are writes, or effects
//   no READ ONLY transaction can take back.
// - `uncheckedCall`: any call that is not a known-pure built-in. "Always allow" runs a read with
//   no question only when every function it calls is on that list, since a user-defined function
//   can do anything at all. A miss costs a prompt, never a refusal.
//
// Both read the guard's blanked text, so a name inside a comment is not a call. Names are matched with every quoted identifier read as the bare name it holds (`guardNamedStatements`),
// so `"SEQ1"."NEXTVAL"`, `"UTL_HTTP".REQUEST(...)` and `"aws_s3".anything(...)` are what they would
// be unquoted: an outside review (2026-10-14) found the sequence and SYSTEM$ checks blind to them.
// A call through a quoted name nobody knows (`"my_fn"(1)`) still counts as both, and so does a
// function named by Snowflake's IDENTIFIER(...) or TABLE(...), whose name is a string or a variable.
//
// A STRING is not blind to `writingCall` either, because some functions run the SQL they are handed
// as one: `ts_stat('select ... dblink_exec(...)')`, `DBMS_XMLGEN.getxml('select utl_http.request(...)
// from dual')`, Db2's `XMLQUERY('db2-fn:sqlquery("...")')`. Two rules, found missing by the same review.
// The known runners are refused by name (WRITING, QUERY_RUNNING); and in a read, a call
// `writingCall` refuses is refused when it is written inside any string too, read with its doubled
// quotes and escapes undone, so the next runner nobody has listed is covered. Only a call's shape is
// matched there, never a bare word: `'call dblink later'` is a read and `'dblink_exec('` is not.
//
// What this enforces is lexical: the guard's lexer plus these lists. A read that passes is then sent
// to the database read-only (`dialect/readOnly.ts`), so on an engine with a read-only mode a function
// missing from WRITING that writes is refused there; on one without, it is caught only by the prompt
// `uncheckedCall` raises.

import { guardLiterals, guardNamedStatements, guardStatements, serverFileCall } from './sqlGuard';

/**
 * Functions that change state, or act outside the database, when a SELECT calls them. Lowercase;
 * `*` ends a prefix. A name with a dot is matched against the call's schema-qualified name (its
 * last two parts), so `pkg.*` would be every function in that schema; one without is matched
 * against the bare name, whatever schema it was called through. A whole schema of functions that
 * act outside the database is CLOUD_SCHEMA's, not a list of its names.
 */
const WRITING = [
	// Postgres: sessions, server state, files, sequences, configuration, large objects, other servers.
	'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile', 'pg_promote',
	'pg_switch_wal', 'pg_create_restore_point', 'pg_create_*', 'pg_drop_replication_slot', 'pg_replication_origin_*',
	'pg_stat_reset*', 'pg_logical_emit_message', 'pg_file_write', 'pg_file_unlink', 'pg_file_rename', 'pg_file_sync',
	'pg_advisory_*', 'pg_try_advisory_*', 'pg_import_system_collations', 'pg_wal_replay_*', 'pg_log_backend_memory_contexts',
	'set_config', 'setval', 'nextval', 'lo_*', 'dblink*', 'query_to_xml*', 'cursor_to_xml*', 'txid_current', 'pg_current_xact_id',
	// Postgres: statistics an operator keeps (a reset throws away what a slow-query review reads),
	// buffers, replication slots (a `get` consumes the changes it returns), backups, notifications.
	'pg_stat_statements_reset', 'pg_stat_monitor_reset', 'pg_stat_kcache_reset', 'pg_qualstats_reset',
	'pg_wait_sampling_reset_profile', 'pg_buffercache_evict*', 'pg_prewarm', 'pg_logical_slot_get_*',
	'pg_replication_slot_advance', 'pg_copy_physical_replication_slot', 'pg_copy_logical_replication_slot', 'pg_sync_replication_slots', 'pg_backup_start',
	'pg_backup_stop', 'pg_start_backup', 'pg_stop_backup', 'pg_notify', 'pg_truncate_visibility_map',
	// The server's files and directories, as families (`sqlGuard.ts` SERVER_FILE refuses them first).
	'pg_read_*', 'pg_ls_*', 'pg_stat_file',
	// Postgres: effects that land OUTSIDE the database, which a READ ONLY transaction does not stop.
	// Every function in a cloud-integration schema is refused by CLOUD_SCHEMA below; these are the
	// same calls written without their schema, through a search_path. pgsql-http (`http_get`,
	// `http(...)`), Db2's HTTP functions (`HTTPGETCLOB`, `HTTPPOSTBLOB`, `SOAPHTTPNV`) by family,
	// RDS/Aurora's Lambda and S3 extensions, Azure's blob storage, AlloyDB's model calls, and
	// pg_background, whose worker runs its own read-write transaction. dblink and pg_notify are above.
	'http', 'http_get', 'http_post', 'http_put', 'http_patch', 'http_delete', 'http_head',
	'httpget*', 'httppost*', 'httpput*', 'httpdelete*', 'httphead*', 'httpclob*', 'httpblob*', 'soaphttp*',
	'invoke', 'query_export_to_s3', 'table_import_from_s3',
	'blob_put', 'blob_delete', 'pg_background*', 'ml_predict_row', 'embedding',
	// Db2's WebSphere MQ functions: a send, a publish or a (subscription to a) queue on another
	// server, and MQRECEIVE takes the message off the queue for good. `DB2MQ*.` is CLOUD_SCHEMA's.
	'mqsend', 'mqpublish', 'mqsubscribe', 'mqunsubscribe', 'mqreceive*', 'mqread*',
	// MySQL / MariaDB, and Aurora MySQL's Lambda calls.
	'get_lock', 'release_lock', 'release_all_locks', 'sys_exec', 'sys_eval', 'lambda_sync', 'lambda_async',
	// SQL Server. Mail, OLE automation and a linked server are reached by EXEC, or OPENQUERY and its
	// kin, which the statement check refuses on their own; the names are here for a call with a
	// parenthesis all the same.
	'xp_*', 'sp_send_dbmail', 'sp_oa*', 'openquery', 'openrowset', 'opendatasource',
	// Oracle packages a SELECT can reach through a function.
	'utl_http*', 'utl_tcp*', 'utl_smtp*', 'utl_mail*', 'utl_file*', 'utl_inaddr*', 'dbms_pipe*', 'dbms_lock*', 'dbms_session*',
	'dbms_scheduler*', 'dbms_sql*', 'dbms_job*', 'dbms_ldap*', 'dbms_cloud*', 'httpuritype*',
	// Functions that run the SQL they are handed as a string, whose calls the checks here would read
	// blanked: Postgres's ts_stat, tablefunc's crosstab and connectby, xml2's xpath_table, Citus's
	// run_command_on_* (on other servers, outside this transaction), Oracle's DBMS_XMLGEN and
	// DBMS_XMLQUERY, SQL Server's sp_executesql. query_to_xml, cursor_to_xml, dblink and DBMS_SQL are
	// above; ts_rewrite's query form and the rest are QUERY_RUNNING's.
	'ts_stat', 'crosstab*', 'connectby*', 'xpath_table', 'run_command_on_*', 'dbms_xmlgen*', 'dbms_xmlquery*', 'sp_executesql',
];

/**
 * Running a query that WRITING cannot name by a function alone, on the named (blanked) text: Oracle's
 * XMLType built from a cursor. Postgres's two-argument `ts_rewrite(query, 'select ...')` is checked
 * by its argument count in `writingCall`, and Db2's `db2-fn:sqlquery(...)`, which lives inside an
 * XQuery string (XMLQUERY, XMLTABLE, XMLEXISTS), by DB2_SQLQUERY on the strings.
 */
const QUERY_RUNNING: readonly [RegExp, string][] = [
	[/\bxmltype\s*(?:\.\s*createxml\s*)?\(\s*cursor\s*\(/i, 'XMLTYPE(CURSOR)'],
];

/** Db2's XQuery function that runs a fullselect, as written in the XQuery string. */
const DB2_SQLQUERY = /\bdb2-fn\s*:\s*sqlquery\s*\(/i;

/**
 * WRITING names a string may hold without running anything: a catalog spells a serial column's
 * default as `nextval('seq'::regclass)`, so a read looking for one names it, and Postgres refuses
 * nextval() and setval() in a read-only transaction whatever runs them.
 */
const STRING_EXEMPT = new Set(['nextval', 'setval']);

/** How deep strings inside strings are read; past it the flat reading of the outer one still counts. */
const STRING_DEPTH = 4;

/**
 * Schemas whose every function acts outside the database: a call qualified by one is refused
 * whatever the function is called, so the next one a vendor ships is refused without a name. Aurora
 * and RDS (`aws_lambda`, `aws_s3`, `aws_bedrock`, `aws_sagemaker`, `aws_comprehend`, `aws_commons`),
 * Azure (`azure_ai`, `azure_openai`, `azure_cognitive`, `azure_ml`, `azure_storage`), AlloyDB and
 * Cloud SQL (`google_ml`), pgai and AlloyDB AI (`ai`), pg_net (`net`), pgsql-http when it is given
 * a schema of its own (`http`), and Db2's MQ functions (`db2mq`, `db2mq1c`, ...).
 */
const CLOUD_SCHEMA = /^(?:aws_\w+|azure_\w+|google_ml\w*|ai|net|http|db2mq\w*)$/;

/**
 * Snowflake's SYSTEM$ functions are a WRITE unless they are on this list. Snowflake keeps adding
 * them, and the ones that act are not named to say so (`SYSTEM$TASK_DEPENDENTS_ENABLE` resumes a
 * task graph, `SYSTEM$GENERATE_SCIM_ACCESS_TOKEN` issues a credential, `SYSTEM$GLOBAL_ACCOUNT_SET_PARAMETER`
 * changes an account), so a deny list of the dangerous ones is always one release behind.
 *
 * Every name here is in the "Information" or "Query Information" group of Snowflake's system
 * function reference (docs.snowflake.com/en/sql-reference/functions-system, read 2026-10-14) and
 * only reports: a status, a description, an estimate, a tag, a plan. Left out on purpose even
 * though the reference files them under Information: anything that issues or reveals a credential
 * (GENERATE_SCIM_ACCESS_TOKEN, SHOW_OAUTH_CLIENT_SECRETS, DECODE_PAT, FETCH_EXTERNAL_SECRET_*),
 * persists or runs something (…_PERSIST_RESULT, EXECUTE_CATALOG_OPERATION,
 * GET_ICEBERG_TABLE_INFORMATION, which writes metadata files), logs, sets a return value, waits, or
 * reaches outside the account (VERIFY_*, VALIDATE_*). Lowercase.
 */
const SNOWFLAKE_READ_ONLY_SYSTEM = new Set([
	'system$allowlist', 'system$allowlist_privatelink', 'system$whitelist', 'system$whitelist_privatelink',
	'system$auto_refresh_status', 'system$behavior_change_bundle_status', 'system$client_version_info',
	'system$clustering_depth', 'system$clustering_information', 'system$clustering_ratio', 'system$current_user_task_name',
	'system$estimate_automatic_clustering_costs', 'system$estimate_search_optimization_costs',
	'system$external_table_pipe_status', 'system$get_classification_result', 'system$get_directory_table_status',
	'system$get_predecessor_return_value', 'system$get_privatelink_config', 'system$get_snowflake_platform_info',
	'system$get_tag', 'system$get_tag_allowed_values', 'system$get_tag_on_current_column', 'system$get_tag_on_current_table',
	'system$get_tzdb_version', 'system$internal_stages_public_access_status', 'system$is_global_data_sharing_enabled_for_account',
	'system$last_change_commit_time', 'system$pipe_status', 'system$show_active_behavior_change_bundles',
	'system$stream_get_table_timestamp', 'system$stream_has_data', 'system$tag_value_contains', 'system$typeof',
	'system$estimate_query_acceleration', 'system$explain_plan_json', 'system$explain_json_to_text', 'system$get_resultset_status',
]);

/**
 * Advancing a sequence, written without a call's parentheses: `NEXT VALUE FOR seq` (SQL Server,
 * Db2, MariaDB, HANA's standard form), Db2's `NEXTVAL FOR seq`, and `seq.NEXTVAL` (Oracle,
 * Snowflake, HANA, Db2, MariaDB's Oracle mode). A SELECT that does it moves the sequence for good,
 * and on SQL Server a rollback does not move it back. `nextval(...)`/`setval(...)` are in WRITING.
 * Matched with quoted names read bare, so `"SEQ"."NEXTVAL"` and `NEXT VALUE FOR "s"` count too.
 */
const SEQUENCE_ADVANCE: readonly [RegExp, string][] = [
	[/\bnext\s+value\s+for\b/i, 'NEXT VALUE FOR'],
	[/\bnextval\s+for\b/i, 'NEXTVAL FOR'],
	[/\.\s*nextval\b(?!\s*\()/i, 'sequence NEXTVAL'],
];

/** Functions (and keywords that take a parenthesis) a read may call and stay a read. Lowercase. */
const PURE = new Set([
	// Keywords followed by a parenthesis.
	'select', 'from', 'in', 'exists', 'any', 'all', 'some', 'as', 'values', 'over', 'filter', 'within', 'using', 'on',
	'and', 'or', 'not', 'where', 'join', 'when', 'then', 'else', 'case', 'by', 'union', 'intersect', 'except', 'minus',
	'lateral', 'rollup', 'cube', 'grouping', 'sets', 'partition', 'top', 'distinct', 'is', 'like', 'between', 'having',
	'limit', 'offset', 'fetch', 'interval', 'row', 'array', 'unnest', 'with', 'into', 'returns', 'ilike', 'escape',
	// Types written with a size: varchar(10), numeric(10, 2).
	'char', 'varchar', 'nchar', 'nvarchar', 'varchar2', 'nvarchar2', 'character', 'numeric', 'decimal', 'number', 'float',
	'double', 'real', 'int', 'integer', 'bigint', 'smallint', 'tinyint', 'bit', 'binary', 'varbinary', 'timestamp', 'time',
	'date', 'datetime', 'datetime2', 'datetimeoffset', 'text', 'json', 'jsonb', 'uuid', 'boolean', 'bool', 'string', 'bytes',
	// Casts and conditionals.
	'cast', 'try_cast', 'safe_cast', 'convert', 'try_convert', 'coalesce', 'nullif', 'ifnull', 'isnull', 'nvl', 'nvl2', 'iif',
	'if', 'decode', 'greatest', 'least', 'extract',
	// Aggregates and windows.
	'count', 'sum', 'avg', 'min', 'max', 'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp',
	'string_agg', 'array_agg', 'json_agg', 'jsonb_agg', 'json_object_agg', 'jsonb_object_agg', 'group_concat', 'listagg',
	'bool_and', 'bool_or', 'every', 'bit_and', 'bit_or', 'percentile_cont', 'percentile_disc', 'mode', 'median',
	'approx_count_distinct', 'count_big', 'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag',
	'lead', 'first_value', 'last_value', 'nth_value', 'corr', 'covar_pop', 'covar_samp', 'any_value', 'uniq', 'uniqexact',
	'argmax', 'argmin', 'quantile', 'quantiles', 'topk', 'groupuniqarray', 'grouparray',
	// Strings.
	'lower', 'upper', 'lcase', 'ucase', 'initcap', 'length', 'char_length', 'character_length', 'octet_length', 'len',
	'datalength', 'substr', 'substring', 'left', 'right', 'trim', 'ltrim', 'rtrim', 'btrim', 'replace', 'translate',
	'concat', 'concat_ws', 'position', 'strpos', 'instr', 'charindex', 'locate', 'lpad', 'rpad', 'repeat', 'reverse',
	'split_part', 'regexp_replace', 'regexp_matches', 'regexp_match', 'regexp_like', 'regexp_substr', 'regexp_instr',
	'regexp_count', 'regexp_split_to_array', 'format', 'quote_ident', 'quote_literal', 'quote_nullable', 'ascii', 'chr',
	'md5', 'sha1', 'sha2', 'sha256', 'encode', 'hex', 'unhex', 'to_hex', 'string_to_array', 'array_to_string', 'starts_with',
	'ends_with', 'contains', 'soundex', 'difference', 'stuff', 'space', 'str', 'patindex', 'collate',
	// Numbers.
	'abs', 'ceil', 'ceiling', 'floor', 'round', 'trunc', 'truncate', 'mod', 'power', 'pow', 'sqrt', 'cbrt', 'exp', 'ln',
	'log', 'log2', 'log10', 'sign', 'pi', 'div', 'width_bucket', 'random', 'rand',
	// Dates.
	'now', 'current_date', 'current_timestamp', 'localtimestamp', 'getdate', 'getutcdate', 'sysdate', 'systimestamp',
	'sysdatetime', 'date_trunc', 'date_part', 'datepart', 'datediff', 'dateadd', 'date_add', 'date_sub', 'datename',
	'date_format', 'to_char', 'to_date', 'to_number', 'to_timestamp', 'str_to_date', 'unix_timestamp', 'from_unixtime',
	'age', 'make_date', 'make_time', 'make_timestamp', 'make_interval', 'eomonth', 'last_day', 'add_months',
	'months_between', 'year', 'month', 'day', 'hour', 'minute', 'second', 'week', 'quarter', 'dayofweek', 'dayofmonth',
	'dayofyear', 'weekday', 'todate', 'todatetime', 'tostartofday', 'tostartofmonth', 'tostartofhour', 'toyyyymm',
	'datefromparts', 'timezone', 'at_timezone', 'convert_tz',
	// JSON and arrays.
	'json_extract', 'json_unquote', 'json_extract_path', 'json_extract_path_text', 'jsonb_extract_path',
	'jsonb_extract_path_text', 'json_build_object', 'jsonb_build_object', 'json_build_array', 'jsonb_build_array',
	'json_array_length', 'jsonb_array_length', 'json_array_elements', 'jsonb_array_elements', 'json_array_elements_text',
	'jsonb_array_elements_text', 'json_each', 'jsonb_each', 'json_each_text', 'jsonb_each_text', 'json_object_keys',
	'jsonb_object_keys', 'json_typeof', 'jsonb_typeof', 'json_value', 'json_query', 'json_object', 'json_array',
	'to_json', 'to_jsonb', 'row_to_json', 'jsonb_pretty', 'jsonb_path_query', 'json_contains', 'json_keys', 'openjson',
	'array_length', 'array_position', 'cardinality', 'array_upper', 'array_lower', 'array_cat', 'array_append',
	// Catalog readers an assistant asks for.
	'pg_get_viewdef', 'pg_get_functiondef', 'pg_get_indexdef', 'pg_get_constraintdef', 'pg_get_triggerdef',
	'pg_get_expr', 'pg_get_userbyid', 'pg_get_serial_sequence', 'pg_size_pretty', 'pg_total_relation_size',
	'pg_relation_size', 'pg_table_size', 'pg_indexes_size', 'pg_database_size', 'obj_description', 'col_description',
	'format_type', 'current_setting', 'version', 'current_schema', 'current_database', 'current_user', 'session_user',
	'has_table_privilege', 'has_schema_privilege', 'has_database_privilege', 'has_column_privilege', 'pg_typeof',
	'object_id', 'object_name', 'schema_name', 'db_name', 'type_name', 'col_name', 'objectproperty', 'database',
	'schema', 'user', 'dbms_metadata.get_ddl', 'get_ddl', 'sys_context', 'typeof',
]);

/** A function called in a statement: its name as checked (lowercased, schema prefix dropped, an
 *  Oracle package kept) and, when it was called through a schema or package, its last two parts. */
interface Call {
	name: string;
	qualified?: string;
	/** Where its opening parenthesis is. */
	open: number;
	/** Whether the parenthesis follows the name with nothing between them. */
	tight: boolean;
}

/** Every function called in `statement` (blanked text). */
function calls(statement: string): Call[] {
	const out: Call[] = [];
	for (const m of statement.matchAll(/([A-Za-z_][\w$#]*(?:\s*\.\s*[A-Za-z_][\w$#]*)*)(\s*)\(/g)) {
		const name = m[1].replace(/\s+/g, '').toLowerCase();
		const last = name.slice(name.lastIndexOf('.') + 1);
		const qualified = name.includes('.') ? name.split('.').slice(-2).join('.') : undefined;
		// An Oracle package call keeps its package: dbms_lock.sleep is dbms_lock's.
		out.push({
			name: qualified && /^(?:utl|dbms)_/.test(qualified) ? qualified : last,
			qualified,
			open: (m.index ?? 0) + m[0].length - 1,
			tight: m[2] === '',
		});
	}
	return out;
}

/** How many arguments the call whose parenthesis opens at `open` is given (blanked text). */
function argumentCount(statement: string, open: number): number {
	let depth = 0;
	let count = 1;
	for (let i = open; i < statement.length; i++) {
		const ch = statement[i];
		if (ch === '(') {
			depth++;
		} else if (ch === ')') {
			depth--;
			if (depth === 0) {
				break;
			}
		} else if (ch === ',' && depth === 1) {
			count++;
		}
	}
	return /^\(\s*\)/.test(statement.slice(open)) ? 0 : count;
}

/** The name `call` is refused under in a read, by WRITING, a CLOUD_SCHEMA or SYSTEM$, or undefined. */
function refusedName(call: Call): string | undefined {
	const written = writingName(call);
	if (written) {
		return written;
	}
	if (call.name.startsWith('system$') && !SNOWFLAKE_READ_ONLY_SYSTEM.has(call.name)) {
		return call.name;
	}
	return undefined;
}

/**
 * The ways `literal` (a string's raw inside) could read once something runs it: as written, with
 * its doubled quotes and C-style escapes undone (`''`, `\'`, `\x64`, `\u0064`, `\144`), and with
 * Postgres's U&'...' escapes undone (`\0064`, `\+000064`).
 */
function unquotedReadings(literal: string): string[] {
	const undoubled = literal.replace(/''/g, "'").replace(/""/g, '"').replace(/``/g, '`');
	const code = (hex: string, radix = 16): string => {
		const point = parseInt(hex, radix);
		return point <= 0x10ffff ? String.fromCodePoint(point) : '';
	};
	const cStyle = undoubled.replace(/\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([0-7]{1,3})|([\s\S]))/g,
		(_, x: string, u: string, big: string, octal: string, other: string) =>
			x ? code(x) : u ? code(u) : big ? code(big) : octal ? code(octal, 8) : other);
	const unicode = undoubled.replace(/\\(?:\+([0-9a-fA-F]{6})|([0-9a-fA-F]{4})|(\\))/g,
		(_, six: string, four: string, slash: string) => (six ? code(six) : four ? code(four) : slash));
	return [...new Set([literal, cStyle, unicode])];
}

/**
 * The first call a read refuses that is written inside a string in `sql`, at any depth, or
 * undefined. Each string is read as SQL in every way it could be (see `unquotedReadings`), both
 * flat (so a name inside a string inside it still shows) and as the guard reads a statement (so a
 * comment or a quoted name inside it does not hide one). Only a call's shape counts: a plain word
 * must touch its parenthesis (`http(`), since prose puts a space before one (`Http (beta)`); a
 * name with `_`, `$` or a schema in it is code however it is spaced.
 */
function callInString(sql: string, driver: string | undefined, depth = 0): string | undefined {
	if (depth >= STRING_DEPTH) {
		return undefined;
	}
	for (const literal of guardLiterals(sql, driver)) {
		for (const text of unquotedReadings(literal)) {
			if (!text.includes('(')) {
				continue;
			}
			if (DB2_SQLQUERY.test(text)) {
				return 'db2-fn:sqlquery';
			}
			for (const reading of [text, ...guardNamedStatements(text, driver)]) {
				for (const call of calls(reading)) {
					if (STRING_EXEMPT.has(call.name) || (!call.tight && !/[_$.]/.test(call.name))) {
						continue;
					}
					const refused = refusedName(call);
					if (refused) {
						return refused;
					}
				}
				const file = serverFileCall(reading);
				if (file) {
					return file;
				}
				for (const [pattern, name] of QUERY_RUNNING) {
					if (pattern.test(reading)) {
						return name;
					}
				}
			}
			const deeper = callInString(text, driver, depth + 1);
			if (deeper) {
				return deeper;
			}
		}
	}
	return undefined;
}

/** The name `call` is refused under when it is on WRITING or in a CLOUD_SCHEMA, or undefined. */
function writingName(call: Call): string | undefined {
	if (call.qualified && CLOUD_SCHEMA.test(call.qualified.slice(0, call.qualified.indexOf('.')))) {
		return call.qualified;
	}
	for (const pattern of WRITING) {
		if (pattern.includes('.')) {
			if (call.qualified && matches(call.qualified, pattern)) {
				return call.qualified;
			}
		} else if (matches(call.name, pattern)) {
			return call.name;
		}
	}
	return undefined;
}

/**
 * A function named by Snowflake's IDENTIFIER(...) (or TABLE(...)), called: `IDENTIFIER('SYSTEM$X')(1)`,
 * `IDENTIFIER($fn)(1)`. Its name is a string or a session variable, which the checks here cannot fully
 * judge, so a read may not call one at all; IDENTIFIER naming a table or a column is untouched.
 */
function indirectCall(statement: string): string | undefined {
	for (const m of statement.matchAll(/\b(identifier|table)\s*\(/gi)) {
		let depth = 1;
		let i = (m.index ?? 0) + m[0].length;
		while (i < statement.length && depth > 0) {
			if (statement[i] === '(') {
				depth++;
			} else if (statement[i] === ')') {
				depth--;
			}
			i++;
		}
		if (depth === 0 && /^\s*\(/.test(statement.slice(i))) {
			return `a function named by ${m[1].toUpperCase()}`;
		}
	}
	return undefined;
}

/** A name hidden by quoting, called: `"f"(...)`, `` `f`(...) ``, `[f](...)`. */
function quotedCall(statement: string): boolean {
	// `FROM [t] (NOLOCK)` is SQL Server's table hint, not a call.
	return /["`\]]\s*\((?!\s*nolock\s*\))/i.test(statement);
}

function matches(name: string, pattern: string): boolean {
	return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

/**
 * ClickHouse's table functions that read only this server's own data, or make their rows up.
 * Lowercase. `cluster` and `clusterAllReplicas` reach the other servers of a cluster the server's
 * own configuration names, never an address the query supplies.
 */
const CLICKHOUSE_LOCAL_TABLE_FUNCTIONS = new Set([
	'numbers', 'numbers_mt', 'zeros', 'zeros_mt', 'generaterandom', 'generate_series', 'generateseries', 'values', 'null',
	'view', 'viewifpermitted', 'merge', 'cluster', 'clusterallreplicas', 'dictionary', 'format', 'loop', 'mergetreeindex',
	'mergetreeprojection',
]);

/**
 * ClickHouse functions that reach outside the server, wherever they are written (inside `loop(...)`,
 * after IN, as a scalar): another server, object storage, a URL, a file, a script, a bridge.
 * Lowercase; `*` ends a prefix. The rule that does the work is the allow-list above, for a table's
 * place; this catches the known ones where no table goes.
 */
const CLICKHOUSE_REACHING = [
	'url', 'urlcluster', 'remote', 'remotesecure', 's3', 's3cluster', 'gcs', 'oss', 'cosn', 'mysql', 'postgresql',
	'mongodb', 'redis', 'jdbc', 'odbc', 'hdfs', 'hdfscluster', 'azureblobstorage*', 'file', 'filecluster', 'executable',
	'input', 'sqlite', 'hive', 'iceberg*', 'deltalake*', 'hudi*', 'paimon*', 'arrowflight', 'ytsaurus',
];

/** Words that start a clause, which decides what a comma or a name after them is. */
const CLAUSE = /^(?:select|from|join|where|prewhere|group|order|having|limit|settings|format|union|on|using|window|qualify|into|values|except|intersect)$/;

/** The calls in one blanked ClickHouse statement, each with whether it stands where a table goes. */
function clickhouseCalls(statement: string): { name: string; table: boolean }[] {
	const out: { name: string; table: boolean }[] = [];
	// One frame per open parenthesis: the clause it is in, and whether a SELECT opened in it (a
	// FROM inside `extract(DAY FROM d)` or `trim(BOTH ' ' FROM s)` is not a table's FROM).
	const frames: { clause: string; select: boolean }[] = [{ clause: '', select: true }];
	let prev = '';
	let prevPrev = '';
	for (const m of statement.matchAll(/([A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)*)|(\S)/g)) {
		const frame = frames[frames.length - 1];
		const token = (m[1] ?? m[2]).replace(/\s+/g, '').toLowerCase();
		if (m[1]) {
			if (/^\s*\(/.test(statement.slice((m.index ?? 0) + m[0].length))) {
				const table = frame.select && (
					(prev === 'from' || (prev === 'join' && prevPrev !== 'array')) ||
					(prev === ',' && frame.clause === 'from') ||
					prev === 'desc' || prev === 'describe' || (prev === 'table' && (prevPrev === 'desc' || prevPrev === 'describe'))
				);
				out.push({ name: token, table });
			} else if (token === 'select') {
				frame.select = true;
				frame.clause = 'select';
			} else if (token === 'join') {
				frame.clause = prev === 'array' ? 'arrayjoin' : 'from';
			} else if (CLAUSE.test(token)) {
				frame.clause = token;
			}
		} else if (token === '(') {
			frames.push({ clause: '', select: false });
		} else if (token === ')' && frames.length > 1) {
			frames.pop();
		}
		prevPrev = prev;
		prev = token;
	}
	return out;
}

/**
 * The first ClickHouse table function in `sql` that reaches outside the server, as its name, or
 * undefined. In a table's place (after FROM or JOIN, in a FROM list, after DESCRIBE) a table
 * function must be one of the few that only read this server: ClickHouse keeps adding ones that
 * fetch a URL, read object storage, open a file, query another database or run a script (url, s3,
 * remote, mysql, postgresql, mongodb, redis, jdbc, odbc, hdfs, azureBlobStorage, file, executable,
 * and the lakehouse readers), so a list of the bad ones is always one release behind. A
 * parameterized view (`my_view(p = 1)`) stands where a table function does and is refused with
 * them. The known reaching ones are refused wherever else they are written. ClickHouse only:
 * elsewhere a set-returning function in FROM is an ordinary read.
 */
export function clickhouseTableFunction(sql: string, driver?: string): string | undefined {
	if (driver !== 'clickhouse') {
		return undefined;
	}
	for (const statement of guardNamedStatements(sql, driver)) {
		for (const { name, table } of clickhouseCalls(statement)) {
			if (table ? !CLICKHOUSE_LOCAL_TABLE_FUNCTIONS.has(name) : CLICKHOUSE_REACHING.some((pattern) => matches(name, pattern))) {
				return name;
			}
		}
	}
	return undefined;
}

/**
 * The first function `sql` calls that changes state, a sequence it advances, or a call nobody can
 * check (through a quoted name, or IDENTIFIER(...)), as the name to show, then the first such call
 * written inside a string (see the header); undefined when there is none. A name with a space in it is a phrase (`NEXT VALUE FOR`), not a function. `driver` is the
 * connection's driver id.
 */
export function writingCall(sql: string, driver?: string): string | undefined {
	for (const statement of guardNamedStatements(sql, driver)) {
		for (const call of calls(statement)) {
			const refused = refusedName(call);
			if (refused) {
				return refused;
			}
			// `ts_rewrite(query, 'select target, substitute from aliases')` runs its second argument.
			if (call.name === 'ts_rewrite' && argumentCount(statement, call.open) === 2) {
				return call.name;
			}
		}
		for (const [pattern, name] of [...QUERY_RUNNING, ...SEQUENCE_ADVANCE]) {
			if (pattern.test(statement)) {
				return name;
			}
		}
		const indirect = indirectCall(statement);
		if (indirect) {
			return indirect;
		}
	}
	for (const statement of guardStatements(sql, driver)) {
		if (quotedCall(statement)) {
			return 'a function named in quotes';
		}
	}
	return callInString(sql, driver);
}

/**
 * The first function `sql` calls that is not a known-pure built-in (a user-defined function, a
 * sleep, a remote table function), or undefined when every call is known. A read that calls one
 * may still run, but not unasked.
 */
export function uncheckedCall(sql: string, driver?: string): string | undefined {
	const written = writingCall(sql, driver);
	if (written) {
		return written;
	}
	for (const statement of guardStatements(sql, driver)) {
		for (const { name } of calls(statement)) {
			if (!PURE.has(name) && !name.startsWith('pg_get_')) {
				return name;
			}
		}
	}
	return undefined;
}

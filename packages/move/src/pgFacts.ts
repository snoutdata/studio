/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reading a Postgres database's `EndpointFacts`: one query, and the mapping from its answer.
 *
 * Both halves are here, pure, so the desktop app and the CLI ask the same question and read the
 * answer the same way; the host only runs the query. One statement returning one JSON value,
 * because a hosted endpoint is behind a front door where every round trip costs, and because a
 * single statement sees one snapshot.
 *
 * What the query cannot know is supplied by the host: where the database is, whether the saved
 * connection is read-only or production, a hosted plan's storage, and the platform profile.
 */

import type { DatabaseObject, DatabaseObjectKind, EndpointFacts, ExtensionTable, SchemaFacts } from './facts.js';
import { HOSTED_POSTGRES_MAJOR, HOSTED_POSTGRES_PLATFORM, NO_PLATFORM, type PlatformProfile } from './platform.js';

export const PG_FACTS_SQL = `select json_build_object(
	'serverMajor', current_setting('server_version_num')::int / 10000,
	'superuser', (select rolsuper from pg_roles where rolname = current_user),
	'sizeBytes', pg_database_size(current_database()),
	'schemas', coalesce((
		select json_agg(json_build_object(
			'name', n.nspname,
			'bytes', (select coalesce(sum(pg_total_relation_size(c.oid)), 0) from pg_class c where c.relnamespace = n.oid and c.relkind in ('r', 'm', 'p'))
		) order by n.nspname)
		from pg_namespace n
		where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
	), '[]'),
	'extensions', coalesce((select json_agg(extname order by extname) from pg_extension), '[]'),
	'availableExtensions', coalesce((select json_agg(name order by name) from pg_available_extensions), '[]'),
	'roles', coalesce((select json_agg(rolname order by rolname) from pg_roles where rolname not like 'pg\\_%'), '[]'),
	'grantees', coalesce((
		select json_agg(distinct g order by g) from (
			select pg_get_userbyid(c.relowner) as g
				from pg_class c join pg_namespace n on n.oid = c.relnamespace
				where c.relkind in ('r', 'v', 'm', 'p', 'S')
					and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
			union
			select a.grantee::regrole::text
				from pg_class c
				join pg_namespace n on n.oid = c.relnamespace
				cross join lateral aclexplode(c.relacl) a
				where c.relacl is not null
					and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
			union
			select pg_get_userbyid(n.nspowner)
				from pg_namespace n
				where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
			union
			select a.grantee::regrole::text
				from pg_namespace n
				cross join lateral aclexplode(n.nspacl) a
				where n.nspacl is not null
					and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
		) s
		-- grantee 0 is PUBLIC, which renders as '-' through regrole and is not a role anybody
		-- has to create on the target.
		--
		-- The pg_ prefix is excluded for a sharper reason than symmetry with the roles list
		-- above: a built-in role exists on EVERY cluster by definition, so it can never be the
		-- missing grantee this fact is gathered to find. Left in, pg_database_owner (which owns
		-- the public schema on a modern server) would be reported missing against every target
		-- and block every move that keeps privileges. Found by running this query against a real
		-- database rather than by reading it.
		--
		-- NO BACKTICKS IN THIS COMMENT. The whole statement is a JS template literal, so a
		-- backtick ends the string and the SQL after it is parsed as JavaScript.
		where g is not null and g <> '' and g <> '-' and g not like 'pg\\_%'
	), '[]'),
	'extensionTables', coalesce((
		select json_agg(distinct jsonb_build_object(
			'extension', e.extname,
			'schema', n.nspname,
			'table', c.relname,
			'rows', case when c.reltuples < 0 then null else c.reltuples::bigint end
		))
		from pg_attribute a
		join pg_class c on c.oid = a.attrelid and c.relkind in ('r', 'p')
		join pg_namespace n on n.oid = c.relnamespace
		join pg_depend d on d.classid = 'pg_type'::regclass and d.objid = a.atttypid and d.deptype = 'e'
		join pg_extension e on e.oid = d.refobjid
		where a.attnum > 0 and not a.attisdropped
	), '[]'),
	'objects', coalesce((
		select json_agg(o) from (
			select n.nspname as schema, c.relname as name,
				case c.relkind when 'v' then 'view' when 'm' then 'materializedView' when 'S' then 'sequence' else 'table' end as kind,
				null::text as arguments
			from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where c.relkind in ('r', 'p', 'v', 'm', 'S')
				and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
				and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
			union all
			select n.nspname, t.typname, 'type', null
			from pg_type t join pg_namespace n on n.oid = t.typnamespace
			where (t.typtype in ('e', 'd', 'r') or (t.typtype = 'c' and (select relkind from pg_class where oid = t.typrelid) = 'c'))
				and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
				and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')
			union all
			select n.nspname, p.proname, case p.prokind when 'p' then 'procedure' else 'function' end, pg_get_function_identity_arguments(p.oid)
			from pg_proc p join pg_namespace n on n.oid = p.pronamespace
			where p.prokind in ('f', 'p')
				and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
				and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
		) o
	), '[]')
) as facts`;

export interface HostFacts {
	/** `host:port/database`, so a move onto itself is caught. */
	readonly identity: string | null;
	readonly readOnly: boolean;
	readonly production: boolean;
	readonly storage: { readonly limitBytes: number; readonly usedBytes: number } | null;
	readonly platform?: PlatformProfile;
	/** A hosted target's list of extensions that actually refuse; null when there is none. */
	readonly allowedExtensions?: readonly string[] | null;
}

const KINDS = new Set<DatabaseObjectKind>(['table', 'view', 'materializedView', 'sequence', 'type', 'function', 'procedure']);

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberOrNull(value: unknown): number | null {
	const number = typeof value === 'string' ? Number(value) : value;
	return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

/**
 * The query's answer, as `EndpointFacts`. Accepts the JSON value or its text (a driver may hand
 * back either), and is defensive about shape: a field that did not come back is unknown, never a
 * guess.
 */
export function endpointFactsFromPg(answer: unknown, host: HostFacts): EndpointFacts {
	const raw = record(typeof answer === 'string' ? JSON.parse(answer) : answer);
	const platform = host.platform ?? NO_PLATFORM;

	const schemas: SchemaFacts[] = (Array.isArray(raw.schemas) ? raw.schemas : []).map(record).flatMap((schema) =>
		typeof schema.name === 'string' ? [{ name: schema.name, bytes: numberOrNull(schema.bytes) }] : []
	);

	const extensionTables: ExtensionTable[] = (Array.isArray(raw.extensionTables) ? raw.extensionTables : [])
		.map(record)
		.flatMap((table) =>
			typeof table.extension === 'string' && typeof table.schema === 'string' && typeof table.table === 'string'
				? [{ extension: table.extension, schema: table.schema, table: table.table, rows: numberOrNull(table.rows) }]
				: []
		)
		.sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));

	const objects: DatabaseObject[] = (Array.isArray(raw.objects) ? raw.objects : []).map(record).flatMap((object) =>
		typeof object.schema === 'string' && typeof object.name === 'string' && KINDS.has(object.kind as DatabaseObjectKind)
			? [
					{
						schema: object.schema,
						name: object.name,
						kind: object.kind as DatabaseObjectKind,
						arguments: typeof object.arguments === 'string' ? object.arguments : null
					}
				]
			: []
	);

	const platformSchemas = new Set(platform.schemas);
	const platformObjects = new Set(platform.objects.map((object) => `${object.schema}.${object.name}`));
	// Empty means nothing of the USER's: the platform's own schemas and watchers do not count, or
	// every fresh hosted project would look full.
	const empty = !objects.some(
		(object) =>
			(object.kind === 'table' || object.kind === 'view' || object.kind === 'materializedView') &&
			!platformSchemas.has(object.schema) &&
			!platformObjects.has(`${object.schema}.${object.name}`)
	);

	const superuser = typeof raw.superuser === 'boolean' ? raw.superuser : null;

	return {
		serverMajor: numberOrNull(raw.serverMajor),
		identity: host.identity,
		schemas,
		extensions: strings(raw.extensions),
		availableExtensions: Array.isArray(raw.availableExtensions) ? strings(raw.availableExtensions) : null,
		allowedExtensions: host.allowedExtensions ?? null,
		empty,
		readOnly: host.readOnly,
		production: host.production,
		superuser,
		roles: Array.isArray(raw.roles) ? strings(raw.roles) : null,
		grantees: Array.isArray(raw.grantees) ? strings(raw.grantees) : null,
		sizeBytes: numberOrNull(raw.sizeBytes),
		storage: host.storage,
		platformSchemas: [...platform.schemas],
		platformExtensions: [...platform.extensions],
		extensionTables,
		objects,
		platformObjects: [...platform.objects],
		creation: null
	};
}

/**
 * A string as a Postgres literal, written as an escape string (`E'…'`) with `\` and `'` both doubled.
 *
 * That form means the same thing whatever `standard_conforming_strings` is, both to the server and
 * to `psql`'s own lexer, which is the one that matters: `psqlQuery` sends text through psql, and a
 * plain `'…'` whose value holds `\'` is read by psql under `off` as an escaped quote, so the rest of a
 * hostile source's table name (`\! <command>`) would land outside the literal as a meta-command.
 * Every value here can be a name the source chose.
 */
export function quoteLiteral(value: string): string {
	return `E'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/**
 * What the SERVER a new database would be created on can tell us, asked over a saved
 * connection to any database on it. Nothing is created by asking.
 */
export function pgServerFactsSql(database: string): string {
	return `select json_build_object(
	'serverMajor', current_setting('server_version_num')::int / 10000,
	'superuser', (select rolsuper from pg_roles where rolname = current_user),
	'canCreate', (select rolsuper or rolcreatedb from pg_roles where rolname = current_user),
	'nameTaken', exists (select 1 from pg_database where datname = ${quoteLiteral(database)}),
	'availableExtensions', coalesce((select json_agg(name order by name) from pg_available_extensions), '[]')
) as facts`;
}

/** The facts of a database that does not exist yet: empty by definition, on a server we asked. */
export function newDatabaseFactsFromPg(answer: unknown, host: HostFacts): EndpointFacts {
	const raw = record(typeof answer === 'string' ? JSON.parse(answer) : answer);
	return {
		serverMajor: numberOrNull(raw.serverMajor),
		identity: host.identity,
		schemas: [],
		extensions: [],
		availableExtensions: Array.isArray(raw.availableExtensions) ? strings(raw.availableExtensions) : null,
		allowedExtensions: null,
		empty: true,
		readOnly: host.readOnly,
		production: host.production,
		superuser: typeof raw.superuser === 'boolean' ? raw.superuser : null,
		// The server was asked for its roles here; a database that does not exist yet has no
		// objects, so it names no grantees.
		roles: Array.isArray(raw.roles) ? strings(raw.roles) : null,
		grantees: [],
		sizeBytes: 0,
		storage: host.storage,
		platformSchemas: [],
		platformExtensions: [],
		extensionTables: [],
		objects: [],
		platformObjects: [],
		creation: {
			canCreate: typeof raw.canCreate === 'boolean' ? raw.canCreate : null,
			nameTaken: typeof raw.nameTaken === 'boolean' ? raw.nameTaken : null
		}
	};
}

/**
 * The facts of a hosted project that does not exist yet. Nothing can be asked of it, so this is
 * what every new project IS: Postgres 18, the measured platform profile, empty. Whether the plan
 * allows one more project is the control plane's to say when it is created.
 */
export function newHostedProjectFacts(): EndpointFacts {
	return {
		serverMajor: HOSTED_POSTGRES_MAJOR,
		identity: null,
		schemas: [],
		extensions: [],
		availableExtensions: null,
		allowedExtensions: null,
		empty: true,
		readOnly: false,
		production: false,
		superuser: false,
		// Nothing can be asked of a project that does not exist yet, and its roles are the
		// platform's rather than ours to predict, so this is NOT ASKED rather than a guess.
		// It means a move into a new hosted project gets no missing-grantee finding; the gap is
		// recorded as a known gap rather than filled with an invented list.
		roles: null,
		grantees: [],
		sizeBytes: 0,
		storage: null,
		platformSchemas: [...HOSTED_POSTGRES_PLATFORM.schemas],
		platformExtensions: [...HOSTED_POSTGRES_PLATFORM.extensions],
		extensionTables: [],
		objects: [],
		platformObjects: [...HOSTED_POSTGRES_PLATFORM.objects],
		creation: { canCreate: null, nameTaken: false }
	};
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the host learned about the two databases, which is everything the preflight rules read.
 *
 * Gathering these is I/O and belongs to the host (the desktop app asks its connections and the
 * control plane; the CLI asks a URL). The rules only read them, which is what lets every rule be
 * tested without a database. A field the host could not learn is `null`, and a rule that needs it
 * stays silent rather than guessing.
 */

export interface SchemaFacts {
	readonly name: string;
	/** On-disk size of the schema's relations, when the host could read it. */
	readonly bytes: number | null;
}

export interface EndpointFacts {
	readonly serverMajor: number | null;
	/**
	 * Where this database really is (`host:port/database`), so a move onto itself is caught even
	 * when the two endpoints are named differently: a saved connection and the cloud project it
	 * was imported from are the same database.
	 */
	readonly identity: string | null;
	readonly schemas: readonly SchemaFacts[];
	/** Extensions installed in this database. */
	readonly extensions: readonly string[];
	/** Extensions this server could create. Null when unknown. */
	readonly availableExtensions: readonly string[] | null;
	/**
	 * Extensions a non-superuser owner is allowed to create here: the hosted project's
	 * `snout_utils` allowlist. Null means there is no such list.
	 */
	readonly allowedExtensions: readonly string[] | null;
	/** Whether the database holds no user objects. Null when unknown. */
	readonly empty: boolean | null;
	readonly readOnly: boolean;
	readonly production: boolean;
	readonly superuser: boolean | null;
	/**
	 * The roles this cluster has, by name, without the `pg_` built-ins. Null when they were not
	 * asked for.
	 *
	 * On the TARGET this is what decides whether the source's grants can land at all: `pg_dump`
	 * packs an object's whole acl into ONE restore entry, so one missing grantee fails that entry
	 * and takes every other grant on the object with it.
	 */
	readonly roles: readonly string[] | null;
	/**
	 * Every role the SOURCE's own objects name -- owners, and every grantee in an acl -- in the
	 * schemas that are not the platform's. Null when not asked.
	 *
	 * Null means NOT ASKED and never "none", which is why both of these are nullable rather than
	 * defaulting to an empty list: a missing-roles finding computed from an empty list would be
	 * unfalsifiable, and would block every move against a target nobody could read.
	 */
	readonly grantees: readonly string[] | null;
	readonly sizeBytes: number | null;
	/** A hosted plan's storage allowance. Null when the database has none. */
	readonly storage: { readonly limitBytes: number; readonly usedBytes: number } | null;
	/**
	 * Schemas that belong to the platform this database is hosted on rather than to the user's
	 * data. Supplied by the host from what it measured, never guessed here.
	 */
	readonly platformSchemas: readonly string[];
	/** Extensions the platform installs for itself, measured the same way. */
	readonly platformExtensions: readonly string[];
	/**
	 * Tables with a column whose type an extension provides. Measured 2026-09-13: when the
	 * extension cannot be created on the target, `pg_restore` drops the WHOLE table and its rows
	 * and carries on, so these are what a missing extension really costs.
	 */
	readonly extensionTables: readonly ExtensionTable[];
	/**
	 * The schema-level objects in this database that are not members of an extension, which is
	 * what `replace` drops from a schema it may not drop whole (`public`). Read for the TARGET.
	 */
	readonly objects: readonly DatabaseObject[];
	/**
	 * Objects the platform put in a user schema and a replace must leave alone. Measured
	 * 2026-09-13: PostgREST's `pgrst_ddl_watch()` / `pgrst_drop_watch()` live in `public` and are
	 * OWNED BY `<ref>_owner`, so ownership cannot tell them from the user's own functions and the
	 * host has to name them.
	 */
	readonly platformObjects: readonly { readonly schema: string; readonly name: string }[];
	/**
	 * Set only for a target the move CREATES: whether this connection may create it, and
	 * whether the name is already taken. Null for a database that already exists.
	 */
	readonly creation: { readonly canCreate: boolean | null; readonly nameTaken: boolean | null } | null;
}

export type DatabaseObjectKind = 'table' | 'view' | 'materializedView' | 'sequence' | 'type' | 'function' | 'procedure';

export interface DatabaseObject {
	readonly schema: string;
	readonly name: string;
	readonly kind: DatabaseObjectKind;
	/** `pg_get_function_identity_arguments` for a function or procedure; null otherwise. */
	readonly arguments: string | null;
}

export interface ExtensionTable {
	readonly extension: string;
	readonly schema: string;
	readonly table: string;
	readonly rows: number | null;
}

export interface MoveFacts {
	readonly source: EndpointFacts;
	readonly target: EndpointFacts;
	/** The major version of the installed `pg_dump`/`pg_restore`. Null when not installed. */
	readonly toolMajor: number | null;
}

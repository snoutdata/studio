/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A move: one database copied from one place to another.
 *
 * The spec is the ONE document the screen, the assistant and the coding agent all edit.
 * It names endpoints and never holds a host, a user or a password:
 * the host resolves an endpoint when a run starts, so a spec can be saved, shown to a model and
 * handed to the CLI without carrying anything secret.
 */

/** A driver id as the desktop app names it: `postgres`, `mysql`, `redshift`, ... */
export type DriverId = string;

export type MoveEndpoint =
	| { readonly kind: 'connection'; readonly id: string; readonly driver: DriverId }
	| { readonly kind: 'cloud'; readonly ref: string; readonly driver: 'postgres' }
	/** A database CREATED when the move starts, on the server a saved connection reaches. */
	| { readonly kind: 'newDatabase'; readonly serverConnectionId: string; readonly database: string; readonly driver: DriverId }
	/** A SnoutData Cloud project CREATED when the move starts, through the control plane. */
	| { readonly kind: 'newCloudProject'; readonly name: string; readonly region: string; readonly driver: 'postgres' };

/** A target the move creates rather than one that exists. Never a source. */
export function isNewEndpoint(endpoint: MoveEndpoint): boolean {
	return endpoint.kind === 'newDatabase' || endpoint.kind === 'newCloudProject';
}

/** Postgres's limit on an identifier, in bytes (NAMEDATALEN - 1). */
const PG_NAME_BYTES = 63;

export interface SchemaExclusion {
	readonly schema: string;
	/** Why it is left out, in a sentence a person reads on the review sheet. */
	readonly reason: string;
}

export interface TableExclusion {
	readonly schema: string;
	readonly table: string;
	readonly reason: string;
}

export interface ExtensionExclusion {
	readonly extension: string;
	readonly reason: string;
}

export interface MoveSelection {
	/** Null means every schema the source has. */
	readonly schemas: readonly string[] | null;
	readonly excludeSchemas: readonly SchemaExclusion[];
	readonly excludeTables: readonly TableExclusion[];
	/** `pg_dump --exclude-extension`, Postgres 17+. */
	readonly excludeExtensions: readonly ExtensionExclusion[];
}

export type MoveContent = 'schema' | 'data' | 'both';

/**
 * What happens to a target that already holds something. `requireEmpty` is the default and
 * `replace` is never one: dropping what is there is always a decision somebody made.
 */
export type TargetMode = 'requireEmpty' | 'replace';

/**
 * What happens to the source once the move has finished AND its verification matched. `keep` is
 * the default, which makes a move a copy until somebody says otherwise. `pause` is a hosted
 * project only. Nothing happens to the source after a run that was partial, failed or cancelled.
 */
export type SourceAfter = 'keep' | 'pause' | 'delete';

/**
 * Every way a preflight finding can be resolved. A model resolves a finding by choosing one of
 * the fixes the finding lists, never by writing SQL.
 */
export type FixId =
	/** Accept a risk the finding describes, and go ahead. */
	| 'continue'
	/** Go ahead without the object the finding names; it fails to restore and is reported. */
	| 'continueWithout'
	/** Drop what the target holds before restoring. */
	| 'replaceTarget'
	/** Leave the named schema out of the move. */
	| 'excludeSchema'
	/** Leave the named extension out of the move. */
	| 'excludeExtension'
	/** Take a schema the source does not have out of the selection. */
	| 'removeSchema'
	/** Restore without owners and grants, which a non-superuser target cannot apply. */
	| 'skipOwnership'
	/** Leave the source as it is after the move, rather than pausing or deleting it. */
	| 'keepSource';

export interface ResolvedFinding {
	readonly key: string;
	readonly fix: FixId;
}

export interface MoveSpec {
	readonly version: 1;
	readonly id: string;
	readonly name: string;
	/** A `ready` move is no longer edited by anybody; it is what the review sheet shows. */
	readonly status: 'draft' | 'ready';
	readonly source: MoveEndpoint;
	readonly target: MoveEndpoint;
	readonly content: MoveContent;
	readonly selection: MoveSelection;
	readonly targetMode: TargetMode;
	readonly ownership: 'skip' | 'keep';
	readonly privileges: 'skip' | 'keep';
	readonly sourceAfter: SourceAfter;
	/** Findings accepted by a fix that does not change the spec (`continue`, `continueWithout`). */
	readonly resolved: readonly ResolvedFinding[];
}

/**
 * A new draft with the defaults a move should have when nobody has decided anything yet.
 *
 * Owners and grants are skipped by default because roles are per server: a role that owns a
 * table on the source rarely exists on the target, and a hosted target cannot create one.
 */
export function newMoveSpec(input: {
	id: string;
	name: string;
	source: MoveEndpoint;
	target: MoveEndpoint;
}): MoveSpec {
	return {
		version: 1,
		id: input.id,
		name: input.name,
		status: 'draft',
		source: input.source,
		target: input.target,
		content: 'both',
		selection: { schemas: null, excludeSchemas: [], excludeTables: [], excludeExtensions: [] },
		targetMode: 'requireEmpty',
		ownership: 'skip',
		privileges: 'skip',
		sourceAfter: 'keep',
		resolved: []
	};
}

/** A hosted project's reference, as SnoutData Cloud issues them. */
const PROJECT_REF = /^[a-z0-9]{13}$/;

export function sameEndpoint(a: MoveEndpoint, b: MoveEndpoint): boolean {
	if (a.kind === 'connection' && b.kind === 'connection') {
		return a.id === b.id;
	}
	if (a.kind === 'cloud' && b.kind === 'cloud') {
		return a.ref === b.ref;
	}
	if (a.kind === 'newDatabase' && b.kind === 'newDatabase') {
		return a.serverConnectionId === b.serverConnectionId && a.database === b.database;
	}
	return false;
}

/** What is wrong with the spec on its own, before anything is known about either database. */
export function validateMove(spec: MoveSpec): string[] {
	const problems: string[] = [];
	if (spec.version !== 1) {
		problems.push(`This move was saved in a format this version does not read (${String(spec.version)}).`);
	}
	if (!spec.name.trim()) {
		problems.push("The move has no name.");
	}
	for (const [label, endpoint] of [
		['source', spec.source],
		['target', spec.target]
	] as const) {
		if (endpoint.kind === 'connection' && !endpoint.id.trim()) {
			problems.push(`The ${label} names no connection.`);
		}
		if (endpoint.kind === 'cloud' && !PROJECT_REF.test(endpoint.ref)) {
			problems.push(`The ${label} is not a SnoutData Cloud project reference: "${endpoint.ref}".`);
		}
		if (isNewEndpoint(endpoint) && label === 'source') {
			problems.push("The source has to be a database that already exists.");
		}
		if (endpoint.kind === 'newDatabase') {
			if (!endpoint.serverConnectionId.trim()) {
				problems.push("The new database names no server to create it on.");
			}
			if (!endpoint.database.trim()) {
				problems.push("The new database has no name.");
			} else if (new TextEncoder().encode(endpoint.database).length > PG_NAME_BYTES) {
				problems.push(`"${endpoint.database}" is longer than Postgres allows for a database name (${PG_NAME_BYTES} bytes).`);
			}
		}
		if (endpoint.kind === 'newCloudProject') {
			const name = endpoint.name.trim();
			if (!name || name.length > 60) {
				problems.push("A new SnoutData Cloud project needs a name of 1 to 60 characters.");
			}
			if (!endpoint.region.trim()) {
				problems.push("A new SnoutData Cloud project needs a region.");
			}
		}
	}
	if (sameEndpoint(spec.source, spec.target)) {
		problems.push("The source and the target are the same database.");
	}
	if (spec.targetMode === 'replace' && spec.content === 'data') {
		problems.push(
			"Replacing the target drops its objects first, which a data-only move cannot do. Move the schema and the data, or keep the target as it is."
		);
	}
	if (spec.sourceAfter === 'pause' && spec.source.kind !== 'cloud') {
		problems.push("Only a SnoutData Cloud project can be paused after a move.");
	}
	// A hosted delete is the control plane's soft delete, recoverable for the plan's grace period
	// Dropping a database on somebody's own server has no such undo, and is not offered.
	if (spec.sourceAfter === 'delete' && spec.source.kind !== 'cloud') {
		problems.push("Only a SnoutData Cloud project can be deleted after a move.");
	}
	const { schemas, excludeSchemas, excludeTables, excludeExtensions } = spec.selection;
	if (schemas !== null && schemas.length === 0) {
		problems.push("No schema is selected.");
	}
	const names = [
		...(schemas ?? []),
		...excludeSchemas.map((exclusion) => exclusion.schema),
		...excludeTables.flatMap((exclusion) => [exclusion.schema, exclusion.table]),
		...excludeExtensions.map((exclusion) => exclusion.extension)
	];
	if (names.some((name) => !name)) {
		problems.push("A schema, table or extension in the selection has no name.");
	}
	return problems;
}

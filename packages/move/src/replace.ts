/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What `replace` does to the target before the restore.
 *
 * Not `pg_restore --clean`: measured 2026-09-13, `--clean` drops only the objects the archive
 * contains, so a table that existed only on the target survived a "replace".
 *
 * And never `drop schema public`: measured the same day on a hosted project, that cascades into
 * PostgREST's schema watchers and the platform's extensions, and the recreated schema comes back
 * owned by the wrong role with none of the grants the data API and Realtime need. So `public` (on
 * any server, since Postgres 15 gives it an owner and grants worth keeping) is emptied object by
 * object, and every other user schema the move writes into is dropped whole.
 *
 * A platform schema is never touched, and neither is a platform object inside `public`.
 */

import type { DatabaseObject, DatabaseObjectKind, EndpointFacts } from './facts.js';
import { selectedSchemas } from './preflight.js';
import type { MoveSpec } from './spec.js';

export interface ReplacePlan {
	/** What is dropped, by name, for the review sheet: `reporting` or `public.orders`. */
	readonly drops: readonly string[];
	/** Run in order, in one transaction, before the restore. */
	readonly statements: readonly string[];
}

/** A schema emptied object by object rather than dropped. */
const KEPT_SCHEMAS = new Set(['public']);

/** Relations before the types they use, functions last. CASCADE covers the rest. */
const ORDER: readonly DatabaseObjectKind[] = ['view', 'materializedView', 'table', 'sequence', 'type', 'function', 'procedure'];

const DROP: Record<DatabaseObjectKind, string> = {
	view: 'view',
	materializedView: 'materialized view',
	table: 'table',
	sequence: 'sequence',
	type: 'type',
	function: 'function',
	procedure: 'procedure'
};

export function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function qualified(object: DatabaseObject): string {
	const name = `${quoteIdent(object.schema)}.${quoteIdent(object.name)}`;
	return object.kind === 'function' || object.kind === 'procedure' ? `${name}(${object.arguments ?? ''})` : name;
}

export function replacePlan(spec: MoveSpec, facts: { source: EndpointFacts; target: EndpointFacts }): ReplacePlan {
	if (spec.targetMode !== 'replace') {
		return { drops: [], statements: [] };
	}
	const { target } = facts;
	const onTarget = new Set(target.schemas.map((schema) => schema.name));
	const platform = new Set(target.platformSchemas);
	const protectedObjects = new Set(target.platformObjects.map((object) => `${object.schema}.${object.name}`));
	const schemas = selectedSchemas(spec, facts.source).filter((name) => onTarget.has(name) && !platform.has(name));

	const drops: string[] = [];
	const statements: string[] = [];
	for (const schema of schemas.filter((name) => !KEPT_SCHEMAS.has(name))) {
		drops.push(schema);
		statements.push(`drop schema if exists ${quoteIdent(schema)} cascade`);
	}
	const emptied = target.objects
		.filter((object) => KEPT_SCHEMAS.has(object.schema) && schemas.includes(object.schema))
		.filter((object) => !protectedObjects.has(`${object.schema}.${object.name}`))
		.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
	for (const object of emptied) {
		drops.push(`${object.schema}.${object.name}`);
		statements.push(`drop ${DROP[object.kind]} if exists ${qualified(object)} cascade`);
	}
	return { drops, statements };
}

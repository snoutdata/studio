/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Everything worth saying about a move before it runs, as data.
 *
 * Each finding has a stable id, a sentence for a person, and the fixes that resolve it. A model
 * helping with a move reads findings and picks fixes; it never writes SQL to get past one. That
 * is what makes this usable by a small model: the decision space is enumerated here, by rules
 * tested without any model at all.
 *
 * Three severities, and the difference is who acts:
 *
 *   block   the move cannot run as specified. Either a fix changes the spec so the finding
 *           goes away, or it has no fix and the databases themselves must change.
 *   decide  the move can run, once somebody has chosen one of the fixes.
 *   note    worth knowing, needs nothing.
 */

import type { EndpointFacts, MoveFacts } from './facts.js';
import { validateMove, type FixId, type MoveSpec } from './spec.js';
import { strategyFor } from './strategy.js';

export type FindingId =
	| 'invalid-spec'
	| 'strategy-refused'
	| 'same-database'
	| 'tools-missing'
	| 'tool-too-old'
	| 'target-older'
	| 'schema-not-found'
	| 'platform-schema'
	| 'extensions-not-copied'
	| 'platform-extension'
	| 'extension-not-allowed'
	| 'extension-unavailable'
	| 'target-read-only'
	| 'target-not-empty'
	| 'storage-over'
	| 'storage-near'
	| 'ownership-needs-superuser'
	| 'grantees-missing'
	| 'production-target'
	| 'source-delete-partial'
	| 'source-delete'
	| 'target-name-taken'
	| 'cannot-create-database'
	| 'new-target';

export type Severity = 'block' | 'decide' | 'note';

export interface Finding {
	readonly id: FindingId;
	/** `id` or `id:object`. What a resolution is recorded against, stable across runs. */
	readonly key: string;
	readonly severity: Severity;
	readonly object: string | null;
	readonly sentence: string;
	readonly fixes: readonly FixId[];
	/** The fix a `decide` finding was resolved with, when it was. */
	readonly resolvedBy: FixId | null;
}

/** `plpgsql` is in every database and is never a finding. */
const ALWAYS_PRESENT = new Set(['plpgsql']);

/** Within this share of the space left, a move is close enough to the limit to ask. */
const STORAGE_NEAR = 0.9;

/** The newer of the two servers' majors: the tools must be at least this new. */
export function requiredToolMajor(facts: MoveFacts): number | null {
	const majors = [facts.source.serverMajor, facts.target.serverMajor].filter(
		(major): major is number => major !== null
	);
	return majors.length > 0 ? Math.max(...majors) : null;
}

/** The source schemas this move copies. */
export function selectedSchemas(spec: MoveSpec, source: EndpointFacts): string[] {
	const excluded = new Set(spec.selection.excludeSchemas.map((exclusion) => exclusion.schema));
	const base = spec.selection.schemas ?? source.schemas.map((schema) => schema.name);
	return base.filter((name) => !excluded.has(name));
}

/**
 * About how many bytes the move writes. An over-estimate by design: it is the relations' size on
 * disk, bloat and indexes included, and a restore writes less than that.
 */
export function estimatedBytes(spec: MoveSpec, source: EndpointFacts): number | null {
	const sizes = new Map(source.schemas.map((schema) => [schema.name, schema.bytes]));
	let total = 0;
	for (const name of selectedSchemas(spec, source)) {
		const bytes = sizes.get(name);
		if (bytes === null || bytes === undefined) {
			const narrowed = spec.selection.schemas !== null || spec.selection.excludeSchemas.length > 0;
			return narrowed ? null : source.sizeBytes;
		}
		total += bytes;
	}
	return total;
}

export function formatBytes(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return unit === 0 ? `${value} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`;
}

export function preflight(spec: MoveSpec, facts: MoveFacts): Finding[] {
	const found: Omit<Finding, 'key' | 'resolvedBy'>[] = [];
	function add(id: FindingId, severity: Severity, object: string | null, sentence: string, fixes: FixId[] = []): void {
		found.push({ id, severity, object, sentence, fixes });
	}

	for (const problem of validateMove(spec)) {
		add('invalid-spec', 'block', problem, problem);
	}

	const strategy = strategyFor(spec.source.driver, spec.target.driver);
	if (strategy.kind === 'refused') {
		add('strategy-refused', 'block', null, strategy.reason);
		return finish(spec, found);
	}

	const { source, target } = facts;

	if (source.identity !== null && source.identity === target.identity) {
		add('same-database', 'block', null, "The source and the target are the same database.");
	}

	const required = requiredToolMajor(facts);
	if (facts.toolMajor === null) {
		add('tools-missing', 'block', null, "The Postgres tools this move runs are not installed yet.");
	} else if (required !== null && facts.toolMajor < required) {
		add(
			'tool-too-old',
			'block',
			null,
			`The Postgres tools here are version ${facts.toolMajor}, and the newer server runs ${required}. The tools must be at least as new as the newest server.`
		);
	}

	if (source.serverMajor !== null && target.serverMajor !== null && target.serverMajor < source.serverMajor) {
		add(
			'target-older',
			'decide',
			null,
			`The target runs Postgres ${target.serverMajor} and the source runs ${source.serverMajor}. Anything that uses a newer feature will fail to restore and be listed in the report.`,
			['continue']
		);
	}

	if (spec.selection.schemas !== null && source.schemas.length > 0) {
		const known = new Set(source.schemas.map((schema) => schema.name));
		for (const name of spec.selection.schemas) {
			if (!known.has(name)) {
				add('schema-not-found', 'block', name, `The source has no schema named "${name}".`, ['removeSchema']);
			}
		}
	}

	const platform = new Set(source.platformSchemas);
	for (const name of selectedSchemas(spec, source)) {
		if (platform.has(name)) {
			add(
				'platform-schema',
				'decide',
				name,
				`"${name}" is managed by the platform the source is hosted on, not part of your data.`,
				['excludeSchema', 'continue']
			);
		}
	}

	if (spec.content !== 'data') {
		const excludedExtensions = new Set(spec.selection.excludeExtensions.map((exclusion) => exclusion.extension));
		const platformExtensions = new Set(source.platformExtensions);
		const extensions = source.extensions.filter((name) => !ALWAYS_PRESENT.has(name) && !excludedExtensions.has(name));
		// pg_dump copies extensions only when it dumps the whole database. With a schema list it
		// leaves every CREATE EXTENSION out, and the objects that use them fail on the target.
		if (spec.selection.schemas !== null && extensions.length > 0) {
			add(
				'extensions-not-copied',
				'decide',
				null,
				`With a list of schemas, extensions are not copied. ${extensions.join(', ')} must already exist on the target, or whatever uses them will fail to restore.`,
				['continue']
			);
		}
		for (const name of extensions) {
			const cost = extensionCost(name, source);
			if (platformExtensions.has(name)) {
				add(
					'platform-extension',
					'decide',
					name,
					`The extension ${name} is installed by the platform the source is hosted on, not by you.${cost.sentence}`,
					cost.tables > 0 ? ['continue'] : ['excludeExtension', 'continue']
				);
				continue;
			}
			// With no table depending on it, leaving the extension out loses nothing, so it is
			// offered. With tables depending on it, excluding it would lose them exactly as
			// failing would, and pretending otherwise is the one thing a fix must not do.
			const fixes: FixId[] = cost.tables > 0 ? ['continueWithout'] : ['excludeExtension', 'continueWithout'];
			if (target.allowedExtensions !== null && !target.allowedExtensions.includes(name)) {
				add(
					'extension-not-allowed',
					'decide',
					name,
					`The target does not allow the extension ${name}, so it will not be created.${cost.sentence}`,
					fixes
				);
			} else if (target.availableExtensions !== null && !target.availableExtensions.includes(name)) {
				add(
					'extension-unavailable',
					'decide',
					name,
					`The target server does not have the extension ${name} installed, so it will not be created.${cost.sentence}`,
					fixes
				);
			}
		}
	}

	if (target.readOnly) {
		add('target-read-only', 'block', null, "The target is read-only, so nothing can be written to it.");
	}

	// A target the move creates. Nothing is created here: these say whether it CAN be, and
	// when it will be.
	if (target.creation) {
		const created = spec.target;
		if (created.kind === 'newDatabase') {
			if (target.creation.nameTaken === true) {
				add(
					'target-name-taken',
					'block',
					created.database,
					`A database named "${created.database}" already exists on that server. Choose another name, or pick it as an existing target.`
				);
			}
			if (target.creation.canCreate === false) {
				add(
					'cannot-create-database',
					'block',
					null,
					"The connection that would create the new database is not allowed to create databases. It needs the CREATEDB privilege or a superuser."
				);
			}
			add('new-target', 'note', null, `The database "${created.database}" is created on that server when the move starts, and a connection to it is saved.`);
		} else if (created.kind === 'newCloudProject') {
			add(
				'new-target',
				'note',
				null,
				`The SnoutData Cloud project "${created.name}" is created in ${created.region} when the move starts, and the move waits until it is ready. Your plan decides whether one more project is allowed.`
			);
		}
	}

	if (spec.targetMode === 'requireEmpty' && spec.content !== 'data' && target.empty === false) {
		add(
			'target-not-empty',
			'block',
			null,
			"The target already holds tables. Replacing it drops everything in it first.",
			['replaceTarget']
		);
	}

	if (spec.content !== 'schema' && target.storage !== null) {
		const estimate = estimatedBytes(spec, source);
		const left = Math.max(0, target.storage.limitBytes - target.storage.usedBytes);
		if (estimate !== null && estimate > left) {
			add(
				'storage-over',
				'block',
				null,
				`The move writes about ${formatBytes(estimate)}, and the target has ${formatBytes(left)} left of its ${formatBytes(target.storage.limitBytes)} plan.`
			);
		} else if (estimate !== null && estimate > left * STORAGE_NEAR) {
			add(
				'storage-near',
				'decide',
				null,
				`The move writes about ${formatBytes(estimate)}, close to the ${formatBytes(left)} the target has left. The target becomes read-only if it goes over.`,
				['continue']
			);
		}
	}

	if ((spec.ownership === 'keep' || spec.privileges === 'keep') && target.superuser === false) {
		add(
			'ownership-needs-superuser',
			'block',
			null,
			"Keeping owners and grants needs a superuser on the target, and this connection is not one.",
			['skipOwnership']
		);
	}

	// Keeping grants needs more than a superuser: it needs the ROLES the source's acls name to
	// EXIST on the target. `pg_dump` packs an object's whole acl into ONE restore entry, so a
	// single missing grantee fails that entry and takes every other grant on that object with it.
	// `pg_restore` reports it as one more ignorable "role does not exist" and the object arrives
	// with no privileges at all -- silently, and invisibly afterwards without comparing acls by
	// hand.
	//
	// Not hypothetical: restoring another hosted Postgres platform's project into our own pod cost
	// `auth` 26 of its 27 tables' acls, because the source's acls name two roles our image never
	// creates. A hosted project -> SnoutData Cloud is this feature's headline direction and the
	// exact pair that triggers it.
	//
	// A null on either side means NOT ASKED, so nothing is claimed: a target whose roles could
	// not be read produces no finding rather than an unfalsifiable one.
	if (spec.ownership === 'keep' || spec.privileges === 'keep') {
		const held = target.roles;
		const named = source.grantees;
		if (held !== null && named !== null) {
			const missing = named.filter((role) => !held.includes(role));
			if (missing.length > 0) {
				const shown = missing.slice(0, 4).join(', ');
				const rest = missing.length > 4 ? `, and ${missing.length - 4} more` : '';
				add(
					'grantees-missing',
					'block',
					null,
					`The target does not have ${shown}${rest}, which the source's grants name. Every grant on an object naming a missing role is dropped WHOLE, without an error anybody would notice.`,
					['skipOwnership']
				);
			}
		}
	}

	if (target.production) {
		add(
			'production-target',
			'note',
			null,
			"The target is a production database. Starting the move will ask for its name to be typed."
		);
	}

	if (spec.sourceAfter === 'delete') {
		// Deleting the source is only ever the end of a move that took ALL of it. Leaving out the
		// platform's own schemas does not count as leaving anything out; any other narrowing does.
		const leftOut = [
			...(spec.content !== 'both' ? [spec.content === 'schema' ? 'the data' : 'the schema'] : []),
			...(spec.selection.schemas !== null ? ['every schema not in the list'] : []),
			...spec.selection.excludeSchemas
				.filter((exclusion) => !platform.has(exclusion.schema))
				.map((exclusion) => `the schema "${exclusion.schema}"`),
			...spec.selection.excludeTables.map((exclusion) => `the table "${exclusion.schema}"."${exclusion.table}"`),
			// An extension no table uses is not data: leaving it out loses no rows. Without this a hosted
			// source could never be deleted after a move, because every project carries `vector`
			// (measured 2026-09-13: it cannot be created on a stock Postgres, so it is either left out
			// or fails, and both used to count against the delete).
			...spec.selection.excludeExtensions
				.filter((exclusion) => !source.platformExtensions.includes(exclusion.extension))
				.filter((exclusion) => source.extensionTables.some((table) => table.extension === exclusion.extension))
				.map((exclusion) => `the extension ${exclusion.extension}`)
		];
		if (leftOut.length > 0) {
			add(
				'source-delete-partial',
				'block',
				null,
				`The source can only be deleted after a move that copies all of it, and this one leaves out ${leftOut.join(', ')}.`,
				['keepSource']
			);
		} else {
			add(
				'source-delete',
				'note',
				null,
				"The source is deleted only if the move finishes with every object restored and the row counts match. Starting the move will ask for its name to be typed."
			);
		}
	}

	return finish(spec, found);
}

/** What a missing extension takes with it: the tables whose columns use its types. */
function extensionCost(extension: string, source: EndpointFacts): { tables: number; sentence: string } {
	const tables = source.extensionTables.filter((table) => table.extension === extension);
	if (tables.length === 0) {
		return { tables: 0, sentence: '' };
	}
	const named = tables
		.map((table) => `"${table.schema}"."${table.table}"${table.rows === null ? '' : ` (${table.rows} rows)`}`)
		.join(', ');
	const which = tables.length === 1 ? 'This table uses it and' : `These ${tables.length} tables use it and`;
	return { tables: tables.length, sentence: ` ${which} will not move at all, rows included: ${named}.` };
}

function finish(spec: MoveSpec, found: Omit<Finding, 'key' | 'resolvedBy'>[]): Finding[] {
	return found.map((finding) => {
		const key = finding.object === null ? finding.id : `${finding.id}:${finding.object}`;
		const resolution = spec.resolved.find(
			(resolved) => resolved.key === key && finding.fixes.includes(resolved.fix)
		);
		return {
			...finding,
			key,
			resolvedBy: finding.severity === 'decide' && resolution ? resolution.fix : null
		};
	});
}

/** Nothing blocks, and every decision has been made. */
export function readyToRun(findings: readonly Finding[]): boolean {
	return findings.every(
		(finding) => finding.severity === 'note' || (finding.severity === 'decide' && finding.resolvedBy !== null)
	);
}

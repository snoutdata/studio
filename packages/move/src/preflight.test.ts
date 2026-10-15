/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { EndpointFacts, MoveFacts } from './facts.js';
import { applyFix, findFinding } from './fixes.js';
import { nativePgArgs } from './pgArgs.js';
import { preflight, readyToRun, type Finding } from './preflight.js';
import { replacePlan } from './replace.js';
import { newMoveSpec, type MoveSpec } from './spec.js';

function endpoint(overrides: Partial<EndpointFacts> = {}): EndpointFacts {
	return {
		serverMajor: 17,
		identity: null,
		schemas: [{ name: 'public', bytes: 1024 }],
		extensions: [],
		availableExtensions: null,
		allowedExtensions: null,
		empty: true,
		readOnly: false,
		production: false,
		superuser: true,
		// NOT ASKED by default, so no test trips the missing-grantee rule without saying so.
		roles: null,
		grantees: null,
		sizeBytes: 1024,
		storage: null,
		platformSchemas: [],
		platformExtensions: [],
		extensionTables: [],
		objects: [],
		platformObjects: [],
		creation: null,
		...overrides
	};
}

function facts(source: Partial<EndpointFacts> = {}, target: Partial<EndpointFacts> = {}, toolMajor: number | null = 17): MoveFacts {
	return { source: endpoint(source), target: endpoint(target), toolMajor };
}

function cloudToLocal(overrides: Partial<MoveSpec> = {}): MoveSpec {
	return {
		...newMoveSpec({
			id: 'm1',
			name: 'home-test to this computer',
			source: { kind: 'cloud', ref: 'qwertyzxcv123', driver: 'postgres' },
			target: { kind: 'connection', id: 'local', driver: 'postgres' }
		}),
		...overrides
	};
}

function only(findings: Finding[], id: string): Finding {
	const matching = findings.filter((finding) => finding.id === id);
	assert.equal(matching.length, 1, `expected one ${id}, got ${findings.map((f) => f.key).join(', ')}`);
	return matching[0];
}

function fix(spec: MoveSpec, finding: Finding, chosen: Parameters<typeof applyFix>[2]): MoveSpec {
	const result = applyFix(spec, finding, chosen);
	assert.ok(result.ok, result.ok ? '' : result.error);
	return result.spec;
}

test('a move between two ordinary Postgres 17 databases has nothing to say', () => {
	const findings = preflight(cloudToLocal(), facts());
	assert.deepEqual(findings, []);
	assert.equal(readyToRun(findings), true);
});

test('an engine pair that is not built is refused with a sentence, and nothing else is checked', () => {
	const spec = cloudToLocal({ target: { kind: 'connection', id: 'local', driver: 'mysql' } });
	const findings = preflight(spec, facts({}, { readOnly: true }));
	assert.deepEqual(findings.map((finding) => finding.id), ['strategy-refused']);
	assert.equal(readyToRun(findings), false);
});

test('a saved connection that IS the source project is caught by identity, not by name', () => {
	const at = 'qwertyzxcv123.db.snoutdata.com:5432/qwertyzxcv123';
	const finding = only(preflight(cloudToLocal(), facts({ identity: at }, { identity: at })), 'same-database');
	assert.equal(finding.severity, 'block');
});

test('tools older than the newest server block, and missing tools block', () => {
	assert.equal(only(preflight(cloudToLocal(), facts({}, {}, 16)), 'tool-too-old').severity, 'block');
	assert.equal(only(preflight(cloudToLocal(), facts({}, {}, null)), 'tools-missing').severity, 'block');
});

test('an older target is a decision, and continuing resolves it', () => {
	let spec = cloudToLocal();
	const known = facts({ serverMajor: 17 }, { serverMajor: 16 }, 17);
	const finding = only(preflight(spec, known), 'target-older');
	assert.equal(finding.severity, 'decide');
	assert.equal(readyToRun(preflight(spec, known)), false);

	spec = fix(spec, finding, 'continue');
	const after = preflight(spec, known);
	assert.equal(only(after, 'target-older').resolvedBy, 'continue');
	assert.equal(readyToRun(after), true);
});

test('a platform schema is excluded by a fix, with its reason kept for the review sheet', () => {
	let spec = cloudToLocal();
	const source = { schemas: [{ name: 'public', bytes: 10 }, { name: 'auth', bytes: 10 }], platformSchemas: ['auth'] };
	const finding = only(preflight(spec, facts(source)), 'platform-schema');
	assert.equal(finding.key, 'platform-schema:auth');

	spec = fix(spec, finding, 'excludeSchema');
	assert.deepEqual(preflight(spec, facts(source)), []);
	assert.equal(spec.selection.excludeSchemas[0].schema, 'auth');
	assert.match(spec.selection.excludeSchemas[0].reason, /managed by the platform/);
	assert.ok(nativePgArgs(spec, { database: 'local' }).dump.includes('--exclude-schema="auth"'));
});

test('an extension the hosted target does not allow is a decision about going on without it', () => {
	const spec = cloudToLocal({
		source: { kind: 'connection', id: 'local', driver: 'postgres' },
		target: { kind: 'cloud', ref: 'qwertyzxcv123', driver: 'postgres' }
	});
	const known = facts({ extensions: ['plpgsql', 'timescaledb', 'vector'] }, { allowedExtensions: ['vector'] });
	const findings = preflight(spec, known);
	const finding = only(findings, 'extension-not-allowed');
	assert.equal(finding.object, 'timescaledb');
	// Nothing uses it, so leaving it out loses nothing and is offered first.
	assert.deepEqual(finding.fixes, ['excludeExtension', 'continueWithout']);
	assert.equal(readyToRun(preflight(fix(spec, finding, 'continueWithout'), known)), true);
});

test('a missing extension names the tables it takes with it, and then cannot be merely excluded', () => {
	// Measured 2026-09-13: vector missing on a stock local server dropped "orders" and all
	// 300,000 of its rows while pg_restore reported "errors ignored" and carried on.
	const known = facts(
		{ extensions: ['vector'], extensionTables: [{ extension: 'vector', schema: 'public', table: 'orders', rows: 300000 }] },
		{ availableExtensions: ['pg_trgm'] }
	);
	const finding = only(preflight(cloudToLocal(), known), 'extension-unavailable');
	assert.match(finding.sentence, /will not move at all, rows included: "public"\."orders" \(300000 rows\)/);
	assert.deepEqual(finding.fixes, ['continueWithout']);
});

test('an extension nothing uses can be left out, and the dump is told so', () => {
	let spec = cloudToLocal();
	const known = facts({ extensions: ['hstore'] }, { availableExtensions: [] });
	const finding = only(preflight(spec, known), 'extension-unavailable');
	assert.deepEqual(finding.fixes, ['excludeExtension', 'continueWithout']);
	spec = fix(spec, finding, 'excludeExtension');
	assert.deepEqual(preflight(spec, known), []);
	assert.ok(nativePgArgs(spec, { database: 'local' }).dump.includes('--exclude-extension="hstore"'));
});

test('a hosted source\'s own extensions are a platform finding, not an availability one', () => {
	let spec = cloudToLocal();
	const known = facts({ extensions: ['pg_graphql', 'pg_stat_statements'], platformExtensions: ['pg_graphql', 'pg_stat_statements'] }, { availableExtensions: [] });
	const findings = preflight(spec, known);
	assert.deepEqual(findings.map((finding) => finding.id), ['platform-extension', 'platform-extension']);
	for (const finding of findings) {
		spec = fix(spec, finding, 'excludeExtension');
	}
	assert.deepEqual(preflight(spec, known), []);
	// Leaving out the platform's extensions is not leaving out the user's data.
	assert.deepEqual(preflight({ ...spec, sourceAfter: 'delete' }, known).map((finding) => finding.id), ['source-delete']);
});

test('with a schema list, extensions are not copied, and that is said', () => {
	const spec = cloudToLocal({ selection: { schemas: ['public'], excludeSchemas: [], excludeTables: [], excludeExtensions: [] } });
	const finding = only(preflight(spec, facts({ extensions: ['vector'] })), 'extensions-not-copied');
	assert.match(finding.sentence, /vector must already exist/);
});

test('a target that holds tables blocks until replacing it is chosen, and replacing empties it first', () => {
	let spec = cloudToLocal();
	const known = facts({}, { empty: false });
	const finding = only(preflight(spec, known), 'target-not-empty');
	assert.deepEqual(finding.fixes, ['replaceTarget']);

	spec = fix(spec, finding, 'replaceTarget');
	assert.deepEqual(preflight(spec, known), []);
	// Measured: --clean drops only what the archive holds, and a target-only table survived it.
	const restore = nativePgArgs(spec, { database: 'local' }).restore;
	assert.ok(!restore.includes('--clean'));
});

test('replace empties public object by object, drops other user schemas whole, and spares the platform', () => {
	// Measured on a hosted project: dropping public cascades into PostgREST's watchers (owned by
	// <ref>_owner, so only a name tells them apart) and loses the grants the data API needs.
	const spec = cloudToLocal({ targetMode: 'replace' });
	const known = facts(
		{ schemas: [{ name: 'public', bytes: 1 }, { name: 'reporting', bytes: 1 }, { name: 'auth', bytes: 1 }] },
		{
			schemas: [{ name: 'public', bytes: 1 }, { name: 'reporting', bytes: 1 }, { name: 'auth', bytes: 1 }],
			platformSchemas: ['auth'],
			objects: [
				{ schema: 'public', name: 'touch_updated_at', kind: 'function', arguments: '' },
				{ schema: 'public', name: 'orders', kind: 'table', arguments: null },
				{ schema: 'public', name: 'order_status', kind: 'type', arguments: null },
				{ schema: 'public', name: 'paid_orders', kind: 'view', arguments: null },
				{ schema: 'public', name: 'pgrst_ddl_watch', kind: 'function', arguments: '' },
				{ schema: 'auth', name: 'uid', kind: 'function', arguments: '' }
			],
			platformObjects: [{ schema: 'public', name: 'pgrst_ddl_watch' }]
		}
	);
	const plan = replacePlan(spec, known);
	assert.deepEqual(plan.statements, [
		'drop schema if exists "reporting" cascade',
		'drop view if exists "public"."paid_orders" cascade',
		'drop table if exists "public"."orders" cascade',
		'drop type if exists "public"."order_status" cascade',
		'drop function if exists "public"."touch_updated_at"() cascade'
	]);
	assert.ok(!plan.statements.some((statement) => /drop schema if exists "(public|auth)"/.test(statement)));
	assert.ok(!plan.drops.includes('public.pgrst_ddl_watch'));
	assert.equal(replacePlan(cloudToLocal(), known).statements.length, 0);
});

test('a data-only move into tables that exist is the point, not a finding', () => {
	const spec = cloudToLocal({ content: 'data' });
	assert.deepEqual(preflight(spec, facts({}, { empty: false })), []);
});

test('storage past what the plan has left blocks with the numbers, and close to it asks', () => {
	const gb = 1024 ** 3;
	const over = only(
		preflight(cloudToLocal(), facts({ schemas: [{ name: 'public', bytes: 9 * gb }] }, { storage: { limitBytes: 8 * gb, usedBytes: 0 } })),
		'storage-over'
	);
	assert.equal(over.severity, 'block');
	assert.deepEqual(over.fixes, []);
	assert.match(over.sentence, /about 9\.0 GB.*8\.0 GB left of its 8\.0 GB plan/);

	const near = only(
		preflight(cloudToLocal(), facts({ schemas: [{ name: 'public', bytes: 7.5 * gb }] }, { storage: { limitBytes: 8 * gb, usedBytes: 0 } })),
		'storage-near'
	);
	assert.equal(near.severity, 'decide');
});

test('keeping owners into a non-superuser target blocks until they are skipped', () => {
	let spec = cloudToLocal({ ownership: 'keep' });
	const known = facts({}, { superuser: false });
	spec = fix(spec, only(preflight(spec, known), 'ownership-needs-superuser'), 'skipOwnership');
	assert.equal(spec.ownership, 'skip');
	assert.equal(spec.privileges, 'skip');
	assert.deepEqual(preflight(spec, known), []);
});

test('a grant naming a role the target lacks blocks, because the whole acl would go in silence', () => {
	// pg_dump packs an object's WHOLE acl into one restore entry, so a single missing grantee
	// fails that entry and takes every other grant on the object with it -- reported as one more
	// ignorable "role does not exist". Restoring another hosted platform's project into our own pod
	// cost auth 26 of its 27 tables' acls exactly this way.
	let spec = cloudToLocal({ privileges: 'keep' });
	const known = facts(
		{ grantees: ['anon', 'authenticated', 'dashboard_user', 'postgres'] },
		{ roles: ['anon', 'authenticated', 'postgres'] }
	);
	const finding = only(preflight(spec, known), 'grantees-missing');
	assert.equal(finding.severity, 'block');
	assert.match(finding.sentence, /dashboard_user/);
	spec = fix(spec, finding, 'skipOwnership');
	assert.deepEqual(preflight(spec, known), []);
});

test('nothing is claimed about roles that were never asked for', () => {
	// Null means NOT ASKED and never "none". A target nobody could read must not produce a
	// finding that cannot be falsified: that would block every move against such a target.
	const spec = cloudToLocal({ ownership: 'keep' });
	assert.deepEqual(preflight(spec, facts({ grantees: ['anon'] }, { roles: null })), []);
	assert.deepEqual(preflight(spec, facts({ grantees: null }, { roles: ['anon'] })), []);
});

test('skipping owners and grants needs no roles on the target at all', () => {
	// The default, and the reason this rule is not simply always on: nothing that names a role is
	// restored, so a target with none of them is perfectly fine.
	const spec = cloudToLocal();
	assert.equal(spec.ownership, 'skip');
	assert.equal(spec.privileges, 'skip');
	assert.deepEqual(preflight(spec, facts({ grantees: ['anon', 'x_owner'] }, { roles: [] })), []);
});

test('a production target is a note: it never blocks here, the sheet asks for the name', () => {
	const findings = preflight(cloudToLocal(), facts({}, { production: true }));
	assert.equal(only(findings, 'production-target').severity, 'note');
	assert.equal(readyToRun(findings), true);
});

test('the source is kept by default, and deleting it is a note that never blocks a full move', () => {
	assert.equal(cloudToLocal().sourceAfter, 'keep');
	const source = { schemas: [{ name: 'public', bytes: 10 }, { name: 'auth', bytes: 10 }], platformSchemas: ['auth'] };
	let spec = cloudToLocal({ sourceAfter: 'delete' });
	spec = fix(spec, only(preflight(spec, facts(source)), 'platform-schema'), 'excludeSchema');
	// Leaving out the platform's own schema is not leaving out the user's data.
	const findings = preflight(spec, facts(source));
	assert.equal(only(findings, 'source-delete').severity, 'note');
	assert.equal(readyToRun(findings), true);
});

test('deleting the source after a partial move blocks, naming what would be lost', () => {
	let spec = cloudToLocal({
		sourceAfter: 'delete',
		selection: {
			schemas: null,
			excludeSchemas: [],
			excludeTables: [{ schema: 'public', table: 'events', reason: 'big' }],
			excludeExtensions: []
		}
	});
	const finding = only(preflight(spec, facts()), 'source-delete-partial');
	assert.match(finding.sentence, /leaves out the table "public"\."events"/);
	spec = fix(spec, finding, 'keepSource');
	assert.equal(spec.sourceAfter, 'keep');
	assert.deepEqual(preflight(spec, facts()), []);
});

test('leaving out an extension no table uses does not stop a delete; one a table uses does', () => {
	// Every hosted project carries `vector` (measured), which a stock Postgres cannot create.
	const spec = cloudToLocal({
		sourceAfter: 'delete',
		selection: { schemas: null, excludeSchemas: [], excludeTables: [], excludeExtensions: [{ extension: 'vector', reason: 'not available here' }] }
	});
	assert.equal(preflight(spec, facts({ extensions: ['vector'] })).some((finding) => finding.id === 'source-delete-partial'), false);
	const used = preflight(spec, facts({ extensions: ['vector'], extensionTables: [{ extension: 'vector', schema: 'public', table: 'docs', rows: 3 }] }));
	assert.match(only(used, 'source-delete-partial').sentence, /the extension vector/);
});

test('only a hosted project can be paused after a move', () => {
	const spec = cloudToLocal({
		source: { kind: 'connection', id: 'local', driver: 'postgres' },
		target: { kind: 'cloud', ref: 'qwertyzxcv123', driver: 'postgres' },
		sourceAfter: 'pause'
	});
	assert.match(only(preflight(spec, facts()), 'invalid-spec').sentence, /Only a SnoutData Cloud project can be paused/);
});

test('a new database: a taken name or no CREATEDB blocks; otherwise one note says when it is made', () => {
	const spec = cloudToLocal({ target: { kind: 'newDatabase', serverConnectionId: 'local', database: 'shop_copy', driver: 'postgres' } });
	const fresh: Partial<EndpointFacts> = { schemas: [], empty: true, creation: { canCreate: true, nameTaken: false } };

	const findings = preflight(spec, facts({}, fresh));
	assert.deepEqual(findings.map((finding) => finding.id), ['new-target']);
	assert.equal(readyToRun(findings), true);

	const taken = only(preflight(spec, facts({}, { ...fresh, creation: { canCreate: true, nameTaken: true } })), 'target-name-taken');
	assert.equal(taken.severity, 'block');
	assert.match(taken.sentence, /"shop_copy" already exists/);
	assert.equal(only(preflight(spec, facts({}, { ...fresh, creation: { canCreate: false, nameTaken: false } })), 'cannot-create-database').severity, 'block');
});

test('a new cloud project names its region, and cannot be a source', () => {
	const target = { kind: 'newCloudProject' as const, name: 'shop', region: 'us-west-2', driver: 'postgres' as const };
	const note = only(preflight(cloudToLocal({ target }), facts({}, { empty: true, creation: { canCreate: null, nameTaken: false } })), 'new-target');
	assert.match(note.sentence, /"shop" is created in us-west-2 when the move starts/);

	const backwards = cloudToLocal({ source: target, target: { kind: 'connection', id: 'local', driver: 'postgres' } });
	assert.match(only(preflight(backwards, facts()), 'invalid-spec').sentence, /already exists/);
});

test('a fix the finding did not offer is refused with the ones it did', () => {
	const spec = cloudToLocal();
	const finding = only(preflight(spec, facts({}, { empty: false })), 'target-not-empty');
	const result = applyFix(spec, finding, 'continue');
	assert.equal(result.ok, false);
	assert.match(result.ok ? '' : result.error, /Its fixes are: replaceTarget/);
});

test('a ready move cannot be edited by a fix', () => {
	const spec = cloudToLocal({ status: 'ready' });
	const finding = only(preflight(spec, facts({}, { empty: false })), 'target-not-empty');
	assert.equal(applyFix(spec, finding, 'replaceTarget').ok, false);
});

test('findings are found by key', () => {
	const findings = preflight(cloudToLocal(), facts({}, { empty: false }));
	assert.equal(findFinding(findings, 'target-not-empty')?.id, 'target-not-empty');
	assert.equal(findFinding(findings, 'nope'), null);
});

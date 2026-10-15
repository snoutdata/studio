/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { Grant, Principal, PrincipalDraft, SecurityChange } from '../../../shared/engine';
import type { CapabilityContext } from './registry';
import { securityCapabilities } from './security';

const listUsers = securityCapabilities.find((h) => h.spec.name === 'list_db_users')!;
const listGrants = securityCapabilities.find((h) => h.spec.name === 'list_db_grants')!;
const proposeUser = securityCapabilities.find((h) => h.spec.name === 'propose_db_user')!;
const proposeAccess = securityCapabilities.find((h) => h.spec.name === 'propose_db_access_change')!;

interface Opened { connectionId: string; draft?: PrincipalDraft; changes?: SecurityChange[] }

/** A fake context. The capabilities reach the app only through `ctx.api.securityRead`,
 *  `ctx.snapshot()` (which connections exist and are live) and `ctx.app.openSecurity`. */
function ctxWith(options: { connected?: boolean; principals?: Principal[]; grants?: Grant[]; warnings?: string[] } = {}): { ctx: CapabilityContext; opened: Opened[] } {
	const opened: Opened[] = [];
	const ctx = {
		api: {
			securityRead: async () => ({
				driverId: 'postgres',
				principals: options.principals ?? [],
				grants: options.grants ?? [],
				warnings: options.warnings ?? [],
			}),
		},
		app: {
			openSecurity: (connectionId: string, proposal?: { draft?: PrincipalDraft; changes?: SecurityChange[] }) => {
				opened.push({ connectionId, draft: proposal?.draft, changes: proposal?.changes });
			},
		},
		snapshot: () => ({
			connections: [{ id: 'c1', label: 'Shop', driver: 'postgres', connected: options.connected !== false }],
			activeConnectionId: 'c1',
			tabs: [],
			appSettings: {},
		}),
	} as unknown as CapabilityContext;
	return { ctx, opened };
}

function principal(over: Partial<Principal>): Principal {
	return { name: 'app', kind: 'user', canLogin: true, isSuperuser: false, disabled: false, locked: false, memberOf: [], ...over };
}

function grant(over: Partial<Grant>): Grant {
	return { grantee: 'app', scope: 'table', privilege: 'SELECT', withGrantOption: false, ...over };
}

describe('the read capabilities', () => {
	test('run with no approval, because reading who can reach a database changes nothing', () => {
		assert.equal(listUsers.spec.mutates, false);
		assert.equal(listGrants.spec.mutates, false);
	});

	test('list_db_users returns each principal with what it can do', async () => {
		const { ctx } = ctxWith({ principals: [principal({ name: 'app', memberOf: ['readers'] }), principal({ name: 'admin', isSuperuser: true })] });
		const result = await listUsers.run({ connectionId: 'c1' }, ctx);
		assert.equal(result.ok, true);
		const data = result.data as { principals: { name: string; roles: string[]; isSuperuser: boolean }[] };
		assert.equal(data.principals.length, 2);
		assert.deepEqual(data.principals[0].roles, ['readers']);
		assert.equal(data.principals[1].isSuperuser, true);
	});

	test('passes the "could not read this" warnings through instead of pretending the list is complete', async () => {
		const { ctx } = ctxWith({ principals: [], warnings: ['Could not read table privileges: permission denied'] });
		const result = await listUsers.run({ connectionId: 'c1' }, ctx);
		const data = result.data as { warnings: string[] };
		assert.deepEqual(data.warnings, ['Could not read table privileges: permission denied']);
	});

	test('list_db_grants filters to one account, host included', async () => {
		const { ctx } = ctxWith({
			grants: [
				grant({ grantee: 'app', granteeHost: '%', object: 'orders' }),
				grant({ grantee: 'app', granteeHost: 'localhost', object: 'secrets' }),
				grant({ grantee: 'other', object: 'orders' }),
			],
		});
		const all = await listGrants.run({ connectionId: 'c1' }, ctx);
		assert.equal((all.data as { grants: unknown[] }).grants.length, 3);

		const mine = await listGrants.run({ connectionId: 'c1', user: 'app', host: '%' }, ctx);
		const grants = (mine.data as { grants: { grantee: string; object?: string }[] }).grants;
		assert.equal(grants.length, 1);
		assert.equal(grants[0].grantee, 'app@%');
		assert.equal(grants[0].object, 'orders');
	});

	test('carries a DENY through as a deny, not as a grant', async () => {
		const { ctx } = ctxWith({ grants: [grant({ deny: true, privilege: 'SELECT' })] });
		const result = await listGrants.run({ connectionId: 'c1' }, ctx);
		assert.equal((result.data as { grants: { deny: boolean }[] }).grants[0].deny, true);
	});

	// A handler that throws is turned into an unsuccessful CapabilityResult by the registry, so
	// the model reads the sentence and can recover; these assert the sentence is a useful one.
	test('refuses a connection that is not connected, saying so', async () => {
		const { ctx } = ctxWith({ connected: false });
		await assert.rejects(async () => listUsers.run({ connectionId: 'c1' }, ctx), /not connected/);
	});

	test('refuses an unknown connection id', async () => {
		const { ctx } = ctxWith();
		await assert.rejects(async () => listUsers.run({ connectionId: 'nope' }, ctx), /No connection with id/);
	});
});

describe('the write capabilities', () => {
	test('are approval-gated and only ever OPEN a review surface', () => {
		assert.equal(proposeUser.spec.mutates, true);
		assert.equal(proposeAccess.spec.mutates, true);
		// Both consent labels have to say the thing that makes this safe.
		assert.match(proposeUser.spec.consentLabel ?? '', /review|approve/i);
		assert.match(proposeAccess.spec.consentLabel ?? '', /review|approve/i);
	});

	test('propose_db_user has no password parameter at all', () => {
		// The rule this whole feature is built on: a password the model supplied would already have
		// passed through a chat message, a tool-call argument and the AI audit log.
		const properties = (proposeUser.spec.parameters as { properties: Record<string, unknown> }).properties;
		assert.equal('password' in properties, false);
		assert.match(proposeUser.spec.description, /TYPES THE PASSWORD THEMSELVES/);
	});

	test('propose_db_user opens the form with the name, host and roles filled in', () => {
		const { ctx, opened } = ctxWith();
		const result = proposeUser.run({ connectionId: 'c1', name: 'reporting', host: 'localhost', roles: ['readers'] }, ctx) as { ok: boolean };
		assert.equal(result.ok, true);
		assert.equal(opened.length, 1);
		assert.equal(opened[0].connectionId, 'c1');
		assert.deepEqual(opened[0].draft, { kind: 'user', name: 'reporting', host: 'localhost', memberOf: ['readers'] });
		assert.equal(opened[0].changes, undefined);
	});

	test('propose_db_user needs a name', () => {
		const { ctx, opened } = ctxWith();
		const result = proposeUser.run({ connectionId: 'c1', name: '  ' }, ctx) as { ok: boolean };
		assert.equal(result.ok, false);
		assert.equal(opened.length, 0);
	});

	test('propose_db_access_change opens the review sheet with a grant', () => {
		const { ctx, opened } = ctxWith();
		proposeAccess.run({ connectionId: 'c1', action: 'grant', user: 'app', scope: 'table', schema: 'public', table: 'orders', privileges: ['SELECT', 'INSERT'] }, ctx);
		assert.deepEqual(opened[0].changes, [{
			kind: 'grant',
			principal: { name: 'app', host: undefined },
			target: { scope: 'table', database: undefined, schema: 'public', object: 'orders', columns: undefined },
			privileges: ['SELECT', 'INSERT'],
			withGrantOption: false,
		}]);
	});

	test('a revoke is a revoke, not a grant with a flag', () => {
		const { ctx, opened } = ctxWith();
		proposeAccess.run({ connectionId: 'c1', action: 'revoke', user: 'app', scope: 'database', database: 'shop', privileges: ['ALL PRIVILEGES'] }, ctx);
		assert.equal(opened[0].changes?.[0].kind, 'revoke');
	});

	test('an unrecognised scope falls back to table rather than to the whole server', () => {
		// Widening on a typo is the one direction this must never fail in.
		const { ctx, opened } = ctxWith();
		proposeAccess.run({ connectionId: 'c1', action: 'grant', user: 'app', scope: 'everything', table: 't', privileges: ['SELECT'] }, ctx);
		const change = opened[0].changes?.[0];
		assert.equal(change?.kind === 'grant' && change.target.scope, 'table');
	});

	test('needs a user and at least one privilege', () => {
		const { ctx, opened } = ctxWith();
		assert.equal((proposeAccess.run({ connectionId: 'c1', action: 'grant', user: '', privileges: ['SELECT'] }, ctx) as { ok: boolean }).ok, false);
		assert.equal((proposeAccess.run({ connectionId: 'c1', action: 'grant', user: 'app', privileges: [] }, ctx) as { ok: boolean }).ok, false);
		assert.equal(opened.length, 0);
	});

	test('every capability declares the security domain, so the app-actions list groups them', () => {
		for (const handler of securityCapabilities) {
			assert.equal(handler.spec.domain, 'security', handler.spec.name);
		}
	});
});

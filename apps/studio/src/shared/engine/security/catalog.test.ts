/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { policyAppliesTo, policyKey, principalKey, propagateSuperuser, rowsToGrants, rowsToPolicies, rowsToPrincipals, rowToGrant, rowToPrincipal } from './catalog';
import type { Principal } from './types';

describe('rowToPrincipal', () => {
	it('reads the contract columns', () => {
		const principal = rowToPrincipal({
			name: 'app', kind: 'user', host: '%', can_login: true, is_superuser: false,
			disabled: false, locked: false, expires_at: null, member_of: 'readers,writers',
		});
		assert.deepEqual(principal, {
			name: 'app', kind: 'user', host: '%', canLogin: true, isSuperuser: false,
			disabled: false, locked: false, expiresAt: undefined, memberOf: ['readers', 'writers'],
			attributes: undefined,
		});
	});

	it('folds column case, because Oracle upper-cases every alias and Postgres lower-cases it', () => {
		const oracle = rowToPrincipal({ NAME: 'APP', KIND: 'user', CAN_LOGIN: 1, IS_SUPERUSER: 0, MEMBER_OF: 'DBA' });
		assert.equal(oracle?.name, 'APP');
		assert.equal(oracle?.canLogin, true);
		assert.deepEqual(oracle?.memberOf, ['DBA']);
	});

	it('accepts every way the four engines say yes', () => {
		for (const yes of [true, 1, '1', 'Y', 'YES', 'yes', 't', 'true']) {
			assert.equal(rowToPrincipal({ name: 'a', can_login: yes })?.canLogin, true, String(yes));
		}
		for (const no of [false, 0, '0', 'N', 'NO', '', null, undefined]) {
			assert.equal(rowToPrincipal({ name: 'a', can_login: no })?.canLogin, false, String(no));
		}
	});

	it('folds an unknown column into a display attribute, keeping its label', () => {
		const principal = rowToPrincipal({ name: 'app', 'Default tablespace': 'USERS', 'Can create roles': false });
		assert.deepEqual(principal?.attributes, { 'Default tablespace': 'USERS', 'Can create roles': 'No' });
	});

	it('drops an empty attribute rather than showing a blank row', () => {
		const principal = rowToPrincipal({ name: 'app', 'Profile': null, 'Comment': '   ' });
		assert.equal(principal?.attributes, undefined);
	});

	it('renders a date attribute as an ISO string', () => {
		const principal = rowToPrincipal({ name: 'app', 'Created': new Date('2026-01-02T03:04:05Z') });
		assert.equal(principal?.attributes?.Created, '2026-01-02T03:04:05.000Z');
	});

	it('drops a row with no name rather than showing a nameless principal', () => {
		assert.equal(rowToPrincipal({ name: null, kind: 'user' }), null);
		assert.equal(rowsToPrincipals([{ name: 'a' }, { name: '' }, { name: 'b' }]).length, 2);
	});

	it('defaults an unrecognised kind to user', () => {
		assert.equal(rowToPrincipal({ name: 'a', kind: 'something' })?.kind, 'user');
		assert.equal(rowToPrincipal({ name: 'a', kind: 'login' })?.kind, 'login');
	});
});

describe('rowToGrant', () => {
	it('reads a table grant', () => {
		const grant = rowToGrant({
			grantee: 'app', grantee_host: null, scope: 'table', database_name: 'shop',
			schema_name: 'public', object_name: 'orders', column_name: null,
			privilege: 'select', is_grantable: 'YES', is_deny: 0, grantor: 'postgres',
		});
		assert.deepEqual(grant, {
			grantee: 'app', granteeHost: undefined, scope: 'table', database: 'shop',
			schema: 'public', object: 'orders', column: undefined, privilege: 'SELECT',
			withGrantOption: true, deny: undefined, grantor: 'postgres',
		});
	});

	it('carries a DENY through, because it beats every grant the principal holds', () => {
		assert.equal(rowToGrant({ grantee: 'app', privilege: 'SELECT', is_deny: 1 })?.deny, true);
		assert.equal(rowToGrant({ grantee: 'app', privilege: 'SELECT', is_deny: 0 })?.deny, undefined);
	});

	it('defaults an unrecognised scope to table', () => {
		assert.equal(rowToGrant({ grantee: 'a', privilege: 'SELECT' })?.scope, 'table');
		assert.equal(rowToGrant({ grantee: 'a', privilege: 'SELECT', scope: 'global' })?.scope, 'global');
	});

	it('drops a row with no grantee or no privilege', () => {
		assert.equal(rowToGrant({ grantee: 'a' }), null);
		assert.equal(rowToGrant({ privilege: 'SELECT' }), null);
		assert.equal(rowsToGrants([{ grantee: 'a', privilege: 'SELECT' }, { grantee: 'b' }]).length, 1);
	});

	it('keeps PUBLIC as a grantee like any other', () => {
		assert.equal(rowToGrant({ grantee: 'PUBLIC', privilege: 'SELECT' })?.grantee, 'PUBLIC');
	});
});

describe('principalKey', () => {
	it('keys on the pair where the engine has a host', () => {
		// app@localhost and app@% are two accounts with two sets of grants. Keying on the name
		// alone shows one of them the other's privileges.
		assert.notEqual(principalKey('app', 'localhost'), principalKey('app', '%'));
		assert.equal(principalKey('app'), 'app');
		assert.equal(principalKey('app', '%'), 'app@%');
	});
});

describe('propagateSuperuser', () => {
	function principal(name: string, over: Partial<Principal> = {}): Principal {
		return { name, kind: 'user', canLogin: true, isSuperuser: false, disabled: false, locked: false, memberOf: [], ...over };
	}

	// ClickHouse Cloud's shape exactly: `default` holds NO grant of its own, `default_role` holds
	// CREATE USER, and `default` is a member of it. Reading only direct grants reports the
	// administrator of the service as an ordinary account.
	it('marks a user that is only a superuser through a role, and names the role', () => {
		const out = propagateSuperuser([
			principal('default', { memberOf: ['default_role'] }),
			principal('default_role', { kind: 'role', canLogin: false, isSuperuser: true }),
			principal('app', { memberOf: ['readers'] }),
			principal('readers', { kind: 'role', canLogin: false }),
		]);
		const byName = new Map(out.map((p) => [p.name, p]));
		assert.equal(byName.get('default')?.isSuperuser, true);
		assert.equal(byName.get('default')?.superuserVia, 'default_role');
		assert.equal(byName.get('app')?.isSuperuser, false);
		assert.equal(byName.get('app')?.superuserVia, undefined);
	});

	it('follows membership transitively, which Cloud really does chain', () => {
		// sql-console:<email> -> sql_console_admin -> default_role -> CREATE USER.
		const out = propagateSuperuser([
			principal('console-user', { memberOf: ['sql_console_admin'] }),
			principal('sql_console_admin', { kind: 'role', canLogin: false, memberOf: ['default_role'] }),
			principal('default_role', { kind: 'role', canLogin: false, isSuperuser: true }),
		]);
		assert.equal(out.find((p) => p.name === 'console-user')?.isSuperuser, true);
		assert.equal(out.find((p) => p.name === 'console-user')?.superuserVia, 'default_role');
	});

	it('leaves a direct superuser alone, and says nothing about how', () => {
		const out = propagateSuperuser([principal('root', { isSuperuser: true, memberOf: ['admins'] }), principal('admins', { kind: 'role', isSuperuser: true })]);
		assert.equal(out[0].superuserVia, undefined);
	});

	it('survives a membership cycle rather than trusting there is none', () => {
		const out = propagateSuperuser([
			principal('a', { memberOf: ['b'] }),
			principal('b', { kind: 'role', memberOf: ['a'] }),
		]);
		assert.equal(out[0].isSuperuser, false);
	});

	it('ignores a role it cannot see, because a read can be partial', () => {
		const out = propagateSuperuser([principal('app', { memberOf: ['a_role_we_cannot_read'] })]);
		assert.equal(out[0].isSuperuser, false);
	});
});

describe('policies', () => {
	const row = {
		kind: 'row-policy',
		name: 'own_rows',
		database_name: 'shop',
		object_name: 'orders',
		applies_to: 'app,reader',
		applies_to_all: 0,
		except_for: '',
		detail: 'tenant_id = currentUser()',
		is_restrictive: 1,
		'Defined in': 'local_directory',
	};

	it('maps a policy row and keeps the unknown columns as attributes', () => {
		const [policy] = rowsToPolicies([row]);
		assert.equal(policy.kind, 'row-policy');
		assert.equal(policy.name, 'own_rows');
		assert.deepEqual([...policy.appliesTo], ['app', 'reader']);
		assert.equal(policy.appliesToAll, false);
		assert.equal(policy.restrictive, true);
		assert.deepEqual(policy.attributes, { 'Defined in': 'local_directory' });
	});

	it('drops a row whose kind is not one of the three rather than guessing', () => {
		assert.equal(rowsToPolicies([{ ...row, kind: 'something-else' }]).length, 0);
		assert.equal(rowsToPolicies([{ ...row, name: '' }]).length, 0);
	});

	it('answers "does this apply to me" through roles and through the except list', () => {
		const [policy] = rowsToPolicies([row]);
		assert.equal(policyAppliesTo(policy, 'app'), true);
		assert.equal(policyAppliesTo(policy, 'someone'), false);
		// Granted through a role, which is how most of them reach a person.
		assert.equal(policyAppliesTo(policy, 'someone', ['reader']), true);

		// "Everyone except the admin" is the ordinary shape, and a list-membership test answers it
		// backwards: nobody is in the list, so nobody would be reported.
		const [everyone] = rowsToPolicies([{ ...row, applies_to: '', applies_to_all: 1, except_for: 'admin' }]);
		assert.equal(policyAppliesTo(everyone, 'app'), true);
		assert.equal(policyAppliesTo(everyone, 'admin'), false);
		assert.equal(policyAppliesTo(everyone, 'someone', ['admin']), false);
	});

	it('keys two policies with the same name on two tables apart', () => {
		const [a] = rowsToPolicies([row]);
		const [b] = rowsToPolicies([{ ...row, database_name: 'other' }]);
		assert.notEqual(policyKey(a), policyKey(b));
		assert.equal(policyKey({ kind: 'quota', name: 'reader' }), 'quota:reader');
	});
});

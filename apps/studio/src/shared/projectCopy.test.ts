/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { bucketCreateBody, functionBundle, isAlreadyThere, partUnavailable, secretReserved, userCreateBody, usersPageSql } from './projectCopy';

/*
 * Copying a whole project between this computer and SnoutData Cloud: what is decided without
 * touching either project.
 */

const BCRYPT = '$2a$10$abcdefghijklmnopqrstuuJ6mFQ6M3cbO0Q9yJbXPcH3f0QH6S2xK';

describe('which parts a pair of projects can copy', () => {
	test('everything goes from this computer to the cloud', () => {
		for (const part of ['users', 'database', 'files', 'functions', 'secrets'] as const) {
			assert.equal(partUnavailable(part, 'local', 'cloud'), null, part);
		}
	});

	test('functions and secrets do not come back from the cloud, and say why', () => {
		assert.match(partUnavailable('functions', 'cloud', 'local') ?? '', /source/);
		assert.match(partUnavailable('secrets', 'cloud', 'local') ?? '', /value/);
		assert.equal(partUnavailable('users', 'cloud', 'local'), null);
		assert.equal(partUnavailable('files', 'cloud', 'local'), null);
	});

	test('two projects of the same kind are not a copy this does', () => {
		assert.ok(partUnavailable('database', 'local', 'local'));
		assert.ok(partUnavailable('database', 'cloud', 'cloud'));
	});
});

describe('a user, as auth admin API creates it on the target', () => {
	test('keeps the id, the email, the confirmation and the password hash', () => {
		const made = userCreateBody({ id: 'u1', email: ' a@b.co ', encrypted_password: BCRYPT, email_confirmed_at: '2026-01-01T00:00:00Z', role: 'authenticated' });
		assert.ok(made.ok);
		assert.deepEqual(made.body, { id: 'u1', email: 'a@b.co', email_confirm: true, password_hash: BCRYPT });
		// The member role under our name is the default too.
		const ours = userCreateBody({ id: 'u1', email: 'a@b.co', role: 'snout_member' });
		assert.ok(ours.ok);
		assert.equal(ours.body.role, undefined);
	});

	test('carries metadata, but leaves the provider list to the target', () => {
		const made = userCreateBody({ id: 'u1', email: 'a@b.co', raw_user_meta_data: { name: 'A' }, raw_app_meta_data: { provider: 'email', providers: ['email'], plan: 'pro' } });
		assert.ok(made.ok);
		assert.deepEqual(made.body.user_metadata, { name: 'A' });
		assert.deepEqual(made.body.app_metadata, { plan: 'pro' });
		assert.equal(made.body.email_confirm, false);
	});

	test('an empty or unknown hash is not sent, so the target makes the user without a password', () => {
		for (const hash of ['', null, 'plain', '$1$md5']) {
			const made = userCreateBody({ id: 'u1', email: 'a@b.co', encrypted_password: hash });
			assert.ok(made.ok);
			assert.equal('password_hash' in made.body, false, String(hash));
		}
		const argon = userCreateBody({ id: 'u1', email: 'a@b.co', encrypted_password: '$argon2id$v=19$m=65536,t=3,p=4$abc$def' });
		assert.ok(argon.ok && argon.body.password_hash);
	});

	test('a role other than the default rides along', () => {
		const made = userCreateBody({ id: 'u1', email: 'a@b.co', role: 'admin' });
		assert.ok(made.ok && made.body.role === 'admin');
	});

	test('anonymous, phone-only, single sign-on and deleted users stay behind, with a reason', () => {
		assert.equal(userCreateBody({ id: 'u1', email: '', is_anonymous: true }).ok, false);
		assert.equal(userCreateBody({ id: 'u1', email: null }).ok, false);
		assert.equal(userCreateBody({ id: 'u1', email: 'a@b.co', is_sso_user: true }).ok, false);
		assert.equal(userCreateBody({ id: 'u1', email: 'a@b.co', deleted_at: '2026-01-01' }).ok, false);
		const none = userCreateBody({ email: 'a@b.co' });
		assert.ok(!none.ok && none.reason);
	});
});

describe('a user already on the target', () => {
	test('is recognised in either auth server\'s words', () => {
		assert.ok(isAlreadyThere(422, { error_code: 'email_exists', msg: 'A user with this email address has already been registered' }));
		assert.ok(isAlreadyThere(422, { code: 'email_exists' }));
		assert.ok(isAlreadyThere(409, { message: 'duplicate key value violates unique constraint "users_pkey"' }));
	});

	test('anything else is a refusal', () => {
		assert.equal(isAlreadyThere(422, { msg: 'Password should be at least 6 characters' }), false);
		assert.equal(isAlreadyThere(500, { msg: 'already exists' }), false);
	});
});

describe('reading users a page at a time', () => {
	test('the first page has no cursor, the next one starts after the last id', () => {
		assert.equal(usersPageSql(null, 500), 'select to_jsonb(u) as u from snout_identity.people u order by u.id limit 500');
		assert.match(usersPageSql('5f0c', 500), /where u\.id > '5f0c'::uuid order by u\.id limit 500$/);
	});

	test('a quote in the cursor cannot end the literal', () => {
		assert.match(usersPageSql("x'; drop table t; --", 10), /'x''; drop table t; --'::uuid/);
	});
});

describe('a bucket on the target', () => {
	test('has the same name, visibility and limits', () => {
		assert.deepEqual(bucketCreateBody({ id: 'avatars', name: 'avatars', public: true, file_size_limit: 1024, allowed_mime_types: ['image/png'] }),
			{ id: 'avatars', name: 'avatars', public: true, file_size_limit: 1024, allowed_mime_types: ['image/png'] });
		assert.deepEqual(bucketCreateBody({ id: 'docs', name: 'docs', file_size_limit: null, allowed_mime_types: [] }), { id: 'docs', name: 'docs', public: false });
	});
});

describe('a function, laid out as the CLI deploys it', () => {
	const own = [{ path: 'index.ts', text: 'x' }, { path: 'lib/a.ts', text: 'a' }];

	test('alone, flat, starting at index.ts', () => {
		const bundle = functionBundle('hello', own, null);
		assert.equal(bundle.entrypoint, 'index.ts');
		assert.deepEqual(bundle.files.map((f) => f.path), ['index.ts', 'lib/a.ts']);
	});

	test('beside _shared, under its own name so ../_shared resolves', () => {
		const bundle = functionBundle('hello', own, [{ path: 'db.ts', text: 'd' }]);
		assert.equal(bundle.entrypoint, 'hello/index.ts');
		assert.deepEqual(bundle.files.map((f) => f.path), ['_shared/db.ts', 'hello/index.ts', 'hello/lib/a.ts']);
	});
});

test('secrets the cloud reserves for itself are recognised by name', () => {
	assert.ok(secretReserved('SNOUTDATA_URL'));
	assert.ok(secretReserved('SNOUT_KEY'));
	assert.equal(secretReserved('STRIPE_KEY'), false);
});

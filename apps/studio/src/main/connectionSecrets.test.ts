/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ConnectionConfig, SshTunnelProfile } from '../shared/connection';
import { dropMovedSecrets, dropMovedTunnelSecrets, moveUriPasswords, secretsToDrop, type ConnectionSecret } from './connectionSecrets';

/** A keychain stand-in: the secrets a connection holds, and what was deleted from it. */
function fakeStore(id: string): { store: { delete(id: string, kind: string): void }; held: Set<string> } {
	const held = new Set<string>(['password', 'sshPassword', 'sshPassphrase', 'awsSecretAccessKey'].map((kind) => `${id}:${kind}`));
	return { store: { delete: (owner, kind) => held.delete(`${owner}:${kind}`) }, held };
}

const saved: ConnectionConfig = {
	id: 'c1',
	label: 'Shop',
	driver: 'postgres',
	host: 'db.internal',
	port: 5432,
	username: 'app',
	ssl: { rejectUnauthorized: true, caBundle: 'rds' },
	sshTunnel: { host: 'bastion', username: 'ec2-user' },
};

const noProfiles = (): undefined => undefined;

describe('a saved secret never follows a connection somewhere new', () => {
	test('a new host drops the stored database password', () => {
		const { store, held } = fakeStore('c1');
		const out = dropMovedSecrets(store, saved, { ...saved, host: 'evil.example' }, {}, noProfiles);
		assert.deepEqual(out.changes.map((c) => c.field), ['host']);
		assert.equal(held.has('c1:password'), false);
		assert.equal(held.has('c1:awsSecretAccessKey'), false);
		// The tunnel did not move, so its own secrets still belong to it.
		assert.equal(held.has('c1:sshPassword'), true);
		assert.equal(held.has('c1:sshPassphrase'), true);
	});

	test('a harmless change (label, database, read-only) keeps every secret', () => {
		const { store, held } = fakeStore('c1');
		const out = dropMovedSecrets(store, saved, { ...saved, label: 'Shop (renamed)', database: 'other', readOnly: true }, {}, noProfiles);
		assert.deepEqual(out.dropped, []);
		assert.equal(held.size, 4);
	});

	test('a new user name drops the stored password: credentials are typed again for a new user', () => {
		const { store, held } = fakeStore('c1');
		const out = dropMovedSecrets(store, saved, { ...saved, username: 'admin' }, {}, noProfiles);
		assert.deepEqual(out.changes.map((c) => c.field), ['username']);
		assert.equal(held.has('c1:password'), false);
		assert.equal(held.has('c1:sshPassword'), true);
	});

	test('a new database is a move where that field says where the connection goes', () => {
		const routed: ConnectionConfig[] = [
			{ id: 'c1', label: 'Lite', driver: 'sqlite', host: '', port: 0, username: '', database: '/data/app.db' },
			{ id: 'c1', label: 'Duck', driver: 'duckdb', host: '', port: 0, username: '', database: '/data/app.duckdb' },
			{ id: 'c1', label: 'Db2', driver: 'db2', host: 'db2.internal', port: 50000, username: 'app', database: 'SAMPLE' },
			{ id: 'c1', label: 'Ora', driver: 'oracle', host: 'ora.internal', port: 1521, username: 'app', database: 'ORCLPDB1' },
			{ id: 'c1', label: 'Hana', driver: 'hana', host: 'hana.internal', port: 30013, username: 'app', database: 'HXE' },
		];
		for (const before of routed) {
			const { store, held } = fakeStore('c1');
			const out = dropMovedSecrets(store, before, { ...before, database: 'OTHER' }, {}, noProfiles);
			assert.deepEqual(out.changes.map((c) => c.field), ['database'], before.driver);
			assert.equal(held.has('c1:password'), false, before.driver);
		}
	});

	test('port, driver and TLS (turning verification off) each count as a move', () => {
		for (const after of [{ ...saved, port: 6543 }, { ...saved, driver: 'mysql-aurora' }, { ...saved, ssl: { rejectUnauthorized: false } }, { ...saved, ssl: undefined }]) {
			const { store, held } = fakeStore('c1');
			dropMovedSecrets(store, saved, after, {}, noProfiles);
			assert.equal(held.has('c1:password'), false, JSON.stringify(after));
		}
	});

	test('a legacy ssl: true reads the same as verifying against the system store', () => {
		const { store, held } = fakeStore('c1');
		dropMovedSecrets(store, { ...saved, ssl: true }, { ...saved, ssl: { rejectUnauthorized: true } }, {}, noProfiles);
		assert.equal(held.has('c1:password'), true);
	});

	test('moving the SSH tunnel drops the tunnel secrets and the database password', () => {
		const { store, held } = fakeStore('c1');
		dropMovedSecrets(store, saved, { ...saved, sshTunnel: { host: 'other-bastion', username: 'ec2-user' } }, {}, noProfiles);
		assert.equal(held.size, 0);
	});

	test('an inline tunnel promoted to a profile with the same endpoint is not a move', () => {
		const { store, held } = fakeStore('c1');
		const promoted: ConnectionConfig = { ...saved, sshTunnel: undefined, sshTunnelRef: 'p1' };
		const out = dropMovedSecrets(store, saved, promoted, {}, (ref) => (ref === 'p1' ? { host: 'bastion', port: 22, username: 'ec2-user' } : undefined));
		assert.deepEqual(out.changes, []);
		assert.equal(held.size, 4);
	});

	test('a password typed in the same edit is kept: it is the answer for the new host', () => {
		const typed: Partial<Record<ConnectionSecret, boolean>> = { password: true };
		assert.deepEqual(secretsToDrop([{ field: 'host', before: 'a', after: 'b', ssh: false }], typed), ['awsSecretAccessKey']);
	});

	test('a new connection has nothing stored to drop', () => {
		const { store, held } = fakeStore('c1');
		assert.deepEqual(dropMovedSecrets(store, undefined, saved, {}, noProfiles).dropped, []);
		assert.equal(held.size, 4);
	});
});

// A shared tunnel profile moved to another SSH server must not keep its SSH password, nor the
// connections through it their database passwords.
describe('a saved secret never follows a tunnel profile somewhere new', () => {
	const profile: SshTunnelProfile = { id: 'p1', name: 'bastion', host: 'bastion.internal', port: 22, username: 'ec2-user' };
	const viaProfile: ConnectionConfig = { id: 'c1', label: 'Shop', driver: 'postgres', host: 'db', port: 5432, username: 'app', sshTunnelRef: 'p1' };
	const other: ConnectionConfig = { id: 'c2', label: 'Other', driver: 'postgres', host: 'db2', port: 5432, username: 'app' };

	function stores(): { stores: Parameters<typeof dropMovedTunnelSecrets>[0]; held: Set<string>; forgotten: string[] } {
		const held = new Set<string>(['tunnel:p1:sshPassword', 'tunnel:p1:sshPassphrase', 'c1:password', 'c1:awsSecretAccessKey', 'c2:password']);
		const forgotten: string[] = [];
		return {
			stores: { secrets: { delete: (owner, kind) => held.delete(`${owner}:${kind}`) }, forgetHostKey: (host, port) => forgotten.push(`${host}:${port}`) },
			held,
			forgotten,
		};
	}
	const context = (profiles: SshTunnelProfile[] = [], connections: ConnectionConfig[] = [viaProfile, other]) => ({ profileSecretId: 'tunnel:p1', connections, profiles });

	for (const [field, after] of [['host', { ...profile, host: 'evil.example' }], ['port', { ...profile, port: 2222 }], ['user', { ...profile, username: 'root' }]] as const) {
		test(`a new ${field} drops the profile's SSH secrets and every using connection's database password`, () => {
			const { stores: s, held, forgotten } = stores();
			const out = dropMovedTunnelSecrets(s, profile, after, {}, context([after]));
			assert.equal(out.changes.length, 1);
			assert.deepEqual([...held].sort(), ['c2:password']);
			assert.deepEqual(out.connections, ['c1']);
			// The pin belongs to the server, so only a move to another server forgets it.
			assert.deepEqual(forgotten, field === 'user' ? [] : ['bastion.internal:22']);
		});
	}

	test('an SSH secret typed in the same edit is kept', () => {
		const { stores: s, held } = stores();
		const out = dropMovedTunnelSecrets(s, profile, { ...profile, host: 'new.example' }, { sshPassword: true }, context());
		assert.deepEqual(out.dropped, ['sshPassphrase']);
		assert.equal(held.has('tunnel:p1:sshPassword'), true);
		assert.equal(held.has('c1:password'), false);
	});

	test('a rename, a key path or a keepalive change moves nothing', () => {
		const { stores: s, held, forgotten } = stores();
		const out = dropMovedTunnelSecrets(s, profile, { ...profile, name: 'renamed', privateKeyPath: '/k', keepAlive: false, host: ' bastion.internal ' }, {}, context());
		assert.deepEqual(out.changes, []);
		assert.equal(held.size, 5);
		assert.deepEqual(forgotten, []);
	});

	test('a pinned host key another profile or connection still uses is kept', () => {
		const sibling: SshTunnelProfile = { ...profile, id: 'p2', name: 'same bastion' };
		const inline: ConnectionConfig = { ...other, sshTunnel: { host: 'BASTION.internal', username: 'x' } };
		for (const [profiles, connections] of [[[sibling], [viaProfile]], [[], [viaProfile, inline]]] as const) {
			const { stores: s, forgotten } = stores();
			const out = dropMovedTunnelSecrets(s, profile, { ...profile, host: 'new.example' }, {}, context([...profiles], [...connections]));
			assert.equal(out.forgotHostKey, false);
			assert.deepEqual(forgotten, []);
		}
	});

	test('a new profile has nothing stored to drop', () => {
		const { stores: s, held } = stores();
		assert.deepEqual(dropMovedTunnelSecrets(s, undefined, profile, {}, context()).changes, []);
		assert.equal(held.size, 5);
	});
});

describe('a connection string saved with its password gives it to the keychain', () => {
	const mongo: ConnectionConfig = { id: 'm1', label: 'Docs', driver: 'mongodb', host: 'mongodb://app:s3cr%40t@db.example:27017/shop?authSource=admin', port: 0, username: '' };

	test('the password is stored under the connection and the URI is rewritten without it', () => {
		const stored: [string, string, string][] = [];
		const written: ConnectionConfig[] = [];
		const moved = moveUriPasswords([mongo, saved], { store: (id, kind, value) => stored.push([id, kind, value]) }, (config) => written.push(config));
		assert.deepEqual(moved, ['m1']);
		assert.deepEqual(stored, [['m1', 'password', 's3cr@t']]);
		assert.equal(written.length, 1);
		assert.equal(written[0].host, 'mongodb://app@db.example:27017/shop?authSource=admin');
		assert.equal(JSON.stringify(written).includes('s3cr'), false);
	});

	test('a keychain that refuses leaves the connection as it was, for the next launch', () => {
		const written: ConnectionConfig[] = [];
		const moved = moveUriPasswords([mongo], { store: () => { throw new Error('OS secret encryption is unavailable'); } }, (config) => written.push(config));
		assert.deepEqual(moved, []);
		assert.deepEqual(written, []);
	});

	test('nothing to move: nothing is written', () => {
		const written: ConnectionConfig[] = [];
		assert.deepEqual(moveUriPasswords([saved, { ...mongo, host: 'mongodb://app@db.example/shop' }], { store: () => undefined }, (config) => written.push(config)), []);
		assert.deepEqual(written, []);
	});
});

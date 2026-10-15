/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ConnectionConfig } from './connection';
import { describeConnectionEdit, destinationChanges, editConnectionApproval, formatChange, editTunnelApproval, type ConnectionDestination } from './connectionDestination';

const existing: ConnectionConfig = { id: 'c1', label: 'Shop', driver: 'postgres', host: 'db.internal', port: 5432, username: 'app', database: 'shop' };

describe('what an edit_connection call would change', () => {
	test('lists each changed field as before → after, and marks the ones that move the connection', () => {
		const changes = describeConnectionEdit(existing, { id: 'c1', host: 'evil.example', port: 5432, label: 'Shop 2' });
		assert.deepEqual(changes.map(formatChange), ['host: db.internal → evil.example', 'label: Shop → Shop 2']);
		assert.deepEqual(changes.map((c) => c.destination), [true, false]);
	});

	test('a connection string\'s password is masked on both sides of a host change', () => {
		const mongo: ConnectionConfig = { ...existing, driver: 'mongodb', host: 'mongodb://app:old@db.example/shop' };
		const line = editConnectionApproval(mongo, { id: 'c1', host: 'mongodb://app:n3w@evil.example/shop' });
		assert.match(line, /host: mongodb:\/\/app:\*\*\*\*@db\.example\/shop → mongodb:\/\/app:\*\*\*\*@evil\.example\/shop/);
		assert.doesNotMatch(line, /old@|n3w/);
		// The same string with only its password changed is still a change, and still moves it.
		assert.deepEqual(describeConnectionEdit(mongo, { id: 'c1', host: 'mongodb://app:other@db.example/shop' }).map((c) => c.destination), [true]);
	});

	test('the approval line names the connection, the changes and the removed password', () => {
		const line = editConnectionApproval(existing, { id: 'c1', host: 'evil.example' });
		assert.match(line, /^edit connection "Shop" \(host: db\.internal → evil\.example\)/);
		assert.match(line, /saved password is removed/);
		assert.doesNotMatch(editConnectionApproval(existing, { id: 'c1', readOnly: true }), /password/);
	});

	test('environment and read-only are safety changes, and the approval line says it is asked every time', () => {
		const changes = describeConnectionEdit({ ...existing, environment: 'prod', readOnly: true }, { id: 'c1', environment: 'dev', readOnly: false, label: 'Shop 2' });
		assert.deepEqual(changes.map(formatChange), ['label: Shop → Shop 2', 'environment: prod → dev', 'read-only: on → off']);
		assert.deepEqual(changes.map((c) => c.safety === true), [false, true, true]);
		assert.match(editConnectionApproval({ ...existing, environment: 'prod' }, { id: 'c1', environment: 'dev' }), /environment: prod → dev.*asked every time/);
	});

	test('a new user name is a move, and so is a new database where it says where the connection goes', () => {
		assert.deepEqual(describeConnectionEdit(existing, { id: 'c1', username: 'admin' }).map((c) => c.destination), [true]);
		// On Postgres the database is a database on the same server: not a move.
		assert.deepEqual(describeConnectionEdit(existing, { id: 'c1', database: 'other' }).map((c) => c.destination), [false]);
		for (const driver of ['sqlite', 'duckdb', 'db2', 'oracle', 'hana']) {
			const changes = describeConnectionEdit({ ...existing, driver }, { id: 'c1', database: 'X;HOSTNAME=attacker.example' });
			assert.deepEqual(changes.map((c) => [c.field, c.destination]), [['database', true]], driver);
			assert.match(editConnectionApproval({ ...existing, driver }, { id: 'c1', database: '/tmp/other.db' }), /saved password is removed/);
		}
	});

	test('the destination rule reads the user name and, per driver, the database', () => {
		const base: ConnectionDestination = { driver: 'postgres', host: 'h', port: 5432, username: 'app', database: 'shop' };
		assert.deepEqual(destinationChanges(base, { ...base, username: 'root' }).map((c) => c.field), ['username']);
		assert.deepEqual(destinationChanges(base, { ...base, database: 'other' }), []);
		const file: ConnectionDestination = { driver: 'sqlite', host: '', port: 0, database: '/a.db' };
		assert.deepEqual(destinationChanges(file, { ...file, database: '/b.db' }).map((c) => c.field), ['database']);
	});

	test('turning SSL off is a move', () => {
		const changes = describeConnectionEdit({ ...existing, ssl: { rejectUnauthorized: true } }, { id: 'c1', ssl: false });
		assert.equal(changes[0].field, 'ssl');
		assert.equal(changes[0].destination, true);
	});
});

describe('what an edit_tunnel call would change', () => {
	const tunnel = { id: 't1', name: 'bastion', host: 'bastion.internal', port: 22, username: 'ec2-user' };
	test('a move lists old → new and says what is removed', () => {
		const line = editTunnelApproval(tunnel, { id: 't1', host: 'evil.example', username: 'root' });
		assert.match(line, /^edit tunnel "bastion" \(ssh host: bastion\.internal → evil\.example; ssh user: ec2-user → root\)\. /);
		assert.match(line, /host key is trusted the first time/);
	});
	test('a rename is not a move', () => {
		assert.equal(editTunnelApproval(tunnel, { id: 't1', name: 'jump', port: 22 }), 'edit tunnel "bastion" (name: bastion → jump)');
	});
});

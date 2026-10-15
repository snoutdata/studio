/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { CapabilitySpec } from '../shared/capabilities';
import { asksEveryTime } from '../shared/capabilities';
import type { ConnectionConfig, SshTunnelProfile } from '../shared/connection';
import { agentActionDetail, agentCallGate, describeArguments } from './agentActionDetail';

/*
 * The approval card an external agent's app change raises. It must say WHAT the call does (which
 * project, which product, which setting and its new value), and a destructive or security-relevant
 * action must never be offered a standing yes.
 */

function spec(name: string, properties: Record<string, unknown>, extra: Partial<CapabilitySpec> = {}): CapabilitySpec {
	return { name, description: '', parameters: { type: 'object', properties }, domain: 'cloud', mutates: true, implicitConnection: 'none', returnsData: 'none', ...extra };
}

const none = (): ConnectionConfig[] => [];

describe('agentActionDetail', () => {
	test('deleting a cloud project names the project and is asked every time', () => {
		const detail = agentActionDetail(spec('delete_cloud_project', { project: {} }), { project: 'Orders' }, none);
		assert.deepEqual(detail.changes, ['project: Orders']);
		assert.equal(detail.askEveryTime, true);
	});

	test('switching a product names the project, the product and the new state', () => {
		const detail = agentActionDetail(
			spec('set_cloud_product', { project: {}, product: {}, enable: {} }),
			{ enable: false, product: 'storage', project: 'Orders' },
			none,
		);
		assert.deepEqual(detail.changes, ['project: Orders', 'product: storage', 'enable: false']);
		assert.equal(detail.askEveryTime, true);
	});

	test('a setting change shows the setting and its new value, and is never standing-approvable', () => {
		const detail = agentActionDetail(spec('set_setting', { key: {}, value: {} }, { domain: 'settings' }), { key: 'fontSize', value: 14 }, none);
		assert.deepEqual(detail.changes, ['setting: fontSize', 'new value: 14']);
		assert.equal(detail.askEveryTime, true);
	});

	test('anything a capability marks destructive is asked every time', () => {
		const detail = agentActionDetail(spec('drop_everything', { target: {} }, { destructive: true }), { target: 'x' }, none);
		assert.equal(detail.askEveryTime, true);
	});

	test('an ordinary change still lists its arguments and may be allowed for good', () => {
		const detail = agentActionDetail(spec('open_in_new_tab', { sql: {} }, { domain: 'editor' }), { sql: 'select 1' }, none);
		assert.deepEqual(detail.changes, ['sql: select 1']);
		assert.equal(detail.askEveryTime, false);
	});

	test('an edit that moves a connection is asked every time; a rename is not', () => {
		const conn = { id: 'c1', label: 'Orders', driver: 'postgres', host: 'db.internal', port: 5432, username: 'u' } as ConnectionConfig;
		const editSpec = spec('edit_connection', { id: {}, label: {}, host: {} }, { domain: 'connections' });
		const moved = agentActionDetail(editSpec, { id: 'c1', host: 'elsewhere' }, () => [conn]);
		assert.equal(moved.askEveryTime, true);
		assert.ok(moved.changes?.includes('host: db.internal → elsewhere'));
		assert.equal(agentActionDetail(editSpec, { id: 'c1', label: 'Orders 2' }, () => [conn]).askEveryTime, false);
	});

	test('a new user name, or a new file or Db2 database, is asked every time; a Postgres database is not', () => {
		const editSpec = spec('edit_connection', { id: {}, username: {}, database: {} }, { domain: 'connections' });
		const pg = { id: 'c1', label: 'Orders', driver: 'postgres', host: 'db.internal', port: 5432, username: 'u', database: 'shop' } as ConnectionConfig;
		assert.equal(agentActionDetail(editSpec, { id: 'c1', username: 'root' }, () => [pg]).askEveryTime, true);
		assert.equal(agentActionDetail(editSpec, { id: 'c1', database: 'other' }, () => [pg]).askEveryTime, false);
		for (const driver of ['sqlite', 'duckdb', 'db2', 'oracle', 'hana']) {
			const detail = agentActionDetail(editSpec, { id: 'c1', database: 'elsewhere' }, () => [{ ...pg, driver }]);
			assert.equal(detail.askEveryTime, true, driver);
			assert.match(detail.note ?? '', /saved password is removed/, driver);
		}
	});

	test('switching off production or read-only shows old → new and is asked every time, whatever was granted', () => {
		const conn = { id: 'c1', label: 'Orders', driver: 'postgres', host: 'db.internal', port: 5432, username: 'u', environment: 'prod', readOnly: true } as ConnectionConfig;
		const editSpec = spec('edit_connection', { id: {}, environment: {}, readOnly: {} }, { domain: 'connections' });
		const demoted = agentActionDetail(editSpec, { id: 'c1', environment: 'dev' }, () => [conn]);
		assert.equal(demoted.askEveryTime, true);
		assert.ok(demoted.changes?.includes('environment: prod → dev'));
		assert.match(demoted.note ?? '', /asked every time/);
		const writable = agentActionDetail(editSpec, { id: 'c1', readOnly: false }, () => [conn]);
		assert.equal(writable.askEveryTime, true);
		assert.ok(writable.changes?.includes('read-only: on → off'));
		// Setting a value it already has changes nothing, and asks nothing special.
		assert.equal(agentActionDetail(editSpec, { id: 'c1', environment: 'prod' }, () => [conn]).askEveryTime, false);
	});

	test('a monitor query names its connection, shows the SQL whole, and is asked every time', () => {
		const conn = { id: 'c1', label: 'Orders', driver: 'postgres', host: 'h', port: 5432, username: 'u', environment: 'prod' } as ConnectionConfig;
		const monitorSpec = spec('add_monitor_widget', { monitor: {}, title: {}, sql: {}, connectionId: {} }, { domain: 'monitors' });
		const sql = `select count(*) from orders where note = '${'x'.repeat(200)}'`;
		const detail = agentActionDetail(monitorSpec, { monitor: 'Ops', title: 'Orders', sql, connectionId: 'c1' }, () => [conn]);
		assert.equal(detail.askEveryTime, true);
		assert.ok(detail.changes?.includes('connection: Orders (prod)'));
		assert.ok(detail.changes?.includes(`sql: ${sql}`), 'never cut short');
		assert.ok(detail.changes?.includes('monitor: Ops'));
		assert.match(detail.note ?? '', /runs this query by itself/);
		assert.equal(asksEveryTime(monitorSpec), true);
		assert.equal(asksEveryTime({ name: 'create_monitor', domain: 'monitors' }), true);
	});
});

describe('describeArguments', () => {
	test('a credential is shown as present, never printed, and a long value is cut', () => {
		const lines = describeArguments(spec('x', { password: {}, note: {} }), { password: 'hunter2', note: 'a'.repeat(300) });
		assert.equal(lines[0], 'password: (hidden)');
		assert.ok(lines[1].length < 140);
	});

	test('undeclared arguments a model sent anyway are still shown', () => {
		assert.deepEqual(describeArguments(spec('x', {}), { surprise: 'yes' }), ['surprise: yes']);
	});
});

describe('asksEveryTime', () => {
	test('the named destructive actions are covered even without the flag', () => {
		for (const name of ['delete_cloud_project', 'set_cloud_product', 'set_setting', 'delete_tunnel', 'reset_cloud_password']) {
			assert.equal(asksEveryTime({ name, domain: 'x' }), true, name);
		}
		assert.equal(asksEveryTime({ name: 'open_in_new_tab', domain: 'editor' }), false);
	});
});

describe('testing settings that are not saved', () => {
	const testSpec = spec('test_connection_settings', { driver: {}, host: {}, port: {}, database: {}, username: {}, password: {}, ssl: {} }, { domain: 'connections', destructive: true });

	test('shows the whole address however long, hides the password, and never offers always', () => {
		const host = `${'a1b2c3d4'.repeat(20)}.attacker.example`;
		const detail = agentActionDetail(testSpec, { driver: 'postgres', host, port: 5432, username: 'svc', password: 'p', database: 'app' }, none);
		assert.ok(detail.changes?.includes(`address: ${host}:5432`), JSON.stringify(detail.changes));
		assert.ok(detail.changes?.includes('username: svc'));
		assert.ok(detail.changes?.includes('password: (given, hidden)'));
		assert.ok(!JSON.stringify(detail.changes).includes('"p"'));
		assert.equal(detail.askEveryTime, true);
		assert.match(detail.note ?? '', /not one of your saved connections/);
	});

	test('a file database names the whole path', () => {
		const path = '/Users/x/Library/LaunchAgents/com.example.made-up-by-a-model.db';
		const detail = agentActionDetail(testSpec, { driver: 'sqlite', database: path }, none);
		assert.ok(detail.changes?.includes(`file: ${path}`));
		assert.match(detail.note ?? '', /never creates/);
	});

	test('is asked every time even if a renderer forgot the flag', () => {
		assert.equal(asksEveryTime({ name: 'test_connection_settings', domain: 'connections' }), true);
	});

	test('moving a saved tunnel shows old → new, names the connections through it, and is asked every time', () => {
		const tunnel: SshTunnelProfile = { id: 't1', name: 'bastion', host: 'bastion.internal', username: 'ec2-user' };
		const conn: ConnectionConfig = { id: 'c1', label: 'Orders', driver: 'postgres', host: 'db', port: 5432, username: 'app', sshTunnelRef: 't1' };
		const editSpec = spec('edit_tunnel', { id: {}, name: {}, host: {}, port: {}, username: {} }, { domain: 'tunnels' });
		const moved = agentActionDetail(editSpec, { id: 't1', host: 'evil.example', port: 2222 }, () => [conn], () => [tunnel]);
		assert.deepEqual(moved.changes, ['tunnel: bastion', 'ssh host: bastion.internal → evil.example', 'ssh port: 22 → 2222', 'connections using it: Orders']);
		assert.match(moved.note ?? '', /database password of every connection/);
		assert.equal(moved.askEveryTime, true);
		// A tunnel main does not know is still asked about, with its arguments.
		assert.equal(agentActionDetail(editSpec, { id: 'gone', host: 'x' }, () => [conn], () => [tunnel]).askEveryTime, true);
		const renamed = agentActionDetail(editSpec, { id: 't1', name: 'jump' }, () => [conn], () => [tunnel]);
		assert.deepEqual(renamed.changes, ['tunnel: bastion', 'name: bastion → jump']);
		assert.equal(renamed.note, undefined);
	});
});

// An agent's call is matched to the capability the renderer published. One that is not published
// (yet, or any more) cannot be known to only read, so it never runs without a card.
describe('agentCallGate', () => {
	const read = spec('list_tabs', {}, { domain: 'editor', mutates: false });
	const change = spec('open_query_tab', { sql: {} }, { domain: 'editor' });

	test('a capability with no published spec is refused, not run unasked', () => {
		const gate = agentCallGate(undefined, {}, false);
		assert.equal(gate.kind, 'refuse');
		assert.match(gate.kind === 'refuse' ? gate.error : '', /not available/);
		assert.equal(agentCallGate(undefined, {}, true).kind, 'refuse');
	});

	test('a read runs, a change is asked about unless the user allowed it for good', () => {
		assert.equal(agentCallGate(read, {}, false).kind, 'run');
		assert.equal(agentCallGate(change, {}, false).kind, 'ask');
		assert.equal(agentCallGate(change, {}, true).kind, 'run');
		assert.equal(agentCallGate(change, { askEveryTime: true }, true).kind, 'ask');
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ConnectionConfig } from '../shared/connection';
import { gateMonitorCall, type MonitorGateOptions } from './monitorAgentGate';

/*
 * Before a model's monitor query reaches a card: only on a connection the caller may use, only a
 * read, and pinned to the connection the card will name.
 */

const conns = [
	{ id: 'c1', label: 'Orders', driver: 'postgres', host: 'h', port: 5432, username: 'u' },
	{ id: 'c2', label: 'Secret', driver: 'postgres', host: 'h', port: 5432, username: 'u' },
] as ConnectionConfig[];

const agent: MonitorGateOptions = { connections: conns, allowed: (id) => id === 'c1', allowedWhere: 'Settings, Agent access' };

describe('gateMonitorCall', () => {
	test('a read on an allowed connection goes on, pinned to its id', () => {
		const gate = gateMonitorCall('add_monitor_widget', { monitor: 'M', title: 't', sql: 'select 1', connectionId: 'orders' }, agent);
		assert.deepEqual(gate, { ok: true, arguments: { monitor: 'M', title: 't', sql: 'select 1', connectionId: 'c1' } });
	});

	test('a connection the user did not allow is refused', () => {
		const gate = gateMonitorCall('create_monitor', { name: 'M', title: 't', sql: 'select 1', connectionId: 'c2' }, agent);
		assert.equal(gate.ok, false);
		assert.match(gate.ok ? '' : gate.error, /"Secret" is not a connection the user has allowed/);
	});

	test('a write is refused, on any connection', () => {
		const gate = gateMonitorCall('create_monitor', { name: 'M', title: 't', sql: 'delete from orders', connectionId: 'c1' }, agent);
		assert.equal(gate.ok, false);
		assert.match(gate.ok ? '' : gate.error, /^Refused: a monitor only runs read-only queries/);
	});

	test('an agent must name the connection; the assistant falls back to its own', () => {
		assert.equal(gateMonitorCall('add_monitor_widget', { monitor: 'M', title: 't', sql: 'select 1' }, agent).ok, false);
		const gate = gateMonitorCall('add_monitor_widget', { monitor: 'M', title: 't', sql: 'select 1' }, { ...agent, fallbackConnectionId: 'c1' });
		assert.equal(gate.ok && gate.arguments.connectionId, 'c1');
	});

	test('an empty monitor and other capabilities pass untouched', () => {
		assert.deepEqual(gateMonitorCall('create_monitor', { name: 'M' }, agent), { ok: true, arguments: { name: 'M' } });
		assert.deepEqual(gateMonitorCall('delete_monitor', { monitor: 'M' }, agent), { ok: true, arguments: { monitor: 'M' } });
	});

	test('an unknown connection is named in the refusal', () => {
		const gate = gateMonitorCall('create_monitor', { name: 'M', title: 't', sql: 'select 1', connectionId: 'e2e-missing' }, agent);
		assert.match(gate.ok ? '' : gate.error, /No connection called "e2e-missing"/);
	});
});

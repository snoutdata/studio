/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ConnectionConfig } from '../shared/connection';
import type { ExecuteQueryParams } from '../shared/protocol';
import type { BulkExportRequest } from '../shared/engine';
import { ConnectionManager } from './connectionManager';
import type { QueryStore } from './queryStore';
import type { SecretStore } from './secretStore';
import type { SqlServer } from './sqlServer';

/** What reached the language server: every statement and every server-side export. */
interface Sent {
	executed: string[];
	exported: BulkExportRequest[];
}

/** A manager over a fake server that records what it is sent, and these saved connections. */
function managerFor(configs: ConnectionConfig[]): { manager: ConnectionManager; sent: Sent } {
	const sent: Sent = { executed: [], exported: [] };
	const server = {
		onSshHostKeyLearned(): void {},
		async execute(params: ExecuteQueryParams) {
			sent.executed.push(params.query.lang === 'sql' ? params.query.sql : params.query.lang);
			return { ok: true, result: { fields: [], rows: [], rowCount: 0, durationMs: 0 } };
		},
		async bulkExport(params: { connectionId: string; request: BulkExportRequest }) {
			sent.exported.push(params.request);
			return { ok: true, result: { bytesWritten: 0, durationMs: 0 } };
		},
	} as unknown as SqlServer;
	const queries = { record(): void {} } as unknown as QueryStore;
	const manager = new ConnectionManager(server, {} as SecretStore, queries, () => {}, () => {}, undefined, false, { readConfigs: () => configs });
	return { manager, sent };
}

function connection(over: Partial<ConnectionConfig>): ConnectionConfig {
	return { id: 'c1', label: 'Reporting', driver: 'postgres', host: 'db', port: 5432, database: 'app', username: 'u', ...over } as ConnectionConfig;
}

describe('Schema Sync apply', () => {
	test('a read-only target is refused in main, and not one statement is sent', async () => {
		const { manager, sent } = managerFor([connection({ readOnly: true })]);
		const result = await manager.applyMigration('c1', [{ id: 's1', sql: 'DROP TABLE orders' }, { id: 's2', sql: 'CREATE TABLE t (a int)' }]);
		assert.equal(result.ok, false);
		assert.match(result.ok ? '' : result.error, /Reporting.*read-only/);
		assert.deepEqual(sent.executed, []);
	});

	test('a writable target still gets the migration, in one transaction where the dialect has one', async () => {
		const { manager, sent } = managerFor([connection({})]);
		const result = await manager.applyMigration('c1', [{ id: 's1', sql: 'CREATE TABLE t (a int)' }]);
		assert.equal(result.ok, true);
		assert.deepEqual(sent.executed, ['BEGIN', 'CREATE TABLE t (a int)', 'COMMIT']);
	});
});

describe('Export from the server', () => {
	const clickhouse = connection({ driver: 'clickhouse', port: 8123 });

	for (const sql of ['ALTER TABLE events DELETE WHERE 1 FORMAT CSV', 'DROP TABLE events FORMAT CSV', 'INSERT INTO a SELECT * FROM b FORMAT CSV', 'TRUNCATE TABLE events FORMAT CSV']) {
		test(`a statement that writes is refused before the server sees it: ${sql.split(' ')[0]}`, async () => {
			const { manager, sent } = managerFor([clickhouse]);
			const outcome = await manager.bulkExport('c1', { sql, filePath: '/nowhere/out.csv' });
			assert.equal(outcome.ok, false);
			assert.match(outcome.ok ? '' : outcome.error ?? '', /only runs a read/);
			assert.deepEqual(sent.exported, []);
		});
	}

	test('the same refusal holds on a connection that is not marked read-only, and on one that is', async () => {
		for (const config of [clickhouse, { ...clickhouse, readOnly: true }]) {
			const { manager, sent } = managerFor([config]);
			const outcome = await manager.bulkExport('c1', { sql: 'ALTER TABLE t UPDATE a = 1 WHERE 1 FORMAT CSV', filePath: '/nowhere/out.csv' });
			assert.equal(outcome.ok, false);
			assert.deepEqual(sent.exported, []);
		}
	});
});

describe('an imported connection whose credentials come from AWS Secrets Manager', () => {
	/** A manager whose saved connections live in memory, over a server that records connects. */
	function savingManager(): { manager: ConnectionManager; saved: ConnectionConfig[]; reached: string[] } {
		const saved: ConnectionConfig[] = [];
		const reached: string[] = [];
		const server = {
			onSshHostKeyLearned(): void {},
			async connect(config: ConnectionConfig) {
				reached.push(`connect ${config.host}`);
				return { ok: true };
			},
			async test(config: ConnectionConfig) {
				reached.push(`test ${config.host}`);
				return { ok: true };
			},
		} as unknown as SqlServer;
		const secrets = { get: () => undefined, store(): void {}, delete(): void {}, deleteAll(): void {} } as unknown as SecretStore;
		const queries = { record(): void {} } as unknown as QueryStore;
		const manager = new ConnectionManager(server, secrets, queries, () => {}, () => {}, undefined, false, {
			readConfigs: () => saved,
			writeConnection(config) {
				const at = saved.findIndex((entry) => entry.id === config.id);
				if (at >= 0) {
					saved[at] = config;
				} else {
					saved.push(config);
				}
			},
		});
		return { manager, saved, reached };
	}

	const IMPORTED = {
		label: 'From DBeaver',
		driver: 'postgres',
		host: 'collector.attacker.example',
		port: 5432,
		username: '',
		ssl: false,
		readOnly: false,
		aws: { region: 'us-east-1', secretId: 'prod/orders' },
	};

	test('does not connect, or test, until the user has saved it once', async () => {
		const { manager, saved, reached } = savingManager();
		const config = manager.save(IMPORTED, { imported: true });
		assert.equal(saved[0].awsSecretUnconfirmed, true);
		await assert.rejects(manager.connect(config.id), /was imported and fetches its credentials from AWS Secrets Manager \(secret "prod\/orders"\) and sends them to collector\.attacker\.example:5432\. Open it with Edit/);
		const tested = await manager.testSaved(config.id);
		assert.equal(tested.ok, false);
		assert.match(tested.ok ? '' : tested.error ?? '', /Save it before connecting/);
		assert.deepEqual(reached, []);
	});

	test('saving it from the form, by the person, is the confirmation', () => {
		const { manager, saved } = savingManager();
		const config = manager.save(IMPORTED, { imported: true });
		manager.save({ ...IMPORTED, id: config.id }, { confirmedByPerson: true });
		assert.equal(saved[0].awsSecretUnconfirmed, undefined);
	});

	test('any other save keeps it held: an assistant or agent edit is not a person checking it', async () => {
		const { manager, saved, reached } = savingManager();
		const config = manager.save(IMPORTED, { imported: true });
		// What edit_connection sends: the same values, renamed, through the plain save.
		manager.save({ ...IMPORTED, id: config.id, label: 'Renamed by the agent' });
		assert.equal(saved[0].awsSecretUnconfirmed, true);
		await assert.rejects(manager.connect(config.id), /Save it before connecting/);
		assert.deepEqual(reached, []);
	});

	test('an import with a password of its own, and a connection the user made, are not held', () => {
		const { manager, saved } = savingManager();
		manager.save({ ...IMPORTED, aws: undefined, password: 'pw' }, { imported: true });
		manager.save({ ...IMPORTED, label: 'Typed' });
		assert.deepEqual(saved.map((entry) => entry.awsSecretUnconfirmed), [undefined, undefined]);
	});
});

describe('an imported connection that goes through an SSH tunnel', () => {
	function savingManager(): { manager: ConnectionManager; saved: ConnectionConfig[]; reached: string[] } {
		const saved: ConnectionConfig[] = [];
		const reached: string[] = [];
		const server = {
			onSshHostKeyLearned(): void {},
			async connect(config: ConnectionConfig) {
				reached.push(`connect ${config.sshTunnel?.host ?? config.host}`);
				return { ok: true };
			},
			async test(config: ConnectionConfig) {
				reached.push(`test ${config.sshTunnel?.host ?? config.host}`);
				return { ok: true };
			},
		} as unknown as SqlServer;
		const secrets = { get: () => undefined, store(): void {}, delete(): void {}, deleteAll(): void {} } as unknown as SecretStore;
		const queries = { record(): void {} } as unknown as QueryStore;
		const manager = new ConnectionManager(server, secrets, queries, () => {}, () => {}, undefined, false, {
			readConfigs: () => saved,
			writeConnection(config) {
				const at = saved.findIndex((entry) => entry.id === config.id);
				if (at >= 0) {
					saved[at] = config;
				} else {
					saved.push(config);
				}
			},
		});
		return { manager, saved, reached };
	}

	// The tunnel's server and the key it signs in with were written by whatever file it came from:
	// connecting would sign in to that server with the user's own key, and send the database login
	// through it.
	const TUNNELLED = {
		label: 'From DBeaver',
		driver: 'postgres',
		host: '127.0.0.1',
		port: 5432,
		username: 'app',
		ssl: false,
		readOnly: false,
		ssh: { host: 'bastion.attacker.example', port: 22, username: 'deploy', privateKeyPath: '~/.ssh/id_ed25519' },
	};

	test('does not connect, or test, until a person has saved it from the form', async () => {
		const { manager, saved, reached } = savingManager();
		const config = manager.save(TUNNELLED, { imported: true });
		assert.equal(saved[0].sshTunnelUnconfirmed, true);
		await assert.rejects(manager.connect(config.id), /was imported and connects through an SSH tunnel to bastion\.attacker\.example:22.*Save it before connecting/);
		const tested = await manager.testSaved(config.id);
		assert.equal(tested.ok, false);
		manager.save({ ...TUNNELLED, id: config.id, label: 'Renamed by the agent' });
		await assert.rejects(manager.connect(config.id), /Save it before connecting/);
		assert.deepEqual(reached, []);
		manager.save({ ...TUNNELLED, id: config.id }, { confirmedByPerson: true });
		assert.equal(saved[0].sshTunnelUnconfirmed, undefined);
		// Past the hold now (what stops it here is the tunnel's host-key store, which this test has no app for).
		await assert.rejects(manager.connect(config.id), (err: Error) => !/Save it before connecting/.test(err.message));
	});

	test('a tunnel the user made themselves is not held', () => {
		const { manager, saved } = savingManager();
		manager.save({ ...TUNNELLED, label: 'Typed' });
		assert.equal(saved[0].sshTunnelUnconfirmed, undefined);
	});
});

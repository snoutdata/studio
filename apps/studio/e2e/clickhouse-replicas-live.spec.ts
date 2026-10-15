/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { createServer, connect, type Server } from 'node:net';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

// ClickHouse with several replicas behind a balancer, which is what ClickHouse Cloud is: every HTTP
// request lands on any replica, and system tables and KILL are local to the one it lands on. The
// spec puts its own round-robin TCP balancer in front of two replicas, so the app sees what a Cloud
// user sees. Needs two servers in one `default` cluster, with Keeper for ON CLUSTER
// (`bash deploy/clickhouse-cluster/up.sh` brings them up):
//   SNOUTDATA_TEST_CLICKHOUSE_REPLICA_PORTS=58124,58125 SNOUTDATA_TEST_CLICKHOUSE_PASSWORD=pw npx playwright test clickhouse-replicas-live --project=app

const PORTS = (process.env.SNOUTDATA_TEST_CLICKHOUSE_REPLICA_PORTS ?? '').split(',').filter(Boolean).map(Number);
const PASSWORD = process.env.SNOUTDATA_TEST_CLICKHOUSE_PASSWORD ?? '';

test.skip(PORTS.length < 2, 'set SNOUTDATA_TEST_CLICKHOUSE_REPLICA_PORTS to two replicas of one cluster');

let handle: AppHandle;
let balancer: Server;
let balancerPort = 0;
let connectionId = '';

/** Each new connection goes to the next replica, as a load balancer would send it. */
function roundRobin(): Promise<Server> {
	let next = 0;
	const server = createServer((client) => {
		const upstream = connect(PORTS[next++ % PORTS.length], '127.0.0.1');
		client.pipe(upstream).pipe(client);
		client.on('error', () => upstream.destroy());
		upstream.on('error', () => client.destroy());
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Straight to one replica, for starting a query where the app is not looking and for checking. */
async function onReplica(port: number, sql: string): Promise<string> {
	const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
	return (await res.text()).trim();
}

/** Where a query id is running, on any replica. */
function runningAnywhere(queryId: string): Promise<string> {
	return onReplica(PORTS[0], `SELECT hostName() FROM clusterAllReplicas('default', system.processes) WHERE query_id = '${queryId}'`);
}

function longQuery(port: number, queryId: string): ReturnType<typeof spawn> {
	return spawn('curl', ['-s', '-u', `default:${PASSWORD}`, `http://127.0.0.1:${port}/?query_id=${queryId}`, '--data-binary', 'SELECT count() FROM numbers(100000000000000)'], { stdio: 'ignore' });
}

test.beforeAll(async () => {
	balancer = await roundRobin();
	const address = balancer.address();
	balancerPort = typeof address === 'object' && address ? address.port : 0;
	handle = await launchApp('clickhouse-replicas-live');
	connectionId = await handle.page.evaluate(async ({ port, password }: { port: number; password: string }) => {
		return (await window.sqlApi.saveConnection({ label: 'ch cloud', driver: 'clickhouse', host: '127.0.0.1', port, database: 'default', username: 'default', password, ssl: false, readOnly: false })).id;
	}, { port: balancerPort, password: PASSWORD });
});

test.afterAll(async () => {
	await closeApp(handle);
	balancer?.close();
});

test('Operations reads every replica, and stops a query on the one it did not land on', async () => {
	const { page } = handle;
	const row = page.locator('.tree-row.depth-0', { hasText: 'ch cloud' });
	await row.click();
	await row.hover();
	if (await row.locator('button[aria-label="Connect"]').count() > 0) {
		await row.locator('button[aria-label="Connect"]').click();
	}
	await expect(row.locator('button[aria-label="Disconnect"]')).toBeVisible({ timeout: 30_000 });
	const operations = page.locator('.tree-row.depth-1', { hasText: 'Operations' });
	if (!(await operations.isVisible())) {
		await row.locator('.twisty').click();
	}
	await operations.click();

	const panel = page.locator('.ch-ops');
	await expect(panel.locator('.ch-ops-scope')).toHaveText(`All ${PORTS.length} replicas`, { timeout: 30_000 });

	// One long query on each replica. Without clusterAllReplicas the view would show one of them,
	// a different one on each refresh.
	const ids = PORTS.map((_, i) => `replicas_e2e_${Date.now()}_${i}`);
	const outside = PORTS.map((port, i) => longQuery(port, ids[i]));
	try {
		await panel.locator('.tab', { hasText: 'Queries' }).click();
		await panel.locator('.ch-ops-view', { hasText: 'Running queries' }).click();
		await expect(panel.locator('.cell.head-cell', { hasText: /^replica$/ })).toBeVisible({ timeout: 15_000 });
		for (const id of ids) {
			await expect(panel.locator('.row', { hasText: id })).toBeVisible({ timeout: 15_000 });
		}
		await page.screenshot({ path: 'test-results/clickhouse-replicas-running.png' });

		// Stop each: KILL ... ON CLUSTER reaches the replica whichever one the request lands on.
		for (const id of ids) {
			const target = panel.locator('.row', { hasText: id });
			await target.locator('button[aria-label="Stop"]').click();
			await page.locator('.modal.confirm button', { hasText: 'Stop' }).click();
			await expect(target).toBeHidden({ timeout: 15_000 });
			await expect.poll(() => runningAnywhere(id), { timeout: 15_000 }).toBe('');
		}
	} finally {
		for (const child of outside) {
			child.kill();
		}
	}
});

test('Stop in the editor ends the query on whichever replica is running it', async () => {
	const { page } = handle;
	// Several rounds, since which replica the KILL lands on depends on the balancer's turn.
	for (let round = 0; round < 4; round++) {
		const marker = `editor_stop_${Date.now()}_${round}`;
		await page.evaluate(({ id, sql }: { id: string; sql: string }) => {
			(window as unknown as { __chRun: Promise<unknown> }).__chRun = window.sqlApi.execute({ connectionId: id, sql });
		}, { id: connectionId, sql: `SELECT count() AS ${marker} FROM numbers(100000000000000)` });
		await expect.poll(async () => onReplica(PORTS[0], `SELECT count() FROM clusterAllReplicas('default', system.processes) WHERE query LIKE '%AS ${marker} FROM%' AND is_initial_query AND query NOT LIKE '%clusterAllReplicas%'`), { timeout: 15_000 }).toBe('1');
		const outcome = await page.evaluate(async (id: string) => {
			await window.sqlApi.cancelQuery(id);
			return JSON.stringify(await (window as unknown as { __chRun: Promise<unknown> }).__chRun);
		}, connectionId);
		expect(outcome).toMatch(/cancel/i);
		await expect.poll(async () => onReplica(PORTS[0], `SELECT count() FROM clusterAllReplicas('default', system.processes) WHERE query LIKE '%AS ${marker} FROM%' AND is_initial_query AND query NOT LIKE '%clusterAllReplicas%'`), { timeout: 15_000 }).toBe('0');
	}
});

// The Cluster group's second half: the two queues and Keeper.
//
// These three cannot be driven against a single container, and ClickHouse Cloud cannot stand in
// either: Cloud stores tables as SharedMergeTree, so there is no replication queue of this kind, it
// has no Distributed tables to fill a distribution queue, and it hands out no Keeper. So they are
// here, against the two-node cluster `deploy/clickhouse-cluster/up.sh` brings up.
//
// Each queue is made to hold something ON PURPOSE rather than waited for: a queue is empty when
// everything is healthy, which is most of the time, and a view that has only ever been seen empty
// has not been seen at all. `SYSTEM STOP FETCHES` and `SYSTEM STOP DISTRIBUTED SENDS` are the two
// switches that hold work back without breaking anything, and both are put back afterwards.
test('the replication queue, the distributed queue and Keeper, each with something really in it', async () => {
	const { page } = handle;
	const panel = page.locator('.ch-ops');
	const a = PORTS[0];
	const b = PORTS[1];

	await onReplica(a, 'CREATE DATABASE IF NOT EXISTS q ON CLUSTER default');
	await onReplica(a, 'DROP TABLE IF EXISTS q.events_all ON CLUSTER default SYNC');
	await onReplica(a, 'DROP TABLE IF EXISTS q.events ON CLUSTER default SYNC');
	await onReplica(a, "CREATE TABLE q.events ON CLUSTER default (id UInt64) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/q/events', '{replica}') ORDER BY id");
	await onReplica(a, "CREATE TABLE q.events_all ON CLUSTER default AS q.events ENGINE = Distributed('default', 'q', 'events', rand())");

	try {
		// A replica that is not fetching: the part lands on ch-a and ch-b queues a GET_PART it will
		// not act on, which is exactly what "the replica is behind" looks like from the inside.
		await onReplica(b, 'SYSTEM STOP FETCHES q.events');
		await onReplica(a, 'INSERT INTO q.events VALUES (1), (2), (3)');
		await expect.poll(() => onReplica(b, "SELECT count() FROM system.replication_queue WHERE database = 'q'"), { timeout: 30_000 }).not.toBe('0');

		await panel.locator('.tab', { hasText: 'Cluster' }).click();
		await panel.locator('.ch-ops-view', { hasText: 'Replication queue' }).click();
		// The replica column is the point: the entry is stuck on ONE node, and which one is the
		// first thing to know.
		await expect(panel.locator('.cell.head-cell', { hasText: /^replica$/ })).toBeVisible({ timeout: 20_000 });
		await expect(panel.locator('.row', { hasText: 'events' }).first()).toBeVisible({ timeout: 20_000 });
		await page.screenshot({ path: 'test-results/clickhouse-replication-queue.png' });
		await onReplica(b, 'SYSTEM START FETCHES q.events');
		await expect.poll(() => onReplica(b, 'SELECT count() FROM q.events'), { timeout: 30_000 }).toBe('3');

		// Rows written to the Distributed table with the sends held back sit on disk as files.
		await onReplica(a, 'SYSTEM STOP DISTRIBUTED SENDS q.events_all');
		// `prefer_localhost_replica = 0` is what makes this a QUEUE rather than a local write: with
		// the default, a Distributed insert on a node that is itself a replica of the shard goes
		// straight into the local table and never becomes a file waiting to be sent.
		await onReplica(a, 'INSERT INTO q.events_all SETTINGS distributed_foreground_insert = 0, prefer_localhost_replica = 0 VALUES (4), (5)');
		await expect.poll(() => onReplica(a, "SELECT count() FROM system.distribution_queue WHERE database = 'q'"), { timeout: 30_000 }).not.toBe('0');

		await panel.locator('.ch-ops-view', { hasText: 'Distributed inserts' }).click();
		const pending = panel.locator('.row', { hasText: 'events_all' }).first();
		await expect(pending).toBeVisible({ timeout: 20_000 });

		// And the repair the view offers: send them now, from the screen.
		await onReplica(a, 'SYSTEM START DISTRIBUTED SENDS q.events_all');
		await pending.locator('button[title="Send now"]').click();
		await page.locator('.modal.confirm button', { hasText: 'Send now' }).click();
		await expect.poll(() => onReplica(a, 'SELECT count() FROM q.events_all'), { timeout: 30_000 }).toBe('5');

		// Keeper: the tree the whole thing agrees on, walked from the root to this table's replicas.
		await panel.locator('.ch-ops-view', { hasText: 'Keeper' }).click();
		await expect(panel.locator('.row', { hasText: 'clickhouse' }).first()).toBeVisible({ timeout: 20_000 });
		for (const step of ['clickhouse', 'tables', '01', 'q', 'events', 'replicas']) {
			await panel.locator('.row', { hasText: step }).first().locator('button[aria-label="Open"]').click();
			await expect(panel.locator('.ch-ops-crumb', { hasText: step })).toBeVisible({ timeout: 20_000 });
		}
		// Both replicas are registered under the table's node, which is what a queue that makes no
		// sense is checked against.
		await expect(panel.locator('.row', { hasText: 'ch-a' }).first()).toBeVisible({ timeout: 20_000 });
		await expect(panel.locator('.row', { hasText: 'ch-b' }).first()).toBeVisible();
		await page.screenshot({ path: 'test-results/clickhouse-keeper.png' });

		// The breadcrumb walks back up, and it is a path rather than a history: clicking the root
		// from six levels down lands at the root.
		await panel.locator('.ch-ops-crumb').first().click();
		await expect(panel.locator('.row', { hasText: 'clickhouse' }).first()).toBeVisible({ timeout: 20_000 });
		await expect(panel.locator('.ch-ops-crumb')).toHaveCount(1);
	} finally {
		await onReplica(b, 'SYSTEM START FETCHES q.events').catch(() => undefined);
		await onReplica(a, 'SYSTEM START DISTRIBUTED SENDS q.events_all').catch(() => undefined);
		await onReplica(a, 'DROP TABLE IF EXISTS q.events_all ON CLUSTER default SYNC').catch(() => undefined);
		await onReplica(a, 'DROP TABLE IF EXISTS q.events ON CLUSTER default SYNC').catch(() => undefined);
	}
});

// The server's own log: `system.text_log`, and the link to it from the query that failed.
//
// Here rather than in the single-node spec because logging to a table is OFF in a default install,
// and `deploy/clickhouse-cluster/up.sh` is where it is switched on (`logs.xml`). The single-node
// spec asserts the other half: that a server without it says which switch to throw.
test('a failed query is followed into the server log, where the rest of the story is', async () => {
	const { page } = handle;
	const panel = page.locator('.ch-ops');
	const a = PORTS[0];

	// A failure with a message nobody else on this server will have produced.
	const marker = `textlog_e2e_${Date.now()}`;
	await onReplica(a, `SELECT throwIf(1, '${marker}')`);
	// query_log and text_log are flushed on a timer, so the id exists before its rows do.
	await expect.poll(() => onReplica(a, `SELECT count() FROM system.query_log WHERE type = 'ExceptionWhileProcessing' AND query LIKE '%${marker}%'`), { timeout: 30_000 }).not.toBe('0');
	const queryId = await onReplica(a, `SELECT argMax(query_id, event_time) FROM system.query_log WHERE type = 'ExceptionWhileProcessing' AND query LIKE '%${marker}%'`);
	expect(queryId).not.toBe('');
	await expect.poll(() => onReplica(a, `SELECT count() FROM system.text_log WHERE query_id = '${queryId}'`), { timeout: 30_000 }).not.toBe('0');

	await panel.locator('.tab', { hasText: 'Server' }).click();
	await panel.locator('.ch-ops-view', { hasText: 'Server log' }).click();
	await expect(panel.locator('.cell.head-cell', { hasText: /^level$/ })).toBeVisible({ timeout: 20_000 });

	// Narrowed to that one query: every line it produced, at every level, which is the whole
	// point. Unfiltered this view is warnings and worse, and most of these are not.
	await panel.locator('.ch-ops-filter input').fill(queryId);
	await expect(panel.locator('.row', { hasText: marker }).first()).toBeVisible({ timeout: 20_000 });
	await page.screenshot({ path: 'test-results/clickhouse-server-log.png' });

	// And the way somebody actually gets here: from the failure itself, without copying an id.
	await panel.locator('.ch-ops-filter .icon-btn').click();
	await panel.locator('.tab', { hasText: 'Queries' }).click();
	await panel.locator('.ch-ops-view', { hasText: 'Failed queries' }).click();
	const failure = panel.locator('.row', { hasText: 'FUNCTION_THROW_IF_VALUE_IS_NON_ZERO' }).first();
	await expect(failure).toBeVisible({ timeout: 20_000 });
	await failure.locator('button[title="Server log"]').click();
	await expect(panel.locator('.ch-ops-view.active')).toHaveText('Server log', { timeout: 20_000 });
	await expect(panel.locator('.ch-ops-filter input')).toHaveValue(/.+/);
	await expect(panel.locator('.row', { hasText: marker }).first()).toBeVisible({ timeout: 20_000 });
});

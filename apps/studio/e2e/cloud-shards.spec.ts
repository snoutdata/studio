/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { launchApp, closeApp, type AppHandle } from './helpers';

/*
 * A cloud project's Cluster section, driven end to end against a FAKE control plane on 127.0.0.1
 * (`SNOUT_E2E_CLOUD_API`, honoured only under a scratch profile, as in cloud-panel.spec.ts). The
 * real IPC, the real `cloudProjectOps` forwarding and the real section; only
 * `cloud-project-shards` is played here, in the shapes it answers in.
 *
 * What is asserted is the rule the section exists for: nothing runs on a click. Every operation
 * is planned first and shown, and only Run sends anything but `plan: true`. The assistant's
 * proposal lands in the same review and runs nothing by itself.
 */

let handle: AppHandle;
let server: Server;
/** Every body the app sent to cloud-project-shards. */
let shardCalls: Record<string, unknown>[] = [];

const REF = 'aaaaaaaaaaaaa';
const MIN = '-9223372036854775808';

const PLAN = {
	op: 'range.split',
	steps: [{ kind: 'catalog', args: {} }, { kind: 'transfer', args: {} }],
	moves: [{ source: 1, targets: [2], tables: ['app.ledger'], estimated_rows: 1200, estimated_bytes: 64000, estimated_copy_seconds: 1, expected_pause_ms: 70 }],
	cutovers: 1,
	estimated_rows: 1200,
	estimated_bytes: 64000,
	estimated_copy_seconds: 1,
	expected_pause_ms: 70,
	max_write_pause_ms: 2000,
	warnings: [],
};

const STATUS = {
	ref: REF,
	sharded: true,
	projectsUsed: 2,
	maxProjects: 5,
	tier: 'pro',
	desiredNodes: 2,
	maxWritePauseMs: 2000,
	routerError: null,
	pods: [{ ref: 'bbbbbbbbbbbbb', ordinal: 2, state: 'ready', desiredState: 'running', hasOwnBackup: true, standbyOf: REF, node: { id: 2, state: 'active' }, next: null }],
	cluster: {
		catalog: true,
		epoch: 4,
		nodes: [
			{ id: 1, name: 'home', host: '127.0.0.1', port: 5432, dbname: REF, home: true, state: 'active', server_version_num: 180000, ranges: [{ keyspace: 'acct', lo: MIN, hi: '-1' }] },
			{ id: 2, name: 'bbbbbbbbbbbbb', host: 'snoutpod-bbbbbbbbbbbbb', port: 5432, dbname: REF, home: false, state: 'active', server_version_num: 180000, ranges: [{ keyspace: 'acct', lo: '0', hi: '9223372036854775807' }] },
		],
		keyspaces: [{ name: 'acct', key_type: 'bigint', seed: '4242', pins: [], ranges: [{ lo: MIN, hi: '-1', node: 1 }, { lo: '0', hi: '9223372036854775807', node: 2 }] }],
		tables: [{ table: 'app.ledger', kind: 'sharded', keyspace: 'acct', column: 'acct' }],
	},
};

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		let raw = '';
		req.on('data', (chunk) => { raw += String(chunk); });
		req.on('end', () => {
			try {
				resolve(JSON.parse(raw || '{}') as Record<string, unknown>);
			} catch {
				resolve({});
			}
		});
	});
}

test.beforeAll(async () => {
	server = createServer((req, res) => {
		void (async () => {
			const body = await readBody(req);
			const path = (req.url ?? '').replace(/^\//, '').split('?')[0];
			if (path === 'account') {
				send(res, 200, { account: 'alex@example.com' });
				return;
			}
			if (path === 'cloud-project-list') {
				send(res, 200, { projects: [{
					ref: REF, name: 'ledger', region: 'us-west-2', production: false, state: 'ready', desiredState: 'running', wakesInstantly: true,
					readOnly: false, sizeBytes: 9_000_000, createdAt: '2026-10-01T10:00:00Z', lastConnectionAt: null,
					host: `${REF}.db.snoutdata.com`, database: REF, user: `${REF}_owner`,
				}] });
				return;
			}
			if (path === 'cloud-project-shards') {
				shardCalls.push(body);
				const action = String(body.action);
				if (action === 'status') {
					send(res, 200, STATUS);
				} else if (action === 'jobs') {
					send(res, 200, { jobs: [{ id: 6, op: 'range.move', state: 'running', error: null, created_at: '2026-10-05T10:00:00Z', finished_at: null, steps: 4, steps_done: 1 }] });
				} else if (action === 'advice') {
					send(res, 200, {
						summary: '1 recommendation.',
						advice: [{ op: 'range.split', request: { op: 'range.split', keyspace: 'acct', range: '0' }, reason: 'bbbbbbbbbbbbb holds most of acct', metric: 'size', needs: [], plan: PLAN }],
						facts: { sampled_ms: 0, nodes: [{ id: 1, name: 'home', active: true, db_bytes: 4_000_000, connections: 3, max_connections: 100, writes_per_s: 0, error: null }], ranges: [] },
						assumptions: 'Thresholds are chosen, not measured.',
					});
				} else if (body.plan === true) {
					send(res, 200, PLAN);
				} else {
					send(res, 200, { job: 7, plan: PLAN });
				}
				return;
			}
			send(res, 404, { error: `no such path: ${path}` });
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	handle = await launchApp('cloud-shards', { env: { SNOUT_E2E_CLOUD_API: api } });
});

test.afterAll(async () => {
	await closeApp(handle);
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

const view = () => handle.page.locator('.cloud-project-view');

test('a cluster project lists Cluster, and the section draws its cluster nodes, ranges, jobs and advice', async () => {
	const page = handle.page;
	await page.click('.activity-bar button[aria-label="Dashboard"]');
	const header = page.locator('.sidebar-header', { hasText: 'DASHBOARD' });
	await expect(header).toBeVisible();
	await header.locator('button:is([title="Refresh"], [aria-label="Refresh"])').click();
	const panel = page.locator('.sidebar', { has: header });
	await panel.locator('.tree-row:has-text("ledger")').click();
	// Gated: never in the tree, only in the tab once the control plane offers it.
	await expect(panel.locator('.tree-row.depth-2', { hasText: /^Cluster$/ })).toHaveCount(0);
	await panel.locator('.tree-row.depth-2', { hasText: /^Logs$/ }).click();
	await view().locator('.settings-nav-item:has-text("Cluster")').click();

	await expect(view().locator('.settings-section-title')).toHaveText('Cluster');
	await expect(view().locator('.shards-bar > span')).toHaveCount(2);
	await expect(view()).toContainText('2 of 5 project slots used on the pro plan');
	await expect(view()).toContainText('range.move');
	await expect(view()).toContainText('bbbbbbbbbbbbb holds most of acct');
	await page.screenshot({ path: 'test-results/cloud-shards-section.png' });
});

test('an operation is planned and shown before it runs, and only Run sends it', async () => {
	shardCalls = [];
	const keyspace = view().locator('fieldset', { hasText: 'Keyspace acct' });
	await keyspace.locator('button:has-text("Move")').first().click();
	const review = view().locator('fieldset.shards-review');
	await expect(review).toContainText('Move a range');
	await review.locator('select').selectOption('bbbbbbbbbbbbb');
	await review.locator('button:has-text("Show the plan")').click();
	await expect(review).toContainText('1 cutover, about 1,200 rows');
	expect(shardCalls.filter((c) => c.action === 'move')).toEqual([
		{ ref: REF, action: 'move', request: { keyspace: 'acct', range: MIN, to: 'bbbbbbbbbbbbb' }, plan: true },
	]);
	await page().screenshot({ path: 'test-results/cloud-shards-review.png' });
	await review.locator('button.danger:has-text("Move")').click();
	await expect(view()).toContainText('Job 7 started');
	expect(shardCalls.filter((c) => c.action === 'move' && c.plan === undefined)).toHaveLength(1);
});

test('the assistant proposes; the review opens filled in, and nothing has run', async () => {
	shardCalls = [];
	const result = await handle.page.evaluate(() => (window as unknown as {
		__snoutDebugCapability(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; summary: string }>;
	}).__snoutDebugCapability('propose_cloud_cluster_operation', { project: 'ledger', operation: { op: 'range.split', keyspace: 'acct', range: '0' }, reason: 'The node holding acct is filling up.' }));
	expect(result.ok).toBe(true);
	const review = view().locator('fieldset.shards-review');
	await expect(review).toContainText('Split a range');
	await expect(review).toContainText('The node holding acct is filling up.');
	await expect(review).toContainText('1 cutover');
	// Planned twice (the tool, then the review), never run.
	expect(shardCalls.filter((c) => c.action === 'split').every((c) => c.plan === true)).toBe(true);
	await review.locator('button:has-text("Cancel")').click();
	await expect(review).toHaveCount(0);
});

function page() {
	return handle.page;
}

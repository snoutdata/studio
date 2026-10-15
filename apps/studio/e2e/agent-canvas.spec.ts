/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

import { launchApp, closeApp, MOD, type AppHandle } from './helpers';

/*
 * A coding agent DRAWING into the app.
 *
 * Like agent-capabilities.spec.ts, THIS SPEC IS THE AGENT: it speaks JSON-RPC to the local MCP
 * endpoint on 127.0.0.1 and every assertion is on the real window afterwards. It also names itself
 * `claude-code` at initialize, which is how the app knows which console to draw into.
 *
 * WHERE it draws is what this spec pins down (docking.ts, `agentSurfaceHome`): a console in the
 * bottom strip draws into its own workbench TAB beside the editor, and a console the user has moved
 * to a side draws into a PANEL above its terminal. The default layout puts consoles at the bottom,
 * so most of this file is the tab, and the move near the end is the panel.
 *
 * A fake agent binary is put on PATH so the console exists without Claude Code being installed on
 * the machine running this. The agent process itself is irrelevant here: the drawing goes through
 * MCP, not through the terminal.
 */

interface Endpoint { url: string; token: string }

/** A stand-in agent, so the Claude Code console is present and startable. */
function fakeAgent(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), 'snout-canvas-agent-'));
	const script = join(dir, 'fake-agent.js');
	writeFileSync(script, `
if (process.argv.slice(2).includes('--version')) { process.stdout.write('9.9.9 (Fake Agent)\\n'); process.exit(0); }
process.stdout.write('FAKE AGENT READY\\r\\n');
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`, 'utf8');
	if (process.platform === 'win32') {
		const path = join(dir, 'claude.cmd');
		writeFileSync(path, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
		return { dir, path };
	}
	const path = join(dir, 'claude');
	writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
	chmodSync(path, 0o755);
	return { dir, path };
}

async function endpoint(handle: AppHandle): Promise<Endpoint> {
	await expect
		.poll(async () => handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { mcp: { status(): Promise<{ running: boolean }> } } }).sqlApi;
			return (await api.mcp.status()).running;
		}), { timeout: 20_000 })
		.toBe(true);
	return handle.page.evaluate(async () => {
		const api = (window as unknown as { sqlApi: { mcp: { status(): Promise<{ url: string; token: string }> } } }).sqlApi;
		const status = await api.mcp.status();
		return { url: status.url, token: status.token };
	});
}

async function rpc(ep: Endpoint, body: unknown): Promise<{ result?: Record<string, unknown> }> {
	const res = await fetch(ep.url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	return text ? JSON.parse(text) : {};
}

/** Say who we are, the way a real client does: the name is what routes a push to a console. */
async function initialize(ep: Endpoint, name: string): Promise<void> {
	await rpc(ep, {
		jsonrpc: '2.0', id: 0, method: 'initialize',
		params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name, version: '1.0.0' } },
	});
}

async function callTool(ep: Endpoint, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
	const res = await rpc(ep, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
	const result = res.result as { content: { text: string }[]; isError: boolean };
	return { text: result.content[0].text, isError: result.isError };
}

const CHART = JSON.stringify({ type: 'bar', x: 'day', series: [{ key: 'hits' }], data: [{ day: 'Mon', hits: 3 }] });

test.describe.serial('an agent drawing into the app', () => {
	let handle: AppHandle;
	let agent: { dir: string; path: string };
	let ep: Endpoint;

	test.beforeAll(async () => {
		agent = fakeAgent();
		const path = `${agent.dir}${delimiter}${process.env.PATH ?? ''}`;
		handle = await launchApp('agent-canvas', { env: { PATH: path, Path: path } });
		ep = await endpoint(handle);
		await initialize(ep, 'claude-code');
		// Open the console so there is somewhere to look. The surface itself is absent until the
		// agent draws, which is the first thing asserted.
		await handle.page.click('.activity-item[aria-label="Claude Code console"]');
		await handle.page.waitForSelector('.agent-console');
	});

	test.afterAll(async () => {
		await closeApp(handle);
		rmSync(agent.dir, { recursive: true, force: true });
	});

	test('the tool is offered to an external agent, with no approval attached', async () => {
		const res = await rpc(ep, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
		const tools = (res.result?.tools ?? []) as { name: string; description: string }[];
		const draw = tools.find((t) => t.name === 'show_in_app');
		expect(draw).toBeDefined();
		// Non-mutating, so its description carries no "currently refused" rider and no toast appears
		// when it is called (asserted by every other test here answering immediately).
		expect(draw?.description).not.toMatch(/Changes the app/);
	});

	test('a console with nothing drawn has no surface at all', async () => {
		await expect(handle.page.locator('.agent-canvas')).toHaveCount(0);
		await expect(handle.page.locator('.tab-item', { hasText: 'Claude Code' })).toHaveCount(0);
	});

	test('the first push opens the agent its own tab, beside the editor', async () => {
		const out = await callTool(ep, 'show_in_app', { markdown: '## Findings\n\nThe orders table has no index on `placed_at`.', title: 'Findings' });
		expect(out.isError).toBe(false);
		// The console is at the bottom (the default layout), a strip too short to be a terminal and a
		// reading surface at once, so what it draws opens in the workbench instead.
		await expect(handle.page.locator('.tab-item', { hasText: 'Claude Code' })).toHaveCount(1);
		await expect(handle.page.locator('.agent-canvas-host .agent-canvas')).toBeVisible({ timeout: 10_000 });
		await expect(handle.page.locator('.agent-canvas')).toContainText('no index on');
		await expect(handle.page.locator('.agent-canvas-head')).toContainText('Claude Code');
		// And the console says where its output went, for anyone looking at the terminal.
		await expect(handle.page.locator('.agent-console-shown')).toBeVisible();
	});

	test('the agent draws into its OWN surface, not the assistant thread', async () => {
		// Writing into the assistant conversation would read as the assistant saying things it never
		// said, so the two threads stay apart however many AIs are talking.
		await expect(handle.page.locator('.chat-panel .agent-canvas')).toHaveCount(0);
		await expect(handle.page.locator('.chat-panel')).not.toContainText('no index on');
	});

	test('a sql fence becomes a card with Copy and Insert, not a code block', async () => {
		const out = await callTool(ep, 'show_in_app', { markdown: 'Try this:\n```sql\nselect 1 from dual;\n```' });
		expect(out.isError).toBe(false);
		// The tool tells the agent what it will LOOK like, so it writes differently next time.
		expect(out.text).toMatch(/1 SQL card/);
		const card = handle.page.locator('.agent-canvas .sql-block').last();
		await expect(card).toBeVisible({ timeout: 10_000 });
		await expect(card.locator('button:is([title="Copy"], [aria-label="Copy"])')).toBeVisible();
		await expect(card.locator('button[aria-label="Insert into editor"]')).toBeVisible();
	});

	test('Insert into editor really puts the agent\'s SQL in the editor', async () => {
		await handle.page.locator('.agent-canvas .sql-block').last().locator('button[aria-label="Insert into editor"]').click();
		await expect.poll(async () => handle.page.evaluate(() => {
			const debug = (window as unknown as { __snoutDebugAmbient?: () => { editorBuffer?: string } }).__snoutDebugAmbient;
			return debug ? (debug().editorBuffer ?? '') : '';
		}), { timeout: 10_000 }).toContain('select 1 from dual');
	});

	test('the insert lands the cursor on what it inserted, not at the top of a long script', async () => {
		const { page } = handle;
		// SQL is appended at the END of the document. In a script of any length that is off-screen, so
		// an insert that leaves the cursor and the view at line 1 looks like nothing happened.
		await page.locator('.monaco-editor').first().click();
		await page.keyboard.press(`${MOD}+a`);
		await page.keyboard.type('-- filler\n'.repeat(60));
		await page.locator('.tab-item', { hasText: 'Claude Code' }).click();
		await page.locator('.agent-canvas .sql-block').last().locator('button[aria-label="Insert into editor"]').click();
		// The cursor is on the last line of the buffer, which is where the SQL now ends.
		const lines = await page.evaluate(() => {
			const debug = (window as unknown as { __snoutDebugAmbient?: () => { editorBuffer?: string } }).__snoutDebugAmbient;
			return (debug?.().editorBuffer ?? '').split('\n').length;
		});
		expect(lines).toBeGreaterThan(60);
		await expect(page.locator('.status-item[title="Cursor position"]')).toHaveText(new RegExp(`Ln ${lines},`));
	});

	test('a later push marks the tab instead of stealing the screen', async () => {
		// Insert put the user in the editor. An agent that yanked them back out of it on its next
		// push would be unusable during any long task, so the tab is MARKED and stays put.
		await expect(handle.page.locator('.tab-item.active', { hasText: 'Claude Code' })).toHaveCount(0);
		await callTool(ep, 'show_in_app', { markdown: 'And one more finding.' });
		await expect(handle.page.locator('.tab-item.attention', { hasText: 'Claude Code' })).toHaveCount(1);
		// Opening it is reading it.
		await handle.page.locator('.tab-item', { hasText: 'Claude Code' }).click();
		await expect(handle.page.locator('.tab-item.attention', { hasText: 'Claude Code' })).toHaveCount(0);
		await expect(handle.page.locator('.agent-canvas')).toContainText('And one more finding.');
	});

	test('Run is withheld while nothing is connected', async () => {
		// A Run button that cannot run is worse than no button. Nothing is connected in this
		// profile, so the card offers Copy and the two inserts and stops there.
		await expect(handle.page.locator('.agent-canvas .sql-block button[aria-label="Run"]')).toHaveCount(0);
	});

	test('a chart fence renders a chart', async () => {
		const out = await callTool(ep, 'show_in_app', { markdown: `Here:\n\`\`\`chart\n${CHART}\n\`\`\`` });
		expect(out.text).toMatch(/1 chart/);
		await expect(handle.page.locator('.agent-canvas .chart-block, .agent-canvas .recharts-wrapper').first()).toBeVisible({ timeout: 10_000 });
	});

	test('pushes accumulate, and clear starts a fresh surface', async () => {
		const before = await handle.page.locator('.agent-canvas .chat-msg').count();
		await callTool(ep, 'show_in_app', { markdown: 'One more thing.' });
		await expect(handle.page.locator('.agent-canvas .chat-msg')).toHaveCount(before + 1);
		await callTool(ep, 'show_in_app', { markdown: 'Starting over.', clear: true });
		await expect(handle.page.locator('.agent-canvas .chat-msg')).toHaveCount(1);
		await expect(handle.page.locator('.agent-canvas')).toContainText('Starting over');
	});

	test('an empty push is an error, unless it is a clear', async () => {
		const empty = await callTool(ep, 'show_in_app', { markdown: '   ' });
		expect(empty.isError).toBe(true);
		const cleared = await callTool(ep, 'show_in_app', { markdown: '', clear: true });
		expect(cleared.isError).toBe(false);
		// A tab the user has open is not closed under them: it says why it is empty instead.
		await expect(handle.page.locator('.agent-canvas-empty')).toBeVisible();
		await expect(handle.page.locator('.tab-item', { hasText: 'Claude Code' })).toHaveCount(1);
	});

	test('moving the console to a side takes the surface with it, tab and all', async () => {
		await callTool(ep, 'show_in_app', { markdown: 'Still here after the move.' });
		await expect(handle.page.locator('.agent-canvas')).toContainText('Still here after the move.', { timeout: 10_000 });
		await handle.page.locator('.agent-console .pane-header').first().click({ button: 'right' });
		await handle.page.locator('.panel-menu-item', { hasText: 'Move to right' }).click();
		await expect(handle.page.locator('.panel-menu')).toHaveCount(0);
		// A side dock is the assistant shape, so the agent gets the assistant arrangement: its thread
		// above, its terminal below. ONE destination, so the tab goes away rather than showing the same
		// push in a second place. (The console is mounted once and portalled, so the
		// move must not remount the surface and lose what was drawn, which the text below asserts.)
		await expect(handle.page.locator('.agent-console .agent-canvas')).toContainText('Still here after the move.');
		await expect(handle.page.locator('.tab-item', { hasText: 'Claude Code' })).toHaveCount(0);
		await expect(handle.page.locator('.agent-console-shown')).toHaveCount(0);
	});

	test('the Clear button empties it', async () => {
		await handle.page.click('.agent-canvas-head button[aria-label="Clear what is shown"]');
		// In a panel the surface is absent until something is drawn: an empty box above every terminal
		// would be a permanent tax on the consoles that never use it.
		await expect(handle.page.locator('.agent-canvas')).toHaveCount(0);
	});
});

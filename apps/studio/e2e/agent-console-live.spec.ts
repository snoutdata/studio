/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launchApp, closeApp, type AppHandle } from './helpers';

/*
 * The Agent Console against the REAL agent binary.
 *
 * Opt-in, like the other live specs: it needs Claude Code installed and signed in on this machine,
 * and it starts a real agent process. It sends the agent no prompt, so it spends nothing; what it
 * proves is the half a fake binary cannot — that the real executable is found, launches under a
 * PTY, and draws its TUI in our terminal.
 *
 *   SNOUTDATA_E2E_LIVE_AGENT=1 npx playwright test agent-console-live
 */

const skip = process.env.SNOUTDATA_E2E_LIVE_AGENT
	? null
	: 'set SNOUTDATA_E2E_LIVE_AGENT=1 to run against the real Claude Code on this machine';

test.describe('agent console (live agent)', () => {
	test.skip(skip !== null, skip ?? '');

	let handle: AppHandle;

	test.beforeAll(async () => {
		handle = await launchApp('agent-console-live');
	});

	test.afterAll(async () => {
		await closeApp(handle);
	});

	test('finds the installed agent, starts it, and draws its interface', async () => {
		await handle.page.keyboard.press('ControlOrMeta+Shift+P');
		await handle.page.fill('.palette input', 'Agent Console');
		await handle.page.keyboard.press('Enter');
		await handle.page.waitForSelector('.agent-console');

		// Discovery ran the real binary: whatever version is installed is what the panel reports.
		await expect(handle.page.locator('.agent-console-version')).toContainText(/\d+\.\d+/, { timeout: 20_000 });

		await handle.page.click('.agent-console-actions button.primary');
		// The TUI paints something within a few seconds. Deliberately not asserting on a specific
		// string: Claude Code's welcome screen is theirs to change, and this spec is about our PTY.
		await expect
			.poll(async () => (await handle.page.locator('.agent-console-term .xterm-rows').innerText()).trim().length, { timeout: 60_000 })
			.toBeGreaterThan(20);
		await handle.page.screenshot({ path: 'e2e/.results/agent-console-live.png' });
		// Dump what the real agent printed: this is where a complaint about the settings/MCP files
		// we generate for it shows up, and it is worth reading after any change to that handoff.
		writeFileSync('e2e/.results/agent-console-live.txt', await handle.page.locator('.agent-console-term').innerText(), 'utf8');

		const status = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { statuses(): Promise<Array<{ kind: string; running: boolean; mcpWired: boolean }>> } } }).sqlApi;
			return (await api.agentConsole.statuses()).find((s) => s.kind === 'claude');
		});
		expect(status?.running).toBe(true);
		// The broker is on by default, so a live console should be wired to it with no setup.
		expect(status?.mcpWired).toBe(true);
	});

	test('an image on the clipboard pastes into the real agent', async () => {
		// The half a fake binary cannot prove, and the half that was wrong: WHICH key Claude Code
		// binds to "read the clipboard yourself". On Windows it is alt+v (ESC v), not ctrl+v, so
		// the obvious guess produced a console where pasting a screenshot did nothing at all and
		// said nothing about it. This asserts on the agent's own answer, `[Image #1]`.
		await handle.app.evaluate(({ clipboard, nativeImage }, iconPath) => {
			clipboard.clear();
			clipboard.writeImage(nativeImage.createFromPath(iconPath));
		}, join(process.cwd(), 'build', 'icon.png'));
		await handle.page.click('.agent-console-term .xterm-screen');
		// Claude Code asks about the folder before it shows a prompt, and a scratch workspace in the
		// temp directory is exactly what it should ask about. Answer it, then paste.
		if ((await handle.page.locator('.agent-console-term').innerText()).includes('I trust this folder')) {
			await handle.page.keyboard.press('ArrowDown');
			await handle.page.keyboard.press('Enter');
			await expect
				.poll(async () => handle.page.locator('.agent-console-term').innerText(), { timeout: 30_000 })
				.not.toContain('I trust this folder');
		}
		// Let the TUI finish drawing before pasting. A key sent while it is still starting up is
		// simply dropped, which reads exactly like the wrong key having been sent.
		await expect
			.poll(async () => handle.page.locator('.agent-console-term').innerText(), { timeout: 60_000 })
			.toContain('Context');
		await handle.page.waitForTimeout(3000);
		await handle.page.keyboard.press('ControlOrMeta+v');
		await expect
			.poll(async () => handle.page.locator('.agent-console-term').innerText(), { timeout: 30_000 })
			.toContain('[Image #1]');
		await handle.page.screenshot({ path: 'e2e/.results/agent-console-live-paste.png' });
	});
});

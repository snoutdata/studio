/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

import { launchApp, closeApp, type AppHandle } from './helpers';

/*
 * Dockable panels.
 *
 * The property worth a suite is not "the CSS moved": it is that a panel KEEPS ITS STATE when it
 * moves. A remounted assistant is a lost conversation and a remounted console is a terminal
 * that lost its screen, and both would look almost right in a screenshot, so the console test
 * below moves a LIVE agent and asserts its transcript is still there afterwards.
 *
 * The agent is a fake binary put on PATH for the launch, exactly as in agent-console.spec.ts, so
 * this never needs Claude Code installed.
 */

function fakeAgent(): { dir: string } {
	const dir = mkdtempSync(join(tmpdir(), 'snout-dock-agent-'));
	const script = join(dir, 'fake-agent.js');
	writeFileSync(script, `
if (process.argv.slice(2).includes('--version')) {
	process.stdout.write('9.9.9 (Fake Agent)\\n');
	process.exit(0);
}
process.stdout.write('DOCKING-MARKER-42\\r\\n');
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`, 'utf8');
	if (process.platform === 'win32') {
		writeFileSync(join(dir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
		return { dir };
	}
	const path = join(dir, 'claude');
	writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
	chmodSync(path, 0o755);
	return { dir };
}

/** The connections tree's header, wherever it is docked. `.sidebar-header` alone is ambiguous:
 *  every side view uses that class, so a bare selector can match the history panel instead. */
const CONNECTIONS_HEADER = '.sidebar-header:has-text("CONNECTIONS")';

/** Which dock area a panel is currently rendered inside. */
async function areaOf(handle: AppHandle, selector: string): Promise<string | null> {
	return handle.page.locator(selector).first().evaluate((el) => {
		const dock = el.closest('.dock');
		return dock ? (dock.className.match(/dock-(left|right|bottom)/)?.[1] ?? null) : null;
	});
}

/**
 * Make sure a panel is on screen, wherever it happens to be docked.
 *
 * The activity-bar icon TOGGLES, so clicking it blind is as likely to put the panel away as to
 * bring it out — which is exactly how the two drag tests below failed the first time they ran in
 * the full suite: the earlier tests had already left Connections showing.
 */
/** `item`: the activity-bar button, as an attribute selector (the assistant's label is the build's
 *  name for it, so it is found by `data-tool`). */
async function ensureShown(handle: AppHandle, item: string, panel: string): Promise<void> {
	const target = handle.page.locator(panel).first();
	if (!await target.isVisible().catch(() => false)) {
		await handle.page.click(`.activity-item${item}`);
	}
	await expect(target).toBeVisible();
}

/** Show the console and make sure the agent is actually RUNNING, so a test can measure its
 *  terminal. Self-contained on purpose: a test that depends on an earlier one having pressed
 *  Start passes or fails depending on what ran before it. */
async function ensureConsoleRunning(handle: AppHandle): Promise<void> {
	if (!await handle.page.locator('.agent-console').isVisible().catch(() => false)) {
		await handle.page.click('.activity-item[aria-label="Claude Code console"]');
	}
	await expect(handle.page.locator('.agent-console')).toBeVisible();
	const start = handle.page.locator('.agent-console-empty button.primary, .agent-console-exited button.primary');
	if (await start.first().isVisible().catch(() => false)) {
		await start.first().click();
	}
	await expect.poll(async () => handle.page.locator('.agent-console-term .xterm-rows').innerText(), { timeout: 15_000 })
		.toContain('DOCKING-MARKER-42');
}

/** Right-click a panel's header and pick "Move to X" from the menu the user gets. */
async function moveViaMenu(handle: AppHandle, header: string, area: 'left' | 'right' | 'bottom'): Promise<void> {
	await handle.page.locator(header).first().click({ button: 'right' });
	await handle.page.locator('.panel-menu-item', { hasText: `Move to ${area}` }).click();
	await expect(handle.page.locator('.panel-menu')).toHaveCount(0);
}

test.describe('dockable panels', () => {
	let handle: AppHandle;
	const agent = fakeAgent();

	test.beforeAll(async () => {
		handle = await launchApp('docking', {
			env: { PATH: `${agent.dir}${delimiter}${process.env.PATH ?? ''}`, Path: `${agent.dir}${delimiter}${process.env.PATH ?? ''}` },
		});
	});

	test.afterAll(async () => {
		await closeApp(handle);
	});

	test('a fresh profile opens exactly where the app always opened', async () => {
		// The default layout reproduces the old hardcoded one, and "exactly" is the point of this
		// test: connections left, the ASSISTANT OUT on the right (it was `useState(true)` before
		// docking, so every launch had it open), no console until asked for.
		expect(await areaOf(handle, CONNECTIONS_HEADER)).toBe('left');
		expect(await areaOf(handle, '.chat-panel')).toBe('right');
		await expect(handle.page.locator('.chat-panel')).toBeVisible();
		await expect(handle.page.locator('.agent-console')).toHaveCount(0);
	});

	test('the assistant can be moved to the bottom, and comes back', async () => {
		await ensureShown(handle, '[data-tool="assistant"]', '.chat-panel');
		expect(await areaOf(handle, '.chat-panel')).toBe('right');

		await moveViaMenu(handle, '.chat-header', 'bottom');
		expect(await areaOf(handle, '.chat-panel')).toBe('bottom');
		await expect(handle.page.locator('.chat-panel')).toBeVisible();
		await handle.page.screenshot({ path: 'e2e/.results/docking-assistant-bottom.png' });

		await moveViaMenu(handle, '.chat-header', 'right');
		expect(await areaOf(handle, '.chat-panel')).toBe('right');
	});

	test('the assistant\'s full view is the same panel, moved, not a second chat', async () => {
		await ensureShown(handle, '[data-tool="assistant"]', '.chat-panel');
		// One activity-bar icon for one assistant: the old second "full screen" chat is gone.
		await expect(handle.page.locator('.activity-item[aria-label="AI Chat (full screen)"]')).toHaveCount(0);
		// Tag the panel's DOM node. A remount builds a new node, so the tag surviving both switches
		// is what proves the conversation, the draft and a reply in flight would survive them too.
		await handle.page.locator('.chat-panel').first().evaluate((el) => { (el as HTMLElement & { libyMark?: number }).libyMark = 42; });
		const mark = (): Promise<number | undefined> => handle.page.locator('.chat-panel').first().evaluate((el) => (el as HTMLElement & { libyMark?: number }).libyMark);

		await handle.page.locator('.chat-header button[aria-label="Full screen"]').click();
		await expect(handle.page.locator('.chat-panel.chat-full')).toBeVisible();
		await expect(handle.page.locator('.chat-panel')).toHaveCount(1);
		await expect(handle.page.locator('.dock-center').first()).toBeHidden();
		expect(await areaOf(handle, '.chat-panel')).toBeNull();
		expect(await mark()).toBe(42);
		await handle.page.screenshot({ path: 'e2e/.results/docking-liby-full.png' });

		await handle.page.locator('.chat-header button[aria-label="Exit full screen"]').click();
		await expect(handle.page.locator('.chat-panel.chat-full')).toHaveCount(0);
		await expect(handle.page.locator('.chat-panel')).toBeVisible();
		expect(await areaOf(handle, '.chat-panel')).toBe('right');
		expect(await mark()).toBe(42);

		// Moving it between docks is the same move, so it keeps the same node too.
		await moveViaMenu(handle, '.chat-header', 'bottom');
		expect(await mark()).toBe(42);
		await moveViaMenu(handle, '.chat-header', 'right');
		expect(await mark()).toBe(42);
	});

	test('a running agent console moves to the side WITH its terminal intact', async () => {
		// The want this whole feature came from: Claude Code on the side, like the assistant.
		await handle.page.click('.activity-item[aria-label="Claude Code console"]');
		await handle.page.waitForSelector('.agent-console');
		await handle.page.locator('.agent-console-empty button.primary').click();
		await expect(handle.page.locator('.agent-console-term .xterm-rows')).toContainText('DOCKING-MARKER-42', { timeout: 15_000 });
		expect(await areaOf(handle, '.agent-console')).toBe('bottom');

		await moveViaMenu(handle, '.agent-console .pane-header', 'right');

		expect(await areaOf(handle, '.agent-console')).toBe('right');
		// The point of the portal: the same terminal, still showing what the agent said, not a
		// fresh one that had to replay (or worse, a dead one).
		await expect(handle.page.locator('.agent-console-term .xterm-rows')).toContainText('DOCKING-MARKER-42');
		await handle.page.screenshot({ path: 'e2e/.results/docking-console-right.png' });
	});

	test('two tools can share an area, and the activity bar switches between them', async () => {
		// The console is on the right from the previous test; the assistant lives there too.
		await handle.page.click('.activity-item[data-tool="assistant"]');
		await expect(handle.page.locator('.chat-panel')).toBeVisible();
		expect(await areaOf(handle, '.chat-panel')).toBe('right');
		// One area shows one tool, so the console went away without being unmounted.
		await expect(handle.page.locator('.agent-console')).toBeHidden();
		await handle.page.click('.activity-item[aria-label="Claude Code console"]');
		await expect(handle.page.locator('.agent-console')).toBeVisible();
		await expect(handle.page.locator('.chat-panel')).toBeHidden();
	});

	test('the layout survives a reload', async () => {
		await handle.page.reload();
		await handle.page.waitForSelector('.activity-bar');
		await handle.page.click('.activity-item[aria-label="Claude Code console"]');
		expect(await areaOf(handle, '.agent-console')).toBe('right');
	});

	test('a panel can be DRAGGED to another area, and the bands say where it will land', async () => {
		await ensureShown(handle, '[aria-label="Connections"]', CONNECTIONS_HEADER);
		const header = handle.page.locator(CONNECTIONS_HEADER);
		const grab = await header.boundingBox();
		const band = await handle.page.locator('.app-body').boundingBox();
		if (!grab || !band) { throw new Error('no layout to drag'); }

		await handle.page.mouse.move(grab.x + 60, grab.y + grab.height / 2);
		await handle.page.mouse.down();
		// A click is not a drag: the bands only appear once the pointer has actually moved.
		await expect(handle.page.locator('.dock-drop-layer')).toHaveCount(0);
		await handle.page.mouse.move(band.x + band.width / 2, band.y + band.height / 2, { steps: 6 });
		await expect(handle.page.locator('.dock-drop-layer')).toHaveCount(1);
		// The middle of the editor is nowhere: nothing is lit, and a drop there would be a cancel.
		await expect(handle.page.locator('.dock-edge.over')).toHaveCount(0);

		await handle.page.mouse.move(band.x + band.width - 40, band.y + band.height / 2, { steps: 8 });
		await expect(handle.page.locator('.dock-edge.over')).toHaveCount(1);
		await handle.page.screenshot({ path: 'e2e/.results/docking-drag-bands.png' });
		await handle.page.mouse.up();

		await expect(handle.page.locator('.dock-drop-layer')).toHaveCount(0);
		expect(await areaOf(handle, CONNECTIONS_HEADER)).toBe('right');
	});

	test('a drag can be abandoned with Escape, and in the middle of the editor', async () => {
		await ensureShown(handle, '[aria-label="Connections"]', CONNECTIONS_HEADER);
		const header = handle.page.locator(CONNECTIONS_HEADER);
		const grab = await header.boundingBox();
		const band = await handle.page.locator('.app-body').boundingBox();
		if (!grab || !band) { throw new Error('no layout to drag'); }

		await handle.page.mouse.move(grab.x + 60, grab.y + grab.height / 2);
		await handle.page.mouse.down();
		await handle.page.mouse.move(band.x + 40, band.y + band.height / 2, { steps: 6 });
		await expect(handle.page.locator('.dock-edge.over')).toHaveCount(1);
		await handle.page.keyboard.press('Escape');
		await expect(handle.page.locator('.dock-drop-layer')).toHaveCount(0);
		await handle.page.mouse.up();
		// Still where it was: Escape means the drag never happened.
		expect(await areaOf(handle, CONNECTIONS_HEADER)).toBe('right');

		// And a drop in the middle is the same answer, without a keystroke.
		await handle.page.mouse.move(grab.x + 60, grab.y + grab.height / 2);
		await handle.page.mouse.down();
		await handle.page.mouse.move(band.x + band.width / 2, band.y + band.height / 2, { steps: 6 });
		await handle.page.mouse.up();
		expect(await areaOf(handle, CONNECTIONS_HEADER)).toBe('right');
	});

	test('a panel can be moved from its activity-bar icon too, without disturbing its neighbour', async () => {
		// Wherever the earlier tests have left it: the point is that it does not MOVE, not that it
		// is in any particular place.
		const connectionsBefore = await areaOf(handle, CONNECTIONS_HEADER);
		await handle.page.locator('.activity-item[aria-label="Query history & saved"]').click({ button: 'right' });
		await handle.page.locator('.panel-menu-item', { hasText: 'Move to bottom' }).click();
		// A move shows the panel where it lands, so history is now the bottom strip...
		await expect(handle.page.locator('.dock-bottom .sidebar-header')).toHaveText(/HISTORY/);
		// ...and the panel that shared an area with it is exactly where it was.
		expect(await areaOf(handle, CONNECTIONS_HEADER)).toBe(connectionsBefore);
	});

	test('the terminal re-fits when it MOVES, not only when it is resized', async () => {
		// Rows are countable from the DOM, so this asserts the RE-FIT rather than the transcript
		// surviving (which is a different test): move a live console from a wide strip to a tall
		// column and the grid must have more rows in it than it did.
		await ensureConsoleRunning(handle);
		await moveViaMenu(handle, '.agent-console .pane-header', 'bottom');
		const rows = async (): Promise<number> => handle.page.locator('.agent-console-term .xterm-rows > div').count();
		await expect.poll(rows, { timeout: 10_000 }).toBeGreaterThan(0);
		const wide = await rows();

		await moveViaMenu(handle, '.agent-console .pane-header', 'right');
		expect(await areaOf(handle, '.agent-console')).toBe('right');
		await expect.poll(rows, { timeout: 10_000 }).toBeGreaterThan(wide);
	});

	test('a panel dragged to its floor is still readable', async () => {
		await ensureShown(handle, '[data-tool="assistant"]', '.chat-panel');
		expect(await areaOf(handle, '.chat-panel')).toBe('right');
		const band = await handle.page.locator('.app-body').boundingBox();
		// The splitter immediately before the right area is the one that sizes it.
		const grip = await handle.page.locator('.splitter-vertical').last().boundingBox();
		if (!band || !grip) { throw new Error('no layout to squeeze'); }

		// Shove it as far right as it will go. The model has to stop the drag where the assistant
		// stops being an assistant, not at the area's bare floor.
		await handle.page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
		await handle.page.mouse.down();
		await handle.page.mouse.move(band.x + band.width - 12, grip.y + grip.height / 2, { steps: 10 });
		await handle.page.mouse.up();

		const after = await handle.page.locator('.chat-panel').boundingBox();
		expect(after?.width ?? 0).toBeGreaterThanOrEqual(300);
		// And the panel is still a panel at that size: its header is there and its controls are
		// still on screen rather than wrapped or clipped out of reach. Not the composer — this
		// suite runs a fresh, signed-out profile, where the assistant shows its sign-in state and
		// has no composer to find. What the floor protects is the frame.
		const header = handle.page.locator('.chat-panel .chat-header');
		await expect(header).toBeVisible();
		const headerBox = await header.boundingBox();
		expect(headerBox?.height ?? 0).toBeLessThan(64);
		await expect(header.locator('.icon-btn').first()).toBeVisible();
		await handle.page.screenshot({ path: 'e2e/.results/docking-squeezed.png' });
	});

	test('an agent switched off while its console is open hands the dock over', async () => {
		// Last, deliberately: it takes the only agent this suite has away, which is a state nothing
		// after it could rely on.
		await ensureConsoleRunning(handle);
		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { setEnabled(k: string, v: boolean): Promise<unknown> } } }).sqlApi;
			await api.agentConsole.setEnabled('claude', false);
		});
		// Only the fake `claude` is on PATH for this suite, so there is no neighbour to promote and
		// the area closes rather than sitting open around a panel that is no longer there.
		await expect(handle.page.locator('.agent-console')).toBeHidden({ timeout: 10_000 });
		await expect(handle.page.locator('.activity-item[aria-label="Claude Code console"]')).toHaveCount(0);

		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { setEnabled(k: string, v: boolean): Promise<unknown> } } }).sqlApi;
			await api.agentConsole.setEnabled('claude', true);
		});
		await expect(handle.page.locator('.activity-item[aria-label="Claude Code console"]')).toHaveCount(1, { timeout: 10_000 });
	});
});

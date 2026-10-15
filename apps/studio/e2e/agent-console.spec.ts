/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

import { launchApp, closeApp, type AppHandle } from './helpers';
import { agentImagePasteKey } from '../src/shared/agentConsole';

/*
 * The Agent Console.
 *
 * Everything here runs against a FAKE agent binary put on PATH for the launch, so the suite never
 * depends on Claude Code being installed on the machine running it — and so a test can make the
 * agent do things (exit, echo) that a real one would not do on command. The code under test is the
 * real one: real PTY, real IPC, real xterm.
 */

/**
 * The bytes the app should send so the agent pastes the image itself, ON THIS PLATFORM.
 *
 * Taken from the app's own table rather than written out here, because the key is NOT the same
 * everywhere — Claude Code binds alt+v on Windows (an ESC sequence) and ctrl+v elsewhere (0x16) —
 * and a fake agent that only recognised the Windows one reported nothing on macOS and Linux, where
 * the app was in fact sending exactly the right key. That is what made this test, and the six after
 * it, fail on a Mac while passing on the PC it was written on.
 *
 * Reading it from `agentImagePasteKey` also keeps the test meaningful: send the WRONG key for the
 * platform and the fake agent stops reporting, so the assertion still fails.
 */
const IMAGE_PASTE_KEY = agentImagePasteKey('claude', process.platform) ?? '\u001b';

/** A stand-in agent: answers --version, then echoes whatever is typed at it. */
function fakeAgent(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), 'snout-fake-agent-'));
	const script = join(dir, 'fake-agent.js');
	writeFileSync(script, `
const isVersion = process.argv.slice(2).includes('--version');
if (isVersion) {
	process.stdout.write('9.9.9 (Fake Agent)\\n');
	process.exit(0);
}
if (require('node:fs').existsSync(require('node:path').join(__dirname, 'die'))) {
	// Stand-in for a real agent refusing its own config file: say why, then exit non-zero.
	// A sentinel FILE, not an env var: the console's environment allow-list would strip the var,
	// which is exactly the behaviour we do not want to weaken for a test's convenience.
	process.stdout.write('Error loading configuration: unknown variant \`xhigh\`, expected one of \`minimal\`, \`low\`, \`medium\`, \`high\`\\r\\nin \`model_reasoning_effort\`\\r\\n');
	process.exit(1);
}
process.stdout.write('FAKE AGENT READY\\r\\n');
process.stdout.write('mcp=' + (process.env.SNOUTDATA_MCP_URL ? 'yes' : 'no') + '\\r\\n');
// The house rules and the strict-MCP flag are LAUNCH FLAGS, so the only honest way to assert they
// were handed over is to have the process say what it was handed.
const flags = process.argv.slice(2);
process.stdout.write('strict=' + (flags.includes('--strict-mcp-config') ? 'yes' : 'no') + '\\r\\n');
// Nothing multi-line may ride the command line: on Windows an npm-installed agent is a .cmd shim
// and cmd.exe re-parses the arguments, which is how the house rules arrived corrupted the first
// time they were passed this way. They travel as the MCP server instructions instead. (No backticks
// in here: this script lives inside a TS template literal.)
process.stdout.write('multiline=' + (flags.some((f) => /[\\r\\n]/.test(f)) ? 'yes' : 'no') + '\\r\\n');
// Raw mode, like the real agents: a TUI turns line input off, and that is not cosmetic here. In a
// Windows console's cooked mode ESC means "clear the line", so an escape sequence never reaches the
// child at all, and the image-paste key would look like it was never sent.
if (process.stdin.setRawMode) { process.stdin.setRawMode(true); }
process.stdin.setEncoding('utf8');
// Only the FIRST character of the key is matched, deliberately: on Windows the key is ESC followed
// by 'v' and a PTY may deliver those in two chunks, so matching the whole sequence would be flaky
// there. The first character (ESC vs 0x16) is what distinguishes the platforms' keys anyway.
const IMAGE_KEY_HEAD = ${JSON.stringify(IMAGE_PASTE_KEY[0])};
let line = '';
process.stdin.on('data', (chunk) => {
	if (chunk.includes('\\u0003')) { process.exit(0); }
	// Stands in for an agent that reads the clipboard itself. Claude Code's image-paste key is a
	// control sequence (alt+v on Windows, ctrl+v elsewhere), so it is REPORTED rather than echoed:
	// it would not survive being printed back. WHICH key we send is pinned by the unit test and by
	// e2e/agent-console-live.spec.ts against the real CLI.
	if (chunk.includes(IMAGE_KEY_HEAD)) { process.stdout.write('image-key\\r\\n'); return; }
	for (const ch of chunk) {
		if (ch === '\\r' || ch === '\\n') {
			process.stdout.write('\\r\\nyou-said:' + line + '\\r\\n');
			line = '';
		} else {
			line += ch;
			process.stdout.write(ch);
		}
	}
});
setInterval(() => {}, 1 << 30);
`, 'utf8');
	if (process.platform === 'win32') {
		// A .cmd shim is also the shape npm installs, so this exercises planSpawn's one shell case.
		const path = join(dir, 'claude.cmd');
		writeFileSync(path, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
		return { dir, path };
	}
	const path = join(dir, 'claude');
	writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
	chmodSync(path, 0o755);
	return { dir, path };
}

/** Open the dock from the activity bar, the way a user would. */
async function openConsole(handle: AppHandle): Promise<void> {
	await handle.page.click('.activity-item[aria-label="Claude Code console"]');
	await handle.page.waitForSelector('.agent-console');
}

/** Whatever the terminal is currently showing. */
async function terminalText(handle: AppHandle): Promise<string> {
	return handle.page.locator('.agent-console-term .xterm-rows').innerText();
}

/** Everything the Claude Code console's terminal holds, scrollback included (null: no terminal). */
async function terminalTranscript(handle: AppHandle): Promise<string | null> {
	return handle.page.evaluate(() => {
		const w = window as unknown as { __snoutDebugAgentTranscript?: (kind: string) => string | null };
		return w.__snoutDebugAgentTranscript?.('claude') ?? null;
	});
}

test.describe('agent console', () => {
	let handle: AppHandle;
	const agent = fakeAgent();

	test.beforeAll(async () => {
		handle = await launchApp('agent-console', {
			env: { PATH: `${agent.dir}${delimiter}${process.env.PATH ?? ''}`, Path: `${agent.dir}${delimiter}${process.env.PATH ?? ''}` },
		});
	});

	test.afterAll(async () => {
		await closeApp(handle);
	});

	test('an installed agent turns up on the activity bar by itself', async () => {
		// Nobody has ever decided about this agent, so the first sighting shows it. That sweep is
		// deferred off the boot path, hence the wait rather than an immediate assertion.
		await expect(handle.page.locator('.activity-item[aria-label="Claude Code console"]')).toBeVisible({ timeout: 20_000 });
		// And the rule, asserted rather than the contents of THIS machine (the box running the
		// suite may genuinely have Codex or opencode installed): an icon appears for exactly the
		// agents that are installed and switched on, and for no others.
		const statuses = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { statuses(): Promise<Array<{ kind: string; label: string; visible: boolean; install: { installed: boolean } }>> } } }).sqlApi;
			return api.agentConsole.statuses();
		});
		expect(statuses.filter((a) => a.visible).every((a) => a.install.installed)).toBe(true);
		expect(statuses.some((a) => a.kind === 'claude' && a.visible)).toBe(true);
		for (const agent of statuses) {
			await expect(handle.page.locator(`.activity-item[aria-label="${agent.label} console"]`)).toHaveCount(agent.visible ? 1 : 0);
		}
		await handle.page.screenshot({ path: 'e2e/.results/agent-activity-bar.png' });
	});

	test('finds the agent on PATH and offers to start it', async () => {
		await openConsole(handle);
		await expect(handle.page.locator('.agent-console-empty')).toContainText('Claude Code');
		// Discovery ran the binary and kept what it said, so the panel can prove which one it found.
		await expect(handle.page.locator('.agent-console-version')).toContainText('9.9.9 (Fake Agent)');
		await handle.page.screenshot({ path: 'e2e/.results/agent-console-not-started.png' });
	});

	test('starts the agent and streams its output into the terminal', async () => {
		await handle.page.click('.agent-console-actions button.primary');
		await expect.poll(() => terminalText(handle), { timeout: 15_000 }).toContain('FAKE AGENT READY');
		await handle.page.screenshot({ path: 'e2e/.results/agent-console-running.png' });
	});

	test('hands the agent the local MCP endpoint, and nothing else', async () => {
		// The fake agent reports whether SNOUTDATA_MCP_URL reached it: that is the whole handoff.
		await expect.poll(() => terminalText(handle), { timeout: 10_000 }).toContain('mcp=yes');
		// And the environment it was given carries no secret-shaped variable (the allow-list).
		const leaked = await handle.page.evaluate(() => {
			const text = document.querySelector('.agent-console-term .xterm-rows')?.textContent ?? '';
			return /password|secret|api[_-]?key/i.test(text);
		});
		expect(leaked).toBe(false);
	});

	test('the agent is launched with our MCP server as its only one', async () => {
		// The flag half of the house rules, asserted where it actually lands: on the
		// process. A test on the generated FILES would not catch a flag that never reached the spawn.
		const text = await terminalText(handle);
		expect(text).toContain('strict=yes');
		expect(text).toContain('multiline=no');
	});

	test('typing reaches the agent', async () => {
		await handle.page.click('.agent-console-term .xterm-screen');
		await handle.page.keyboard.type('hello');
		await handle.page.keyboard.press('Enter');
		await expect.poll(() => terminalText(handle), { timeout: 10_000 }).toContain('you-said:hello');
	});

	test('Ctrl+V pastes into the agent', async () => {
		// The complaint this fixes: Ctrl+V did nothing in any of the three consoles. xterm turns it
		// into the control character 0x16 and cancels the keydown, so neither the terminal nor the
		// browser ever pasted. Asserted where it matters, on what the AGENT received.
		await handle.app.evaluate(({ clipboard }) => clipboard.writeText('pasted-from-the-clipboard'));
		await handle.page.click('.agent-console-term .xterm-screen');
		await handle.page.keyboard.press('ControlOrMeta+v');
		// Wait for the terminal to show it before pressing Enter. Two reasons, both real: reading the
		// clipboard is asynchronous, so Enter can otherwise beat the paste to the PTY, and a Windows
		// console hands the child nothing until the line ends, so the Enter is what delivers it.
		await expect.poll(() => terminalText(handle), { timeout: 10_000 }).toContain('pasted-from-the-clipboard');
		await handle.page.keyboard.press('Enter');
		await expect.poll(() => terminalText(handle), { timeout: 10_000 }).toContain('you-said:pasted-from-the-clipboard');
		// And exactly once: the browser's own paste listener must not fire on top of ours, whether
		// that would arrive as a second line or as the text twice over in one.
		const text = await terminalText(handle);
		expect(text.split('you-said:pasted-from-the-clipboard').length - 1).toBe(1);
		expect(text).not.toContain('pasted-from-the-clipboardpasted-from-the-clipboard');
	});

	test('Ctrl+V with an image on the clipboard hands it to the agent', async () => {
		// The agent reads the clipboard itself, so what we owe it is its own key and nothing else.
		// Asserted on what the AGENT received: sending the wrong bytes is silent at every other layer.
		await handle.app.evaluate(({ clipboard, nativeImage }) => {
			clipboard.clear();
			clipboard.writeImage(nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='));
		});
		await handle.page.click('.agent-console-term .xterm-screen');
		await handle.page.keyboard.press('ControlOrMeta+v');
		// The key itself draws nothing, so there is no echo to wait on: give the clipboard read a
		// beat, then end the line so a Windows console delivers it.
		await handle.page.waitForTimeout(1000);
		await handle.page.keyboard.press('Enter');
		await expect.poll(() => terminalText(handle), { timeout: 10_000 }).toContain('image-key');
	});

	test('text on the clipboard still wins over an image beside it', async () => {
		// Copying out of a spreadsheet or a browser leaves a bitmap on the clipboard next to the
		// text. The user meant the rows, so the image half must only run when there is no text.
		await handle.app.evaluate(({ clipboard, nativeImage }) => {
			clipboard.write({
				text: 'rows-not-the-bitmap',
				image: nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
			});
		});
		await handle.page.click('.agent-console-term .xterm-screen');
		await handle.page.keyboard.press('ControlOrMeta+v');
		await expect.poll(() => terminalText(handle), { timeout: 10_000 }).toContain('rows-not-the-bitmap');
		await handle.page.keyboard.press('Enter');
		await expect.poll(() => terminalText(handle), { timeout: 10_000 }).toContain('you-said:rows-not-the-bitmap');
	});

	test('the terminal text can be resized, and the size sticks', async () => {
		// The complaint this fixes: 12px, fixed, in a panel people read for minutes at a time. The
		// assertion is on what xterm actually RENDERS, not on the stored number, because the bug
		// worth catching is a setting that changes and a terminal that does not.
		const rendered = async (): Promise<number> => handle.page.evaluate(() => {
			const rows = document.querySelector('.agent-console-term .xterm-rows');
			return rows ? Number.parseFloat(getComputedStyle(rows).fontSize) : 0;
		});
		const before = await rendered();
		expect(before).toBeGreaterThan(0);
		await handle.page.click('.agent-console-zoom button[aria-label="Bigger terminal text"]');
		await handle.page.click('.agent-console-zoom button[aria-label="Bigger terminal text"]');
		await expect.poll(rendered, { timeout: 5_000 }).toBe(before + 2);
		// The terminal is re-measured with it: a bigger cell in the same box is fewer columns, and
		// the PTY has to be told, or the agent's output wraps in the wrong place.
		const cols = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { statuses(): Promise<Array<{ kind: string; cols?: number }>> } } }).sqlApi;
			return (await api.agentConsole.statuses()).find((s) => s.kind === 'claude')?.cols;
		});
		expect(cols === undefined || cols > 0).toBe(true);
		// The number in the header is the reset.
		await handle.page.click('.agent-console-zoom-value');
		await expect.poll(rendered, { timeout: 5_000 }).toBe(before);
	});

	test('closing the dock detaches; reopening replays the scrollback', async () => {
		await handle.page.click('.agent-console .pane-header button[aria-label="Close panel"]');
		// HIDDEN, not gone. Since panels became dockable, a console is mounted once
		// and only ever hidden, so that moving or closing it does not dispose its terminal. This
		// assertion used to be toHaveCount(0), which is the behaviour that made a close destructive.
		await expect(handle.page.locator('.agent-console')).toBeHidden();
		await openConsole(handle);
		// The agent was never killed, so its earlier output is still there: main owns the history.
		await expect.poll(() => terminalText(handle), { timeout: 10_000 }).toContain('you-said:hello');
		const running = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { statuses(): Promise<Array<{ kind: string; running: boolean }>> } } }).sqlApi;
			return (await api.agentConsole.statuses()).find((s) => s.kind === 'claude')?.running;
		});
		expect(running).toBe(true);
	});

	test('the terminal key toggles the dock', async () => {
		await handle.page.click('.agent-console-term .xterm-screen');
		await handle.page.keyboard.press('ControlOrMeta+`');
		await expect(handle.page.locator('.agent-console')).toBeHidden();
		await handle.page.keyboard.press('ControlOrMeta+`');
		await expect(handle.page.locator('.agent-console')).toBeVisible();
	});

	test('stopping ends the session and leaves the transcript on screen', async () => {
		await handle.page.click('.agent-console .pane-header button[aria-label="Stop"]');
		await expect(handle.page.locator('.agent-console-exited')).toBeVisible({ timeout: 10_000 });
		await expect(handle.page.locator('.agent-console-exited button.primary')).toContainText('Start again');
		// What it said stays readable: a console that blanks itself on exit throws away the reason.
		// Two halves. The end of the transcript is ON SCREEN: the rendered rows, since the cursor's
		// line is always in view.
		await expect.poll(() => terminalText(handle), { timeout: 5_000 }).toContain('you-said:rows-not-the-bitmap');
		// And ALL of it, from the agent's first line, is still in that terminal: its buffer, scrollback
		// included, not the rendered rows. The rows are only the lines in view, and the exit strip
		// takes rows from the terminal AFTER it appears, on the ResizeObserver's next refit. Shrinking
		// a terminal moves its view down to keep the cursor in it, so the first line was in view or
		// not depending on the font (Linux's DejaVu Sans Mono fits one row fewer than macOS's Menlo)
		// and on whether that refit landed before or after anything the spec did, scrolling to the
		// top included. A cleared or disposed terminal still fails this: the hook reads the live
		// xterm, and returns null when none is mounted.
		await expect.poll(() => terminalTranscript(handle), { timeout: 5_000 }).toContain('FAKE AGENT READY');
		await handle.page.screenshot({ path: 'e2e/.results/agent-console-stopped.png' });
	});

	test('an agent that dies on startup leaves its reason on screen', async () => {
		// Restart it with the fake agent set to fail. The panel must keep the transcript: "it exited"
		// on its own is the least useful thing we could say.
		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { stop(k: string): Promise<unknown> } } }).sqlApi;
			await api.agentConsole.stop('claude');
		});
		writeFileSync(join(agent.dir, 'die'), '', 'utf8');
		await handle.page.click('.agent-console-exited button.primary, .agent-console-actions button.primary');
		await expect(handle.page.locator('.agent-console-exited')).toBeVisible({ timeout: 15_000 });
		// The app NAMES what stopped it and points at whoever owns that, without repeating the
		// agent's message or offering to fix the agent. The fake agent prints the real message
		// codex-cli 0.29.0 produced against a config it did not understand.
		await expect(handle.page.locator('.agent-console-exited')).toContainText('its own settings');
		// It does NOT paraphrase the agent: that message is on screen, right above the strip.
		await expect(handle.page.locator('.agent-console-exited-why')).not.toContainText('xhigh');
		await expect(handle.page.locator('.agent-console-exited-why')).toContainText('outside SnoutData');
		// It points at the things that own the problem, and hands out no install advice: how the
		// agent got onto this machine is not something the app knows or should guess about.
		await expect(handle.page.locator('.agent-console-exited-actions')).toContainText('settings folder');
		await expect(handle.page.locator('.agent-console-exited-actions')).not.toContainText('npm');
		await expect.poll(() => terminalText(handle), { timeout: 10_000 }).toContain('unknown variant');
		await handle.page.screenshot({ path: 'e2e/.results/agent-console-died.png' });
		// And it can be started again from there, once the reason is read.
		rmSync(join(agent.dir, 'die'), { force: true });
		await handle.page.click('.agent-console-exited button.primary');
		await expect.poll(() => terminalText(handle), { timeout: 15_000 }).toContain('FAKE AGENT READY');
	});

	test('Settings lists every agent, with what was found and a switch', async () => {
		await handle.page.keyboard.press('ControlOrMeta+Shift+P');
		await handle.page.keyboard.type('Settings');
		await handle.page.keyboard.press('Enter');
		await expect(handle.page.locator('.settings-page')).toBeVisible();
		await handle.page.locator('.settings-nav-item', { hasText: 'Agent access' }).click();
		// Agent access is four tabs now, opening on Databases. The coding agents are one over.
		await handle.page.locator('.agent-section-tabs .tab', { hasText: 'Coding agents' }).click();
		const picks = handle.page.locator('.agent-pick');
		// All three, whether installed or not: this is where a user turns one back on, so an agent
		// they switched off has to still be listed.
		await expect(picks).toHaveCount(3);
		await expect(picks.filter({ hasText: 'Claude Code' })).toContainText('Found');
		await handle.page.screenshot({ path: 'e2e/.results/agent-settings.png' });
		await handle.page.locator('.settings-titlebar .icon-btn').click();
	});

	test('the user can point us at a binary PATH does not mention, and take it back', async () => {
		// The failsafe behind discovery. A second copy, deliberately in a directory that is NOT on
		// the launch PATH: nothing but the pin can find it.
		const elsewhere = fakeAgent();
		// A path handed over by the page is refused: a program is pinned only from main's own file
		// dialog, which is stubbed here to answer with the second copy.
		const refused = await handle.page.evaluate(async (path) => {
			const api = (window as unknown as { sqlApi: { agentConsole: { setPath(k: string, p?: string | null): Promise<Array<{ kind: string; install: { installed: boolean; path?: string; pinned?: boolean } }>> } } }).sqlApi;
			return (await api.agentConsole.setPath('claude', path)).find((a) => a.kind === 'claude');
		}, elsewhere.path);
		expect(refused?.install.pinned).toBeFalsy();
		expect(refused?.install.path).not.toBe(elsewhere.path);
		await handle.app.evaluate(({ dialog }, chosen) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
		}, elsewhere.path);
		const pinned = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { setPath(k: string, p?: string | null): Promise<Array<{ kind: string; install: { installed: boolean; path?: string; pinned?: boolean } }>> } } }).sqlApi;
			return (await api.agentConsole.setPath('claude')).find((a) => a.kind === 'claude');
		});
		expect(pinned?.install.installed).toBe(true);
		expect(pinned?.install.path).toBe(elsewhere.path);
		expect(pinned?.install.pinned).toBe(true);

		// A pin that stops resolving does NOT fall back to the copy on PATH: the user chose one.
		rmSync(elsewhere.dir, { recursive: true, force: true });
		const gone = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { discoverAll(): Promise<Array<{ kind: string; install: { installed: boolean; pinned?: boolean } }>> } } }).sqlApi;
			return (await api.agentConsole.discoverAll()).find((a) => a.kind === 'claude');
		});
		expect(gone?.install.installed).toBe(false);
		expect(gone?.install.pinned).toBe(true);

		// Clearing it goes back to PATH, and the agent on PATH is found again.
		const cleared = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { setPath(k: string, p?: string | null): Promise<Array<{ kind: string; install: { installed: boolean; path?: string; pinned?: boolean } }>> } } }).sqlApi;
			return (await api.agentConsole.setPath('claude', null)).find((a) => a.kind === 'claude');
		});
		expect(cleared?.install.installed).toBe(true);
		expect(cleared?.install.path).toBe(agent.path);
		expect(cleared?.install.pinned).toBeFalsy();
	});

	test('switching an agent off in Settings hides it, and a re-probe does not bring it back', async () => {
		// A decision outranks a discovery: this is the difference between "never asked" and "no".
		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { setEnabled(k: string, v: boolean): Promise<unknown> } } }).sqlApi;
			await api.agentConsole.setEnabled('claude', false);
		});
		await expect(handle.page.locator('.activity-item[aria-label="Claude Code console"]')).toHaveCount(0);
		// Another agent's console may stay open (this machine can have one installed), but the
		// console of the agent that was switched off is gone. Since docking each agent's console is
		// its own tool window, so this is a pane, not a tab.
		await expect(handle.page.locator('.agent-console .pane-title', { hasText: 'Claude Code' })).toHaveCount(0, { timeout: 10_000 });
		// Look again: still installed, still found, still hidden, because the user said no.
		const stillFound = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { discoverAll(): Promise<Array<{ kind: string; install: { installed: boolean }; visible: boolean }>> } } }).sqlApi;
			return (await api.agentConsole.discoverAll()).find((a) => a.kind === 'claude');
		});
		expect(stillFound?.install.installed).toBe(true);
		expect(stillFound?.visible).toBe(false);
		await expect(handle.page.locator('.activity-item[aria-label="Claude Code console"]')).toHaveCount(0);
		// Turning it back on brings it straight back.
		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { agentConsole: { setEnabled(k: string, v: boolean): Promise<unknown> } } }).sqlApi;
			await api.agentConsole.setEnabled('claude', true);
		});
		await expect(handle.page.locator('.activity-item[aria-label="Claude Code console"]')).toBeVisible();
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { CONTROL, crashed, parseMode, recoveryScript, runWaiter, type SwapMode, type WaiterConfig, type WaiterDeps } from './swapWaiter';

// Windows paths on every host, as the waiter itself uses.
const { join } = win32;

const ROOT = join('C:', 'Programs');
const INSTALL = join(ROOT, 'snoutdata');
const CONTROL_DIR = `${INSTALL}.swap`;
const RECOVERY = join('C:', 'Startup', 'snoutdata-update-recovery.cmd');

function config(): WaiterConfig {
	return {
		appPid: 100,
		install: INSTALL,
		next: `${INSTALL}.next`,
		old: `${INSTALL}.old`,
		exe: 'SnoutData.exe',
		installer: join('C:', 'updater', 'pending', 'Setup.exe'),
		installerCache: join('C:', 'updater', 'installer.exe'),
		uninstallKey: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\guid',
		version: '1.0.51',
		displayName: 'SnoutData 1.0.51',
		marker: '.snout-staged',
		control: CONTROL_DIR,
		log: join('C:', 'update.log'),
		tries: 3,
		fallbackArgs: { restart: ['--updated', '--force-run'], background: ['--updated', '/S', '--force-run'], quit: ['--updated', '/S'] },
		recovery: {
			script: RECOVERY,
			runOnceKey: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
			runOnceName: 'SnoutDataUpdateRecovery',
		},
	};
}

/** A filesystem of paths, where renaming a folder moves everything under it. */
class World implements WaiterDeps {
	files = new Map<string, string>();
	appAliveFor = 0;
	lingering = 0;
	/** Folders whose rename is refused, as Windows does when a handle without delete-sharing is open. */
	held = new Set<string>();
	launched: { file: string; args: string[] }[] = [];
	/** Exit codes the stock installer returns, in order; then 0. */
	installerCodes: (number | null)[] = [];
	ran: { file: string; args: string[] }[] = [];
	registry = new Map<string, string>();
	copies: [string, string][] = [];
	logs: string[] = [];
	lockSeenDuringSwap = false;
	/** Every write to disk and every rename, in order. */
	events: string[] = [];
	durableFails = false;

	constructor(mode: SwapMode | null, extra: string[] = []) {
		this.files.set(join(INSTALL, 'SnoutData.exe'), 'v1.0.50');
		this.files.set(join(`${INSTALL}.next`, 'SnoutData.exe'), 'v1.0.51');
		this.files.set(join(`${INSTALL}.next`, '.snout-staged'), 'marker');
		if (mode) {
			this.files.set(join(CONTROL_DIR, CONTROL.mode), mode);
		}
		for (const name of extra) {
			this.files.set(join(CONTROL_DIR, name), '1');
		}
	}

	private under(path: string): string[] {
		return [...this.files.keys()].filter((key) => key === path || key.startsWith(`${path}\\`) || key.startsWith(`${path}/`));
	}

	exists(path: string): boolean {
		return this.under(path).length > 0;
	}
	read(path: string): string | null {
		return this.files.get(path) ?? null;
	}
	write(path: string, text: string): void {
		this.files.set(path, text);
	}
	remove(path: string): void {
		this.files.delete(path);
	}
	removeDir(path: string): void {
		for (const key of this.under(path)) {
			this.files.delete(key);
		}
	}
	rename(from: string, to: string): boolean {
		if (this.held.has(from) || this.exists(to) || !this.exists(from)) {
			return false;
		}
		if (this.exists(join(CONTROL_DIR, CONTROL.lock))) {
			this.lockSeenDuringSwap = true;
		}
		this.events.push(`rename ${from}`);
		for (const key of this.under(from)) {
			const value = this.files.get(key) ?? '';
			this.files.delete(key);
			this.files.set(to + key.slice(from.length), value);
		}
		return true;
	}
	alive(): boolean {
		return this.appAliveFor-- > 0;
	}
	otherAppProcesses(): number {
		return this.lingering-- > 0 ? 1 : 0;
	}
	closed = 0;
	closeApp(): void {
		this.closed++;
		this.lingering = 0;
	}
	async sleep(): Promise<void> {
		// Time is not what is under test.
	}
	launch(file: string, args: string[]): void {
		this.launched.push({ file, args });
	}
	async run(file: string, args: string[]): Promise<number | null> {
		this.ran.push({ file, args });
		return this.installerCodes.length > 0 ? (this.installerCodes.shift() ?? null) : 0;
	}
	reg(key: string, name: string, value: string): void {
		this.registry.set(`${key}\\${name}`, value);
	}
	unreg(key: string, name: string): void {
		this.registry.delete(`${key}\\${name}`);
	}
	writeDurable(path: string, text: string): boolean {
		if (this.durableFails) {
			return false;
		}
		this.files.set(path, text);
		this.events.push(`durable ${path}`);
		return true;
	}
	copy(from: string, to: string): void {
		this.copies.push([from, to]);
	}
	log(message: string): void {
		this.logs.push(message);
	}

	liveVersion(): string | undefined {
		return this.files.get(join(INSTALL, 'SnoutData.exe'));
	}
}

test('Restart: the stage becomes the install, Windows is told the version, and the new app starts', async () => {
	const world = new World('restart');
	world.appAliveFor = 3;
	assert.equal(await runWaiter(config(), world), 'swapped');
	assert.equal(world.liveVersion(), 'v1.0.51');
	assert.equal(world.exists(`${INSTALL}.next`), false);
	assert.equal(world.exists(`${INSTALL}.old`), false);
	assert.equal(world.exists(join(INSTALL, '.snout-staged')), false);
	assert.equal(world.registry.get(`${config().uninstallKey}\\DisplayVersion`), '1.0.51');
	assert.equal(world.registry.get(`${config().uninstallKey}\\DisplayName`), 'SnoutData 1.0.51');
	assert.deepEqual(world.copies, [[config().installer, config().installerCache]]);
	assert.deepEqual(world.launched, [{ file: join(INSTALL, 'SnoutData.exe'), args: ['--updated'] }]);
	// The lock is held while folders move, so a launch in that second waits, and released after.
	assert.equal(world.lockSeenDuringSwap, true);
	assert.equal(world.exists(join(CONTROL_DIR, CONTROL.lock)), false);
	assert.equal(world.exists(join(CONTROL_DIR, CONTROL.ready)), true);
});

test('a plain quit swaps without bringing the app back', async () => {
	const world = new World('quit');
	assert.equal(await runWaiter(config(), world), 'swapped');
	assert.equal(world.liveVersion(), 'v1.0.51');
	assert.deepEqual(world.launched, []);
});

test('an app that exits without asking (a crash, a kill) is not swapped under', async () => {
	const world = new World(null);
	assert.equal(await runWaiter(config(), world), 'no-swap');
	assert.equal(world.liveVersion(), 'v1.0.50');
	assert.equal(world.exists(`${INSTALL}.next`), true);
	assert.deepEqual(world.launched, []);
});

test('Windows ending the session means no swap, even with a mode written', async () => {
	const world = new World('quit', [CONTROL.sessionEnd]);
	assert.equal(await runWaiter(config(), world), 'no-swap');
	assert.equal(world.liveVersion(), 'v1.0.50');
	assert.deepEqual(world.launched, []);
});

test('a cancel while waiting sends the waiter away without touching anything', async () => {
	const world = new World(null, [CONTROL.cancel]);
	world.appAliveFor = 10;
	assert.equal(await runWaiter(config(), world), 'cancelled');
	assert.equal(world.liveVersion(), 'v1.0.50');
	assert.deepEqual(world.launched, []);
});

test('the app\'s other processes are waited for before any folder moves', async () => {
	const world = new World('restart');
	world.lingering = 2;
	assert.equal(await runWaiter(config(), world), 'swapped');
	assert.equal(world.liveVersion(), 'v1.0.51');
});

test('what outlives the app (its crash reporter) is ended, as the stock installer does, and the swap goes on', async () => {
	const world = new World('restart');
	world.lingering = 99;
	assert.equal(await runWaiter(config(), world), 'swapped');
	assert.equal(world.closed, 1);
	assert.equal(world.liveVersion(), 'v1.0.51');
	assert.deepEqual(world.ran, []);
});

test('processes that leave by themselves are not ended', async () => {
	const world = new World('restart');
	world.lingering = 2;
	assert.equal(await runWaiter(config(), world), 'swapped');
	assert.equal(world.closed, 0);
});

test('the live folder cannot be moved aside: stock installer, live install untouched', async () => {
	const world = new World('background');
	world.held.add(INSTALL);
	assert.equal(await runWaiter(config(), world), 'fallback');
	assert.equal(world.liveVersion(), 'v1.0.50');
	assert.equal(world.exists(`${INSTALL}.next`), true);
	assert.deepEqual(world.ran, [{ file: config().installer, args: ['--updated', '/S', '--force-run'] }]);
});

test('the stage cannot be moved in: the live install is put back before the stock installer runs', async () => {
	const world = new World('quit');
	world.held.add(`${INSTALL}.next`);
	assert.equal(await runWaiter(config(), world), 'fallback');
	assert.equal(world.liveVersion(), 'v1.0.50');
	assert.equal(world.exists(`${INSTALL}.old`), false);
	assert.deepEqual(world.ran, [{ file: config().installer, args: ['--updated', '/S'] }]);
	assert.ok(world.logs.some((line) => line.includes('putting the live install back')));
});

test('a stage that vanished: stock installer, live install untouched', async () => {
	const world = new World('restart');
	world.removeDir(`${INSTALL}.next`);
	assert.equal(await runWaiter(config(), world), 'fallback');
	assert.equal(world.liveVersion(), 'v1.0.50');
});

test('a leftover .old that will not go: stock installer rather than moving the install into it', async () => {
	const world = new World('restart');
	world.files.set(join(`${INSTALL}.old`, 'stuck.dll'), 'x');
	world.removeDir = () => undefined;
	assert.equal(await runWaiter(config(), world), 'fallback');
	assert.equal(world.liveVersion(), 'v1.0.50');
});

test('only the three modes the app writes are honoured', () => {
	assert.equal(parseMode('restart\r\n'), 'restart');
	assert.equal(parseMode('quit'), 'quit');
	assert.equal(parseMode('background'), 'background');
	assert.equal(parseMode('swap'), null);
	assert.equal(parseMode(null), null);
});

test('a stock installer that crashes is run again; one that answers is left alone', async () => {
	const world = new World('restart');
	world.held.add(INSTALL);
	world.installerCodes = [3221225477, 3221225477, 0];
	assert.equal(await runWaiter(config(), world), 'fallback');
	assert.equal(world.ran.length, 3);

	const answered = new World('restart');
	answered.held.add(INSTALL);
	answered.installerCodes = [2];
	await runWaiter(config(), answered);
	assert.equal(answered.ran.length, 1);
});

test('crash exit codes are told apart from an installer answering', () => {
	assert.equal(crashed(3221225477), true);
	assert.equal(crashed(null), true);
	assert.equal(crashed(0), false);
	assert.equal(crashed(2), false);
});

test('the swap never launches the app when it falls back: the stock installer does that', async () => {
	const world = new World('restart');
	world.held.add(INSTALL);
	await runWaiter(config(), world);
	assert.deepEqual(world.launched, []);
});

const RUN_ONCE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce\\SnoutDataUpdateRecovery';

test('the power-cut recovery is on disk before the first rename, and gone once the swap is whole', async () => {
	const world = new World('restart');
	await runWaiter(config(), world);
	const firstRename = world.events.findIndex((event) => event.startsWith('rename'));
	const armed = world.events.indexOf(`durable ${RECOVERY}`);
	assert.ok(armed >= 0 && armed < firstRename, world.events.join(' | '));
	assert.equal(world.exists(RECOVERY), false);
	assert.equal(world.registry.has(RUN_ONCE), false);
});

test('a recovery that cannot be written does not stop the swap: the stock installer is the riskier path', async () => {
	const world = new World('restart');
	world.durableFails = true;
	assert.equal(await runWaiter(config(), world), 'swapped');
	assert.equal(world.liveVersion(), 'v1.0.51');
	assert.equal(world.ran.length, 0);
});

test('a swap left with no install (the old one could not be put back) keeps the recovery armed for the next logon', async () => {
	const world = new World('quit');
	world.held.add(`${INSTALL}.next`);
	// The live folder moves aside, then refuses to come back.
	const rename = world.rename.bind(world);
	let moved = false;
	world.rename = (from: string, to: string): boolean => {
		if (from === `${INSTALL}.old`) {
			return false;
		}
		moved = moved || from === INSTALL;
		return rename(from, to);
	};
	await runWaiter(config(), world);
	assert.equal(moved, true);
	assert.equal(world.exists(join(INSTALL, 'SnoutData.exe')), false);
	assert.equal(world.exists(RECOVERY), true);
	assert.equal(world.registry.has(RUN_ONCE), true);
});

test('the recovery script names a %LOCALAPPDATA% install through the variable, and rolls forward before back', () => {
	const local = join('C:', 'Users', 'Zoë', 'AppData', 'Local');
	const cfg = { ...config(), install: join(local, 'Programs', 'snoutdata'), next: join(local, 'Programs', 'snoutdata.next'), old: join(local, 'Programs', 'snoutdata.old') };
	cfg.recovery = { ...cfg.recovery, localAppData: local };
	const script = recoveryScript(cfg);
	assert.ok(script.includes('set "INST=%LOCALAPPDATA%\\Programs\\snoutdata"'), script);
	assert.ok(!script.includes('Zoë'));
	assert.ok(script.indexOf('ren "%NEXT%"') < script.indexOf('ren "%OLD%"'));
	assert.ok(script.includes('set "LEAF=snoutdata"'));
});

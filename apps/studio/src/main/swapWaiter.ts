/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Windows paths whatever the host: the waiter only ever runs on Windows, and the tests run everywhere.
import { win32 } from 'node:path';

const { join } = win32;

// THE SWAP WAITER. VSCode's shape: the process that will swap a staged update in is started when
// the update is READY, not when the app quits, and it confirms it is running before the app offers
// Restart. So a waiter that cannot start (policy, antivirus) is found while the app is up and the
// stock installer is used instead, rather than being found at quit, when nothing is left to notice.
// Quitting only writes a flag file.
//
// It runs as `<install>.swap\swap-waiter.exe`, a HARD LINK to the app's executable, in Node mode
// (ELECTRON_RUN_AS_NODE), on a copy of out/server/swap-waiter.cjs, and talks to the app through
// files in that folder. Not the executable in the install folder: in Node mode Electron opens its
// ICU and V8 data files without delete-sharing, and that alone stops the install folder being
// renamed (found driving it, 2026-10-04). Under its own name it is also invisible to the stock
// installer's "close every SnoutData.exe", so it lives to retry an installer that crashes.
//
//   ready      written by the waiter once it is running; the app waits for it
//   mode       written by the app as it quits: restart | background | quit
//   sessionend written by the app when Windows is logging off: no swap (a waiter killed between its
//              two renames would leave no app), the stage is reused on the next launch
//   cancel     written by the app when the stage is being replaced: the waiter leaves
//   swapping   written by the waiter for the length of the swap; a launch that finds it waits, then
//              relaunches (stagedUpdate.waitOutSwap)
//
// No mode file when the app is gone means it crashed or was killed: no swap. Everything that can go
// wrong ends with the live install whole and the stock installer run, which is what ran before.
//
// A POWER CUT. Windows has no atomic swap of two folders (VSCode gets one by swapping a single
// executable, which needs Microsoft's own Electron builds), so between the two renames there is a
// moment with no install folder at all. That moment is made recoverable rather than impossible:
// before the first rename the waiter writes a recovery script, forced to disk, into the Startup
// folder and points RunOnce at it, so the next logon after any power cut finishes the job (moves the
// complete, self-checked stage in, or puts the old install back) before anyone can click the icon.
// NTFS journals the renames in order after that write, so a rename that survived the cut means the
// script did too. If the script cannot be written (or policy stops it running at logon) the swap
// still happens: the stock installer is the alternative, and it is unprotected for 20-45 s, not a
// moment. The stage itself was
// forced to disk before the waiter was started (stagedUpdate.flushTree): NTFS journals names, not
// file contents, and the renamed-in files must be whole after a cut too.
// The decisions are here with every side effect injected (WaiterDeps), so all of them are tested;
// swapWaiterEntry.ts is the thin real implementation.

export type SwapMode = 'restart' | 'background' | 'quit';

export const CONTROL = {
	ready: 'ready',
	mode: 'mode',
	sessionEnd: 'sessionend',
	cancel: 'cancel',
	lock: 'swapping',
	config: 'config.json',
	script: 'waiter.cjs',
} as const;

export interface WaiterConfig {
	appPid: number;
	install: string;
	next: string;
	old: string;
	/** The executable's file name, e.g. SnoutData.exe. */
	exe: string;
	installer: string;
	installerCache: string;
	/** Full registry path of the uninstall key. */
	uninstallKey: string;
	version: string;
	displayName: string;
	/** File name of the stage marker inside the stage. */
	marker: string;
	control: string;
	log: string;
	/** Seconds to keep retrying a rename, or to wait for the app's processes to go. */
	tries: number;
	fallbackArgs: Record<SwapMode, string[]>;
	recovery: {
		/** The script in the Startup folder. */
		script: string;
		runOnceKey: string;
		runOnceName: string;
		/** %LOCALAPPDATA%, so the script can name the install by it and stay ASCII. */
		localAppData?: string;
	};
}

export interface WaiterDeps {
	exists(path: string): boolean;
	read(path: string): string | null;
	write(path: string, text: string): void;
	remove(path: string): void;
	removeDir(path: string): void;
	/** True when the rename happened. */
	rename(from: string, to: string): boolean;
	alive(pid: number): boolean;
	/** Processes running the app's executable, other than this one. */
	otherAppProcesses(exe: string): number;
	/** End them, as the stock installer does before it installs. */
	closeApp(exe: string): void;
	sleep(ms: number): Promise<void>;
	/** Start a program detached, WITHOUT this process's Node-mode environment. */
	launch(file: string, args: string[]): void;
	/** Run a program (same environment rule) and resolve with its exit code; null if it never ran. */
	run(file: string, args: string[]): Promise<number | null>;
	reg(key: string, name: string, value: string): void;
	unreg(key: string, name: string): void;
	/** Write a file and force it to disk before returning; false if it could not be. */
	writeDurable(path: string, text: string): boolean;
	copy(from: string, to: string): void;
	log(message: string): void;
}

export type WaiterOutcome = 'cancelled' | 'no-swap' | 'swapped' | 'fallback';

export function parseMode(text: string | null): SwapMode | null {
	const mode = text?.trim();
	return mode === 'restart' || mode === 'background' || mode === 'quit' ? mode : null;
}

export async function runWaiter(cfg: WaiterConfig, d: WaiterDeps): Promise<WaiterOutcome> {
	const control = (name: string): string => join(cfg.control, name);
	d.write(control(CONTROL.ready), 'ok');
	d.log(`waiting for the app (pid ${cfg.appPid}) to quit, v${cfg.version} staged`);
	// A quarter second: this loop is part of what a Restart feels like.
	while (d.alive(cfg.appPid)) {
		if (d.exists(control(CONTROL.cancel))) {
			d.log('cancelled: the stage is being replaced');
			return 'cancelled';
		}
		await d.sleep(250);
	}
	if (d.exists(control(CONTROL.cancel))) {
		d.log('cancelled: the stage is being replaced');
		return 'cancelled';
	}
	if (d.exists(control(CONTROL.sessionEnd))) {
		d.log('Windows is ending the session: no swap, the stage is kept for the next launch');
		return 'no-swap';
	}
	const mode = parseMode(d.read(control(CONTROL.mode)));
	if (!mode) {
		d.log('the app exited without asking for the update (a crash or a kill): no swap, the stage is kept');
		return 'no-swap';
	}
	d.write(control(CONTROL.lock), String(Date.now()));
	try {
		return await swap(cfg, mode, d);
	} catch (err) {
		// Nothing in swap() is expected to throw (every dependency reports rather than throws), but if
		// one does, the one thing that matters is that an install exists before handing over.
		d.log(`unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
		if (!d.exists(join(cfg.install, cfg.exe)) && d.exists(cfg.old) && !d.exists(cfg.install)) {
			d.rename(cfg.old, cfg.install);
		}
		return await fallback(cfg, mode, d);
	} finally {
		// The recovery stays armed whenever there is no whole install, so the next logon mends it.
		if (d.exists(join(cfg.install, cfg.exe))) {
			disarmRecovery(cfg, d);
		}
		d.remove(control(CONTROL.mode));
		d.remove(control(CONTROL.lock));
	}
}

/** What the next logon runs if the swap was cut off between its two renames. ASCII where it can be
 *  (the install named through %LOCALAPPDATA%); otherwise UTF-8 under code page 65001. */
export function recoveryScript(cfg: WaiterConfig): string {
	const local = cfg.recovery.localAppData;
	const name = (path: string): string => (local && path.toLowerCase().startsWith(`${local.toLowerCase()}\\`) ? `%LOCALAPPDATA%${path.slice(local.length)}` : path);
	const leaf = (path: string): string => path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
	return [
		'@echo off',
		'chcp 65001 >nul',
		'setlocal',
		`set "INST=${name(cfg.install)}"`,
		`set "NEXT=${name(cfg.next)}"`,
		`set "OLD=${name(cfg.old)}"`,
		`set "EXE=${cfg.exe}"`,
		`set "LEAF=${leaf(cfg.install)}"`,
		'rem A SnoutData update was cut off (a power cut) between moving the old version aside and',
		'rem moving the new one in. Finish it, or put the old one back, then remove this script.',
		'if exist "%INST%\\%EXE%" goto done',
		'if exist "%INST%" goto done',
		'if exist "%NEXT%\\%EXE%" ren "%NEXT%" "%LEAF%" && goto done',
		'if exist "%OLD%\\%EXE%" ren "%OLD%" "%LEAF%"',
		':done',
		`reg delete "${cfg.recovery.runOnceKey}" /v "${cfg.recovery.runOnceName}" /f >nul 2>&1`,
		'(goto) 2>nul & del "%~f0"',
		'',
	].join('\r\n');
}

function armRecovery(cfg: WaiterConfig, d: WaiterDeps): boolean {
	if (!d.writeDurable(cfg.recovery.script, recoveryScript(cfg))) {
		return false;
	}
	// A second way in, for a machine whose Startup folder does not run; the script is safe to run twice.
	d.reg(cfg.recovery.runOnceKey, cfg.recovery.runOnceName, `cmd.exe /d /c "${cfg.recovery.script}"`);
	return true;
}

function disarmRecovery(cfg: WaiterConfig, d: WaiterDeps): void {
	d.remove(cfg.recovery.script);
	d.unreg(cfg.recovery.runOnceKey, cfg.recovery.runOnceName);
}

async function swap(cfg: WaiterConfig, mode: SwapMode, d: WaiterDeps): Promise<WaiterOutcome> {
	if (d.exists(cfg.old)) {
		d.removeDir(cfg.old);
		if (d.exists(cfg.old)) {
			d.log('a leftover .old could not be removed');
			return await fallback(cfg, mode, d);
		}
	}
	if (!d.exists(join(cfg.next, cfg.exe))) {
		d.log('the stage is missing');
		return await fallback(cfg, mode, d);
	}
	// Windows renames a folder even while a program inside it runs, so the folder failing to move is
	// no guard. The app's children exit just after it does; give them a moment, then end whatever is
	// left, exactly as the stock installer does. What is left is Electron's crash reporter
	// (--type=crashpad-handler), which outlives the app and once held a swap up for the whole wait,
	// which then fell back to the stock installer for nothing (found driving it, 2026-10-04). A copy
	// someone launches in the meantime waits for the `swapping` lock and does not get this far.
	for (let waited = 0; d.otherAppProcesses(cfg.exe) > 0 && waited < SETTLE_CHECKS; waited++) {
		await d.sleep(250);
	}
	if (d.otherAppProcesses(cfg.exe) > 0) {
		d.log('ending what is left of the app');
		d.closeApp(cfg.exe);
		await d.sleep(500);
	}
	// Before anything moves: what mends a power cut between the two renames. No recovery, no swap.
	// Swapping without it is still safer than the stock installer it would fall back to, whose
	// unprotected window is the whole 20-45 s uninstall-and-extract rather than one moment.
	if (!armRecovery(cfg, d)) {
		d.log('the power-cut recovery could not be written to disk; swapping without it');
	}
	// The ORDER keeps an install whole: the live folder moves aside only once the stage is known to
	// be there, and if the stage then cannot move in, the live folder is put back before anything else.
	if (!(await retry(cfg.tries, d, () => d.rename(cfg.install, cfg.old)))) {
		d.log('the install folder could not be moved aside');
		return await fallback(cfg, mode, d);
	}
	if (!(await retry(cfg.tries, d, () => d.rename(cfg.next, cfg.install)))) {
		d.log('the stage could not be moved in; putting the live install back');
		if (!(await retry(RESTORE_TRIES, d, () => d.rename(cfg.old, cfg.install)))) {
			d.log('the live install could not be put back');
		}
		return await fallback(cfg, mode, d);
	}
	d.remove(join(cfg.install, cfg.marker));
	d.reg(cfg.uninstallKey, 'DisplayVersion', cfg.version);
	d.reg(cfg.uninstallKey, 'DisplayName', cfg.displayName);
	// electron-updater diffs the next download against this copy; the stock installer refreshes it.
	d.copy(cfg.installer, cfg.installerCache);
	if (mode !== 'quit') {
		d.launch(join(cfg.install, cfg.exe), ['--updated']);
	}
	d.log(`swapped in v${cfg.version}`);
	// This process's own executable is in there, so some of it stays; the next launch removes the rest.
	d.removeDir(cfg.old);
	return 'swapped';
}

/** About half a second (the stock installer allows 300 ms): the renderer and GPU process go with the
 *  app, and the crash reporter never leaves on
 *  its own, so waiting longer only makes Restart slower. */
const SETTLE_CHECKS = 2;

/** Ten minutes: nothing but us has a reason to hold the folder we just moved. */
const RESTORE_TRIES = 600;

async function retry(tries: number, d: WaiterDeps, attempt: () => boolean): Promise<boolean> {
	for (let n = 0; n < tries; n++) {
		if (attempt()) {
			return true;
		}
		await d.sleep(1000);
	}
	return false;
}

/** Windows exit codes from 0xC0000000 up are crashes (0xC0000005 is an access violation). */
export function crashed(code: number | null): boolean {
	return code === null || code >= 0xc0000000 || code < 0;
}

const INSTALLER_ATTEMPTS = 3;

/** The stock installer, as electron-updater would run it, retried when it CRASHES: NSIS 3.0.4.1's
 *  System plugin intermittently dies in .onInit before doing anything (seen while building this),
 *  and a fallback that silently did nothing would leave the update for another day. Any exit that
 *  is not a crash is the installer's own answer and is left alone. */
async function fallback(cfg: WaiterConfig, mode: SwapMode, d: WaiterDeps): Promise<WaiterOutcome> {
	for (let attempt = 1; attempt <= INSTALLER_ATTEMPTS; attempt++) {
		d.log(`running the stock installer (attempt ${attempt})`);
		const code = await d.run(cfg.installer, cfg.fallbackArgs[mode]);
		if (!crashed(code)) {
			d.log(`the stock installer exited ${code}`);
			return 'fallback';
		}
		d.log(`the stock installer crashed (${code})`);
		await d.sleep(3000);
	}
	return 'fallback';
}

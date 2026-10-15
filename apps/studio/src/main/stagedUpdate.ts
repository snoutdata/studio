/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { constants as osConstants, setPriority, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isNewerVersion } from '../shared/update';
import { CONTROL, type SwapMode, type WaiterConfig } from './swapWaiter';

// STAGED WINDOWS UPDATES.
//
// electron-updater's NSIS path runs the whole installer at quit time: it uninstalls the live app
// and writes ~750 MB back while the user stares at nothing, which is why the first launch after an
// update took 20-45 s against a normal 1.5 s. VSCode restarts in seconds because its installer
// already ran in the background; Restart only swaps folders. This is the same shape:
//
//   1. stage: as soon as the verified installer has downloaded, run it as
//      `<installer> /S --snout-stage=<install>.next`. build/installer.nsh makes that ONLY unpack the
//      app beside the live one (no kill, no uninstall, no registry), at below-normal priority.
//   2. check: start the STAGED build with `--snout-self-check` against a scratch profile
//      (selfCheck.ts). A build that cannot start is never swapped in. Then force every staged file
//      to disk (flushTree), so a power cut after the swap cannot leave half-written files.
//   3. wait: start the waiter (swapWaiter.ts) NOW, while the app is up, and only offer Restart once
//      it says it is running. On Restart, a tray install or a plain quit the app writes one flag
//      file; once it has exited, the waiter renames <install> to <install>.old and <install>.next to
//      <install>, fixes the version Windows shows under Installed apps, and relaunches.
//
// THE RULE: AN UPDATE MUST NEVER STRAND AN INSTALL, because a broken install has no updater left to
// fix it. So every failure lands on the stock installer, which is exactly what ran before this
// existed, and nothing here is ever worse than it:
//   - a stage that fails, is incomplete, or whose build fails its self-check: stock install on quit;
//   - a quit while a stage is still being written: the stage is cancelled, stock install on quit;
//   - Windows shutting down: no swap at all (a helper killed between its two renames would leave no
//     app); the stage waits for the next quit;
//   - a waiter that does not start: found before Restart is offered, stock install on quit;
//   - a waiter that is gone by quit time (killed): stock install on quit;
//   - a waiter that cannot get the folder, or cannot move the stage in: it puts the live install
//     back and runs the stock installer;
//   - a swap that still never lands: the next launch is still the old version, and after
//     MAX_SWAP_ATTEMPTS of those the version goes the stock way (swapAllowed).
// Nothing here imports electron, so the decisions are testable under `node --test`.

export interface StagePaths {
	install: string;
	next: string;
	old: string;
}

/** The live install folder is the one holding the executable; the stage and the folder it is
 *  swapped out to are its siblings, so both moves are same-volume renames. */
export function stagePaths(execPath: string): StagePaths {
	const install = dirname(execPath);
	return { install, next: `${install}.next`, old: `${install}.old` };
}

/** What build/installer.nsh writes into `.snout-staged` once the stage is whole. */
export interface StageMarker {
	version: string;
	uninstallKey: string;
	displayName: string;
}

export const STAGE_MARKER = '.snout-staged';
export const SELF_CHECK_FLAG = '--snout-self-check';

export function parseStageMarker(text: string): StageMarker | null {
	const [version, uninstallKey, displayName] = text.split(/\r?\n/).map((line) => line.trim());
	if (!version || !uninstallKey || !displayName) {
		return null;
	}
	return { version, uninstallKey, displayName };
}

/** How the swap was asked for, which decides whether the app comes back and, if the swap cannot
 *  happen, how the stock installer is run (the same arguments electron-updater would pass). */
export type { SwapMode };

export function fallbackInstallerArgs(mode: SwapMode): string[] {
	if (mode === 'restart') {
		return ['--updated', '--force-run'];
	}
	if (mode === 'background') {
		return ['--updated', '/S', '--force-run'];
	}
	return ['--updated', '/S'];
}

export interface StagedUpdate {
	marker: StageMarker;
	installer: string;
	paths: StagePaths;
}

export interface StageHooks {
	log(message: string): void;
	/** Something went wrong that we want to hear about from the field (Sentry). */
	report(message: string, extra?: Record<string, unknown>): void;
	/** Aborted when the app quits: a stage still being written is abandoned. */
	signal: AbortSignal;
	/** out/server/swap-waiter.cjs, which also does the folder work (runFolderTool). */
	tool: string;
}

/**
 * Unpack the downloaded installer beside the live app and prove the result starts. Resolves to the
 * staged update, or null when it cannot be staged, in which case the caller keeps the stock
 * install-on-quit.
 */
export async function stageUpdate(installer: string, version: string, execPath: string, hooks: StageHooks): Promise<StagedUpdate | null> {
	const { log } = hooks;
	const paths = stagePaths(execPath);
	// electron-updater re-announces an already-downloaded update on every launch until it is
	// installed; a stage of that version that finished last time is still good, once it passes the
	// check again (something may have deleted part of it since).
	const existing = readStage(paths, execPath);
	if (existing?.version === version) {
		log(`staged update: v${version} already staged in ${paths.next}`);
		if ((await selfCheck(paths, execPath, hooks)) && (await flushTree(paths.next, hooks))) {
			return { marker: existing, installer, paths };
		}
	}
	try {
		// A per-machine install under Program Files is not writable without elevation, and staging
		// must never prompt. Probe with a folder rather than fs.access, which on Windows only reads
		// the read-only attribute.
		await removeStage(paths, hooks);
		await mkdir(paths.next);
		await rmdir(paths.next);
	} catch (err) {
		log(`staged update: cannot write beside ${paths.install} (${err instanceof Error ? err.message : String(err)}), installing on quit instead`);
		return null;
	}
	// NSIS 3.0.4.1's System plugin (what electron-builder 25 ships) intermittently crashes in the
	// installer's .onInit, before the stage branch is reached (seen in about one rapid run in four
	// while building this). A stage starts by wiping its folder, so trying again is safe.
	for (let attempt = 1; attempt <= STAGE_ATTEMPTS && !hooks.signal.aborted; attempt++) {
		const started = Date.now();
		log(`staged update: unpacking v${version} into ${paths.next} (attempt ${attempt})`);
		const code = await runFolderTool(hooks, ['--run', String(STAGE_TIMEOUT_MS), installer, '/S', `--snout-stage=${paths.next}`]);
		const marker = code === 0 ? readStage(paths, execPath) : null;
		if (marker?.version === version) {
			log(`staged update: v${version} unpacked in ${Math.round((Date.now() - started) / 1000)}s`);
			if ((await selfCheck(paths, execPath, hooks)) && (await flushTree(paths.next, hooks))) {
				return { marker, installer, paths };
			}
			// A build that unpacked whole and still cannot start will not start on a second unpack.
			break;
		}
		log(`staged update: stage incomplete (exit ${code}, marker ${marker ? marker.version : 'missing'})`);
		await removeStage(paths, hooks);
		if (attempt < STAGE_ATTEMPTS && !hooks.signal.aborted) {
			await new Promise((resolve) => setTimeout(resolve, STAGE_RETRY_DELAY_MS));
		}
	}
	await removeStage(paths, hooks);
	if (hooks.signal.aborted) {
		log('staged update: abandoned, the app is quitting');
	} else {
		hooks.report('staged update: could not stage, installing on quit instead', { version });
		log('staged update: giving up, installing on quit instead');
	}
	return null;
}

// "Ready" waits for the stage, so a hung installer must not hold it: a stage takes ~5 s.
const STAGE_TIMEOUT_MS = 3 * 60_000;
const STAGE_ATTEMPTS = 3;
const STAGE_RETRY_DELAY_MS = 5_000;
const SELF_CHECK_TIMEOUT_MS = 90_000;

async function removeStage(paths: StagePaths, hooks: FolderToolHooks): Promise<void> {
	await runFolderTool(hooks, ['--remove', paths.next]);
}

/**
 * Force every staged file to disk. NTFS journals names, not contents: without this a power cut just
 * after the swap could leave the renamed-in install with files that are there and empty. False (and
 * the stage is not used) if any file cannot be flushed.
 */
export async function flushTree(dir: string, hooks: FolderToolHooks): Promise<boolean> {
	const started = Date.now();
	const ok = (await runFolderTool(hooks, ['--flush', dir])) === 0;
	hooks.log(ok ? `staged update: the stage was forced to disk in ${Date.now() - started}ms` : 'staged update: the stage could not be forced to disk');
	return ok;
}

export type FolderToolHooks = Pick<StageHooks, 'log' | 'tool'> & Partial<Pick<StageHooks, 'signal'>>;

/**
 * Whole-folder work on an install (walk, flush, delete) and starting the heavy programs (the
 * installer, the staged build's self-check) NEVER happen in the app's main process. Found by doing
 * them there (2026-10-04): a walk froze the window for as long as it took, and Electron's archive
 * support treats every `app.asar` as a folder, so a walk of one install met 15,523 entries where there
 * are 951 and tried to open the archive's insides for writing; and starting a program is synchronous
 * on Windows, with Defender scanning a NEW executable inside that call, so starting the 140 MB
 * installer stalled the window 556 ms and the freshly unpacked build 328 ms. So the app starts only
 * this: its OWN executable (already scanned) in Node mode with archive support OFF
 * (ELECTRON_NO_ASAR), on a copy of the tool taken out of the asar; the tool does the work or starts
 * the program. Resolves with the tool's exit code (for `--run`, the program's), null if it never ran.
 */
export async function runFolderTool(hooks: FolderToolHooks, args: string[], env: NodeJS.ProcessEnv = {}): Promise<number | null> {
	let script: string;
	try {
		script = join(tmpdir(), `snoutdata-folder-tool-${process.pid}.cjs`);
		if (!existsSync(script)) {
			copyFileSync(hooks.tool, script);
		}
	} catch (err) {
		hooks.log(`staged update: the folder tool is unavailable (${err instanceof Error ? err.message : String(err)})`);
		return null;
	}
	const signal = hooks.signal ?? new AbortController().signal;
	return runChild(process.execPath, [script, ...args], { ...env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' }, FOLDER_TOOL_TIMEOUT_MS, { log: hooks.log, signal });
}

// Above every `--run` timeout the tool is handed, so the tool reports a hung program itself.
const FOLDER_TOOL_TIMEOUT_MS = 6 * 60_000;

/** The marker of a WHOLE stage: written last by the installer, and the executable beside it. */
function readStage(paths: StagePaths, execPath: string): StageMarker | null {
	const markerPath = join(paths.next, STAGE_MARKER);
	if (!existsSync(markerPath) || !existsSync(join(paths.next, basename(execPath)))) {
		return null;
	}
	return parseStageMarker(readFileSync(markerPath, 'utf8'));
}

/** Start the staged build in check mode, in a scratch profile with reporting off, so it touches
 *  nothing of the user's and sends nothing. */
async function selfCheck(paths: StagePaths, execPath: string, hooks: StageHooks): Promise<boolean> {
	const profile = join(tmpdir(), `snoutdata-self-check-${process.pid}-${Date.now()}`);
	try {
		await mkdir(profile, { recursive: true });
		writeFileSync(join(profile, 'telemetry.json'), JSON.stringify({ enabled: false }), 'utf8');
	} catch (err) {
		hooks.log(`staged update: no scratch profile for the self-check (${err instanceof Error ? err.message : String(err)})`);
		return false;
	}
	const started = Date.now();
	const code = await runFolderTool(hooks, ['--run', String(SELF_CHECK_TIMEOUT_MS), join(paths.next, basename(execPath)), SELF_CHECK_FLAG], { SNOUT_E2E_USERDATA: profile });
	let reason = '';
	try {
		reason = readFileSync(join(profile, 'self-check.txt'), 'utf8').trim();
	} catch {
		reason = 'no answer';
	}
	await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => undefined);
	if (code === 0 && reason === 'ok') {
		hooks.log(`staged update: the staged build passed its self-check in ${Math.round((Date.now() - started) / 1000)}s`);
		return true;
	}
	if (!hooks.signal.aborted) {
		hooks.report('staged update: the staged build failed its self-check', { exit: code, reason });
	}
	hooks.log(`staged update: the staged build FAILED its self-check (exit ${code}: ${reason}), installing on quit instead`);
	return false;
}

function runChild(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, hooks: Pick<StageHooks, 'log' | 'signal'>): Promise<number | null> {
	return new Promise<number | null>((resolve) => {
		if (hooks.signal.aborted) {
			resolve(null);
			return;
		}
		// Never the app's working folder: launched from its shortcut that is the install folder, and a
		// process whose working folder it is stops it being renamed (EBUSY). That alone held a real
		// swap up for its whole wait (2026-10-04).
		const child = spawn(file, args, { cwd: tmpdir(), windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
		// The tool's own children (an installer, a self-check) go with it: an orphaned installer would
		// keep the NSIS mutex the stock install on quit needs.
		const kill = (): void => {
			if (process.platform === 'win32' && child.pid !== undefined) {
				spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
			} else {
				child.kill();
			}
		};
		const timer = setTimeout(kill, timeoutMs);
		hooks.signal.addEventListener('abort', kill, { once: true });
		const done = (code: number | null): void => {
			clearTimeout(timer);
			hooks.signal.removeEventListener('abort', kill);
			resolve(code);
		};
		child.once('spawn', () => {
			try {
				setPriority(child.pid ?? 0, osConstants.priority.PRIORITY_BELOW_NORMAL);
			} catch {
				// A lower priority is a courtesy to whatever the user is doing; it works without it.
			}
		});
		child.once('error', (err) => {
			hooks.log(`staged update: ${basename(file)} did not start: ${err.message}`);
			done(null);
		});
		child.once('exit', (exitCode) => done(exitCode));
	});
}

// ── The swap record: the one thing that notices a helper which never ran ─────────────────────

export const MAX_SWAP_ATTEMPTS = 2;
const SWAP_RECORD = 'staged-update.json';

export interface SwapRecord {
	version: string;
	attempts: number;
}

export function readSwapRecord(userData: string): SwapRecord | null {
	try {
		const raw = JSON.parse(readFileSync(join(userData, SWAP_RECORD), 'utf8')) as Partial<SwapRecord>;
		return typeof raw.version === 'string' && typeof raw.attempts === 'number' ? { version: raw.version, attempts: raw.attempts } : null;
	} catch {
		return null;
	}
}

function writeSwapRecord(userData: string, record: SwapRecord | null): void {
	try {
		if (record) {
			writeFileSync(join(userData, SWAP_RECORD), JSON.stringify(record), 'utf8');
		} else {
			rmSync(join(userData, SWAP_RECORD), { force: true });
		}
	} catch {
		// Losing the record costs at most one more swap attempt.
	}
}

/** Written just before a swap is started, so the next launch can tell whether it happened. */
export function noteSwapAttempt(userData: string, version: string): void {
	const record = readSwapRecord(userData);
	writeSwapRecord(userData, { version, attempts: record?.version === version ? record.attempts + 1 : 1 });
}

/** A version whose swap has been tried and has not happened MAX_SWAP_ATTEMPTS times goes the stock
 *  way: something on this machine is stopping the helper, and the stock installer does not need it. */
export function swapAllowed(record: SwapRecord | null, version: string): boolean {
	return !(record && record.version === version && record.attempts >= MAX_SWAP_ATTEMPTS);
}

/** What a launch learns from the record: the swap it was waiting for happened (or a newer version
 *  superseded it), or it did not. */
export function settleSwapRecord(userData: string, currentVersion: string): SwapRecord | null {
	const record = readSwapRecord(userData);
	if (!record) {
		return null;
	}
	if (!isNewerVersion(record.version, currentVersion)) {
		writeSwapRecord(userData, null);
		return null;
	}
	return record;
}

/** Leftovers: the `.old` a swap could not remove, and a `.next` that is not newer than this build
 *  (its update arrived some other way). A whole `.next` of a newer version is kept for reuse. */
export async function cleanupStage(execPath: string, currentVersion: string, hooks: FolderToolHooks): Promise<void> {
	const paths = stagePaths(execPath);
	if (existsSync(paths.old)) {
		await runFolderTool(hooks, ['--remove', paths.old]);
	}
	// The last waiter's files; a waiter for THIS session is only ever started after this has run.
	await rm(controlDir(execPath), { recursive: true, force: true }).catch(() => undefined);
	const marker = readStage(paths, execPath);
	if (existsSync(paths.next) && (!marker || !isNewerVersion(marker.version, currentVersion))) {
		await removeStage(paths, hooks);
	}
}

// ── The waiter ────────────────────────────────────────────────────────────────────────────

export interface Waiter {
	pid: number;
	control: string;
}

/** The folder the waiter and the app talk through, beside the install so a launch can find the
 *  swap lock from its own path alone. */
export function controlDir(execPath: string): string {
	return `${stagePaths(execPath).install}.swap`;
}

const WAITER_READY_MS = 15_000;
const RECOVERY_SCRIPT = 'snoutdata-update-recovery.cmd';
const WAITER_EXE = 'swap-waiter.exe';
const WAITER_DATA_FILES = ['icudtl.dat', 'v8_context_snapshot.bin', 'snapshot_blob.bin'];

/**
 * Start the waiter that will swap this stage in once the app quits (swapWaiter.ts), and wait for
 * it to say it is running. Null when it does not start, so the caller keeps the stock path, and
 * knows that now rather than at quit.
 */
export async function startWaiter(staged: StagedUpdate, execPath: string, waiterScript: string, logFile: string, log: (message: string) => void): Promise<Waiter | null> {
	const control = controlDir(execPath);
	const { paths, marker, installer } = staged;
	// The power-cut recovery lives in the Startup folder; without one there is no swap at all.
	const appData = process.env.APPDATA;
	if (!appData) {
		log('staged update: no %APPDATA%, so no Startup folder for the power-cut recovery; installing on quit instead');
		return null;
	}
	const config: WaiterConfig = {
		appPid: process.pid,
		install: paths.install,
		next: paths.next,
		old: paths.old,
		exe: basename(execPath),
		installer,
		installerCache: join(dirname(dirname(installer)), 'installer.exe'),
		uninstallKey: `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${marker.uninstallKey}`,
		version: marker.version,
		displayName: marker.displayName,
		marker: STAGE_MARKER,
		control,
		log: logFile,
		// Five seconds of retrying a rename: what blocks one does not let go by waiting, and a person is
		// looking at an empty screen meanwhile. Then the stock installer, which at least shows itself.
		tries: Number(process.env.SNOUT_SWAP_TRIES ?? 5),
		fallbackArgs: { restart: fallbackInstallerArgs('restart'), background: fallbackInstallerArgs('background'), quit: fallbackInstallerArgs('quit') },
		recovery: {
			script: join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', RECOVERY_SCRIPT),
			runOnceKey: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
			runOnceName: 'SnoutDataUpdateRecovery',
			localAppData: process.env.LOCALAPPDATA,
		},
	};
	let pid: number | undefined;
	try {
		await rm(control, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		await mkdir(control, { recursive: true });
		// Out of the asar: the copy is what runs, so nothing it needs moves when the install does.
		copyFileSync(waiterScript, join(control, CONTROL.script));
		writeFileSync(join(control, CONTROL.config), JSON.stringify(config), 'utf8');
		// The waiter runs as a HARD LINK to this executable, beside the three data files Node mode
		// opens (swapWaiter.ts says why it cannot run from the install folder). A link costs nothing
		// on disk and needs NTFS, which Programs always is; where it fails the stock path is used.
		linkSync(execPath, join(control, WAITER_EXE));
		for (const file of WAITER_DATA_FILES) {
			if (existsSync(join(paths.install, file))) {
				linkSync(join(paths.install, file), join(control, file));
			}
		}
		const child = spawn(join(control, WAITER_EXE), [join(control, CONTROL.script), join(control, CONTROL.config)], {
			// Not the app's working folder, which is the install folder when it was launched from its
			// shortcut: the waiter would then be holding the very folder it has to rename.
			cwd: tmpdir(),
			// Archive support off: the waiter deletes the old install, which holds an app.asar.
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
			detached: true,
			windowsHide: true,
			stdio: 'ignore',
		});
		child.on('error', (err) => log(`staged update: the waiter did not start: ${err.message}`));
		child.unref();
		pid = child.pid;
	} catch (err) {
		log(`staged update: the waiter could not be set up: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
	for (const started = Date.now(); Date.now() - started < WAITER_READY_MS; ) {
		if (pid !== undefined && existsSync(join(control, CONTROL.ready))) {
			log(`staged update: the waiter is running (pid ${pid})`);
			return { pid, control };
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	log('staged update: the waiter never said it was running');
	if (pid !== undefined) {
		try {
			process.kill(pid);
		} catch {
			// Already gone.
		}
	}
	return null;
}

export function waiterAlive(waiter: Waiter): boolean {
	try {
		process.kill(waiter.pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Tell the waiter how the app is quitting. False when it is no longer there to hear it (the
 *  caller then takes the stock path). */
export function requestSwap(waiter: Waiter, mode: SwapMode): boolean {
	if (!waiterAlive(waiter)) {
		return false;
	}
	try {
		writeFileSync(join(waiter.control, CONTROL.mode), mode, 'utf8');
		return true;
	} catch {
		return false;
	}
}

export function signalSessionEnd(waiter: Waiter): void {
	try {
		writeFileSync(join(waiter.control, CONTROL.sessionEnd), '1', 'utf8');
	} catch {
		// With no flag the waiter sees no mode either, and does not swap.
	}
}

/** The stage is being replaced: send the waiter away and wait until it has gone. */
export async function cancelWaiter(waiter: Waiter): Promise<void> {
	try {
		writeFileSync(join(waiter.control, CONTROL.cancel), '1', 'utf8');
	} catch {
		// Killed below instead.
	}
	for (let n = 0; n < 30 && waiterAlive(waiter); n++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	if (waiterAlive(waiter)) {
		try {
			process.kill(waiter.pid);
		} catch {
			// Gone between the check and the kill.
		}
	}
}

/** A swap whose lock is older than this was interrupted (a power cut); it is not waited on. */
const STALE_SWAP_MS = 5 * 60_000;
const SWAP_WAIT_MS = 60_000;

/**
 * Called first thing at launch. A launch that lands while a swap is moving folders (someone
 * double-clicks the icon the second they quit) must not start from a folder that is about to be
 * renamed under it, so it waits for the swap to finish and then starts the install that is there
 * now. True when this process should exit because it has relaunched. One existsSync when there is
 * no swap, which is every launch but that one.
 */
export function waitOutSwap(execPath: string): boolean {
	const lock = join(controlDir(execPath), CONTROL.lock);
	if (!existsSync(lock)) {
		return false;
	}
	try {
		if (Date.now() - statSync(lock).mtimeMs > STALE_SWAP_MS) {
			return false;
		}
	} catch {
		return false;
	}
	const pause = new Int32Array(new SharedArrayBuffer(4));
	for (const started = Date.now(); existsSync(lock) && Date.now() - started < SWAP_WAIT_MS; ) {
		Atomics.wait(pause, 0, 0, 200);
	}
	spawn(execPath, process.argv.slice(1), { detached: true, stdio: 'ignore' }).unref();
	return true;
}

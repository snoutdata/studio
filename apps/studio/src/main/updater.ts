/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, autoUpdater as squirrelMac } from 'electron';
import { autoUpdater as electronUpdater, type NsisUpdater, type UpdateInfo } from 'electron-updater';
import * as Sentry from '@sentry/electron/main';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { OFFICIAL_BUILD, updateCheckRoute } from '../shared/officialBuild';
import { describeUpdateFailure, isNewerVersion, type UpdateStatus } from '../shared/update';
import { isNetworkError, netFetch } from './netFetch';
import { signatureRefusal, WINDOWS_PUBLISHER_NAMES } from './updateSignature';
import { cancelWaiter, cleanupStage, MAX_SWAP_ATTEMPTS, noteSwapAttempt, readSwapRecord, requestSwap, settleSwapRecord, signalSessionEnd, stageUpdate, startWaiter, swapAllowed, type StagedUpdate, type SwapMode, type Waiter } from './stagedUpdate';

// What the last swap left is looked at this long after launch: startup is sacred, and nothing
// waits for it but a stage, which is minutes away at the earliest.
const STAGE_CLEANUP_DELAY_MS = 20_000;

/** The waiter and folder tool, bundled by esbuild.server.mjs; inside the asar, so always copied out
 *  before it runs. */
function waiterScript(): string {
	return path.join(__dirname, '../server/swap-waiter.cjs');
}

function updateLogPath(): string {
	return path.join(app.getPath('userData'), 'update.log');
}

// A staged update that went wrong in the field: these are the reports that say the never-strand
// fallbacks are being used, which is the only way we would learn the fast path has stopped working.
function reportStaging(message: string, extra?: Record<string, unknown>): void {
	Sentry.captureException(new Error(message), { tags: { area: 'auto-update', platform: process.platform, failure: 'staged-update' }, extra });
}

/** Whether the swap this launch was waiting for happened, and the leftovers of it removed. */
async function settleLastSwap(): Promise<void> {
	const record = settleSwapRecord(app.getPath('userData'), app.getVersion());
	if (record) {
		const message = `staged update: v${record.version} was swapped in ${record.attempts} time(s) but this is still v${app.getVersion()}`;
		logUpdate(message);
		reportStaging(message, { attempts: record.attempts });
	}
	await cleanupStage(process.execPath, app.getVersion(), { log: logUpdate, tool: waiterScript() });
}

type Emit = (status: UpdateStatus) => void;

// The macOS swap runs in ShipIt (out of process) and Electron's quitAndInstall is opaque, so
// record the sequence — every Squirrel event + the install call — to userData/update.log. This
// is how we diagnose an install that downloads but never applies, on a user's machine or ours.
export function logUpdate(message: string): void {
	try {
		const stamp = new Date().toISOString();
		fs.appendFileSync(path.join(app.getPath('userData'), 'update.log'), `${stamp} ${message}\n`);
	} catch {
		// logging must never throw / never block an update
	}
}

// The PUBLIC release feed (matches electron-builder.yml `publish:`). Used only as a fallback.
const DEFAULT_FEED = 'https://github.com/snoutdata/studio/releases/latest/download';

// The macOS path needs the SAME GitHub repo electron-builder baked into app-update.yml from
// the `publish:` block (the file electron-updater reads on Windows). Deriving the feed from
// it means overriding the repo at build time — `-c.publish.owner=… -c.publish.repo=…`, e.g.
// to a throwaway test repo — flows to BOTH the Windows and macOS paths from one source, with
// nothing to edit (or revert) in code. GitHub serves the newest published (non-draft,
// non-prerelease) release under the static `latest/download` path, so no GitHub API (and no
// auth/rate-limit) is needed to find "the latest". Falls back to the public repo if unread.
function feedBase(): string {
	try {
		const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
		const owner = yml.match(/^owner:\s*(.+)$/m)?.[1]?.trim();
		const repo = yml.match(/^repo:\s*(.+)$/m)?.[1]?.trim();
		if (owner && repo) {
			return `https://github.com/${owner}/${repo}/releases/latest/download`;
		}
	} catch {
		// app-update.yml missing/unreadable (e.g. dev) — fall back to the public feed.
	}
	return DEFAULT_FEED;
}

// Updater failures are HANDLED here (caught -> emitted to the renderer as a status), so
// Sentry's automatic unhandled-exception capture never sees them. Report them explicitly.
// Sentry.init() may not have run (dev / no DSN / opted out) — captureException is a safe
// no-op in that case, so we don't need to gate on telemetryActive().
//
// EXCEPT connectivity failures: a laptop that's asleep, offline, or behind a captive portal
// can't reach the feed, and there's nothing to fix on our side. Reporting those made an
// update check on a closed laptop lid look like a crash. The renderer still gets the error
// status either way — this only decides what's worth telling us about.
function reportUpdateError(err: unknown): UpdateStatus {
	const raw = err instanceof Error ? err.message : String(err);
	// electron-builder's HttpError carries the code; Squirrel's errors do not, and the classifier
	// reads the text in that case.
	const statusCode = typeof (err as { statusCode?: unknown })?.statusCode === 'number' ? (err as { statusCode: number }).statusCode : undefined;
	const failure = describeUpdateFailure(raw, statusCode);
	// The whole error goes to the log, where it is wanted in full; nothing else ever sees it.
	logUpdate(`update error (${failure.kind}): ${raw}`);
	// `offline` is the one kind nobody can act on and nobody needs to hear about: a laptop with
	// its lid shut produces it on every check, and reporting it made that look like a crash. The
	// rest are worth knowing, and the KIND is a tag so "GitHub was down for an hour" and "a
	// download failed its signature" are not one undifferentiated pile.
	if (failure.kind !== 'offline' && !isNetworkError(err)) {
		Sentry.captureException(err instanceof Error ? err : new Error(raw), {
			tags: { area: 'auto-update', platform: process.platform, failure: failure.kind, ...(statusCode ? { status: String(statusCode) } : {}) },
			extra: { detail: failure.detail },
		});
	}
	return { state: 'error', message: failure.message, kind: failure.kind, detail: failure.detail };
}

interface UpdaterImpl {
	check(): void;
	download(): void;
	/** `background`: nobody asked, the app is idle in the tray (trayInstall.ts). Install without a
	 *  visible installer and bring the app back afterwards. */
	quitAndInstall(background?: boolean): void;
	/** Windows is logging off or shutting down (a window's 'session-end'). */
	sessionEnding?(): void;
}

// ── Windows ──────────────────────────────────────────────────────────────────────────
// electron-updater (NSIS installer + blockmap differential downloads). The feed comes from
// electron-builder's `publish:` config baked into `app-update.yml` at package time. On
// Windows we fetch the installer silently in the background as soon as one is found (no
// "Download" button), then surface a "ready" cue and install on the next quit (or an
// explicit "Restart & Update"). Linux is constructed here too but never drives a check
// (AppUpdater short-circuits it — apt owns Linux updates).
class ElectronUpdaterImpl implements UpdaterImpl {
	private readonly emit: Emit;
	private wired = false;
	private staged: StagedUpdate | null = null;
	/** The process that swaps the stage in after the app exits; set exactly when `staged` is. */
	private waiter: Waiter | null = null;
	private stageRun: Promise<void> = Promise.resolve();
	private swapping = false;
	private quitting = false;
	private sessionEnded = false;
	/** The last download failed its signature check: electron-updater's own
	 *  install must not run it, on Restart or on quit. A verified stage may still swap in. */
	private refused = false;
	private readonly quitSignal = new AbortController();
	/** Leftovers of the last swap, cleared off the boot path; a stage waits for it. */
	private readonly cleanup: Promise<void>;

	constructor(emit: Emit) {
		this.emit = emit;
		this.cleanup = process.platform === 'win32' && app.isPackaged
			? new Promise<void>((resolve) => {
				setTimeout(() => void settleLastSwap().then(resolve), STAGE_CLEANUP_DELAY_MS).unref();
			})
			: Promise.resolve();
		this.hookQuit();
		electronUpdater.autoDownload = process.platform === 'win32';
		electronUpdater.autoInstallOnAppQuit = true;
		// Force every feed/manifest request to skip caches. Without this an intermediary (a corporate
		// proxy, a VPN, even a stale OS-level cache) can serve a previous latest.yml, so a freshly
		// published release reads as "up to date" while the app is open. GitHub itself sends no-cache,
		// but we can't assume the network between us and GitHub honors that.
		electronUpdater.requestHeaders = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' };
		// Route electron-updater's own trace into update.log. Without this a Windows update check is
		// invisible: update.log only ever recorded the macOS/Squirrel path, so when a check reports
		// "up to date" against a feed we believe is newer, there is nothing to tell "the feed said
		// that" apart from "we never asked". This logs which version the feed actually returned, and
		// prints "Checking for update (already in progress)" if a wedged in-flight check is being
		// reused (the one way a check can go stale until restart).
		electronUpdater.logger = {
			info: (m) => logUpdate(`electron-updater: ${m}`),
			warn: (m) => logUpdate(`electron-updater WARN: ${m}`),
			error: (m) => logUpdate(`electron-updater ERROR: ${m}`),
			debug: (m) => logUpdate(`electron-updater debug: ${m}`),
		};
	}

	// The GitHub release body is markdown and arrives as a string; other providers can hand
	// back a per-version array. Normalize to a single markdown string (or undefined).
	private notes(info: UpdateInfo): string | undefined {
		const notes = info.releaseNotes;
		if (typeof notes === 'string') {
			return notes.trim() || undefined;
		}
		if (Array.isArray(notes)) {
			const joined = notes.map((n) => n.note ?? '').join('\n\n').trim();
			return joined || undefined;
		}
		return undefined;
	}

	private wire(): void {
		if (this.wired) {
			return;
		}
		this.wired = true;
		electronUpdater.on('checking-for-update', () => this.emit({ state: 'checking' }));
		electronUpdater.on('update-available', (info) => this.emit({ state: 'available', version: info.version, notes: this.notes(info) }));
		electronUpdater.on('update-not-available', (info) => this.emit({ state: 'not-available', version: info.version }));
		electronUpdater.on('download-progress', (progress) => this.emit({ state: 'downloading', percent: Math.round(progress.percent) }));
		// "Ready" waits for the stage, so a Restart is always the fast swap when staging works.
		electronUpdater.on('update-downloaded', (info) => {
			// Said out loud: the bar would otherwise sit at "Updating 100%" for the whole stage.
			if (process.platform === 'win32' && app.isPackaged) {
				this.emit({ state: 'downloading', preparing: true });
			}
			void this.stage(info.downloadedFile, info.version).then(() => {
				// A refused installer has already said so (an error state); it is never offered.
				if (!this.refused) {
					this.emit({ state: 'downloaded', version: info.version, notes: this.notes(info) });
				}
			});
		});
		electronUpdater.on('error', (err) => this.emit(reportUpdateError(err)));
	}

	check(): void {
		this.wire();
		void electronUpdater.checkForUpdates().catch((err) => {
			this.emit(reportUpdateError(err));
		});
	}

	download(): void {
		void electronUpdater.downloadUpdate().catch((err) => {
			this.emit(reportUpdateError(err));
		});
	}

	/**
	 * Unpack the verified installer beside the live app now, so Restart (or quit) is a folder swap
	 * instead of a 20-45 s reinstall (stagedUpdate.ts, which carries the never-strand rule). Windows
	 * only; anything that fails leaves electron-updater's stock install-on-quit in charge, exactly
	 * as before. Stages run one at a time: a newer version arriving waits for the current one.
	 */
	private stage(installer: string | undefined, version: string): Promise<void> {
		this.stageRun = this.stageRun.then(() => this.stageOne(installer, version)).catch((err) => {
			logUpdate(`staged update: failed: ${err instanceof Error ? err.message : String(err)}`);
		});
		return this.stageRun;
	}

	private async stageOne(installer: string | undefined, version: string): Promise<void> {
		if (process.platform !== 'win32' || !app.isPackaged || !installer || this.quitting) {
			return;
		}
		// The installer is RUN by the stage (and by the stock install on quit), so it must be ours.
		// electron-updater checks a fresh download against app-update.yml, but hands back a cached
		// one without that check, so it is checked here too.
		this.refused = false;
		if (!(await this.signedByUs(installer, version))) {
			// Whatever is staged already (an earlier, verified version) stays; the stock install,
			// which would run THIS file, is switched off for Restart and for quit.
			this.refused = true;
			electronUpdater.autoInstallOnAppQuit = false;
			return;
		}
		// The stage about to be written replaces any earlier one, so until it is whole, checked and
		// has a waiter, a quit must take the stock path.
		this.staged = null;
		electronUpdater.autoInstallOnAppQuit = true;
		if (this.waiter) {
			await cancelWaiter(this.waiter);
			this.waiter = null;
		}
		await this.cleanup;
		const userData = app.getPath('userData');
		if (!swapAllowed(readSwapRecord(userData), version)) {
			logUpdate(`staged update: v${version} has been swapped ${MAX_SWAP_ATTEMPTS} times without the app coming back on it; installing the stock way`);
			return;
		}
		let staged: StagedUpdate | null = null;
		try {
			staged = await stageUpdate(installer, version, process.execPath, {
				log: logUpdate,
				report: reportStaging,
				signal: this.quitSignal.signal,
				tool: waiterScript(),
			});
		} catch (err) {
			logUpdate(`staged update: failed: ${err instanceof Error ? err.message : String(err)}`);
			reportStaging(`staged update: failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!staged || this.quitting) {
			return;
		}
		// The swap's process starts NOW and has to say it is running before Restart is offered, so a
		// waiter that policy or antivirus stops is found while there is still an app to notice.
		const waiter = await startWaiter(staged, process.execPath, waiterScript(), updateLogPath(), logUpdate);
		if (!waiter) {
			reportStaging('staged update: the waiter did not start, installing on quit instead', { version });
			return;
		}
		if (this.quitting) {
			await cancelWaiter(waiter);
			return;
		}
		this.staged = staged;
		this.waiter = waiter;
		// electron-updater's quit handler checks this at quit time, so turning it off here hands the
		// quit to ours.
		electronUpdater.autoInstallOnAppQuit = false;
	}

	/** True when `installer` carries a valid Authenticode signature from WINDOWS_PUBLISHER_NAMES.
	 *  electron-updater's verifier answers null for that, and a description otherwise; it also
	 *  answers null when PowerShell itself cannot run, which is its own deliberate choice. */
	private async signedByUs(installer: string, version: string): Promise<boolean> {
		let answer: string | null;
		try {
			answer = await (electronUpdater as NsisUpdater).verifyUpdateCodeSignature([...WINDOWS_PUBLISHER_NAMES], installer);
		} catch (err) {
			answer = err instanceof Error ? err.message : String(err);
		}
		if (answer === null) {
			return true;
		}
		const refusal = signatureRefusal(version, answer);
		this.emit(reportUpdateError(new Error(refusal)));
		return false;
	}

	/** The OS is logging off or shutting down. A helper killed between its two renames would leave
	 *  no app at all, so there is no swap now; the stage is reused on the next quit. */
	sessionEnding(): void {
		this.sessionEnded = true;
		if (this.waiter) {
			signalSessionEnd(this.waiter);
		}
	}

	private hookQuit(): void {
		if (process.platform !== 'win32' || !app.isPackaged) {
			return;
		}
		// Before electron-updater's own 'quit' handler: a stage still being written holds the
		// installer's single-instance mutex, which would make the stock install on quit give up.
		// 'will-quit' and not 'before-quit', which the renderer's "quit?" dialog can still cancel.
		app.on('will-quit', () => {
			this.quitting = true;
			this.quitSignal.abort();
		});
		app.once('quit', () => {
			if (!this.staged || this.swapping) {
				return;
			}
			if (this.sessionEnded) {
				logUpdate('staged update: Windows is ending the session; keeping the stage for the next launch');
				return;
			}
			if (!this.swap('quit') && !this.refused) {
				// electron-updater already passed on this quit (autoInstallOnAppQuit was off), so run
				// its install directly (on Windows, where this runs, it is the NSIS updater).
				(electronUpdater as NsisUpdater).install(true, false);
			}
		});
	}

	/** Tell the waiter to swap once the app has exited; false when it is no longer there to hear it
	 *  (killed since it started), so the caller takes the stock path. */
	private swap(mode: SwapMode): boolean {
		if (!this.staged || !this.waiter) {
			return false;
		}
		if (!requestSwap(this.waiter, mode)) {
			const message = 'staged update: the waiter is gone; installing the stock way';
			logUpdate(message);
			reportStaging(message);
			this.staged = null;
			this.waiter = null;
			electronUpdater.autoInstallOnAppQuit = true;
			return false;
		}
		this.swapping = true;
		noteSwapAttempt(app.getPath('userData'), this.staged.marker.version);
		logUpdate(`staged update: ${mode}: the waiter swaps v${this.staged.marker.version} in once the app has exited`);
		return true;
	}

	quitAndInstall(background = false): void {
		if (this.staged && this.swap(background ? 'background' : 'restart')) {
			setImmediate(() => app.quit());
			return;
		}
		if (this.refused) {
			// The download failed its signature check; electron-updater would run it.
			logUpdate('quitAndInstall: the downloaded installer was refused (not signed by SnoutData); not installing');
			return;
		}
		// A stage still being written holds the installer's single-instance mutex; stop it so the
		// stock installer (which reaches that check after its ~1.5 s CRC pass) can run.
		this.quitSignal.abort();
		// A person clicking Restart sees the installer as they always have. A tray install runs it
		// silently (/S) and forces the relaunch, which a silent NSIS install otherwise skips.
		if (background) {
			electronUpdater.quitAndInstall(true, true);
			return;
		}
		electronUpdater.quitAndInstall();
	}
}

// ── macOS ────────────────────────────────────────────────────────────────────────────
// Native Squirrel.Mac, driven directly through Electron's built-in `autoUpdater` — the same
// approach VSCode's DarwinUpdateService uses, NOT electron-updater. macOS has no block-level
// delta (the whole signed .zip is pulled every time) and Squirrel.Mac REFUSES to swap a
// bundle whose code signature doesn't satisfy the running app's — so this path only works in
// a signed + notarized packaged build (AppUpdater guards dev away from it).
//
// Squirrel.Mac needs a feed URL it can GET. GitHub serves static .yml, not a Squirrel feed,
// so (exactly like VSCode's update server) we stand up a tiny one-shot localhost endpoint
// that returns `{ "url": <github zip url> }`; Squirrel then downloads the .zip from GitHub
// DIRECTLY (no proxy-streaming of bytes, no `squirrelDownloadedUpdate` race — the two things
// that made electron-updater's mac path stage an update but never apply it).
class MacSquirrelUpdater implements UpdaterImpl {
	private readonly emit: Emit;
	private readonly base = feedBase();
	private wired = false;
	private server: http.Server | null = null;
	private pending: { version: string; zipUrl: string } | null = null;
	/** The version Squirrel has already staged for the next relaunch, once it has said so.
	 *  Squirrel.Mac holds exactly ONE staged bundle and its check command is disabled from the
	 *  moment it is awaiting the relaunch, so this is also the flag that says a further check
	 *  cannot do anything but report what is already ready. Cleared by the relaunch, since the
	 *  process does not survive it. */
	private staged: string | null = null;

	constructor(emit: Emit) {
		this.emit = emit;
	}

	private wire(): void {
		if (this.wired) {
			return;
		}
		this.wired = true;
		squirrelMac.on('error', (err) => {
			this.closeServer();
			logUpdate(`squirrel error: ${err instanceof Error ? err.message : String(err)}`);
			this.emit(reportUpdateError(err));
		});
		squirrelMac.on('checking-for-update', () => logUpdate('squirrel: checking-for-update'));
		squirrelMac.on('update-available', () => logUpdate('squirrel: update-available (download starting)'));
		squirrelMac.on('update-not-available', () => {
			logUpdate('squirrel: update-not-available');
			this.emit({ state: 'not-available', version: app.getVersion() });
		});
		squirrelMac.on('before-quit-for-update', () => logUpdate('squirrel: before-quit-for-update (ShipIt should be taking over)'));
		squirrelMac.on('update-downloaded', () => {
			// Squirrel has fetched + verified the .zip and staged ShipIt; the feed server has
			// done its one job, so close it. The bundle swap happens on quitAndInstall().
			this.closeServer();
			this.staged = this.pending?.version ?? app.getVersion();
			logUpdate(`squirrel: update-downloaded (v${this.staged} staged, ready to install)`);
			this.emit({ state: 'downloaded', version: this.staged });
		});
	}

	check(): void {
		// Once Squirrel has staged a bundle it holds it until the app relaunches: checkForUpdates()
		// is refused from then on, so a release published while the "Restart & Update" toast sits
		// there CANNOT be fetched now, however new it is. Reporting it as available (and then
		// downloading, forever, because Squirrel never answers) would be a lie about what a restart
		// installs. Report what is actually ready instead; the launch check after the restart is
		// what offers the newer one, so nothing is lost but one extra restart.
		if (this.staged) {
			this.emit({ state: 'downloaded', version: this.staged });
			this.noteNewerThanStaged();
			return;
		}
		// Same reason, one state earlier: a download in flight owns Squirrel until it finishes.
		// Re-asking would only re-point the feed server at a zip Squirrel is not going to read.
		if (this.server) {
			this.emit({ state: 'downloading' });
			return;
		}
		this.emit({ state: 'checking' });
		void this.resolveLatest()
			.then((meta) => {
				if (!meta || !isNewerVersion(meta.version, app.getVersion())) {
					this.emit({ state: 'not-available', version: meta?.version ?? app.getVersion() });
					return;
				}
				this.pending = { version: meta.version, zipUrl: `${this.base}/${meta.zipName}` };
				this.emit({ state: 'available', version: meta.version });
				// VSCode-style: start the background download immediately; the toast moves on to
				// "Ready — Restart & Update" when Squirrel finishes.
				this.download();
			})
			.catch((err) => this.emit(reportUpdateError(err)));
	}

	download(): void {
		// Nothing to download twice: the staged bundle is the one a restart installs.
		if (this.staged) {
			this.emit({ state: 'downloaded', version: this.staged });
			return;
		}
		if (this.server) {
			this.emit({ state: 'downloading' });
			return;
		}
		// A bare download() (e.g. the toast "Download" button) before a successful check just
		// runs the check, which resolves `pending` and auto-downloads.
		if (!this.pending) {
			this.check();
			return;
		}
		try {
			this.wire();
			this.startFeedServer(this.pending.zipUrl);
			this.emit({ state: 'downloading' });
		} catch (err) {
			this.closeServer();
			this.emit(reportUpdateError(err));
		}
	}

	quitAndInstall(): void {
		// Squirrel.Mac always relaunches and shows no installer, so a tray install is the same call.
		logUpdate('MacSquirrelUpdater.quitAndInstall() -> squirrelMac.quitAndInstall()');
		squirrelMac.quitAndInstall();
	}

	// Diagnostics only, and deliberately not a status: when a check lands on an already-staged
	// update, write down whether the feed has moved past it. That sentence is the difference
	// between "the app never saw v1.0.31" and "it saw it and is waiting for the restart", which is
	// otherwise unanswerable from a user's update.log.
	private noteNewerThanStaged(): void {
		const staged = this.staged;
		if (!staged) {
			return;
		}
		void this.resolveLatest()
			.then((meta) => {
				if (meta && isNewerVersion(meta.version, staged)) {
					logUpdate(`squirrel: v${meta.version} is on the feed, but v${staged} is already staged; it will be offered after the restart`);
				}
			})
			.catch(() => {
				// An unreadable feed changes nothing about the update that is already staged.
			});
	}

	// Read the latest release's `latest-mac.yml` (via GitHub's `latest/download` redirect)
	// and pull the version + the .zip Squirrel.Mac should apply (electron-builder lists it as
	// `path:` and under `files:`). Returns null if the manifest can't be parsed.
	private async resolveLatest(): Promise<{ version: string; zipName: string } | null> {
		// Cache-bust the manifest read: a unique query param + no-store/no-cache so neither GitHub's
		// CDN nor any proxy/VPN between us serves a stale latest-mac.yml. Without this a release
		// published while the app is open can keep reading as "up to date". GitHub ignores the query
		// on the latest/download redirect (it still resolves to the newest published release).
		const url = `${this.base}/latest-mac.yml?noCache=${Date.now()}`;
		const res = await netFetch(url, { redirect: 'follow', headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
		if (!res.ok) {
			throw new Error(`update feed returned HTTP ${res.status}`);
		}
		const text = await res.text();
		const version = text.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? '';
		const zipName = (text.match(/url:\s*(\S+-mac\.zip)\b/) ?? text.match(/^path:\s*(\S+\.zip)\s*$/m))?.[1]?.trim() ?? '';
		if (!version || !zipName) {
			return null;
		}
		return { version, zipName };
	}

	private startFeedServer(zipUrl: string): void {
		this.closeServer();
		// Squirrel.Mac's JSON feed: a 200 with `{ "url": <zip> }`. `url` is the only required
		// field; `name` gives the relaunch a version label. Squirrel follows GitHub's redirect
		// to the asset CDN and verifies the downloaded bundle's signature itself.
		const body = JSON.stringify({ url: zipUrl, name: this.pending?.version ?? '' });
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
			res.end(body);
		});
		// Never let a feed-server hiccup take the app down — report it like any update error.
		server.on('error', (err) => {
			this.closeServer();
			this.emit(reportUpdateError(err));
		});
		this.server = server;
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			logUpdate(`mac feed server up on 127.0.0.1:${port}; serving zip ${zipUrl}; calling checkForUpdates()`);
			squirrelMac.setFeedURL({ url: `http://127.0.0.1:${port}/feed.json`, serverType: 'json' });
			squirrelMac.checkForUpdates();
		});
	}

	private closeServer(): void {
		if (this.server) {
			this.server.close();
			this.server = null;
		}
	}
}

// Per-platform auto-update, mirroring VSCode's split: native Squirrel.Mac on macOS,
// electron-updater (NSIS) on Windows, and the OS package manager (apt) on Linux. Status
// changes are emitted to the renderer, which decides what (if anything) to surface — an
// auto-check stays silent unless there is something to act on.
export class AppUpdater {
	private readonly emit: Emit;
	/** Null in a build from the open-source tree: it has no feed, so nothing that reads one is made. */
	private readonly impl: UpdaterImpl | null;
	private downloadStartedAt: number | undefined;

	constructor(emit: Emit) {
		this.emit = (status) => emit(this.stamp(status));
		this.impl = !OFFICIAL_BUILD ? null : process.platform === 'darwin' ? new MacSquirrelUpdater(this.emit) : new ElectronUpdaterImpl(this.emit);
	}

	// When the download started, held for its whole life and cleared the moment it is over. The
	// surfaces need an age, and the only place that knows one is here: a renderer that timed it
	// from the first status it saw would restart the clock on every reload, and the tray does not
	// keep a clock at all. Stamped on both platforms because it costs a number, but only the macOS
	// label reads it (see updateProgressDetail) - Windows reports a percentage and needs nothing.
	private stamp(status: UpdateStatus): UpdateStatus {
		if (status.state !== 'downloading') {
			this.downloadStartedAt = undefined;
			return status;
		}
		this.downloadStartedAt ??= Date.now();
		return { ...status, startedAt: this.downloadStartedAt };
	}

	check(): void {
		// A build from the open-source tree never asks the official feed: it is updated by building
		// the source again, and the check says so. The updaters can only run against a real
		// install. In dev (unpackaged) they would throw (electron-updater wants app-update.yml;
		// Squirrel.Mac wants a code signature), so report "up to date" instead of erroring.
		// Linux ships as a .deb served from our apt repo, so the OS package manager owns
		// updates (apt upgrade / unattended-upgrades) - there is no in-app path for .deb.
		// Report "up to date" and let apt do its job.
		const route = updateCheckRoute({ official: OFFICIAL_BUILD, packaged: app.isPackaged, platform: process.platform });
		if (route === 'from-source') {
			this.emit({ state: 'not-available', version: app.getVersion(), fromSource: true });
			return;
		}
		if (route === 'up-to-date' || !this.impl) {
			this.emit({ state: 'not-available', version: app.getVersion() });
			return;
		}
		this.impl.check();
	}

	download(): void {
		this.impl?.download();
	}

	quitAndInstall(background = false): void {
		this.impl?.quitAndInstall(background);
	}

	sessionEnding(): void {
		this.impl?.sessionEnding?.();
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

/** Whether the build under test carries the private halves: Data Flows
 *  and Liby are compiled in when they are present and `SNOUT_PRO` is not 0, the same rule as
 *  scripts/pro.mjs and scripts/liby.mjs, which decided the build. A spec that needs one skips without
 *  it, so the open-source build's `app` project passes. */
export const PRO_BUILD = process.env.SNOUT_PRO !== '0' && existsSync(join(__dirname, '../src/main/pro/main.ts'));
export const LIBY_BUILD = process.env.SNOUT_PRO !== '0' && existsSync(join(__dirname, '../../../packages/liby/src/index.ts'));
/** The renderer chunks her package splits off and loads only when she is first needed, which a launch
 *  must never fetch (startup.spec.ts). Her package names them (`lazyChunks`); none without her. */
export const LIBY_LAZY_CHUNKS: string[] = LIBY_BUILD
	? (JSON.parse(readFileSync(join(__dirname, '../../../packages/liby/package.json'), 'utf8')) as { lazyChunks?: string[] }).lazyChunks ?? []
	: [];

// For specs that live outside this app (Liby's, in her private package): they cannot resolve
// @playwright/test from there, and must use this app's one copy of it anyway.
export { expect, test } from '@playwright/test';
export type { ElectronApplication, Page } from '@playwright/test';

const APP_DIR = join(__dirname, '..');

/**
 * The one profile an e2e is allowed to REUSE, and the only way a spec can be signed in.
 *
 * Everything else here runs against a fresh scratch dir on purpose, which also means no e2e can
 * ever be signed in: an account is an OAuth round trip through a browser, and a profile that is
 * thrown away cannot keep the session. So there is one fixed profile, signed into ONCE by hand
 * (`npm run e2e:signin`), and the specs that need a real model launch against it.
 *
 * NOT the user's real profile — their connections, secrets and chats are never opened by a test.
 * The session is safeStorage-encrypted and machine-bound, so this directory is useless anywhere
 * else; it is gitignored all the same.
 */
export const AUTH_PROFILE = process.env.SNOUT_E2E_AUTH_PROFILE ?? join(__dirname, '.auth-profile');

/** Whether that profile holds a persisted session — i.e. whether signing in has been done. The
 *  file is encrypted; its presence is all we can (and need to) read from outside the app. */
export function signedInProfileExists(): boolean {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(AUTH_PROFILE, 'auth.json'), 'utf8'));
		return Boolean(raw && typeof raw === 'object' && (raw as Record<string, string>)['positron-db-auth']);
	} catch {
		return false;
	}
}

/** Why a live-model spec is skipping, or null when it can run. Kept as a sentence because the
 *  answer is always "do this one thing first". */
export function liveAiSkip(): string | null {
	if (!process.env.SNOUTDATA_E2E_LIVE_AI) {
		return 'set SNOUTDATA_E2E_LIVE_AI=1 to run the live-model specs (they spend real AI budget)';
	}
	if (!existsSync(AUTH_PROFILE) || !signedInProfileExists()) {
		return `no signed-in profile at ${AUTH_PROFILE} — run \`npm run e2e:signin\` once and sign in`;
	}
	return null;
}

/** Wait for the account to resolve: a restored session is adopted asynchronously on launch, and the
 *  gateway key is minted after that, so a launch against {@link AUTH_PROFILE} is signed OUT for a
 *  moment after it paints. Returns null if it never resolves. */
export async function waitForSignIn(page: Page, timeoutMs = 30_000): Promise<{ email?: string } | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const user = await page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { authState(): Promise<{ user: { email?: string } | null }> } }).sqlApi;
			return (await api.authState()).user;
		});
		if (user || Date.now() > deadline) {
			return user;
		}
		await page.waitForTimeout(500);
	}
}

/** The app's portable 'Mod' modifier (src/shared/keybindings.ts): Cmd on macOS, Ctrl elsewhere. */
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const RESULTS_DIR = join(__dirname, '.results');

export interface AppHandle {
	app: ElectronApplication;
	page: Page;
	/** The scratch userData dir this instance ran against (kept for post-mortems; it lives in
	 *  the OS temp dir, so the OS reaps it eventually). */
	userData: string;
	/** Names this instance's trace zip under e2e/.results/. */
	name: string;
	/**
	 * When `electron.launch()` resolved, which is the closest thing we have to frame zero of the
	 * recording: Playwright's video canvas opens with the browser context.
	 *
	 * A spec that lines events up against the recording needs this anchor. Timing from before the
	 * launch adds Electron's whole boot; timing from after `launchApp` returns misses the profile
	 * seed and reload it does. This is the one moment that matches the video.
	 */
	startedAt: number;
}

export interface DbConfig {
	driver: string;
	host: string;
	port: string;
	database: string;
	username: string;
	password: string;
	/** TLS, verified against the system trust store. Set by SNOUTDATA_TEST_SSL=1; a SnoutData Cloud
	 *  project needs it, since its front door refuses a plaintext connection. */
	ssl?: boolean;
}

/** The SNOUTDATA_TEST_* database env that gates the live-DB specs (the e2e counterpart of the
 *  unit tier's SNOUTDATA_IT_* gating). Returns null when not configured so those specs skip
 *  cleanly. Driver accepts the short names ('mysql', 'postgres', …) or a full driver id. */
export function dbEnv(): DbConfig | null {
	const host = process.env.SNOUTDATA_TEST_HOST;
	const database = process.env.SNOUTDATA_TEST_NAME;
	const username = process.env.SNOUTDATA_TEST_USER;
	if (!host || !database || !username) {
		return null;
	}
	const raw = process.env.SNOUTDATA_TEST_DRIVER ?? 'mysql';
	const driver = raw === 'mysql' ? 'mysql-aurora' : raw;
	return {
		driver,
		host,
		port: process.env.SNOUTDATA_TEST_PORT ?? '',
		database,
		username,
		password: process.env.SNOUTDATA_TEST_PASSWORD ?? '',
		ssl: process.env.SNOUTDATA_TEST_SSL === '1',
	};
}

/** In the open connection form: switch TLS on and verify with the system trust store, when the
 *  SNOUTDATA_TEST_* env asks for it. The form's own default mode is the RDS CA bundle, which a
 *  publicly signed certificate (a SnoutData Cloud project's) does not chain to. */
export async function fillSsl(page: Page, cfg: DbConfig): Promise<void> {
	if (!cfg.ssl) {
		return;
	}
	await page.locator('label.check', { hasText: 'Use SSL' }).locator('input').check();
	await page.locator('label', { hasText: 'Certificate verification' }).locator('select').selectOption('system');
}

/** A port nothing on this machine listens on right now, asked of the OS. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
		});
	});
}

/** Launch the built app (out/main/index.js) against a fresh scratch userData dir, wait for the
 *  UI to paint, and suppress first-run onboarding so the tour never covers the surface under
 *  test. Requires `npm run build` to have run (the `e2e` script does). `name` labels this
 *  instance's recordings (use the spec name). Every run records a .webm video per window
 *  (e2e/.results/videos/) and a trace (e2e/.results/<name>-trace.zip, written by closeApp);
 *  Playwright clears .results at the start of the next run, so they never pile up. */
export async function launchApp(name: string, options: { profile?: string; env?: Record<string, string>; videoSize?: { width: number; height: number }; require?: string } = {}): Promise<AppHandle> {
	// `profile` reuses a fixed directory instead of a scratch one — only the signed-in profile
	// above does that, and only the live-model specs pass it.
	const userData = options.profile ?? mkdtempSync(join(tmpdir(), 'snout-e2e-'));
	// The agent server's port, chosen per launch. On the default (7311) a scratch app lost the port
	// to any Studio already running on this machine, a dev build or the installed one, and every
	// spec that talks to the agent server failed for a reason that had nothing to do with it.
	if (!options.profile) {
		writeFileSync(join(userData, 'mcp.json'), JSON.stringify({ port: await freePort() }));
	}
	const app = await electron.launch({
		// SwiftShader, Chromium's software WebGL, as a FALLBACK only: a machine with a GPU still uses
		// it. Chromium no longer falls back to it on its own, so on a CI runner or a container (no
		// GPU at all) no WebGL context could be made and Orbit's spec, which asserts one comes up in
		// this Electron build, could not pass anywhere but a desktop. What Orbit does when there truly
		// is none is its own test (orbit.spec.ts, "a window with no WebGL").
		// `require` is a script main loads before the app's own code (Node's `-r`, as Playwright loads
		// its own loader). Playwright drops NODE_OPTIONS, so this is the only way to run code that early.
		args: [...(options.require ? ['-r', options.require] : []), APP_DIR, '--enable-unsafe-swiftshader'],
		env: {
			...process.env as Record<string, string>,
			// Points userData at the scratch dir, skips the legacy-userData migration, and
			// disables the confirm-quit dialog (see src/main/index.ts).
			SNOUT_E2E_USERDATA: userData,
			// Per-spec environment. Used by the agent-console spec to put a FAKE agent binary on
			// PATH, so the suite never depends on Claude Code being installed on the machine.
			...(options.env ?? {}),
		},
		// The video canvas is fixed when the context is created, so a spec that resizes the window
		// afterwards gets its content letterboxed and downscaled into the old size. `videoSize`
		// lets a recording ask for the size it is going to use.
		recordVideo: { dir: join(RESULTS_DIR, 'videos'), ...(options.videoSize ? { size: options.videoSize } : {}) },
	});
	const startedAt = Date.now();
	// Trace every step (screenshots + DOM snapshots) — scrub through it after the fact with
	// `npx playwright show-trace e2e/.results/<name>-trace.zip`.
	await app.context().tracing.start({ screenshots: true, snapshots: true, title: name });
	// A launch that never shows a window used to fail as a bare hook timeout, which says nothing.
	// Give up a little before the hook does, and say what main got to and what windows it holds.
	const page = await app.firstWindow({ timeout: 45_000 }).catch(async (err: unknown) => {
		const state = await app.evaluate(({ BrowserWindow }) => ({
			boot: (globalThis as unknown as { __snoutBoot?: () => { name: string; at: number }[] }).__snoutBoot?.() ?? [],
			windows: BrowserWindow.getAllWindows().map((w) => ({
				url: w.webContents.getURL(),
				visible: w.isVisible(),
				loading: w.webContents.isLoading(),
				crashed: w.webContents.isCrashed(),
			})),
		})).catch((e: unknown) => ({ unreachable: String(e) }));
		throw new Error(`no window within 45s: ${JSON.stringify(state)}`, { cause: err });
	});
	// Onboarding state lives in renderer localStorage, which is empty in a scratch profile, so
	// the spotlight tour would auto-start over every test. Seed "already seen" and reload; both
	// loaders merge stored partials over their defaults.
	await page.evaluate(() => {
		localStorage.setItem('positron-db.onboarding', JSON.stringify({ tourSeen: true, checklistDismissed: true }));
		// Keep the first-run extras off, so nothing appears over what a spec is clicking.
		localStorage.setItem('positron-db.appSettings', JSON.stringify({ disableOnboarding: true, disableMascot: true }));
	});
	await page.reload();
	await page.waitForSelector('[data-tour="activity-bar"]');
	return { app, page, userData, name, startedAt };
}

/**
 * The last button on the review step, whatever it says.
 *
 * It is deliberately not always "Run": when the flow empties something first, it names what — the
 * table, the collection, or the file it overwrites. Specs that only want the run to start match
 * every wording here; the wording itself is asserted where it is the point.
 */
export function runButton(page: Page) {
	return page.getByRole('button', { name: /^(Run|Empty the (table|collection) and run|Overwrite the file and run)$/ });
}

/**
 * Choose a connection in a connection picker (components/ConnectionPicker.tsx), the editor
 * toolbar's unless `scope` names another. It is a custom list, not a <select>, so this opens it and
 * clicks the row whose NAME is exactly `label` (a row also carries tags and the engine's name).
 */
export async function pickConnection(page: Page, label: string, scope = '.editor-toolbar'): Promise<void> {
	await page.locator(`${scope} .conn-picker-btn`).first().click();
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const exact = new RegExp('^' + escaped + '$');
	await page.locator('.conn-picker-menu [role="option"]').filter({ has: page.locator('.conn-picker-label', { hasText: exact }) }).click();
}

export async function closeApp(handle: AppHandle | undefined): Promise<void> {
	if (handle) {
		// Best-effort: a test failure may have torn the context down already, and a teardown
		// throw would mask the real failure.
		await handle.app.context().tracing.stop({ path: join(RESULTS_DIR, `${handle.name}-trace.zip`) }).catch(() => {});
		const video = handle.page.video();
		await handle.app.close();
		// The recording is only finalized after close; re-save it under the spec name so it's
		// findable next to its trace (the hash-named original is removed).
		if (video) {
			await video.saveAs(join(RESULTS_DIR, 'videos', `${handle.name}.webm`));
			await video.delete();
		}
	}
}

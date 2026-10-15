/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Open the built app against the e2e AUTH PROFILE so a human can sign in, once.
 *
 *  Why this exists: every e2e runs against a throwaway profile, so no spec can ever be signed in,
 *  so nothing that needs a real model can be tested at all. Signing in is an OAuth round trip
 *  through a browser — a person has to do it. This opens the app against one fixed directory,
 *  they sign in, and the session persists there for every later run.
 *
 *  **Launched through Playwright, exactly as the specs launch it.** Playwright's Electron loader
 *  adds `--use-mock-keychain`, so safeStorage under a spec encrypts with Chromium's mock key, not
 *  the macOS keychain's. A session written by a plain launch (how this script worked until
 *  2026-10-12) was encrypted with the real key and could never be decrypted by any spec: every
 *  one reported "no account on this profile" on a profile that was signed in. Written the same
 *  way the specs read it, it restores. The cost is that the file is protected by its permissions
 *  and the gitignore, not by the keychain; it is a test profile, never the user's real one.
 *
 *  Any provider works: a development build returns from sign-in through a loopback listener, not
 *  the `snoutdata://` protocol an installed copy would take (authStore.ts, `returnUrl`).
 *
 *      npm run e2e:signin        # sign in, then quit from the tray (closing the window hides it)
 *      SNOUTDATA_E2E_LIVE_AI=1 npx playwright test <a live spec>
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const profile = process.env.SNOUT_E2E_AUTH_PROFILE ?? join(here, '.auth-profile');

if (!existsSync(join(appDir, 'out', 'main', 'index.js'))) {
	console.error('Build first: npm run build');
	process.exit(1);
}
mkdirSync(profile, { recursive: true });

console.log(`Opening the app against ${profile}`);
console.log('Sign in (Account → Sign in; any provider), then quit from the tray icon: closing the window only hides it.');
console.log('The session persists there, and the live-model specs will find it.');

const app = await _electron.launch({
	args: [appDir],
	env: { ...process.env, SNOUT_E2E_USERDATA: profile },
	// A person is signing in: there is no deadline on the app staying open.
	timeout: 0,
});
app.process().stdout?.pipe(process.stdout);
app.process().stderr?.pipe(process.stderr);
app.on('close', () => {
	const signedIn = existsSync(join(profile, 'auth.json'));
	console.log(signedIn ? 'A session was written. Live-model specs can run.' : 'No session was written — nothing signed in.');
	process.exit(0);
});

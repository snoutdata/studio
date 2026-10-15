/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Refuse to run the e2e suite against a build older than the code.
 *
 * Playwright drives the BUILT app (`out/main/index.js`), and only `npm run e2e`/`e2e:app`
 * build first. The documented iteration advice is `npx playwright test <spec> --project=app`,
 * which is the right advice for speed and does NOT build -- so the documented fast path can
 * run yesterday's binary against today's source.
 *
 * The failure that matters is not the noisy one. A stale build that makes a test FAIL sends
 * you looking and you find it (which is how this check came to exist, 2026-09-12). A stale
 * build that makes a test PASS tells you nothing is wrong, and the rule directly above that
 * advice says a targeted run passing IS the answer and not to re-run the rest to be sure. So
 * a silent wrong answer is the thing being designed out here.
 *
 * Deliberately a refusal and not a rebuild: the fast command is fast because it does not
 * build, and quietly building would take that away. It says what is stale and what to run.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// __dirname, not import.meta: Playwright loads this config the same way it loads
// playwright.config.ts, which this package resolves as CommonJS.
const root = resolve(__dirname, '..');

/** The four artifacts a test actually launches. The OLDEST of them is what "built at" means:
 *  main, preload and the renderer come from electron-vite, the server from a separate esbuild
 *  step, and any one of them can be the stale one on its own. */
const ARTIFACTS = ['out/main', 'out/preload', 'out/renderer', 'out/server'];

/** Source that ends up IN those artifacts. `*.test.ts` is excluded on purpose: it is bundled
 *  by `npm test` into out/tests and never reaches the app, so counting it would report a
 *  stale build every time a unit test was touched. */
const SOURCES = ['src', '../../packages/review-core/src', '../../packages/move/src'];

function newest(dir: string, skip: (name: string) => boolean): number {
	let latest = 0;
	const walk = (d: string): void => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
				continue;
			}
			const full = join(d, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (!skip(entry.name)) {
				const at = statSync(full).mtimeMs;
				if (at > latest) {
					latest = at;
				}
			}
		}
	};
	walk(dir);
	return latest;
}

export default function checkBuildIsCurrent(): void {
	if (process.env.SNOUT_E2E_ALLOW_STALE === '1') {
		return;
	}

	const missing = ARTIFACTS.filter((a) => !existsSync(join(root, a)));
	if (missing.length > 0) {
		throw new Error(
			`No build to test: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.\n` +
			`Playwright drives the BUILT app, so run:  npm run build\n`,
		);
	}

	// The oldest artifact, because one stale piece is enough to test the wrong code.
	const builtAt = Math.min(...ARTIFACTS.map((a) => newest(join(root, a), () => false)));
	let sourceAt = 0;
	let culprit = '';
	for (const source of SOURCES) {
		const dir = join(root, source);
		if (!existsSync(dir)) {
			continue;
		}
		const at = newest(dir, (name) => name.endsWith('.test.ts') || name.endsWith('.test.tsx'));
		if (at > sourceAt) {
			sourceAt = at;
			culprit = source;
		}
	}

	if (sourceAt > builtAt) {
		const behind = Math.round((sourceAt - builtAt) / 1000);
		throw new Error(
			`The build is older than the source, so these tests would run the wrong code.\n` +
			`  built:  ${new Date(builtAt).toLocaleString()}\n` +
			`  ${culprit}: ${new Date(sourceAt).toLocaleString()}  (${behind}s newer)\n\n` +
			`Run one of:\n` +
			`  npm run build && npx playwright test <spec> --project=app   # keep the fast loop\n` +
			`  npm run e2e:app                                             # builds, then runs\n\n` +
			`This check exists because a stale build can make a test PASS, which is the case\n` +
			`nothing else would have told you about. SNOUT_E2E_ALLOW_STALE=1 skips it.\n`,
		);
	}
}

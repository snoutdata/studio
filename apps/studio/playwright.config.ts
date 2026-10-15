/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { libyPaths } from './scripts/liby.mjs';

// E2E tests drive the REAL built app (out/main/index.js) via Playwright's Electron support:
// main process, preload bridge, LSP child and stores included. Run `npm run e2e` (builds first)
// or `npm run e2e:only` against an existing build. Each test launches its own app instance with
// a scratch userData dir (see e2e/helpers.ts), so nothing touches real connections/secrets.
/*
 * An optional second project, `extraction`, for the specs a list file beside them names, when that
 * file is present. Anything not listed is in `app`, so a new spec is covered by default rather than
 * silently unrun. Without the file, `app` is every spec and there is no second project.
 */
const SPECS_FILE = resolve(__dirname, 'e2e/extraction-specs.json');
const EXTRACTION_SPECS: string[] = existsSync(SPECS_FILE) ? (JSON.parse(readFileSync(SPECS_FILE, 'utf8')) as string[]) : [];

const LIBY = libyPaths(__dirname);

export default defineConfig({
	testDir: './e2e',
	// Refuse to run against a build older than the source: these tests drive out/main/index.js,
	// and the documented fast loop (`npx playwright test <spec>`) does not build. See the file.
	globalSetup: './e2e/staleBuild.ts',
	projects: [
		{ name: 'app', testIgnore: EXTRACTION_SPECS },
		// Liby's own specs live in her (private) package. Same project name, so `--project=app` runs
		// them; absent from a tree without her.
		...(LIBY.real ? [{ name: 'app', testDir: resolve(LIBY.dir, 'e2e') }] : []),
		...(EXTRACTION_SPECS.length ? [{ name: 'extraction', testMatch: EXTRACTION_SPECS }] : []),
	],
	timeout: 60_000,
	expect: { timeout: 15_000 },
	// One Electron instance at a time: parallel apps would fight over the dev-only AI debug
	// endpoint's port and interleave their logs beyond usefulness.
	workers: 1,
	fullyParallel: false,
	reporter: [['list']],
	outputDir: './e2e/.results',
	// NOTE: no `use: { trace, video }` here — those options only apply to contexts the test
	// runner creates, and our Electron app is launched manually via _electron.launch(), which
	// they silently ignore. Recording is wired in e2e/helpers.ts instead: every run leaves a
	// .webm video per window and a <name>-trace.zip per spec under e2e/.results/ (cleared on
	// the next run). Replay a trace with `npx playwright show-trace <zip>`.
});

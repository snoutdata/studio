/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, LIBY_LAZY_CHUNKS, type AppHandle } from './helpers';

// THE STARTUP BUDGET. The "Startup is sacred" rule forbids non-essential work from RUNNING on
// the boot path, and that rule held; what it never covered is REACHABILITY. A view merely imported
// from App.tsx is parsed and evaluated at launch whether or not the user opens it, so launch cost
// grew with every feature SHIPPED rather than with the features a user actually uses — which is why
// a single renderer chunk had reached 13.6 MB with Data Flows, Snoutbot, the agent console, the
// dashboards and the whole settings tree inside it, for a user who may open none of them.
//
// Two assertions, and the second is the one that stops the regression coming back:
//   1. first paint lands inside a budget;
//   2. the heavy feature views are NOT in the chunk graph the launch loads.
// A number alone rots — someone raises it. Asserting that FlowWizardView is a separate chunk that
// launch did not fetch is a structural claim, and the only way to break it is to re-add a static
// import, which is exactly the thing to catch in review.
let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('startup');
});

test.afterAll(async () => {
	await closeApp(handle);
});

/** Feature views a launch must not pay for. Matched against the resource URLs the page fetched;
 *  the names are the lazy chunk names set in App.tsx's `lazy(() => import(...))` sites. */
const ALL_DEFERRED = [
	'FlowWizardView',
	'SettingsModal',
	'SchemaSyncView',
	'ReviewView',
	'MonitorView',
	'QueryPerformanceView',
	'AgentConsolePanel',
	'ReleaseNotesView',
	// The hosted-databases panel. A tool window nobody has opened must not cost a launch:
	// it also makes a network call the moment it mounts, which is the other half of the
	// reason it is deferred.
	'DashboardPanel',
	// A project's tab, local or cloud: opened from that panel's tree, never at launch. It reads
	// the control plane or runs docker the moment it mounts.
	'ProjectView',
	// A cloud project's Containers section, its own chunk inside that tab.
	'ContainersSection',
	// The local setup wizard, which runs docker as it mounts.
	'LocalSetupView',
	// Snout Orbit: the only view that pulls in three.js. A static import creeping back would put
	// ~600KB of WebGL into every launch for a feature most users never open.
	'OrbitView',
	'OrbitRailPanel',
	// Move Database: a whole-screen job like a flow, opened on demand.
	'MoveView',
	// Copying a whole project to the other side (shared/projectCopy.ts), opened from a project.
	'ProjectCopyView',
	'VectorSearchView',
	// ClickHouse Operations: opened from a ClickHouse connection, never on launch.
	'ClickHouseOpsView',
	'ClickHouseRemoteView',
	// The Explain panel: it lives in a result tab, but only after someone asks for a plan.
	'ExplainPanel',
	// The Storage tab, which only a ClickHouse table has.
	'ClickHouseTableStorage',
	// "Find your databases": a fresh install opens it, a launch of an existing profile never does.
	'DiscoveryModal',
];
// The companion's own lazy chunks, named by her package (none in a build without her): fetched the
// first time she goes anywhere, never on launch.
const DEFERRED = [...ALL_DEFERRED, ...LIBY_LAZY_CHUNKS];

const ASSETS = join(__dirname, '../out/renderer/assets');

test('reports startup marks', async () => {
	const boot = await handle.app.evaluate(() => (globalThis as unknown as { __snoutBoot(): { name: string; at: number }[] }).__snoutBoot());
	const timings = await handle.page.evaluate(() => (window as unknown as { __snoutStartup(): Record<string, number> }).__snoutStartup());
	console.log('main boot (ms from process start):', JSON.stringify(boot));
	console.log('renderer (ms from renderer entry):', JSON.stringify(timings));
	const index = readdirSync(ASSETS).filter((f) => f.startsWith('index-') && f.endsWith('.js'));
	console.log('index chunk:', index.join(', '));
	expect(timings.render).toBeGreaterThanOrEqual(0);
	expect(timings.paint).toBeGreaterThanOrEqual(timings.render);
	// A backstop against gross regression, not a precision instrument: CI hardware varies enough
	// that a tight bound here would be flaky, and a flaky budget gets raised until it means
	// nothing. The sharp guards are the two structural tests below, which fail on the CAUSE (a
	// static import creeping back) rather than on a symptom that hardware can mask. Reference
	// numbers on the dev machine after the split + minify: render 72ms, paint 229ms.
	expect(timings.paint).toBeLessThan(1200);
	expect(boot.find((m) => m.name === 'did-finish-load')?.at ?? Infinity).toBeLessThan(2500);
});

test('the feature views are split out of the launch chunk', () => {
	// Proves the SPLIT happened. Without this, the "was it fetched" assertion below passes
	// vacuously for a view that is statically bundled into index-*.js — there is no separate URL
	// to fetch, which is precisely the regression being guarded against.
	const chunks = readdirSync(ASSETS);
	const unsplit = DEFERRED.filter((name) => !chunks.some((file) => file.startsWith(`${name}-`)));
	expect(unsplit, `these views are still bundled into the launch chunk: ${unsplit.join(', ')}`).toEqual([]);
});

test('a launch does not load the feature views the user has not opened', async () => {
	const loaded = await handle.page.evaluate(() =>
		performance.getEntriesByType('resource').map((entry) => entry.name),
	);
	const leaked = DEFERRED.filter((name) => loaded.some((url) => url.includes(`/${name}-`)));
	expect(leaked, `these feature chunks were fetched during launch: ${leaked.join(', ')}`).toEqual([]);
});

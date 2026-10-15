/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The gate on every test-only environment variable the main process reads (`SNOUT_E2E_*`,
 * `SNOUTDATA_TEST_*`): a fake control plane, a fake GitHub, a local component feed, a scripted
 * model runtime. Each of them points the app at something other than the real service, so an
 * installed copy must never honour one, whatever the environment of the user who starts it says.
 *
 * Closed until the app opens it: `index.ts` calls `allowTestHooks(!app.isPackaged)` before any
 * window exists, so a packaged build reads none of them and a development or e2e build (which runs
 * out/main/index.js, unpackaged) reads them as before. Pure on purpose (no `electron` import), so
 * the modules that read through it stay testable under plain Node; their tests open it themselves.
 *
 * The scratch PROFILE (`SNOUT_E2E_USERDATA`) is not read here: a packaged build honours it for one
 * more caller, a staged update's self-check (index.ts says how).
 */

let allowed = false;

/** Open (or close) the gate. Called once by index.ts; tests call it to drive the hooks. */
export function allowTestHooks(on: boolean): void {
	allowed = on;
}

/** Whether test hooks are honoured in this process. */
export function testHooksAllowed(): boolean {
	return allowed;
}

/** A test-only environment variable, or undefined in a build that must not honour one. */
export function testEnv(name: string): string | undefined {
	if (!allowed) {
		return undefined;
	}
	const value = process.env[name];
	return value ? value : undefined;
}

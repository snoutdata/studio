/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * An update installed from the tray relaunches the app, and it should come back where it was: in
 * the tray, not as a window that opens by itself on somebody's screen while they are doing
 * something else. The installer runs the new version with no arguments we control, so the old
 * version leaves this note on its way out and the new one reads it (and deletes it) once, when it
 * creates its window.
 *
 * Deliberately short-lived: a note that survived a failed install must not make the NEXT launch,
 * days later and from the Start menu, open without a window.
 */
const FILE = 'relaunch-hidden.json';

/** How long after it was written the note still counts. An install takes seconds to a minute. */
export const RELAUNCH_HIDDEN_TTL_MS = 10 * 60 * 1000;

export function writeRelaunchHidden(dir: string, now: number = Date.now()): void {
	try {
		writeFileSync(join(dir, FILE), JSON.stringify({ at: now }));
	} catch {
		// Worst case the new version opens its window, which is what it did before.
	}
}

/**
 * Whether this launch should start hidden, removing the note either way. One `existsSync` when
 * there is no note, which is every launch but one, so it costs the boot path nothing.
 */
export function consumeRelaunchHidden(dir: string, now: number = Date.now()): boolean {
	const path = join(dir, FILE);
	if (!existsSync(path)) {
		return false;
	}
	let at: unknown;
	try {
		at = (JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown }).at;
	} catch {
		at = undefined;
	}
	try {
		rmSync(path, { force: true });
	} catch {
		// A note we cannot delete would hide every launch for ten minutes at most.
	}
	return typeof at === 'number' && now >= at && now - at <= RELAUNCH_HIDDEN_TTL_MS;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Remembers the main window's size (and maximized state) between launches, persisted as
// JSON in the app data dir. We store size only — not the x/y position — so a window can
// never be restored onto a monitor that's since been unplugged.
//
// It also carries the one thing the tray has to remember: whether the user has already been told
// that closing the window leaves the app running (src/main/tray.ts). Same file, because it is the
// same subject — what the window did last time.

export interface WindowSize {
	width: number;
	height: number;
	maximized: boolean;
}

/** The file, whole. `size` is null until a window has been closed once. */
export interface WindowState {
	size: WindowSize | null;
	/** True once the "it keeps running" notice has been shown, so it is shown exactly once. */
	trayNoticeShown: boolean;
}

function windowPath(): string {
	return join(app.getPath('userData'), 'window.json');
}

function readState(): WindowState {
	const path = windowPath();
	if (!existsSync(path)) {
		return { size: null, trayNoticeShown: false };
	}
	try {
		const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<WindowSize & WindowState>;
		const size = typeof raw.width === 'number' && typeof raw.height === 'number'
			? { width: raw.width, height: raw.height, maximized: raw.maximized === true }
			: null;
		return { size, trayNoticeShown: raw.trayNoticeShown === true };
	} catch {
		return { size: null, trayNoticeShown: false };
	}
}

/** Write the file, keeping the fields this caller did not set. The size and the tray flag are
 *  written at different moments, so a write of one must not drop the other. */
function writeState(state: WindowState): void {
	const path = windowPath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ ...state.size, trayNoticeShown: state.trayNoticeShown }, null, 2), 'utf8');
	} catch {
		// A failure to remember any of this is not worth crashing or interrupting shutdown over.
	}
}

export function readWindowSize(): WindowSize | null {
	return readState().size;
}

export function writeWindowSize(size: WindowSize): void {
	writeState({ ...readState(), size });
}

/** Whether the user has been told that closing the window leaves the app running in the tray. */
export function trayNoticeShown(): boolean {
	return readState().trayNoticeShown;
}

export function markTrayNoticeShown(): void {
	writeState({ ...readState(), trayNoticeShown: true });
}

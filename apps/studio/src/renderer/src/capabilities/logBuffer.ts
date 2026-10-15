/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A tiny in-memory ring buffer of recent app log lines, so the `get_recent_logs` capability can
 * show the assistant what's been going wrong without a real logging backend. `install()` tees
 * console.warn/error into the buffer (originals still fire); app code can also push structured
 * lines with {@link logEvent}. DOM-free and node-safe.
 */

export interface LogLine {
	ts: number;
	level: 'info' | 'warn' | 'error';
	message: string;
	/** The saved connection the line is about, when the app knows (a notification naming one). A
	 *  line without one cannot be held to a connection's data-access level or agent access, so it is
	 *  reduced to its error class wherever those apply. */
	connectionId?: string;
}

const CAP = 200;
const lines: LogLine[] = [];
let installed = false;

function push(level: LogLine['level'], message: string, connectionId?: string): void {
	lines.push({ ts: Date.now(), level, message, ...(connectionId ? { connectionId } : {}) });
	if (lines.length > CAP) {
		lines.splice(0, lines.length - CAP);
	}
}

/** Record an app event explicitly (use for things that aren't console output). */
export function logEvent(message: string, level: LogLine['level'] = 'info', connectionId?: string): void {
	push(level, message, connectionId);
}

/** The most recent log lines, oldest first, capped at `limit` (default 50, max {@link CAP}). */
export function recentLogs(limit = 50): LogLine[] {
	const n = Math.max(1, Math.min(limit, CAP));
	return lines.slice(-n);
}

function format(args: unknown[]): string {
	return args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeStringify(a))).join(' ');
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Tee console.warn/error into the buffer. Idempotent. */
export function install(): void {
	if (installed) {
		return;
	}
	installed = true;
	const origWarn = console.warn.bind(console);
	const origError = console.error.bind(console);
	console.warn = (...args: unknown[]): void => {
		push('warn', format(args));
		origWarn(...args);
	};
	console.error = (...args: unknown[]): void => {
		push('error', format(args));
		origError(...args);
	};
}

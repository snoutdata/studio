/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react';
import { logEvent } from './capabilities/logBuffer';
import { recordError } from './capabilities/lastError';

/**
 * A persistent, app-wide notifications store: the durable home for errors and notable events
 * (connection failures, failed queries, exports, …) that used to flash once in the toolbar
 * status line and vanish. Entries survive restarts (localStorage), so the user gets a real
 * history of "previous issues" they can revisit and hand to the assistant. DOM-free apart from
 * localStorage; consumed by the activity-bar bell + the notifications center.
 */

export type NotificationSeverity = 'error' | 'warn' | 'info';

export interface AppNotification {
	id: string;
	ts: number;
	severity: NotificationSeverity;
	title: string;
	/** The full message (e.g. the raw driver error). Shown expanded in the center. */
	detail?: string;
	/** Where it came from, for grouping/labelling, e.g. 'connection', 'query', 'export'. */
	source?: string;
	/** Who wrote it, when a MODEL did (an agent, or the app's assistant): shown on the toast and in
	 *  the center as "From …", so a model's words never pass for the app's own. Absent for the app. */
	from?: string;
	/** The connection involved, so "Ask AI" can ground the chat in its schema. */
	connectionId?: string;
	/** The SQL that produced the error, if any, so "Ask AI" can propose a corrected query. */
	sql?: string;
	read: boolean;
}

const STORAGE_KEY = 'positron.notifications.v1';
const CAP = 200;

let items: AppNotification[] = load();
const listeners = new Set<() => void>();
const newListeners = new Set<(entry: AppNotification) => void>();

function load(): AppNotification[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return [];
		}
		const parsed = JSON.parse(raw) as AppNotification[];
		return Array.isArray(parsed) ? parsed.slice(-CAP) : [];
	} catch {
		return [];
	}
}

function persist(): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(-CAP)));
	} catch {
		// Ignore quota/availability errors; the in-memory list still works for this session.
	}
}

function emit(): void {
	persist();
	for (const listener of listeners) {
		listener();
	}
}

export interface NotifyInput {
	severity?: NotificationSeverity;
	title: string;
	detail?: string;
	source?: string;
	/** See {@link AppNotification.from}. */
	from?: string;
	connectionId?: string;
	/** The connection's label, used to name it in the log line + last-error the assistant reads. */
	connectionLabel?: string;
	sql?: string;
}

/** The most recent error recorded for one connection from one source (`'connection'`: a failed
 *  connect), within `withinMs`. Liby reads it to know why a connection's form was opened. */
export function lastErrorFor(connectionId: string, source: string, withinMs: number): AppNotification | undefined {
	const since = Date.now() - withinMs;
	for (let i = items.length - 1; i >= 0; i--) {
		const n = items[i];
		if (n.ts < since) {
			return undefined;
		}
		if (n.severity === 'error' && n.connectionId === connectionId && n.source === source) {
			return n;
		}
	}
	return undefined;
}

/** Record a user-facing notification (an error by default). Returns the new entry's id. */
export function notify(input: NotifyInput): string {
	const entry: AppNotification = {
		id: crypto.randomUUID(),
		ts: Date.now(),
		severity: input.severity ?? 'error',
		title: input.title,
		detail: input.detail,
		source: input.source,
		from: input.from,
		connectionId: input.connectionId,
		sql: input.sql,
		read: false,
	};
	items = [...items, entry].slice(-CAP);
	// Mirror into the log ring buffer so the assistant's get_recent_logs capability sees it too,
	// naming the connection it involved so the assistant knows which one to fix.
	const where = input.connectionLabel ? ` [${input.connectionLabel}]` : '';
	logEvent(input.detail ? `${input.title}${where}: ${input.detail}` : `${input.title}${where}`, entry.severity, entry.connectionId);
	// Keep the latest error on hand for the get_last_error capability ("fix it for me").
	if (entry.severity === 'error') {
		recordError({ ts: entry.ts, title: entry.title, detail: entry.detail, source: entry.source, connectionId: entry.connectionId, connectionLabel: input.connectionLabel, sql: entry.sql });
	}
	emit();
	for (const listener of newListeners) {
		listener(entry);
	}
	return entry.id;
}

/** Convenience for the common case: a new error entry. */
export function notifyError(title: string, detail?: string, extra?: Omit<NotifyInput, 'title' | 'detail' | 'severity'>): string {
	return notify({ severity: 'error', title, detail, ...extra });
}

export function dismiss(id: string): void {
	const next = items.filter((n) => n.id !== id);
	if (next.length !== items.length) {
		items = next;
		emit();
	}
}

export function clearAll(): void {
	if (items.length > 0) {
		items = [];
		emit();
	}
}

/** Mark every entry as read (called when the center is opened). */
export function markAllRead(): void {
	if (items.some((n) => !n.read)) {
		items = items.map((n) => (n.read ? n : { ...n, read: true }));
		emit();
	}
}

/** Register a callback fired once per newly-added entry (for transient toasts). Returns an unsubscribe. */
export function onNotify(callback: (entry: AppNotification) => void): () => void {
	newListeners.add(callback);
	return () => {
		newListeners.delete(callback);
	};
}

function snapshot(): AppNotification[] {
	return items;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** React hook: the live notifications list (oldest first, as stored). */
export function useNotifications(): AppNotification[] {
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

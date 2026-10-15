/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CapabilityHandler } from './registry';
import { recentLogs } from './logBuffer';
import { lastError } from './lastError';

/**
 * Read-only diagnostics: the recent app log lines (warnings/errors teed from the console plus
 * explicit events) and the single most recent error, so the assistant can help debug "why did
 * that fail?" or "fix it for me" without the user pasting anything. No prompt.
 */
export const logCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'get_recent_logs',
			description: 'Get the most recent app log lines (warnings, errors, and notable events). Use this to diagnose a failure the user is reporting.',
			parameters: {
				type: 'object',
				properties: { limit: { type: 'number', description: 'How many recent lines to return (default 50).' } },
			},
			domain: 'logs',
			mutates: false,
			implicitConnection: 'perItem',
			returnsData: 'values',
		},
		run: (args) => {
			const limit = typeof args.limit === 'number' ? args.limit : 50;
			const lines = recentLogs(limit);
			return { ok: true, summary: `${lines.length} recent log lines`, data: lines };
		},
	},
	{
		spec: {
			name: 'get_last_error',
			description: 'Get the most recent error the user hit (e.g. a failed connection or query), including which saved connection it involved (id + label) and the raw message. Use this to act on "fix it for me" without the user pasting the error. Pair the connectionId with edit_connection to correct a bad connection.',
			parameters: { type: 'object', properties: {} },
			domain: 'logs',
			mutates: false,
			implicitConnection: 'lastError',
			returnsData: 'values',
		},
		run: (_args, ctx) => {
			const err = lastError();
			if (!err) {
				return { ok: true, summary: 'No recent error this session.', data: null };
			}
			// Prefer the label captured at record time; fall back to the live snapshot in case it
			// was recorded without one (e.g. a stale closure at the call site).
			const label = err.connectionLabel
				?? (err.connectionId ? ctx.snapshot().connections.find((c) => c.id === err.connectionId)?.label : undefined);
			const data = { title: err.title, detail: err.detail, source: err.source, connectionId: err.connectionId, connectionLabel: label, sql: err.sql, ts: err.ts };
			// Tagged with its connection: a driver's message can quote values, so what the AI may see
			// of THAT database decides whether its text is handed on (engine/context/dataAccess.ts).
			return { ok: true, summary: `Last error: ${err.title}${label ? ` (connection "${label}")` : ''}`, data, dataConnectionId: err.connectionId };
		},
	},
];

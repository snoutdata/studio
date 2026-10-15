/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CapabilityContext, CapabilityHandler } from './registry';
import type { CapabilityResult } from '../../../shared/capabilities';
import { liveGrid } from '../gridBridge';

/**
 * Read-only access to the result grid currently on screen, so the assistant (or a coding agent) can
 * chart or reason about data the user already ran without re-querying. The model turns these rows
 * into a ```chart fenced block in its reply, which the render surface draws inline (see
 * src/shared/chart.ts). No prompt: it returns the same rows the user is already looking at (capped).
 *
 * ONE registration, and it is static. This capability used to exist twice — here, and again inside
 * ResultsGrid.tsx with a much better implementation — which is a duplicate-name collision the
 * registry throws on, so one of them was always silently lost. Now the grid publishes its reader
 * through `gridBridge` and this delegates to it whenever a grid is mounted, falling back to the app
 * bridge when none is. Static matters: `mcpServer.ts` snapshots the tool list at `initialize`, so a
 * capability that only exists while some component is mounted is one most external agents never
 * see.
 */
export const resultCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'get_query_result',
			description: "Read the ACTUAL row VALUES currently loaded in the result grid (the rows the user is looking at), in the grid's current filter/sort order, as a page of rows. Read-only. Use this to inspect, summarize, aggregate, chart, or spot an anomaly in the shown results, or to read more rows than the small sample in the context. IMPORTANT: it only sees rows ALREADY FETCHED into the grid (bounded by the query's LIMIT) and reflects any client-side filter/sort applied there — it does NOT re-query the database. To see rows that weren't fetched, re-run the query with a higher LIMIT or a different WHERE instead. To render a chart, reply with a ```chart fenced JSON block.",
			parameters: {
				type: 'object',
				properties: {
					offset: { type: 'number', description: 'Row to start at within the loaded result (0-based). Defaults to 0.' },
					limit: { type: 'number', description: 'How many rows to return (1-100). Defaults to 30.' },
					columns: { type: 'array', items: { type: 'string' }, description: 'Optional subset of column names to return; omit for all columns.' },
					maxRows: { type: 'number', description: 'Legacy alias for limit, kept so an older prompt still works.' },
				},
			},
			domain: 'results',
			mutates: false,
			implicitConnection: 'result',
			returnsData: 'values',
		},
		// Tagged with the connection the rows came from: main checks what the AI may see of THAT
		// database (engine/context/dataAccess.ts) before the rows reach any model.
		run: (args, ctx) => ({ ...readResult(args, ctx), dataConnectionId: ctx.app.resultConnectionId?.() }),
	},
];

function readResult(args: Record<string, unknown>, ctx: CapabilityContext): CapabilityResult {
	// The grid on screen answers this precisely (paging, a column subset, and the order the
	// user is actually looking at). Everything below is the fallback for when none is mounted.
	const grid = liveGrid();
	if (grid) {
		// `maxRows` was this tool's old parameter name. Accept it as `limit` so a prompt (or a
		// model) written against the previous shape still reads rows instead of silently
		// getting the default page.
		const limit = typeof args.limit === 'number' ? args.limit : typeof args.maxRows === 'number' ? args.maxRows : undefined;
		return grid.getQueryResult(limit === undefined ? args : { ...args, limit });
	}
	const maxRows = typeof args.maxRows === 'number' ? args.maxRows : typeof args.limit === 'number' ? args.limit : 100;
	const res = ctx.app.getQueryResult(maxRows);
	if (res.status === 'none') {
		return { ok: false, summary: '', error: "No query result is currently shown. Run a query first (or ask the user to)." };
	}
	if (res.status === 'error') {
		// The query ran but failed. Hand the model the error so it fixes the SQL and re-runs,
		// instead of looping on a generic "nothing here" message.
		return { ok: false, summary: '', error: `The last query failed: ${res.error}. Fix the SQL and run it again before reading the result.`, errorFromDatabase: true };
	}
	const view = res.view;
	const shown = view.truncated ? ` (showing the first ${view.rows.length})` : '';
	return {
		ok: true,
		summary: `${view.rowCount} rows × ${view.columns.length} columns${shown}`,
		data: view,
	};
}

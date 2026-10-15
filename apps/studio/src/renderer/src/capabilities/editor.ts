/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CapabilityHandler } from './registry';

/**
 * Editor-control capabilities: let the assistant put SQL where the user wants it and run it.
 * All are `mutates` (they change the editor / execute), so they're approval-gated — the model
 * can still also propose SQL in its reply for the user to insert manually.
 */
export const editorCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'insert_sql',
			description: "Insert SQL at the cursor in the active editor tab (replacing any selection).",
			parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
			domain: 'editor',
			consentLabel: "Type SQL into the editor you are looking at.",
			mutates: true,
			implicitConnection: 'activeTab',
			returnsData: 'none',
		},
		run: (args, ctx) => {
			const sql = String(args.sql ?? '');
			if (!sql.trim()) {
				return { ok: false, summary: '', error: 'Provide SQL to insert.' };
			}
			ctx.app.insertAtCursor(sql);
			return { ok: true, summary: 'Inserted SQL at the cursor' };
		},
	},
	{
		spec: {
			name: 'open_in_new_tab',
			description: 'Open a new editor tab containing SQL for the USER to read or run themselves. Do NOT use this to obtain data for your own use (a chart, analysis, or answering a question): call the run_query tool instead, which returns the rows directly without touching the editor. Use this only when the user wants the query placed in their editor.',
			parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
			domain: 'editor',
			consentLabel: "Open a new editor tab with SQL in it.",
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: (args, ctx) => {
			const sql = String(args.sql ?? '');
			ctx.app.createTab(sql);
			return { ok: true, summary: 'Opened the SQL in a new tab' };
		},
	},
	{
		spec: {
			name: 'run_current',
			// "Run current" is not a thing anyone says; the derived title needs help here.
			title: 'Run the current query',
			description: 'Run whatever SQL the user currently has in their active editor tab. Use this ONLY when the user explicitly asks to run what is in their editor. NEVER use it to fetch data for yourself (e.g. to build a chart or answer a question): it runs whatever the user happens to have open, which is often not what you intend. To run your own query and read the rows, use the run_query tool instead.',
			parameters: { type: 'object', properties: {} },
			domain: 'editor',
			consentLabel: "Run the query in the editor.",
			mutates: true,
			implicitConnection: 'activeTab',
			returnsData: 'none',
		},
		run: async (_args, ctx) => {
			await ctx.app.runCurrent();
			return { ok: true, summary: 'Ran the current statement' };
		},
	},
];

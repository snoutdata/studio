/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CapabilityHandler } from './registry';
import type { WorkspaceFile } from '../../../shared/workspace';

/**
 * Workspace-file capabilities: let the assistant browse, read, search, write, and open the
 * user's `.sql` script library (the same folder the Workspace side view shows). This is the
 * "talk to my files" seam — the agent lists/searches to find a script, reads it for grounding,
 * and can save a new one or open one into the editor. Reads run silently; writes (`save`/`open`)
 * are `mutates` and so approval-gated.
 */

/** Normalize a user/model-supplied name to a `*.sql` file name (no path parts). */
function sqlName(name: string): string {
	const base = name.trim().split(/[\\/]/).pop() ?? '';
	const clean = base.replace(/[<>:"|?*]/g, '').trim() || 'query';
	return clean.toLowerCase().endsWith('.sql') ? clean : `${clean}.sql`;
}

/** Find a workspace file by name (case-insensitive, with or without the .sql extension). */
function findByName(files: WorkspaceFile[], name: string): WorkspaceFile | undefined {
	const target = sqlName(name).toLowerCase();
	return files.find((f) => f.name.toLowerCase() === target);
}

export const workspaceCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'list_workspace_files',
			description: 'List the SQL script files in the user\'s workspace folder (name, size, last modified). The workspace is the user\'s saved library of .sql scripts.',
			parameters: { type: 'object', properties: {} },
			domain: 'workspace',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: async (_args, ctx) => {
			const files = await ctx.api.workspace.list();
			return {
				ok: true,
				summary: `${files.length} workspace file${files.length === 1 ? '' : 's'}`,
				data: files.map((f) => ({ name: f.name, size: f.size, modifiedAt: f.modifiedAt })),
			};
		},
	},
	{
		spec: {
			name: 'read_workspace_file',
			description: 'Read the full contents of a workspace SQL file by name (e.g. "daily-report.sql").',
			parameters: {
				type: 'object',
				properties: { name: { type: 'string', description: 'The file name, e.g. "daily-report.sql".' } },
				required: ['name'],
			},
			domain: 'workspace',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: async (args, ctx) => {
			const name = String(args.name ?? '').trim();
			if (!name) {
				return { ok: false, summary: '', error: 'Provide a file name to read.' };
			}
			const file = findByName(await ctx.api.workspace.list(), name);
			if (!file) {
				return { ok: false, summary: '', error: `No workspace file named "${name}".` };
			}
			const content = await ctx.api.workspace.read(file.path);
			return { ok: true, summary: `Read ${file.name}`, data: { name: file.name, content } };
		},
	},
	{
		spec: {
			name: 'search_workspace',
			description: 'Search the workspace SQL files by name and contents. Returns matching files with the matching lines, so you can find the script that does something without reading every file.',
			parameters: {
				type: 'object',
				properties: { query: { type: 'string', description: 'Text to search for in file names and contents.' } },
				required: ['query'],
			},
			domain: 'workspace',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: async (args, ctx) => {
			const query = String(args.query ?? '').trim();
			if (!query) {
				return { ok: false, summary: '', error: 'Provide a search query.' };
			}
			const hits = await ctx.api.workspace.search(query);
			return {
				ok: true,
				summary: `${hits.length} file${hits.length === 1 ? '' : 's'} match "${query}"`,
				data: hits.map((h) => ({ name: h.name, nameMatch: h.nameMatch, matches: h.matches })),
			};
		},
	},
	{
		spec: {
			name: 'save_workspace_file',
			consentLabel: 'Save SQL to a file in your workspace, overwriting one of the same name.',
			description: 'Save SQL to a workspace file by name, creating it if it does not exist or overwriting it if it does. Use this to store a script the user wants to keep.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The file name, e.g. "monthly-summary.sql".' },
					content: { type: 'string', description: 'The SQL to write to the file.' },
				},
				required: ['name', 'content'],
			},
			domain: 'workspace',
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: async (args, ctx) => {
			const name = String(args.name ?? '').trim();
			const content = String(args.content ?? '');
			if (!name) {
				return { ok: false, summary: '', error: 'Provide a file name to save.' };
			}
			const existing = findByName(await ctx.api.workspace.list(), name);
			const file = existing
				? await ctx.api.workspace.save(existing.path, content)
				: await ctx.api.workspace.create(sqlName(name), content);
			return { ok: true, summary: `Saved ${file.name}`, data: { name: file.name } };
		},
	},
	{
		spec: {
			name: 'open_workspace_file',
			description: 'Open a workspace SQL file in a new editor tab so the user can see and run it.',
			parameters: {
				type: 'object',
				properties: { name: { type: 'string', description: 'The file name, e.g. "daily-report.sql".' } },
				required: ['name'],
			},
			domain: 'workspace',
			consentLabel: "Open one of your workspace .sql files.",
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: async (args, ctx) => {
			const name = String(args.name ?? '').trim();
			if (!name) {
				return { ok: false, summary: '', error: 'Provide a file name to open. Call list_workspace_files first to see what is available.' };
			}
			const files = await ctx.api.workspace.list();
			const file = findByName(files, name);
			if (!file) {
				const available = files.map((f) => f.name).join(', ') || '(none)';
				return { ok: false, summary: '', error: `No workspace file named "${name}". Available files: ${available}.` };
			}
			await ctx.app.openWorkspaceFile(file.path);
			return { ok: true, summary: `Opened ${file.name}` };
		},
	},
];

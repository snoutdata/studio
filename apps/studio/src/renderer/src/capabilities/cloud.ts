/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLOUD_REGIONS, type CloudProjectRow } from '../../../shared/cloudProjects';
import { PROJECT_SECTIONS, projectSection } from '../../../shared/projects';
import type { CapabilityResult } from '../../../shared/capabilities';
import type { CapabilityContext, CapabilityHandler } from './registry';

/**
 * SnoutData Cloud projects, for the assistant and for a coding agent (the registry is published
 * to agents as MCP tools). Each is the same call the Cloud projects panel makes, so the control
 * plane decides every limit and refusal, and a refusal comes back in its own words.
 *
 * Built for a small model: every tool takes the project by NAME or ref (`project`), because a
 * model has the name from the user's sentence and would otherwise need a lookup first; the list
 * says what each project can do right now, so "stop it" does not have to be tried to be refused;
 * and nothing returns a password or an API key (those go to the clipboard, and only when a person
 * clicks Copy in the project tab).
 */

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const SECTION_IDS = PROJECT_SECTIONS.map((s) => s.id);

function describe(row: CloudProjectRow): Record<string, unknown> {
	return {
		ref: row.ref,
		name: row.name,
		state: row.state,
		...(row.desiredState ? { changingTo: row.desiredState } : {}),
		region: row.region,
		production: row.production,
		sizeBytes: row.sizeBytes,
		readOnly: row.readOnly,
		lastConnectionAt: row.lastConnectionAt,
		host: row.host,
		database: row.database,
		user: row.user,
		canStart: row.canResume,
		canStop: row.canPause,
		canDelete: row.canDelete,
		...(row.pauseRefusal ? { whyNoStop: row.pauseRefusal } : {}),
	};
}

/** Find a project by ref or by name (case-insensitive), or say what exists. Shared with shards.ts. */
export async function find(ctx: CapabilityContext, project: unknown): Promise<{ row: CloudProjectRow } | { error: CapabilityResult }> {
	const wanted = str(project);
	const view = await ctx.api.cloudProjects();
	if (view.unavailable && view.projects.length === 0) {
		return { error: { ok: false, summary: '', error: view.unavailable } };
	}
	if (!wanted) {
		return { error: { ok: false, summary: '', error: `Say which project. Projects: ${view.projects.map((p) => p.name).join(', ') || 'none'}.` } };
	}
	const lower = wanted.toLowerCase();
	const row = view.projects.find((p) => p.ref === wanted) ?? view.projects.find((p) => p.name.toLowerCase() === lower);
	if (!row) {
		return { error: { ok: false, summary: '', error: `No project "${wanted}". Projects: ${view.projects.map((p) => p.name).join(', ') || 'none'}.` } };
	}
	return { row };
}

/**
 * The saved connections of the project a call names: the database it acts on, as far as agent
 * access is concerned. A project with no saved connection in this app is none (the account decides
 * what may be done to it); one that cannot be found is none too, and the call itself says so.
 * Shared with shards.ts.
 */
export async function projectConnections(args: Record<string, unknown>, ctx: CapabilityContext): Promise<string[]> {
	const found = await find(ctx, args.project);
	if ('error' in found) {
		return [];
	}
	return (await ctx.api.state()).connections.filter((connection) => connection.cloudProjectRef === found.row.ref).map((connection) => connection.id);
}

function refused(message: string, wasRefused: boolean): CapabilityResult {
	return { ok: false, summary: '', error: message, refused: wasRefused };
}

const PROJECT_PARAM = { type: 'string', description: 'The project, by name (e.g. "orders") or by ref.' } as const;

export const cloudCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'list_cloud_projects',
			description: 'List the signed-in account\'s SnoutData Cloud projects (hosted Postgres): name, ref, state (ready, paused, starting, …), region, size, whether it is production, and what can be done to each now (canStart, canStop, canDelete). Use this first for any question about cloud projects or hosted databases.',
			parameters: { type: 'object', properties: {} },
			domain: 'cloud',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: async (_args, ctx) => {
			const view = await ctx.api.cloudProjects();
			if (view.projects.length === 0) {
				return { ok: true, summary: view.unavailable ?? 'No cloud projects', data: { projects: [], note: view.unavailable } };
			}
			return { ok: true, summary: `${view.projects.length} cloud projects`, data: { account: view.account, projects: view.projects.map(describe) } };
		},
	},
	{
		spec: {
			name: 'get_cloud_project',
			description: 'Everything about one SnoutData Cloud project: its state and address, which products are on (auth, storage, data API), its deployed functions and secret NAMES, its custom domains, and its latest storage use against the plan limit. Never returns a password or an API key.',
			parameters: { type: 'object', properties: { project: PROJECT_PARAM }, required: ['project'] },
			domain: 'cloud',
			mutates: false,
			implicitConnection: 'target',
			returnsData: 'none',
		},
		connections: projectConnections,
		run: async (args, ctx) => {
			const found = await find(ctx, args.project);
			if ('error' in found) {
				return found.error;
			}
			const ref = found.row.ref;
			const [services, functions, domains, usage] = await Promise.all([
				ctx.api.cloudProject('services', { ref }),
				ctx.api.cloudProject('functions', { ref }),
				ctx.api.cloudProject('domains', { ref }),
				ctx.api.cloudProject('usage', { ref }),
			]);
			const latest = usage.ok ? [...usage.data.days].reverse().find((d) => d.dbBytes !== null) : undefined;
			return {
				ok: true,
				summary: `${found.row.name}: ${found.row.state}`,
				data: {
					...describe(found.row),
					products: services.ok
						? { auth: services.data.auth?.enabled ?? null, storage: services.data.storage?.enabled ?? null, dataApi: services.data.dataApi?.enabled ?? null, dataApiAllowedOnPlan: services.data.dataApi?.allowed ?? null }
						: { error: services.message },
					functions: functions.ok ? functions.data.functions.map((f) => f.name) : { error: functions.message },
					secretNames: functions.ok ? functions.data.secrets.map((s) => s.name) : undefined,
					// Each function's memory and workers as it runs, and the plan they are sized within.
					functionSizes: functions.ok ? functions.data.functions.map((f) => ({ name: f.name, memoryMb: f.memoryMb ?? null, concurrency: f.concurrency ?? null })) : undefined,
					functionPlan: functions.ok ? functions.data.plan ?? null : undefined,
					domains: domains.ok ? domains.data.map((d) => ({ hostname: d.hostname, verified: d.verified })) : { error: domains.message },
					storage: usage.ok ? { dbBytes: latest?.dbBytes ?? null, planLimitBytes: usage.data.limit?.maxStorageBytes ?? null, tier: usage.data.limit?.tier ?? null } : { error: usage.message },
					cannotBeChangedYet: ['name', 'production flag', 'team sharing'],
				},
			};
		},
	},
	{
		spec: {
			name: 'create_cloud_project',
			consentLabel: 'Create a new SnoutData Cloud project (a hosted database) on your account.',
			description: `Create a new SnoutData Cloud project (a hosted Postgres database) and add it as a connection. It takes about half a minute to start. The plan's project limit and whether production is allowed are decided by the control plane, which refuses in its own words. Regions: ${CLOUD_REGIONS.map((r) => r.id).join(', ')}.`,
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The project name, 1 to 60 characters.' },
					region: { type: 'string', description: `Region (default ${CLOUD_REGIONS[0].id}).` },
					production: { type: 'boolean', description: 'Never pause it (Plus and Pro only). Default false.' },
				},
				required: ['name'],
			},
			domain: 'cloud',
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: async (args, ctx) => {
			const name = str(args.name);
			if (!name) {
				return { ok: false, summary: '', error: 'A project needs a name.' };
			}
			const outcome = await ctx.api.cloudCreate({ name, region: str(args.region) ?? CLOUD_REGIONS[0].id, production: args.production === true });
			if (!outcome.ok) {
				return refused(outcome.message, outcome.refused === true);
			}
			return { ok: true, summary: outcome.message, data: { ref: outcome.ref, addedAsConnection: outcome.connected === true } };
		},
	},
	{
		spec: {
			name: 'start_cloud_project',
			consentLabel: 'Start a paused SnoutData Cloud project.',
			description: 'Start (wake) a paused SnoutData Cloud project. This ASKS for it: the host starts it within a few seconds, so check list_cloud_projects afterwards rather than assuming it is ready.',
			parameters: { type: 'object', properties: { project: PROJECT_PARAM }, required: ['project'] },
			domain: 'cloud',
			mutates: true,
			implicitConnection: 'target',
			returnsData: 'none',
		},
		connections: projectConnections,
		run: async (args, ctx) => {
			const found = await find(ctx, args.project);
			if ('error' in found) {
				return found.error;
			}
			const outcome = await ctx.api.cloudAsk('resume', found.row.ref);
			return outcome.ok ? { ok: true, summary: outcome.message } : refused(outcome.message, outcome.refused === true);
		},
	},
	{
		spec: {
			name: 'stop_cloud_project',
			consentLabel: 'Stop (pause) a SnoutData Cloud project.',
			description: 'Stop (pause) a SnoutData Cloud project. A production project is never paused and this is refused. It ASKS: the host stops it within a few seconds.',
			parameters: { type: 'object', properties: { project: PROJECT_PARAM }, required: ['project'] },
			domain: 'cloud',
			mutates: true,
			implicitConnection: 'target',
			returnsData: 'none',
			destructive: true,
		},
		connections: projectConnections,
		run: async (args, ctx) => {
			const found = await find(ctx, args.project);
			if ('error' in found) {
				return found.error;
			}
			const outcome = await ctx.api.cloudAsk('pause', found.row.ref);
			return outcome.ok ? { ok: true, summary: outcome.message } : refused(outcome.message, outcome.refused === true);
		},
	},
	{
		spec: {
			name: 'delete_cloud_project',
			consentLabel: 'Delete a SnoutData Cloud project and its data, and remove its connection.',
			description: 'Delete a SnoutData Cloud project and its data (recoverable for the plan\'s grace period) and remove its connection from the app. Only when the user clearly asked to delete that project.',
			parameters: { type: 'object', properties: { project: PROJECT_PARAM }, required: ['project'] },
			domain: 'cloud',
			mutates: true,
			implicitConnection: 'target',
			returnsData: 'none',
			destructive: true,
		},
		connections: projectConnections,
		run: async (args, ctx) => {
			const found = await find(ctx, args.project);
			if ('error' in found) {
				return found.error;
			}
			const outcome = await ctx.api.cloudDelete(found.row.ref);
			return outcome.ok ? { ok: true, summary: `${found.row.name}: ${outcome.message}` } : refused(outcome.message, outcome.refused === true);
		},
	},
	{
		spec: {
			name: 'set_cloud_product',
			consentLabel: 'Turn a SnoutData Cloud product (auth, storage or data API) on or off for a project.',
			description: 'Turn one of a SnoutData Cloud project\'s products on or off: "auth" (user sign-up/sign-in), "storage" (files) or "dataApi" (REST and GraphQL over the tables, on every plan). It starts within about a minute.',
			parameters: {
				type: 'object',
				properties: {
					project: PROJECT_PARAM,
					product: { type: 'string', enum: ['auth', 'storage', 'dataApi'] },
					enable: { type: 'boolean', description: 'true to turn it on, false to turn it off.' },
				},
				required: ['project', 'product', 'enable'],
			},
			domain: 'cloud',
			mutates: true,
			implicitConnection: 'target',
			returnsData: 'none',
			destructive: true,
		},
		connections: projectConnections,
		run: async (args, ctx) => {
			const product = args.product;
			if (product !== 'auth' && product !== 'storage' && product !== 'dataApi') {
				return { ok: false, summary: '', error: 'product must be auth, storage or dataApi.' };
			}
			if (typeof args.enable !== 'boolean') {
				return { ok: false, summary: '', error: 'enable must be true or false.' };
			}
			const found = await find(ctx, args.project);
			if ('error' in found) {
				return found.error;
			}
			const outcome = await ctx.api.cloudProject('setService', { ref: found.row.ref, service: product, enable: args.enable });
			return outcome.ok
				? { ok: true, summary: outcome.data.note ?? `${product} turned ${args.enable ? 'on' : 'off'} for ${found.row.name}.` }
				: refused(outcome.message, outcome.refused);
		},
	},
	{
		spec: {
			name: 'remove_cloud_secret',
			consentLabel: "Remove an environment secret from a SnoutData Cloud project's functions.",
			// There is deliberately no SET beside it, the rule the CLI's MCP server already keeps: every
			// tool call is written to the AI audit log with its arguments, so a secret passed to a tool
			// is a secret in a log. A person sets one in the project tab (Functions) or with
			// `snoutdata secrets set`.
			description: "Remove an environment variable from a SnoutData Cloud project's functions. There is no tool that SETS one: a secret in a tool call is a secret in the audit log, so tell the user to set it in the project tab (open_cloud_project, section functions) or with `snoutdata secrets set NAME --stdin`.",
			parameters: {
				type: 'object',
				properties: {
					project: PROJECT_PARAM,
					name: { type: 'string', description: 'The variable name, e.g. STRIPE_SECRET_KEY.' },
				},
				required: ['project', 'name'],
			},
			domain: 'cloud',
			mutates: true,
			implicitConnection: 'target',
			returnsData: 'none',
			destructive: true,
		},
		connections: projectConnections,
		run: async (args, ctx) => {
			const name = str(args.name)?.toUpperCase();
			if (!name) {
				return { ok: false, summary: '', error: 'Say which secret to remove.' };
			}
			const found = await find(ctx, args.project);
			if ('error' in found) {
				return found.error;
			}
			const outcome = await ctx.api.cloudProject('unsetSecret', { ref: found.row.ref, name });
			return outcome.ok ? { ok: true, summary: `${name} removed from ${found.row.name}.` } : refused(outcome.message, outcome.refused);
		},
	},
	{
		spec: {
			name: 'size_cloud_function',
			consentLabel: 'Change the memory and number of workers of a SnoutData Cloud function.',
			description: "Set one Snout Function's memory (MB one worker may use) and concurrency (how many workers it may run at once) within the project's plan. memoryMb × concurrency may not exceed the project's memory; get_cloud_project shows each function's size (functionSizes) and the plan's limits (functionPlan). Omit one to keep it as it runs now; reset true goes back to the plan's default. A size that does not fit is refused with a sentence. A second worker only helps CPU-bound work.",
			parameters: {
				type: 'object',
				properties: {
					project: PROJECT_PARAM,
					name: { type: 'string', description: 'The function.' },
					memoryMb: { type: 'integer', description: 'Memory one worker may use, in MB.' },
					concurrency: { type: 'integer', description: 'How many workers it may run at once.' },
					reset: { type: 'boolean', description: "Back to the plan's default size." },
				},
				required: ['project', 'name'],
			},
			domain: 'cloud',
			mutates: true,
			implicitConnection: 'target',
			returnsData: 'none',
		},
		connections: projectConnections,
		run: async (args, ctx) => {
			const found = await find(ctx, args.project);
			if ('error' in found) {
				return found.error;
			}
			const name = str(args.name);
			const memoryMb = typeof args.memoryMb === 'number' ? args.memoryMb : undefined;
			const concurrency = typeof args.concurrency === 'number' ? args.concurrency : undefined;
			const reset = args.reset === true;
			if (!name || (!reset && memoryMb === undefined && concurrency === undefined)) {
				return { ok: false, summary: 'Say which function, and a memoryMb, a concurrency, or reset.' };
			}
			const outcome = await ctx.api.cloudProject('sizeFunction', { ref: found.row.ref, name, memoryMb, concurrency, reset });
			if (!outcome.ok) {
				return refused(outcome.message, outcome.refused);
			}
			const now = outcome.data.functions.find((f) => f.name === name);
			return {
				ok: true,
				summary: `${name} on ${found.row.name} runs at ${now?.memoryMb} MB × ${now?.concurrency} workers from its next request.`,
				data: { name, memoryMb: now?.memoryMb ?? null, concurrency: now?.concurrency ?? null, plan: outcome.data.plan },
			};
		},
	},
	{
		spec: {
			name: 'export_cloud_project',
			consentLabel: 'Take a pg_dump export of a SnoutData Cloud project.',
			description: 'Ask for a pg_dump export of a SnoutData Cloud project. It is taken within a minute; the download link appears in the project tab\'s Backups section.',
			parameters: { type: 'object', properties: { project: PROJECT_PARAM }, required: ['project'] },
			domain: 'cloud',
			mutates: true,
			implicitConnection: 'target',
			returnsData: 'none',
			destructive: true,
		},
		connections: projectConnections,
		run: async (args, ctx) => {
			const found = await find(ctx, args.project);
			if ('error' in found) {
				return found.error;
			}
			const outcome = await ctx.api.cloudProject('requestExport', { ref: found.row.ref });
			return outcome.ok ? { ok: true, summary: `Export asked for ${found.row.name}.` } : refused(outcome.message, outcome.refused);
		},
	},
	{
		spec: {
			name: 'reset_cloud_password',
			consentLabel: 'Reset a SnoutData Cloud project\'s database password (other clients using the old one are disconnected).',
			description: 'Issue a new database password for a SnoutData Cloud project. The app\'s own connections are updated; anything else using the old password is disconnected when it reconnects. The new password is not returned.',
			parameters: { type: 'object', properties: { project: PROJECT_PARAM }, required: ['project'] },
			domain: 'cloud',
			mutates: true,
			implicitConnection: 'target',
			returnsData: 'none',
			destructive: true,
		},
		connections: projectConnections,
		run: async (args, ctx) => {
			const found = await find(ctx, args.project);
			if ('error' in found) {
				return found.error;
			}
			const outcome = await ctx.api.cloudProject('resetPassword', { ref: found.row.ref });
			return outcome.ok
				? { ok: true, summary: `New password for ${found.row.name}, applies ${outcome.data.appliesIn}. ${outcome.data.updatedConnections} app connection(s) updated.` }
				: refused(outcome.message, outcome.refused);
		},
	},
	{
		spec: {
			name: 'open_cloud_project',
			description: `Open a SnoutData Cloud project's tab in the app, at a section: ${SECTION_IDS.join(', ')}. overview is the Overview (state, keys, usage), database the connection details, settings the backups and deletion. Use it to SHOW the user something rather than describing where to click.`,
			parameters: {
				type: 'object',
				properties: {
					project: PROJECT_PARAM,
					section: { type: 'string', enum: SECTION_IDS, description: 'Default overview.' },
				},
				required: ['project'],
			},
			domain: 'cloud',
			mutates: false,
			implicitConnection: 'target',
			returnsData: 'none',
		},
		connections: projectConnections,
		run: async (args, ctx) => {
			const found = await find(ctx, args.project);
			if ('error' in found) {
				return found.error;
			}
			const section = projectSection(args.section);
			ctx.app.openCloudProject(found.row.ref, found.row.name, section);
			return { ok: true, summary: `Opened ${found.row.name} (${section}).` };
		},
	},
];

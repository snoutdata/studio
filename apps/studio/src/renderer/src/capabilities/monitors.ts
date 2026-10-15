/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CapabilityHandler, CapabilityContext } from './registry';
import { MIN_INTERVAL_SEC, type Monitor, type MonitorWidget, type WidgetKind, type WidgetViz } from '../../../shared/monitor';

/*
 * Monitors for an agent.
 *
 * "Make me a monitor of the slowest queries" was the sentence this whole harness was described
 * by, and it did not work: the view, the store and the poller all existed and none of it was
 * reachable. This is the seam being filled in, and it is the worked example the other nine surfaces
 * copy.
 *
 * Two rules from the harness doc show up here concretely:
 *
 *  - NAVIGATE AND MUTATE ARE SEPARATE TOOLS. `open_monitors` shows the view and writes nothing;
 *    `create_monitor` writes. One tool that did both would ask for consent to look.
 *  - A widget is `trend` or `snapshot` and the difference is not cosmetic. A trend samples a NUMBER
 *    over wall-clock time into the samples store and is polled in main whether or not the view is
 *    open; a snapshot re-runs a query and replaces what is drawn. Getting this wrong gives the user
 *    a chart that never fills in, so the description says it in the model's own terms.
 */

const VIZ: readonly WidgetViz[] = ['line', 'area', 'bar', 'number', 'table'];

function newId(): string {
	return crypto.randomUUID();
}

/** Find a monitor by id, or failing that by an exact-then-loose name match. A model that has just
 *  read the list will use the name it saw, and refusing that is pedantry. */
function pick(all: Monitor[], ref: string): Monitor | undefined {
	const needle = ref.trim().toLowerCase();
	return all.find((d) => d.id === ref)
		?? all.find((d) => d.name.toLowerCase() === needle)
		?? all.find((d) => d.name.toLowerCase().includes(needle));
}

/** The connection a widget should run against: the one named, else the app's active one. */
function resolveConnection(ctx: CapabilityContext, ref: unknown): { id: string } | { error: string } {
	const snapshot = ctx.snapshot();
	if (typeof ref === 'string' && ref.trim() !== '') {
		const needle = ref.trim().toLowerCase();
		const match = snapshot.connections.find((c) => c.id === ref) ?? snapshot.connections.find((c) => c.label.toLowerCase() === needle);
		if (!match) {
			return { error: `No connection called "${ref}". Use list_connections to see them.` };
		}
		return { id: match.id };
	}
	if (!snapshot.activeConnectionId) {
		return { error: 'No connection is selected, so there is nothing for the widget to query. Name one with connectionId.' };
	}
	return { id: snapshot.activeConnectionId };
}

function readWidget(args: Record<string, unknown>, connectionId: string): MonitorWidget | { error: string } {
	const title = typeof args.title === 'string' ? args.title.trim() : '';
	const sql = typeof args.sql === 'string' ? args.sql.trim() : '';
	if (title === '') {
		return { error: 'Give the widget a title: it is what the user reads above the chart.' };
	}
	if (sql === '') {
		return { error: 'Give the widget a sql query to poll.' };
	}
	const kind: WidgetKind = args.kind === 'snapshot' ? 'snapshot' : 'trend';
	const viz = typeof args.viz === 'string' && VIZ.includes(args.viz as WidgetViz)
		? args.viz as WidgetViz
		: (kind === 'trend' ? 'line' : 'table');
	const requested = typeof args.intervalSec === 'number' ? Math.round(args.intervalSec) : MIN_INTERVAL_SEC;
	return {
		id: newId(),
		title,
		connectionId,
		sql,
		kind,
		viz,
		// The floor is enforced at read time in the poller too; clamping here means the number the
		// agent is told back is the number that will actually be used.
		intervalSec: Math.max(MIN_INTERVAL_SEC, requested),
		enabled: true,
	};
}

function describe(d: Monitor): Record<string, unknown> {
	return {
		id: d.id,
		name: d.name,
		widgets: d.widgets.map((w) => ({ id: w.id, title: w.title, kind: w.kind, viz: w.viz, intervalSec: w.intervalSec, connectionId: w.connectionId, enabled: w.enabled !== false, sql: w.sql })),
	};
}

const WIDGET_PARAMS = {
	title: { type: 'string', description: 'What the user reads above the chart.' },
	sql: { type: 'string', description: 'The query to poll. For a trend it must return a NUMBER (one column), or a label column plus a number column for a grouped series.' },
	kind: { type: 'string', enum: ['trend', 'snapshot'], description: 'trend = sample the number over time and plot the history (polled in the background, even when the view is closed). snapshot = re-run and replace what is drawn, no history. Defaults to trend.' },
	viz: { type: 'string', enum: ['line', 'area', 'bar', 'number', 'table'], description: 'How to draw it. Defaults to line for a trend, table for a snapshot.' },
	intervalSec: { type: 'number', description: `How often to run it, in seconds. Floored at ${MIN_INTERVAL_SEC} so a monitor cannot hammer a production box.` },
	connectionId: { type: 'string', description: 'Which connection to query, by id or label. Defaults to the one the app has selected.' },
};

export const monitorCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'list_monitors',
			description: 'List the user\'s monitors (live, polled SQL widgets, called monitors in this API) and the widgets on each one. Read-only.',
			parameters: { type: 'object', properties: {} },
			domain: 'monitors',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: async (_args, ctx) => {
			const all = await ctx.api.monitors.list();
			return {
				ok: true,
				summary: all.length === 0 ? 'No monitors yet' : `${all.length} monitor${all.length === 1 ? '' : 's'}`,
				data: { monitors: all.map(describe) },
			};
		},
	},
	{
		spec: {
			name: 'open_monitors',
			description: 'Show the Monitors view in the app, so the user can watch what you have built. Only opens the view; it changes nothing.',
			parameters: { type: 'object', properties: {} },
			domain: 'monitors',
			// Opens a view and writes nothing, like new_data_flow. Asking consent to LOOK at something
			// is the kind of prompt that teaches people to click through prompts.
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: (_args, ctx) => {
			ctx.app.openMonitors();
			return { ok: true, summary: 'Opened Monitors' };
		},
	},
	{
		spec: {
			name: 'create_monitor',
			description: 'Create a monitor, optionally with its first widget. A monitor is a named set of queries polled on an interval and plotted; the polling happens in the background, so a trend keeps filling in while the user works elsewhere.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'What the monitor is called.' },
					...WIDGET_PARAMS,
					title: { type: 'string', description: 'Title of the first widget. Omit (with sql) to create an empty monitor.' },
					sql: { type: 'string', description: 'Query for the first widget. Omit (with title) to create an empty monitor.' },
				},
				required: ['name'],
			},
			domain: 'monitors',
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			consentLabel: 'Create a monitor.',
			// An empty monitor queries nothing; a first widget with no connection named is refused
			// in main before anyone is asked.
			connectionWhenAbsent: 'none',
		},
		run: async (args, ctx) => {
			const name = typeof args.name === 'string' ? args.name.trim() : '';
			if (name === '') {
				return { ok: false, summary: '', error: 'Give the monitor a name.' };
			}
			const widgets: MonitorWidget[] = [];
			// A first widget is optional, but if either half of one is given the other is required:
			// silently creating an empty monitor from a half-specified widget hides the mistake.
			const wantsWidget = typeof args.title === 'string' || typeof args.sql === 'string';
			if (wantsWidget) {
				const conn = resolveConnection(ctx, args.connectionId);
				if ('error' in conn) {
					return { ok: false, summary: '', error: conn.error };
				}
				const widget = readWidget(args, conn.id);
				if ('error' in widget) {
					return { ok: false, summary: '', error: widget.error };
				}
				widgets.push(widget);
			}
			const now = Date.now();
			const monitor: Monitor = { id: newId(), name, widgets, createdAt: now, updatedAt: now };
			await ctx.api.monitors.save(monitor);
			ctx.app.openMonitors();
			return {
				ok: true,
				summary: `Created the monitor "${name}"${widgets.length > 0 ? ` with "${widgets[0].title}"` : ''}`,
				data: describe(monitor),
			};
		},
	},
	{
		spec: {
			name: 'add_monitor_widget',
			description: 'Add one polled query to an existing monitor. Name the monitor by id or by its name.',
			parameters: {
				type: 'object',
				properties: {
					monitor: { type: 'string', description: 'The monitor\'s id, or its name.' },
					...WIDGET_PARAMS,
				},
				required: ['monitor', 'title', 'sql'],
			},
			domain: 'monitors',
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			consentLabel: 'Add a widget to one of your monitors.',
		},
		run: async (args, ctx) => {
			const ref = typeof args.monitor === 'string' ? args.monitor : '';
			const all = await ctx.api.monitors.list();
			const target = ref ? pick(all, ref) : undefined;
			if (!target) {
				return { ok: false, summary: '', error: `No monitor matching "${ref}". Use list_monitors to see them.` };
			}
			const conn = resolveConnection(ctx, args.connectionId);
			if ('error' in conn) {
				return { ok: false, summary: '', error: conn.error };
			}
			const widget = readWidget(args, conn.id);
			if ('error' in widget) {
				return { ok: false, summary: '', error: widget.error };
			}
			const updated: Monitor = { ...target, widgets: [...target.widgets, widget], updatedAt: Date.now() };
			await ctx.api.monitors.save(updated);
			ctx.app.openMonitors();
			return { ok: true, summary: `Added "${widget.title}" to "${target.name}"`, data: describe(updated) };
		},
	},
	{
		spec: {
			name: 'remove_monitor_widget',
			description: 'Take one widget off a monitor. The samples already collected for it are dropped with it.',
			parameters: {
				type: 'object',
				properties: {
					monitor: { type: 'string', description: 'The monitor\'s id, or its name.' },
					widget: { type: 'string', description: 'The widget\'s id, or its title.' },
				},
				required: ['monitor', 'widget'],
			},
			domain: 'monitors',
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			consentLabel: 'Remove a widget from one of your monitors.',
		},
		run: async (args, ctx) => {
			const ref = typeof args.monitor === 'string' ? args.monitor : '';
			const widgetRef = typeof args.widget === 'string' ? args.widget.trim().toLowerCase() : '';
			const all = await ctx.api.monitors.list();
			const target = ref ? pick(all, ref) : undefined;
			if (!target) {
				return { ok: false, summary: '', error: `No monitor matching "${ref}".` };
			}
			const widget = target.widgets.find((w) => w.id === args.widget) ?? target.widgets.find((w) => w.title.toLowerCase() === widgetRef);
			if (!widget) {
				return { ok: false, summary: '', error: `"${target.name}" has no widget matching "${args.widget}".` };
			}
			const updated: Monitor = { ...target, widgets: target.widgets.filter((w) => w.id !== widget.id), updatedAt: Date.now() };
			await ctx.api.monitors.save(updated);
			return { ok: true, summary: `Removed "${widget.title}" from "${target.name}"`, data: describe(updated) };
		},
	},
	{
		spec: {
			name: 'delete_monitor',
			description: 'Delete a whole monitor and every sample it has collected. This cannot be undone.',
			parameters: {
				type: 'object',
				properties: { monitor: { type: 'string', description: 'The monitor\'s id, or its name.' } },
				required: ['monitor'],
			},
			domain: 'monitors',
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			destructive: true,
			consentLabel: 'Delete a monitor, and the history it has collected.',
		},
		run: async (args, ctx) => {
			const ref = typeof args.monitor === 'string' ? args.monitor : '';
			const all = await ctx.api.monitors.list();
			const target = ref ? pick(all, ref) : undefined;
			if (!target) {
				return { ok: false, summary: '', error: `No monitor matching "${ref}".` };
			}
			await ctx.api.monitors.remove(target.id);
			return { ok: true, summary: `Deleted the monitor "${target.name}"` };
		},
	},
];

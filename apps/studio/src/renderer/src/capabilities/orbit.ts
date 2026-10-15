/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OrbitGraph, OrbitLink, OrbitNode } from '../../../shared/orbit';
import { buildOrbitGraph, findNode, neighbourhood } from '../../../shared/orbit';
import type { DatabaseSchema, TableInfo } from '../../../shared/schema';
import type { CapabilityContext, CapabilityHandler } from './registry';

/*
 * Snout Orbit for an agent.
 *
 * Orbit is READ-ONLY. It draws a schema the app has already introspected, it never connects and it
 * never reads a row, so there is nothing here to gate behind consent and every tool is
 * `mutates: false`. Asking a person's permission to LOOK at their own schema is the prompt that
 * teaches them to click through prompts.
 *
 * Three constraints shape this, and two of them are not obvious:
 *
 *  - **THE MCP TOOL LIST IS FROZEN AT CONNECT**. So every spec
 *    below is a literal, nothing is read at declaration time, and `orbit_neighbourhood` reads the
 *    SCHEMA rather than the view. "Open Orbit first" can gate what a tool DOES; it can never gate
 *    whether the tool exists, because an agent that connected before the tab was opened would
 *    never see it appear.
 *  - **Navigate and mutate stay separate tools**, so navigation stays separate from focus too:
 *    `open_orbit` shows the tab, `orbit_focus` moves an Orbit that is already open. One tool with
 *    an `open: true` argument would be a tool whose consent story changes with its arguments.
 *  - **`orbit_neighbourhood` is the one that matters**, because it is the only one that helps a
 *    model that cannot see the screen. It answers "what does this table touch" as sentences, not
 *    as a picture and not as a JSON dump: both result renderers (`engine/context/tools.ts` for the
 *    chat, `main/mcpServer.ts` for MCP) print `summary` and then `JSON.stringify(data)`, so `data`
 *    is an array of finished lines and each line reads on its own.
 *
 * How it reaches the view: a module-level bridge, set once by App.tsx, the same shape
 * `lastError.ts` and `notifications.ts` already use in this folder. Not `ctx.app`, because the
 * capability registry's `AppCapabilityBridge` is shared by every module and Orbit does not need to
 * widen it to say two things.
 */

/** What App.tsx hands us so `open_orbit` and `orbit_focus` can reach the Orbit tab. Both take a
 *  SCHEMA-QUALIFIED name (`sales.orders`), already resolved against the live schema here, so the
 *  view never has to guess which `orders` was meant. */
export interface OrbitBridge {
	/** Open (or focus) the one Orbit tab, optionally landing on an object. */
	openOrbit(table?: string): void;
	/** Focus an object in an already-open Orbit and isolate its neighbourhood. `false` when Orbit
	 *  cannot act on it yet (no graph built, or it does not know that name). */
	focusOrbit(table: string): boolean;
}

let bridge: OrbitBridge | undefined;

/** Wire the Orbit tab up (App.tsx, once). Pass `undefined` to unwire it. */
export function setOrbitBridge(next: OrbitBridge | undefined): void {
	bridge = next;
}

/** The connection to draw: the one named, else the app's active one. Orbit needs an introspected
 *  schema, so a disconnected connection is refused HERE with the fix rather than downstream with a
 *  null. */
function resolveConnection(ctx: CapabilityContext, ref: unknown): { id: string; label: string } | { error: string } {
	const snapshot = ctx.snapshot();
	if (typeof ref === 'string' && ref.trim() !== '') {
		const needle = ref.trim().toLowerCase();
		const match = snapshot.connections.find((c) => c.id === ref)
			?? snapshot.connections.find((c) => c.label.toLowerCase() === needle);
		if (!match) {
			return { error: `No connection called "${ref}". Use list_connections to see them.` };
		}
		if (!match.connected) {
			return { error: `"${match.label}" is not connected, so there is no schema to map. Connect it first.` };
		}
		return { id: match.id, label: match.label };
	}
	if (!snapshot.activeConnectionId) {
		return { error: 'No connection is selected, so there is no schema to map. Name one with connectionId.' };
	}
	const active = snapshot.connections.find((c) => c.id === snapshot.activeConnectionId);
	if (active && !active.connected) {
		return { error: `"${active.label}" is not connected, so there is no schema to map. Connect it first.` };
	}
	return { id: snapshot.activeConnectionId, label: active?.label ?? snapshot.activeConnectionId };
}

interface Resolved {
	graph: OrbitGraph;
	schema: DatabaseSchema;
	connection: { id: string; label: string };
}

/** Fetch the connection's schema and build the same graph Orbit draws. Every tool here starts
 *  from this, so the text answer and the picture can never disagree about what a node is. */
async function resolveGraph(ctx: CapabilityContext, ref: unknown): Promise<Resolved | { error: string }> {
	const connection = resolveConnection(ctx, ref);
	if ('error' in connection) {
		return { error: connection.error };
	}
	const schema = await ctx.api.getSchema(connection.id);
	if (!schema) {
		return { error: `"${connection.label}" has not been introspected yet. Call list_tables against it first.` };
	}
	return { graph: buildOrbitGraph(schema), schema, connection };
}

/** Up to five objects whose name looks like what was asked for, so a refusal names a way forward
 *  instead of just saying no. Same intent as `pick()` in monitors.ts: a model using the name it
 *  saw a moment ago should not be met with pedantry. */
function nearMatches(graph: OrbitGraph, reference: string): string[] {
	const needle = reference.trim().toLowerCase();
	const bare = needle.includes('.') ? needle.slice(needle.lastIndexOf('.') + 1) : needle;
	const scored = graph.nodes
		.filter((n) => n.kind !== 'index')
		.filter((n) => n.name.toLowerCase().includes(bare) || bare.includes(n.name.toLowerCase()));
	return scored.slice(0, 5).map(qualified);
}

/** Resolve a name to a node, or an error that says what to try instead. */
function pickNode(graph: OrbitGraph, reference: string): OrbitNode | { error: string } {
	const id = findNode(graph, reference);
	if (id >= 0) {
		return graph.nodes[id];
	}
	const near = nearMatches(graph, reference);
	if (near.length > 0) {
		return { error: `No object called "${reference}". Did you mean ${near.join(', ')}?` };
	}
	return { error: `No object called "${reference}". Use list_tables to see what this database has.` };
}

function qualified(node: OrbitNode): string {
	return `${node.schema}.${node.name}`;
}

/** Thousands separators without a locale, so a test and a user's machine agree. */
function count(n: number): string {
	return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function columnList(columns: string[] | undefined): string {
	return `(${(columns ?? []).join(', ')})`;
}

/** The TableInfo behind a node, when there is one. The graph deliberately carries only a COLUMN
 *  COUNT for an index (it is drawing dots, not documenting), so index key columns come from here. */
function tableFor(schema: DatabaseSchema, node: OrbitNode): TableInfo | undefined {
	// The cluster name is the table's schema, or the database name when the driver reports none
	// (SQLite, DuckDB); match the same way buildOrbitGraph did or a node would find no table.
	return schema.tables.find((t) => t.name === node.name && (t.schema && t.schema !== '' ? t.schema : schema.database) === node.schema);
}

function fkOut(graph: OrbitGraph, node: OrbitNode): OrbitLink[] {
	return node.links.map((id) => graph.links[id]).filter((l) => l.kind === 'fk' && l.a === node.id);
}

function fkIn(graph: OrbitGraph, node: OrbitNode): OrbitLink[] {
	return node.links.map((id) => graph.links[id]).filter((l) => l.kind === 'fk' && l.b === node.id);
}

/**
 * What this object touches, as lines a model can read out loud.
 *
 * Absences are stated, never omitted: "no foreign keys point at this table" is an ANSWER, and a
 * section that silently disappears reads as a section the tool forgot to fill in.
 */
export function renderNeighbourhood(graph: OrbitGraph, node: OrbitNode, table?: TableInfo): string[] {
	const lines: string[] = [];
	const facts = [`${node.columns} column${node.columns === 1 ? '' : 's'}`];
	if (node.rows !== undefined) {
		facts.push(`about ${count(node.rows)} rows`);
	}
	lines.push(`${qualified(node)} is a ${node.kind} in schema "${node.schema}", ${facts.join(', ')}.`);
	if (node.parent !== undefined) {
		lines.push(`It belongs to ${qualified(graph.nodes[node.parent])}.`);
	}
	if (table && table.primaryKey.length > 0) {
		lines.push(`Primary key: ${table.primaryKey.join(', ')}.`);
	}

	const out = fkOut(graph, node);
	if (out.length === 0) {
		lines.push('Foreign keys out: none. This object references no other table.');
	} else {
		lines.push(`Foreign keys out (${out.length}), what it references:`);
		for (const link of out) {
			const target = graph.nodes[link.b];
			lines.push(`  ${link.name}: ${columnList(link.columns)} references ${qualified(target)} ${columnList(link.referencedColumns)}${link.crossSchema ? ' [crosses schemas]' : ''}`);
		}
	}

	const incoming = fkIn(graph, node);
	if (incoming.length === 0) {
		lines.push('Foreign keys in: none. Nothing references this object.');
	} else {
		lines.push(`Foreign keys in (${incoming.length}), what references it:`);
		for (const link of incoming) {
			const source = graph.nodes[link.a];
			lines.push(`  ${link.name}: ${qualified(source)} ${columnList(link.columns)} references ${columnList(link.referencedColumns)}${link.crossSchema ? ' [crosses schemas]' : ''}`);
		}
	}

	// Real key columns where the schema has them; the graph's index nodes carry a count only.
	const indexes = table?.indexes ?? [];
	if (indexes.length === 0) {
		const drawn = node.links.map((id) => graph.links[id]).filter((l) => l.kind === 'index' && l.a === node.id);
		if (drawn.length === 0) {
			lines.push('Indexes: none besides the primary key.');
		} else {
			lines.push(`Indexes (${drawn.length}): ${drawn.map((l) => l.name).join(', ')}`);
		}
	} else {
		lines.push(`Indexes (${indexes.length}):`);
		for (const index of indexes) {
			lines.push(`  ${index.name} ${columnList(index.columns)}${index.unique ? ' unique' : ''}`);
		}
	}

	// The same set Orbit isolates when you click the star, so the text and the picture agree.
	const hop = [...neighbourhood(graph, node.id, 1)]
		.filter((id) => id !== node.id)
		.map((id) => graph.nodes[id])
		.filter((n) => n.kind !== 'index');
	lines.push(hop.length === 0
		? 'One hop away: nothing. This object stands alone in the graph.'
		: `One hop away (${hop.length}): ${hop.map(qualified).join(', ')}`);
	const crossing = [...out, ...incoming].filter((l) => l.crossSchema).length;
	if (crossing > 0) {
		lines.push(`${crossing} of its ${out.length + incoming.length} foreign keys cross a schema boundary.`);
	}
	return lines;
}

export const orbitCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'open_orbit',
			title: 'Open Orbit',
			description: 'Show Snout Orbit: the connected database drawn in 3D, every table a star and every relationship a filament, clustered by schema. Optionally open it already focused on one object. It draws a schema the app has already introspected and writes nothing. To READ what a table touches without looking at the screen, call orbit_neighbourhood instead.',
			parameters: {
				type: 'object',
				properties: {
					table: { type: 'string', description: 'Optional object to land on, as "schema.table" or a bare table name.' },
					connectionId: { type: 'string', description: 'Which connection to map, by id or label. Defaults to the one the app has selected.' },
				},
			},
			domain: 'orbit',
			// Opens a view over a schema already in memory. Nothing is written, nothing is queried,
			// and nothing needs undoing, so this is the same call as open_monitors.
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'schema',
		},
		run: async (args, ctx) => {
			if (!bridge) {
				return { ok: false, summary: '', error: 'Orbit is not wired up in this window yet. Try again once the app has finished starting.' };
			}
			const wanted = typeof args.table === 'string' ? args.table.trim() : '';
			if (wanted === '') {
				bridge.openOrbit();
				return { ok: true, summary: 'Opened Orbit' };
			}
			// A name was given, so it is resolved BEFORE the tab opens: an Orbit that opens on
			// nothing because the model guessed a table name is worse than a refusal that names the
			// tables that do exist.
			const resolved = await resolveGraph(ctx, args.connectionId);
			if ('error' in resolved) {
				return { ok: false, summary: '', error: resolved.error };
			}
			const node = pickNode(resolved.graph, wanted);
			if ('error' in node) {
				return { ok: false, summary: '', error: node.error };
			}
			bridge.openOrbit(qualified(node));
			return { ok: true, summary: `Opened Orbit on ${qualified(node)}` };
		},
	},
	{
		spec: {
			name: 'orbit_focus',
			title: 'Focus an object in Orbit',
			description: 'Focus one object in an Orbit tab that is already open: the camera flies to it and its neighbourhood is isolated so only what it touches stays lit. Call open_orbit first. This moves the view only; it changes no data.',
			parameters: {
				type: 'object',
				properties: {
					table: { type: 'string', description: 'The object to focus, as "schema.table" or a bare table name.' },
					connectionId: { type: 'string', description: 'Which connection the object belongs to, by id or label. Defaults to the one the app has selected.' },
				},
				required: ['table'],
			},
			domain: 'orbit',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'schema',
		},
		run: async (args, ctx) => {
			const wanted = typeof args.table === 'string' ? args.table.trim() : '';
			if (wanted === '') {
				return { ok: false, summary: '', error: 'Name the object to focus, as "schema.table" or a bare table name.' };
			}
			// The snapshot is the honest test of whether there is anything to move: a bridge left
			// wired by a closed tab would happily report success at nobody.
			if (!ctx.snapshot().tabs.some((t) => t.kind === 'orbit')) {
				return { ok: false, summary: '', error: 'Orbit is not open. Call open_orbit first.' };
			}
			if (!bridge) {
				return { ok: false, summary: '', error: 'Orbit is not wired up in this window yet. Try again once the app has finished starting.' };
			}
			const resolved = await resolveGraph(ctx, args.connectionId);
			if ('error' in resolved) {
				return { ok: false, summary: '', error: resolved.error };
			}
			const node = pickNode(resolved.graph, wanted);
			if ('error' in node) {
				return { ok: false, summary: '', error: node.error };
			}
			if (!bridge.focusOrbit(qualified(node))) {
				return { ok: false, summary: '', error: `Orbit is open but cannot focus ${qualified(node)} yet: it is still laying the graph out, or it is showing a different connection. Call open_orbit with this table instead.` };
			}
			return { ok: true, summary: `Focused ${qualified(node)} in Orbit`, data: { focused: qualified(node), kind: node.kind, degree: node.degree } };
		},
	},
	{
		spec: {
			name: 'orbit_neighbourhood',
			title: 'Read what a table touches',
			description: 'Read what one object touches, in words: its columns and row estimate, the foreign keys out of it (constraint name, columns, referenced table), the foreign keys into it, its indexes, which of those relations cross a schema boundary, and everything one hop away. This is Orbit\'s answer for a caller who cannot see the screen, so it works whether or not the Orbit tab is open. Read-only: it reads the schema the app has already introspected and queries nothing.',
			parameters: {
				type: 'object',
				properties: {
					table: { type: 'string', description: 'The object to describe, as "schema.table" or a bare table name.' },
					connectionId: { type: 'string', description: 'Which connection the object belongs to, by id or label. Defaults to the one the app has selected.' },
				},
				required: ['table'],
			},
			domain: 'orbit',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'schema',
		},
		run: async (args, ctx) => {
			const wanted = typeof args.table === 'string' ? args.table.trim() : '';
			if (wanted === '') {
				return { ok: false, summary: '', error: 'Name the object to describe, as "schema.table" or a bare table name.' };
			}
			const resolved = await resolveGraph(ctx, args.connectionId);
			if ('error' in resolved) {
				return { ok: false, summary: '', error: resolved.error };
			}
			const node = pickNode(resolved.graph, wanted);
			if ('error' in node) {
				return { ok: false, summary: '', error: node.error };
			}
			const lines = renderNeighbourhood(resolved.graph, node, tableFor(resolved.schema, node));
			const relations = fkOut(resolved.graph, node).length + fkIn(resolved.graph, node).length;
			return {
				ok: true,
				summary: `${qualified(node)}: ${relations} foreign key${relations === 1 ? '' : 's'}`,
				data: lines,
			};
		},
	},
];

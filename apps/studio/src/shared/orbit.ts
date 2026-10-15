/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Snout Orbit's graph model.
 *
 * Turns a `DatabaseSchema` the app has already introspected into the nodes and links Orbit draws.
 * Pure: no Electron, no DOM, no three.js, so it is unit-tested in the normal `npm test` tier and
 * the renderer, main and a test all agree on what a "node" is.
 *
 * Deliberately NOT in `src/shared/engine/`: the engine is the layer every query and every prompt
 * passes through, and a picture of a schema is neither. Orbit CONSUMES the engine (statement ->
 * tables, for Pulse) and never joins it.
 *
 * Two shapes here are load-bearing for the renderer:
 *
 *  - `nodes[i].id === i` and `links[i].id === i`. Every buffer the scene builds is indexed by
 *    position, so an id that is not an index would mean a lookup per node per frame.
 *  - `clusters` is the SCHEMA list, and `node.cluster` indexes it. The layout puts each cluster
 *    somewhere of its own; that is what turns a hairball into eight places.
 */

import type { DatabaseSchema, TableInfo } from './schema';

export type OrbitNodeKind = 'table' | 'view' | 'collection' | 'index' | 'routine';

export interface OrbitNode {
	/** Index into `OrbitGraph.nodes`. */
	id: number;
	name: string;
	schema: string;
	kind: OrbitNodeKind;
	/** Index into `OrbitGraph.clusters`. */
	cluster: number;
	/** Column count (parameters, for a routine; key columns, for an index). */
	columns: number;
	/** Approximate rows, where the driver's catalog stats reported any. */
	rows?: number;
	/** The table an index, view or routine hangs off, when it is derived from one. */
	parent?: number;
	/** Every link touching this node. */
	links: number[];
	degree: number;
	/** Foreign keys only, which is what "how connected is this table" actually means. */
	fkDegree: number;
}

export type OrbitLinkKind = 'fk' | 'index' | 'depends';

export interface OrbitLink {
	/** Index into `OrbitGraph.links`. */
	id: number;
	/** Node ids. For an `fk` this direction is REFERENCING -> REFERENCED. */
	a: number;
	b: number;
	kind: OrbitLinkKind;
	/** The constraint's real name for an `fk`; the object's own name otherwise. */
	name: string;
	/** FK only: the referencing columns, in key order. */
	columns?: string[];
	/** FK only: the referenced columns. */
	referencedColumns?: string[];
	crossSchema: boolean;
}

export interface OrbitCluster {
	/** Schema name, or the database name when a driver reports no schema. */
	name: string;
	/** How many nodes belong to it, which is how the layout sizes its region. */
	size: number;
}

export interface OrbitGraph {
	nodes: OrbitNode[];
	links: OrbitLink[];
	clusters: OrbitCluster[];
	/** `schema.name` (lowercased) -> node id, for tables and views only. Pulse maps a statement's
	 *  table list through this, so it is a Map rather than a scan per packet. */
	byName: Map<string, number>;
}

export interface BuildOrbitOptions {
	/** Draw each table's secondary indexes as their own small nodes. Default true. */
	includeIndexes?: boolean;
	/** Draw stored procedures and functions. Default true. */
	includeRoutines?: boolean;
	/** Fallback cluster name for drivers that report no schema per table (SQLite, DuckDB). */
	defaultSchema?: string;
}

function clusterKey(table: { schema?: string }, fallback: string): string {
	return table.schema && table.schema !== '' ? table.schema : fallback;
}

function nodeKind(table: TableInfo): OrbitNodeKind {
	if (table.kind === 'view') {
		return 'view';
	}
	if (table.kind === 'collection') {
		return 'collection';
	}
	return 'table';
}

/**
 * The graph a schema implies.
 *
 * `logGroup` pseudo-tables are skipped: a cloud log scope has no relationships and
 * would sit in the void as an unconnected dot pretending to be a table.
 */
export function buildOrbitGraph(schema: DatabaseSchema, options: BuildOrbitOptions = {}): OrbitGraph {
	const includeIndexes = options.includeIndexes !== false;
	const includeRoutines = options.includeRoutines !== false;
	const fallback = options.defaultSchema ?? schema.database ?? 'main';

	const nodes: OrbitNode[] = [];
	const links: OrbitLink[] = [];
	const clusters: OrbitCluster[] = [];
	const clusterIndex = new Map<string, number>();
	const byName = new Map<string, number>();

	function cluster(name: string): number {
		const existing = clusterIndex.get(name);
		if (existing !== undefined) {
			return existing;
		}
		const id = clusters.length;
		clusters.push({ name, size: 0 });
		clusterIndex.set(name, id);
		return id;
	}

	function addNode(node: Omit<OrbitNode, 'id' | 'links' | 'degree' | 'fkDegree'>): OrbitNode {
		const created: OrbitNode = { ...node, id: nodes.length, links: [], degree: 0, fkDegree: 0 };
		nodes.push(created);
		clusters[created.cluster].size += 1;
		return created;
	}

	function addLink(a: number, b: number, kind: OrbitLinkKind, name: string): OrbitLink {
		const link: OrbitLink = {
			id: links.length,
			a,
			b,
			kind,
			name,
			crossSchema: nodes[a].cluster !== nodes[b].cluster,
		};
		links.push(link);
		for (const side of [a, b]) {
			nodes[side].links.push(link.id);
			nodes[side].degree += 1;
			if (kind === 'fk') {
				nodes[side].fkDegree += 1;
			}
		}
		return link;
	}

	// Pass one: every table and view becomes a node, so a foreign key in pass two can always
	// resolve both ends.
	const tables = schema.tables.filter((t) => t.kind !== 'logGroup' && t.kind !== 'index');
	for (const table of tables) {
		const schemaName = clusterKey(table, fallback);
		const node = addNode({
			name: table.name,
			schema: schemaName,
			kind: nodeKind(table),
			cluster: cluster(schemaName),
			columns: table.columns.length,
			rows: table.stats?.rowCount,
		});
		byName.set(`${schemaName}.${table.name}`.toLowerCase(), node.id);
		// A driver that reports no schema still lets the user say "orders".
		if (!byName.has(table.name.toLowerCase())) {
			byName.set(table.name.toLowerCase(), node.id);
		}
	}

	// Pass two: relationships, then the small objects that hang off a table.
	tables.forEach((table, position) => {
		const owner = nodes[position];
		for (const fk of table.foreignKeys) {
			const target = resolveTable(byName, fk.referencedTable, owner.schema);
			if (target === undefined || target === owner.id) {
				continue;
			}
			const link = addLink(owner.id, target, 'fk', fk.constraintName || `${table.name}_fkey`);
			link.columns = fk.columns;
			link.referencedColumns = fk.referencedColumns;
		}

		if (includeIndexes) {
			for (const index of table.indexes ?? []) {
				const node = addNode({
					name: index.name,
					schema: owner.schema,
					kind: 'index',
					cluster: owner.cluster,
					columns: index.columns.length,
					rows: owner.rows,
					parent: owner.id,
				});
				addLink(owner.id, node.id, 'index', index.name);
			}
		}
	});

	if (includeRoutines) {
		for (const routine of schema.routines ?? []) {
			const schemaName = routine.schema && routine.schema !== '' ? routine.schema : fallback;
			const node = addNode({
				name: routine.name,
				schema: schemaName,
				kind: 'routine',
				cluster: cluster(schemaName),
				columns: routine.parameters?.length ?? 0,
			});
			// A routine is drawn beside its schema rather than wired to a guessed table: which
			// tables a procedure body touches is a parsing question, and guessing it wrong would
			// draw a relationship that does not exist.
			void node;
		}
	}

	return { nodes, links, clusters, byName };
}

/** `referencedTable` may be bare or schema-qualified; a bare name means the referencing schema. */
function resolveTable(byName: Map<string, number>, reference: string, schemaName: string): number | undefined {
	const raw = reference.trim().toLowerCase();
	if (raw === '') {
		return undefined;
	}
	return byName.get(raw.includes('.') ? raw : `${schemaName.toLowerCase()}.${raw}`) ?? byName.get(raw);
}

/** Node ids within `hops` foreign keys of `id`, plus everything hanging off those tables. */
export function neighbourhood(graph: OrbitGraph, id: number, hops = 1): Set<number> {
	const seen = new Set<number>([id]);
	let frontier = [id];
	for (let hop = 0; hop < hops; hop++) {
		const next: number[] = [];
		for (const current of frontier) {
			for (const linkId of graph.nodes[current].links) {
				const link = graph.links[linkId];
				const other = link.a === current ? link.b : link.a;
				if (!seen.has(other)) {
					seen.add(other);
					next.push(other);
				}
			}
		}
		frontier = next;
	}
	// One more step for the small objects, so an isolated table shows its own indexes even when
	// the hop budget was spent on foreign keys.
	for (const current of [...seen]) {
		for (const linkId of graph.nodes[current].links) {
			const link = graph.links[linkId];
			if (link.kind !== 'fk') {
				seen.add(link.a === current ? link.b : link.a);
			}
		}
	}
	return seen;
}

/** Find a node by `schema.table` or a bare table name. -1 when there is no such object. */
export function findNode(graph: OrbitGraph, reference: string): number {
	return graph.byName.get(reference.trim().toLowerCase()) ?? -1;
}

/**
 * Tables, views and collections whose name CONTAINS `query`, ranked for a picker.
 *
 * A substring match everywhere, deliberately: `us` finds `users`, `status` and `bus_stop`, which
 * is what a wildcard on both sides means and what someone hunting a half-remembered name needs.
 * A prefix match would be tidier and would find one of those three.
 *
 * `schema.name` is matched as well as the bare name, so `public.or` narrows to one schema on a
 * database that has several. Indexes and routines are left out: there are more of them than
 * anything else and none of them is what "find a table" means.
 *
 * Ranking is name-first and then connectedness — a name that STARTS with the query, then one whose
 * word starts with it, then anything else, and within each the more connected object first, so the
 * table the query is really about is not below its own audit log.
 */
export function searchNodes(graph: OrbitGraph, query: string, limit = 40): number[] {
	const needle = query.trim().toLowerCase();
	if (needle === '') {
		return [];
	}
	const scored: Array<{ id: number; rank: number; node: OrbitNode }> = [];
	for (const node of graph.nodes) {
		if (node.kind === 'index' || node.kind === 'routine') {
			continue;
		}
		const name = node.name.toLowerCase();
		const qualified = `${node.schema.toLowerCase()}.${name}`;
		const at = name.indexOf(needle);
		const rank = at === 0 ? 0
			: at > 0 && !/[a-z0-9]/.test(name[at - 1]) ? 1
				: at > 0 ? 2
					: qualified.includes(needle) ? 3
						: -1;
		if (rank >= 0) {
			scored.push({ id: node.id, rank, node });
		}
	}
	scored.sort((a, b) => a.rank - b.rank
		|| b.node.fkDegree - a.node.fkDegree
		|| b.node.degree - a.node.degree
		|| a.node.name.localeCompare(b.node.name));
	return scored.slice(0, limit).map((entry) => entry.id);
}

/** Tables and views ranked by how connected they are: what gets a label when nothing is focused. */
export function hubs(graph: OrbitGraph, count: number): number[] {
	return graph.nodes
		.filter((n) => n.kind === 'table' || n.kind === 'view' || n.kind === 'collection')
		.sort((a, b) => b.fkDegree - a.fkDegree || b.degree - a.degree)
		.slice(0, count)
		.map((n) => n.id);
}

/**
 * Which objects in this graph a statement touched (for Pulse).
 *
 * Deliberately LEXICAL, and deliberately matched against the graph rather than parsed out of the
 * SQL: it tokenises identifiers and keeps the ones that name an object this database actually has.
 * That gets the direction of the error right. A SQL grammar can invent a table from a typo or
 * choke on a dialect it has not met; a match against `byName` can only ever be too generous, and
 * the cost of being too generous here is that a table named in a comment glows for a second.
 *
 * This lights pixels. Nothing decides anything from it, and nothing is written from it.
 */
export function statementTargets(graph: OrbitGraph, sql: string): number[] {
	const found: number[] = [];
	const seen = new Set<number>();
	// Identifiers, optionally schema-qualified, with quoting stripped: `"public"."users"`,
	// `[dbo].[Orders]`, `` `billing`.`invoices` `` and plain `users` all reduce to the same key.
	const pattern = /[A-Za-z_][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*)?/g;
	const cleaned = sql.replace(/["`\[\]]/g, '');
	for (const match of cleaned.matchAll(pattern)) {
		const key = match[0].replace(/\s+/g, '').toLowerCase();
		const id = graph.byName.get(key);
		if (id !== undefined && !seen.has(id)) {
			seen.add(id);
			found.push(id);
		}
	}
	return found;
}

/**
 * A route between the objects a statement touched, as relations to send packets down.
 *
 * Consecutive targets joined by a foreign key travel that relation; a pair with no relation
 * between them is simply not drawn, because inventing an edge to animate would be drawing a
 * join that does not exist.
 */
export function statementPath(graph: OrbitGraph, targets: number[]): Array<{ link: number; from: number }> {
	const path: Array<{ link: number; from: number }> = [];
	for (let i = 0; i + 1 < targets.length; i++) {
		const from = targets[i];
		const to = targets[i + 1];
		const linkId = graph.nodes[from].links.find((id) => {
			const link = graph.links[id];
			return link.kind === 'fk' && (link.a === to || link.b === to);
		});
		if (linkId !== undefined) {
			path.push({ link: linkId, from });
		}
	}
	return path;
}

/**
 * A statement the app just ran, handed to Orbit so Pulse can light the path it took.
 * Lives here rather than in the view so `App.tsx` can hold one without importing anything
 * that pulls in three.js.
 */
export interface OrbitStatement {
	sql: string;
	connectionId: string;
	durationMs?: number;
	/** Epoch ms, and the value's identity: re-running the same SQL must still fire. */
	at: number;
}

/**
 * A statement, shortened to the part that says what it did.
 *
 * The Pulse feed used to list the TABLE NAMES a statement touched, which on a real database reads
 * as forty consecutive lines of `shop_prod.orders`: true, and useless, because the stars already
 * light up to say the same thing. The statement itself is the part that is not on the canvas.
 *
 * The select list is what has to go. It can be a hundred columns long, it pushes the table names
 * off the end of a 300px panel, and it is the one part of a query that says nothing about which
 * objects were read. Everything after FROM survives. Nothing else is truncated here: the feed's
 * own CSS ellipsis knows how much room there is and this does not.
 */
export function condenseStatement(sql: string): string {
	const flat = sql.replace(/\s+/g, ' ').trim();
	const select = /^select\b[\s\S]*?\sfrom\b/i.exec(flat);
	if (!select) {
		return flat;
	}
	return `SELECT ... FROM${flat.slice(select[0].length)}`;
}

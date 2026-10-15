/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolSpec } from './ai';

/**
 * The capability bridge: a generic seam that lets any renderer-side module expose named
 * actions and state-readers to the AI agent. Each {@link CapabilitySpec} a module registers
 * (in the renderer's capability registry) becomes an agent tool; when the model calls it,
 * the agent loop in main round-trips the call back to the renderer to run it. This is how the
 * chat drives the whole app (connections, table design, settings, the editor, logs), not just
 * the SQL it proposes. The DB tools in `src/main/ai/tools.ts` are the main-local counterpart.
 */

/** A renderer-side action or state-reader the agent can call. Projected to a {@link ToolSpec}. */
export interface CapabilitySpec {
	/** The tool name the model calls. Must be unique and must not collide with a built-in DB
	 *  tool (the registry rejects reserved names). */
	name: string;
	description: string;
	/** JSON Schema (an object schema) for the arguments — the same shape as ToolSpec.parameters. */
	parameters: Record<string, unknown>;
	/** Grouping for prompts/UI only, e.g. 'connections', 'editor'. */
	domain: string;
	/** true ⇒ the agent must get the user's approval ("the assistant wants to <summary>")
	 *  before it runs; false ⇒ read-only, runs with no prompt. */
	mutates: boolean;
	/**
	 * One short sentence for the CONSENT card, addressed to the user rather than the model.
	 * `description` is written for a model and often carries instructions to it ("do NOT use this
	 * to..."), which reads as noise on a card someone has to answer in a hurry. Optional: absent,
	 * the card falls back to the first sentence of `description`. Worth setting on anything that
	 * mutates.
	 */
	consentLabel?: string;
	/**
	 * A human title for the lists a PERSON reads, when the one derived from `name` reads badly.
	 * `open_connection_form` needs nothing (it derives to "Open connection form"); `run_current`
	 * does, because "Run current" is not a thing. See {@link capabilityTitle}.
	 */
	title?: string;
	/**
	 * Destructive or security-relevant: the user is asked about EVERY call, "Always allow this" is
	 * never offered, and a standing approval stored before this flag existed is ignored. Deleting a
	 * project, switching a product off, changing a setting: a yes to one of these must be a yes to
	 * the call in front of the person, never to the next forty. See {@link asksEveryTime}.
	 */
	destructive?: boolean;
	/**
	 * The argument that names a saved connection (by id or label), on a capability that reads
	 * from, acts on or reports about one. An external agent may only name a connection the user
	 * exposed to agents (Settings, Agent access): main resolves it, refuses one that is not
	 * exposed, and hands the capability the connection's id. An argument called `connectionId` or
	 * `connection` counts as this even when the spec does not say so ({@link capabilityConnectionArg}).
	 * Left out when optional, the capability would use the app's selected connection, so an agent
	 * must name one, unless {@link connectionWhenAbsent} says otherwise.
	 */
	connectionArg?: string;
	/**
	 * What the capability does when its optional connection argument is left out: `'selected'` (the
	 * default) uses the app's selected connection, so an agent is refused; `'none'` touches no
	 * connection at all (an empty monitor), so the call goes on.
	 */
	connectionWhenAbsent?: 'selected' | 'none';
	/**
	 * The connection the capability acts on or reads from WITHOUT the call naming it, so an external
	 * agent is held to the per-connection allowlist for it just as for {@link connectionArg}. Main
	 * asks the app which connection that is before anything runs, refuses one not exposed to agents,
	 * and the app refuses the call if the answer has changed by the time it runs. Required, so a new
	 * capability cannot leave the question unanswered. See {@link ImplicitConnection}.
	 */
	implicitConnection: ImplicitConnection;
	/**
	 * What the capability hands back that came out of a database, in its data, its summary or its
	 * errors. Anything but `'none'` goes to an external agent only from connections exposed to it, and
	 * values are held to the data-access level. Required, for the same reason. See {@link CapabilityData}.
	 */
	returnsData: CapabilityData;
}

/**
 * Where a capability's connection comes from when the call does not name one:
 *
 * - `none`: it touches no connection beyond the one {@link CapabilitySpec.connectionArg} names.
 * - `activeTab`: the active editor tab's connection (what Run would run on).
 * - `result`: the connection that produced the result grid on screen.
 * - `lastError`: the connection the most recent error came from.
 * - `target`: the connections of the thing the call names (a flow's source and destination, a
 *   cloud project's saved connection, the open wizard's source), which the capability's own
 *   handler resolves.
 * - `perItem`: a list whose entries each carry their own connection (the log lines); checked
 *   entry by entry on the way out, nothing to check before.
 */
export type ImplicitConnection = 'none' | 'activeTab' | 'result' | 'lastError' | 'target' | 'perItem';

/**
 * What a capability returns from a database: `'none'` (nothing; app state and the user's own files
 * and configuration count as nothing), `'schema'` (names: tables, columns, users, grants), or
 * `'values'` (rows, counts over rows, or a database's own error text, which can quote values).
 */
export type CapabilityData = 'none' | 'schema' | 'values';

export const IMPLICIT_CONNECTIONS: readonly ImplicitConnection[] = ['none', 'activeTab', 'result', 'lastError', 'target', 'perItem'];
export const CAPABILITY_DATA: readonly CapabilityData[] = ['none', 'schema', 'values'];

/** Argument names that always name a connection, declared or not. */
const CONNECTION_ARG_NAMES: readonly string[] = ['connectionId', 'connection'];

/** The argument of `spec` that names a saved connection, if it has one. */
export function capabilityConnectionArg(spec: Pick<CapabilitySpec, 'connectionArg' | 'parameters'>): string | undefined {
	if (spec.connectionArg) {
		return spec.connectionArg;
	}
	const properties = (spec.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
	return CONNECTION_ARG_NAMES.find((name) => Object.prototype.hasOwnProperty.call(properties, name));
}

/**
 * Capabilities that are asked about every time whatever their spec says, so a renderer that forgot
 * the flag (or a published list from an older build) cannot make one of them standing-approvable.
 */
const ALWAYS_ASK: ReadonlySet<string> = new Set([
	'delete_cloud_project',
	'set_cloud_product',
	'stop_cloud_project',
	'remove_cloud_secret',
	'reset_cloud_password',
	'export_cloud_project',
	'set_setting',
	'create_tunnel',
	'edit_tunnel',
	'delete_tunnel',
	'delete_monitor',
	// A query the app then runs by itself every interval, on the connection the card names.
	'create_monitor',
	'add_monitor_widget',
	// A destination a model chose: a hostname is a DNS lookup and a password a login attempt.
	'test_connection_settings',
	// They run statements on a database, writes included: whatever is in the editor, or whatever a
	// saved flow does to its destination. A yes is for the run in front of the person, never the next.
	'run_current',
	'run_data_flow',
]);

/** Is every call of this capability asked about, with no "Always allow"? */
export function asksEveryTime(spec: Pick<CapabilitySpec, 'name' | 'domain' | 'destructive'>): boolean {
	return spec.destructive === true || ALWAYS_ASK.has(spec.name) || spec.domain === 'settings';
}

/** Is this capability asked about every time whatever its published spec says? For a store that
 *  only has the name: a standing yes for one of these is never kept. */
export function alwaysAsksByName(name: string): boolean {
	return ALWAYS_ASK.has(name);
}

/** Main → renderer: run this capability. `id` is the originating ToolCall.id. */
export interface CapabilityInvocation {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/**
	 * Who asked, as an external agent named itself on connect (e.g. "claude-code"). Absent when the
	 * app's own assistant is the caller. A capability that has to act on the RIGHT agent's surface
	 * needs this: the renderer cannot otherwise tell one MCP client from another.
	 */
	client?: string;
	/**
	 * Do not run it: answer which connections it would act on ({@link CapabilitySpec.implicitConnection}),
	 * in {@link CapabilityResult.connectionIds}. Main asks this before an external agent's call, so a
	 * connection not exposed to agents is refused before anyone is asked or anything runs.
	 */
	resolveConnections?: boolean;
	/**
	 * The connections main checked for this call. The app re-resolves them just before it runs and
	 * refuses the call if they differ (the user switched tabs while the card was open), so what runs
	 * is what was checked.
	 */
	expectConnections?: string[];
}

/**
 * Renderer → main: the outcome of one invocation. `summary` is a one-line human description
 * (it labels the tool step and leads the result the model reads); `data` is an optional
 * structured payload for read capabilities. Everything here crosses an IPC boundary, so
 * `data` MUST be structured-clone-safe (plain objects/arrays/primitives — no functions,
 * class instances, or DOM nodes).
 */
export interface CapabilityResult {
	ok: boolean;
	summary: string;
	data?: unknown;
	error?: string;
	/**
	 * The call was REFUSED (the user declined it, or policy would not allow it) rather than
	 * attempted and failed. The agent log shows the two differently: a refusal is the system
	 * working, an error is something going wrong, and folding them together makes a timeline full
	 * of red that means nothing.
	 */
	refused?: boolean;
	/** The connection whose database VALUES this result carries, when it carries any (the result
	 *  grid's rows). Main checks that connection's data-access level before a model sees it. */
	dataConnectionId?: string;
	/** The connections the call acts on, as the app resolved them (the answer to
	 *  {@link CapabilityInvocation.resolveConnections}, and attached to every result of a capability
	 *  with an implicit connection). */
	connectionIds?: string[];
	/** `error` is a database's own message (it can quote values), not a sentence the app wrote, so
	 *  below the data-access level it is reduced to its class and code. */
	errorFromDatabase?: boolean;
}

/** Main → renderer IPC payload: a request to run a capability during a chat turn. */
export interface AiCapabilityRequest {
	requestId: string;
	invocation: CapabilityInvocation;
}

/**
 * Built-in tool names a capability may not shadow (see `src/main/ai/tools.ts`, and the MCP
 * server's own TOOLS). A name in both places is not an error anyone sees: the built-in wins in
 * `runTool` and the capability is silently unreachable over MCP, which is the class of bug that
 * cost a black window once.
 */
export const RESERVED_CAPABILITY_NAMES: readonly string[] = ['run_query', 'list_tables', 'describe_table', 'search_columns', 'list_app_actions'];

/** Project a capability spec onto the wire {@link ToolSpec} the providers understand. The
 *  `domain`/`mutates` metadata is kept by main in side-sets keyed by name, not sent to the model. */
export function toToolSpec(spec: CapabilitySpec): ToolSpec {
	return { name: spec.name, description: spec.description, parameters: spec.parameters };
}

/**
 * Words that must not be sentence-cased when a capability name is turned into a title.
 * Keyed by the lower-case segment, so `run_sql` reads "Run SQL" rather than "Run sql".
 */
const CAPABILITY_TITLE_WORDS: Record<string, string> = {
	ai: 'AI',
	aws: 'AWS',
	csv: 'CSV',
	db: 'DB',
	ddl: 'DDL',
	fk: 'FK',
	id: 'ID',
	json: 'JSON',
	pdf: 'PDF',
	sql: 'SQL',
	ssh: 'SSH',
	ui: 'UI',
	url: 'URL',
};

/**
 * A human title for a capability, for any surface a PERSON reads (Settings' app-actions list,
 * the consent card, the agent timeline): `open_connection_form` becomes "Open connection form".
 *
 * Derived rather than hand-written, deliberately. Capabilities are added often, and a
 * per-capability label field that a new one can forget renders as a blank row or falls back to the
 * snake_case anyway, which is the thing being fixed. A spec that derives badly sets {@link
 * CapabilitySpec.title} instead; that is the exception, not the pattern.
 */
export function capabilityTitle(spec: CapabilitySpec | string): string {
	if (typeof spec !== 'string' && spec.title) {
		return spec.title;
	}
	const name = typeof spec === 'string' ? spec : spec.name;
	const words = name.split('_').filter((word) => word.length > 0);
	if (words.length === 0) {
		return name;
	}
	return words
		.map((word, index) => {
			const known = CAPABILITY_TITLE_WORDS[word.toLowerCase()];
			if (known) {
				return known;
			}
			// Only the first word is capitalized: a title, not Title Case.
			return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
		})
		.join(' ');
}

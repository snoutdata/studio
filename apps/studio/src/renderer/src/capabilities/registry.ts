/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ProjectSection } from '../../../shared/projects';
import type { CapabilityInvocation, CapabilityResult, CapabilitySpec } from '../../../shared/capabilities';
import { CAPABILITY_DATA, capabilityConnectionArg, IMPLICIT_CONNECTIONS, RESERVED_CAPABILITY_NAMES } from '../../../shared/capabilities';
import type { ConnectionFormValues } from '../../../shared/forms';
import type { TableDraft } from '../ddl';
import type { PrincipalDraft, SecurityChange } from '../../../shared/engine';
import type { AppSettings } from '../appSettings';
import type { ToolId } from '../docking';
import { lastError } from './lastError';

/**
 * The renderer-side capability registry: the reusable seam between the app's modules and the
 * AI chat. A module registers a {@link CapabilityHandler}; the registry advertises its spec to
 * the agent (via the per-request manifest in ChatPanel) and, when the model calls it, runs the
 * handler with an injected {@link CapabilityContext}. Keep this file DOM-free (no React/Monaco)
 * so it stays node-testable — handlers reach the app through the injected context, never by
 * closing over component state. There is one process-wide singleton, {@link capabilityRegistry}.
 */

/** The imperative app handles a capability handler may drive. Implemented in App.tsx (each
 *  method wraps an existing handler), passed in via {@link CapabilityContext.app}. */
export interface AppCapabilityBridge {
	/** Open a new editor tab seeded with SQL; returns the tab id. */
	createTab(sql: string): string;
	/** Insert text at the active editor's cursor. */
	insertAtCursor(text: string): void;
	/** Run the current editor statement (honors the prod-confirm path). Resolves once the run
	 *  has settled, so a caller can read the result immediately after awaiting. */
	runCurrent(): Promise<void>;
	/** Open the connection form prefilled with a partial draft for the user to review and save. */
	openConnectionForm(draft: Partial<ConnectionFormValues>): void;
	/** Open the table designer for a new table, optionally seeded with a draft. */
	openTableDesigner(connectionId: string, schema: string | undefined, seed?: TableDraft): void;
	/** Open a workspace `.sql` file (by absolute path) in an editor tab. */
	openWorkspaceFile(path: string): Promise<void>;
	/**
	 * Open the Data Flow wizard, optionally on a file to sample or a saved flow to edit.
	 *
	 * `companion` is the docked tool to leave on screen when the wizard takes the room: whoever
	 * opened it and is about to talk the user through it. Without it, an agent that opens the
	 * wizard is hidden by its own action, and the user is left on a screen they did not open with
	 * nobody to ask.
	 */
	openFlow(options: { path?: string; flowId?: string; companion?: ToolId }): void;
	/** Open (or focus) the monitors view. One monitor tab exists at a time. */
	openMonitors(): void;
	/** Open (or focus) a SnoutData Cloud project's tab at a section. */
	openCloudProject(ref: string, name: string, section: ProjectSection): void;
	/**
	 * Open (or focus) the Users & Privileges view for a connection, optionally with a proposal to
	 * review: a `draft` prefills the new-user form (the user still types the password), `changes`
	 * open the review sheet on the exact statements. Nothing is run.
	 */
	openSecurity(connectionId: string, proposal?: { draft?: PrincipalDraft; changes?: SecurityChange[] }): void;
	/** Connect / disconnect a saved connection by id. */
	connect(id: string): Promise<boolean>;
	disconnect(id: string): Promise<void>;
	/** Apply a whitelisted app setting (validated by the settings capability). */
	setAppSetting(key: keyof AppSettings, value: AppSettings[keyof AppSettings]): void;
	/** Switch the color theme. */
	setTheme(dark: boolean): void;
	/** A knowledge note was added/changed, so surfaces that count what the assistant knows (the
	 *  chat's "Knows N things" chip) re-read it. */
	notifyKnowledgeChanged(): void;
	/** The result grid currently shown: columns + rows (capped at `maxRows`), structured-clone-safe,
	 *  for charting/reasoning over what's on screen. Distinguishes "nothing run yet" from a run
	 *  that failed (carrying its error) so the model can fix and retry rather than loop blind. */
	getQueryResult(maxRows: number): QueryResultLookup;
	/** The connection that produced the result shown in the grid, so main can check what the AI may
	 *  see of THAT database before get_query_result's rows reach a model. */
	resultConnectionId?(): string | undefined;
}

/** What {@link AppCapabilityBridge.getQueryResult} found: nothing run yet, a run that failed
 *  (with its error so the model can correct the SQL), or a successful result grid. */
export type QueryResultLookup =
	| { status: 'none' }
	| { status: 'error'; error: string }
	| { status: 'ok'; view: QueryResultView };

/** A plain view of the active result grid for the `get_query_result` capability. */
export interface QueryResultView {
	columns: { name: string; dataType?: string }[];
	rows: (string | number | boolean | null)[][];
	/** Total rows in the result (rows may be capped to `maxRows`). */
	rowCount: number;
	/** True when `rows` was truncated to `maxRows`. */
	truncated: boolean;
}

/** A plain, structured-clone-safe view of the app for read capabilities. */
export interface AppSnapshot {
	connections: { id: string; label: string; driver: string; environment?: string; connected: boolean }[];
	activeConnectionId?: string;
	tabs: { id: string; title: string; kind: string; connectionId?: string; active: boolean }[];
	appSettings: AppSettings;
	/** The keyboard shortcuts as bound now (rebindable), keys formatted for this platform. */
	shortcuts: { id: string; label: string; keys: string }[];
}

/** Everything a handler needs, injected so the registry core stays DOM-free and testable. */
export interface CapabilityContext {
	api: Window['sqlApi'];
	app: AppCapabilityBridge;
	snapshot(): AppSnapshot;
	/** Who asked, when an external agent did (see {@link CapabilityInvocation.client}). Injected by
	 *  {@link CapabilityRegistry.invoke}, so a handler never has to be given the invocation. */
	client?: string;
}

/** A registered capability: its spec plus the handler that performs it. */
export interface CapabilityHandler {
	spec: CapabilitySpec;
	run(args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> | CapabilityResult;
	/**
	 * The connections this call would act on, for a spec whose `implicitConnection` is `'target'`
	 * (the thing it names decides: a flow, a cloud project, the open wizard). Required for those,
	 * and only those. An empty list means it touches no saved connection.
	 */
	connections?(args: Record<string, unknown>, ctx: CapabilityContext): Promise<string[]> | string[];
}

/**
 * Why a handler cannot be registered as it is, or undefined. Every capability says which connection
 * it acts on without being told and what it returns from a database, because that is what holds an
 * external agent to the connections the user exposed to it; a spec published without the answer
 * (or a `'target'` one with nobody to resolve it) is a programmer error, caught here at register time.
 */
export function classificationProblem(handler: CapabilityHandler): string | undefined {
	const { spec } = handler;
	if (!IMPLICIT_CONNECTIONS.includes(spec.implicitConnection)) {
		return `Capability "${spec.name}" does not say which connection it acts on (implicitConnection).`;
	}
	if (!CAPABILITY_DATA.includes(spec.returnsData)) {
		return `Capability "${spec.name}" does not say what it returns from a database (returnsData).`;
	}
	if (spec.returnsData !== 'none' && spec.implicitConnection === 'none' && !capabilityConnectionArg(spec)) {
		return `Capability "${spec.name}" returns content from a database but does not say which connection it comes from.`;
	}
	if ((spec.implicitConnection === 'target') !== (typeof handler.connections === 'function')) {
		return spec.implicitConnection === 'target'
			? `Capability "${spec.name}" acts on the connections of what it names, but cannot resolve them.`
			: `Capability "${spec.name}" resolves connections but does not say it acts on them (implicitConnection: 'target').`;
	}
	return undefined;
}

/** The connections a call of `handler` acts on without naming them, as the app stands now. */
export async function implicitConnections(handler: CapabilityHandler, args: Record<string, unknown>, ctx: CapabilityContext): Promise<string[]> {
	const one = (id: string | undefined): string[] => (id ? [id] : []);
	switch (handler.spec.implicitConnection) {
		case 'none':
		case 'perItem':
			return [];
		case 'activeTab':
			return one(ctx.snapshot().activeConnectionId);
		case 'result':
			return one(ctx.app.resultConnectionId?.());
		case 'lastError':
			return one(lastError()?.connectionId);
		case 'target':
			return [...new Set(await handler.connections?.(args, ctx) ?? [])];
	}
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	const left = new Set(a);
	const right = new Set(b);
	return left.size === right.size && [...left].every((id) => right.has(id));
}

const reserved = new Set(RESERVED_CAPABILITY_NAMES);

export class CapabilityRegistry {
	private handlers = new Map<string, CapabilityHandler>();
	private listeners = new Set<() => void>();

	/**
	 * Subscribe to registrations and unregistrations. The chat path reads {@link list} per request
	 * so it never needed this; an EXTERNAL agent has no request to hang a manifest off, so main
	 * keeps a standing copy and this is what keeps it current.
	 */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	/** Register a capability. Returns an unregister fn (for component-lifecycle use). Throws on a
	 *  reserved name (a built-in DB tool) or a duplicate — both are programmer errors. */
	register(handler: CapabilityHandler): () => void {
		const { name } = handler.spec;
		if (reserved.has(name)) {
			throw new Error(`Capability "${name}" collides with a built-in tool name.`);
		}
		if (this.handlers.has(name)) {
			throw new Error(`Capability "${name}" is already registered.`);
		}
		const problem = classificationProblem(handler);
		if (problem) {
			throw new Error(problem);
		}
		this.handlers.set(name, handler);
		this.changed();
		return () => this.unregister(name);
	}

	unregister(name: string): void {
		if (this.handlers.delete(name)) {
			this.changed();
		}
	}

	has(name: string): boolean {
		return this.handlers.has(name);
	}

	/** The manifest advertised to the agent for a chat turn. */
	list(): CapabilitySpec[] {
		return [...this.handlers.values()].map((h) => h.spec);
	}

	/** Run one invocation. Never throws: an unknown name or a handler error becomes an
	 *  unsuccessful {@link CapabilityResult} the model can read and recover from. */
	async invoke(inv: CapabilityInvocation, ctx: CapabilityContext): Promise<CapabilityResult> {
		const handler = this.handlers.get(inv.name);
		if (!handler) {
			return { ok: false, summary: '', error: `Unknown capability "${inv.name}".` };
		}
		const args = inv.arguments ?? {};
		const scoped = inv.client ? { ...ctx, client: inv.client } : ctx;
		try {
			if (inv.resolveConnections) {
				return { ok: true, summary: '', connectionIds: await implicitConnections(handler, args, scoped) };
			}
			if (!inv.expectConnections) {
				return await handler.run(args, scoped);
			}
			// Checked again at the moment it runs: what main checked is what runs.
			const now = await implicitConnections(handler, args, scoped);
			if (!sameSet(now, inv.expectConnections)) {
				return { ok: false, summary: '', refused: true, error: `"${inv.name}" was not run: what it acts on changed while it waited (another tab, result or error is now current). Call it again.` };
			}
			return { ...await handler.run(args, scoped), connectionIds: now };
		} catch (err) {
			return { ok: false, summary: '', error: err instanceof Error ? err.message : String(err) };
		}
	}
}

/** The process-wide registry. Modules register on it; ChatPanel reads its manifest per request. */
export const capabilityRegistry = new CapabilityRegistry();

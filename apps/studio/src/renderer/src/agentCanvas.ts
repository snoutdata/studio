/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AGENT_KINDS, type AgentKind } from '../../shared/agentConsole';

/*
 * What each coding agent has DRAWN into its console.
 *
 * A module-level store, not React state, for the same reason the capability registry is one: the
 * thing that writes to it is a capability invoked from main, which has no component to call into.
 * The console subscribes and renders; nothing else reads it.
 *
 * Deliberately NOT persisted. This is what an agent chose to show this session; the terminal
 * scrollback is the durable record of what it did. Keeping it would mean a store, a cap and an
 * eviction policy for something nobody asked to keep.
 */

/** One push: markdown the agent wants shown, in the order it arrived. */
export interface CanvasEntry {
	id: string;
	markdown: string;
	/** Optional heading for the push, e.g. "Slow queries". */
	title?: string;
}

/** How many pushes a console keeps. A long task can draw a lot; this is a memory floor, not a
 *  policy, and the oldest go first so the newest is always the one on screen. */
const MAX_ENTRIES = 100;

type Listener = () => void;

const entries = new Map<AgentKind, CanvasEntry[]>();
const listeners = new Set<Listener>();
let seq = 0;

function emit(): void {
	for (const listener of listeners) {
		listener();
	}
}

/** Subscribe to every console's canvas. Cheap enough to notify all of them: there are three. */
export function subscribeCanvas(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** What this agent has drawn, oldest first. Stable identity while nothing changes, so a component
 *  can use it as a render dependency without re-rendering on every unrelated push. */
export function canvasFor(kind: AgentKind): CanvasEntry[] {
	return entries.get(kind) ?? EMPTY;
}

const EMPTY: CanvasEntry[] = [];

/** Append a push (or replace everything, when the agent asked to clear first). */
export function pushCanvas(kind: AgentKind, entry: { markdown: string; title?: string; clear?: boolean }): CanvasEntry {
	seq += 1;
	const next: CanvasEntry = { id: `canvas-${seq}`, markdown: entry.markdown, title: entry.title };
	const current = entry.clear ? [] : (entries.get(kind) ?? []);
	const list = [...current, next];
	entries.set(kind, list.length > MAX_ENTRIES ? list.slice(list.length - MAX_ENTRIES) : list);
	emit();
	return next;
}

/** Empty one console's canvas (the Clear button, and `clear` with nothing to show). */
export function clearCanvas(kind: AgentKind): void {
	if ((entries.get(kind) ?? []).length > 0) {
		entries.delete(kind);
		emit();
	}
}

/** Drop everything. Only for tests and a full app reset. */
export function resetCanvas(): void {
	let had = false;
	for (const kind of AGENT_KINDS) {
		had = entries.delete(kind) || had;
	}
	if (had) {
		emit();
	}
}

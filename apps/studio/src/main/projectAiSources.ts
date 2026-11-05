/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ProjectAiSource } from '../shared/aiSources';

// The SnoutData Cloud projects whose own AI gateway the signed-in user may use, from the control
// plane's `cloud-project-ai` relay (`{action: "ai-sources"}`). Read lazily, when the model picker
// opens, never on the boot path, and cached for a minute like the model catalog. A failure is an
// empty list: a project's models are an addition to the picker, never a reason it fails.

const CACHE_TTL_MS = 60_000;

/** Keeps only well-formed rows; the relay is ours, but a picker must never throw on its answer. */
export function parseAiSources(payload: unknown): ProjectAiSource[] {
	const projects = (payload as { projects?: unknown } | null)?.projects;
	if (!Array.isArray(projects)) {
		return [];
	}
	const out: ProjectAiSource[] = [];
	for (const p of projects as Partial<ProjectAiSource>[]) {
		if (!p || typeof p.ref !== 'string' || !p.ref || p.ref.includes(':')) {
			continue;
		}
		const models = Array.isArray(p.models)
			? p.models.filter((m) => m && typeof m.id === 'string' && m.id).map((m) => ({ id: m.id, owned_by: typeof m.owned_by === 'string' ? m.owned_by : undefined, vendor: typeof m.vendor === 'string' ? m.vendor : undefined }))
			: null;
		out.push({ ref: p.ref, name: typeof p.name === 'string' && p.name ? p.name : p.ref, state: typeof p.state === 'string' ? p.state : '', models });
	}
	return out;
}

export interface ProjectAiSources {
	/** The cached list, or a fresh one when it is older than a minute (or `force`). */
	list(force?: boolean): Promise<ProjectAiSource[]>;
	/** Forget the cache (sign-in, sign-out). */
	clear(): void;
}

/** `fetchSources` asks the relay; `now` is a seam for the test. Concurrent asks share one call. */
export function createProjectAiSources(fetchSources: () => Promise<unknown>, now: () => number = Date.now): ProjectAiSources {
	let cache: { at: number; sources: ProjectAiSource[] } | null = null;
	let inFlight: Promise<ProjectAiSource[]> | null = null;
	let generation = 0;
	return {
		async list(force = false): Promise<ProjectAiSource[]> {
			if (!force && cache && now() - cache.at < CACHE_TTL_MS) {
				return cache.sources;
			}
			if (inFlight) {
				return inFlight;
			}
			const asked = generation;
			inFlight = (async () => {
				let sources: ProjectAiSource[] = [];
				let ok = false;
				try {
					sources = parseAiSources(await fetchSources());
					ok = true;
				} catch {
					// Offline, signed out or the relay refused: no project models this time.
				}
				// A failure is not cached, so the next open asks again; a clear() while asking wins.
				if (ok && asked === generation) {
					cache = { at: now(), sources };
				}
				return sources;
			})();
			try {
				return await inFlight;
			} finally {
				inFlight = null;
			}
		},
		clear(): void {
			cache = null;
			generation++;
		},
	};
}

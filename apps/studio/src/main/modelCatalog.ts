/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getCloudClient } from './cloudClient';

// The completion-role helpers live in an Electron-free module (so they're unit-testable) but are
// re-exported here, where the rest of main already imports the catalog.
export { isCompletionModel, preferredCompletionModel } from './completionRole';

/** Editorial metadata for one model, sourced from the control plane's `released_models`. Keyed by the
 *  raw model id (the join key shared with the gateway's `/v1/models`). All fields are optional
 *  since a model row may carry none. */
export interface ModelMeta {
	displayName?: string;
	description?: string;
	label?: string;
	contextWindow?: number;
	sortOrder?: number;
	recommended?: boolean;
	/** The model's role: 'completion' (base/FIM, inline completion only) vs 'chat' (default).
	 *  Server-owned, so the FIM model can be swapped/renamed without an app release — the app
	 *  classifies and picks the completion model from this, not a hard-coded id. */
	role?: string;
}

interface ReleasedModelRow {
	model_name: string;
	display_name: string | null;
	description: string | null;
	label: string | null;
	context_window: number | null;
	sort_order: number | null;
	recommended: boolean | null;
	role: string | null;
}

// Cache the catalog briefly: providerStatus() is called often (every time the picker opens),
// but the metadata changes rarely (an editor tweaks a row), so a short TTL spares the
// network round-trip without making edits feel stale. The map is global, not per-user — the read
// uses the public (app key) read policy on released_models.
const CACHE_TTL_MS = 60_000;
let cache: { at: number; map: Map<string, ModelMeta> } | null = null;

/** The model metadata map (model id → {@link ModelMeta}), read from the control plane and cached for a
 *  minute. Best-effort: on any error (offline, policy, missing table) it returns an empty map so
 *  the picker simply falls back to raw ids. The `at` reference is captured before `Date.now()` is
 *  unavailable in workflow scripts — here in main it's fine.
 *
 *  Read only for a signed-in user (AiService gates it): the catalog decorates the gateway's models,
 *  and a signed-out app makes no call to the accounts backend for something it cannot use. */
export async function getModelCatalog(): Promise<Map<string, ModelMeta>> {
	const now = Date.now();
	if (cache && now - cache.at < CACHE_TTL_MS) {
		return cache.map;
	}
	const map = new Map<string, ModelMeta>();
	try {
		const { data, error } = await getCloudClient()
			.table('released_models')
			.read<ReleasedModelRow>('model_name, display_name, description, label, context_window, sort_order, recommended, role');
		if (!error && Array.isArray(data)) {
			for (const row of data as ReleasedModelRow[]) {
				if (!row.model_name) {
					continue;
				}
				map.set(row.model_name, {
					displayName: row.display_name ?? undefined,
					description: row.description ?? undefined,
					label: row.label ?? undefined,
					contextWindow: typeof row.context_window === 'number' ? row.context_window : undefined,
					sortOrder: typeof row.sort_order === 'number' ? row.sort_order : undefined,
					recommended: row.recommended ?? undefined,
					role: row.role ?? undefined,
				});
			}
		}
	} catch {
		// Offline / unreachable — leave the map empty; the picker shows raw ids.
	}
	cache = { at: now, map };
	return map;
}

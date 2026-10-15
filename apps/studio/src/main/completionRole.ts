/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isCompletionOnlyModel } from '../shared/ai';
import type { ModelMeta } from './modelCatalog';

// Pure completion/FIM-role logic, split out from modelCatalog so it carries no Electron
// dependency (modelCatalog imports the accounts client, which imports `electron`) and can be
// unit-tested under node:test. The `ModelMeta` import is type-only, so it's erased at build and
// never pulls the catalog's runtime deps.

/** Whether `model` is a completion/FIM model (inline completion only, never chat). Prefers the
 *  server's `role` from the catalog; falls back to the hard-coded {@link isCompletionOnlyModel}
 *  set only when the catalog has no row for it (offline, or a model not yet tagged) so completion
 *  classification still works cold. */
export function isCompletionModel(model: string, catalog: Map<string, ModelMeta>): boolean {
	const role = catalog.get(model)?.role;
	if (role) {
		return role === 'completion';
	}
	return isCompletionOnlyModel(model);
}

/** The catalog's preferred completion model id: among the models tagged `role: 'completion'`,
 *  the recommended one, then the lowest sort_order, then lexical. Undefined when none is tagged
 *  (then the caller keeps the stored/default id). This is the seam that lets a server-side
 *  completion-model swap/rename land with no app release. */
export function preferredCompletionModel(catalog: Map<string, ModelMeta>): string | undefined {
	const completion = [...catalog.entries()].filter(([, m]) => m.role === 'completion');
	if (completion.length === 0) {
		return undefined;
	}
	completion.sort(([aId, a], [bId, b]) =>
		Number(b.recommended ?? false) - Number(a.recommended ?? false)
		|| (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
		|| aId.localeCompare(bId));
	return completion[0][0];
}

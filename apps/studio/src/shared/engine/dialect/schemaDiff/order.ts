/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Safe dependency ordering for a change list.
 *
 *  Statements must run in an order that never references an object before it exists (or after
 *  it is gone): drop dependents (triggers, FKs, indexes) first, create tables before the
 *  constraints/views/triggers that lean on them, and push the destructive drops (columns,
 *  views, tables) to the very end so excluding them in the UI leaves a still-valid plan.
 *--------------------------------------------------------------------------------------------*/

import type { SchemaChange } from './types';

/** Lower phase = applied earlier. The within-phase order from the diff (grouped per table) is kept. */
function phase(change: SchemaChange): number {
	switch (change.kind) {
		case 'dropTrigger': return 0;
		case 'dropForeignKey': return 1;
		case 'dropIndex': return 2;
		case 'dropRoutine': return 3;
		case 'addTable': return 10;
		case 'addColumn': return 11;
		case 'alterColumn': return 12;
		case 'setPrimaryKey': return 13;
		case 'addIndex': return 14;
		case 'replaceIndex': return 14;
		case 'addForeignKey': return 15;
		case 'replaceForeignKey': return 15;
		case 'addView': return 20;
		case 'replaceView': return 20;
		case 'addRoutine': return 21;
		case 'replaceRoutine': return 21;
		case 'addTrigger': return 22;
		case 'replaceTrigger': return 22;
		case 'dropColumn': return 30;
		case 'dropView': return 31;
		case 'dropTable': return 32;
	}
}

/** Stable-sort changes into safe apply order without mutating the input. */
export function orderChanges(changes: readonly SchemaChange[]): SchemaChange[] {
	return changes
		.map((change, index) => ({ change, index }))
		.sort((a, b) => phase(a.change) - phase(b.change) || a.index - b.index)
		.map((entry) => entry.change);
}

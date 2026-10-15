/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How a move between two engines is carried out.
 *
 * Keyed by driver id from the first line, so adding an engine is a row here and a rules file,
 * not a refactor. Redshift speaks the Postgres wire protocol and is still refused: `pg_dump`
 * does not work against it, and a strategy that looks right and fails on the first catalogue
 * query is worse than a sentence.
 */

import type { DriverId } from './spec.js';

export type MoveStrategy =
	/** `pg_dump | pg_restore`: full fidelity, same engine. */
	| { readonly kind: 'native-pg' }
	| { readonly kind: 'refused'; readonly reason: string };

export function strategyFor(source: DriverId, target: DriverId): MoveStrategy {
	if (source === 'postgres' && target === 'postgres') {
		return { kind: 'native-pg' };
	}
	if (source === target) {
		return {
			kind: 'refused',
			reason: `Moving a ${source} database is not built yet. Postgres is the first engine.`
		};
	}
	return {
		kind: 'refused',
		reason: `Moving from ${source} to ${target} is not built yet. Postgres to Postgres is the first move.`
	};
}

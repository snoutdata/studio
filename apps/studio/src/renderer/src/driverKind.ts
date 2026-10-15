/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * What KIND of backend a driver is, as a glyph and a heading — the one definition of it.
 *
 * Two surfaces need this and they must not disagree: the connection form's driver picker (grouped
 * rows) and the connections tree (a mark beside each connection). A second copy of the mapping is
 * the thing that goes stale silently when a driver is added, so there is one, here.
 *
 * It is DERIVED from `backendKindForDriver` rather than written out per vendor, for the same reason
 * the flow source catalogue derives its list: a hand-maintained table of sixteen driver ids is
 * exactly what nobody remembers to update, and the failure is invisible — a new driver would simply
 * get no icon.
 *
 * These are Codicons and they name a FAMILY, not a vendor. `BrandMark` is the app's vehicle for real
 * third-party marks and it takes the actual artwork, so a vendor logo drawn from memory is what its
 * "unmodified in shape" rule exists to prevent. The family is also the more useful thing to show:
 * it is what decides which fields the connection form asks for and whether the grid can be edited.
 */

import { backendKindForDriver } from '../../shared/engine';

export interface DriverKind {
	/** The heading this driver sits under in a grouped picker. */
	group: string;
	/** Icon name, as `<Icon/>` takes it. */
	icon: string;
}

/**
 * The families, in the order a picker shows them, first match wins.
 *
 * File-based is tested BEFORE relational on purpose: SQLite and DuckDB are relational, and the
 * difference that matters to someone choosing here is that they are a file rather than a server —
 * which is what the rest of the form becomes (a path picker, not host, port and credentials).
 */
export const DRIVER_KINDS: readonly (DriverKind & { match(driverId: string): boolean })[] = [
	{ group: 'File-based', icon: 'file-binary', match: (id) => id === 'sqlite' || id === 'duckdb' },
	{ group: 'Relational', icon: 'database', match: (id) => backendKindForDriver(id) === 'relational' },
	{ group: 'Document', icon: 'json', match: (id) => backendKindForDriver(id) === 'document' },
	{ group: 'Vector', icon: 'graph-scatter', match: (id) => backendKindForDriver(id) === 'vector' },
	{ group: 'Cloud logs', icon: 'cloud', match: (id) => backendKindForDriver(id) === 'telemetry' },
];

/** The family a driver belongs to. A driver matching none still gets a mark rather than a gap. */
export function driverKind(driverId: string): DriverKind {
	const found = DRIVER_KINDS.find((kind) => kind.match(driverId));
	return found ? { group: found.group, icon: found.icon } : { group: 'Other', icon: 'database' };
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Flavors: engines that speak another engine's wire protocol ON PURPOSE (CockroachDB and
 *  YugabyteDB speak Postgres, TiDB speaks MySQL), so they need no driver and no package of their
 *  own. A flavored connection keeps its base driver id (`postgres` / `mysql-aurora`) and carries
 *  `ConnectionConfig.flavor`; every behaviour (pool, introspection, dialect, guard, schema sync) is
 *  the base driver's. What the flavor changes is only what a person or a model is TOLD: its name in
 *  the picker and the tree, its default port, and the SQL flavour named in the AI prompt, which is
 *  the one that matters (a model writing for "PostgreSQL" against CockroachDB reaches for things
 *  Cockroach does not have).
 *
 *  A flavor that turns out to need behaviour of its own graduates to a driver id, the way Redshift
 *  is its own driver on the Postgres family.
 *--------------------------------------------------------------------------------------------*/

import { dialectFor, readOnlyEnforcement } from './index';
import { lexicalOnly, type ReadOnlyEnforcement } from './readOnly';

export interface Flavor {
	/** Stored in `ConnectionConfig.flavor`. Never changes once shipped. */
	readonly id: string;
	/** The driver that actually connects: 'postgres' or 'mysql-aurora'. */
	readonly baseDriver: string;
	/** Name in the connection picker and the tree. */
	readonly displayName: string;
	/** The SQL flavour handed to the model. */
	readonly aiDisplayName: string;
	/** The port the engine's own docs give for its SQL wire endpoint. */
	readonly defaultPort: number;
	/** Lower-case words that identify it in an imported tool's driver/url text. */
	readonly importWords: readonly string[];
	/** False when the base driver's database-side read-only statements are not known to work on
	 *  this engine (TiDB treats SET TRANSACTION READ ONLY as a no-op it refuses by default), so a
	 *  read-only run there relies on the statement check alone rather than failing every read. */
	readonly databaseReadOnly?: false;
}

const FLAVORS: readonly Flavor[] = [
	{ id: 'cockroachdb', baseDriver: 'postgres', displayName: 'CockroachDB', aiDisplayName: 'CockroachDB (PostgreSQL-compatible)', defaultPort: 26257, importWords: ['cockroach'] },
	{ id: 'yugabytedb', baseDriver: 'postgres', displayName: 'YugabyteDB', aiDisplayName: 'YugabyteDB YSQL (PostgreSQL-compatible)', defaultPort: 5433, importWords: ['yugabyte'] },
	{ id: 'timescaledb', baseDriver: 'postgres', displayName: 'TimescaleDB', aiDisplayName: 'PostgreSQL with the TimescaleDB extension', defaultPort: 5432, importWords: ['timescale'] },
	{ id: 'greenplum', baseDriver: 'postgres', displayName: 'Greenplum', aiDisplayName: 'Greenplum (PostgreSQL-based MPP)', defaultPort: 5432, importWords: ['greenplum'] },
	{ id: 'tidb', baseDriver: 'mysql-aurora', displayName: 'TiDB', aiDisplayName: 'TiDB (MySQL-compatible)', defaultPort: 4000, importWords: ['tidb'], databaseReadOnly: false },
	{ id: 'oceanbase', baseDriver: 'mysql-aurora', displayName: 'OceanBase', aiDisplayName: 'OceanBase in MySQL mode (MySQL-compatible)', defaultPort: 2881, importWords: ['oceanbase'], databaseReadOnly: false },
];

/** Every flavor, in picker order. */
export function listFlavors(): readonly Flavor[] {
	return FLAVORS;
}

/** The flavor a connection carries, or undefined when it has none, names one we do not know, or
 *  names one whose base driver is not the connection's (a hand-edited file). */
export function flavorFor(driver: string | undefined, flavor: string | undefined): Flavor | undefined {
	if (!flavor) {
		return undefined;
	}
	const found = FLAVORS.find((candidate) => candidate.id === flavor);
	return found && found.baseDriver === driver ? found : undefined;
}

/** {@link readOnlyEnforcement} for a connection, honouring its flavor. */
export function readOnlyEnforcementFor(driver: string | undefined, flavor?: string): ReadOnlyEnforcement {
	const found = flavorFor(driver, flavor);
	if (found?.databaseReadOnly === false) {
		return lexicalOnly(found.displayName);
	}
	return readOnlyEnforcement(driver);
}

/** What to call the engine behind a connection: the flavor's name, else the driver's. */
export function engineDisplayName(driver: string | undefined, flavor?: string): string {
	return flavorFor(driver, flavor)?.displayName ?? dialectFor(driver).displayName;
}

/** The SQL flavour to name in a prompt: the flavor's, else the driver dialect's. */
export function engineAiDisplayName(driver: string | undefined, flavor?: string): string {
	return flavorFor(driver, flavor)?.aiDisplayName ?? dialectFor(driver).aiDisplayName;
}

/** Match imported driver/url text to a flavor. Checked BEFORE the base-driver match, since a
 *  CockroachDB profile in another tool often names the Postgres driver too. */
export function flavorForImportText(text: string): Flavor | undefined {
	const hay = text.toLowerCase();
	return FLAVORS.find((flavor) => flavor.importWords.some((word) => hay.includes(word)));
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../../shared/connection';
import type { ConnectionFormValues, DiscoveryOptions, DiscoveryProgress, ImportItemRef, ImportScanResult, ImportSourceId } from '../../shared/forms';
import { DISCOVERY_SOURCE_LABELS, discoverySourceIds } from '../../shared/forms';
import { resolveAzureDataStudioImport, scanAzureDataStudio } from './azureDataStudio';
import { dedupeAcrossSources, dropMapped } from './dedupe';
import { resolveDockerImport, scanDocker } from './docker';
import { resolveHeidisqlImport, scanHeidisql } from './heidisql';
import { resolveProbeImport, scanLocal } from './local';
import { resolveMysqlWorkbenchImport, scanMysqlWorkbench } from './mysqlWorkbench';
import { scanNetwork } from './network';
import { resolvePgadminImport, scanPgadmin } from './pgadmin';
import { resolvePgpassImport, scanPgpass } from './pgpass';
import { resolveSsmsImport, scanSsms } from './ssms';
import { resolveTablePlusImport, scanTablePlus } from './tablePlus';

// First-run discovery: every source at once, each under its own time limit, progress pushed as each
// finishes, and one database found twice shown once. Never on the boot path: this runs when the
// user presses "Find databases", and not before.
//
// The sources that already had an importer (DBeaver, DataGrip, Navicat, SnoutData Cloud) are
// handed in by the caller, which owns their dependencies; everything else is imported here.

/** How one source is run. */
interface SourceRun {
	id: ImportSourceId;
	timeoutMs: number;
	/** null means "nothing to say", and the source is left out of the results entirely. */
	scan(): ImportScanResult | null | Promise<ImportScanResult | null>;
}

export interface DiscoveryDeps {
	existing: ConnectionConfig[];
	platform: NodeJS.Platform;
	/** The pre-existing importers, run as they are. */
	scanDbeaver(): ImportScanResult;
	scanDatagrip(): ImportScanResult;
	scanNavicat(): ImportScanResult;
	/** SnoutData Cloud, or null when signed out (skipped quietly, per the spec). */
	scanCloud(): Promise<ImportScanResult | null>;
	onProgress?(progress: DiscoveryProgress): void;
}

const FILE_MS = 5_000;

/** The sources this machine runs, in the order `discoverySourceIds` gives (the popup lists the same). */
export function discoverySources(deps: DiscoveryDeps, options: DiscoveryOptions): SourceRun[] {
	const { existing } = deps;
	const table: Record<ImportSourceId, Omit<SourceRun, 'id'>> = {
		'snoutdata-cloud': { timeoutMs: 10_000, scan: () => deps.scanCloud() },
		docker: { timeoutMs: 8_000, scan: () => scanDocker(existing) },
		local: { timeoutMs: 4_000, scan: () => scanLocal(existing) },
		dbeaver: { timeoutMs: FILE_MS, scan: () => deps.scanDbeaver() },
		datagrip: { timeoutMs: FILE_MS, scan: () => deps.scanDatagrip() },
		pgadmin: { timeoutMs: FILE_MS, scan: () => scanPgadmin(existing) },
		'mysql-workbench': { timeoutMs: FILE_MS, scan: () => scanMysqlWorkbench(existing) },
		'azure-data-studio': { timeoutMs: FILE_MS, scan: () => scanAzureDataStudio(existing) },
		pgpass: { timeoutMs: FILE_MS, scan: () => scanPgpass(existing) },
		navicat: { timeoutMs: FILE_MS, scan: () => deps.scanNavicat() },
		ssms: { timeoutMs: FILE_MS, scan: () => scanSsms(existing) },
		heidisql: { timeoutMs: FILE_MS, scan: () => scanHeidisql(existing) },
		tableplus: { timeoutMs: FILE_MS, scan: () => scanTablePlus(existing) },
		network: { timeoutMs: 30_000, scan: () => scanNetwork(existing) },
	};
	const platform = deps.platform === 'win32' || deps.platform === 'darwin' ? deps.platform : 'linux';
	return discoverySourceIds(platform, options.network).map((id) => ({ id, ...table[id] }));
}

/** Let the event loop turn, so a progress message already sent reaches the window. */
function yieldToLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function withTimeout(run: SourceRun): Promise<ImportScanResult | null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve({
			sourceId: run.id,
			sources: [],
			items: [],
			unavailable: `${DISCOVERY_SOURCE_LABELS[run.id]} took too long to answer, so it was skipped.`,
		}), run.timeoutMs);
		Promise.resolve()
			.then(() => run.scan())
			.then((r) => resolve(r), (err: unknown) => resolve({
				sourceId: run.id,
				sources: [],
				items: [],
				unavailable: `Could not look at ${DISCOVERY_SOURCE_LABELS[run.id]}: ${err instanceof Error ? err.message : String(err)}`,
			}))
			.finally(() => clearTimeout(timer));
	});
}

/** Run every source and return what they found, one result per source that had something to say. */
export async function runDiscovery(deps: DiscoveryDeps, options: DiscoveryOptions): Promise<ImportScanResult[]> {
	const runs = discoverySources(deps, options);
	for (const run of runs) {
		deps.onProgress?.({ sourceId: run.id, state: 'scanning' });
	}
	// The file sources are synchronous reads. Each waits its own turn of the loop, so the "done"
	// for one reaches the window before the next starts, instead of all of them at the end.
	const results = await Promise.all(runs.map(async (run, i) => {
		for (let k = 0; k <= i; k++) {
			await yieldToLoop();
		}
		const started = Date.now();
		const result = await withTimeout(run);
		const found = result?.items.filter((i) => i.supported).length ?? 0;
		// One line per source in the main log, so a slow or stuck source is named rather than guessed at.
		console.log(`[discovery] ${run.id}: ${found} found in ${Date.now() - started}ms${result?.unavailable ? ` (${result.unavailable})` : ''}`);
		deps.onProgress?.({ sourceId: run.id, state: 'done', found });
		return result;
	}));
	return dropMapped(dedupeAcrossSources(results.filter((r): r is ImportScanResult => r !== null)));
}

/** Resolve the chosen refs for one of the sources this module owns, with secrets, in main. */
export async function resolveDiscoveryImport(source: ImportSourceId, refs: ImportItemRef[]): Promise<ConnectionFormValues[] | null> {
	switch (source) {
		case 'pgadmin': return resolvePgadminImport(refs);
		case 'mysql-workbench': return resolveMysqlWorkbenchImport(refs);
		case 'azure-data-studio': return resolveAzureDataStudioImport(refs);
		case 'ssms': return resolveSsmsImport(refs);
		case 'heidisql': return resolveHeidisqlImport(refs);
		case 'pgpass': return resolvePgpassImport(refs);
		case 'tableplus': return resolveTablePlusImport(refs);
		case 'docker': return resolveDockerImport(refs);
		case 'local':
		case 'network': return resolveProbeImport(refs);
		default: return null;
	}
}

/** Auto-detect scan for one of this module's sources (the import pre-screen's `import:scan`). */
export function scanDiscoverySource(source: ImportSourceId, existing: ConnectionConfig[]): ImportScanResult | Promise<ImportScanResult> | null {
	switch (source) {
		case 'pgadmin': return scanPgadmin(existing);
		case 'mysql-workbench': return scanMysqlWorkbench(existing);
		case 'azure-data-studio': return scanAzureDataStudio(existing);
		case 'ssms': return scanSsms(existing);
		case 'heidisql': return scanHeidisql(existing);
		case 'pgpass': return scanPgpass(existing);
		case 'tableplus': return scanTablePlus(existing);
		case 'docker': return scanDocker(existing);
		case 'local': return scanLocal(existing);
		case 'network': return scanNetwork(existing);
		default: return null;
	}
}

/** Parse files the user browsed to, for one of this module's sources. */
export function browseDiscoverySource(source: ImportSourceId, files: string[], existing: ConnectionConfig[]): ImportScanResult | Promise<ImportScanResult> | null {
	switch (source) {
		case 'pgadmin': return scanPgadmin(existing, files);
		case 'mysql-workbench': return scanMysqlWorkbench(existing, files);
		case 'azure-data-studio': return scanAzureDataStudio(existing, files);
		case 'ssms': return scanSsms(existing, files);
		case 'heidisql': return scanHeidisql(existing, files);
		case 'pgpass': return scanPgpass(existing, files);
		case 'tableplus': return scanTablePlus(existing, files);
		default: return null;
	}
}

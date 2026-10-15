/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Checking a move against the two real databases.
 *
 * The rules are `@snout/move`'s and pure; this is only the host: find the two saved connections,
 * run the package's one facts query on each at background priority, add what only the app knows
 * (read-only, production, whether it is a hosted project), and hand both to preflight. Everything
 * that can be tested without Electron is in the package; what is here takes a `MoveHost` so it can
 * be driven without one too.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';

import {
	applyFix,
	endpointFactsFromPg,
	findFinding,
	HOSTED_POSTGRES_PLATFORM,
	newDatabaseFactsFromPg,
	newHostedProjectFacts,
	NO_PLATFORM,
	PG_FACTS_SQL,
	pgServerFactsSql,
	preflight,
	readyToRun,
	replacePlan,
	type EndpointFacts,
	type FixId,
	type MoveEndpoint,
	type MoveSpec
} from '@snout/move';
import type { ConnectionConfig } from '../shared/connection';
import type { MoveCheck, MoveFixOutcome } from '../shared/move';
import type { ExecuteQueryResult } from '../shared/protocol';
import { testEnv } from './testHooks';

export interface MoveHost {
	connections(): ConnectionConfig[];
	ensureConnected(id: string): Promise<void>;
	/** Read-only, background priority, never recorded in history. */
	execute(id: string, sql: string): Promise<ExecuteQueryResult>;
	/** The installed `pg_dump`'s major version, or null when there is none. */
	toolMajor(): Promise<number | null>;
}

/** Facts for an endpoint nothing could be learned about: every rule that needs one stays silent. */
function unknownFacts(config: ConnectionConfig): EndpointFacts {
	return {
		serverMajor: null,
		identity: null,
		schemas: [],
		extensions: [],
		availableExtensions: null,
		allowedExtensions: null,
		empty: null,
		readOnly: config.readOnly === true,
		production: config.environment === 'prod',
		superuser: null,
		// Null is NOT ASKED, which is exactly what this function is for: `grantees-missing` stays
		// silent rather than blocking a move against a database nobody could interrogate.
		roles: null,
		grantees: null,
		sizeBytes: null,
		storage: null,
		platformSchemas: [],
		platformExtensions: [],
		extensionTables: [],
		objects: [],
		platformObjects: [],
		creation: null
	};
}

/** The saved connection an EXISTING endpoint is. Undefined for one the move creates. */
export function connectionFor(endpoint: MoveEndpoint, connections: readonly ConnectionConfig[]): ConnectionConfig | undefined {
	if (endpoint.kind === 'connection') {
		return connections.find((connection) => connection.id === endpoint.id);
	}
	if (endpoint.kind === 'cloud') {
		return connections.find((connection) => connection.cloudProjectRef === endpoint.ref);
	}
	return undefined;
}

/**
 * The SSH tunnel lives in the server child (`postgresDriver.ts`), so a spawned `pg_dump` has no
 * port to reach it through. Refused by name until a tunnel can be opened in main.
 */
function refuseTunnel(config: ConnectionConfig): void {
	if (config.sshTunnel || config.sshTunnelRef) {
		throw new Error(`"${config.label}" connects through an SSH tunnel, and a move cannot use one yet.`);
	}
}

/** Facts for the target, which may not exist yet. A thrown Error is a sentence for the view. */
async function targetFactsFor(spec: MoveSpec, all: readonly ConnectionConfig[], host: MoveHost): Promise<EndpointFacts> {
	const target = spec.target;
	if (target.kind === 'newCloudProject') {
		return newHostedProjectFacts();
	}
	if (target.kind === 'newDatabase') {
		const server = all.find((connection) => connection.id === target.serverConnectionId);
		if (!server) {
			throw new Error("The server for the new database is not a saved connection any more.");
		}
		if (server.driver !== 'postgres') {
			return { ...unknownFacts(server), creation: { canCreate: null, nameTaken: null } };
		}
		refuseTunnel(server);
		await host.ensureConnected(server.id);
		const answer = await host.execute(server.id, pgServerFactsSql(target.database));
		if (!answer.ok) {
			throw new Error(`Could not read the server of "${server.label}": ${String(answer.error)}`);
		}
		return newDatabaseFactsFromPg(answer.result.rows[0]?.[0], {
			identity: `${server.host}:${server.port}/${target.database}`,
			readOnly: server.readOnly === true,
			production: server.environment === 'prod',
			storage: null
		});
	}
	const existing = connectionFor(target, all);
	if (!existing) {
		throw new Error("The target is not a saved connection any more.");
	}
	return factsFor(existing, host);
}

async function factsFor(config: ConnectionConfig, host: MoveHost): Promise<EndpointFacts> {
	if (config.driver !== 'postgres') {
		// The strategy refuses the pair in a sentence; asking a non-Postgres server Postgres's
		// catalogue would only add a second, worse one.
		return unknownFacts(config);
	}
	refuseTunnel(config);
	await host.ensureConnected(config.id);
	const answer = await host.execute(config.id, PG_FACTS_SQL);
	if (!answer.ok) {
		throw new Error(`Could not read "${config.label}": ${String(answer.error)}`);
	}
	return endpointFactsFromPg(answer.result.rows[0]?.[0], {
		identity: `${config.host}:${config.port}/${config.database ?? ''}`,
		readOnly: config.readOnly === true,
		production: config.environment === 'prod',
		// A hosted plan's storage needs the control plane's usage call, which the desktop does not
		// make yet; until then the storage rule stays silent rather than guessing.
		storage: null,
		// A local project runs the same image, so its platform is the same.
		platform: config.cloudProjectRef || config.localProjectId ? HOSTED_POSTGRES_PLATFORM : NO_PLATFORM
	});
}

export interface GatheredFacts {
	readonly source: EndpointFacts;
	readonly target: EndpointFacts;
	readonly toolMajor: number | null;
}

/** Everything preflight reads, from both databases. Throws a sentence when either cannot be read. */
export async function gatherFacts(spec: MoveSpec, host: MoveHost): Promise<GatheredFacts> {
	const all = host.connections();
	const source = connectionFor(spec.source, all);
	if (!source) {
		throw new Error("The source is not a saved connection any more.");
	}
	const [sourceFacts, targetFacts, toolMajor] = await Promise.all([factsFor(source, host), targetFactsFor(spec, all, host), host.toolMajor()]);
	return { source: sourceFacts, target: targetFacts, toolMajor };
}

export async function checkMove(spec: MoveSpec, host: MoveHost): Promise<MoveCheck> {
	try {
		const facts = await gatherFacts(spec, host);
		const findings = preflight(spec, facts);
		return {
			findings,
			ready: readyToRun(findings),
			drops: replacePlan(spec, facts).drops,
			error: null
		};
	} catch (error) {
		return { findings: [], ready: false, drops: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Apply one of a finding's fixes, found by key against a FRESH check, and check again. */
export async function fixMove(spec: MoveSpec, key: string, fix: FixId, host: MoveHost): Promise<MoveFixOutcome> {
	const before = await checkMove(spec, host);
	if (before.error) {
		return { ok: false, error: before.error };
	}
	const finding = findFinding(before.findings, key);
	if (!finding) {
		return { ok: false, error: "That finding is no longer there. Check both databases again." };
	}
	const applied = applyFix(spec, finding, fix);
	if (!applied.ok) {
		return applied;
	}
	return { ok: true, spec: applied.spec, check: await checkMove(applied.spec, host) };
}

/**
 * Where the Postgres tools are: the `pgtools` component once downloaded, or, for a
 * developer, a `bin` directory named by `SNOUT_PG_TOOLS_DIR`, which wins. Like every other override
 * of that kind it is read through the test-hook gate, so an installed copy never lets its environment
 * choose which pg_dump runs. Null when neither, and the move says the tools are missing and offers
 * the download.
 */
export function pgToolsDir(installed: string | undefined): string | null {
	return testEnv('SNOUT_PG_TOOLS_DIR') || installed || null;
}

const majors = new Map<string, Promise<number | null>>();

/** The major version of the `pg_dump` in `dir`, asked once per directory. */
export function pgToolsMajor(dir: string | null): Promise<number | null> {
	if (!dir) {
		return Promise.resolve(null);
	}
	let major = majors.get(dir);
	if (!major) {
		major = new Promise((resolve) => {
			execFile(join(dir, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'), ['--version'], { timeout: 10_000 }, (error, stdout) => {
				const match = /\(PostgreSQL\)\s+(\d+)/.exec(stdout ?? '');
				resolve(error || !match ? null : Number(match[1]));
			});
		});
		majors.set(dir, major);
	}
	return major;
}

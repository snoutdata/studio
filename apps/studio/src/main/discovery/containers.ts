/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionFormValues } from '../../shared/forms';
import type { Found } from './common';

// A running container, as the Docker Engine API describes it, to the connection it offers. Pure: the
// socket half is `docker.ts`. The engine is decided by the IMAGE (a stray container exposing 5432 is
// not a Postgres just for that), falling back to the private port only when the image says nothing,
// and then only as a guess. Credentials come from the container's own environment, the variables
// each official image documents, and are read again in main when the user imports.

/** The part of `GET /containers/{id}/json` read here. */
export interface ContainerInspect {
	Id: string;
	Name?: string;
	Config?: { Image?: string; Env?: string[] | null; Labels?: Record<string, string> | null };
	NetworkSettings?: { Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null };
	/** `NetworkMode: 'host'` shares the host's network: nothing is published, and nothing needs to be. */
	HostConfig?: { NetworkMode?: string };
}

/** The label SnoutData's own database images carry (the hosted pod image and the self-hosted stack). */
export const STACK_LABEL = 'com.snoutdata.stack';
/** Which part of the stack a container is; only `postgres` is a database. */
export const STACK_COMPONENT_LABEL = 'com.snoutdata.component';
/** A project's containers when it runs as a pod rather than under Compose: the ref is on every one
 *  of them, the service name on each part that is not its database. */
const SNOUTPOD_REF_LABEL = 'snoutpod.ref';
const SNOUTPOD_SERVICE_LABEL = 'snoutpod.service';

/** Docker Compose's own labels. A local project runs as compose project `snout-<ref>` (localStack/plan.ts). */
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const LOCAL_STACK_PROJECT = /^snout-[a-z][a-z0-9]{12}$/;

/** What the item for a local stack's database is called: by its ref, since two can run at once. */
export function stackItemName(ref: string | undefined): string {
	return ref ? `SnoutData stack (${ref})` : "SnoutData stack (local)";
}

interface Engine {
	driver: string;
	/** The port it listens on inside the container. */
	port: number;
}

/** Image repository patterns, most specific first (MariaDB before MySQL, the stack before Postgres). */
const IMAGE_ENGINES: { match: RegExp; engine: Engine }[] = [
	{ match: /(^|\/)snoutpod-postgres$/, engine: { driver: 'postgres', port: 5432 } },
	{ match: /(^|\/)(postgres|postgresql|postgis|timescaledb(-ha|-postgis)?|pgvector)$|cloudnative-pg\/postgresql$/, engine: { driver: 'postgres', port: 5432 } },
	{ match: /mariadb/, engine: { driver: 'mariadb', port: 3306 } },
	{ match: /(^|\/)(mysql|mysql-server|percona|percona-server)$/, engine: { driver: 'mysql-aurora', port: 3306 } },
	{ match: /mssql\/server$|azure-sql-edge$/, engine: { driver: 'sqlserver', port: 1433 } },
	{ match: /gvenzl\/oracle-(xe|free)$|(^|\/)database\/(free|express|enterprise)$|oracle\/database$/, engine: { driver: 'oracle', port: 1521 } },
	{ match: /clickhouse-server$|clickhouse\/clickhouse$/, engine: { driver: 'clickhouse', port: 8123 } },
	{ match: /(^|\/)mongo$|mongodb/, engine: { driver: 'mongodb', port: 27017 } },
	{ match: /db2/, engine: { driver: 'db2', port: 50000 } },
];

const PORT_ENGINES: Record<number, string> = {
	5432: 'postgres', 3306: 'mysql-aurora', 1433: 'sqlserver', 1521: 'oracle', 8123: 'clickhouse', 27017: 'mongodb', 50000: 'db2',
};

/** `docker.io/library/postgres:16@sha256:…` to `docker.io/library/postgres`. */
export function imageRepository(image: string): string {
	let s = image.trim().toLowerCase();
	s = s.replace(/@sha256:[0-9a-f]+$/, '');
	const slash = s.lastIndexOf('/');
	const colon = s.lastIndexOf(':');
	return colon > slash ? s.slice(0, colon) : s;
}

export function engineForImage(image: string): Engine | null {
	const repo = imageRepository(image);
	return IMAGE_ENGINES.find((e) => e.match.test(repo))?.engine ?? null;
}

function envMap(env: string[] | null | undefined): Map<string, string> {
	const out = new Map<string, string>();
	for (const pair of env ?? []) {
		const eq = pair.indexOf('=');
		if (eq > 0) {
			out.set(pair.slice(0, eq), pair.slice(eq + 1));
		}
	}
	return out;
}

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|yes|true|y)$/i.test(v.trim());

interface Credentials {
	username: string;
	password?: string;
	database?: string;
	note?: string;
}

/** The credentials each official image documents, read from the container's environment. Pure. */
export function credentialsFromEnv(driver: string, image: string, env: Map<string, string>): Credentials {
	const get = (...names: string[]): string | undefined => names.map((n) => env.get(n)).find((v) => v !== undefined && v !== '');
	if (driver === 'postgres') {
		const ref = get('SNOUTPOD_REF');
		if (ref) {
			return { username: `${ref}_owner`, password: get('SNOUTPOD_OWNER_PASSWORD'), database: ref };
		}
		const bitnamiUser = get('POSTGRESQL_USERNAME');
		if (bitnamiUser) {
			return { username: bitnamiUser, password: get('POSTGRESQL_PASSWORD'), database: get('POSTGRESQL_DATABASE') };
		}
		const username = get('POSTGRES_USER') ?? 'postgres';
		const trust = (get('POSTGRES_HOST_AUTH_METHOD') ?? '').toLowerCase() === 'trust';
		const password = get('POSTGRES_PASSWORD', 'POSTGRESQL_POSTGRES_PASSWORD');
		return {
			username,
			password,
			database: get('POSTGRES_DB') ?? username,
			note: get('POSTGRES_PASSWORD_FILE') && !password ? "The password is in a file inside the container; set it after import."
				: trust ? "The container trusts every connection, so no password is needed." : undefined,
		};
	}
	if (driver === 'mysql-aurora' || driver === 'mariadb') {
		const m = (name: string): string | undefined => (driver === 'mariadb' ? get(`MARIADB_${name}`, `MYSQL_${name}`) : get(`MYSQL_${name}`));
		const database = m('DATABASE');
		const appUser = m('USER');
		if (appUser && m('PASSWORD')) {
			return { username: appUser, password: m('PASSWORD'), database };
		}
		const rootPassword = m('ROOT_PASSWORD');
		if (rootPassword) {
			return { username: 'root', password: rootPassword, database };
		}
		const allowEmpty = driver === 'mariadb' ? truthy(get('MARIADB_ALLOW_EMPTY_ROOT_PASSWORD', 'MYSQL_ALLOW_EMPTY_PASSWORD')) : truthy(get('MYSQL_ALLOW_EMPTY_PASSWORD'));
		if (allowEmpty) {
			return { username: 'root', database, note: "The root password is empty." };
		}
		const random = driver === 'mariadb' ? truthy(get('MARIADB_RANDOM_ROOT_PASSWORD', 'MYSQL_RANDOM_ROOT_PASSWORD')) : truthy(get('MYSQL_RANDOM_ROOT_PASSWORD'));
		return {
			username: 'root',
			database,
			note: random ? "The root password was generated when the container first started and printed to its log; set it after import." : undefined,
		};
	}
	if (driver === 'sqlserver') {
		return { username: 'sa', password: get('MSSQL_SA_PASSWORD', 'SA_PASSWORD') };
	}
	if (driver === 'oracle') {
		const repo = imageRepository(image);
		const pdb = get('ORACLE_PDB') ?? (/free/.test(repo) ? 'FREEPDB1' : /xe/.test(repo) ? 'XEPDB1' : undefined);
		const appUser = get('APP_USER');
		if (appUser && get('APP_USER_PASSWORD')) {
			return { username: appUser, password: get('APP_USER_PASSWORD'), database: get('ORACLE_DATABASE') ?? pdb };
		}
		return { username: 'system', password: get('ORACLE_PASSWORD', 'ORACLE_PWD'), database: pdb };
	}
	if (driver === 'clickhouse') {
		return { username: get('CLICKHOUSE_USER') ?? 'default', password: get('CLICKHOUSE_PASSWORD'), database: get('CLICKHOUSE_DB') };
	}
	if (driver === 'mongodb') {
		const username = get('MONGO_INITDB_ROOT_USERNAME', 'MONGODB_ROOT_USER');
		return username
			? { username, password: get('MONGO_INITDB_ROOT_PASSWORD', 'MONGODB_ROOT_PASSWORD') }
			: { username: '', note: "No root user is set, so the server takes connections without signing in." };
	}
	if (driver === 'db2') {
		return { username: get('DB2INSTANCE') ?? 'db2inst1', password: get('DB2INST1_PASSWORD'), database: get('DBNAME') };
	}
	return { username: '' };
}

/** The host a published port is reached on from this computer. */
function hostFor(hostIp: string | undefined): string {
	return !hostIp || hostIp === '0.0.0.0' || hostIp === '::' || hostIp === '127.0.0.1' || hostIp === '::1' ? 'localhost' : hostIp;
}

/**
 * What one container offers, or null when it is not a database at all (including the stack's own
 * non-database parts). `engineName` is "Docker" or "Podman", for the note. Pure.
 */
export function containerFound(socket: string, engineName: string, c: ContainerInspect): Found | null {
	const labels = c.Config?.Labels ?? {};
	const image = c.Config?.Image ?? '';
	const ports = c.NetworkSettings?.Ports ?? {};
	const isStack = labels[STACK_LABEL] === '1' || labels[SNOUTPOD_REF_LABEL] !== undefined;
	if (labels[SNOUTPOD_SERVICE_LABEL] !== undefined || (labels[STACK_COMPONENT_LABEL] !== undefined && labels[STACK_COMPONENT_LABEL] !== 'postgres')) {
		return null;
	}
	// A local project's other parts run stock images (its `metadata` service is plain postgres), so
	// no stack label marks them; the compose project does. Only its `db` is the project's database.
	if (LOCAL_STACK_PROJECT.test(labels[COMPOSE_PROJECT_LABEL] ?? '') && labels[COMPOSE_SERVICE_LABEL] !== 'db') {
		return null;
	}

	let engine = isStack ? { driver: 'postgres', port: 5432 } : engineForImage(image);
	let guessed = false;
	if (!engine) {
		// A host-network container publishes nothing, so there is no port here to guess from.
		const exposed = Object.keys(ports).map((k) => Number(k.split('/')[0])).find((p) => PORT_ENGINES[p]);
		if (exposed === undefined) {
			return null;
		}
		engine = { driver: PORT_ENGINES[exposed], port: exposed };
		guessed = true;
	}

	const name = (c.Name ?? '').replace(/^\//, '') || c.Id.slice(0, 12);
	const env = envMap(c.Config?.Env);
	const cred = credentialsFromEnv(engine.driver, image, env);
	const bindings = ports[`${engine.port}/tcp`] ?? null;
	const hostNetwork = c.HostConfig?.NetworkMode === 'host';
	// On the host's network the server listens on the host itself, at its own port.
	const binding = hostNetwork
		? { HostIp: '127.0.0.1', HostPort: String(engine.port) }
		: bindings?.find((b) => b.HostPort && !(b.HostIp ?? '').includes(':')) ?? bindings?.find((b) => b.HostPort);
	const label = isStack ? stackItemName(env.get('SNOUTPOD_REF') ?? labels[SNOUTPOD_REF_LABEL]) : name;

	const values: ConnectionFormValues = {
		label,
		driver: engine.driver,
		host: hostFor(binding?.HostIp),
		port: binding?.HostPort ? Number(binding.HostPort) : engine.port,
		database: cred.database,
		username: cred.username,
		password: cred.password,
		ssl: false,
		readOnly: false,
	};

	const what = isStack ? `The local SnoutData stack (${name}) in ${engineName}.` : `${imageRepository(image).split('/').pop() || "A"} container in ${engineName}.`;
	if (!binding) {
		return {
			ref: { file: socket, connId: c.Id },
			values,
			sourceName: label,
			supported: false,
			importsPassword: false,
			note: `${what} Its port ${engine.port} is not published to this computer, so it cannot be reached. Recreate it with "-p ${engine.port}:${engine.port}" (or a "ports:" entry in compose) to connect.`,
		};
	}
	const notes = [what];
	if (hostNetwork) {
		notes.push(`It shares this computer's network, so it listens on port ${engine.port} directly.`);
	}
	if (guessed) {
		notes.push(`The image does not say what it is; port ${engine.port} suggests it.`);
	}
	if (cred.note) {
		notes.push(cred.note);
	} else if (cred.password) {
		notes.push("The password comes from the container's environment.");
	} else if (engine.driver !== 'mongodb') {
		notes.push("No password in its environment; set it after import.");
	}
	return {
		ref: { file: socket, connId: c.Id },
		values,
		sourceName: label,
		supported: true,
		importsPassword: Boolean(cred.password),
		tentative: guessed || undefined,
		note: notes.join(' '),
	};
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { realpathSync } from 'node:fs';
import { request } from 'node:http';

import type { ConnectionConfig } from '../../shared/connection';
import type { ConnectionFormValues, ImportItemRef, ImportScanResult } from '../../shared/forms';
import { pickResolved, toScanResult, type Found } from './common';
import { containerFound, type ContainerInspect } from './containers';
import { containerSockets, hostEnv } from './paths';

// Docker and Podman, over the Engine API on their local socket (a named pipe on Windows). Both
// speak the Docker-compatible API, so one client serves them: list the RUNNING containers, inspect
// each for its environment, and let `containers.ts` decide what it is. Nothing is started, stopped
// or pulled; the only verbs are two GETs.

/** Why a socket gave nothing: the daemon is absent, or it is there and refused us. */
type SocketFailure = { code: string };

function engineGet(socket: string, path: string, timeoutMs: number): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const req = request({ socketPath: socket, path, method: 'GET', headers: { Host: 'localhost' }, timeout: timeoutMs }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => {
				if ((res.statusCode ?? 500) >= 400) {
					reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { code: `HTTP_${res.statusCode}` }));
					return;
				}
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
				} catch (err) {
					reject(err);
				}
			});
		});
		req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
		req.on('error', reject);
		req.end();
	});
}

/** A container id, and nothing that could steer the request path elsewhere. */
function isContainerId(id: string): boolean {
	return /^[0-9a-f]{12,64}$/i.test(id);
}

function engineNameFor(socket: string): string {
	return /podman/i.test(socket) ? "Podman" : "Docker";
}

async function inspect(socket: string, id: string, timeoutMs: number): Promise<ContainerInspect | null> {
	if (!isContainerId(id)) {
		return null;
	}
	try {
		return await engineGet(socket, `/containers/${id}/json`, timeoutMs) as ContainerInspect;
	} catch {
		return null;
	}
}

/** Every running container one socket knows, inspected; or why the socket gave nothing. */
async function listSocket(socket: string, timeoutMs: number): Promise<ContainerInspect[] | SocketFailure> {
	let list: unknown;
	try {
		list = await engineGet(socket, '/containers/json', timeoutMs);
	} catch (err) {
		return { code: (err as NodeJS.ErrnoException).code ?? 'ERROR' };
	}
	const ids = Array.isArray(list) ? list.map((c) => String((c as { Id?: unknown }).Id ?? '')).filter(isContainerId) : [];
	const inspected = await Promise.all(ids.map((id) => inspect(socket, id, timeoutMs)));
	return inspected.filter((c): c is ContainerInspect => c !== null);
}

/** Distinct sockets: two names for one daemon (a symlink) are asked once. */
function distinctSockets(sockets: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of sockets) {
		let real = s;
		try {
			real = realpathSync(s);
		} catch {
			// a named pipe, or not there: keep the name as given
		}
		if (!seen.has(real)) {
			seen.add(real);
			out.push(s);
		}
	}
	return out;
}

export async function scanDocker(existing: ConnectionConfig[], sockets = containerSockets(hostEnv()), timeoutMs = 3000): Promise<ImportScanResult> {
	const found: Found[] = [];
	const sources: string[] = [];
	const seenIds = new Set<string>();
	const denied: string[] = [];
	const answers = await Promise.all(distinctSockets(sockets).map(async (socket) => ({ socket, got: await listSocket(socket, timeoutMs) })));
	for (const { socket, got } of answers) {
		if (!Array.isArray(got)) {
			// ENOENT / ECONNREFUSED: that engine is not installed or not running, which is normal.
			if (got.code === 'EACCES' || got.code === 'EPERM') {
				denied.push(socket);
			}
			continue;
		}
		sources.push(socket);
		for (const c of got) {
			if (seenIds.has(c.Id)) {
				continue;
			}
			seenIds.add(c.Id);
			const f = containerFound(socket, engineNameFor(socket), c);
			if (f) {
				found.push(f);
			}
		}
	}
	const result = toScanResult('docker', sources, found, existing);
	if (sources.length === 0 && denied.length > 0) {
		// Linux, and the user is not in the docker group. A sentence they can act on, never a crash
		// and never "nothing found", which would be untrue.
		return {
			...result,
			notFound: false,
			unavailable: `Docker is running, but this account may not read its socket (${denied[0]}). Add yourself to the docker group ("sudo usermod -aG docker $USER"), sign out and back in, then run this again.`,
		};
	}
	return result;
}

/** Inspect the chosen containers again, in main, so their passwords never leave it. */
export async function resolveDockerImport(refs: ImportItemRef[], timeoutMs = 3000): Promise<ConnectionFormValues[]> {
	const found: Found[] = [];
	const known = new Set(containerSockets(hostEnv()));
	for (const ref of refs) {
		// Only a socket this machine's scan would have asked; a ref is not a way to name any file.
		const c = known.has(ref.file) ? await inspect(ref.file, ref.connId, timeoutMs) : null;
		const f = c ? containerFound(ref.file, engineNameFor(ref.file), c) : null;
		if (f) {
			found.push(f);
		}
	}
	return pickResolved(found, refs);
}

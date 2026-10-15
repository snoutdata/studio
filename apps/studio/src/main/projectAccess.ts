/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { projectKey, type ProjectActionOutcome, type ProjectApiRequest, type ProjectApiResponse, type ProjectSqlResult, type ProjectTarget } from '../shared/projects';
import { CloudRequestError, detailFrom, type CloudApi } from './cloudApi';
import { apiErrorMessage, apiPathAllowed } from './localStack/plan';
import { CLOUD_VOCABULARY, DB_LAYOUT_SQL, keyHeader, platformSql, wirePath, type Vocabulary } from '../shared/ownLayout';

// How a project's sections reach the project, local or cloud (shared/projects.ts). The cloud
// dashboard reaches a project through two doors, and every section of the app's project tab uses
// the same two, wherever the project runs:
//
//   - SQL as the owner: a local project's own Postgres on 127.0.0.1 with the owner password from its
//     .env, or `cloud-project-sql`, the dashboard's runner.
//   - The gateway with the server key: a local project's on 127.0.0.1, or `<ref>.api.snoutdata.com`
//     with the key from `cloud-project-connection`.
//
// Paths are written in our own names (`/v1/identity/operator/people`, `/v1/files/space`,
// `/v1/data/<table>`) and sent in the names the project's gateway serves (shared/ownLayout.ts).
//
// Both secrets stay here. A cloud key is read once per project per session, like the dashboard's:
// reading it is a line on the project's audit log, and one visit
// should be one line, not one per file.

/** What a local project needs to be reached. Main only (LocalStackService.target). */
export interface LocalTarget {
	ref: string;
	dbPort: number;
	apiPort: number;
	password: string;
	/** The server key (`SERVER_KEY` in its `.env`, or the stack's own name for it, `SERVICE_ROLE_KEY`). */
	serverKey: string;
	/** The names its gateway serves (shared/ownLayout.ts, `stackVocabulary`). */
	vocabulary: Vocabulary;
}

/** Leads every statement this app sends; pg_stat_statements keeps a leading comment, so Logs can leave them out. */
export const SQL_MARK = '/* snoutdata-desktop */';

/** Where a cloud project's gateway answers. */
export function cloudApiBase(ref: string): string {
	return `https://${ref}.api.snoutdata.com`;
}

export interface ProjectAccessDeps {
	local(id: string): LocalTarget;
	cloud: CloudApi;
	fetch: typeof fetch;
}

export class ProjectAccess {
	private readonly cloudKeys = new Map<string, string>();
	/** Each project's database layout (shared/ownLayout.ts), asked once; a failed ask is not kept. */
	private readonly layouts = new Map<string, Vocabulary>();

	constructor(private readonly deps: ProjectAccessDeps) {}

	/** One statement as the project owner, rows capped at `limit`. */
	/** A statement on the platform's own tables, written in our layout's names, sent in the names
	 *  this project's database has (a project born before the new layout keeps the old ones). */
	async platformSql(target: ProjectTarget, text: string, limit = 500): Promise<ProjectSqlResult> {
		const key = projectKey(target);
		let layout = this.layouts.get(key);
		if (!layout) {
			const asked = await this.sql(target, DB_LAYOUT_SQL);
			if (!asked.ok) {
				return asked;
			}
			layout = asked.rows[0]?.layout === 'old' ? 'old' : 'new';
			this.layouts.set(key, layout);
		}
		return this.sql(target, platformSql(text, layout), limit);
	}

	async sql(target: ProjectTarget, text: string, limit = 500): Promise<ProjectSqlResult> {
		const statement = `${SQL_MARK} ${text}`;
		if (target.kind === 'cloud') {
			try {
				const answer = await this.deps.cloud.request<{ columns?: string[]; rows?: Record<string, unknown>[]; rowCount?: number; truncated?: boolean }>('cloud-project-sql', { ref: target.ref, sql: statement });
				const rows = answer.rows ?? [];
				return { ok: true, columns: answer.columns ?? [], rows: rows.slice(0, limit), rowCount: answer.rowCount ?? rows.length, truncated: answer.truncated === true || rows.length > limit };
			} catch (err) {
				return { ok: false, columns: [], rows: [], rowCount: 0, truncated: false, error: detailFrom(err), refused: err instanceof CloudRequestError && err.refused };
			}
		}
		const local = this.deps.local(target.id);
		// Lazily: pg is only needed once somebody opens one of these sections.
		const { Client } = await import('pg');
		const client = new Client({
			host: '127.0.0.1',
			port: local.dbPort,
			user: `${local.ref}_owner`,
			// A function, so an empty answer is the answer: pg would read "" as absent and try PGPASSWORD and ~/.pgpass.
			password: () => local.password,
			database: local.ref,
			connectionTimeoutMillis: 8000,
			statement_timeout: 60000,
			application_name: 'snoutdata-desktop',
		});
		try {
			await client.connect();
			const answer: unknown = await client.query(statement);
			// A string of several statements answers an array; the last is the one being read.
			const last = (Array.isArray(answer) ? answer[answer.length - 1] : answer) as { rows?: Record<string, unknown>[]; fields?: { name: string }[]; rowCount?: number | null } | undefined;
			const rows = last?.rows ?? [];
			return { ok: true, columns: (last?.fields ?? []).map((f) => f.name), rows: rows.slice(0, limit), rowCount: last?.rowCount ?? rows.length, truncated: rows.length > limit };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				columns: [],
				rows: [],
				rowCount: 0,
				truncated: false,
				error: /ECONNREFUSED|ETIMEDOUT|timeout expired/i.test(message) ? `The database is not answering on 127.0.0.1:${local.dbPort}. Is the project running?` : message,
			};
		} finally {
			await client.end().catch(() => undefined);
		}
	}

	/** The gateway's address and its server key, for one project. */
	private async gateway(target: ProjectTarget, fresh = false): Promise<{ base: string; key: string }> {
		if (target.kind === 'local') {
			const local = this.deps.local(target.id);
			return { base: `http://127.0.0.1:${local.apiPort}`, key: local.serverKey };
		}
		let key = fresh ? undefined : this.cloudKeys.get(target.ref);
		if (!key) {
			// `serviceRoleKey` is the field's earlier name: a control plane not yet migrated to the new names sends only it.
			const details = await this.deps.cloud.connection(target.ref) as { serverKey?: string | null; serviceRoleKey?: string | null };
			const serverKey = details.serverKey ?? details.serviceRoleKey;
			if (!serverKey) {
				throw new Error("This project's API keys could not be read just now. Try again in a moment.");
			}
			key = serverKey;
			this.cloudKeys.set(target.ref, key);
		}
		return { base: cloudApiBase(target.ref), key };
	}

	private async send(target: ProjectTarget, method: string, path: string, body: string | Buffer | undefined, headers: Record<string, string>, wantBytes = false): Promise<{ ok: boolean; status: number; text: string; bytes?: ArrayBuffer }> {
		let vocabulary: Vocabulary;
		try {
			// A local project's own: the stack its compose.yaml runs may predate the new names.
			vocabulary = target.kind === 'local' ? this.deps.local(target.id).vocabulary : CLOUD_VOCABULARY;
		} catch (err) {
			return { ok: false, status: 0, text: detailFrom(err) };
		}
		const wire = wirePath(path, vocabulary);
		// Both: the path as written, and the path as it goes out.
		if (!apiPathAllowed(path) || !apiPathAllowed(wire)) {
			return { ok: false, status: 0, text: `The app does not call ${path} for you.` };
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			let gateway: { base: string; key: string };
			try {
				gateway = await this.gateway(target, attempt > 0);
			} catch (err) {
				return { ok: false, status: 0, text: detailFrom(err) };
			}
			let res: Response;
			try {
				res = await this.deps.fetch(`${gateway.base}${wire}`, {
					method,
					headers: { [keyHeader(vocabulary)]: gateway.key, Authorization: `Bearer ${gateway.key}`, ...headers },
					body,
					signal: AbortSignal.timeout(120000),
				});
			} catch (err) {
				const where = target.kind === 'local' ? `${gateway.base}. Is the project running?` : gateway.base;
				return { ok: false, status: 0, text: `The gateway did not answer at ${where} (${err instanceof Error ? err.message : String(err)})` };
			}
			// A cloud key rotated since it was read: read it again, once.
			if (res.status === 401 && target.kind === 'cloud' && attempt === 0) {
				continue;
			}
			if (wantBytes && res.ok) {
				return { ok: true, status: res.status, text: '', bytes: await res.arrayBuffer() };
			}
			return { ok: res.ok, status: res.status, text: await res.text() };
		}
		return { ok: false, status: 401, text: "The project refused its own server key." };
	}

	async api(target: ProjectTarget, request: ProjectApiRequest): Promise<ProjectApiResponse> {
		const json = request.body !== undefined;
		const res = await this.send(target, request.method, request.path, json ? JSON.stringify(request.body) : undefined, json ? { 'Content-Type': 'application/json' } : {});
		const body = parse(res.text) ?? (res.text || null);
		return res.ok ? { ok: true, status: res.status, body } : { ok: false, status: res.status, body, error: apiErrorMessage(body, res.text, res.status) };
	}

	/** Files from this computer into a space, each under `prefix`. An existing name is refused unless `upsert`. */
	async upload(target: ProjectTarget, bucket: string, prefix: string, files: string[], upsert: boolean): Promise<ProjectActionOutcome> {
		let sent = 0;
		for (const file of files) {
			const name = basename(file);
			const key = [prefix.replace(/^\/+|\/+$/g, ''), name].filter(Boolean).join('/');
			const res = await this.send(target, 'POST', `/v1/files/file/${encodeURIComponent(bucket)}/${encodeStoragePath(key)}`, readFileSync(file), {
				'Content-Type': mimeFor(name),
				'x-upsert': upsert ? 'true' : 'false',
			});
			if (!res.ok) {
				return { ok: false, message: `${name}: ${apiErrorMessage(parse(res.text), res.text, res.status)}${sent > 0 ? ` (${sent} uploaded before it)` : ''}` };
			}
			sent++;
		}
		return { ok: true, message: sent === 1 ? "1 file uploaded." : `${sent} files uploaded.` };
	}

	/** One object's bytes, for a copy to another project (`projectCopy.ts`). */
	async readObject(target: ProjectTarget, bucket: string, path: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
		const res = await this.send(target, 'GET', `/v1/files/file/${encodeURIComponent(bucket)}/${encodeStoragePath(path)}`, undefined, {}, true);
		return res.ok && res.bytes ? { ok: true, bytes: Buffer.from(res.bytes) } : { ok: false, error: apiErrorMessage(parse(res.text), res.text, res.status) };
	}

	/** Write one object, never over one that is there: `exists` is a copy's "already done". */
	async writeObject(target: ProjectTarget, bucket: string, path: string, bytes: Buffer, contentType: string): Promise<{ ok: true } | { ok: false; exists: boolean; error: string }> {
		const res = await this.send(target, 'POST', `/v1/files/file/${encodeURIComponent(bucket)}/${encodeStoragePath(path)}`, bytes, {
			'Content-Type': contentType || mimeFor(path),
			'x-upsert': 'false',
		});
		if (res.ok) {
			return { ok: true };
		}
		const body = parse(res.text);
		const exists = res.status === 409 || /already exists|duplicate/i.test(res.text);
		return { ok: false, exists, error: apiErrorMessage(body, res.text, res.status) };
	}

	/** One object to a file on this computer. */
	async download(target: ProjectTarget, bucket: string, path: string, file: string): Promise<ProjectActionOutcome> {
		const res = await this.send(target, 'GET', `/v1/files/file/${encodeURIComponent(bucket)}/${encodeStoragePath(path)}`, undefined, {}, true);
		if (!res.ok || !res.bytes) {
			return { ok: false, message: `Could not download it: ${apiErrorMessage(parse(res.text), res.text, res.status)}` };
		}
		writeFileSync(file, Buffer.from(res.bytes));
		return { ok: true, message: `Saved to ${file}.` };
	}
}

function parse(text: string): unknown {
	try {
		return text ? JSON.parse(text) : null;
	} catch {
		return null;
	}
}

export function encodeStoragePath(path: string): string {
	return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/** Enough of a content type for storage to serve a file back as what it is. */
function mimeFor(name: string): string {
	const types: Record<string, string> = {
		'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
		'.svg': 'image/svg+xml', '.avif': 'image/avif', '.pdf': 'application/pdf', '.json': 'application/json',
		'.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
		'.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.zip': 'application/zip',
	};
	return types[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

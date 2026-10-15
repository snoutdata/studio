/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DB_LAYOUT_SQL, platformSql, type Vocabulary } from '../../shared/ownLayout';
import { projectKey, type ProjectApiRequest, type ProjectTarget } from '../../shared/projects';

// What a project's sections send, local or cloud (shared/projects.ts): SQL that main runs as the
// project owner, and gateway calls that main signs with the service key. The quoting is
// the dashboard's, because the statements are the dashboard's: there is
// no parameter array on the way through, so every value is inlined by `pgLiteral`.

/** Anything below space, plus DEL. A loop, so the check survives editors that rewrite escapes. */
function hasControl(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 32 || code === 127) {
			return true;
		}
	}
	return false;
}

/** A value as a Postgres literal. `standard_conforming_strings` is on, so doubling the quote is the whole escape. */
export function pgLiteral(value: string | number | boolean): string {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new Error(`${value} cannot be a SQL literal`);
		}
		return String(value);
	}
	if (typeof value === 'boolean') {
		return value ? 'true' : 'false';
	}
	if (hasControl(value)) {
		throw new Error("That value contains a control character and will not be sent as a literal.");
	}
	return `'${value.replace(/'/g, "''")}'`;
}

/** An identifier, always quoted, so case and reserved words survive. */
export function pgIdent(name: string): string {
	if (hasControl(name)) {
		throw new Error("That identifier cannot be used.");
	}
	return `"${name.replace(/"/g, '""')}"`;
}

/** Text as a dollar-quoted literal (a command for pg_cron, a function body), with a tag the text cannot close. */
export function pgDollar(text: string): string {
	let tag = 'cmd';
	for (let i = 0; text.includes(`$${tag}$`); i++) {
		tag = `cmd${i}`;
	}
	return `$${tag}$${text}$${tag}$`;
}

/** `ilike` text with its own wildcards escaped, wrapped in `%`. */
export function ilikeNeedle(needle: string): string {
	return `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Rows of a statement, or the database's own error as a thrown Error. */
export async function query<T>(target: ProjectTarget, sql: string): Promise<T[]> {
	const result = await window.sqlApi.project.sql(target, sql);
	if (!result.ok) {
		throw new Error(result.error ?? "The statement failed.");
	}
	return result.rows as unknown as T[];
}

/** Each project's database layout, asked once a session (a failed ask is asked again next time). */
const layouts = new Map<string, Promise<Vocabulary>>();

function dbLayout(target: ProjectTarget): Promise<Vocabulary> {
	const key = projectKey(target);
	let layout = layouts.get(key);
	if (!layout) {
		layout = query<{ layout: string }>(target, DB_LAYOUT_SQL).then((rows) => (rows[0]?.layout === 'old' ? 'old' : 'new'));
		layouts.set(key, layout);
		layout.catch(() => layouts.delete(key));
	}
	return layout;
}

/** A statement on the platform's own tables, written in our layout's names (`snout_identity.people`,
 *  `snout_files.files`, ...) and sent in the names this project's database has (shared/ownLayout.ts). */
export async function platformQuery<T>(target: ProjectTarget, sql: string): Promise<T[]> {
	return query<T>(target, platformSql(sql, await dbLayout(target)));
}

/**
 * A json/jsonb cell as an object, whichever way it arrived.
 *
 * A local project's `pg` driver parses json into an object; `cloud-project-sql` sends every
 * object as its JSON TEXT (its `asJsonRow`). Reading `.series` off a string gave the Time series
 * section rows of blanks, and React duplicate keys, on every cloud project.
 */
export function jsonCell<T = Record<string, unknown>>(value: unknown): T {
	if (typeof value === 'string') {
		try {
			return JSON.parse(value) as T;
		} catch {
			return {} as T;
		}
	}
	return (value ?? {}) as T;
}

/** A statement whose rows nobody reads. */
export async function exec(target: ProjectTarget, sql: string): Promise<void> {
	await query(target, sql);
}

/** A gateway call with the service key (added in main), or the service's own refusal as a thrown Error. */
export async function api<T>(target: ProjectTarget, request: ProjectApiRequest): Promise<T> {
	const res = await window.sqlApi.project.api(target, request);
	if (!res.ok) {
		throw new Error(res.error ?? `HTTP ${res.status}`);
	}
	return res.body as T;
}

export function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export function bytes(n: number | string | null | undefined): string {
	const v = n === null || n === undefined ? NaN : Number(n);
	if (!Number.isFinite(v)) {
		return "";
	}
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = v;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function when(value: unknown): string {
	if (value === null || value === undefined || value === '') {
		return "never";
	}
	const date = value instanceof Date ? value : new Date(String(value));
	return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

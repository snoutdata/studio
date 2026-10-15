/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copying a whole project between this computer and SnoutData Cloud. A project is more than its
// database, so a copy is five PARTS run in one order, each by the door that owns it:
//
//   users      auth.users read as the owner, created on the target by auth's admin API with the
//              same id and the same password hash, so a person signs in there as they did here.
//   database   the Move: its preflight, its runner, its row counts. The platform's own schemas
//              are left out, because the other parts carry what is in them.
//   files      every bucket and object, through both gateways with the service key.
//   functions  the local project's `functions/` folder, deployed to the cloud project.
//   secrets    `functions/.env`, set on the cloud project. Values never leave main.
//
// Users go BEFORE the database: a customer's table that references auth.users would otherwise
// lose its foreign key on the target, since pg_restore adds the constraint after the data and the
// referenced users would not be there yet.
//
// Cloud never hands back a function's source or a secret's value, so those two parts only run
// from this computer to the cloud, and the other direction says so instead of pretending.
//
// Types and pure helpers only; the copying is main's (src/main/projectCopy.ts).

import type { MoveSpec } from '@snout/move';
import type { MoveCheck } from './move';
import type { ProjectTarget } from './projects';

export type ProjectCopyPart = 'users' | 'database' | 'files' | 'functions' | 'secrets';

/** The order the parts run in, which is also the order the screen lists them. */
export const PROJECT_COPY_PARTS: readonly ProjectCopyPart[] = ['users', 'database', 'files', 'functions', 'secrets'];

export const PART_TITLE: Record<ProjectCopyPart, string> = {
	users: "Users",
	database: "Database",
	files: "Files",
	functions: "Functions",
	secrets: "Function secrets",
};

/** Where a copy goes: a project that exists, or a cloud project made when the copy starts. */
export type ProjectCopyDestination = ProjectTarget | { kind: 'newCloud'; name: string; region: string };

export interface ProjectCopyRequest {
	/** Also the database move's id, so its spec and its run are found by the same key. */
	readonly id: string;
	readonly source: ProjectTarget;
	readonly target: ProjectCopyDestination;
	readonly parts: readonly ProjectCopyPart[];
}

export interface ProjectCopyPartCheck {
	readonly part: ProjectCopyPart;
	/** False when this pair of projects cannot copy this part at all. */
	readonly available: boolean;
	/** What will be copied, or why nothing can be: "12 users", "3 buckets, 240 files". */
	readonly summary: string;
	/** What a person should know before starting: what is skipped, what is replaced. */
	readonly notes: readonly string[];
	/** A reason this part cannot start as things are, in a sentence. */
	readonly problem: string | null;
}

export interface ProjectCopyCheck {
	readonly parts: readonly ProjectCopyPartCheck[];
	/** The database part's move and its preflight, when the database is copied. */
	readonly database: { readonly spec: MoveSpec; readonly check: MoveCheck } | null;
	/** The Postgres tools the database part runs are not installed yet. */
	readonly toolsMissing: boolean;
	readonly sourceLabel: string;
	readonly targetLabel: string;
	/** The name to type before starting, when the target is production. Null otherwise. */
	readonly confirmName: string | null;
	/** What is never copied, for the review: keys, sign-in settings. */
	readonly notCopied: readonly string[];
	/** Why the check could not run, in a sentence. */
	readonly error: string | null;
}

export type PartState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';

export interface PartProgress {
	readonly part: ProjectCopyPart;
	readonly state: PartState;
	/** A sentence about right now, or the part's outcome once it has finished. */
	readonly message: string;
	readonly done: number;
	readonly total: number | null;
	/** What did not copy, by name, so the report can say which. */
	readonly failures: readonly string[];
}

export interface ProjectCopyProgress {
	readonly id: string;
	readonly running: boolean;
	/** A step before the parts: making the cloud project, switching its services on. */
	readonly preparing: string | null;
	readonly parts: readonly PartProgress[];
	/** The database part's move run, so its own progress can be shown. */
	readonly moveRunId: string | null;
	/** Set once it has finished: whether every part did what it was asked. */
	readonly ok: boolean | null;
	readonly error: string | null;
	/** The project the copy went to, once it exists (a new cloud project has no ref before Start). */
	readonly target: ProjectTarget | null;
}

export type ProjectCopyStartOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Why a part cannot be copied between these two kinds of project, or null when it can. */
export function partUnavailable(part: ProjectCopyPart, source: ProjectTarget['kind'], target: ProjectTarget['kind']): string | null {
	if (source === target) {
		return "A copy goes between this computer and SnoutData Cloud.";
	}
	if (part === 'functions' && source === 'cloud') {
		return "SnoutData Cloud does not give a function's source back. Put your functions in the local project's functions folder from your own copy.";
	}
	if (part === 'secrets' && source === 'cloud') {
		return "SnoutData Cloud never shows a secret's value, so there is nothing to copy. Set them in the local project's Functions section.";
	}
	return null;
}

/** What a copy never takes, in the review's words. */
export function notCopied(source: ProjectTarget['kind']): string[] {
	return [
		"The API keys and the database password: each project has its own. Point your app at the new project's URL and app key.",
		"Sign-in settings (Google, GitHub, the mail server, redirect addresses, email templates). Set them on the new project.",
		...(source === 'cloud' ? ["Functions and their secrets: SnoutData Cloud does not give them back."] : []),
	];
}

// --- users ---------------------------------------------------------------------------------------

/** One auth.users row, as `to_jsonb(u)` gives it. Every field is optional: auth's columns vary by version. */
export interface AuthUserRow {
	id?: string;
	email?: string | null;
	encrypted_password?: string | null;
	email_confirmed_at?: string | null;
	raw_user_meta_data?: Record<string, unknown> | null;
	raw_app_meta_data?: Record<string, unknown> | null;
	role?: string | null;
	is_anonymous?: boolean | null;
	is_sso_user?: boolean | null;
	deleted_at?: string | null;
}

/** The body auth's admin API takes to create this user on the target, or why it is not copied. */
export type UserCreate = { ok: true; email: string; body: Record<string, unknown> } | { ok: false; reason: string };

const HASH = /^\$(2[abxy]?|argon2(id|i|d))\$/;

/** App metadata auth writes for itself; the target's auth writes its own. */
const AUTH_OWNED_APP_META = new Set(['provider', 'providers']);

export function userCreateBody(row: AuthUserRow): UserCreate {
	const email = typeof row.email === 'string' ? row.email.trim() : '';
	if (!row.id) {
		return { ok: false, reason: "has no id" };
	}
	if (row.deleted_at) {
		return { ok: false, reason: "was deleted" };
	}
	if (row.is_anonymous) {
		return { ok: false, reason: "is an anonymous sign-in" };
	}
	if (row.is_sso_user) {
		return { ok: false, reason: "signs in with single sign-on" };
	}
	if (!email) {
		return { ok: false, reason: "has no email address (phone sign-in is not copied)" };
	}
	const body: Record<string, unknown> = { id: row.id, email, email_confirm: Boolean(row.email_confirmed_at) };
	const hash = typeof row.encrypted_password === 'string' ? row.encrypted_password : '';
	if (HASH.test(hash)) {
		body.password_hash = hash;
	}
	// The operator API's field names in the earlier layout: every identity server reads them, the
	// current one beside `profile_data`/`server_data`, and the stack Studio pins
	// reads only these.
	if (row.raw_user_meta_data && Object.keys(row.raw_user_meta_data).length > 0) {
		body.user_metadata = row.raw_user_meta_data;
	}
	const app = Object.fromEntries(Object.entries(row.raw_app_meta_data ?? {}).filter(([key]) => !AUTH_OWNED_APP_META.has(key)));
	if (Object.keys(app).length > 0) {
		body.app_metadata = app;
	}
	// The default member role, under its earlier name or ours, is the server's to set.
	if (row.role && row.role !== 'authenticated' && row.role !== 'snout_member') {
		body.role = row.role;
	}
	return { ok: true, email, body };
}

/** Whether auth refused a create because the user is already there, which a copy counts as done. */
export function isAlreadyThere(status: number, body: unknown): boolean {
	if (status !== 422 && status !== 409 && status !== 400) {
		return false;
	}
	const text = JSON.stringify(body ?? '').toLowerCase();
	return text.includes('email_exists') || text.includes('already been registered') || text.includes('already exists') || text.includes('duplicate key');
}

/** One page of users after `after` (keyset on id), as the owner reads them. */
export function usersPageSql(after: string | null, limit: number): string {
	const where = after ? `where u.id > '${after.replace(/'/g, "''")}'::uuid ` : '';
	return `select to_jsonb(u) as u from snout_identity.people u ${where}order by u.id limit ${limit}`;
}

// --- files ---------------------------------------------------------------------------------------

/** A bucket as storage's API lists it. */
export interface BucketRow {
	id: string;
	name: string;
	public?: boolean;
	file_size_limit?: number | null;
	allowed_mime_types?: string[] | null;
}

/** The body that makes the same bucket on the target. */
export function bucketCreateBody(bucket: BucketRow): Record<string, unknown> {
	return {
		id: bucket.id,
		name: bucket.name,
		public: bucket.public === true,
		...(bucket.file_size_limit ? { file_size_limit: bucket.file_size_limit } : {}),
		...(bucket.allowed_mime_types && bucket.allowed_mime_types.length > 0 ? { allowed_mime_types: bucket.allowed_mime_types } : {}),
	};
}

/** One entry of `POST /v1/files/file/list/<space>`: a folder has no id. */
export interface ListedObject {
	name: string;
	id: string | null;
	metadata?: { size?: number; mimetype?: string } | null;
}

export function isFolder(entry: ListedObject): boolean {
	return entry.id === null || entry.id === undefined;
}

export function joinPath(prefix: string, name: string): string {
	return prefix ? `${prefix}/${name}` : name;
}

// --- functions -----------------------------------------------------------------------------------

export interface FunctionFile {
	readonly path: string;
	readonly text: string;
}

/**
 * The bundle `cloud-project-functions` deploys, laid out as the snoutdata CLI lays it (its
 * `collectFunction`): the function's own files flat, or, when a `_shared` folder exists beside it,
 * `<name>/…` beside `_shared/…` so a `../_shared/x.ts` import resolves. The control plane re-checks
 * every rule, so a refusal there is the sentence a person sees.
 */
export function functionBundle(name: string, own: readonly FunctionFile[], shared: readonly FunctionFile[] | null): { snoutfn: 1; entrypoint: string; files: FunctionFile[] } {
	const sort = (files: FunctionFile[]): FunctionFile[] => files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	if (!shared || shared.length === 0) {
		return { snoutfn: 1, entrypoint: 'index.ts', files: sort([...own]) };
	}
	return {
		snoutfn: 1,
		entrypoint: `${name}/index.ts`,
		files: sort([...own.map((f) => ({ path: `${name}/${f.path}`, text: f.text })), ...shared.map((f) => ({ path: `_shared/${f.path}`, text: f.text }))]),
	};
}

/** Secret names the cloud refuses (`checkSecretName`'s reserved prefixes), so they are skipped by name. */
export function secretReserved(name: string): boolean {
	return name.startsWith('SNOUTDATA_') || name.startsWith('SNOUT_');
}

// --- wording -------------------------------------------------------------------------------------

export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

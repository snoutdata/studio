/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Copying a whole project between this computer and SnoutData Cloud (src/shared/projectCopy.ts has
 * the parts, their order and why). This is the running half: it reads one project through its two
 * doors (`ProjectAccess`: SQL as the owner, the gateway with the server key) and writes the other
 * through the same doors, the database through the Move's own runner, and functions and secrets
 * through the control plane, exactly the calls the CLI makes.
 *
 * Nothing destructive is a default. A user, a bucket or a file already on the target is left as it
 * is and counted; the database must be empty unless the Move's own review says otherwise; and a
 * production target asks for its name to be typed, checked again here.
 */

import { HOSTED_POSTGRES_PLATFORM, newMoveSpec, type MoveEndpoint, type MoveRunResult, type MoveSpec } from '@snout/move';
import type { ConnectionConfig } from '../shared/connection';
import type { ConnectionFormValues } from '../shared/forms';
import type { MoveCheck, MoveConfirmations, MoveStartOutcome } from '../shared/move';
import {
	PART_TITLE, PROJECT_COPY_PARTS, bucketCreateBody, functionBundle, isAlreadyThere, isFolder, joinPath, notCopied, partUnavailable, plural, secretReserved, userCreateBody, usersPageSql,
	type AuthUserRow, type BucketRow, type ListedObject, type PartProgress, type ProjectCopyCheck, type ProjectCopyDestination, type ProjectCopyPart, type ProjectCopyPartCheck,
	type ProjectCopyProgress, type ProjectCopyRequest, type ProjectCopyStartOutcome,
} from '../shared/projectCopy';
import type { ProjectTarget } from '../shared/projects';
import { detailFrom, type CloudApi, type CloudProjectSummary } from './cloudApi';
import { resolveSnoutdataCloudImport } from './cloudImport';
import type { LocalFunctionSource } from './localStack/service';
import { wakeProject, waitForReady } from './moveRunner';
import type { ProjectAccess } from './projectAccess';

export interface ProjectCopyDeps {
	access: ProjectAccess;
	cloud: CloudApi;
	local: {
		describe(id: string): { name: string; production: boolean };
		functionSources(id: string): LocalFunctionSource[];
		functionSecretValues(id: string): [string, string][];
	};
	moves: {
		/** The stored spec for this id, so fixes made on an earlier check are kept. */
		get(id: string): MoveSpec | undefined;
		save(spec: MoveSpec): MoveSpec;
		check(spec: MoveSpec): Promise<MoveCheck>;
		start(spec: MoveSpec, typed: MoveConfirmations): Promise<MoveStartOutcome>;
		wait(moveId: string): Promise<MoveRunResult>;
		cancel(runId: string): boolean;
		toolsInstalled(): boolean;
	};
	connections(): ConnectionConfig[];
	saveConnection(values: ConnectionFormValues): ConnectionConfig;
	onProgress(progress: ProjectCopyProgress): void;
	sleep?(ms: number): Promise<void>;
}

/** Rows per read of auth.users: `cloud-project-sql` answers at most 500. */
const USERS_PAGE = 500;
/** Objects per page of storage's list. */
const LIST_PAGE = 1000;
/** How long a service just switched on may take to answer. */
const SERVICE_WAIT_MS = 5 * 60_000;

/** Why the platform's schemas are left out of the database part. */
const PLATFORM_REASON = "Part of the project's platform. Users and files are copied as parts of their own.";

interface Run {
	progress: ProjectCopyProgress;
	readonly controller: AbortController;
}

function sleepFor(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : detailFrom(err);
}

export class ProjectCopies {
	private readonly runs = new Map<string, Run>();

	constructor(private readonly deps: ProjectCopyDeps) {}

	anyRunning(): boolean {
		return [...this.runs.values()].some((run) => run.progress.running);
	}

	state(id: string): ProjectCopyProgress | null {
		return this.runs.get(id)?.progress ?? null;
	}

	cancel(id: string): boolean {
		const run = this.runs.get(id);
		if (!run || !run.progress.running) {
			return false;
		}
		run.controller.abort();
		if (run.progress.moveRunId) {
			this.deps.moves.cancel(run.progress.moveRunId);
		}
		return true;
	}

	// --- where things are --------------------------------------------------------------------------

	private async cloudRow(ref: string): Promise<CloudProjectSummary> {
		const row = (await this.deps.cloud.list()).find((p) => p.ref === ref);
		if (!row) {
			throw new Error("SnoutData Cloud does not list that project any more.");
		}
		return row;
	}

	private async labelOf(target: ProjectTarget): Promise<string> {
		return target.kind === 'local' ? this.deps.local.describe(target.id).name : (await this.cloudRow(target.ref)).name;
	}

	/** The saved connection a project's database is. A cloud project not imported yet is imported. */
	private async connectionOf(target: ProjectTarget): Promise<ConnectionConfig | null> {
		const all = this.deps.connections();
		if (target.kind === 'local') {
			return all.find((c) => c.localProjectId === target.id) ?? null;
		}
		const found = all.find((c) => c.cloudProjectRef === target.ref);
		if (found) {
			return found;
		}
		const [values] = await resolveSnoutdataCloudImport(this.deps.cloud, [{ file: 'snoutdata-cloud', connId: target.ref }], all);
		return values ? this.deps.saveConnection(values) : null;
	}

	private endpointOf(target: ProjectTarget, connection: ConnectionConfig): MoveEndpoint {
		return target.kind === 'cloud' ? { kind: 'cloud', ref: target.ref, driver: 'postgres' } : { kind: 'connection', id: connection.id, driver: connection.driver };
	}

	/**
	 * The database part's move: every schema of the user's, the platform's own left out (the other
	 * parts carry what is in them). An earlier spec for this copy is kept, so a fix made on the
	 * review is not undone by checking again.
	 */
	private databaseSpec(request: ProjectCopyRequest, source: MoveEndpoint, target: MoveEndpoint, name: string): MoveSpec {
		const stored = this.deps.moves.get(request.id);
		const sameEnds = stored && JSON.stringify(stored.source) === JSON.stringify(source) && JSON.stringify(stored.target) === JSON.stringify(target);
		const base = sameEnds ? stored : newMoveSpec({ id: request.id, name, source, target });
		const excluded = new Set(base.selection.excludeSchemas.map((e) => e.schema));
		const excludedExt = new Set(base.selection.excludeExtensions.map((e) => e.extension));
		return {
			...base,
			status: 'draft',
			selection: {
				...base.selection,
				excludeSchemas: [...base.selection.excludeSchemas, ...HOSTED_POSTGRES_PLATFORM.schemas.filter((s) => !excluded.has(s)).map((schema) => ({ schema, reason: PLATFORM_REASON }))],
				excludeExtensions: [...base.selection.excludeExtensions, ...HOSTED_POSTGRES_PLATFORM.extensions.filter((e) => !excludedExt.has(e)).map((extension) => ({ extension, reason: PLATFORM_REASON }))],
			},
		};
	}

	// --- the check ---------------------------------------------------------------------------------

	async check(request: ProjectCopyRequest): Promise<ProjectCopyCheck> {
		const empty = (error: string): ProjectCopyCheck => ({ parts: [], database: null, toolsMissing: false, sourceLabel: '', targetLabel: '', confirmName: null, notCopied: [], error });
		const { source, target } = request;
		const targetKind = target.kind === 'newCloud' ? 'cloud' : target.kind;
		if (source.kind === targetKind) {
			return empty("A copy goes between this computer and SnoutData Cloud.");
		}
		const sleep = this.deps.sleep ?? sleepFor;
		try {
			const sourceLabel = await this.labelOf(source);
			const targetLabel = target.kind === 'newCloud' ? target.name.trim() : await this.labelOf(target);
			if (!targetLabel) {
				return empty("Give the new project a name.");
			}
			// A paused cloud project cannot be read; the Move wakes one the same way.
			for (const end of [source, target]) {
				if (end.kind === 'cloud') {
					await wakeProject(this.deps.cloud, end.ref, await this.labelOf(end), () => undefined, sleep);
				}
			}
			const sourceConnection = await this.connectionOf(source);
			const targetConnection = target.kind === 'newCloud' ? null : await this.connectionOf(target);

			const parts: ProjectCopyPartCheck[] = [];
			let database: ProjectCopyCheck['database'] = null;
			for (const part of PROJECT_COPY_PARTS) {
				const unavailable = partUnavailable(part, source.kind, targetKind);
				if (unavailable) {
					parts.push({ part, available: false, summary: unavailable, notes: [], problem: null });
					continue;
				}
				// A part nobody asked for is not read: the database's check alone reads both databases.
				if (!request.parts.includes(part)) {
					continue;
				}
				if (part === 'database') {
					if (!sourceConnection) {
						parts.push({ part, available: true, summary: "Not readable", notes: [], problem: `"${sourceLabel}" has no saved connection for its database. Open its Database section to add one.` });
						continue;
					}
					if (target.kind !== 'newCloud' && !targetConnection) {
						parts.push({ part, available: true, summary: "Not writable", notes: [], problem: `"${targetLabel}" has no saved connection for its database. Open its Database section to add one.` });
						continue;
					}
					const targetEnd: MoveEndpoint = target.kind === 'newCloud'
						? { kind: 'newCloudProject', name: targetLabel, region: target.region, driver: 'postgres' }
						: this.endpointOf(target, targetConnection as ConnectionConfig);
					const spec = this.deps.moves.save(this.databaseSpec(request, this.endpointOf(source, sourceConnection), targetEnd, `${sourceLabel} to ${targetLabel}`));
					const check = await this.deps.moves.check(spec);
					database = { spec, check };
					const decisions = check.findings.filter((f) => f.severity !== 'note' && f.resolvedBy === null).length;
					parts.push({
						part,
						available: true,
						summary: check.error ? "Could not be checked" : "Your schemas, tables and data",
						notes: check.findings.length > 0 ? [plural(check.findings.length, 'finding') + (decisions > 0 ? `, ${decisions} to decide below` : '')] : [],
						problem: check.error ?? (check.ready ? null : "The database has findings to decide below."),
					});
					continue;
				}
				parts.push(await this.checkPart(part, source, target, targetLabel));
			}
			const toolsMissing = request.parts.includes('database') && !this.deps.moves.toolsInstalled();
			const production = target.kind === 'local'
				? this.deps.local.describe(target.id).production || targetConnection?.environment === 'prod'
				: target.kind === 'cloud'
					? (await this.cloudRow(target.ref)).production || targetConnection?.environment === 'prod'
					: false;
			return {
				parts,
				database,
				toolsMissing,
				sourceLabel,
				targetLabel,
				confirmName: production ? targetConnection?.label ?? targetLabel : null,
				notCopied: notCopied(source.kind),
				error: null,
			};
		} catch (err) {
			return empty(errorText(err));
		}
	}

	private async checkPart(part: Exclude<ProjectCopyPart, 'database'>, source: ProjectTarget, target: ProjectCopyDestination, targetLabel: string): Promise<ProjectCopyPartCheck> {
		const { access } = this.deps;
		const ok = (summary: string, notes: string[] = [], problem: string | null = null): ProjectCopyPartCheck => ({ part, available: true, summary, notes, problem });
		try {
			if (part === 'users') {
				const counted = await access.platformSql(source, `select count(*)::int as total,
	count(*) filter (where (to_jsonb(u)->>'deleted_at') is null and coalesce((to_jsonb(u)->>'is_anonymous')::boolean, false) = false and coalesce(u.email, '') <> '')::int as copied,
	count(*) filter (where coalesce(to_jsonb(u)->>'encrypted_password', '') like '$%')::int as passwords
from snout_identity.people u`);
				if (!counted.ok) {
					return /does not exist/i.test(counted.error ?? '')
						? ok("None: sign-in is off on the source")
						: ok("Not readable", [], `Users could not be read: ${counted.error}`);
				}
				const row = counted.rows[0] ?? {};
				const total = Number(row.total ?? 0);
				const copied = Number(row.copied ?? 0);
				const notes = ["A user whose email is already on the target is left as it is."];
				if (total > copied) {
					notes.push(`${plural(total - copied, 'user')} without an email (anonymous, phone or deleted) stay behind.`);
				}
				if (Number(row.passwords ?? 0) > 0) {
					notes.push("Passwords come across as they are stored, so people sign in with the ones they have.");
				}
				if (target.kind !== 'local' && copied > 0 && !(await this.cloudServiceOn(target, 'auth'))) {
					notes.push(`Sign-in is switched on for "${targetLabel}".`);
				}
				return ok(copied === 0 ? "No users to copy" : plural(copied, 'user'), notes);
			}
			if (part === 'files') {
				const buckets = await access.api(source, { method: 'GET', path: '/v1/files/space' });
				if (!buckets.ok || !Array.isArray(buckets.body)) {
					return source.kind === 'cloud' && !(await this.cloudServiceOn(source, 'storage'))
						? ok("None: storage is off on the source")
						: ok("Not readable", [], `Files could not be listed: ${buckets.error ?? 'no answer'}`);
				}
				const list = buckets.body as BucketRow[];
				const counted = await access.platformSql(source, 'select count(*)::int as files, coalesce(sum((metadata->>\'size\')::bigint), 0)::bigint as bytes from snout_files.files');
				const files = counted.ok ? Number(counted.rows[0]?.files ?? 0) : null;
				const bytes = counted.ok ? Number(counted.rows[0]?.bytes ?? 0) : null;
				const notes = ["A bucket or a file already on the target is left as it is."];
				let problem: string | null = null;
				if (target.kind !== 'local' && list.length > 0) {
					const storage = target.kind === 'cloud' ? await this.cloudStorage(target.ref) : null;
					if (!storage?.enabled) {
						notes.push(`Storage is switched on for "${targetLabel}".`);
					}
					if (storage?.max !== null && storage?.max !== undefined && bytes !== null && bytes + (storage.used ?? 0) > storage.max) {
						problem = `The files are ${megabytes(bytes)} and "${targetLabel}" has room for ${megabytes(Math.max(0, storage.max - (storage.used ?? 0)))} on its plan.`;
					}
				}
				const what = `${plural(list.length, 'bucket')}${files === null ? '' : `, ${plural(files, 'file')}`}${bytes ? ` (${megabytes(bytes)})` : ''}`;
				return ok(list.length === 0 ? "No buckets" : what, notes, problem);
			}
			if (part === 'functions' && source.kind === 'local') {
				const sources = this.deps.local.functionSources(source.id);
				const broken = sources.filter((s) => s.problem);
				const existing = target.kind === 'cloud' ? await this.cloudFunctionNames(target.ref) : [];
				const replaced = sources.filter((s) => existing.includes(s.name)).map((s) => s.name);
				const notes = [
					...(replaced.length > 0 ? [`Replaces ${replaced.join(', ')} on the target with this computer's version.`] : []),
					...broken.map((s) => `${s.name} is not sent: ${s.problem}`),
				];
				return ok(sources.length === 0 ? "No functions" : plural(sources.length - broken.length, 'function'), notes);
			}
			if (part === 'secrets' && source.kind === 'local') {
				const all = this.deps.local.functionSecretValues(source.id);
				const reserved = all.filter(([name]) => secretReserved(name)).map(([name]) => name);
				const notes = [
					"A secret with the same name on the target is replaced. Values go from this computer to SnoutData Cloud and are never shown.",
					...(reserved.length > 0 ? [`${reserved.join(', ')} ${reserved.length === 1 ? 'is reserved on SnoutData Cloud and stays' : 'are reserved on SnoutData Cloud and stay'} behind.`] : []),
				];
				return ok(all.length === reserved.length ? "No secrets" : plural(all.length - reserved.length, 'secret'), notes);
			}
			return { part, available: false, summary: partUnavailable(part, source.kind, 'local') ?? '', notes: [], problem: null };
		} catch (err) {
			return ok("Could not be checked", [], errorText(err));
		}
	}

	private async cloudServiceOn(target: ProjectCopyDestination, service: 'auth' | 'storage'): Promise<boolean> {
		if (target.kind !== 'cloud') {
			return false;
		}
		if (service === 'storage') {
			return (await this.cloudStorage(target.ref)).enabled;
		}
		const answer = await this.deps.cloud.request<{ enabled?: boolean }>('cloud-project-auth', { ref: target.ref, action: 'status' });
		return answer.enabled === true;
	}

	private async cloudStorage(ref: string): Promise<{ enabled: boolean; used: number | null; max: number | null }> {
		const answer = await this.deps.cloud.request<{ storage?: { enabled: boolean; bytes: number | null; limit?: { maxFilesBytes: number | null } } }>('cloud-project-storage', { ref });
		return { enabled: answer.storage?.enabled === true, used: answer.storage?.bytes ?? null, max: answer.storage?.limit?.maxFilesBytes ?? null };
	}

	private async cloudFunctionNames(ref: string): Promise<string[]> {
		const answer = await this.deps.cloud.request<{ functions?: { name: string }[] }>('cloud-project-functions', { ref });
		return (answer.functions ?? []).map((f) => f.name);
	}

	// --- the run -----------------------------------------------------------------------------------

	async start(request: ProjectCopyRequest, typed: string | undefined): Promise<ProjectCopyStartOutcome> {
		if (this.runs.get(request.id)?.progress.running) {
			return { ok: false, error: "This copy is already running." };
		}
		const parts = PROJECT_COPY_PARTS.filter((p) => request.parts.includes(p));
		if (parts.length === 0) {
			return { ok: false, error: "Choose at least one part to copy." };
		}
		// Checked again here: a review read a minute ago is not a licence to write to a target that
		// has changed since (the same rule as a Move, for the whole project).
		const check = await this.check(request);
		if (check.error) {
			return { ok: false, error: check.error };
		}
		for (const part of parts) {
			const found = check.parts.find((p) => p.part === part);
			if (found && found.available && found.problem) {
				return { ok: false, error: `${PART_TITLE[part]}: ${found.problem}` };
			}
		}
		if (parts.includes('database') && check.toolsMissing) {
			return { ok: false, error: "The Postgres tools the database copy runs are not installed yet." };
		}
		if (check.confirmName && typed !== check.confirmName) {
			return { ok: false, error: `The target is a production project. Type "${check.confirmName}" to start the copy.` };
		}

		const run: Run = {
			controller: new AbortController(),
			progress: {
				id: request.id,
				running: true,
				preparing: null,
				parts: parts
					.filter((part) => check.parts.find((p) => p.part === part)?.available !== false)
					.map((part) => ({ part, state: 'waiting', message: "Waiting", done: 0, total: null, failures: [] })),
				moveRunId: null,
				ok: null,
				error: null,
				target: request.target.kind === 'newCloud' ? null : request.target,
			},
		};
		this.runs.set(request.id, run);
		this.emit(run);
		void this.run(request, check, run, typed).catch((err: unknown) => {
			this.finish(run, false, errorText(err));
		});
		return { ok: true };
	}

	private emit(run: Run): void {
		this.deps.onProgress(run.progress);
	}

	private set(run: Run, change: Partial<ProjectCopyProgress>): void {
		run.progress = { ...run.progress, ...change };
		this.emit(run);
	}

	private part(run: Run, part: ProjectCopyPart, change: Partial<PartProgress>): void {
		run.progress = { ...run.progress, parts: run.progress.parts.map((p) => (p.part === part ? { ...p, ...change } : p)) };
		this.emit(run);
	}

	private finish(run: Run, ok: boolean, error: string | null): void {
		this.set(run, {
			running: false,
			preparing: null,
			ok,
			error,
			parts: run.progress.parts.map((p) => (p.state === 'waiting' || p.state === 'running' ? { ...p, state: 'skipped', message: run.controller.signal.aborted ? "Stopped" : "Not reached" } : p)),
		});
	}

	private async run(request: ProjectCopyRequest, check: ProjectCopyCheck, run: Run, typed: string | undefined): Promise<void> {
		const { deps } = this;
		const sleep = deps.sleep ?? sleepFor;
		const signal = run.controller.signal;
		const wanted = new Set(run.progress.parts.map((p) => p.part));

		// The target, made now if it is new. Nothing is created by choosing or checking.
		let target: ProjectTarget;
		if (request.target.kind === 'newCloud') {
			const name = request.target.name.trim();
			this.set(run, { preparing: `Creating the SnoutData Cloud project "${name}"` });
			const { project } = await deps.cloud.create(name, request.target.region);
			await waitForReady(deps.cloud, project.ref, name, (message) => this.set(run, { preparing: message }), sleep);
			target = { kind: 'cloud', ref: project.ref };
			this.set(run, { target });
			await this.connectionOf(target);
		} else {
			target = request.target;
		}
		const source = request.source;
		for (const [end, label] of [[source, check.sourceLabel], [target, check.targetLabel]] as const) {
			if (end.kind === 'cloud') {
				await wakeProject(deps.cloud, end.ref, label, (message) => this.set(run, { preparing: message }), sleep);
			}
		}

		// Services a part needs, switched on before it runs.
		if (target.kind === 'cloud') {
			if (wanted.has('users') && !(await this.cloudServiceOn(target, 'auth'))) {
				this.set(run, { preparing: `Switching sign-in on for "${check.targetLabel}"` });
				await deps.cloud.request('cloud-project-auth', { ref: target.ref, action: 'enable' });
			}
			if (wanted.has('files') && !(await this.cloudServiceOn(target, 'storage'))) {
				this.set(run, { preparing: `Switching storage on for "${check.targetLabel}"` });
				await deps.cloud.request('cloud-project-storage', { ref: target.ref, enable: true });
			}
			if (wanted.has('users')) {
				await this.waitForService(run, target, '/v1/identity/operator/people?page=1&per_page=1', "sign-in", sleep);
			}
			if (wanted.has('files')) {
				await this.waitForService(run, target, '/v1/files/space', "storage", sleep);
			}
		}
		this.set(run, { preparing: null });

		let allOk = true;
		for (const { part } of run.progress.parts) {
			if (signal.aborted) {
				break;
			}
			this.part(run, part, { state: 'running', message: "Starting" });
			try {
				const outcome = part === 'users' ? await this.copyUsers(run, source, target)
					: part === 'database' ? await this.copyDatabase(run, request, check, target, typed)
						: part === 'files' ? await this.copyFiles(run, source, target)
							: part === 'functions' ? await this.copyFunctions(run, source, target)
								: await this.copySecrets(run, source, target);
				allOk &&= outcome;
			} catch (err) {
				allOk = false;
				this.part(run, part, { state: 'failed', message: errorText(err) });
			}
		}
		this.finish(run, allOk && !signal.aborted, signal.aborted ? "Stopped. What was copied before that stays on the target." : null);
	}

	private async waitForService(run: Run, target: ProjectTarget, path: string, what: string, sleep: (ms: number) => Promise<void>): Promise<void> {
		const deadline = Date.now() + SERVICE_WAIT_MS;
		for (;;) {
			const answer = await this.deps.access.api(target, { method: 'GET', path });
			if (answer.ok) {
				return;
			}
			if (Date.now() > deadline || run.controller.signal.aborted) {
				throw new Error(`The target's ${what} did not answer: ${answer.error ?? `status ${answer.status}`}`);
			}
			this.set(run, { preparing: `Waiting for the target's ${what} to start` });
			await sleep(3000);
		}
	}

	private async copyUsers(run: Run, source: ProjectTarget, target: ProjectTarget): Promise<boolean> {
		const { access } = this.deps;
		const failures: string[] = [];
		let created = 0;
		let there = 0;
		let left = 0;
		let after: string | null = null;
		for (;;) {
			if (run.controller.signal.aborted) {
				return false;
			}
			const page = await access.platformSql(source, usersPageSql(after, USERS_PAGE), USERS_PAGE);
			if (!page.ok) {
				throw new Error(`Users could not be read: ${page.error}`);
			}
			for (const record of page.rows) {
				const row = (record.u ?? {}) as AuthUserRow;
				after = row.id ?? after;
				const plan = userCreateBody(row);
				if (!plan.ok) {
					left++;
					continue;
				}
				const answer = await access.api(target, { method: 'POST', path: '/v1/identity/operator/people', body: plan.body });
				if (answer.ok) {
					created++;
				} else if (isAlreadyThere(answer.status, answer.body)) {
					there++;
				} else {
					failures.push(`${plan.email}: ${answer.error ?? answer.status}`);
				}
				this.part(run, 'users', { done: created + there + failures.length, message: `Copying users: ${plural(created, 'created')}` });
			}
			if (page.rows.length < USERS_PAGE) {
				break;
			}
		}
		const sentence = [
			plural(created, 'user') + ' copied',
			there > 0 ? `${there.toLocaleString()} already there` : '',
			left > 0 ? `${left.toLocaleString()} without an email left behind` : '',
			failures.length > 0 ? `${failures.length.toLocaleString()} refused` : '',
		].filter(Boolean).join(', ');
		this.part(run, 'users', { state: failures.length > 0 ? 'failed' : 'done', message: `${sentence}.`, failures, total: created + there + failures.length });
		return failures.length === 0;
	}

	private async copyDatabase(run: Run, request: ProjectCopyRequest, check: ProjectCopyCheck, target: ProjectTarget, typed: string | undefined): Promise<boolean> {
		const { moves } = this.deps;
		let spec = check.database?.spec;
		if (!spec) {
			throw new Error("The database was not checked.");
		}
		// A new cloud project exists now: the move writes to it, and is checked against it.
		if (request.target.kind === 'newCloud' && target.kind === 'cloud') {
			spec = moves.save({ ...spec, target: { kind: 'cloud', ref: target.ref, driver: 'postgres' } });
			const again = await moves.check(spec);
			if (!again.ready) {
				const first = again.error ?? again.findings.find((f) => f.severity !== 'note' && f.resolvedBy === null)?.sentence ?? "it needs a decision";
				throw new Error(`The new project was made, but its database needs a look before anything is copied into it: ${first} Open the copy again to decide.`);
			}
		}
		this.part(run, 'database', { message: "Starting the copy" });
		const started = await moves.start(spec, { target: typed });
		if (!started.ok) {
			throw new Error(started.error);
		}
		this.set(run, { moveRunId: started.runId });
		const result = await moves.wait(spec.id);
		const tables = result.tables.length;
		const failures = [
			...result.failures.map((f) => (f.object ? `${f.object}: ${f.message}` : f.message)),
			...result.tables.filter((t) => !t.matches).map((t) => `${t.schema}.${t.table}: ${t.sourceRows ?? '?'} rows here, ${t.targetRows ?? 'none'} there`),
		];
		if (result.status === 'success') {
			this.part(run, 'database', { state: 'done', message: `${plural(tables, 'table')} copied, row counts match.`, failures });
			return true;
		}
		if (result.status === 'partial') {
			this.part(run, 'database', { state: 'failed', message: `Copied, but ${plural(failures.length, 'thing')} did not come across as it was. The details are below.`, failures });
			return false;
		}
		this.part(run, 'database', { state: 'failed', message: result.error ?? (result.status === 'cancelled' ? "Stopped" : "The database copy failed."), failures });
		return false;
	}

	private async copyFiles(run: Run, source: ProjectTarget, target: ProjectTarget): Promise<boolean> {
		const { access } = this.deps;
		const listed = await access.api(source, { method: 'GET', path: '/v1/files/space' });
		if (!listed.ok || !Array.isArray(listed.body)) {
			this.part(run, 'files', { state: 'skipped', message: "No buckets to copy." });
			return true;
		}
		const buckets = listed.body as BucketRow[];
		const failures: string[] = [];
		let copied = 0;
		let there = 0;
		let bytes = 0;
		for (const bucket of buckets) {
			const exists = await access.api(target, { method: 'GET', path: `/v1/files/space/${encodeURIComponent(bucket.id)}` });
			if (!exists.ok) {
				const made = await access.api(target, { method: 'POST', path: '/v1/files/space', body: bucketCreateBody(bucket) });
				if (!made.ok && !isAlreadyThere(made.status, made.body)) {
					failures.push(`bucket ${bucket.name}: ${made.error ?? made.status}`);
					continue;
				}
			}
			// Depth first through the folders, a page at a time.
			const pending: string[] = [''];
			while (pending.length > 0) {
				const prefix = pending.pop() as string;
				for (let offset = 0; ; offset += LIST_PAGE) {
					if (run.controller.signal.aborted) {
						return false;
					}
					const page = await access.api(source, {
						method: 'POST',
						path: `/v1/files/file/list/${encodeURIComponent(bucket.id)}`,
						body: { prefix, limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } },
					});
					if (!page.ok || !Array.isArray(page.body)) {
						failures.push(`${bucket.name}/${prefix}: ${page.error ?? 'could not be listed'}`);
						break;
					}
					const entries = page.body as ListedObject[];
					for (const entry of entries) {
						const path = joinPath(prefix, entry.name);
						if (isFolder(entry)) {
							pending.push(path);
							continue;
						}
						const read = await access.readObject(source, bucket.id, path);
						if (!read.ok) {
							failures.push(`${bucket.name}/${path}: ${read.error}`);
							continue;
						}
						const wrote = await access.writeObject(target, bucket.id, path, read.bytes, entry.metadata?.mimetype ?? '');
						if (wrote.ok) {
							copied++;
							bytes += read.bytes.length;
						} else if (wrote.exists) {
							there++;
						} else {
							failures.push(`${bucket.name}/${path}: ${wrote.error}`);
						}
						this.part(run, 'files', { done: copied + there + failures.length, message: `Copying ${bucket.name}/${path}` });
					}
					if (entries.length < LIST_PAGE) {
						break;
					}
				}
			}
		}
		const sentence = [
			`${plural(buckets.length, 'bucket')}, ${plural(copied, 'file')} copied${bytes ? ` (${megabytes(bytes)})` : ''}`,
			there > 0 ? `${there.toLocaleString()} already there` : '',
			failures.length > 0 ? `${failures.length.toLocaleString()} refused` : '',
		].filter(Boolean).join(', ');
		this.part(run, 'files', { state: failures.length > 0 ? 'failed' : 'done', message: `${sentence}.`, failures });
		return failures.length === 0;
	}

	private async copyFunctions(run: Run, source: ProjectTarget, target: ProjectTarget): Promise<boolean> {
		if (source.kind !== 'local' || target.kind !== 'cloud') {
			this.part(run, 'functions', { state: 'skipped', message: partUnavailable('functions', source.kind, target.kind) ?? "Not copied." });
			return true;
		}
		const sources = this.deps.local.functionSources(source.id);
		const failures: string[] = [];
		let deployed = 0;
		for (const fn of sources) {
			if (run.controller.signal.aborted) {
				return false;
			}
			if (fn.problem) {
				failures.push(`${fn.name}: ${fn.problem}`);
				continue;
			}
			this.part(run, 'functions', { message: `Deploying ${fn.name}`, done: deployed + failures.length, total: sources.length });
			try {
				await this.deps.cloud.request('cloud-project-functions', { ref: target.ref, action: 'deploy', name: fn.name, verifyJwt: fn.verifyJwt, bundle: functionBundle(fn.name, fn.own, fn.shared) });
				deployed++;
			} catch (err) {
				failures.push(`${fn.name}: ${errorText(err)}`);
			}
		}
		this.part(run, 'functions', {
			state: failures.length > 0 ? 'failed' : 'done',
			message: `${plural(deployed, 'function')} deployed${failures.length > 0 ? `, ${failures.length.toLocaleString()} not` : ''}.`,
			done: deployed + failures.length,
			total: sources.length,
			failures,
		});
		return failures.length === 0;
	}

	private async copySecrets(run: Run, source: ProjectTarget, target: ProjectTarget): Promise<boolean> {
		if (source.kind !== 'local' || target.kind !== 'cloud') {
			this.part(run, 'secrets', { state: 'skipped', message: partUnavailable('secrets', source.kind, target.kind) ?? "Not copied." });
			return true;
		}
		const all = this.deps.local.functionSecretValues(source.id).filter(([name]) => !secretReserved(name));
		const failures: string[] = [];
		let set = 0;
		for (const [name, value] of all) {
			if (run.controller.signal.aborted) {
				return false;
			}
			try {
				await this.deps.cloud.request('cloud-project-secrets', { ref: target.ref, action: 'set', name, value });
				set++;
			} catch (err) {
				failures.push(`${name}: ${errorText(err)}`);
			}
			this.part(run, 'secrets', { done: set + failures.length, total: all.length, message: `Setting ${name}` });
		}
		this.part(run, 'secrets', { state: failures.length > 0 ? 'failed' : 'done', message: `${plural(set, 'secret')} set${failures.length > 0 ? `, ${failures.length.toLocaleString()} refused` : ''}.`, failures });
		return failures.length === 0;
	}
}

function megabytes(bytes: number): string {
	if (bytes < 1024 * 1024) {
		return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

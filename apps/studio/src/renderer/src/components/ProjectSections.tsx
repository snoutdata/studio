/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import { Pager, Status, useLoad, type Said } from './projectUi';
import { api, bytes, errorText, exec, ilikeNeedle, jsonCell, pgDollar, pgIdent, pgLiteral, platformQuery, query, when } from '../projectSql';
import { keyHeader, wirePath, type Vocabulary } from '../../../shared/ownLayout';
import { projectKey, type ProjectTarget } from '../../../shared/projects';

// A project's sections, local or cloud (shared/projects.ts): the cloud dashboard's, over the same
// two doors it uses, SQL as the owner and the
// gateway with the service key, which main points at the right project. Nothing here knows which
// kind of project it is: what differs (a local project's Docker and .env, a cloud project's
// control plane) is in LocalProjectSections.tsx and CloudProjectSections.tsx.

/** One project, as every section is handed it. */
export interface ProjectHandle {
	target: ProjectTarget;
	name: string;
	/** Where clients reach the gateway. */
	apiUrl: string;
	/** The database and the gateway can answer now. */
	running: boolean;
	/** The names its gateway serves (shared/ownLayout.ts): a local project's own stack decides. */
	vocabulary: Vocabulary;
}

/** A gateway path, written in our names, as this project's gateway serves it (shared/ownLayout.ts). */
function served(project: ProjectHandle, path: string): string {
	return wirePath(path, project.vocabulary);
}

interface SectionProps {
	project: ProjectHandle;
}

const PAGE = 25;

/** The dashboard's "Work on it" card: a statement, the tables, the settings, for either kind. */
export function WorkOnIt(props: { onRunSql(): void; onBrowse(): void; onSettings(): void }): JSX.Element {
	const links: Array<{ icon: string; title: string; hint: string; run(): void }> = [
		{ icon: 'terminal', title: "Run a statement", hint: "a new SQL editor on this database", run: props.onRunSql },
		{ icon: 'table', title: "Browse the tables", hint: "the connection, in Connections", run: props.onBrowse },
		{ icon: 'settings-gear', title: "Settings", hint: "the password, production, exports", run: props.onSettings },
	];
	return (
		<fieldset>
			<legend>Work on it</legend>
			<div className="local-quick">
				{links.map((l) => (
					<button key={l.title} type="button" className="local-quick-link" onClick={l.run}>
						<Icon name={l.icon} />
						<span className="local-quick-text"><strong>{l.title}</strong><span className="muted small">{l.hint}</span></span>
						<Icon name="chevron-right" />
					</button>
				))}
			</div>
		</fieldset>
	);
}

interface AuthUser {
	id: string;
	email: string | null;
	phone: string | null;
	provider: string;
	created_at: string;
	last_sign_in_at: string | null;
	confirmed: boolean;
	banned: boolean;
}

const COUNTS_SQL = `
select count(*)::int                                                             as "total",
       count(*) filter (where email_confirmed_at is not null)::int               as "confirmed",
       count(*) filter (where last_sign_in_at > now() - interval '7 days')::int  as "active"
from snout_identity.people
`.trim();

function usersSql(needle: string, page: number): string {
	const where = needle ? `where u.email ilike ${pgLiteral(ilikeNeedle(needle))} or u.phone ilike ${pgLiteral(ilikeNeedle(needle))}` : '';
	return `
select u.id::text                                            as "id",
       u.email                                               as "email",
       u.phone                                               as "phone",
       coalesce(u.raw_app_meta_data->>'provider', 'email')   as "provider",
       u.created_at                                          as "created_at",
       u.last_sign_in_at                                     as "last_sign_in_at",
       u.email_confirmed_at is not null                      as "confirmed",
       u.banned_until is not null and u.banned_until > now() as "banned"
from snout_identity.people u
${where}
order by u.created_at desc, u.id desc
limit ${PAGE + 1} offset ${page * PAGE}
`.trim();
}

/** The project's users: listed by the owner's SQL, changed through the auth admin API. */
export function AuthUsers({ project }: SectionProps): JSX.Element {
	const [needle, setNeedle] = useState('');
	const [search, setSearch] = useState('');
	const [page, setPage] = useState(0);
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [autoConfirm, setAutoConfirm] = useState(true);
	const [confirm, confirmDialog] = useConfirm();

	const counts = useLoad(() => platformQuery<{ total: number; confirmed: number; active: number }>(project.target, COUNTS_SQL).then((r) => r[0]), [projectKey(project.target)]);
	const users = useLoad(() => platformQuery<AuthUser>(project.target, usersSql(search, page)), [projectKey(project.target), search, page]);

	useEffect(() => {
		const timer = setTimeout(() => {
			setPage(0);
			setSearch(needle.trim());
		}, 300);
		return () => clearTimeout(timer);
	}, [needle]);

	async function act(work: () => Promise<string>): Promise<void> {
		setBusy(true);
		setSaid(null);
		try {
			setSaid({ ok: true, message: await work() });
			await Promise.all([users.reload(), counts.reload()]);
		} catch (e) {
			setSaid({ ok: false, message: errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	async function addUser(): Promise<void> {
		await act(async () => {
			await api(project.target, { method: 'POST', path: '/v1/identity/operator/people', body: { email: email.trim(), password, email_confirm: autoConfirm } });
			const added = email.trim();
			setEmail('');
			setPassword('');
			return `${added} was added.`;
		});
	}

	async function remove(user: AuthUser): Promise<void> {
		const ok = await confirm({ title: `Delete ${user.email ?? user.phone ?? user.id}?`, body: "The user and their sessions are deleted. Rows of yours that reference them keep whatever your foreign keys say.", confirmLabel: "Delete user", danger: true });
		if (ok) {
			await act(async () => {
				await api(project.target, { method: 'DELETE', path: `/v1/identity/operator/people/${encodeURIComponent(user.id)}` });
				return "The user was deleted.";
			});
		}
	}

	const list = users.data ?? [];
	const shown = list.slice(0, PAGE);

	return (
		<>
			<fieldset>
				<legend>Users</legend>
				{counts.data && (
					<div className="local-stats">
						<div className="local-stat"><span className="muted small">Users</span><strong>{counts.data.total}</strong></div>
						<div className="local-stat"><span className="muted small">Confirmed</span><strong>{counts.data.confirmed}</strong></div>
						<div className="local-stat"><span className="muted small">Signed in this week</span><strong>{counts.data.active}</strong></div>
					</div>
				)}
				<label>
					Search
					<input value={needle} onChange={(e) => setNeedle(e.target.value)} placeholder="Email or phone" />
				</label>
				{users.error && <div className="form-status error">{users.error}</div>}
				{!users.error && shown.length === 0 && !users.loading && <p className="field-hint">{search ? "Nobody matches." : "No users yet. Add one below, or sign one up from your app."}</p>}
				{shown.length > 0 && (
					<table className="cloud-table">
						<thead>
							<tr><th>User</th><th>Provider</th><th>Created</th><th>Last sign-in</th><th /></tr>
						</thead>
						<tbody>
							{shown.map((u) => (
								<tr key={u.id}>
									<td>
										<span className="mono local-nowrap">{u.email ?? u.phone ?? u.id}</span>
										{!u.confirmed && <span className="env warn" title="Has not confirmed their email">unconfirmed</span>}
										{u.banned && <span className="env prod">banned</span>}
									</td>
									<td className="muted">{u.provider}</td>
									<td className="muted cloud-when">{when(u.created_at)}</td>
									<td className="muted cloud-when">{when(u.last_sign_in_at)}</td>
									<td className="cloud-table-action">
										<span className="local-row-actions">
											{!u.confirmed && (
												<button type="button" className="table-action" title="Confirm" aria-label="Confirm" disabled={busy} onClick={() => void act(async () => {
													await api(project.target, { method: 'PUT', path: `/v1/identity/operator/people/${encodeURIComponent(u.id)}`, body: { email_confirm: true } });
													return "Confirmed.";
												})}><Icon name="check" /></button>
											)}
											<button type="button" className="table-action" title={u.banned ? "Unban" : "Ban"} aria-label={u.banned ? "Unban" : "Ban"} disabled={busy} onClick={() => void act(async () => {
												await api(project.target, { method: 'PUT', path: `/v1/identity/operator/people/${encodeURIComponent(u.id)}`, body: { ban_duration: u.banned ? 'none' : '876000h' } });
												return u.banned ? "The ban was lifted." : "Banned. Their sessions stop working when they next refresh.";
											})}><Icon name={u.banned ? 'pass' : 'circle-slash'} /></button>
											<button type="button" className="table-action is-danger" title="Delete" aria-label="Delete" disabled={busy} onClick={() => void remove(u)}><Icon name="trash" /></button>
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<Pager page={page} hasMore={list.length > PAGE} onPage={setPage} />
				<Status said={said} />
			</fieldset>
			<fieldset>
				<legend>Add a user</legend>
				<label>
					Email
					<input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="someone@example.com" autoComplete="off" />
				</label>
				<label>
					Password
					<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
				</label>
				<label className="check">
					<input type="checkbox" checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} /> Confirmed, without an email
				</label>
				<div className="cloud-actions">
					<button type="button" disabled={busy || !email.trim() || password.length < 6} onClick={() => void addUser()}><Icon name="person-add" /> Add user</button>
				</div>
			</fieldset>
			{confirmDialog}
		</>
	);
}

interface Bucket {
	id: string;
	name: string;
	public: boolean;
	created_at: string;
	file_size_limit: number | null;
}

interface StoredObject {
	id: string;
	name: string;
	size: number | null;
	mimetype: string | null;
	updated_at: string | null;
}

const BUCKETS_SQL = `
select id, name, public, created_at, file_size_limit
from snout_files.spaces
order by name
`.trim();

function objectsSql(bucket: string, needle: string, page: number): string {
	const search = needle ? `and o.name ilike ${pgLiteral(ilikeNeedle(needle))}` : '';
	return `
select o.id::text                       as "id",
       o.name                           as "name",
       (o.metadata->>'size')::bigint    as "size",
       o.metadata->>'mimetype'          as "mimetype",
       o.updated_at                     as "updated_at"
from snout_files.files o
where o.bucket_id = ${pgLiteral(bucket)}
${search}
order by o.name
limit ${PAGE + 1} offset ${page * PAGE}
`.trim();
}

export function StorageBrowser({ project }: SectionProps): JSX.Element {
	const buckets = useLoad(() => platformQuery<Bucket>(project.target, BUCKETS_SQL), [projectKey(project.target)]);
	const [chosen, setChosen] = useState<string | null>(null);
	const [name, setName] = useState('');
	const [isPublic, setIsPublic] = useState(false);
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);

	const list = buckets.data ?? [];
	const bucket = list.find((b) => b.id === chosen) ?? null;

	useEffect(() => {
		if (!chosen && list.length > 0) {
			setChosen(list[0].id);
		}
	}, [chosen, list]);

	async function create(): Promise<void> {
		setBusy(true);
		setSaid(null);
		try {
			const id = name.trim();
			await api(project.target, { method: 'POST', path: '/v1/files/space', body: { id, name: id, public: isPublic } });
			setName('');
			setSaid({ ok: true, message: `${id} was created.` });
			await buckets.reload();
			setChosen(id);
		} catch (e) {
			setSaid({ ok: false, message: errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<fieldset>
				<legend>Buckets</legend>
				{buckets.error && <div className="form-status error">{buckets.error}</div>}
				{list.length === 0 && !buckets.loading && !buckets.error && <p className="field-hint">No buckets yet. A bucket holds files; its policies (or being public) decide who may read them.</p>}
				<div className="local-services">
					{list.map((b) => (
						<button key={b.id} type="button" className={`local-service${b.id === chosen ? ' selected' : ''}`} onClick={() => setChosen(b.id)}>
							<Icon name={b.public ? 'globe' : 'lock'} />
							<span className="mono">{b.name}</span>
							<span className="muted small">{b.public ? "public" : "private"}</span>
						</button>
					))}
				</div>
				<div className="local-inline-form">
					<label>
						New bucket
						<input value={name} onChange={(e) => setName(e.target.value)} placeholder="avatars" />
					</label>
					<label className="check">
						<input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} /> Public
					</label>
					<button type="button" disabled={busy || !/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(name.trim())} onClick={() => void create()}><Icon name="add" /> Create</button>
				</div>
				<Status said={said} />
			</fieldset>
			{bucket && <BucketFiles key={bucket.id} project={project} bucket={bucket} onChanged={async (gone, message) => {
				// A deleted bucket's own card unmounts with its status in it, so the parent says it;
				// otherwise "<bucket> was created." stayed on screen after the delete.
				if (gone) {
					setChosen(null);
					setSaid(message ? { ok: true, message } : null);
				}
				await buckets.reload();
			}} />}
		</>
	);
}

function BucketFiles(props: { project: ProjectHandle; bucket: Bucket; onChanged(gone: boolean, message?: string): Promise<void> }): JSX.Element {
	const { project, bucket } = props;
	const target = project.target;
	const [needle, setNeedle] = useState('');
	const [search, setSearch] = useState('');
	const [page, setPage] = useState(0);
	const [folder, setFolder] = useState('');
	const [replace, setReplace] = useState(false);
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [confirm, confirmDialog] = useConfirm();
	const objects = useLoad(() => platformQuery<StoredObject>(target, objectsSql(bucket.id, search, page)), [projectKey(target), bucket.id, search, page]);

	useEffect(() => {
		const timer = setTimeout(() => {
			setPage(0);
			setSearch(needle.trim());
		}, 300);
		return () => clearTimeout(timer);
	}, [needle]);

	async function act(work: () => Promise<string | null>, gone = false): Promise<void> {
		setBusy(true);
		setSaid(null);
		try {
			const message = await work();
			if (message) {
				setSaid({ ok: true, message });
			}
			if (gone) {
				await props.onChanged(true, message ?? undefined);
				return;
			}
			await objects.reload();
			await props.onChanged(false);
		} catch (e) {
			setSaid({ ok: false, message: errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	async function upload(): Promise<void> {
		setBusy(true);
		setSaid(null);
		try {
			const outcome = await window.sqlApi.project.upload(target, bucket.id, folder, replace);
			if (outcome) {
				setSaid(outcome);
				await objects.reload();
			}
		} finally {
			setBusy(false);
		}
	}

	async function removeBucket(): Promise<void> {
		const ok = await confirm({ title: `Delete ${bucket.name}?`, body: "Storage refuses while it still holds files. Empty it first to delete them too.", confirmLabel: "Delete bucket", danger: true });
		if (ok) {
			await act(async () => {
				await api(target, { method: 'DELETE', path: `/v1/files/space/${encodeURIComponent(bucket.id)}` });
				return `${bucket.name} was deleted.`;
			}, true);
		}
	}

	async function empty(): Promise<void> {
		const ok = await confirm({ title: `Empty ${bucket.name}?`, body: "Every file in it is deleted. This cannot be undone.", confirmLabel: "Delete every file", danger: true });
		if (ok) {
			await act(async () => {
				await api(target, { method: 'POST', path: `/v1/files/space/${encodeURIComponent(bucket.id)}/empty` });
				return "Emptied.";
			});
		}
	}

	const list = objects.data ?? [];
	const shown = list.slice(0, PAGE);

	return (
		<fieldset>
			<legend>{bucket.name}</legend>
			<label className="check">
				<input
					type="checkbox"
					checked={bucket.public}
					disabled={busy}
					onChange={(e) => void act(async () => {
						await api(target, { method: 'PUT', path: `/v1/files/space/${encodeURIComponent(bucket.id)}`, body: { public: e.target.checked } });
						return e.target.checked ? "Anyone with a file's URL can read it now." : "Files are read through your policies now.";
					})}
				/> Public
			</label>
			<p className="field-hint">Public files are served at {served(project, `/v1/files/file/public/${bucket.name}/`)}&lt;path&gt; without a key. Private ones need a signed URL or a policy that lets the caller read them.</p>
			<div className="local-inline-form">
				<label>
					Folder (optional)
					<input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="2026/october" />
				</label>
				<label className="check">
					<input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace files with the same name
				</label>
				<button type="button" disabled={busy} onClick={() => void upload()}><Icon name="cloud-upload" /> Upload…</button>
			</div>
			<label>
				Search
				<input value={needle} onChange={(e) => setNeedle(e.target.value)} placeholder="File name" />
			</label>
			{objects.error && <div className="form-status error">{objects.error}</div>}
			{shown.length === 0 && !objects.loading && !objects.error && <p className="field-hint">{search ? "No file matches." : "No files yet."}</p>}
			{shown.length > 0 && (
				<table className="cloud-table">
					<thead><tr><th>Name</th><th>Size</th><th>Type</th><th>Updated</th><th /></tr></thead>
					<tbody>
						{shown.map((o) => (
							<tr key={o.id}>
								<td className="mono">{o.name}</td>
								<td className="muted">{bytes(o.size)}</td>
								<td className="muted">{o.mimetype ?? ''}</td>
								<td className="muted cloud-when">{when(o.updated_at)}</td>
								<td className="cloud-table-action">
									<span className="local-row-actions">
										<button type="button" className="table-action" title="Download" aria-label="Download" disabled={busy} onClick={() => void window.sqlApi.project.download(target, bucket.id, o.name).then((r) => r && setSaid(r))}><Icon name="cloud-download" /></button>
										<button type="button" className="table-action is-danger" title="Delete" aria-label="Delete" disabled={busy} onClick={() => void act(async () => {
											await api(target, { method: 'DELETE', path: `/v1/files/file/${encodeURIComponent(bucket.id)}`, body: { prefixes: [o.name] } });
											return `${o.name} was deleted.`;
										})}><Icon name="trash" /></button>
									</span>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<Pager page={page} hasMore={list.length > PAGE} onPage={setPage} />
			<Status said={said} />
			<div className="cloud-actions">
				<span className="spacer" />
				<button type="button" className="secondary" disabled={busy} onClick={() => void empty()}><Icon name="clear-all" /> Empty bucket</button>
				<button type="button" className="danger" disabled={busy} onClick={() => void removeBucket()}><Icon name="trash" /> Delete bucket</button>
			</div>
			{confirmDialog}
		</fieldset>
	);
}

const PUBLICATION = 'snoutdata_realtime';

interface TableRef {
	schema: string;
	table: string;
}

interface Subscription {
	table: string;
	role: string;
	subscribers: number;
	since: string | null;
	filters: string | null;
}

const STREAMED_SQL = `
select n.nspname as "schema", c.relname as "table"
from pg_publication p
join pg_publication_rel r on r.prpubid = p.oid
join pg_class c on c.oid = r.prrelid
join pg_namespace n on n.oid = c.relnamespace
where p.pubname = '${PUBLICATION}'
order by 1, 2
`.trim();

const CANDIDATES_SQL = `
select n.nspname as "schema", c.relname as "table"
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and not c.relispartition
  and n.nspname not in ('information_schema', 'realtime', 'auth', 'storage', 'extensions', 'cron',
                        'net', 'graphql', 'graphql_public', 'snouttime',
                        'snout_live', 'snout_identity', 'snout_files', 'snout_ext', 'snout_graph')
  and n.nspname not like 'pg\\_%'
  and pg_has_role(c.relowner, 'USAGE')
  and not exists (
    select 1 from pg_publication_rel r join pg_publication p on p.oid = r.prpubid
    where p.pubname = '${PUBLICATION}' and r.prrelid = c.oid
  )
order by 1, 2
limit 500
`.trim();

const SUBSCRIPTIONS_SQL = `
select s.entity::text                                              as "table",
       s.claims_role::text                                         as "role",
       count(*)::int                                               as "subscribers",
       min(s.created_at)                                           as "since",
       string_agg(distinct nullif(s.filters::text, '{}'), ', ')    as "filters"
from snout_live.listeners s
group by 1, 2
order by 3 desc, 1
limit 200
`.trim();

export function RealtimeSection({ project }: SectionProps): JSX.Element {
	const streamed = useLoad(() => query<TableRef>(project.target, STREAMED_SQL), [projectKey(project.target)]);
	const candidates = useLoad(() => query<TableRef>(project.target, CANDIDATES_SQL), [projectKey(project.target)]);
	const subscriptions = useLoad(() => platformQuery<Subscription>(project.target, SUBSCRIPTIONS_SQL), [projectKey(project.target)]);
	const [pick, setPick] = useState('');
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);

	async function change(sql: string, message: string): Promise<void> {
		setBusy(true);
		setSaid(null);
		try {
			await exec(project.target, sql);
			setSaid({ ok: true, message });
			setPick('');
			await Promise.all([streamed.reload(), candidates.reload()]);
		} catch (e) {
			setSaid({ ok: false, message: errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	const ws = `${project.apiUrl.replace(/^http/, 'ws')}${served(project, '/v1/live/websocket')}`;

	return (
		<>
			<fieldset>
				<legend>Tables that stream their changes</legend>
				<p className="field-hint">A table in the {PUBLICATION} publication sends every insert, update and delete to listeners of changes, filtered by your row-level security. Signals and the roster need no table.</p>
				{streamed.error && <div className="form-status error">{streamed.error}</div>}
				{(streamed.data ?? []).length === 0 && !streamed.loading && !streamed.error && <p className="field-hint">No table streams yet.</p>}
				{(streamed.data ?? []).length > 0 && (
					<table className="cloud-table">
						<tbody>
							{(streamed.data ?? []).map((t) => (
								<tr key={`${t.schema}.${t.table}`}>
									<td className="mono">{t.schema}.{t.table}</td>
									<td className="cloud-table-action">
										<button type="button" className="table-action" disabled={busy} onClick={() => void change(`alter publication ${PUBLICATION} drop table ${pgIdent(t.schema)}.${pgIdent(t.table)}`, `${t.table} stopped streaming.`)}><Icon name="debug-stop" /> Stop streaming</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<div className="local-inline-form">
					<label>
						Add a table
						<select value={pick} onChange={(e) => setPick(e.target.value)}>
							<option value="">Choose a table…</option>
							{(candidates.data ?? []).map((t) => <option key={`${t.schema}.${t.table}`} value={`${t.schema}.${t.table}`}>{t.schema}.{t.table}</option>)}
						</select>
					</label>
					<button
						type="button"
						disabled={busy || !pick}
						onClick={() => {
							const [schema, ...rest] = pick.split('.');
							const table = rest.join('.');
							void change(`alter publication ${PUBLICATION} add table ${pgIdent(schema)}.${pgIdent(table)}`, `${table} streams its changes now.`);
						}}
					>
						<Icon name="broadcast" /> Stream it
					</button>
				</div>
				<Status said={said} />
			</fieldset>
			<fieldset>
				<legend>Subscribed now</legend>
				{subscriptions.error && <div className="form-status error">{subscriptions.error}</div>}
				{(subscriptions.data ?? []).length === 0 && !subscriptions.loading && !subscriptions.error && <p className="field-hint">Nobody is subscribed to database changes right now.</p>}
				{(subscriptions.data ?? []).length > 0 && (
					<table className="cloud-table">
						<thead><tr><th>Table</th><th>Role</th><th>Subscribers</th><th>Since</th><th>Filters</th></tr></thead>
						<tbody>
							{(subscriptions.data ?? []).map((s) => (
								<tr key={`${s.table}:${s.role}`}>
									<td className="mono">{s.table}</td>
									<td className="muted">{s.role}</td>
									<td>{s.subscribers}</td>
									<td className="muted cloud-when">{when(s.since)}</td>
									<td className="muted mono">{s.filters ?? ''}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<div className="cloud-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={() => void subscriptions.reload()}><Icon name="refresh" /> Refresh</button>
				</div>
			</fieldset>
			<fieldset>
				<legend>Connect</legend>
				<div className="cloud-facts">
					<span className="muted">WebSocket</span><span className="mono">{ws}</span>
					<span className="muted">Signals over HTTP</span><span className="mono">{project.apiUrl}{served(project, '/v1/live/signal')}</span>
				</div>
				<pre className="local-snippet">{`client.live.topic('room-1')
  .listen('changes', { event: '*', schema: 'public', table: 'notes' }, (change) => console.log(change))
  .join()`}</pre>
			</fieldset>
		</>
	);
}

interface Statement {
	query: string;
	calls: number;
	total_ms: number;
	mean_ms: number;
	rows: number;
}

const STATEMENTS_SQL = `
select left(s.query, 600)                         as "query",
       s.calls::int                               as "calls",
       round(s.total_exec_time::numeric, 1)::float as "total_ms",
       round(s.mean_exec_time::numeric, 2)::float  as "mean_ms",
       s.rows::bigint                             as "rows"
from pg_stat_statements s
where s.query <> '<insufficient privilege>'
  and s.query not like '/* snoutdata-desktop */%'
order by s.total_exec_time desc
limit 50
`.trim();

export function PostgresStatements({ target }: { target: ProjectTarget }): JSX.Element {
	const installed = useLoad(() => query<{ on: boolean }>(target, "select exists (select 1 from pg_extension where extname = 'pg_stat_statements') as \"on\"").then((r) => r[0]?.on === true), [projectKey(target)]);
	const statements = useLoad(() => (installed.data ? query<Statement>(target, STATEMENTS_SQL) : Promise.resolve([])), [projectKey(target), installed.data]);
	const [said, setSaid] = useState<Said>(null);

	async function switchOn(): Promise<void> {
		try {
			await exec(target, 'create extension if not exists pg_stat_statements');
			await installed.reload();
		} catch (e) {
			setSaid({ ok: false, message: errorText(e) });
		}
	}

	return (
		<fieldset>
			<legend>Postgres statements</legend>
			<p className="field-hint">What the database remembers about the statements it has run (pg_stat_statements), normalised so no literal is in it, heaviest first. Statements other roles ran (auth, the data API) are hidden from this login.</p>
			{installed.data === false && (
				<div className="cloud-actions">
					<button type="button" onClick={() => void switchOn()}><Icon name="zap" /> Switch on pg_stat_statements</button>
				</div>
			)}
			{statements.error && <div className="form-status error">{statements.error}</div>}
			{(statements.data ?? []).length > 0 && (
				<table className="cloud-table">
					<thead><tr><th>Statement</th><th>Calls</th><th>Total ms</th><th>Mean ms</th><th>Rows</th></tr></thead>
					<tbody>
						{(statements.data ?? []).map((s, i) => (
							<tr key={i}>
								<td className="mono local-wrap">{s.query}</td>
								<td>{s.calls}</td>
								<td>{s.total_ms}</td>
								<td>{s.mean_ms}</td>
								<td>{s.rows}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{installed.data && (statements.data ?? []).length === 0 && !statements.loading && <p className="field-hint">Nothing recorded yet.</p>}
			<div className="cloud-actions">
				<span className="spacer" />
				<button type="button" className="secondary" onClick={() => void statements.reload()}><Icon name="refresh" /> Refresh</button>
			</div>
			<Status said={said} />
		</fieldset>
	);
}

interface ApiTable {
	schema: string;
	name: string;
	kind: string;
	rows: number;
}

interface ApiColumn {
	name: string;
	type: string;
	nullable: boolean;
	hasDefault: boolean;
	primary: boolean;
}

const API_TABLES_SQL = `
select n.nspname as "schema", c.relname as "name",
       case c.relkind when 'v' then 'view' when 'm' then 'materialized view' else 'table' end as "kind",
       greatest(c.reltuples, 0)::bigint as "rows"
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'v', 'm')
  and not c.relispartition
  and n.nspname = 'public'
order by 2
limit 500
`.trim();

function apiColumnsSql(schema: string, table: string): string {
	return `
select a.attname as "name",
       format_type(a.atttypid, a.atttypmod) as "type",
       not a.attnotnull as "nullable",
       (a.atthasdef or a.attidentity <> '') as "hasDefault",
       exists (select 1 from pg_index i where i.indrelid = a.attrelid and i.indisprimary and a.attnum = any(i.indkey)) as "primary"
from pg_attribute a
where a.attrelid = (${pgLiteral(`${pgIdent(schema)}.${pgIdent(table)}`)})::regclass
  and a.attnum > 0 and not a.attisdropped
order by a.attnum
`.trim();
}

/** A placeholder value of a column's type, for the insert snippet. */
function sample(type: string): string {
	if (/int|numeric|double|real|serial/.test(type)) {
		return '1';
	}
	if (/bool/.test(type)) {
		return 'true';
	}
	if (/json/.test(type)) {
		return '{}';
	}
	if (/timestamp|date/.test(type)) {
		return `'${new Date().toISOString()}'`;
	}
	return `'…'`;
}

/**
 * The Data API, as the dashboard has it: Settings (the one switch that serves both REST and
 * GraphQL) and Docs (what to call, with which key, against which table). Locally the switch is
 * the `rest` container's compose profile (main/localStack/plan.ts, "the data API switch").
 */
export function DataApiSection({ project, settings }: SectionProps & { settings: JSX.Element }): JSX.Element {
	const [tab, setTab] = useState<'settings' | 'docs'>('settings');
	const running = project.running;
	return (
		<>
			<p className="field-hint">REST at {project.apiUrl}{served(project, '/v1/data')} and GraphQL at {project.apiUrl}{served(project, '/v1/graph')}, both generated from this database's own tables. One switch turns on both.</p>
			<div className="local-chips local-subtabs" role="tablist" aria-label="Data API">
				{([['settings', "Settings"], ['docs', "Docs"]] as const).map(([id, label]) => (
					<button key={id} type="button" role="tab" aria-selected={tab === id} className={`local-chip${tab === id ? ' selected' : ''}`} onClick={() => setTab(id)}>{label}</button>
				))}
			</div>
			{tab === 'settings' && settings}
			{tab === 'docs' && (running ? <DataApiDocs project={project} /> : <div className="form-status warn">The project is not running. Start it from Overview to read its tables.</div>)}
		</>
	);
}

function DataApiDocs({ project }: SectionProps): JSX.Element {
	const tables = useLoad(() => query<ApiTable>(project.target, API_TABLES_SQL), [projectKey(project.target)]);
	const [chosen, setChosen] = useState<string | null>(null);
	const list = tables.data ?? [];
	const table = list.find((t) => t.name === chosen) ?? list[0] ?? null;
	// A gateway still on the earlier names is told so (shared/ownLayout.ts).
	const options = project.vocabulary === 'old' ? `,\n  { vocabulary: 'old' }` : '';
	const client = `// npm install @snoutdata/client
import { snout } from '@snoutdata/client'

const db = snout(
  '${project.apiUrl}',
  process.env.SNOUTDATA_APP_KEY${options}
)`;

	return (
		<>
			<fieldset>
				<legend>Getting started</legend>
				<p className="field-hint">@snoutdata/client is the client, with no dependencies. The two keys it takes are on Overview: the app key in a browser, where your row-level security decides what it can reach, and the server key on a server, where nothing does.</p>
				<pre className="local-snippet">{client}</pre>
			</fieldset>
			<fieldset>
				<legend>Your tables</legend>
				<p className="field-hint">Every table and view in the public schema, at {project.apiUrl}{served(project, '/v1/data/')}&lt;table&gt;.</p>
				{tables.error && <div className="form-status error">{tables.error}</div>}
				{list.length === 0 && !tables.loading && !tables.error && <p className="field-hint">No tables in public yet. Create one in the SQL editor on this project's connection.</p>}
				<div className="local-chips">
					{list.map((t) => (
						<button key={t.name} type="button" className={`local-chip${table?.name === t.name ? ' selected' : ''}`} onClick={() => setChosen(t.name)}>
							<Icon name={t.kind === 'table' ? 'table' : 'eye'} /> {t.name}
						</button>
					))}
				</div>
			</fieldset>
			{table && <ApiTableDoc key={table.name} project={project} table={table} />}
		</>
	);
}

function ApiTableDoc({ project, table }: { project: ProjectHandle; table: ApiTable }): JSX.Element {
	const columns = useLoad(() => query<ApiColumn>(project.target, apiColumnsSql(table.schema, table.name)), [projectKey(project.target), table.name]);
	const [tried, setTried] = useState<string | null>(null);
	const [said, setSaid] = useState<Said>(null);
	const cols = columns.data ?? [];
	const key = cols.find((c) => c.primary)?.name ?? cols[0]?.name ?? 'id';
	const writable = cols.filter((c) => !c.hasDefault).slice(0, 4);
	const insertBody = `{ ${writable.map((c) => `${c.name}: ${sample(c.type)}`).join(', ')} }`;
	const name = table.name;

	const js = `const { data, error } = await db.table('${name}').read('*').limit(10)

await db.table('${name}').add(${insertBody})

await db.table('${name}').change({ ${writable[0]?.name ?? 'column'}: ${sample(writable[0]?.type ?? '')} }).eq('${key}', 1)

await db.table('${name}').remove().eq('${key}', 1)`;

	const curl = `curl '${project.apiUrl}${served(project, `/v1/data/${name}`)}?select=*&limit=10' \\
  -H "${keyHeader(project.vocabulary)}: $SNOUTDATA_APP_KEY" \\
  -H "Authorization: Bearer $SNOUTDATA_APP_KEY"`;

	async function tryIt(): Promise<void> {
		setSaid(null);
		try {
			const rows = await api<unknown[]>(project.target, { method: 'GET', path: `/v1/data/${encodeURIComponent(name)}?select=*&limit=5` });
			setTried(JSON.stringify(rows, null, 2));
		} catch (e) {
			setSaid({ ok: false, message: errorText(e) });
		}
	}

	return (
		<fieldset>
			<legend>{name}</legend>
			<div className="cloud-facts">
				<span className="muted">Endpoint</span><span className="mono">{project.apiUrl}{served(project, `/v1/data/${name}`)}</span>
				<span className="muted">Kind</span><span>{table.kind}, about {table.rows} rows</span>
			</div>
			{cols.length > 0 && (
				<table className="cloud-table">
					<thead><tr><th>Column</th><th>Type</th><th /></tr></thead>
					<tbody>
						{cols.map((c) => (
							<tr key={c.name}>
								<td className="mono">{c.name}</td>
								<td className="mono muted">{c.type}</td>
								<td className="muted small">{[c.primary ? "primary key" : '', c.nullable ? "optional" : "required", c.hasDefault ? "has a default" : ''].filter(Boolean).join(', ')}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<p className="field-hint">With the client above:</p>
			<pre className="local-snippet">{js}</pre>
			<p className="field-hint">HTTP:</p>
			<pre className="local-snippet">{curl}</pre>
			<div className="cloud-actions">
				<button type="button" className="secondary" onClick={() => void tryIt()}><Icon name="beaker" /> Try it with the server key</button>
				<span className="field-hint">The first five rows, read past row-level security.</span>
			</div>
			{tried && <pre className="local-snippet">{tried}</pre>}
			<Status said={said} />
		</fieldset>
	);
}

interface Extension {
	name: string;
	defaultVersion: string | null;
	installedVersion: string | null;
	comment: string | null;
	delegated: boolean | null;
}

const EXTENSIONS_SQL = `
select name                              as "name",
       default_version                   as "defaultVersion",
       installed_version                 as "installedVersion",
       comment                           as "comment",
       case
         when d.list is null then null
         else name = any(string_to_array(d.list, ','))
       end                               as "delegated"
from pg_available_extensions,
     lateral (select nullif(current_setting('snout_utils.privileged_extensions', true), '') as list) d
order by (installed_version is null), name
`.trim();

export function ExtensionsSection({ project }: SectionProps): JSX.Element {
	const all = useLoad(() => query<Extension>(project.target, EXTENSIONS_SQL), [projectKey(project.target)]);
	const [filter, setFilter] = useState('');
	const [busy, setBusy] = useState<string | null>(null);
	const [said, setSaid] = useState<Said>(null);
	const [confirm, confirmDialog] = useConfirm();

	const shown = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return (all.data ?? []).filter((e) => !needle || e.name.includes(needle) || (e.comment ?? '').toLowerCase().includes(needle));
	}, [all.data, filter]);

	async function change(extension: Extension, on: boolean): Promise<void> {
		if (!on) {
			const ok = await confirm({ title: `Switch ${extension.name} off?`, body: "This drops the extension and its own objects. Postgres refuses if anything of yours still depends on it, and says what.", confirmLabel: "Switch off", danger: true });
			if (!ok) {
				return;
			}
		}
		setBusy(extension.name);
		setSaid(null);
		try {
			await exec(project.target, on ? `create extension if not exists ${pgIdent(extension.name)}` : `drop extension if exists ${pgIdent(extension.name)}`);
			setSaid({ ok: true, message: on ? `${extension.name} is on.` : `${extension.name} is off.` });
			await all.reload();
		} catch (e) {
			setSaid({ ok: false, message: errorText(e) });
		} finally {
			setBusy(null);
		}
	}

	const on = (all.data ?? []).filter((e) => e.installedVersion).length;

	return (
		<fieldset>
			<legend>Extensions</legend>
			<p className="field-hint">What this database's image carries, read off the database itself. {on} on. The owner may switch on the ones the image delegates to it.</p>
			<label>
				Search
				<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="vector, postgis, cron…" />
			</label>
			<Status said={said} />
			{all.error && <div className="form-status error">{all.error}</div>}
			<table className="cloud-table">
				<tbody>
					{shown.map((e) => (
						<tr key={e.name}>
							<td>
								<span className="mono">{e.name}</span>
								<span className="muted small"> {e.installedVersion ?? e.defaultVersion}</span>
								{e.delegated === false && !e.installedVersion && <span className="env" title="Not in the list the image delegates to the owner; creating it may be refused">not delegated</span>}
								<div className="muted small">{e.comment}</div>
							</td>
							<td className="cloud-table-action">
								<label className="check local-inline-check" title={e.installedVersion ? "Switch off" : "Switch on"}>
									<input type="checkbox" checked={!!e.installedVersion} disabled={busy !== null} onChange={(ev) => void change(e, ev.target.checked)} />
								</label>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{confirmDialog}
		</fieldset>
	);
}

interface Job {
	jobId: number;
	name: string | null;
	schedule: string;
	command: string;
	active: boolean;
	lastStatus: string | null;
	lastStart: string | null;
	lastMessage: string | null;
	failures: number;
}

interface Run {
	runId: number;
	status: string;
	start: string | null;
	end: string | null;
	message: string | null;
}

const CRON_STATE_SQL = `
select exists (select 1 from pg_extension where extname = 'pg_cron') as "installed",
       exists (select 1 from pg_available_extensions where name = 'pg_cron') as "available"
`.trim();

const CRON_JOBS_SQL = `
select j.jobid::int                   as "jobId",
       j.jobname                      as "name",
       j.schedule                     as "schedule",
       j.command                      as "command",
       j.active                       as "active",
       r.status                       as "lastStatus",
       r.start_time                   as "lastStart",
       left(r.return_message, 400)    as "lastMessage",
       (select count(*) from cron.job_run_details f
         where f.jobid = j.jobid and f.status = 'failed'
           and f.start_time > now() - interval '1 day')::int as "failures"
from cron.job j
left join lateral (
  select status, start_time, return_message
  from cron.job_run_details d
  where d.jobid = j.jobid
  order by d.start_time desc nulls last
  limit 1
) r on true
order by j.jobid
`.trim();

function runsSql(jobId: number): string {
	return `
select runid::int as "runId", status as "status", start_time as "start", end_time as "end", left(return_message, 400) as "message"
from cron.job_run_details
where jobid = ${pgLiteral(jobId)}
order by start_time desc nulls last
limit 25
`.trim();
}

const PRESETS: ReadonlyArray<{ label: string; schedule: string }> = [
	{ label: "Every 30 seconds", schedule: '30 seconds' },
	{ label: "Every 5 minutes", schedule: '*/5 * * * *' },
	{ label: "Hourly", schedule: '0 * * * *' },
	{ label: "Daily at 03:00", schedule: '0 3 * * *' },
	{ label: "Weekly, Sunday 03:00", schedule: '0 3 * * 0' },
];

const TEMPLATES: ReadonlyArray<{ label: string; name: string; schedule: string; command: string }> = [
	{ label: "Trim the run history", name: 'trim-cron-history', schedule: '0 3 * * *', command: "delete from cron.job_run_details where end_time < now() - interval '7 days'" },
	{ label: "Refresh a materialized view", name: 'refresh-view', schedule: '0 * * * *', command: 'refresh materialized view concurrently public.my_view' },
	{ label: "Call a URL (needs pg_net)", name: 'call-webhook', schedule: '*/5 * * * *', command: "select net.http_post(url := 'https://example.com/hook', body := '{}'::jsonb)" },
];

export function CronSection({ project }: SectionProps): JSX.Element {
	const state = useLoad(() => query<{ installed: boolean; available: boolean }>(project.target, CRON_STATE_SQL).then((r) => r[0]), [projectKey(project.target)]);
	const jobs = useLoad(() => (state.data?.installed ? query<Job>(project.target, CRON_JOBS_SQL) : Promise.resolve([])), [projectKey(project.target), state.data?.installed]);
	const [open, setOpen] = useState<number | null>(null);
	const [name, setName] = useState('');
	const [schedule, setSchedule] = useState('*/5 * * * *');
	const [command, setCommand] = useState('');
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [confirm, confirmDialog] = useConfirm();

	async function run(sql: string, message: string): Promise<boolean> {
		setBusy(true);
		setSaid(null);
		try {
			await exec(project.target, sql);
			setSaid({ ok: true, message });
			await state.reload();
			await jobs.reload();
			return true;
		} catch (e) {
			setSaid({ ok: false, message: errorText(e) });
			return false;
		} finally {
			setBusy(false);
		}
	}

	async function create(): Promise<void> {
		const sql = name.trim()
			? `select cron.schedule(${pgLiteral(name.trim())}, ${pgLiteral(schedule.trim())}, ${pgDollar(command.trim())})`
			: `select cron.schedule(${pgLiteral(schedule.trim())}, ${pgDollar(command.trim())})`;
		if (await run(sql, "Scheduled.")) {
			setName('');
			setCommand('');
		}
	}

	if (state.error) {
		return <div className="form-status error">{state.error}</div>;
	}
	if (!state.data) {
		return <div className="field-hint">Loading…</div>;
	}
	if (!state.data.installed) {
		return (
			<fieldset>
				<legend>Scheduled jobs</legend>
				<p>SQL that runs on a schedule, inside this database, with pg_cron.</p>
				{state.data.available
					? <div className="cloud-actions"><button type="button" disabled={busy} onClick={() => void run('create extension if not exists pg_cron', "pg_cron is on.")}><Icon name="zap" /> Switch on pg_cron</button></div>
					: <p className="field-hint">pg_cron is not in this database's image.</p>}
				<Status said={said} />
			</fieldset>
		);
	}

	const list = jobs.data ?? [];
	return (
		<>
			<fieldset>
				<legend>Scheduled jobs</legend>
				<p className="field-hint">Each job runs as the owner, while the project is running; a time that passes while it is stopped is not caught up. A job scheduled from SQL anywhere shows up here too.</p>
				{jobs.error && <div className="form-status error">{jobs.error}</div>}
				{list.length === 0 && !jobs.loading && <p className="field-hint">No jobs yet.</p>}
				{list.map((job) => (
					<div key={job.jobId} className="local-job">
						<div className="local-job-head">
							<span className={`cloud-dot ${job.lastStatus === 'failed' ? 'error' : job.lastStatus === 'succeeded' ? 'ok' : 'dim'}`} />
							<strong>{job.name ?? `Job ${job.jobId}`}</strong>
							<span className="mono muted">{job.schedule}</span>
							<span className="spacer" />
							<label className="check local-inline-check" title={job.active ? "Pause" : "Resume"}>
								<input type="checkbox" checked={job.active} disabled={busy} onChange={(e) => void run(`select cron.alter_job(${pgLiteral(job.jobId)}, active := ${pgLiteral(e.target.checked)})`, e.target.checked ? "Resumed." : "Paused.")} />
							</label>
							<button type="button" className="table-action" onClick={() => setOpen(open === job.jobId ? null : job.jobId)}><Icon name="history" /> {open === job.jobId ? "Hide runs" : "Runs"}</button>
							<button
								type="button"
								className="table-action is-danger"
								disabled={busy}
								onClick={async () => {
									if (await confirm({ title: `Delete ${job.name ?? `job ${job.jobId}`}?`, body: "The job stops and is removed. Its run history stays in cron.job_run_details.", confirmLabel: "Delete job", danger: true })) {
										await run(`select cron.unschedule(${pgLiteral(job.jobId)})`, "Deleted.");
									}
								}}
							>
								<Icon name="trash" /> Delete
							</button>
						</div>
						<pre className="local-snippet">{job.command}</pre>
						<div className="muted small">
							{job.lastStart ? `Last ran ${when(job.lastStart)}: ${job.lastStatus}` : "Has not run yet."}
							{job.failures > 0 ? ` · ${job.failures} failed in the last day` : ''}
							{job.lastStatus === 'failed' && job.lastMessage ? ` · ${job.lastMessage}` : ''}
						</div>
						{open === job.jobId && <JobRuns target={project.target} jobId={job.jobId} />}
					</div>
				))}
				<Status said={said} />
			</fieldset>
			<fieldset>
				<legend>New job</legend>
				<label>
					Start from
					<select value="" onChange={(e) => {
						const t = TEMPLATES.find((x) => x.label === e.target.value);
						if (t) {
							setName(t.name);
							setSchedule(t.schedule);
							setCommand(t.command);
						}
					}}>
						<option value="">A template…</option>
						{TEMPLATES.map((t) => <option key={t.label} value={t.label}>{t.label}</option>)}
					</select>
				</label>
				<label>
					Name (optional)
					<input value={name} onChange={(e) => setName(e.target.value)} placeholder="nightly-cleanup" />
				</label>
				<label>
					Schedule
					<input value={schedule} onChange={(e) => setSchedule(e.target.value)} className="mono" />
				</label>
				<div className="local-chips">
					{PRESETS.map((p) => <button key={p.schedule} type="button" className={`local-chip${schedule === p.schedule ? ' selected' : ''}`} onClick={() => setSchedule(p.schedule)}>{p.label}</button>)}
				</div>
				<p className="field-hint">Cron syntax in UTC, or "N seconds" for 1 to 59 seconds.</p>
				<label>
					SQL to run
					<textarea rows={4} value={command} onChange={(e) => setCommand(e.target.value)} className="mono" />
				</label>
				<div className="cloud-actions">
					<button type="button" disabled={busy || !schedule.trim() || !command.trim()} onClick={() => void create()}><Icon name="calendar" /> Schedule</button>
				</div>
			</fieldset>
			{confirmDialog}
		</>
	);
}

function JobRuns({ target, jobId }: { target: ProjectTarget; jobId: number }): JSX.Element {
	const runs = useLoad(() => query<Run>(target, runsSql(jobId)), [projectKey(target), jobId]);
	if (runs.error) {
		return <div className="form-status error">{runs.error}</div>;
	}
	if ((runs.data ?? []).length === 0) {
		return <p className="field-hint">No runs yet.</p>;
	}
	return (
		<table className="cloud-table">
			<thead><tr><th>Started</th><th>Status</th><th>Took</th><th>Message</th></tr></thead>
			<tbody>
				{(runs.data ?? []).map((r) => (
					<tr key={r.runId}>
						<td className="muted cloud-when">{when(r.start)}</td>
						<td>{r.status}</td>
						<td className="muted">{r.start && r.end ? `${Math.max(0, new Date(r.end).getTime() - new Date(r.start).getTime())} ms` : ''}</td>
						<td className="muted mono local-wrap">{r.message ?? ''}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

type Json = Record<string, unknown>;

const TS_STATE_SQL = `
select exists (select 1 from pg_extension where extname = 'snouttime') as "installed",
       exists (select 1 from pg_available_extensions where name = 'snouttime') as "available",
       (select extversion from pg_extension where extname = 'snouttime') as "version"
`.trim();

const TS_SERIES_SQL = `
select to_jsonb(s) || jsonb_build_object('oid', s.series::oid) as j
from snouttime.series_info s
order by s.series::text
`.trim();

const TS_ROLLUPS_SQL = `
select r.relid::text                                              as "name",
       r.source::text                                             as "source",
       coalesce(r.bucket_interval::text, r.bucket_width::text)    as "bucket",
       coalesce(r.retention::text, r.retention_width::text)       as "retention"
from snouttime.rollups r
order by r.relid::text
`.trim();

const TS_JOBS_SQL = `
select to_jsonb(j) as j
from snouttime.job_info j
order by j.target::text, j.kind
`.trim();

function str(v: unknown): string {
	return v === null || v === undefined ? '' : String(v);
}

export function TimeSeriesSection({ project }: SectionProps): JSX.Element {
	const state = useLoad(() => query<{ installed: boolean; available: boolean; version: string | null }>(project.target, TS_STATE_SQL).then((r) => r[0]), [projectKey(project.target)]);
	const installed = state.data?.installed === true;
	const series = useLoad(() => (installed ? query<{ j: unknown }>(project.target, TS_SERIES_SQL).then((r) => r.map((x) => jsonCell<Json>(x.j))) : Promise.resolve([] as Json[])), [projectKey(project.target), installed]);
	const rollups = useLoad(() => (installed ? query<{ name: string; source: string; bucket: string | null; retention: string | null }>(project.target, TS_ROLLUPS_SQL) : Promise.resolve([])), [projectKey(project.target), installed]);
	const jobs = useLoad(() => (installed ? query<{ j: unknown }>(project.target, TS_JOBS_SQL).then((r) => r.map((x) => jsonCell<Json>(x.j))) : Promise.resolve([] as Json[])), [projectKey(project.target), installed]);
	const [table, setTable] = useState('');
	const [column, setColumn] = useState('ts');
	const [interval, setInterval] = useState('1 day');
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);

	async function run(sql: string, message: string): Promise<void> {
		setBusy(true);
		setSaid(null);
		try {
			await exec(project.target, sql);
			setSaid({ ok: true, message });
			await state.reload();
			await Promise.all([series.reload(), rollups.reload(), jobs.reload()]);
		} catch (e) {
			setSaid({ ok: false, message: errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	if (state.error) {
		return <div className="form-status error">{state.error}</div>;
	}
	if (!state.data) {
		return <div className="field-hint">Loading…</div>;
	}
	if (!installed) {
		return (
			<fieldset>
				<legend>Time series</legend>
				<p>SnoutTime partitions a table by time, seals old partitions into a compressed columnar form, keeps rollups up to date and drops what is past its retention.</p>
				{state.data.available
					? <div className="cloud-actions"><button type="button" disabled={busy} onClick={() => void run('create extension if not exists snouttime', "SnoutTime is on.")}><Icon name="zap" /> Switch on SnoutTime</button></div>
					: <p className="field-hint">SnoutTime is not in this project's database image, so there is nothing to switch on here. It runs on SnoutData Cloud projects; when the self-hosted image carries it, this section offers it.</p>}
				<Status said={said} />
			</fieldset>
		);
	}

	const list = series.data ?? [];
	return (
		<>
			<fieldset>
				<legend>Series</legend>
				<p className="field-hint">SnoutTime {state.data.version}. Every figure is from the catalog or a planner estimate, never a scan.</p>
				{series.error && <div className="form-status error">{series.error}</div>}
				{list.length === 0 && !series.loading && <p className="field-hint">No series yet. Make one from a table with a time column below.</p>}
				{list.length > 0 && (
					<table className="cloud-table">
						<thead><tr><th>Series</th><th>Time column</th><th>Partition</th><th>Partitions</th><th>Rows</th><th>Size</th><th>Retention</th></tr></thead>
						<tbody>
							{list.map((s) => (
								<tr key={str(s.oid)}>
									<td className="mono">{str(s.series)}</td>
									<td className="mono muted">{str(s.time_column)}</td>
									<td className="muted">{str(s.partition_size)}</td>
									<td>{str(s.partitions)}</td>
									<td>~{str(s.estimated_rows)}</td>
									<td className="muted">{bytes(s.bytes as number | null)}</td>
									<td className="muted">{str(s.retention) || "kept"}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<Status said={said} />
			</fieldset>
			{(rollups.data ?? []).length > 0 && (
				<fieldset>
					<legend>Rollups</legend>
					<table className="cloud-table">
						<thead><tr><th>Rollup</th><th>From</th><th>Bucket</th><th>Retention</th></tr></thead>
						<tbody>
							{(rollups.data ?? []).map((r) => (
								<tr key={r.name}><td className="mono">{r.name}</td><td className="mono muted">{r.source}</td><td>{r.bucket ?? ''}</td><td className="muted">{r.retention ?? "kept"}</td></tr>
							))}
						</tbody>
					</table>
				</fieldset>
			)}
			{(jobs.data ?? []).length > 0 && (
				<fieldset>
					<legend>Background jobs</legend>
					<table className="cloud-table">
						<thead><tr><th>Job</th><th>Target</th><th>Next run</th><th>Last run</th></tr></thead>
						<tbody>
							{(jobs.data ?? []).map((j, i) => (
								<tr key={i}>
									<td>{str(j.kind)}</td>
									<td className="mono muted">{str(j.target)}</td>
									<td className="muted cloud-when">{when(j.next_run)}</td>
									<td className={j.last_ok === false ? 'form-status error' : 'muted'}>{j.last_run ? `${when(j.last_run)}${j.last_ok === false ? `: ${str(j.last_detail)}` : ''}` : "never"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</fieldset>
			)}
			<fieldset>
				<legend>New series</legend>
				<div className="local-port-grid">
					<label>
						Table
						<input value={table} onChange={(e) => setTable(e.target.value)} placeholder="metrics" />
					</label>
					<label>
						Time column
						<input value={column} onChange={(e) => setColumn(e.target.value)} />
					</label>
					<label>
						Partition every
						<input value={interval} onChange={(e) => setInterval(e.target.value)} />
					</label>
				</div>
				<p className="field-hint">An existing table with a timestamp column. It becomes a partitioned series in place.</p>
				<div className="cloud-actions">
					<button
						type="button"
						disabled={busy || !table.trim() || !column.trim()}
						onClick={() => void run(`select snouttime.create_series(${pgLiteral(table.trim())}, ${pgLiteral(column.trim())}, partition_interval => ${pgLiteral(interval.trim())})`, `${table.trim()} is a series now.`)}
					>
						<Icon name="graph-line" /> Make it a series
					</button>
				</div>
			</fieldset>
		</>
	);
}

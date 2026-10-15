/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { errorMessage } from '../errors';
import { appliesToLabel, policyAppliesTo, policyKey, policyLabel, principalKey, principalLabel, privilegesFor, redactSqlSecrets, scopeRank, type AccessPolicy, type Grant, type GrantScope, type PolicyDraft, type PolicyKind, type PolicySetting, type Principal, type PrincipalDraft, type PrincipalKind, type SecurityChange, type SecurityPlan, type SecuritySnapshot, type SecuritySupport } from '../../../shared/engine';
import type { ConnectionConfig } from '../../../shared/connection';
import { isPlatformRole, isPlatformSchema } from '../../../shared/cloudPlatform';

/*
 * Users & Privileges: who can reach this database, and what they may do with it.
 *
 * The one rule this whole screen is built around: NOTHING runs until the user has read the
 * statements. Every action — create, drop, grant, revoke, set a password — produces a
 * `SecurityChange[]` and opens the review sheet, which asks main for the plan and shows the exact
 * SQL. That is the same shape as the table designer (the assistant proposes, the surface reviews,
 * the user applies), and it is what lets the AI drive this feature without ever running a GRANT
 * on its own.
 *
 * A password is typed HERE and nowhere else. It never enters a chat message, a capability
 * argument, query history or the audit log, and the review sheet masks it until asked.
 */

interface SecurityViewProps {
	connections: ConnectionConfig[];
	connectedIds: string[];
	/** The connection this tab is bound to, driven by the connections sidebar. */
	connectionId?: string;
	/**
	 * What the assistant proposed, keyed by nonce so the same proposal can be sent twice. This is
	 * the whole of an agent's write authority here: it fills a form in, and that is all.
	 *
	 * `draft` opens the new-user form prefilled with everything EXCEPT the password, which the
	 * user types. That split is the point: a password the assistant supplied would have travelled
	 * through a chat message, a tool call and the audit log to get here.
	 * `changes` (grants, revokes, role changes — nothing carrying a secret) opens the review sheet
	 * directly, showing the exact statements.
	 */
	proposal?: { nonce: number; draft?: PrincipalDraft; changes?: SecurityChange[] } | null;
}

/** What the detail pane's action row is currently editing. */
type Editor =
	| { kind: 'new-principal'; seed?: PrincipalDraft }
	| { kind: 'set-password'; principal: Principal }
	| { kind: 'grant'; principal: Principal }
	| { kind: 'new-policy' }
	| null;

const KIND_ICON: Record<PrincipalKind, string> = { user: 'person', role: 'organization', login: 'key', group: 'organization' };
const KIND_GROUP: Record<PrincipalKind, string> = { user: 'Users', role: 'Roles', login: 'Server logins', group: 'Groups' };
const GROUP_ORDER: PrincipalKind[] = ['user', 'role', 'login', 'group'];

const POLICY_ICON: Record<PolicyKind, string> = { 'row-policy': 'filter', 'quota': 'dashboard', 'settings-profile': 'settings-gear' };
const POLICY_GROUP: Record<PolicyKind, string> = { 'row-policy': 'Row policies', 'quota': 'Quotas', 'settings-profile': 'Settings profiles' };
const POLICY_ORDER: PolicyKind[] = ['row-policy', 'quota', 'settings-profile'];

/** What each kind is FOR, said once on the screen that creates it. The three are easy to confuse
 *  and only one of them takes data away. */
const POLICY_BLURB: Record<PolicyKind, string> = {
	'row-policy': "Which rows of one table an account may see. The first policy on a table hides every row it does not allow, including from accounts it does not name.",
	'quota': "How much an account may use in a window of time: queries, rows read, errors. Going over it fails the query.",
	'settings-profile': "Settings an account runs with, such as a memory ceiling or read-only mode.",
};

/** The selection key for a policy, kept apart from a principal's so one list can hold both. */
function policySelectionKey(policy: AccessPolicy): string {
	return `policy!${policyKey(policy)}`;
}

function scopeLabel(scope: GrantScope): string {
	switch (scope) {
		case 'global': return 'Server';
		case 'database': return 'Database';
		case 'schema': return 'Schema';
		case 'column': return 'Column';
		default: return 'Table';
	}
}

/** The object a grant is on, as one path. */
function grantObject(grant: Grant): string {
	const parts = [grant.database, grant.schema, grant.object].filter((part): part is string => !!part);
	const path = parts.join('.');
	if (grant.column) {
		return `${path} (${grant.column})`;
	}
	return path || 'the whole server';
}

export function SecurityView({ connections, connectedIds, connectionId, proposal }: SecurityViewProps): JSX.Element {
	const [snapshot, setSnapshot] = useState<SecuritySnapshot | null>(null);
	const [support, setSupport] = useState<SecuritySupport | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState('');
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [editor, setEditor] = useState<Editor>(null);
	/** The changes waiting to be reviewed and applied, or null when the sheet is closed. */
	const [pending, setPending] = useState<SecurityChange[] | null>(null);

	const conn = connectionId ? connections.find((c) => c.id === connectionId) : undefined;
	const connected = connectionId !== undefined && connectedIds.includes(connectionId);

	// What this engine supports, so the empty state can say WHY rather than showing a blank list.
	useEffect(() => {
		if (!connectionId) {
			setSupport(null);
			return;
		}
		let live = true;
		void window.sqlApi.securitySupport(connectionId)
			.then((value) => { if (live) { setSupport(value); } })
			.catch(() => { if (live) { setSupport(null); } });
		return () => { live = false; };
	}, [connectionId]);

	function reload(): void {
		if (!connectionId || !connected) {
			return;
		}
		const cid = connectionId;
		setLoading(true);
		setError(null);
		void window.sqlApi.securityRead(cid)
			.then((value) => {
				setSnapshot(value);
				setLoading(false);
			})
			.catch((err: unknown) => {
				setError(errorMessage(err));
				setSnapshot(null);
				setLoading(false);
			});
	}

	// Read on connect / connection change. Reading is a handful of catalog SELECTs, so unlike the
	// workload tool there is no reason to make the user ask for it.
	useEffect(() => {
		setSnapshot(null);
		setSelectedKey(null);
		setEditor(null);
		if (connectionId && connected && support?.supported) {
			reload();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [connectionId, connected, support?.supported]);

	// What the assistant proposed: a new-user form to finish, or statements to read and decide on.
	useEffect(() => {
		if (!proposal) {
			return;
		}
		if (proposal.draft) {
			setEditor({ kind: 'new-principal', seed: proposal.draft });
		} else if (proposal.changes && proposal.changes.length > 0) {
			setPending(proposal.changes);
		}
	}, [proposal?.nonce]);

	// A hosted database hides the platform's own roles and its grants on platform schemas
	// (shared/cloudPlatform.ts): they are not the customer's to see, and dropping one breaks the project.
	const hidePlatform = !!conn?.cloudProjectRef;
	const principals = useMemo(
		() => (snapshot?.principals ?? []).filter((p) => !hidePlatform || !isPlatformRole(p.name)),
		[snapshot, hidePlatform],
	);
	const usesHost = support?.usesHost ?? false;

	const shown = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		if (!needle) {
			return principals;
		}
		return principals.filter((p) => principalLabel(p).toLowerCase().includes(needle));
	}, [principals, filter]);

	const grouped = useMemo(() => {
		const groups = new Map<PrincipalKind, Principal[]>();
		for (const principal of shown) {
			const list = groups.get(principal.kind) ?? [];
			list.push(principal);
			groups.set(principal.kind, list);
		}
		return GROUP_ORDER.filter((kind) => groups.has(kind)).map((kind) => ({ kind, items: groups.get(kind) ?? [] }));
	}, [shown]);

	const selected = useMemo(
		() => (selectedKey?.startsWith('policy!') ? null : principals.find((p) => principalKey(p.name, p.host) === selectedKey) ?? null),
		[principals, selectedKey],
	);

	const policies = snapshot?.policies ?? [];

	/** Row policies, quotas and settings profiles, filtered by the same box as the users and
	 *  grouped the same way. The filter reads the DETAIL too: "which policy mentions tenant_id"
	 *  is the question somebody has, and the name rarely answers it. */
	const policyGroups = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		const shownPolicies = needle
			? policies.filter((policy) => `${policy.name} ${policy.database ?? ''} ${policy.object ?? ''} ${policy.detail ?? ''}`.toLowerCase().includes(needle))
			: policies;
		const groups = new Map<PolicyKind, AccessPolicy[]>();
		for (const policy of shownPolicies) {
			const list = groups.get(policy.kind) ?? [];
			list.push(policy);
			groups.set(policy.kind, list);
		}
		return POLICY_ORDER.filter((kind) => groups.has(kind)).map((kind) => ({ kind, items: groups.get(kind) ?? [] }));
	}, [policies, filter]);

	const selectedPolicy = useMemo(
		() => policies.find((policy) => policySelectionKey(policy) === selectedKey) ?? null,
		[policies, selectedKey],
	);

	/** The policies that act on the selected principal, through its own name or a role it holds.
	 *  This is the answer to "why does this account see four rows", which a grant list cannot
	 *  give. */
	const policiesOnSelected = useMemo(
		() => (selected ? policies.filter((policy) => policyAppliesTo(policy, selected.name, selected.memberOf)) : []),
		[policies, selected],
	);

	/**
	 * The grants held DIRECTLY by the selected principal, widest scope first — a stray
	 * `ALL PRIVILEGES` on the whole database is what matters, and burying it under fifty table
	 * rows is how it goes unnoticed. Roles are not expanded: what a role adds is shown as the
	 * role membership, and the pane says so rather than implying this is the effective total.
	 */
	const grants = useMemo(() => {
		if (!selected || !snapshot) {
			return [];
		}
		return snapshot.grants
			.filter((grant) => grant.grantee === selected.name && (!usesHost || (grant.granteeHost ?? '') === (selected.host ?? '')))
			.filter((grant) => !hidePlatform || !isPlatformSchema(grant.schema))
			.sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope) || grantObject(a).localeCompare(grantObject(b)) || a.privilege.localeCompare(b.privilege));
	}, [selected, snapshot, usesHost, hidePlatform]);

	/** Every role name on this connection, for the "add to role" pickers. */
	const roleNames = useMemo(() => principals.filter((p) => p.kind === 'role').map((p) => p.name), [principals]);

	/** Every name a policy can be applied to: users and roles alike, since both are addressable. */
	const principalNames = useMemo(
		() => principals.filter((p) => p.kind === 'user' || p.kind === 'role').map((p) => p.name),
		[principals],
	);

	function propose(changes: SecurityChange[]): void {
		setEditor(null);
		setPending(changes);
	}

	if (!connectionId) {
		return <div className="table-view"><div className="results-message">Select a database in the connections sidebar to see its users and privileges.</div></div>;
	}
	if (support && !support.supported) {
		return (
			<div className="table-view">
				<div className="tv-head">
					<Icon name="shield" className="tv-head-icon" />
					<span className="tv-title">Users &amp; Privileges</span>
				</div>
				<div className="results-message">{support.reason}</div>
			</div>
		);
	}

	return (
		<>
		<div className="table-view security-view">
			<div className="tv-head">
				<Icon name="shield" className="tv-head-icon" />
				<span className="tv-title">Users &amp; Privileges</span>
				<span className="muted">{conn?.label ?? ''}</span>
				<button type="button" disabled={!connected || loading} title="Re-read the users and privileges" onClick={reload}>
					<Icon name="refresh" /> {loading ? 'Reading…' : 'Refresh'}
				</button>
				<button type="button" disabled={!connected} title="Create a new user or role" onClick={() => setEditor({ kind: 'new-principal' })}>
					<Icon name="add" /> New user
				</button>
				{(support?.policyKinds.length ?? 0) > 0 && (
					<button type="button" disabled={!connected} title="Create a row policy, a quota or a settings profile" onClick={() => setEditor({ kind: 'new-policy' })}>
						<Icon name="add" /> New policy
					</button>
				)}
				<span className="spacer" />
			</div>

			{!connected
				? <div className="results-message">Connect "{conn?.label ?? 'this database'}" in the sidebar to see who can reach it.</div>
				: error
					? <div className="results-error">{error}</div>
					: (
						<>
						{(snapshot?.warnings.length ?? 0) > 0 && (
							<div className="sec-warnings">
								<Icon name="info" />
								<div>
									<div>This connection cannot read everything. What is missing:</div>
									<ul>{snapshot?.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
								</div>
							</div>
						)}
						<div className="sec-body">
							<div className="sec-list">
								<input
									className="sec-filter"
									type="search"
									placeholder="Find a user, role or policy"
									value={filter}
									onChange={(e) => setFilter(e.target.value)}
								/>
								{loading && principals.length === 0
									? <div className="results-message">Reading users and privileges…</div>
									: grouped.length === 0
										? <div className="results-message">{principals.length === 0 ? 'No users or roles were readable on this connection.' : 'Nothing matches that.'}</div>
										: grouped.map((group) => (
											<div className="sec-group" key={group.kind}>
												<div className="sec-group-title">{KIND_GROUP[group.kind]}</div>
												{group.items.map((principal) => {
													const key = principalKey(principal.name, principal.host);
													return (
														<button
															type="button"
															key={key}
															className={`sec-row${key === selectedKey ? ' selected' : ''}`}
															onClick={() => setSelectedKey(key)}
														>
															<Icon name={KIND_ICON[principal.kind]} />
															<span className="sec-row-name">{principalLabel(principal)}</span>
															{principal.isSuperuser && <span className="sec-badge warn" title={principal.superuserVia ? `Unrestricted through the role ${principal.superuserVia}. The membership is what to take away, not a grant this account does not have.` : "Holds this engine's unrestricted role"}>super</span>}
															{principal.disabled && <span className="sec-badge" title="Cannot sign in">off</span>}
														</button>
													);
												})}
											</div>
										))}
								{policyGroups.map((group) => (
									<div className="sec-group" key={group.kind}>
										<div className="sec-group-title">{POLICY_GROUP[group.kind]}</div>
										{group.items.map((policy) => {
											const key = policySelectionKey(policy);
											return (
												<button
													type="button"
													key={key}
													className={`sec-row${key === selectedKey ? ' selected' : ''}`}
													onClick={() => setSelectedKey(key)}
												>
													<Icon name={POLICY_ICON[policy.kind]} />
													<span className="sec-row-name">{policy.name}</span>
													{policy.restrictive && <span className="sec-badge" title="Restrictive: ANDed with the other policies, so it can only take rows away">restrictive</span>}
													{policy.appliesToAll && <span className="sec-badge warn" title={policy.exceptFor.length > 0 ? `Applies to everyone except ${policy.exceptFor.join(', ')}` : 'Applies to everyone'}>everyone</span>}
												</button>
											);
										})}
									</div>
								))}
							</div>

							<div className="sec-detail">
								{selectedPolicy
									? (
										<PolicyDetail
											policy={selectedPolicy}
											principalNames={principalNames}
											onPropose={propose}
										/>
									)
									: !selected
										? <div className="results-message">Select a user, role or policy to see what it does.</div>
										: (
											<PrincipalDetail
												principal={selected}
												grants={grants}
												policies={policiesOnSelected}
												roleNames={roleNames}
												onEdit={setEditor}
												onPropose={propose}
											/>
										)}
							</div>
						</div>
						</>
					)}
		</div>

		{editor?.kind === 'new-principal' && support && (
			<NewPrincipalDialog
				support={support}
				roleNames={roleNames}
				seed={editor.seed}
				onCancel={() => setEditor(null)}
				onPropose={propose}
			/>
		)}
		{editor?.kind === 'set-password' && (
			<SetPasswordDialog principal={editor.principal} onCancel={() => setEditor(null)} onPropose={propose} />
		)}
		{editor?.kind === 'grant' && support && conn && (
			<GrantDialog
				principal={editor.principal}
				support={support}
				driverId={conn.driver}
				onCancel={() => setEditor(null)}
				onPropose={propose}
			/>
		)}
		{editor?.kind === 'new-policy' && support && (
			<NewPolicyDialog
				support={support}
				principalNames={principalNames}
				onCancel={() => setEditor(null)}
				onPropose={propose}
			/>
		)}
		{pending && connectionId && (
			<ReviewSheet
				connectionId={connectionId}
				changes={pending}
				onClose={() => setPending(null)}
				onApplied={() => { setPending(null); reload(); }}
			/>
		)}
		</>
	);
}

/** The right-hand pane: what this principal is, what roles it holds, what it can do. */
function PrincipalDetail({ principal, grants, policies, roleNames, onEdit, onPropose }: {
	principal: Principal;
	grants: readonly Grant[];
	/** The policies that act on this principal, directly or through a role it holds. */
	policies: readonly AccessPolicy[];
	roleNames: readonly string[];
	onEdit(editor: Editor): void;
	onPropose(changes: SecurityChange[]): void;
}): JSX.Element {
	const ref = { name: principal.name, host: principal.host };
	const addable = roleNames.filter((role) => !principal.memberOf.includes(role) && role !== principal.name);

	return (
		<>
			<div className="sec-detail-head">
				<Icon name={KIND_ICON[principal.kind]} className="sec-detail-icon" />
				<div className="sec-detail-name">
					<div className="sec-detail-title">{principalLabel(principal)}</div>
					<div className="muted small">{KIND_GROUP[principal.kind].replace(/s$/, '')}{principal.canLogin ? ', can sign in' : ', cannot sign in'}</div>
				</div>
				<span className="spacer" />
				{principal.kind !== 'role' && (
					<>
						<button type="button" onClick={() => onEdit({ kind: 'set-password', principal })}><Icon name="key" /> Set password</button>
						<button type="button" onClick={() => onPropose([{ kind: 'set-enabled', principal: ref, enabled: principal.disabled }])}>
							<Icon name={principal.disabled ? 'unlock' : 'lock'} /> {principal.disabled ? 'Enable' : 'Disable'}
						</button>
					</>
				)}
				<button
					type="button"
					className="danger"
					onClick={() => onPropose([{ kind: 'drop-principal', principal: ref, principalKind: principal.kind }])}
				>
					<Icon name="trash" /> Drop
				</button>
			</div>

			{principal.attributes && (
				<fieldset className="sec-card">
					<legend>Details</legend>
					<dl className="sec-attrs">
						{Object.entries(principal.attributes).map(([label, value]) => (
							<div key={label}><dt>{label}</dt><dd>{value}</dd></div>
						))}
						{principal.expiresAt && <div><dt>Expires</dt><dd>{principal.expiresAt}</dd></div>}
					</dl>
				</fieldset>
			)}

			<fieldset className="sec-card">
				<legend>Roles</legend>
				{principal.memberOf.length === 0
					? <div className="muted small">Holds no roles.</div>
					: (
						<div className="sec-chips">
							{principal.memberOf.map((role) => (
								<span className="sec-chip" key={role}>
									{role}
									<button
										type="button"
										className="icon-btn"
										aria-label={`Remove ${principalLabel(principal)} from ${role}`}
										onClick={() => onPropose([{ kind: 'revoke-role', principal: ref, role }])}
									><Icon name="close" /></button>
								</span>
							))}
						</div>
					)}
				{addable.length > 0 && (
					<label className="sec-add-role">
						Add to role
						<select
							value=""
							onChange={(e) => {
								if (e.target.value) {
									onPropose([{ kind: 'grant-role', principal: ref, role: e.target.value }]);
								}
							}}
						>
							<option value="">Choose a role…</option>
							{addable.map((role) => <option key={role} value={role}>{role}</option>)}
						</select>
					</label>
				)}
			</fieldset>

			{policies.length > 0 && (
				<fieldset className="sec-card">
					<legend>What else applies to this account</legend>
					<div className="muted small sec-note">
						These are not privileges. A row policy decides which ROWS of a table are visible, a quota
						decides how much may be used, and a settings profile decides what the session runs with.
					</div>
					<table className="sec-policy-table">
						<tbody>
							{policies.map((policy) => (
								<tr key={policySelectionKey(policy)}>
									<td><Icon name={POLICY_ICON[policy.kind]} /> {policyLabel(policy)}</td>
									<td className="sec-policy-detail">{policy.detail}</td>
									<td>{policy.restrictive && <span className="sec-badge" title="ANDed with the other policies on that table">restrictive</span>}</td>
								</tr>
							))}
						</tbody>
					</table>
				</fieldset>
			)}

			<fieldset className="sec-card sec-grants">
				<legend>Privileges</legend>
				<div className="sec-card-actions">
					<button type="button" onClick={() => onEdit({ kind: 'grant', principal })}><Icon name="add" /> Grant…</button>
				</div>
				{grants.length === 0
					? <div className="muted small">No privileges granted directly.</div>
					: (
						<table className="sec-grant-table">
							<thead>
								<tr><th>Scope</th><th>On</th><th>Privilege</th><th></th><th></th></tr>
							</thead>
							<tbody>
								{grants.map((grant, index) => (
									<tr key={`${grant.scope}-${grantObject(grant)}-${grant.privilege}-${index}`} className={grant.deny ? 'sec-deny' : undefined}>
										<td>{scopeLabel(grant.scope)}</td>
										<td>{grantObject(grant)}</td>
										<td>{grant.privilege}</td>
										<td>
											{grant.deny && <span className="sec-badge warn" title="A DENY overrides every grant, including one inherited from a role">DENY</span>}
											{grant.withGrantOption && <span className="sec-badge" title="Can pass this privilege on to others">grantable</span>}
										</td>
										<td>
											{!grant.deny && (
												<button
													type="button"
													className="icon-btn"
													aria-label={`Revoke ${grant.privilege} on ${grantObject(grant)}`}
													onClick={() => onPropose([{
														kind: 'revoke',
														principal: ref,
														target: { scope: grant.scope, database: grant.database, schema: grant.schema, object: grant.object, columns: grant.column ? [grant.column] : undefined },
														privileges: [grant.privilege],
													}])}
												><Icon name="close" /></button>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				{principal.memberOf.length > 0 && (
					<div className="muted small sec-note">
						These are the privileges granted directly. This {principal.kind} also holds {principal.memberOf.length === 1 ? 'a role' : `${principal.memberOf.length} roles`}, which may add more.
					</div>
				)}
			</fieldset>
		</>
	);
}

/**
 * The right-hand pane for a row policy, a quota or a settings profile.
 *
 * The question it is built to answer is "who does this act on", which is why the applies-to list
 * is editable here and nowhere else: the statement that changes it REPLACES the whole list
 * (`ALTER ROW POLICY p ON t TO a, b`), so the screen that knows the current list is the one that
 * has to send the new one.
 */
function PolicyDetail({ policy, principalNames, onPropose }: {
	policy: AccessPolicy;
	principalNames: readonly string[];
	onPropose(changes: SecurityChange[]): void;
}): JSX.Element {
	const ref = { kind: policy.kind, name: policy.name, database: policy.database, object: policy.object };
	// With `appliesToAll`, the list on screen is the EXCEPT list, and adding a name to it takes
	// the policy off that account rather than putting it on. One list, two meanings, so the
	// wording changes with it rather than the shape.
	const list = policy.appliesToAll ? policy.exceptFor : policy.appliesTo;
	const addable = principalNames.filter((name) => !list.includes(name));

	function setList(names: readonly string[]): void {
		onPropose([{ kind: 'set-policy-principals', policy: ref, appliesTo: names, appliesToAll: policy.appliesToAll }]);
	}

	return (
		<>
			<div className="sec-detail-head">
				<Icon name={POLICY_ICON[policy.kind]} className="sec-detail-icon" />
				<div className="sec-detail-name">
					<div className="sec-detail-title">{policy.name}</div>
					<div className="muted small">{POLICY_GROUP[policy.kind].replace(/s$/, '')}{policy.database && policy.object ? ` on ${policy.database}.${policy.object}` : ''}</div>
				</div>
				<span className="spacer" />
				<button type="button" className="danger" onClick={() => onPropose([{ kind: 'drop-policy', policy: ref }])}>
					<Icon name="trash" /> Drop
				</button>
			</div>

			<fieldset className="sec-card">
				<legend>{policy.kind === 'row-policy' ? 'Rows it allows' : policy.kind === 'quota' ? 'Limits' : 'Settings'}</legend>
				<div className="sec-policy-detail">{policy.detail || 'Nothing recorded.'}</div>
				{policy.kind === 'row-policy' && (
					<div className="muted small sec-note">
						{policy.restrictive
							? 'Restrictive: this is ANDed with every other policy on the table, so it can only take rows away.'
							: 'Permissive: this is ORed with the other permissive policies on the table. The first policy on a table hides every row no policy allows.'}
					</div>
				)}
			</fieldset>

			<fieldset className="sec-card">
				<legend>{policy.appliesToAll ? 'Applies to everyone except' : 'Applies to'}</legend>
				<div className="muted small sec-note">Applies to {appliesToLabel(policy.appliesToAll ? policy.exceptFor : policy.appliesTo, policy.appliesToAll)}.</div>
				{list.length > 0 && (
					<div className="sec-chips">
						{list.map((name) => (
							<span className="sec-chip" key={name}>
								{name}
								<button
									type="button"
									className="icon-btn"
									aria-label={policy.appliesToAll ? `Stop excepting ${name}` : `Stop applying to ${name}`}
									onClick={() => setList(list.filter((other) => other !== name))}
								><Icon name="close" /></button>
							</span>
						))}
					</div>
				)}
				{addable.length > 0 && (
					<label className="sec-add-role">
						{policy.appliesToAll ? 'Except' : 'Apply to'}
						<select
							value=""
							onChange={(e) => {
								if (e.target.value) {
									setList([...list, e.target.value]);
								}
							}}
						>
							<option value="">Choose a user or role…</option>
							{addable.map((name) => <option key={name} value={name}>{name}</option>)}
						</select>
					</label>
				)}
			</fieldset>

			{policy.attributes && (
				<fieldset className="sec-card">
					<legend>Details</legend>
					<dl className="sec-attrs">
						{Object.entries(policy.attributes).map(([label, value]) => (
							<div key={label}><dt>{label}</dt><dd>{value}</dd></div>
						))}
					</dl>
				</fieldset>
			)}
		</>
	);
}

/** One row of a two-field list (a quota's limits, a profile's settings), edited in place. */
function PairRows({ label, rows, names, unit, onChange }: {
	label: string;
	rows: readonly PolicySetting[];
	/** A fixed vocabulary offers a picker; undefined means the name is typed. */
	names?: readonly string[];
	unit?: string;
	onChange(rows: PolicySetting[]): void;
}): JSX.Element {
	function set(index: number, patch: Partial<PolicySetting>): void {
		onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
	}
	return (
		<>
			{rows.map((row, index) => (
				<div className="sec-pair" key={index}>
					{names
						? (
							<select aria-label={`${label} ${index + 1}`} value={row.name} onChange={(e) => set(index, { name: e.target.value })}>
								{names.map((name) => <option key={name} value={name}>{name}</option>)}
							</select>
						)
						: <input aria-label={`${label} ${index + 1}`} type="text" value={row.name} placeholder="setting" onChange={(e) => set(index, { name: e.target.value })} />}
					<input aria-label={`${label} ${index + 1} value`} type="text" value={row.value} placeholder={unit ?? 'value'} onChange={(e) => set(index, { value: e.target.value })} />
					<button type="button" className="icon-btn" aria-label="Remove" onClick={() => onChange(rows.filter((_, i) => i !== index))}><Icon name="close" /></button>
				</div>
			))}
			<button type="button" className="secondary" onClick={() => onChange([...rows, { name: names ? names[0] : '', value: '' }])}>
				<Icon name="add" /> Add {label.toLowerCase()}
			</button>
		</>
	);
}

/** ClickHouse's own quota windows, offered rather than typed. */
const QUOTA_UNITS = ['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];
const QUOTA_METRICS = ['queries', 'query_selects', 'query_inserts', 'errors', 'result_rows', 'result_bytes', 'read_rows', 'read_bytes', 'execution_time'];

/**
 * Create a row policy, a quota or a settings profile.
 *
 * Nothing here runs: like every other action on this screen it produces a change and hands it to
 * the review sheet, so the statement is read before it exists. The filter expression is the one
 * field that is SQL the person writes, and it is shown back to them in the statement.
 */
function NewPolicyDialog({ support, principalNames, onCancel, onPropose }: {
	support: SecuritySupport;
	principalNames: readonly string[];
	onCancel(): void;
	onPropose(changes: SecurityChange[]): void;
}): JSX.Element {
	const [kind, setKind] = useState<PolicyKind>(support.policyKinds[0] ?? 'row-policy');
	const [name, setName] = useState('');
	const [database, setDatabase] = useState('');
	const [object, setObject] = useState('');
	const [expression, setExpression] = useState('');
	const [restrictive, setRestrictive] = useState(false);
	const [duration, setDuration] = useState('1');
	const [unit, setUnit] = useState('hour');
	const [limits, setLimits] = useState<PolicySetting[]>([{ name: 'queries', value: '' }]);
	const [settings, setSettings] = useState<PolicySetting[]>([{ name: '', value: '' }]);
	const [appliesTo, setAppliesTo] = useState<string[]>([]);

	const ready = name.trim() !== ''
		&& (kind !== 'row-policy' || (database.trim() !== '' && object.trim() !== '' && expression.trim() !== ''))
		&& (kind !== 'settings-profile' || settings.some((setting) => setting.name.trim() !== '' && setting.value.trim() !== ''));

	function submit(): void {
		const draft: PolicyDraft = {
			kind,
			name: name.trim(),
			database: kind === 'row-policy' ? database.trim() : undefined,
			object: kind === 'row-policy' ? object.trim() : undefined,
			expression: kind === 'row-policy' ? expression.trim() : undefined,
			restrictive: kind === 'row-policy' ? restrictive : undefined,
			interval: kind === 'quota'
				? { duration: Number(duration), unit, limits: limits.filter((limit) => limit.value.trim() !== '') }
				: undefined,
			settings: kind === 'settings-profile' ? settings.filter((setting) => setting.name.trim() !== '') : undefined,
			appliesTo,
			appliesToAll: false,
		};
		onPropose([{ kind: 'create-policy', draft }]);
	}

	return (
		<div className="modal-backdrop" onClick={onCancel}>
			<div className="modal sec-modal" onClick={(e) => e.stopPropagation()}>
				<h2><Icon name="shield" /> New policy</h2>
				<div className="sec-modal-body">
					{support.policyKinds.length > 1 && (
						<label>
							Kind
							<select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as PolicyKind)}>
								{support.policyKinds.map((k) => <option key={k} value={k}>{POLICY_GROUP[k].replace(/s$/, '')}</option>)}
							</select>
						</label>
					)}
					<p className="field-hint">{POLICY_BLURB[kind]}</p>

					<label>
						Name
						<input aria-label="Name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="own_rows_only" />
					</label>

					{kind === 'row-policy' && (
						<>
							<label>
								Database
								<input aria-label="Database" type="text" value={database} onChange={(e) => setDatabase(e.target.value)} />
							</label>
							<label>
								Table
								<input aria-label="Table" type="text" value={object} onChange={(e) => setObject(e.target.value)} />
							</label>
							<label>
								Rows it allows
								<input aria-label="Rows it allows" type="text" value={expression} onChange={(e) => setExpression(e.target.value)} placeholder="tenant_id = currentUser()" />
							</label>
							<p className="field-hint">A condition on that table's own columns. A row is visible when it is true.</p>
							<label className="check">
								<input type="checkbox" checked={restrictive} onChange={(e) => setRestrictive(e.target.checked)} />
								<span>Restrictive</span>
							</label>
							<p className="field-hint">Restrictive policies are ANDed with the others, so they can only take rows away. A permissive one is ORed and can give them back.</p>
						</>
					)}

					{kind === 'quota' && (
						<>
							<label>
								Window
								<input aria-label="Window" type="number" min="1" value={duration} onChange={(e) => setDuration(e.target.value)} />
							</label>
							<label>
								Unit
								<select aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
									{QUOTA_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
								</select>
							</label>
							<PairRows label="Limit" rows={limits} names={QUOTA_METRICS} unit="number" onChange={setLimits} />
							<p className="field-hint">Counted per account. A window with no limits tracks usage without refusing anything.</p>
						</>
					)}

					{kind === 'settings-profile' && (
						<>
							<PairRows label="Setting" rows={settings} onChange={setSettings} />
							<p className="field-hint">A setting name as the server spells it, such as max_memory_usage or readonly.</p>
						</>
					)}

					{principalNames.length > 0 && (
						<>
							<div className="sec-check-list-title">Applies to</div>
							<div className="sec-check-list">
								{principalNames.map((who) => (
									<label className="sec-check" key={who}>
										<input
											type="checkbox"
											checked={appliesTo.includes(who)}
											onChange={(e) => setAppliesTo(e.target.checked ? [...appliesTo, who] : appliesTo.filter((name) => name !== who))}
										/>
										<span>{who}</span>
									</label>
								))}
							</div>
							<p className="field-hint">{appliesTo.length === 0 ? 'It will exist and apply to nobody until you say who.' : `It will apply to ${appliesToLabel(appliesTo, false)}.`}</p>
						</>
					)}
				</div>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onCancel}><Icon name="close" /> Cancel</button>
					<button type="button" className="primary" disabled={!ready} onClick={submit}><Icon name="eye" /> Review statement</button>
				</div>
			</div>
		</div>
	);
}

/** Create a user, a role, or (SQL Server) a server login. */
function NewPrincipalDialog({ support, roleNames, seed, onCancel, onPropose }: {
	support: SecuritySupport;
	roleNames: readonly string[];
	/** A draft to prefill from (the assistant's proposal). Never carries a password. */
	seed?: PrincipalDraft;
	onCancel(): void;
	onPropose(changes: SecurityChange[]): void;
}): JSX.Element {
	const [kind, setKind] = useState<PrincipalKind>(seed?.kind ?? support.principalKinds[0] ?? 'user');
	const [name, setName] = useState(seed?.name ?? '');
	const [host, setHost] = useState(seed?.host ?? '%');
	const [password, setPassword] = useState('');
	const [memberOf, setMemberOf] = useState<string[]>([...(seed?.memberOf ?? [])]);

	const needsPassword = kind !== 'role';
	const ready = name.trim() !== '' && (!needsPassword || password !== '');

	function submit(): void {
		onPropose([{
			kind: 'create-principal',
			draft: {
				kind,
				name: name.trim(),
				host: support.usesHost ? host.trim() || '%' : undefined,
				password: needsPassword ? password : undefined,
				memberOf,
			},
		}]);
	}

	return (
		<div className="modal-backdrop" onClick={onCancel}>
			<div className="modal sec-modal" onClick={(e) => e.stopPropagation()}>
				<h2><Icon name="person" /> New user</h2>
				<div className="sec-modal-body">
					<fieldset>
						<legend>Who</legend>
						{support.principalKinds.length > 1 && (
							<label>Kind
								<select value={kind} onChange={(e) => setKind(e.target.value as PrincipalKind)}>
									{support.principalKinds.map((k) => <option key={k} value={k}>{KIND_GROUP[k].replace(/s$/, '')}</option>)}
								</select>
							</label>
						)}
						<label>Name
							<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="app" />
						</label>
						{support.usesHost && (
							<label>Host
								<input value={host} onChange={(e) => setHost(e.target.value)} placeholder="%" />
							</label>
						)}
						{support.usesHost && (
							<div className="muted small">
								On MySQL the host is part of the account: <code>app@localhost</code> and <code>app@%</code> are two different accounts with two different sets of privileges.
							</div>
						)}
					</fieldset>
					{needsPassword && (
						<fieldset>
							<legend>Password</legend>
							<label>Password
								<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
							</label>
							<div className="muted small">
								Typed here and used once, in the statement you are about to review. It is never written to your query history, never sent to a model, and never stored by the app.
							</div>
						</fieldset>
					)}
					{roleNames.length > 0 && (
						<fieldset>
							<legend>Roles</legend>
							<div className="tick-grid">
								{roleNames.map((role) => (
									<label className="tick" key={role}>
										<input
											type="checkbox"
											checked={memberOf.includes(role)}
											onChange={(e) => setMemberOf((prev) => e.target.checked ? [...prev, role] : prev.filter((r) => r !== role))}
										/>
										<span title={role}>{role}</span>
									</label>
								))}
							</div>
						</fieldset>
					)}
				</div>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onCancel}><Icon name="close" /> Cancel</button>
					<button type="button" className="primary" disabled={!ready} onClick={submit}><Icon name="eye" /> Review statements</button>
				</div>
			</div>
		</div>
	);
}

function SetPasswordDialog({ principal, onCancel, onPropose }: {
	principal: Principal;
	onCancel(): void;
	onPropose(changes: SecurityChange[]): void;
}): JSX.Element {
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const mismatch = confirm !== '' && confirm !== password;

	return (
		<div className="modal-backdrop" onClick={onCancel}>
			<div className="modal sec-modal" onClick={(e) => e.stopPropagation()}>
				<h2><Icon name="key" /> Set password for {principalLabel(principal)}</h2>
				<div className="sec-modal-body">
					<fieldset>
						<legend>New password</legend>
						<label>Password
							<input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
						</label>
						<label>Confirm
							<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
						</label>
						{mismatch && <div className="results-error">The two passwords do not match.</div>}
					</fieldset>
				</div>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onCancel}><Icon name="close" /> Cancel</button>
					<button
						type="button"
						className="primary"
						disabled={password === '' || password !== confirm}
						onClick={() => onPropose([{ kind: 'set-password', principal: { name: principal.name, host: principal.host }, password }])}
					><Icon name="eye" /> Review statement</button>
				</div>
			</div>
		</div>
	);
}

/** Grant privileges on one object. The object is typed rather than picked from a tree: the tree
 *  would need the whole schema for every database on the server, and the name is what the user
 *  already knows. */
function GrantDialog({ principal, support, driverId, onCancel, onPropose }: {
	principal: Principal;
	support: SecuritySupport;
	driverId: string;
	onCancel(): void;
	onPropose(changes: SecurityChange[]): void;
}): JSX.Element {
	const widest = support.grantScopes[support.grantScopes.length - 1];
	const [scope, setScope] = useState<GrantScope>(support.grantScopes.includes('table') ? 'table' : widest);
	const [database, setDatabase] = useState('');
	const [schema, setSchema] = useState('');
	const [object, setObject] = useState('');
	const [columns, setColumns] = useState('');
	const [privileges, setPrivileges] = useState<string[]>([]);
	const [grantable, setGrantable] = useState(false);
	// The privilege list is per engine AND per scope, and it lives in the engine, so it is read
	// from there rather than duplicated in the UI.
	const offered = useMemo(() => privilegesFor(driverId, scope), [driverId, scope]);

	const needsObject = scope === 'table' || scope === 'column';
	const ready = privileges.length > 0 && (!needsObject || object.trim() !== '');

	function submit(): void {
		onPropose([{
			kind: 'grant',
			principal: { name: principal.name, host: principal.host },
			target: {
				scope,
				database: database.trim() || undefined,
				schema: schema.trim() || undefined,
				object: object.trim() || undefined,
				columns: scope === 'column' ? columns.split(',').map((c) => c.trim()).filter(Boolean) : undefined,
			},
			privileges,
			withGrantOption: grantable,
		}]);
	}

	return (
		<div className="modal-backdrop" onClick={onCancel}>
			<div className="modal sec-modal" onClick={(e) => e.stopPropagation()}>
				<h2><Icon name="shield" /> Grant to {principalLabel(principal)}</h2>
				<div className="sec-modal-body">
					<fieldset>
						<legend>On what</legend>
						<label>Scope
							<select value={scope} onChange={(e) => { setScope(e.target.value as GrantScope); setPrivileges([]); }}>
								{[...support.grantScopes].reverse().map((s) => <option key={s} value={s}>{scopeLabel(s)}</option>)}
							</select>
						</label>
						{(scope === 'database' || support.usesHost) && scope !== 'global' && (
							<label>Database<input value={database} onChange={(e) => setDatabase(e.target.value)} /></label>
						)}
						{(scope === 'schema' || ((scope === 'table' || scope === 'column') && !support.usesHost)) && (
							<label>Schema<input value={schema} onChange={(e) => setSchema(e.target.value)} /></label>
						)}
						{needsObject && <label>Table<input value={object} onChange={(e) => setObject(e.target.value)} /></label>}
						{scope === 'column' && (
							<label>Columns<input value={columns} onChange={(e) => setColumns(e.target.value)} placeholder="total, status" /></label>
						)}
					</fieldset>
					<fieldset>
						<legend>Privileges</legend>
						<div className="tick-grid">
							{offered.map((privilege) => (
								<label className="tick" key={privilege}>
									<input
										type="checkbox"
										checked={privileges.includes(privilege)}
										onChange={(e) => setPrivileges((prev) => e.target.checked ? [...prev, privilege] : prev.filter((p) => p !== privilege))}
									/>
									<span title={privilege}>{privilege}</span>
								</label>
							))}
						</div>
						<label className="check">
							<input type="checkbox" checked={grantable} onChange={(e) => setGrantable(e.target.checked)} />
							Let them grant this to others
						</label>
					</fieldset>
				</div>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onCancel}><Icon name="close" /> Cancel</button>
					<button type="button" className="primary" disabled={!ready} onClick={submit}><Icon name="eye" /> Review statement</button>
				</div>
			</div>
		</div>
	);
}

/**
 * The review sheet: the statements, in order, with the sentence that explains each one, and the
 * only Apply button in the feature. A statement carrying a password is masked until asked for,
 * so a shared screen does not leak what was just typed.
 */
function ReviewSheet({ connectionId, changes, onClose, onApplied }: {
	connectionId: string;
	changes: readonly SecurityChange[];
	onClose(): void;
	onApplied(): void;
}): JSX.Element {
	const [plan, setPlan] = useState<SecurityPlan | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [applying, setApplying] = useState(false);
	const [reveal, setReveal] = useState(false);

	useEffect(() => {
		let live = true;
		setError(null);
		void window.sqlApi.securityPlan(connectionId, [...changes])
			.then((value) => { if (live) { setPlan(value); } })
			.catch((err: unknown) => { if (live) { setError(errorMessage(err)); } });
		return () => { live = false; };
	}, [connectionId, changes]);

	function apply(): void {
		setApplying(true);
		setError(null);
		void window.sqlApi.securityApply(connectionId, [...changes])
			.then((result) => {
				setApplying(false);
				if (result.ok) {
					onApplied();
					return;
				}
				// Three of the four engines auto-commit each statement, so a failure halfway
				// really has done half of it. Say which half rather than implying a rollback.
				const done = result.applied > 0 ? ` ${result.applied} earlier statement${result.applied === 1 ? '' : 's'} already took effect.` : '';
				setError(`${result.description} did not work: ${result.error}${done}`);
			})
			.catch((err: unknown) => {
				setApplying(false);
				setError(errorMessage(err));
			});
	}

	const destructive = plan?.statements.some((statement) => statement.destructive) ?? false;
	const hasSecret = plan?.statements.some((statement) => statement.carriesSecret) ?? false;

	return (
		<div className="modal-backdrop" onClick={applying ? undefined : onClose}>
			<div className="modal sec-modal sec-review" onClick={(e) => e.stopPropagation()}>
				<h2><Icon name="law" /> Review before running</h2>
				<div className="sec-modal-body">
					{error && <div className="results-error">{error}</div>}
					{!plan && !error && <div className="results-message">Building the statements…</div>}
					{plan && (
						<>
							{destructive && (
								<div className="sec-warn-banner">
									<Icon name="warning" /> This takes access away. It is not undone by running it again.
								</div>
							)}
							<ol className="sec-plan">
								{plan.statements.map((statement) => (
									<li key={statement.id} className={statement.destructive ? 'destructive' : undefined}>
										<div className="sec-plan-desc">{statement.description}</div>
										<pre className="sec-plan-sql">{statement.carriesSecret && !reveal ? redactSqlSecrets(statement.sql) : statement.sql}</pre>
									</li>
								))}
							</ol>
							{hasSecret && (
								<label className="check">
									<input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
									Show the password in the statement
								</label>
							)}
						</>
					)}
				</div>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" disabled={applying} onClick={onClose}><Icon name="close" /> Cancel</button>
					<button type="button" className={destructive ? 'danger' : 'primary'} disabled={!plan || applying} onClick={apply}><Icon name="play" /> 
						{applying ? 'Running…' : destructive ? 'Run anyway' : 'Run'}
					</button>
				</div>
			</div>
		</div>
	);
}

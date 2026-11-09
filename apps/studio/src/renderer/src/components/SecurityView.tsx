/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { useI18n, useT, type Translate } from '../i18n';
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
const KIND_GROUP: Record<PrincipalKind, string> = { user: 'security.kinds.users', role: 'security.kinds.roles', login: 'security.kinds.logins', group: 'security.kinds.groups' };
const KIND_ONE: Record<PrincipalKind, string> = { user: 'security.kinds.user', role: 'security.kinds.role', login: 'security.kinds.login', group: 'security.kinds.group' };
const GROUP_ORDER: PrincipalKind[] = ['user', 'role', 'login', 'group'];

const POLICY_ICON: Record<PolicyKind, string> = { 'row-policy': 'filter', 'quota': 'dashboard', 'settings-profile': 'settings-gear' };
const POLICY_GROUP: Record<PolicyKind, string> = { 'row-policy': 'security.policies.rowPolicies', 'quota': 'security.policies.quotas', 'settings-profile': 'security.policies.settingsProfiles' };
const POLICY_ONE: Record<PolicyKind, string> = { 'row-policy': 'security.policies.rowPolicy', 'quota': 'security.policies.quota', 'settings-profile': 'security.policies.settingsProfile' };
const POLICY_ORDER: PolicyKind[] = ['row-policy', 'quota', 'settings-profile'];

/** What each kind is FOR, said once on the screen that creates it. The three are easy to confuse
 *  and only one of them takes data away. */
const POLICY_BLURB: Record<PolicyKind, string> = {
	'row-policy': 'security.policies.blurbRow',
	'quota': 'security.policies.blurbQuota',
	'settings-profile': 'security.policies.blurbProfile',
};

/** The selection key for a policy, kept apart from a principal's so one list can hold both. */
function policySelectionKey(policy: AccessPolicy): string {
	return `policy!${policyKey(policy)}`;
}

function scopeLabel(scope: GrantScope, t: Translate): string {
	switch (scope) {
		case 'global': return t('security.scope.server');
		case 'database': return t('security.scope.database');
		case 'schema': return t('security.scope.schema');
		case 'column': return t('security.scope.column');
		default: return t('security.scope.table');
	}
}

/** The object a grant is on, as one path. */
function grantObject(grant: Grant, t: Translate): string {
	const parts = [grant.database, grant.schema, grant.object].filter((part): part is string => !!part);
	const path = parts.join('.');
	if (grant.column) {
		return `${path} (${grant.column})`;
	}
	return path || t('security.wholeServer');
}

export function SecurityView({ connections, connectedIds, connectionId, proposal }: SecurityViewProps): JSX.Element {
	const t = useT();
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
			.sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope) || grantObject(a, t).localeCompare(grantObject(b, t)) || a.privilege.localeCompare(b.privilege));
	}, [selected, snapshot, usesHost, hidePlatform, t]);

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
		return <div className="table-view"><div className="results-message">{t('security.selectDatabase')}</div></div>;
	}
	if (support && !support.supported) {
		return (
			<div className="table-view">
				<div className="tv-head">
					<Icon name="shield" className="tv-head-icon" />
					<span className="tv-title">{t('security.title')}</span>
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
				<span className="tv-title">{t('security.title')}</span>
				<span className="muted">{conn?.label ?? ''}</span>
				<button type="button" disabled={!connected || loading} title={t('security.refreshTitle')} onClick={reload}>
					<Icon name="refresh" /> {loading ? t('security.reading') : t('security.refresh')}
				</button>
				<button type="button" disabled={!connected} title={t('security.newUserTitle')} onClick={() => setEditor({ kind: 'new-principal' })}>
					<Icon name="add" /> {t('security.newUser')}
				</button>
				{(support?.policyKinds.length ?? 0) > 0 && (
					<button type="button" disabled={!connected} title={t('security.newPolicyTitle')} onClick={() => setEditor({ kind: 'new-policy' })}>
						<Icon name="add" /> {t('security.newPolicy')}
					</button>
				)}
				<span className="spacer" />
			</div>

			{!connected
				? <div className="results-message">{t('security.connectToSee', { name: conn?.label ?? t('security.thisDatabase') })}</div>
				: error
					? <div className="results-error">{error}</div>
					: (
						<>
						{(snapshot?.warnings.length ?? 0) > 0 && (
							<div className="sec-warnings">
								<Icon name="info" />
								<div>
									<div>{t('security.cannotReadAll')}</div>
									<ul>{snapshot?.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
								</div>
							</div>
						)}
						<div className="sec-body">
							<div className="sec-list">
								<input
									className="sec-filter"
									type="search"
									placeholder={t('security.filter')}
									value={filter}
									onChange={(e) => setFilter(e.target.value)}
								/>
								{loading && principals.length === 0
									? <div className="results-message">{t('security.readingUsers')}</div>
									: grouped.length === 0
										? <div className="results-message">{principals.length === 0 ? t('security.noUsers') : t('security.noMatch')}</div>
										: grouped.map((group) => (
											<div className="sec-group" key={group.kind}>
												<div className="sec-group-title">{t(KIND_GROUP[group.kind])}</div>
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
															{principal.isSuperuser && <span className="sec-badge warn" title={principal.superuserVia ? t('security.superVia', { role: principal.superuserVia }) : t('security.superHolds')}>{t('security.badgeSuper')}</span>}
															{principal.disabled && <span className="sec-badge" title={t('security.disabledTitle')}>{t('security.badgeOff')}</span>}
														</button>
													);
												})}
											</div>
										))}
								{policyGroups.map((group) => (
									<div className="sec-group" key={group.kind}>
										<div className="sec-group-title">{t(POLICY_GROUP[group.kind])}</div>
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
													{policy.restrictive && <span className="sec-badge" title={t('security.restrictiveTitle')}>{t('security.badgeRestrictive')}</span>}
													{policy.appliesToAll && <span className="sec-badge warn" title={policy.exceptFor.length > 0 ? t('security.everyoneExcept', { names: policy.exceptFor.join(', ') }) : t('security.everyoneTitle')}>{t('security.badgeEveryone')}</span>}
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
										? <div className="results-message">{t('security.selectToSee')}</div>
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
	const t = useT();
	const ref = { name: principal.name, host: principal.host };
	const addable = roleNames.filter((role) => !principal.memberOf.includes(role) && role !== principal.name);

	return (
		<>
			<div className="sec-detail-head">
				<Icon name={KIND_ICON[principal.kind]} className="sec-detail-icon" />
				<div className="sec-detail-name">
					<div className="sec-detail-title">{principalLabel(principal)}</div>
					<div className="muted small">{t(KIND_ONE[principal.kind])}{principal.canLogin ? t('security.canSignIn') : t('security.cannotSignIn')}</div>
				</div>
				<span className="spacer" />
				{principal.kind !== 'role' && (
					<>
						<button type="button" onClick={() => onEdit({ kind: 'set-password', principal })}><Icon name="key" /> {t('security.setPassword')}</button>
						<button type="button" onClick={() => onPropose([{ kind: 'set-enabled', principal: ref, enabled: principal.disabled }])}>
							<Icon name={principal.disabled ? 'unlock' : 'lock'} /> {principal.disabled ? t('security.enable') : t('security.disable')}
						</button>
					</>
				)}
				<button
					type="button"
					className="danger"
					onClick={() => onPropose([{ kind: 'drop-principal', principal: ref, principalKind: principal.kind }])}
				>
					<Icon name="trash" /> {t('security.drop')}
				</button>
			</div>

			{principal.attributes && (
				<fieldset className="sec-card">
					<legend>{t('security.details')}</legend>
					<dl className="sec-attrs">
						{Object.entries(principal.attributes).map(([label, value]) => (
							<div key={label}><dt>{label}</dt><dd>{value}</dd></div>
						))}
						{principal.expiresAt && <div><dt>{t('security.expires')}</dt><dd>{principal.expiresAt}</dd></div>}
					</dl>
				</fieldset>
			)}

			<fieldset className="sec-card">
				<legend>{t('security.roles')}</legend>
				{principal.memberOf.length === 0
					? <div className="muted small">{t('security.noRoles')}</div>
					: (
						<div className="sec-chips">
							{principal.memberOf.map((role) => (
								<span className="sec-chip" key={role}>
									{role}
									<button
										type="button"
										className="icon-btn"
										aria-label={t('security.removeFromRole', { who: principalLabel(principal), role })}
										onClick={() => onPropose([{ kind: 'revoke-role', principal: ref, role }])}
									><Icon name="close" /></button>
								</span>
							))}
						</div>
					)}
				{addable.length > 0 && (
					<label className="sec-add-role">
						{t('security.addToRole')}
						<select
							value=""
							onChange={(e) => {
								if (e.target.value) {
									onPropose([{ kind: 'grant-role', principal: ref, role: e.target.value }]);
								}
							}}
						>
							<option value="">{t('security.chooseRole')}</option>
							{addable.map((role) => <option key={role} value={role}>{role}</option>)}
						</select>
					</label>
				)}
			</fieldset>

			{policies.length > 0 && (
				<fieldset className="sec-card">
					<legend>{t('security.alsoApplies')}</legend>
					<div className="muted small sec-note">
						{t('security.alsoAppliesNote')}
					</div>
					<table className="sec-policy-table">
						<tbody>
							{policies.map((policy) => (
								<tr key={policySelectionKey(policy)}>
									<td><Icon name={POLICY_ICON[policy.kind]} /> {policyLabel(policy)}</td>
									<td className="sec-policy-detail">{policy.detail}</td>
									<td>{policy.restrictive && <span className="sec-badge" title={t('security.restrictiveTableTitle')}>{t('security.badgeRestrictive')}</span>}</td>
								</tr>
							))}
						</tbody>
					</table>
				</fieldset>
			)}

			<fieldset className="sec-card sec-grants">
				<legend>{t('security.privileges')}</legend>
				<div className="sec-card-actions">
					<button type="button" onClick={() => onEdit({ kind: 'grant', principal })}><Icon name="add" /> {t('security.grant')}</button>
				</div>
				{grants.length === 0
					? <div className="muted small">{t('security.noPrivileges')}</div>
					: (
						<table className="sec-grant-table">
							<thead>
								<tr><th>{t('security.scopeHeader')}</th><th>{t('security.objectColumn')}</th><th>{t('security.privilegeHeader')}</th><th></th><th></th></tr>
							</thead>
							<tbody>
								{grants.map((grant, index) => (
									<tr key={`${grant.scope}-${grantObject(grant, t)}-${grant.privilege}-${index}`} className={grant.deny ? 'sec-deny' : undefined}>
										<td>{scopeLabel(grant.scope, t)}</td>
										<td>{grantObject(grant, t)}</td>
										<td>{grant.privilege}</td>
										<td>
											{grant.deny && <span className="sec-badge warn" title={t('security.denyTitle')}>DENY</span>}
											{grant.withGrantOption && <span className="sec-badge" title={t('security.grantableTitle')}>{t('security.badgeGrantable')}</span>}
										</td>
										<td>
											{!grant.deny && (
												<button
													type="button"
													className="icon-btn"
													aria-label={t('security.revokeOn', { privilege: grant.privilege, target: grantObject(grant, t) })}
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
						{t(`security.alsoHolds.${principal.kind}`, { count: principal.memberOf.length })}
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
	const t = useT();
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
					<div className="muted small">{policy.database && policy.object ? t('security.policies.onTable', { kind: t(POLICY_ONE[policy.kind]), table: `${policy.database}.${policy.object}` }) : t(POLICY_ONE[policy.kind])}</div>
				</div>
				<span className="spacer" />
				<button type="button" className="danger" onClick={() => onPropose([{ kind: 'drop-policy', policy: ref }])}>
					<Icon name="trash" /> {t('security.drop')}
				</button>
			</div>

			<fieldset className="sec-card">
				<legend>{policy.kind === 'row-policy' ? t('security.rowsItAllows') : policy.kind === 'quota' ? t('security.limits') : t('security.settings')}</legend>
				<div className="sec-policy-detail">{policy.detail || t('security.nothingRecorded')}</div>
				{policy.kind === 'row-policy' && (
					<div className="muted small sec-note">
						{policy.restrictive
							? t('security.restrictiveNote')
							: t('security.permissiveNote')}
					</div>
				)}
			</fieldset>

			<fieldset className="sec-card">
				<legend>{policy.appliesToAll ? t('security.everyoneExceptLegend') : t('security.appliesTo')}</legend>
				<div className="muted small sec-note">{t('security.appliesToWho', { who: appliesToLabel(policy.appliesToAll ? policy.exceptFor : policy.appliesTo, policy.appliesToAll) })}</div>
				{list.length > 0 && (
					<div className="sec-chips">
						{list.map((name) => (
							<span className="sec-chip" key={name}>
								{name}
								<button
									type="button"
									className="icon-btn"
									aria-label={policy.appliesToAll ? t('security.stopExcepting', { name }) : t('security.stopApplying', { name })}
									onClick={() => setList(list.filter((other) => other !== name))}
								><Icon name="close" /></button>
							</span>
						))}
					</div>
				)}
				{addable.length > 0 && (
					<label className="sec-add-role">
						{policy.appliesToAll ? t('security.except') : t('security.applyTo')}
						<select
							value=""
							onChange={(e) => {
								if (e.target.value) {
									setList([...list, e.target.value]);
								}
							}}
						>
							<option value="">{t('security.chooseUserOrRole')}</option>
							{addable.map((name) => <option key={name} value={name}>{name}</option>)}
						</select>
					</label>
				)}
			</fieldset>

			{policy.attributes && (
				<fieldset className="sec-card">
					<legend>{t('security.details')}</legend>
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
function PairRows({ kind, rows, names, unit, onChange }: {
	kind: 'limit' | 'setting';
	rows: readonly PolicySetting[];
	/** A fixed vocabulary offers a picker; undefined means the name is typed. */
	names?: readonly string[];
	unit?: string;
	onChange(rows: PolicySetting[]): void;
}): JSX.Element {
	const t = useT();
	function set(index: number, patch: Partial<PolicySetting>): void {
		onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
	}
	return (
		<>
			{rows.map((row, index) => (
				<div className="sec-pair" key={index}>
					{names
						? (
							<select aria-label={t(`security.pairs.${kind}.row`, { n: index + 1 })} value={row.name} onChange={(e) => set(index, { name: e.target.value })}>
								{names.map((name) => <option key={name} value={name}>{name}</option>)}
							</select>
						)
						: <input aria-label={t(`security.pairs.${kind}.row`, { n: index + 1 })} type="text" value={row.name} placeholder={t('security.pairs.settingPlaceholder')} onChange={(e) => set(index, { name: e.target.value })} />}
					<input aria-label={t(`security.pairs.${kind}.rowValue`, { n: index + 1 })} type="text" value={row.value} placeholder={unit ?? t('security.pairs.valuePlaceholder')} onChange={(e) => set(index, { value: e.target.value })} />
					<button type="button" className="icon-btn" aria-label={t('security.pairs.remove')} onClick={() => onChange(rows.filter((_, i) => i !== index))}><Icon name="close" /></button>
				</div>
			))}
			<button type="button" className="secondary" onClick={() => onChange([...rows, { name: names ? names[0] : '', value: '' }])}>
				<Icon name="add" /> {t(`security.pairs.${kind}.add`)}
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
	const t = useT();
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
				<h2><Icon name="shield" /> {t('security.newPolicy')}</h2>
				<div className="sec-modal-body">
					{support.policyKinds.length > 1 && (
						<label>
							{t('security.kind')}
							<select aria-label={t('security.kind')} value={kind} onChange={(e) => setKind(e.target.value as PolicyKind)}>
								{support.policyKinds.map((k) => <option key={k} value={k}>{t(POLICY_ONE[k])}</option>)}
							</select>
						</label>
					)}
					<p className="field-hint">{t(POLICY_BLURB[kind])}</p>

					<label>
						{t('security.name')}
						<input aria-label={t('security.name')} type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="own_rows_only" />
					</label>

					{kind === 'row-policy' && (
						<>
							<label>
								{t('security.scope.database')}
								<input aria-label={t('security.scope.database')} type="text" value={database} onChange={(e) => setDatabase(e.target.value)} />
							</label>
							<label>
								{t('security.scope.table')}
								<input aria-label={t('security.scope.table')} type="text" value={object} onChange={(e) => setObject(e.target.value)} />
							</label>
							<label>
								{t('security.rowsItAllows')}
								<input aria-label={t('security.rowsItAllows')} type="text" value={expression} onChange={(e) => setExpression(e.target.value)} placeholder="tenant_id = currentUser()" />
							</label>
							<p className="field-hint">{t('security.conditionHint')}</p>
							<label className="check">
								<input type="checkbox" checked={restrictive} onChange={(e) => setRestrictive(e.target.checked)} />
								<span>{t('security.restrictive')}</span>
							</label>
							<p className="field-hint">{t('security.restrictiveHint')}</p>
						</>
					)}

					{kind === 'quota' && (
						<>
							<label>
								{t('security.window')}
								<input aria-label={t('security.window')} type="number" min="1" value={duration} onChange={(e) => setDuration(e.target.value)} />
							</label>
							<label>
								{t('security.unit')}
								<select aria-label={t('security.unit')} value={unit} onChange={(e) => setUnit(e.target.value)}>
									{QUOTA_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
								</select>
							</label>
							<PairRows kind="limit" rows={limits} names={QUOTA_METRICS} unit="number" onChange={setLimits} />
							<p className="field-hint">{t('security.quotaHint')}</p>
						</>
					)}

					{kind === 'settings-profile' && (
						<>
							<PairRows kind="setting" rows={settings} onChange={setSettings} />
							<p className="field-hint">{t('security.settingHint')}</p>
						</>
					)}

					{principalNames.length > 0 && (
						<>
							<div className="sec-check-list-title">{t('security.appliesTo')}</div>
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
							<p className="field-hint">{appliesTo.length === 0 ? t('security.applyNobody') : t('security.applyTo2', { who: appliesToLabel(appliesTo, false) })}</p>
						</>
					)}
				</div>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onCancel}><Icon name="close" /> {t('connections.common.cancel')}</button>
					<button type="button" className="primary" disabled={!ready} onClick={submit}><Icon name="eye" /> {t('security.reviewStatement')}</button>
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
	const { t, tr } = useI18n();
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
				<h2><Icon name="person" /> {t('security.newUser')}</h2>
				<div className="sec-modal-body">
					<fieldset>
						<legend>{t('security.who')}</legend>
						{support.principalKinds.length > 1 && (
							<label>{t('security.kind')}
								<select value={kind} onChange={(e) => setKind(e.target.value as PrincipalKind)}>
									{support.principalKinds.map((k) => <option key={k} value={k}>{t(KIND_ONE[k])}</option>)}
								</select>
							</label>
						)}
						<label>{t('security.name')}
							<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="app" />
						</label>
						{support.usesHost && (
							<label>{t('security.host')}
								<input value={host} onChange={(e) => setHost(e.target.value)} placeholder="%" />
							</label>
						)}
						{support.usesHost && (
							<div className="muted small">
								{tr('security.mysqlHost')}
							</div>
						)}
					</fieldset>
					{needsPassword && (
						<fieldset>
							<legend>{t('security.password')}</legend>
							<label>{t('security.password')}
								<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
							</label>
							<div className="muted small">
								{t('security.passwordNote')}
							</div>
						</fieldset>
					)}
					{roleNames.length > 0 && (
						<fieldset>
							<legend>{t('security.roles')}</legend>
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
					<button type="button" className="secondary" onClick={onCancel}><Icon name="close" /> {t('connections.common.cancel')}</button>
					<button type="button" className="primary" disabled={!ready} onClick={submit}><Icon name="eye" /> {t('security.reviewStatements')}</button>
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
	const t = useT();
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const mismatch = confirm !== '' && confirm !== password;

	return (
		<div className="modal-backdrop" onClick={onCancel}>
			<div className="modal sec-modal" onClick={(e) => e.stopPropagation()}>
				<h2><Icon name="key" /> {t('security.setPasswordFor', { who: principalLabel(principal) })}</h2>
				<div className="sec-modal-body">
					<fieldset>
						<legend>{t('security.newPassword')}</legend>
						<label>{t('security.password')}
							<input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
						</label>
						<label>{t('security.confirm')}
							<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
						</label>
						{mismatch && <div className="results-error">{t('security.mismatch')}</div>}
					</fieldset>
				</div>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onCancel}><Icon name="close" /> {t('connections.common.cancel')}</button>
					<button
						type="button"
						className="primary"
						disabled={password === '' || password !== confirm}
						onClick={() => onPropose([{ kind: 'set-password', principal: { name: principal.name, host: principal.host }, password }])}
					><Icon name="eye" /> {t('security.reviewStatement')}</button>
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
	const t = useT();
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
				<h2><Icon name="shield" /> {t('security.grantTo', { who: principalLabel(principal) })}</h2>
				<div className="sec-modal-body">
					<fieldset>
						<legend>{t('security.onWhat')}</legend>
						<label>{t('security.scopeHeader')}
							<select value={scope} onChange={(e) => { setScope(e.target.value as GrantScope); setPrivileges([]); }}>
								{[...support.grantScopes].reverse().map((s) => <option key={s} value={s}>{scopeLabel(s, t)}</option>)}
							</select>
						</label>
						{(scope === 'database' || support.usesHost) && scope !== 'global' && (
							<label>{t('security.scope.database')}<input value={database} onChange={(e) => setDatabase(e.target.value)} /></label>
						)}
						{(scope === 'schema' || ((scope === 'table' || scope === 'column') && !support.usesHost)) && (
							<label>{t('security.scope.schema')}<input value={schema} onChange={(e) => setSchema(e.target.value)} /></label>
						)}
						{needsObject && <label>{t('security.scope.table')}<input value={object} onChange={(e) => setObject(e.target.value)} /></label>}
						{scope === 'column' && (
							<label>{t('security.columns')}<input value={columns} onChange={(e) => setColumns(e.target.value)} placeholder="total, status" /></label>
						)}
					</fieldset>
					<fieldset>
						<legend>{t('security.privileges')}</legend>
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
							{t('security.letGrant')}
						</label>
					</fieldset>
				</div>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onCancel}><Icon name="close" /> {t('connections.common.cancel')}</button>
					<button type="button" className="primary" disabled={!ready} onClick={submit}><Icon name="eye" /> {t('security.reviewStatement')}</button>
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
	const t = useT();
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
				const done = result.applied > 0 ? ` ${t('security.earlierApplied', { count: result.applied })}` : '';
				setError(`${t('security.didNotWork', { what: result.description, error: result.error })}${done}`);
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
				<h2><Icon name="law" /> {t('security.reviewTitle')}</h2>
				<div className="sec-modal-body">
					{error && <div className="results-error">{error}</div>}
					{!plan && !error && <div className="results-message">{t('security.building')}</div>}
					{plan && (
						<>
							{destructive && (
								<div className="sec-warn-banner">
									<Icon name="warning" /> {t('security.takesAway')}
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
									{t('security.showPassword')}
								</label>
							)}
						</>
					)}
				</div>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" disabled={applying} onClick={onClose}><Icon name="close" /> {t('connections.common.cancel')}</button>
					<button type="button" className={destructive ? 'danger' : 'primary'} disabled={!plan || applying} onClick={apply}><Icon name="play" /> 
						{applying ? t('security.running') : destructive ? t('security.runAnyway') : t('security.run')}
					</button>
				</div>
			</div>
		</div>
	);
}

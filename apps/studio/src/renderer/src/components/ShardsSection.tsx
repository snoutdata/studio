/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';
import { Status, type Said } from './projectUi';
import { formatBytes } from '../formatBytes';
import { onShardsProposal, takeShardsProposal } from '../shardsProposal';
import {
	FAILOVER_STEPS, failoverStep, jobFinished, joinWords, nextRange, nodePods, nodeShade, planIsSentence, planSentence, proposalFromRequest, rangeShares, ranSentence,
	homeReplicaStanding, replicaBlocked, replicaPods, replicaStanding, replicaWords, shardsOffered, shortBound, slotsSentence, spareSlots, splitAlerts,
	type ShardAdvice, type ShardAlert, type ShardJob, type ShardKeyspace, type ShardPlan, type ShardPod, type ShardsRunAction, type ShardsStatus,
} from '../../../shared/cloudShards';

/**
 * A cloud project's Cluster section: its nodes, each keyspace's
 * ranges as a bar over the hash space, the jobs with their progress, the advisor's
 * recommendations, and every operation as a REVIEW: what it needs, then the plan the router
 * computed (what moves, rows, copy time, expected write pause), then Run. Nothing runs on a click.
 *
 * The same review shows what the assistant or a coding agent proposed (`propose_cloud_cluster_
 * operation`): the proposal is filled in and planned, and a person presses Run or does not.
 *
 * A node added here joins on its own (the control plane drives it): it starts as a copy of the home node,
 * is attached once ready and takes its share of the data, and the section shows each step as it
 * happens, with Retry when one stops. Spread a table does a keyspace, the table and a rebalance in
 * one go.
 *
 * A data node can have a replica: a copy that follows it and takes its
 * place on its own if it is lost or corrupt. The section says per node whether one protects it,
 * shows a failover as its steps while it runs, and puts the cluster's alerts at the top, each
 * marked as seen from here.
 *
 * Every answer is `cloud-project-shards`'s, through main (op `shards`): the router decides, this
 * draws. Code-split behind the project tab (`lazyView` in ProjectView), so a launch never parses it.
 */

/** One input an operation asks for; `node` and `keyspace` are chosen from what the cluster has. */
interface Field {
	name: string;
	label: string;
	kind: 'text' | 'number' | 'node' | 'keyspace';
	optional?: boolean;
	hint?: string;
	placeholder?: string;
}

interface Review {
	title: string;
	action: ShardsRunAction;
	verb: string;
	request: Record<string, unknown>;
	fields?: Field[];
	reason?: string;
	/** Moves or deletes data, or a pod: the Run button is the danger one. */
	danger: boolean;
}

/** What the section is told by the function, typed from shared/cloudShards.ts. */
async function ask<T>(ref: string, body: Record<string, unknown> & { action: string }): Promise<T> {
	const outcome = await window.sqlApi.cloudProject('shards', { ref, ...body });
	if (!outcome.ok) {
		throw Object.assign(new Error(outcome.message), { refused: outcome.refused });
	}
	return outcome.data as unknown as T;
}

function said(error: unknown): Said {
	return { ok: false, message: error instanceof Error ? error.message : String(error), refused: (error as { refused?: boolean }).refused === true };
}

const POLL_MS = 3000;

/** The router's word for where a table lives, in the words the rest of this section uses. */
const TABLE_KIND: Readonly<Record<string, string>> = {
	sharded: "distributed",
	reference: "on every cluster node",
	global: "home node only",
};

/** Operations that change nothing a person would want to stop and think about. */
const QUIET: ReadonlySet<ShardsRunAction> = new Set(['verify', 'attach', 'add-node', 'keyspace', 'drop-keyspace', 'add-replica']);

const TITLES: Record<ShardsRunAction, string> = {
	enable: "Make it a cluster", disable: "Turn clustering off", 'add-node': "Add a cluster node", attach: "Attach a cluster node", drain: "Drain a cluster node", remove: "Remove a cluster node",
	keyspace: "Create a keyspace", 'drop-keyspace': "Drop a keyspace", distribute: "Distribute a table", reference: "Copy a table to every cluster node", global: "Bring a table home",
	split: "Split a range", merge: "Merge two ranges", move: "Move a range", pin: "Pin a tenant", rebalance: "Rebalance",
	scale: "Change the number of cluster nodes", verify: "Verify", cleanup: "Clean up", spread: "Spread a table",
	'add-replica': "Add a replica", 'remove-replica': "Remove a replica",
};

/** What a replica is, in the words the review opens with. */
const REPLICA_REASON = "A replica follows this node and takes its place on its own if the node is lost or corrupt. It takes one project slot.";
const HOME_REPLICA_REASON = "A replica follows the home node and takes its place on its own, on the same address, if the home is lost or corrupt. Without one, a broken home takes the whole cluster down until it is repaired. It takes one project slot.";

function review(action: ShardsRunAction, request: Record<string, unknown>, extra: Partial<Review> = {}): Review {
	return { title: TITLES[action], action, verb: TITLES[action].split(' ')[0], request, danger: !QUIET.has(action), ...extra };
}

export function ShardsSection({ projectRef }: { projectRef: string }): JSX.Element {
	const [status, setStatus] = useState<ShardsStatus | null>(null);
	const [jobs, setJobs] = useState<ShardJob[] | null>(null);
	const [advice, setAdvice] = useState<ShardAdvice | null>(null);
	const [message, setMessage] = useState<Said>(null);
	const [current, setCurrent] = useState<Review | null>(null);

	const refresh = useCallback(async () => {
		try {
			const next = await ask<ShardsStatus>(projectRef, { action: 'status' });
			setStatus(next);
			if (next.sharded && next.cluster) {
				setJobs((await ask<{ jobs: ShardJob[] }>(projectRef, { action: 'jobs' })).jobs);
			}
		} catch (e) {
			setMessage(said(e));
		}
	}, [projectRef]);

	const askAdvisor = useCallback(async (sampleMs?: number) => {
		try {
			setAdvice(await ask<ShardAdvice>(projectRef, { action: 'advice', ...(sampleMs === undefined ? {} : { sampleMs }) }));
		} catch (e) {
			setMessage(said(e));
		}
	}, [projectRef]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const sharded = status?.sharded === true && status.cluster !== null;
	useEffect(() => {
		if (sharded) {
			void askAdvisor(0);
		}
	}, [sharded, askAdvisor]);

	// A proposal from the assistant, now or while the section is open.
	useEffect(() => {
		function take(): void {
			const proposal = takeShardsProposal(projectRef);
			if (proposal) {
				setCurrent(review(proposal.action, proposal.request, { reason: proposal.reason ?? "Proposed by the assistant. Nothing runs until you press the button." }));
			}
		}
		take();
		return onShardsProposal((ref) => {
			if (ref === projectRef) {
				take();
			}
		});
	}, [projectRef]);

	// Polled while anything moves: a job, a pod being made, joining or leaving, a request the
	// cluster is finishing, or the router starting. Every status read also moves that work on (172).
	const moving = (jobs ?? []).some((j) => !jobFinished(j.state)) ||
		(status?.pods ?? []).some((p) => p.next === 'wait' || p.next === 'joining' || p.desiredState === 'deleted' || p.failover === 'fence' || p.failover === 'promote' || (p.wantsReplica === true && !p.replica)) ||
		Boolean(status?.sharded && (status.routerError || status.router === 'starting' || status.automation?.active));
	useEffect(() => {
		if (!moving) {
			return;
		}
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') {
				void refresh();
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [moving, refresh]);

	if (!status) {
		return <>{message ? <Status said={message} /> : <div className="field-hint">Loading…</div>}</>;
	}

	const cluster = status.cluster;
	const nodes = cluster?.nodes ?? [];
	const keyspaces = cluster?.keyspaces ?? [];
	const tables = cluster?.tables ?? [];
	const nodeName = (id: number): string => nodes.find((n) => n.id === id)?.name ?? `node ${id}`;
	const shadeOf = (id: number): number => nodeShade(Math.max(0, nodes.findIndex((n) => n.id === id)));
	const nodeCount = 1 + nodePods(status.pods).length;
	const replicas = replicaPods(status.pods);
	const knowsReplicas = status.pods.some((p) => p.replicaOf !== undefined);
	const podOf = (name: string): ShardPod | undefined => status.pods.find((p) => p.ref === name && !p.replicaOf);
	const failingOver = status.pods.filter((p) => p.failover);

	function finished(text: string): void {
		setCurrent(null);
		setMessage({ ok: true, message: text });
		void refresh();
	}

	return (
		<div className="shards-section">
			{current && (
				<ReviewSheet
					key={`${current.action}:${JSON.stringify(current.request)}`}
					projectRef={projectRef}
					review={current}
					status={status}
					onCancel={() => setCurrent(null)}
					onDone={finished}
				/>
			)}
			<Status said={message} />

			<AlertsGroup projectRef={projectRef} alerts={status.alerts} onDone={finished} onError={(e) => setMessage(said(e))} />

			{!status.sharded && (
				<fieldset>
					<legend>One database, several cluster nodes</legend>
					<p className="field-hint">
						A cluster spreads a table's rows over several cluster nodes by a column you choose, such as an account id, behind
						one connection string. Queries that name the column go to one cluster node; the rest are answered across all of them.
					</p>
					{shardsOffered(status) ? (
						<>
							<p className="field-hint">Each cluster node uses one of your plan's project slots, and you have {spareSlots(status)} free. Making it a cluster restarts the database once, and nothing moves until you add a cluster node.</p>
							<div className="cloud-actions">
								<button type="button" onClick={() => setCurrent(review('enable', {}, { danger: true, verb: "Make it a cluster" }))}><Icon name="split-horizontal" /> Make it a cluster</button>
							</div>
						</>
					) : (
						<p className="field-hint">{status.maxProjects === null || status.projectsUsed === null ? "Your plan could not be read just now." : `Each cluster node uses one of your plan's project slots, and all ${status.maxProjects} are in use.`}</p>
					)}
				</fieldset>
			)}

			{status.sharded && (
				<>
					{status.router === 'starting' && <div className="form-status">The router is starting beside the database, which takes about twenty seconds.</div>}
					{status.router === 'paused' && <div className="form-status">The project is paused. The router wakes with it on the next connection.</div>}
					{status.routerError && <div className="form-status warn">The router is not answering: {status.routerError}</div>}
					{status.automation?.queueError && (
						<div className="form-status warn">
							Spreading a table stopped: {status.automation.queueError}
							<RetryButtons projectRef={projectRef} body={{ queue: true }} dismiss="Drop the rest" onDone={finished} onError={(e) => setMessage(said(e))} />
						</div>
					)}
					{status.automation && !status.automation.queueError && (status.automation.queue.length > 0 || status.automation.queueJob !== null) && (
						<div className="form-status">Spreading a table{status.automation.queueJob !== null ? ` (job ${status.automation.queueJob})` : ''}{status.automation.queue.length > 0 ? `; then ${status.automation.queue.join(', ')}` : ''}.</div>
					)}
					<fieldset>
						<legend>Cluster nodes</legend>
						<div className="cloud-facts">
							<span className="muted">Cluster nodes</span><span>{nodeCount}</span>
							<span className="muted">Project slots</span><span>{slotsSentence(status) ?? "Plan limit unknown"}. Each cluster node{knowsReplicas ? " and replica" : ''} uses one.</span>
							{knowsReplicas && <><span className="muted">Replicas</span><span>{replicas.length}</span></>}
							<span className="muted">Keyspaces</span><span>{keyspaces.length}, {keyspaces.reduce((n, k) => n + k.ranges.length, 0)} ranges</span>
						</div>
						{nodes.length > 0 && (
							<table className="cloud-table">
								<thead><tr><th>Cluster node</th><th>State</th><th>Ranges</th><th>Size</th>{knowsReplicas && <th>Replica</th>}<th /></tr></thead>
								<tbody>
									{nodes.map((n) => {
										const facts = advice?.facts.nodes.find((f) => f.id === n.id);
										const pod = podOf(n.name);
										const standing = n.home ? homeReplicaStanding(status.home) : pod ? replicaStanding(pod) : 'unknown';
										const blocked = pod ? replicaBlocked(pod, status) : n.home && status.projectsUsed !== null && status.maxProjects !== null && spareSlots(status) === 0 ? "A replica takes one project slot, and all of your plan's are in use." : null;
										// 222: the home is the project, so its replica is asked for by the project's ref.
										const replicaTarget = n.home ? (status.home ? status.home.ref : null) : pod ? pod.ref : null;
										const replica = replicas.find((r) => r.replicaOf === n.name);
										return (
											<Fragment key={n.id}>
												<tr>
													<td>
														<span className="shards-swatch" style={{ '--shade': `${shadeOf(n.id)}%` } as CSSProperties} aria-hidden="true" />
														<span className="mono">{n.name}</span>{n.home && <span className="env">home</span>}
													</td>
													<td>{n.state}</td>
													<td>{n.ranges.length}</td>
													<td>{facts ? formatBytes(facts.db_bytes) : '-'}</td>
													{knowsReplicas && (
														<td>
															<span className={`shards-replica ${standing}`}>{replicaWords(standing)}</span>
														</td>
													)}
													<td className="cloud-table-action">
														{n.state !== 'removed' && (
															<span className="shards-row-actions">
																{replicaTarget && standing === 'none' && (
																	<button type="button" className="table-action" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => setCurrent(review('add-replica', { node: replicaTarget }, { verb: "Add the replica", reason: n.home ? HOME_REPLICA_REASON : REPLICA_REASON }))}>Add a replica</button>
																)}
																{replicaTarget && (standing === 'protected' || standing === 'making') && (
																	<button type="button" className="table-action" onClick={() => setCurrent(review('remove-replica', { node: replicaTarget }, { verb: "Remove the replica", reason: n.home ? "Without a replica, if the home node is lost or corrupt the whole cluster is unavailable until it is restored from its backups. Its project slot is freed." : "Without a replica, if this node is lost or corrupt its share of the data is unavailable until it is restored from its backups. Its project slot is freed." }))}>Remove replica</button>
																)}
																{!n.home && <button type="button" className="table-action" onClick={() => setCurrent(review('drain', { node: n.name }))}>Drain</button>}
																{!n.home && <button type="button" className="table-action" onClick={() => setCurrent(review('remove', { node: n.name }))}>Remove</button>}
															</span>
														)}
													</td>
												</tr>
												{replica && <ReplicaRow pod={replica} of={n.name} columns={knowsReplicas ? 6 : 5} />}
											</Fragment>
										);
									})}
									{replicas.filter((r) => !nodes.some((n) => n.name === r.replicaOf)).map((r) => (
										<ReplicaRow key={r.ref} pod={r} of={r.replicaOf ?? ''} columns={knowsReplicas ? 6 : 5} />
									))}
								</tbody>
							</table>
						)}
						{failingOver.map((p) => <FailoverRow key={`failover:${p.ref}`} pod={p} />)}
						{status.pods.filter((p) => !p.replicaOf && (p.next !== null || p.joining)).map((p) => (
							<PodRow key={p.ref} pod={p} projectRef={projectRef} onAttach={() => setCurrent(review('attach', { node: p.ref }))} onDone={finished} onError={(e) => setMessage(said(e))} />
						))}
						<div className="cloud-actions">
							<button type="button" onClick={() => setCurrent(review('add-node', {}, { verb: "Add", reason: "A new node starts as a copy of the home node, then joins the cluster and takes its share of the distributed tables on its own. Writes to a range pause for a moment when it moves. It uses one of your plan's project slots." }))}><Icon name="add" /> Add a cluster node</button>
							<button type="button" className="secondary" onClick={() => setCurrent(review('scale', {}, { verb: "Scale", fields: [{ name: 'nodes', label: "Cluster nodes, the home included", kind: 'number', placeholder: String(nodeCount + 1) }] }))}>Scale</button>
							<button type="button" className="secondary" onClick={() => void refresh()}><Icon name="refresh" /> Refresh</button>
						</div>
					</fieldset>

					{keyspaces.map((keyspace) => (
						<KeyspaceGroup key={keyspace.name} keyspace={keyspace} nodeName={nodeName} shadeOf={shadeOf} advice={advice} usedBy={tables.filter((t) => t.keyspace === keyspace.name).length} propose={setCurrent} />
					))}

					<fieldset>
						<legend>Tables</legend>
						{tables.length === 0 && <p className="field-hint">Every table is on the home node. Distribute one to spread its rows over the cluster nodes.</p>}
						{tables.length > 0 && (
							<table className="cloud-table">
								<thead><tr><th>Table</th><th>Kind</th><th>Keyspace</th><th>Distribution key</th><th /></tr></thead>
								<tbody>
									{tables.map((t) => (
										<tr key={t.table}>
											<td className="mono">{t.table}</td><td>{TABLE_KIND[t.kind] ?? t.kind}</td><td>{t.keyspace ?? '-'}</td><td className="mono">{t.column ?? '-'}</td>
											<td className="cloud-table-action">
												{t.kind !== 'global' && <button type="button" className="table-action" onClick={() => setCurrent(review('global', { table: t.table }, { verb: "Bring home" }))}>Bring home</button>}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
						<div className="cloud-actions">
							<button type="button" onClick={() => setCurrent(review('spread', {}, {
								verb: "Spread",
								reason: "In one go: a keyspace for the column (shared with tables keyed the same way), the table distributed by it, then its ranges spread over the nodes.",
								fields: [
									{ name: 'table', label: "Table", kind: 'text', placeholder: 'public.orders' },
									{ name: 'column', label: "Spread by column", kind: 'text', placeholder: 'account_id', hint: "A primary key or unique constraint must include it." },
									{ name: 'key_type', label: "Its type", kind: 'text', placeholder: 'bigint', hint: "bigint, int, text, uuid, and the other types the router hashes." },
								],
							}))}>Spread a table</button>
							<button type="button" className="secondary" disabled={keyspaces.length === 0} title={keyspaces.length === 0 ? "Create a keyspace first" : undefined} onClick={() => setCurrent(review('distribute', {}, {
								fields: [
									{ name: 'table', label: "Table", kind: 'text', placeholder: 'public.orders' },
									{ name: 'column', label: "Distribution key column", kind: 'text', placeholder: 'account_id', hint: "A primary key or unique constraint must include it." },
									{ name: 'keyspace', label: "Keyspace", kind: 'keyspace' },
								],
							}))}>Distribute a table</button>
							<button type="button" className="secondary" onClick={() => setCurrent(review('reference', {}, { verb: "Copy", fields: [{ name: 'table', label: "Table", kind: 'text', placeholder: 'public.countries' }] }))}>Copy to every cluster node</button>
							<button type="button" className="secondary" onClick={() => setCurrent(review('keyspace', {}, {
								fields: [
									{ name: 'name', label: "Name", kind: 'text', placeholder: 'accounts' },
									{ name: 'key_type', label: "Distribution key type", kind: 'text', placeholder: 'bigint', hint: "bigint, int, text, uuid, and the other types the router hashes." },
									{ name: 'ranges', label: "Ranges to start with", kind: 'number', optional: true, placeholder: '1' },
								],
							}))}>Create a keyspace</button>
						</div>
					</fieldset>

					<JobsGroup projectRef={projectRef} jobs={jobs} onChanged={finished} onError={(e) => setMessage(said(e))} />

					<fieldset>
						<legend>Recommendations</legend>
						{!advice && <div className="field-hint">Asking the advisor…</div>}
						{advice && <p className="field-hint">{advice.summary}</p>}
						{advice?.advice.map((one, i) => {
							const proposal = one.needs.length === 0 ? proposalFromRequest(one.request, one.reason) : null;
							return (
								<div key={i} className="shards-advice">
									<div className="cloud-actions">
										<strong>{one.op}</strong>
										<span className="env">{one.metric}</span>
										<span className="spacer" />
										{proposal && <button type="button" className="table-action" onClick={() => setCurrent(review(proposal.action, proposal.request, { reason: one.reason }))}>Review</button>}
									</div>
									<p className="field-hint">{one.reason}</p>
									{one.plan && <p className="field-hint">{planSentence(one.plan)}</p>}
									{one.needs.length > 0 && <p className="field-hint">Needs {one.needs.join(', ')} before it can be planned.</p>}
								</div>
							);
						})}
						<div className="cloud-actions">
							<button type="button" className="secondary" onClick={() => void askAdvisor()}>Measure write rates</button>
						</div>
					</fieldset>

					<fieldset>
						<legend>Turn clustering off</legend>
						<p className="field-hint">
							{nodeCount > 1
								? `Scale down to one cluster node first (this cluster has ${nodeCount}), so every row is on the home node.`
								: "Every row is on the home node, so turning it off moves nothing. The data is checked first, then the router leaves, which restarts the database once."}
						</p>
						<div className="cloud-actions">
							<button type="button" className="danger" disabled={nodeCount > 1} onClick={() => setCurrent(review('disable', {}, { verb: "Turn it off", danger: true }))}>Turn clustering off</button>
						</div>
					</fieldset>
				</>
			)}
		</div>
	);
}

/**
 * The cluster's alerts: open ones first, each with its severity and a Mark as seen button,
 * then those resolved in the last day, folded away. Seeing one changes nothing in the cluster.
 */
function AlertsGroup(props: { projectRef: string; alerts: ShardAlert[] | undefined; onDone(text: string): void; onError(e: unknown): void }): JSX.Element | null {
	const [busy, setBusy] = useState<string | null>(null);
	const { open, resolved } = splitAlerts(props.alerts);
	if (open.length === 0 && resolved.length === 0) {
		return null;
	}
	async function seen(alert: ShardAlert): Promise<void> {
		setBusy(alert.id);
		try {
			props.onDone(ranSentence(await ask<Record<string, unknown>>(props.projectRef, { action: 'acknowledge', alert: alert.id })));
		} catch (e) {
			props.onError(e);
		} finally {
			setBusy(null);
		}
	}
	return (
		<fieldset>
			<legend>Alerts</legend>
			{open.length === 0 && <p className="field-hint">Nothing needs you right now.</p>}
			{open.map((alert) => (
				<div key={alert.id} className={`shards-alert ${alert.severity}`} role={alert.severity === 'critical' ? 'alert' : undefined}>
					<Icon name={alert.severity === 'critical' ? 'error' : alert.severity === 'warning' ? 'warning' : 'info'} />
					<div className="shards-alert-body">
						<div>{alert.message}</div>
						<div className="muted small">Since {whenWords(alert.openedAt)}{alert.acknowledged ? ". Seen" : ''}</div>
					</div>
					{!alert.acknowledged && (
						<button type="button" className="table-action" disabled={busy !== null} onClick={() => void seen(alert)}>{busy === alert.id ? "Marking…" : "Mark as seen"}</button>
					)}
				</div>
			))}
			{resolved.length > 0 && (
				<details className="shards-alerts-resolved">
					<summary>Resolved in the last day ({resolved.length})</summary>
					{resolved.map((alert) => (
						<div key={alert.id} className="shards-alert resolved">
							<Icon name="check" />
							<div className="shards-alert-body">
								<div>{alert.message}</div>
								<div className="muted small">{alert.resolution ? `${alert.resolution} ` : ''}{alert.resolvedAt ? `Resolved ${whenWords(alert.resolvedAt)}.` : ''}</div>
							</div>
						</div>
					))}
				</details>
			)}
		</fieldset>
	);
}

/** A moment, in the viewer's own clock: today's as a time, an older one with its date. */
function whenWords(at: string): string {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) {
		return at;
	}
	const sameDay = date.toDateString() === new Date().toDateString();
	return sameDay ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** A replica's row, under the node it follows. It is never in the catalog and owns no ranges. */
function ReplicaRow(props: { pod: ShardPod; of: string; columns: number }): JSX.Element {
	return (
		<tr className="shards-replica-row">
			<td colSpan={props.columns - 1}>
				<Icon name="mirror" />
				<span className="mono">{props.pod.ref}</span>
				<span className="muted small">Replica of node <span className="mono">{props.of}</span>{props.pod.state === 'ready' ? ", following it" : `, ${props.pod.state}`}</span>
			</td>
			<td />
		</tr>
	);
}

/** A node failing over to its replica: the steps as they happen, or where it stopped. */
function FailoverRow(props: { pod: ShardPod }): JSX.Element {
	const { pod } = props;
	const at = failoverStep(pod);
	const failed = pod.failover === 'failed' || pod.failover === 'held';
	return (
		<div className="shards-join">
			<div className="cloud-actions">
				<span className="mono">{pod.ref}</span>
				<span className={failed ? 'form-status error' : 'muted small'}>
					{pod.failover === 'held'
						? "Stopped, not replaced: its replica was behind and its last writes could not be copied to it, so nothing was given up. See Alerts."
						: failed
						? `Its replica could not take its place: ${pod.failoverError ?? "see Alerts"}`
						: "This node was lost or damaged. Its replica is taking its place on its own, and queries that need its data may fail for a moment."}
				</span>
			</div>
			<ol className="shards-join-steps">
				{FAILOVER_STEPS.map((label, i) => (
					<li key={label} className={i < at ? 'done' : i === at ? (failed ? 'failed' : 'active') : 'waiting'}>{label}</li>
				))}
			</ol>
		</div>
	);
}

function KeyspaceGroup(props: {
	keyspace: ShardKeyspace;
	nodeName(id: number): string;
	shadeOf(id: number): number;
	advice: ShardAdvice | null;
	/** Tables distributed by it: a keyspace in use cannot be dropped. */
	usedBy: number;
	propose(review: Review): void;
}): JSX.Element {
	const { keyspace, nodeName, shadeOf, propose } = props;
	const shares = useMemo(() => rangeShares(keyspace.ranges), [keyspace.ranges]);
	const owners = [...new Set(keyspace.ranges.map((r) => r.node))];
	return (
		<fieldset>
			<legend>Keyspace {keyspace.name} ({keyspace.key_type})</legend>
			<div className="shards-bar" role="img" aria-label={`${keyspace.ranges.length} ranges over ${owners.length} cluster nodes`}>
				{shares.map(({ range, percent }) => (
					<span
						key={range.lo}
						style={{ width: `${percent}%`, '--shade': `${shadeOf(range.node)}%` } as CSSProperties}
						title={`${keyspace.name}:${range.lo} to ${range.hi} on ${nodeName(range.node)} (${percent.toFixed(1)}%)`}
					/>
				))}
			</div>
			<div className="shards-legend">
				{owners.map((id) => (
					<span key={id}><span className="shards-swatch" style={{ '--shade': `${shadeOf(id)}%` } as CSSProperties} aria-hidden="true" />{nodeName(id)}</span>
				))}
			</div>
			<table className="cloud-table">
				<thead><tr><th>Range</th><th>Up to</th><th>Cluster node</th><th>Rows</th><th /></tr></thead>
				<tbody>
					{shares.map(({ range }) => {
						const facts = props.advice?.facts.ranges.find((f) => f.keyspace === keyspace.name && f.lo === range.lo);
						const next = nextRange(keyspace, range);
						return (
							<tr key={range.lo}>
								<td className="mono" title={`${keyspace.name}:${range.lo}`}>{shortBound(range.lo)}</td>
								<td className="mono" title={range.hi}>{shortBound(range.hi)}</td>
								<td>{nodeName(range.node)}</td>
								<td>{facts ? facts.rows.toLocaleString() : '-'}</td>
								<td className="cloud-table-action">
									<span className="shards-row-actions">
										<button type="button" className="table-action" onClick={() => propose(review('split', { keyspace: keyspace.name, range: range.lo }, {
											fields: [
												{ name: 'at', label: "Split at", kind: 'text', optional: true, hint: "A hash value inside the range. Empty: the middle." },
												{ name: 'to', label: "Move one half to", kind: 'node', optional: true },
											],
										}))}>Split</button>
										<button type="button" className="table-action" onClick={() => propose(review('move', { keyspace: keyspace.name, range: range.lo }, { fields: [{ name: 'to', label: "To cluster node", kind: 'node' }] }))}>Move</button>
										{next && <button type="button" className="table-action" onClick={() => propose(review('merge', { keyspace: keyspace.name, a: range.lo, b: next.lo }))}>Merge</button>}
									</span>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			{keyspace.pins.length > 0 && <p className="field-hint">Pinned: {keyspace.pins.map((p) => `${p.value} on ${nodeName(p.node)}`).join(', ')}</p>}
			<div className="cloud-actions">
				<button type="button" className="secondary" onClick={() => propose(review('rebalance', { keyspace: keyspace.name }))}>Rebalance</button>
				<button type="button" className="secondary" disabled={props.usedBy > 0} title={props.usedBy > 0 ? "A table is distributed by it. Bring it home first." : undefined} onClick={() => propose(review('drop-keyspace', { name: keyspace.name }, { verb: "Drop" }))}>Drop</button>
				<button type="button" className="secondary" onClick={() => propose(review('verify', { keyspace: keyspace.name }))}>Verify</button>
				<button type="button" className="secondary" onClick={() => propose(review('pin', { keyspace: keyspace.name }, {
					fields: [
						{ name: 'value', label: "Key value", kind: 'text', placeholder: '42' },
						{ name: 'node', label: "Cluster node", kind: 'node', optional: true },
					],
				}))}>Pin a tenant</button>
			</div>
		</fieldset>
	);
}

/** A node pod on its way in or out: its join's steps as they happen, or the one thing a person can do. */
function PodRow(props: { pod: ShardPod; projectRef: string; onAttach(): void; onDone(text: string): void; onError(e: unknown): void }): JSX.Element {
	const { pod } = props;
	if (pod.joining) {
		const steps = ["Starting as a copy of the home node", "Joining the cluster", "Taking its share of the data"];
		const at = pod.joining === 'copying' ? 0 : pod.joining === 'joining' ? 1 : pod.joining === 'spreading' ? 2 : pod.state === 'ready' ? 1 : 0;
		return (
			<div className="shards-join">
				<div className="cloud-actions">
					<span className="mono">{pod.ref}</span>
					<span className="muted small">{pod.joining === 'failed' ? `Stopped: ${pod.joinError ?? 'see the audit log'}` : `Joining on its own: ${joinWords(pod.joining)}.`}</span>
				</div>
				<ol className="shards-join-steps">
					{steps.map((label, i) => (
						<li key={label} className={i < at ? 'done' : i === at ? (pod.joining === 'failed' ? 'failed' : 'active') : 'waiting'}>{label}</li>
					))}
				</ol>
				{pod.joining === 'failed' && <RetryButtons projectRef={props.projectRef} body={{ node: pod.ref }} dismiss="Leave it" onDone={props.onDone} onError={props.onError} />}
			</div>
		);
	}
	return (
		<div className="cloud-actions">
			<span className="mono">{pod.ref}</span>
			<span className="muted small">
				{pod.next === 'attach' && "Ready, joining by hand: attach it to give the cluster a node to move a range onto."}
				{pod.next === 'delete-pod' && "Let go by the cluster; its pod is being deleted."}
				{pod.next === 'wait' && `Starting as a copy of the home node (${pod.state}).`}
			</span>
			<span className="spacer" />
			{pod.next === 'attach' && <button type="button" className="table-action" onClick={props.onAttach}>Attach</button>}
		</div>
	);
}

/** Retry a stopped step, or let it go. */
function RetryButtons(props: { projectRef: string; body: Record<string, unknown>; dismiss: string; onDone(text: string): void; onError(e: unknown): void }): JSX.Element {
	const [busy, setBusy] = useState(false);
	async function act(action: 'retry' | 'dismiss'): Promise<void> {
		setBusy(true);
		try {
			props.onDone(ranSentence(await ask<Record<string, unknown>>(props.projectRef, { action, ...props.body })));
		} catch (e) {
			props.onError(e);
		} finally {
			setBusy(false);
		}
	}
	return (
		<span className="shards-row-actions">
			<button type="button" className="table-action" disabled={busy} onClick={() => void act('retry')}>Retry</button>
			<button type="button" className="table-action" disabled={busy} onClick={() => void act('dismiss')}>{props.dismiss}</button>
		</span>
	);
}

function JobsGroup(props: { projectRef: string; jobs: ShardJob[] | null; onChanged(text: string): void; onError(e: unknown): void }): JSX.Element {
	const [busy, setBusy] = useState(false);
	async function act(job: ShardJob, action: 'cancel' | 'resume'): Promise<void> {
		setBusy(true);
		try {
			const answer = await ask<{ state: string }>(props.projectRef, { action, id: job.id });
			props.onChanged(`Job ${job.id}: ${answer.state}.`);
		} catch (e) {
			props.onError(e);
		} finally {
			setBusy(false);
		}
	}
	return (
		<fieldset>
			<legend>Jobs</legend>
			{props.jobs === null && <div className="field-hint">Loading…</div>}
			{props.jobs?.length === 0 && <p className="field-hint">No operations have run on this cluster yet.</p>}
			{props.jobs && props.jobs.length > 0 && (
				<table className="cloud-table">
					<thead><tr><th>Job</th><th>Operation</th><th>Progress</th><th /></tr></thead>
					<tbody>
						{props.jobs.map((job) => {
							const percent = job.state === 'done' ? 100 : job.steps > 0 ? Math.round((job.steps_done / job.steps) * 100) : 0;
							return (
								<tr key={job.id}>
									<td className="mono">{job.id}</td>
									<td><span className="mono">{job.op}</span>{job.error && <div className="form-status error">{job.error}</div>}</td>
									<td>
										<span className="small">{job.state}, {job.steps_done} of {job.steps} steps</span>
										<div className="shards-meter" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent}%` }} /></div>
									</td>
									<td className="cloud-table-action">
										{!jobFinished(job.state) && job.state !== 'cancelling' && <button type="button" className="table-action" disabled={busy} onClick={() => void act(job, 'cancel')}>Cancel</button>}
										{job.state === 'failed' && <button type="button" className="table-action" disabled={busy} onClick={() => void act(job, 'resume')}>Resume</button>}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}
		</fieldset>
	);
}

/**
 * The review every operation goes through: its fields, then the plan, then Run. Only `plan: true`
 * is sent until Run is pressed.
 */
function ReviewSheet(props: { projectRef: string; review: Review; status: ShardsStatus; onCancel(): void; onDone(text: string): void }): JSX.Element {
	const { review: current } = props;
	const fields = current.fields ?? [];
	const [values, setValues] = useState<Record<string, string>>({});
	const [plan, setPlan] = useState<ShardPlan | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<Said>(null);
	const nodes = (props.status.cluster?.nodes ?? []).filter((n) => n.state === 'active' || n.state === 'joining');
	const keyspaces = props.status.cluster?.keyspaces ?? [];

	const request = useMemo(() => {
		const body: Record<string, unknown> = { ...current.request };
		for (const field of fields) {
			const value = (values[field.name] ?? '').trim();
			if (value !== '') {
				body[field.name] = field.kind === 'number' ? Number(value) : value;
			}
		}
		return body;
	}, [current.request, fields, values]);
	const missing = fields.some((f) => !f.optional && (values[f.name] ?? '').trim() === '');

	const send = useCallback(async (run: boolean) => {
		setBusy(true);
		setError(null);
		try {
			const answer = await ask<Record<string, unknown>>(props.projectRef, { action: current.action, request, ...(run ? {} : { plan: true }) });
			if (run) {
				props.onDone(ranSentence(answer));
			} else {
				setPlan(answer as unknown as ShardPlan);
			}
		} catch (e) {
			setError(said(e));
		} finally {
			setBusy(false);
		}
	}, [props, current.action, request]);

	// An operation that asks nothing is planned as soon as the review opens.
	useEffect(() => {
		if (fields.length === 0) {
			void send(false);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<fieldset className="shards-review">
			<legend>{current.title}</legend>
			{current.reason && <p className="field-hint">{current.reason}</p>}
			{!plan && fields.map((field) => (
				<label key={field.name}>
					{field.label}{field.optional ? " (optional)" : ''}
					{field.kind === 'node' || field.kind === 'keyspace' ? (
						<select value={values[field.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}>
							<option value="">{field.kind === 'node' ? (field.optional ? "Let the router choose" : "Choose a node") : "Choose a keyspace"}</option>
							{field.kind === 'node'
								? nodes.map((n) => <option key={n.id} value={n.name}>{n.name}</option>)
								: keyspaces.map((k) => <option key={k.name} value={k.name}>{k.name} ({k.key_type})</option>)}
						</select>
					) : (
						<input
							type={field.kind === 'number' ? 'number' : 'text'}
							value={values[field.name] ?? ''}
							placeholder={field.placeholder}
							spellCheck={false}
							onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
						/>
					)}
					{field.hint && <p className="field-hint">{field.hint}</p>}
				</label>
			))}
			{busy && !plan && <div className="field-hint">Planning…</div>}
			{plan && planIsSentence(plan) && <p className="field-hint">{plan.assumptions}</p>}
			{plan && !planIsSentence(plan) && (
				<>
					<div className="cloud-facts">
						<span className="muted">Steps</span><span>{plan.steps.map((s) => s.kind).join(', ') || "none"}</span>
						<span className="muted">Cutovers</span><span>{plan.cutovers}</span>
						<span className="muted">Rows to copy</span><span>about {plan.estimated_rows.toLocaleString()} ({formatBytes(plan.estimated_bytes)})</span>
						<span className="muted">Writes pause for</span><span>about {plan.expected_pause_ms} ms{plan.max_write_pause_ms > 0 ? `, never more than ${plan.max_write_pause_ms} ms` : ''}</span>
					</div>
					<p className="field-hint">{planSentence(plan)}</p>
					{plan.warnings.map((w, i) => <div key={i} className="form-status warn">{w}</div>)}
					{plan.assumptions && <p className="field-hint">{plan.assumptions}</p>}
				</>
			)}
			<Status said={error} />
			<div className="cloud-actions">
				{!plan
					? <button type="button" disabled={busy || missing} onClick={() => void send(false)}>Show the plan</button>
					: <button type="button" className={current.danger ? 'danger' : undefined} disabled={busy} onClick={() => void send(true)}>{busy ? "Working…" : current.verb}</button>}
				{plan && fields.length > 0 && <button type="button" className="secondary" disabled={busy} onClick={() => setPlan(null)}>Back</button>}
				<button type="button" className="secondary" disabled={busy} onClick={props.onCancel}>Cancel</button>
			</div>
		</fieldset>
	);
}

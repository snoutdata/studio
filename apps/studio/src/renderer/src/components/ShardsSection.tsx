/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ClusterMap } from './ClusterMap';
import { Icon } from './Icon';
import { Status, type Said } from './projectUi';
import { formatBytes } from '../formatBytes';
import { formatLocale, t, useT } from '../i18n';
import { onShardsProposal, takeShardsProposal } from '../shardsProposal';
import {
	failoverSteps, failoverStep, jobFinished, joinWords, nextRange, nodePods, nodeShade, planIsSentence, planWords, proposalFromRequest, rangeShares, ranSentence,
	homeReplicaStanding, replicaBlocked, replicaPods, replicaStanding, replicaWords, shardsOffered, shortBound, slotsSentence, spareSlots, splitAlerts,
	checkSentence, severityWord, type CheckFinding, type DesignCheck,
	type ShardAdvice, type ShardAlert, type ShardJob, type ShardKeyspace, type ShardPlan, type ShardPod, type ShardsRunAction, type ShardsStatus,
} from '../../../shared/cloudShards';
import { clusterMapModel } from '../../../shared/cloudClusterMap';

/**
 * A cloud project's Cluster section: a map of the cluster (`ClusterMap`), its nodes, each keyspace's
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
function tableKindLabel(kind: string): string {
	switch (kind) {
		case 'sharded':
			return t('shards.tableKind.sharded');
		case 'reference':
			return t('shards.tableKind.reference');
		case 'global':
			return t('shards.tableKind.global');
		default:
			return kind;
	}
}

/** Operations that change nothing a person would want to stop and think about. */
const QUIET: ReadonlySet<ShardsRunAction> = new Set(['verify', 'attach', 'add-node', 'keyspace', 'drop-keyspace', 'add-replica']);

const TITLES: Record<ShardsRunAction, string> = {
	enable: 'shards.titles.enable', disable: 'shards.titles.disable', 'add-node': 'shards.titles.addNode', attach: 'shards.titles.attach', drain: 'shards.titles.drain', remove: 'shards.titles.remove',
	keyspace: 'shards.titles.keyspace', 'drop-keyspace': 'shards.titles.dropKeyspace', distribute: 'shards.titles.distribute', reference: 'shards.titles.reference', global: 'shards.titles.global',
	split: 'shards.titles.split', merge: 'shards.titles.merge', move: 'shards.titles.move', pin: 'shards.titles.pin', rebalance: 'shards.titles.rebalance',
	scale: 'shards.titles.scale', verify: 'shards.titles.verify', cleanup: 'shards.titles.cleanup', spread: 'shards.titles.spread',
	'add-replica': 'shards.titles.addReplica', 'remove-replica': 'shards.titles.removeReplica',
};

/** What a replica is, in the words the review opens with. */
function replicaReason(): string {
	return t('shards.replicaReason');
}

function homeReplicaReason(): string {
	return t('shards.homeReplicaReason');
}

function review(action: ShardsRunAction, request: Record<string, unknown>, extra: Partial<Review> = {}): Review {
	const title = t(TITLES[action]);
	return { title, action, verb: title.split(' ')[0], request, danger: !QUIET.has(action), ...extra };
}

export function ShardsSection({ projectRef }: { projectRef: string }): JSX.Element {
	const t = useT();
	const [status, setStatus] = useState<ShardsStatus | null>(null);
	const [jobs, setJobs] = useState<ShardJob[] | null>(null);
	const [advice, setAdvice] = useState<ShardAdvice | null>(null);
	const [check, setCheck] = useState<DesignCheck | null>(null);
	const [checkError, setCheckError] = useState<string | null>(null);
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

	// The design check: a read of the schema's keys, foreign keys and indexes. A router
	// older than the check answers 404, which the group says in a line rather than an error.
	const askCheck = useCallback(async () => {
		try {
			setCheck(await ask<DesignCheck>(projectRef, { action: 'check' }));
			setCheckError(null);
		} catch (e) {
			setCheckError(e instanceof Error ? e.message : String(e));
		}
	}, [projectRef]);

	const sharded = status?.sharded === true && status.cluster !== null;
	useEffect(() => {
		if (sharded) {
			void askAdvisor(0);
			void askCheck();
		}
	}, [sharded, askAdvisor, askCheck]);

	// A proposal from the assistant, now or while the section is open.
	useEffect(() => {
		function take(): void {
			const proposal = takeShardsProposal(projectRef);
			if (proposal) {
				setCurrent(review(proposal.action, proposal.request, { reason: proposal.reason ?? t('shards.proposedByAssistant') }));
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
		return <>{message ? <Status said={message} /> : <div className="field-hint">{t('shards.loading')}</div>}</>;
	}

	const cluster = status.cluster;
	const nodes = cluster?.nodes ?? [];
	const keyspaces = cluster?.keyspaces ?? [];
	const tables = cluster?.tables ?? [];
	const nodeName = (id: number): string => nodes.find((n) => n.id === id)?.name ?? t('shards.nodeFallback', { id: String(id) });
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
					<legend>{t('shards.legends.intro')}</legend>
					<p className="field-hint">
						{t('shards.intro')}
					</p>
					{shardsOffered(status) ? (
						<>
							<p className="field-hint">{t('shards.enableHint', { spare: spareSlots(status) })}</p>
							<div className="cloud-actions">
								<button type="button" onClick={() => setCurrent(review('enable', {}, { danger: true, verb: t('shards.makeCluster') }))}><Icon name="split-horizontal" /> {t('shards.makeCluster')}</button>
							</div>
						</>
					) : (
						<p className="field-hint">{status.maxProjects === null || status.projectsUsed === null ? t('shards.planUnread') : t('shards.allSlotsUsed', { max: status.maxProjects })}</p>
					)}
				</fieldset>
			)}

			{status.sharded && (
				<>
					{status.router === 'starting' && <div className="form-status">{t('shards.routerStarting')}</div>}
					{status.router === 'paused' && <div className="form-status">{t('shards.routerPaused')}</div>}
					{status.routerError && <div className="form-status warn">{t('shards.routerDown', { error: status.routerError })}</div>}
					{status.automation?.queueError && (
						<div className="form-status warn">
							{t('shards.spreadStopped', { error: status.automation.queueError })}
							<RetryButtons projectRef={projectRef} body={{ queue: true }} dismiss={t('shards.dropRest')} onDone={finished} onError={(e) => setMessage(said(e))} />
						</div>
					)}
					{status.automation && !status.automation.queueError && (status.automation.queue.length > 0 || status.automation.queueJob !== null) && (
						<div className="form-status">{t('shards.spreading', { job: status.automation.queueJob !== null ? t('shards.spreadingJob', { job: String(status.automation.queueJob) }) : '', then: status.automation.queue.length > 0 ? t('shards.spreadingThen', { list: status.automation.queue.join(', ') }) : '' })}</div>
					)}
					{nodes.length > 0 && (
						<fieldset>
							<legend>{t('shards.legends.map')}</legend>
							<ClusterMap
								model={clusterMapModel(status, advice ? new Map(advice.facts.nodes.map((f) => [f.id, f.db_bytes])) : undefined, jobs)}
								shadeOf={shadeOf}
							/>
						</fieldset>
					)}
					<fieldset>
						<legend>{t('shards.legends.nodes')}</legend>
						<div className="cloud-facts">
							<span className="muted">{t('shards.legends.nodes')}</span><span>{nodeCount}</span>
							<span className="muted">{t('shards.facts.projectSlots')}</span><span>{knowsReplicas ? t('shards.slotsEachReplica', { slots: slotsSentence(status) ?? t('shards.planLimitUnknown') }) : t('shards.slotsEachNode', { slots: slotsSentence(status) ?? t('shards.planLimitUnknown') })}</span>
							{knowsReplicas && <><span className="muted">{t('shards.facts.replicas')}</span><span>{replicas.length}</span></>}
							<span className="muted">{t('shards.facts.keyspaces')}</span><span>{t('shards.keyspacesFacts', { keyspaces: keyspaces.length, ranges: keyspaces.reduce((n, k) => n + k.ranges.length, 0) })}</span>
						</div>
						{nodes.length > 0 && (
							<table className="cloud-table">
								<thead><tr><th>{t('shards.th.node')}</th><th>{t('shards.th.state')}</th><th>{t('shards.th.ranges')}</th><th>{t('shards.th.size')}</th>{knowsReplicas && <th>{t('shards.th.replica')}</th>}<th /></tr></thead>
								<tbody>
									{nodes.map((n) => {
										const facts = advice?.facts.nodes.find((f) => f.id === n.id);
										const pod = podOf(n.name);
										const standing = n.home ? homeReplicaStanding(status.home) : pod ? replicaStanding(pod) : 'unknown';
										const blocked = pod ? replicaBlocked(pod, status) : n.home && status.projectsUsed !== null && status.maxProjects !== null && spareSlots(status) === 0 ? t('shards.replicaFull') : null;
										// 222: the home is the project, so its replica is asked for by the project's ref.
										const replicaTarget = n.home ? (status.home ? status.home.ref : null) : pod ? pod.ref : null;
										const replica = replicas.find((r) => r.replicaOf === n.name);
										return (
											<Fragment key={n.id}>
												<tr>
													<td>
														<span className="shards-swatch" style={{ '--shade': `${shadeOf(n.id)}%` } as CSSProperties} aria-hidden="true" />
														<span className="mono">{n.name}</span>{n.home && <span className="env">{t('shards.homeBadge')}</span>}
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
																	<button type="button" className="table-action" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => setCurrent(review('add-replica', { node: replicaTarget }, { verb: t('shards.addReplicaVerb'), reason: n.home ? homeReplicaReason() : replicaReason() }))}>{t('shards.addReplica')}</button>
																)}
																{replicaTarget && (standing === 'protected' || standing === 'making') && (
																	<button type="button" className="table-action" onClick={() => setCurrent(review('remove-replica', { node: replicaTarget }, { verb: t('shards.removeReplicaVerb'), reason: n.home ? t('shards.removeHomeReplicaReason') : t('shards.removeReplicaReason') }))}>{t('shards.removeReplica')}</button>
																)}
																{!n.home && <button type="button" className="table-action" onClick={() => setCurrent(review('drain', { node: n.name }))}>{t('shards.drain')}</button>}
																{!n.home && <button type="button" className="table-action" onClick={() => setCurrent(review('remove', { node: n.name }))}>{t('shards.remove')}</button>}
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
							<button type="button" onClick={() => setCurrent(review('add-node', {}, { verb: t('shards.addVerb'), reason: t('shards.addReason') }))}><Icon name="add" /> {t('shards.addNode')}</button>
							<button type="button" className="secondary" onClick={() => setCurrent(review('scale', {}, { verb: t('shards.scale'), fields: [{ name: 'nodes', label: t('shards.nodesIncludingHome'), kind: 'number', placeholder: String(nodeCount + 1) }] }))}>{t('shards.scale')}</button>
							<button type="button" className="secondary" onClick={() => void refresh()}><Icon name="refresh" /> {t('shards.refresh')}</button>
						</div>
					</fieldset>

					{keyspaces.map((keyspace) => (
						<KeyspaceGroup key={keyspace.name} keyspace={keyspace} nodeName={nodeName} shadeOf={shadeOf} advice={advice} usedBy={tables.filter((row) => row.keyspace === keyspace.name).length} propose={setCurrent} />
					))}

					<fieldset>
						<legend>{t('shards.legends.tables')}</legend>
						{tables.length === 0 && <p className="field-hint">{t('shards.tablesEmpty')}</p>}
						{tables.length > 0 && (
							<table className="cloud-table">
								<thead><tr><th>{t('shards.th.table')}</th><th>{t('shards.th.kind')}</th><th>{t('shards.th.keyspace')}</th><th>{t('shards.th.distKey')}</th><th /></tr></thead>
								<tbody>
									{tables.map((row) => (
										<tr key={row.table}>
											<td className="mono">{row.table}</td><td>{tableKindLabel(row.kind)}</td><td>{row.keyspace ?? '-'}</td><td className="mono">{row.column ?? '-'}</td>
											<td className="cloud-table-action">
												{row.kind !== 'global' && <button type="button" className="table-action" onClick={() => setCurrent(review('global', { table: row.table }, { verb: t('shards.bringHome') }))}>{t('shards.bringHome')}</button>}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
						<div className="cloud-actions">
							<button type="button" onClick={() => setCurrent(review('spread', {}, {
								verb: t('shards.spread'),
								reason: t('shards.spreadReason'),
								fields: [
									{ name: 'table', label: t('shards.th.table'), kind: 'text', placeholder: 'public.orders' },
									{ name: 'column', label: t('shards.fields.spreadByColumn'), kind: 'text', placeholder: 'account_id', hint: t('shards.fields.keyHint') },
									{ name: 'key_type', label: t('shards.fields.itsType'), kind: 'text', placeholder: 'bigint', hint: t('shards.fields.typeHint') },
								],
							}))}>{t('shards.spreadTable')}</button>
							<button type="button" className="secondary" disabled={keyspaces.length === 0} title={keyspaces.length === 0 ? t('shards.createKeyspaceFirst') : undefined} onClick={() => setCurrent(review('distribute', {}, {
								fields: [
									{ name: 'table', label: t('shards.th.table'), kind: 'text', placeholder: 'public.orders' },
									{ name: 'column', label: t('shards.fields.distKeyColumn'), kind: 'text', placeholder: 'account_id', hint: t('shards.fields.keyHint') },
									{ name: 'keyspace', label: t('shards.th.keyspace'), kind: 'keyspace' },
								],
							}))}>{t('shards.distributeTable')}</button>
							<button type="button" className="secondary" onClick={() => setCurrent(review('reference', {}, { verb: t('shards.copy'), fields: [{ name: 'table', label: t('shards.th.table'), kind: 'text', placeholder: 'public.countries' }] }))}>{t('shards.copyEveryNode')}</button>
							<button type="button" className="secondary" onClick={() => setCurrent(review('keyspace', {}, {
								fields: [
									{ name: 'name', label: t('shards.fields.name'), kind: 'text', placeholder: 'accounts' },
									{ name: 'key_type', label: t('shards.fields.distKeyType'), kind: 'text', placeholder: 'bigint', hint: t('shards.fields.typeHint') },
									{ name: 'ranges', label: t('shards.fields.rangesStart'), kind: 'number', optional: true, placeholder: '1' },
								],
							}))}>{t('shards.createKeyspace')}</button>
						</div>
					</fieldset>

					<JobsGroup projectRef={projectRef} jobs={jobs} onChanged={finished} onError={(e) => setMessage(said(e))} />

					<fieldset>
						<legend>{t('shards.legends.check')}</legend>
						<p className="field-hint">{t('shards.checkIntro')}</p>
						{!check && !checkError && <div className="field-hint">{t('shards.checking')}</div>}
						{checkError && <div className="form-status warn">{checkError}</div>}
						{check && <p className="field-hint">{checkSentence(check)}</p>}
						{check && <Findings findings={check.findings} onReview={(action, request, reason) => setCurrent(review(action, request, { reason }))} />}
						<div className="cloud-actions">
							<button type="button" className="secondary" onClick={() => void askCheck()}>{t('shards.checkAgain')}</button>
						</div>
					</fieldset>

					<fieldset>
						<legend>{t('shards.legends.recommendations')}</legend>
						{!advice && <div className="field-hint">{t('shards.askingAdvisor')}</div>}
						{advice && <p className="field-hint">{advice.summary}</p>}
						{advice?.advice.map((one, i) => {
							const proposal = one.needs.length === 0 ? proposalFromRequest(one.request, one.reason) : null;
							return (
								<div key={i} className="shards-advice">
									<div className="cloud-actions">
										<strong>{one.op}</strong>
										<span className="env">{one.metric}</span>
										<span className="spacer" />
										{proposal && <button type="button" className="table-action" onClick={() => setCurrent(review(proposal.action, proposal.request, { reason: one.reason }))}>{t('shards.review')}</button>}
									</div>
									<p className="field-hint">{one.reason}</p>
									{one.plan && <p className="field-hint">{planWords(one.plan)}</p>}
									{one.needs.length > 0 && <p className="field-hint">{t('shards.advisorNeeds', { list: one.needs.join(', ') })}</p>}
								</div>
							);
						})}
						<div className="cloud-actions">
							<button type="button" className="secondary" onClick={() => void askAdvisor()}>{t('shards.measureWrites')}</button>
						</div>
					</fieldset>

					<fieldset>
						<legend>{t('shards.legends.disable')}</legend>
						<p className="field-hint">
							{nodeCount > 1
								? t('shards.scaleDownFirst', { nodes: nodeCount })
								: t('shards.disableBody')}
						</p>
						<div className="cloud-actions">
							<button type="button" className="danger" disabled={nodeCount > 1} onClick={() => setCurrent(review('disable', {}, { verb: t('shards.turnItOff'), danger: true }))}>{t('shards.legends.disable')}</button>
						</div>
					</fieldset>
				</>
			)}
		</div>
	);
}

/** Design check findings: severity, table, what it is, the fix, the SQL, and Review when a request does it. */
function Findings(props: { findings: CheckFinding[]; onReview?(action: ShardsRunAction, request: Record<string, unknown>, reason: string): void }): JSX.Element {
	const t = useT();
	return (
		<>
			{props.findings.map((f, i) => {
				const proposal = props.onReview && f.operation ? proposalFromRequest(f.operation, f.message) : null;
				return (
					<div key={`${f.code}-${f.table}-${i}`} className="shards-advice">
						<div className="cloud-actions">
							<strong>{f.table}</strong>
							<span className={`env ${f.severity === 'info' ? '' : f.severity}`}>{severityWord(f.severity)}</span>
							<span className="spacer" />
							{proposal && <button type="button" className="table-action" onClick={() => props.onReview?.(proposal.action, proposal.request, f.message)}>{t('shards.review')}</button>}
						</div>
						<p className="field-hint">{f.message}</p>
						<p className="field-hint">{f.fix}</p>
						{f.sql && <pre className="shards-sql">{f.sql}</pre>}
					</div>
				);
			})}
		</>
	);
}

/**
 * The cluster's alerts: open ones first, each with its severity and a Mark as seen button,
 * then those resolved in the last day, folded away. Seeing one changes nothing in the cluster.
 */
function AlertsGroup(props: { projectRef: string; alerts: ShardAlert[] | undefined; onDone(text: string): void; onError(e: unknown): void }): JSX.Element | null {
	const t = useT();
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
			<legend>{t('shards.legends.alerts')}</legend>
			{open.length === 0 && <p className="field-hint">{t('shards.noAlerts')}</p>}
			{open.map((alert) => (
				<div key={alert.id} className={`shards-alert ${alert.severity}`} role={alert.severity === 'critical' ? 'alert' : undefined}>
					<Icon name={alert.severity === 'critical' ? 'error' : alert.severity === 'warning' ? 'warning' : 'info'} />
					<div className="shards-alert-body">
						<div>{alert.message}</div>
						<div className="muted small">{t('shards.since', { when: whenWords(alert.openedAt) })}{alert.acknowledged ? t('shards.seen') : ''}</div>
					</div>
					{!alert.acknowledged && (
						<button type="button" className="table-action" disabled={busy !== null} onClick={() => void seen(alert)}>{busy === alert.id ? t('shards.marking') : t('shards.markSeen')}</button>
					)}
				</div>
			))}
			{resolved.length > 0 && (
				<details className="shards-alerts-resolved">
					<summary>{t('shards.resolvedDay', { n: resolved.length })}</summary>
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
	return sameDay ? date.toLocaleTimeString(formatLocale(), { hour: '2-digit', minute: '2-digit' }) : date.toLocaleString(formatLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** A replica's row, under the node it follows. It is never in the catalog and owns no ranges. */
function ReplicaRow(props: { pod: ShardPod; of: string; columns: number }): JSX.Element {
	const t = useT();
	return (
		<tr className="shards-replica-row">
			<td colSpan={props.columns - 1}>
				<Icon name="mirror" />
				<span className="mono">{props.pod.ref}</span>
				<span className="muted small">{t('shards.replicaOfNode')} <span className="mono">{props.of}</span>{props.pod.state === 'ready' ? t('shards.followingIt') : `, ${props.pod.state}`}</span>
			</td>
			<td />
		</tr>
	);
}

/** A node failing over to its replica: the steps as they happen, or where it stopped. */
function FailoverRow(props: { pod: ShardPod }): JSX.Element {
	const t = useT();
	const { pod } = props;
	const at = failoverStep(pod);
	const failed = pod.failover === 'failed' || pod.failover === 'held';
	return (
		<div className="shards-join">
			<div className="cloud-actions">
				<span className="mono">{pod.ref}</span>
				<span className={failed ? 'form-status error' : 'muted small'}>
					{pod.failover === 'held'
						? t('shards.failoverHeld')
						: failed
						? t('shards.failoverFailed', { error: pod.failoverError ?? t('shards.seeAlerts') })
						: t('shards.failoverRunning')}
				</span>
			</div>
			<ol className="shards-join-steps">
				{failoverSteps().map((label, i) => (
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
			<legend>{t('shards.keyspaceLegend', { name: keyspace.name, type: keyspace.key_type })}</legend>
			<div className="shards-bar" role="img" aria-label={t('shards.rangesOver', { ranges: keyspace.ranges.length, nodes: owners.length })}>
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
				<thead><tr><th>{t('shards.th.range')}</th><th>{t('shards.th.upTo')}</th><th>{t('shards.th.node')}</th><th>{t('shards.th.rows')}</th><th /></tr></thead>
				<tbody>
					{shares.map(({ range }) => {
						const facts = props.advice?.facts.ranges.find((f) => f.keyspace === keyspace.name && f.lo === range.lo);
						const next = nextRange(keyspace, range);
						return (
							<tr key={range.lo}>
								<td className="mono" title={`${keyspace.name}:${range.lo}`}>{shortBound(range.lo)}</td>
								<td className="mono" title={range.hi}>{shortBound(range.hi)}</td>
								<td>{nodeName(range.node)}</td>
								<td>{facts ? facts.rows.toLocaleString(formatLocale()) : '-'}</td>
								<td className="cloud-table-action">
									<span className="shards-row-actions">
										<button type="button" className="table-action" onClick={() => propose(review('split', { keyspace: keyspace.name, range: range.lo }, {
											fields: [
												{ name: 'at', label: t('shards.splitAt'), kind: 'text', optional: true, hint: t('shards.splitHint') },
												{ name: 'to', label: t('shards.moveHalfTo'), kind: 'node', optional: true },
											],
										}))}>{t('shards.split')}</button>
										<button type="button" className="table-action" onClick={() => propose(review('move', { keyspace: keyspace.name, range: range.lo }, { fields: [{ name: 'to', label: t('shards.toNode'), kind: 'node' }] }))}>{t('shards.move')}</button>
										{next && <button type="button" className="table-action" onClick={() => propose(review('merge', { keyspace: keyspace.name, a: range.lo, b: next.lo }))}>{t('shards.merge')}</button>}
									</span>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			{keyspace.pins.length > 0 && <p className="field-hint">{t('shards.pinned', { list: keyspace.pins.map((p) => t('shards.pinItem', { value: String(p.value), node: nodeName(p.node) })).join(', ') })}</p>}
			<div className="cloud-actions">
				<button type="button" className="secondary" onClick={() => propose(review('rebalance', { keyspace: keyspace.name }))}>{t('shards.rebalance')}</button>
				<button type="button" className="secondary" disabled={props.usedBy > 0} title={props.usedBy > 0 ? t('shards.dropBlocked') : undefined} onClick={() => propose(review('drop-keyspace', { name: keyspace.name }, { verb: t('shards.drop') }))}>{t('shards.drop')}</button>
				<button type="button" className="secondary" onClick={() => propose(review('verify', { keyspace: keyspace.name }))}>{t('shards.verify')}</button>
				<button type="button" className="secondary" onClick={() => propose(review('pin', { keyspace: keyspace.name }, {
					fields: [
						{ name: 'value', label: t('shards.keyValue'), kind: 'text', placeholder: '42' },
						{ name: 'node', label: t('shards.th.node'), kind: 'node', optional: true },
					],
				}))}>{t('shards.pinTenant')}</button>
			</div>
		</fieldset>
	);
}

/** A node pod on its way in or out: its join's steps as they happen, or the one thing a person can do. */
function PodRow(props: { pod: ShardPod; projectRef: string; onAttach(): void; onDone(text: string): void; onError(e: unknown): void }): JSX.Element {
	const t = useT();
	const { pod } = props;
	if (pod.joining) {
		const steps = [t('shards.joinSteps.copy'), t('shards.joinSteps.join'), t('shards.joinSteps.share')];
		const at = pod.joining === 'copying' ? 0 : pod.joining === 'joining' ? 1 : pod.joining === 'spreading' ? 2 : pod.state === 'ready' ? 1 : 0;
		return (
			<div className="shards-join">
				<div className="cloud-actions">
					<span className="mono">{pod.ref}</span>
					<span className="muted small">{pod.joining === 'failed' ? t('shards.joinStopped', { error: pod.joinError ?? t('shards.seeAuditLog') }) : t('shards.joiningOwn', { phase: joinWords(pod.joining) })}</span>
				</div>
				<ol className="shards-join-steps">
					{steps.map((label, i) => (
						<li key={label} className={i < at ? 'done' : i === at ? (pod.joining === 'failed' ? 'failed' : 'active') : 'waiting'}>{label}</li>
					))}
				</ol>
				{pod.joining === 'failed' && <RetryButtons projectRef={props.projectRef} body={{ node: pod.ref }} dismiss={t('shards.leaveIt')} onDone={props.onDone} onError={props.onError} />}
			</div>
		);
	}
	return (
		<div className="cloud-actions">
			<span className="mono">{pod.ref}</span>
			<span className="muted small">
				{pod.next === 'attach' && t('shards.attachHint')}
				{pod.next === 'delete-pod' && t('shards.letGo')}
				{pod.next === 'wait' && t('shards.copyWait', { state: pod.state })}
			</span>
			<span className="spacer" />
			{pod.next === 'attach' && <button type="button" className="table-action" onClick={props.onAttach}>{t('shards.attach')}</button>}
		</div>
	);
}

/** Retry a stopped step, or let it go. */
function RetryButtons(props: { projectRef: string; body: Record<string, unknown>; dismiss: string; onDone(text: string): void; onError(e: unknown): void }): JSX.Element {
	const t = useT();
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
			<button type="button" className="table-action" disabled={busy} onClick={() => void act('retry')}>{t('shards.retry')}</button>
			<button type="button" className="table-action" disabled={busy} onClick={() => void act('dismiss')}>{props.dismiss}</button>
		</span>
	);
}

function JobsGroup(props: { projectRef: string; jobs: ShardJob[] | null; onChanged(text: string): void; onError(e: unknown): void }): JSX.Element {
	const t = useT();
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
			<legend>{t('shards.legends.jobs')}</legend>
			{props.jobs === null && <div className="field-hint">{t('shards.loading')}</div>}
			{props.jobs?.length === 0 && <p className="field-hint">{t('shards.noJobs')}</p>}
			{props.jobs && props.jobs.length > 0 && (
				<table className="cloud-table">
					<thead><tr><th>{t('shards.th.job')}</th><th>{t('shards.th.operation')}</th><th>{t('shards.th.progress')}</th><th /></tr></thead>
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
										{!jobFinished(job.state) && job.state !== 'cancelling' && <button type="button" className="table-action" disabled={busy} onClick={() => void act(job, 'cancel')}>{t('shards.cancel')}</button>}
										{job.state === 'failed' && <button type="button" className="table-action" disabled={busy} onClick={() => void act(job, 'resume')}>{t('shards.resume')}</button>}
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
	const t = useT();
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
							<option value="">{field.kind === 'node' ? (field.optional ? t('shards.letRouterChoose') : t('shards.chooseNode')) : t('shards.chooseKeyspace')}</option>
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
			{busy && !plan && <div className="field-hint">{t('shards.planning')}</div>}
			{plan && planIsSentence(plan) && <p className="field-hint">{plan.assumptions}</p>}
			{plan && !planIsSentence(plan) && (
				<>
					<div className="cloud-facts">
						<span className="muted">{t('shards.plan.steps')}</span><span>{plan.steps.map((s) => s.kind).join(', ') || t('shards.none')}</span>
						<span className="muted">{t('shards.plan.cutovers')}</span><span>{plan.cutovers}</span>
						<span className="muted">{t('shards.plan.rowsToCopy')}</span><span>{t('shards.plan.aboutRows', { rows: plan.estimated_rows, bytes: formatBytes(plan.estimated_bytes) })}</span>
						<span className="muted">{t('shards.plan.writesPause')}</span><span>{t('shards.plan.pauseAbout', { ms: plan.expected_pause_ms })}{plan.max_write_pause_ms > 0 ? t('shards.plan.pauseNever', { ms: plan.max_write_pause_ms }) : ''}</span>
					</div>
					<p className="field-hint">{planWords(plan)}</p>
					{plan.warnings.map((w, i) => <div key={i} className="form-status warn">{w}</div>)}
					{plan.check?.error && <p className="field-hint">{t('shards.checkReadFailed', { error: plan.check.error })}</p>}
					{plan.check && !plan.check.error && plan.check.findings.length > 0 && (
						<>
							<p className="field-hint"><strong>{t('shards.designCheckDot')}</strong> {checkSentence(plan.check)}</p>
							<Findings findings={plan.check.findings} />
						</>
					)}
					{plan.assumptions && <p className="field-hint">{plan.assumptions}</p>}
				</>
			)}
			<Status said={error} />
			<div className="cloud-actions">
				{!plan
					? <button type="button" disabled={busy || missing} onClick={() => void send(false)}>{t('shards.showPlan')}</button>
					: <button type="button" className={current.danger ? 'danger' : undefined} disabled={busy} onClick={() => void send(true)}>{busy ? t('shards.working') : current.verb}</button>}
				{plan && fields.length > 0 && <button type="button" className="secondary" disabled={busy} onClick={() => setPlan(null)}>{t('shards.back')}</button>}
				<button type="button" className="secondary" disabled={busy} onClick={props.onCancel}>{t('shards.cancel')}</button>
			</div>
		</fieldset>
	);
}

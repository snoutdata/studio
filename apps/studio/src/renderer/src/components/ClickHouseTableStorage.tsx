/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Metric } from './Metric';
import { SqlCode } from './SqlCode';
import { useConfirm } from './ConfirmDialog';
import { errorMessage } from '../errors';
import { namedRows } from '../../../shared/clickhouseOps';
import {
	anatomySql,
	missingSystemTable,
	partitionsSql,
	PARTITION_ACTIONS,
	projectionsSql,
	qualified,
	readAnatomy,
	skipIndexSql,
	type EngineAnatomy,
	type PartitionRow,
} from '../../../shared/clickhouseTable';

// The Storage tab on a ClickHouse table: what the table IS physically, rather than what
// its columns are.
//
// Every other tab on this page is engine-neutral because every engine has columns, keys and a row
// count. A MergeTree table's behaviour is not in any of those: it is in the order it is stored in,
// the partitions it is cut into, the parts inside them, the projections that answer a query
// instead of the table, and the skip indexes that cross granules out. So this tab exists only for
// ClickHouse, and TableView shows it only there.
//
// The reads go through `sqlApi.explain` (history-clean, as the Operations panel's do). The three
// partition writes go through `onRunDdl`, the same path the table designer's DDL takes: they are
// the user's own statements, so they belong in query history and re-introspect after.

interface ClickHouseTableStorageProps {
	connectionId: string;
	schema: string;
	table: string;
	isProd: boolean;
	/** Connection flagged read-only: the partition actions are not offered at all. */
	readOnly: boolean;
	onRunDdl(connectionId: string, sql: string): Promise<{ ok: boolean; error?: string }>;
}

/** A section's rows, or why there are none. `undefined` means "still reading". */
interface Section<T> {
	rows?: T[];
	note?: string;
}

interface ProjectionRow {
	name: string;
	type: string;
	sortingKey: string;
	parts: number;
	rows: number;
	diskMb: number;
	query: string;
}

interface SkipIndexRow {
	name: string;
	type: string;
	expression: string;
	granulesPerEntry: number;
	diskMb: number;
	rawMb: number;
}

const NUM = new Intl.NumberFormat();

function num(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string {
	return value === null || value === undefined ? '' : String(value);
}

/** `1.2 GB` from a megabyte number, kept as one reading so a column of sizes is comparable. */
function mb(value: number): string {
	if (value >= 1024) {
		return `${(value / 1024).toFixed(2)} GB`;
	}
	if (value < 0.01 && value > 0) {
		return '< 0.01 MB';
	}
	return `${NUM.format(Number(value.toFixed(2)))} MB`;
}

function ratio(disk: number, raw: number): string {
	return disk > 0 && raw > 0 ? `${(raw / disk).toFixed(1)}x` : '';
}

export function ClickHouseTableStorage({ connectionId, schema, table, isProd, readOnly, onRunDdl }: ClickHouseTableStorageProps): JSX.Element {
	const [anatomy, setAnatomy] = useState<EngineAnatomy | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [partitions, setPartitions] = useState<Section<PartitionRow>>({});
	const [projections, setProjections] = useState<Section<ProjectionRow>>({});
	const [skipIndexes, setSkipIndexes] = useState<Section<SkipIndexRow>>({});
	const [seq, setSeq] = useState(0);
	const [confirm, confirmDialog] = useConfirm();
	const [busy, setBusy] = useState<string | null>(null);
	const name = qualified(schema, table);

	const read = useCallback(async (sql: string): Promise<Record<string, unknown>[]> => {
		const res = await window.sqlApi.explain({ connectionId, sql });
		if (!res.ok) {
			throw new Error(res.error);
		}
		return namedRows(res.result.fields, res.result.rows);
	}, [connectionId]);

	useEffect(() => {
		let alive = true;
		setError(null);
		setAnatomy(null);
		setPartitions({});
		setProjections({});
		setSkipIndexes({});

		void (async () => {
			let head: EngineAnatomy;
			try {
				const rows = await read(anatomySql(schema, table));
				if (!rows[0]) {
					throw new Error(`${name} is not in system.tables on this server.`);
				}
				head = readAnatomy(rows[0]);
			} catch (err) {
				if (alive) {
					setError(errorMessage(err));
				}
				return;
			}
			if (!alive) {
				return;
			}
			setAnatomy(head);
			if (!head.isMergeTree) {
				// A Memory table, a Dictionary, a Distributed table: no parts on disk, so the
				// three lists below would be empty for a reason that is not "nothing to see".
				const note = `A ${head.engine} table keeps no parts on disk, so it has no partitions, projections or skip indexes.`;
				setPartitions({ note });
				setProjections({ note });
				setSkipIndexes({ note });
				return;
			}

			// Each section reads on its own: a user refused one system table keeps the others.
			const load = async <T,>(sql: string, map: (row: Record<string, unknown>) => T, set: (s: Section<T>) => void, missing: string): Promise<void> => {
				try {
					const rows = (await read(sql)).map(map);
					if (alive) {
						set({ rows });
					}
				} catch (err) {
					const message = errorMessage(err);
					if (alive) {
						set({ note: missingSystemTable(message) ? missing : message });
					}
				}
			};

			await Promise.all([
				load(partitionsSql(schema, table), (row) => ({
					partition: str(row.partition),
					partitionId: str(row.partition_id),
					parts: num(row.parts),
					rows: num(row.rows),
					diskMb: num(row.on_disk_mb),
					rawMb: num(row.raw_mb),
					from: str(row.covers_from),
					to: str(row.covers_to),
					modified: str(row.last_written),
				}), setPartitions, 'This server does not expose system.parts to this user.'),
				load(projectionsSql(schema, table), (row) => ({
					name: str(row.name),
					type: str(row.type),
					sortingKey: str(row.sorting_key),
					parts: num(row.parts),
					rows: num(row.rows),
					diskMb: num(row.on_disk_mb),
					query: str(row.query),
				}), setProjections, 'This server is older than system.projections (ClickHouse 24.x), so projections cannot be listed.'),
				load(skipIndexSql(schema, table), (row) => ({
					name: str(row.name),
					type: str(row.type),
					expression: str(row.expression),
					granulesPerEntry: num(row.granules_per_entry),
					diskMb: num(row.on_disk_mb),
					rawMb: num(row.raw_mb),
				}), setSkipIndexes, 'This server does not expose system.data_skipping_indices to this user.'),
			]);
		})();

		return () => { alive = false; };
	}, [read, schema, table, name, seq]);

	async function act(actionId: string, row: PartitionRow): Promise<void> {
		const action = PARTITION_ACTIONS.find((a) => a.id === actionId);
		if (!action) {
			return;
		}
		const sql = action.sql(name, row);
		const ok = await confirm({
			title: isProd ? `${action.label} on PRODUCTION?` : `${action.label} partition ${row.partition}?`,
			body: (
				<>
					<p>{action.confirm(name, row)}</p>
					<SqlCode sql={sql} />
				</>
			),
			confirmLabel: action.label,
			danger: action.danger || isProd,
		});
		if (!ok) {
			return;
		}
		setBusy(`${action.id}:${row.partitionId}`);
		const res = await onRunDdl(connectionId, sql).finally(() => setBusy(null));
		if (res.ok) {
			setSeq((n) => n + 1);
		}
	}

	if (error) {
		return <div className="telemetry"><div className="results-error">{error}</div></div>;
	}
	if (!anatomy) {
		return <div className="telemetry"><div className="prop-empty">Reading what {name} is made of…</div></div>;
	}

	const totalRaw = partitions.rows?.reduce((sum, p) => sum + p.rawMb, 0) ?? 0;
	const totalDisk = partitions.rows?.reduce((sum, p) => sum + p.diskMb, 0) ?? 0;

	return (
		<>
			<div className="telemetry ch-storage">
				<div className="telemetry-section">
					<div className="telemetry-heading">Engine</div>
					<div className="ch-anatomy">
						<div className="ch-anatomy-engine">{anatomy.engine}</div>
						{anatomy.clauses.length === 0 && <div className="muted small">This engine takes no key, partition or TTL clause.</div>}
						{anatomy.clauses.map((clause) => (
							<div className="ch-anatomy-row" key={clause.label}>
								<span className="ch-anatomy-label">{clause.label}</span>
								<code className="ch-anatomy-value">{clause.value}</code>
							</div>
						))}
						{anatomy.settings.length > 0 && (
							<div className="ch-anatomy-row">
								<span className="ch-anatomy-label">SETTINGS</span>
								<span className="ch-anatomy-settings">
									{anatomy.settings.map((setting) => (
										<span className="explain-fact" key={setting.label} title={`${setting.label} = ${setting.value}`}>
											<span className="explain-fact-label">{setting.label}</span>{setting.value}
										</span>
									))}
								</span>
							</div>
						)}
					</div>
					<div className="metric-cards">
						<Metric icon="symbol-numeric" label="Rows" value={anatomy.rows === undefined ? '—' : NUM.format(anatomy.rows)} hint="What the catalog says, which for a MergeTree table is exact." />
						<Metric icon="database" label="On disk" value={anatomy.bytes === undefined ? '—' : mb(anatomy.bytes / 1048576)} />
						{anatomy.isMergeTree && totalRaw > 0 && (
							<Metric icon="symbol-ruler" label="Compression" value={ratio(totalDisk, totalRaw)} hint={`${mb(totalRaw)} of data stored in ${mb(totalDisk)}.`} />
						)}
						{anatomy.isMergeTree && (
							<Metric
								icon="layers"
								label="Active parts"
								value={anatomy.activeParts === undefined ? '—' : NUM.format(anatomy.activeParts)}
								hint={`Every INSERT writes a part and merges combine them. ${anatomy.parts === anatomy.activeParts ? 'Nothing is waiting to be cleaned up.' : `${NUM.format((anatomy.parts ?? 0) - (anatomy.activeParts ?? 0))} more have been merged away and not yet deleted, which is normal.`}`}
							/>
						)}
						{anatomy.isMergeTree && (
							<Metric icon="list-ordered" label="Granules" value={anatomy.marks === undefined ? '—' : NUM.format(anatomy.marks)} hint="A granule is the smallest thing a read can skip; the sort key's index has one entry per granule." />
						)}
						{anatomy.storagePolicy !== '' && <Metric icon="server-environment" label="Storage policy" value={anatomy.storagePolicy} />}
					</div>
				</div>

				<div className="telemetry-section">
					<div className="telemetry-heading">
						Partitions
						<span className="spacer" />
						{partitions.rows && partitions.rows.length > 0 && (
							<span className="muted small">{partitions.rows.length === 1 ? '1 partition' : `${partitions.rows.length} partitions`}</span>
						)}
					</div>
					<div className="muted small ch-storage-blurb">
						A partition is read and dropped as a unit, and its parts are what merges combine. Too many
						parts in one partition slows inserts, then refuses them.
					</div>
					{partitions.note && <div className="prop-empty">{partitions.note}</div>}
					{!partitions.note && !partitions.rows && <div className="prop-empty">Reading…</div>}
					{partitions.rows && partitions.rows.length === 0 && (
						<div className="prop-empty">No parts: this table has no rows on this node yet.</div>
					)}
					{partitions.rows && partitions.rows.length > 0 && (
						<table className="explain-indexes ch-storage-table">
							<thead>
								<tr>
									<th>Partition</th>
									<th className="explain-num">Parts</th>
									<th className="explain-num">Rows</th>
									<th className="explain-num">On disk</th>
									<th className="explain-num">Raw</th>
									<th>Covers</th>
									<th>Last written</th>
									{!readOnly && <th />}
								</tr>
							</thead>
							<tbody>
								{partitions.rows.map((row) => (
									<tr key={row.partitionId}>
										<td><code>{row.partition}</code></td>
										<td className="explain-num">{NUM.format(row.parts)}</td>
										<td className="explain-num">{NUM.format(row.rows)}</td>
										<td className="explain-num">{mb(row.diskMb)}</td>
										<td className="explain-num" title={ratio(row.diskMb, row.rawMb) === '' ? undefined : `${ratio(row.diskMb, row.rawMb)} smaller on disk`}>{mb(row.rawMb)}</td>
										<td className="muted">{row.from && row.to ? `${row.from} → ${row.to}` : ''}</td>
										<td className="muted">{row.modified}</td>
										{!readOnly && (
											<td className="ch-storage-actions">
												{PARTITION_ACTIONS.map((action) => (
													<button
														key={action.id}
														type="button"
														className={action.danger ? 'table-action is-danger' : 'table-action'}
														title={action.label}
														disabled={busy !== null}
														onClick={() => void act(action.id, row)}
													>
														<Icon name={busy === `${action.id}:${row.partitionId}` ? 'loading' : action.icon} className={busy === `${action.id}:${row.partitionId}` ? 'codicon-modifier-spin' : undefined} />
													</button>
												))}
											</td>
										)}
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>

				<div className="telemetry-section">
					<div className="telemetry-heading">Projections</div>
					<div className="muted small ch-storage-blurb">
						A projection is a second copy of this table kept in another order, or pre-aggregated.
						ClickHouse reads it instead of the table when that reads less.
					</div>
					{projections.note && <div className="prop-empty">{projections.note}</div>}
					{!projections.note && !projections.rows && <div className="prop-empty">Reading…</div>}
					{projections.rows && projections.rows.length === 0 && (
						<div className="prop-empty">None. A recurring heavy aggregation over this table is usually what one is for.</div>
					)}
					{projections.rows && projections.rows.length > 0 && (
						<table className="explain-indexes ch-storage-table">
							<thead>
								<tr>
									<th>Projection</th>
									<th>Type</th>
									<th>Ordered by</th>
									<th className="explain-num">Rows</th>
									<th className="explain-num">On disk</th>
									<th>Query</th>
								</tr>
							</thead>
							<tbody>
								{projections.rows.map((row) => (
									<tr key={row.name}>
										<td><code>{row.name}</code></td>
										<td>{row.type}</td>
										<td>{row.sortingKey}</td>
										<td className="explain-num">{NUM.format(row.rows)}</td>
										<td className="explain-num">{mb(row.diskMb)}</td>
										<td className="explain-condition" title={row.query}>{row.query}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>

				<div className="telemetry-section">
					<div className="telemetry-heading">Data-skipping indexes</div>
					<div className="muted small ch-storage-blurb">
						ClickHouse has no B-tree. These hold one summary per group of granules, and a filter on a
						column outside the sort key skips granules only if one of them says it can.
					</div>
					{skipIndexes.note && <div className="prop-empty">{skipIndexes.note}</div>}
					{!skipIndexes.note && !skipIndexes.rows && <div className="prop-empty">Reading…</div>}
					{skipIndexes.rows && skipIndexes.rows.length === 0 && (
						<div className="prop-empty">None. Every filter outside <code>{anatomy.clauses.find((c) => c.label === 'ORDER BY')?.value ?? 'the sort key'}</code> reads every granule.</div>
					)}
					{skipIndexes.rows && skipIndexes.rows.length > 0 && (
						<table className="explain-indexes ch-storage-table">
							<thead>
								<tr>
									<th>Index</th>
									<th>Type</th>
									<th>On</th>
									<th className="explain-num">Granules each</th>
									<th className="explain-num">On disk</th>
								</tr>
							</thead>
							<tbody>
								{skipIndexes.rows.map((row) => (
									<tr key={row.name}>
										<td><code>{row.name}</code></td>
										<td>{row.type}</td>
										<td className="explain-condition" title={row.expression}>{row.expression}</td>
										<td className="explain-num">{NUM.format(row.granulesPerEntry)}</td>
										<td className="explain-num">{mb(row.diskMb)}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			</div>
			{confirmDialog}
		</>
	);
}

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
import { formatLocale, useT } from '../i18n';

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

const NUM = { format: (value: number): string => new Intl.NumberFormat(formatLocale()).format(value) };

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
	const t = useT();
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
					throw new Error(t('clickhouse.storage.notInSystem', { name }));
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
				const note = t('clickhouse.storage.noParts', { engine: head.engine });
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
				}), setPartitions, t('clickhouse.storage.noSystemParts')),
				load(projectionsSql(schema, table), (row) => ({
					name: str(row.name),
					type: str(row.type),
					sortingKey: str(row.sorting_key),
					parts: num(row.parts),
					rows: num(row.rows),
					diskMb: num(row.on_disk_mb),
					query: str(row.query),
				}), setProjections, t('clickhouse.storage.oldProjections')),
				load(skipIndexSql(schema, table), (row) => ({
					name: str(row.name),
					type: str(row.type),
					expression: str(row.expression),
					granulesPerEntry: num(row.granules_per_entry),
					diskMb: num(row.on_disk_mb),
					rawMb: num(row.raw_mb),
				}), setSkipIndexes, t('clickhouse.storage.noSkipIndices')),
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
			title: isProd ? t('clickhouse.storage.confirmProd', { action: action.label }) : t('clickhouse.storage.confirmPartition', { action: action.label, partition: row.partition }),
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
		return <div className="telemetry"><div className="prop-empty">{t('clickhouse.storage.readingAnatomy', { name })}</div></div>;
	}

	const totalRaw = partitions.rows?.reduce((sum, p) => sum + p.rawMb, 0) ?? 0;
	const totalDisk = partitions.rows?.reduce((sum, p) => sum + p.diskMb, 0) ?? 0;

	return (
		<>
			<div className="telemetry ch-storage">
				<div className="telemetry-section">
					<div className="telemetry-heading">{t('clickhouse.storage.engine')}</div>
					<div className="ch-anatomy">
						<div className="ch-anatomy-engine">{anatomy.engine}</div>
						{anatomy.clauses.length === 0 && <div className="muted small">{t('clickhouse.storage.noClauses')}</div>}
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
						<Metric icon="symbol-numeric" label={t('clickhouse.storage.rows')} value={anatomy.rows === undefined ? '—' : NUM.format(anatomy.rows)} hint={t('clickhouse.storage.rowsHint')} />
						<Metric icon="database" label={t('clickhouse.storage.onDisk')} value={anatomy.bytes === undefined ? '—' : mb(anatomy.bytes / 1048576)} />
						{anatomy.isMergeTree && totalRaw > 0 && (
							<Metric icon="symbol-ruler" label={t('clickhouse.storage.compression')} value={ratio(totalDisk, totalRaw)} hint={t('clickhouse.storage.compressionHint', { raw: mb(totalRaw), disk: mb(totalDisk) })} />
						)}
						{anatomy.isMergeTree && (
							<Metric
								icon="layers"
								label={t('clickhouse.storage.activeParts')}
								value={anatomy.activeParts === undefined ? '—' : NUM.format(anatomy.activeParts)}
								hint={`${t('clickhouse.storage.partsIntro')} ${anatomy.parts === anatomy.activeParts ? t('clickhouse.storage.partsClean') : t('clickhouse.storage.partsPending', { n: (anatomy.parts ?? 0) - (anatomy.activeParts ?? 0) })}`}
							/>
						)}
						{anatomy.isMergeTree && (
							<Metric icon="list-ordered" label={t('clickhouse.storage.granules')} value={anatomy.marks === undefined ? '—' : NUM.format(anatomy.marks)} hint={t('clickhouse.storage.granulesHint')} />
						)}
						{anatomy.storagePolicy !== '' && <Metric icon="server-environment" label={t('clickhouse.storage.policy')} value={anatomy.storagePolicy} />}
					</div>
				</div>

				<div className="telemetry-section">
					<div className="telemetry-heading">
						{t('clickhouse.storage.partitions')}
						<span className="spacer" />
						{partitions.rows && partitions.rows.length > 0 && (
							<span className="muted small">{t('clickhouse.storage.partitionCount', { count: partitions.rows.length })}</span>
						)}
					</div>
					<div className="muted small ch-storage-blurb">
						{t('clickhouse.storage.partitionsBlurb')}
					</div>
					{partitions.note && <div className="prop-empty">{partitions.note}</div>}
					{!partitions.note && !partitions.rows && <div className="prop-empty">{t('clickhouse.storage.reading')}</div>}
					{partitions.rows && partitions.rows.length === 0 && (
						<div className="prop-empty">{t('clickhouse.storage.noPartsYet')}</div>
					)}
					{partitions.rows && partitions.rows.length > 0 && (
						<table className="explain-indexes ch-storage-table">
							<thead>
								<tr>
									<th>{t('clickhouse.storage.partition')}</th>
									<th className="explain-num">{t('clickhouse.storage.parts')}</th>
									<th className="explain-num">{t('clickhouse.storage.rows')}</th>
									<th className="explain-num">{t('clickhouse.storage.onDisk')}</th>
									<th className="explain-num">{t('clickhouse.storage.raw')}</th>
									<th>{t('clickhouse.storage.covers')}</th>
									<th>{t('clickhouse.storage.lastWritten')}</th>
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
										<td className="explain-num" title={ratio(row.diskMb, row.rawMb) === '' ? undefined : t('clickhouse.storage.smallerOnDisk', { ratio: ratio(row.diskMb, row.rawMb) })}>{mb(row.rawMb)}</td>
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
					<div className="telemetry-heading">{t('clickhouse.storage.projections')}</div>
					<div className="muted small ch-storage-blurb">
						{t('clickhouse.storage.projectionsBlurb')}
					</div>
					{projections.note && <div className="prop-empty">{projections.note}</div>}
					{!projections.note && !projections.rows && <div className="prop-empty">{t('clickhouse.storage.reading')}</div>}
					{projections.rows && projections.rows.length === 0 && (
						<div className="prop-empty">{t('clickhouse.storage.noneProjections')}</div>
					)}
					{projections.rows && projections.rows.length > 0 && (
						<table className="explain-indexes ch-storage-table">
							<thead>
								<tr>
									<th>{t('clickhouse.storage.projection')}</th>
									<th>{t('clickhouse.storage.type')}</th>
									<th>{t('clickhouse.storage.orderedBy')}</th>
									<th className="explain-num">{t('clickhouse.storage.rows')}</th>
									<th className="explain-num">{t('clickhouse.storage.onDisk')}</th>
									<th>{t('clickhouse.storage.query')}</th>
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
					<div className="telemetry-heading">{t('clickhouse.storage.skipHeading')}</div>
					<div className="muted small ch-storage-blurb">
						{t('clickhouse.storage.skipBlurb')}
					</div>
					{skipIndexes.note && <div className="prop-empty">{skipIndexes.note}</div>}
					{!skipIndexes.note && !skipIndexes.rows && <div className="prop-empty">{t('clickhouse.storage.reading')}</div>}
					{skipIndexes.rows && skipIndexes.rows.length === 0 && (
						<div className="prop-empty">{t('clickhouse.storage.noneSkipBefore')} <code>{anatomy.clauses.find((c) => c.label === 'ORDER BY')?.value ?? t('clickhouse.storage.theSortKey')}</code> {t('clickhouse.storage.noneSkipAfter')}</div>
					)}
					{skipIndexes.rows && skipIndexes.rows.length > 0 && (
						<table className="explain-indexes ch-storage-table">
							<thead>
								<tr>
									<th>{t('clickhouse.storage.index')}</th>
									<th>{t('clickhouse.storage.type')}</th>
									<th>{t('clickhouse.storage.on')}</th>
									<th className="explain-num">{t('clickhouse.storage.granulesEach')}</th>
									<th className="explain-num">{t('clickhouse.storage.onDisk')}</th>
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

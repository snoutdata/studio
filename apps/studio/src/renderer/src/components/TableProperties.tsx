/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { addPrimaryKeySql, alterTableSql, autoIncrementFor, blankColumn, canAlterAutoIncrement, canAlterPrimaryKey, createIndexSql, createTableSql, draftFromTable, dropIndexSql, dropPrimaryKeySql, notNullSql, seriesAlterSql, suggestIndexName, tableDdl, type ColumnDraft, type PrimaryKeyTarget, type TableDraft } from '../ddl';
import { blankSeriesDraft, seriesProblems, timeColumnCandidates, timeKind, type SeriesDraft } from '../../../shared/snouttimeSeries';
import { formatBytes } from '../formatBytes';
import { ratioText } from '../seriesTree';
import { blankEngineDraft, engineById, engineProblems, MERGE_TREE_ENGINES, type EngineDraft } from '../../../shared/clickhouseEngine';
import { namedRows } from '../../../shared/clickhouseOps';
import { dialectFor, type ReplicaScope } from '../../../shared/engine';
import type { DatabaseSchema, TableInfo } from '../../../shared/schema';

// A "Properties" panel for a table: a header (name/description) and a
// left sub-nav whose sections are backed by the introspected schema —
//   Columns       editable designer (add/drop/modify; Save generates CREATE/ALTER)
//   Constraints   the primary key
//   Foreign Keys  this table's outgoing FKs
//   References    other tables' FKs that point here (computed from the full schema)
//   Indexes       secondary indexes (with create/drop)
//   Triggers      each trigger's full CREATE TRIGGER body (MySQL ACTION_STATEMENT /
//                 Postgres pg_get_triggerdef)
//   DDL           the generated CREATE TABLE
//   Engine        ClickHouse only: which MergeTree, what it is partitioned by, its TTL
//   Time series   Postgres with SnoutTime: make the table a series, or change a series' retention
type Section = 'columns' | 'engine' | 'series' | 'constraints' | 'fks' | 'references' | 'indexes' | 'triggers' | 'ddl';

const SECTIONS: { id: Section; label: string; icon: string }[] = [
	{ id: 'columns', label: 'Columns', icon: 'symbol-field' },
	{ id: 'engine', label: 'Engine', icon: 'server-environment' },
	{ id: 'series', label: 'Time series', icon: 'graph-line' },
	{ id: 'constraints', label: 'Constraints', icon: 'key' },
	{ id: 'fks', label: 'Foreign Keys', icon: 'link' },
	{ id: 'references', label: 'References', icon: 'references' },
	{ id: 'indexes', label: 'Indexes', icon: 'list-ordered' },
	{ id: 'triggers', label: 'Triggers', icon: 'symbol-event' },
	{ id: 'ddl', label: 'DDL', icon: 'code' },
];

interface TablePropertiesProps {
	connectionId: string;
	driver: string;
	isProd: boolean;
	mode: 'create' | 'edit';
	base?: TableInfo;
	targetSchema?: string;
	/** Create mode: prefill the designer with this draft (e.g. one the AI assistant proposed). */
	seedDraft?: TableDraft;
	onRunDdl(connectionId: string, sql: string): Promise<{ ok: boolean; error?: string }>;
	onPersisted(table: TableInfo): void;
}

function columnsValid(columns: ColumnDraft[]): boolean {
	return columns.length > 0 && columns.every((c) => c.name.trim() !== '' && c.dataType.trim() !== '');
}

/** The sort key the CREATE will carry, written the way the statement writes it. Shown in the
 *  Engine section because every engine below MergeTree does something drastic without one. */
function orderByOf(draft: TableDraft): string {
	const key = draft.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
	return key.length > 0 ? `(${key.join(', ')})` : 'tuple()';
}

function primaryKeyColumns(table: TableInfo): string[] {
	return table.primaryKey && table.primaryKey.length > 0
		? table.primaryKey
		: table.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
}

export function TableProperties({ connectionId, driver, isProd, mode, base, targetSchema, seedDraft, onRunDdl, onPersisted }: TablePropertiesProps): JSX.Element {
	const [section, setSection] = useState<Section>('columns');
	const [draft, setDraft] = useState<TableDraft>(() =>
		base ? draftFromTable(base) : seedDraft ?? { schema: targetSchema, name: '', columns: [blankColumn()] });
	const [schema, setSchema] = useState<DatabaseSchema | null>(null);
	// A DDL action awaiting confirmation: column save, or an index create/drop.
	const [preview, setPreview] = useState<{ title: string; sql: string } | null>(null);
	const [applying, setApplying] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// "Set primary key" form (Constraints section).
	const [editingPk, setEditingPk] = useState(false);
	const [pkCols, setPkCols] = useState<string[]>([]);
	// "Add index" form.
	const [addingIndex, setAddingIndex] = useState(false);
	const [idxName, setIdxName] = useState('');
	const [idxUnique, setIdxUnique] = useState(false);
	const [idxCols, setIdxCols] = useState<string[]>([]);

	function resetIndexForm(): void {
		setAddingIndex(false);
		setIdxName('');
		setIdxUnique(false);
		setIdxCols([]);
	}

	function resetPkForm(): void {
		setEditingPk(false);
		setPkCols([]);
	}

	// Re-seed when the persisted table changes (e.g. after our own apply re-introspects).
	useEffect(() => {
		if (base) {
			setDraft(draftFromTable(base));
		}
	}, [base]);

	// The full schema backs the References section (and refreshes after edits).
	useEffect(() => {
		let cancelled = false;
		void window.sqlApi.getSchema(connectionId).then((s) => { if (!cancelled) { setSchema(s); } });
		return () => { cancelled = true; };
	}, [connectionId, base]);

	// SnoutTime: offered on Postgres when the extension is in this database, for a new table or
	// an ordinary existing one. A partition belongs to its parent, and a table already
	// partitioned by hand cannot be handed to create_series. When the server carries SnoutTime
	// but this database has not switched it on, the section is still shown, holding the one
	// button that does (a `create extension`, through the same review sheet as every other
	// statement here), rather than leaving it to SQL.
	const seriesFits = dialectFor(driver).driverId === 'postgres' && !base?.partitionOf
		&& !(base && !base.series && schema?.tables.some((t) => t.partitionOf?.name === base.name && t.partitionOf?.schema === base.schema));
	const seriesOffered = seriesFits && !!schema?.snouttime;
	const seriesSwitchable = seriesFits && !schema?.snouttime && !!schema?.snouttimeAvailable;
	const seriesIssues = useMemo(
		() => (seriesOffered && draft.series && !base?.series ? seriesProblems(draft.series, draft.columns) : []),
		[seriesOffered, draft, base],
	);
	function patchSeries(partial: Partial<SeriesDraft> | null): void {
		setDraft((d) => ({ ...d, series: partial === null ? undefined : { ...(d.series ?? blankSeriesDraft(timeColumnCandidates(d.columns)[0] ?? '')), ...partial } }));
	}

	const sql = useMemo(() => {
		if (!columnsValid(draft.columns) || seriesIssues.length > 0) {
			return '';
		}
		const withSeries = seriesOffered ? draft : { ...draft, series: undefined };
		if (mode === 'create') {
			return draft.name.trim() === '' ? '' : createTableSql(withSeries, driver);
		}
		return base ? [alterTableSql(base, withSeries, driver), ...seriesAlterSql(base, withSeries, driver)].filter((x) => x.trim() !== '').join('\n') : '';
	}, [draft, base, driver, mode, seriesOffered, seriesIssues]);

	const references = useMemo(() => {
		if (!schema || !base) {
			return [];
		}
		const out: { table: string; constraintName: string; columns: string[]; referencedColumns: string[] }[] = [];
		for (const t of schema.tables) {
			for (const fk of t.foreignKeys) {
				if (fk.referencedTable === base.name) {
					out.push({ table: t.name, constraintName: fk.constraintName, columns: fk.columns, referencedColumns: fk.referencedColumns });
				}
			}
		}
		return out;
	}, [schema, base]);

	const canSave = sql.trim() !== '' && !applying;
	// A disabled button with no reason next to it is the whole bug this answers: the TYPE
	// placeholder reads "int", which looks exactly like a value that is already there, so a
	// column with no type at all looks finished. The save silently could not build any DDL and
	// nothing said so. Same source as `sql` above, so the sentence and the button never disagree.
	const blocker = useMemo(() => {
		if (applying || sql.trim() !== '') {
			return null;
		}
		if (mode === 'create' && draft.name.trim() === '') {
			return 'Give the table a name.';
		}
		if (draft.columns.length === 0) {
			return 'Add at least one column.';
		}
		const noName = draft.columns.findIndex((c) => c.name.trim() === '');
		if (noName >= 0) {
			return `Column ${noName + 1} needs a name.`;
		}
		const noType = draft.columns.find((c) => c.dataType.trim() === '');
		if (noType) {
			return `Column "${noType.name.trim()}" needs a type. The grey text is a suggestion, not a value.`;
		}
		if (seriesIssues.length > 0) {
			return `Time series: ${seriesIssues[0]}`;
		}
		if (mode === 'edit') {
			return 'Nothing has changed yet.';
		}
		return null;
	}, [applying, sql, mode, draft, seriesIssues]);
	// The primary key as it stands: on the persisted table in edit mode, on the draft's ticked PK
	// boxes before the table exists.
	const basePk = base ? primaryKeyColumns(base) : [];
	const draftPk = draft.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
	const pkTarget: PrimaryKeyTarget = { schema: base?.schema, name: base?.name ?? draft.name, constraintName: base?.primaryKeyName };
	// The columns the chosen key would cover that currently allow NULL: a key column can't, so the
	// statement has to say so, and the user should know before they run it.
	const nullablePkCols = (base?.columns ?? []).filter((c) => pkCols.includes(c.name) && c.nullable).map((c) => c.name);
	// Replacing a key is drop-then-add; setting a first one is just the add. NOT NULL comes first,
	// because Postgres is the only engine that promotes the columns for you.
	const primaryKeySql = [
		...nullablePkCols.map((n) => notNullSql(pkTarget, n, base?.columns.find((c) => c.name === n)?.dataType ?? '', driver)),
		...(basePk.length > 0 ? [dropPrimaryKeySql(pkTarget, driver)] : []),
		addPrimaryKeySql(pkTarget, pkCols, driver),
	].join('\n');
	// What this engine calls an auto-increment column, or null when it has none — the designer
	// shows the column only for engines that do.
	// ClickHouse's physical half. The engine form is for a table being CREATED: ORDER BY and
	// PARTITION BY are the order the data is written in and cannot be changed in place, so an
	// existing table's engine is READ on the Storage tab rather than edited here.
	const isClickHouse = dialectFor(driver).driverId === 'clickhouse';
	const engine: EngineDraft = draft.engine ?? blankEngineDraft();
	function patchEngine(partial: Partial<EngineDraft>): void {
		setDraft((d) => ({ ...d, engine: { ...(d.engine ?? blankEngineDraft()), ...partial } }));
	}
	// Whether this server has replicas at all, which is the only thing that makes "create on every
	// replica" a real choice. Read once, in the background, and a failure just means the option is
	// not offered (exactly as the Operations panel treats a refused system table).
	const [scope, setScope] = useState<ReplicaScope | null>(null);
	useEffect(() => {
		if (!isClickHouse || mode !== 'create') {
			return;
		}
		let alive = true;
		const probe = dialectFor(driver).replicaScope;
		if (!probe) {
			return;
		}
		void probe(async (sql) => {
			const res = await window.sqlApi.explain({ connectionId, sql });
			if (!res.ok) {
				throw new Error(res.error);
			}
			return namedRows(res.result.fields, res.result.rows);
		}).then((found) => {
			if (alive) {
				setScope(found);
			}
		}).catch(() => undefined);
		return () => { alive = false; };
	}, [isClickHouse, mode, driver, connectionId]);

	const autoIncrement = autoIncrementFor(driver);
	// SQLite's spelling exists only inside CREATE TABLE, and SQL Server / Snowflake / Redshift /
	// HANA fix the property when the column is created; on those, an EXISTING column's checkbox is
	// read-only rather than generating DDL the engine would refuse.
	const autoIncrementCreateOnly = autoIncrement?.inlinePrimaryKey === true;
	function autoIncrementLocked(col: ColumnDraft): boolean {
		if (autoIncrementCreateOnly) {
			return mode !== 'create';
		}
		return col.originalName !== undefined && !canAlterAutoIncrement(driver);
	}

	function patchColumn(index: number, patch: Partial<ColumnDraft>): void {
		setDraft((d) => ({ ...d, columns: d.columns.map((c, i) => (i === index ? { ...c, ...patch } : c)) }));
	}

	// Auto-increment is a table-wide property as much as a column one: every engine here allows at
	// most one such column, most require it to be a key, and none lets it carry a DEFAULT or a NULL.
	// So the checkbox settles all of that rather than leaving the user to discover it from an error.
	function setAutoIncrement(index: number, on: boolean): void {
		setDraft((d) => {
			const takesKey = on && autoIncrement?.requiresKey === true && !d.columns.some((c, i) => i !== index && c.isPrimaryKey);
			return {
				...d,
				columns: d.columns.map((c, i) => {
					if (i !== index) {
						// Only one column per table can be generated, so ticking one unticks the rest.
						return c.autoIncrement ? { ...c, autoIncrement: false } : c;
					}
					if (!on) {
						// A Postgres serial keeps its sequence in the DEFAULT rather than in an
						// identity property, so unticking has to clear that too or nothing changes.
						const def = /^nextval\(/i.test(c.default) ? '' : c.default;
						return { ...c, autoIncrement: false, default: def };
					}
					return { ...c, autoIncrement: true, nullable: false, default: '', isPrimaryKey: takesKey ? true : c.isPrimaryKey };
				}),
			};
		});
	}

	function revert(): void {
		setError(null);
		setDraft(base ? draftFromTable(base) : { schema: targetSchema, name: '', columns: [blankColumn()] });
	}

	async function apply(): Promise<void> {
		if (!preview) {
			return;
		}
		setApplying(true);
		setError(null);
		const result = await onRunDdl(connectionId, preview.sql);
		if (!result.ok) {
			setApplying(false);
			setError(result.error ?? 'Failed to apply changes.');
			return;
		}
		const fresh = await window.sqlApi.getSchema(connectionId);
		if (fresh) {
			setSchema(fresh);
		}
		const found = fresh?.tables.find((t) => t.name === draft.name && (draft.schema ? t.schema === draft.schema : true)) ?? null;
		setApplying(false);
		setPreview(null);
		resetIndexForm();
		resetPkForm();
		if (found) {
			onPersisted(found);
		}
	}

	return (
		<div className="properties">
			<div className="prop-header">
				<label>Table Name
					{mode === 'create'
						? <input type="text" value={draft.name} placeholder="new_table" autoFocus onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
						: <input type="text" value={base ? (base.schema ? `${base.schema}.${base.name}` : base.name) : ''} readOnly />}
				</label>
				<label>Description
					<input type="text" value={base?.comment ?? ''} placeholder="—" readOnly />
				</label>
			</div>

			<div className="prop-body">
				<div className="prop-nav">
					{SECTIONS.filter((s) => (s.id !== 'engine' || isClickHouse) && (s.id !== 'series' || seriesOffered || seriesSwitchable)).map((s) => (
						<div
							key={s.id}
							className={`prop-nav-item${section === s.id ? ' active' : ''}`}
							onClick={() => setSection(s.id)}
						>
							<Icon name={s.icon} /> {s.label}
						</div>
					))}
				</div>

				<div className="prop-section">
					{section === 'columns' && (
						<div className="designer-grid">
							<div className="dg-row dg-head">
								<span className="dg-pk" title="Primary key">PK</span>
								<span className="dg-name">Name</span>
								<span className="dg-type">Type</span>
								<span className="dg-null" title="Allow NULL">Null</span>
								{autoIncrement && <span className="dg-auto" title={`Auto-increment (${autoIncrement.label})`}>Auto</span>}
								{isClickHouse && <span className="dg-codec" title="Compression codec (ClickHouse)">Codec</span>}
								<span className="dg-default">Default</span>
								<span className="dg-comment">Description</span>
								<span className="dg-actions" />
							</div>
							{draft.columns.map((c, i) => (
								<div className="dg-row" key={i}>
									<span className="dg-pk"><input type="checkbox" checked={c.isPrimaryKey} onChange={(e) => patchColumn(i, { isPrimaryKey: e.target.checked })} /></span>
									<span className="dg-name"><input type="text" value={c.name} placeholder="column" onChange={(e) => patchColumn(i, { name: e.target.value })} /></span>
									<span className="dg-type"><input type="text" className={c.dataType.trim() === '' && c.name.trim() !== '' ? 'needs-value' : undefined} value={c.dataType} placeholder="int" onChange={(e) => patchColumn(i, { dataType: e.target.value })} /></span>
									<span className="dg-null"><input type="checkbox" checked={c.nullable} disabled={c.autoIncrement === true} title={c.autoIncrement ? "An auto-increment column is never null." : undefined} onChange={(e) => patchColumn(i, { nullable: e.target.checked })} /></span>
									{autoIncrement && (
										<span className="dg-auto">
											<input
												type="checkbox"
												checked={c.autoIncrement === true}
												disabled={autoIncrementLocked(c)}
												title={autoIncrementLocked(c)
													? `${autoIncrement.label} can only be set when the column is created on this engine.`
													: `${autoIncrement.label}: the database generates the value.`}
												onChange={(e) => setAutoIncrement(i, e.target.checked)}
											/>
										</span>
									)}
									{/* On a columnar store the codec is the difference between a column costing
									    eight bytes a row and costing one bit, and the right answer depends on
									    what is in the column, which is why it is per column and not per table. */}
									{isClickHouse && (
										<span className="dg-codec">
											<input
												type="text"
												value={c.codec ?? ''}
												placeholder="—"
												title="How this column is compressed, e.g. Delta, ZSTD(3) for a timestamp, or ZSTD(1) for text. Empty uses the server's default."
												onChange={(e) => patchColumn(i, { codec: e.target.value })}
											/>
										</span>
									)}
									<span className="dg-default"><input type="text" value={c.default} placeholder="—" disabled={c.autoIncrement === true} title={c.autoIncrement ? "The generated value is the default." : undefined} onChange={(e) => patchColumn(i, { default: e.target.value })} /></span>
									{/* The database's own column comment. Read-only for now: writing one needs
									    per-dialect DDL (MySQL inline COMMENT, Postgres COMMENT ON, SQL Server
									    extended properties), so it is shown rather than edited. */}
									<span className="dg-comment"><input type="text" value={c.comment ?? ''} placeholder="—" readOnly title={c.comment ?? "No description on this column"} /></span>
									<span className="dg-actions"><button type="button" className="icon-btn" aria-label="Remove column" onClick={() => setDraft((d) => ({ ...d, columns: d.columns.filter((_x, j) => j !== i) }))}><Icon name="trash" /></button></span>
								</div>
							))}
							<div className="dg-add">
								<button type="button" className="secondary" onClick={() => setDraft((d) => ({ ...d, columns: [...d.columns, blankColumn()] }))}><Icon name="add" /> Add column</button>
							</div>
						</div>
					)}

					{section === 'constraints' && (
						!base
							// Before the table exists the key is part of the CREATE statement, so it is
							// set by ticking PK in the Columns grid; this only reports what that says.
							? <PropTable head={['Name', 'Type', 'Columns']} rows={
								draftPk.length > 0 ? [['PRIMARY', 'PRIMARY KEY', draftPk.join(', ')]] : []
							} empty="No primary key. Tick PK on a column to add one." />
							: (
								<div className="prop-index">
									{basePk.length > 0 && (
										<div className="prop-table">
											<div className="pt-row pt-head"><span>Name</span><span>Type</span><span>Columns</span><span className="pt-actions" /></div>
											<div className="pt-row">
												<span>{base.primaryKeyName ?? 'PRIMARY'}</span>
												<span>PRIMARY KEY</span>
												<span>{basePk.join(', ')}</span>
												<span className="pt-actions">
													<button type="button" className="icon-btn" aria-label="Drop primary key" onClick={() => {
														setError(null);
														setPreview({ title: 'Drop primary key', sql: dropPrimaryKeySql(pkTarget, driver) });
													}}><Icon name="trash" /></button>
												</span>
											</div>
										</div>
									)}
									{basePk.length === 0 && !editingPk && <div className="prop-empty">No primary key.</div>}

									{editingPk ? (
										<div className="index-form">
											<div className="index-cols">
												{base.columns.map((c) => (
													<label className="check" key={c.name}>
														<input type="checkbox" checked={pkCols.includes(c.name)} onChange={(e) => setPkCols((prev) => e.target.checked ? [...prev, c.name] : prev.filter((n) => n !== c.name))} />
														{c.name}
													</label>
												))}
											</div>
											{/* A key column cannot be null, and saying so here beats an engine error
											    after the fact. The generated DDL sets NOT NULL for the ones that are. */}
											{nullablePkCols.length > 0 && (
												<div className="prop-note muted small">
													<Icon name="info" />
													<span>{nullablePkCols.join(', ')} {nullablePkCols.length === 1 ? 'allows' : 'allow'} NULL, so the key also sets NOT NULL. It fails if any existing row is null there.</span>
												</div>
											)}
											<div className="index-form-actions">
												<button type="button" className="copy" onClick={resetPkForm}><Icon name="close" /> Cancel</button>
												<button type="button" disabled={pkCols.length === 0} onClick={() => {
													setError(null);
													setPreview({
														title: basePk.length > 0 ? 'Change primary key' : 'Set primary key',
														sql: primaryKeySql,
													});
												}}><Icon name="key" /> {basePk.length > 0 ? 'Change primary key' : 'Set primary key'}</button>
											</div>
										</div>
									) : canAlterPrimaryKey(driver) ? (
										<div className="dg-add">
											<button type="button" className="secondary" onClick={() => { setPkCols(basePk); setEditingPk(true); }}>
												<Icon name={basePk.length > 0 ? 'edit' : 'add'} /> {basePk.length > 0 ? 'Change primary key' : 'Add primary key'}
											</button>
										</div>
									) : (
										<div className="prop-note muted small" style={{ padding: '8px 12px' }}>
											<Icon name="info" />
											<span>This engine fixes the primary key when the table is created: changing it means rebuilding the table and copying the rows.</span>
										</div>
									)}
								</div>
							)
					)}

					{section === 'fks' && (
						<PropTable head={['Constraint', 'Columns', 'References']} rows={
							(base?.foreignKeys ?? []).map((fk) => [fk.constraintName, fk.columns.join(', '), `${fk.referencedTable} (${fk.referencedColumns.join(', ')})`])
						} empty="No foreign keys." />
					)}

					{section === 'references' && (
						<PropTable head={['From table', 'Constraint', 'Columns']} rows={
							references.map((r) => [r.table, r.constraintName, `${r.columns.join(', ')} → ${r.referencedColumns.join(', ')}`])
						} empty="No tables reference this one." />
					)}

					{section === 'indexes' && (
						!base
							? <div className="prop-empty">Create the table first, then add indexes.</div>
							: (
								<div className="prop-index">
									{(base.indexes ?? []).length > 0 && (
										<div className="prop-table">
											<div className="pt-row pt-head"><span>Name</span><span>Unique</span><span>Columns</span><span className="pt-actions" /></div>
											{(base.indexes ?? []).map((ix) => (
												<div className="pt-row" key={ix.name}>
													<span>{ix.name}</span>
													<span>{ix.unique ? 'UNIQUE' : ''}</span>
													<span>{ix.columns.join(', ')}</span>
													<span className="pt-actions">
														<button type="button" className="icon-btn" aria-label="Drop index" onClick={() => { setError(null); setPreview({ title: 'Drop index', sql: dropIndexSql({ schema: base.schema, table: base.name, name: ix.name }, driver) }); }}><Icon name="trash" /></button>
													</span>
												</div>
											))}
										</div>
									)}
									{(base.indexes ?? []).length === 0 && !addingIndex && <div className="prop-empty">No indexes.</div>}

									{addingIndex ? (
										<div className="index-form">
											<label>Index name<input type="text" value={idxName} placeholder={suggestIndexName(base.name, idxCols)} onChange={(e) => setIdxName(e.target.value)} /></label>
											<label className="check"><input type="checkbox" checked={idxUnique} onChange={(e) => setIdxUnique(e.target.checked)} /> Unique</label>
											<div className="index-cols">
												{base.columns.map((c) => (
													<label className="check" key={c.name}>
														<input type="checkbox" checked={idxCols.includes(c.name)} onChange={(e) => setIdxCols((prev) => e.target.checked ? [...prev, c.name] : prev.filter((n) => n !== c.name))} />
														{c.name}
													</label>
												))}
											</div>
											<div className="index-form-actions">
												<button type="button" className="copy" onClick={resetIndexForm}><Icon name="close" /> Cancel</button>
												<button type="button" disabled={idxCols.length === 0} onClick={() => {
													const name = idxName.trim() || suggestIndexName(base.name, idxCols);
													setError(null);
													setPreview({ title: 'Create index', sql: createIndexSql({ schema: base.schema, table: base.name, name, unique: idxUnique, columns: idxCols }, driver) });
												}}><Icon name="add" /> Create index</button>
											</div>
										</div>
									) : (
										<div className="dg-add"><button type="button" className="secondary" onClick={() => setAddingIndex(true)}><Icon name="add" /> Add index</button></div>
									)}
								</div>
							)
					)}

					{section === 'triggers' && (
						(base?.triggers ?? []).length === 0
							? <div className="prop-empty">No triggers.</div>
							: (
								<div className="prop-triggers">
									{(base!.triggers ?? []).map((tr) => (
										<div className="trigger-card" key={tr.name}>
											<div className="trigger-head">
												<Icon name="symbol-event" />
												<span className="trigger-name">{tr.name}</span>
												<span className="muted">{tr.timing} {tr.event}</span>
											</div>
											<pre className="ddl-view">{tr.statement ?? '-- Trigger body not available.'}</pre>
										</div>
									))}
								</div>
							)
					)}

					{section === 'engine' && (
						mode !== 'create'
							// ORDER BY and PARTITION BY are the order the rows are written in: changing
							// either means a new table and an INSERT SELECT, not an ALTER. So this is not
							// a form here, and the table's real shape has a page of its own.
							? <div className="prop-empty">A ClickHouse table's engine, sort key and partitioning are the order its data is written in, so they cannot be changed here. Open the <strong>Storage</strong> tab to see what this table is, its partitions, its projections and its skip indexes.</div>
							: (
								<div className="ch-engine-form">
									<fieldset>
										<legend>Engine</legend>
										<div className="ch-engine-choices">
											{MERGE_TREE_ENGINES.map((e) => (
												<label className={`ch-engine-choice${engine.engine === e.id ? ' selected' : ''}`} key={e.id}>
													<input type="radio" name="ch-engine" checked={engine.engine === e.id} onChange={() => patchEngine({ engine: e.id, parameter: '' })} />
													<span className="ch-engine-name">{e.label}</span>
													<span className="ch-engine-hint">{e.hint}</span>
												</label>
											))}
										</div>
										{engineById(engine.engine)?.parameter && (
											<label className="ch-engine-field">{engineById(engine.engine)?.parameter?.label}
												<input
													type="text"
													value={engine.parameter}
													placeholder={engineById(engine.engine)?.parameter?.placeholder}
													onChange={(e) => patchEngine({ parameter: e.target.value })}
												/>
												<span className="muted small">{engineById(engine.engine)?.parameter?.hint}</span>
											</label>
										)}
									</fieldset>

									<fieldset>
										<legend>How the data is laid out</legend>
										<label className="ch-engine-field">Sort key
											<input type="text" value={orderByOf(draft)} readOnly title="The columns ticked as the key in Columns. It is the order the rows are stored in, which is what a query skips data by." />
											<span className="muted small">Tick the key columns in <strong>Columns</strong>. This is the order the rows are stored in, and what a query can skip data by.</span>
										</label>
										<label className="ch-engine-field">Partition by
											<input type="text" value={engine.partitionBy} placeholder="toYYYYMM(ts)" onChange={(e) => patchEngine({ partitionBy: e.target.value })} />
											<span className="muted small">A partition is read and dropped as a unit. A month of a timestamp column is the usual answer; too many partitions is worse than none.</span>
										</label>
										<label className="ch-engine-field">TTL
											<input type="text" value={engine.ttl} placeholder="ts + INTERVAL 90 DAY" onChange={(e) => patchEngine({ ttl: e.target.value })} />
											<span className="muted small">When a row expires and is removed.</span>
										</label>
										<label className="ch-engine-field">Settings
											<input type="text" value={engine.settings} placeholder="index_granularity = 8192" onChange={(e) => patchEngine({ settings: e.target.value })} />
										</label>
									</fieldset>

									{scope && scope.replicas > 1 && (
										<fieldset>
											<legend>Replicas</legend>
											<label className="check">
												<input
													type="checkbox"
													checked={engine.replicated}
													onChange={(e) => patchEngine({ replicated: e.target.checked, cluster: e.target.checked ? (engine.cluster || scope.cluster || 'default') : engine.cluster })}
												/>
												Create on every replica
											</label>
											<div className="muted small">This server has {scope.replicas} replicas. The table is created <code>ON CLUSTER</code> with a <code>Replicated</code> engine, so every replica has it and they keep each other up to date.</div>
											{engine.replicated && (
												<label className="ch-engine-field">Cluster
													<input type="text" value={engine.cluster} placeholder="default" onChange={(e) => patchEngine({ cluster: e.target.value })} />
												</label>
											)}
										</fieldset>
									)}

									{engineProblems(engine, orderByOf(draft)).map((problem, i) => (
										<div className={problem.blocking ? 'results-error ch-engine-problem' : 'ch-engine-problem muted'} key={i}>
											<Icon name={problem.blocking ? 'error' : 'warning'} /> {problem.message}
										</div>
									))}
								</div>
							)
					)}

					{section === 'series' && seriesSwitchable && (
						<div className="ch-engine-form">
							<fieldset>
								<legend>SnoutTime is off in this database</legend>
								<p className="field-hint">
									Switch it on to partition this table by time, seal old partitions and keep rollups.
									It takes effect at once, with no restart, and only in this database.
								</p>
								<button
									type="button"
									onClick={() => { setError(null); setPreview({ title: 'Switch on SnoutTime', sql: 'CREATE EXTENSION IF NOT EXISTS snouttime;' }); }}
								>
									<Icon name="graph-line" /> Switch on SnoutTime
								</button>
							</fieldset>
						</div>
					)}

					{section === 'series' && seriesOffered && (
						<div className="ch-engine-form">
							{base?.series ? (
								<>
									<fieldset>
										<legend>This table is a series</legend>
										<p className="field-hint">
											Partitioned by <strong>{base.series.timeColumn}</strong>, {base.series.partitionSize} per partition,
											{' '}{base.series.partitions.length} partitions
											{base.series.sealedBytesBefore && base.series.sealedBytes
												? `, sealed ones ${formatBytes(base.series.sealedBytesBefore)} → ${formatBytes(base.series.sealedBytes)} (${ratioText(base.series.sealedBytesBefore, base.series.sealedBytes)} smaller)`
												: ''}.
											{' '}The time column and partition size are fixed once a series exists.
										</p>
										<label className="ch-engine-field">Keep rows for
											<input type="text" value={draft.series?.retention ?? ''} placeholder="forever" onChange={(e) => patchSeries({ retention: e.target.value })} />
											<span className="muted small">Partitions whose whole range is older than this are dropped by SnoutTime's worker. Empty keeps everything.</span>
										</label>
									</fieldset>
								</>
							) : (
								<>
									<label className="check">
										<input type="checkbox" checked={!!draft.series} onChange={(e) => patchSeries(e.target.checked ? {} : null)} />
										Make this a series table
									</label>
									<p className="field-hint">
										SnoutTime partitions it by time and makes partitions ahead of the data. Old partitions are sealed into a compressed
										column store and dropped when they pass the retention. Queries and writes do not change.
										{mode === 'edit' ? ' Rows already in the table move into their partitions in the background.' : ''}
									</p>
									{draft.series && (
										<fieldset>
											<legend>Partitioning</legend>
											<label className="ch-engine-field">Time column
												<select value={draft.series.timeColumn} onChange={(e) => patchSeries({ timeColumn: e.target.value })}>
													<option value="">Choose a column</option>
													{timeColumnCandidates(draft.columns).map((name) => <option key={name} value={name}>{name}</option>)}
												</select>
											</label>
											<label className="ch-engine-field">Partition size
												<input
													type="text"
													value={draft.series.interval}
													placeholder={timeKind(draft.columns.find((c) => c.name === draft.series?.timeColumn)?.dataType ?? '') === 'integer' ? '100000' : '1 day'}
													onChange={(e) => patchSeries({ interval: e.target.value })}
												/>
												<span className="muted small">How much time one partition holds. A day suits most tables; aim for partitions of a few million rows.</span>
											</label>
											<label className="ch-engine-field">Keep rows for
												<input type="text" value={draft.series.retention} placeholder="forever" onChange={(e) => patchSeries({ retention: e.target.value })} />
											</label>
											<label className="ch-engine-field">Seal after
												<input type="text" value={draft.series.sealAfter} placeholder="never" onChange={(e) => patchSeries({ sealAfter: e.target.value })} />
												<span className="muted small">How long after a partition's range ends it is compressed into the column store. Late writes still land after it.</span>
											</label>
										</fieldset>
									)}
								</>
							)}
							{seriesIssues.map((problem, i) => (
								<div className="results-error ch-engine-problem" key={i}><Icon name="error" /> {problem}</div>
							))}
						</div>
					)}

					{section === 'ddl' && (
						<pre className="ddl-view">{mode === 'create'
							? (sql || '-- Define a table name and at least one column.')
							: (base ? tableDdl(base, driver) : '')}</pre>
					)}
				</div>
			</div>

			<div className="prop-footer">
				<span className="muted">{mode === 'create' ? 'New table' : 'Editing structure'}</span>
				{blocker && <span className="prop-blocker">{blocker}</span>}
				<span className="spacer" />
				<button type="button" className="copy" onClick={revert} disabled={applying || sql.trim() === ''}><Icon name="discard" /> Revert</button>
				<button type="button" onClick={() => { setError(null); setPreview({ title: mode === 'create' ? 'Create table' : 'Apply changes', sql }); }} disabled={!canSave}>
					<Icon name="save" /> {mode === 'create' ? 'Create table' : 'Save changes'}
				</button>
			</div>

			{preview !== null && (
				<div className="modal-backdrop" onClick={() => !applying && setPreview(null)}>
					<div className="modal designer-preview" onClick={(e) => e.stopPropagation()}>
						<h3>{preview.title}</h3>
						{isProd && <div className="prod-warning"><Icon name="warning" /> This is a <b>production</b> connection. Review carefully.</div>}
						<pre className="ddl-preview">{preview.sql}</pre>
						{error && <div className="results-error">{error}</div>}
						<div className="modal-actions">
							<button type="button" className="copy" onClick={() => setPreview(null)} disabled={applying}><Icon name="close" /> Cancel</button>
							<button type="button" onClick={() => void apply()} disabled={applying}>
								<Icon name={applying ? 'loading' : 'play'} className={applying ? 'codicon-modifier-spin' : undefined} /> {applying ? 'Applying…' : 'Run'}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** A small read-only table for constraint/FK/reference sections. */
function PropTable({ head, rows, empty }: { head: string[]; rows: string[][]; empty: string }): JSX.Element {
	if (rows.length === 0) {
		return <div className="prop-empty">{empty}</div>;
	}
	return (
		<div className="prop-table">
			<div className="pt-row pt-head">{head.map((h, i) => <span key={i}>{h}</span>)}</div>
			{rows.map((row, i) => (
				<div className="pt-row" key={i}>{row.map((cell, j) => <span key={j}>{cell}</span>)}</div>
			))}
		</div>
	);
}

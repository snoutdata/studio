/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { SqlCode } from './SqlCode';
import { DataGrid, cellText, computeColumnWidths } from './DataGrid';
import { useConfirm } from './ConfirmDialog';
import { errorMessage } from '../errors';
import type { ConnectionConfig } from '../../../shared/connection';
import type { CloudAccountView } from '../../../shared/cloud';
import type { QueryResult } from '../../../shared/query';
import {
	bulkFormatsFor,
	emitTableFunctionCall,
	importStatement,
	missingArguments,
	previewStatement,
	tableFunctionsFor,
	type TableFunctionSpec,
} from '../../../shared/engine';

// Remote data: the data that is NOT in this database, which on ClickHouse is a function
// you select FROM.
//
// The screen exists because those functions are the engine's best trick and, in every client
// including this one until now, a string you type by hand: no completion, no schema, no way to find
// out what went wrong except to run it and read an error about argument 4.
//
// Three things it does that typing cannot. It asks the SERVER what the columns are before a row is
// read (`DESCRIBE TABLE s3(...)`), which is the question a person actually has. It takes the
// credentials out of the statement: a saved cloud account's key pair is resolved in main, out of the
// keychain, and a password typed here is replaced by an unrunnable placeholder everywhere the
// statement is shown or recorded. And it turns the result into a table of this database's own in one
// click, which is what most of these sessions were always going to end with.
//
// Everything that decides is in `shared/engine/dialect/tableFunctions.ts` and its spec list; this
// file draws it and nothing more. Main builds the statement that runs.

const PREVIEW_ROWS = 100;

interface ClickHouseRemoteViewProps {
	connections: ConnectionConfig[];
	connectedIds: string[];
	connectionId?: string;
	/** Put a statement in a new editor tab, so the session carries on as ordinary SQL. */
	onOpenInEditor(sql: string): void;
}

type Outcome = { kind: 'columns'; result: QueryResult } | { kind: 'rows'; result: QueryResult } | null;

export function ClickHouseRemoteView({ connections, connectedIds, connectionId, onOpenInEditor }: ClickHouseRemoteViewProps): JSX.Element {
	const conn = connections.find((c) => c.id === connectionId);
	const driver = conn?.driver ?? '';
	const functions = useMemo(() => tableFunctionsFor(driver), [driver]);
	const formats = useMemo(() => bulkFormatsFor(driver), [driver]);
	const connected = connectionId !== undefined && connectedIds.includes(connectionId);

	const [specId, setSpecId] = useState(functions[0]?.id ?? '');
	// Values are per function, so switching away and back does not lose what was typed. They live
	// only while this tab is open: nothing here is written to disk, which is also why a password
	// typed here has to be typed again next time.
	const [values, setValues] = useState<Record<string, Record<string, string>>>({});
	const [accountId, setAccountId] = useState('');
	const [accounts, setAccounts] = useState<CloudAccountView[]>([]);
	const [tableName, setTableName] = useState('');
	const [database, setDatabase] = useState('');
	const [databases, setDatabases] = useState<string[]>([]);
	const [busy, setBusy] = useState<'describe' | 'preview' | 'import' | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [outcome, setOutcome] = useState<Outcome>(null);
	// What the columns ARE, kept apart from what is being shown. Describing and then previewing
	// must not lose them: they are what the new table's sort key is picked from, and a preview
	// answers the same question (its fields carry the server's own types).
	const [columns, setColumns] = useState<{ name: string; type: string }[]>([]);
	const [confirm, confirmDialog] = useConfirm();

	const spec: TableFunctionSpec | undefined = functions.find((f) => f.id === specId) ?? functions[0];
	const current = (spec && values[spec.id]) ?? {};
	const missing = spec ? missingArguments(spec, current) : [];
	const usingAccount = accountId !== '';

	// A saved cloud account can fill in a key pair. Only one saved AS A KEY: the ClickHouse server
	// is what fetches the data, so a profile or a role on THIS computer is no use to it, and main
	// refuses those by name rather than letting a bucket answer with a permission error.
	useEffect(() => {
		let alive = true;
		void window.sqlApi.cloud.list().then((list) => {
			if (alive) {
				setAccounts(list.filter((a) => a.auth.mode === 'key' && a.hasSecret));
			}
		}).catch(() => undefined);
		return () => {
			alive = false;
		};
	}, []);

	// Which database a new table would go into. The connection's own is the default, and the rest
	// are offered because "it went somewhere else" is not a thing a person should have to find out
	// by looking: a ClickHouse connection usually reaches every database on the server.
	useEffect(() => {
		if (!connectionId || !connected) {
			return;
		}
		let alive = true;
		void window.sqlApi.getSchema(connectionId).then((schema) => {
			if (!alive || !schema) {
				return;
			}
			const names = [...new Set(schema.tables.map((t) => t.schema).filter((name): name is string => Boolean(name)))].sort();
			setDatabases(names);
			setDatabase((prev) => prev || conn?.database?.trim() || names.find((n) => n === 'default') || names[0] || '');
		}).catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [connectionId, connected, conn?.database]);

	// The statement as it will be RECORDED and shown: secrets already gone. The real one is built
	// in main and never comes back here.
	const shownCall = spec
		? emitTableFunctionCall(driver, spec, usingAccount && spec.keyPair
			? { ...current, [spec.keyPair.idParam]: '<redacted>', [spec.keyPair.secretParam]: '<redacted>' }
			: current, { redactSecrets: true })
		: '';
	const shownSql = spec ? previewStatement(shownCall, PREVIEW_ROWS) : '';

	function setValue(name: string, value: string): void {
		if (!spec) {
			return;
		}
		setValues((prev) => ({ ...prev, [spec.id]: { ...(prev[spec.id] ?? {}), [name]: value } }));
	}

	async function run(action: 'describe' | 'preview'): Promise<void> {
		if (!spec || !connectionId) {
			return;
		}
		setBusy(action);
		setError(null);
		try {
			const res = await window.sqlApi.tableFunction({
				connectionId,
				functionId: spec.id,
				values: current,
				accountId: usingAccount ? accountId : undefined,
				action,
				limit: PREVIEW_ROWS,
			});
			if (res.ok) {
				setOutcome({ kind: action === 'describe' ? 'columns' : 'rows', result: res.result });
				setColumns(action === 'describe'
					? res.result.rows.map((row) => ({ name: String(row[0] ?? ''), type: String(row[1] ?? '') })).filter((c) => c.name)
					: res.result.fields.map((field) => ({ name: field.name, type: field.dataType ?? '' })));
			} else {
				setOutcome(null);
				setError(res.error);
			}
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(null);
		}
	}

	async function importTable(): Promise<void> {
		if (!spec || !connectionId) {
			return;
		}
		const target = database || conn?.database?.trim() || 'default';
		const name = tableName.trim();
		if (!name) {
			return;
		}
		// The sort key is the first described column, or nothing at all. Offering a picker here
		// would be a second table designer; what this action is for is getting the data in, and the
		// Storage tab is where a MergeTree is then made to behave.
		const orderBy = columns.length > 0 ? [columns[0].name] : [];
		const statement = importStatement(driver, { database: target, table: name, orderBy }, shownCall);
		const ok = await confirm({
			title: "Create this table?",
			icon: 'table',
			confirmLabel: "Create table",
			body: (
				<>
					<p>{`It reads everything ${spec.label.toLowerCase()} returns and writes it into ${target}.${name}. Nothing is copied back the other way.`}</p>
					<SqlCode sql={statement} />
					{orderBy.length === 0
						? <p className="muted small">Nothing has been described or previewed yet, so the table is created with no sort order (tuple()). Describe it first and it is sorted by its first column.</p>
						: <p className="muted small">Sorted by {orderBy[0]}, its first column. The Storage tab is where a MergeTree is then made to behave.</p>}
				</>
			),
		});
		if (!ok) {
			return;
		}
		setBusy('import');
		setError(null);
		try {
			const res = await window.sqlApi.tableFunction({
				connectionId,
				functionId: spec.id,
				values: current,
				accountId: usingAccount ? accountId : undefined,
				action: 'import',
				target: { database: target, table: name, orderBy },
			});
			if (res.ok) {
				await window.sqlApi.refresh(connectionId).catch(() => undefined);
				setError(null);
				setOutcome(null);
				setColumns([]);
				setTableName('');
				onOpenInEditor(`SELECT * FROM ${target}.${name} LIMIT 100`);
			} else {
				setError(res.error);
			}
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(null);
		}
	}

	if (!conn) {
		return <div className="table-view"><div className="results-message">Select a ClickHouse connection in the sidebar.</div></div>;
	}
	if (functions.length === 0) {
		return <div className="table-view"><div className="results-message">Remote data reads ClickHouse's table functions. "{conn.label}" is not a ClickHouse connection.</div></div>;
	}

	const rows = outcome?.kind === 'rows' ? outcome.result.rows : [];
	const fields = outcome?.kind === 'rows' ? outcome.result.fields : [];
	const widths = computeColumnWidths(fields, rows.length, (i) => rows[i]);

	return (
		<div className="table-view ch-remote">
			<div className="tv-head">
				<Icon name="globe" className="tv-head-icon" />
				<span className="tv-title">Remote data</span>
				<span className="muted">{conn.label}</span>
			</div>
			{!connected
				? <div className="results-message">Connect "{conn.label}" in the sidebar to read from somewhere else.</div>
				: (
					<div className="ch-remote-body">
						{/* The settings page's own nav, classes and all: one list shape for the app. */}
						<nav className="settings-nav ch-remote-nav" aria-label="Source">
							{functions.map((fn) => (
								<button
									type="button"
									key={fn.id}
									className={`settings-nav-item${fn.id === spec?.id ? ' active' : ''}`}
									onClick={() => { setSpecId(fn.id); setOutcome(null); setColumns([]); setError(null); }}
								>
									<Icon name={fn.icon} className="settings-nav-icon" />
									<span>{fn.label}</span>
								</button>
							))}
						</nav>

						{spec && (
							<div className="ch-remote-main">
								<p className="ch-remote-summary muted">{spec.summary}</p>

								<div className="ch-remote-form">
									{spec.params.map((param) => (
										<Fragment key={param.name}>
											<label>
												{param.label}
												{param.format
													? (
														// The visible label carries the field's name; the control names
														// itself too, so a test and a screen reader agree with the eye.
														<select aria-label={param.label} value={current[param.name] ?? ''} onChange={(e) => setValue(param.name, e.target.value)}>
															<option value="">Work it out</option>
															{formats.map((f) => <option key={f.id} value={f.id}>{f.id}</option>)}
														</select>
													)
													: (
														<input
															type={param.secret ? 'password' : 'text'}
															aria-label={param.label}
															value={current[param.name] ?? ''}
															placeholder={param.placeholder}
															disabled={usingAccount && (param.name === spec.keyPair?.idParam || param.name === spec.keyPair?.secretParam)}
															onChange={(e) => setValue(param.name, e.target.value)}
														/>
													)}
											</label>
											{param.note && <p className="field-hint">{param.note}</p>}
										</Fragment>
									))}
									{spec.keyPair && accounts.length > 0 && (
										<>
											<label>
												Credentials
												<select aria-label="Credentials" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
													<option value="">Typed above</option>
													{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
												</select>
											</label>
											<p className="field-hint">A saved account's key is read from the keychain when the statement runs, and never reaches this screen or query history.</p>
										</>
									)}
								</div>

								<SqlCode sql={shownSql} />

								<div className="ch-remote-actions">
									<button type="button" disabled={busy !== null || missing.length > 0} onClick={() => void run('describe')}><Icon name="search" /> 
										{busy === 'describe' ? 'Asking…' : 'Describe'}
									</button>
									<button type="button" className="secondary" disabled={busy !== null || missing.length > 0} onClick={() => void run('preview')}><Icon name="eye" /> 
										{busy === 'preview' ? 'Reading…' : `Preview ${PREVIEW_ROWS} rows`}
									</button>
									<span className="spacer" />
									<button type="button" className="secondary" disabled={missing.length > 0} onClick={() => onOpenInEditor(shownSql)}><Icon name="go-to-file" /> Open in editor</button>
								</div>
								{missing.length > 0 && <p className="field-hint">Fill in {missing.join(', ')} to run anything.</p>}

								<div className="ch-remote-create ch-remote-form">
									<div className="ch-remote-create-head">Create a table from this</div>
									<div className="ch-remote-create-row">
										<label>
											Database
											<select aria-label="Database for the new table" value={database} onChange={(e) => setDatabase(e.target.value)}>
												{databases.length === 0 && <option value="">default</option>}
												{databases.map((name) => <option key={name} value={name}>{name}</option>)}
											</select>
										</label>
										<label className="grow">
											Name
											<input
												type="text"
												value={tableName}
												placeholder="new table name"
												aria-label="New table name"
												onChange={(e) => setTableName(e.target.value)}
											/>
										</label>
										<button type="button" disabled={busy !== null || missing.length > 0 || tableName.trim() === ''} onClick={() => void importTable()}><Icon name="table" /> 
											{busy === 'import' ? 'Creating…' : 'Create table'}
										</button>
									</div>
									<p className="field-hint">
										{columns.length > 0
											? `MergeTree, sorted by ${columns[0].name}. Everything the source returns is read once and written here.`
											: 'Describe it first and the table is sorted by its first column; without that it is created unsorted.'}
									</p>
								</div>

								{error && <div className="results-error">{error}</div>}

								{outcome?.kind === 'columns' && (
									<div className="ch-remote-columns">
										<div className="ch-remote-columns-head">{columns.length} {columns.length === 1 ? 'column' : 'columns'}, as the server read them</div>
										{columns.map((col) => (
											<div className="ch-remote-column" key={col.name}>
												<span className="ch-remote-column-name">{col.name}</span>
												<span className="muted">{col.type}</span>
											</div>
										))}
									</div>
								)}

								{outcome?.kind === 'rows' && (
									<div className="ch-remote-grid">
										{rows.length === 0
											? <div className="results-message">It answered with no rows.</div>
											: (
												<DataGrid
													fields={fields}
													rowCount={rows.length}
													getRow={(i) => rows[i]}
													widths={widths}
													resetKey={`${connectionId}:${spec.id}`}
													onCopyCell={(i, col) => void navigator.clipboard.writeText(cellText(rows[i][col]) ?? '')}
													onCopyRow={(i) => void navigator.clipboard.writeText(fields.map((_f, col) => cellText(rows[i][col]) ?? '').join('\t'))}
												/>
											)}
									</div>
								)}
							</div>
						)}
					</div>
				)}
			{confirmDialog}
		</div>
	);
}

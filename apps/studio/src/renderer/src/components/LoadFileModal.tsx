/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { SqlCode } from './SqlCode';
import { formatBytes } from '../formatBytes';
import { errorMessage } from '../errors';
import { bulkFormatById, bulkFormatsFor, bulkLoadWarnings, describeBulkLoad, emitBulkLoad, type LoadFileChoice } from '../../../shared/engine';

// Loading a FILE into a table, which on ClickHouse is `INSERT ... FORMAT Parquet` with the file as
// the statement's body rather than the VALUES batches every other path in the app sends.
//
// The screen exists because the load is not reversible and the only decision in it, the format, is
// one the app GUESSED from a file name. So the guess is shown as a choice, the statement it makes
// is shown as itself, and what cannot be undone is said before the button rather than after it.
//
// The file is chosen before this mounts (the OS picker, in main), so there is no empty state: it
// opens knowing the file, its size and what its name suggests it holds.

interface LoadFileModalProps {
	connectionId: string;
	driver: string;
	/** The table the rows are going into. */
	schema?: string;
	table: string;
	/** The file the person already picked, with what main could tell about it. */
	choice: LoadFileChoice;
	onClose(): void;
	/** Rows landed: the grid behind this reloads. */
	onLoaded(rows: number): void;
}

export function LoadFileModal({ connectionId, driver, schema, table, choice, onClose, onLoaded }: LoadFileModalProps): JSX.Element {
	const formats = useMemo(() => bulkFormatsFor(driver), [driver]);
	const [formatId, setFormatId] = useState(choice.formatId ?? formats[0]?.id ?? '');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<{ rows: number; ms: number } | null>(null);
	const [rowsRead, setRowsRead] = useState<number | null>(null);

	const format = bulkFormatById(driver, formatId) ?? formats[0];
	const target = { schema, table };
	const sql = format ? emitBulkLoad(driver, target, format) : '';
	// The guess is only a guess while it is still the guess: changing the picker makes it a choice.
	const guessed = format !== undefined && choice.formatId === format.id;
	const warnings = format ? bulkLoadWarnings(format, choice.encoding, guessed) : [];

	// What the server has read so far, from the same place a running query's progress comes from:
	// the load holds the connection's one active statement, so this is free.
	useEffect(() => {
		if (!busy) {
			return;
		}
		let alive = true;
		const timer = setInterval(() => {
			void window.sqlApi.queryProgress(connectionId).then((progress) => {
				if (alive && progress?.rowsRead !== undefined) {
					setRowsRead(progress.rowsRead);
				}
			}).catch(() => undefined);
		}, 1000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [busy, connectionId]);

	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape' && !busy) {
				onClose();
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [busy, onClose]);

	async function load(): Promise<void> {
		if (!format) {
			return;
		}
		setBusy(true);
		setError(null);
		setRowsRead(null);
		try {
			const outcome = await window.sqlApi.bulkLoad({ connectionId, schema, table, formatId: format.id, filePath: choice.path });
			if (outcome.ok) {
				setDone({ rows: outcome.result.rowsWritten, ms: outcome.result.durationMs });
				onLoaded(outcome.result.rowsWritten);
			} else {
				setError(outcome.error);
			}
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	const name = schema ? `${schema}.${table}` : table;
	return (
		<div className="modal-backdrop" onClick={busy ? undefined : onClose}>
			<div className="modal load-file" onClick={(e) => e.stopPropagation()}>
				<h2>
					<Icon name="cloud-upload" />
					Load a file into {name}
				</h2>

				<div className="load-file-source">
					<Icon name="file" />
					<span className="load-file-name" title={choice.path}>{choice.name}</span>
					<span className="muted">{formatBytes(choice.bytes)}</span>
					{choice.encoding && <span className="limit-badge info">{choice.encoding}</span>}
				</div>

				{done
					? (
						<p className="confirm-detail">
							{done.rows.toLocaleString()} {done.rows === 1 ? 'row' : 'rows'} written in {(done.ms / 1000).toFixed(1)}s.
						</p>
					)
					: (
						<>
							{/* A plain labelled field, like the connection form's: a box around one control
							    reads as a group that has lost its other members. */}
							<label>
								Read it as
								<select aria-label="Read it as" value={formatId} disabled={busy} onChange={(e) => setFormatId(e.target.value)}>
									{formats.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
								</select>
							</label>
							{format && <p className="field-hint">{format.note ?? describeBulkLoad(target, format)}</p>}

							{sql && <SqlCode sql={sql} />}

							<div className="confirm-hazards">
								{warnings.map((warning, i) => (
									<div className="confirm-hazard" key={i}>
										<Icon name="alert" />
										<div><p className="confirm-hazard-message">{warning}</p></div>
									</div>
								))}
							</div>
						</>
					)}

				{busy && (
					<p className="muted small load-file-progress">
						<Icon name="loading" className="spin" />
						{rowsRead === null ? 'Sending the file…' : `${rowsRead.toLocaleString()} rows read so far…`}
					</p>
				)}
				{error && <div className="results-error">{error}</div>}

				<div className="modal-actions">
					<span className="spacer" />
					{done
						? <button type="button" onClick={onClose} autoFocus><Icon name="check" /> Done</button>
						: (
							<>
								<button type="button" className="secondary" disabled={busy} onClick={onClose}><Icon name="close" /> Cancel</button>
								<button type="button" disabled={busy || !format} onClick={() => void load()}><Icon name="cloud-upload" /> {busy ? 'Loading…' : 'Load'}</button>
							</>
						)}
				</div>
			</div>
		</div>
	);
}

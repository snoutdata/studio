/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { errorMessage } from '../errors';
import type { DbeaverScript, DbeaverScriptScan, WorkspaceFile } from '../../../shared/workspace';

interface WorkspaceImportModalProps {
	onClose(): void;
	/** Called after files are copied into the workspace (with the new workspace copies). */
	onImported(files: WorkspaceFile[]): void;
}

type Source = 'computer' | 'dbeaver';

function relativeTime(ts: number): string {
	const seconds = Math.round((Date.now() - ts) / 1000);
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	return `${Math.round(hours / 24)}d ago`;
}

/**
 * Import SQL files into the workspace from one of several sources: this computer (the OS file
 * picker) or a local DBeaver install (its workspace `.sql` scripts). Selected files are copied
 * into our workspace folder; the originals are never modified. New sources can be added as cases.
 */
export function WorkspaceImportModal({ onClose, onImported }: WorkspaceImportModalProps): JSX.Element {
	const [source, setSource] = useState<Source | null>(null);
	const [dataDir, setDataDir] = useState<string | null>(null);
	const [scripts, setScripts] = useState<DbeaverScript[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				e.preventDefault();
				onClose();
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);

	async function chooseComputer(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const files = await window.sqlApi.workspace.importFile();
			if (files && files.length > 0) {
				onImported(files);
			} else {
				setBusy(false);
			}
		} catch (err) {
			setError(errorMessage(err));
			setBusy(false);
		}
	}

	async function chooseDbeaver(): Promise<void> {
		setSource('dbeaver');
		setBusy(true);
		setError(null);
		try {
			applyScan(await window.sqlApi.workspace.dbeaverScripts());
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	function applyScan(scan: DbeaverScriptScan): void {
		setDataDir(scan.dataDir);
		setScripts(scan.scripts);
		setSelected(new Set(scan.scripts.map((s) => s.path)));
	}

	// Browse to a different DBeaver workspace folder (e.g. a non-standard location) and re-scan.
	async function changeFolder(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const scan = await window.sqlApi.workspace.dbeaverPickFolder();
			if (scan) {
				applyScan(scan);
			}
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	function toggle(path: string): void {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	}

	async function importSelected(): Promise<void> {
		const paths = scripts.filter((s) => selected.has(s.path)).map((s) => s.path);
		if (paths.length === 0) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			onImported(await window.sqlApi.workspace.importPaths(paths));
		} catch (err) {
			setError(errorMessage(err));
			setBusy(false);
		}
	}

	// Step 1: pick a source.
	if (!source) {
		return (
			<div className="modal-backdrop" onClick={onClose}>
				<div className="modal" onClick={(e) => e.stopPropagation()}>
					<div className="modal-head">
						<h2>Import SQL files</h2>
						<span className="spacer" />
						<button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
					</div>
					<p className="muted">Choose where to import scripts from. Files are copied into your workspace; the originals are left untouched.</p>
					<div className="import-sources">
						<button type="button" className="import-source" onClick={() => void chooseComputer()} disabled={busy}>
							<Icon name="device-desktop" />
							<div className="import-source-text">
								<div className="import-source-label">This computer</div>
								<div className="muted small">Pick one or more .sql files from disk.</div>
							</div>
							<Icon name="chevron-right" />
						</button>
						<button type="button" className="import-source" onClick={() => void chooseDbeaver()} disabled={busy}>
							<Icon name="database" />
							<div className="import-source-text">
								<div className="import-source-label">DBeaver</div>
								<div className="muted small">Import scripts from your local DBeaver workspace.</div>
							</div>
							<Icon name="chevron-right" />
						</button>
					</div>
				</div>
			</div>
		);
	}

	// Step 2: the DBeaver script picker.
	const allSelected = scripts.length > 0 && selected.size === scripts.length;
	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal import-picker" onClick={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<button type="button" className="icon-btn" aria-label="Back" onClick={() => { setSource(null); setScripts([]); setError(null); }}><Icon name="arrow-left" /></button>
					<h2>Import from DBeaver</h2>
					<span className="spacer" />
					<button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
				</div>

				<div className="import-folder-bar">
					<Icon name="folder" />
					<div className="import-folder-path muted small" title={dataDir ?? undefined}>
						{dataDir ?? "No DBeaver workspace detected"}
					</div>
					<button type="button" className="secondary small" onClick={() => void changeFolder()} disabled={busy}><Icon name="folder-opened" /> Change…</button>
				</div>

				{busy && scripts.length === 0 && <div className="muted pad">Scanning DBeaver…</div>}

				{!busy && dataDir === null && (
					<div className="pad"><p className="muted">No DBeaver workspace was found on this computer. Use "Change…" to point at your DBeaver workspace folder.</p></div>
				)}

				{!busy && dataDir !== null && scripts.length === 0 && (
					<div className="pad"><p className="muted">No .sql scripts were found in this folder. Use "Change…" to pick a different DBeaver workspace.</p></div>
				)}

				{scripts.length > 0 && (
					<>
						<div className="import-toolbar">
							<label className="check">
								<input
									type="checkbox"
									checked={allSelected}
									onChange={(e) => setSelected(e.target.checked ? new Set(scripts.map((s) => s.path)) : new Set())}
								/> Select all ({scripts.length})
							</label>
						</div>
						<div className="import-list">
							{scripts.map((s) => (
								<label className="import-row" key={s.path} title={s.path}>
									<input type="checkbox" checked={selected.has(s.path)} onChange={() => toggle(s.path)} />
									<div className="import-row-text">
										<div className="import-row-name">{s.name}</div>
										<div className="muted small">{s.folder} · {relativeTime(s.modifiedAt)}</div>
									</div>
								</label>
							))}
						</div>
					</>
				)}

				{error && <div className="form-status error">{error}</div>}

				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onClose} disabled={busy}><Icon name="close" /> Cancel</button>
					<button type="button" onClick={() => void importSelected()} disabled={busy || selected.size === 0}>
						<Icon name="cloud-download" /> Import {selected.size > 0 ? selected.size : ''}
					</button>
				</div>
			</div>
		</div>
	);
}

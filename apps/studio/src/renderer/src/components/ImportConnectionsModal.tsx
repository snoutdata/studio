/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { ImportRow } from './ImportRow';
import { IMPORT_SOURCES } from '../../../shared/forms';
import type { ImportItem, ImportScanResult, ImportSource, ImportSourceId } from '../../../shared/forms';
import { errorMessage } from '../errors';
import { currentPlatform } from '../platform';
import { secretsPlace, useSecretsWeak } from '../secretsPlace';

interface ImportConnectionsModalProps {
	onClose(): void;
	/** Called after one or more connections are imported, with how many. */
	onImported(count: number): void;
	/** Close this and open first-run discovery ("Find databases"), which looks everywhere at once. */
	onFindDatabases?(): void;
}

/**
 * Import saved connections from another database tool. Step 1 is a source pre-screen
 * (DBeaver today; more can be added to IMPORT_SOURCES). Step 2 lists the detected
 * connections with checkboxes; selected ones are saved via the normal connection path.
 * Secrets are never imported, so the user reviews/fills passwords afterwards.
 */
export function ImportConnectionsModal({ onClose, onImported, onFindDatabases }: ImportConnectionsModalProps): JSX.Element {
	const keyPlace = secretsPlace(useSecretsWeak());
	const [source, setSource] = useState<ImportSource | null>(null);
	const [scan, setScan] = useState<ImportScanResult | null>(null);
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

	// Default-select everything supported and not already saved.
	function applyScan(result: ImportScanResult): void {
		setScan(result);
		setSelected(new Set(result.items.filter((i) => i.supported && !i.duplicate && !i.tentative).map((i) => i.key)));
	}

	async function chooseSource(s: ImportSource): Promise<void> {
		setSource(s);
		setBusy(true);
		setError(null);
		try {
			applyScan(await window.sqlApi.importScan(s.id));
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	async function browse(sourceId: ImportSourceId): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const result = await window.sqlApi.importBrowse(sourceId);
			if (result) {
				applyScan(result);
			}
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	function toggle(key: string): void {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}

	async function importSelected(items: ImportItem[]): Promise<void> {
		const picked = items.filter((i) => selected.has(i.key) && i.supported);
		if (picked.length === 0 || !scan) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			// Secrets are resolved and saved in the main process from these refs; the
			// renderer never handles the imported passwords.
			const count = await window.sqlApi.importApply(scan.sourceId, picked.map((i) => i.ref));
			onImported(count);
			onClose();
		} catch (err) {
			setError(errorMessage(err));
			setBusy(false);
		}
	}

	// Step 1: pick which tool to import from.
	if (!source) {
		return (
			<div className="modal-backdrop" onClick={onClose}>
				<div className="modal" onClick={(e) => e.stopPropagation()}>
					<div className="modal-head">
						<h2>Import connections</h2>
						<span className="spacer" />
						<button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
					</div>
					<p className="muted">Choose a tool to import saved connections from. Saved usernames and passwords are imported when available; otherwise you set them after.</p>
					<div className="import-sources">
						{onFindDatabases && (
							<button type="button" className="import-source" onClick={onFindDatabases} disabled={busy} data-test="import-find-databases">
								<Icon name="search" />
								<div className="import-source-text">
									<div className="import-source-label">Find databases</div>
									<div className="muted small">Look everywhere at once: the tools below, containers, and databases running on this computer.</div>
								</div>
								<Icon name="chevron-right" />
							</button>
						)}
						{IMPORT_SOURCES.filter((s) => !s.platforms || s.platforms.includes(currentPlatform())).map((s) => (
							<button type="button" className="import-source" key={s.id} onClick={() => void chooseSource(s)} disabled={busy}>
								<Icon name="database" />
								<div className="import-source-text">
									<div className="import-source-label">{s.label}</div>
									<div className="muted small">{s.description}</div>
								</div>
								<Icon name="chevron-right" />
							</button>
						))}
					</div>
				</div>
			</div>
		);
	}

	// Step 2: the detected-connections picker.
	const items = scan?.items ?? [];
	const selectableCount = items.filter((i) => i.supported).length;
	const selectedCount = items.filter((i) => i.supported && selected.has(i.key)).length;
	const allSelected = selectableCount > 0 && selectedCount === selectableCount;

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal import-picker" onClick={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<button type="button" className="icon-btn" aria-label="Back" onClick={() => { setSource(null); setScan(null); setError(null); }}><Icon name="arrow-left" /></button>
					<h2>Import from {source.label}</h2>
					<span className="spacer" />
					<button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
				</div>

				{busy && !scan && <div className="muted pad">Scanning…</div>}

				{/* A source that could not be read for a reason the user can act on: not signed
				    in, offline, nothing there yet. Distinct from `notFound`, whose answer is
				    Browse — this one has no file to browse for, so the sentence IS the
				    screen. Showing an empty list here would read as "you have no databases",
				    which is a different and more discouraging thing to be told. */}
				{scan && scan.unavailable && (
					<div className="pad">
						<p className="muted">{scan.unavailable}</p>
					</div>
				)}

				{scan && scan.notFound && !scan.unavailable && (
					<div className="pad">
						<p className="muted">No {source.label} connections were found automatically.</p>
						<button type="button" className="secondary" onClick={() => void browse(source.id)} disabled={busy}>
							<Icon name="folder-opened" /> Browse for a config file…
						</button>
					</div>
				)}

				{scan && !scan.notFound && !scan.unavailable && (
					<>
						<div className="import-note">
							<Icon name="info" />
							<span>{source.id === 'snoutdata-cloud'
								? `These are your own hosted databases, so the username and password come with them and are kept ${keyPlace}. Each one becomes an ordinary connection: importing again later picks up a reset password without making a second copy.`
								: source.id === 'dbeaver'
									? "Usernames and passwords are imported from DBeaver when it has them saved (Community Edition). A connection protected by a DBeaver master password, or from DBeaver Enterprise, comes in without credentials, set those after import."
									: source.id === 'heidisql' || source.id === 'pgpass'
										? `Usernames and passwords are imported from ${source.label}; the passwords are kept ${keyPlace}.`
										: `Usernames are imported from ${source.label}. Passwords are not (they're kept in your OS keychain or encrypted), so set those after import.`}</span>
						</div>
						<div className="import-toolbar">
							<label className="check">
								<input
									type="checkbox"
									checked={allSelected}
									onChange={(e) => setSelected(e.target.checked ? new Set(items.filter((i) => i.supported).map((i) => i.key)) : new Set())}
								/> Select all ({selectableCount})
							</label>
							<span className="spacer" />
							{/* Nothing to browse for when the source is an API. A button that
							    opens a file dialog against a cloud account is worse than absent. */}
							{source.id !== 'snoutdata-cloud' && (
								<button type="button" className="secondary small" onClick={() => void browse(source.id)} disabled={busy} title="Import from a different config file">
									<Icon name="folder-opened" /> Browse…
								</button>
							)}
						</div>
						<div className="import-list">
							{items.map((item) => (
								<ImportRow
									key={item.key}
									item={item}
									checked={selected.has(item.key)}
									onToggle={() => toggle(item.key)}
									// For a cloud project this is not a warning: re-importing is the
									// supported way to pick up a reset password, and it writes to
									// the connection that already exists.
									duplicateLabel={source.id === 'snoutdata-cloud' ? "already imported, will update" : undefined}
								/>
							))}
						</div>
						{scan.sources.length > 0 && (
							<div className="muted small pad-x" title={scan.sources.join('\n')}>
								{source.id === 'snoutdata-cloud'
									? `Signed in as ${scan.sources[0]}.`
									: `Read from ${scan.sources.length} file${scan.sources.length === 1 ? '' : 's'}.`}
							</div>
						)}
					</>
				)}

				{error && <div className="form-status error">{error}</div>}

				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onClose} disabled={busy}><Icon name="close" /> Cancel</button>
					<button type="button" onClick={() => void importSelected(items)} disabled={busy || selectedCount === 0}>
						<Icon name="cloud-download" /> Import {selectedCount > 0 ? selectedCount : ''}
					</button>
				</div>
			</div>
		</div>
	);
}

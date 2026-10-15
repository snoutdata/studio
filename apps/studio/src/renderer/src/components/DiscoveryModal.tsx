/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { DiscoverArt } from '../art/Illustrations';
import { ImportRow } from './ImportRow';
import { DISCOVERY_SOURCE_LABELS, discoverySourceIds } from '../../../shared/forms';
import type { DiscoveryProgress, ImportScanResult, ImportSourceId } from '../../../shared/forms';
import { errorMessage } from '../errors';
import { currentPlatform } from '../platform';

// "Find your databases": the popup a fresh install opens with, and the same screen "Find
// Databases…" opens later. It asks one question (also search the local network?), runs every source
// at once in main, and shows what came back grouped by where it was found, with the import picker's
// own rows. Nothing is scanned until the user presses "Find databases".

interface DiscoveryModalProps {
	/** Closed without importing (Skip, Esc, the close button). The caller marks the popup seen. */
	onClose(): void;
	/** Connections were imported: how many. */
	onImported(count: number): void;
	/** Nothing was found and the user chose to add one by hand. */
	onAddConnection(): void;
}

type Step = 'intro' | 'scanning' | 'results';

/** The selection key of a row: sources number their items independently. */
function rowKey(sourceId: ImportSourceId, key: string): string {
	return `${sourceId}:${key}`;
}

export function DiscoveryModal({ onClose, onImported, onAddConnection }: DiscoveryModalProps): JSX.Element {
	const [step, setStep] = useState<Step>('intro');
	const [network, setNetwork] = useState(false);
	const [progress, setProgress] = useState<DiscoveryProgress[]>([]);
	const [results, setResults] = useState<ImportScanResult[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const alive = useRef(true);
	// Set true on EVERY mount, not only at creation: React's StrictMode (development) mounts,
	// unmounts and mounts again, and a ref left false by that first cleanup silently dropped every
	// answer, so the popup spun forever in `npm run dev` while the production build was fine.
	useEffect(() => {
		alive.current = true;
		return () => { alive.current = false; };
	}, []);

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

	async function find(): Promise<void> {
		setStep('scanning');
		setError(null);
		// The whole list at once, every source "looking", before main has said anything: the screen
		// is never an empty box, and each line ticks over as its source answers.
		setProgress(discoverySourceIds(currentPlatform(), network).map((sourceId) => ({ sourceId, state: 'scanning' })));
		let off = (): void => undefined;
		let timer = 0;
		try {
			// Everything inside the try, subscribing included: a failure anywhere must end on a sentence
			// and Try again, never on a list of spinners that nothing will ever stop.
			off = window.sqlApi.onDiscoverProgress((p) => {
				if (!alive.current) {
					return;
				}
				setProgress((prev) => {
					const at = prev.findIndex((x) => x.sourceId === p.sourceId);
					return at === -1 ? [...prev, p] : prev.map((x, i) => (i === at ? p : x));
				});
			});
			// Every source has its own limit in main (30 seconds at most, for the network), so no
			// answer in a minute means the run itself is not coming back.
			const ceiling = new Promise<never>((_, reject) => {
				timer = window.setTimeout(() => reject(new Error("The search did not finish within a minute.")), 60_000);
			});
			const found = await Promise.race([window.sqlApi.discoverRun({ network }), ceiling]);
			if (!alive.current) {
				return;
			}
			setResults(found);
			setSelected(new Set(found.flatMap((r) => r.items
				.filter((i) => i.supported && !i.duplicate && !i.tentative)
				.map((i) => rowKey(r.sourceId, i.key)))));
			setStep('results');
		} catch (err) {
			if (alive.current) {
				setResults([]);
				setError(errorMessage(err));
				setStep('results');
			}
		} finally {
			window.clearTimeout(timer);
			off();
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

	// What is shown: a source with rows, or with a sentence the user can act on. A source that
	// merely found nothing is not a group.
	const groups = results.filter((r) => r.items.length > 0 || r.unavailable);
	const selectedCount = results.reduce((n, r) => n + r.items.filter((i) => i.supported && selected.has(rowKey(r.sourceId, i.key))).length, 0);

	async function importSelected(): Promise<void> {
		setBusy(true);
		setError(null);
		let total = 0;
		try {
			// One apply per source, through the same `import:apply` every import uses: secrets are
			// resolved again in main from each ref and never pass through here.
			for (const r of results) {
				const refs = r.items.filter((i) => i.supported && selected.has(rowKey(r.sourceId, i.key))).map((i) => i.ref);
				if (refs.length > 0) {
					total += await window.sqlApi.importApply(r.sourceId, refs);
				}
			}
			onImported(total);
			onClose();
		} catch (err) {
			if (total > 0) {
				onImported(total);
			}
			setError(errorMessage(err));
			setBusy(false);
		}
	}

	const head = (title: string): JSX.Element => (
		<div className="modal-head">
			<h2>{title}</h2>
			<span className="spacer" />
			<button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
		</div>
	);

	if (step === 'intro') {
		return (
			<div className="modal-backdrop" onClick={onClose}>
				<div className="modal discovery" onClick={(e) => e.stopPropagation()} data-test="discovery-modal">
					{head("Find your databases")}
					<DiscoverArt className="discovery-art" />
					<p className="muted">SnoutData Studio can look on this computer for databases and for connections saved in other tools. Nothing leaves this computer.</p>
					<label className="check">
						<input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} data-test="discovery-network" />
						Also search my local network
					</label>
					<p className="field-hint">This checks the machines on your local network for open database ports. A company's security tools can flag that, so leave it off on a work network.</p>
					<div className="modal-actions">
						<span className="spacer" />
						<button type="button" className="secondary" onClick={onClose} data-test="discovery-skip"><Icon name="debug-step-over" /> Skip</button>
						<button type="button" onClick={() => void find()} autoFocus data-test="discovery-find"><Icon name="search" /> Find databases</button>
					</div>
				</div>
			</div>
		);
	}

	if (step === 'scanning') {
		const done = progress.filter((p) => p.state === 'done').length;
		const foundSoFar = progress.reduce((n, p) => n + (p.found ?? 0), 0);
		const looking = progress.find((p) => p.state === 'scanning');
		return (
			<div className="modal-backdrop">
				<div className="modal discovery" data-test="discovery-modal">
					{head("Looking for databases")}
					<div className="discovery-meter" role="progressbar" aria-valuemin={0} aria-valuemax={progress.length} aria-valuenow={done}>
						<div className="discovery-meter-fill" style={{ width: `${progress.length ? (done / progress.length) * 100 : 0}%` }} />
					</div>
					<p className="muted small discovery-status" data-test="discovery-status">
						{done} of {progress.length} checked
						{foundSoFar > 0 ? `, ${foundSoFar} found so far` : ''}
						{looking ? `. Looking at ${DISCOVERY_SOURCE_LABELS[looking.sourceId]}` : ''}
						{looking?.sourceId === 'network' ? " (this takes up to 20 seconds)" : ''}
					</p>
					<ul className="discovery-progress" data-test="discovery-progress">
						{progress.map((p) => (
							<li key={p.sourceId} className={p.state}>
								<Icon name={p.state === 'done' ? 'check' : 'loading'} className={p.state === 'done' ? undefined : 'codicon-modifier-spin'} />
								<span>{DISCOVERY_SOURCE_LABELS[p.sourceId]}</span>
								<span className="spacer" />
								<span className="muted small">{p.state === 'done' ? (p.found ? `${p.found} found` : "nothing") : "looking"}</span>
							</li>
						))}
					</ul>
					<div className="modal-actions">
						<span className="spacer" />
						<button type="button" className="secondary" onClick={onClose}><Icon name="debug-step-over" /> Skip</button>
					</div>
				</div>
			</div>
		);
	}

	if (groups.length === 0 && !error) {
		return (
			<div className="modal-backdrop" onClick={onClose}>
				<div className="modal discovery" onClick={(e) => e.stopPropagation()} data-test="discovery-modal">
					{head("No databases found")}
					<DiscoverArt className="discovery-art" />
					<p className="muted" data-test="discovery-empty">
						Nothing turned up on this computer{network ? " or your local network" : ''}. You can add a connection by hand, or look again later with Find Databases in the command palette or the Import connections screen.
					</p>
					<div className="modal-actions">
						<span className="spacer" />
						<button type="button" className="secondary" onClick={onClose}><Icon name="close" /> Close</button>
						<button type="button" onClick={onAddConnection}><Icon name="add" /> Add a connection</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="modal-backdrop">
			<div className="modal discovery import-picker" data-test="discovery-modal">
				{head(groups.length === 0 && error ? "The search did not finish" : "Databases found")}
				<div className="discovery-groups" data-test="discovery-results">
					{groups.map((r) => (
						<section className="discovery-group" key={r.sourceId} data-test={`discovery-group-${r.sourceId}`}>
							<h3>{DISCOVERY_SOURCE_LABELS[r.sourceId]}</h3>
							{r.unavailable ? (
								<p className="muted small">{r.unavailable}</p>
							) : (
								<div className="import-list">
									{r.items.map((item) => (
										<ImportRow
											key={item.key}
											item={item}
											checked={selected.has(rowKey(r.sourceId, item.key))}
											onToggle={() => toggle(rowKey(r.sourceId, item.key))}
											duplicateLabel={r.sourceId === 'snoutdata-cloud' ? "already imported, will update" : undefined}
										/>
									))}
								</div>
							)}
						</section>
					))}
				</div>
				{error && <div className="form-status error" data-test="discovery-error">{error}</div>}
				<div className="modal-actions">
					{error && !busy && <button type="button" className="secondary" onClick={() => void find()}><Icon name="refresh" /> Try again</button>}
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onClose} disabled={busy} data-test="discovery-skip"><Icon name="debug-step-over" /> Skip</button>
					<button type="button" onClick={() => void importSelected()} disabled={busy || selectedCount === 0} data-test="discovery-import">
						<Icon name="cloud-download" /> Import {selectedCount > 0 ? selectedCount : ''}
					</button>
				</div>
			</div>
		</div>
	);
}

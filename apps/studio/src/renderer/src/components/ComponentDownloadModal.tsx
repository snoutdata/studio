/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';

import type { ComponentInstallProgress, ComponentRequirement } from '../../../shared/components';
import { Icon } from './Icon';

interface ComponentDownloadModalProps {
	/** Driver being connected (e.g. 'db2'), used to drive the install. */
	driver: string;
	/** Human label for what's being connected to, shown in the prompt (e.g. "IBM Db2"). */
	driverLabel: string;
	/** What's missing + total size, from componentsRequiredFor. */
	requirement: ComponentRequirement;
	/** User cancelled or closed without installing. */
	onClose(): void;
	/** Install finished successfully — the caller retries the connect. */
	onInstalled(): void;
}

const COMPONENT_LABEL: Record<string, string> = {
	node22: 'runtime',
	db2: 'IBM Db2 client',
	hana: 'SAP HANA client',
};

const PHASE_LABEL: Record<ComponentInstallProgress['phase'], string> = {
	download: 'Downloading',
	verify: 'Verifying',
	extract: 'Extracting',
	done: 'Done',
	error: 'Failed',
};

/**
 * One-time download prompt for a native-driver component (e.g. Db2's ibm_db sidecar runtime). Shown
 * when a connect needs a component that isn't installed yet. Mirrors how DBeaver fetches driver
 * files on first use: prompt → progress → the caller retries the connect.
 */
export function ComponentDownloadModal({ driver, driverLabel, requirement, onClose, onInstalled }: ComponentDownloadModalProps): JSX.Element {
	const [stage, setStage] = useState<'prompt' | 'installing' | 'error'>('prompt');
	const [progress, setProgress] = useState<ComponentInstallProgress | null>(null);
	const [error, setError] = useState('');
	/** The vendor licences the person has switched to accepted in this prompt, by id. */
	const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
	const terms = requirement.terms ?? [];
	const allAccepted = terms.every((t) => accepted.has(t.id));

	useEffect(() => {
		// Only the prompt stage is dismissable with Escape; a download in flight shouldn't vanish.
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape' && stage !== 'installing') {
				e.preventDefault();
				onClose();
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose, stage]);

	useEffect(() => {
		return window.sqlApi.onComponentProgress((p) => setProgress(p));
	}, []);

	function toggleTerms(id: string, on: boolean): void {
		setAccepted((prev) => {
			const next = new Set(prev);
			if (on) {
				next.add(id);
			} else {
				next.delete(id);
			}
			return next;
		});
	}

	async function start(): Promise<void> {
		if (!allAccepted) {
			return;
		}
		setStage('installing');
		setError('');
		// Main refuses a vendor's file until its licence is recorded as accepted, so this goes first.
		if (terms.length > 0) {
			await window.sqlApi.componentsAcceptTerms(terms.map((t) => t.id));
		}
		const result = await window.sqlApi.componentsInstallFor(driver);
		if (result.ok) {
			onInstalled();
		} else {
			setError(result.error);
			setStage('error');
		}
	}

	const pct = progress && progress.totalBytes && progress.receivedBytes !== undefined
		? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
		: undefined;
	const phaseText = progress
		? `${PHASE_LABEL[progress.phase]} ${COMPONENT_LABEL[progress.id] ?? progress.id}${pct !== undefined && progress.phase === 'download' ? ` · ${pct}%` : '…'}`
		: 'Starting…';

	return (
		<div className="modal-backdrop" onClick={stage === 'installing' ? undefined : onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
				<div className="about-head">
					<Icon name="cloud-download" className="about-logo" />
					<div>
						<h2>Download {driverLabel} support</h2>
						<div className="about-tagline">A one-time component download</div>
					</div>
				</div>

				{stage === 'prompt' && (
					<>
						<p>
							Connecting to {driverLabel} needs a one-time download of its database client
							{requirement.supported ? <> (about <strong>{requirement.totalLabel}</strong>)</> : null}. It's
							saved on this computer, so you'll only do this once.
						</p>
						{(requirement.notices ?? []).map((notice) => (
							<p key={notice} className="field-hint">{notice}</p>
						))}
						{requirement.supported && terms.map((t) => (
							<div key={t.id} className="component-terms" data-terms={t.id}>
								<p>
									{t.vendor}'s licence applies:{' '}
									<a href={t.url} onClick={(e) => { e.preventDefault(); void window.sqlApi.openExternal(t.url); }}>{t.title}</a>
									{t.file ? <>, also in the download as <code>{t.file}</code></> : null}.
								</p>
								<label className="check">
									<input
										type="checkbox"
										checked={accepted.has(t.id)}
										onChange={(e) => toggleTerms(t.id, e.target.checked)}
									/>
									I accept {t.vendor}'s terms
								</label>
							</div>
						))}
						{requirement.supported && !allAccepted && (
							<p className="field-hint">Nothing is downloaded until you accept {terms.length === 1 ? `${terms[0].vendor}'s terms` : 'each licence'}.</p>
						)}
						{!requirement.supported && (
							<p className="form-status error">This database isn't supported on your operating system yet.</p>
						)}
						<div className="modal-actions">
							<span className="spacer" />
							<button type="button" className="secondary" onClick={onClose}><Icon name="close" /> Cancel</button>
							<button type="button" disabled={!requirement.supported || !allAccepted} onClick={() => void start()}>
								<Icon name="cloud-download" /> Download
							</button>
						</div>
					</>
				)}

				{stage === 'installing' && (
					<>
						<p>{phaseText}</p>
						<div className="progress-track">
							<div
								className="progress-fill"
								style={{ width: pct !== undefined ? `${pct}%` : '100%', opacity: pct !== undefined ? 1 : 0.5 }}
							/>
						</div>
						<div className="modal-actions">
							<span className="spacer" />
							<button type="button" disabled>Downloading…</button>
						</div>
					</>
				)}

				{stage === 'error' && (
					<>
						<p className="form-status error">{error}</p>
						<div className="modal-actions">
							<span className="spacer" />
							<button type="button" className="secondary" onClick={onClose}><Icon name="close" /> Close</button>
							<button type="button" onClick={() => void start()}><Icon name="refresh" /> Try again</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

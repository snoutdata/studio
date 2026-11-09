/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';

import type { ComponentInstallProgress, ComponentRequirement } from '../../../shared/components';
import { Icon } from './Icon';
import { useI18n, type Translate } from '../i18n';

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

function componentLabel(id: string, t: Translate): string {
	switch (id) {
		case 'node22': return t('shell.componentDownload.runtime');
		case 'db2': return t('shell.componentDownload.db2Client');
		case 'hana': return t('shell.componentDownload.hanaClient');
		default: return id;
	}
}

function phaseText(phase: ComponentInstallProgress['phase'], component: string, t: Translate): string {
	switch (phase) {
		case 'download': return t('shell.componentDownload.phaseDownload', { component });
		case 'verify': return t('shell.componentDownload.phaseVerify', { component });
		case 'extract': return t('shell.componentDownload.phaseExtract', { component });
		case 'done': return t('shell.componentDownload.phaseDone', { component });
		case 'error': return t('shell.componentDownload.phaseError', { component });
	}
}

/**
 * One-time download prompt for a native-driver component (e.g. Db2's ibm_db sidecar runtime). Shown
 * when a connect needs a component that isn't installed yet. Mirrors how DBeaver fetches driver
 * files on first use: prompt → progress → the caller retries the connect.
 */
export function ComponentDownloadModal({ driver, driverLabel, requirement, onClose, onInstalled }: ComponentDownloadModalProps): JSX.Element {
	const { t, tr } = useI18n();
	const [stage, setStage] = useState<'prompt' | 'installing' | 'error'>('prompt');
	const [progress, setProgress] = useState<ComponentInstallProgress | null>(null);
	const [error, setError] = useState('');
	/** The vendor licences the person has switched to accepted in this prompt, by id. */
	const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
	const terms = requirement.terms ?? [];
	const allAccepted = terms.every((term) => accepted.has(term.id));

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
			await window.sqlApi.componentsAcceptTerms(terms.map((term) => term.id));
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
	const statusLine = progress
		? `${phaseText(progress.phase, componentLabel(progress.id, t), t)}${pct !== undefined && progress.phase === 'download' ? ` · ${pct}%` : '…'}`
		: t('shell.componentDownload.starting');

	return (
		<div className="modal-backdrop" onClick={stage === 'installing' ? undefined : onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
				<div className="about-head">
					<Icon name="cloud-download" className="about-logo" />
					<div>
						<h2>{t('shell.componentDownload.title', { driver: driverLabel })}</h2>
						<div className="about-tagline">{t('shell.componentDownload.tagline')}</div>
					</div>
				</div>

				{stage === 'prompt' && (
					<>
						<p>
							{requirement.supported
								? tr('shell.componentDownload.neededSize', { driver: driverLabel, size: requirement.totalLabel })
								: t('shell.componentDownload.needed', { driver: driverLabel })}
						</p>
						{(requirement.notices ?? []).map((notice) => (
							<p key={notice} className="field-hint">{notice}</p>
						))}
						{requirement.supported && terms.map((term) => (
							<div key={term.id} className="component-terms" data-terms={term.id}>
								<p>
									{t('shell.componentDownload.licenceApplies', { vendor: term.vendor })}{' '}
									<a href={term.url} onClick={(e) => { e.preventDefault(); void window.sqlApi.openExternal(term.url); }}>{term.title}</a>
									{term.file ? <>{t('shell.componentDownload.alsoInDownload')} <code>{term.file}</code></> : null}.
								</p>
								<label className="check">
									<input
										type="checkbox"
										checked={accepted.has(term.id)}
										onChange={(e) => toggleTerms(term.id, e.target.checked)}
									/>
									{t('shell.componentDownload.accept', { vendor: term.vendor })}
								</label>
							</div>
						))}
						{requirement.supported && !allAccepted && (
							<p className="field-hint">{terms.length === 1 ? t('shell.componentDownload.nothingUntilVendor', { vendor: terms[0].vendor }) : t('shell.componentDownload.nothingUntilEach')}</p>
						)}
						{!requirement.supported && (
							<p className="form-status error">{t('shell.componentDownload.unsupportedOs')}</p>
						)}
						<div className="modal-actions">
							<span className="spacer" />
							<button type="button" className="secondary" onClick={onClose}><Icon name="close" /> {t('shell.common.cancel')}</button>
							<button type="button" disabled={!requirement.supported || !allAccepted} onClick={() => void start()}>
								<Icon name="cloud-download" /> {t('shell.common.download')}
							</button>
						</div>
					</>
				)}

				{stage === 'installing' && (
					<>
						<p>{statusLine}</p>
						<div className="progress-track">
							<div
								className="progress-fill"
								style={{ width: pct !== undefined ? `${pct}%` : '100%', opacity: pct !== undefined ? 1 : 0.5 }}
							/>
						</div>
						<div className="modal-actions">
							<span className="spacer" />
							<button type="button" disabled>{t('shell.componentDownload.downloading')}</button>
						</div>
					</>
				)}

				{stage === 'error' && (
					<>
						<p className="form-status error">{error}</p>
						<div className="modal-actions">
							<span className="spacer" />
							<button type="button" className="secondary" onClick={onClose}><Icon name="close" /> {t('shell.common.close')}</button>
							<button type="button" onClick={() => void start()}><Icon name="refresh" /> {t('shell.common.tryAgain')}</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../i18n';
import logoMark from '../assets/logo-mark.png';
import { AboutArt } from '../art/Illustrations';
import { secretsPlace, useSecretsWeak } from '../secretsPlace';
import { REPOSITORY_URL } from '../../../shared/officialBuild';

const REPO_URL = REPOSITORY_URL;

interface AboutModalProps {
	version: string;
	onClose(): void;
}

/** A small "About SnoutData Studio" card opened from Help → About (or the command palette). */
export function AboutModal({ version, onClose }: AboutModalProps): JSX.Element {
	const t = useT();
	const secretsWeak = useSecretsWeak();
	// Third-party licences: null while the About card shows, 'loading' while main reads the files the
	// build wrote, then their text (or false when this build has none).
	const [licences, setLicences] = useState<null | 'loading' | string | false>(null);
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				e.preventDefault();
				if (licences !== null) {
					setLicences(null);
				} else {
					onClose();
				}
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose, licences]);

	function showLicences(): void {
		setLicences('loading');
		window.sqlApi.thirdPartyLicences().then(
			({ notice, licences: list }) => {
				const parts = [notice, list].filter((text): text is string => typeof text === 'string' && text.trim() !== '');
				setLicences(parts.length > 0 ? parts.join('\n\n') : false);
			},
			() => setLicences(false),
		);
	}

	if (licences !== null) {
		return (
			<div className="modal-backdrop" onClick={onClose}>
				<div className="modal about about-licences" onClick={(e) => e.stopPropagation()}>
					<h2>{t('shell.about.thirdParty')}</h2>
					<p className="about-desc">
						{t('shell.about.thirdPartyIntro')}
					</p>
					{licences === 'loading'
						? <p className="about-desc">{t('shell.about.reading')}</p>
						: licences === false
							? <p className="about-desc">{t('shell.about.noLicenceFile')}</p>
							: <pre className="about-licences-text" tabIndex={0}>{licences}</pre>}
					<div className="modal-actions">
						<button type="button" onClick={() => setLicences(null)}><Icon name="arrow-left" /> {t('shell.common.back')}</button>
						<button type="button" onClick={onClose}><Icon name="close" /> {t('shell.common.close')}</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal about" onClick={(e) => e.stopPropagation()}>
				<AboutArt className="about-art" />
				<div className="about-head">
					<img src={logoMark} className="about-logo" alt="SnoutData Studio" />
					<div>
						<h2>SnoutData Studio</h2>
						<div className="about-tagline">{t('shell.about.tagline')}</div>
					</div>
				</div>
				<div className="about-meta">
					<div>{t('shell.about.version', { version: version || "—" })}</div>
				</div>
				<p className="about-desc">
					{t('shell.about.intro')}
				</p>
				<p className="about-desc">
					{t('shell.about.agent', { place: secretsPlace(secretsWeak) })}
				</p>
				<a
					className="about-star"
					href={REPO_URL}
					onClick={(e) => { e.preventDefault(); void window.sqlApi.openExternal(REPO_URL); }}
				>
					<Icon name="github" /> {t('shell.about.star')}
				</a>
				<div className="modal-actions">
					<button type="button" onClick={showLicences}><Icon name="law" /> {t('shell.about.thirdParty')}</button>
					<button type="button" onClick={onClose}><Icon name="close" /> {t('shell.common.close')}</button>
				</div>
			</div>
		</div>
	);
}

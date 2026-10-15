/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
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
				const parts = [notice, list].filter((t): t is string => typeof t === 'string' && t.trim() !== '');
				setLicences(parts.length > 0 ? parts.join('\n\n') : false);
			},
			() => setLicences(false),
		);
	}

	if (licences !== null) {
		return (
			<div className="modal-backdrop" onClick={onClose}>
				<div className="modal about about-licences" onClick={(e) => e.stopPropagation()}>
					<h2>Third-party licences</h2>
					<p className="about-desc">
						SnoutData Studio is built on open source software. Each package it includes is listed below with
						its licence, after Studio's own notice.
					</p>
					{licences === 'loading'
						? <p className="about-desc">Reading…</p>
						: licences === false
							? <p className="about-desc">This build carries no licence file. A build from source writes it with "npm run build".</p>
							: <pre className="about-licences-text" tabIndex={0}>{licences}</pre>}
					<div className="modal-actions">
						<button type="button" onClick={() => setLicences(null)}><Icon name="arrow-left" /> Back</button>
						<button type="button" onClick={onClose}><Icon name="close" /> Close</button>
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
						<div className="about-tagline">Your databases, your data, your projects, your agent. One app.</div>
					</div>
				</div>
				<div className="about-meta">
					<div>Version {version || "—"}</div>
				</div>
				<p className="about-desc">
					A desktop workbench for everything around your data. Query relational, document, vector
					and cloud log stores in SQL or their own language, watch them with live monitors, and see
					a schema as a map. Build data flows that pull from files, PDFs, web pages, cloud storage
					and other databases. Run SnoutData projects in your own Docker or in SnoutData Cloud, and
					move a database between any two of them.
				</p>
				<p className="about-desc">
					Bring the coding agent you already use: it works through the app and never receives your
					credentials, which stay {secretsPlace(secretsWeak)}. A model is called only where it is needed.
				</p>
				<a
					className="about-star"
					href={REPO_URL}
					onClick={(e) => { e.preventDefault(); void window.sqlApi.openExternal(REPO_URL); }}
				>
					<Icon name="github" /> Star us on GitHub
				</a>
				<div className="modal-actions">
					<button type="button" onClick={showLicences}><Icon name="law" /> Third-party licences</button>
					<button type="button" onClick={onClose}><Icon name="close" /> Close</button>
				</div>
			</div>
		</div>
	);
}

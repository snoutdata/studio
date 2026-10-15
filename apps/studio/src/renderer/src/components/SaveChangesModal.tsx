/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { Icon } from './Icon';

// Confirmation dialog for saving inline data edits: shows the generated DML (with a prod
// warning), and lets the user copy it or run it. Shared by the table-browser and the
// editable query-results grid.

interface SaveChangesModalProps {
	sql: string;
	isProd: boolean;
	saving: boolean;
	error: string | null;
	/** An advisory note shown above the preview (e.g. a non-transactional batch warning), or null. */
	note?: string | null;
	onCancel(): void;
	onRun(): void;
}

export function SaveChangesModal({ sql, isProd, saving, error, note, onCancel, onRun }: SaveChangesModalProps): JSX.Element {
	const [copied, setCopied] = useState(false);

	// Enter runs the save (matching the prod-confirm dialog), Escape cancels — both inert while
	// a save is already in flight.
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (saving) {
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				onRun();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				onCancel();
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [saving, onRun, onCancel]);

	async function copy(): Promise<void> {
		await navigator.clipboard.writeText(sql);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}

	return (
		<div className="modal-backdrop" onClick={() => !saving && onCancel()}>
			<div className="modal designer-preview" onClick={(e) => e.stopPropagation()}>
				<h3>Save data changes</h3>
				{isProd && <div className="prod-warning"><Icon name="warning" /> This is a <b>production</b> connection. Review carefully.</div>}
				{note && <div className="prod-warning"><Icon name="info" /> {note}</div>}
				<pre className="ddl-preview">{sql}</pre>
				{error && <div className="results-error">{error}</div>}
				<div className="modal-actions">
					<button type="button" className="copy" onClick={onCancel} disabled={saving}><Icon name="close" /> Cancel</button>
					<span className="spacer" />
					<button type="button" className="copy" onClick={() => void copy()} disabled={saving}>
						<Icon name={copied ? 'check' : 'copy'} /> {copied ? 'Copied' : 'Copy'}
					</button>
					<button type="button" onClick={onRun} disabled={saving}>
						<Icon name={saving ? 'loading' : 'play'} className={saving ? 'codicon-modifier-spin' : undefined} /> {saving ? 'Applying…' : 'Run'}
					</button>
				</div>
			</div>
		</div>
	);
}

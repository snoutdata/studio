/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../../shared/assistant';
import { useEffect, useState } from 'react';
import { Icon } from './Icon';

interface AiTranslateConfirmProps {
	/** Confirm the AI translation. `always` ⇒ also turn on the "always translate" setting. */
	onConfirm(always: boolean): void;
	onCancel(): void;
}

/**
 * Consent prompt before the assistant translates a SQL query the deterministic compiler can't handle
 * into a native MongoDB pipeline. Every model call spends the user's AI budget, so this
 * is never implicit. Kept small. The "always" checkbox flips the persistent setting so power users
 * who never want native pipelines stop being asked.
 */
export function AiTranslateConfirm({ onConfirm, onCancel }: AiTranslateConfirmProps): JSX.Element {
	const [always, setAlways] = useState(false);
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				onCancel();
			} else if (e.key === 'Enter') {
				onConfirm(always);
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onConfirm, onCancel, always]);

	return (
		<div className="modal-backdrop" onClick={onCancel}>
			<div className="modal confirm" onClick={(e) => e.stopPropagation()}>
				<h2><Icon name="sparkle" /> Translate with {ASSISTANT_NAME}?</h2>
				<p className="confirm-detail">
					{ASSISTANT_NAME} can turn this query into a MongoDB pipeline, which uses your AI budget. Or write it directly in the Pipeline tab.
				</p>
				<label className="confirm-always">
					<input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
					Always translate with {ASSISTANT_NAME} (don't ask again)
				</label>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onCancel} autoFocus><Icon name="close" /> Cancel</button>
					<button type="button" onClick={() => onConfirm(always)}><Icon name="sparkle" /> Translate with {ASSISTANT_NAME}</button>
				</div>
			</div>
		</div>
	);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../../shared/assistant';
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../i18n';

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
	const t = useT();
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
				<h2><Icon name="sparkle" /> {t('chat.aiTranslate.title', { assistant: ASSISTANT_NAME })}</h2>
				<p className="confirm-detail">
					{t('chat.aiTranslate.detail', { assistant: ASSISTANT_NAME })}
				</p>
				<label className="confirm-always">
					<input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
					{t('chat.aiTranslate.always', { assistant: ASSISTANT_NAME })}
				</label>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onCancel} autoFocus><Icon name="close" /> {t('chat.aiTranslate.cancel')}</button>
					<button type="button" onClick={() => onConfirm(always)}><Icon name="sparkle" /> {t('chat.aiTranslate.confirm', { assistant: ASSISTANT_NAME })}</button>
				</div>
			</div>
		</div>
	);
}

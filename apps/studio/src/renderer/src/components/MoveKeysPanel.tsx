/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../i18n';
import { ASSISTANT_NAME } from '../../../shared/assistant';
import type { MoveKeyPreview, MoveKeysResult, MoveKeysTarget } from '../../../shared/moveKeys';

/**
 * Settings, AI: the user's own provider keys, posted once to a project's AI gateway, and the
 * assistant switched to it. The keys never reach this process: main reads them and sends them. The
 * screen says where they will live, because that is not where a key kept in Studio lives.
 */
export function MoveKeysPanel({ onMoved }: { onMoved(): void }): JSX.Element | null {
	const t = useT();
	const [keys, setKeys] = useState<MoveKeyPreview[]>([]);
	const [targets, setTargets] = useState<MoveKeysTarget[] | null>(null);
	const [ref, setRef] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<MoveKeysResult | null>(null);

	useEffect(() => {
		let live = true;
		void window.sqlApi.aiMovePreview().then((preview) => {
			if (!live) {
				return;
			}
			setKeys(preview);
			if (preview.length > 0) {
				void window.sqlApi.aiMoveTargets().then((list) => {
					if (live) {
						setTargets(list);
						setRef((current) => current || list[0]?.ref || '');
					}
				}).catch(() => setTargets([]));
			}
		}).catch(() => setKeys([]));
		return () => {
			live = false;
		};
	}, []);

	if (keys.length === 0) {
		return null;
	}

	const target = targets?.find((p) => p.ref === ref);

	async function move(): Promise<void> {
		if (!target) {
			return;
		}
		setBusy(true);
		setError(null);
		setResult(null);
		try {
			const outcome = await window.sqlApi.aiMoveKeys(target.ref, target.name);
			setResult(outcome);
			if (outcome.switchTo) {
				onMoved();
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<fieldset>
			<legend>{t('settingsAi.moveKeys.legend')}</legend>
			<p className="field-hint">{t('settingsAi.moveKeys.intro', { assistant: ASSISTANT_NAME })}</p>
			<ul className="field-hint">
				{keys.map((key) => <li key={key.source}>{t('settingsAi.moveKeys.keyLine', { provider: key.label, models: key.models.join(', ') })}</li>)}
			</ul>
			{targets !== null && targets.length === 0 && <p className="field-hint">{t('settingsAi.moveKeys.noTargets')}</p>}
			{targets !== null && targets.length > 0 && (
				<label>{t('settingsAi.moveKeys.project')}
					<select value={ref} onChange={(e) => setRef(e.target.value)}>
						{targets.map((p) => <option key={p.ref} value={p.ref}>{p.local ? t('settingsAi.moveKeys.localProject', { name: p.name }) : t('settingsAi.moveKeys.cloudProject', { name: p.name })}</option>)}
					</select>
				</label>
			)}
			{target && <p className="form-status warn">{t(target.local ? 'settingsAi.moveKeys.whereLocal' : 'settingsAi.moveKeys.whereCloud', { project: target.name })}</p>}
			{target && <p className="field-hint">{t('settingsAi.moveKeys.copyStays')}</p>}
			{error && <div className="form-status error">{error}</div>}
			{result && result.moved.map((m) => <div key={m.source} className="field-hint">{t('settingsAi.moveKeys.moved', { provider: m.provider, models: m.models.join(', ') })}</div>)}
			{result && result.failed.map((f) => <div key={f.source} className="form-status error">{f.message}</div>)}
			{result && result.moved.length === 0 && result.failed.length === 0 && <div className="field-hint">{t('settingsAi.moveKeys.nothing')}</div>}
			{result?.switchTo && <div className="field-hint">{t('settingsAi.moveKeys.switched', { assistant: ASSISTANT_NAME, model: result.switchTo.model })}</div>}
			<div className="cloud-actions">
				<button type="button" disabled={busy || !target} onClick={() => void move()}><Icon name="cloud-upload" /> {busy ? t('settingsAi.moveKeys.moving') : t('settingsAi.moveKeys.move')}</button>
			</div>
		</fieldset>
	);
}

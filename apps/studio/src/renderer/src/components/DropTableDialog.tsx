/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { dropTableSql } from '../ddl';
import { useI18n } from '../i18n';

interface DropTableDialogProps {
	table: { schema?: string; name: string };
	driver: string;
	isProd: boolean;
	onDrop(sql: string): Promise<{ ok: boolean; error?: string }>;
	onClose(): void;
}

/**
 * The confirmation for dropping a table. Not `useConfirm`: that one accepts on Enter, and a drop
 * cannot be undone, so here the table's name has to be typed first. The statement shown is the
 * statement that runs.
 */
export function DropTableDialog({ table, driver, isProd, onDrop, onClose }: DropTableDialogProps): JSX.Element {
	const { t, tr } = useI18n();
	const [typed, setTyped] = useState('');
	const [applying, setApplying] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const sql = dropTableSql(table, driver);
	const confirmed = typed === table.name;

	useEffect(() => {
		const key = (event: KeyboardEvent): void => {
			if (event.key === 'Escape' && !applying) {
				onClose();
			}
		};
		window.addEventListener('keydown', key);
		return () => window.removeEventListener('keydown', key);
	}, [applying, onClose]);

	async function submit(event: FormEvent): Promise<void> {
		event.preventDefault();
		if (!confirmed || applying) {
			return;
		}
		setError(null);
		setApplying(true);
		try {
			const result = await onDrop(sql);
			if (result.ok) {
				onClose();
				return;
			}
			setError(result.error ?? t('tables.common.applyFailed'));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
		setApplying(false);
	}

	return createPortal(
		<div className="modal-backdrop" onClick={() => { if (!applying) { onClose(); } }}>
			<form className="modal designer-preview" onClick={(event) => event.stopPropagation()} onSubmit={(event) => void submit(event)}>
				<h3>{t('shell.sidebar.dropTableTitle', { name: table.name })}</h3>
				{isProd && <div className="prod-warning"><Icon name="warning" /> {tr('tables.common.prodWarning')}</div>}
				<div className="confirm-detail">{t('shell.sidebar.dropTableBody')}</div>
				<pre className="ddl-preview">{sql}</pre>
				<label>
					{t('shell.sidebar.dropTableTypeName', { name: table.name })}
					<input type="text" value={typed} onChange={(event) => setTyped(event.target.value)} disabled={applying} autoFocus autoComplete="off" spellCheck={false} />
				</label>
				{error && <div className="results-error">{error}</div>}
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onClose} disabled={applying}><Icon name="close" /> {t('shell.common.cancel')}</button>
					<button type="submit" className="danger" disabled={!confirmed || applying}>
						<Icon name={applying ? 'loading' : 'trash'} className={applying ? 'codicon-modifier-spin' : undefined} /> {applying ? t('tables.common.applying') : t('shell.sidebar.dropTable')}
					</button>
				</div>
			</form>
		</div>,
		document.body,
	);
}

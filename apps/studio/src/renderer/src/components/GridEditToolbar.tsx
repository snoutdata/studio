/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';
import { useT } from '../i18n';

// The Add row / Revert / Save bar above an editable data grid. Shared by the table-browser
// "Data" tab and the editable query-results grid so both expose the same affordances.

interface GridEditToolbarProps {
	dirty: boolean;
	saving: boolean;
	onAddRow(): void;
	onRevert(): void;
	onSave(): void;
}

export function GridEditToolbar({ dirty, saving, onAddRow, onRevert, onSave }: GridEditToolbarProps): JSX.Element {
	const t = useT();
	return (
		<div className="tv-data-toolbar">
			<button type="button" className="secondary" title={t('results.edit.addNewRow')} onClick={onAddRow}><Icon name="add" /> {t('results.edit.addRow')}</button>
			<span className="muted small">{t('results.edit.hint')}</span>
			<span className="spacer" />
			{dirty && <span className="tv-dirty">{t('results.edit.unsaved')}</span>}
			<button type="button" className="secondary" disabled={!dirty || saving} onClick={onRevert}><Icon name="discard" /> {t('editor.common.revert')}</button>
			<button type="button" disabled={!dirty || saving} onClick={onSave}><Icon name="save" /> {t('editor.common.save')}</button>
		</div>
	);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';

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
	return (
		<div className="tv-data-toolbar">
			<button type="button" className="secondary" title="Add a new row" onClick={onAddRow}><Icon name="add" /> Add row</button>
			<span className="muted small">Double-click a cell to edit · click the # to mark a row for deletion</span>
			<span className="spacer" />
			{dirty && <span className="tv-dirty">Unsaved changes</span>}
			<button type="button" className="secondary" disabled={!dirty || saving} onClick={onRevert}><Icon name="discard" /> Revert</button>
			<button type="button" disabled={!dirty || saving} onClick={onSave}><Icon name="save" /> Save</button>
		</div>
	);
}

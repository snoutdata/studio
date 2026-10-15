/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';

import { isComposite } from '../../../shared/cellValue';
import { CellValueTree } from './CellValueTree';
import { Icon } from './Icon';

// DBeaver-style value viewer/editor — opened from the grid's right-click "Edit value…"
// for long text / JSON cells where the inline input feels cramped. Commits back through
// the same useGridEditing path; `readOnly` shows it as a viewer (no Save).
//
// A value with STRUCTURE inside it (a ClickHouse Array/Map/Tuple/Nested/JSON, a Postgres array or
// jsonb, a Mongo document) opens on a TREE instead, because one line of JSON is not a thing anyone
// reads. The text is still there, on its own tab, and is still what gets edited: editing a
// structure by hand is editing text, and pretending otherwise would be a second, lossier truth.

interface CellValueEditorProps {
	columnName: string;
	value: string | null;
	readOnly?: boolean;
	/** The raw value from the driver, when the caller has it. The tree reads structure out of this
	 *  (or out of `value` when it holds JSON); without it the viewer is exactly what it was. */
	raw?: unknown;
	/** The column's declared type, which names and types the tree's nodes (`Tuple(id UInt64, …)`). */
	dataType?: string;
	/** Override the format action. Given the current text, returns the reformatted text. Defaults to a
	 *  best-effort JSON pretty-print; the Query Performance viewer passes a SQL formatter instead. */
	onFormat?(text: string): string;
	/** Label for the format button (defaults to "Format JSON"). */
	formatLabel?: string;
	onCommit(value: string): void;
	onClose(): void;
}

export function CellValueEditor({ columnName, value, readOnly = false, raw, dataType, onFormat, formatLabel, onCommit, onClose }: CellValueEditorProps): JSX.Element {
	const [text, setText] = useState(value ?? '');
	// The tree reads the driver's own value when the caller passed one, and otherwise the text,
	// which covers every caller that only ever had the string.
	const treeValue = raw !== undefined ? raw : value;
	const hasTree = isComposite(treeValue);
	const [tab, setTab] = useState<'tree' | 'text'>(hasTree ? 'tree' : 'text');

	// Reformat the text in place. Default is a best-effort JSON pretty-print (left untouched if it
	// doesn't parse); callers can pass `onFormat` to plug in another formatter (e.g. SQL).
	function reformat(): void {
		if (onFormat) {
			setText(onFormat(text));
			return;
		}
		try {
			const parsed = JSON.parse(text);
			setText(JSON.stringify(parsed, null, 2));
		} catch {
			// not JSON
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal cell-editor" onClick={(e) => e.stopPropagation()}>
				<h2>{readOnly ? "View value" : "Edit value"}: {columnName}</h2>
				{hasTree && (
					<div className="tabs cell-editor-tabs" role="tablist">
						<button type="button" role="tab" aria-selected={tab === 'tree'} className={`tab${tab === 'tree' ? ' active' : ''}`} onClick={() => setTab('tree')}>Tree</button>
						<button type="button" role="tab" aria-selected={tab === 'text'} className={`tab${tab === 'text' ? ' active' : ''}`} onClick={() => setTab('text')}>Text</button>
					</div>
				)}
				{hasTree && tab === 'tree' ? (
					<div className="cell-editor-tree">
						<CellValueTree value={treeValue} dataType={dataType} columnName={columnName} />
					</div>
				) : (
					<textarea
						className="cell-editor-text"
						autoFocus
						value={text}
						readOnly={readOnly}
						spellCheck={false}
						onChange={(e) => setText(e.target.value)}
						rows={14}
					/>
				)}
				<div className="modal-actions">
					{(!hasTree || tab === 'text') && (
						<button type="button" className="secondary" onClick={reformat} title={onFormat ? "Reformat the value" : "Try to pretty-print the value as JSON"}><Icon name="json" /> {formatLabel ?? "Format JSON"}</button>
					)}
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onClose}><Icon name="close" /> {readOnly ? "Close" : "Cancel"}</button>
					{!readOnly && <button type="button" onClick={() => { onCommit(text); onClose(); }}><Icon name="save" /> Save</button>}
				</div>
			</div>
		</div>
	);
}

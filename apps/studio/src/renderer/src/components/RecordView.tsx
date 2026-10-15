/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect } from 'react';
import { Icon } from './Icon';
import { cellText } from './DataGrid';
import { DocumentTree } from './DocumentTree';
import { isCellExpr } from '../dml';
import type { DocumentFieldEdit } from '../mongoDml';
import type { QueryField } from '../../../shared/query';

// A DBeaver-style single-record view of the results: shows one row at a time, as a vertical
// column/value list ("record"), pretty-printed JSON, or an expandable document "tree" (Compass-style,
// for nested MongoDB documents). Navigation (◀ ▶ / arrows) walks the same
// ordered, filtered row set the grid shows. Read-only — editing stays in the grid.

interface RecordViewProps {
	mode: 'record' | 'json' | 'tree';
	fields: QueryField[];
	/** The active row's values, aligned to {@link fields}. */
	row: unknown[];
	/** 0-based position of this row within {@link total}. */
	index: number;
	total: number;
	onPrev(): void;
	onNext(): void;
	/** Tree mode only: enable click-to-edit leaves + the save toolbar (document backends with an
	 *  editable result). */
	editable?: boolean;
	/** Persist the tree's nested-field edits for the active row. */
	onSaveDocument?(document: Record<string, unknown>, edits: DocumentFieldEdit[]): void;
	/** Identity of the current result (changes on a reload) — combined with the row index to reset
	 *  the tree's pending edits when the user navigates rows or the result is re-fetched. */
	resetKey?: string | number;
}

/** A cell's raw value for JSON: keep nulls/numbers/strings as-is; render edit placeholders
 *  (CellExpr) and objects through the grid's text form. */
function jsonValue(value: unknown): unknown {
	if (isCellExpr(value)) {
		return value.display;
	}
	if (value === undefined) {
		return null;
	}
	return value;
}

export function RecordView({ mode, fields, row, index, total, onPrev, onNext, editable = false, onSaveDocument, resetKey = '' }: RecordViewProps): JSX.Element {
	// Arrow up/down step between records (matching the grid's row navigation).
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'ArrowDown') { e.preventDefault(); onNext(); }
			else if (e.key === 'ArrowUp') { e.preventDefault(); onPrev(); }
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onPrev, onNext]);

	// The row as a plain object keyed by field name — shared by the JSON and tree views (each cell's
	// value is already wire-safe; nested documents/arrays arrive as real objects/arrays, not strings).
	const doc = (mode === 'json' || mode === 'tree')
		? Object.fromEntries(fields.map((f, col) => [f.name, jsonValue(row[col])]))
		: {};
	const json = mode === 'json' ? JSON.stringify(doc, null, 2) : '';

	return (
		<div className="record-view">
			<div className="record-nav">
				<button type="button" className="page-btn" title="Previous record" disabled={index <= 0} onClick={onPrev}><Icon name="chevron-left" /></button>
				<span className="record-pos">{total === 0 ? '0 of 0' : `row ${(index + 1).toLocaleString()} of ${total.toLocaleString()}`}</span>
				<button type="button" className="page-btn" title="Next record" disabled={index >= total - 1} onClick={onNext}><Icon name="chevron-right" /></button>
			</div>
			{mode === 'record' ? (
				<div className="record-body">
					{fields.map((field, col) => {
						const cur = row[col];
						const expr = isCellExpr(cur) ? cur : null;
						const text = expr ? expr.display : cellText(cur);
						return (
							<div className="record-field" key={col}>
								<span className="record-key" title={field.name}>{field.name}</span>
								<span className={`record-val${text === null ? ' null' : ''}`}>{text === null ? 'NULL' : text}</span>
							</div>
						);
					})}
				</div>
			) : mode === 'tree' ? (
				<div className="record-tree"><DocumentTree key={`${resetKey}:${index}`} document={doc} editable={editable} onSave={(edits) => onSaveDocument?.(doc, edits)} /></div>
			) : (
				<pre className="record-json">{json}</pre>
			)}
		</div>
	);
}

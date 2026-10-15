/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import { Icon } from './Icon';
import type { DocumentFieldEdit } from '../mongoDml';

// A Compass-style expandable document tree. Renders one row's value map as
// a collapsible tree: subdocuments and arrays are branches you can expand/collapse; scalars are
// leaves with a type badge. Read-only by default; when `editable` (a document backend's editable
// result), each scalar leaf is click-to-edit and the pending edits save as one `$set` per dotted
// path (`updateOne({_id},{$set:{'a.b.c':v}})`, built by mongoDml.buildDocumentUpdate). Purely
// structural typing: each node is typed from its live JS value (object/array/string/number/boolean/
// null), which is what the wire carries once the driver has made BSON values wire-safe. (Richer BSON
// typing — telling an ObjectId string from a plain string — is Tier 3, Extended-JSON.)

/** A short type label inferred from a live JS value. */
function typeLabel(value: unknown): string {
	if (value === null || value === undefined) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'array';
	}
	if (typeof value === 'object') {
		return 'object';
	}
	return typeof value; // 'string' | 'number' | 'boolean'
}

/** Render a scalar leaf value for display: strings are quoted (so `""` and whitespace are visible),
 *  everything else is its plain text form. */
function scalarText(value: unknown): string {
	if (value === null || value === undefined) {
		return 'null';
	}
	if (typeof value === 'string') {
		return `"${value}"`;
	}
	return String(value);
}

/** The raw editable text of a scalar (unquoted) — what seeds the edit input. */
function rawText(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	return String(value);
}

/** Editing controls threaded to every node (undefined ⇒ read-only tree). */
interface EditControls {
	/** path → the raw text the user has entered for that leaf. */
	edits: Map<string, string>;
	/** The leaf currently open in an input, with its live draft text. */
	active: { path: string; draft: string } | null;
	begin(path: string, seed: string): void;
	setDraft(draft: string): void;
	commit(): void;
	cancel(): void;
}

interface NodeProps {
	/** The field name (or array index) at this position. */
	name: string;
	/** The dotted `$set` path to this node (`user.address.city`, `items.0.sku`). */
	path: string;
	value: unknown;
	depth: number;
	/** Expand this node's children on first render (used to open the top level by default). */
	defaultOpen: boolean;
	edit?: EditControls;
}

function TreeNode({ name, path, value, depth, defaultOpen, edit }: NodeProps): JSX.Element {
	const isContainer = value !== null && typeof value === 'object';
	const [open, setOpen] = useState(defaultOpen);
	const type = typeLabel(value);
	const indent = { paddingLeft: depth * 14 + 8 };

	if (!isContainer) {
		// `_id` is the filter key for the write, so it's never editable here.
		const canEdit = Boolean(edit) && path !== '_id';
		const isActive = edit?.active?.path === path;
		const edited = edit?.edits.has(path) ?? false;
		const editedText = edit?.edits.get(path);
		return (
			<div className="doc-node doc-leaf" style={indent}>
				<span className="doc-twisty" />
				<span className="doc-key" title={name}>{name}</span>
				{isActive ? (
					<input
						className="doc-edit-input"
						autoFocus
						value={edit!.active!.draft}
						onChange={(e) => edit!.setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') { e.preventDefault(); edit!.commit(); }
							else if (e.key === 'Escape') { e.preventDefault(); edit!.cancel(); }
						}}
						onBlur={() => edit!.commit()}
					/>
				) : (
					<span
						className={`doc-val${edited ? ' edited' : ''}${value === null && !edited ? ' null' : ''}${canEdit ? ' editable' : ''}`}
						title={canEdit ? 'Click to edit' : undefined}
						onClick={canEdit ? () => edit!.begin(path, edited ? editedText! : rawText(value)) : undefined}
					>
						{edited ? editedText : scalarText(value)}
					</span>
				)}
				<span className="doc-type">{type}</span>
			</div>
		);
	}

	const entries: [string, unknown, string][] = Array.isArray(value)
		? value.map((v, i) => [String(i), v, `${path}.${i}`])
		: Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, v, `${path}.${k}`]);
	const summary = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;

	return (
		<>
			<div className="doc-node doc-branch" style={indent} onClick={() => setOpen((o) => !o)}>
				<span className="doc-twisty"><Icon name={open ? 'chevron-down' : 'chevron-right'} /></span>
				<span className="doc-key" title={name}>{name}</span>
				<span className="doc-summary">{summary}</span>
				<span className="doc-type">{type}</span>
			</div>
			{open && (entries.length === 0
				? <div className="doc-node doc-leaf doc-empty" style={{ paddingLeft: (depth + 1) * 14 + 8 }}><span className="doc-twisty" /><span className="doc-val null">{Array.isArray(value) ? 'empty array' : 'empty object'}</span></div>
				: entries.map(([k, v, p]) => <TreeNode key={k} name={k} path={p} value={v} depth={depth + 1} defaultOpen={depth === 0} edit={edit} />))}
		</>
	);
}

interface DocumentTreeProps {
	document: Record<string, unknown>;
	/** Enable click-to-edit on scalar leaves + the save/revert toolbar. */
	editable?: boolean;
	/** Persist the collected leaf edits (one `$set` per path). Called from the toolbar's Save. */
	onSave?(edits: DocumentFieldEdit[]): void;
}

/** The document tree for one row: its top-level fields are always shown (and any object/array among
 *  them starts expanded); deeper nesting is collapsed until clicked. When `editable`, scalar leaves
 *  are click-to-edit and a toolbar saves/reverts the pending edits. */
export function DocumentTree({ document, editable = false, onSave }: DocumentTreeProps): JSX.Element {
	const [edits, setEdits] = useState<Map<string, string>>(new Map());
	const [active, setActive] = useState<{ path: string; draft: string } | null>(null);

	const controls: EditControls | undefined = editable ? {
		edits,
		active,
		begin: (path, seed) => setActive({ path, draft: seed }),
		setDraft: (draft) => setActive((a) => (a ? { ...a, draft } : a)),
		// `active` is the current state at call time (controls are rebuilt each render), so folding it
		// into edits here is correct without a nested state updater.
		commit: () => {
			if (active) {
				setEdits((prev) => new Map(prev).set(active.path, active.draft));
			}
			setActive(null);
		},
		cancel: () => setActive(null),
	} : undefined;

	// The edits to persist, folding any leaf still open in the input (so clicking Save while a field
	// is mid-edit doesn't drop it to a state-update race).
	function pendingEdits(): DocumentFieldEdit[] {
		const merged = new Map(edits);
		if (active) {
			merged.set(active.path, active.draft);
		}
		return [...merged].map(([path, value]) => ({ path, value }));
	}
	const dirty = edits.size > 0 || active !== null;

	const entries = Object.entries(document);
	if (entries.length === 0) {
		return <div className="doc-tree doc-empty-doc">This document has no fields.</div>;
	}
	return (
		<div className="doc-tree">
			{editable && (
				<div className="doc-tree-toolbar">
					<button type="button" disabled={!dirty} onClick={() => onSave?.(pendingEdits())}>
						<Icon name="save" /> Save…
					</button>
					<button type="button" className="secondary" disabled={!dirty} onClick={() => { setEdits(new Map()); setActive(null); }}>
						<Icon name="discard" /> Revert
					</button>
					{edits.size > 0 && <span className="doc-dirty">{edits.size} field{edits.size === 1 ? '' : 's'} edited</span>}
				</div>
			)}
			{entries.map(([k, v]) => <TreeNode key={k} name={k} path={k} value={v} depth={0} defaultOpen={true} edit={controls} />)}
		</div>
	);
}

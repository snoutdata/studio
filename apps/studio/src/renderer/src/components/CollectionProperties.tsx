/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { describeMongoDdl, type MongoDdl } from '../../../shared/engine';
import type { TableInfo } from '../../../shared/schema';

// The document-backend analog of TableProperties. A MongoDB collection is
// schemaless, so there's no column designer / ALTER path: this panel shows the inferred fields
// read-only and offers the structure operations Mongo actually has — create/drop a secondary index
// and drop the collection. Each action confirms with the shell command it will run (describeMongoDdl)
// before issuing it through the same guarded `runMongoDdl` path used elsewhere.
type Section = 'fields' | 'indexes';

const SECTIONS: { id: Section; label: string; icon: string }[] = [
	{ id: 'fields', label: 'Fields', icon: 'symbol-field' },
	{ id: 'indexes', label: 'Indexes', icon: 'list-ordered' },
];

interface CollectionPropertiesProps {
	connectionId: string;
	isProd: boolean;
	/** Connection is flagged read-only — hides every structure-mutating affordance. */
	readOnly: boolean;
	base: TableInfo;
	runMongoDdl(connectionId: string, ops: MongoDdl[]): Promise<{ ok: boolean; error?: string }>;
	/** Re-introspected collection adopted after a create/drop index. */
	onPersisted(table: TableInfo): void;
	/** The collection was dropped — close the tab. */
	onDropped(): void;
}

/** A default index name from the chosen fields, e.g. `email_status_idx` (Mongo auto-names when
 *  omitted, but a readable name makes the index list and the drop action clearer). */
function suggestIndexName(fields: string[]): string {
	const parts = fields.map((s) => s.replace(/[^A-Za-z0-9_]/g, '')).filter((s) => s !== '');
	return `${parts.join('_').slice(0, 60)}_idx`;
}

export function CollectionProperties({ connectionId, isProd, readOnly, base, runMongoDdl, onPersisted, onDropped }: CollectionPropertiesProps): JSX.Element {
	const [section, setSection] = useState<Section>('fields');
	// A structure op awaiting confirmation: its title, the ops to run, and whether it drops the
	// whole collection (so apply closes the tab instead of re-seeding it).
	const [preview, setPreview] = useState<{ title: string; ops: MongoDdl[]; drops?: boolean } | null>(null);
	const [applying, setApplying] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// "Add index" form.
	const [addingIndex, setAddingIndex] = useState(false);
	const [idxName, setIdxName] = useState('');
	const [idxUnique, setIdxUnique] = useState(false);
	const [idxFields, setIdxFields] = useState<string[]>([]);
	// Free-text field entry: a new/empty collection has no sampled fields to tick, and you may want
	// to index a field that isn't in the sample, so the index can always be built by typing a name.
	const [idxFieldInput, setIdxFieldInput] = useState('');

	function resetIndexForm(): void {
		setAddingIndex(false);
		setIdxName('');
		setIdxUnique(false);
		setIdxFields([]);
		setIdxFieldInput('');
	}

	/** Add a typed field name to the index (trimmed, de-duplicated); clears the input. */
	function addIdxField(name: string): void {
		const field = name.trim();
		if (field && !idxFields.includes(field)) {
			setIdxFields((prev) => [...prev, field]);
		}
		setIdxFieldInput('');
	}

	function toggleIdxField(name: string): void {
		setIdxFields((prev) => prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]);
	}

	// Clear any in-flight form/preview when the persisted collection changes (e.g. after our own
	// apply re-introspects, or the user opens a different collection on the same tab).
	useEffect(() => {
		setPreview(null);
		setError(null);
		resetIndexForm();
	}, [base]);

	async function apply(): Promise<void> {
		if (!preview) {
			return;
		}
		setApplying(true);
		setError(null);
		const result = await runMongoDdl(connectionId, preview.ops);
		if (!result.ok) {
			setApplying(false);
			setError(result.error ?? 'Failed to apply changes.');
			return;
		}
		if (preview.drops) {
			setApplying(false);
			setPreview(null);
			onDropped();
			return;
		}
		const fresh = await window.sqlApi.getSchema(connectionId);
		const found = fresh?.tables.find((t) => t.name === base.name) ?? null;
		setApplying(false);
		setPreview(null);
		resetIndexForm();
		if (found) {
			onPersisted(found);
		}
	}

	const indexes = base.indexes ?? [];

	return (
		<div className="properties">
			<div className="prop-header">
				<label>Collection
					<input type="text" value={base.name} readOnly />
				</label>
				<label>Documents sampled
					<input type="text" value={`${base.columns.length} fields inferred`} readOnly />
				</label>
			</div>

			<div className="prop-body">
				<div className="prop-nav">
					{SECTIONS.map((s) => (
						<div
							key={s.id}
							className={`prop-nav-item${section === s.id ? ' active' : ''}`}
							onClick={() => setSection(s.id)}
						>
							<Icon name={s.icon} /> {s.label}
						</div>
					))}
				</div>

				<div className="prop-section">
					{section === 'fields' && (
						base.columns.length === 0
							? <div className="prop-empty">No fields inferred (the collection is empty or unsampled).</div>
							: (
								<div className="prop-table">
									<div className="pt-row pt-head"><span>Field</span><span>Type</span><span>Nullable</span></div>
									{base.columns.map((c) => (
										<div className="pt-row" key={c.name}>
											<span>{c.isPrimaryKey ? <><Icon name="key" /> {c.name}</> : c.name}</span>
											<span>{c.dataType}</span>
											<span>{c.nullable ? 'yes' : 'no'}</span>
										</div>
									))}
								</div>
							)
					)}

					{section === 'indexes' && (
						<div className="prop-index">
							{indexes.length > 0 && (
								<div className="prop-table">
									<div className="pt-row pt-head"><span>Name</span><span>Unique</span><span>Fields</span><span className="pt-actions" /></div>
									{indexes.map((ix) => (
										<div className="pt-row" key={ix.name}>
											<span>{ix.name}</span>
											<span>{ix.unique ? 'UNIQUE' : ''}</span>
											<span>{ix.columns.join(', ')}</span>
											<span className="pt-actions">
												{!readOnly && (
													<button type="button" className="icon-btn" aria-label="Drop index" onClick={() => { setError(null); setPreview({ title: 'Drop index', ops: [{ op: 'dropIndex', collection: base.name, name: ix.name }] }); }}><Icon name="trash" /></button>
												)}
											</span>
										</div>
									))}
								</div>
							)}
							{indexes.length === 0 && !addingIndex && <div className="prop-empty">No secondary indexes. The <code>_id</code> field is always indexed.</div>}

							{!readOnly && (addingIndex ? (
								<div className="index-form">
									<label>Index name<input type="text" value={idxName} placeholder={suggestIndexName(idxFields)} onChange={(e) => setIdxName(e.target.value)} /></label>
									<label className="check"><input type="checkbox" checked={idxUnique} onChange={(e) => setIdxUnique(e.target.checked)} /> Unique</label>
									<label>Fields to index
										<span className="index-add-field">
											<input type="text" value={idxFieldInput} placeholder="field name (e.g. email or address.city)" onChange={(e) => setIdxFieldInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addIdxField(idxFieldInput); } }} />
											<button type="button" className="secondary" disabled={idxFieldInput.trim() === ''} onClick={() => addIdxField(idxFieldInput)}><Icon name="add" /> Add</button>
										</span>
									</label>
									{idxFields.length > 0 && (
										<div className="index-chosen">
											{idxFields.map((f) => (
												<span className="index-chip" key={f}>{f}<button type="button" className="icon-btn" aria-label="Remove field" onClick={() => toggleIdxField(f)}><Icon name="close" /></button></span>
											))}
										</div>
									)}
									{base.columns.filter((c) => c.name !== '_id').length > 0 && (
										<div className="index-cols">
											{base.columns.filter((c) => c.name !== '_id').map((c) => (
												<label className="check" key={c.name}>
													<input type="checkbox" checked={idxFields.includes(c.name)} onChange={() => toggleIdxField(c.name)} />
													{c.name}
												</label>
											))}
										</div>
									)}
									<div className="index-form-actions">
										<button type="button" className="copy" onClick={resetIndexForm}><Icon name="close" /> Cancel</button>
										<button type="button" disabled={idxFields.length === 0} onClick={() => {
											const name = idxName.trim() || suggestIndexName(idxFields);
											const keys: Record<string, 1 | -1> = {};
											for (const f of idxFields) {
												keys[f] = 1;
											}
											setError(null);
											setPreview({ title: 'Create index', ops: [{ op: 'createIndex', collection: base.name, name, keys, unique: idxUnique }] });
										}}><Icon name="add" /> Create index</button>
									</div>
								</div>
							) : (
								<div className="dg-add"><button type="button" className="secondary" onClick={() => setAddingIndex(true)}><Icon name="add" /> Add index</button></div>
							))}
						</div>
					)}
				</div>
			</div>

			<div className="prop-footer">
				<span className="muted">MongoDB collection</span>
				<span className="spacer" />
				{!readOnly && (
					<button type="button" className="danger" onClick={() => { setError(null); setPreview({ title: 'Drop collection', ops: [{ op: 'dropCollection', collection: base.name }], drops: true }); }}>
						<Icon name="trash" /> Drop collection
					</button>
				)}
			</div>

			{preview !== null && (
				<div className="modal-backdrop" onClick={() => !applying && setPreview(null)}>
					<div className="modal designer-preview" onClick={(e) => e.stopPropagation()}>
						<h3>{preview.title}</h3>
						{isProd && <div className="prod-warning"><Icon name="warning" /> This is a <b>production</b> connection. Review carefully.</div>}
						<pre className="ddl-preview">{preview.ops.map(describeMongoDdl).join('\n')}</pre>
						{error && <div className="results-error">{error}</div>}
						<div className="modal-actions">
							<button type="button" className="copy" onClick={() => setPreview(null)} disabled={applying}><Icon name="close" /> Cancel</button>
							<button type="button" onClick={() => void apply()} disabled={applying}>
								<Icon name={applying ? 'loading' : 'play'} className={applying ? 'codicon-modifier-spin' : undefined} /> {applying ? 'Applying…' : 'Run'}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

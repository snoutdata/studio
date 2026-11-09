/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { describeMongoDdl, type MongoDdl } from '../../../shared/engine';
import type { TableInfo } from '../../../shared/schema';
import { useI18n } from '../i18n';

// The document-backend analog of TableProperties. A MongoDB collection is
// schemaless, so there's no column designer / ALTER path: this panel shows the inferred fields
// read-only and offers the structure operations Mongo actually has — create/drop a secondary index
// and drop the collection. Each action confirms with the shell command it will run (describeMongoDdl)
// before issuing it through the same guarded `runMongoDdl` path used elsewhere.
type Section = 'fields' | 'indexes';

const SECTIONS: { id: Section; labelKey: string; icon: string }[] = [
	{ id: 'fields', labelKey: 'tables.coll.fields', icon: 'symbol-field' },
	{ id: 'indexes', labelKey: 'tables.coll.indexes', icon: 'list-ordered' },
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
	const { t, tr } = useI18n();
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
			setError(result.error ?? t('tables.common.applyFailed'));
			return;
		}
		if (preview.drops) {
			setApplying(false);
			setPreview(null);
			onDropped();
			return;
		}
		const fresh = await window.sqlApi.getSchema(connectionId);
		const found = fresh?.tables.find((candidate) => candidate.name === base.name) ?? null;
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
				<label>{t('tables.coll.collection')}
					<input type="text" value={base.name} readOnly />
				</label>
				<label>{t('tables.coll.sampled')}
					<input type="text" value={t('tables.coll.inferred', { count: String(base.columns.length) })} readOnly />
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
							<Icon name={s.icon} /> {t(s.labelKey)}
						</div>
					))}
				</div>

				<div className="prop-section">
					{section === 'fields' && (
						base.columns.length === 0
							? <div className="prop-empty">{t('tables.coll.noFields')}</div>
							: (
								<div className="prop-table">
									<div className="pt-row pt-head"><span>{t('tables.coll.field')}</span><span>{t('tables.common.type')}</span><span>{t('tables.coll.nullable')}</span></div>
									{base.columns.map((c) => (
										<div className="pt-row" key={c.name}>
											<span>{c.isPrimaryKey ? <><Icon name="key" /> {c.name}</> : c.name}</span>
											<span>{c.dataType}</span>
											<span>{c.nullable ? t('tables.coll.yes') : t('tables.coll.no')}</span>
										</div>
									))}
								</div>
							)
					)}

					{section === 'indexes' && (
						<div className="prop-index">
							{indexes.length > 0 && (
								<div className="prop-table">
									<div className="pt-row pt-head"><span>{t('tables.common.name')}</span><span>{t('tables.common.unique')}</span><span>{t('tables.coll.fields')}</span><span className="pt-actions" /></div>
									{indexes.map((ix) => (
										<div className="pt-row" key={ix.name}>
											<span>{ix.name}</span>
											<span>{ix.unique ? 'UNIQUE' : ''}</span>
											<span>{ix.columns.join(', ')}</span>
											<span className="pt-actions">
												{!readOnly && (
													<button type="button" className="icon-btn" aria-label={t('tables.common.dropIndex')} onClick={() => { setError(null); setPreview({ title: t('tables.common.dropIndex'), ops: [{ op: 'dropIndex', collection: base.name, name: ix.name }] }); }}><Icon name="trash" /></button>
												)}
											</span>
										</div>
									))}
								</div>
							)}
							{indexes.length === 0 && !addingIndex && <div className="prop-empty">{tr('tables.coll.noSecondary')}</div>}

							{!readOnly && (addingIndex ? (
								<div className="index-form">
									<label>{t('tables.common.indexName')}<input type="text" value={idxName} placeholder={suggestIndexName(idxFields)} onChange={(e) => setIdxName(e.target.value)} /></label>
									<label className="check"><input type="checkbox" checked={idxUnique} onChange={(e) => setIdxUnique(e.target.checked)} /> {t('tables.common.unique')}</label>
									<label>{t('tables.coll.fieldsToIndex')}
										<span className="index-add-field">
											<input type="text" value={idxFieldInput} placeholder={t('tables.coll.fieldPlaceholder')} onChange={(e) => setIdxFieldInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addIdxField(idxFieldInput); } }} />
											<button type="button" className="secondary" disabled={idxFieldInput.trim() === ''} onClick={() => addIdxField(idxFieldInput)}><Icon name="add" /> {t('tables.coll.add')}</button>
										</span>
									</label>
									{idxFields.length > 0 && (
										<div className="index-chosen">
											{idxFields.map((f) => (
												<span className="index-chip" key={f}>{f}<button type="button" className="icon-btn" aria-label={t('tables.coll.removeField')} onClick={() => toggleIdxField(f)}><Icon name="close" /></button></span>
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
										<button type="button" className="copy" onClick={resetIndexForm}><Icon name="close" /> {t('editor.common.cancel')}</button>
										<button type="button" disabled={idxFields.length === 0} onClick={() => {
											const name = idxName.trim() || suggestIndexName(idxFields);
											const keys: Record<string, 1 | -1> = {};
											for (const f of idxFields) {
												keys[f] = 1;
											}
											setError(null);
											setPreview({ title: t('tables.common.createIndex'), ops: [{ op: 'createIndex', collection: base.name, name, keys, unique: idxUnique }] });
										}}><Icon name="add" /> {t('tables.common.createIndex')}</button>
									</div>
								</div>
							) : (
								<div className="dg-add"><button type="button" className="secondary" onClick={() => setAddingIndex(true)}><Icon name="add" /> {t('tables.common.addIndex')}</button></div>
							))}
						</div>
					)}
				</div>
			</div>

			<div className="prop-footer">
				<span className="muted">{t('tables.coll.mongoCollection')}</span>
				<span className="spacer" />
				{!readOnly && (
					<button type="button" className="danger" onClick={() => { setError(null); setPreview({ title: t('tables.coll.dropCollection'), ops: [{ op: 'dropCollection', collection: base.name }], drops: true }); }}>
						<Icon name="trash" /> {t('tables.coll.dropCollection')}
					</button>
				)}
			</div>

			{preview !== null && (
				<div className="modal-backdrop" onClick={() => !applying && setPreview(null)}>
					<div className="modal designer-preview" onClick={(e) => e.stopPropagation()}>
						<h3>{preview.title}</h3>
						{isProd && <div className="prod-warning"><Icon name="warning" /> {tr('tables.common.prodWarning')}</div>}
						<pre className="ddl-preview">{preview.ops.map(describeMongoDdl).join('\n')}</pre>
						{error && <div className="results-error">{error}</div>}
						<div className="modal-actions">
							<button type="button" className="copy" onClick={() => setPreview(null)} disabled={applying}><Icon name="close" /> {t('editor.common.cancel')}</button>
							<button type="button" onClick={() => void apply()} disabled={applying}>
								<Icon name={applying ? 'loading' : 'play'} className={applying ? 'codicon-modifier-spin' : undefined} /> {applying ? t('tables.common.applying') : t('editor.common.run')}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

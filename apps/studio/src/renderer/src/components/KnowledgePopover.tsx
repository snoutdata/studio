/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { GLOBAL_CONNECTION, type KnowledgeNote } from '../../../shared/knowledge';

/**
 * The in-chat "🧠 Knows N things about this database" popover: the discoverable, plain-language home
 * for what the assistant remembers. No scope/glossary jargon — just sentences the user can toggle,
 * delete, or teach. Shows the background observer's `suggested` notes at the top (Remember /
 * dismiss). Globals (facts that apply to every database) are folded in and flagged. The fuller
 * manager still lives in Settings → Knowledge.
 */
export function KnowledgePopover(props: {
	connectionId: string;
	connectionLabel: string;
	onClose(): void;
	onChanged(): void;
}): JSX.Element {
	const [items, setItems] = useState<KnowledgeNote[] | null>(null);
	const [draft, setDraft] = useState('');
	const [everywhere, setEverywhere] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	async function load(): Promise<void> {
		const [own, global] = await Promise.all([
			window.sqlApi.knowledgeNotes(props.connectionId),
			window.sqlApi.knowledgeNotes(GLOBAL_CONNECTION),
		]);
		// Globals last; both are already newest-first from the store.
		setItems([...own, ...global.filter((n) => n.connectionId === GLOBAL_CONNECTION)]);
	}

	useEffect(() => {
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.connectionId]);

	// Close on an outside click or Escape (dropdown convention).
	useEffect(() => {
		function onDown(e: MouseEvent): void {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				props.onClose();
			}
		}
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				props.onClose();
			}
		}
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function after(op: Promise<unknown>): Promise<void> {
		await op;
		await load();
		props.onChanged();
	}

	async function add(): Promise<void> {
		const text = draft.trim();
		if (!text) {
			return;
		}
		const now = Date.now();
		setDraft('');
		const wasEverywhere = everywhere;
		setEverywhere(false);
		await after(window.sqlApi.saveKnowledgeNote({
			id: crypto.randomUUID(),
			connectionId: wasEverywhere ? GLOBAL_CONNECTION : props.connectionId,
			scope: 'glossary',
			text,
			enabled: true,
			status: 'active',
			source: 'manual',
			createdAt: now,
			updatedAt: now,
		}));
	}

	const suggested = (items ?? []).filter((n) => n.status === 'suggested');
	const active = (items ?? []).filter((n) => (n.status ?? 'active') === 'active');

	return (
		<div className="chat-knows-popover" ref={rootRef}>
			<div className="chat-knows-head">
				<span><Icon name="lightbulb" /> What I know about “{props.connectionLabel}”</span>
				<button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}><Icon name="close" /></button>
			</div>

			{items === null ? (
				<div className="muted small chat-knows-empty">Loading…</div>
			) : (
				<div className="chat-knows-body">
					{suggested.length > 0 && (
						<div className="chat-knows-suggested">
							{suggested.map((n) => (
								<div className="knowledge-item suggested" key={n.id}>
									<div className="knowledge-item-body">
										<div className="knowledge-item-text">{n.text}</div>
										<div className="knowledge-item-meta muted small">Suggested from your chat</div>
									</div>
									<div className="knowledge-item-actions">
										<button type="button" title="Remember this" onClick={() => void after(window.sqlApi.approveKnowledgeNote(n.id))}><Icon name="check" /> Remember</button>
										<button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => void after(window.sqlApi.dismissKnowledgeNote(n.id))}><Icon name="close" /></button>
									</div>
								</div>
							))}
						</div>
					)}

					{active.length === 0 && suggested.length === 0 && (
						<div className="muted small chat-knows-empty">Nothing yet. Teach me a fact about this database (like “sales live in <code>customer_order</code>, <code>fulfilled_date</code> is the sale date”) and I'll remember it so you don't have to repeat it.</div>
					)}

					{active.map((n) => (
						<div className={`knowledge-item${n.enabled ? '' : ' disabled'}`} key={n.id}>
							<label className="knowledge-item-toggle" title={n.enabled ? 'On, I use this' : 'Off, kept but not used'}>
								<input type="checkbox" checked={n.enabled} onChange={() => void after(window.sqlApi.setKnowledgeNoteEnabled(n.id, !n.enabled))} />
							</label>
							<div className="knowledge-item-body">
								<div className="knowledge-item-text">{n.text}</div>
								{n.connectionId === GLOBAL_CONNECTION && <div className="knowledge-item-meta muted small"><span className="knowledge-badge">every database</span></div>}
							</div>
							<div className="knowledge-item-actions">
								<button type="button" className="icon-btn" aria-label="Delete" onClick={() => void after(window.sqlApi.deleteKnowledgeNote(n.id))}><Icon name="trash" /></button>
							</div>
						</div>
					))}

					<div className="chat-knows-add">
						<textarea
							value={draft}
							placeholder="Teach it something about this database…"
							rows={2}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void add(); } }}
						/>
						<div className="chat-knows-add-row">
							<label className="muted small" title="Apply this to every connection, not just this one">
								<input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} /> Applies to every database
							</label>
							<button type="button" disabled={!draft.trim()} onClick={() => void add()}><Icon name="mortar-board" /> Teach it</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

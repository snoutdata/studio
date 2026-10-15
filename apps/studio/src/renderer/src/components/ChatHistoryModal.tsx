/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import type { ChatSession } from '../../../shared/chat';

interface ChatHistoryModalProps {
	/** Highlight the session currently open in the panel. */
	currentId: string | undefined;
	onLoad(session: ChatSession): void;
	onClose(): void;
}

function relativeTime(ts: number): string {
	const seconds = Math.round((Date.now() - ts) / 1000);
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	return `${Math.round(hours / 24)}d ago`;
}

/** A modal listing saved chat sessions — click one to reopen it in the panel. */
export function ChatHistoryModal({ currentId, onLoad, onClose }: ChatHistoryModalProps): JSX.Element {
	const PAGE_SIZE = 25;
	const [sessions, setSessions] = useState<ChatSession[]>([]);
	const [query, setQuery] = useState('');
	const [page, setPage] = useState(0);
	const [confirm, confirmDialog] = useConfirm();

	function refresh(): void {
		void window.sqlApi.chatSessions().then(setSessions);
	}

	useEffect(() => {
		refresh();
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				e.preventDefault();
				onClose();
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);

	// Any filter change resets to the first page so the view never lands on an empty page.
	useEffect(() => { setPage(0); }, [query]);

	async function remove(id: string): Promise<void> {
		if (!(await confirm({ title: "Delete this chat?", body: "This cannot be undone.", confirmLabel: "Delete", danger: true }))) {
			return;
		}
		await window.sqlApi.deleteChatSession(id);
		refresh();
	}

	async function clearAll(): Promise<void> {
		if (!(await confirm({ title: "Delete all chat history?", body: `All ${sessions.length} saved chat${sessions.length === 1 ? '' : 's'} will be removed. This cannot be undone.`, confirmLabel: "Delete all", danger: true }))) {
			return;
		}
		await window.sqlApi.clearChatSessions();
		refresh();
	}

	const q = query.trim().toLowerCase();
	const filtered = sessions.filter((s) => {
		if (!q) {
			return true;
		}
		const hay = `${s.title} ${s.connectionLabel ?? ''} ${s.messages.map((m) => m.content).join(' ')}`.toLowerCase();
		return hay.includes(q);
	});
	const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	const clampedPage = Math.min(page, pageCount - 1);
	const pageSessions = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);
	const rangeStart = filtered.length === 0 ? 0 : clampedPage * PAGE_SIZE + 1;
	const rangeEnd = clampedPage * PAGE_SIZE + pageSessions.length;

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal chat-history" onClick={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<h2>Chat history</h2>
					<span className="spacer" />
					{sessions.length > 0 && (
						<button type="button" className="icon-btn" aria-label="Clear all" onClick={() => void clearAll()}><Icon name="clear-all" /></button>
					)}
					<button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
				</div>
				{sessions.length > 0 && (
					<div className="audit-filter">
						<input className="audit-search" value={query} placeholder="Search title, connection, or message text…" onChange={(e) => setQuery(e.target.value)} />
						<span className="spacer" />
						{q && <span className="muted small">{filtered.length} match{filtered.length === 1 ? '' : 'es'}</span>}
					</div>
				)}
				<div className="chat-history-list">
					{sessions.length === 0 && <div className="muted pad">No saved chats yet.</div>}
					{sessions.length > 0 && filtered.length === 0 && <div className="muted pad">No chats match the filter.</div>}
					{pageSessions.map((session) => (
						<div
							className={`chat-history-row${session.id === currentId ? ' current' : ''}`}
							key={session.id}
							onClick={() => onLoad(session)}
						>
							<div className="chat-history-title">{session.title || "Untitled chat"}</div>
							<div className="chat-history-meta">
								{session.connectionLabel && <span>{session.connectionLabel}</span>}
								<span className="muted">{relativeTime(session.updatedAt)}</span>
								<span className="muted">{session.messages.length} msgs</span>
								{session.tokens.totalTokens > 0 && <span className="muted">{session.tokens.totalTokens.toLocaleString()} tok</span>}
								<span className="spacer" />
								<button
									type="button"
									className="icon-btn"
									aria-label="Delete"
									onClick={(e) => { e.stopPropagation(); void remove(session.id); }}
								><Icon name="trash" /></button>
							</div>
						</div>
					))}
				</div>
				{pageCount > 1 && (
					<div className="audit-pager">
						<button type="button" className="secondary small" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}><Icon name="chevron-left" /> Prev</button>
						<span className="muted small">{rangeStart}-{rangeEnd} of {filtered.length}</span>
						<button type="button" className="secondary small" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)}>Next <Icon name="chevron-right" /></button>
					</div>
				)}
			</div>
			{confirmDialog}
		</div>
	);
}

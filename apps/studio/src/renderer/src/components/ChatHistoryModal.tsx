/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { formatLocale, useT, type Translate } from '../i18n';
import { useConfirm } from './ConfirmDialog';
import type { ChatSession } from '../../../shared/chat';

interface ChatHistoryModalProps {
	/** Highlight the session currently open in the panel. */
	currentId: string | undefined;
	onLoad(session: ChatSession): void;
	onClose(): void;
}

function relativeTime(ts: number, t: Translate): string {
	const seconds = Math.round((Date.now() - ts) / 1000);
	if (seconds < 60) {
		return t('chat.ago.seconds', { n: String(seconds) });
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return t('chat.ago.minutes', { n: String(minutes) });
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return t('chat.ago.hours', { n: String(hours) });
	}
	return t('chat.ago.days', { n: String(Math.round(hours / 24)) });
}

/** A modal listing saved chat sessions — click one to reopen it in the panel. */
export function ChatHistoryModal({ currentId, onLoad, onClose }: ChatHistoryModalProps): JSX.Element {
	const PAGE_SIZE = 25;
	const [sessions, setSessions] = useState<ChatSession[]>([]);
	const [query, setQuery] = useState('');
	const [page, setPage] = useState(0);
	const t = useT();
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
		if (!(await confirm({ title: t('chat.history.deleteOneTitle'), body: t('chat.history.deleteBody'), confirmLabel: t('chat.history.delete'), danger: true }))) {
			return;
		}
		await window.sqlApi.deleteChatSession(id);
		refresh();
	}

	async function clearAll(): Promise<void> {
		if (!(await confirm({ title: t('chat.history.deleteAllTitle'), body: t('chat.history.deleteAllBody', { count: sessions.length }), confirmLabel: t('chat.history.deleteAll'), danger: true }))) {
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
					<h2>{t('chat.history.title')}</h2>
					<span className="spacer" />
					{sessions.length > 0 && (
						<button type="button" className="icon-btn" aria-label={t('chat.history.clearAll')} onClick={() => void clearAll()}><Icon name="clear-all" /></button>
					)}
					<button type="button" className="icon-btn" aria-label={t('chat.history.close')} onClick={onClose}><Icon name="close" /></button>
				</div>
				{sessions.length > 0 && (
					<div className="audit-filter">
						<input className="audit-search" value={query} placeholder={t('chat.history.search')} onChange={(e) => setQuery(e.target.value)} />
						<span className="spacer" />
						{q && <span className="muted small">{t('chat.history.matches', { count: filtered.length })}</span>}
					</div>
				)}
				<div className="chat-history-list">
					{sessions.length === 0 && <div className="muted pad">{t('chat.history.empty')}</div>}
					{sessions.length > 0 && filtered.length === 0 && <div className="muted pad">{t('chat.history.noMatch')}</div>}
					{pageSessions.map((session) => (
						<div
							className={`chat-history-row${session.id === currentId ? ' current' : ''}`}
							key={session.id}
							onClick={() => onLoad(session)}
						>
							<div className="chat-history-title">{session.title || t('chat.history.untitled')}</div>
							<div className="chat-history-meta">
								{session.connectionLabel && <span>{session.connectionLabel}</span>}
								<span className="muted">{relativeTime(session.updatedAt, t)}</span>
								<span className="muted">{t('chat.history.messages', { count: session.messages.length })}</span>
								{session.tokens.totalTokens > 0 && <span className="muted">{t('chat.history.tokens', { count: session.tokens.totalTokens.toLocaleString(formatLocale()) })}</span>}
								<span className="spacer" />
								<button
									type="button"
									className="icon-btn"
									aria-label={t('chat.history.delete')}
									onClick={(e) => { e.stopPropagation(); void remove(session.id); }}
								><Icon name="trash" /></button>
							</div>
						</div>
					))}
				</div>
				{pageCount > 1 && (
					<div className="audit-pager">
						<button type="button" className="secondary small" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}><Icon name="chevron-left" /> {t('chat.history.prev')}</button>
						<span className="muted small">{t('chat.history.range', { start: rangeStart, end: rangeEnd, total: filtered.length })}</span>
						<button type="button" className="secondary small" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)}>{t('chat.history.next')} <Icon name="chevron-right" /></button>
					</div>
				)}
			</div>
			{confirmDialog}
		</div>
	);
}

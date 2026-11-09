/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../../shared/assistant';
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { BellArt } from '../art/Illustrations';
import { useConfirm } from './ConfirmDialog';
import { shownNotification, type AppNotification, type NotificationSeverity } from '../notifications';
import { useT, type Translate } from '../i18n';

const PAGE_SIZE = 25;

interface NotificationsCenterProps {
	/** Stored oldest-first; the center renders newest-first. */
	notifications: AppNotification[];
	onAskAI(entry: AppNotification): void;
	onDismiss(id: string): void;
	onClear(): void;
	onClose(): void;
}

function relativeTime(ts: number, t: Translate): string {
	const seconds = Math.round((Date.now() - ts) / 1000);
	if (seconds < 60) {
		return t('notifications.center.secondsAgo', { count: seconds });
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return t('notifications.center.minutesAgo', { count: minutes });
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return t('notifications.center.hoursAgo', { count: hours });
	}
	return t('notifications.center.daysAgo', { count: Math.round(hours / 24) });
}

const ICONS: Record<NotificationSeverity, string> = { error: 'error', warn: 'warning', info: 'info' };

/** The notifications center: a scrollable history of errors and notable events, newest first.
 *  Each row can be expanded for the full message, handed to the assistant, copied, or dismissed. */
export function NotificationsCenter({ notifications, onAskAI, onDismiss, onClear, onClose }: NotificationsCenterProps): JSX.Element {
	const t = useT();
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [page, setPage] = useState(0);
	const [confirm, confirmDialog] = useConfirm();
	const rows = [...notifications].reverse();

	// Escape closes it, like every other window in the app. It did not, and a notifications list left
	// open blocks every click behind it.
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				onClose();
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);

	async function clearAll(): Promise<void> {
		if (!(await confirm({ title: t('notifications.center.clearAllTitle'), body: t('notifications.center.clearAllBody', { count: rows.length }), confirmLabel: t('notifications.center.clearAll'), danger: true }))) {
			return;
		}
		onClear();
	}

	async function dismiss(id: string): Promise<void> {
		if (!(await confirm({ title: t('notifications.center.deleteTitle'), body: t('notifications.center.deleteBody'), confirmLabel: t('shell.common.delete'), danger: true }))) {
			return;
		}
		onDismiss(id);
	}

	const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
	const clampedPage = Math.min(page, pageCount - 1);
	const pageRows = rows.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);
	const rangeStart = rows.length === 0 ? 0 : clampedPage * PAGE_SIZE + 1;
	const rangeEnd = clampedPage * PAGE_SIZE + pageRows.length;

	// Snap back to the first page if entries are cleared/dismissed out from under the current one.
	useEffect(() => { setPage((p) => Math.min(p, pageCount - 1)); }, [pageCount]);

	function toggle(id: string): void {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}

	return (
		<div className="modal-backdrop" onMouseDown={onClose}>
			<div className="modal notifications" onMouseDown={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<h2><Icon name="bell" /> {t('notifications.center.title')}</h2>
					<span className="spacer" />
					{rows.length > 0 && (
						<button className="secondary" type="button" onClick={() => void clearAll()} title={t('notifications.center.clearAllTooltip')}>
							<Icon name="clear-all" /> {t('notifications.center.clearAll')}
						</button>
					)}
					<button className="icon-btn" type="button" aria-label={t('shell.common.close')} onClick={onClose}><Icon name="close" /></button>
				</div>
				{rows.length === 0 ? (
					<div className="notif-empty">
						<BellArt className="notif-empty-art" />
						<p>{t('notifications.center.empty')}</p>
					</div>
				) : (
					<div className="notif-list">
						{pageRows.map((n) => {
							const open = expanded.has(n.id);
							const hasDetail = !!n.detail && n.detail !== n.title;
							const shown = shownNotification(n, t);
							return (
								<div key={n.id} className={`notif-row sev-${n.severity}`}>
									<Icon name={ICONS[n.severity]} className="notif-sev" />
									<div className="notif-main">
										<div className="notif-title">{shown.title}</div>
										{hasDetail && (open
											? <pre className="notif-detail">{shown.detail}</pre>
											: <div className="notif-detail-peek">{shown.detail}</div>)}
										<div className="notif-meta">
											<span>{relativeTime(n.ts, t)}</span>
											{(n.from || n.source) && <span className="notif-tag">{n.from ? t('notifications.from', { name: n.from }) : n.source}</span>}
											<span className="spacer" />
											<button className="notif-action" type="button" onClick={() => onAskAI(n)} title={t('notifications.askTitle', { assistant: ASSISTANT_NAME })}>
												<Icon name="sparkle" /> {t('notifications.ask', { assistant: ASSISTANT_NAME })}
											</button>
											{hasDetail && (
												<button className="notif-action" type="button" onClick={() => toggle(n.id)}>
													<Icon name={open ? 'chevron-up' : 'chevron-down'} /> {t(open ? 'notifications.center.less' : 'notifications.center.details')}
												</button>
											)}
											<button className="notif-action" type="button" onClick={() => void navigator.clipboard.writeText(shown.detail ? `${shown.title}\n${shown.detail}` : shown.title)} title={t('shell.common.copy')}>
												<Icon name="copy" />
											</button>
											<button className="notif-action" type="button" onClick={() => void dismiss(n.id)} title={t('shell.common.dismiss')}>
												<Icon name="close" />
											</button>
										</div>
									</div>
								</div>
							);
						})}
					</div>
				)}
				{pageCount > 1 && (
					<div className="audit-pager">
						<button type="button" className="secondary small" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}><Icon name="chevron-left" /> {t('notifications.center.prev')}</button>
						<span className="muted small">{t('notifications.center.range', { start: rangeStart, end: rangeEnd, total: rows.length })}</span>
						<button type="button" className="secondary small" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)}>{t('shell.common.next')} <Icon name="chevron-right" /></button>
					</div>
				)}
				{confirmDialog}
			</div>
		</div>
	);
}

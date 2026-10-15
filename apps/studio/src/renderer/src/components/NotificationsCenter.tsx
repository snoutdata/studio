/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../../shared/assistant';
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { BellArt } from '../art/Illustrations';
import { useConfirm } from './ConfirmDialog';
import type { AppNotification, NotificationSeverity } from '../notifications';

const PAGE_SIZE = 25;

interface NotificationsCenterProps {
	/** Stored oldest-first; the center renders newest-first. */
	notifications: AppNotification[];
	onAskAI(entry: AppNotification): void;
	onDismiss(id: string): void;
	onClear(): void;
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

const ICONS: Record<NotificationSeverity, string> = { error: 'error', warn: 'warning', info: 'info' };

/** The notifications center: a scrollable history of errors and notable events, newest first.
 *  Each row can be expanded for the full message, handed to the assistant, copied, or dismissed. */
export function NotificationsCenter({ notifications, onAskAI, onDismiss, onClear, onClose }: NotificationsCenterProps): JSX.Element {
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
		if (!(await confirm({ title: "Clear all notifications?", body: `All ${rows.length} notification${rows.length === 1 ? '' : 's'} will be removed. This cannot be undone.`, confirmLabel: "Clear all", danger: true }))) {
			return;
		}
		onClear();
	}

	async function dismiss(id: string): Promise<void> {
		if (!(await confirm({ title: "Delete this notification?", body: "This cannot be undone.", confirmLabel: "Delete", danger: true }))) {
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
					<h2><Icon name="bell" /> Notifications</h2>
					<span className="spacer" />
					{rows.length > 0 && (
						<button className="secondary" type="button" onClick={() => void clearAll()} title="Clear all notifications">
							<Icon name="clear-all" /> Clear all
						</button>
					)}
					<button className="icon-btn" type="button" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
				</div>
				{rows.length === 0 ? (
					<div className="notif-empty">
						<BellArt className="notif-empty-art" />
						<p>No notifications. Errors and notable events will show up here.</p>
					</div>
				) : (
					<div className="notif-list">
						{pageRows.map((n) => {
							const open = expanded.has(n.id);
							const hasDetail = !!n.detail && n.detail !== n.title;
							return (
								<div key={n.id} className={`notif-row sev-${n.severity}`}>
									<Icon name={ICONS[n.severity]} className="notif-sev" />
									<div className="notif-main">
										<div className="notif-title">{n.title}</div>
										{hasDetail && (open
											? <pre className="notif-detail">{n.detail}</pre>
											: <div className="notif-detail-peek">{n.detail}</div>)}
										<div className="notif-meta">
											<span>{relativeTime(n.ts)}</span>
											{(n.from || n.source) && <span className="notif-tag">{n.from ? `From ${n.from}` : n.source}</span>}
											<span className="spacer" />
											<button className="notif-action" type="button" onClick={() => onAskAI(n)} title={`Ask ${ASSISTANT_NAME} about this`}>
												<Icon name="sparkle" /> Ask {ASSISTANT_NAME}
											</button>
											{hasDetail && (
												<button className="notif-action" type="button" onClick={() => toggle(n.id)}>
													<Icon name={open ? 'chevron-up' : 'chevron-down'} /> {open ? 'Less' : 'Details'}
												</button>
											)}
											<button className="notif-action" type="button" onClick={() => void navigator.clipboard.writeText(n.detail ? `${n.title}\n${n.detail}` : n.title)} title="Copy">
												<Icon name="copy" />
											</button>
											<button className="notif-action" type="button" onClick={() => void dismiss(n.id)} title="Dismiss">
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
						<button type="button" className="secondary small" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}><Icon name="chevron-left" /> Prev</button>
						<span className="muted small">{rangeStart}-{rangeEnd} of {rows.length}</span>
						<button type="button" className="secondary small" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)}>Next <Icon name="chevron-right" /></button>
					</div>
				)}
				{confirmDialog}
			</div>
		</div>
	);
}

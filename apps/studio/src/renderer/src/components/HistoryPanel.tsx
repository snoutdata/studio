/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import type { QueryHistoryEntry, SavedQuery } from '../../../shared/queries';
import { HistoryArt, SavedArt } from '../art/Illustrations';

interface HistoryPanelProps {
	/** Load the chosen SQL into the editor. */
	onPick(sql: string): void;
	onCollapse(): void;
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

function preview(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Left-side-bar view for query history + saved queries (selected from the activity bar). */
export function HistoryPanel(props: HistoryPanelProps): JSX.Element {
	const [tab, setTab] = useState<'recent' | 'saved'>('recent');
	const [history, setHistory] = useState<QueryHistoryEntry[]>([]);
	const [saved, setSaved] = useState<SavedQuery[]>([]);
	const [confirm, confirmDialog] = useConfirm();

	async function clearHistory(): Promise<void> {
		if (!(await confirm({ title: "Clear query history?", body: "Every recorded query in your history will be removed. This cannot be undone.", confirmLabel: "Clear history", danger: true }))) {
			return;
		}
		await window.sqlApi.clearHistory();
		void refresh();
	}

	async function refresh(): Promise<void> {
		setHistory(await window.sqlApi.history());
		setSaved(await window.sqlApi.savedQueries());
	}

	useEffect(() => {
		void refresh();
	}, []);

	return (
		<div className="sidebar">
			<div className="sidebar-header">
				<span>HISTORY</span>
				<span className="spacer" />
				<button className="icon-btn" aria-label="Refresh" onClick={() => void refresh()}><Icon name="refresh" /></button>
				{tab === 'recent' && history.length > 0 && (
					<button className="icon-btn" aria-label="Clear history" onClick={() => void clearHistory()}><Icon name="clear-all" /></button>
				)}
				<button className="icon-btn" aria-label="Collapse" onClick={props.onCollapse}><Icon name="chevron-left" /></button>
			</div>
			<div className="tabs">
				<button type="button" className={tab === 'recent' ? 'tab active' : 'tab'} onClick={() => setTab('recent')}>Recent</button>
				<button type="button" className={tab === 'saved' ? 'tab active' : 'tab'} onClick={() => setTab('saved')}>Saved</button>
			</div>
			<div className="queries-list">
				{tab === 'recent' && history.length === 0 && (
					<div className="queries-empty">
						<HistoryArt className="queries-empty-art" />
						<p>No history yet. The queries you run show up here.</p>
					</div>
				)}
				{tab === 'recent' && history.map((entry, i) => (
					<div className="query-row" key={i} onClick={() => props.onPick(entry.sql)}>
						<div className="query-sql">{preview(entry.sql)}</div>
						<div className="query-meta">
							<span>{entry.connectionLabel}</span>
							{entry.environment && <span className={`env${entry.environment === 'prod' ? ' prod' : ''}`}>{entry.environment}</span>}
							<span className="muted">{relativeTime(entry.timestamp)}</span>
							<span className={entry.outcome.ok ? 'ok' : 'error'}>
								{entry.outcome.ok ? `${entry.outcome.rowCount} rows · ${entry.outcome.durationMs} ms` : 'error'}
							</span>
						</div>
					</div>
				))}
				{tab === 'saved' && saved.length === 0 && (
					<div className="queries-empty">
						<SavedArt className="queries-empty-art" />
						<p>No saved queries. Save one from the editor and it is kept here.</p>
					</div>
				)}
				{tab === 'saved' && saved.map((query) => (
					<div className="query-row" key={query.name} onClick={() => props.onPick(query.sql)}>
						<div className="query-sql"><strong>{query.name}</strong>: {preview(query.sql)}</div>
						<div className="query-meta">
							<span className="spacer" />
							<button
								type="button"
								className="icon-btn"
								aria-label="Delete"
								onClick={async (e) => { e.stopPropagation(); await window.sqlApi.deleteQuery(query.name); void refresh(); }}
							><Icon name="trash" /></button>
						</div>
					</div>
				))}
			</div>
			{confirmDialog}
		</div>
	);
}

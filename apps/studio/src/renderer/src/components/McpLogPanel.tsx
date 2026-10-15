/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import type { McpLogEntry } from '../../../shared/mcp';

interface McpLogPanelProps {
	/** Load the chosen SQL into a new editor tab. */
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

/** A refusal is its own outcome: the app stopped it, which is different from it going wrong. */
function outcomeClass(entry: McpLogEntry): string {
	if (entry.outcome.ok) {
		return 'ok';
	}
	return entry.outcome.refused ? 'warn' : 'error';
}

function outcomeLabel(entry: McpLogEntry): string {
	if (!entry.outcome.ok) {
		return entry.outcome.refused ? 'refused' : 'error';
	}
	const rows = entry.outcome.rowCount === undefined ? '' : `${entry.outcome.rowCount} rows · `;
	return `${rows}${entry.outcome.durationMs} ms`;
}

function preview(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Left-side-bar view for the agent's ACTIVITY TIMELINE: everything an external agent did
 * through the app, database and app alike, including the calls that were refused.
 *
 * It is an OBSERVED record, not a self-report: every line is something the app watched the agent
 * do, so nothing here depends on the agent choosing to describe itself honestly. Search, filter by
 * kind, delete each, clear all; a row with SQL opens it in a tab. Shown while agent access is on.
 */
export function McpLogPanel(props: McpLogPanelProps): JSX.Element {
	const [entries, setEntries] = useState<McpLogEntry[]>([]);
	const [query, setQuery] = useState('');
	const [kind, setKind] = useState<'all' | 'query' | 'app'>('all');
	const [confirm, confirmDialog] = useConfirm();

	async function refresh(): Promise<void> {
		setEntries(await window.sqlApi.mcp.logs());
	}

	useEffect(() => {
		void refresh();
	}, []);

	async function clearAll(): Promise<void> {
		if (!(await confirm({ title: "Clear the agent log?", body: "Every query an agent ran over MCP will be removed from this log. This cannot be undone.", confirmLabel: "Clear log", danger: true }))) {
			return;
		}
		await window.sqlApi.mcp.logsClear();
		void refresh();
	}

	async function remove(id: string): Promise<void> {
		await window.sqlApi.mcp.logDelete(id);
		void refresh();
	}

	const q = query.trim().toLowerCase();
	const filtered = useMemo(() => {
		// An entry written before the timeline existed has no `kind`; treat it as what it was.
		const byKind = kind === 'all' ? entries : entries.filter((e) => (e.kind ?? 'query') === kind);
		if (!q) {
			return byKind;
		}
		return byKind.filter((e) => `${e.sql ?? ''} ${e.summary ?? ''} ${e.connectionLabel ?? ''} ${e.tool} ${e.client ?? ''}`.toLowerCase().includes(q));
	}, [entries, q, kind]);

	return (
		<div className="sidebar">
			<div className="sidebar-header">
				<span>AGENT LOG</span>
				<span className="spacer" />
				<button className="icon-btn" aria-label="Refresh" onClick={() => void refresh()}><Icon name="refresh" /></button>
				{entries.length > 0 && (
					<button className="icon-btn" aria-label="Clear log" onClick={() => void clearAll()}><Icon name="clear-all" /></button>
				)}
				<button className="icon-btn" aria-label="Collapse" onClick={props.onCollapse}><Icon name="chevron-left" /></button>
			</div>
			<div className="ws-search">
				<Icon name="search" />
				<input
					type="text"
					placeholder="Search the agent log"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				{query && <button className="icon-btn" aria-label="Clear" onClick={() => setQuery('')}><Icon name="close" /></button>}
			</div>
			<div className="agent-log-kinds" role="tablist">
				{([['all', 'Everything'], ['query', 'Databases'], ['app', 'The app']] as const).map(([id, label]) => (
					<button
						key={id}
						role="tab"
						aria-selected={kind === id}
						className={`agent-log-kind${kind === id ? ' active' : ''}`}
						onClick={() => setKind(id)}
					>{label}</button>
				))}
			</div>
			<div className="queries-list">
				{entries.length === 0 && <div className="muted pad">Nothing yet. Everything an external agent does through SnoutData Studio, queries and app actions alike, appears here.</div>}
				{entries.length > 0 && filtered.length === 0 && <div className="muted pad">No entries match the filter.</div>}
				{filtered.map((entry) => (
					<div
						className="query-row"
						key={entry.id}
						onClick={() => { if (entry.sql) { props.onPick(entry.sql); } }}
						title={entry.sql ? "Open in a new tab" : undefined}
					>
						<div className={entry.sql ? 'query-sql' : 'agent-log-what'}>
							{entry.sql ? preview(entry.sql) : (entry.summary ?? entry.tool)}
						</div>
						<div className="query-meta">
							<span className="mcp-log-tool">{entry.tool}</span>
							{entry.client && <span className="muted">{entry.client}</span>}
							{entry.connectionLabel && <span>{entry.connectionLabel}</span>}
							{entry.environment && <span className={`env${entry.environment === 'prod' ? ' prod' : ''}`}>{entry.environment}</span>}
							{entry.mutates && <span className="agent-log-changes" title="This call changed something">changes</span>}
							<span className="muted">{relativeTime(entry.timestamp)}</span>
							<span className={outcomeClass(entry)}>{outcomeLabel(entry)}</span>
							<span className="spacer" />
							<button
								type="button"
								className="icon-btn"
								aria-label="Delete entry"
								onClick={(e) => { e.stopPropagation(); void remove(entry.id); }}
							><Icon name="trash" /></button>
						</div>
					</div>
				))}
			</div>
			{confirmDialog}
		</div>
	);
}

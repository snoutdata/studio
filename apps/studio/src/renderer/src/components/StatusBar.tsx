/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { updateProgressDetail, type UpdateStatus } from '../../../shared/update';
import { Icon } from './Icon';
import { useT } from '../i18n';

interface StatusBarProps {
	/** The connection the active tab points at (label + state); undefined when none. */
	connectionLabel?: string;
	connected: boolean;
	prod: boolean;
	/** The active connection's default database/schema, shown next to the connection. */
	database?: string;
	/** Editor cursor + selection info; undefined for non-SQL (table/result) tabs. */
	editor?: { line: number; col: number; selected: number };
	/** Last query result summary (rows + elapsed ms); undefined until a query runs. */
	result?: { rows: number; ms: number };
	/** True while a query is in flight (the active tab). */
	running: boolean;
	/** How many interactive queries are in flight on the status-bar connection right now. Drives the
	 *  "running N" count and, at/above `poolMax`, the "connections busy" hint. */
	concurrentRuns?: number;
	/** The status-bar connection's pool size (max simultaneous queries before the next one queues). */
	poolMax?: number;
	/** Total app memory (working set across all processes) in bytes; 0 until first sample. Does NOT
	 *  include a local model, which runs in its own process. */
	memoryBytes: number;
	/** Readings from Data Flows' half (the local model's memory), drawn before the version. Nothing in
	 *  a build without it. */
	proItems?: ReactNode;
	/** The capability an external agent is running right now, or undefined when nothing is. An app
	 *  that moves on its own has to say why. */
	agentActing?: string;
	/** App version (e.g. "0.0.26"), shown at the far right. */
	version: string;
	/** Latest auto-update status (undefined when nothing to surface). Download progress shows
	 *  ambiently here; the "ready to install" CTA is a separate toast unless it was dismissed. */
	update?: UpdateStatus;
	/** True once the user dismissed the "ready" toast — then we keep a quiet restart pill here. */
	updateDismissed?: boolean;
	/** Click the connection segment → jump to the Connections view. */
	onClickConnection(): void;
	/** Restart-and-install the downloaded update (from the status-bar restart pill). */
	onInstallUpdate?(): void;
}

/** How often the download readout redraws. The clock counts in seconds, so a second is the only
 *  interval that keeps it honest, and it exists only while there is a clock to move. */
const UPDATE_TICK_MS = 1_000;

/** The "Updating…" segment.
 *
 *  Its own component because it is the one thing in the bar that changes on its own: on macOS
 *  Squirrel reports no progress at all, so without a clock this sat at a bare ellipsis for the
 *  whole download, and a user cannot tell a slow one from a hung one. Windows keeps its
 *  percentage and is untouched (updateProgressDetail returns nothing once there is a percent),
 *  which is also why the timer is armed only when there is no percentage to show: a bar that
 *  re-renders every second for no reason is a cost with no reader. */
function UpdatingStatus({ status }: { status: UpdateStatus }): JSX.Element {
	const preparing = status.state === 'downloading' && status.preparing === true;
	const percent = status.state === 'downloading' && !preparing ? status.percent : undefined;
	const ticking = status.state === 'downloading' && !preparing && percent === undefined && status.startedAt !== undefined;
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!ticking) {
			return;
		}
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), UPDATE_TICK_MS);
		return () => clearInterval(timer);
	}, [ticking]);
	const t = useT();
	const detail = updateProgressDetail(status, now, true);
	if (preparing) {
		return (
			<span className="status-item status-update" title={t('shell.statusBar.preparingTitle')}>
				<Icon name="loading" className="codicon-modifier-spin" /> {t('shell.statusBar.preparing')}
			</span>
		);
	}
	return (
		<span className="status-item status-update" title={t('shell.statusBar.updatingTitle')}>
			<Icon name="cloud-download" /> {t('shell.statusBar.updating')}{percent !== undefined ? ` ${percent}%` : `${detail ? ` ${detail}` : ''}…`}
		</span>
	);
}

/** Bytes → a compact "MB"/"GB" label for the status bar. */
export function formatMemory(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	if (mb >= 1024) {
		return `${(mb / 1024).toFixed(2)} GB`;
	}
	return `${Math.round(mb)} MB`;
}

/** VSCode-style bottom status strip: connection on the left; result/cursor/language/version
 *  on the right. Purely a status surface — the only interactive bit is the connection chip. */
export function StatusBar(props: StatusBarProps): JSX.Element {
	const t = useT();
	const { connectionLabel, connected, prod, database, editor, result, running, concurrentRuns = 0, poolMax, memoryBytes, proItems, version, update, updateDismissed, agentActing, onClickConnection, onInstallUpdate } = props;
	// The connection is saturated when as many queries are running as the pool allows: the next one
	// on it will queue until a slot frees. Only meaningful once we know the pool size.
	const poolBusy = poolMax !== undefined && concurrentRuns >= poolMax;
	return (
		<footer className="status-bar">
			<div className="status-left">
				<button className="status-item" type="button" onClick={onClickConnection} title={t('shell.dock.tool.connections')}>
					<Icon name="circle-filled" className={`status-dot${connected ? ' on' : ''}${prod ? ' prod' : ''}`} />
					<span>{connectionLabel ?? t('shell.common.noConnection')}</span>
					{prod && <span className="status-prod">{t('shell.statusBar.prod')}</span>}
				</button>
				{database && <span className="status-item status-muted">{database}</span>}
				{(running || concurrentRuns > 0) && (
					<span className="status-item" title={concurrentRuns > 1 ? t('shell.statusBar.runningManyTitle', { count: concurrentRuns }) : t('shell.statusBar.runningTitle')}>
						<Icon name="sync" className="spin" /> {concurrentRuns > 1 ? t('shell.statusBar.runningMany', { count: concurrentRuns }) : t('shell.statusBar.running')}
					</span>
				)}
				{poolBusy && (
					<span className="status-item status-busy" title={t('shell.statusBar.busyTitle', { count: poolMax })}>
						<Icon name="warning" /> {t('shell.statusBar.busy')}
					</span>
				)}
				{agentActing && (
					<span className="status-item status-agent" title={t('shell.statusBar.agentActingTitle', { capability: agentActing })}>
						<Icon name="sparkle" className="spin" /> {t('shell.statusBar.agentActing')}
					</span>
				)}
				{update?.state === 'downloading' && <UpdatingStatus status={update} />}
				{update?.state === 'downloaded' && updateDismissed && (
					<button className="status-item status-update ready" type="button" onClick={onInstallUpdate} title={t('shell.statusBar.restartTitle')}>
						<Icon name="arrow-circle-up" /> {t('shell.statusBar.restart')}
					</button>
				)}
			</div>
			<div className="status-right">
				{result && (
					<span className="status-item" title={t('shell.statusBar.resultTitle')}>
						<Icon name="list-flat" /> {t('shell.statusBar.rows', { count: result.rows })} · {result.ms} ms
					</span>
				)}
				{editor && (
					<span className="status-item" title={t('shell.statusBar.cursorTitle')}>
						{t('shell.statusBar.cursor', { line: String(editor.line), col: String(editor.col) })}{editor.selected > 0 ? ` ${t('shell.statusBar.selected', { count: editor.selected })}` : ''}
					</span>
				)}
				{editor && <span className="status-item">SQL</span>}
				{memoryBytes > 0 && (
					<span className="status-item status-muted" title={t('shell.statusBar.memoryTitle')}>
						<Icon name="pulse" /> {formatMemory(memoryBytes)}
					</span>
				)}
				{proItems}
				<span className="status-item status-muted">v{version}</span>
			</div>
		</footer>
	);
}

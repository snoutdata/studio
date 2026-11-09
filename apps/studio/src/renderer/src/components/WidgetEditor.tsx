/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import { Icon } from './Icon';
import { MIN_INTERVAL_SEC, type MonitorWidget, type WidgetKind, type WidgetViz } from '../../../shared/monitor';
import { useT } from '../i18n';

// Create/edit one monitor widget. A widget is a SQL query polled on an interval and plotted.
// `trend` accumulates a metric over time (SQLite-backed); `snapshot` re-runs and replaces the view
// each interval.

interface WidgetEditorProps {
	initial: MonitorWidget;
	connections: { id: string; label: string }[];
	onSave(widget: MonitorWidget): void;
	onCancel(): void;
}

const VIZZES: WidgetViz[] = ['line', 'area', 'bar', 'number', 'table'];

export function WidgetEditor({ initial, connections, onSave, onCancel }: WidgetEditorProps): JSX.Element {
	const t = useT();
	const [title, setTitle] = useState(initial.title);
	const [connectionId, setConnectionId] = useState(initial.connectionId);
	const [kind, setKind] = useState<WidgetKind>(initial.kind);
	const [viz, setViz] = useState<WidgetViz>(initial.viz);
	const [sql, setSql] = useState(initial.sql);
	const [intervalSec, setIntervalSec] = useState(String(initial.intervalSec));
	const [retentionMin, setRetentionMin] = useState(String(initial.retentionMin ?? 1440));

	const canSave = title.trim().length > 0 && sql.trim().length > 0 && connectionId.length > 0;

	function save(): void {
		if (!canSave) {
			return;
		}
		const widget: MonitorWidget = {
			id: initial.id,
			title: title.trim(),
			connectionId,
			sql: sql.trim(),
			kind,
			viz,
			intervalSec: Math.max(MIN_INTERVAL_SEC, Number(intervalSec) || MIN_INTERVAL_SEC),
			enabled: initial.enabled,
		};
		if (kind === 'trend') {
			widget.retentionMin = Math.max(1, Number(retentionMin) || 1440);
		}
		onSave(widget);
	}

	return (
		<div className="modal-backdrop">
			<div className="modal widget-editor">
				<h2><Icon name="pulse" /> {initial.title ? t('dashboard.widget.edit') : t('dashboard.widget.add')}</h2>

				<label className="field">
					<span>{t('dashboard.widget.title')}</span>
					<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('dashboard.widget.placeholder')} autoFocus />
				</label>

				<div className="field-row">
					<label className="field">
						<span>{t('cloudProjects.conn.title')}</span>
						<select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
							<option value="">{t('dashboard.widget.chooseConn')}</option>
							{connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
						</select>
					</label>
					<label className="field">
						<span>{t('projects.common.type')}</span>
						<select value={kind} onChange={(e) => setKind(e.target.value as WidgetKind)}>
							<option value="trend">{t('dashboard.widget.trend')}</option>
							<option value="snapshot">{t('dashboard.widget.snapshot')}</option>
						</select>
					</label>
				</div>

				<label className="field">
					<span>SQL</span>
					<textarea
						className="widget-sql"
						value={sql}
						onChange={(e) => setSql(e.target.value)}
						placeholder={kind === 'trend' ? "SELECT COUNT(*) FROM queue WHERE status = 'new'" : "SELECT name, rows FROM table_sizes ORDER BY rows DESC LIMIT 10"}
						spellCheck={false}
						rows={4}
					/>
				</label>
				<p className="field-hint">
					{kind === 'trend'
						? t('dashboard.widget.trendHint')
						: t('dashboard.widget.snapshotHint')}
				</p>

				<div className="field-row">
					<label className="field">
						<span>{t('dashboard.widget.viz')}</span>
						<select value={viz} onChange={(e) => setViz(e.target.value as WidgetViz)}>
							{VIZZES.map((v) => <option key={v} value={v}>{t(`dashboard.viz.${v}`)}</option>)}
						</select>
					</label>
					<label className="field">
						<span>{t('dashboard.widget.refresh')}</span>
						<input type="number" min={MIN_INTERVAL_SEC} value={intervalSec} onChange={(e) => setIntervalSec(e.target.value)} />
					</label>
					{kind === 'trend' && (
						<label className="field">
							<span>{t('dashboard.widget.keep')}</span>
							<input type="number" min={1} value={retentionMin} onChange={(e) => setRetentionMin(e.target.value)} />
						</label>
					)}
				</div>

				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onCancel}><Icon name="close" /> {t('projects.common.cancel')}</button>
					<button type="button" disabled={!canSave} onClick={save}><Icon name="save" /> {t('dashboard.widget.save')}</button>
				</div>
			</div>
		</div>
	);
}

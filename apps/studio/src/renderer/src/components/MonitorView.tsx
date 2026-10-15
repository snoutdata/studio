/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { MonitorArt, WidgetSlotArt } from '../art/Illustrations';
import { WidgetTile } from './WidgetTile';
import { WidgetEditor } from './WidgetEditor';
import type { Monitor, MonitorWidget } from '../../../shared/monitor';

// The monitors main-area view: a switcher across the user's monitors, management (create / rename /
// delete), and a grid of widget tiles. Trend tiles read the SQLite samples store + live poller
// ticks; snapshot tiles poll renderer-side. The deterministic polling/rendering path has no model
// in it — AI analysis is a separate, on-demand cold path.

interface ConnRef {
	id: string;
	label: string;
}

interface MonitorViewProps {
	connections: ConnRef[];
	/** This monitor tab is the active/visible tab (snapshot tiles pause polling when false). */
	active: boolean;
	/** Show this monitor, when something OUTSIDE this view has just made or named one (the
	 *  ClickHouse Operations panel's starter). `nonce` is what makes a second request for the same
	 *  monitor arrive: the id alone would be unchanged and the effect would not run. */
	focus?: { nonce: number; id: string };
	onClose(): void;
}

function uid(): string {
	return crypto.randomUUID();
}

function freshWidget(connectionId: string): MonitorWidget {
	return { id: uid(), title: '', connectionId, sql: '', kind: 'trend', viz: 'line', intervalSec: 60, retentionMin: 1440 };
}

export function MonitorView({ connections, active, focus, onClose }: MonitorViewProps): JSX.Element {
	const [monitors, setMonitors] = useState<Monitor[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [editing, setEditing] = useState<MonitorWidget | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameText, setRenameText] = useState('');
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [loaded, setLoaded] = useState(false);

	const reload = useCallback(async (): Promise<Monitor[]> => {
		const list = await window.sqlApi.monitors.list();
		setMonitors(list);
		setLoaded(true);
		return list;
	}, []);

	useEffect(() => {
		void reload().then((list) => {
			setSelectedId((cur) => cur ?? list[0]?.id ?? null);
		});
	}, [reload]);

	/*
	 * Re-read when the set changes under us.
	 *
	 * Without this the view was a snapshot of whatever existed the moment it mounted, which is a
	 * problem the moment something other than this component writes a monitor. An agent driving
	 * the app over MCP does exactly that: `create_monitor` opens this view and then every
	 * `add_monitor_widget` saved correctly, answered ok, and appeared nowhere until the tab was
	 * closed and reopened.
	 *
	 * Selecting is left alone deliberately: `selectedId` is this view's own state, and re-reading
	 * the list must not move the user off the monitor they are looking at. The one exception is
	 * having nothing selected yet, where a monitor arriving is the thing to show.
	 */
	useEffect(() => {
		return window.sqlApi.monitors.onChanged(() => {
			void reload().then((list) => {
				setSelectedId((cur) => (cur && list.some((d) => d.id === cur) ? cur : list[0]?.id ?? null));
			});
		});
	}, [reload]);

	// A monitor made elsewhere has to be the one on screen, or the click that made it looks like
	// it did nothing. Re-reads the list first: it was saved through the store, not through here.
	useEffect(() => {
		if (!focus) {
			return;
		}
		void reload().then((list) => {
			if (list.some((d) => d.id === focus.id)) {
				setSelectedId(focus.id);
			}
		});
	}, [focus?.nonce, focus?.id, reload]);

	const selected = monitors.find((d) => d.id === selectedId) ?? null;

	async function persist(monitor: Monitor): Promise<void> {
		const updated = { ...monitor, updatedAt: Date.now() };
		setMonitors((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
		await window.sqlApi.monitors.save(updated);
	}

	async function createMonitor(): Promise<void> {
		const now = Date.now();
		const dash: Monitor = { id: uid(), name: "New monitor", widgets: [], createdAt: now, updatedAt: now };
		setMonitors((prev) => [...prev, dash]);
		setSelectedId(dash.id);
		await window.sqlApi.monitors.save(dash);
		setRenaming(dash.id);
		setRenameText(dash.name);
	}

	async function commitRename(): Promise<void> {
		const id = renaming;
		setRenaming(null);
		const dash = monitors.find((d) => d.id === id);
		const name = renameText.trim();
		if (dash && name.length > 0 && name !== dash.name) {
			await persist({ ...dash, name });
		}
	}

	async function deleteSelected(): Promise<void> {
		if (!selected) {
			return;
		}
		const id = selected.id;
		setConfirmDelete(false);
		setMonitors((prev) => prev.filter((d) => d.id !== id));
		setSelectedId((cur) => (cur === id ? monitors.find((d) => d.id !== id)?.id ?? null : cur));
		await window.sqlApi.monitors.remove(id);
	}

	function saveWidget(widget: MonitorWidget): void {
		if (!selected) {
			return;
		}
		const exists = selected.widgets.some((w) => w.id === widget.id);
		const widgets = exists
			? selected.widgets.map((w) => (w.id === widget.id ? widget : w))
			: [...selected.widgets, widget];
		void persist({ ...selected, widgets });
		setEditing(null);
	}

	function deleteWidget(widgetId: string): void {
		if (!selected) {
			return;
		}
		void persist({ ...selected, widgets: selected.widgets.filter((w) => w.id !== widgetId) });
	}

	const connLabel = (id: string): string | undefined => connections.find((c) => c.id === id)?.label;

	return (
		<div className="monitor-view">
			<div className="monitor-toolbar">
				<Icon name="pulse" />
				<span className="monitor-tabs">
					{monitors.map((d) => (
						renaming === d.id ? (
							<input
								key={d.id}
								className="monitor-rename"
								value={renameText}
								autoFocus
								onChange={(e) => setRenameText(e.target.value)}
								onBlur={() => void commitRename()}
								onKeyDown={(e) => { if (e.key === 'Enter') { void commitRename(); } else if (e.key === 'Escape') { setRenaming(null); } }}
							/>
						) : (
							<button
								key={d.id}
								className={`monitor-tab${d.id === selectedId ? ' active' : ''}`}
								onClick={() => setSelectedId(d.id)}
								onDoubleClick={() => { setRenaming(d.id); setRenameText(d.name); }}
								title="Double-click to rename"
							>
								{d.name}
							</button>
						)
					))}
					<button className="monitor-tab add" onClick={() => void createMonitor()} title="New monitor"><Icon name="add" /></button>
				</span>
				<span className="spacer" />
				{selected && (
					<>
						<button className="secondary" onClick={() => setEditing(freshWidget(connections[0]?.id ?? ''))}><Icon name="add" /> Add widget</button>
						{confirmDelete ? (
							<span className="monitor-confirm">
								Delete "{selected.name}"?
								<button className="danger" onClick={() => void deleteSelected()}><Icon name="trash" /> Delete</button>
								<button className="secondary" onClick={() => setConfirmDelete(false)}><Icon name="close" /> Cancel</button>
							</span>
						) : (
							<button className="icon-button" title="Delete monitor" onClick={() => setConfirmDelete(true)}><Icon name="trash" /></button>
						)}
					</>
				)}
				<button className="icon-button" title="Close" onClick={onClose}><Icon name="close" /></button>
			</div>

			{!loaded ? null : monitors.length === 0 ? (
				<div className="monitor-empty">
					<MonitorArt className="monitor-empty-art" />
					<h3>No monitors yet</h3>
					<p>A monitor is a set of live SQL widgets, polled on an interval and plotted over time.</p>
					<button onClick={() => void createMonitor()}><Icon name="add" /> New monitor</button>
				</div>
			) : !selected ? null : selected.widgets.length === 0 ? (
				<div className="monitor-empty">
					<WidgetSlotArt className="monitor-empty-art" />
					<h3>{selected.name} is empty</h3>
					<p>Add a widget: a SQL query polled every few seconds and plotted. A trend samples a number over time; a snapshot re-runs a query and replaces the chart.</p>
					<button onClick={() => setEditing(freshWidget(connections[0]?.id ?? ''))}><Icon name="add" /> Add widget</button>
				</div>
			) : (
				<div className="monitor-grid">
					{selected.widgets.map((w) => (
						<WidgetTile
							key={w.id}
							widget={w}
							connectionLabel={connLabel(w.connectionId)}
							active={active}
							onEdit={() => setEditing(w)}
							onDelete={() => deleteWidget(w.id)}
						/>
					))}
				</div>
			)}

			{editing && (
				<WidgetEditor
					initial={editing}
					connections={connections}
					onSave={saveWidget}
					onCancel={() => setEditing(null)}
				/>
			)}
		</div>
	);
}

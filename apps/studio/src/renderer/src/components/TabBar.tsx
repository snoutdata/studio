/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import { Icon } from './Icon';
import { formatShortcut } from '../shortcuts';
import { useT, type Translate } from '../i18n';
import type { ConnectionConfig } from '../../../shared/connection';
import { agentDescriptor, type AgentKind } from '../../../shared/agentConsole';
import type { ProjectSection, ProjectTarget } from '../../../shared/projects';

export interface EditorTab {
	id: string;
	title: string;
	filePath?: string;
	dirty: boolean;
	/** 'sql' (default) | 'table' (double-clicked table view) | 'object' (procedure/trigger
	 *  DDL view) | 'schemaSync' (database diff/migrate view) | 'workload' (per-connection
	 *  heaviest-queries advisor) | 'releaseNotes' (VSCode-style per-version release notes doc) |
	 *  'monitor' (live DB monitors) | 'flow' (the Data Flows wizard) | 'agentView' (what a coding
	 *  agent has shown, when its console is docked at the bottom) | 'review' (Snoutbot's
	 *  pull-request reviews, read before they post) | 'security' (per-connection users and
	 *  privileges) | 'orbit' (the database as a 3D world) | 'cloudProject' (a SnoutData Cloud
	 *  project) | 'localSetup' (the local project setup wizard) | 'localProject' (a local project
	 *  in Docker). */
	kind?: 'sql' | 'table' | 'object' | 'schemaSync' | 'workload' | 'releaseNotes' | 'monitor' | 'flow' | 'move' | 'vectorSearch' | 'agentView' | 'review' | 'security' | 'orbit' | 'chOps' | 'chRemote' | 'cloudProject' | 'localSetup' | 'localProject' | 'projectCopy';
	/** The SnoutData Cloud project a `cloudProject` tab shows, and the section it is on. */
	cloudRef?: string;
	cloudSection?: ProjectSection;
	/** The local project a `localProject` tab shows, and the section it is on. */
	localId?: string;
	localSection?: ProjectSection;
	/** The project a `projectCopy` tab copies to the other side (shared/projectCopy.ts). */
	copySource?: ProjectTarget;
	/** Which agent an `agentView` tab belongs to, so the tab carries that agent's own mark. */
	agent?: AgentKind;
	/** Something new arrived on a tab the user is not looking at (a coding agent drew while they were
	 *  in the editor). Cleared when they open it. Deliberately not `dirty`: this is unread, not
	 *  unsaved, and the two must never share a dot the close-confirm reads. */
	attention?: boolean;
	/** The connection this tab runs against (the per-tab "active connection"). */
	connectionId?: string;
	/** Authoring surface for an editor tab: 'sql' (default, the universal SQL
	 *  editor) or 'native' (the MongoDB aggregation-pipeline JSON editor). */
	surface?: 'sql' | 'native';
	/** Monaco language of this tab's model ('sql' by default, 'json' for a native pipeline tab). */
	language?: string;
	/** The target collection a native pipeline runs against (native surface only). */
	collection?: string;
}

/**
 * What a tab is called on screen. `tab.title` stays the name the app or the user gave it, English for
 * the tabs the app names: the assistant is told the open tabs by that name and a saved session keeps
 * it. Those names are translated here, so a language switch renames them too; a name from a file, a
 * table or the user is left as it is.
 */
export function tabLabel(tab: EditorTab, connections: ConnectionConfig[], t: Translate): string {
	const connection = tab.connectionId ? connections.find((c) => c.id === tab.connectionId)?.label : undefined;
	switch (tab.kind) {
		case 'schemaSync': return t('shell.tabs.schemaSync');
		case 'releaseNotes': return t('shell.tabs.releaseNotes');
		case 'review': return t('shell.tabs.reviews');
		case 'monitor': return t('shell.tabs.monitors');
		case 'move': return t('shell.tabs.moveDatabase');
		case 'vectorSearch': return t('shell.tabs.searchVectors');
		case 'localSetup': return t('shell.tabs.localSetup');
		case 'workload': return connection ? t('shell.tabs.queryPerformanceOn', { connection }) : t('shell.tabs.queryPerformance');
		case 'security': return connection ? t('shell.tabs.usersOn', { connection }) : t('shell.tabs.users');
		case 'chOps': return connection ? t('shell.tabs.operationsOn', { connection }) : t('shell.tabs.operations');
		case 'chRemote': return connection ? t('shell.tabs.remoteDataOn', { connection }) : t('shell.tabs.remoteData');
		case 'projectCopy': return t('shell.tabs.copy', { name: tab.title.replace(/^Copy /, '') });
		case 'table': return tab.title === 'New table' ? t('shell.tabs.newTable') : tab.title;
		default: {
			const untitled = /^Untitled-(\d+)$/.exec(tab.title);
			return untitled ? t('shell.tabs.untitled', { number: untitled[1] }) : tab.title;
		}
	}
}

interface TabBarProps {
	tabs: EditorTab[];
	activeTabId: string | null;
	/** Connections + which are live, so each tab can show its connection dot. */
	connections: ConnectionConfig[];
	connectedIds: string[];
	onSelect(id: string): void;
	onClose(id: string): void;
	onNew(): void;
	/** Drag-reorder: move `fromId` to where `toId` currently sits. */
	onReorder(fromId: string, toId: string): void;
}

/** VSCode-style editor tab strip: switch, close, new, and drag to reorder. */
export function TabBar({ tabs, activeTabId, connections, connectedIds, onSelect, onClose, onNew, onReorder }: TabBarProps): JSX.Element {
	const t = useT();
	const [dragId, setDragId] = useState<string | null>(null);
	const [overId, setOverId] = useState<string | null>(null);

	return (
		<div className="tabbar">
			{tabs.map((tab) => {
				const conn = tab.connectionId ? connections.find((c) => c.id === tab.connectionId) : undefined;
				const connConnected = tab.connectionId !== undefined && connectedIds.includes(tab.connectionId);
				const label = tabLabel(tab, connections, t);
				const tip = conn ? `${tab.filePath ?? label} · ${conn.label}${connConnected ? '' : ` (${t('shell.tabs.notConnected')})`}` : (tab.filePath ?? label);
				return (
				<div
					key={tab.id}
					className={`tab-item${tab.id === activeTabId ? ' active' : ''}${tab.attention ? ' attention' : ''}${overId === tab.id && dragId !== tab.id ? ' drop-target' : ''}`}
					draggable
					onClick={() => onSelect(tab.id)}
					title={tip}
					onDragStart={(e) => { setDragId(tab.id); e.dataTransfer.effectAllowed = 'move'; }}
					onDragOver={(e) => { if (dragId && dragId !== tab.id) { e.preventDefault(); setOverId(tab.id); } }}
					onDragLeave={() => setOverId((cur) => (cur === tab.id ? null : cur))}
					onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== tab.id) { onReorder(dragId, tab.id); } setDragId(null); setOverId(null); }}
					onDragEnd={() => { setDragId(null); setOverId(null); }}
				>
					{tab.kind === 'table' && <Icon name="table" className="tab-icon" />}
					{tab.kind === 'object' && <Icon name="symbol-method" className="tab-icon" />}
					{tab.kind === 'schemaSync' && <Icon name="git-compare" className="tab-icon" />}
					{tab.kind === 'security' && <Icon name="shield" className="tab-icon" />}
					{tab.kind === 'chOps' && <Icon name="server-process" className="tab-icon" />}
					{tab.kind === 'chRemote' && <Icon name="globe" className="tab-icon" />}
					{tab.kind === 'workload' && <Icon name="pulse" className="tab-icon" />}
					{tab.kind === 'flow' && <Icon name="arrow-swap" className="tab-icon" />}
					{tab.kind === 'move' && <Icon name="arrow-both" className="tab-icon" />}
					{tab.kind === 'vectorSearch' && <Icon name="search" className="tab-icon" />}
					{tab.kind === 'review' && <Icon name="git-pull-request" className="tab-icon" />}
					{tab.kind === 'cloudProject' && <Icon name="cloud" className="tab-icon" />}
					{tab.kind === 'projectCopy' && <Icon name={tab.copySource?.kind === 'local' ? 'cloud-upload' : 'cloud-download'} className="tab-icon" />}
					{(tab.kind === 'localSetup' || tab.kind === 'localProject') && <Icon name="device-desktop" className="tab-icon" />}
					{tab.kind === 'agentView' && <Icon name={tab.agent ? agentDescriptor(tab.agent).icon : 'preview'} className="tab-icon" />}
					{(tab.kind === undefined || tab.kind === 'sql') && tab.surface === 'native' && <Icon name="json" className="tab-icon" />}
					<span className={`tab-title${conn ? (conn.environment === 'prod' ? ' conn-prod' : connConnected ? ' conn-on' : '') : ''}`}>{label}</span>
					<span
						className={`tab-close${tab.dirty ? ' dirty' : ''}`}
						title={t('shell.common.close')}
						onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
					>
						<Icon name={tab.dirty ? 'circle-filled' : 'close'} />
					</span>
				</div>
				);
			})}
			<button className="icon-btn tab-new" aria-label={t('shell.tabs.newQuery', { shortcut: formatShortcut('Mod+N') })} onClick={onNew}><Icon name="add" /></button>
		</div>
	);
}

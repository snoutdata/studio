/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../../shared/assistant';
import { useRef } from 'react';
import { Icon } from './Icon';
import { useHoverTip } from './HoverTip';
import { ManageMenu } from './ManageMenu';
import type { SideView } from '../layout';
import type { ToolId } from '../docking';
import type { ActivityBarPosition } from '../appSettings';
import type { Theme } from '../theme';
import type { AgentKind } from '../../../shared/agentConsole';

interface ActivityBarProps {
	position: ActivityBarPosition;
	/**
	 * The tools showing right now, wherever they are docked. The bar is the switcher for every
	 * tool window, so an icon highlights when its tool is on screen — it deliberately does not
	 * know or care which area that is.
	 */
	visibleTools: ToolId[];
	/** Unread notification count, shown as a badge on the bell. */
	notificationCount: number;
	/**
	 * Items waiting for the user to check, badged on Data flows (0 when there are none, and always
	 * 0 in a build without Data Flows). A badge on the view that owns the work is the smallest honest
	 * way to say "there is something here".
	 */
	reviewCount: number;
	/** Show the Agent (MCP) log view icon (only when agent access is enabled). */
	/**
	 * Show Snoutbot's icon, which means a host has been connected or a repository is watched.
	 *
	 * Gated for the same reason the tray's line is: an icon for a feature somebody has never heard
	 * of is an advertisement in the window chrome, and the bar is already the busiest strip in the
	 * app. Once it IS set up the icon is the point, because a review is written while the user is
	 * somewhere else entirely.
	 */
	showSnoutbot: boolean;
	/** Reviews written and waiting to be read before they post, badged on that icon. */
	snoutbotAwaiting: number;
	/**
	 * The coding agents to offer: installed on this machine and not switched off.
	 * Empty for a user with none, which is the common case, so the bar does not grow an
	 * icon for a feature they cannot use.
	 */
	agents: Array<{ kind: AgentKind; label: string; icon: string }>;
	/** Right-click on a tool's icon: the same "move this panel" menu its header offers. */
	onToolMenu(tool: ToolId, x: number, y: number): void;
	/** Dragging a tool's icon drops its panel wherever the pointer lands. */
	onToolDragStart(tool: ToolId, event: React.PointerEvent): void;
	/** Open (or focus) that agent's console. */
	onOpenAgent(kind: AgentKind): void;
	/** Open (or focus) Snoutbot's reviews. */
	onOpenReviews(): void;
	/** The active theme id (for the Manage menu's Color Theme submenu). */
	theme: Theme;
	onSelectView(view: SideView): void;
	onOpenMonitors(): void;
	/** Open Move Database. */
	onOpenMove(): void;
	/** Open Snout Orbit: the workbench tab AND its docked controls. */
	onOpenOrbit(): void;
	/** Liby, the assistant: shows or hides it docked. Its full view is reached from its own
	 *  header (or the palette), so there is one icon for one assistant. */
	onToggleChat(): void;
	onOpenNotifications(): void;
	onOpenSettings(): void;
	onSelectTheme(id: Theme): void;
}

/*
 * Every icon has to be readable as ONE THING at 16px, in a vertical strip, with no label. That
 * rules out most of the clever ones: `arrow-swap` on Data flows read as "exchange these two"
 * rather than "move data from A to B", and `remote` on the Agent log read as nothing at all (it
 * is VSCode's remote-explorer glyph, which means "another machine" only if you already knew).
 * The pairs that must never be confusable are workspace-vs-connections and flows-vs-history.
 */
const VIEWS: Array<{ id: SideView; icon: string; title: string }> = [
	{ id: 'connections', icon: 'database', title: 'Connections' },
	// A folder, not a page: this view is a folder of .sql scripts on disk, and a page is what a
	// single open file looks like everywhere else in the app.
	{ id: 'workspace', icon: 'folder', title: 'Workspace files' },
	{ id: 'history', icon: 'history', title: 'Query history & saved' },
	// The user's SnoutData projects, local and cloud. Tiles, not the Codicon `dashboard`, which is
	// a speedometer and means speed everywhere else in the app (Glyph.tsx says more).
	{ id: 'dashboard', icon: 'glyph:dashboard', title: 'Dashboard' },
	// Two streams merging into one: a flow is source(s) -> transform -> destination.
	{ id: 'flows', icon: 'combine', title: 'Data flows' },
];

// The Agent (MCP) log has no icon here, to save the strip's space: it opens from the palette
// ("Show Agent (MCP) Log") while agent access is on, and keeps its docked panel.

/**
 * VSCode-style activity bar: big icons that switch the left side bar between views
 * (connections / history) and toggle the assistant. Renders as a vertical left strip or
 * a horizontal top row depending on `position`; the layout/CSS handle the orientation.
 */
export function ActivityBar(props: ActivityBarProps): JSX.Element {
	const views = VIEWS;
	const showing = (id: ToolId): boolean => props.visibleTools.includes(id);
	const menu = (tool: ToolId) => (event: React.MouseEvent): void => {
		event.preventDefault();
		props.onToolMenu(tool, event.clientX, event.clientY);
	};
	// The icon is a button first: this only becomes a drag once the pointer has moved, so a
	// plain click still just opens the panel.
	const drag = (tool: ToolId) => (event: React.PointerEvent): void => props.onToolDragStart(tool, event);
	// Every icon says what it is on hover, from its aria-label (HoverTip.tsx says why not `title`).
	const barRef = useRef<HTMLDivElement>(null);
	const tip = useHoverTip(barRef, '.activity-item', props.position === 'top' ? 'below' : 'beside');
	return (
		<div ref={barRef} className={`activity-bar activity-${props.position}`} data-tour="activity-bar">
			{tip}
			<div className="activity-group">
				{views.map((item) => {
					// Quiet rather than red: work waiting is not a failure, and the bell's badge means
					// something went wrong.
					const badge = item.id === 'flows' && props.reviewCount > 0 ? props.reviewCount : 0;
					return (
						<button
							key={item.id}
							className={`activity-item${showing(item.id) ? ' active' : ''}`}
							aria-label={badge > 0 ? `${item.title}: ${badge.toLocaleString()} reading${badge === 1 ? '' : 's'} the extraction model left for you to check` : item.title}
							onClick={() => props.onSelectView(item.id)}
							onContextMenu={menu(item.id)}
							onPointerDown={drag(item.id)}
						>
							<Icon name={item.icon} />
							{badge > 0 && <span className="activity-badge quiet" data-badge="review">{badge > 99 ? '99+' : badge}</span>}
						</button>
					);
				})}
				<button
					className="activity-item"
					aria-label="Monitors"
					onClick={props.onOpenMonitors}
				>
					<Icon name="graph-line" />
				</button>
				{/* With Monitors for the same reason Snoutbot is: it opens a workbench tab, not a
				    side panel. Two arrows between two places, the glyph its tab carries. */}
				<button
					className="activity-item"
					aria-label="Move a database"
					onClick={props.onOpenMove}
				>
					<Icon name="arrow-both" />
				</button>
				{props.showSnoutbot && (
					// A pull request, because that is literally what it reads. It sits with Monitors
					// rather than with the side views: both open a WORKBENCH TAB, so neither has a
					// docked panel to highlight, and putting it among the views would promise a side
					// panel that does not exist.
					<button
						className="activity-item"
						aria-label={props.snoutbotAwaiting > 0
							? `Snoutbot: ${props.snoutbotAwaiting} review${props.snoutbotAwaiting === 1 ? '' : 's'} waiting for you to read`
							: 'Snoutbot reviews'}
						onClick={props.onOpenReviews}
					>
						<Icon name="git-pull-request" />
						{/* Amber, like the tray's dot for the same state: a review nobody has read is
						    the app HOLDING something, not a failure. The bell's badge means an error. */}
						{props.snoutbotAwaiting > 0 && (
							<span className="activity-badge quiet" data-badge="snoutbot">
								{props.snoutbotAwaiting > 99 ? '99+' : props.snoutbotAwaiting}
							</span>
						)}
					</button>
				)}
				<button
					className={`activity-item${showing('assistant') ? ' active' : ''}`}
					aria-label={ASSISTANT_NAME}
					data-tool="assistant"
					onClick={props.onToggleChat}
					onContextMenu={menu('assistant')}
					onPointerDown={drag('assistant')}
				>
					<Icon name="sparkle" />
				</button>
				{/* A spiral galaxy, and the one bespoke glyph in this strip (see Glyph.tsx). The
				    Codicon set has nothing that says "a database drawn as a world": it was
				    `graph-scatter`, which is a scatter PLOT and read as one more analysis view, then
				    `compass`, which says "navigation" without saying what you are navigating. Not
				    `globe` (that reads as the internet), not `circuit-board` (the agent tooling).
				    Orbit is the one entry here that opens a workbench tab AND a docked panel, so it
				    highlights off the panel like a view rather than off nothing like Monitors. */}
				<button
					className={`activity-item${showing('orbit') ? ' active' : ''}`}
					aria-label="Orbit: this database in 3D"
					onClick={props.onOpenOrbit}
					onContextMenu={menu('orbit')}
					onPointerDown={drag('orbit')}
				>
					<Icon name="glyph:galaxy" />
				</button>
			</div>
			{props.agents.length > 0 && (
				// The coding agents are a group of their own, under a rule: they are somebody else's
				// programs running inside our window, not another view of the user's data, and the
				// activity bar should not pretend otherwise.
				<div className="activity-group activity-agents">
					{props.agents.map((agent) => (
						<button
							key={agent.kind}
							className={`activity-item${showing(`agent:${agent.kind}`) ? ' active' : ''}`}
							aria-label={`${agent.label} console`}
							onClick={() => props.onOpenAgent(agent.kind)}
							onContextMenu={menu(`agent:${agent.kind}`)}
							onPointerDown={drag(`agent:${agent.kind}`)}
						>
							<Icon name={agent.icon} />
						</button>
					))}
				</div>
			)}
			<div className="activity-group activity-bottom">
				<button className="activity-item" aria-label="Notifications" onClick={props.onOpenNotifications}>
					<Icon name={props.notificationCount > 0 ? 'bell-dot' : 'bell'} />
					{props.notificationCount > 0 && <span className="activity-badge">{props.notificationCount > 99 ? '99+' : props.notificationCount}</span>}
				</button>
				<ManageMenu
					position={props.position}
					theme={props.theme}
					onSelectTheme={props.onSelectTheme}
					onOpenSettings={props.onOpenSettings}
				/>
			</div>
		</div>
	);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dockable panels: which tool window sits in which area, which one that area is showing, how
// big it is. This file is the whole rule set, and it is pure — no React, no DOM, no storage —
// so the invariants are asserted in `docking.test.ts` rather than reasoned about while
// reading JSX.
//
// The one rule everything else follows from: a tool is in EXACTLY ONE area. Every operation
// here removes before it adds, so there is no state in which two areas both claim a tool and
// no way to write one.

import { ASSISTANT_NAME } from '../../shared/assistant';
import { AGENTS, type AgentKind } from '../../shared/agentConsole';

/** The three edges a tool window can occupy. No top (that is the title/activity bar) and no
 *  floating windows. */
export type DockArea = 'left' | 'right' | 'bottom';

export const DOCK_AREAS: DockArea[] = ['left', 'right', 'bottom'];

/** A movable panel. The editor and its results grid are deliberately NOT in this union. */
export type ToolId =
	| 'connections'
	| 'workspace'
	| 'flows'
	| 'history'
	| 'mcplog'
	| 'dashboard'
	| 'orbit'
	| 'assistant'
	| `agent:${AgentKind}`;

export interface AreaState {
	/** Tabs in this area, left to right (top to bottom for a vertical strip). */
	tools: ToolId[];
	/** The tab being shown. Always a member of `tools`, or null when the area is empty. */
	active: ToolId | null;
	/** Width for left/right, height for bottom. */
	size: number;
	/** Shown as a collapsed strip rather than removed: the tabs stay, the body does not. */
	collapsed: boolean;
}

export type DockLayout = Record<DockArea, AreaState>;

/** What a tool is called in a menu, a palette entry or a tab. */
export function toolLabel(id: ToolId): string {
	if (id.startsWith('agent:')) {
		const kind = id.slice('agent:'.length) as AgentKind;
		return AGENTS[kind]?.label ?? kind;
	}
	switch (id) {
		case 'connections': return "Connections";
		case 'workspace': return "Workspace files";
		case 'flows': return "Data flows";
		case 'history': return "Query history";
		case 'mcplog': return "Agent log";
		case 'dashboard': return "Dashboard";
		case 'orbit': return "Orbit controls";
		case 'assistant': return ASSISTANT_NAME;
		default: return id;
	}
}

export function areaLabel(area: DockArea): string {
	switch (area) {
		case 'left': return "Left";
		case 'right': return "Right";
		case 'bottom': return "Bottom";
	}
}

/** Every tool the app knows about, in the order a fresh install stacks them. */
export const ALL_TOOLS: ToolId[] = [
	'connections', 'workspace', 'history', 'dashboard', 'flows', 'mcplog', 'orbit',
	'assistant',
	...(Object.keys(AGENTS) as AgentKind[]).map((k) => `agent:${k}` as ToolId),
];

/** Where a tool starts life, and where "Reset panel layout" puts it back. */
export const HOME_AREA: Record<ToolId, DockArea> = ALL_TOOLS.reduce((acc, id) => {
	acc[id] = id === 'assistant' ? 'right' : id.startsWith('agent:') ? 'bottom' : 'left';
	return acc;
}, {} as Record<ToolId, DockArea>);

/** Per-area floor, for an area showing nothing in particular. The max is a function of the
 *  window, so a layout persisted on a 4K monitor cannot open a 900px sidebar on a laptop
 *  (invariant 3). */
export const AREA_MIN: Record<DockArea, number> = { left: 180, right: 260, bottom: 120 };

/**
 * What each tool needs to still be USABLE, as opposed to merely present.
 *
 * The area's floor is not enough on its own: an assistant squeezed into a 120px bottom strip is
 * a composer with no conversation above it, and a terminal three rows tall is not a terminal.
 * The minimum therefore depends on what the area is SHOWING, and it changes as the user switches
 * tools within an area. Panels that are just lists are happy at the area floor.
 */
const TOOL_MIN: Partial<Record<ToolId, { width: number; height: number }>> = {
	assistant: { width: 300, height: 220 },
};

for (const kind of Object.keys(AGENTS) as AgentKind[]) {
	// A terminal wants columns before anything else: wrapped at 40 columns, an agent's own TUI
	// stops being readable. The height floor is about a dozen rows.
	TOOL_MIN[`agent:${kind}`] = { width: 340, height: 180 };
}

/** The smallest this area may be dragged while it is showing this tool. */
export function minSizeFor(area: DockArea, tool: ToolId | null): number {
	const floor = AREA_MIN[area];
	const need = tool ? TOOL_MIN[tool] : undefined;
	if (!need) {
		return floor;
	}
	return Math.max(floor, area === 'bottom' ? need.height : need.width);
}

export function areaMax(area: DockArea, windowWidth: number, windowHeight: number): number {
	return area === 'bottom'
		? Math.max(AREA_MIN.bottom, windowHeight - 200)
		: Math.max(AREA_MIN[area], Math.round(windowWidth * 0.6));
}

/** The default layout reproduces exactly what the app did before it had areas: side views left
 *  showing connections, the assistant OPEN on the right (it was `useState(true)`, so every launch
 *  had it out), agent consoles bottom and closed. Nothing moves until the user moves it. */
export const DEFAULT_DOCKS: DockLayout = {
	left: { tools: ['connections', 'workspace', 'history', 'dashboard', 'flows', 'mcplog', 'orbit'], active: 'connections', size: 280, collapsed: false },
	right: { tools: ['assistant'], active: 'assistant', size: 320, collapsed: false },
	bottom: { tools: ALL_TOOLS.filter((t) => t.startsWith('agent:')), active: null, size: 300, collapsed: false },
};

function cloneArea(a: AreaState): AreaState {
	return { tools: [...a.tools], active: a.active, size: a.size, collapsed: a.collapsed };
}

export function cloneDocks(docks: DockLayout): DockLayout {
	return { left: cloneArea(docks.left), right: cloneArea(docks.right), bottom: cloneArea(docks.bottom) };
}

/**
 * Tools whose panel is nothing but a workbench tab's controls, and which therefore must never be
 * RESTORED as an area's active tool.
 *
 * Orbit is the only one. Its panel holds no state of its own — every control in it is portalled in
 * from the Orbit tab — so a restored layout pointing at it opens the app on an empty pane whose
 * only content is a sentence telling you to go and open Orbit. The Data Flows panel is the
 * contrast: it lists the user's flows and is useful with no wizard open.
 *
 * It is also what keeps the auto-open in `OrbitRailPanel` off the boot path: a launch never shows
 * that panel, so it never asks for the tab, so three.js is never fetched during startup, and
 * `e2e/startup.spec.ts` is the standing guard on it.
 */
const NEEDS_A_TAB: readonly ToolId[] = ['orbit'];

/** Tools that were renamed, so a layout saved before keeps them where the user put them. */
const RENAMED_TOOLS: Readonly<Record<string, ToolId>> = {
	// The Projects panel became the Dashboard (2026-10-01), the name the online one has.
	cloud: 'dashboard',
};

function renamed(id: ToolId): ToolId {
	return RENAMED_TOOLS[id] ?? id;
}

/**
 * Make any blob safe to render: drop tools we no longer know (invariant 4), de-duplicate a
 * tool that somehow landed in two areas, give every known tool a home (invariant 5), and pin
 * `active` to a tab that is really there (invariant 2).
 *
 * This runs on every load, so a layout written by a newer version, or one naming an agent that
 * has since been removed, degrades to something usable instead of stranding a tab.
 */
export function normalise(input: Partial<DockLayout> | undefined): DockLayout {
	const out = {} as DockLayout;
	const seen = new Set<ToolId>();
	for (const area of DOCK_AREAS) {
		const src = input?.[area];
		const tools: ToolId[] = [];
		for (const id of (src?.tools ?? []).map(renamed)) {
			if (!ALL_TOOLS.includes(id) || seen.has(id)) { continue; }
			seen.add(id);
			tools.push(id);
		}
		const fallback = DEFAULT_DOCKS[area];
		const active = src?.active ? renamed(src.active) : null;
		const restored = active && tools.includes(active) ? active : null;
		out[area] = {
			tools,
			// A tool that cannot stand without its tab hands the area back to whatever the area
			// opens on by default, rather than to nothing: an empty side bar on launch is not an
			// improvement on an empty panel.
			active: restored && NEEDS_A_TAB.includes(restored)
				? (fallback.active && tools.includes(fallback.active) ? fallback.active : null)
				: restored,
			size: typeof src?.size === 'number' && Number.isFinite(src.size) ? Math.max(AREA_MIN[area], Math.round(src.size)) : fallback.size,
			collapsed: src?.collapsed === true,
		};
	}
	// Anything the persisted layout never mentioned goes home, so a tool added in a later
	// version appears instead of vanishing.
	for (const id of ALL_TOOLS) {
		if (!seen.has(id)) { out[HOME_AREA[id]].tools.push(id); }
	}
	return out;
}

export function placementOf(docks: DockLayout, id: ToolId): DockArea {
	for (const area of DOCK_AREAS) {
		if (docks[area].tools.includes(id)) { return area; }
	}
	return HOME_AREA[id];
}

/**
 * Where a coding agent's OWN surface goes: the thing it draws with `show_in_app`.
 *
 * It follows the console, because the console is the agent, and the same content wants a different
 * shape in each place:
 *
 * - **bottom** ⇒ `'tab'`. The bottom area is a strip a few hundred pixels tall. Stacking a reading
 *   surface on top of a terminal there leaves neither usable, so what the agent draws opens as its
 *   own tab in the workbench, beside the SQL editor, exactly like the Data Flow wizard.
 * - **left / right** ⇒ `'panel'`. A side dock is tall and narrow, which is the assistant's shape,
 *   so the agent gets the assistant's arrangement: its thread above, its composer (the terminal)
 *   below.
 *
 * It is deliberately ONE destination, derived rather than chosen: the same push rendered in two
 * places is two things to dismiss and two places to look.
 */
export function agentSurfaceHome(docks: DockLayout, kind: AgentKind): 'panel' | 'tab' {
	return placementOf(docks, `agent:${kind}`) === 'bottom' ? 'tab' : 'panel';
}

/** Is this tool the one its area is currently showing? */
export function isToolVisible(docks: DockLayout, id: ToolId): boolean {
	const area = docks[placementOf(docks, id)];
	return area.active === id && !area.collapsed;
}

/** The tool each area is showing, or null. Areas with nothing active render as no pane at all. */
export function visibleTools(docks: DockLayout): Record<DockArea, ToolId | null> {
	return {
		left: docks.left.collapsed ? null : docks.left.active,
		right: docks.right.collapsed ? null : docks.right.active,
		bottom: docks.bottom.collapsed ? null : docks.bottom.active,
	};
}

/** Show a tool wherever it lives, un-collapsing its area. */
export function showTool(docks: DockLayout, id: ToolId): DockLayout {
	const next = cloneDocks(docks);
	const area = next[placementOf(next, id)];
	area.active = id;
	area.collapsed = false;
	return next;
}

/** Hide a tool: its area stops showing anything. The tab stays, so the icon brings it back. */
export function hideTool(docks: DockLayout, id: ToolId): DockLayout {
	const next = cloneDocks(docks);
	const area = next[placementOf(next, id)];
	if (area.active === id) { area.active = null; }
	return next;
}

/**
 * Clear the docks so a whole-screen job (the Data Flow wizard) has the room, keeping ONE tool.
 *
 * `keep` is whoever opened the job and is about to talk the user through it. An agent that opens
 * the wizard and is then hidden by the act of opening it leaves the user on a screen they did not
 * open with nobody to ask, which is worse than a narrower wizard. It is only ever kept if it was
 * already showing: opening a panel the user had closed is the other way to take their screen.
 *
 * Nothing is forgotten here. The caller keeps the layout it was handed and puts it back.
 */
export function focusWorkbench(docks: DockLayout, keep?: ToolId): DockLayout {
	let next = docks;
	for (const area of DOCK_AREAS) {
		const active = next[area].active;
		if (active && active !== keep) {
			next = hideTool(next, active);
		}
	}
	return next;
}

/** What an activity-bar icon does: show it, or put it away if it is already the one showing.
 *  Same toggle the sidebar and the console icons had before areas existed. */
export function toggleTool(docks: DockLayout, id: ToolId): DockLayout {
	return isToolVisible(docks, id) ? hideTool(docks, id) : showTool(docks, id);
}

/**
 * Move a tool to another area and show it there. Removing before adding is what keeps
 * invariant 1 true; promoting a neighbour is what keeps invariant 2 true in the area it left.
 */
export function moveTool(docks: DockLayout, id: ToolId, to: DockArea): DockLayout {
	const from = placementOf(docks, id);
	if (from === to) { return docks; }
	const next = cloneDocks(docks);
	const source = next[from];
	const wasActive = source.active === id;
	source.tools = source.tools.filter((t) => t !== id);
	if (wasActive) { source.active = null; }
	const target = next[to];
	target.tools = [...target.tools, id];
	target.active = id;
	target.collapsed = false;
	return next;
}

/**
 * A tool has become unavailable while docked: an agent switched off in Settings, the Agent log
 * with agent access turned off. If it was the one on screen, its neighbour takes over — the first
 * tool in that area that is still available — and if there is none, the area simply closes.
 *
 * The tab is NOT removed. Availability comes and goes (turn the agent back on, turn access back
 * on) and `normalise` would put the tool back on the next load anyway; what matters is that no
 * area is left showing something that is not there.
 */
export function dropTool(docks: DockLayout, tool: ToolId, isAvailable: (candidate: ToolId) => boolean): DockLayout {
	const area = placementOf(docks, tool);
	if (docks[area].active !== tool) {
		return docks;
	}
	const next = cloneDocks(docks);
	next[area].active = next[area].tools.find((candidate) => candidate !== tool && isAvailable(candidate)) ?? null;
	return next;
}

/** Reorder within an area (drag a tab past its neighbours). Out-of-range indexes clamp. */
export function reorderTool(docks: DockLayout, id: ToolId, index: number): DockLayout {
	const area = placementOf(docks, id);
	const next = cloneDocks(docks);
	const tools = next[area].tools.filter((t) => t !== id);
	const at = Math.max(0, Math.min(tools.length, Math.round(index)));
	tools.splice(at, 0, id);
	next[area].tools = tools;
	return next;
}

export function resizeArea(docks: DockLayout, area: DockArea, size: number, windowWidth: number, windowHeight: number): DockLayout {
	const next = cloneDocks(docks);
	const max = areaMax(area, windowWidth, windowHeight);
	// The floor follows what is SHOWING, so dragging the assistant's edge stops where the assistant
	// stops being usable, not where a list would have.
	const min = Math.min(minSizeFor(area, next[area].active), max);
	next[area].size = Math.max(min, Math.min(max, Math.round(size)));
	return next;
}

export function setCollapsed(docks: DockLayout, area: DockArea, collapsed: boolean): DockLayout {
	const next = cloneDocks(docks);
	next[area].collapsed = collapsed;
	return next;
}

/** The shape of the flat, pre-docking layout fields, for the one-way migration in `layout.ts`. */
export interface LegacyPlacement {
	sidebarWidth?: number;
	sidebarCollapsed?: boolean;
	sideView?: string;
	chatWidth?: number;
	consoleHeight?: number;
	consoleCollapsed?: boolean;
	consoleKind?: string;
	consoleOpen?: boolean;
}

/**
 * Carry a pre-docking layout forward: sizes, which side view was selected, whether the console
 * was open and on which agent.
 */
export function migrateLegacy(legacy: LegacyPlacement | undefined): DockLayout {
	const docks = cloneDocks(DEFAULT_DOCKS);
	if (!legacy) { return docks; }
	if (typeof legacy.sidebarWidth === 'number') { docks.left.size = Math.max(AREA_MIN.left, Math.round(legacy.sidebarWidth)); }
	if (typeof legacy.chatWidth === 'number') { docks.right.size = Math.max(AREA_MIN.right, Math.round(legacy.chatWidth)); }
	if (typeof legacy.consoleHeight === 'number') { docks.bottom.size = Math.max(AREA_MIN.bottom, Math.round(legacy.consoleHeight)); }

	// The assistant's open/closed state was React state rather than persisted layout, and it
	// defaulted to OPEN, so that is what a migrated layout gets: the app a user closes is the app
	// they reopen.
	docks.right.active = 'assistant';

	const view = legacy.sideView as ToolId | undefined;
	docks.left.active = view && docks.left.tools.includes(view) ? view : 'connections';
	docks.left.collapsed = legacy.sidebarCollapsed === true;

	if (legacy.consoleOpen === true) {
		const kind = `agent:${legacy.consoleKind ?? 'claude'}` as ToolId;
		docks.bottom.active = docks.bottom.tools.includes(kind) ? kind : docks.bottom.tools[0] ?? null;
		docks.bottom.collapsed = legacy.consoleCollapsed === true;
	}
	return docks;
}

/** A rectangle in viewport coordinates: the work band a drop is judged against. */
export interface DockRect { left: number; top: number; width: number; height: number }

/**
 * Which area a panel dropped at this point lands in, or null for "nowhere, leave it alone".
 *
 * Nearest edge wins, measured as a FRACTION of the band rather than in pixels, so the target
 * feels the same on a laptop and on a 4K monitor. The bands are deliberately generous: a drag
 * that ends in the middle of the editor is a cancel, not a guess.
 */
export function areaAtPoint(x: number, y: number, rect: DockRect): DockArea | null {
	const fromLeft = (x - rect.left) / rect.width;
	const fromRight = (rect.left + rect.width - x) / rect.width;
	const fromBottom = (rect.top + rect.height - y) / rect.height;
	if (fromLeft < 0 || fromRight < 0 || fromBottom < 0 || y < rect.top) {
		return null;
	}
	const candidates: Array<{ area: DockArea; distance: number }> = [];
	if (fromLeft <= 0.3) { candidates.push({ area: 'left', distance: fromLeft }); }
	if (fromRight <= 0.3) { candidates.push({ area: 'right', distance: fromRight }); }
	if (fromBottom <= 0.3) { candidates.push({ area: 'bottom', distance: fromBottom }); }
	if (candidates.length === 0) {
		return null;
	}
	return candidates.reduce((best, one) => (one.distance < best.distance ? one : best)).area;
}

/**
 * Is this the layout a fresh install opens with? Drives the "Reset panel layout" button, which
 * says so rather than sitting there offering to undo nothing. Compares placement, what each area
 * is showing and each area's size — a collapsed area counts as moved, since the user did that.
 *
 * Membership, NOT order: `moveTool` appends, so moving a panel out of an area and back leaves it
 * last in the list, and nothing on screen shows that today (the activity bar is the switcher,
 * there is no tab strip). Calling an invisible difference "moved" would leave the reset button lit
 * after a change the user already undid. If tabs ever render, this has to compare order too.
 */
export function isDefaultLayout(docks: DockLayout): boolean {
	return DOCK_AREAS.every((area) => {
		const one = docks[area];
		const base = DEFAULT_DOCKS[area];
		return one.size === base.size
			&& one.collapsed === base.collapsed
			&& one.active === base.active
			&& one.tools.length === base.tools.length
			&& one.tools.every((tool) => base.tools.includes(tool));
	});
}

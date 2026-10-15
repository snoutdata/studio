/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../shared/assistant';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	ALL_TOOLS,
	AREA_MIN,
	DEFAULT_DOCKS,
	DOCK_AREAS,
	agentSurfaceHome,
	areaMax,
	cloneDocks,
	dropTool,
	focusWorkbench,
	minSizeFor,
	isDefaultLayout,
	hideTool,
	isToolVisible,
	migrateLegacy,
	moveTool,
	normalise,
	placementOf,
	reorderTool,
	resizeArea,
	setCollapsed,
	showTool,
	toggleTool,
	toolLabel,
	areaAtPoint,
	visibleTools,
	type DockLayout,
	type ToolId,
} from './docking';

function count(docks: DockLayout, id: ToolId): number {
	return DOCK_AREAS.filter((a) => docks[a].tools.includes(id)).length;
}

// --- invariant 1: a tool is in exactly one area -------------------------------

test('every tool starts in exactly one area', () => {
	for (const id of ALL_TOOLS) {
		assert.equal(count(DEFAULT_DOCKS, id), 1, `${id} is not in exactly one area`);
	}
});

test('moving a tool removes it from where it was', () => {
	const moved = moveTool(DEFAULT_DOCKS, 'agent:claude', 'right');
	assert.equal(count(moved, 'agent:claude'), 1);
	assert.equal(placementOf(moved, 'agent:claude'), 'right');
	assert.ok(!moved.bottom.tools.includes('agent:claude'));
	// The want in one line: Claude Code on the side, like the assistant.
	assert.ok(moved.right.tools.includes('assistant') && moved.right.tools.includes('agent:claude'));
});

test('moving is immutable and a move to the same area is a no-op', () => {
	const before = cloneDocks(DEFAULT_DOCKS);
	moveTool(DEFAULT_DOCKS, 'assistant', 'bottom');
	assert.deepEqual(DEFAULT_DOCKS, before, 'moveTool mutated its input');
	assert.equal(moveTool(DEFAULT_DOCKS, 'assistant', 'right'), DEFAULT_DOCKS);
});

// --- invariant 2: active is always a tool that is there ------------------------

test('a moved tool becomes active where it lands, and its old area shows nothing', () => {
	const docks = showTool(DEFAULT_DOCKS, 'agent:claude');
	assert.equal(docks.bottom.active, 'agent:claude');
	const moved = moveTool(docks, 'agent:claude', 'right');
	assert.equal(moved.right.active, 'agent:claude');
	assert.equal(moved.bottom.active, null);
});

test('a non-active tool moving out leaves its old area alone', () => {
	const docks = showTool(DEFAULT_DOCKS, 'connections');
	const moved = moveTool(docks, 'history', 'right');
	assert.equal(moved.left.active, 'connections');
});

test('normalise refuses an active tool that is not in the area', () => {
	const docks = normalise({ left: { tools: ['connections'], active: 'history', size: 280, collapsed: false } });
	assert.equal(docks.left.active, null);
});

test('normalise never restores Orbit as the active tool, and hands the area back to its default', () => {
	// Orbit's panel is its TAB's controls and nothing else, and the tab is not restored, so a
	// layout pointing at it would open the app on an empty pane. It would also load three.js
	// during startup, which must never happen.
	const docks = normalise({
		left: { tools: ['connections', 'orbit'], active: 'orbit', size: 280, collapsed: false },
	});
	assert.equal(docks.left.active, 'connections');
	// The TAB stays in the area: it is only ever refused as the thing shown on launch.
	assert.ok(docks.left.tools.includes('orbit'));
});

test('normalise leaves Orbit alone when it was not the active tool', () => {
	const docks = normalise({
		left: { tools: ['connections', 'orbit'], active: 'connections', size: 280, collapsed: false },
	});
	assert.equal(docks.left.active, 'connections');
});

// --- invariant 3: sizes are clamped -------------------------------------------

test('an area cannot be dragged below its minimum or past the window', () => {
	const tiny = resizeArea(DEFAULT_DOCKS, 'left', 10, 1440, 900);
	assert.equal(tiny.left.size, AREA_MIN.left);
	const huge = resizeArea(DEFAULT_DOCKS, 'left', 5000, 1440, 900);
	assert.equal(huge.left.size, areaMax('left', 1440, 900));
	const tall = resizeArea(DEFAULT_DOCKS, 'bottom', 5000, 1440, 900);
	assert.equal(tall.bottom.size, 700);
});

test('a size persisted on a big monitor is clamped by the small one it opens on', () => {
	const wide = resizeArea(DEFAULT_DOCKS, 'right', 1200, 3840, 2160);
	assert.equal(wide.right.size, 1200, 'a big monitor allows it');
	const onLaptop = resizeArea(wide, 'right', wide.right.size, 1280, 800);
	assert.equal(onLaptop.right.size, 768);
});

// --- invariants 4 + 5: unknown tools drop, known tools always have a home -------

test('an unknown tool id is dropped rather than rendered', () => {
	const docks = normalise({ left: { tools: ['connections', 'ftp-browser' as ToolId], active: 'ftp-browser' as ToolId, size: 280, collapsed: false } });
	assert.deepEqual(docks.left.tools.filter((t) => t === ('ftp-browser' as ToolId)), []);
	assert.equal(docks.left.active, null);
});

test('a tool the persisted layout never mentioned goes home', () => {
	const docks = normalise({ left: { tools: ['connections'], active: 'connections', size: 280, collapsed: false } });
	for (const id of ALL_TOOLS) {
		assert.equal(count(docks, id), 1, `${id} lost its home`);
	}
	assert.equal(placementOf(docks, 'assistant'), 'right');
	assert.equal(placementOf(docks, 'agent:claude'), 'bottom');
});

test('a tool claimed by two areas ends up in one', () => {
	const docks = normalise({
		left: { tools: ['connections', 'assistant'], active: 'assistant', size: 280, collapsed: false },
		right: { tools: ['assistant'], active: 'assistant', size: 320, collapsed: false },
	});
	assert.equal(count(docks, 'assistant'), 1);
	assert.equal(placementOf(docks, 'assistant'), 'left');
});

test('normalise survives an empty, absent or junk layout', () => {
	for (const input of [undefined, {} as DockLayout, { left: undefined } as unknown as DockLayout]) {
		const docks = normalise(input);
		for (const id of ALL_TOOLS) { assert.equal(count(docks, id), 1); }
	}
});

// --- showing, hiding, toggling -------------------------------------------------

test('the activity-bar toggle puts away the tool that is already showing', () => {
	const shown = toggleTool(DEFAULT_DOCKS, 'workspace');
	assert.ok(isToolVisible(shown, 'workspace'));
	const away = toggleTool(shown, 'workspace');
	assert.ok(!isToolVisible(away, 'workspace'));
	assert.ok(away.left.tools.includes('workspace'), 'hiding must not remove the tab');
});

test('showing a tool un-collapses the area it lives in', () => {
	const collapsed = { ...cloneDocks(DEFAULT_DOCKS), bottom: { ...DEFAULT_DOCKS.bottom, collapsed: true } };
	const shown = showTool(collapsed, 'agent:codex');
	assert.equal(shown.bottom.collapsed, false);
	assert.equal(shown.bottom.active, 'agent:codex');
});

test('a collapsed area shows nothing even with an active tab', () => {
	const docks = showTool(DEFAULT_DOCKS, 'agent:claude');
	const collapsed = { ...docks, bottom: { ...docks.bottom, collapsed: true } };
	assert.equal(visibleTools(collapsed).bottom, null);
	assert.ok(!isToolVisible(collapsed, 'agent:claude'));
});

test('the default layout is what the app did before it had areas', () => {
	const visible = visibleTools(DEFAULT_DOCKS);
	assert.equal(visible.left, 'connections');
	assert.equal(visible.right, 'assistant', 'the assistant is out at boot, as it always was');
	assert.equal(visible.bottom, null, 'the console starts closed');
});

test('hiding a tool that is not showing changes nothing', () => {
	const docks = showTool(DEFAULT_DOCKS, 'connections');
	assert.deepEqual(hideTool(docks, 'history'), docks);
});

// --- reordering ----------------------------------------------------------------

test('a tab can be dragged past its neighbours, and out-of-range clamps', () => {
	const first = reorderTool(DEFAULT_DOCKS, 'history', 0);
	assert.equal(first.left.tools[0], 'history');
	const last = reorderTool(DEFAULT_DOCKS, 'connections', 99);
	assert.equal(last.left.tools[last.left.tools.length - 1], 'connections');
	assert.equal(last.left.tools.length, DEFAULT_DOCKS.left.tools.length);
});

// --- the migration off the flat fields ------------------------------------------

test('a pre-docking layout carries its sizes and its selected view forward', () => {
	const docks = migrateLegacy({
		sidebarWidth: 420, sidebarCollapsed: false, sideView: 'flows',
		chatWidth: 500, consoleHeight: 260, consoleKind: 'codex', consoleOpen: true, consoleCollapsed: false,
	});
	assert.equal(docks.left.size, 420);
	assert.equal(docks.left.active, 'flows');
	assert.equal(docks.right.size, 500);
	assert.equal(docks.bottom.size, 260);
	assert.equal(docks.bottom.active, 'agent:codex');
});

test('a closed console migrates to a bottom area showing nothing', () => {
	const docks = migrateLegacy({ consoleOpen: false, consoleKind: 'claude' });
	assert.equal(docks.bottom.active, null);
	assert.ok(docks.bottom.tools.includes('agent:claude'), 'the tab is still there to open');
});

test('a collapsed sidebar migrates collapsed, and junk migrates to the default', () => {
	assert.equal(migrateLegacy({ sidebarCollapsed: true }).left.collapsed, true);
	const junk = migrateLegacy({ sideView: 'nonesuch', sidebarWidth: 4 });
	assert.equal(junk.left.active, 'connections');
	assert.equal(junk.left.size, AREA_MIN.left);
	assert.deepEqual(migrateLegacy(undefined), DEFAULT_DOCKS);
});

// --- labels ---------------------------------------------------------------------

test('an agent tool is labelled with the agent name, not its id', () => {
	assert.equal(toolLabel('agent:claude'), "Claude Code");
	assert.equal(toolLabel('assistant'), ASSISTANT_NAME);
	assert.equal(toolLabel('mcplog'), "Agent log");
});

// --- where a dragged panel lands ------------------------------------------------

test('a drop near an edge lands in that area, and the middle lands nowhere', () => {
	const rect = { left: 0, top: 0, width: 1000, height: 800 };
	assert.equal(areaAtPoint(40, 400, rect), 'left');
	assert.equal(areaAtPoint(960, 400, rect), 'right');
	assert.equal(areaAtPoint(500, 780, rect), 'bottom');
	assert.equal(areaAtPoint(500, 400, rect), null, 'the middle of the editor is a cancel');
});

test('a corner goes to the nearer edge, measured as a fraction of the band', () => {
	const rect = { left: 0, top: 0, width: 1000, height: 800 };
	// 20px from the left is 2% of the width; 40px from the bottom is 5% of the height.
	assert.equal(areaAtPoint(20, 760, rect), 'left');
	assert.equal(areaAtPoint(200, 790, rect), 'bottom');
});

test('the same fraction lands the same way on any size of window', () => {
	const laptop = { left: 0, top: 0, width: 1280, height: 720 };
	const big = { left: 0, top: 0, width: 3840, height: 2160 };
	assert.equal(areaAtPoint(1280 * 0.1, 360, laptop), areaAtPoint(3840 * 0.1, 1080, big));
	assert.equal(areaAtPoint(1280 * 0.5, 360, laptop), areaAtPoint(3840 * 0.5, 1080, big));
});

test('a point outside the band is not a drop target', () => {
	const rect = { left: 100, top: 100, width: 800, height: 600 };
	assert.equal(areaAtPoint(50, 400, rect), null);
	assert.equal(areaAtPoint(400, 50, rect), null);
	assert.equal(areaAtPoint(400, 900, rect), null);
});

// --- resetting ------------------------------------------------------------------

test('the default layout knows it is the default, and anything the user did shows', () => {
	assert.equal(isDefaultLayout(DEFAULT_DOCKS), true);
	assert.equal(isDefaultLayout(normalise(DEFAULT_DOCKS)), true, 'a round trip through storage is still default');
	assert.equal(isDefaultLayout(moveTool(DEFAULT_DOCKS, 'agent:claude', 'right')), false);
	assert.equal(isDefaultLayout(resizeArea(DEFAULT_DOCKS, 'left', 420, 1440, 900)), false);
	assert.equal(isDefaultLayout(showTool(DEFAULT_DOCKS, 'history')), false, 'a different view showing is a change');
	assert.equal(isDefaultLayout(setCollapsed(DEFAULT_DOCKS, 'bottom', true)), false);
});

test('showing what the default already shows is not a change', () => {
	assert.equal(isDefaultLayout(showTool(DEFAULT_DOCKS, 'connections')), true);
});

test('moving a panel and moving it back is not a change, even though the tab order differs', () => {
	const there = moveTool(DEFAULT_DOCKS, 'history', 'bottom');
	const back = hideTool(showTool(moveTool(there, 'history', 'left'), 'connections'), 'history');
	assert.equal(isDefaultLayout(back), true);
});

// --- what a tool needs to still be usable ----------------------------------------

test('the floor follows what the area is showing', () => {
	// A list is happy at the area floor; a terminal and a conversation are not.
	assert.equal(minSizeFor('left', 'connections'), AREA_MIN.left);
	assert.equal(minSizeFor('right', 'assistant'), 300);
	assert.equal(minSizeFor('right', 'agent:claude'), 340);
	assert.equal(minSizeFor('bottom', 'agent:claude'), 180, 'a terminal needs rows, not just pixels');
	assert.equal(minSizeFor('bottom', 'assistant'), 220);
	assert.equal(minSizeFor('bottom', null), AREA_MIN.bottom);
});

test('an area cannot be dragged below what its tool needs', () => {
	const withConsole = showTool(DEFAULT_DOCKS, 'agent:claude');
	assert.equal(resizeArea(withConsole, 'bottom', 10, 1440, 900).bottom.size, 180);
	// ...and the same area with a list in it goes lower, because a list can take it.
	const withList = showTool(moveTool(DEFAULT_DOCKS, 'history', 'bottom'), 'history');
	assert.equal(resizeArea(withList, 'bottom', 10, 1440, 900).bottom.size, AREA_MIN.bottom);
});

test('a tiny window still wins: the floor never exceeds what there is room for', () => {
	// 300px tall: the bottom area's max is its own floor, and the tool's minimum cannot push it
	// past that or the pane would be sized larger than the window.
	const withConsole = showTool(DEFAULT_DOCKS, 'agent:claude');
	const squeezed = resizeArea(withConsole, 'bottom', 900, 800, 300);
	assert.ok(squeezed.bottom.size <= areaMax('bottom', 800, 300));
});

// --- a tool that goes away while it is docked -------------------------------------

test('an agent switched off hands its area to the next one that is still there', () => {
	const docks = showTool(DEFAULT_DOCKS, 'agent:codex');
	const after = dropTool(docks, 'agent:codex', (tool) => tool !== 'agent:codex');
	assert.equal(after.bottom.active, 'agent:claude');
	assert.ok(after.bottom.tools.includes('agent:codex'), 'the tab stays: it can come back');
});

test('the last one going away closes the area rather than showing a ghost', () => {
	const docks = showTool(DEFAULT_DOCKS, 'agent:claude');
	const after = dropTool(docks, 'agent:claude', () => false);
	assert.equal(after.bottom.active, null);
});

test('a tool that was not on screen changes nothing', () => {
	const docks = showTool(DEFAULT_DOCKS, 'agent:claude');
	assert.equal(dropTool(docks, 'agent:codex', () => true), docks);
});

test('the agent log going away promotes a side view, not nothing', () => {
	const docks = showTool(DEFAULT_DOCKS, 'mcplog');
	const after = dropTool(docks, 'mcplog', (tool) => tool !== 'mcplog');
	assert.equal(after.left.active, 'connections');
});

test('focusWorkbench clears the docks for a whole-screen job', () => {
	const after = focusWorkbench(showTool(DEFAULT_DOCKS, 'agent:claude'));
	for (const area of DOCK_AREAS) {
		assert.equal(after[area].active, null, `${area} still shows something`);
	}
});

test('focusWorkbench keeps the one tool that opened the job', () => {
	// The agent that opened the wizard is the thing the user is about to ask "what now": hiding it
	// with the same click that opened the screen leaves them alone on a screen they did not open.
	const docks = showTool(DEFAULT_DOCKS, 'agent:claude');
	const after = focusWorkbench(docks, 'agent:claude');
	assert.equal(after.bottom.active, 'agent:claude');
	assert.equal(after.left.active, null, 'everything else still gives up its room');
	assert.equal(after.right.active, null);
});

test('focusWorkbench does not OPEN the companion, only spares it', () => {
	// A panel the user closed stays closed: opening one uninvited is the other way to take their
	// screen away from them.
	const after = focusWorkbench(DEFAULT_DOCKS, 'agent:claude');
	assert.equal(after.bottom.active, null);
});

test('focusWorkbench leaves the tabs alone, so the icons still bring everything back', () => {
	const after = focusWorkbench(DEFAULT_DOCKS, 'assistant');
	for (const area of DOCK_AREAS) {
		assert.deepEqual(after[area].tools, DEFAULT_DOCKS[area].tools);
	}
	assert.equal(after.right.active, 'assistant');
});

test('an agent surface follows its console: a tab from the bottom, a panel from a side', () => {
	// The rule the whole feature hangs on: a bottom strip cannot be a terminal and a reading
	// surface at once, so what the agent draws opens in the workbench instead; a side dock is
	// the assistant's shape, so it stacks like the assistant.
	assert.equal(agentSurfaceHome(DEFAULT_DOCKS, 'claude'), 'tab');
	assert.equal(agentSurfaceHome(moveTool(DEFAULT_DOCKS, 'agent:claude', 'right'), 'claude'), 'panel');
	assert.equal(agentSurfaceHome(moveTool(DEFAULT_DOCKS, 'agent:claude', 'left'), 'claude'), 'panel');
});

test('moving one console does not move another agent surface', () => {
	const docks = moveTool(DEFAULT_DOCKS, 'agent:claude', 'right');
	assert.equal(agentSurfaceHome(docks, 'claude'), 'panel');
	assert.equal(agentSurfaceHome(docks, 'codex'), 'tab');
});

test('a layout saved with the old Projects tool id keeps the panel where the user put it', () => {
	const docks = normalise({ right: { tools: ['assistant', 'cloud' as ToolId], active: 'cloud' as ToolId, size: 320, collapsed: false } });
	assert.ok(docks.right.tools.includes('dashboard'));
	assert.equal(docks.right.active, 'dashboard');
	assert.ok(!docks.left.tools.includes('dashboard'), 'moved, not duplicated into its home area');
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Fragment } from 'react';

import { Icon } from './Icon';
import { DOCK_AREAS, areaLabel, toolLabel, type DockArea, type DockRect, type ToolId } from '../docking';

/*
 * What a drag looks like while it is happening.
 *
 * Three versions got thrown away before this one, and the reasons are the design:
 *
 *  1. A translucent block a flat 30% of the window wide. Wrong for anyone who had resized.
 *  2. The same block at the area's real size. Still wrong: a block has to claim a SIZE, and the
 *     size depends on a layout that has not happened yet, so every version of it is a promise
 *     that can be broken.
 *  3. Three static chips whose arrows nudged on a loop. Honest, but an infinite animation is a
 *     distraction (continuous animation is for loading indicators only), and
 *     three things blinking at the edges is clutter, not an answer.
 *
 * What is here instead: the target EDGE lights up with a glow that bleeds inward, and it arrives
 * by sliding in from off-screen, so the movement is the answer to "which way is it going". Only
 * one is ever lit, and it crossfades when the pointer changes its mind, which is the spatial
 * continuity a drag is supposed to have. Nothing loops. The pill under the cursor carries what is
 * being dragged and where it will land, in words, so the motion is never the only place the
 * information lives.
 *
 * All of it is transform + opacity (composited), token-coloured, and flat under
 * `prefers-reduced-motion` (the glow still appears, it just does not travel).
 */

interface DockDropZonesProps {
	tool: ToolId;
	/** The work band, in viewport coordinates. */
	rect: DockRect;
	/** Where the pointer is: the pill tracks it in real time. */
	x: number;
	y: number;
	/** The area the drop would land in right now, if any. */
	over: DockArea | null;
}

/** The arrow points the way the panel is going. */
const ARROW: Record<DockArea, string> = { left: 'arrow-left', right: 'arrow-right', bottom: 'arrow-down' };

/** How far the glow bleeds in from its edge. Not a panel width: this is light, not a rectangle. */
const BLEED = 96;

function edgeStyle(area: DockArea, rect: DockRect): React.CSSProperties {
	switch (area) {
		case 'left':
			return { left: rect.left, top: rect.top, width: BLEED, height: rect.height };
		case 'right':
			return { left: rect.left + rect.width - BLEED, top: rect.top, width: BLEED, height: rect.height };
		case 'bottom':
			return { left: rect.left, top: rect.top + rect.height - BLEED, width: rect.width, height: BLEED };
	}
}

/** The hairline that marks a destination before it is chosen. */
function hairlineStyle(area: DockArea, rect: DockRect): React.CSSProperties {
	switch (area) {
		case 'left':
			return { left: rect.left, top: rect.top, width: 2, height: rect.height };
		case 'right':
			return { left: rect.left + rect.width - 2, top: rect.top, width: 2, height: rect.height };
		case 'bottom':
			return { left: rect.left, top: rect.top + rect.height - 2, width: rect.width, height: 2 };
	}
}

export function DockDropZones({ tool, rect, x, y, over }: DockDropZonesProps): JSX.Element {
	return (
		<div className="dock-drop-layer" aria-hidden="true">
			{DOCK_AREAS.map((area) => (
				<Fragment key={area}>
					<span className="dock-edge-hint" style={hairlineStyle(area, rect)} />
					<span
						className={`dock-edge dock-edge-${area}${over === area ? ' over' : ''}`}
						style={edgeStyle(area, rect)}
					/>
				</Fragment>
			))}
			<div className={`dock-drag-pill${over ? ' aimed' : ''}`} style={{ left: x + 16, top: y + 18 }}>
				<Icon name="gripper" className="dock-drag-grip" />
				<span className="dock-drag-name">{toolLabel(tool)}</span>
				{over ? (
					<span className="dock-drag-dest">
						<Icon name={ARROW[over]} />
						{areaLabel(over)}
					</span>
				) : (
					<span className="dock-drag-hint">Drop at an edge</span>
				)}
			</div>
		</div>
	);
}

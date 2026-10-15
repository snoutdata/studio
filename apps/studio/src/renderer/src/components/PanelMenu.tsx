/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react';

import { Icon } from './Icon';
import { DOCK_AREAS, areaLabel, toolLabel, type DockArea, type ToolId } from '../docking';

/*
 * "Move to Left / Right / Bottom" for one tool window.
 *
 * Deliberately a menu before it is a drag: it says out loud which places exist, it is reachable
 * from the keyboard (the same moves are command-palette entries), and it cannot drop a panel
 * somewhere the user did not mean. Opened by right-clicking a panel's header or its activity-bar
 * icon, both of which are places the user already thinks of as "this panel".
 */

interface PanelMenuProps {
	tool: ToolId;
	/** Where the click was, in viewport coordinates. */
	at: { x: number; y: number };
	/** The area the tool is in now, shown as the current choice rather than hidden. */
	current: DockArea;
	onMove(area: DockArea): void;
	onHide(): void;
	onClose(): void;
}

export function PanelMenu({ tool, at, current, onMove, onHide, onClose }: PanelMenuProps): JSX.Element {
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const away = (event: MouseEvent): void => {
			if (ref.current && !ref.current.contains(event.target as Node)) {
				onClose();
			}
		};
		const key = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				onClose();
			}
		};
		// Capture, so a click that also opens something else still closes this first.
		document.addEventListener('mousedown', away, true);
		document.addEventListener('keydown', key);
		return () => {
			document.removeEventListener('mousedown', away, true);
			document.removeEventListener('keydown', key);
		};
	}, [onClose]);

	// Keep the card on screen when the click was near the right or bottom edge.
	const left = Math.min(at.x, Math.max(8, window.innerWidth - 232));
	const top = Math.min(at.y, Math.max(8, window.innerHeight - 200));

	return (
		<div className="panel-menu" ref={ref} style={{ left, top }} role="menu">
			<div className="panel-menu-title">{toolLabel(tool)}</div>
			{DOCK_AREAS.map((area) => (
				<button
					key={area}
					type="button"
					role="menuitemradio"
					aria-checked={area === current}
					className={`panel-menu-item${area === current ? ' active' : ''}`}
					disabled={area === current}
					onClick={() => { onMove(area); onClose(); }}
				>
					<Icon name={area === current ? 'check' : 'blank'} />
					Move to {areaLabel(area).toLowerCase()}
				</button>
			))}
			<div className="panel-menu-sep" />
			<button type="button" role="menuitem" className="panel-menu-item" onClick={() => { onHide(); onClose(); }}>
				<Icon name="close" />
				Hide
			</button>
		</div>
	);
}

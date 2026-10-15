/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect } from 'react';

import { Icon } from './Icon';

/*
 * Orbit's controls, as a docked tool window.
 *
 * The canvas is a workbench tab and the controls are a panel, for the same reason Data Flows keeps
 * its list beside the wizard: the world wants the whole window, and the knobs want to stay put
 * while you fly. This panel does not OWN the controls, it hosts them — `OrbitView` portals its
 * rail into the div below, so every slider stays wired to the live scene and none of Orbit's state
 * has to be lifted into App just to be rendered somewhere else.
 *
 * Which is exactly why SHOWING this panel is asking for Orbit. It carries nothing of its own, so
 * with no tab to portal from it is an empty pane whose only content is a sentence telling you to
 * go and open one — which is what it used to be, and it made no sense: you had just clicked the
 * Orbit icon. It opens the tab instead.
 *
 * MOUNT ONLY, and that matters twice. `open` going false later is the user CLOSING the Orbit tab,
 * and reopening it from here would make the tab impossible to close. And a launch must never reach
 * this: `normalise` in docking.ts refuses to restore Orbit as an area's active tool, so the panel
 * is not mounted during startup and three.js is not fetched there (guarded by
 * `e2e/startup.spec.ts`).
 */

interface OrbitRailPanelProps {
	/** Whether an Orbit tab exists to portal controls in from. */
	open: boolean;
	/** Open one, because this panel showing with no tab is a pane with nothing in it. */
	onOpen(): void;
	/** Handed the element `OrbitView` portals its rail into. Stable for the panel's lifetime. */
	hostRef(element: HTMLDivElement | null): void;
	onCollapse(): void;
}

export function OrbitRailPanel({ open, onOpen, hostRef, onCollapse }: OrbitRailPanelProps): JSX.Element {
	useEffect(() => {
		if (!open) {
			onOpen();
		}
		// Deliberately once, on mount. See the header: this reacting to `open` would trap the tab.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div className="sidebar orbit-panel">
			<div className="sidebar-header">
				<span>ORBIT</span>
				<span className="spacer" />
				<button className="icon-btn" aria-label="Collapse" onClick={onCollapse}><Icon name="chevron-left" /></button>
			</div>
			<div className="orbit-rail-host" ref={hostRef} />
		</div>
	);
}

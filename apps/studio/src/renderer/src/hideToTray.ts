/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the hide-to-tray notice says (components/HideToTrayNotice.tsx). Pure, so a test can hold
 * the one thing that differs by build: a build without Data Flows (the open tree) has no
 * scheduled flows to keep running, so it does not promise any.
 */
export function hideToTrayDetail(o: { mac: boolean; flows: boolean }): string {
	const where = o.mac ? "the menu bar" : "the tray";
	const carryOn = o.flows ? "so scheduled flows and anything already running carry on" : "so anything already running carries on";
	return `Closing this window puts SnoutData Studio in ${where}, ${carryOn}. Click the icon there to bring the window back, or use its menu to quit for good.`;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The application menu, as data the renderer can draw.
 *
 * On Windows and Linux the window is frameless (see the custom title bar), which removes the
 * native menu bar along with the caption. Rather than keep a second copy of the menu in the
 * renderer, main serializes the SAME template it hands to `Menu.buildFromTemplate` and the title
 * bar draws it with our own tokens. One source of truth: adding an item to the native menu adds
 * it to the drawn one.
 *
 * Two kinds of leaf. A `commandId` is one of the renderer's own commands (the id `menu:command`
 * would have carried), so the title bar runs it directly with no round-trip. A `role` is an
 * Electron role (undo, zoom, quit) that only main can perform, and goes back over `app:menuRole`.
 */
export interface AppMenuItem {
	/** A separator carries nothing else. */
	separator?: boolean;
	label?: string;
	/** The shortcut hint to show, already formatted for this platform. */
	accelerator?: string;
	/** A renderer command id, run locally. */
	commandId?: string;
	/** An Electron role, performed in main. A `link:<key>` role opens one of main's pages. */
	role?: string;
	/** A Codicon name (or `glyph:<id>`), drawn before the label. */
	icon?: string;
}

export interface AppMenu {
	label: string;
	items: AppMenuItem[];
}

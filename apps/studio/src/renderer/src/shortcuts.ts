/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Platform-aware keyboard-shortcut labels. Source strings use 'Mod' for the
// Cmd-or-Ctrl shortcuts (Electron's CmdOrCtrl / Monaco's CtrlCmd), so they render
// as Ctrl on Windows/Linux and ⌘ on macOS. A literal 'Ctrl' or 'Alt' stays itself
// (mapped to its mac glyph) for the few bindings that are genuinely control/option.

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

// Mac modifier glyphs, rendered with no '+' separator in the conventional ⌃⌥⇧⌘ order.
const MAC_MODS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod'];
// Non-modifier keys that get a mac glyph; anything else (letters, '\') is shown verbatim.
const MAC_KEYS: Record<string, string> = { Enter: '↵', Space: 'Space' };

/** Format a '+'-joined combo (e.g. 'Mod+Shift+F') for the current platform. */
export function formatShortcut(combo: string): string {
	const parts = combo.split('+');
	if (!isMac) {
		return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)).join('+');
	}
	const mods = parts
		.filter((p) => p in MAC_MODS)
		.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b))
		.map((m) => MAC_MODS[m]);
	const keys = parts.filter((p) => !(p in MAC_MODS)).map((k) => MAC_KEYS[k] ?? k);
	return [...mods, ...keys].join('');
}

/**
 * The same, for an ELECTRON accelerator ('CmdOrCtrl+Shift+P') rather than one of our combos.
 *
 * The application menu is built in main and its hints are already accelerators, so the drawn
 * title-bar menu gets them in that form; this is the one place the two spellings meet.
 */
export function formatAccelerator(accelerator: string): string {
	return formatShortcut(accelerator.split('+').map((t) => (t === 'CmdOrCtrl' || t === 'CommandOrControl' ? 'Mod' : t)).join('+'));
}

/** The combo split into its display tokens (for UIs that render each key in its own <kbd>,
 *  VSCode-style). Each modifier and key becomes its own token: 'Mod+Shift+P' →
 *  ['⇧','⌘','P'] on mac, ['Ctrl','Shift','P'] on Windows/Linux. */
export function shortcutKeys(combo: string): string[] {
	const parts = combo.split('+');
	if (!isMac) {
		return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p));
	}
	const mods = parts
		.filter((p) => p in MAC_MODS)
		.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b))
		.map((m) => MAC_MODS[m]);
	const keys = parts.filter((p) => !(p in MAC_MODS)).map((k) => MAC_KEYS[k] ?? k);
	return [...mods, ...keys];
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The single source of truth for keyboard shortcuts. Every keystroke-driven command is
// declared once here with its default combo and scope; the three input layers that used to
// each carry their own copy of the key strings now read from the resolved map instead:
//   - the global DOM keydown dispatcher (App.tsx) for 'global'-scope bindings,
//   - the Monaco editor's onKeyDown dispatcher (Editor.tsx) for 'editor'-scope bindings,
//   - the Electron application menu (main/index.ts), which shows the accelerator hint.
// User overrides are persisted by main (keybindingStore.ts) and merged over the defaults.
//
// Combo grammar: '+'-joined tokens, e.g. 'Mod+Shift+P'. 'Mod' is the portable Cmd-or-Ctrl
// modifier (Ctrl on Windows/Linux, Cmd on macOS); 'Ctrl'/'Alt'/'Shift' are literal. The
// non-modifier token is a single character (letters stored uppercase) or a named key
// ('Enter', 'Space'). This is the same grammar formatShortcut() (shortcuts.ts) renders.

import { ASSISTANT_NAME } from './assistant';

export type KeybindingScope = 'global' | 'editor';

export interface KeybindingDef {
	/** Command id — matches the command-palette / Electron-menu command id of the same action. */
	id: string;
	/** Human label for the Settings → Shortcuts UI. */
	label: string;
	/** Where the binding is dispatched: 'global' at the window, 'editor' inside Monaco. */
	scope: KeybindingScope;
	/** Default combo in the grammar above. */
	default: string;
}

/** A binding with its effective combo (override applied over the default). */
export interface ResolvedKeybinding extends KeybindingDef {
	combo: string;
}

// The full keybinding set. Order is the display order in Settings → Shortcuts.
export const KEYBINDINGS: KeybindingDef[] = [
	{ id: 'commandPalette', label: 'Command palette', scope: 'global', default: 'Mod+Shift+P' },
	{ id: 'new', label: 'New query', scope: 'global', default: 'Mod+N' },
	{ id: 'open', label: 'Open .sql file', scope: 'global', default: 'Mod+O' },
	{ id: 'saveFile', label: 'Save file', scope: 'global', default: 'Mod+S' },
	{ id: 'closeTab', label: 'Close tab', scope: 'global', default: 'Mod+W' },
	{ id: 'agentConsole', label: 'Agent console (show/hide)', scope: 'global', default: 'Mod+`' },
	{ id: 'libyHelp', label: `${ASSISTANT_NAME}: help with what I am doing`, scope: 'global', default: 'Mod+Shift+H' },
	{ id: 'run', label: 'Run query', scope: 'editor', default: 'Mod+Enter' },
	{ id: 'format', label: 'Format SQL (selection or buffer)', scope: 'editor', default: 'Mod+Shift+F' },
	{ id: 'aiComplete', label: `${ASSISTANT_NAME}: complete at cursor`, scope: 'editor', default: 'Alt+\\' },
	{ id: 'aiEdit', label: `${ASSISTANT_NAME}: edit / generate (inline)`, scope: 'editor', default: 'Mod+K' },
	{ id: 'addToChat', label: `${ASSISTANT_NAME}: add selection to chat`, scope: 'editor', default: 'Mod+L' },
];

// Canonical modifier order so 'Shift+Mod+P' and 'Mod+Shift+P' normalize to the same string.
const MOD_ORDER = ['Ctrl', 'Mod', 'Alt', 'Shift'];
const MODIFIERS = new Set(MOD_ORDER);

/** Render a key token in its canonical stored form (letters uppercase, ' ' → 'Space'). */
function normalizeKeyToken(key: string): string {
	if (key === ' ' || key === 'Spacebar') {
		return 'Space';
	}
	if (key.length === 1) {
		return key.toUpperCase();
	}
	return key;
}

/** Normalize a combo: canonical modifier order + normalized key token. Used for storage and
 *  for conflict comparison so two equivalent combos compare equal. Returns '' for empty input. */
export function normalizeCombo(combo: string): string {
	const parts = combo.split('+').filter((p) => p.length > 0);
	const mods = parts.filter((p) => MODIFIERS.has(p)).sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
	const keys = parts.filter((p) => !MODIFIERS.has(p)).map(normalizeKeyToken);
	return [...mods, ...keys].join('+');
}

/** Apply the user's overrides over the defaults, yielding the effective binding list. */
export function resolveKeybindings(overrides: Record<string, string>): ResolvedKeybinding[] {
	return KEYBINDINGS.map((d) => ({ ...d, combo: normalizeCombo(overrides[d.id] ?? d.default) }));
}

/** Ids of other bindings in the SAME scope that resolve to the same combo (a real conflict —
 *  two different scopes can share a combo because they're dispatched by different layers). */
export function conflictingIds(bindings: ResolvedKeybinding[], id: string, combo: string, scope: KeybindingScope): string[] {
	const target = normalizeCombo(combo);
	return bindings
		.filter((b) => b.id !== id && b.scope === scope && b.combo === target)
		.map((b) => b.id);
}

// Built-in shortcuts a user combo would shadow. Our editor dispatcher is the first responder, so
// binding to one of these WINS — but it disables that built-in (e.g. Trigger Suggest), which is
// worth warning about. Keys are normalized combos; values are a short description for the UI.
// (Only combos expressible in our token grammar — letters/digits/Enter/Space/\ — can be listed.)
const RESERVED_COMBOS: Record<string, string> = {
	'Mod+C': 'Copy',
	'Mod+V': 'Paste',
	'Mod+X': 'Cut',
	'Mod+A': 'Select All',
	'Mod+Z': 'Undo',
	'Mod+Y': 'Redo',
	'Mod+F': 'editor: Find',
	'Mod+H': 'editor: Replace',
	'Mod+G': 'editor: Go to Line',
	'Mod+D': 'editor: Add Selection to Next Match',
	'Mod+I': 'editor: Trigger Suggest',
	'Ctrl+Space': 'editor: Trigger Suggest',
	'Mod+Space': 'editor: Trigger Suggest',
};

/** A description of the built-in a combo would shadow, or undefined if it shadows nothing known. */
export function reservedHint(combo: string): string | undefined {
	return RESERVED_COMBOS[normalizeCombo(combo)];
}

// --- DOM matching (renderer only; main never calls these) -------------------------------

// Structural shape of the KeyboardEvent fields we read — declared here (rather than the DOM
// `KeyboardEvent`) so this module also compiles under the node tsconfig, which has no DOM lib.
// A real DOM KeyboardEvent satisfies it.
export interface KeyEventLike {
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	key: string;
	code: string;
}

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

// We match on the physical key (KeyboardEvent.code), NOT ev.key. ev.key is layout- and
// modifier-dependent — on macOS Option+\ yields '«', not '\', and on non-US layouts letters
// move — so a code-based match is the only one that's stable across platforms and keyboards.
// The stored token stays the human-readable US label ('P', '\\', 'Enter'); these map it to/from
// the code. Returns null for any key outside the small set we support binding to.
function tokenToCode(token: string): string | null {
	if (/^[A-Z]$/.test(token)) {
		return `Key${token}`;
	}
	if (/^[0-9]$/.test(token)) {
		return `Digit${token}`;
	}
	switch (token) {
		case 'Enter': return 'Enter';
		case 'Space': return 'Space';
		case '\\': return 'Backslash';
		// The terminal key: the agent console binds it, the way every editor binds its panel.
		case '`': return 'Backquote';
		default: return null;
	}
}

function codeToToken(code: string): string | null {
	if (/^Key[A-Z]$/.test(code)) {
		return code.slice(3);
	}
	if (/^Digit[0-9]$/.test(code)) {
		return code.slice(5);
	}
	switch (code) {
		case 'Enter':
		case 'NumpadEnter': return 'Enter';
		case 'Space': return 'Space';
		case 'Backslash': return '\\';
		case 'Backquote': return '`';
		default: return null;
	}
}

interface ParsedCombo {
	wantCtrl: boolean;
	wantMeta: boolean;
	wantAlt: boolean;
	wantShift: boolean;
	code: string;
}

function parse(combo: string): ParsedCombo | null {
	const parts = combo.split('+').filter((p) => p.length > 0);
	const mods = new Set(parts.filter((p) => MODIFIERS.has(p)));
	const keys = parts.filter((p) => !MODIFIERS.has(p));
	if (keys.length !== 1) {
		return null;
	}
	const code = tokenToCode(normalizeKeyToken(keys[0]));
	if (!code) {
		return null;
	}
	const hasMod = mods.has('Mod');
	const hasCtrl = mods.has('Ctrl');
	return {
		// 'Mod' maps to Cmd on macOS and Ctrl elsewhere; literal 'Ctrl' is always Control.
		wantCtrl: isMac ? hasCtrl : hasCtrl || hasMod,
		wantMeta: isMac ? hasMod : false,
		wantAlt: mods.has('Alt'),
		wantShift: mods.has('Shift'),
		code,
	};
}

/** True if a DOM KeyboardEvent satisfies the combo. Works for both the window listener and
 *  Monaco's onKeyDown (pass `e.browserEvent`). Exact-modifier match so a looser chord (extra
 *  modifier held) never fires the wrong command. Matches on the physical key so it's correct on
 *  macOS (Option transforms the typed character) and on non-US layouts. */
export function matchesEvent(combo: string, ev: KeyEventLike): boolean {
	const p = parse(combo);
	if (!p) {
		return false;
	}
	if (ev.ctrlKey !== p.wantCtrl || ev.metaKey !== p.wantMeta || ev.altKey !== p.wantAlt || ev.shiftKey !== p.wantShift) {
		return false;
	}
	// Accept main + numpad Enter for an 'Enter'-bound command.
	if (p.code === 'Enter') {
		return ev.code === 'Enter' || ev.code === 'NumpadEnter';
	}
	return ev.code === p.code;
}

/** Turn a captured keystroke into a combo string, or null for a lone modifier press or an
 *  unsupported key. Ctrl/Cmd collapse to the portable 'Mod' so a rebind made on one platform
 *  carries to the other. Keyed off the physical key, so the stored token is the US label. */
export function eventToCombo(ev: KeyEventLike): string | null {
	const token = codeToToken(ev.code);
	if (!token) {
		return null;
	}
	const parts: string[] = [];
	if (ev.ctrlKey || ev.metaKey) {
		parts.push('Mod');
	}
	if (ev.altKey) {
		parts.push('Alt');
	}
	if (ev.shiftKey) {
		parts.push('Shift');
	}
	parts.push(token);
	return normalizeCombo(parts.join('+'));
}

// --- Electron accelerator (main only) ---------------------------------------------------

/** Convert a combo to an Electron accelerator string (display-only — menus register with
 *  registerAccelerator:false, so the renderer/Monaco keep owning the keys). */
export function toAccelerator(combo: string): string {
	return normalizeCombo(combo)
		.split('+')
		.map((t) => (t === 'Mod' ? 'CmdOrCtrl' : t))
		.join('+');
}

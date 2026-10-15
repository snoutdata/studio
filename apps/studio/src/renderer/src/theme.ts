/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { monaco } from './monaco';
import { registerSqlHighlighting } from './sqlHighlight';

// The base palette a theme builds on: it drives the native window chrome shade, the
// `color-scheme` of native controls, and which Monaco editor base + token colors are used.
export type ThemeBase = 'dark' | 'light';

export interface ThemeDef {
	/** Stable id, also the `data-theme` attribute value and the CSS token block selector. */
	id: string;
	/** Human label shown in the picker. */
	label: string;
	/** Light or dark foundation (native chrome + Monaco base + token color set). */
	base: ThemeBase;
	/** Monaco editor surface colors, so the editor pane matches the app chrome. */
	editorBg: string;
	editorFg: string;
	/** Optional override for the SQL syntax-token colors; defaults to the base's
	 *  (dark/light) rule set. Used by novelty themes (e.g. Matrix) that want the
	 *  editor recolored, not just the surface. */
	editorRules?: monaco.editor.ITokenThemeRule[];
}

// Gold: a warm, low-emission syntax set for the near-black Gold theme. The stock Dark Modern
// rules put a cold VSCode blue on every keyword, which fights the warm surfaces; here the
// keyword carries the theme's gold and the rest of the palette stays in the same warm family.
const GOLD_RULES: monaco.editor.ITokenThemeRule[] = [
	{ token: 'keyword', foreground: 'E0B256' },
	{ token: 'type', foreground: '7FB9A6' },
	{ token: 'predefined', foreground: 'D9C77E' },
	{ token: 'string', foreground: 'C98C6B' },
	{ token: 'number', foreground: 'B8C98A' },
	{ token: 'comment', foreground: '6B6357', fontStyle: 'italic' },
	{ token: 'operator', foreground: 'BFB6A8' },
	{ token: 'delimiter', foreground: '8F887E' },
	{ token: 'identifier', foreground: 'E9E4DC' },
];

// Matrix: an all-green phosphor terminal recolor of the SQL syntax tokens, so the
// editor reads as green-on-black rather than the standard Dark Modern palette.
const MATRIX_RULES: monaco.editor.ITokenThemeRule[] = [
	{ token: 'keyword', foreground: '00FF41', fontStyle: 'bold' },
	{ token: 'type', foreground: '39E66B' },
	{ token: 'predefined', foreground: '7CFC4A' },
	{ token: 'string', foreground: '00B33A' },
	{ token: 'number', foreground: 'A8FF9E' },
	{ token: 'comment', foreground: '1E7A2E', fontStyle: 'italic' },
	{ token: 'operator', foreground: '00FF41' },
	{ token: 'delimiter', foreground: '2FAE4B' },
	{ token: 'identifier', foreground: '3DF06A' },
];

// The theme registry. This is the single source of truth: adding a theme is two steps,
//   1. add an entry here (label, base, editor colors), and
//   2. add a matching `:root[data-theme="<id>"]` token block in styles.css.
// Everything else (the picker, Monaco theme, native chrome) reads from this list.
// Listed darks first, then lights, each named base-first ("Dark Gold", "Light Warm") so a pair
// sits together. The default stays first: themeDef falls back to THEMES[0]. Labels only; the ids
// are what profiles store and never change.
export const THEMES: ThemeDef[] = [
	{ id: 'gold', label: 'Dark Gold', base: 'dark', editorBg: '#121110', editorFg: '#e4dfd6', editorRules: GOLD_RULES },
	{ id: 'dark', label: 'Dark', base: 'dark', editorBg: '#1f1f1f', editorFg: '#cccccc' },
	{ id: 'warm-dark', label: 'Dark Warm', base: 'dark', editorBg: '#1f1b16', editorFg: '#e6dccb' },
	{ id: 'abyss', label: 'Abyss', base: 'dark', editorBg: '#0a0b10', editorFg: '#c5c8d6' },
	{ id: 'matrix', label: 'Matrix', base: 'dark', editorBg: '#000000', editorFg: '#00ff41', editorRules: MATRIX_RULES },
	{ id: 'light', label: 'Light', base: 'light', editorBg: '#ffffff', editorFg: '#26251e' },
	{ id: 'warm', label: 'Light Warm', base: 'light', editorBg: '#f5efe1', editorFg: '#43382a' },
];

// Back-compat alias: lots of call sites import `type Theme`. A theme is just its id.
export type Theme = string;

const STORAGE_KEY = 'positron-db.theme';
/** The theme a fresh profile (and any unreadable/absent stored value) gets. */
export const DEFAULT_THEME = 'gold';

// Install our SQL tokenizer + a named Monaco theme for every registered theme, before
// anyone calls applyTheme below.
registerSqlHighlighting(THEMES);

/** Look up a theme by id, falling back to the default (first registered) theme. */
export function themeDef(id: Theme): ThemeDef {
	return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** The next theme in the registry (wraps), for the quick-cycle toggle. */
export function nextTheme(id: Theme): Theme {
	const i = THEMES.findIndex((t) => t.id === id);
	return THEMES[(i + 1) % THEMES.length].id;
}

/** Whether a string is a known theme id (used to sanitize persisted/synced values). */
export function isThemeId(id: unknown): id is Theme {
	return typeof id === 'string' && THEMES.some((t) => t.id === id);
}

export function loadTheme(): Theme {
	const stored = localStorage.getItem(STORAGE_KEY);
	return isThemeId(stored) ? stored : DEFAULT_THEME;
}

/** Apply a theme to the document (CSS variables), Monaco, and the native window chrome; persist it. */
export function applyTheme(theme: Theme): void {
	const def = themeDef(theme);
	document.documentElement.setAttribute('data-theme', def.id);
	monaco.editor.setTheme(`snout-${def.id}`);
	localStorage.setItem(STORAGE_KEY, def.id);
	// Recolor the native OS window chrome (title bar/frame) to match the theme's base, so the
	// whole window follows the in-app theme rather than the OS theme. (No-op outside Electron.)
	// The window's own caption is ours now, but this still drives native menus, dialogs, and the
	// macOS traffic lights.
	void window.sqlApi?.setNativeTheme(def.base);
	// ...and the exact colours for the custom title bar's native half: the Window Controls
	// Overlay buttons on Windows/Linux. Read back off the DOM rather than duplicated onto every
	// ThemeDef: the tokens have just been applied, so this is the theme's real --bg-app and --fg
	// and it cannot drift from the stylesheet the way a second copy of the palette would.
	const style = getComputedStyle(document.documentElement);
	const ground = style.getPropertyValue('--bg-app').trim();
	const symbol = style.getPropertyValue('--fg').trim();
	if (ground && symbol) {
		void window.sqlApi?.setWindowChrome(ground, symbol);
	}
}

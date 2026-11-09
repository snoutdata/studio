/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference types="vite/client" />

import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { catalogOf, isLanguagePreference, isLocale, registerCatalog, resolveLocale, setCurrentLocale, setSystemLanguages, type LanguagePreference, type LanguageState, type Locale } from '../shared/i18n/core';

// The language of this install, and the text only main says: the native menus, the tray, its dialogs,
// its errors. It lives here because main draws the menu before any window exists, and the renderer
// gets it synchronously, so a window never paints in the wrong language first. It belongs to the
// computer (it follows that computer's language by default), so it is not in the synced preferences.
//
// main's sections (main*.json) and the engine's (engine*.json) are bundled for all four languages:
// small, and there is nothing to wait for. Everything else in the catalogs is the renderer's.

const MAIN_CATALOGS = import.meta.glob('../shared/i18n/*/{main,engine}*.json', { eager: true, import: 'default' });

for (const locale of ['en', 'fr', 'es', 'pt'] as const) {
	const files = Object.fromEntries(Object.entries(MAIN_CATALOGS).filter(([path]) => path.includes(`/i18n/${locale}/`)));
	registerCatalog(locale, catalogOf(files));
}

function filePath(): string {
	return join(app.getPath('userData'), 'language.json');
}

function readPreference(): LanguagePreference {
	// A scratch e2e profile is English whatever this computer speaks, because the specs read English
	// text; a spec that looks at another language asks for it.
	if (process.env.SNOUT_E2E_USERDATA && !app.isPackaged) {
		const forced = process.env.SNOUT_E2E_LANGUAGE;
		return isLocale(forced) ? forced : 'en';
	}
	try {
		const saved = (JSON.parse(readFileSync(filePath(), 'utf8')) as { preference?: unknown }).preference;
		return isLanguagePreference(saved) ? saved : 'system';
	} catch {
		return 'system';
	}
}

let preference: LanguagePreference = 'system';
let locale: Locale = 'en';

function systemTags(): string[] {
	const preferred = app.getPreferredSystemLanguages();
	return preferred.length > 0 ? preferred : [app.getLocale()];
}

function apply(): void {
	const tags = systemTags();
	locale = resolveLocale(preference, tags);
	setSystemLanguages(tags);
	setCurrentLocale(locale);
}

/** Reads the saved choice. Call once the app is ready: the system's languages are not known before. */
export function initLanguage(): void {
	preference = readPreference();
	apply();
}

export function languageState(): LanguageState {
	return { preference, locale, system: systemTags() };
}

/** Saves the choice and makes it current. The caller rebuilds what main has already drawn. */
export function setLanguagePreference(next: LanguagePreference): LanguageState {
	preference = next;
	apply();
	try {
		const path = filePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ preference: next }), 'utf8');
	} catch (err) {
		console.error(`[i18n] could not save the language: ${err instanceof Error ? err.message : String(err)}`);
	}
	return languageState();
}

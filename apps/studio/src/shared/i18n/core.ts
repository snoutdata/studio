/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Studio's translations, the pure half: no React, no Electron, no Vite, so main, the renderer, the
// engine and the node-run tests all use the same one.
// Catalogs are per-locale JSON files, one per section: `en/settings.json` holds `settings.*`. English
// is the source, and a key missing from a language falls back to English.

export type Locale = 'en' | 'fr' | 'es' | 'pt';

/** What the user chose in Settings. `system` follows the computer's language. */
export type LanguagePreference = 'system' | Locale;

export type Vars = Record<string, string | number>;

type Catalog = Record<string, unknown>;

/** `native` is how each language writes its own name; it is never translated. */
export const LOCALES: readonly { code: Locale; native: string }[] = [
	{ code: 'en', native: 'English' },
	{ code: 'fr', native: 'Français' },
	{ code: 'es', native: 'Español' },
	{ code: 'pt', native: 'Português (Brasil)' },
];

export function isLocale(value: unknown): value is Locale {
	return value === 'en' || value === 'fr' || value === 'es' || value === 'pt';
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
	return value === 'system' || isLocale(value);
}

/** The first of the computer's languages we have, in the order the computer prefers them, else English. */
export function systemLocale(tags: readonly string[]): Locale {
	for (const tag of tags) {
		const base = (tag || '').toLowerCase().split(/[-_]/)[0];
		if (isLocale(base)) {
			return base;
		}
	}
	return 'en';
}

export function resolveLocale(preference: LanguagePreference, systemTags: readonly string[]): Locale {
	return preference === 'system' ? systemLocale(systemTags) : preference;
}

/** What the renderer needs before its first paint, handed over synchronously by main. */
export interface LanguageState {
	preference: LanguagePreference;
	locale: Locale;
	/** The computer's languages, most preferred first. */
	system: string[];
}

const CATALOGS: Partial<Record<Locale, Catalog>> = {};

let current: Locale = 'en';
let systemTags: readonly string[] = [];

/** Section files (`.../plan.json` becomes `plan`) into one catalog. */
export function catalogOf(files: Record<string, unknown>): Catalog {
	const catalog: Catalog = {};
	for (const [path, content] of Object.entries(files)) {
		const name = /([^/]+)\.json$/.exec(path)?.[1];
		if (name) {
			catalog[name] = content;
		}
	}
	return catalog;
}

/** Adds sections to a locale. Sections already there are kept unless named again. */
export function registerCatalog(locale: Locale, catalog: Catalog): void {
	CATALOGS[locale] = { ...CATALOGS[locale], ...catalog };
}

export function hasCatalog(locale: Locale): boolean {
	return Boolean(CATALOGS[locale]);
}

/** The active locale, for code outside React (formatters, plain .ts modules). */
export function currentLocale(): Locale {
	return current;
}

export function setCurrentLocale(locale: Locale): void {
	current = locale;
}

/** The computer's languages, so dates and numbers can keep the user's own region. */
export function setSystemLanguages(tags: readonly string[]): void {
	systemTags = tags;
}

/**
 * The tag to format dates and numbers with: the user's regional tag when it is in the active language
 * (en-GB keeps day-month and 24h, pt-BR its own), else the bare language.
 */
export function formatLocale(): string {
	return systemTags.find((tag) => (tag || '').toLowerCase().split(/[-_]/)[0] === current) ?? current;
}

function resolveNode(catalog: Catalog | undefined, key: string): unknown {
	let node: unknown = catalog;
	for (const part of key.split('.')) {
		if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
			node = (node as Record<string, unknown>)[part];
		} else {
			return undefined;
		}
	}
	return node;
}

// A string, or a plural `{ "zero"?, "one", "other", ... }` chosen by vars.count.
function leaf(locale: Locale, node: unknown, vars?: Vars): string | undefined {
	if (typeof node === 'string') {
		return node;
	}
	if (node && typeof node === 'object' && !Array.isArray(node) && 'other' in node) {
		const forms = node as Record<string, unknown>;
		const count = Number(vars?.count ?? 0);
		const form = count === 0 && typeof forms.zero === 'string' ? 'zero' : new Intl.PluralRules(locale).select(count);
		const value = forms[form] ?? forms.other;
		return typeof value === 'string' ? value : undefined;
	}
	return undefined;
}

/** A key for a locale, falling back to English, then to the key itself. {placeholders} filled. */
export function translate(locale: Locale, key: string, vars?: Vars): string {
	let value = leaf(locale, resolveNode(CATALOGS[locale], key), vars);
	if (value === undefined && locale !== 'en') {
		value = leaf('en', resolveNode(CATALOGS.en, key), vars);
	}
	if (value === undefined) {
		return key;
	}
	if (vars) {
		for (const [name, replacement] of Object.entries(vars)) {
			const text = typeof replacement === 'number' ? replacement.toLocaleString(formatLocale()) : replacement;
			value = value.split(`{${name}}`).join(text);
		}
	}
	return value;
}

/** A list of strings at a key (bullets), with the same English fallback. */
export function translateList(locale: Locale, key: string): string[] {
	let node = resolveNode(CATALOGS[locale], key);
	if (node === undefined && locale !== 'en') {
		node = resolveNode(CATALOGS.en, key);
	}
	return Array.isArray(node) ? node.filter((x): x is string => typeof x === 'string') : [];
}

/** t() for plain modules: reads the active locale. Call it when the text is needed, never at module load. */
export function t(key: string, vars?: Vars): string {
	return translate(current, key, vars);
}

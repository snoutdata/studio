/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createContext, Fragment, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import {
	catalogOf,
	hasCatalog,
	isLocale,
	registerCatalog,
	setCurrentLocale,
	setSystemLanguages,
	translate,
	translateList,
	type LanguagePreference,
	type LanguageState,
	type Locale,
	type Vars,
} from '../../../shared/i18n/core';

// The renderer's half of the translations: the provider, the hooks and the language chunks. A
// language other than English is one lazy chunk, loaded before the first render (main.tsx), so an
// English launch pays for nothing.

export { currentLocale, formatLocale, LOCALES, t, type LanguagePreference, type Locale } from '../../../shared/i18n/core';

registerCatalog('en', catalogOf(import.meta.glob(['../../../shared/i18n/en/*.json', '!../../../shared/i18n/en/main*.json'], { eager: true, import: 'default' })));

const LOADERS: Record<Exclude<Locale, 'en'>, () => Promise<{ default: Record<string, unknown> }>> = {
	fr: () => import('./fr'),
	es: () => import('./es'),
	pt: () => import('./pt'),
};

/** Fetch a locale's catalog once. A failed load leaves it unloaded, so English shows. */
export async function loadLocale(locale: Locale): Promise<void> {
	if (locale === 'en' || hasCatalog(locale)) {
		return;
	}
	try {
		registerCatalog(locale, (await LOADERS[locale]()).default);
	} catch {
		// A broken chunk must never stop the app: English is the fallback.
	}
}

/** What main says the language is. English on a surface with no main behind it. */
export function bootLanguage(): LanguageState {
	const state = window.sqlApi?.languageState?.();
	if (state && isLocale(state.locale)) {
		setSystemLanguages(state.system);
		setCurrentLocale(state.locale);
		document.documentElement.lang = state.locale;
		return state;
	}
	return { preference: 'system', locale: 'en', system: [] };
}

/**
 * `**label**` and `` `code` ``, nothing else. Rendered as React text rather than HTML, so no string in
 * a catalog can become markup.
 */
export function rich(text: string): ReactNode {
	return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
		if (part.startsWith('**') && part.endsWith('**')) {
			return <strong key={i}>{part.slice(2, -2)}</strong>;
		}
		if (part.startsWith('`') && part.endsWith('`')) {
			return <code key={i}>{part.slice(1, -1)}</code>;
		}
		return <Fragment key={i}>{part}</Fragment>;
	});
}

export type Translate = (key: string, vars?: Vars) => string;

interface I18nValue {
	locale: Locale;
	preference: LanguagePreference;
	setPreference(next: LanguagePreference): void;
	t: Translate;
	tr(key: string, vars?: Vars): ReactNode;
	tList(key: string): string[];
}

const I18nContext = createContext<I18nValue | null>(null);

/** The starting locale must already be loaded (main.tsx does that before rendering). */
export function I18nProvider({ initial, children }: { initial: LanguageState; children: ReactNode }): React.JSX.Element {
	const [state, setState] = useState<LanguageState>(initial);

	const setPreference = useCallback((next: LanguagePreference) => {
		void (async () => {
			const updated = await window.sqlApi.setLanguagePreference(next);
			await loadLocale(updated.locale);
			setSystemLanguages(updated.system);
			setCurrentLocale(updated.locale);
			document.documentElement.lang = updated.locale;
			setState(updated);
		})();
	}, []);

	// e2e/i18nLayout.ts switches language with a screen open. Same effect as the Settings field.
	(window as unknown as { __snoutDebugSetLanguage?: (next: LanguagePreference) => void }).__snoutDebugSetLanguage = setPreference;

	// Only a language change makes a new value, so `t` in a useMemo's dependencies means "the language".
	const value = useMemo<I18nValue>(() => ({
		locale: state.locale,
		preference: state.preference,
		setPreference,
		t: (key, vars) => translate(state.locale, key, vars),
		tr: (key, vars) => rich(translate(state.locale, key, vars)),
		tList: (key) => translateList(state.locale, key),
	}), [state.locale, state.preference, setPreference]);

	// A switch re-renders every component that called useT() or useI18n(), and nothing is remounted, so
	// an open tab, form or running query is left alone. A component with text calls one of them even
	// when its strings come from a plain module's t().
	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
	const context = useContext(I18nContext);
	if (!context) {
		throw new Error('useI18n must be used within <I18nProvider>');
	}
	return context;
}

export function useT(): Translate {
	return useI18n().t;
}

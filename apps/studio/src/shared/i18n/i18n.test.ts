/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { catalogOf, formatLocale, registerCatalog, resolveLocale, setCurrentLocale, setSystemLanguages, systemLocale, translate } from './core';

// The catalogs' own rules, and the rule that ties them to the code: a key the code names exists.
// Run from apps/studio (`npm test`).

const ROOT = 'src/shared/i18n';
const LANGUAGES = ['fr', 'es', 'pt'];

type Tree = Record<string, unknown>;

function section(locale: string, name: string): Tree {
	return JSON.parse(readFileSync(join(ROOT, locale, name), 'utf8')) as Tree;
}

function sections(locale: string): string[] {
	return readdirSync(join(ROOT, locale)).filter((name) => name.endsWith('.json')).sort();
}

function isPlural(node: unknown): node is Tree {
	return Boolean(node) && typeof node === 'object' && !Array.isArray(node) && 'other' in (node as Tree);
}

function leaves(node: unknown, prefix = ''): Map<string, string[]> {
	const found = new Map<string, string[]>();
	if (typeof node === 'string') {
		found.set(prefix, [node]);
	} else if (Array.isArray(node)) {
		found.set(prefix, node.filter((entry): entry is string => typeof entry === 'string'));
	} else if (isPlural(node)) {
		found.set(prefix, Object.values(node).filter((entry): entry is string => typeof entry === 'string'));
	} else if (node && typeof node === 'object') {
		for (const [key, value] of Object.entries(node)) {
			for (const [path, text] of leaves(value, prefix ? `${prefix}.${key}` : key)) {
				found.set(path, text);
			}
		}
	}
	return found;
}

function placeholders(texts: readonly string[]): string[] {
	return [...new Set(texts.flatMap((text) => [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1])))].sort();
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			return name === 'server' || name === 'i18n' ? [] : sourceFiles(full);
		}
		return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
	});
}

describe('the catalogs', () => {
	const english = sections('en');

	for (const locale of LANGUAGES) {
		test(`${locale} has every English section, key and placeholder`, () => {
			const problems: string[] = [];
			for (const name of english) {
				if (!existsSync(join(ROOT, locale, name))) {
					problems.push(`${locale}/${name}: missing file`);
					continue;
				}
				const source = leaves(section('en', name));
				const target = leaves(section(locale, name));
				for (const [key, texts] of source) {
					const translated = target.get(key);
					if (!translated) {
						problems.push(`${locale}/${name}: missing ${key}`);
					} else if (placeholders(texts).join() !== placeholders(translated).join()) {
						problems.push(`${locale}/${name}: ${key} has {${placeholders(translated).join()}} where English has {${placeholders(texts).join()}}`);
					}
				}
				for (const key of target.keys()) {
					if (!source.has(key)) {
						problems.push(`${locale}/${name}: ${key} is not in English`);
					}
				}
			}
			assert.deepEqual(problems, []);
		});
	}

	test('no em or en dashes in any language', () => {
		const problems: string[] = [];
		for (const locale of ['en', ...LANGUAGES]) {
			for (const name of sections(locale)) {
				for (const [key, texts] of leaves(section(locale, name))) {
					if (texts.some((text) => /[–—]/.test(text))) {
						problems.push(`${locale}/${name}: ${key}`);
					}
				}
			}
		}
		assert.deepEqual(problems, []);
	});

	test('every key the code names exists in English', () => {
		const known = new Set<string>();
		for (const name of sections('en')) {
			for (const key of leaves(section('en', name), name.replace(/\.json$/, '')).keys()) {
				known.add(key);
			}
		}
		const problems: string[] = [];
		for (const file of sourceFiles('src')) {
			const text = readFileSync(file, 'utf8');
			for (const match of text.matchAll(/\b(?:t|tr|tList)\(\s*'([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+)'/g)) {
				if (!known.has(match[1])) {
					problems.push(`${file}: ${match[1]}`);
				}
			}
		}
		assert.deepEqual(problems, []);
	});
});

describe('choosing the language', () => {
	test('the first of the computer\'s languages we have', () => {
		assert.equal(systemLocale(['de-DE', 'pt-BR', 'en-US']), 'pt');
		assert.equal(systemLocale(['fr_CA']), 'fr');
		assert.equal(systemLocale(['de-DE']), 'en');
		assert.equal(systemLocale([]), 'en');
	});

	test('a choice in Settings beats the computer', () => {
		assert.equal(resolveLocale('es', ['pt-BR']), 'es');
		assert.equal(resolveLocale('system', ['pt-BR']), 'pt');
	});
});

describe('translate', () => {
	registerCatalog('fr', catalogOf({ 'x/demo.json': { hello: 'Bonjour {name}', rows: { one: '{count} ligne', other: '{count} lignes' } } }));
	registerCatalog('en', catalogOf({ 'x/demo.json': { hello: 'Hello {name}', only: 'English only', rows: { one: '{count} row', other: '{count} rows' } } }));

	test('fills placeholders and falls back to English, then to the key', () => {
		assert.equal(translate('fr', 'demo.hello', { name: 'Ana' }), 'Bonjour Ana');
		assert.equal(translate('fr', 'demo.only'), 'English only');
		assert.equal(translate('fr', 'demo.nothing'), 'demo.nothing');
	});

	test('French treats zero as singular, as French does', () => {
		assert.equal(translate('fr', 'demo.rows', { count: 0 }), '0 ligne');
		assert.equal(translate('en', 'demo.rows', { count: 0 }), '0 rows');
	});

	test('dates and numbers keep the user\'s own region in the active language', () => {
		setSystemLanguages(['pt-BR', 'en-GB']);
		setCurrentLocale('en');
		assert.equal(formatLocale(), 'en-GB');
		setCurrentLocale('fr');
		assert.equal(formatLocale(), 'fr');
		setCurrentLocale('en');
		setSystemLanguages([]);
	});
});

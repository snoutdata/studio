/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Writes out/licenses/: THIRD-PARTY-LICENSES.txt (every third-party package that ends up in the app,
// with its licence text), and NOTICE.txt + LICENSE.txt (Studio's own). Run by `npm run build` after
// electron-vite, so the packaged app carries them (electron-builder ships out/**), and checked by
// scripts/assert-build.mjs, in out/ and again inside the package (`--package`).
//
// "Ends up in the app" is two sets, and the file lists their union:
//   1. BUNDLED: every package a bundle in out/ was built from, read off the bundles' sourcemaps (the
//      renderer's are emitted hidden, the server's beside it). This is how react, monaco-editor,
//      recharts and the rest of the renderer's devDependencies are found: they are in no
//      node_modules electron-builder packs.
//   2. SHIPPED: the production dependency closure of package.json (dependencies, optional and peer
//      dependencies, followed through node_modules the way Node resolves them), which is what
//      electron-builder packs into app.asar. A package listed here and also excluded by
//      electron-builder.yml (three, @xterm/*, @vscode/codicons, …) is in the renderer bundle instead.
// Plus Electron itself, whose runtime IS the app. Our own workspace packages (@snout/*) are skipped.
//
// The pure parts (picking licence files, reading a licence id, formatting) are exported and tested in
// third-party-licenses.test.mjs. No dependencies.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Where the build writes the licence files, relative to the app. Read by main (the About modal)
 *  and by assert-build.mjs. */
export const LICENSES_DIR = 'out/licenses';
export const THIRD_PARTY_FILE = 'THIRD-PARTY-LICENSES.txt';
export const NOTICE_FILE = 'NOTICE.txt';
export const LICENSE_FILE = 'LICENSE.txt';

/** Packages that are in node_modules but not in the app: ibm_db is a component downloaded on first
 *  use (electron-builder.yml excludes it; NOTICE lists it under the downloaded drivers). */
const NOT_SHIPPED = new Set(['ibm_db']);

/** Notes a package's own files do not make plain. */
const EXTRA_NOTES = {
	'@vscode/codicons': 'The Codicons icon font and images are licensed under the Creative Commons Attribution 4.0 International licence (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/) and are used unmodified; the package\'s code is under the MIT licence (LICENSE-CODE). Source: https://github.com/microsoft/vscode-codicons',
	electron: 'Electron includes Chromium and Node.js under their own licences; the full list ships beside the app binary as LICENSES.chromium.html.',
};

const LICENCE_NAME = /^(licen[cs]e|copying|notice|third[-_ ]?party[-_ ]?notices?|unlicen[cs]e)([-._ ].*)?$/i;
const NOT_A_TEXT = /\.(c?js|mjs|ts|tsx|json|map|html?|sh|py|png|svg)$/i;

/** The licence and notice files among a package's top-level file names, licence first, then notices,
 *  then third-party notices, alphabetical within each. */
export function pickLicenceFiles(names) {
	function rank(name) {
		if (/^(licen[cs]e|copying|unlicen[cs]e)/i.test(name)) { return 0; }
		if (/^notice/i.test(name)) { return 1; }
		return 2;
	}
	return names
		.filter((n) => LICENCE_NAME.test(n) && !NOT_A_TEXT.test(n))
		.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The licence a package.json declares, as an SPDX expression where it can be one. */
export function licenceId(pkg) {
	const one = (l) => (typeof l === 'string' ? l : l && typeof l.type === 'string' ? l.type : null);
	const main = one(pkg.license);
	if (main) { return main; }
	if (Array.isArray(pkg.licenses)) {
		const ids = pkg.licenses.map(one).filter(Boolean);
		if (ids.length === 1) { return ids[0]; }
		if (ids.length > 1) { return `(${ids.join(' OR ')})`; }
	}
	return one(pkg.licenses) ?? 'UNKNOWN';
}

/** A line that states a copyright, as opposed to licence prose that mentions one ("Copyright and
 *  Similar Rights means…", "(c) You must retain…") or a template ("Copyright {yyyy} {name}"). */
export function isCopyrightLine(line) {
	if (line.length > 200 || /[{}<>]|\[(yyyy|year)\]/i.test(line)) { return false; }
	if (/^copyright\b/i.test(line)) {
		return /^(Copyright|COPYRIGHT)\b/.test(line) && !/^copyright\s+(and|notice|holders?|owners?|licen[cs]es?|statement|law|protection|rights?|of|to|is|in|the|for|by)\b/i.test(line);
	}
	return /^(\(c\)|©)\s*\d{4}/i.test(line);
}

/** The copyright lines in a set of licence texts, trimmed and de-duplicated, in order. */
export function copyrightLines(texts) {
	const seen = new Set();
	const out = [];
	for (const text of texts) {
		for (const raw of text.split('\n')) {
			const line = raw.trim();
			if (!isCopyrightLine(line)) { continue; }
			if (!seen.has(line)) { seen.add(line); out.push(line); }
		}
	}
	return out;
}

/** The package directory a bundled source file came from: the path up to and including the package
 *  name after its LAST node_modules segment, or null for a file that is not in a package. */
export function packageDirOf(file) {
	const norm = file.split(sep).join('/');
	const i = norm.lastIndexOf('/node_modules/');
	if (i < 0) { return null; }
	const rest = norm.slice(i + '/node_modules/'.length).split('/');
	const name = rest[0]?.startsWith('@') ? (rest[1] ? `${rest[0]}/${rest[1]}` : null) : rest[0];
	if (!name || name === '.bin') { return null; }
	return { dir: norm.slice(0, i + '/node_modules/'.length) + name, name };
}

function normaliseText(text) {
	return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}

function byNameThenVersion(a, b) {
	if (a.name !== b.name) { return a.name < b.name ? -1 : 1; }
	return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
}

/** The whole file. `entries` are { name, version, licence, files: [{ name, text }], homepage? }; the
 *  order is fixed (name, then version) and a licence text identical to one already printed is
 *  referred to rather than repeated, which keeps a hundred copies of the Apache licence out of it. */
export function formatReport(entries, { product = 'SnoutData Studio', version = '' } = {}) {
	const sorted = [...entries].sort(byNameThenVersion);
	const rule = '='.repeat(78);
	const lines = [
		`Third-party software in ${product}${version ? ` ${version}` : ''}`,
		rule,
		'',
		`${product} includes the following ${sorted.length} third-party packages, bundled into the app or`,
		'shipped with it. Each is used under its own licence, reproduced below from the package itself.',
		"Studio's own licence and notices are in LICENSE.txt and NOTICE.txt beside this file.",
		'',
	];
	const printed = new Map();
	for (const e of sorted) {
		const head = `${e.name} ${e.version}`;
		lines.push(rule, head, `Licence: ${e.licence}`);
		if (e.homepage) { lines.push(`Source: ${e.homepage}`); }
		const texts = e.files.map((f) => normaliseText(f.text));
		for (const c of copyrightLines(texts)) { lines.push(c); }
		if (EXTRA_NOTES[e.name]) { lines.push('', EXTRA_NOTES[e.name]); }
		if (e.files.length === 0) {
			lines.push('', `This package carries no licence file. It is distributed under ${e.licence}${/^[A-Za-z0-9.+-]+$/.test(e.licence) && e.licence !== 'UNKNOWN' ? ` (https://spdx.org/licenses/${e.licence}.html)` : ''}, as its package.json declares.`);
		}
		e.files.forEach((f, i) => {
			const text = texts[i];
			const key = createHash('sha256').update(text).digest('hex');
			lines.push('', `--- ${f.name} ---`);
			const first = printed.get(key);
			if (first) {
				lines.push(`(The same text as ${first} above.)`);
			} else {
				printed.set(key, `${head}'s ${f.name}`);
				lines.push(text);
			}
		});
		lines.push('');
	}
	return lines.join('\n') + '\n';
}

// ---- the impure half: reading node_modules and the bundles ----

function readJson(file) {
	try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function entryFor(dir) {
	const pkg = readJson(join(dir, 'package.json'));
	if (!pkg || typeof pkg.name !== 'string') { return null; }
	let names = [];
	try { names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()); } catch { /* none */ }
	const files = pickLicenceFiles(names).map((n) => ({ name: n, text: readFileSync(join(dir, n), 'utf8') }));
	const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
	const homepage = typeof pkg.homepage === 'string' ? pkg.homepage : typeof repo === 'string' ? repo.replace(/^git\+/, '').replace(/\.git$/, '') : undefined;
	return { name: pkg.name, version: String(pkg.version ?? ''), licence: licenceId(pkg), files, homepage, pkg };
}

/** Node's lookup: `name` from `fromDir` upwards, stopping at the filesystem root. */
function resolvePackage(fromDir, name) {
	let d = fromDir;
	for (;;) {
		const candidate = join(d, 'node_modules', name);
		if (existsSync(join(candidate, 'package.json'))) { return candidate; }
		const up = dirname(d);
		if (up === d) { return null; }
		d = up;
	}
}

/** Every *.map under the bundle folders of out/, in a fixed order. */
function sourcemaps(app) {
	const found = [];
	function walk(dir) {
		if (!existsSync(dir)) { return; }
		for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const p = join(dir, e.name);
			if (e.isDirectory()) { walk(p); } else if (e.name.endsWith('.map')) { found.push(p); }
		}
	}
	for (const d of ['main', 'preload', 'renderer', 'server']) { walk(join(app, 'out', d)); }
	return found;
}

export function collect(app) {
	const dirs = new Map();
	function add(dir) {
		let real;
		try { real = realpathSync(dir); } catch { return; }
		if (!dirs.has(real)) { dirs.set(real, true); }
	}

	// 1. Bundled, from the sourcemaps.
	const maps = sourcemaps(app);
	if (!maps.some((m) => m.includes(`${sep}renderer${sep}`))) {
		throw new Error('out/renderer has no sourcemaps: run this after electron-vite build (the renderer emits hidden maps).');
	}
	for (const file of maps) {
		const map = readJson(file);
		if (!map || !Array.isArray(map.sources)) { continue; }
		for (const s of map.sources) {
			if (typeof s !== 'string' || s.startsWith('\0')) { continue; }
			const abs = resolve(dirname(file), map.sourceRoot || '', s.replace(/^[a-z]+:\/\/\/?/i, ''));
			const at = packageDirOf(abs);
			if (!at) { continue; }
			const dir = existsSync(join(at.dir, 'package.json')) ? at.dir : resolvePackage(app, at.name);
			if (dir) { add(dir); }
		}
	}

	// 2. Shipped, the production closure electron-builder packs.
	const root = readJson(join(app, 'package.json'));
	const queue = [[app, { ...root.dependencies, ...root.optionalDependencies }]];
	const visited = new Set();
	while (queue.length) {
		const [from, deps] = queue.shift();
		for (const name of Object.keys(deps ?? {}).sort()) {
			if (NOT_SHIPPED.has(name)) { continue; }
			const dir = resolvePackage(from, name);
			if (!dir) { continue; }
			const real = realpathSync(dir);
			if (visited.has(real)) { continue; }
			visited.add(real);
			add(dir);
			const pkg = readJson(join(dir, 'package.json')) ?? {};
			const optionalPeers = pkg.peerDependenciesMeta ?? {};
			const peers = Object.fromEntries(Object.entries(pkg.peerDependencies ?? {}).filter(([n]) => !optionalPeers[n]?.optional));
			queue.push([dir, { ...pkg.dependencies, ...pkg.optionalDependencies, ...peers }]);
		}
	}

	// Electron's runtime is the app.
	const electron = resolvePackage(app, 'electron');
	if (electron) { add(electron); }

	const own = root.name;
	const byKey = new Map();
	for (const dir of [...dirs.keys()].sort()) {
		const e = entryFor(dir);
		if (!e || e.name === own || e.name.startsWith('@snout/') || e.pkg.private === true) { continue; }
		const key = `${e.name}@${e.version}`;
		if (!byKey.has(key)) { byKey.set(key, e); }
	}
	return [...byKey.values()];
}

/** Studio's own NOTICE and LICENSE: at the repository root in the open tree; the official build reads
 *  the open tree's root files from where the assembler takes them (its manifest's rootFiles.from). */
export function ownFile(app, name) {
	const root = join(app, '..', '..');
	const from = readJson(join(root, 'scripts', 'open-source', 'manifest.json'))?.open?.rootFiles?.from;
	const dirs = [root, ...(typeof from === 'string' ? [join(root, from)] : [])];
	for (const dir of dirs) {
		if (existsSync(join(dir, name))) { return join(dir, name); }
	}
	return null;
}

function main() {
	const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
	const entries = collect(app);
	const version = readJson(join(app, 'package.json'))?.version ?? '';
	const outDir = join(app, LICENSES_DIR);
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, THIRD_PARTY_FILE), formatReport(entries, { version }));
	for (const [name, dest] of [['NOTICE', NOTICE_FILE], ['LICENSE', LICENSE_FILE]]) {
		const src = ownFile(app, name);
		if (!src) { throw new Error(`cannot find Studio's ${name} (looked at the repository root and the open tree's root files)`); }
		copyFileSync(src, join(outDir, dest));
	}
	console.log(`[third-party-licenses] ${entries.length} packages -> ${LICENSES_DIR}/${THIRD_PARTY_FILE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { main(); } catch (err) {
		console.error(`[third-party-licenses] ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Is the build in out/ the build this tree is supposed to make?
//
// The private packages (Data Flows, the companion) are compiled in when they are present and left out when
// they are not (scripts/pro.mjs, scripts/liby.mjs). That rule's failure mode is silent: an official
// release built on a checkout missing them would ship without them and nobody would notice until a
// user did. So every package/release script runs this between `build` and `electron-builder`: an
// official tree must produce a build WITH both, and an open tree (or SNOUT_PRO=0) one with NEITHER.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { libyBuildMarker, libyPaths } from './liby.mjs';
import { proPaths } from './pro.mjs';
import { LICENSE_FILE, LICENSES_DIR, NOTICE_FILE, THIRD_PARTY_FILE } from './third-party-licenses.mjs';

const app = process.cwd();

// `--release`, run first by `npm run release`, before anything is built: publishing goes to the
// OFFICIAL feed (electron-builder.yml's `publish` block, snoutdata/studio), so only the official tree
// may do it. An open build has no updater and checks no feed; a fork that wants updates adds its
// own feed and its own release script.
if (process.argv.includes('--release')) {
	if (!(proPaths(app).real && libyPaths(app).real)) {
		console.error("[assert-build] `npm run release` publishes SnoutData's official release to its feed, so it runs only in the official build. A build from this tree has no updater: package it with `npm run package`, and if your fork wants updates, give it a feed of your own and a release script of your own.");
		process.exit(1);
	}
	console.log('[assert-build] official tree: release may proceed');
	process.exit(0);
}

// The licences the build writes (scripts/third-party-licenses.mjs, run by `npm run build`): the
// third-party list, and Studio's own NOTICE and LICENSE. The list must name what the renderer bundles,
// which is the half no node_modules electron-builder packs would carry.
const LICENCE_FILES = [THIRD_PARTY_FILE, NOTICE_FILE, LICENSE_FILE].map((name) => `${LICENSES_DIR}/${name}`);
function licenceProblems(read) {
	const problems = [];
	for (const file of LICENCE_FILES) {
		const text = read(file);
		if (text === null) { problems.push(`${file} is missing`); } else if (text.trim() === '') { problems.push(`${file} is empty`); }
	}
	const list = read(LICENCE_FILES[0]);
	if (list) {
		const missing = ['react', 'react-dom', 'monaco-editor', '@vscode/codicons', 'electron'].filter((name) => !new RegExp(`^${name.replace(/[/.]/g, '\\$&')} \\d`, 'm').test(list));
		if (missing.length) { problems.push(`${LICENCE_FILES[0]} does not list ${missing.join(', ')}`); }
	}
	return problems;
}
function readOut(file) {
	try { return readFileSync(join(app, file), 'utf8'); } catch { return null; }
}

// `--package [dir]`, run after electron-builder: the licences must be INSIDE what it packed, byte for
// byte what the build wrote. Looks under release/ (or the given folder) for each packaged app's
// app.asar (win-unpacked/resources, linux-unpacked/resources, *.app/Contents/Resources) written after
// the licences were, so an older package left in release/ neither passes nor fails this one.
if (process.argv.includes('--package')) {
	const at = process.argv.indexOf('--package');
	const given = process.argv[at + 1] && !process.argv[at + 1].startsWith('--') ? process.argv[at + 1] : 'release';
	const root = resolve(app, given);
	const outProblems = licenceProblems(readOut);
	if (outProblems.length) {
		console.error(`[assert-build] ${outProblems.join('; ')}.`);
		process.exit(1);
	}
	const built = statSync(join(app, LICENCE_FILES[0])).mtimeMs;
	const found = [];
	function walk(dir, depth) {
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isFile() && e.name === 'app.asar') { found.push({ kind: 'asar', path: p }); }
			else if (e.isDirectory() && e.name === 'app' && existsSync(join(p, 'package.json')) && /[\\/]resources$/i.test(dir)) { found.push({ kind: 'dir', path: p }); }
			else if (e.isDirectory() && depth < 5 && !e.name.endsWith('.asar.unpacked') && e.name !== 'node_modules') { walk(p, depth + 1); }
		}
	}
	walk(root, 0);
	const fresh = found.filter((f) => statSync(f.path).mtimeMs >= built - 1000);
	if (fresh.length === 0) {
		console.error(`[assert-build] no packaged app newer than ${LICENCE_FILES[0]} under ${relative(app, root) || '.'} (found ${found.length} older). Run this right after electron-builder.`);
		process.exit(1);
	}
	const asar = fresh.some((f) => f.kind === 'asar') ? createRequire(import.meta.url)('@electron/asar') : null;
	const failures = [];
	for (const f of fresh) {
		function readPacked(file) {
			try {
				return f.kind === 'asar' ? asar.extractFile(f.path, file).toString('utf8') : readFileSync(join(f.path, file), 'utf8');
			} catch { return null; }
		}
		const where = relative(app, f.path);
		const problems = licenceProblems(readPacked);
		for (const file of LICENCE_FILES) {
			const packed = readPacked(file);
			if (packed !== null && packed !== readOut(file)) { problems.push(`${file} differs from out/`); }
		}
		if (problems.length) { failures.push(`${where}: ${problems.join('; ')}`); }
		else { console.log(`[assert-build] ${where}: the third-party licences, NOTICE and LICENSE are packed`); }
	}
	if (failures.length) {
		console.error(`[assert-build] the package does not carry the licences: ${failures.join(' | ')}.`);
		process.exit(1);
	}
	process.exit(0);
}

const main = readFileSync(join(app, 'out/main/index.js'), 'utf8');
const assetsDir = join(app, 'out/renderer/assets');
const renderer = readdirSync(assetsDir).filter((name) => name.endsWith('.js')).map((name) => readFileSync(join(assetsDir, name), 'utf8')).join('\n');

// One marker each that only the private code carries (main is not minified; the renderer's strings
// survive minification). The companion's comes from her own package, so this file does not quote her.
const libyMarker = libyBuildMarker(app);
if (proPaths(app).real && libyPaths(app).real && !libyMarker) {
	console.error('[assert-build] the companion package names no buildMarker to look for.');
	process.exit(1);
}
// The packaging electron-builder is about to read. The official build is the official app (its app
// id, its snoutdata:// scheme, its apt key and source in the .deb); a build from the open tree is
// none of those (scripts/open-source writes its own electron-builder.yml and package name).
const builderYml = readFileSync(join(app, 'electron-builder.yml'), 'utf8');
const pkgJson = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
const pkgName = pkgJson.name;
// The files the .deb maps in by hand (`deb.fpm`, "source=destination"), and which of them set up apt:
// a source entry under /etc/apt/ or a key under /usr/share/keyrings/.
const fpmMaps = [...builderYml.matchAll(/^\s*-\s*"([^"=]+)=([^"]+)"\s*$/gm)].map((m) => ({ from: m[1], to: m[2] }));
const aptMaps = fpmMaps.filter((m) => m.to.startsWith('/etc/apt/') || m.to.startsWith('/usr/share/keyrings/'));
const linuxDir = join(app, 'build/linux');
const aptLooseFiles = existsSync(linuxDir) ? readdirSync(linuxDir).filter((name) => /\.(gpg|asc|sources|list)$/.test(name)) : [];
const has = {
	officialAppId: /^appId:\s*com\.snoutdata\.app\s*$/m.test(builderYml),
	officialProtocol: /^protocols:[\s\S]*?^\s*-\s*snoutdata\s*$/m.test(builderYml),
	aptKeyAndSource: aptMaps.some((m) => m.to.startsWith('/etc/apt/')) && aptMaps.some((m) => m.to.startsWith('/usr/share/keyrings/')),
	aptFilesPresent: aptMaps.length > 0 && aptMaps.every((m) => existsSync(join(app, m.from))),
	aptAnywhere: aptMaps.length > 0 || aptLooseFiles.length > 0 || /apt\.snoutdata\.com/.test(builderYml),
	officialName: pkgName === 'snoutdata',
	// SnoutData's own address as the .deb maintainer or the package author: a build from source
	// names itself as one (scripts/open-source/lib.mjs, OPEN_IDENTITY.maintainer).
	officialMaintainer: /@snoutdata\.com/.test(builderYml.match(/^\s*maintainer:.*$/m)?.[0] ?? '') || /@snoutdata\.com/.test(String(pkgJson.author ?? '')),
	// Registering snoutdata:// with the OS at run time. An open build compiles it out
	// (src/shared/officialBuild.ts, registersAuthProtocol) and signs in over a 127.0.0.1 loopback.
	protocolClient: main.includes('setAsDefaultProtocolClient('),
	dataFlows: main.includes('registerRuntimeComponents'),
	liby: libyMarker !== null && renderer.includes(libyMarker),
	placeholder: renderer.includes('pro-placeholder'),
	// The updater that reads the official feed. An open build compiles it out (src/shared/officialBuild.ts),
	// so it never checks that feed or installs from it.
	feedUpdater: main.includes('new MacSquirrelUpdater('),
};

const official = proPaths(app).real && libyPaths(app).real;
const problems = official
	? [
		!has.dataFlows && 'Data Flows is not in the main bundle',
		!has.liby && 'the companion is not in the renderer',
		has.placeholder && "the renderer carries the open build's Data Flows placeholder",
		!has.feedUpdater && 'the updater is not in the main bundle',
		!has.officialAppId && 'electron-builder.yml does not carry the official app id',
		!has.officialProtocol && 'electron-builder.yml does not register snoutdata://',
		!has.aptKeyAndSource && 'electron-builder.yml does not install the apt key and source in the .deb',
		!has.aptFilesPresent && 'a file the .deb maps into apt is missing',
		!has.officialName && 'package.json is not named snoutdata',
		!has.protocolClient && 'the main bundle does not register snoutdata://',
	]
	: [
		has.dataFlows && 'Data Flows code is in the main bundle of an open build',
		has.liby && "the companion's lines are in the renderer of an open build",
		has.feedUpdater && "the official feed's updater is in the main bundle of an open build",
		has.officialAppId && "electron-builder.yml carries the official app id",
		has.officialProtocol && 'electron-builder.yml registers the official snoutdata:// scheme',
		has.aptAnywhere && 'the packaging carries an apt key or source, which a .deb built from source never installs',
		has.officialName && "package.json carries the official app's name",
		has.officialMaintainer && "the .deb maintainer or the package author is SnoutData's own address",
		has.protocolClient && 'the main bundle of an open build registers snoutdata://',
	];
const failed = [...problems.filter(Boolean), ...licenceProblems(readOut)];
if (failed.length > 0) {
	console.error(`[assert-build] this is ${official ? 'an OFFICIAL' : 'an OPEN-SOURCE'} tree, but: ${failed.join('; ')}.`);
	process.exit(1);
}
console.log(`[assert-build] ${official ? 'official build: Data Flows and the companion are in' : 'open-source build: no private code'}`);

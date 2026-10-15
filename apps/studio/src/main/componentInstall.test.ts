/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import { integrityMatches } from './componentDownload';
import { extractTgz, installSource, keptPath, sourceBytes, sourcePins, zipExtractCommand, type BundlePart } from './componentInstall';
import { HANA_PREBUILT, IBM_CLI_DRIVER_WIN32_X64, hanaParts } from './componentVendors';

/*  Installing a component from pieces fetched from their publishers. What matters here is that a
 *  file which is not the pinned one is REFUSED and leaves an existing install alone, and that a
 *  package carrying every platform's binary unpacks to this platform's only.  */

/** A minimal ustar writer, so the tests build their archives without a `tar` binary. */
function tarHeader(name: string, size: number, type: string, mode = 0o644): Buffer {
	const block = Buffer.alloc(512);
	block.write(name, 0, 100, 'utf8');
	block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
	block.write('0000000\0', 108, 'ascii');
	block.write('0000000\0', 116, 'ascii');
	block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
	block.write('00000000000\0', 136, 'ascii');
	block.write('        ', 148, 'ascii');
	block.write(type, 156, 'ascii');
	block.write('ustar\0', 257, 'ascii');
	block.write('00', 263, 'ascii');
	let sum = 0;
	for (const byte of block) {
		sum += byte;
	}
	block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
	return block;
}

function padded(data: Buffer): Buffer {
	const pad = (512 - (data.length % 512)) % 512;
	return Buffer.concat([data, Buffer.alloc(pad)]);
}

interface Entry { name: string; body?: string; dir?: boolean; pax?: string }

function tgz(entries: Entry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		if (entry.pax) {
			const record = ` path=${entry.pax}\n`;
			let length = record.length;
			length += String(length + String(length).length).length;
			const pax = Buffer.from(`${length}${record}`);
			blocks.push(tarHeader('PaxHeader', pax.length, 'x'), padded(pax));
		}
		if (entry.dir) {
			blocks.push(tarHeader(entry.name, 0, '5', 0o755));
			continue;
		}
		const body = Buffer.from(entry.body ?? '');
		blocks.push(tarHeader(entry.name, body.length, '0'), padded(body));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const sri = (data: Buffer): string => `sha512-${createHash('sha512').update(data).digest('base64')}`;

/** A package shaped like SAP's: every platform's binary under prebuilt/, one of them with a name
 *  longer than ustar's 100 bytes, carried in a PAX header. */
const LONG = `package/prebuilt/darwinarm64/${'n'.repeat(120)}.txt`;
const PACKAGE = tgz([
	{ name: 'package/package.json', body: '{"name":"fake"}' },
	{ name: 'package/lib/index.js', body: 'module.exports = 42;' },
	{ name: 'package/prebuilt/darwinarm64/hana-client.node', body: 'mac arm' },
	{ name: 'package/prebuilt/ntamd64/hana-client.node', body: 'windows' },
	{ name: 'package/prebuilt/linuxx86_64/hana-client.node', body: 'linux' },
	{ name: 'x', pax: LONG, body: 'long name' },
]);

let dir = '';
let server: Server;
let base = '';
const served = new Map<string, Buffer>();

before(async () => {
	dir = mkdtempSync(join(tmpdir(), 'snout-install-'));
	server = createServer((req, res) => {
		const body = served.get(req.url ?? '');
		if (!body) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { 'content-length': body.length }).end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => {
	server.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('integrityMatches', () => {
	const data = Buffer.from('the pinned bytes');
	const file = (): string => {
		const path = join(dir, 'pinned.bin');
		writeFileSync(path, data);
		return path;
	};

	it('accepts a matching sha256 and a matching sha512 SRI string', async () => {
		assert.equal(await integrityMatches(file(), sha256(data)), true);
		assert.equal(await integrityMatches(file(), sha256(data).toUpperCase()), true);
		assert.equal(await integrityMatches(file(), sri(data)), true);
	});

	it('refuses a file that is not the pinned one', async () => {
		const other = Buffer.from('somebody else');
		assert.equal(await integrityMatches(file(), sha256(other)), false);
		assert.equal(await integrityMatches(file(), sri(other)), false);
	});

	it('throws on a pin it cannot check, rather than letting it pass', async () => {
		await assert.rejects(integrityMatches(file(), 'md5-abc'), /not a usable integrity pin/);
		await assert.rejects(integrityMatches(file(), ''), /not a usable integrity pin/);
		await assert.rejects(integrityMatches(file(), 'sha1-AAAA'), /not a usable integrity pin/);
	});
});

describe('keptPath', () => {
	const options = { strip: 'package', only: { dir: 'prebuilt', keep: 'ntamd64' } };

	it('drops the folder npm wraps a package in', () => {
		assert.equal(keptPath('package/lib/index.js', options), 'lib/index.js');
		assert.equal(keptPath('package/', options), undefined);
	});

	it('keeps this platform under prebuilt/ and drops every other platform', () => {
		assert.equal(keptPath('package/prebuilt/ntamd64/hana-client.node', options), 'prebuilt/ntamd64/hana-client.node');
		assert.equal(keptPath('package/prebuilt/darwinarm64/hana-client.node', options), undefined);
		assert.equal(keptPath('package/prebuilt/linuxx86_64_alpine/', options), undefined);
	});

	it('refuses an entry outside the expected wrapper folder', () => {
		assert.throws(() => keptPath('other/lib/index.js', options), /unexpected archive layout/);
	});
});

describe('extractTgz', () => {
	it('unpacks one platform and leaves the others out entirely', async () => {
		const archive = join(dir, 'package.tgz');
		writeFileSync(archive, PACKAGE);
		const dest = join(dir, 'unpacked-one');
		const count = await extractTgz(archive, dest, { strip: 'package', only: { dir: 'prebuilt', keep: 'ntamd64' } });
		assert.equal(count, 3);
		assert.deepEqual(readdirSync(join(dest, 'prebuilt')), ['ntamd64']);
		assert.equal(readFileSync(join(dest, 'prebuilt', 'ntamd64', 'hana-client.node'), 'utf8'), 'windows');
		assert.equal(readFileSync(join(dest, 'lib', 'index.js'), 'utf8'), 'module.exports = 42;');
	});

	it('honours a long name carried in a PAX header', async () => {
		const archive = join(dir, 'package.tgz');
		writeFileSync(archive, PACKAGE);
		const dest = join(dir, 'unpacked-long');
		await extractTgz(archive, dest, { strip: 'package', only: { dir: 'prebuilt', keep: 'darwinarm64' } });
		assert.equal(readFileSync(join(dest, LONG.slice('package/'.length)), 'utf8'), 'long name');
	});

	it('refuses an entry that would land outside the install folder, and writes nothing there', async () => {
		const archive = join(dir, 'evil.tgz');
		writeFileSync(archive, tgz([{ name: 'package/../../escaped.txt', body: 'out' }]));
		const dest = join(dir, 'unpacked-evil', 'inner');
		mkdirSync(dest, { recursive: true });
		await assert.rejects(extractTgz(archive, dest, {}), /outside the install folder/);
		assert.equal(existsSync(join(dir, 'escaped.txt')), false);
		assert.equal(existsSync(join(dir, 'unpacked-evil', 'escaped.txt')), false);
	});

	it('refuses an archive cut off in the middle', async () => {
		const whole = Buffer.concat([tarHeader('package/a.txt', 2000, '0'), Buffer.alloc(600, 1)]);
		const archive = join(dir, 'cut.tgz');
		writeFileSync(archive, gzipSync(whole));
		await assert.rejects(extractTgz(archive, join(dir, 'unpacked-cut'), { strip: 'package' }), /ended in the middle/);
	});
});

describe('installSource', () => {
	function part(path: string, data: Buffer, integrity: string): BundlePart {
		served.set(path, data);
		return { url: `${base}${path}`, integrity, bytes: data.length, format: 'tgz', into: 'node_modules/pkg', strip: 'package', only: { dir: 'prebuilt', keep: 'linuxx86_64' } };
	}

	it('installs a verified piece into its folder, with this platform only', async () => {
		const dest = join(dir, 'component-good');
		await installSource({ parts: [part('/good.tgz', PACKAGE, sri(PACKAGE))] }, dest, join(dir, 'work-good'), 'Fake client', () => {});
		assert.deepEqual(readdirSync(join(dest, 'node_modules', 'pkg', 'prebuilt')), ['linuxx86_64']);
		assert.equal(existsSync(join(dir, 'work-good', 'part-0.download.tgz')), false, 'the download is cleaned up');
	});

	it('refuses a piece that fails its pin, names where it came from, and leaves the old install alone', async () => {
		const dest = join(dir, 'component-bad');
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(dest, 'component.json'), '{"version":"old"}');
		const wrong = sri(Buffer.from('a different file'));
		await assert.rejects(
			installSource({ parts: [part('/bad.tgz', PACKAGE, wrong)] }, dest, join(dir, 'work-bad'), 'Fake client', () => {}),
			/Integrity check failed for Fake client: the file from 127\.0\.0\.1 does not match/,
		);
		assert.equal(readFileSync(join(dest, 'component.json'), 'utf8'), '{"version":"old"}');
	});

	it('refuses the whole install when a LATER piece fails, after an earlier one verified', async () => {
		const dest = join(dir, 'component-later');
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(dest, 'keep.txt'), 'still here');
		const good = part('/first.tgz', PACKAGE, sri(PACKAGE));
		const bad = part('/second.tgz', PACKAGE, sha256(Buffer.from('nope')));
		await assert.rejects(installSource({ parts: [good, bad] }, dest, join(dir, 'work-later'), 'Fake client', () => {}), /Integrity check failed/);
		assert.equal(readFileSync(join(dest, 'keep.txt'), 'utf8'), 'still here');
	});
});

describe('the vendor pins', () => {
	it('fetch SAP and IBM from their own servers, never from our feed', () => {
		const all = [IBM_CLI_DRIVER_WIN32_X64, ...hanaParts('ntamd64')];
		for (const piece of all) {
			const host = new URL(piece.url).hostname;
			assert.ok(host === 'registry.npmjs.org' || host === 'public.dhe.ibm.com', piece.url);
		}
		assert.match(IBM_CLI_DRIVER_WIN32_X64.url, /\/odbc_cli\/v\d+\.\d+\.\d+\/ntx64_odbc_cli\.zip$/, 'pinned to a version folder');
	});

	it('pin every piece to a hash, and name the publisher of each licensed one', () => {
		for (const piece of [IBM_CLI_DRIVER_WIN32_X64, ...hanaParts('ntamd64')]) {
			assert.match(piece.integrity, /^([0-9a-f]{64}|sha512-[A-Za-z0-9+/]+={0,2})$/);
		}
		assert.match(hanaParts('ntamd64')[0]?.notice ?? '', /SAP/);
		assert.match(IBM_CLI_DRIVER_WIN32_X64.notice ?? '', /IBM/);
		for (const notice of [hanaParts('ntamd64')[0]?.notice, IBM_CLI_DRIVER_WIN32_X64.notice]) {
			assert.ok(!notice?.includes('—'), 'no em-dash in user-facing text');
		}
	});

	it('keep one prebuilt folder per platform, the one SAP picks for it', () => {
		for (const [key, prebuilt] of Object.entries(HANA_PREBUILT)) {
			assert.deepEqual(hanaParts(prebuilt)[0]?.only, { dir: 'prebuilt', keep: prebuilt }, key);
		}
	});

	it('size and pin a source with no feed zip from its pieces alone', () => {
		const source = { parts: hanaParts('ntamd64') };
		assert.equal(sourceBytes(source), 40_093_343 + 17_183 + 2_874);
		assert.equal(sourcePins(source).length, 3);
		assert.equal(sourcePins({ url: 'https://x', sha256: '__x__', parts: [IBM_CLI_DRIVER_WIN32_X64] })[0], '__x__');
	});
});

// A path is never PowerShell text: pasted into a single-quoted string, a profile path with an
// apostrophe would break every zip install and could run PowerShell.
describe('zipExtractCommand', () => {
	const zip = "D:\\Profiles\\O'Brien\\AppData\\Roaming\\snoutdata\\components\\db2.zip.download";
	const dest = "D:\\Profiles\\O'Brien\\AppData\\Roaming\\snoutdata\\components\\db2'; Remove-Item -Recurse C:\\ ; '";

	it('hands PowerShell the paths as environment variables, never as script text', () => {
		const command = zipExtractCommand(zip, dest, 'win32');
		assert.equal(command.cmd, 'powershell.exe');
		const script = command.args[command.args.length - 1];
		assert.equal(script, 'Expand-Archive -LiteralPath $env:SNOUT_EXTRACT_ZIP -DestinationPath $env:SNOUT_EXTRACT_DEST -Force');
		for (const arg of command.args) {
			assert.ok(!arg.includes('Brien') && !arg.includes("'"), arg);
		}
		assert.deepEqual(command.env, { SNOUT_EXTRACT_ZIP: zip, SNOUT_EXTRACT_DEST: dest });
	});

	it('hands unzip the paths as arguments, untouched', () => {
		const command = zipExtractCommand("/srv/o'brien/x.zip", "/srv/o'brien/out", 'darwin');
		assert.deepEqual(command, { cmd: 'unzip', args: ['-o', '-q', "/srv/o'brien/x.zip", '-d', "/srv/o'brien/out"] });
	});
});

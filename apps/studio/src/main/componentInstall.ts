/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Installing a component from its pieces: our own zip on the release feed, and pieces fetched
 *  straight from the people who publish them (a vendor's npm package, a vendor's download site).
 *
 *  Some database clients are not hosted by SnoutData: the app fetches them from their publisher,
 *  pinned to one exact file by a hash written into this code, so a changed or substituted file is
 *  refused exactly as a damaged one from our feed would be.
 *
 *  Kept apart from `componentStore.ts` because that file imports `electron`; everything here runs
 *  under plain Node, so the integrity and extraction rules are tested directly.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { createReadStream, mkdirSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix, resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';

import type { VendorTerms } from '../shared/components';
import { checksumComparable, downloadFile, integrityMatches, resolveFeedUrl, type DownloadOptions } from './componentDownload';

/** One file fetched from its publisher and unpacked into a component. */
export interface BundlePart {
	url: string;
	/** A SHA-256 in hex, or `sha512-<base64>` (npm's own `dist.integrity` for the version). */
	integrity: string;
	/** Download size in bytes, for the prompt's estimate and the progress bar. */
	bytes: number;
	format: 'zip' | 'tgz';
	/** Folder, relative to the component's own, to unpack into. The component's folder by default. */
	into?: string;
	/** tgz: the folder every entry sits in, dropped on the way out (`package` for an npm tarball). */
	strip?: string;
	/** tgz: inside `dir`, unpack only the child named `keep`. How a package that carries every
	 *  platform's native binary is reduced to the one this computer runs. */
	only?: { dir: string; keep: string };
	/** One plain sentence naming who publishes this file and under what licence, shown at the
	 *  download prompt. */
	notice?: string;
	/** The vendor's licence, which a person must accept before this part is fetched
	 *  (componentTerms.ts). */
	terms?: VendorTerms;
}

/** What a component is made of on one platform. */
export interface InstallSource {
	/** Our own zip on the release feed, if any. */
	url?: string;
	sha256?: string;
	bytes?: number;
	/** Pieces from their publishers, unpacked after our zip, in order. */
	parts?: readonly BundlePart[];
}

export type InstallPhase = 'download' | 'verify' | 'extract';

/** Total download size of a source, our zip and every piece. */
export function sourceBytes(source: InstallSource): number {
	return (source.bytes ?? 0) + (source.parts ?? []).reduce((sum, part) => sum + part.bytes, 0);
}

/** Every pin a source carries, ours and the publishers'. */
export function sourcePins(source: InstallSource): string[] {
	const pins = (source.parts ?? []).map((part) => part.integrity);
	return source.url !== undefined ? [source.sha256 ?? '', ...pins] : pins;
}

/**
 * Download every piece, verify every piece, and only then replace `dest` with what they unpack to.
 *
 * The order matters: a publisher's server being down, or a file that fails its pin, must leave a
 * working install exactly as it was. So nothing in `dest` is touched until all the bytes are here
 * and all of them have matched.
 */
export async function installSource(
	source: InstallSource,
	dest: string,
	workDir: string,
	label: string,
	onProgress: (phase: InstallPhase, received?: number, total?: number) => void,
	options: DownloadOptions = {},
): Promise<void> {
	mkdirSync(workDir, { recursive: true });
	const total = sourceBytes(source) || undefined;
	const files: { path: string; part?: BundlePart }[] = [];
	try {
		let done = 0;
		const fetchOne = async (url: string, path: string, bytes: number): Promise<void> => {
			onProgress('download', done, total);
			await downloadFile(resolveFeedUrl(url), path, (received) => onProgress('download', done + received, total), options);
			done += bytes;
		};

		if (source.url !== undefined) {
			const path = join(workDir, 'bundle.download.zip');
			files.push({ path });
			await fetchOne(source.url, path, source.bytes ?? 0);
		}
		for (const [index, part] of (source.parts ?? []).entries()) {
			const path = join(workDir, `part-${index}.download.${part.format}`);
			files.push({ path, part });
			await fetchOne(part.url, path, part.bytes);
		}

		onProgress('verify');
		for (const file of files) {
			const pin = file.part ? file.part.integrity : (source.sha256 ?? '');
			if (checksumComparable(pin) && !(await integrityMatches(file.path, pin))) {
				const from = file.part ? ` from ${new URL(file.part.url).hostname}` : '';
				throw new Error(`Integrity check failed for ${label}: the file${from} does not match the one this app expects. Nothing was installed.`);
			}
		}

		onProgress('extract');
		rmSync(dest, { recursive: true, force: true });
		mkdirSync(dest, { recursive: true });
		for (const file of files) {
			if (!file.part) {
				await extractZip(file.path, dest);
				continue;
			}
			const into = file.part.into ? safeJoin(dest, file.part.into) : dest;
			mkdirSync(into, { recursive: true });
			if (file.part.format === 'zip') {
				await extractZip(file.path, into);
			} else {
				await extractTgz(file.path, into, { strip: file.part.strip, only: file.part.only });
			}
		}
	} finally {
		// Finished downloads go; a `.part` from a cancelled or dropped transfer stays, so the next
		// attempt resumes it (downloadFile renames a part only once it is complete).
		for (const file of files) {
			rmSync(file.path, { force: true });
		}
	}
}

/**
 * Extract a zip into destDir. Windows ships PowerShell's Expand-Archive everywhere, which avoids a
 * native unzip dependency; mac and Linux use `unzip`, which is what restores the SYMLINKS a
 * mac/Linux bundle of shared libraries is built around (the loader resolves a SONAME, so a
 * dereferenced link chain is a directory with every byte present and nothing loadable).
 */
export function extractZip(zip: string, destDir: string): Promise<void> {
	const command = zipExtractCommand(zip, destDir, process.platform);
	return runProcess(command.cmd, command.args, command.env);
}

/** How a zip is unpacked on `platform`: the program, its arguments, and environment to add. */
export interface ZipExtractCommand {
	cmd: string;
	args: string[];
	env?: Record<string, string>;
}

/**
 * The command that unpacks `zip` into `destDir`. On Windows the two paths reach PowerShell as
 * ENVIRONMENT VARIABLES the fixed script reads, never as text inside the script: a profile path
 * with an apostrophe (a user named O'Brien) closed the quoted string it was pasted into, which
 * broke every zip install for that user and let a path run PowerShell. `unzip` takes them as
 * arguments, which no shell reads.
 */
export function zipExtractCommand(zip: string, destDir: string, platform: NodeJS.Platform): ZipExtractCommand {
	if (platform === 'win32') {
		return {
			cmd: 'powershell.exe',
			args: [
				'-NoProfile', '-NonInteractive', '-Command',
				'Expand-Archive -LiteralPath $env:SNOUT_EXTRACT_ZIP -DestinationPath $env:SNOUT_EXTRACT_DEST -Force',
			],
			env: { SNOUT_EXTRACT_ZIP: zip, SNOUT_EXTRACT_DEST: destDir },
		};
	}
	return { cmd: 'unzip', args: ['-o', '-q', zip, '-d', destDir] };
}

function runProcess(cmd: string, args: string[], env?: Record<string, string>): Promise<void> {
	return new Promise<void>((resolvePromise, reject) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
		let stderr = '';
		child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
		child.on('error', reject);
		child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`))));
	});
}

/** Join a relative path onto a root, refusing anything that would land outside it. */
function safeJoin(root: string, relative: string): string {
	const normal = posix.normalize(relative.replace(/\\/g, '/'));
	if (normal === '..' || normal.startsWith('../') || posix.isAbsolute(normal) || isAbsolute(relative) || /^[A-Za-z]:/.test(normal)) {
		throw new Error(`refusing an archive path outside the install folder: ${relative}`);
	}
	const base = resolve(root);
	const target = resolve(base, normal);
	if (target !== base && !target.startsWith(base + sep)) {
		throw new Error(`refusing an archive path outside the install folder: ${relative}`);
	}
	return target;
}

export interface TgzOptions {
	strip?: string;
	only?: { dir: string; keep: string };
}

/**
 * Unpack a gzipped tar (an npm tarball) into destDir, streamed, without a `tar` binary.
 *
 * Windows has no dependable `tar` and an npm tarball is a simple archive, so this reads the format
 * itself: regular files and folders, with long names from PAX or GNU headers. Links are skipped
 * (npm does not publish them). Every path is checked to land inside destDir before a byte is
 * written, and with `only`, the entries outside the kept child are never written at all, so a
 * package carrying seven platforms' binaries costs one platform's disk.
 *
 * Returns how many files were written.
 */
export async function extractTgz(file: string, destDir: string, options: TgzOptions = {}): Promise<number> {
	const reader = new TarReader();
	let written = 0;
	const input = createReadStream(file);
	const gunzip = createGunzip();
	// A read error has to reach the loop below, which only listens to the gunzip side.
	input.on('error', (err) => gunzip.destroy(err));
	input.pipe(gunzip);
	try {
		for await (const chunk of gunzip as AsyncIterable<Buffer>) {
			for (const entry of reader.push(chunk)) {
				const relative = keptPath(entry.path, options);
				if (relative === undefined) {
					continue;
				}
				const target = safeJoin(destDir, relative);
				if (entry.type === 'dir') {
					await mkdir(target, { recursive: true });
					continue;
				}
				await mkdir(resolve(target, '..'), { recursive: true });
				await writeFile(target, entry.data, { mode: (entry.mode & 0o755) | 0o600 });
				written++;
			}
		}
	} finally {
		input.destroy();
	}
	if (!reader.finished()) {
		throw new Error('the archive ended in the middle of a file');
	}
	return written;
}

/** Where an archive entry goes, relative to the destination, or undefined to leave it out. */
export function keptPath(path: string, options: TgzOptions): string | undefined {
	let relative = path.replace(/\\/g, '/').replace(/^\.\//, '');
	if (options.strip) {
		const prefix = `${options.strip.replace(/\/+$/, '')}/`;
		if (relative === prefix || relative === prefix.slice(0, -1)) {
			return undefined;
		}
		if (!relative.startsWith(prefix)) {
			throw new Error(`unexpected archive layout: ${path} is not under ${prefix}`);
		}
		relative = relative.slice(prefix.length);
	}
	relative = relative.replace(/\/+$/, '');
	if (relative === '') {
		return undefined;
	}
	if (options.only) {
		const dir = `${options.only.dir.replace(/\/+$/, '')}/`;
		if (relative.startsWith(dir)) {
			const child = relative.slice(dir.length).split('/')[0];
			if (child !== options.only.keep) {
				return undefined;
			}
		}
	}
	return relative;
}

interface TarEntry {
	path: string;
	type: 'file' | 'dir';
	mode: number;
	data: Buffer;
}

/** An incremental tar parser: feed it bytes, it hands back each entry once its body is complete. */
class TarReader {
	private pending: Buffer = Buffer.alloc(0);
	private body: { header: TarHeader; remaining: number; chunks: Buffer[] } | undefined;
	private padding = 0;
	private ended = false;
	private paxPath: string | undefined;
	private longName: string | undefined;

	finished(): boolean {
		return this.ended || (this.body === undefined && this.padding === 0 && this.pending.length === 0);
	}

	*push(chunk: Buffer): Generator<TarEntry> {
		const data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
		this.pending = Buffer.alloc(0);
		let offset = 0;
		while (offset < data.length && !this.ended) {
			if (this.body) {
				const take = Math.min(this.body.remaining, data.length - offset);
				this.body.chunks.push(data.subarray(offset, offset + take));
				offset += take;
				this.body.remaining -= take;
				if (this.body.remaining === 0) {
					const { header, chunks } = this.body;
					this.body = undefined;
					this.padding = (512 - (header.size % 512)) % 512;
					const entry = this.complete(header, Buffer.concat(chunks));
					if (entry) {
						yield entry;
					}
				}
				continue;
			}
			if (this.padding > 0) {
				const take = Math.min(this.padding, data.length - offset);
				offset += take;
				this.padding -= take;
				continue;
			}
			if (data.length - offset < 512) {
				this.pending = Buffer.from(data.subarray(offset));
				break;
			}
			const block = data.subarray(offset, offset + 512);
			offset += 512;
			if (block.every((byte) => byte === 0)) {
				this.ended = true;
				break;
			}
			const header = parseHeader(block);
			if (header.size > 0) {
				this.body = { header, remaining: header.size, chunks: [] };
			} else {
				const entry = this.complete(header, Buffer.alloc(0));
				if (entry) {
					yield entry;
				}
			}
		}
	}

	private complete(header: TarHeader, data: Buffer): TarEntry | undefined {
		if (header.type === 'x') {
			this.paxPath = paxValue(data, 'path') ?? this.paxPath;
			return undefined;
		}
		if (header.type === 'L') {
			this.longName = data.toString('utf8').replace(/\0.*$/s, '');
			return undefined;
		}
		const path = this.paxPath ?? this.longName ?? header.name;
		this.paxPath = undefined;
		this.longName = undefined;
		if (header.type === '0' || header.type === '\0' || header.type === '7') {
			return { path, type: 'file', mode: header.mode, data };
		}
		if (header.type === '5') {
			return { path, type: 'dir', mode: header.mode, data };
		}
		// 'g' (global PAX), links and devices: nothing to write.
		return undefined;
	}
}

interface TarHeader {
	name: string;
	mode: number;
	size: number;
	type: string;
}

function parseHeader(block: Buffer): TarHeader {
	const text = (start: number, length: number): string => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
	const octal = (start: number, length: number, what: string): number => {
		if ((block[start] ?? 0) & 0x80) {
			throw new Error(`unsupported tar ${what} encoding`);
		}
		const value = text(start, length).trim();
		return value === '' ? 0 : parseInt(value, 8);
	};
	let checksum = 0;
	for (let i = 0; i < 512; i++) {
		checksum += i >= 148 && i < 156 ? 32 : (block[i] ?? 0);
	}
	if (checksum !== octal(148, 8, 'checksum')) {
		throw new Error('the archive is damaged (a tar header checksum does not match)');
	}
	const name = text(0, 100);
	const prefix = text(257, 6).startsWith('ustar') ? text(345, 155) : '';
	return {
		name: prefix ? `${prefix}/${name}` : name,
		mode: octal(100, 8, 'mode'),
		size: octal(124, 12, 'size'),
		type: String.fromCharCode(block[156] ?? 0),
	};
}

/** One value out of a PAX extended header (`<len> <key>=<value>\n` records). */
function paxValue(data: Buffer, key: string): string | undefined {
	let offset = 0;
	while (offset < data.length) {
		const space = data.indexOf(0x20, offset);
		if (space === -1) {
			break;
		}
		const length = parseInt(data.subarray(offset, space).toString('utf8'), 10);
		if (!Number.isFinite(length) || length <= 0) {
			break;
		}
		const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
		const equals = record.indexOf('=');
		if (equals !== -1 && record.slice(0, equals) === key) {
			return record.slice(equals + 1);
		}
		offset += length;
	}
	return undefined;
}

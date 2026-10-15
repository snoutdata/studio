/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { WorkspaceFile, WorkspaceSearchHit } from '../shared/workspace';

/**
 * The workspace: a real folder of `.sql` files on disk (DBeaver-style). Only the root-folder
 * pointer is persisted as JSON (in `userData/workspace.json`, like queryStore.ts); the files
 * themselves are read/written directly so they're portable and version-controllable. The model
 * is flat for now (direct children of the root only). Every path that crosses the IPC boundary
 * is clamped to a direct child of the root before any fs op (`resolveInRoot`) so a malicious or
 * buggy caller can't read/write outside the workspace.
 *
 * Names are not enough on their own: a cloned repository can carry `notes.sql -> ~/.ssh/id_ed25519`,
 * or a dangling `query.sql -> ~/.zshenv` that a create would have written through. So a link is
 * judged by where it really points (its realpath against the root's): one that stays inside the
 * root reads and lists like the file, one that leaves it is refused and never listed or searched,
 * and nothing is ever WRITTEN through a link. Existence is `lstat`, so a dangling link counts as
 * a taken name.
 */

// Search budgets (kept small for a snappy, local scan; same spirit as historyContext.ts).
const MAX_HITS = 50;
const MAX_MATCHES_PER_FILE = 5;
const MAX_LINE_CHARS = 200;

interface WorkspaceConfig {
	root?: string;
}

export class WorkspaceStore {
	/** `baseDir` is the app's userData dir; the root pointer and default workspace live under it.
	 *  Passed in (not read from Electron) so this module stays node-testable. */
	constructor(private readonly baseDir: string) {}

	private configPath(): string {
		return join(this.baseDir, 'workspace.json');
	}

	private readConfig(): WorkspaceConfig {
		const path = this.configPath();
		if (!existsSync(path)) {
			return {};
		}
		try {
			return JSON.parse(readFileSync(path, 'utf8')) as WorkspaceConfig;
		} catch {
			return {};
		}
	}

	private writeConfig(config: WorkspaceConfig): void {
		const path = this.configPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
	}

	/** The workspace root folder, created on first read. Defaults to `userData/workspace`. */
	root(): string {
		const stored = this.readConfig().root;
		const root = stored && stored.trim() ? stored : join(this.baseDir, 'workspace');
		mkdirSync(root, { recursive: true });
		return root;
	}

	/** Point the workspace at a different folder (created if missing). */
	setRoot(path: string): string {
		const root = resolve(path);
		mkdirSync(root, { recursive: true });
		this.writeConfig({ root });
		return root;
	}

	/** Resolve a caller-supplied path/name to a direct child of the root, or throw. */
	private resolveInRoot(pathOrName: string): string {
		const root = this.root();
		const abs = isAbsolute(pathOrName) ? resolve(pathOrName) : resolve(root, pathOrName);
		const rel = relative(root, abs);
		if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) {
			throw new Error('Path is outside the workspace.');
		}
		return abs;
	}

	/** True when `abs` is something on disk, a dangling link included (`existsSync` follows links,
	 *  so it calls a dangling one free and a write would go through it). */
	private taken(abs: string): boolean {
		return lstatOf(abs) !== undefined;
	}

	/** Whether a REAL path is inside the root's real path. */
	private insideRoot(real: string): boolean {
		const rel = relative(realpathSync(this.root()), real);
		return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
	}

	/** `abs` for a read: a link is followed only when it lands inside the root. */
	private readable(abs: string): string {
		const stat = lstatOf(abs);
		if (stat?.isSymbolicLink()) {
			let real: string;
			try {
				real = realpathSync(abs);
			} catch {
				throw new Error('This file is a link to something that does not exist.');
			}
			if (!this.insideRoot(real)) {
				throw new Error('This file is a link to somewhere outside the workspace.');
			}
		}
		return abs;
	}

	/** `abs` for a write into an existing file: never through a link. */
	private writable(abs: string): string {
		if (lstatOf(abs)?.isSymbolicLink()) {
			throw new Error('This file is a link, and the workspace does not write through links.');
		}
		return abs;
	}

	/** Normalize a name to a safe `*.sql` file name (no path parts). */
	private sqlName(name: string): string {
		const base = basename(name.trim()).replace(/[\\/:*?"<>|]/g, '').trim() || 'query';
		return base.toLowerCase().endsWith('.sql') ? base : `${base}.sql`;
	}

	/** Pick a non-colliding path in the root for `name` (appends -2, -3, … on collision). */
	private uniquePath(name: string): string {
		const root = this.root();
		const fileName = this.sqlName(name);
		const stem = fileName.slice(0, -'.sql'.length);
		let candidate = join(root, fileName);
		let n = 2;
		while (this.taken(candidate)) {
			candidate = join(root, `${stem}-${n}.sql`);
			n += 1;
		}
		return candidate;
	}

	private toFile(abs: string): WorkspaceFile {
		const stat = statSync(abs);
		return {
			name: basename(abs),
			path: abs,
			relPath: relative(this.root(), abs),
			size: stat.size,
			modifiedAt: stat.mtimeMs,
		};
	}

	/** All `.sql` files directly in the root, newest-modified first. */
	list(): WorkspaceFile[] {
		const root = this.root();
		let names: string[];
		try {
			names = readdirSync(root);
		} catch {
			return [];
		}
		const files: WorkspaceFile[] = [];
		for (const name of names) {
			if (!name.toLowerCase().endsWith('.sql')) {
				continue;
			}
			const abs = join(root, name);
			try {
				// A link is listed only when it lands on a file inside the root: anything it
				// leads to outside is not the workspace's to show, or to search.
				if (lstatSync(abs).isSymbolicLink() && !this.insideRoot(realpathSync(abs))) {
					continue;
				}
				if (statSync(abs).isFile()) {
					files.push(this.toFile(abs));
				}
			} catch {
				// Skip files that vanished between readdir and stat.
			}
		}
		return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
	}

	read(pathOrName: string): string {
		return readFileSync(this.readable(this.resolveInRoot(pathOrName)), 'utf8');
	}

	/** Write to an existing workspace file (path must already resolve inside the root). */
	save(pathOrName: string, content: string): WorkspaceFile {
		const abs = this.writable(this.resolveInRoot(pathOrName));
		// O_NOFOLLOW where the platform has it, so a link swapped in after the check is refused by
		// the open itself. Windows has no such flag; the check above is what holds there.
		const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644);
		try {
			writeSync(fd, content, null, 'utf8');
		} finally {
			closeSync(fd);
		}
		return this.toFile(abs);
	}

	/** Create a new `.sql` file (deduped name), optionally seeded with content. */
	create(name: string, content = ''): WorkspaceFile {
		const abs = this.uniquePath(name);
		// `wx`: exclusive, so it never opens something already there, a link least of all.
		writeFileSync(abs, content, { encoding: 'utf8', flag: 'wx' });
		return this.toFile(abs);
	}

	/** Copy an external file into the workspace (deduped name), returning the workspace copy. Only a
	 *  regular file, never through a link (`readRegularFile`). */
	importFile(sourcePath: string): WorkspaceFile {
		return this.create(basename(sourcePath), readRegularFile(sourcePath));
	}

	/** Rename a file within the workspace, returning its new descriptor. */
	rename(pathOrName: string, newName: string): WorkspaceFile {
		const from = this.resolveInRoot(pathOrName);
		const root = this.root();
		const target = join(root, this.sqlName(newName));
		const dest = this.taken(target) && target !== from ? this.uniquePath(newName) : target;
		renameSync(from, dest);
		return this.toFile(dest);
	}

	remove(pathOrName: string): void {
		unlinkSync(this.resolveInRoot(pathOrName));
	}

	/** Case-insensitive substring search over file names and contents (capped, local). */
	search(query: string): WorkspaceSearchHit[] {
		const needle = query.trim().toLowerCase();
		if (!needle) {
			return [];
		}
		const hits: WorkspaceSearchHit[] = [];
		for (const file of this.list()) {
			if (hits.length >= MAX_HITS) {
				break;
			}
			const nameMatch = file.name.toLowerCase().includes(needle);
			const matches: { line: number; text: string }[] = [];
			let content = '';
			try {
				content = readFileSync(this.readable(file.path), 'utf8');
			} catch {
				// Unreadable: fall back to a name-only match if it had one.
			}
			if (content) {
				const lines = content.split(/\r?\n/);
				for (let i = 0; i < lines.length && matches.length < MAX_MATCHES_PER_FILE; i += 1) {
					if (lines[i].toLowerCase().includes(needle)) {
						matches.push({ line: i + 1, text: lines[i].trim().slice(0, MAX_LINE_CHARS) });
					}
				}
			}
			if (nameMatch || matches.length > 0) {
				hits.push({ name: file.name, path: file.path, relPath: file.relPath, nameMatch, matches });
			}
		}
		return hits;
	}
}

/**
 * The text of a regular file at an outside path, read without following a link. An import copies
 * it into the workspace, where an agent reads files without asking, so a `.sql` linked to
 * `~/.aws/credentials` is refused rather than copied, and so is anything that is not a regular file
 * (a FIFO would block the read). The open itself refuses a link swapped in after the check where the
 * platform has O_NOFOLLOW; Windows has not, and the check is what holds there.
 */
export function readRegularFile(path: string): string {
	const stat = lstatOf(path);
	if (!stat) {
		throw new Error(`"${basename(path)}" was not found, so it was not imported.`);
	}
	if (stat.isSymbolicLink()) {
		throw new Error(`"${basename(path)}" is a link, so it was not imported. Import the file it points to instead.`);
	}
	const notFile = `"${basename(path)}" is not a regular file, so it was not imported.`;
	if (!stat.isFile()) {
		throw new Error(notFile);
	}
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		if (!fstatSync(fd).isFile()) {
			throw new Error(notFile);
		}
		return readFileSync(fd, 'utf8');
	} finally {
		closeSync(fd);
	}
}

/** `lstat`, or undefined when nothing is there. */
function lstatOf(abs: string): Stats | undefined {
	try {
		return lstatSync(abs);
	} catch {
		return undefined;
	}
}

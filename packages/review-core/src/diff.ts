/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Reading a unified diff.
 *
 *  The reviewer needs three things out of a diff and nothing else: which files changed, what
 *  happened to each, and WHICH LINES OF THE NEW FILE are new. That last one is what keeps the
 *  review to the change: a 900-line migration directory that a PR added one statement to gets
 *  one statement reviewed, not nine hundred.
 *
 *  Tolerant, like everything else here. Anything it cannot read is skipped rather than thrown,
 *  because a diff can carry binary files, mode changes, renames with no content and (from some
 *  hosts) a truncated body.
 *--------------------------------------------------------------------------------------------*/

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
	/** Repository-relative path AFTER the change (for a deletion, the path that went). */
	path: string;
	/** The path before, when it differs — a rename. */
	previousPath?: string;
	status: FileStatus;
	/** 1-based line numbers in the NEW file that this diff adds or changes. */
	addedLines: number[];
	/** Just the added lines' text, in order, joined with newlines. The fallback source of SQL
	 *  when the host could not supply the file's full new content. */
	addedText: string;
	/** True when the hunk headers were unreadable, so `addedLines` cannot be trusted. */
	unreadable?: boolean;
}

const HUNK = /^@@+ -\d+(?:,(\d+))? (?:-\d+(?:,\d+)? )*\+(\d+)(?:,(\d+))? @@/;

/** Path out of a `--- a/x` / `+++ b/x` line, with git's prefix removed. */
function headerPath(line: string): string | undefined {
	const raw = line.slice(4).trim();
	if (raw === '/dev/null') {
		return undefined;
	}
	// Strip a quoted path ("b/some file.sql") and then the a/ or b/ prefix.
	const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
	const cut = unquoted.replace(/^[ab]\//, '');
	// Trailing tab-separated timestamp, which non-git diffs carry.
	const tab = cut.indexOf('\t');
	return tab === -1 ? cut : cut.slice(0, tab);
}

/** Every file a unified diff touches. */
export function parseDiff(diff: string): ChangedFile[] {
	const files: ChangedFile[] = [];
	const lines = diff.split(/\r?\n/);

	let current: ChangedFile | undefined;
	let newLine = 0;
	let inHunk = false;
	// Lines the current hunk still owes, from its `@@ -a,OLD +b,NEW @@` header. A hunk ends when
	// both reach zero and NOT at the first line that looks like a header: an added line reading
	// `++ b/README.md` is `+++ b/README.md` in the diff, and treating it as a file header would
	// move the rest of a migration onto a path the reviewer skips.
	let oldLeft = 0;
	let newLeft = 0;
	let sawOldNull = false;
	let sawNewNull = false;
	const added: string[] = [];

	const flush = (): void => {
		if (current) {
			current.addedText = added.join('\n');
			files.push(current);
		}
		current = undefined;
		added.length = 0;
		inHunk = false;
		sawOldNull = false;
		sawNewNull = false;
	};

	for (const line of lines) {
		if (inHunk && current) {
			if (line.startsWith('+')) {
				current.addedLines.push(newLine);
				added.push(line.slice(1));
				newLine++;
				newLeft--;
			} else if (line.startsWith('-')) {
				oldLeft--; // removed: no line in the new file
			} else if (line.startsWith('\\')) {
				// "\ No newline at end of file"
			} else if (line.startsWith(' ') || line === '') {
				newLine++;
				oldLeft--;
				newLeft--;
			} else {
				// Anything else ends the hunk early (a truncated body), and is read as a header below.
				inHunk = false;
			}
			if (inHunk) {
				if (oldLeft <= 0 && newLeft <= 0) {
					inHunk = false;
				}
				continue;
			}
		}
		if (line.startsWith('diff --git ')) {
			flush();
			// `diff --git a/x b/x` — the b-side is the path after the change. Quoted paths and
			// paths with spaces make this ambiguous, so it is only a seed; the ---/+++ lines win.
			const m = /^diff --git ["]?a\/(.+?)["]? ["]?b\/(.+?)["]?$/.exec(line);
			current = {
				path: m ? m[2] : line.slice(11).trim(),
				status: 'modified',
				addedLines: [],
				addedText: '',
			};
			if (m && m[1] !== m[2]) {
				current.previousPath = m[1];
			}
			continue;
		}
		if (!current) {
			// A bare unified diff with no `diff --git` header — start a file at its ---/+++ pair.
			if (line.startsWith('--- ')) {
				current = { path: '', status: 'modified', addedLines: [], addedText: '' };
				sawOldNull = headerPath(line) === undefined;
				continue;
			}
			continue;
		}

		if (line.startsWith('--- ')) {
			const p = headerPath(line);
			sawOldNull = p === undefined;
			if (p !== undefined && current.path !== p) {
				current.previousPath = p;
			}
			continue;
		}
		if (line.startsWith('+++ ')) {
			const p = headerPath(line);
			sawNewNull = p === undefined;
			if (p !== undefined) {
				current.path = p;
			}
			if (sawOldNull && !sawNewNull) {
				current.status = 'added';
			} else if (sawNewNull) {
				current.status = 'deleted';
			} else if (current.previousPath && current.previousPath !== current.path) {
				current.status = 'renamed';
			}
			continue;
		}
		if (line.startsWith('rename from ')) {
			current.previousPath = line.slice(12).trim();
			current.status = 'renamed';
			continue;
		}
		if (line.startsWith('rename to ')) {
			current.path = line.slice(10).trim();
			current.status = 'renamed';
			continue;
		}
		if (line.startsWith('new file mode')) {
			current.status = 'added';
			continue;
		}
		if (line.startsWith('deleted file mode')) {
			current.status = 'deleted';
			continue;
		}
		if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
			current.unreadable = true;
			continue;
		}

		const hunk = HUNK.exec(line);
		if (hunk) {
			// An omitted count means one line (`@@ -3 +3 @@`).
			oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
			newLine = Number(hunk[2]);
			newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
			inHunk = oldLeft > 0 || newLeft > 0;
			continue;
		}
		// Outside a hunk, anything else (an `index` line, a trailing summary) is skipped.
	}
	flush();

	return files.filter((f) => f.path !== '');
}

/** Default patterns for "this file might contain SQL a review should look at". */
export const DEFAULT_INCLUDE = [
	'**/*.sql',
	'**/*.ddl',
	'**/*.psql',
	'**/*.pgsql',
	'**/migrate/**',
	'**/migrations/**',
	'**/db/migrate/**',
];

/** Default patterns for "generated, seeded or fixture SQL nobody wants reviewed". */
export const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/vendor/**', '**/fixtures/**', '**/seed/**', '**/seeds/**'];

/** Compile one glob to a RegExp. Supports `**`, `*` and `?`; no braces, no character classes —
 *  every pattern a path filter actually needs, and nothing that needs a dependency. */
function globToRegExp(glob: string): RegExp {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				// `**/` matches any number of directories INCLUDING none.
				if (glob[i + 2] === '/') {
					out += '(?:.*/)?';
					i += 2;
					continue;
				}
				out += '.*';
				i++;
				continue;
			}
			out += '[^/]*';
			continue;
		}
		if (c === '?') {
			out += '[^/]';
			continue;
		}
		out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${out}$`, 'i');
}

export interface PathFilter {
	include?: string[];
	exclude?: string[];
}

/** Whether a path is one the reviewer should read. Exclusions win. */
export function isReviewablePath(path: string, filter?: PathFilter): boolean {
	const normalised = path.replace(/\\/g, '/').replace(/^\.\//, '');
	const exclude = filter?.exclude ?? DEFAULT_EXCLUDE;
	if (exclude.some((g) => globToRegExp(g).test(normalised))) {
		return false;
	}
	const include = filter?.include ?? DEFAULT_INCLUDE;
	return include.some((g) => globToRegExp(g).test(normalised));
}

/** The changed files worth reading: reviewable path, not deleted, not binary. */
export function reviewableFiles(diff: string, filter?: PathFilter): ChangedFile[] {
	return parseDiff(diff).filter(
		(f) => f.status !== 'deleted' && !f.unreadable && f.addedLines.length > 0 && isReviewablePath(f.path, filter),
	);
}

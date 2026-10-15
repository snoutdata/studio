/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute, relative, resolve, sep } from 'node:path';

/*---------------------------------------------------------------------------------------------
 *  Which file paths the renderer may hand back to main.
 *
 *  Some IPC channels take a path from the renderer and then write it, copy it or stream it into a
 *  database. The renderer is the app's own page, but it renders text a model wrote, and a page
 *  that ever ran anything else could name any file on the machine. So a path is accepted only when
 *  MAIN produced it in this session (a file dialog, a scan main ran) or when it lies under one of
 *  the channel's roots (the workspace folder). Grants are per channel: a file picked to load into a
 *  table is not thereby a file the editor may overwrite.
 *
 *  The app's own data folder is never a root. It holds what main reads back and trusts (the MCP
 *  token and port, component code that is loaded later, the review store's GitLab address), so a
 *  page that could write there without a dialog would not need any other way in. It is passed as a
 *  DENIED root instead: a path under it is refused even when a broader root (a workspace folder the
 *  person set to their home) contains it, unless the root it came through is itself inside it (the
 *  default workspace, `userData/workspace`).
 *
 *  Pure apart from `path`, so a test holds it without Electron.
 *--------------------------------------------------------------------------------------------*/

export type PathChannel = 'file:save' | 'workspace:importPaths' | 'sql:bulkLoad';

/** The form a path is compared in: absolute and normalised, case-folded where the file system is. */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
	const absolute = resolve(path);
	return platform === 'win32' || platform === 'darwin' ? absolute.toLowerCase() : absolute;
}

/** Whether `path` is `root` itself or somewhere under it, after `..` is resolved. */
export function isInsideRoot(root: string, path: string, platform: NodeJS.Platform = process.platform): boolean {
	const rel = relative(pathKey(root, platform), pathKey(path, platform));
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Whether `path` is somewhere under `root` and is not `root` itself. */
function isStrictlyInside(root: string, path: string, platform: NodeJS.Platform): boolean {
	return isInsideRoot(root, path, platform) && pathKey(root, platform) !== pathKey(path, platform);
}

/**
 * Where `file:save` may write with no dialog: under the workspace folder, never in the app's own
 * data folder outside it (see the header). Everything else goes through the Save dialog.
 */
export function fileSaveRoots(workspaceRoot: string, userData: string): { roots: string[]; denied: string[] } {
	return { roots: [workspaceRoot], denied: [userData] };
}

export class PathGrants {
	private readonly granted = new Map<PathChannel, Set<string>>();

	constructor(private readonly platform: NodeJS.Platform = process.platform) {}

	/** Main produced this path for this channel (a dialog the person answered, a scan main ran). */
	grant(channel: PathChannel, ...paths: string[]): void {
		let set = this.granted.get(channel);
		if (!set) {
			set = new Set();
			this.granted.set(channel, set);
		}
		for (const path of paths) {
			if (path) {
				set.add(pathKey(path, this.platform));
			}
		}
	}

	/** May the renderer use this path on this channel? Only a non-empty, absolute path, granted
	 *  here or under one of `roots` (and not under a `denied` root that contains that root), is. */
	allowed(channel: PathChannel, path: unknown, roots: readonly string[] = [], denied: readonly string[] = []): path is string {
		if (typeof path !== 'string' || path === '' || path.includes('\0') || !isAbsolute(path)) {
			return false;
		}
		if (this.granted.get(channel)?.has(pathKey(path, this.platform))) {
			return true;
		}
		return roots.some((root) => root !== '' && isInsideRoot(root, path, this.platform)
			&& !denied.some((deny) => deny !== '' && isInsideRoot(deny, path, this.platform) && !isStrictlyInside(deny, root, this.platform)));
	}
}

/**
 * The connection-import refs the renderer may hand back to `import:apply`.
 *
 * An import ref names where main should look again for a connection's password: a tool's config
 * file, a container engine's socket, a host. `import:apply` re-reads it in main, so a ref the page
 * made up would have main read (and keep the passwords of) any file it named. A ref is accepted
 * only when a scan main ran this session listed it, for that source: `import:scan`,
 * `import:browse` (main's own file picker) and `discover:run` all pass their results through
 * {@link ImportGrants.grantScan} on the way out.
 *
 * SnoutData Cloud is the exception, and not a file: its ref is the account's own project, which the
 * control plane resolves for the signed-in user and nobody else.
 */
export class ImportGrants {
	private readonly listed = new Set<string>();

	constructor(private readonly platform: NodeJS.Platform = process.platform) {}

	private key(source: string, file: string): string {
		return `${source}\n${isAbsolute(file) ? pathKey(file, this.platform) : file}`;
	}

	/** Remember every ref a scan main ran is about to hand the renderer. Returns the result as is. */
	grantScan<T extends { sourceId: string; items: ReadonlyArray<{ ref: { file: string } }> } | null | undefined>(result: T): T {
		if (result) {
			for (const item of result.items) {
				if (typeof item.ref?.file === 'string' && item.ref.file !== '') {
					this.listed.add(this.key(result.sourceId, item.ref.file));
				}
			}
		}
		return result;
	}

	/** The refs, of those the renderer sent, that a scan listed for this source; the rest are dropped. */
	allowedRefs(source: string, refs: unknown): Array<{ file: string; connId: string }> {
		if (!Array.isArray(refs)) {
			return [];
		}
		const wellFormed = refs.filter((ref): ref is { file: string; connId: string } =>
			!!ref && typeof ref === 'object' && typeof (ref as { file?: unknown }).file === 'string' && typeof (ref as { connId?: unknown }).connId === 'string'
			&& !(ref as { file: string }).file.includes('\0'));
		if (source === 'snoutdata-cloud') {
			return wellFormed;
		}
		return wellFormed.filter((ref) => this.listed.has(this.key(source, ref.file)));
	}
}

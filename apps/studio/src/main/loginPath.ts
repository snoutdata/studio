/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';

/*
 * What PATH the user's TOOLS are on, which is not the PATH this process was given.
 *
 * A macOS app started from Finder, the Dock or Spotlight is started by launchd, and launchd hands
 * it `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. None of the places a developer's tools
 * actually live are on it: not `/usr/local/bin`, not `/opt/homebrew/bin`, not `~/.local/bin`, and
 * certainly not the version-specific bin directory nvm/volta/asdf/fnm put node in. A Linux app
 * started from a .desktop entry has a fuller PATH but still no `~/.local/bin`. Only a launch from
 * a terminal inherits the shell's PATH, which is why "it works in `npm run dev`" and is not a
 * defence.
 *
 * That cost us twice over, and the second half is the one that would have been hard to find:
 *
 *   1. Discovery reported every coding agent as "Not installed" on a machine that has them, since
 *      `resolveOnPath` was looking down a four-directory PATH.
 *   2. Even a found agent would have been launched with that same crippled PATH, so its own tools
 *      (node, git, ripgrep, the user's package manager) would be missing from underneath it.
 *
 * So this resolves the PATH once, and the answer is used for BOTH: finding the binary and the
 * environment the agent runs in.
 *
 * The reliable answer is to ask the user's own login shell, because a version manager's bin
 * directory is not guessable. That is one spawn of `$SHELL`, off the boot path, cached for the life
 * of the app, on a timeout, with the static list below as the fallback when it fails or hangs. It
 * does not weaken the agent console's "the PTY's child is the agent binary, not a shell" rule: this
 * shell exists for as long as it takes to print a string, and the agent never sees it.
 */

/** Where tools land when nobody asked a shell. Appended, so the shell's own order still wins. */
export function wellKnownBinDirs(home: string | undefined, platform: NodeJS.Platform): string[] {
	if (platform === 'win32') {
		return [];
	}
	const dirs = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin', '/opt/local/bin'];
	if (home) {
		dirs.unshift(
			`${home}/.local/bin`,
			`${home}/bin`,
			`${home}/.bun/bin`,
			`${home}/.deno/bin`,
			`${home}/.cargo/bin`,
			`${home}/.volta/bin`,
			`${home}/.npm-global/bin`,
			`${home}/.yarn/bin`,
		);
	}
	return dirs;
}

/**
 * Join PATH fragments in order, dropping empties and anything already seen. First mention wins,
 * which is what a shell does.
 */
export function mergePath(fragments: readonly (string | undefined)[], delimiter: string): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const fragment of fragments) {
		for (const dir of (fragment ?? '').split(delimiter)) {
			const trimmed = dir.trim();
			if (trimmed.length === 0 || seen.has(trimmed)) {
				continue;
			}
			seen.add(trimmed);
			out.push(trimmed);
		}
	}
	return out.join(delimiter);
}

/**
 * The marker an interactive shell's PATH is printed between. A login shell runs the user's rc
 * files, and those print things (version managers, greetings, a fortune); without a marker the
 * first line of that noise would be read as the PATH.
 */
const MARKER = '__SNOUTDATA_PATH__';

/** Pull the PATH back out of whatever the shell printed, or null if the markers are not there. */
export function extractMarkedPath(output: string): string | null {
	const first = output.indexOf(MARKER);
	if (first < 0) {
		return null;
	}
	const second = output.indexOf(MARKER, first + MARKER.length);
	if (second < 0) {
		return null;
	}
	const value = output.slice(first + MARKER.length, second).trim();
	return value.length > 0 ? value : null;
}

/** How long the login shell gets before we stop waiting and use the static list instead. */
const SHELL_TIMEOUT_MS = 4000;

/** Ask the user's login shell what PATH it has. Resolves to null on any failure; never throws. */
export function askLoginShell(shell: string, env: NodeJS.ProcessEnv): Promise<string | null> {
	return new Promise((resolve) => {
		// -l so profile files run, -i so rc files do too (plenty of setups only export PATH there),
		// -c for the one command. An rc file that blocks is what the timeout is for.
		const args = ['-lic', `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`];
		execFile(shell, args, { timeout: SHELL_TIMEOUT_MS, env, encoding: 'utf8' }, (_err, stdout) => {
			// A non-zero exit is not fatal: an rc file that fails after printing still printed it.
			resolve(extractMarkedPath(String(stdout ?? '')));
		});
	});
}

export interface UserPathDeps {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	/** Injected so tests never spawn a shell. */
	askShell?(shell: string, env: NodeJS.ProcessEnv): Promise<string | null>;
	/** Injected so tests never touch the disk. */
	exists?(path: string): boolean;
	/** The user's login shell, when `$SHELL` is not in the environment. Injected for tests. */
	loginShell?(): string | undefined;
}

/** The passwd entry's shell: what the user actually logs in with, and there even when $SHELL is
 *  not (a launchd process is not guaranteed one). */
function passwdShell(): string | undefined {
	try {
		return userInfo().shell ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * The PATH to use for finding and running the user's own tools: this process's PATH, widened with
 * the login shell's and the well-known bin directories that exist on this machine.
 *
 * WIDENED, and in that order, which is the whole rule: an environment we were HANDED beats one we
 * went looking for. Whoever started this process may have meant the PATH they gave us (a launch
 * from a terminal, a wrapper script, an e2e spec putting a stand-in agent first), and a PATH we
 * inferred from a login shell must not quietly outrank it. In the case this exists for it makes no
 * difference anyway: launchd's four directories hold none of the tools being looked for, so the
 * shell's entries are what answer.
 *
 * The cost of that order, stated rather than discovered later: a tool that exists BOTH in a system
 * directory and in a version manager's (`/usr/bin/git` against a newer Homebrew one) resolves to
 * the system copy under a GUI launch. That is what every other GUI-launched app on the machine
 * does, and it is the price of not overriding an explicit PATH.
 */
export async function resolveUserPath(deps: UserPathDeps): Promise<string> {
	const delimiter = deps.platform === 'win32' ? ';' : ':';
	const inherited = deps.env.PATH ?? deps.env.Path ?? '';
	if (deps.platform === 'win32') {
		// Windows hands a GUI process the full machine + user PATH, so there is nothing to fix and
		// no shell worth asking.
		return inherited;
	}
	const has = deps.exists ?? existsSync;
	const shell = deps.env.SHELL ?? (deps.loginShell ?? passwdShell)();
	const ask = deps.askShell ?? askLoginShell;
	let fromShell: string | null = null;
	if (shell && shell.length > 0) {
		try {
			fromShell = await ask(shell, deps.env);
		} catch {
			fromShell = null;
		}
	}
	// Only offer directories that are actually there: a PATH full of absent entries makes every
	// later lookup do the work of stat-ing them.
	const known = wellKnownBinDirs(deps.env.HOME, deps.platform).filter((dir) => has(dir));
	return mergePath([inherited, fromShell ?? undefined, known.join(delimiter)], delimiter);
}

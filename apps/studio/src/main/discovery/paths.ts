/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';

// Where each tool keeps its saved connections, per operating system. Pure: everything is
// computed from a `HostEnv`, so a test can ask "which file on Linux?" on a Mac. `hostEnv()` is
// the only part that reads the real machine.

export interface HostEnv {
	platform: NodeJS.Platform;
	home: string;
	/**
	 * The per-user config root, as Electron's `app.getPath('appData')` returns it: %APPDATA% on
	 * Windows, ~/Library/Application Support on macOS, $XDG_CONFIG_HOME or ~/.config on Linux.
	 */
	appData: string;
	/** The temporary directory (podman's machine socket lives under it on macOS). */
	tmp: string;
	env: Record<string, string | undefined>;
}

/** The real machine's environment. */
export function hostEnv(): HostEnv {
	const home = homedir();
	const env = process.env;
	let appData: string;
	if (process.platform === 'win32') {
		appData = env.APPDATA ?? win32.join(home, 'AppData', 'Roaming');
	} else if (process.platform === 'darwin') {
		appData = posix.join(home, 'Library', 'Application Support');
	} else {
		appData = env.XDG_CONFIG_HOME ?? posix.join(home, '.config');
	}
	return { platform: process.platform, home, appData, tmp: tmpdir(), env };
}

function joiner(h: HostEnv): (...parts: string[]) => string {
	return h.platform === 'win32' ? win32.join : posix.join;
}

/** pgAdmin 4's configuration database. */
export function pgadminFiles(h: HostEnv): string[] {
	const j = joiner(h);
	return h.platform === 'win32' ? [j(h.appData, 'pgAdmin', 'pgadmin4.db')] : [j(h.home, '.pgadmin', 'pgadmin4.db')];
}

/** MySQL Workbench's connections.xml. */
export function workbenchFiles(h: HostEnv): string[] {
	const j = joiner(h);
	if (h.platform === 'win32') {
		return [j(h.appData, 'MySQL', 'Workbench', 'connections.xml')];
	}
	if (h.platform === 'darwin') {
		return [j(h.home, 'Library', 'Application Support', 'MySQL', 'Workbench', 'connections.xml')];
	}
	return [j(h.home, '.mysql', 'workbench', 'connections.xml')];
}

/** Azure Data Studio's user settings.json (the insiders build keeps its own). */
export function azureDataStudioFiles(h: HostEnv): string[] {
	const j = joiner(h);
	return ['azuredatastudio', 'Azure Data Studio'].map((dir) => j(h.appData, dir, 'User', 'settings.json'));
}

/** The folder holding one sub-folder per SSMS version (18.0, 19.0, 20.0, 21.0); Windows only. */
export function ssmsRoot(h: HostEnv): string | null {
	return h.platform === 'win32' ? joiner(h)(h.appData, 'Microsoft', 'SQL Server Management Studio') : null;
}

/** HeidiSQL's portable settings file, where a portable install keeps its sessions; Windows only. */
export function heidisqlPortableFiles(h: HostEnv): string[] {
	if (h.platform !== 'win32') {
		return [];
	}
	const j = joiner(h);
	const roots = [h.env.ProgramFiles, h.env['ProgramFiles(x86)'], h.env.LOCALAPPDATA ? j(h.env.LOCALAPPDATA, 'Programs') : undefined];
	return roots.filter((r): r is string => Boolean(r)).map((r) => j(r, 'HeidiSQL', 'portable_settings.txt'));
}

/** The Postgres password file: $PGPASSFILE, else pgpass.conf on Windows and ~/.pgpass elsewhere. */
export function pgpassFiles(h: HostEnv): string[] {
	if (h.env.PGPASSFILE) {
		return [h.env.PGPASSFILE];
	}
	const j = joiner(h);
	return h.platform === 'win32' ? [j(h.appData, 'postgresql', 'pgpass.conf')] : [j(h.home, '.pgpass')];
}

/** TablePlus's saved connections; macOS only (the Windows format is not known, so it is Browse). */
export function tablePlusFiles(h: HostEnv): string[] {
	return h.platform === 'darwin'
		? [posix.join(h.home, 'Library', 'Application Support', 'com.tinyapp.TablePlus', 'Data', 'Connections.plist')]
		: [];
}

/**
 * Container engine API sockets to try (Docker, Podman, and the macOS VMs that host one). Some are
 * the same daemon under two names (/var/run/docker.sock is a symlink on Docker Desktop), so the
 * caller dedupes CONTAINERS by id rather than trusting this list to be distinct daemons.
 */
export function containerSockets(h: HostEnv): string[] {
	const out: string[] = [];
	const dockerHost = h.env.DOCKER_HOST ?? '';
	if (dockerHost.startsWith('unix://')) {
		out.push(dockerHost.slice('unix://'.length));
	} else if (dockerHost.startsWith('npipe://')) {
		out.push(dockerHost.slice('npipe://'.length).replace(/\//g, '\\'));
	}
	if (h.platform === 'win32') {
		// Any local process can create a named pipe under a free name, so while Podman is not
		// running another account could answer as `podman-machine-default` and list containers of
		// its choosing. Node cannot ask who owns a pipe (stat reports uid 0 on Windows, and the
		// server's identity needs a native call), so what such a pipe lists is trusted no further
		// than any import: nothing is saved until a person picks it in the import or discovery
		// picker, and the scan only ever GETs (the app sends the pipe nothing secret).
		out.push('\\\\.\\pipe\\docker_engine', '\\\\.\\pipe\\podman-machine-default');
	} else if (h.platform === 'darwin') {
		const j = posix.join;
		out.push(
			'/var/run/docker.sock',
			j(h.home, '.docker', 'run', 'docker.sock'),
			j(h.home, '.colima', 'default', 'docker.sock'),
			j(h.home, '.orbstack', 'run', 'docker.sock'),
			j(h.home, '.rd', 'docker.sock'),
			j(h.home, '.local', 'share', 'containers', 'podman', 'machine', 'podman.sock'),
			j(h.home, '.local', 'share', 'containers', 'podman', 'machine', 'podman-machine-default', 'podman.sock'),
			j(h.tmp, 'podman', 'podman-machine-default-api.sock'),
		);
	} else {
		out.push('/var/run/docker.sock');
		const runtime = h.env.XDG_RUNTIME_DIR;
		if (runtime) {
			out.push(posix.join(runtime, 'podman', 'podman.sock'), posix.join(runtime, 'docker.sock'));
		}
		out.push('/run/podman/podman.sock');
	}
	return [...new Set(out)];
}

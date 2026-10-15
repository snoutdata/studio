/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import {
	AGENTS,
	AGENT_KINDS,
	AGENT_SCROLLBACK_BYTES,
	DEFAULT_CONSOLE_SIZE,
	type AgentConsoleAttach,
	type AgentConsoleExit,
	type AgentConsoleSize,
	type AgentConsoleStatus,
	type AgentDescriptor,
	type AgentInstall,
	type AgentKind,
} from '../shared/agentConsole';

/*
 * The Agent Console's process side.
 *
 * One PTY per agent kind, owned by MAIN and living for the life of the app: closing the panel
 * detaches, it does not kill the agent, and reopening replays the scrollback kept here. A second
 * window attaches to the same session; there is no per-window console.
 *
 * Two things in here are load-bearing for the security story and must not be softened:
 *
 *   1. The PTY's process is the AGENT BINARY, not a shell. There is no prompt to escape from.
 *      (The one exception is a Windows `.cmd`/`.bat` shim, which physically requires cmd.exe to
 *      run it — see planSpawn, which is why the native `claude.exe` is preferred when present.)
 *   2. The environment is an ALLOW-LIST, never `process.env`. Nothing about a connection, no
 *      gateway key, no keychain material reaches the child. The only SnoutData values passed are
 *      the local MCP URL and its bearer token, which are a localhost capability gate, not a
 *      credential. `consoleEnvironment` is pure so a test can assert exactly that.
 *
 * node-pty is required LAZILY (the src/main/sqlite.ts pattern): a module that fails to load must
 * break this panel, never the app's startup. It ships N-API prebuilds, so it loads under Node and
 * Electron alike and is NOT part of the rebuild-for-Electron dance.
 */

/** The slice of a node-pty process this module uses. Keeps the native types out of the tests. */
export interface PtyLike {
	readonly pid: number;
	onData(listener: (data: string) => void): void;
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
}

/** What to spawn and how. Produced by {@link planSpawn}, consumed by a {@link PtyFactory}. */
export interface SpawnPlan {
	file: string;
	args: string[];
}

export interface PtyFactoryOptions {
	cwd: string;
	env: Record<string, string>;
	cols: number;
	rows: number;
}

/** Injected so tests never touch the native module. */
export type PtyFactory = (plan: SpawnPlan, options: PtyFactoryOptions) => PtyLike;

/** The message the panel shows if the native terminal backend cannot load at all. */
export class PtyUnavailableError extends Error {
	constructor(readonly cause: unknown) {
		super("The terminal backend could not load, so the agent console is unavailable in this build.");
		this.name = 'PtyUnavailableError';
	}
}

/** The real factory: requires node-pty on first use, never at import time. */
export function nodePtyFactory(plan: SpawnPlan, options: PtyFactoryOptions): PtyLike {
	let pty: { spawn(file: string, args: string[], opts: Record<string, unknown>): PtyLike };
	try {
		// A runtime require, deliberately: the main bundle is CJS and a static import would move
		// this native load onto the startup path.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		pty = require('node-pty') as typeof pty;
	} catch (err) {
		throw new PtyUnavailableError(err);
	}
	return pty.spawn(plan.file, plan.args, {
		name: 'xterm-256color',
		cwd: options.cwd,
		env: options.env,
		cols: options.cols,
		rows: options.rows,
		useConpty: true,
	});
}

// --- the environment allow-list -------------------------------------------------------------

/** Passed on every platform. Proxy vars are included because a corporate user's agent cannot
 *  reach its own API without them. */
const COMMON_ENV = [
	'PATH', 'Path',
	'HOME',
	'LANG', 'LC_ALL',
	'TMPDIR', 'TEMP', 'TMP',
	'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
	'http_proxy', 'https_proxy', 'no_proxy',
	'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

/** Windows needs these to start a process at all; APPDATA/LOCALAPPDATA are where the agent's own
 *  auth lives, so dropping them would silently sign the user out of their own CLI. */
const WINDOWS_ENV = [
	'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT',
	'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
	'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData',
	'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'USERNAME',
];

// DISPLAY/WAYLAND_DISPLAY are here for one reason: on Linux an agent reads the clipboard by
// shelling out to xclip or wl-paste, and without the display it is talking to nothing. That is how
// an image pasted into the console reaches the agent. Neither names a secret; they address the
// session's own display server.
const POSIX_ENV = ['SHELL', 'USER', 'LOGNAME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'DISPLAY', 'WAYLAND_DISPLAY'];

/** The two SnoutData values the child is allowed to see. Neither is a credential: they address
 *  and gate the LOCAL MCP endpoint, which itself hands out capabilities and never secrets. */
export const MCP_ENV_URL = 'SNOUTDATA_MCP_URL';
export const MCP_ENV_TOKEN = 'SNOUTDATA_MCP_TOKEN';

export interface ConsoleEnvOptions {
	platform: NodeJS.Platform;
	mcp: { url: string; token: string } | null;
}

/**
 * Build the child's environment from an allow-list. Pure, and deliberately so: the test that
 * asserts no secret-shaped variable survives is the cheapest guard this feature has.
 */
export function consoleEnvironment(parent: NodeJS.ProcessEnv, options: ConsoleEnvOptions): Record<string, string> {
	const names = [...COMMON_ENV, ...(options.platform === 'win32' ? WINDOWS_ENV : POSIX_ENV)];
	const env: Record<string, string> = {};
	for (const name of names) {
		const value = parent[name];
		if (typeof value === 'string' && value.length > 0) {
			env[name] = value;
		}
	}
	// A real terminal, so the agent's TUI draws in colour instead of falling back to plain text.
	env.TERM = 'xterm-256color';
	env.COLORTERM = 'truecolor';
	if (options.mcp) {
		env[MCP_ENV_URL] = options.mcp.url;
		env[MCP_ENV_TOKEN] = options.mcp.token;
	}
	return env;
}

// --- finding and launching the binary --------------------------------------------------------

/** Extensions tried on Windows when PATHEXT is unavailable. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/*
 * Path handling here is PLATFORM-PARAMETERISED rather than taken from node:path. The resolver has
 * to answer "what would Windows do" while running under a test on any host (and vice versa), and
 * node:path's join/delimiter/isAbsolute all follow the HOST. Getting this wrong is silent: every
 * lookup simply returns null and the panel reports the agent as not installed.
 */

function pathDelimiter(platform: NodeJS.Platform): string {
	return platform === 'win32' ? ';' : ':';
}

function joinPath(dir: string, name: string, platform: NodeJS.Platform): string {
	const separator = platform === 'win32' ? '\\' : '/';
	const trimmed = dir.replace(/[\\/]+$/, '');
	return `${trimmed}${separator}${name}`;
}

function isAbsolutePath(path: string, platform: NodeJS.Platform): boolean {
	return platform === 'win32' ? /^([a-zA-Z]:[\\/]|\\\\)/.test(path) : path.startsWith('/');
}

export interface ResolveOptions {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	/** Injected so the resolver is testable without touching the disk. */
	exists?(path: string): boolean;
}

/**
 * Resolve a bare binary name against PATH, honouring PATHEXT on Windows. Returns the absolute
 * path, or null when the agent is not installed.
 *
 * Order matters: a native `claude.exe` and an npm `claude.cmd` shim can both be on PATH, and the
 * .exe is preferred because launching it needs no shell (see planSpawn).
 */
export function resolveOnPath(binary: string, options: ResolveOptions): string | null {
	const has = options.exists ?? existsSync;
	if (isAbsolutePath(binary, options.platform)) {
		return has(binary) ? binary : null;
	}
	const rawPath = options.env.PATH ?? options.env.Path ?? '';
	const dirs = rawPath.split(pathDelimiter(options.platform)).filter((d) => d.length > 0);
	// PATHEXT is conventionally upper-case; the filesystem does not care and a lower-case path is
	// what the user expects to see in Settings, so the extension is normalised on the way in.
	const extensions = options.platform === 'win32'
		? (options.env.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter((e) => e.length > 0).map((e) => e.toLowerCase())
		: [''];
	// Try every extension in one directory before moving on, so a directory earlier on PATH wins
	// even if a later one holds a "better" extension. That is what the shell does.
	for (const dir of dirs) {
		for (const ext of extensions) {
			const candidate = joinPath(dir, binary + ext, options.platform);
			if (has(candidate)) {
				return candidate;
			}
		}
		if (options.platform === 'win32' && has(joinPath(dir, binary, options.platform))) {
			return joinPath(dir, binary, options.platform);
		}
	}
	return null;
}

/**
 * Decide what actually gets spawned. Normally that is the agent binary itself, with no shell
 * anywhere. A Windows `.cmd`/`.bat` shim (what `npm i -g` writes) is the one case that cannot be
 * executed directly, so it goes through cmd.exe /c — recorded here rather than hidden, because
 * "there is no shell" is a claim this feature makes.
 */
export function planSpawn(file: string, args: string[], platform: NodeJS.Platform, comSpec?: string): SpawnPlan | null {
	if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
		const line = [file, ...args].map(cmdArgument);
		if (line.some((arg) => arg === null)) {
			return null;
		}
		// `/d`: no AutoRun commands from the registry before the shim.
		return { file: comSpec ?? 'cmd.exe', args: ['/d', '/c', ...(line as string[])] };
	}
	return { file, args };
}

/**
 * One argument of a `cmd.exe /c` line, made literal for cmd, or null when it cannot be.
 *
 * Node and node-pty quote an argument only when it holds whitespace (or a quote). Quotes do not
 * protect it: when the quoted text holds one of `& < > ( ) @ ^ |`, `cmd /c` strips the first and
 * last quote of the line and reads the rest bare. So an argument with whitespace may hold none of
 * those, and one without whitespace (never quoted) has each escaped with a caret, which cmd reads
 * as "the next character is a letter" outside quotes and as itself inside them, harmless either
 * way. `%` and `!` expand even inside quotes, and a `"` or a line break changes the quoting, so an
 * argument holding any of them is refused: the agent is then reported as not runnable rather than
 * run with a line cmd could read as more than one command.
 */
export function cmdArgument(arg: string): string | null {
	if (/[%!"\r\n\u0000]/.test(arg)) {
		return null;
	}
	if (arg === '' || /\s/.test(arg)) {
		return /[&|<>^()@]/.test(arg) ? null : arg;
	}
	return arg.replace(/[&|<>^()@]/g, '^$&');
}

// --- scrollback -------------------------------------------------------------------------------

/**
 * A byte-capped ring of output chunks. The panel is not the owner of history: closing it must not
 * lose what the agent said, and reopening replays this. Capped because an agent that loops can
 * emit megabytes a second and this lives for the life of the app.
 */
export class Scrollback {
	private chunks: string[] = [];
	private bytes = 0;

	constructor(private readonly cap: number = AGENT_SCROLLBACK_BYTES) {}

	push(chunk: string): void {
		if (chunk.length === 0) {
			return;
		}
		this.chunks.push(chunk);
		this.bytes += Buffer.byteLength(chunk);
		while (this.bytes > this.cap && this.chunks.length > 1) {
			const dropped = this.chunks.shift()!;
			this.bytes -= Buffer.byteLength(dropped);
		}
	}

	read(): string {
		return this.chunks.join('');
	}

	clear(): void {
		this.chunks = [];
		this.bytes = 0;
	}

	get size(): number {
		return this.bytes;
	}
}

// --- the manager -------------------------------------------------------------------------------

interface Session {
	pty: PtyLike;
	size: AgentConsoleSize;
}

export interface AgentConsoleDeps {
	/** Where the agent starts. The workspace root, never userData. */
	cwd(): string;
	/** The local MCP endpoint, or null when agent access is off. */
	mcp(): { url: string; token: string } | null;
	/** Per-kind launch arguments beyond the descriptor's (the handoff flags). */
	extraArgs?(kind: AgentKind, descriptor: AgentDescriptor): string[];
	/** Overridable for tests. */
	pty?: PtyFactory;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	exists?(path: string): boolean;
	/** Runs the version probe. Injected so tests never execute anything. */
	probe?(file: string, args: string[]): Promise<string | null>;
	/** Kills a process tree. Injected for the same reason. */
	killTree?(pid: number): void;
	/**
	 * Whether the user has switched this agent on. Injected rather than read from a store, so the
	 * manager stays testable and the "undecided vs switched off" rule lives in exactly one place
	 * (AgentConsoleStore). Absent ⇒ everything installed is shown.
	 */
	enabled?(kind: AgentKind): boolean;
	/** True once the user has decided either way about this agent. */
	decided?(kind: AgentKind): boolean;
	/**
	 * Called when an agent is found installed. Returns true if this was the first sighting and the
	 * agent was therefore turned on. Absent ⇒ discovery changes no preference.
	 */
	noteDetected?(kind: AgentKind, now: number): boolean;
	/**
	 * The PATH the user's own tools are on (src/main/loginPath.ts), which on a GUI launch is not
	 * the PATH this process inherited. Awaited once, before the first lookup or launch, and the
	 * answer is used for both. Absent ⇒ the inherited PATH is used as-is, which is what keeps the
	 * tests from spawning a shell.
	 */
	userPath?(): Promise<string | null>;
	/**
	 * A binary the user pointed us at themselves for this kind (AgentConsoleStore.pinnedPath), or
	 * undefined to look on PATH as usual. The failsafe for a machine we cannot work out: an agent
	 * installed somewhere no PATH mentions, or a second copy the user wants used instead.
	 */
	pinnedPath?(kind: AgentKind): string | undefined;
	clock?(): number;
}

/** Run the descriptor's probe and return its first line, or null if it did not run. */
function defaultProbe(file: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
			if (err) {
				resolve(null);
				return;
			}
			const line = String(stdout).split(/\r?\n/).find((l) => l.trim().length > 0);
			resolve(line ? line.trim() : null);
		});
	});
}

/**
 * Kill the whole tree. The agent spawns its own children (node, ripgrep, MCP clients); killing
 * only the PTY leader leaves them running after the app quits, which users notice as a machine
 * that never goes idle.
 */
function defaultKillTree(pid: number): void {
	if (process.platform === 'win32') {
		execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {
			// Best effort: the process may already be gone, which is the outcome we wanted anyway.
		});
		return;
	}
	try {
		process.kill(-pid, 'SIGKILL');
	} catch {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// Already gone.
		}
	}
}

export class AgentConsole {
	private readonly sessions = new Map<AgentKind, Session>();
	/**
	 * What each console has said, kept OUTSIDE the session on purpose.
	 *
	 * An agent that fails on startup (a bad config file, a missing credential) prints one useful
	 * paragraph and exits. When this lived on the session it was deleted with it, so the panel
	 * swapped to an empty state and the user was told "it exited" with no idea why. It is cleared
	 * when the same agent is started again, which is the only moment the old output stops mattering.
	 */
	private readonly scrollbacks = new Map<AgentKind, Scrollback>();
	private readonly installs = new Map<AgentKind, AgentInstall>();
	private readonly exits = new Map<AgentKind, AgentConsoleExit>();
	private readonly dataListeners = new Set<(kind: AgentKind, data: string, seq: number) => void>();
	/** Output chunks emitted so far, across every console; never reset (`AgentConsoleChunk.seq`). */
	private seq = 0;
	private readonly exitListeners = new Set<(event: AgentConsoleExit) => void>();
	/** The resolved user PATH, and the in-flight resolution, so it is asked for exactly once. */
	private userPath: string | undefined;
	private userPathPromise: Promise<void> | undefined;

	constructor(private readonly deps: AgentConsoleDeps) {}

	private get platform(): NodeJS.Platform {
		return this.deps.platform ?? process.platform;
	}

	private get env(): NodeJS.ProcessEnv {
		const base = this.deps.env ?? process.env;
		return this.userPath ? { ...base, PATH: this.userPath } : base;
	}

	/**
	 * Resolve the user's PATH once, on the first discovery or launch. Whatever happens it must not
	 * throw: a shell that fails to answer leaves us exactly where we were before, looking down the
	 * inherited PATH.
	 */
	private async ensureUserPath(): Promise<void> {
		if (!this.deps.userPath) {
			return;
		}
		this.userPathPromise ??= this.deps.userPath()
			.then((path) => {
				// Only override when there is something to add. On Windows the resolver returns the
				// inherited PATH unchanged, and setting a `PATH` key beside the real `Path` one would
				// hand the child the same value twice under two spellings.
				const base = this.deps.env ?? process.env;
				const inherited = base.PATH ?? base.Path;
				this.userPath = path && path.length > 0 && path !== inherited ? path : undefined;
			})
			.catch(() => {
				this.userPath = undefined;
			});
		await this.userPathPromise;
	}

	private now(): number {
		return (this.deps.clock ?? Date.now)();
	}

	onData(listener: (kind: AgentKind, data: string, seq: number) => void): () => void {
		this.dataListeners.add(listener);
		return () => this.dataListeners.delete(listener);
	}

	onExit(listener: (event: AgentConsoleExit) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	/** Look for the binary on PATH and (if found) ask it its version. Cached; call again to recheck. */
	async discover(kind: AgentKind): Promise<AgentInstall> {
		await this.ensureUserPath();
		const descriptor = AGENTS[kind];
		// A pin is the user's answer and it is the WHOLE answer: PATH is not consulted, and a pin
		// that no longer resolves reports as missing rather than falling back to some other copy.
		const pinned = this.deps.pinnedPath?.(kind);
		const lookup = pinned && pinned.length > 0 ? pinned : descriptor.binary;
		const path = resolveOnPath(lookup, { platform: this.platform, env: this.env, exists: this.deps.exists });
		if (!path) {
			const missing: AgentInstall = { installed: false, pinned: pinned ? true : undefined, checkedAt: this.now() };
			this.installs.set(kind, missing);
			return missing;
		}
		const probe = this.deps.probe ?? defaultProbe;
		const plan = planSpawn(path, descriptor.probeArgs, this.platform, this.env.ComSpec);
		if (!plan) {
			// A shim whose path cmd.exe would read as more than a file name is never run.
			const unsafe: AgentInstall = { installed: false, pinned: pinned ? true : undefined, checkedAt: this.now() };
			this.installs.set(kind, unsafe);
			return unsafe;
		}
		const version = await probe(plan.file, plan.args);
		const install: AgentInstall = { installed: true, path, pinned: pinned ? true : undefined, version: version ?? undefined, checkedAt: this.now() };
		this.installs.set(kind, install);
		// First sighting turns it on for the user (see AgentConsoleStore.noteDetected). This is the
		// only place that happens, and it happens whether the sighting is at launch or months later.
		this.deps.noteDetected?.(kind, this.now());
		return install;
	}

	/** Look for every agent we know about. Used at launch (deferred) and when Settings opens, so a
	 *  tool installed while the app was running is found without a restart. */
	async discoverAll(): Promise<AgentConsoleStatus[]> {
		for (const kind of AGENT_KINDS) {
			await this.discover(kind);
		}
		return this.statuses();
	}

	/** The cached discovery result, without running anything. */
	installOf(kind: AgentKind): AgentInstall {
		return this.installs.get(kind) ?? { installed: false };
	}

	status(kind: AgentKind): AgentConsoleStatus {
		const session = this.sessions.get(kind);
		const descriptor = AGENTS[kind];
		const install = this.installOf(kind);
		return {
			kind,
			label: descriptor.label,
			running: session !== undefined,
			pid: session?.pty.pid,
			install,
			lastExit: this.exits.get(kind),
			/** True when there is a transcript to show, running or not (see {@link scrollbacks}). */
			hasOutput: (this.scrollbacks.get(kind)?.size ?? 0) > 0,
			// An agent whose tools we cannot hand over on the command line is NOT wired, however
			// healthy the broker is. Saying otherwise would promise the user tools that are not there.
			mcpWired: descriptor.handoff === 'flag' && this.deps.mcp() !== null,
			handoff: descriptor.handoff,
			visible: install.installed && (this.deps.enabled?.(kind) ?? true),
			decided: this.deps.decided?.(kind) ?? false,
		};
	}

	statuses(): AgentConsoleStatus[] {
		return AGENT_KINDS.map((kind) => this.status(kind));
	}

	running(kind: AgentKind): boolean {
		return this.sessions.has(kind);
	}

	/**
	 * Start the console for a kind, or return the running one. Idempotent on purpose: this is the
	 * singleton rule, and every caller (panel mount, command palette, a second window) goes
	 * through it.
	 */
	async start(kind: AgentKind, size: AgentConsoleSize = DEFAULT_CONSOLE_SIZE): Promise<AgentConsoleStatus> {
		const existing = this.sessions.get(kind);
		if (existing) {
			return this.status(kind);
		}
		// The agent inherits this PATH, so it is resolved before the spawn whether or not discovery
		// has already run: an agent launched down a four-directory PATH cannot find its own tools.
		await this.ensureUserPath();
		const descriptor = AGENTS[kind];
		const install = this.installs.get(kind)?.installed ? this.installs.get(kind)! : await this.discover(kind);
		if (!install.installed || !install.path) {
			return this.status(kind);
		}
		const args = [...descriptor.launchArgs, ...(this.deps.extraArgs?.(kind, descriptor) ?? [])];
		const plan = planSpawn(install.path, args, this.platform, this.env.ComSpec);
		if (!plan) {
			return this.status(kind);
		}
		const factory = this.deps.pty ?? nodePtyFactory;
		const pty = factory(plan, {
			cwd: this.deps.cwd(),
			env: consoleEnvironment(this.env, { platform: this.platform, mcp: this.deps.mcp() }),
			cols: size.cols,
			rows: size.rows,
		});
		const session: Session = { pty, size };
		this.sessions.set(kind, session);
		// A fresh run starts a fresh transcript: the previous one has been read, or never will be.
		const scrollback = new Scrollback();
		this.scrollbacks.set(kind, scrollback);
		this.exits.delete(kind);
		pty.onData((data) => {
			const seq = ++this.seq;
			scrollback.push(data);
			for (const listener of this.dataListeners) {
				listener(kind, data, seq);
			}
		});
		pty.onExit((event) => {
			this.sessions.delete(kind);
			const exit: AgentConsoleExit = { kind, code: event.exitCode ?? null, signal: event.signal, at: this.now() };
			this.exits.set(kind, exit);
			for (const listener of this.exitListeners) {
				listener(exit);
			}
		});
		return this.status(kind);
	}

	write(kind: AgentKind, data: string): void {
		this.sessions.get(kind)?.pty.write(data);
	}

	resize(kind: AgentKind, size: AgentConsoleSize): void {
		const session = this.sessions.get(kind);
		if (!session) {
			return;
		}
		session.size = size;
		try {
			session.pty.resize(Math.max(1, size.cols), Math.max(1, size.rows));
		} catch {
			// A PTY that died between the renderer measuring and this call. onExit cleans up.
		}
	}

	/** Everything the panel needs to render a console it is attaching to. Works after an exit too:
	 *  a dead agent's last words are the whole reason someone opens the panel again. */
	attach(kind: AgentKind): AgentConsoleAttach {
		return { status: this.status(kind), scrollback: this.scrollbacks.get(kind)?.read() ?? '', seq: this.seq };
	}

	stop(kind: AgentKind): void {
		const session = this.sessions.get(kind);
		if (!session) {
			return;
		}
		// Drop it from the map first: onExit may not fire for a tree kill, and a stale entry would
		// make the panel think a dead agent is still running.
		this.sessions.delete(kind);
		const exit: AgentConsoleExit = { kind, code: null, at: this.now() };
		this.exits.set(kind, exit);
		(this.deps.killTree ?? defaultKillTree)(session.pty.pid);
		try {
			session.pty.kill();
		} catch {
			// Already gone.
		}
		for (const listener of this.exitListeners) {
			listener(exit);
		}
	}

	async restart(kind: AgentKind, size?: AgentConsoleSize): Promise<AgentConsoleStatus> {
		const previous = this.sessions.get(kind)?.size;
		this.stop(kind);
		return this.start(kind, size ?? previous ?? DEFAULT_CONSOLE_SIZE);
	}

	/** Called on app quit. A console must never outlive the app that hosts it. */
	stopAll(): void {
		for (const kind of [...this.sessions.keys()]) {
			this.stop(kind);
		}
	}
}

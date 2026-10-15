/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import type { ConnectionFormValues } from '../../shared/forms';
import { prefix, type Vocabulary } from '../../shared/ownLayout';
import type { FunctionFile } from '../../shared/projectCopy';
import type {
	LocalActionOutcome, LocalActivity, LocalConnectionFacts, LocalCopyTarget, LocalExport, LocalFunctionRow, LocalInstallOutcome, LocalMailKind, LocalMailTemplate, LocalProgress,
	LocalProjectRow, LocalProjectsView, LocalRequirements, LocalSettings, LocalSettingsChange, LocalSetupForm,
} from '../../shared/localStack';
import { resolveOnPath } from '../agentConsole';
import { createPrivateFile, ensurePrivateDir, PRIVATE_MODE, tightenPrivateFiles } from '../privateFile';
import type { LocalTarget } from '../projectAccess';
import {
	APP_OVERRIDE, DATA_API_PROFILE, OVERRIDE_MARK, dataApiOn, withProfile, publicUrlProblem, applyEnv, composeProject, dbUrl, envFor, envForSettings, evaluateRequirements, formProblem, functionTemplate,
	composeVocabulary, envKey, isFunctionName, isRef, parseDockerPs, parseEnv, projectState, settingsFromEnv, slugify, stackImageFrom,
	STACK_IMAGE, STACK_SOURCE, downloadStack, suggestPort, tailOf, type EngineFacts,
	MAIL_DEFAULTS, MAIL_DIR, MAIL_KINDS_ORDER, isMailKind, mailEnv, mailTemplateProblem, mailTemplateUrl, overrideStale, settingsProblem,
	secretNameProblem, secretNames, secretValueProblem, withSecret,
	EXPORT_DIR, RESTORE_FILE, restoreAfterSwapScript, restoreCleanupScript, restoreScript, restoreSwapSql, exportName, isExportName, ownerPasswordSql, randomSecret, rotatedKeys, scramVerifier,
} from './plan';

// The running half of local projects: finds Docker, sets a
// project up the way the stack's README does by hand, and runs `docker compose` on it. Everything
// it DECIDES is in `plan.ts`.
//
// ## The docker CLI, not the Engine API
//
// Discovery reads containers over the engine's socket (`discovery/docker.ts`), and that is enough
// for two GETs. This needs Compose, which is a CLI plugin with no API of its own, so it runs the
// `docker` the user has, on the PATH their shell has (`loginPath.ts`: a macOS app started from the
// Dock is handed four directories and none of them hold docker).
//
// ## Secrets stay in `.env` and in main
//
// `.env` is the only copy of a project's keys, exactly as the README says; the registry in
// userData holds the folder, the ref and the ports, nothing secret. A key leaves main only for the
// clipboard, the owner's password only for the keychain (as the connection's password).

/** One function's source, for a copy to the cloud. `problem` says why it cannot be sent. */
export interface LocalFunctionSource {
	name: string;
	verifyJwt: boolean;
	own: FunctionFile[];
	shared: FunctionFile[] | null;
	problem: string | null;
}

/** What one function's tree may hold: the cloud's own bundle limits (`MAX_BUNDLE_FILES` and
 *  `MAX_BUNDLE_BYTES` in the control plane's functions module), so a tree the cloud would refuse
 *  is refused here before all of it is read. */
export const FUNCTION_TREE_MAX_FILES = 200;
export const FUNCTION_TREE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Every file under a function's folder, as bundle paths. Throws a sentence for a binary file, a
 * link (the root included: a linked `_shared` or file would upload whatever it points at), and a
 * tree past the bundle limits.
 */
export function readFunctionTree(root: string): FunctionFile[] {
	const files: FunctionFile[] = [];
	let bytesRead = 0;
	const name = (full: string): string => relative(root, full).split(sep).join('/') || basename(root);
	const refuseLink = (full: string): void => {
		if (lstatSync(full).isSymbolicLink()) {
			throw new Error(`${name(full)} is a link, and a function is copied from its own folder only. Put the file itself there.`);
		}
	};
	refuseLink(root);
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules') {
				continue;
			}
			const full = join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				refuseLink(full);
			}
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			if (files.length >= FUNCTION_TREE_MAX_FILES) {
				throw new Error(`${basename(root)} has more than ${FUNCTION_TREE_MAX_FILES} files, the most a function may hold.`);
			}
			bytesRead += lstatSync(full).size;
			if (bytesRead > FUNCTION_TREE_MAX_BYTES) {
				throw new Error(`${basename(root)} holds more than ${FUNCTION_TREE_MAX_BYTES / 1024} KB, the most a function may. A function is source code; put large files in Storage.`);
			}
			const bytes = readFileSync(full);
			const text = bytes.toString('utf8');
			if (Buffer.compare(Buffer.from(text, 'utf8'), bytes) !== 0) {
				throw new Error(`${relative(root, full)} is not text, and a function is source code. Put binary files in Storage.`);
			}
			files.push({ path: relative(root, full).split(sep).join('/'), text });
		}
	};
	walk(root);
	return files;
}

/** Whether anything, a dangling link included, is at this path. */
function lstatExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** One project in `userData/localProjects.json`. */
interface StoredProject {
	id: string;
	name: string;
	folder: string;
	ref: string;
	apiPort: number;
	dbPort: number;
	createdAt: string;
	production?: boolean;
}

export interface LocalStackDeps {
	userDataDir: string;
	home: string;
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	/** The user's tool PATH (loginPath.ts), resolved once. */
	userPath(): Promise<string>;
	fetch: typeof fetch;
	copy(text: string): void;
	/** Save a connection; answers its id. */
	addConnection(form: ConnectionFormValues): string;
	/** Every connection tagged with this project. */
	connectionsOf(projectId: string): Array<{ id: string; port: number }>;
	updateConnection(connectionId: string, change: { port?: number; password?: string; production?: boolean }): void;
	removeConnection(connectionId: string): Promise<void>;
	openPath(path: string): Promise<void>;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface RunOptions {
	cwd?: string;
	/** Every output line, stdout and stderr alike, as it arrives. */
	onLine?(line: string): void;
	timeoutMs?: number;
	/** Written to the command's stdin, then closed. */
	input?: string;
	/** A file streamed to the command's stdin (a restore). */
	stdinFile?: string;
	/** The command's stdout streamed to this file, bytes as they are (an export). */
	stdoutFile?: string;
}

/** Colour codes: the stack's servers write them even under `compose logs --no-color`. */
function plain(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** Docker that is not on PATH but is where its installer puts it. */
function knownDockerPaths(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
	if (platform === 'win32') {
		const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
		return [join(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')];
	}
	if (platform === 'darwin') {
		return [
			'/usr/local/bin/docker',
			'/opt/homebrew/bin/docker',
			join(home, '.docker', 'bin', 'docker'),
			'/Applications/Docker.app/Contents/Resources/bin/docker',
			join(home, '.orbstack', 'bin', 'docker'),
			join(home, '.rd', 'bin', 'docker'),
		];
	}
	return ['/usr/bin/docker', '/usr/local/bin/docker'];
}

/** Where Docker Desktop is, so it can be started for the user. */
function desktopApp(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
	if (platform === 'win32') {
		const app = join(env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe');
		return existsSync(app) ? app : null;
	}
	if (platform === 'darwin') {
		return existsSync('/Applications/Docker.app') ? '/Applications/Docker.app' : null;
	}
	return existsSync('/opt/docker-desktop') ? '/opt/docker-desktop' : null;
}

function isEmptyDir(path: string): boolean {
	try {
		return readdirSync(path).length === 0;
	} catch {
		return true;
	}
}

function portFree(port: number, host: string): Promise<boolean> {
	return new Promise((done) => {
		const server = createServer();
		server.once('error', () => done(false));
		server.once('listening', () => server.close(() => done(true)));
		server.listen(port, host);
	});
}

/** Something accepts a connection on this port of this machine. */
function answers(port: number): Promise<boolean> {
	return new Promise((done) => {
		const socket = connect({ port, host: '127.0.0.1' });
		const finish = (yes: boolean): void => {
			socket.destroy();
			done(yes);
		};
		socket.setTimeout(400, () => finish(false));
		socket.once('connect', () => finish(true));
		socket.once('error', () => finish(false));
	});
}

/**
 * Free for the stack: nothing answers on it and it can be bound. Both, because neither is enough
 * alone on Windows: a container another stack published on 0.0.0.0 (Docker Desktop's proxy) does
 * not stop a bind to 127.0.0.1 or even to 0.0.0.0 there, so a bind test passed a port another local
 * stack's database held, and the stack's own `db` then never started.
 */
async function portAvailable(port: number): Promise<boolean> {
	if (await answers(port)) {
		return false;
	}
	return (await portFree(port, '127.0.0.1')) && (await portFree(port, '0.0.0.0'));
}

/** The paths a project's gateway serves, in the names it serves them under (shared/ownLayout.ts). */
function gatewayPaths(vocabulary: Vocabulary): LocalConnectionFacts['paths'] {
	return [
		{ path: `${prefix('data', vocabulary)}/`, what: "The data API" },
		{ path: prefix('graph', vocabulary), what: "GraphQL" },
		{ path: `${prefix('identity', vocabulary)}/`, what: "Auth" },
		{ path: `${prefix('files', vocabulary)}/`, what: "Storage" },
		{ path: `${prefix('live', vocabulary)}/`, what: "Realtime" },
		{ path: `${prefix('fn', vocabulary)}/<name>`, what: "Your functions" },
	];
}

export class LocalStackService {
	private dockerPath: string | null | undefined;
	private pathEnv: string | undefined;
	/** Projects with an operation running: a second one is refused, not queued. */
	private readonly busy = new Set<string>();

	constructor(private readonly deps: LocalStackDeps) {}

	// --- the registry ---------------------------------------------------------------------------

	private storePath(): string {
		return join(this.deps.userDataDir, 'localProjects.json');
	}

	private readStore(): StoredProject[] {
		try {
			const raw: unknown = JSON.parse(readFileSync(this.storePath(), 'utf8'));
			const list = (raw as { projects?: unknown })?.projects;
			return Array.isArray(list) ? (list as StoredProject[]) : [];
		} catch {
			return [];
		}
	}

	private writeStore(projects: StoredProject[]): void {
		writeFileSync(this.storePath(), JSON.stringify({ projects }, null, '\t'));
	}

	private find(id: string): StoredProject {
		const project = this.readStore().find((p) => p.id === id);
		if (!project) {
			throw new Error("That local project is not in the list any more.");
		}
		return project;
	}

	private update(id: string, change: Partial<StoredProject>): void {
		this.writeStore(this.readStore().map((p) => (p.id === id ? { ...p, ...change } : p)));
	}

	// --- the activity log: what the app did to each project, newest first --------------------------

	private activityPath(): string {
		return join(this.deps.userDataDir, 'localActivity.json');
	}

	private readActivity(): Record<string, LocalActivity[]> {
		try {
			const raw: unknown = JSON.parse(readFileSync(this.activityPath(), 'utf8'));
			return raw && typeof raw === 'object' ? (raw as Record<string, LocalActivity[]>) : {};
		} catch {
			return {};
		}
	}

	/** Record one thing done to a project. Never fails the thing itself. */
	private note(id: string, what: string, ok = true): void {
		try {
			const all = this.readActivity();
			all[id] = [{ at: new Date().toISOString(), what, ok }, ...(all[id] ?? [])].slice(0, 200);
			writeFileSync(this.activityPath(), JSON.stringify(all));
		} catch {
			// The log is a convenience; the operation it records already happened.
		}
	}

	/** What the app did to this project, newest first. */
	activity(id: string, limit = 200): LocalActivity[] {
		return (this.readActivity()[id] ?? []).slice(0, Math.max(1, Math.min(200, limit)));
	}

	private forgetActivity(id: string): void {
		const all = this.readActivity();
		if (all[id]) {
			delete all[id];
			writeFileSync(this.activityPath(), JSON.stringify(all));
		}
	}

	private readEnv(project: StoredProject): Map<string, string> {
		const path = join(project.folder, '.env');
		if (!existsSync(path)) {
			throw new Error(`${path} is missing. It held this project's keys; restore it from your backup to run the project again.`);
		}
		return parseEnv(readFileSync(path, 'utf8'));
	}

	/** The names this project's gateway serves: those of the snout-stack its own compose.yaml runs,
	 *  so a project made from an earlier pin keeps being spoken to in the names it understands. */
	private vocabulary(project: StoredProject): Vocabulary {
		let compose: string | null = null;
		try {
			compose = readFileSync(join(project.folder, 'compose.yaml'), 'utf8');
		} catch {
			// Missing or unreadable: the folder's own problem, reported where it is read for real.
		}
		return composeVocabulary(compose);
	}

	// --- running docker -------------------------------------------------------------------------

	private async env(): Promise<NodeJS.ProcessEnv> {
		this.pathEnv ??= await this.deps.userPath();
		const delimiter = this.deps.platform === 'win32' ? ';' : ':';
		// docker's own folder first: Compose and the credential helper (docker-credential-desktop)
		// live beside it, and a pull without the helper fails on a Docker Desktop machine.
		const dockerDir = this.dockerPath ? dirname(this.dockerPath) : '';
		const path = [dockerDir, this.pathEnv].filter(Boolean).join(delimiter);
		return { ...this.deps.env, PATH: path, Path: path };
	}

	private async findDocker(): Promise<string | null> {
		const env = await this.env();
		const onPath = resolveOnPath('docker', { platform: this.deps.platform, env });
		this.dockerPath = onPath ?? knownDockerPaths(this.deps.platform, this.deps.home, this.deps.env).find((p) => existsSync(p)) ?? null;
		return this.dockerPath;
	}

	/**
	 * The user's docker, found the way this service finds it, for a feature that is not a local
	 * project: a Snout Container built from a folder. A docker not found before is looked for again.
	 */
	docker(args: string[], options: Pick<RunOptions, 'input' | 'onLine' | 'timeoutMs' | 'cwd'> = {}): Promise<RunResult> {
		if (this.dockerPath === null) {
			this.dockerPath = undefined;
			this.pathEnv = undefined;
		}
		return this.run(args, options);
	}

	private async run(args: string[], options: RunOptions = {}): Promise<RunResult> {
		if (this.dockerPath === undefined) {
			await this.findDocker();
		}
		const docker = this.dockerPath;
		if (!docker) {
			return { code: -1, stdout: '', stderr: "The docker command was not found on this computer." };
		}
		const env = await this.env();
		return new Promise((done) => {
			const child = spawn(docker, args, { cwd: options.cwd, env, windowsHide: true });
			child.stdin.on('error', () => undefined);
			if (options.stdinFile) {
				createReadStream(options.stdinFile).pipe(child.stdin);
			} else {
				child.stdin.end(options.input ?? '');
			}
			// Owner-only: the one file this streams into is a database export (`exportNow`).
			const sink = options.stdoutFile ? createWriteStream(options.stdoutFile, { mode: PRIVATE_MODE }) : null;
			if (sink) {
				child.stdout.pipe(sink);
			}
			let stdout = '';
			let stderr = '';
			let partial = '';
			const emit = (chunk: string): void => {
				if (!options.onLine) {
					return;
				}
				partial += chunk;
				const parts = partial.split(/\r\n|\r|\n/);
				partial = parts.pop() ?? '';
				for (const line of parts) {
					if (line.trim()) {
						options.onLine(plain(line));
					}
				}
			};
			child.stderr.setEncoding('utf8');
			if (!sink) {
				child.stdout.setEncoding('utf8');
				child.stdout.on('data', (c: string) => { stdout += c; emit(c); });
			}
			child.stderr.on('data', (c: string) => { stderr += c; emit(c); });
			const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : null;
			child.on('error', (err) => {
				if (timer) {
					clearTimeout(timer);
				}
				done({ code: -1, stdout, stderr: stderr || err.message });
			});
			child.on('close', (code) => {
				if (timer) {
					clearTimeout(timer);
				}
				if (partial.trim() && options.onLine) {
					options.onLine(plain(partial));
				}
				if (sink) {
					sink.end(() => done({ code: code ?? -1, stdout, stderr }));
					return;
				}
				done({ code: code ?? -1, stdout, stderr });
			});
		});
	}

	private compose(project: StoredProject, args: string[], options: RunOptions = {}): Promise<RunResult> {
		return this.run(['compose', '-p', composeProject(project.ref), '--project-directory', project.folder, ...args], { cwd: project.folder, ...options });
	}

	// --- requirements ---------------------------------------------------------------------------

	async requirements(): Promise<LocalRequirements> {
		this.pathEnv = undefined;
		const dockerPath = await this.findDocker();
		const facts: EngineFacts = {
			platform: this.deps.platform,
			dockerPath,
			desktopInstalled: desktopApp(this.deps.platform, this.deps.env) !== null,
			info: null,
			composeVersion: null,
			network: false,
		};
		const network = this.deps.fetch(`${STACK_SOURCE}/compose.yaml`, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
			.then((res) => { facts.network = res.ok; facts.networkError = res.ok ? undefined : `HTTP ${res.status}`; })
			.catch((err: unknown) => { facts.networkError = err instanceof Error ? err.message : String(err); });
		if (dockerPath) {
			const [info, compose] = await Promise.all([
				this.run(['info', '--format', '{{json .}}'], { timeoutMs: 15000 }),
				this.run(['compose', 'version', '--short'], { timeoutMs: 15000 }),
			]);
			try {
				const parsed = JSON.parse(info.stdout.trim().split(/\r?\n/).pop() ?? '') as { ServerVersion?: string; OperatingSystem?: string; MemTotal?: number; ServerErrors?: string[] };
				if (info.code === 0 && parsed.ServerVersion) {
					facts.info = { serverVersion: parsed.ServerVersion, operatingSystem: parsed.OperatingSystem ?? '', memTotal: parsed.MemTotal ?? 0 };
				} else {
					facts.infoError = (parsed.ServerErrors ?? []).join(' ') || tailOf(info.stderr, 2);
				}
			} catch {
				facts.infoError = tailOf(info.stderr, 2);
			}
			facts.composeVersion = compose.code === 0 ? compose.stdout.trim() || null : null;
		}
		await network;
		return evaluateRequirements(facts);
	}

	/** Start Docker Desktop. Answers at once; the wizard checks again until the engine answers. */
	async startEngine(): Promise<LocalActionOutcome> {
		const app = desktopApp(this.deps.platform, this.deps.env);
		if (!app) {
			return { ok: false, message: "Docker Desktop is not installed where the app can start it. Start your container engine yourself." };
		}
		const detached = (file: string, args: string[]): void => {
			spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
		};
		if (this.deps.platform === 'win32') {
			detached(app, []);
		} else if (this.deps.platform === 'darwin') {
			detached('open', ['-a', 'Docker']);
		} else {
			detached('systemctl', ['--user', 'start', 'docker-desktop']);
		}
		return { ok: true, message: "Starting Docker Desktop. This can take a minute." };
	}

	// --- the wizard's defaults ------------------------------------------------------------------

	async defaults(name: string): Promise<{ folder: string; apiPort: number; dbPort: number }> {
		const taken = this.readStore();
		const api = new Set(taken.map((p) => p.apiPort));
		const db = new Set(taken.map((p) => p.dbPort));
		const free = new Map<number, boolean>();
		const candidates = [...Array(20).keys()].flatMap((i) => [8000 + i, 54322 + i * 10]);
		const answers = await Promise.all(candidates.map((port) => portAvailable(port)));
		candidates.forEach((port, i) => free.set(port, answers[i]));
		const slug = slugify(name || 'my-project');
		let folder = join(this.deps.home, 'SnoutData', slug);
		for (let i = 2; existsSync(folder) && !isEmptyDir(folder); i++) {
			folder = join(this.deps.home, 'SnoutData', `${slug}-${i}`);
		}
		return {
			folder,
			apiPort: suggestPort(8000, api, (p) => free.get(p) ?? false, 20),
			// 54322, not 5432: a local Postgres nearly always holds 5432 already.
			dbPort: [...Array(20).keys()].map((i) => 54322 + i * 10).find((p) => !db.has(p) && free.get(p)) ?? 54322,
		};
	}

	/** Which of these ports something else is listening on. */
	async portsInUse(ports: number[]): Promise<number[]> {
		const free = await Promise.all(ports.map((port) => portAvailable(port)));
		return ports.filter((_, i) => !free[i]);
	}

	// --- the list -------------------------------------------------------------------------------

	async list(): Promise<LocalProjectsView> {
		const stored = this.readStore();
		if (stored.length === 0) {
			return { projects: [] };
		}
		const ps = await this.run(['ps', '-a', '--filter', 'label=com.docker.compose.project', '--format', '{{json .}}'], { timeoutMs: 15000 });
		const reachable = ps.code === 0;
		const byProject = reachable ? parseDockerPs(ps.stdout) : new Map();
		const projects: LocalProjectRow[] = stored.map((p) => {
			const services = byProject.get(composeProject(p.ref)) ?? [];
			let state: LocalProjectRow['state'];
			if (!existsSync(join(p.folder, 'compose.yaml'))) {
				state = 'missing';
			} else if (!reachable) {
				state = 'unknown';
			} else {
				state = this.busy.has(p.id) && services.length === 0 ? 'starting' : projectState(services);
			}
			return {
				id: p.id,
				name: p.name,
				folder: p.folder,
				ref: p.ref,
				apiUrl: `http://localhost:${p.apiPort}`,
				dbPort: p.dbPort,
				state,
				services,
				createdAt: p.createdAt,
				production: p.production === true,
				vocabulary: this.vocabulary(p),
			};
		});
		return {
			projects,
			unavailable: reachable ? undefined : `Docker is not running, so these projects' states cannot be read. ${this.dockerPath ? "Start Docker" : "Install Docker"} to run them.`,
		};
	}

	// --- set up ---------------------------------------------------------------------------------

	async install(form: LocalSetupForm, installId: string, progress: (p: LocalProgress) => void): Promise<LocalInstallOutcome> {
		const say = (step: LocalProgress['step'], message: string): void => progress({ installId, step, message });
		const line = (step: LocalProgress['step']) => (text: string): void => progress({ installId, step, message: '', line: text });
		const fail = (message: string): LocalInstallOutcome => {
			say('failed', message);
			return { ok: false, message };
		};

		const problem = formProblem(form);
		if (problem) {
			return fail(problem);
		}
		const folder = resolve(form.folder.trim());
		if (existsSync(folder) && (!statSync(folder).isDirectory() || !isEmptyDir(folder))) {
			return fail(`${folder} is not empty. Choose a new or empty folder: the project's files go there.`);
		}
		const busyPorts = await this.portsInUse([form.apiPort, form.dbPort]);
		if (busyPorts.length > 0) {
			return fail(`Port ${busyPorts.join(" and ")} is already in use on this computer. Choose another.`);
		}

		// 1. The published stack's files, as the README's `git clone` would have them: from the
		// pinned commit, and every one checked against its pinned hash BEFORE the folder is made,
		// so a changed file leaves nothing on disk and nothing is run.
		say('download', "Downloading the stack from github.com/snoutdata/snout-stack");
		const downloaded = await downloadStack(this.deps.fetch);
		if ('problem' in downloaded) {
			return fail(downloaded.problem);
		}
		const compose = Buffer.from(downloaded.files.get('compose.yaml') ?? new Uint8Array()).toString('utf8');
		const image = stackImageFrom(compose);
		if (image !== STACK_IMAGE) {
			return fail("The downloaded compose.yaml does not name the snout-stack image this version of the app expects. Try again later, or report it.");
		}
		try {
			mkdirSync(folder, { recursive: true });
			for (const [file, bytes] of downloaded.files) {
				const target = join(folder, ...file.split('/'));
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, bytes);
			}
			writeFileSync(join(folder, '.gitignore'), '.env\nfunctions/.env\n');
			writeFileSync(join(folder, 'compose.override.yaml'), APP_OVERRIDE);
			mkdirSync(join(folder, ...MAIL_DIR.split('/')), { recursive: true });
		} catch (err) {
			return fail(`Could not write the stack's files: ${err instanceof Error ? err.message : String(err)}`);
		}

		// 2. Keys: `snout-stack init`, from the very image the compose file runs.
		say('keys', "Making this project's keys and passwords");
		const init = await this.run(['run', '--rm', image, 'init'], { onLine: (l) => { if (!/^[A-Z_]+=/.test(l)) { line('keys')(l); } }, timeoutMs: 15 * 60 * 1000 });
		const made = parseEnv(init.stdout);
		const ref = made.get('SNOUT_REF') ?? '';
		if (init.code !== 0 || !isRef(ref) || !envKey(made, 'app')) {
			return fail(`Could not make the project's keys: ${tailOf(init.stderr) || "snout-stack init gave nothing back."}`);
		}
		const envPath = join(folder, '.env');
		writeFileSync(envPath, applyEnv(init.stdout, envFor(form)), { mode: 0o600 });

		// From here the project exists: it is listed, and a failure below leaves it to be started
		// again from the panel rather than half-made and invisible.
		const project: StoredProject = {
			id: randomUUID(),
			name: form.name.trim(),
			folder,
			ref,
			apiPort: form.apiPort,
			dbPort: form.dbPort,
			createdAt: new Date().toISOString(),
		};
		this.writeStore([...this.readStore(), project]);
		if (form.addConnection) {
			this.deps.addConnection({
				label: project.name,
				driver: 'postgres',
				host: '127.0.0.1',
				port: form.dbPort,
				database: ref,
				username: `${ref}_owner`,
				password: made.get('POSTGRES_OWNER_PASSWORD'),
				ssl: false,
				readOnly: false,
				localProjectId: project.id,
			});
		}

		this.busy.add(project.id);
		try {
			// 3. The images. Their own step so a slow first pull reads as progress, not a hang.
			say('pull', "Downloading the images (about 670 MB the first time)");
			const pull = await this.compose(project, ['pull'], { onLine: line('pull'), timeoutMs: 60 * 60 * 1000 });
			if (pull.code !== 0) {
				return { ...fail(`Could not download the images: ${tailOf(pull.stderr)}`), id: project.id };
			}

			// 4. Up, and wait for every health check, as the README does.
			say('start', "Starting the services");
			const up = await this.compose(project, ['up', '-d', '--wait', '--wait-timeout', '600'], { onLine: line('start'), timeoutMs: 15 * 60 * 1000 });
			if (up.code !== 0) {
				return { ...fail(`The stack did not start: ${tailOf(up.stderr)}`), id: project.id };
			}
		} finally {
			this.busy.delete(project.id);
		}

		this.note(project.id, "Set up and started");
		say('done', `${project.name} is running at http://localhost:${form.apiPort}`);
		return { ok: true, message: `${project.name} is running.`, id: project.id };
	}

	// --- lifecycle ------------------------------------------------------------------------------

	private async exclusive(id: string, work: () => Promise<LocalActionOutcome>): Promise<LocalActionOutcome> {
		if (this.busy.has(id)) {
			return { ok: false, message: "Something is already happening to this project. Wait for it to finish." };
		}
		this.busy.add(id);
		try {
			return await work();
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err) };
		} finally {
			this.busy.delete(id);
		}
	}

	start(id: string, progress: (p: LocalProgress) => void): Promise<LocalActionOutcome> {
		return this.exclusive(id, async () => {
			const project = this.find(id);
			this.readEnv(project);
			this.ensureOverride(project);
			progress({ installId: id, step: 'start', message: "Starting the services" });
			const up = await this.compose(project, ['up', '-d', '--wait', '--wait-timeout', '600'], {
				onLine: (l) => progress({ installId: id, step: 'start', message: '', line: l }),
				timeoutMs: 60 * 60 * 1000,
			});
			const outcome = up.code === 0
				? { ok: true, message: `${project.name} is running.` }
				: { ok: false, message: `It did not start: ${tailOf(up.stderr)}` };
			this.note(id, outcome.ok ? "Started" : "Start failed", outcome.ok);
			progress({ installId: id, step: outcome.ok ? 'done' : 'failed', message: outcome.message });
			return outcome;
		});
	}

	stop(id: string): Promise<LocalActionOutcome> {
		return this.exclusive(id, async () => {
			const project = this.find(id);
			const res = await this.compose(project, ['stop'], { timeoutMs: 5 * 60 * 1000 });
			this.note(id, res.code === 0 ? "Stopped" : "Stop failed", res.code === 0);
			return res.code === 0
				? { ok: true, message: `${project.name} is stopped. Its data is kept.` }
				: { ok: false, message: `Could not stop it: ${tailOf(res.stderr)}` };
		});
	}

	/**
	 * Take a project off the list. `deleteData` also removes its volumes (the database, the files),
	 * and `deleteFolder` its folder, `.env` with it: both are what makes it unrecoverable, so both
	 * are asked for separately.
	 */
	remove(id: string, options: { deleteData: boolean; deleteFolder: boolean }): Promise<LocalActionOutcome> {
		return this.exclusive(id, async () => {
			const project = this.find(id);
			if (existsSync(join(project.folder, 'compose.yaml')) && existsSync(join(project.folder, '.env'))) {
				const down = await this.compose(project, ['down', '--remove-orphans', ...(options.deleteData ? ['--volumes'] : [])], { timeoutMs: 10 * 60 * 1000 });
				if (down.code !== 0) {
					return { ok: false, message: `Could not remove its containers: ${tailOf(down.stderr)}` };
				}
			} else if (options.deleteData) {
				return { ok: false, message: "Its folder is gone, so its data cannot be found to delete. Remove it from the list without deleting data." };
			}
			for (const connection of this.deps.connectionsOf(id)) {
				await this.deps.removeConnection(connection.id);
			}
			this.writeStore(this.readStore().filter((p) => p.id !== id));
			this.forgetActivity(id);
			// Only a folder this app set up: it must still hold the stack's own two files.
			if (options.deleteFolder && existsSync(join(project.folder, 'compose.yaml'))) {
				rmSync(project.folder, { recursive: true, force: true });
			}
			return { ok: true, message: `${project.name} was removed.` };
		});
	}

	async logs(id: string, service: string | null, tail = 300): Promise<string> {
		const project = this.find(id);
		if (service !== null && !/^[a-z][a-z0-9-]*$/.test(service)) {
			return '';
		}
		const res = await this.compose(project, ['logs', '--no-color', '--tail', String(tail), ...(service ? [service] : [])], { timeoutMs: 30000 });
		return res.code === 0 ? plain(res.stdout + res.stderr) : `Could not read the logs: ${tailOf(res.stderr)}`;
	}

	/** What the dashboard's sections need to reach the project: read off .env, for main only. */
	target(id: string): LocalTarget {
		const project = this.find(id);
		const env = this.readEnv(project);
		return {
			ref: project.ref,
			dbPort: project.dbPort,
			apiPort: project.apiPort,
			password: env.get('POSTGRES_OWNER_PASSWORD') ?? '',
			serverKey: envKey(env, 'server') ?? '',
			vocabulary: this.vocabulary(project),
		};
	}

	// --- connection & keys ----------------------------------------------------------------------

	facts(id: string): LocalConnectionFacts {
		const project = this.find(id);
		const env = this.readEnv(project);
		return {
			apiUrl: env.get('API_EXTERNAL_URL') ?? `http://localhost:${project.apiPort}`,
			ref: project.ref,
			host: '127.0.0.1',
			port: project.dbPort,
			database: project.ref,
			user: `${project.ref}_owner`,
			folder: project.folder,
			paths: gatewayPaths(this.vocabulary(project)),
		};
	}

	copy(id: string, target: LocalCopyTarget): LocalActionOutcome {
		const project = this.find(id);
		const env = this.readEnv(project);
		const password = env.get('POSTGRES_OWNER_PASSWORD') ?? '';
		const values: Record<LocalCopyTarget, [string | undefined, string]> = {
			apiUrl: [env.get('API_EXTERNAL_URL'), "The API URL"],
			appKey: [envKey(env, 'app'), "The app key"],
			serverKey: [envKey(env, 'server'), "The server key"],
			dbPassword: [password || undefined, "The database password"],
			dbUrl: [password ? dbUrl(project.ref, password, project.dbPort) : undefined, "The connection string"],
		};
		const [value, label] = values[target];
		if (!value) {
			return { ok: false, message: `${label} is not in .env.` };
		}
		this.deps.copy(value);
		if (target !== 'apiUrl') {
			this.note(id, `${label} was copied`);
		}
		return { ok: true, message: `${label} was copied.` };
	}

	/** The project's exports, in the file manager. */
	openExports(id: string): Promise<void> {
		const project = this.find(id);
		const dir = this.exportDir(project);
		ensurePrivateDir(dir);
		return this.deps.openPath(dir);
	}

	openFolder(id: string, sub?: string): Promise<void> {
		const project = this.find(id);
		const path = sub && isFunctionName(sub) ? join(project.folder, 'functions', sub) : project.folder;
		return this.deps.openPath(path);
	}

	// --- functions ------------------------------------------------------------------------------

	functions(id: string): LocalFunctionRow[] {
		const project = this.find(id);
		const dir = join(project.folder, 'functions');
		if (!existsSync(dir)) {
			return [];
		}
		const base = `http://localhost:${project.apiPort}`;
		const fn = prefix('fn', this.vocabulary(project));
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && isFunctionName(e.name) && existsSync(join(dir, e.name, 'index.ts')))
			.map((e) => ({ name: e.name, url: `${base}${fn}/${e.name}` }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	newFunction(id: string, name: string): LocalActionOutcome {
		const project = this.find(id);
		if (!isFunctionName(name) || name.startsWith('_')) {
			return { ok: false, message: "A function name is letters, digits, dashes and underscores, and does not start with _." };
		}
		const dir = join(project.folder, 'functions', name);
		if (existsSync(dir)) {
			return { ok: false, message: `functions/${name} already exists.` };
		}
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'index.ts'), functionTemplate(name));
		return { ok: true, message: `functions/${name}/index.ts was created. Deploy to serve it.` };
	}

	deployFunctions(id: string, progress: (p: LocalProgress) => void): Promise<LocalActionOutcome> {
		return this.exclusive(id, async () => {
			const project = this.find(id);
			const res = await this.compose(project, ['run', '--rm', 'functions-deploy'], {
				onLine: (l) => progress({ installId: id, step: 'start', message: '', line: l }),
				timeoutMs: 15 * 60 * 1000,
			});
			this.note(id, res.code === 0 ? "Functions deployed" : "Functions deploy failed", res.code === 0);
			return res.code === 0
				? { ok: true, message: "Functions deployed. The runtime serves the new code at once." }
				: { ok: false, message: `The deploy failed: ${tailOf(res.stderr || res.stdout)}` };
		});
	}

	// --- the data API -------------------------------------------------------------------------------

	private overridePath(project: StoredProject): string {
		return join(project.folder, 'compose.override.yaml');
	}

	dataApi(id: string): { on: boolean; switchable: boolean } {
		const project = this.find(id);
		const path = this.overridePath(project);
		const override = existsSync(path) ? readFileSync(path, 'utf8') : null;
		return {
			on: dataApiOn(this.readEnv(project), override),
			// An override the user wrote is theirs: the switch would have to edit it, so it does not.
			switchable: override === null || override.startsWith(OVERRIDE_MARK),
		};
	}

	/** Switch the data API on or off: the profile in .env, then `up` (on) or the container removed (off). */
	setDataApi(id: string, on: boolean, progress: (p: LocalProgress) => void): Promise<LocalActionOutcome> {
		return this.exclusive(id, async () => {
			const project = this.find(id);
			const env = this.readEnv(project);
			const path = this.overridePath(project);
			const override = existsSync(path) ? readFileSync(path, 'utf8') : null;
			if (override !== null && !override.startsWith(OVERRIDE_MARK)) {
				return { ok: false, message: "This project has a compose.override.yaml of your own, so the app leaves the data API to it." };
			}
			this.ensureOverride(project);
			const envPath = join(project.folder, '.env');
			const profiles = withProfile(env.get('COMPOSE_PROFILES') ?? 'objects,images', DATA_API_PROFILE, on);
			writeFileSync(envPath, applyEnv(readFileSync(envPath, 'utf8'), { COMPOSE_PROFILES: profiles }), { mode: 0o600 });
			const line = (l: string): void => progress({ installId: id, step: 'start', message: '', line: l });
			const res = on
				? await this.compose(project, ['up', '-d', '--wait', '--wait-timeout', '600'], { onLine: line, timeoutMs: 15 * 60 * 1000 })
				: await this.compose(project, ['rm', '--stop', '--force', 'rest'], { onLine: line, timeoutMs: 5 * 60 * 1000 });
			this.note(id, on ? "Data API switched on" : "Data API switched off", res.code === 0);
			if (res.code !== 0) {
				return { ok: false, message: `The switch is saved, but Docker did not apply it: ${tailOf(res.stderr)}` };
			}
			return on
				? { ok: true, message: `The data API is on: REST at ${prefix('data', this.vocabulary(project))} and GraphQL at ${prefix('graph', this.vocabulary(project))}.` }
				: { ok: true, message: "The data API is off. The rest of the project keeps running." };
		});
	}

	// --- settings -------------------------------------------------------------------------------

	settings(id: string): LocalSettings {
		return settingsFromEnv(this.readEnv(this.find(id)));
	}

	/** Write the change into `.env`, then `up` again, which recreates only what changed. */
	saveSettings(id: string, change: LocalSettingsChange, progress: (p: LocalProgress) => void): Promise<LocalActionOutcome> {
		return this.exclusive(id, async () => {
			const project = this.find(id);
			this.readEnv(project);
			const moved = [change.apiPort, change.dbPort].filter((p): p is number => p !== undefined && p !== project.apiPort && p !== project.dbPort);
			const inUse = await this.portsInUse(moved);
			if (inUse.length > 0) {
				return { ok: false, message: `Port ${inUse.join(" and ")} is already in use on this computer.` };
			}
			if (change.apiPort !== undefined && change.apiPort === (change.dbPort ?? project.dbPort)) {
				return { ok: false, message: "The API and the database need different ports." };
			}
			if (change.publicUrl !== undefined) {
				const problem = publicUrlProblem(change.publicUrl);
				if (problem) {
					return { ok: false, message: problem };
				}
			}
			const problem = settingsProblem(change);
			if (problem) {
				return { ok: false, message: problem };
			}
			this.ensureOverride(project);
			const envPath = join(project.folder, '.env');
			const current = settingsFromEnv(parseEnv(readFileSync(envPath, 'utf8')));
			writeFileSync(envPath, applyEnv(readFileSync(envPath, 'utf8'), envForSettings(change, current)), { mode: 0o600 });
			this.update(id, {
				apiPort: change.apiPort ?? project.apiPort,
				dbPort: change.dbPort ?? project.dbPort,
			});
			if (change.dbPort !== undefined && change.dbPort !== project.dbPort) {
				for (const connection of this.deps.connectionsOf(id)) {
					this.deps.updateConnection(connection.id, { port: change.dbPort });
				}
			}
			progress({ installId: id, step: 'start', message: "Applying the change" });
			const up = await this.compose(project, ['up', '-d', '--wait', '--wait-timeout', '600'], {
				onLine: (l) => progress({ installId: id, step: 'start', message: '', line: l }),
				timeoutMs: 30 * 60 * 1000,
			});
			const outcome = up.code === 0
				? { ok: true, message: "Saved. The services that changed were restarted." }
				: { ok: false, message: `Saved, but the stack did not come back up: ${tailOf(up.stderr)}` };
			this.note(id, `Settings changed: ${Object.keys(change).join(', ')}`, outcome.ok);
			progress({ installId: id, step: outcome.ok ? 'done' : 'failed', message: outcome.message });
			return outcome;
		});
	}

	/**
	 * The app's compose.override.yaml, current: written when there is none, brought up to date when
	 * an older app wrote it, and never touched when it is the user's own. Answers whether the app's
	 * additions (the data API switch, the email templates) are in force.
	 */
	private ensureOverride(project: StoredProject): boolean {
		const path = this.overridePath(project);
		const override = existsSync(path) ? readFileSync(path, 'utf8') : null;
		mkdirSync(join(project.folder, ...MAIL_DIR.split('/')), { recursive: true });
		if (override === null || overrideStale(override)) {
			writeFileSync(path, APP_OVERRIDE);
			return true;
		}
		return override.startsWith(OVERRIDE_MARK);
	}

	// --- auth's emails ----------------------------------------------------------------------------

	private mailFile(project: StoredProject, kind: LocalMailKind): string {
		return join(project.folder, ...MAIL_DIR.split('/'), `${kind}.html`);
	}

	/** The five emails: the project's own where it has one, auth's built-in one otherwise. */
	mailTemplates(id: string): LocalMailTemplate[] {
		const project = this.find(id);
		const env = this.readEnv(project);
		return MAIL_KINDS_ORDER.map((kind) => {
			const names = mailEnv(kind);
			const file = this.mailFile(project, kind);
			const custom = (env.get(names.template) ?? '') !== '' && existsSync(file);
			return {
				kind,
				custom,
				subject: env.get(names.subject) || MAIL_DEFAULTS[kind].subject,
				body: custom ? readFileSync(file, 'utf8') : MAIL_DEFAULTS[kind].body,
			};
		});
	}

	/**
	 * Make one email the project's own (`template` given) or go back to auth's (`null`). The body is
	 * a file auth fetches; the subject and the URL are .env, so `up` recreates auth with them, and a
	 * body changed under the same URL needs auth restarted (it caches a template for ten minutes).
	 */
	saveMailTemplate(id: string, kind: LocalMailKind, template: { subject: string; body: string } | null, progress: (p: LocalProgress) => void): Promise<LocalActionOutcome> {
		return this.exclusive(id, async () => {
			if (!isMailKind(kind)) {
				return { ok: false, message: "Not one of auth's emails." };
			}
			const project = this.find(id);
			this.readEnv(project);
			if (!this.ensureOverride(project)) {
				return { ok: false, message: "This project has a compose.override.yaml of your own, so the app cannot add the email templates to it." };
			}
			if (template) {
				const problem = mailTemplateProblem(template.subject, template.body);
				if (problem) {
					return { ok: false, message: problem };
				}
			}
			const names = mailEnv(kind);
			const file = this.mailFile(project, kind);
			if (template) {
				writeFileSync(file, template.body);
			} else {
				rmSync(file, { force: true });
			}
			const envPath = join(project.folder, '.env');
			writeFileSync(envPath, applyEnv(readFileSync(envPath, 'utf8'), {
				[names.subject]: template ? template.subject.trim() : '',
				[names.template]: template ? mailTemplateUrl(kind) : '',
			}), { mode: 0o600 });
			const line = (l: string): void => progress({ installId: id, step: 'start', message: '', line: l });
			const up = await this.compose(project, ['up', '-d', '--wait', '--wait-timeout', '600'], { onLine: line, timeoutMs: 30 * 60 * 1000 });
			const restart = up.code === 0 ? await this.compose(project, ['restart', 'auth'], { onLine: line, timeoutMs: 5 * 60 * 1000 }) : up;
			const ok = up.code === 0 && restart.code === 0;
			this.note(id, `Email template ${template ? 'saved' : 'reset'}: ${kind.replace('_', ' ')}`, ok);
			return ok
				? { ok: true, message: template ? "Saved. Auth sends it from now on." : "Back to auth's own email." }
				: { ok: false, message: `Saved, but auth did not restart: ${tailOf((up.code !== 0 ? up : restart).stderr)}` };
		});
	}

	// --- functions' secrets -------------------------------------------------------------------------

	private secretsFile(project: StoredProject): string {
		return join(project.folder, 'functions', '.env');
	}

	/**
	 * For a copy to SnoutData Cloud (`projectCopy.ts`), main only: each function's files, read as
	 * the CLI reads a folder for a deploy (dotfiles and node_modules left out, a binary file refused
	 * by name), and whether it asks for a key.
	 */
	functionSources(id: string): LocalFunctionSource[] {
		const project = this.find(id);
		const dir = join(project.folder, 'functions');
		const noVerify = new Set(settingsFromEnv(this.readEnv(project)).functionsNoVerify);
		const sharedDir = join(dir, '_shared');
		let shared: FunctionFile[] | null = null;
		let sharedProblem: string | null = null;
		// lstat, not stat: a `_shared` that is a link is refused by the read below rather than followed.
		const sharedEntry = lstatExists(sharedDir) ? lstatSync(sharedDir) : undefined;
		if (sharedEntry && (sharedEntry.isDirectory() || sharedEntry.isSymbolicLink())) {
			try {
				shared = readFunctionTree(sharedDir);
			} catch (err) {
				sharedProblem = err instanceof Error ? err.message : String(err);
			}
		}
		return this.functions(id).map((fn) => {
			try {
				return { name: fn.name, verifyJwt: !noVerify.has(fn.name), own: readFunctionTree(join(dir, fn.name)), shared, problem: sharedProblem };
			} catch (err) {
				return { name: fn.name, verifyJwt: !noVerify.has(fn.name), own: [], shared: null, problem: err instanceof Error ? err.message : String(err) };
			}
		});
	}

	/** A project's name and whether it is marked production, for a copy's review. */
	describe(id: string): { name: string; production: boolean } {
		const project = this.find(id);
		return { name: project.name, production: project.production === true };
	}

	/** For a copy to SnoutData Cloud, main only: the secrets WITH their values, which never cross IPC. */
	functionSecretValues(id: string): [string, string][] {
		const file = this.secretsFile(this.find(id));
		return existsSync(file) ? [...parseEnv(readFileSync(file, 'utf8')).entries()] : [];
	}

	/** The secrets' names. Values are never read back, as the cloud's are not. */
	functionSecrets(id: string): string[] {
		const file = this.secretsFile(this.find(id));
		return existsSync(file) ? secretNames(readFileSync(file, 'utf8')) : [];
	}

	/** Set one secret (or remove it, `value` null), then deploy: the deploy step is what hands them over. */
	setFunctionSecret(id: string, name: string, value: string | null, progress: (p: LocalProgress) => void): Promise<LocalActionOutcome> {
		const problem = secretNameProblem(name);
		if (problem) {
			return Promise.resolve({ ok: false, message: problem });
		}
		const valueProblem = value === null ? null : secretValueProblem(value);
		if (valueProblem) {
			return Promise.resolve({ ok: false, message: valueProblem });
		}
		const project = this.find(id);
		const file = this.secretsFile(project);
		mkdirSync(dirname(file), { recursive: true });
		const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
		writeFileSync(file, withSecret(text, name, value), { mode: 0o600 });
		this.note(id, value === null ? `Secret removed: ${name}` : `Secret set: ${name}`);
		return this.deployFunctions(id, progress).then((outcome) => outcome.ok
			? { ok: true, message: value === null ? `${name} was removed. Functions were deployed without it.` : `${name} was set. Functions were deployed with it.` }
			: { ok: false, message: `${name} is saved in functions/.env, but ${outcome.message.charAt(0).toLowerCase()}${outcome.message.slice(1)}` });
	}

	// --- the things done TO a project: password, keys, production, exports ----------------------

	/** psql as the cluster's admin, inside the `db` container (trusted on 127.0.0.1 there), SQL on stdin. */
	private admin(project: StoredProject, sql: string, database = 'postgres'): Promise<RunResult> {
		return this.compose(project, ['exec', '-T', 'db', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', 'snoutpod_admin', '-d', database], { input: sql, timeoutMs: 60000 });
	}

	private async running(project: StoredProject, services: string[] = ['db']): Promise<boolean> {
		const res = await this.compose(project, ['ps', '--status', 'running', '--services'], { timeoutMs: 15000 });
		const up = res.stdout.split(/\r?\n/).map((l) => l.trim());
		return res.code === 0 && services.every((s) => up.includes(s));
	}

	/**
	 * A new password for the owner, as the cloud's reset does: drawn here, set in Postgres as a SCRAM
	 * verifier, written into .env (the only copy), and handed to this project's connections. A
	 * session already open keeps going; a new connection needs the new password.
	 */
	resetPassword(id: string): Promise<LocalActionOutcome> {
		return this.exclusive(id, async () => {
			const project = this.find(id);
			this.readEnv(project);
			if (!(await this.running(project))) {
				return { ok: false, message: "Start the project first: the password is changed in its running database." };
			}
			const password = randomSecret(24);
			const res = await this.admin(project, ownerPasswordSql(project.ref, scramVerifier(password)));
			if (res.code !== 0) {
				this.note(id, "Password reset failed", false);
				return { ok: false, message: `The database refused the new password: ${tailOf(res.stderr)}` };
			}
			const envPath = join(project.folder, '.env');
			writeFileSync(envPath, applyEnv(readFileSync(envPath, 'utf8'), { POSTGRES_OWNER_PASSWORD: password }), { mode: 0o600 });
			const updated = this.deps.connectionsOf(id);
			for (const connection of updated) {
				this.deps.updateConnection(connection.id, { password });
			}
			this.note(id, "Database password reset");
			const said = updated.length === 0 ? '' : updated.length === 1 ? " Your connection was updated." : ` ${updated.length} connections were updated.`;
			return { ok: true, message: `New password set.${said} Copy it from Database.` };
		});
	}

	/**
	 * New API keys: a new JWT secret and both keys signed with it, in .env, then `up`, which re-runs
	 * setup (storage and Realtime are told the new secret) and restarts what reads them. Every key
	 * pasted anywhere stops working, and so does every signed-in user's session.
	 */
	rotateKeys(id: string, progress: (p: LocalProgress) => void): Promise<LocalActionOutcome> {
		return this.exclusive(id, async () => {
			const project = this.find(id);
			const env = this.readEnv(project);
			const envPath = join(project.folder, '.env');
			writeFileSync(envPath, applyEnv(readFileSync(envPath, 'utf8'), rotatedKeys(env)), { mode: 0o600 });
			progress({ installId: id, step: 'start', message: "Restarting with the new keys" });
			const up = await this.compose(project, ['up', '-d', '--wait', '--wait-timeout', '600'], {
				onLine: (l) => progress({ installId: id, step: 'start', message: '', line: l }),
				timeoutMs: 30 * 60 * 1000,
			});
			this.note(id, "API keys rotated", up.code === 0);
			const outcome = up.code === 0
				? { ok: true, message: "New keys issued. Every key pasted into an app or a secret stops working, and signed-in users sign in again." }
				: { ok: false, message: `The new keys are in .env, but the stack did not come back up: ${tailOf(up.stderr)}` };
			progress({ installId: id, step: outcome.ok ? 'done' : 'failed', message: outcome.message });
			return outcome;
		});
	}

	/** Production: the connection gets the production guard, and the app asks before stopping it. */
	setProduction(id: string, on: boolean): LocalActionOutcome {
		this.find(id);
		this.update(id, { production: on });
		for (const connection of this.deps.connectionsOf(id)) {
			this.deps.updateConnection(connection.id, { production: on });
		}
		this.note(id, on ? "Marked production" : "No longer production");
		return { ok: true, message: on ? "Marked production." : "No longer production." };
	}

	private exportDir(project: StoredProject): string {
		return join(project.folder, EXPORT_DIR);
	}

	exports(id: string): LocalExport[] {
		const dir = this.exportDir(this.find(id));
		if (!existsSync(dir)) {
			return [];
		}
		return readdirSync(dir)
			.filter(isExportName)
			.map((name) => {
				const stat = statSync(join(dir, name));
				return { name, bytes: stat.size, at: stat.mtime.toISOString() };
			})
			.sort((a, b) => b.name.localeCompare(a.name));
	}

	/** A `pg_dump` of the whole database, custom format (`pg_restore` reads it), into backups/. */
	exportNow(id: string): Promise<LocalActionOutcome> {
		return this.exclusive(id, async () => {
			const project = this.find(id);
			this.readEnv(project);
			if (!(await this.running(project))) {
				return { ok: false, message: "Start the project first: the export is taken from the running database." };
			}
			// An export is the whole database, auth's password hashes and every key included, so the
			// folder and each file in it are the owner's alone, and exports an older build left
			// readable are tightened on the way in.
			const dir = this.exportDir(project);
			ensurePrivateDir(dir);
			tightenPrivateFiles(dir, process.platform, readdirSync(dir).filter(isExportName));
			const ignore = join(project.folder, '.gitignore');
			const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
			if (!ignored.split(/\r?\n/).includes(`${EXPORT_DIR}/`)) {
				writeFileSync(ignore, `${ignored}${ignored && !ignored.endsWith('\n') ? '\n' : ''}${EXPORT_DIR}/\n`);
			}
			const name = exportName(project.ref, new Date());
			const file = join(dir, name);
			createPrivateFile(file);
			const res = await this.compose(project, ['exec', '-T', 'db', 'pg_dump', '-Fc', '--create', '-h', '127.0.0.1', '-U', 'snoutpod_admin', '-d', project.ref], { stdoutFile: file, timeoutMs: 6 * 60 * 60 * 1000 });
			if (res.code !== 0) {
				rmSync(file, { force: true });
				this.note(id, "Export failed", false);
				return { ok: false, message: `The export failed: ${tailOf(res.stderr)}` };
			}
			this.note(id, `Exported ${name}`);
			return { ok: true, message: `Exported to ${EXPORT_DIR}/${name}. Files in storage are not in it; they stay in the objects volume.` };
		});
	}

	/**
	 * Put the database back to an export, over this project: a local project has no slot beside it
	 * for a second project, and the export it came from stays where it is. It is restored into a
	 * scratch database first while the project keeps running, so a restore that fails changes
	 * nothing; only then are the services that hold sessions stopped for the swap, and `up` brings
	 * everything back, setup registering storage and Realtime again.
	 */
	restore(id: string, name: string, progress: (p: LocalProgress) => void): Promise<LocalActionOutcome> {
		return this.exclusive(id, async () => {
			const project = this.find(id);
			this.readEnv(project);
			const file = join(this.exportDir(project), name);
			if (!isExportName(name) || !existsSync(file)) {
				return { ok: false, message: "That export is not in the project's backups folder." };
			}
			if (!(await this.running(project))) {
				return { ok: false, message: "Start the project first: the restore runs in its database server." };
			}
			const line = (l: string): void => progress({ installId: id, step: 'start', message: '', line: l });
			const failed = (message: string): LocalActionOutcome => {
				this.note(id, `Restore from ${name} failed`, false);
				progress({ installId: id, step: 'failed', message });
				return { ok: false, message };
			};

			// 1. Into a scratch database beside the project's, which keeps running untouched.
			progress({ installId: id, step: 'start', message: "Restoring the export beside the project's database" });
			const copied = await this.compose(project, ['exec', '-T', 'db', 'sh', '-c', `cat > ${RESTORE_FILE}`], { stdinFile: file, timeoutMs: 60 * 60 * 1000 });
			const restored = copied.code === 0
				? await this.compose(project, ['exec', '-T', 'db', 'sh', '-s'], { input: restoreScript(project.ref), onLine: line, timeoutMs: 6 * 60 * 60 * 1000 })
				: copied;
			if (restored.code !== 0) {
				await this.compose(project, ['exec', '-T', 'db', 'sh', '-s'], { input: restoreCleanupScript(project.ref), timeoutMs: 5 * 60 * 1000 });
				return failed(`Nothing was changed: the export did not restore. ${tailOf(restored.stderr)}`);
			}

			// 2. The swap, with the services that hold sessions stopped for it.
			progress({ installId: id, step: 'start', message: "Swapping it in" });
			const stop = await this.compose(project, ['stop', 'gateway', 'auth', 'rest', 'storage', 'realtime', 'functions'], { onLine: line, timeoutMs: 5 * 60 * 1000 });
			const swap = stop.code === 0 ? await this.admin(project, restoreSwapSql(project.ref)) : stop;
			let outcome: LocalActionOutcome = swap.code === 0
				? { ok: true, message: `Put back to ${name}.` }
				: { ok: false, message: `The restored database could not be swapped in: ${tailOf(swap.stderr)}` };
			if (swap.code !== 0) {
				await this.compose(project, ['exec', '-T', 'db', 'sh', '-s'], { input: restoreCleanupScript(project.ref), timeoutMs: 5 * 60 * 1000 });
			}
			// 3. pg_cron and its jobs, which only the project's own database can hold.
			if (outcome.ok) {
				const after = await this.compose(project, ['exec', '-T', 'db', 'sh', '-s'], { input: restoreAfterSwapScript(project.ref), onLine: line, timeoutMs: 30 * 60 * 1000 });
				if (after.code !== 0) {
					outcome = { ok: false, message: `Put back to ${name}, but its Cron jobs could not be restored: ${tailOf(after.stderr)}` };
				}
			}
			progress({ installId: id, step: 'start', message: "Starting the services again" });
			const up = await this.compose(project, ['up', '-d', '--wait', '--wait-timeout', '600'], { onLine: line, timeoutMs: 30 * 60 * 1000 });
			if (outcome.ok && up.code !== 0) {
				outcome = { ok: false, message: `Restored, but the stack did not come back up: ${tailOf(up.stderr)}` };
			}
			this.note(id, outcome.ok ? `Restored from ${name}` : `Restore from ${name} failed`, outcome.ok);
			progress({ installId: id, step: outcome.ok ? 'done' : 'failed', message: outcome.message });
			return outcome;
		});
	}
}


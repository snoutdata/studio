/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
	AgentConsole,
	MCP_ENV_TOKEN,
	MCP_ENV_URL,
	Scrollback,
	consoleEnvironment,
	cmdArgument,
	planSpawn,
	resolveOnPath,
	type PtyLike,
	type SpawnPlan,
} from './agentConsole';
import { ConsoleReplay, agentImagePasteKey, type AgentConsoleSize } from '../shared/agentConsole';

/** A stand-in for a node-pty process: nothing native is loaded in these tests. */
class FakePty implements PtyLike {
	readonly pid = 4242;
	written: string[] = [];
	resized: AgentConsoleSize[] = [];
	killed = false;
	private data: ((d: string) => void) | null = null;
	private exit: ((e: { exitCode: number; signal?: number }) => void) | null = null;

	onData(listener: (d: string) => void): void {
		this.data = listener;
	}

	onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
		this.exit = listener;
	}

	write(data: string): void {
		this.written.push(data);
	}

	resize(cols: number, rows: number): void {
		this.resized.push({ cols, rows });
	}

	kill(): void {
		this.killed = true;
	}

	emit(data: string): void {
		this.data?.(data);
	}

	die(exitCode = 0): void {
		this.exit?.({ exitCode });
	}
}

interface Harness {
	console: AgentConsole;
	ptys: FakePty[];
	plans: SpawnPlan[];
	killed: number[];
}

function harness(overrides: { mcp?: { url: string; token: string } | null; env?: NodeJS.ProcessEnv } = {}): Harness {
	const ptys: FakePty[] = [];
	const plans: SpawnPlan[] = [];
	const killed: number[] = [];
	const env = overrides.env ?? { PATH: '/usr/bin', DB_PASSWORD: 'hunter2' };
	const console_ = new AgentConsole({
		cwd: () => '/work',
		mcp: () => (overrides.mcp === undefined ? { url: 'http://127.0.0.1:7311/mcp', token: 'tok' } : overrides.mcp),
		platform: 'linux',
		env,
		exists: (p) => p === '/usr/bin/claude',
		probe: async () => '2.1.238 (Claude Code)',
		killTree: (pid) => killed.push(pid),
		clock: () => 1_000,
		pty: (plan) => {
			plans.push(plan);
			const pty = new FakePty();
			ptys.push(pty);
			return pty;
		},
	});
	return { console: console_, ptys, plans, killed };
}

describe('consoleEnvironment', () => {
	test('passes an allow-list and drops everything secret-shaped', () => {
		const env = consoleEnvironment(
			{
				PATH: '/usr/bin',
				HOME: '/home/alex',
				DB_PASSWORD: 'hunter2',
				AWS_SECRET_ACCESS_KEY: 'nope',
				SNOUTDATA_SENTRY_DSN: 'nope',
				OPENAI_API_KEY: 'nope',
				SOME_TOKEN: 'nope',
			},
			{ platform: 'linux', mcp: { url: 'http://127.0.0.1:7311/mcp', token: 'tok' } },
		);
		assert.equal(env.PATH, '/usr/bin');
		assert.equal(env.HOME, '/home/alex');
		// The one assertion this whole feature's security story leans on: nothing secret-shaped
		// survives except the two MCP values, which gate a localhost broker and are not credentials.
		const allowed = new Set([MCP_ENV_URL, MCP_ENV_TOKEN]);
		const leaked = Object.keys(env).filter((k) => /PASS|SECRET|TOKEN|KEY|DSN/i.test(k) && !allowed.has(k));
		assert.deepEqual(leaked, []);
	});

	test('forces a colour terminal and carries the MCP endpoint', () => {
		const env = consoleEnvironment({}, { platform: 'linux', mcp: { url: 'u', token: 't' } });
		assert.equal(env.TERM, 'xterm-256color');
		assert.equal(env.COLORTERM, 'truecolor');
		assert.equal(env[MCP_ENV_URL], 'u');
		assert.equal(env[MCP_ENV_TOKEN], 't');
	});

	test('omits the MCP pair entirely when agent access is off', () => {
		const env = consoleEnvironment({}, { platform: 'linux', mcp: null });
		assert.equal(env[MCP_ENV_URL], undefined);
		assert.equal(env[MCP_ENV_TOKEN], undefined);
	});

	test('keeps the Windows variables a process needs to start', () => {
		const env = consoleEnvironment(
			{ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\j\\AppData\\Roaming', SHELL: '/bin/sh' },
			{ platform: 'win32', mcp: null },
		);
		assert.equal(env.SystemRoot, 'C:\\Windows');
		assert.equal(env.APPDATA, 'C:\\Users\\j\\AppData\\Roaming');
		assert.equal(env.SHELL, undefined, 'posix-only names are not carried onto Windows');
	});
});

describe('agentImagePasteKey', () => {
	test('Claude Code gets its own key, and it is not the same one on Windows', () => {
		// Not a preference: alt+v on Windows and ctrl+v elsewhere is what Claude Code itself binds,
		// and sending the wrong one is silent (the agent simply does nothing, which is how this was
		// missed the first time). e2e/agent-console-live.spec.ts proves the Windows one end to end.
		assert.equal(agentImagePasteKey('claude', 'win32'), '\u001bv');
		assert.equal(agentImagePasteKey('claude', 'darwin'), '\u0016');
		assert.equal(agentImagePasteKey('claude', 'linux'), '\u0016');
	});

	test('an agent with no clipboard key of its own says so, rather than being sent one', () => {
		// The caller reads null as "this one takes an image as a file path". Guessing a key here
		// would type a stray character into somebody's prompt.
		assert.equal(agentImagePasteKey('codex', 'win32'), null);
		assert.equal(agentImagePasteKey('opencode', 'linux'), null);
	});
});

describe('resolveOnPath', () => {
	test('prefers an .exe over a .cmd shim in the same directory', () => {
		const found = resolveOnPath('claude', {
			platform: 'win32',
			env: { PATH: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
			exists: (p) => p === 'C:\\bin\\claude.exe' || p === 'C:\\bin\\claude.cmd',
		});
		assert.equal(found, 'C:\\bin\\claude.exe');
	});

	test('takes the first directory on PATH, not the best extension', () => {
		const found = resolveOnPath('claude', {
			platform: 'win32',
			env: { PATH: 'C:\\first;C:\\second', PATHEXT: '.EXE;.CMD' },
			exists: (p) => p === 'C:\\first\\claude.cmd' || p === 'C:\\second\\claude.exe',
		});
		assert.equal(found, 'C:\\first\\claude.cmd');
	});

	test('finds an extensionless binary on posix and reports absence', () => {
		assert.equal(resolveOnPath('claude', { platform: 'linux', env: { PATH: '/a:/b' }, exists: (p) => p === '/b/claude' }), '/b/claude');
		assert.equal(resolveOnPath('claude', { platform: 'linux', env: { PATH: '/a' }, exists: () => false }), null);
	});

	test('passes an absolute path through when it exists', () => {
		assert.equal(resolveOnPath('/opt/claude', { platform: 'linux', env: {}, exists: () => true }), '/opt/claude');
		assert.equal(resolveOnPath('/opt/claude', { platform: 'linux', env: {}, exists: () => false }), null);
	});
});

describe('planSpawn', () => {
	test('runs a real binary directly, with no shell anywhere', () => {
		assert.deepEqual(planSpawn('C:\\bin\\claude.exe', ['--x'], 'win32'), { file: 'C:\\bin\\claude.exe', args: ['--x'] });
		assert.deepEqual(planSpawn('/usr/bin/claude', ['--x'], 'linux'), { file: '/usr/bin/claude', args: ['--x'] });
	});

	test('wraps a Windows .cmd shim, which cannot be executed on its own', () => {
		assert.deepEqual(planSpawn('C:\\bin\\claude.cmd', ['--x'], 'win32', 'C:\\Windows\\system32\\cmd.exe'), {
			file: 'C:\\Windows\\system32\\cmd.exe',
			args: ['/d', '/c', 'C:\\bin\\claude.cmd', '--x'],
		});
	});

	test('a shim path cmd.exe would read as syntax is escaped, or refused when it cannot be', () => {
		// Unquoted (no space), so each metacharacter gets a caret and cmd reads it as a letter.
		assert.deepEqual(planSpawn('C:\\a&calc\\claude.cmd', [], 'win32')?.args, ['/d', '/c', 'C:\\a^&calc\\claude.cmd']);
		assert.equal(cmdArgument('x|y^z(1)<2>@'), 'x^|y^^z^(1^)^<2^>^@');
		// Holding a space, the spawner quotes it, and that is enough only with no metacharacter
		// inside: with one, cmd /c strips the quotes again.
		assert.equal(cmdArgument('C:\\Program Files\\npm\\claude.cmd'), 'C:\\Program Files\\npm\\claude.cmd');
		assert.equal(cmdArgument('C:\\a b&calc\\claude.cmd'), null);
		assert.equal(cmdArgument('C:\\Program Files (x86)\\npm\\claude.cmd'), null);
		// Expansion and quote-breaking cannot be escaped reliably: not run at all.
		for (const bad of ['C:\\%PATH%\\claude.cmd', 'C:\\a!b\\claude.cmd', 'C:\\a"b\\claude.cmd', 'C:\\a\nb\\claude.cmd']) {
			assert.equal(planSpawn(bad, [], 'win32'), null, bad);
		}
		assert.equal(planSpawn('C:\\bin\\claude.cmd', ['--config=%TEMP%'], 'win32'), null);
		// Not a shim: never through cmd, so nothing to escape.
		assert.deepEqual(planSpawn('/opt/a&b/claude', [], 'linux'), { file: '/opt/a&b/claude', args: [] });
	});
});

describe('Scrollback', () => {
	test('keeps what fits and drops the oldest chunks past the cap', () => {
		const buffer = new Scrollback(10);
		buffer.push('aaaaa');
		buffer.push('bbbbb');
		assert.equal(buffer.read(), 'aaaaabbbbb');
		buffer.push('ccccc');
		assert.equal(buffer.read(), 'bbbbbccccc');
		assert.ok(buffer.size <= 10);
	});

	test('never drops the only chunk, however large', () => {
		const buffer = new Scrollback(4);
		buffer.push('a much longer chunk than the cap');
		assert.equal(buffer.read(), 'a much longer chunk than the cap');
	});

	test('clears', () => {
		const buffer = new Scrollback(10);
		buffer.push('abc');
		buffer.clear();
		assert.equal(buffer.read(), '');
		assert.equal(buffer.size, 0);
	});
});

describe('AgentConsole', () => {
	test('discovers the binary and reports its version', async () => {
		const h = harness();
		const install = await h.console.discover('claude');
		assert.equal(install.installed, true);
		assert.equal(install.path, '/usr/bin/claude');
		assert.equal(install.version, '2.1.238 (Claude Code)');
		assert.equal(install.checkedAt, 1_000);
	});

	test('finds an agent that is only on the user PATH, and hands it to the agent too', async () => {
		// The macOS GUI-launch bug: launchd gives the app four directories and the agent lives in
		// none of them, so discovery said "not installed" on a machine that had it.
		const plans: SpawnPlan[] = [];
		let ptyEnv: Record<string, string> = {};
		let asked = 0;
		const console_ = new AgentConsole({
			cwd: () => '/work',
			mcp: () => null,
			platform: 'darwin',
			env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/alex' },
			exists: (p) => p === '/Users/alex/.local/bin/claude',
			probe: async () => '2.1.259 (Claude Code)',
			userPath: async () => {
				asked += 1;
				return '/usr/bin:/bin:/usr/sbin:/sbin:/Users/alex/.local/bin';
			},
			pty: (plan, options) => {
				plans.push(plan);
				ptyEnv = options.env;
				return new FakePty();
			},
		});
		const install = await console_.discover('claude');
		assert.equal(install.installed, true);
		assert.equal(install.path, '/Users/alex/.local/bin/claude');
		await console_.start('claude');
		assert.equal(plans[0].file, '/Users/alex/.local/bin/claude');
		// The agent's own tools (node, git, the user's package manager) hang off this PATH, so the
		// widened one has to reach the child as well as the lookup.
		assert.equal(ptyEnv.PATH, '/usr/bin:/bin:/usr/sbin:/sbin:/Users/alex/.local/bin');
		assert.equal(asked, 1, 'the shell is asked once, not once per lookup');
	});

	test('a pinned binary is the whole answer: PATH is not consulted', async () => {
		const looked: string[] = [];
		const console_ = new AgentConsole({
			cwd: () => '/work',
			mcp: () => null,
			platform: 'linux',
			env: { PATH: '/usr/bin' },
			exists: (p) => { looked.push(p); return p === '/opt/tools/claude'; },
			probe: async () => 'v9',
			pinnedPath: () => '/opt/tools/claude',
			pty: () => new FakePty(),
		});
		const install = await console_.discover('claude');
		assert.equal(install.path, '/opt/tools/claude');
		assert.equal(install.pinned, true);
		assert.deepEqual(looked, ['/opt/tools/claude'], 'PATH was never walked');
	});

	test('a pin that stops resolving reports missing rather than falling back to PATH', async () => {
		const console_ = new AgentConsole({
			cwd: () => '/work',
			mcp: () => null,
			platform: 'linux',
			// The agent IS on PATH, and we still must not silently run it: the user chose another.
			env: { PATH: '/usr/bin' },
			exists: (p) => p === '/usr/bin/claude',
			probe: async () => 'v9',
			pinnedPath: () => '/opt/tools/claude',
			pty: () => new FakePty(),
		});
		const install = await console_.discover('claude');
		assert.equal(install.installed, false);
		assert.equal(install.pinned, true, 'the panel can say WHICH thing is missing');
	});

	test('falls back to the inherited PATH when the user PATH cannot be resolved', async () => {
		const console_ = new AgentConsole({
			cwd: () => '/work',
			mcp: () => null,
			platform: 'linux',
			env: { PATH: '/usr/bin' },
			exists: (p) => p === '/usr/bin/claude',
			probe: async () => 'v1',
			userPath: async () => { throw new Error("no shell"); },
			pty: () => new FakePty(),
		});
		const install = await console_.discover('claude');
		assert.equal(install.path, '/usr/bin/claude');
	});

	test('start is idempotent: one console per agent kind, however many callers', async () => {
		const h = harness();
		await h.console.start('claude');
		await h.console.start('claude');
		assert.equal(h.ptys.length, 1, 'a second start attaches rather than spawning');
		assert.equal(h.console.status('claude').running, true);
		assert.equal(h.console.status('claude').pid, 4242);
	});

	test('does not spawn when the agent is not installed', async () => {
		const console_ = new AgentConsole({
			cwd: () => '/work',
			mcp: () => null,
			platform: 'linux',
			env: { PATH: '/usr/bin' },
			exists: () => false,
			probe: async () => null,
			pty: () => {
				throw new Error('must not spawn');
			},
		});
		const status = await console_.start('claude');
		assert.equal(status.running, false);
		assert.equal(status.install.installed, false);
	});

	test('buffers output and replays it on attach, so closing the panel loses nothing', async () => {
		const h = harness();
		await h.console.start('claude');
		h.ptys[0].emit('hello ');
		h.ptys[0].emit('world');
		const attached = h.console.attach('claude');
		assert.equal(attached.scrollback, 'hello world');
		assert.equal(attached.status.running, true);
	});

	test('fans output out to subscribers and stops on unsubscribe', async () => {
		const h = harness();
		const seen: string[] = [];
		const off = h.console.onData((_kind, data) => seen.push(data));
		await h.console.start('claude');
		h.ptys[0].emit('a');
		off();
		h.ptys[0].emit('b');
		assert.deepEqual(seen, ['a']);
	});

	test('an attach says up to which chunk its scrollback goes, and live chunks carry the count', async () => {
		const h = harness();
		const seen: number[] = [];
		h.console.onData((_kind, _data, seq) => seen.push(seq));
		await h.console.start('claude');
		h.ptys[0].emit('a');
		h.ptys[0].emit('b');
		const attached = h.console.attach('claude');
		h.ptys[0].emit('c');
		assert.deepEqual(seen, [1, 2, 3]);
		assert.equal(attached.scrollback, 'ab');
		assert.equal(attached.seq, 2);
	});

	test('records an exit and lets the kind start fresh afterwards', async () => {
		const h = harness();
		const exits: number[] = [];
		h.console.onExit((e) => exits.push(e.code ?? -1));
		await h.console.start('claude');
		h.ptys[0].die(3);
		assert.equal(h.console.status('claude').running, false);
		assert.equal(h.console.status('claude').lastExit?.code, 3);
		assert.deepEqual(exits, [3]);
		await h.console.start('claude');
		assert.equal(h.ptys.length, 2);
	});

	test('an agent that dies keeps what it said, which is the only thing it had to give', async () => {
		// The real case this comes from: a coding agent with a bad config file prints one paragraph
		// ("unknown variant `xhigh`...") and exits 1. That paragraph IS the diagnosis, and it used to
		// be deleted along with the session, leaving the user with "it exited" and nothing else.
		const h = harness();
		await h.console.start('claude');
		h.ptys[0].emit('Error loading configuration: unknown variant `xhigh`\r\n');
		h.ptys[0].die(1);
		const attached = h.console.attach('claude');
		assert.equal(attached.status.running, false);
		assert.equal(attached.status.lastExit?.code, 1);
		assert.match(attached.scrollback, /unknown variant/);
		assert.equal(attached.status.hasOutput, true);
	});

	test('starting again begins a fresh transcript', async () => {
		const h = harness();
		await h.console.start('claude');
		h.ptys[0].emit('old news');
		h.ptys[0].die(1);
		await h.console.start('claude');
		assert.equal(h.console.attach('claude').scrollback, '', 'the previous run is not replayed into the new one');
	});

	test('a console that has never run has nothing to show', async () => {
		const h = harness();
		assert.equal(h.console.status('claude').hasOutput, false);
	});

	test('stop kills the whole tree, not just the pty leader', async () => {
		const h = harness();
		await h.console.start('claude');
		h.console.stop('claude');
		assert.deepEqual(h.killed, [4242]);
		assert.equal(h.ptys[0].killed, true);
		assert.equal(h.console.status('claude').running, false);
	});

	test('stopAll leaves nothing running, so a console cannot outlive the app', async () => {
		const h = harness();
		await h.console.start('claude');
		h.console.stopAll();
		assert.equal(h.console.running('claude'), false);
		assert.deepEqual(h.killed, [4242]);
	});

	test('write and resize reach the pty; resize clamps to a usable size', async () => {
		const h = harness();
		await h.console.start('claude');
		h.console.write('claude', 'ls\r');
		h.console.resize('claude', { cols: 0, rows: -5 });
		assert.deepEqual(h.ptys[0].written, ['ls\r']);
		assert.deepEqual(h.ptys[0].resized, [{ cols: 1, rows: 1 }]);
	});

	test('write to a console that is not running is a no-op, not a throw', () => {
		const h = harness();
		h.console.write('claude', 'x');
		h.console.resize('claude', { cols: 80, rows: 24 });
		assert.equal(h.console.running('claude'), false);
	});

	test('status says whether the agent has tools from us', async () => {
		const wired = harness();
		await wired.console.start('claude');
		assert.equal(wired.console.status('claude').mcpWired, true);
		const bare = harness({ mcp: null });
		assert.equal(bare.console.status('claude').mcpWired, false);
	});

	test('passes the handoff arguments through to the spawn plan', async () => {
		const ptys: FakePty[] = [];
		const plans: SpawnPlan[] = [];
		const console_ = new AgentConsole({
			cwd: () => '/work',
			mcp: () => null,
			platform: 'linux',
			env: { PATH: '/usr/bin' },
			exists: (p) => p === '/usr/bin/claude',
			probe: async () => null,
			extraArgs: () => ['--mcp-config', '/data/agent-console/mcp.json'],
			pty: (plan) => {
				plans.push(plan);
				const pty = new FakePty();
				ptys.push(pty);
				return pty;
			},
		});
		await console_.start('claude');
		assert.deepEqual(plans[0], { file: '/usr/bin/claude', args: ['--mcp-config', '/data/agent-console/mcp.json'] });
	});
});

describe('ConsoleReplay', () => {
	test('a chunk printed while the scrollback was being fetched is written once, not twice', () => {
		const out: string[] = [];
		const replay = new ConsoleReplay((data) => out.push(data));
		// Live chunks 1 and 2 arrive before the attach answers; its scrollback already holds both.
		replay.live({ kind: 'claude', data: 'READY\r\n', seq: 1 });
		replay.live({ kind: 'claude', data: 'mcp=yes\r\n', seq: 2 });
		replay.attached('READY\r\nmcp=yes\r\n', 2);
		replay.live({ kind: 'claude', data: 'hello', seq: 3 });
		assert.equal(out.join(''), 'READY\r\nmcp=yes\r\nhello');
	});

	test('a held chunk the scrollback did not reach is written after it, in order', () => {
		const out: string[] = [];
		const replay = new ConsoleReplay((data) => out.push(data));
		replay.live({ kind: 'claude', data: 'one', seq: 4 });
		replay.live({ kind: 'claude', data: 'two', seq: 5 });
		replay.attached('zero,one', 4);
		assert.deepEqual(out, ['zero,one', 'two']);
	});

	test('no attach answer still lets the held output through', () => {
		const out: string[] = [];
		const replay = new ConsoleReplay((data) => out.push(data));
		replay.live({ kind: 'claude', data: 'x', seq: 9 });
		replay.attached('', 0);
		assert.deepEqual(out, ['x']);
	});
});

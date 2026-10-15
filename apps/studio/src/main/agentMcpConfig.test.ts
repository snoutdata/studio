/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configPaths, launchArgs, mcpConfigFile, rewriteAgentMcpConfig, settingsFile, writeAgentConfig } from './agentMcpConfig';
import { DB_CLIENT_COMMANDS } from '../shared/agentHouseRules';

const ENDPOINT = { url: 'http://127.0.0.1:7311/mcp', token: 'a-local-capability-token' };

function withDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'agentcfg-'));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('mcpConfigFile', () => {
	test('is the standard mcpServers block pointing at our local broker', () => {
		const parsed = JSON.parse(mcpConfigFile(ENDPOINT)) as { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> };
		const server = parsed.mcpServers.snoutdata;
		assert.equal(server.type, 'http');
		assert.equal(server.url, ENDPOINT.url);
		assert.equal(server.headers.Authorization, `Bearer ${ENDPOINT.token}`);
	});

	test('carries no credential beyond the broker token', () => {
		// The whole point of the broker: the agent is told WHERE to ask, never what a database
		// password is. If this ever fails, the handoff has started leaking.
		const text = mcpConfigFile(ENDPOINT).toLowerCase();
		for (const forbidden of ['password', 'passphrase', 'secretaccesskey', 'privatekey', 'connectionstring']) {
			assert.equal(text.includes(forbidden), false, `generated config mentions "${forbidden}"`);
		}
	});
});

describe('settingsFile', () => {
	test('denies reads and edits under the app data directory', () => {
		const parsed = JSON.parse(settingsFile('C:\\Users\\alex\\AppData\\Roaming\\snoutdata')) as { permissions: { deny: string[] } };
		const deny = parsed.permissions.deny;
		assert.ok(deny.some((rule) => rule.startsWith('Read(')));
		assert.ok(deny.some((rule) => rule.startsWith('Edit(')));
		// Only rules the agent actually enforces. A Write() rule is refused by Claude Code (Edit
		// covers every file-editing tool), and a PATH-scoped Bash rule never fires; emitting either
		// would read as protection while enforcing nothing. A COMMAND-scoped Bash rule does fire,
		// which is why the database clients below are allowed to be Bash rules.
		assert.ok(deny.every((rule) => !rule.startsWith('Write(')));
		assert.ok(deny.every((rule) => !rule.startsWith('Bash(') || /^Bash\([a-z0-9_-]+:\*\)$/.test(rule)));
		// Backslashes would read as escapes in a glob, so the path is normalised.
		assert.ok(deny.every((rule) => !rule.includes('\\')), 'deny rules must use forward slashes');
		assert.ok(deny[0].includes('AppData/Roaming/snoutdata'));
	});

	test('tolerates a trailing separator without producing a doubled slash', () => {
		const parsed = JSON.parse(settingsFile('/home/alex/.config/snoutdata/')) as { permissions: { deny: string[] } };
		assert.ok(parsed.permissions.deny.every((rule) => !rule.includes('//')));
	});

	test('denies the local database clients by default, so "always go through the app" is a fact', () => {
		const parsed = JSON.parse(settingsFile('/data')) as { permissions: { deny: string[] } };
		for (const command of ['psql', 'mysql', 'mongosh', 'sqlite3', 'sqlcmd']) {
			assert.ok(parsed.permissions.deny.includes(`Bash(${command}:*)`), `${command} is not denied`);
		}
		assert.equal(parsed.permissions.deny.length, 2 + DB_CLIENT_COMMANDS.length);
	});

	test('leaves them alone when the user runs their agent as it comes', () => {
		const parsed = JSON.parse(settingsFile('/data', { routeDatabaseThroughApp: false })) as { permissions: { deny: string[] } };
		assert.deepEqual(parsed.permissions.deny.filter((rule) => rule.startsWith('Bash(')), []);
	});
});

describe('writeAgentConfig', () => {
	test('writes both files into userData and returns the launch flags', () => {
		withDir((dir) => {
			const args = writeAgentConfig('claude', dir, ENDPOINT, { routeDatabaseThroughApp: false });
			const paths = configPaths(dir);
			assert.deepEqual(args, ['--mcp-config', paths.mcp, '--settings', paths.settings]);
			assert.ok(readFileSync(paths.mcp, 'utf8').includes(ENDPOINT.token));
			assert.ok(readFileSync(paths.settings, 'utf8').includes('permissions'));
		});
	});

	test('the integrated launch (the default) leaves the agent only our MCP server', () => {
		withDir((dir) => {
			const args = writeAgentConfig('claude', dir, ENDPOINT);
			const paths = configPaths(dir);
			assert.deepEqual(args, ['--mcp-config', paths.mcp, '--settings', paths.settings, '--strict-mcp-config']);
			// The house rules are NOT on the command line, deliberately: they go over the MCP wire as
			// the server's `instructions` (mcpServer.ts), because a multi-line argument does not
			// survive the cmd.exe re-parse a Windows .cmd shim puts it through. If this ever grows an
			// `--append-system-prompt`, the e2e fake agent will report it arriving corrupted.
			assert.equal(args.includes('--append-system-prompt'), false);
			assert.equal(args.some((arg) => arg.includes('\n')), false, 'no argument may contain a newline');
		});
	});

	test('the file holding the broker token is readable by its owner only, even over an older world-readable one', { skip: process.platform === 'win32' }, () => {
		withDir((dir) => {
			const paths = configPaths(dir);
			mkdirSync(paths.dir, { recursive: true });
			writeFileSync(paths.mcp, '{}');
			chmodSync(paths.mcp, 0o644);
			writeAgentConfig('claude', dir, ENDPOINT);
			assert.equal(statSync(paths.mcp).mode & 0o777, 0o600);
			assert.equal(statSync(paths.settings).mode & 0o777, 0o600);
		});
	});

	test('writes nothing and passes no flags when agent access is off', () => {
		withDir((dir) => {
			assert.deepEqual(writeAgentConfig('claude', dir, null), []);
			assert.throws(() => readFileSync(configPaths(dir).mcp, 'utf8'));
		});
	});

	test('rewrites on every call, so a regenerated token is picked up', () => {
		withDir((dir) => {
			writeAgentConfig('claude', dir, ENDPOINT);
			writeAgentConfig('claude', dir, { ...ENDPOINT, token: 'rotated' });
			assert.ok(readFileSync(configPaths(dir).mcp, 'utf8').includes('rotated'));
		});
	});

	test('codex is handed our server as config overrides, and only ours', () => {
		withDir((dir) => {
			const args = writeAgentConfig('codex', dir, ENDPOINT);
			// Codex's own spelling of the same handoff, verified against codex-cli 0.130.0: `codex mcp
			// add --url` writes exactly this pair of keys. Replacing the whole map is its version of
			// --strict-mcp-config; the user's plugins are a different config section and survive.
			assert.equal(args[0], '-c');
			assert.match(args[1], /^mcp_servers=\{snoutdata=\{/);
			assert.ok(args[1].includes(`url="${ENDPOINT.url}"`));
			assert.equal(args.length, 2);
			// The TOKEN is read from the environment the console already sets, so no secret is ever on
			// a command line, where every `ps` on the machine would see it.
			assert.ok(args[1].includes('bearer_token_env_var="SNOUTDATA_MCP_TOKEN"'));
			assert.equal(args[1].includes(ENDPOINT.token), false, 'the token must not ride on argv');
			assert.equal(args.some((arg) => arg.includes('\n')), false);
		});
	});

	test('codex keeps its own MCP servers when the switch is off', () => {
		withDir((dir) => {
			const args = writeAgentConfig('codex', dir, ENDPOINT, { routeDatabaseThroughApp: false });
			// The dotted form ADDS ours; the inline-table form replaces the map. Off means the user
			// wanted their setup, so ours goes alongside rather than instead.
			assert.deepEqual(args.slice(0, 1), ['-c']);
			assert.match(args[1], /^mcp_servers\.snoutdata=\{/);
		});
	});

	test('opencode is still manual, so it gets no flags from us', () => {
		const paths = configPaths('/data');
		assert.deepEqual(launchArgs('opencode', paths, {}, ENDPOINT), []);
	});
});

describe('rewriteAgentMcpConfig', () => {
	test('a rotated token reaches the config the agents were handed', () => {
		withDir((dir) => {
			writeAgentConfig('claude', dir, ENDPOINT);
			const rotated = { ...ENDPOINT, token: 'rotated-token' };
			assert.equal(rewriteAgentMcpConfig(dir, rotated), true);
			const written = readFileSync(configPaths(dir).mcp, 'utf8');
			assert.equal(written, mcpConfigFile(rotated));
			assert.equal(written.includes(ENDPOINT.token), false, 'the old token is gone from the file');
		});
	});

	test('writes nothing that was never handed out, and nothing while agent access is off', () => {
		withDir((dir) => {
			assert.equal(rewriteAgentMcpConfig(dir, ENDPOINT), false);
			assert.throws(() => statSync(configPaths(dir).mcp));
			writeAgentConfig('claude', dir, ENDPOINT);
			assert.equal(rewriteAgentMcpConfig(dir, null), false);
			assert.equal(readFileSync(configPaths(dir).mcp, 'utf8'), mcpConfigFile(ENDPOINT));
		});
	});
});

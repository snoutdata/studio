/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { MCP_SERVER_NAME, mcpServerConfig } from '../shared/mcp';
import { dbClientDenyRules } from '../shared/agentHouseRules';
import { MCP_ENV_TOKEN } from './agentConsole';
import type { AgentKind } from '../shared/agentConsole';
import { writePrivateFile } from './privateFile';

/*
 * The zero-setup handoff: the console hands the agent a config file naming the app's own local MCP
 * endpoint, so the user never pastes anything.
 *
 * Where the config goes was settled 2026-08-20 by checking the installed CLI: `claude --mcp-config <file>` exists,
 * so the config lives in userData and is passed as a FLAG. That beats writing `.mcp.json` into the
 * user's workspace, which would put a bearer token in a folder that is often a git repo and would
 * trip Claude Code's "approve this project's MCP servers" prompt on first run.
 *
 * `--strict-mcp-config` is deliberately NOT used: it would suppress the user's own MCP servers,
 * and the console is meant to add to their setup, not replace it.
 *
 * Two hard rules, both asserted by agentMcpConfig.test.ts:
 *   1. Nothing written here may contain a database credential. The bearer token is a localhost
 *      capability gate for our own broker, and is the only secret-shaped value present.
 *   2. The deny rules must name the userData directory, so the agent's own permission system
 *      refuses to read the app's stores (secrets.json, connections.json, ...). That is defense in
 *      depth, not the guarantee: see the doc's "The blackbox, honestly".
 */

export interface McpEndpoint {
	url: string;
	token: string;
}

/** How integrated this launch is. Absent fields mean the integrated default: the switch in
 *  Settings, Agent access is what turns it off (AgentConsoleConfig.routeDatabaseThroughApp). */
export interface AgentConfigOptions {
	/** False ⇒ launch the agent as it comes: no house rules, no strict MCP, no client deny rules. */
	routeDatabaseThroughApp?: boolean;
}

/** The `--mcp-config` payload: the standard `mcpServers` block, one entry, ours. */
export function mcpConfigFile(endpoint: McpEndpoint): string {
	return `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: mcpServerConfig(endpoint) } }, null, 2)}\n`;
}

/**
 * The `--settings` payload: permission deny rules keeping the agent out of the app's own data
 * directory. Paths are normalised to forward slashes because the rule matcher is glob-shaped and
 * a Windows backslash reads as an escape.
 */
export function settingsFile(userDataDir: string, opts: AgentConfigOptions = {}): string {
	const dir = userDataDir.replace(/\\/g, '/').replace(/\/+$/, '');
	// Read + Edit only, and that is deliberate. Verified against Claude Code 2.1.238 on 2026-08-20
	// by reading what it printed into our own console: a `Write(path)` rule is REFUSED with "only
	// Edit(path) rules are [matched by file permission checks] ... Edit rules cover all file-editing
	// tools". A path-scoped Bash rule is left out for the same reason in reverse: Bash rules match
	// command patterns, not paths, so `Bash(cat:<dir>/**)` would look like protection while
	// enforcing nothing. A rule that does not fire is worse than no rule, because it reads as cover.
	// The database clients go the same way when the routing switch is on: an agent told "always go
	// through the app" and then handed a working `psql` will use `psql` the first time our tool is
	// one call slower. The instruction states the rule; this is what makes it true.
	const deny = [
		`Read(${dir}/**)`,
		`Edit(${dir}/**)`,
		...(opts.routeDatabaseThroughApp === false ? [] : dbClientDenyRules()),
	];
	const settings = { permissions: { deny } };
	return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Where the generated files live: inside userData, never inside the user's workspace. */
export function configPaths(userDataDir: string): { dir: string; mcp: string; settings: string } {
	const dir = join(userDataDir, 'agent-console');
	return { dir, mcp: join(dir, 'mcp.json'), settings: join(dir, 'settings.json') };
}

/**
 * Write both files and return the launch arguments that point the agent at them. Called on every
 * start, so a regenerated token or a moved port is picked up without the user doing anything.
 *
 * Returns [] when agent access is off: the console still runs, the agent simply has no tools from
 * us, and the panel says so rather than pretending it is wired.
 */
export function writeAgentConfig(kind: AgentKind, userDataDir: string, endpoint: McpEndpoint | null, opts: AgentConfigOptions = {}): string[] {
	if (!endpoint) {
		return [];
	}
	const paths = configPaths(userDataDir);
	// Both owner-only: the first carries the broker token, and the agent runs as this same user.
	writePrivateFile(paths.mcp, mcpConfigFile(endpoint));
	writePrivateFile(paths.settings, settingsFile(userDataDir, opts));
	return launchArgs(kind, paths, opts, endpoint);
}

/**
 * After the token is rotated: rewrite the config file already handed to the coding agents, so the
 * next agent that reads it (a restart, a reconnect) has the new token. Only a file that exists is
 * rewritten; with agent access off (`endpoint` null) it is left alone, since the next start writes
 * it anyway. Returns whether a file was written.
 */
export function rewriteAgentMcpConfig(userDataDir: string, endpoint: McpEndpoint | null): boolean {
	const paths = configPaths(userDataDir);
	if (!endpoint || !existsSync(paths.mcp)) {
		return false;
	}
	writePrivateFile(paths.mcp, mcpConfigFile(endpoint));
	return true;
}

/**
 * The per-agent spelling of "here is our server". Two shapes, both per-session and neither of them
 * touching the user's own config:
 *
 *  - Claude Code takes a generated config FILE (`--mcp-config`), plus `--strict-mcp-config` to leave
 *    its other servers out of this session.
 *  - Codex takes `-c key=value` config overrides (verified against codex-cli 0.130.0: `codex mcp add
 *    --url` writes exactly `[mcp_servers.<name>] url / bearer_token_env_var`, and both the dotted and
 *    the inline-table override forms parse). The token is read from `SNOUTDATA_MCP_TOKEN`, which the
 *    console's environment allow-list already sets, so no secret rides the command line. Replacing
 *    the whole `mcp_servers` map is Codex's version of `--strict-mcp-config`; the dotted form adds
 *    ours alongside theirs, which is what the switch being off means.
 *
 * opencode is still `manual`: nobody has checked its CLI for a per-session equivalent. When somebody
 * does, it is a branch here and a descriptor flip, not a new mechanism.
 */
export function launchArgs(kind: AgentKind, paths: { mcp: string; settings: string }, opts: AgentConfigOptions = {}, endpoint?: McpEndpoint): string[] {
	const integrated = opts.routeDatabaseThroughApp !== false;
	if (kind === 'claude') {
		const args = ['--mcp-config', paths.mcp, '--settings', paths.settings];
		if (!integrated) {
			return args;
		}
		// `--strict-mcp-config` is what makes "ignore the other MCP servers" true rather than asked
		// for: without it the agent still sees whatever database server sits in its global config,
		// and a tool it can see is a tool it will eventually prefer. This reverses an earlier
		// decision, and deliberately: that one was about not REPLACING the user's setup, and the switch in
		// Settings is how a user gets that back. Verified against Claude Code 2.1.241.
		//
		// The RULES themselves are not here, and that is a fix rather than an omission. They were
		// passed as `--append-system-prompt <text>` first, and the e2e fake agent reported them
		// arriving corrupted: on Windows an npm-installed agent is a `.cmd` shim, so the arguments
		// are re-parsed by cmd.exe, and a multi-line argument does not survive that. They travel on
		// the MCP wire instead, as the server's `instructions` (mcpServer.ts), which is the
		// transport's own place for "how to work with this server" and reaches every client.
		args.push('--strict-mcp-config');
		return args;
	}
	if (kind === 'codex' && endpoint) {
		const server = `{url="${endpoint.url}",bearer_token_env_var="${MCP_ENV_TOKEN}"}`;
		return integrated
			? ['-c', `mcp_servers={${MCP_SERVER_NAME}=${server}}`]
			: ['-c', `mcp_servers.${MCP_SERVER_NAME}=${server}`];
	}
	return [];
}

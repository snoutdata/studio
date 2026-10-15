/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import { AUTH_PROFILE, closeApp, launchApp, signedInProfileExists, waitForSignIn, type AppHandle } from './helpers';

/*
 * The REAL coding agents reaching SnoutData Cloud through the app.
 *
 * The app hands each agent its MCP server at launch, and the agent reaches the cloud tools through
 * it. This runs the installed `claude` and `codex` CLIs with exactly that handoff (the config the
 * console generates) and asks each to list the projects, so what is proved is the whole path: the
 * agent's own MCP client, our broker, the capability, the control plane.
 *
 * Opt-in (SNOUTDATA_E2E_LIVE_AGENTS=1): it spends the user's own Claude and Codex usage, and needs
 * the signed-in e2e profile. An agent that is not installed is skipped, not failed. Read-only: the
 * tool asked for is list_cloud_projects, which needs no approval.
 */

const skip = !process.env.SNOUTDATA_E2E_LIVE_AGENTS
	? 'set SNOUTDATA_E2E_LIVE_AGENTS=1 (it runs the installed Claude Code and Codex, on your usage)'
	: !signedInProfileExists() ? `no signed-in profile at ${AUTH_PROFILE}` : null;

const PROMPT = 'Use the snoutdata MCP server\'s list_cloud_projects tool and print the name of every project it returns, one per line. Do nothing else.';

function installed(cmd: string): boolean {
	return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).status === 0;
}

async function projectNames(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const api = (window as unknown as { sqlApi: { cloudProjects(): Promise<{ projects: { name: string }[] }> } }).sqlApi;
		return (await api.cloudProjects()).projects.map((p) => p.name);
	});
}

test.describe('coding agents reach the cloud projects through the app', () => {
	let handle: AppHandle;
	let endpoint: { url: string; token: string };
	let names: string[];
	test.setTimeout(300_000);
	test.skip(skip !== null, skip ?? '');

	test.beforeAll(async () => {
		handle = await launchApp('agents-cloud-live', { profile: AUTH_PROFILE });
		expect(await waitForSignIn(handle.page)).toBeTruthy();
		await expect.poll(async () => handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { mcp: { status(): Promise<{ running: boolean }> } } }).sqlApi;
			return (await api.mcp.status()).running;
		}), { timeout: 20_000 }).toBe(true);
		endpoint = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { mcp: { status(): Promise<{ url: string; token: string }> } } }).sqlApi;
			const s = await api.mcp.status();
			return { url: s.url, token: s.token };
		});
		names = await projectNames(handle.page);
		expect(names.length, 'the test account needs at least one project').toBeGreaterThan(0);
	});
	test.afterAll(async () => {
		await closeApp(handle);
	});

	test('Claude Code lists the projects with the app\'s tool', async () => {
		test.skip(!installed('claude'), 'claude is not installed');
		const dir = mkdtempSync(join(tmpdir(), 'snout-agent-'));
		const config = join(dir, 'mcp.json');
		// What the console generates (agentMcpConfig.mcpConfigFile), with --strict-mcp-config as it launches.
		writeFileSync(config, JSON.stringify({ mcpServers: { snoutdata: { type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` } } } }));
		// The prompt on stdin, not argv: on Windows an argument with spaces is one more thing to quote.
		const run = spawnSync('claude', ['-p', '--mcp-config', config, '--strict-mcp-config', '--allowedTools', 'mcp__snoutdata__list_cloud_projects'], {
			encoding: 'utf8', timeout: 240_000, cwd: dir, input: PROMPT,
		});
		console.log(`CLAUDE (${run.status}):\n${run.stdout}\n${run.stderr}`);
		for (const name of names) {
			expect(run.stdout).toContain(name);
		}
	});

	test('Codex lists the projects with the app\'s tool', async () => {
		test.skip(!installed('codex'), 'codex is not installed');
		const dir = mkdtempSync(join(tmpdir(), 'snout-agent-'));
		// What the console passes (agentMcpConfig.launchArgs for codex), token in the environment.
		const server = `mcp_servers={snoutdata={url="${endpoint.url}",bearer_token_env_var="SNOUTDATA_MCP_TOKEN"}}`;
		const run = spawnSync('codex', ['exec', '--skip-git-repo-check', '-c', server, PROMPT], {
			encoding: 'utf8', timeout: 240_000, cwd: dir, env: { ...process.env, SNOUTDATA_MCP_TOKEN: endpoint.token },
		});
		console.log(`CODEX (${run.status}):\n${run.stdout}\n${run.stderr.slice(-2000)}`);
		for (const name of names) {
			expect(run.stdout).toContain(name);
		}
	});
});

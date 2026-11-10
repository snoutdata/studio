/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentAiCall, agentAiLaunch, opencodeSnippet } from './agentAiRoute';

const RELAY = { root: 'http://127.0.0.1:4100/', token: 'local-token' };

test('Claude Code is pointed at the relay, with every tier on the chosen model', () => {
	const launch = agentAiLaunch('claude', RELAY, 'team-model');
	assert.equal(launch.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4100/agent/claude');
	assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, 'local-token');
	for (const tier of ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
		assert.equal(launch.env[tier], 'team-model');
	}
	assert.deepEqual(launch.args, []);
	assert.equal('ANTHROPIC_API_KEY' in launch.env, false);
});

test('Codex gets a provider of its own, no token on the command line', () => {
	const launch = agentAiLaunch('codex', RELAY, 'qwen:7b');
	assert.equal(launch.env.SNOUTDATA_AI_TOKEN, 'local-token');
	assert.ok(launch.args.includes('model_provider="snoutdata"'));
	assert.ok(launch.args.includes('model="qwen:7b"'));
	assert.match(launch.args[1], /base_url="http:\/\/127\.0\.0\.1:4100\/agent\/codex\/v1"/);
	assert.match(launch.args[1], /wire_api="responses"/);
	assert.equal(launch.args.join(' ').includes('local-token'), false);
	assert.equal(launch.args.some((a) => a.includes('\n')), false);
});

test('opencode reads the two variables through its own config', () => {
	const launch = agentAiLaunch('opencode', RELAY, 'm');
	assert.equal(launch.env.SNOUTDATA_AI_BASE_URL, 'http://127.0.0.1:4100/agent/opencode/v1');
	const config = JSON.parse(opencodeSnippet('m')) as { model: string; providers: { snoutdata: { settings: { baseURL: string }; env: string[] } } };
	assert.equal(config.model, 'snoutdata/m');
	assert.equal(config.providers.snoutdata.settings.baseURL, '{env:SNOUTDATA_AI_BASE_URL}');
	assert.deepEqual(config.providers.snoutdata.env, ['SNOUTDATA_AI_TOKEN']);
});

test('the relay names model calls and nothing else', () => {
	assert.deepEqual(agentAiCall('/agent/claude/v1/messages?beta=true'), { kind: 'claude', path: 'v1/messages?beta=true' });
	assert.deepEqual(agentAiCall('/agent/codex/v1/responses'), { kind: 'codex', path: 'v1/responses' });
	for (const url of ['/agent/claude/v1/admin/keys', '/agent/nobody/v1/messages', '/v1/messages', '/agent/claude/v1/../admin/keys']) {
		assert.equal(agentAiCall(url), null, url);
	}
});

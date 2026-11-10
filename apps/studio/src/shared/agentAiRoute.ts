/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentKind } from './agentConsole';

// Pointing a coding agent in the console at a project's AI gateway, when the user chooses to. Each
// agent has its own spelling, all of them per session and none touching the user's own config.
//
// What the agent is handed is the address of main's relay on 127.0.0.1 and a token good only there
// (`main/agentAiRelay.ts`), the same kind of thing as the MCP token. The project's key stays in main,
// so the console's rule holds: the agent never receives a credential.

/** The relay's token, for the agents that read their key from a named variable. */
export const AGENT_AI_ENV_TOKEN = 'SNOUTDATA_AI_TOKEN';
/** The relay's address, for the agent whose config takes it by `{env:…}`. */
export const AGENT_AI_ENV_BASE = 'SNOUTDATA_AI_BASE_URL';

export interface AgentAiLaunch {
	env: Record<string, string>;
	args: string[];
}

/**
 * The environment and flags for one agent. `root` is the relay's origin; the part after it names
 * the agent, and each client adds its own `/v1/...`.
 *
 *  - Claude Code calls `{ANTHROPIC_BASE_URL}/v1/messages`, and every model tier it may ask for is
 *    the chosen model, because a project's models carry the project's names. `ANTHROPIC_AUTH_TOKEN`
 *    is sent as `Authorization: Bearer`, where `ANTHROPIC_API_KEY` would be sent as `x-api-key`.
 *  - Codex takes `-c` overrides for a provider of its own (checked against codex-cli 0.167.0:
 *    `wire_api = "responses"` is the only one it still accepts).
 *  - opencode has no per-session override in its docs, so the console only sets the variables the
 *    snippet in Settings reads ({@link opencodeSnippet}).
 */
export function agentAiLaunch(kind: AgentKind, relay: { root: string; token: string }, model: string): AgentAiLaunch {
	const base = `${relay.root.replace(/\/+$/, '')}/agent/${kind}`;
	if (kind === 'claude') {
		return {
			env: {
				ANTHROPIC_BASE_URL: base,
				ANTHROPIC_AUTH_TOKEN: relay.token,
				ANTHROPIC_MODEL: model,
				ANTHROPIC_SMALL_FAST_MODEL: model,
				ANTHROPIC_DEFAULT_OPUS_MODEL: model,
				ANTHROPIC_DEFAULT_SONNET_MODEL: model,
				ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
			},
			args: [],
		};
	}
	if (kind === 'codex') {
		const provider = `{name="SnoutData project",base_url=${JSON.stringify(`${base}/v1`)},env_key="${AGENT_AI_ENV_TOKEN}",wire_api="responses"}`;
		return {
			env: { [AGENT_AI_ENV_TOKEN]: relay.token },
			args: ['-c', `model_providers.snoutdata=${provider}`, '-c', 'model_provider="snoutdata"', '-c', `model=${JSON.stringify(model)}`],
		};
	}
	return { env: { [AGENT_AI_ENV_TOKEN]: relay.token, [AGENT_AI_ENV_BASE]: `${base}/v1` }, args: [] };
}

/** The lines the user adds to opencode's own config, once per model. */
export function opencodeSnippet(model: string): string {
	return `${JSON.stringify({
		$schema: 'https://opencode.ai/config.json',
		model: `snoutdata/${model}`,
		providers: {
			snoutdata: {
				name: 'SnoutData project',
				env: [AGENT_AI_ENV_TOKEN],
				package: '@opencode/ai/providers/openai-compatible',
				settings: { baseURL: `{env:${AGENT_AI_ENV_BASE}}` },
				models: { [model]: { name: model } },
			},
		},
	}, null, 2)}\n`;
}

/** What the relay forwards: an agent, and a model call. Anything else is refused. */
export function agentAiCall(url: string): { kind: AgentKind; path: string } | null {
	const match = /^\/agent\/(claude|codex|opencode)\/(v1\/(?:messages(?:\/count_tokens)?|chat\/completions|responses|models))(\?[A-Za-z0-9_\-.%=&:]*)?$/.exec(url);
	return match ? { kind: match[1] as AgentKind, path: `${match[2]}${match[3] ?? ''}` } : null;
}

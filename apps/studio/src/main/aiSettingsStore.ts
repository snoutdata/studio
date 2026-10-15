/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { COMPLETION_MODEL_RENAMES, DEFAULT_AI_SETTINGS, isByokProvider, isCompletionOnlyModel, type AiModelChoice, type AiProviderId, type AiSettings, type AiSettingsFormValues, type ByokProviderId, type CloudProviderId } from '../shared/ai';
import type { SecretStore } from './secretStore';
import { DATA_ACCESS_LEVELS, type DataAccessLevel } from '../shared/engine';

// Non-secret AI settings live in userData/ai.json; the secret (the gateway API key) is
// encrypted in the keychain via SecretStore, reusing its (id, kind) scheme under a
// reserved pseudo-connection id.
const CLOUD_SECRET_ID: Record<CloudProviderId, string> = {
	'positron-cloud': '__ai_positroncloud__',
};

// The second, persistent "top-up" gateway key behind pay-as-you-go credits.
// Stored alongside the subscription key but never resets; absent until the user buys credits.
const CLOUD_TOPUP_SECRET_ID = '__ai_positroncloud_topup__';

// Bring-Your-Own-Key provider keys: the user's own OpenAI/OpenRouter/Anthropic key, in its own
// keychain slot. Same safeStorage scheme as the gateway key; never leaves the machine for our
// servers (the BYOK path talks to the provider directly).
const BYOK_SECRET_ID: Record<ByokProviderId, string> = {
	'byok-openai': '__byok_openai__',
	'byok-openrouter': '__byok_openrouter__',
	'byok-anthropic': '__byok_anthropic__',
};

export class AiSettingsStore {
	constructor(private readonly secrets: SecretStore) {}

	// The signed-in account's user id, set alongside the minted gateway key (cleared on sign-out).
	// Sent as the OpenAI `user` field so the gateway attributes requests to an account: an opaque
	// id the control plane already holds, never the email, which would put a person's address on
	// every request. In-memory only — re-set each launch when the key is confirmed; not a secret.
	private gatewayUser: string | null = null;

	private filePath(): string {
		return join(app.getPath('userData'), 'ai.json');
	}

	get(): AiSettings {
		const path = this.filePath();
		if (!existsSync(path)) {
			return DEFAULT_AI_SETTINGS;
		}
		try {
			const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AiSettings>;
			// A file saved by an older build may name a since-removed provider (bedrock,
			// openai, …); fall back to the default so we never select an unhandled provider.
			const known = (p: AiProviderId | undefined): p is AiProviderId => p === 'ollama' || p === 'positron-cloud' || (p !== undefined && isByokProvider(p));
			// A base/FIM model is completion-only; if an older file selected it as the *chat*
			// model it would chat as a raw text-completer (gibberish), so repoint chat to the
			// current default. Completion still uses it via the `completion` override.
			const cloud = { ...DEFAULT_AI_SETTINGS['positron-cloud'], ...raw['positron-cloud'] };
			if (isCompletionOnlyModel(cloud.model)) {
				cloud.model = DEFAULT_AI_SETTINGS['positron-cloud'].model;
			}
			// The completion model's id has changed over time (COMPLETION_MODEL_RENAMES: today it is
			// snout-fim-1.0, served from Qwen2.5-Coder with fill-in-the-middle); an older file may
			// still name a prior one, so migrate the stored completion override on read.
			let completion: AiModelChoice | undefined = known(raw.completion?.provider) ? raw.completion : undefined;
			if (completion && COMPLETION_MODEL_RENAMES[completion.model]) {
				completion = { ...completion, model: COMPLETION_MODEL_RENAMES[completion.model] };
			}
			// Merge over defaults so a partial/old file never yields missing fields.
			return {
				provider: known(raw.provider) ? raw.provider : DEFAULT_AI_SETTINGS.provider,
				ollama: { ...DEFAULT_AI_SETTINGS.ollama, ...raw.ollama },
				'positron-cloud': cloud,
				byok: {
					'byok-openai': { ...DEFAULT_AI_SETTINGS.byok['byok-openai'], ...raw.byok?.['byok-openai'] },
					'byok-openrouter': { ...DEFAULT_AI_SETTINGS.byok['byok-openrouter'], ...raw.byok?.['byok-openrouter'] },
					'byok-anthropic': { ...DEFAULT_AI_SETTINGS.byok['byok-anthropic'], ...raw.byok?.['byok-anthropic'] },
				},
				behavior: { ...DEFAULT_AI_SETTINGS.behavior, ...raw.behavior },
				tools: { ...DEFAULT_AI_SETTINGS.tools, ...raw.tools },
				completion,
				disabledModels: raw.disabledModels,
				dataAccess: raw.dataAccess && DATA_ACCESS_LEVELS.includes(raw.dataAccess) ? raw.dataAccess : undefined,
			};
		} catch {
			return DEFAULT_AI_SETTINGS;
		}
	}

	save(values: AiSettingsFormValues): AiSettings {
		const { apiKeys, ...settings } = values;
		const path = this.filePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8');
		for (const provider of Object.keys(CLOUD_SECRET_ID) as CloudProviderId[]) {
			const key = apiKeys?.[provider]?.trim();
			if (key) {
				this.secrets.store(CLOUD_SECRET_ID[provider], 'password', key);
			}
		}
		for (const provider of Object.keys(BYOK_SECRET_ID) as ByokProviderId[]) {
			const key = apiKeys?.[provider]?.trim();
			if (key) {
				this.secrets.store(BYOK_SECRET_ID[provider], 'password', key);
			}
		}
		return settings;
	}

	/** Switch the active provider and its model in one step (the chat-panel combo). */
	setActive(provider: AiProviderId, model: string): AiSettings {
		const current = this.get();
		let updated: AiSettings;
		switch (provider) {
			case 'ollama': updated = { ...current, provider, ollama: { ...current.ollama, model } }; break;
			case 'positron-cloud': updated = { ...current, provider, 'positron-cloud': { ...current['positron-cloud'], model } }; break;
			case 'byok-openai':
			case 'byok-openrouter':
			case 'byok-anthropic':
				updated = { ...current, provider, byok: { ...current.byok, [provider]: { ...current.byok[provider], model } } };
				break;
		}
		return this.save(updated);
	}

	/** Clear the legacy freeform "AI instructions" after it has been migrated into a global
	 *  knowledge note. No-op when already empty. */
	clearInstructions(): void {
		const current = this.get();
		if (!current.behavior.instructions) {
			return;
		}
		this.save({ ...current, behavior: { ...current.behavior, instructions: '' } });
	}

	/** Flip the agent loop on/off — the composer's Agent⇄Ask toggle, which is the same
	 *  switch as Settings → AI → Agent ("Agent mode"). Touches only that flag. */
	/** Set what the AI may see of a database (the assistant's banner and Settings → AI). Touches
	 *  only that field. */
	setDataAccess(level: DataAccessLevel): AiSettings {
		const current = this.get();
		return this.save({ ...current, dataAccess: level });
	}

	/** Add or remove a connection from the run_query auto-approve allowlist (the card's
	 *  "Always allow", and the Settings revert). Touches only that list. */
	setConnectionAutoApprove(connectionId: string, allowed: boolean): AiSettings {
		const current = this.get();
		const list = new Set(current.tools.autoApproveConnections);
		if (allowed) {
			list.add(connectionId);
		} else {
			list.delete(connectionId);
		}
		return this.save({ ...current, tools: { ...current.tools, autoApproveConnections: [...list] } });
	}

	/** Show or hide one "provider:model" in the chat picker. Default-on, so we persist
	 *  only the hidden ones; touches nothing else in the settings file. */
	setModelEnabled(key: string, enabled: boolean): AiSettings {
		const current = this.get();
		const disabled = new Set(current.disabledModels ?? []);
		if (enabled) {
			disabled.delete(key);
		} else {
			disabled.add(key);
		}
		return this.save({ ...current, disabledModels: [...disabled] });
	}

	/** The stored API key for a cloud provider (undefined when none is set). */
	apiKey(provider: CloudProviderId): string | undefined {
		return this.secrets.get(CLOUD_SECRET_ID[provider], 'password');
	}

	/** The user's own stored key for a BYOK provider (undefined when none is set). Used only on
	 *  the BYOK path, where the request goes straight to the provider. */
	byokKey(provider: ByokProviderId): string | undefined {
		return this.secrets.get(BYOK_SECRET_ID[provider], 'password');
	}

	/** Store (or clear, when null) the gateway virtual key minted for the signed-in user.
	 *  Reuses the same positron-cloud keychain slot that {@link apiKey} reads, so the chat
	 *  path needs no special-casing — a signed-in user's minted key simply becomes the
	 *  gateway bearer; sign-out clears it. */
	setGatewayKey(key: string | null, endUser?: string | null): void {
		if (key) {
			this.secrets.store(CLOUD_SECRET_ID['positron-cloud'], 'password', key);
			this.gatewayUser = endUser?.trim() || null;
		} else {
			this.secrets.delete(CLOUD_SECRET_ID['positron-cloud'], 'password');
			this.gatewayUser = null;
		}
	}

	/** Store (or clear, when null) the user's persistent top-up (credits) gateway key — the
	 *  second key behind pay-as-you-go credits. Minted/returned by `mint-litellm-key` alongside the
	 *  subscription key; absent until the user buys credits, and cleared on sign-out. */
	setGatewayTopupKey(key: string | null): void {
		if (key) {
			this.secrets.store(CLOUD_TOPUP_SECRET_ID, 'password', key);
		} else {
			this.secrets.delete(CLOUD_TOPUP_SECRET_ID, 'password');
		}
	}

	/** The stored top-up (credits) key, or undefined when the user has bought no credits. */
	topupKey(): string | undefined {
		return this.secrets.get(CLOUD_TOPUP_SECRET_ID, 'password');
	}

	/** The signed-in account's user id for request attribution (OpenAI `user` field), or undefined
	 *  when signed out / using a manually-pasted key. */
	endUser(): string | undefined {
		return this.gatewayUser ?? undefined;
	}
}

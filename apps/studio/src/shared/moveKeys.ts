/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BYOK_PROVIDER_DEFAULTS, type ByokProviderId } from './ai';
import type { PsycheAdmin, ProviderKind } from './psycheAdmin';

// "Move my keys to a project": the user's own provider keys, posted to a project's AI gateway. Pure
// over the admin client, so what it does to a project that already has providers and models is
// provable without one. Nothing in a project is overwritten: a provider name that is taken gets
// another, a model name that is taken is left as it is. A provider whose key the gateway refuses
// leaves nothing behind.

/** One provider key to move. `apiKey` stays in main. */
export interface MoveKeyInput {
	source: ByokProviderId;
	apiKey: string;
	baseUrl: string;
	models: string[];
}

/** What the screen shows before the move. Nothing secret. */
export interface MoveKeyPreview {
	source: ByokProviderId;
	label: string;
	models: string[];
}

/** A project the keys can go to. `ref` is as in `ProjectAiSelection` (shared/aiSources.ts). */
export interface MoveKeysTarget {
	ref: string;
	name: string;
	local: boolean;
}

export interface MoveKeysResult {
	moved: { source: ByokProviderId; provider: string; models: string[] }[];
	failed: { source: ByokProviderId; message: string }[];
	/** The model the assistant switches to, and the provider it runs on; null when none moved. */
	switchTo: { model: string; provider: string } | null;
}

const SOURCES: Record<ByokProviderId, { name: string; kind: ProviderKind }> = {
	'byok-openai': { name: 'openai', kind: 'openai' },
	'byok-openrouter': { name: 'openrouter', kind: 'openai' },
	'byok-anthropic': { name: 'anthropic', kind: 'anthropic' },
};

/** The stored BYOK settings as what can be moved: a key and at least one model. */
export function moveInput(source: ByokProviderId, apiKey: string | undefined, config: { model: string; models: string[]; baseUrl?: string }): MoveKeyInput | null {
	const models = [...new Set([...config.models, config.model].map((m) => m.trim()).filter(Boolean))];
	if (!apiKey || models.length === 0) {
		return null;
	}
	return { source, apiKey, baseUrl: config.baseUrl?.trim() || BYOK_PROVIDER_DEFAULTS[source].baseUrl, models };
}

/** A provider name not yet taken: the source's own, else `<name>-studio`, `-studio-2`… */
export function freeProviderName(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base)) {
		return base;
	}
	for (let n = 1; ; n++) {
		const name = n === 1 ? `${base}-studio` : `${base}-studio-${n}`;
		if (!taken.has(name)) {
			return name;
		}
	}
}

function sentence(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Moves the keys, one provider at a time, in the order the add-a-model guide uses: the provider, its
 * models, then the credential, which Psyche proves against the provider before keeping it. Models
 * whose names are all taken mean nothing is left to move for that key, so it is not posted at all.
 * `prefer` is the model the assistant is on now, kept when it moved.
 */
export async function moveKeys(admin: PsycheAdmin, inputs: MoveKeyInput[], prefer?: string): Promise<MoveKeysResult> {
	const [providers, models] = await Promise.all([admin.providers(), admin.models()]);
	const takenProviders = new Set(providers.map((p) => p.name));
	const takenModels = new Set(models.map((m) => m.name));
	const result: MoveKeysResult = { moved: [], failed: [], switchTo: null };
	for (const input of inputs) {
		const fresh = input.models.filter((m) => !takenModels.has(m));
		if (fresh.length === 0) {
			continue;
		}
		const source = SOURCES[input.source];
		const name = freeProviderName(source.name, takenProviders);
		const added: string[] = [];
		let made = false;
		try {
			await admin.putProvider(name, { kind: source.kind, base_url: input.baseUrl, credential: name });
			made = true;
			takenProviders.add(name);
			for (const model of fresh) {
				await admin.putModel(model, { provider: name, upstream: model });
				added.push(model);
			}
			await admin.putCredential(name, { api_key: input.apiKey });
			for (const model of added) {
				takenModels.add(model);
			}
			result.moved.push({ source: input.source, provider: name, models: added });
		} catch (error) {
			for (const model of added) {
				await admin.deleteModel(model).catch(() => undefined);
			}
			if (made) {
				await admin.deleteProvider(name).catch(() => undefined);
				takenProviders.delete(name);
			}
			result.failed.push({ source: input.source, message: sentence(error) });
		}
	}
	const all = result.moved.flatMap((m) => m.models.map((model) => ({ model, provider: m.provider })));
	result.switchTo = all.find((m) => m.model === prefer) ?? all[0] ?? null;
	return result;
}

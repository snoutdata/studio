/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Where a chat model comes from, and how the picker groups them.
// Three sources, each billed differently, which is the distinction the picker has to make plain:
//   - SnoutData AI (`positron-cloud`): our gateway, the user's SnoutData balance.
//   - A SnoutData Cloud project's own AI gateway (`snout-project` + the project's ref): the
//     project's own provider keys, billed by that provider. Reached through the control plane's
//     `cloud-project-ai` relay with the user's own sign-in.
//   - The user's own keys kept in Studio (BYOK, and the hidden local Ollama).
// Pure on purpose: the renderer and main both use it, and it is unit-tested without Electron.

import { BYOK_PROVIDER_DEFAULTS, isByokProvider, isReasoningModel, type AiModelInfo, type AiProviderId, type AiSettings, type ProjectAiSelection } from './ai';

/** One project the relay lists (`POST cloud-project-ai {action: "ai-sources"}`). `models` is null
 *  when the project is paused or its gateway did not answer: it is shown as nothing, never woken. */
export interface ProjectAiSource {
	ref: string;
	name: string;
	state: string;
	/** `vendor` is the relay's display name for who bills the model ("OpenAI", "AWS Bedrock", or
	 *  the provider's host); `owned_by` is Psyche's own field. */
	models: { id: string; owned_by?: string; vendor?: string }[] | null;
}

/** The relay's base for one project, OpenAI-compatible: `{functions}/cloud-project-ai/{ref}/v1`. */
export function projectRelayBase(functionsUrl: string, ref: string): string {
	return `${functionsUrl.replace(/\/+$/, '')}/cloud-project-ai/${encodeURIComponent(ref)}/v1`;
}

/** A picker value. "provider:model" as before, so every stored and rendered value keeps working;
 *  a project model is "snout-project:<ref>:<model>" so a project's `gpt-x` and SnoutData AI's
 *  `gpt-x` never collide. A ref holds no colon; a model id may (`qwen2.5-coder:7b`). */
export function modelKey(m: { provider: AiProviderId; model: string; projectRef?: string }): string {
	return m.provider === 'snout-project' ? `snout-project:${m.projectRef ?? ''}:${m.model}` : `${m.provider}:${m.model}`;
}

/** The inverse of {@link modelKey}; null for a value that names no model. */
export function parseModelKey(value: string): { provider: AiProviderId; model: string; projectRef?: string } | null {
	const idx = value.indexOf(':');
	if (idx <= 0) {
		return null;
	}
	const provider = value.slice(0, idx) as AiProviderId;
	const rest = value.slice(idx + 1);
	if (provider !== 'snout-project') {
		return rest ? { provider, model: rest } : null;
	}
	const sep = rest.indexOf(':');
	if (sep <= 0 || sep === rest.length - 1) {
		return null;
	}
	return { provider, projectRef: rest.slice(0, sep), model: rest.slice(sep + 1) };
}

/** The selected chat model as a (source, model) pair. */
export function chatSelection(settings: AiSettings): { provider: AiProviderId; model: string; projectRef?: string } {
	switch (settings.provider) {
		case 'snout-project': return { provider: 'snout-project', model: settings.project?.model ?? '', projectRef: settings.project?.ref };
		case 'ollama': return { provider: 'ollama', model: settings.ollama.model };
		case 'positron-cloud': return { provider: 'positron-cloud', model: settings['positron-cloud'].model };
		default: return isByokProvider(settings.provider)
			? { provider: settings.provider, model: settings.byok[settings.provider].model }
			: { provider: 'positron-cloud', model: settings['positron-cloud'].model };
	}
}

/** A stored project selection, kept only when it names both a project and a model. */
export function normalizeProjectSelection(raw: unknown): ProjectAiSelection | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const p = raw as Partial<ProjectAiSelection>;
	const ref = typeof p.ref === 'string' ? p.ref.trim() : '';
	const model = typeof p.model === 'string' ? p.model.trim() : '';
	if (!ref || !model || ref.includes(':')) {
		return undefined;
	}
	return {
		ref,
		model,
		name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : undefined,
		ownedBy: typeof p.ownedBy === 'string' && p.ownedBy.trim() ? p.ownedBy.trim() : undefined,
		vendor: typeof p.vendor === 'string' && p.vendor.trim() ? p.vendor.trim() : undefined,
	};
}

/** The stored chat provider, checked: a name from an older build, a removed provider, or a
 *  project selection that lost its project or model falls back to `fallback` (SnoutData AI). */
export function resolveStoredProvider(raw: unknown, project: ProjectAiSelection | undefined, fallback: AiProviderId): AiProviderId {
	if (raw === 'ollama' || raw === 'positron-cloud') {
		return raw;
	}
	if (raw === 'snout-project') {
		return project ? raw : fallback;
	}
	if (typeof raw === 'string' && isByokProvider(raw as AiProviderId)) {
		return raw as AiProviderId;
	}
	return fallback;
}

/** A provider a project's model is served by, as people say it, from Psyche's `owned_by`.
 *  Unknown values give undefined (a sub-line names only a vendor we are sure of). */
export function vendorName(ownedBy: string | undefined): string | undefined {
	const v = (ownedBy ?? '').toLowerCase();
	if (!v) {
		return undefined;
	}
	const known: [RegExp, string][] = [
		[/openrouter/, 'OpenRouter'],
		[/azure/, 'Azure OpenAI'],
		[/openai/, 'OpenAI'],
		[/anthropic|claude/, 'Anthropic'],
		[/bedrock|aws/, 'AWS Bedrock'],
		[/gemini|vertex|google/, 'Google'],
		[/mistral/, 'Mistral'],
		[/deepseek/, 'DeepSeek'],
		[/groq/, 'Groq'],
		[/ollama/, 'Ollama'],
	];
	return known.find(([re]) => re.test(v))?.[1];
}

/** Who bills a project model: the relay's `vendor`, else a name read from `owned_by`. */
export function billedBy(m: { vendor?: string; ownedBy?: string }): string | undefined {
	return m.vendor?.trim() || vendorName(m.ownedBy);
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
	if (names.length <= 1) {
		return names[0] ?? '';
	}
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The picker's models for every project the relay listed, in its order. A paused project (or one
 *  whose gateway did not answer) contributes none. Hidden models (Settings) are still returned,
 *  flagged off, like every other source. */
export function projectModelInfos(sources: ProjectAiSource[], disabled: ReadonlySet<string> = new Set()): AiModelInfo[] {
	const out: AiModelInfo[] = [];
	for (const s of sources) {
		if (!s || typeof s.ref !== 'string' || !s.ref || s.ref.includes(':') || !Array.isArray(s.models)) {
			continue;
		}
		for (const m of s.models) {
			if (!m || typeof m.id !== 'string' || !m.id) {
				continue;
			}
			const info: AiModelInfo = {
				provider: 'snout-project',
				model: m.id,
				projectRef: s.ref,
				projectName: s.name || s.ref,
				ownedBy: m.owned_by,
				vendor: typeof m.vendor === 'string' && m.vendor.trim() ? m.vendor.trim() : undefined,
				enabled: true,
				reasoning: isReasoningModel('snout-project', m.id),
				metered: false,
			};
			info.enabled = !disabled.has(modelKey(info));
			out.push(info);
		}
	}
	return out;
}

/** One group in the picker. */
export interface PickerGroup {
	id: string;
	title: string;
	/** Who pays for a call to a model in this group. */
	subtitle: string;
	models: AiModelInfo[];
}

/** A short line naming where one model's calls are billed, for the hover detail. */
export function modelSourceLine(m: AiModelInfo): string {
	if (m.provider === 'snout-project') {
		const vendor = billedBy(m);
		return vendor ? `${m.projectName ?? m.projectRef}: the project's ${vendor} key` : `${m.projectName ?? m.projectRef}: the project's keys`;
	}
	if (isByokProvider(m.provider)) {
		return `Your ${BYOK_PROVIDER_DEFAULTS[m.provider].label} key`;
	}
	if (m.provider === 'ollama') {
		return 'Ollama on your computer';
	}
	return 'SnoutData AI';
}

/** Groups the picker's models by source, in this order: SnoutData AI, then one group per project
 *  (in the order first seen), then the user's own keys. Empty groups are left out. */
export function groupPickerModels(models: AiModelInfo[]): PickerGroup[] {
	const cloud: AiModelInfo[] = [];
	const projects = new Map<string, AiModelInfo[]>();
	const own: AiModelInfo[] = [];
	for (const m of models) {
		if (m.provider === 'snout-project') {
			const ref = m.projectRef ?? '';
			const list = projects.get(ref) ?? [];
			list.push(m);
			projects.set(ref, list);
		} else if (m.provider === 'positron-cloud') {
			cloud.push(m);
		} else {
			own.push(m);
		}
	}
	const groups: PickerGroup[] = [];
	if (cloud.length) {
		groups.push({ id: 'snoutdata', title: "SnoutData AI", subtitle: "Uses your balance", models: cloud });
	}
	for (const [ref, list] of projects) {
		const vendors = [...new Set(list.map(billedBy).filter((v): v is string => !!v))];
		groups.push({
			id: `project:${ref}`,
			title: list[0].projectName || ref,
			subtitle: vendors.length ? `Your project's keys, billed by ${joinNames(vendors)}` : "Your project's keys",
			models: list,
		});
	}
	if (own.length) {
		const vendors = [...new Set(own.map((m) => (isByokProvider(m.provider) ? BYOK_PROVIDER_DEFAULTS[m.provider].label : m.provider === 'ollama' ? 'Ollama' : '')).filter(Boolean))];
		const local = own.every((m) => m.provider === 'ollama');
		groups.push({
			id: 'own',
			title: "Your keys",
			subtitle: local ? "Runs on your computer" : `Billed by ${joinNames(vendors.filter((v) => v !== 'Ollama'))}`,
			models: own,
		});
	}
	return groups;
}

/**
 * A project relay's refusal, said plainly. `message` is the provider's error ("OpenAI 404: {…}");
 * the relay answers OpenAI-shaped `{error: {message, code}}`. 404 with `ai-off` is a project
 * whose AI was switched off, 403 a project this user may not use. Anything else is the
 * project's own gateway speaking (its budgets, its provider), named as the project's.
 */
export function projectRefusal(message: string, projectName: string): string | null {
	const match = /^OpenAI (\d{3}): ([\s\S]*)$/.exec(message.trim());
	if (!match) {
		return null;
	}
	const status = Number(match[1]);
	let code: string | undefined;
	let detail = match[2].trim();
	try {
		const body = JSON.parse(detail) as { error?: { message?: string; code?: string } | string; message?: string };
		if (body && typeof body.error === 'object' && body.error) {
			code = typeof body.error.code === 'string' ? body.error.code : undefined;
			detail = body.error.message ?? detail;
		} else if (typeof body?.error === 'string') {
			detail = body.error;
		} else if (typeof body?.message === 'string') {
			detail = body.message;
		}
	} catch {
		// Not JSON: keep the text.
	}
	if (code === 'ai-off' || (status === 404 && /ai.?off|switched off/i.test(detail))) {
		return `The AI gateway of ${projectName} is switched off. Switch it on in the project's dashboard, or pick another model.`;
	}
	if (status === 403) {
		return `You may not use the AI of ${projectName}. Pick another model, or ask the project's owner for access.`;
	}
	if (status === 401) {
		return `SnoutData Cloud did not accept your sign-in for ${projectName}. Sign in again, then try once more.`;
	}
	return `${projectName}'s AI gateway refused the request: ${detail || `status ${status}`}`;
}

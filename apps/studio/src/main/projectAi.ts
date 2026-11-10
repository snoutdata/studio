/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BYOK_PROVIDER_DEFAULTS, type AiSettings, type ByokProviderId } from '../shared/ai';
import { targetOfAiRef, type ProjectAiSource } from '../shared/aiSources';
import { moveInput, moveKeys, type MoveKeyInput, type MoveKeyPreview, type MoveKeysResult, type MoveKeysTarget } from '../shared/moveKeys';
import type { ProjectApiResponse, ProjectTarget } from '../shared/projects';
import { PsycheAdmin, psycheAnswer, type PsycheMethod } from '../shared/psycheAdmin';
import { t } from '../shared/i18n/core';

// What main does with a project's AI gateway beyond the section's own calls: moving the user's own
// provider keys into it, and holding the key an agent's calls go out with.

const BYOK_IDS = Object.keys(BYOK_PROVIDER_DEFAULTS) as ByokProviderId[];

/** The agents' key: one per project, under a reserved id in the secret store. */
function agentKeyId(ref: string): string {
	return `__agent_ai_${ref}__`;
}

export interface ProjectAiDeps {
	psyche(target: ProjectTarget, method: PsycheMethod, path: string, body?: unknown): Promise<ProjectApiResponse>;
	sources(force: boolean): Promise<ProjectAiSource[]>;
	settings: {
		get(): AiSettings;
		byokKey(provider: ByokProviderId): string | undefined;
		setActive(provider: 'snout-project', model: string, project: { ref: string; name?: string; ownedBy?: string }): AiSettings;
	};
	secrets: {
		get(id: string, kind: 'password'): string | undefined;
		store(id: string, kind: 'password', value: string): void;
	};
	byokAllowed(): boolean;
	/** A key was moved: the picker's list is out of date. */
	forgetSources(): void;
}

export class ProjectAi {
	private readonly minting = new Map<string, Promise<string>>();

	constructor(private readonly deps: ProjectAiDeps) {}

	admin(target: ProjectTarget): PsycheAdmin {
		return new PsycheAdmin(async (method, path, body) => psycheAnswer(await this.deps.psyche(target, method, path, body)));
	}

	private inputs(): MoveKeyInput[] {
		if (!this.deps.byokAllowed()) {
			return [];
		}
		const settings = this.deps.settings.get();
		return BYOK_IDS.flatMap((source) => moveInput(source, this.deps.settings.byokKey(source), settings.byok[source]) ?? []);
	}

	/** What would be moved. Nothing secret crosses IPC. */
	movePreview(): MoveKeyPreview[] {
		return this.inputs().map((input) => ({ source: input.source, label: BYOK_PROVIDER_DEFAULTS[input.source].label, models: input.models }));
	}

	/** The projects whose gateway answers now. Fresh, since someone may have just switched one on. */
	async moveTargets(): Promise<MoveKeysTarget[]> {
		const sources = await this.deps.sources(true);
		return sources.filter((s) => s.models !== null).map((s) => ({ ref: s.ref, name: s.name, local: targetOfAiRef(s.ref).kind === 'local' }));
	}

	/** Posts the keys to the project and switches the assistant to it. The copies in Studio stay. */
	async moveKeys(ref: string, name: string): Promise<MoveKeysResult> {
		const inputs = this.inputs();
		if (inputs.length === 0) {
			throw new Error(t('mainProjects.noKeysToMove'));
		}
		const settings = this.deps.settings.get();
		const prefer = BYOK_IDS.includes(settings.provider as ByokProviderId) ? settings.byok[settings.provider as ByokProviderId].model : undefined;
		const result = await moveKeys(this.admin(targetOfAiRef(ref)), inputs, prefer);
		if (result.switchTo) {
			this.deps.settings.setActive('snout-project', result.switchTo.model, { ref, name, ownedBy: result.switchTo.provider });
			this.deps.forgetSources();
		}
		return result;
	}

	/** The key an agent's calls are sent with, made through the project's admin API the first time. */
	agentKey(ref: string, fresh: boolean): Promise<string> {
		const stored = fresh ? undefined : this.deps.secrets.get(agentKeyId(ref), 'password');
		if (stored) {
			return Promise.resolve(stored);
		}
		let making = this.minting.get(ref);
		if (!making) {
			making = this.admin(targetOfAiRef(ref)).createKey({ name: 'SnoutData Studio agents' }).then((made) => {
				this.deps.secrets.store(agentKeyId(ref), 'password', made.key);
				return made.key;
			}).finally(() => this.minting.delete(ref));
			this.minting.set(ref, making);
		}
		return making;
	}
}

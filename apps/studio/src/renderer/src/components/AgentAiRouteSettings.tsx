/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../i18n';
import type { AiModelInfo } from '../../../shared/ai';
import { groupPickerModels, modelKey } from '../../../shared/aiSources';
import { AGENTS, type AgentConsoleConfig, type AgentConsoleStatus, type AgentKind } from '../../../shared/agentConsole';
import { opencodeSnippet } from '../../../shared/agentAiRoute';

/**
 * Settings, Agent access: which project's AI gateway a coding agent's own model calls go to, when
 * the user wants them budgeted and logged with the project's. Unset, the agent uses its own account.
 */
export function AgentAiRouteSettings({ agents }: { agents: AgentConsoleStatus[] }): JSX.Element | null {
	const t = useT();
	const [models, setModels] = useState<AiModelInfo[]>([]);
	const [config, setConfig] = useState<AgentConsoleConfig | null>(null);
	const [changed, setChanged] = useState<ReadonlySet<AgentKind>>(new Set());

	useEffect(() => {
		void window.sqlApi.aiProjectModels().then(setModels).catch(() => setModels([]));
		void window.sqlApi.agentConsole.config().then(setConfig).catch(() => setConfig(null));
	}, []);

	const installed = agents.filter((a) => a.install.installed);
	if (!config || installed.length === 0) {
		return null;
	}
	const groups = groupPickerModels(models.filter((m) => m.provider === 'snout-project'));

	async function choose(kind: AgentKind, value: string): Promise<void> {
		const model = models.find((m) => modelKey(m) === value);
		const route = model?.projectRef ? { ref: model.projectRef, model: model.model, name: model.projectName } : null;
		setConfig(await window.sqlApi.agentConsole.setAiRoute(kind, route));
		setChanged((prev) => new Set(prev).add(kind));
	}

	return (
		<fieldset>
			<legend>{t('settingsAgent.aiRoute.legend')}</legend>
			<p className="field-hint">{t('settingsAgent.aiRoute.hint')}</p>
			{installed.map((agent) => {
				const route = config.aiRoutes[agent.kind];
				const value = route ? modelKey({ provider: 'snout-project', model: route.model, projectRef: route.ref }) : '';
				const known = !route || models.some((m) => modelKey(m) === value);
				return (
					<div key={agent.kind}>
						<label>{AGENTS[agent.kind].label}
							<select value={value} onChange={(e) => void choose(agent.kind, e.target.value)}>
								<option value="">{t('settingsAgent.aiRoute.ownAccount')}</option>
								{!known && route && <option value={value}>{`${route.name ?? route.ref}: ${route.model}`}</option>}
								{groups.map((group) => (
									<optgroup key={group.id} label={group.title}>
										{group.models.map((m) => <option key={modelKey(m)} value={modelKey(m)}>{m.model}</option>)}
									</optgroup>
								))}
							</select>
						</label>
						{route && agent.kind === 'opencode' && (
							<>
								<p className="field-hint">{t('settingsAgent.aiRoute.opencodeHint')}</p>
								<pre className="local-log">{opencodeSnippet(route.model)}</pre>
							</>
						)}
						{changed.has(agent.kind) && agent.running && (
							<div className="cloud-actions">
								<button type="button" className="secondary" onClick={() => { void window.sqlApi.agentConsole.restart(agent.kind); setChanged((prev) => { const next = new Set(prev); next.delete(agent.kind); return next; }); }}><Icon name="debug-restart" /> {t('settingsAgent.aiRoute.restart', { agent: AGENTS[agent.kind].label })}</button>
							</div>
						)}
					</div>
				);
			})}
		</fieldset>
	);
}

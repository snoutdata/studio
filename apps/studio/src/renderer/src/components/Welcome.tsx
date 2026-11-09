/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';
import { WorkbenchArt } from '../art/Illustrations';
import { shortcutKeys } from '../shortcuts';
import { CHECKLIST_TASKS, type ChecklistTaskId } from '../onboarding';
import { useT } from '../i18n';
import type { ResolvedKeybinding } from '../../../shared/keybindings';

interface WelcomeProps {
	onNewQuery(): void;
	onOpenCommandPalette(): void;
	onOpenFile(): void;
	onSave(): void;
	onRun(): void;
	onFormat(): void;
	onCloseTab(): void;
	onAddConnection(): void;
	/** Resolved keyboard shortcuts, so the hints follow a Settings rebind. */
	bindings: ResolvedKeybinding[];
	/** Getting-started task completion — drives the "Getting started N/5" button's count. */
	tasks: Record<ChecklistTaskId, boolean>;
	/** Pop the getting-started checklist out as the side card (same as on first launch). */
	onOpenChecklist(): void;
	/** When false (onboarding disabled in Settings), the tour/checklist buttons are hidden. */
	onboardingEnabled: boolean;
}

interface Action {
	label: string;
	/** Command id whose bound combo is shown as the key hint (rendered per-platform). */
	commandId?: string;
	run(): void;
}

/** Empty-workbench placeholder shown when there are no open tabs, after VSCode/Cursor's welcome
 *  view: a drawing of the workbench (art/Illustrations.tsx, the website's style) above a short list
 *  of starter actions with key hints. */
export function Welcome({ onNewQuery, onOpenCommandPalette, onOpenFile, onSave, onRun, onFormat, onCloseTab, onAddConnection, bindings, tasks, onOpenChecklist, onboardingEnabled }: WelcomeProps): JSX.Element {
	const t = useT();
	const done = CHECKLIST_TASKS.filter((task) => tasks[task.id]).length;
	const total = CHECKLIST_TASKS.length;
	const comboFor = (id: string): string | undefined => bindings.find((b) => b.id === id)?.combo;
	const actions: Action[] = [
		{ label: t('commands.new'), commandId: 'new', run: onNewQuery },
		{ label: t('shell.welcome.showAllCommands'), commandId: 'commandPalette', run: onOpenCommandPalette },
		{ label: t('shell.welcome.openFile'), commandId: 'open', run: onOpenFile },
		{ label: t('commands.saveFile'), commandId: 'saveFile', run: onSave },
		{ label: t('commands.run'), commandId: 'run', run: onRun },
		{ label: t('commands.format'), commandId: 'format', run: onFormat },
		{ label: t('commands.closeTab'), commandId: 'closeTab', run: onCloseTab },
		{ label: t('shell.welcome.addConnection'), run: onAddConnection },
	];
	return (
		<div className="welcome">
			<WorkbenchArt className="welcome-art" />
			{onboardingEnabled && done < total && (
				<button type="button" className="welcome-checklist-btn" onClick={onOpenChecklist}>
					<Icon name="rocket" />
					<span>{t('onboarding.gettingStarted')}</span>
					<span className="welcome-checklist-count">{done}/{total}</span>
				</button>
			)}
			<div className="welcome-actions">
				{actions.map((a) => {
					const combo = a.commandId ? comboFor(a.commandId) : undefined;
					return (
						<button key={a.label} type="button" className="welcome-action" onClick={a.run}>
							<span className="welcome-action-label">{a.label}</span>
							{combo && (
								<span className="welcome-action-keys">
									{shortcutKeys(combo).map((k, i) => (
										<kbd key={i}>{k}</kbd>
									))}
								</span>
							)}
						</button>
					);
				})}
			</div>
		</div>
	);
}

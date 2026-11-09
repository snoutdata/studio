/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';
import { ChecklistArt } from '../art/Illustrations';
import { CHECKLIST_TASKS, type ChecklistTaskId, type OnboardingState } from '../onboarding';
import { useT } from '../i18n';

interface GettingStartedProps {
	state: OnboardingState;
	/** Expanded card vs. collapsed corner pill. */
	open: boolean;
	onToggleOpen(): void;
	onStartTour(): void;
	onDismiss(): void;
	/** Clicking a not-yet-done task jumps the user to where they'd do it. */
	onRunTask(id: ChecklistTaskId): void;
}

/**
 * A persistent "Getting started" checklist that lives in the bottom-right corner. It
 * ticks tasks off as the user actually does them (App marks them), can be collapsed to a
 * pill, and offers a one-click jump to each remaining task plus a "Take the tour" button.
 */
export function GettingStarted({ state, open, onToggleOpen, onStartTour, onDismiss, onRunTask }: GettingStartedProps): JSX.Element {
	const t = useT();
	const done = CHECKLIST_TASKS.filter((task) => state.tasks[task.id]).length;
	const total = CHECKLIST_TASKS.length;
	const complete = done === total;

	if (!open) {
		return (
			<button className="gs-pill" type="button" onClick={onToggleOpen} title={t('onboarding.gettingStarted')}>
				<Icon name={complete ? 'check-all' : 'rocket'} />
				<span>{t('onboarding.gettingStarted')}</span>
				<span className="gs-pill-count">{done}/{total}</span>
			</button>
		);
	}

	return (
		<div className="gs-card">
			<div className="gs-header">
				<ChecklistArt className="gs-art" />
				<span className="gs-title">{t('onboarding.gettingStarted')}</span>
				<span className="gs-progress">{done}/{total}</span>
				<span className="spacer" />
				<button className="icon-btn" type="button" aria-label={t('onboarding.minimize')} onClick={onToggleOpen}><Icon name="chevron-down" /></button>
				<button className="icon-btn" type="button" aria-label={t('onboarding.dontShowAgain')} onClick={onDismiss}><Icon name="close" /></button>
			</div>
			<div className="gs-track"><div className="gs-track-fill" style={{ width: `${(done / total) * 100}%` }} /></div>
			<ul className="gs-list">
				{CHECKLIST_TASKS.map((task) => {
					const isDone = state.tasks[task.id];
					return (
						<li key={task.id} className={`gs-task${isDone ? ' done' : ''}`}>
							<button type="button" onClick={() => !isDone && onRunTask(task.id)} disabled={isDone}>
								<Icon name={isDone ? 'pass-filled' : 'circle-large-outline'} className="gs-check" />
								<span className="gs-task-text">
									<span className="gs-task-label">{task.label}</span>
									{!isDone && <span className="gs-task-hint">{task.hint}</span>}
								</span>
								{!isDone && <Icon name="chevron-right" className="gs-task-go" />}
							</button>
						</li>
					);
				})}
			</ul>
			{complete ? (
				<div className="gs-done-banner"><Icon name="check-all" /> {t('onboarding.allSet')}</div>
			) : (
				<button className="gs-tour-btn" type="button" onClick={onStartTour}>
					<Icon name="play-circle" /> {t('onboarding.takeTour')}
				</button>
			)}
		</div>
	);
}

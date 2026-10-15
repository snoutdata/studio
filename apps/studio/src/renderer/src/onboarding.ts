/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// First-run onboarding state: whether the spotlight tour has been seen, whether the
// "Getting started" checklist was dismissed, which checklist tasks the user has completed,
// and the app version whose release notes were last shown. Pure-UI, persisted to localStorage
// alongside theme/layout/appSettings.

import { ASSISTANT_NAME } from '../../shared/assistant';

/** The five starter tasks tracked by the getting-started checklist. */
export type ChecklistTaskId = 'addConnection' | 'run' | 'explore' | 'ai' | 'save';

export interface OnboardingState {
	/** The spotlight tour has been finished or skipped — don't auto-start it again. */
	tourSeen: boolean;
	/** The user permanently dismissed the getting-started checklist. */
	checklistDismissed: boolean;
	/** Per-task completion for the checklist. */
	tasks: Record<ChecklistTaskId, boolean>;
	/** The app version whose release notes we've already surfaced. Null until the first launch
	 *  records it (a fresh install records silently — release notes only auto-open after an
	 *  actual update, mirroring VSCode). */
	lastReleaseNotesVersion: string | null;
	/** The first-run "Find your databases" popup has been answered (either way) and is not shown
	 *  again. False only on a fresh install: stored state that predates the field is an existing
	 *  user, who is never shown it on upgrade. */
	discoverySeen: boolean;
}

export interface ChecklistTaskMeta {
	id: ChecklistTaskId;
	label: string;
	hint: string;
}

/** The checklist rows, in the order a new user naturally hits them. */
export const CHECKLIST_TASKS: ChecklistTaskMeta[] = [
	{ id: 'addConnection', label: "Add a database connection", hint: "Connect a MySQL, Postgres, or SQL Server database." },
	{ id: 'run', label: "Run a query", hint: "Type SQL in the editor and press Run (or Ctrl/Cmd+Enter)." },
	{ id: 'explore', label: "Explore a table", hint: "Double-click a table in the sidebar to browse its data." },
	{ id: 'ai', label: `Ask ${ASSISTANT_NAME}`, hint: `Insert SQL that ${ASSISTANT_NAME} proposes into your editor.` },
	{ id: 'save', label: "Save a query", hint: "Keep a query you'll reuse for later." },
];

const STORAGE_KEY = 'positron-db.onboarding';

export const DEFAULT_ONBOARDING: OnboardingState = {
	tourSeen: false,
	checklistDismissed: false,
	tasks: { addConnection: false, run: false, explore: false, ai: false, save: false },
	lastReleaseNotesVersion: null,
	discoverySeen: false,
};

/**
 * The onboarding state from what storage holds (null: nothing stored, i.e. a fresh install). Pure.
 * Every field defaults as DEFAULT_ONBOARDING says, except `discoverySeen`: stored state WITHOUT it
 * belongs to someone who used the app before the popup existed, so it counts as seen.
 */
export function onboardingFromStorage(raw: string | null): OnboardingState {
	if (raw) {
		try {
			const stored = JSON.parse(raw) as Partial<OnboardingState>;
			return {
				...DEFAULT_ONBOARDING,
				...stored,
				tasks: { ...DEFAULT_ONBOARDING.tasks, ...(stored.tasks ?? {}) },
				discoverySeen: stored.discoverySeen ?? true,
			};
		} catch {
			// malformed storage: fall through to a fresh state
		}
	}
	return { ...DEFAULT_ONBOARDING, tasks: { ...DEFAULT_ONBOARDING.tasks } };
}

export function loadOnboarding(): OnboardingState {
	let raw: string | null = null;
	try {
		raw = localStorage.getItem(STORAGE_KEY);
	} catch {
		// storage unavailable: treat as fresh
	}
	return onboardingFromStorage(raw);
}

export function saveOnboarding(state: OnboardingState): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// ignore write failures (private mode, quota)
	}
}

/** How many checklist tasks are done. */
export function tasksDone(state: OnboardingState): number {
	return CHECKLIST_TASKS.reduce((n, t) => n + (state.tasks[t.id] ? 1 : 0), 0);
}

/** True once every checklist task is complete. */
export function allTasksDone(state: OnboardingState): boolean {
	return CHECKLIST_TASKS.every((t) => state.tasks[t.id]);
}

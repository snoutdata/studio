/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @snout/liby/studio, as the open-source tree builds it: every name Studio imports from Liby's
// Studio half, with no Liby behind it. She says nothing (every advice is null), notices nothing and
// has no moments; the help shortcut falls back to the assistant (`LIBY_AVAILABLE`); the first-run
// tour keeps the app's own words below. The types are Studio's own (libyFacts.ts), so they cannot
// drift from what the real package takes. See ../README.md.
//
// User-facing text: no em-dashes (the house style).

import type { LibyCall, LibyHelp, LibyHost } from '@snout/liby';
import type { AmbientFlowWizard } from '@snout/studio/shared/ai';
import type { ChecklistTaskId } from '@snout/studio/renderer/src/onboarding';
import type {
	EditorFacts, FormFacts, FoundDb, HelpAction, HelpMove, Moment, MomentId, MomentSwitches, ResultFacts, RiskyFacts, SchemaGlance,
	SidebarFacts, StudioEvent, TableFacts, TourCopy, TourStepId,
} from '@snout/studio/renderer/src/libyFacts';

/** False: this build has no Liby. */
export const LIBY_AVAILABLE = false;

export function libyFeel(_event: StudioEvent): void {}

export function installLibyTestHooks(): void {}

// ---- What she would say: nothing ------------------------------------------------------------------

export function formAdvice(_f: FormFacts, _said: ReadonlySet<string>): LibyCall | null {
	return null;
}

export function foundAdvice(_found: readonly FoundDb[], _action?: LibyCall['action']): LibyCall | null {
	return null;
}

export function queryErrorAdvice(_error: string, _sql: string | undefined, _schema: SchemaGlance | null | undefined): LibyCall | null {
	return null;
}

export function returnAdvice(_f: FormFacts, _error: string): LibyCall | null {
	return null;
}

export function riskyAdvice(_r: RiskyFacts): LibyCall | null {
	return null;
}

export function tableAdvice(_t: TableFacts): LibyCall | null {
	return null;
}

export function testAdvice(_f: FormFacts, _ok: boolean, _error: string | undefined, _failedBefore: boolean): LibyCall | null {
	return null;
}

export function writtenTable(_sql: string): string | undefined {
	return undefined;
}

// ---- Her help on a screen: none, and nobody asks for it --------------------------------------------

// The helpers that would ask these are registered with the stub's `registerLibyHelper`, which keeps
// none, so the non-null ones below are never shown.
const NOTHING: HelpMove = { line: '', mood: 'hello' };

export function editorHelp(_f: EditorFacts): HelpMove | null {
	return null;
}

export function emptyWorkbenchHelp(_newKey: string): HelpMove | null {
	return null;
}

export function resultHelp(_r: ResultFacts | undefined, _schema?: SchemaGlance | null): HelpMove | null {
	return null;
}

export function flowHelp(_w: AmbientFlowWizard): HelpMove | null {
	return null;
}

export function tableHelp(_t: TableFacts): HelpMove {
	return NOTHING;
}

export function sidebarHelp(_f: SidebarFacts): HelpMove {
	return NOTHING;
}

export function formHelp(_f: FormFacts, _lastTest?: { ok: boolean; error?: string }): HelpMove {
	return NOTHING;
}

export function signedOutHelp(_place: string): HelpMove {
	return NOTHING;
}

export function signedOutQuestionHelp(): HelpMove {
	return NOTHING;
}

let runAction: (action: HelpAction) => void = () => {};

export function setHelpActionRunner(run: (action: HelpAction) => void): void {
	runAction = run;
}

export function asLibyHelp(move: HelpMove): LibyHelp {
	return { line: move.line, mood: move.mood, actions: move.actions?.map((a) => ({ label: a.label, run: () => runAction(a) })) };
}

export function studioHost(_live: {
	help(target: Element, question?: string): unknown;
	deeper(question: string): void;
	busy(): boolean;
	off(): void;
}): LibyHost<StudioEvent> {
	return {};
}

// ---- Moments: none are ever sent ----------------------------------------------------------------------

function silent(id: MomentId): Moment {
	return { id, kind: 'milestone', message: '' };
}

/** Every moment, with nothing to say. Nothing requests one (`requestMoment` is inert), so App's
 *  listener never reads these; they exist so its types hold. Spelled out, so a new checklist task
 *  fails `typecheck:public` here instead of slipping past a cast. */
export const MOMENTS: Record<MomentId, Moment> = {
	launch: silent('launch'),
	welcome: silent('welcome'),
	addConnection: silent('addConnection'),
	run: silent('run'),
	explore: silent('explore'),
	ai: silent('ai'),
	save: silent('save'),
	allDone: silent('allDone'),
};

export function messageFor(_id: string, line: string, _signIn: boolean): string {
	return line;
}

export function newlyDoneTasks(_before: Record<ChecklistTaskId, boolean>, _after: Record<ChecklistTaskId, boolean>): ChecklistTaskId[] {
	return [];
}

export function onMomentRequest(_listener: (id: MomentId) => void): () => void {
	return () => {};
}

export function requestMoment(_id: MomentId): void {}

export function shouldShowMoment(_moment: Moment, _seen: readonly MomentId[], _queued: readonly string[], _switches: MomentSwitches): boolean {
	return false;
}

export function loadIntroduced(): boolean {
	return true;
}

export function markLibyIntroduced(): void {}

export function loadMomentsSeen(): MomentId[] {
	return [];
}

export function saveMomentsSeen(_seen: MomentId[]): void {}

// ---- The help shortcut: it opens the assistant ------------------------------------------------------

/** Never asked in this build (the shortcut opens the assistant instead); a point inside the area. */
export function summonPoint(area: { right: number; top: number }, _view: { width: number; height: number }): { x: number; y: number } {
	return { x: area.right, y: area.top };
}

/** The help shortcut, as `get_shortcuts` tells the model: here it opens the assistant's panel. */
export function helpShortcutDescription(keys: string): string {
	return `${keys}, which opens this panel`;
}

/** What the Settings switch that hides the companion says it hides; never shown in this build. */
export const HIDE_SETTING_HINT = 'the companion';

// ---- The first-run tour, in the app's own words ----------------------------------------------------------

export const TOUR_COPY: Record<TourStepId, TourCopy> = {
	'welcome': { title: "Welcome to SnoutData Studio", body: "Your databases, your files and your coding agent, in one place. Want a quick tour? It takes under a minute, and you can skip anytime." },
	'activity-bar': { title: "Everything starts here", body: "This strip opens your connections, your scripts, your history and the assistant. The gear at the bottom opens Settings." },
	'add-connection': { title: "First, a database", body: "Click here to add one: Postgres, MySQL, SQL Server and plenty more, SSH tunnels included. Open it to browse its tables." },
	'editor': { title: "Where the work happens", body: "Write SQL here. It knows your schema, so completion and hover show your real tables and columns. Ctrl/Cmd-click a table name to open it." },
	'run-button': { title: "Run it", body: "Run the statement under your cursor (or whatever you've selected) with this, or Ctrl/Cmd+Enter." },
	'results': { title: "Your data lands here", body: "Sort, filter, page through and export. On a single table you can edit cells and save them back." },
	'ai-assistant': { title: "The assistant", body: "Ask in plain words. It knows your schema, so the SQL it writes fits your database, and it drops straight into the editor." },
};

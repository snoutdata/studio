/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// App-shell preferences that live in the renderer (alongside theme + layout): editor
// appearance and query-execution defaults. AI provider/model and connections are
// stored in main (ai.json / connections.json) and reached over IPC; everything here
// is pure-UI and persisted to localStorage so it survives a reload.

import { dialectFor } from '../../shared/engine';

/** How completion renders SQL keyword suggestions. `preserve` matches what you type. */
export type KeywordCase = 'preserve' | 'upper' | 'lower';

/** Where the VSCode-style activity bar sits: a left strip or a horizontal top row. */
export type ActivityBarPosition = 'side' | 'top';

export interface AppSettings {
	/** Monaco font size, in px. */
	fontSize: number;
	/** Agent console terminal font size, in px. Separate from the editor's: a terminal is read at a
	 *  different distance and holds a fixed 80-column grid, so one number for both makes one of them
	 *  wrong. Changed from Settings or with Ctrl/Cmd +/-/0 (and Ctrl+wheel) over the terminal. */
	terminalFontSize: number;
	/** Soft-wrap long lines in the editor. */
	wordWrap: boolean;
	/** Show Monaco's minimap. */
	minimap: boolean;
	/** Default row cap appended when auto-LIMIT is on. */
	defaultLimit: number;
	/** Append `LIMIT <defaultLimit>` to a bare SELECT that has none. */
	autoLimit: boolean;
	/** Require confirmation before destructive statements on `prod` connections. */
	confirmOnProd: boolean;
	/** Allow results-grid actions (edit value, copy, copy row) on `prod` connections.
	 *  Off by default: prod grids are read-only-in-place until you opt in. dev/stage always allow. */
	allowProdGridActions: boolean;
	/** Resolve foreign-key ids to a human label inline in the grid (e.g. `4815 · Acme Corp`).
	 *  On by default. Fires a small secondary lookup per FK column over the visible rows; turn
	 *  off to avoid those extra queries (the hover/right-click peek card stays available either way). */
	resolveFkLabels: boolean;
	/** Connection pre-selected on launch (id), or null to leave nothing selected. */
	defaultConnectionId: string | null;
	/** Picking a connection from a dropdown (editor or chat) connects it automatically.
	 *  When off, the dropdown only selects; the user connects from the sidebar. */
	autoConnectOnSelect: boolean;
	/** Auto-disconnect a connection after this many idle minutes (0 = never). */
	idleDisconnectMinutes: number;
	/** Reopen the non-prod connections that were open last launch. Off by default. */
	reconnectOnLaunch: boolean;
	/** Record chat-panel interactions to the AI audit log. Off by default. */
	auditLogChat: boolean;
	/** Record editor AI calls (auto-completion + inline edits) to the audit log. Off by default. */
	auditLogCompletion: boolean;
	/** Pop completions automatically as you type / on space; otherwise only on Ctrl+Space. */
	autoCompletion: boolean;
	/** Case applied to SQL keyword suggestions (`preserve` = don't change what you type). */
	keywordCase: KeywordCase;
	/** Activity bar placement: left strip (`side`) or horizontal top row (`top`). */
	activityBarPosition: ActivityBarPosition;
	/** On a document/vector connection, when the deterministic SQL→native compiler can't translate a
	 *  query, translate it with AI automatically instead of asking each time. Off by default, so the
	 *  first such query prompts for consent (every model call spends the user's AI budget). Turn on if
	 *  you'd rather never write native pipelines and accept the AI cost. */
	aiAutoTranscribe: boolean;
	/** Hide the automatic onboarding tips: the first-run spotlight tour and the getting-started
	 *  checklist (card + pill + Welcome buttons). The manual Help menu / command-palette entries
	 *  still work. Off by default. */
	disableOnboarding: boolean;
	/** Hide the companion (@snout/liby): the host reports it off, so it does nothing unasked. The
	 *  help shortcut still opens it, since that is asked for. Off by default. */
	disableMascot: boolean;
	/** Open the per-version Release Notes document automatically after an update lands on a new
	 *  version (VSCode's `update.showReleaseNotes`). On by default; the in-document checkbox and
	 *  the Settings toggle change the same value. The Help menu / command palette open it on
	 *  demand regardless. */
	showReleaseNotesAfterUpdate: boolean;
	/** While a query runs, escalate the toolbar timer to a "taking longer than expected" warning
	 *  once it has been running this many milliseconds. 0 disables the escalation (the plain timer
	 *  still shows). Default 5000. */
	slowQueryWarnMs: number;
	/** After a query completes, if it took longer than this many milliseconds, run one EXPLAIN and
	 *  surface index/scan advisories for it (Pillar 2 Tier B). 0 disables the post-run advisor.
	 *  Default 2000. */
	slowQueryAdviseMs: number;
	/** Before running a SELECT, ask the planner (one EXPLAIN) roughly how many rows it will scan, and
	 *  warn before a huge scan runs at all (the pre-flight check). The same plan also feeds the
	 *  index/scan advisor, so no second EXPLAIN. Adds one cheap EXPLAIN round-trip per SELECT (it
	 *  applies on tunnelled/prod connections too — that's where a runaway scan hurts most); turn this
	 *  off to skip it entirely. Default true. */
	preflightScan: boolean;
	/** The pre-flight warning fires when the planner estimates a scan of at least this many rows.
	 *  Default 1,000,000. */
	preflightWarnRows: number;
	/** Narrate the Data Flows wizard for somebody who has not built one before: number the steps,
	 *  name them in plain words, say what each one is for and what happens after it, and describe
	 *  what was dropped in ordinary language rather than by the evidence that identified it.
	 *  On by default, because the cost of guiding an expert is one click and the cost of not guiding
	 *  a beginner is the whole feature. Off leaves the wizard exactly as it was. */
	flowWizardGuided: boolean;
}

const STORAGE_KEY = 'positron-db.appSettings';

export const DEFAULT_APP_SETTINGS: AppSettings = {
	fontSize: 13,
	terminalFontSize: 13,
	wordWrap: false,
	minimap: false,
	defaultLimit: 200,
	autoLimit: true,
	confirmOnProd: true,
	allowProdGridActions: false,
	resolveFkLabels: true,
	defaultConnectionId: null,
	autoConnectOnSelect: true,
	idleDisconnectMinutes: 240,
	reconnectOnLaunch: false,
	auditLogChat: false,
	auditLogCompletion: false,
	autoCompletion: false,
	keywordCase: 'preserve',
	activityBarPosition: 'side',
	aiAutoTranscribe: false,
	disableOnboarding: false,
	disableMascot: false,
	showReleaseNotesAfterUpdate: true,
	slowQueryWarnMs: 5000,
	slowQueryAdviseMs: 2000,
	preflightScan: true,
	preflightWarnRows: 1_000_000,
	flowWizardGuided: true,
};

export function loadAppSettings(): AppSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const stored = JSON.parse(raw) as Partial<AppSettings> & { auditLogEnabled?: boolean };
			// Migrate the former single audit toggle into the per-kind pair.
			if (stored.auditLogEnabled !== undefined && stored.auditLogChat === undefined && stored.auditLogCompletion === undefined) {
				stored.auditLogChat = stored.auditLogEnabled;
				stored.auditLogCompletion = stored.auditLogEnabled;
			}
			return { ...DEFAULT_APP_SETTINGS, ...stored };
		}
	} catch {
		// ignore malformed storage
	}
	return { ...DEFAULT_APP_SETTINGS };
}

/**
 * Settings that belong to THIS machine and never travel with the account's synced preferences
 * (settingsSync.ts). Hiding Liby is the one that made this necessary: an e2e run against the
 * signed-in test profile seeds `disableMascot: true` so she is not in front of what a spec clicks,
 * and the sync pushed that to the real account, so every installation that pulled it lost her
 * with no act of its user. She is switched off only where somebody switched her off.
 */
export const LOCAL_ONLY_SETTINGS = ['disableMascot'] as const;
export type LocalOnlySetting = typeof LOCAL_ONLY_SETTINGS[number];
export type SyncedAppSettings = Omit<AppSettings, LocalOnlySetting>;

/** The part of the settings that syncs: everything but {@link LOCAL_ONLY_SETTINGS}. Also strips
 *  them from a blob an older client wrote, which still carries them. */
export function syncedAppSettings(settings: Partial<AppSettings>): SyncedAppSettings {
	const out: Partial<AppSettings> = { ...settings };
	for (const key of LOCAL_ONLY_SETTINGS) {
		delete out[key];
	}
	return out as SyncedAppSettings;
}

/** Adopt the account's synced settings while keeping this machine's own local-only values. */
export function adoptSyncedAppSettings(local: AppSettings, remote: Partial<AppSettings>): AppSettings {
	const merged: AppSettings = { ...DEFAULT_APP_SETTINGS, ...syncedAppSettings(remote) };
	for (const key of LOCAL_ONLY_SETTINGS) {
		keepLocal(merged, local, key);
	}
	return merged;
}

function keepLocal<K extends LocalOnlySetting>(to: AppSettings, from: AppSettings, key: K): void {
	to[key] = from[key];
}

/** The size range the terminal is legible in, shared by Settings, the zoom keys and the capability. */
export const TERMINAL_FONT_MIN = 8;
export const TERMINAL_FONT_MAX = 32;

/** Clamp a terminal font size to the supported range, rounding away a fractional wheel step. */
export function clampTerminalFontSize(size: number): number {
	if (!Number.isFinite(size)) {
		return DEFAULT_APP_SETTINGS.terminalFontSize;
	}
	return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

export function saveAppSettings(settings: AppSettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// ignore write failures (private mode, quota)
	}
}

/** Monaco editor options derived from the prefs. When auto-completion is off, both
 *  as-you-type and trigger-character popups are disabled — Ctrl+Space still works. */
export function editorOptions(settings: AppSettings): {
	fontSize: number;
	wordWrap: 'on' | 'off';
	minimap: { enabled: boolean };
	quickSuggestions: boolean;
	suggestOnTriggerCharacters: boolean;
} {
	return {
		fontSize: settings.fontSize,
		wordWrap: settings.wordWrap ? 'on' : 'off',
		minimap: { enabled: settings.minimap },
		quickSuggestions: settings.autoCompletion,
		suggestOnTriggerCharacters: settings.autoCompletion,
	};
}

/** Cap a bare single SELECT when auto-LIMIT is enabled. Conservative: only touches a lone
 *  SELECT with no existing cap and no trailing semicolon noise. The row-cap clause is dialect
 *  specific (SQL Server `TOP n`, Oracle `FETCH FIRST n ROWS ONLY`, MySQL/Postgres trailing
 *  `LIMIT n`) and comes from the central dialect strategy. */
export function withAutoLimit(sql: string, settings: AppSettings, driver?: string): string {
	if (!settings.autoLimit) {
		return sql;
	}
	const trimmed = sql.trim().replace(/;\s*$/, '');
	if (!/^select\b/i.test(trimmed)) {
		return sql;
	}
	const dialect = dialectFor(driver);
	// Already capped?
	if (dialect.hasLimit(trimmed)) {
		return sql;
	}
	// Bail if it looks like multiple statements.
	if (trimmed.includes(';')) {
		return sql;
	}
	return `${dialect.limitClause(trimmed, settings.defaultLimit)};`;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState, type InputHTMLAttributes } from 'react';
import { hideSettingHint, LIBY_AVAILABLE } from '@snout/liby/studio';
import { PRO_AVAILABLE } from '@snout/studio-pro/renderer';
import { ASSISTANT_INTRO, ASSISTANT_NAME } from '../../../shared/assistant';
import { Icon } from './Icon';
import { AgentAccessArt, ConnectArt, HistoryArt, KeysArt, KnowledgeArt, NetworkArt, PageMark, PrivacyArt, ResetArt, hasPageMark } from '../art/Illustrations';
import { SettingsIntro } from './SettingsIntro';
import { ReviewSettings } from './ReviewSettings';
import { formatShortcut } from '../shortcuts';
import { conflictingIds, eventToCombo, normalizeCombo, reservedHint, KEYBINDINGS, type ResolvedKeybinding } from '../../../shared/keybindings';
import { useConfirm } from './ConfirmDialog';
import { AccountSection } from './AccountSection';
import type { ConnectionConfig } from '../../../shared/connection';
import { GLOBAL_CONNECTION, type KnowledgeNote, type KnowledgeScope } from '../../../shared/knowledge';
import { BYOK_PROVIDER_DEFAULTS, DEFAULT_AI_SETTINGS } from '../../../shared/ai';
import { DATA_ACCESS_LEVELS, dataAccessText, effectiveDataAccess, type DataAccessLevel } from '../../../shared/engine';
import type { AiAuditEntry, AiAuditKind, AiBudgetStatus, AiProviderId, AiProviderStatus, AiSettings, AiSettingsFormValues, ByokProviderId, InlineCompletionMode } from '../../../shared/ai';
import type { AuthProviderId, AuthState, Entitlements } from '../../../shared/auth';
import { MCP_SERVER_NAME, mcpConfigSnippet, mcpProblemNotice, type McpProblem, type McpStatus } from '../../../shared/mcp';
import { agentHouseRules } from '../../../shared/agentHouseRules';
import { AGENT_KINDS, agentDescriptor, type AgentConsoleConfig, type AgentConsoleStatus } from '../../../shared/agentConsole';
import { DEFAULT_PROXY_CONFIG, type ProxyConfig, type ProxyMode, type ProxyStatus, type ProxyTestResult } from '../../../shared/proxy';
import { TERMINAL_FONT_MAX, TERMINAL_FONT_MIN } from '../appSettings';
import type { ActivityBarPosition, AppSettings, KeywordCase } from '../appSettings';
import { THEMES, type Theme } from '../theme';
import { setSyncEnabled, syncEnabled } from '../settingsSync';
import { OFFICIAL_BUILD } from '../../../shared/officialBuild';
import { CloudAccountsSection } from './CloudAccountSettings';
import { DataGenerationSection, ExtractionModelSection, PRO_SETTING_ENTRIES } from '@snout/studio-pro/settings';
import type { ProEnginePage } from '../proSeam';
import { useSecretsWeak } from '../secretsPlace';
import { formatLocale, LOCALES, rich, useI18n, useT, type LanguagePreference, type Translate } from '../i18n';
import { translate } from '../../../shared/i18n/core';
import { lazyView } from '../lazyView';

// Both fetched the first time their page opens.
const MoveKeysPanel = lazyView(() => import('./MoveKeysPanel').then((mod) => ({ default: mod.MoveKeysPanel })));
const AgentAiRouteSettings = lazyView(() => import('./AgentAiRouteSettings').then((mod) => ({ default: mod.AgentAiRouteSettings })));

export type SettingsTab = 'account' | 'appearance' | 'editor' | 'ai' | 'datagen' | 'extractmodel' | 'audit' | 'agent' | 'knowledge' | 'snoutbot' | 'connections' | 'cloud' | 'network' | 'privacy' | 'shortcuts' | 'reset';

/** Which categories a "Reset settings" run should wipe. */
export interface ResetOptions {
	/** Window + pane sizing (sidebar/results/chat widths, collapsed state). */
	layout: boolean;
	/** Editor & appearance preferences + theme, back to defaults. */
	preferences: boolean;
	/** All saved connections and their stored credentials. */
	connections: boolean;
	/** Query history and saved queries. */
	queries: boolean;
	/** AI chat history (saved sessions). */
	chats: boolean;
	/** AI audit log. */
	audit: boolean;
}

interface SettingsModalProps {
	initialTab?: SettingsTab;
	/** Which page WITHIN that tab to open on, for the tabs that have their own (only Extraction
	 *  Model does). A signpost that lands somebody on a page and leaves them to find the sub-tab is
	 *  a signpost that points at a building rather than at a door. */
	initialPage?: ProEnginePage;
	appSettings: AppSettings;
	/** Resolved entitlements for the signed-in tier, for gating tier-locked settings. */
	entitlements: Entitlements;
	/** Full auth state (account + tier), for the Account tab. */
	auth: AuthState;
	/** True while a sign-in/out round-trip is in flight (Account buttons disabled). */
	authBusy: boolean;
	/** Why the last sign-in did not start, or null. */
	signInError: string | null;
	onSignIn(provider: AuthProviderId, workEmail?: string): void;
	onSignOut(): void;
	onCancelSignIn(): void;
	onAppSettingsChange(next: AppSettings): void;
	theme: Theme;
	onSelectTheme(id: Theme): void;
	/** Whether any panel has been moved or resized away from the default. */
	panelsMoved: boolean;
	/** Put every panel back where it starts, at its starting size. */
	onResetPanels(): void;
	connections: ConnectionConfig[];
	connectedIds: string[];
	/** The connection the active tab is grounded on, so the Knowledge tab opens on it by default. */
	activeConnectionId?: string;
	onAddConnection(): void;
	onEditConnection(config: ConnectionConfig): void;
	onDeleteConnection(config: ConnectionConfig): void;
	onConnect(id: string): void;
	onDisconnect(id: string): void;
	/** Wipe the selected categories back to defaults. */
	onReset(options: ResetOptions): Promise<void>;
	/** Saved the AI settings — so the app re-reads them live (e.g. the inline-completion
	 *  toggle) instead of only on close. */
	onAiSaved?(): void;
	/** Close settings and show the Data Flows view. The extraction model's record cannot fill in
	 *  until a flow has run, and a page that says so without a way there is a dead end. */
	onOpenFlows?(): void;
	/** Close settings and show Snoutbot's reviews. The pane is where the feature is set up; the
	 *  reviews it produces live in their own tab, and a setup screen with no way to the result is
	 *  a setup screen people configure once and never come back to. */
	onOpenReviews?(): void;
	onClose(): void;
}

/** Nav entries grouped into sections (a blank line is drawn between groups, VSCode-style).
 *  Each carries a Codicon for a quick visual anchor. */
const TAB_GROUPS: Array<Array<{ id: SettingsTab; labelKey: string; icon: string }>> = [
	[
		{ id: 'account', labelKey: 'settings.tabs.account', icon: 'account' },
		{ id: 'appearance', labelKey: 'settings.tabs.appearance', icon: 'symbol-color' },
		{ id: 'editor', labelKey: 'settings.tabs.editor', icon: 'edit' },
	],
	[
		{ id: 'ai', labelKey: 'settings.tabs.ai', icon: 'sparkle' },
		{ id: 'datagen', labelKey: 'settings.tabs.datagen', icon: 'beaker' },
		{ id: 'extractmodel', labelKey: 'settings.tabs.extractmodel', icon: 'circuit-board' },
		{ id: 'audit', labelKey: 'settings.tabs.audit', icon: 'history' },
		{ id: 'agent', labelKey: 'settings.tabs.agent', icon: 'remote' },
		{ id: 'knowledge', labelKey: 'settings.tabs.knowledge', icon: 'lightbulb' },
		{ id: 'snoutbot', labelKey: 'settings.tabs.snoutbot', icon: 'git-pull-request' },
	],
	[
		{ id: 'connections', labelKey: 'settings.tabs.connections', icon: 'database' },
		{ id: 'cloud', labelKey: 'settings.tabs.cloud', icon: 'cloud' },
		{ id: 'network', labelKey: 'settings.tabs.network', icon: 'globe' },
	],
	[
		{ id: 'privacy', labelKey: 'settings.tabs.privacy', icon: 'shield' },
	],
	[
		{ id: 'shortcuts', labelKey: 'settings.tabs.shortcuts', icon: 'keyboard' },
		{ id: 'reset', labelKey: 'settings.tabs.reset', icon: 'discard' },
	],
];

const TABS = TAB_GROUPS.flat();

/** One searchable setting inside a tab. `labelKey` is the catalog key of the control's own text,
 *  so its translation is by construction a substring of what the control renders (that's how the
 *  reveal below finds it in the DOM, in any language); `label` is plain text for the entries Data
 *  Flows brings. `keywords` stays English: the words people actually type but that don't appear in
 *  the label ("gpu", "telemetry", "fk"). */
interface SettingEntry {
	tab: SettingsTab;
	labelKey?: string;
	label?: string;
	keywords?: string;
}

/** Settings pages that are Data Flows', shown only in a build that has it. */
const PRO_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>(['datagen', 'extractmodel']);

function tabShown(id: SettingsTab): boolean {
	return PRO_AVAILABLE || !PRO_TABS.has(id);
}

/** The index the settings search matches against, so typing "gpu" or "proxy" finds the control
 *  and not just the tab. Keep in sync when adding a setting: the label here is matched against
 *  the rendered label text to scroll to it. The Shortcuts entries are derived, so they never rot.
 *  Data Flows' pages bring their own entries (none in a build without it). */
const SETTING_INDEX: SettingEntry[] = [
	{ tab: 'appearance', labelKey: 'settings.language.label', keywords: 'idioma langue lengua translation locale' },
	{ tab: 'appearance', labelKey: 'settings.appearance.theme', keywords: 'dark light color scheme' },
	{ tab: 'appearance', labelKey: 'settings.appearance.activityBarPosition', keywords: 'sidebar top side' },
	{ tab: 'appearance', labelKey: 'settings.appearance.resetPanelLayout', keywords: 'panels move dock left right bottom position sidebar assistant console default' },
	{ tab: 'appearance', labelKey: 'settings.appearance.editorFontSize', keywords: 'text size zoom' },
	{ tab: 'appearance', labelKey: 'settings.appearance.terminalFontSize', keywords: 'agent console terminal text size zoom claude code codex opencode' },
	{ tab: 'appearance', labelKey: 'settings.appearance.wordWrap' },
	{ tab: 'appearance', labelKey: 'settings.appearance.showMinimap' },
	{ tab: 'appearance', labelKey: 'settings.appearance.disableOnboarding', keywords: 'tour checklist getting started welcome' },
	{ tab: 'appearance', labelKey: 'settings.appearance.showReleaseNotes', keywords: "what's new changelog" },
	{ tab: 'appearance', labelKey: 'settings.appearance.gpuToggle', keywords: 'gpu graphics rendering crash blank flicker' },

	{ tab: 'editor', labelKey: 'settings.editor.autoCompletion', keywords: 'autocomplete intellisense suggest' },
	{ tab: 'editor', labelKey: 'settings.editor.keywordCase', keywords: 'uppercase lowercase select' },
	{ tab: 'editor', labelKey: 'settings.editor.autoLimit' },
	{ tab: 'editor', labelKey: 'settings.editor.defaultLimit', keywords: 'rows' },
	{ tab: 'editor', labelKey: 'settings.editor.transcribe', keywords: 'mongo document transcribe' },
	{ tab: 'editor', labelKey: 'settings.editor.confirmOnProd', keywords: 'guard safety drop delete production' },
	{ tab: 'editor', labelKey: 'settings.editor.allowGridActions', keywords: 'edit value copy row prod production grid' },
	{ tab: 'editor', labelKey: 'settings.editor.resolveFk', keywords: 'fk lookup peek' },
	{ tab: 'editor', labelKey: 'settings.editor.autoConnect' },
	{ tab: 'editor', labelKey: 'settings.editor.preflightScan', keywords: 'preflight explain scan large dataset' },
	{ tab: 'editor', labelKey: 'settings.editor.warnAbove', keywords: 'preflight threshold' },
	{ tab: 'editor', labelKey: 'settings.editor.warnSlow', keywords: 'slow long running timeout' },
	{ tab: 'editor', labelKey: 'settings.editor.adviseAfter', keywords: 'index advice slow' },
	{ tab: 'editor', labelKey: 'settings.editor.defaultConnection', keywords: 'startup' },
	{ tab: 'editor', labelKey: 'settings.editor.idleDisconnect', keywords: 'idle timeout' },
	{ tab: 'editor', labelKey: 'settings.editor.reconnect', keywords: 'reconnect restore startup' },

	{ tab: 'ai', labelKey: 'settingsAi.provider', keywords: 'model source cloud byok openai anthropic openrouter' },
	{ tab: 'ai', labelKey: 'settingsAi.apiKey', keywords: 'token byok credentials' },
	{ tab: 'ai', labelKey: 'settingsAi.addModel', keywords: 'byok catalogue' },
	{ tab: 'ai', labelKey: 'settingsAi.baseUrl', keywords: 'byok endpoint gateway' },
	{ tab: 'ai', labelKey: 'settingsAi.extraInstructions', keywords: 'tone conventions system prompt' },
	{ tab: 'ai', labelKey: 'settingsAi.topTables', keywords: 'schema linking prompt context' },
	{ tab: 'ai', labelKey: 'settingsAi.maxSchemaChars', keywords: 'prompt budget context' },
	{ tab: 'ai', labelKey: 'settingsAi.autoInsertSql' },
	{ tab: 'ai', labelKey: 'settings.search.assistantTools', keywords: 'tools agent agentic inspect database' },
	{ tab: 'ai', labelKey: 'settingsAi.listTables', keywords: 'tool agentic' },
	{ tab: 'ai', labelKey: 'settingsAi.describeTable', keywords: 'tool agentic columns keys indexes' },
	{ tab: 'ai', labelKey: 'settingsAi.searchColumns', keywords: 'tool agentic' },
	{ tab: 'ai', labelKey: 'settingsAi.runQueries', keywords: 'tool agentic approve' },
	{ tab: 'ai', labelKey: 'settingsAi.maxSteps', keywords: 'agentic' },
	{ tab: 'ai', labelKey: 'settingsAi.maxRows', keywords: 'agentic tool' },
	{ tab: 'ai', labelKey: 'settingsAi.enableCompletion', keywords: 'ghost text inline fim tab autocomplete' },
	{ tab: 'ai', labelKey: 'settingsAi.trigger', keywords: 'inline completion manual automatic' },
	{ tab: 'ai', labelKey: 'settingsAi.completionModel', keywords: 'fim snout complete inline' },

	...PRO_SETTING_ENTRIES,

	{ tab: 'audit', labelKey: 'settings.search.recordChats', keywords: 'audit log history actions tools capabilities' },
	{ tab: 'audit', labelKey: 'settings.audit.recordCompletion', keywords: 'audit log fim' },

	{ tab: 'agent', labelKey: 'settingsAgent.allowAccess', keywords: 'mcp claude code local server' },
	{ tab: 'agent', labelKey: 'settingsAgent.letProgramUse', keywords: 'cli snoutdata sign in token handoff terminal command line' },
	{ tab: 'agent', labelKey: 'settingsAgent.connectionsLegend', keywords: 'mcp expose allowlist' },
	{ tab: 'agent', labelKey: 'settingsAgent.allowWrites', keywords: 'mcp insert update delete ddl' },
	{ tab: 'agent', labelKey: 'settingsAgent.letChangeApp', keywords: 'capabilities app actions mutating approve open tab setting' },
	{ tab: 'agent', labelKey: 'settingsAgent.agentsLegend', keywords: 'claude code codex opencode console terminal agent' },

	{ tab: 'knowledge', labelKey: 'settings.knowledge.appliesTo', keywords: 'connection scope notes' },
	{ tab: 'knowledge', labelKey: 'settings.knowledge.scope', keywords: 'database table column note' },

	{ tab: 'connections', labelKey: 'settings.search.addConnection', keywords: 'new database server' },
	{ tab: 'cloud', labelKey: 'settings.search.addCloudAccount', keywords: 'aws amazon azure google gcp s3 bucket cloudwatch logs object storage r2 minio backblaze wasabi data flow source credential' },
	{ tab: 'cloud', labelKey: 'settings.search.accessKeyId', keywords: 'aws s3 cloudwatch credentials bucket secret key' },
	{ tab: 'cloud', labelKey: 'settings.search.importProfile', keywords: 'aws cli profile sso named credential adopt' },
	{ tab: 'cloud', labelKey: 'cloudAccounts.endpoint', keywords: 's3 compatible r2 minio backblaze wasabi ceph bucket' },
	{ tab: 'cloud', labelKey: 'cloudAccounts.region', keywords: 'aws s3 bucket cloudwatch log group' },

	{ tab: 'network', labelKey: 'settings.network.proxyLegend', keywords: 'corporate zscaler network system' },
	{ tab: 'network', labelKey: 'settings.network.pacUrl', keywords: 'proxy auto-config script wpad' },
	{ tab: 'network', labelKey: 'settings.network.proxyServer', keywords: 'manual host port' },
	{ tab: 'network', labelKey: 'settings.network.bypass', keywords: 'proxy no_proxy localhost' },
	{ tab: 'network', labelKey: 'settings.network.signIn', keywords: 'username password credentials kerberos' },

	{ tab: 'privacy', labelKey: 'settings.privacy.sendReports', keywords: 'telemetry sentry analytics usage activity install id heartbeat account opt out' },
	{ tab: 'privacy', labelKey: 'settings.privacy.syncToggle', keywords: 'settings sync cloud account' },

	{ tab: 'reset', labelKey: 'settings.reset.items.layout', keywords: 'reset layout' },
	{ tab: 'reset', labelKey: 'settings.reset.items.preferences', keywords: 'reset defaults' },
	{ tab: 'reset', labelKey: 'settings.reset.items.connections', keywords: 'reset delete' },
	{ tab: 'reset', labelKey: 'settings.reset.items.queries', keywords: 'reset clear' },
	{ tab: 'reset', labelKey: 'settings.reset.items.chats', keywords: 'reset clear ai chat history' },
	{ tab: 'reset', labelKey: 'settings.reset.items.audit', keywords: 'reset clear' },

	...KEYBINDINGS.map((k): SettingEntry => ({ tab: 'shortcuts', labelKey: `settings.shortcuts.commands.${k.id}`, keywords: 'keybinding shortcut key' })),
];

/** The entry's label in the current language: the text the control renders, so the reveal finds it. */
function entryLabel(entry: SettingEntry, translator: Translate): string {
	return entry.labelKey ? translator(entry.labelKey, { assistant: ASSISTANT_NAME }) : entry.label ?? '';
}

/** A search hits the translated label, the English label, or the English keywords, so an English
 *  word still finds a setting in every language. */
function settingMatches(entry: SettingEntry, label: string, query: string): boolean {
	return label.toLowerCase().includes(query)
		|| (entry.labelKey !== undefined && translate('en', entry.labelKey, { assistant: ASSISTANT_NAME }).toLowerCase().includes(query))
		|| (entry.keywords?.includes(query) ?? false);
}

/** The elements a setting's label can live on, for the scroll-to-and-flash reveal. */
const REVEAL_SELECTOR = 'label, legend, h4, .shortcut-row, .settings-conn-row';

// Only the gateway is user-selectable for now. Local Ollama is intentionally omitted
// (kept in the model, not offered in the picker).
function providerLabels(translator: Translate): Partial<Record<AiProviderId, string>> {
	const byok = (id: ByokProviderId): string => translator('settingsAi.byokProviderLabel', { name: BYOK_PROVIDER_DEFAULTS[id].label });
	return {
		'positron-cloud': 'SnoutData Cloud',
		'byok-openai': byok('byok-openai'),
		'byok-openrouter': byok('byok-openrouter'),
		'byok-anthropic': byok('byok-anthropic'),
	};
}

/** The BYOK providers, in display order. */
const BYOK_IDS: ByokProviderId[] = ['byok-openai', 'byok-openrouter', 'byok-anthropic'];


export function SettingsModal(props: SettingsModalProps): JSX.Element {
	const { t, preference, setPreference } = useI18n();
	const [tab, setTab] = useState<SettingsTab>(props.initialTab ?? 'appearance');
	const [navFilter, setNavFilter] = useState('');
	// The setting to scroll to and flash once its tab has rendered. The nonce lets the same
	// setting be revealed again on a second click.
	const [reveal, setReveal] = useState<{ label: string; labelKey?: string; nonce: number } | null>(null);
	const { appSettings, onAppSettingsChange, onClose } = props;
	// A Linux desktop with no password vault saves passwords in a file instead (main/secretStorageMode.ts);
	// the Connections page says so, since its own sentence would otherwise promise a keychain.
	const secretsWeak = useSecretsWeak();

	const activeTabLabel = t(TABS.find((entry) => entry.id === tab)?.labelKey ?? 'settings.tabs.appearance');
	const navQuery = navFilter.trim().toLowerCase();
	const hits = new Map<SettingsTab, SettingEntry[]>();
	if (navQuery) {
		for (const entry of SETTING_INDEX) {
			if (tabShown(entry.tab) && settingMatches(entry, entryLabel(entry, t), navQuery)) {
				const list = hits.get(entry.tab);
				if (list) {
					list.push(entry);
				} else {
					hits.set(entry.tab, [entry]);
				}
			}
		}
	}
	const groups = TAB_GROUPS
		.map((group) => group.filter((entry) => tabShown(entry.id) && (!navQuery || t(entry.labelKey).toLowerCase().includes(navQuery) || translate('en', entry.labelKey).toLowerCase().includes(navQuery) || hits.has(entry.id))))
		.filter((group) => group.length > 0);

	function openSetting(target: SettingsTab, entry: SettingEntry): void {
		setTab(target);
		setReveal((prev) => ({ label: entryLabel(entry, t), labelKey: entry.labelKey, nonce: (prev?.nonce ?? 0) + 1 }));
	}

	// Scroll the revealed setting into view and flash it. Matching on the rendered text keeps
	// this working without threading an id through every control.
	useEffect(() => {
		if (!reveal) {
			return;
		}
		let hit: HTMLElement | null = null;
		// A frame, so the newly selected tab's content is in the DOM.
		const raf = requestAnimationFrame(() => {
			const root = document.querySelector('.settings-content');
			if (!root) {
				return;
			}
			const needle = reveal.label.toLowerCase();
			for (const el of Array.from(root.querySelectorAll<HTMLElement>(REVEAL_SELECTOR))) {
				if ((el.textContent ?? '').toLowerCase().includes(needle)) {
					hit = el;
					break;
				}
			}
			if (hit) {
				hit.scrollIntoView({ block: 'center' });
				hit.classList.add('settings-hit');
			}
		});
		const timer = window.setTimeout(() => hit?.classList.remove('settings-hit'), 1600);
		return () => {
			cancelAnimationFrame(raf);
			window.clearTimeout(timer);
			hit?.classList.remove('settings-hit');
		};
	}, [reveal, tab]);

	function patch(part: Partial<AppSettings>): void {
		onAppSettingsChange({ ...appSettings, ...part });
	}

	// Close on Escape (VSCode-style); no click-outside dismissal — edits aren't lost
	// by an accidental click on the rest of the app.
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				onClose();
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);

	return (
		<div className="settings-page">
			<div className="settings-titlebar">
				<h2><PageMark art="settings" text={t('settings.title')} /></h2>
				<span className="spacer" />
				<button className="icon-btn" aria-label={t('settings.nav.closeEsc')} onClick={onClose}><Icon name="close" /></button>
			</div>
			<div className="settings-main">
				<nav className="settings-nav">
					<div className="settings-nav-search">
						<Icon name="search" />
						<input
							type="text"
							placeholder={t('settings.nav.search')}
							value={navFilter}
							onChange={(e) => setNavFilter(e.target.value)}
						/>
						{navFilter && <button className="icon-btn" aria-label={t('settings.nav.clear')} onClick={() => setNavFilter('')}><Icon name="close" /></button>}
					</div>
					{groups.length === 0 && <div className="muted small settings-nav-empty">{t('settings.nav.noMatches')}</div>}
					{groups.map((group, gi) => (
						<div className="settings-nav-group" key={gi}>
							{group.map((entry) => {
								const matched = hits.get(entry.id) ?? [];
								return (
									<div key={entry.id}>
										<button
											className={`settings-nav-item${tab === entry.id ? ' active' : ''}`}
											onClick={() => matched.length > 0 ? openSetting(entry.id, matched[0]) : setTab(entry.id)}
										>
											<Icon name={entry.icon} className="settings-nav-icon" />
											<span>{t(entry.labelKey)}</span>
											{matched.length > 0 && <span className="settings-nav-count">{matched.length}</span>}
										</button>
										{matched.map((s) => (
											<button key={s.labelKey ?? s.label} className="settings-nav-subitem" title={entryLabel(s, t)} onClick={() => openSetting(entry.id, s)}>
												{entryLabel(s, t)}
											</button>
										))}
									</div>
								);
							})}
						</div>
					))}
				</nav>
				<div className="settings-content">
					<h3 className="settings-section-title">
						{/* The pages with no spot drawing of their own get the website's page mark instead.
						    Account only once signed in: signed out, it already opens on a drawing. */}
						{hasPageMark(tab) && (tab !== 'account' || props.auth.user !== null)
							? <PageMark art={tab} text={activeTabLabel} />
							: activeTabLabel}
					</h3>
					{tab === 'account' && (
						<AccountSection
							auth={props.auth}
							busy={props.authBusy}
							signInError={props.signInError}
							onSignIn={props.onSignIn}
							onSignOut={props.onSignOut}
							onCancelSignIn={props.onCancelSignIn}
						/>
					)}
					{tab === 'appearance' && (
						/* Grouped, like every other tab: eight unrelated controls in one flat column gave the
						   eye nothing to sort "how the app looks" from "what happens on launch". */
						<>
							<fieldset>
								<legend>{t('settings.appearance.legend')}</legend>
								<label>{t('settings.language.label')}
									<select value={preference} data-test="settings-language" onChange={(e) => setPreference(e.target.value as LanguagePreference)}>
										<option value="system">{t('settings.language.system')}</option>
										{LOCALES.map((entry) => <option key={entry.code} value={entry.code}>{entry.native}</option>)}
									</select>
								</label>
								<label>{t('settings.appearance.theme')}
									<select value={props.theme} onChange={(e) => props.onSelectTheme(e.target.value)}>
										{THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.label}</option>)}
									</select>
								</label>
								<label>{t('settings.appearance.activityBarPosition')}
									<select value={appSettings.activityBarPosition} onChange={(e) => patch({ activityBarPosition: e.target.value as ActivityBarPosition })}>
										<option value="side">{t('settings.appearance.sideLeft')}</option>
										<option value="top">{t('settings.appearance.top')}</option>
									</select>
								</label>
							</fieldset>
							<fieldset>
								<legend>{t('settings.appearance.panelsLegend')}</legend>
								<div className="muted">{t('settings.appearance.panelsHelp')}</div>
								<div className="settings-row-action">
									<button type="button" disabled={!props.panelsMoved} onClick={props.onResetPanels}>
										<Icon name="discard" /> {t('settings.appearance.resetPanelLayout')}
									</button>
									{!props.panelsMoved && <span className="muted">{t('settings.appearance.alreadyDefault')}</span>}
								</div>
							</fieldset>
							<fieldset>
								<legend>{t('settings.appearance.editorLegend')}</legend>
								<label>{t('settings.appearance.editorFontSize')}
									<NumberField min={9} max={28} fallback={13} value={appSettings.fontSize} onCommit={(n) => patch({ fontSize: n })} />
								</label>
								<label className="check"><input type="checkbox" checked={appSettings.wordWrap} onChange={(e) => patch({ wordWrap: e.target.checked })} /> {t('settings.appearance.wordWrap')}</label>
								<label className="check"><input type="checkbox" checked={appSettings.minimap} onChange={(e) => patch({ minimap: e.target.checked })} /> {t('settings.appearance.showMinimap')}</label>
							</fieldset>
							<fieldset>
								<legend>{t('settings.appearance.terminalLegend')}</legend>
								<label>{t('settings.appearance.terminalFontSize')}
									<NumberField min={TERMINAL_FONT_MIN} max={TERMINAL_FONT_MAX} fallback={13} value={appSettings.terminalFontSize} onCommit={(n) => patch({ terminalFontSize: n })} />
								</label>
								<div className="muted">{t('settings.appearance.terminalHelp')}</div>
							</fieldset>
							<fieldset>
								<legend>{t('settings.appearance.startupLegend')}</legend>
								<label className="check"><input type="checkbox" checked={appSettings.disableOnboarding} onChange={(e) => patch({ disableOnboarding: e.target.checked })} /> {t('settings.appearance.disableOnboarding')} {t('settings.appearance.disableOnboardingHint')}</label>
								<div className="muted">{t('settings.appearance.tourHelp')}</div>
								{LIBY_AVAILABLE && (
									<label className="check"><input type="checkbox" checked={appSettings.disableMascot} onChange={(e) => patch({ disableMascot: e.target.checked })} /> {t('settings.appearance.hideHelper', { assistant: ASSISTANT_NAME, hint: hideSettingHint() })}</label>
								)}
								<label className="check"><input type="checkbox" checked={appSettings.showReleaseNotesAfterUpdate} onChange={(e) => patch({ showReleaseNotesAfterUpdate: e.target.checked })} /> {t('settings.appearance.showReleaseNotes')}</label>
							</fieldset>
							<fieldset>
								<legend>{t('settings.appearance.graphicsLegend')}</legend>
								<HardwareAccelerationSetting />
							</fieldset>
						</>
					)}

					{tab === 'editor' && (
						/* Grouped and set side by side: seventeen settings in one flat column meant scrolling past
						   the ones about typing to reach the ones about connections, with no seam between them. */
						<div className="settings-grid">
							<div className="settings-col">
								<fieldset>
									<legend>{t('settings.editor.editingLegend')}</legend>
									<label className="check"><input type="checkbox" checked={appSettings.autoCompletion} onChange={(e) => patch({ autoCompletion: e.target.checked })} /> {t('settings.editor.autoCompletion')} {t('settings.editor.autoCompletionHint', { shortcut: formatShortcut('Ctrl+Space') })}</label>
									<label>{t('settings.editor.keywordCase')}
										<select value={appSettings.keywordCase} onChange={(e) => patch({ keywordCase: e.target.value as KeywordCase })}>
											<option value="preserve">{t('settings.editor.matchWhatIType')}</option>
											<option value="upper">{t('settings.editor.upper')}</option>
											<option value="lower">{t('settings.editor.lower')}</option>
										</select>
									</label>
								</fieldset>

								<fieldset>
									<legend>{t('settings.editor.runningLegend')}</legend>
									<label className="check"><input type="checkbox" checked={appSettings.autoLimit} onChange={(e) => patch({ autoLimit: e.target.checked })} /> {t('settings.editor.autoLimit')}</label>
									<label>{t('settings.editor.defaultLimit')}
										<NumberField min={1} max={100000} fallback={100} value={appSettings.defaultLimit} onCommit={(n) => patch({ defaultLimit: n })} />
									</label>
									<label className="check"><input type="checkbox" checked={appSettings.aiAutoTranscribe} onChange={(e) => patch({ aiAutoTranscribe: e.target.checked })} /> {t('settings.editor.transcribe', { assistant: ASSISTANT_NAME })}</label>
									<div className="muted">{t('settings.editor.transcribeHelp')}</div>
								</fieldset>

								<fieldset>
									<legend>{t('settings.editor.resultsLegend')}</legend>
									<label className="check"><input type="checkbox" checked={appSettings.confirmOnProd} onChange={(e) => patch({ confirmOnProd: e.target.checked })} /> {t('settings.editor.confirmOnProd')}</label>
									<label className="check"><input type="checkbox" checked={appSettings.allowProdGridActions} onChange={(e) => patch({ allowProdGridActions: e.target.checked })} /> {t('settings.editor.allowGridActions')} {t('settings.editor.allowGridActionsHint')}</label>
									<label className="check"><input type="checkbox" checked={appSettings.resolveFkLabels} onChange={(e) => patch({ resolveFkLabels: e.target.checked })} /> {t('settings.editor.resolveFk')}</label>
									<div className="muted">{t('settings.editor.resolveFkHelp')}</div>
								</fieldset>
							</div>

							<div className="settings-col">
								<fieldset>
									<legend>{t('settings.editor.largeLegend')}</legend>
									<label className="check"><input type="checkbox" checked={appSettings.preflightScan} onChange={(e) => patch({ preflightScan: e.target.checked })} /> {t('settings.editor.preflightScan')}</label>
									<div className="muted">{t('settings.editor.preflightHelp')}</div>
									<label>{t('settings.editor.warnAbove')}
										<NumberField min={1000} max={1000000000} fallback={1000000} value={appSettings.preflightWarnRows} onCommit={(n) => patch({ preflightWarnRows: n })} />
									</label>
									<label>{t('settings.editor.warnSlow')}
										<NumberField min={0} max={600000} fallback={5000} value={appSettings.slowQueryWarnMs} onCommit={(n) => patch({ slowQueryWarnMs: n })} />
									</label>
									<label>{t('settings.editor.adviseAfter')}
										<NumberField min={0} max={600000} fallback={2000} value={appSettings.slowQueryAdviseMs} onCommit={(n) => patch({ slowQueryAdviseMs: n })} />
									</label>
									<div className="muted">{t('settings.editor.thresholdsHelp')}</div>
								</fieldset>

								<fieldset>
									<legend>{t('settings.editor.connectionsLegend')}</legend>
									<label className="check"><input type="checkbox" checked={appSettings.autoConnectOnSelect} onChange={(e) => patch({ autoConnectOnSelect: e.target.checked })} /> {t('settings.editor.autoConnect')}</label>
									<div className="muted">{t('settings.editor.autoConnectHelp')}</div>
									<label>{t('settings.editor.defaultConnection')}
										<select value={appSettings.defaultConnectionId ?? ''} onChange={(e) => patch({ defaultConnectionId: e.target.value || null })}>
											<option value="">{t('settings.common.none')}</option>
											{props.connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
										</select>
									</label>
									<label>{t('settings.editor.idleDisconnect')} {t('settings.editor.idleDisconnectHint')}
										<NumberField min={0} max={1440} fallback={240} value={appSettings.idleDisconnectMinutes} onCommit={(n) => patch({ idleDisconnectMinutes: n })} />
									</label>
									<label className="check"><input type="checkbox" checked={appSettings.reconnectOnLaunch} onChange={(e) => patch({ reconnectOnLaunch: e.target.checked })} /> {t('settings.editor.reconnect')}</label>
									<div className="muted">{t('settings.editor.reconnectHelp')}</div>
								</fieldset>
							</div>
						</div>
					)}

					{tab === 'ai' && <AiSection onAiSaved={props.onAiSaved} byokAllowed={props.entitlements.byok} />}

					{/* Data Flows' generator: its own page because its providers and keys are separate
					    from the assistant's. The vendor path reuses the byok entitlement; local
					    Ollama generation is ungated. */}
					{tab === 'datagen' && <DataGenerationSection vendorAllowed={props.entitlements.byok} />}

					{/* The model that reads the user's documents: a third page for a third consent
					    question. */}
					{tab === 'extractmodel' && <ExtractionModelSection initialPage={props.initialPage} onOpenFlows={props.onOpenFlows} />}

					{/* Buckets a data flow reads from. Beside Connections rather than
					    inside it: a bucket is a place files live, not a database, and the two answer
					    different questions everywhere else in the app. */}
					{tab === 'cloud' && <CloudAccountsSection />}

					{tab === 'audit' && (
						<AuditSection
							connections={props.connections}
							chatEnabled={appSettings.auditLogChat}
							completionEnabled={appSettings.auditLogCompletion}
							onToggleChat={(v) => patch({ auditLogChat: v })}
							onToggleCompletion={(v) => patch({ auditLogCompletion: v })}
						/>
					)}

					{tab === 'agent' && <AgentAccessSection reveal={reveal ?? undefined} />}
					{tab === 'snoutbot' && <ReviewSettings connections={props.connections} onOpenReviews={props.onOpenReviews} />}

						{tab === 'knowledge' && <KnowledgeSection connections={props.connections} activeConnectionId={props.activeConnectionId} />}

					{tab === 'connections' && (
						<div className="settings-conns">
							{props.connections.length > 0 && (
								<SettingsIntro art={ConnectArt}>
									<p>{t(secretsWeak ? 'settings.connections.introWeak' : 'settings.connections.intro')}</p>
									{secretsWeak && <p className="muted">{t('settings.connections.weakSecrets')}</p>}
								</SettingsIntro>
							)}
							{props.connections.length === 0 && (
								<div className="settings-empty">
									<ConnectArt className="settings-empty-art" />
									<p>{t('settings.connections.empty')}</p>
									{secretsWeak && <p className="field-hint">{t('settings.connections.weakSecrets')}</p>}
									<button type="button" onClick={props.onAddConnection}><Icon name="add" /> {t('settings.connections.add')}</button>
								</div>
							)}
							{props.connections.map((c) => {
								const connected = props.connectedIds.includes(c.id);
								return (
									<div className="settings-conn-row" key={c.id}>
										<span className={`dot${connected ? ' on' : ''}${c.environment === 'prod' ? ' prod' : ''}`}><Icon name="circle-filled" /></span>
										<span className="tree-label">{c.label}</span>
										{c.environment && <span className={`env${c.environment === 'prod' ? ' prod' : ''}`}>{c.environment}</span>}
										<span className="spacer" />
										{connected
											? <button className="icon-btn" aria-label={t('settings.connections.disconnect')} onClick={() => props.onDisconnect(c.id)}><Icon name="debug-disconnect" /></button>
											: <button className="icon-btn" aria-label={t('settings.connections.connect')} onClick={() => props.onConnect(c.id)}><Icon name="plug" /></button>}
										<button className="icon-btn" aria-label={t('settings.common.edit')} onClick={() => props.onEditConnection(c)}><Icon name="edit" /></button>
										<button className="icon-btn" aria-label={t('settings.common.delete')} onClick={() => props.onDeleteConnection(c)}><Icon name="trash" /></button>
									</div>
								);
							})}
							{props.connections.length > 0 && (
								<div className="modal-actions">
									<button type="button" className="secondary" onClick={props.onAddConnection}><Icon name="add" /> {t('settings.connections.add')}</button>
								</div>
							)}
						</div>
					)}

					{tab === 'network' && <NetworkSection />}

					{tab === 'privacy' && <PrivacySection signedIn={props.auth.user !== null} />}

					{tab === 'shortcuts' && <ShortcutsSection />}

					{tab === 'reset' && <ResetSection onReset={props.onReset} />}
				</div>
			</div>
		</div>
	);
}

function clampInt(value: string, min: number, max: number, fallback: number): number {
	const n = Number.parseInt(value, 10);
	if (Number.isNaN(n)) {
		return fallback;
	}
	return Math.max(min, Math.min(max, n));
}

/**
 * A numeric setting input that lets you type freely and only clamps to
 * [min, max] when you commit the edit (blur or Enter).
 *
 * Deliberately a `type="text"` input, NOT `type="number"`: Chromium's native
 * number field sanitizes/clamps its own value against min/max as you type,
 * which fought editing (deleting "13" snapped to the minimum, appending a digit
 * jumped to the maximum). We keep it a plain text field, filter keystrokes to
 * digits ourselves, and clamp the range only on commit, so intermediate values
 * are always typeable.
 */
function NumberField(props: {
	value: number;
	min: number;
	max: number;
	fallback: number;
	onCommit: (n: number) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'onKeyDown' | 'min' | 'max' | 'type'>): JSX.Element {
	const { value, min, max, fallback, onCommit, ...rest } = props;
	const [text, setText] = useState(String(value));
	// Track the external value while we are NOT mid-edit; typing keeps `value`
	// unchanged (nothing is committed yet), so this won't clobber the buffer.
	useEffect(() => {
		setText(String(value));
	}, [value]);
	function commit(raw: string): void {
		const n = clampInt(raw, min, max, fallback);
		onCommit(n);
		setText(String(n));
	}
	return (
		<input
			type="text"
			inputMode="numeric"
			value={text}
			onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
			onBlur={(e) => commit(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === 'Enter') {
					commit((e.target as HTMLInputElement).value);
				}
			}}
			{...rest}
		/>
	);
}

/** Provider/model + behavior. Self-contained: loads and saves via the AI IPC, exactly
 *  like the former standalone AI settings modal, plus the behavior knobs. */
function AiSection({ onAiSaved, byokAllowed }: { onAiSaved?: () => void; byokAllowed: boolean }): JSX.Element | null {
	const t = useT();
	const keyPlace = t(useSecretsWeak() ? 'settings.secretsPlace.file' : 'settings.secretsPlace.keychain');
	const PROVIDER_LABELS = providerLabels(t);
	const [loaded, setLoaded] = useState<AiSettings | null>(null);
	const [provider, setProvider] = useState<AiProviderId>('positron-cloud');
	// Ollama state is kept (not offered in the picker) so its saved config round-trips through save().
	const [ollamaEndpoint, setOllamaEndpoint] = useState('');
	const [ollamaModel, setOllamaModel] = useState('');
	const [instructions, setInstructions] = useState('');
	const [maxSchemaChars, setMaxSchemaChars] = useState(24000);
	const [topTables, setTopTables] = useState(8);
	const [autoInsertSql, setAutoInsertSql] = useState(false);
	const [inlineCompletion, setInlineCompletion] = useState(false);
	const [inlineCompletionMode, setInlineCompletionMode] = useState<InlineCompletionMode>('manual');
	const [observerModel, setObserverModel] = useState('');
	// Undefined while the user has never chosen: kept that way on save, so opening Settings and
	// saving something else is not taken as a choice (the assistant's banner keys off it).
	const [dataAccess, setDataAccess] = useState<DataAccessLevel | undefined>(undefined);
	const [completionModel, setCompletionModel] = useState('');
	const [toolListTables, setToolListTables] = useState(true);
	const [toolDescribeTable, setToolDescribeTable] = useState(true);
	const [toolSearchColumns, setToolSearchColumns] = useState(true);
	const [toolRunQuery, setToolRunQuery] = useState(true);
	const [agentMaxSteps, setAgentMaxSteps] = useState(15);
	const [agentMaxRows, setAgentMaxRows] = useState(200);
	const [autoApprove, setAutoApprove] = useState<string[]>([]);
	const [connList, setConnList] = useState<ConnectionConfig[]>([]);
	const [gatewayModel, setGatewayModel] = useState('');
	// BYOK (Bring-Your-Own-Key): per-provider model + optional base-URL override, plus the key
	// input (blank = keep the stored one). Keyed by provider id.
	const emptyByok: Record<ByokProviderId, string> = { 'byok-openai': '', 'byok-openrouter': '', 'byok-anthropic': '' };
	const emptyByokList: Record<ByokProviderId, string[]> = { 'byok-openai': [], 'byok-openrouter': [], 'byok-anthropic': [] };
	const [byokModel, setByokModel] = useState<Record<ByokProviderId, string>>(emptyByok); // the active model
	const [byokCurated, setByokCurated] = useState<Record<ByokProviderId, string[]>>(emptyByokList); // models the user added (shown in the picker)
	const [byokOptions, setByokOptions] = useState<Record<ByokProviderId, string[]>>(emptyByokList); // the provider's full list for the combo (transient, from "Load models")
	const [byokPick, setByokPick] = useState<Record<ByokProviderId, string>>(emptyByok); // the combo/custom entry waiting to be added
	const [byokBaseUrl, setByokBaseUrl] = useState<Record<ByokProviderId, string>>(emptyByok);
	const [byokKey, setByokKey] = useState<Record<ByokProviderId, string>>(emptyByok);
	const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [ollamaModels, setOllamaModels] = useState<string[]>([]);
	const [refreshing, setRefreshing] = useState(false);
	const [aiTab, setAiTab] = useState<'chat' | 'completion'>('chat');
	const [chatTab, setChatTab] = useState<'models' | 'settings'>('models');
	const [statuses, setStatuses] = useState<AiProviderStatus[]>([]);

	async function loadStatuses(): Promise<void> {
		try {
			setStatuses(await window.sqlApi.aiProviderStatus());
		} catch {
			setStatuses([]);
		}
	}

	/** Show/hide a "provider:model" in the chat picker; persists immediately. */
	async function toggleModel(key: string, enabled: boolean): Promise<void> {
		await window.sqlApi.aiSetModelEnabled(key, enabled);
		await loadStatuses();
	}

	async function refreshOllama(endpoint: string): Promise<void> {
		setRefreshing(true);
		try {
			setOllamaModels(await window.sqlApi.aiOllamaModels(endpoint));
		} catch {
			setOllamaModels([]);
		} finally {
			setRefreshing(false);
		}
	}

	/** Ollama model field: a dropdown of the live model list (the current value is always
	 *  included, so an offline or not-yet-listed model still shows), plus a refresh button. */
	function ollamaModelField(value: string, onChange: (next: string) => void): JSX.Element {
		const options = value && !ollamaModels.includes(value) ? [value, ...ollamaModels] : ollamaModels;
		return (
			<span style={{ display: 'flex', gap: 6 }}>
				<select style={{ flex: 1, minWidth: 0 }} value={value} onChange={(e) => onChange(e.target.value)}>
					{!value && <option value="">{refreshing ? t('settings.common.loading') : ollamaModels.length ? t('settingsAi.selectModel') : t('settingsAi.noModelsEndpoint')}</option>}
					{options.map((m) => <option key={m} value={m}>{m}</option>)}
				</select>
				<button type="button" className="secondary" disabled={refreshing} title={t('settingsAi.refreshOllama')} onClick={() => void refreshOllama(ollamaEndpoint)}><Icon name="refresh" /> {refreshing ? '…' : t('settings.common.refresh')}</button>
			</span>
		);
	}

	/** The completion-model picker for a cloud provider: purely the gateway's completion-only
	 *  (base/FIM) models, the inverse of the chat list. A stale/unknown saved value is snapped
	 *  onto a real one by the effect above, so this lists only what the gateway offers. */
	function cloudCompletionField(p: AiProviderId, value: string, onChange: (next: string) => void): JSX.Element {
		const models = (statuses.find((s) => s.provider === p)?.completionModels ?? []).map((m) => m.model);
		return (
			<select value={value} onChange={(e) => onChange(e.target.value)}>
				{models.length === 0 && <option value="">{t('settingsAi.noCompletionModels')}</option>}
				{models.map((m) => <option key={m} value={m}>{m}</option>)}
			</select>
		);
	}

	useEffect(() => {
		void window.sqlApi.aiSettings().then((s) => {
			setLoaded(s);
			setProvider(s.provider);
			setOllamaEndpoint(s.ollama.endpoint);
			setOllamaModel(s.ollama.model);
			setGatewayModel(s['positron-cloud'].model);
			setByokModel({ 'byok-openai': s.byok['byok-openai'].model, 'byok-openrouter': s.byok['byok-openrouter'].model, 'byok-anthropic': s.byok['byok-anthropic'].model });
			setByokCurated({ 'byok-openai': s.byok['byok-openai'].models, 'byok-openrouter': s.byok['byok-openrouter'].models, 'byok-anthropic': s.byok['byok-anthropic'].models });
			setByokBaseUrl({ 'byok-openai': s.byok['byok-openai'].baseUrl ?? '', 'byok-openrouter': s.byok['byok-openrouter'].baseUrl ?? '', 'byok-anthropic': s.byok['byok-anthropic'].baseUrl ?? '' });
			setInstructions(s.behavior.instructions);
			setMaxSchemaChars(s.behavior.maxSchemaChars);
			setTopTables(s.behavior.topTables);
			setAutoInsertSql(s.behavior.autoInsertSql);
			setInlineCompletion(s.behavior.inlineCompletion);
			setInlineCompletionMode(s.behavior.inlineCompletionMode);
			setObserverModel(s.behavior.observerModel ?? '');
			setDataAccess(s.dataAccess);
			setCompletionModel(s.completion?.model ?? '');
			setToolListTables(s.tools.listTables);
			setToolDescribeTable(s.tools.describeTable);
			setToolSearchColumns(s.tools.searchColumns);
			setToolRunQuery(s.tools.runQuery);
			setAgentMaxSteps(s.tools.maxSteps);
			setAgentMaxRows(s.tools.maxRows);
			setAutoApprove(s.tools.autoApproveConnections);
			// Ollama is not offered in the picker; only probe its endpoint when it's the active provider.
			if (s.provider === 'ollama') {
				void refreshOllama(s.ollama.endpoint);
			}
		});
		void loadStatuses();
		void window.sqlApi.state().then((st) => setConnList(st.connections));
	}, []);

	// Completion-only (base/FIM) models are served only by the gateway (BYOK providers offer none),
	// so the completion model is always a positron-cloud model unless the parked Ollama provider is
	// active. Tracking the active BYOK chat provider here would store a gateway model under a BYOK
	// provider id and break routing (the completion target can't serve it).
	const completionProvider: AiProviderId = provider === 'ollama' ? 'ollama' : 'positron-cloud';

	// Pin the completion model to a real gateway completion model. An older ai.json may hold a
	// raw model tag that isn't a valid gateway model_name; once
	// the live list loads, snap an unknown/empty value onto the first offered one.
	useEffect(() => {
		const models = (statuses.find((s) => s.provider === completionProvider)?.completionModels ?? []).map((m) => m.model);
		if (models.length > 0 && !models.includes(completionModel)) {
			setCompletionModel(models[0]);
		}
	}, [statuses, completionProvider, completionModel]);

	/** Revoke a connection's "Always allow" — it'll prompt again before running queries. */
	async function revokeAutoApprove(id: string): Promise<void> {
		await window.sqlApi.setConnectionAutoApprove(id, false);
		setAutoApprove((prev) => prev.filter((x) => x !== id));
	}

	function collect(): AiSettingsFormValues {
		return {
			provider,
			// The project model chosen in the assistant's picker; not edited here, so kept as loaded.
			project: loaded?.project,
			ollama: { endpoint: ollamaEndpoint.trim(), model: ollamaModel.trim() },
			'positron-cloud': { model: gatewayModel.trim() },
			// BYOK: the curated model list (what shows in the picker), a valid active model, and an
			// optional base-URL override (blank ⇒ provider default).
			byok: {
				'byok-openai': { model: activeByokModel('byok-openai'), models: byokCurated['byok-openai'], baseUrl: byokBaseUrl['byok-openai'].trim() || undefined },
				'byok-openrouter': { model: activeByokModel('byok-openrouter'), models: byokCurated['byok-openrouter'], baseUrl: byokBaseUrl['byok-openrouter'].trim() || undefined },
				'byok-anthropic': { model: activeByokModel('byok-anthropic'), models: byokCurated['byok-anthropic'], baseUrl: byokBaseUrl['byok-anthropic'].trim() || undefined },
			},
			behavior: { instructions: instructions.trim(), maxSchemaChars, topTables, autoInsertSql, inlineCompletion, inlineCompletionMode, observerModel: observerModel.trim() },
			tools: { enabled: true, listTables: toolListTables, describeTable: toolDescribeTable, searchColumns: toolSearchColumns, runQuery: toolRunQuery, autoApproveConnections: autoApprove, maxSteps: agentMaxSteps, maxRows: agentMaxRows },
			completion: completionModel.trim() ? { provider: completionProvider, model: completionModel.trim() } : undefined,
			dataAccess,
			// Each key goes to its own keychain slot; blank leaves the stored one intact.
			apiKeys: {
				'byok-openai': byokKey['byok-openai'] || undefined,
				'byok-openrouter': byokKey['byok-openrouter'] || undefined,
				'byok-anthropic': byokKey['byok-anthropic'] || undefined,
			},
		};
	}

	async function save(): Promise<void> {
		setBusy(true);
		await window.sqlApi.saveAiSettings(collect());
		await loadStatuses();
		// Let the app re-read AI settings now, so toggling inline completion takes effect
		// immediately instead of only when the modal is closed (or after a restart).
		onAiSaved?.();
		setStatus({ ok: true, message: t('settings.common.saved') });
		setBusy(false);
	}

	async function test(): Promise<void> {
		setBusy(true);
		setStatus({ ok: true, message: t('settings.common.testing') });
		await window.sqlApi.saveAiSettings(collect());
		setStatus(await window.sqlApi.aiTest());
		setBusy(false);
	}

	if (!loaded) {
		return null;
	}

	/** The model field for SnoutData Cloud. The model is a select fed by the provider's live model
	 *  list (like the chat picker); a stale saved value is kept as an option so it stays visible.
	 *  There is no key: the account's own sign-in is what the gateway takes. */
	function cloudFields(p: AiProviderId, model: string, setModel: (v: string) => void): JSX.Element {
		const status = statuses.find((s) => s.provider === p);
		const models = (status?.models ?? []).map((m) => m.model);
		const options = model && !models.includes(model) ? [model, ...models] : models;
		return (
			<>
				<label>{t('settingsAi.model')}
					<span style={{ display: 'flex', gap: 6 }}>
						<select style={{ flex: 1, minWidth: 0 }} value={model} onChange={(e) => setModel(e.target.value)}>
							{!model && <option value="">{models.length ? t('settingsAi.selectModel') : t('settingsAi.noModelsSignIn')}</option>}
							{options.map((m) => <option key={m} value={m}>{m}</option>)}
						</select>
						<button type="button" className="secondary" title={t('settingsAi.refreshGateway')} onClick={() => void loadStatuses()}><Icon name="refresh" /> {t('settings.common.refresh')}</button>
					</span>
				</label>
				<div className="muted">{t('settingsAi.cloudNote')}</div>
			</>
		);
	}

	/** The active model to persist for a BYOK provider: the user's current pick if it's still in
	 *  the curated list, else the first curated model (so the active provider always has a valid
	 *  model), else empty. Keeps a chat-picker selection from being clobbered on a settings save. */
	function activeByokModel(p: ByokProviderId): string {
		const picked = byokModel[p].trim();
		const curated = byokCurated[p];
		return curated.includes(picked) ? picked : (curated[0] ?? '');
	}

	/** Persist the form (so the just-typed key reaches the keychain), then fetch the provider's full
	 *  model list into the "add a model" combo. byokModelList (main) reads the STORED key, so saving
	 *  first is required. A bad key surfaces the provider's verbatim error. */
	async function loadByokModels(p: ByokProviderId): Promise<void> {
		const def = BYOK_PROVIDER_DEFAULTS[p];
		setBusy(true);
		setStatus({ ok: true, message: t('settingsAi.loadingModels', { provider: def.label }) });
		try {
			await window.sqlApi.saveAiSettings(collect());
			const list = await window.sqlApi.aiByokModels(p);
			setByokOptions({ ...byokOptions, [p]: list });
			setStatus(list.length
				? { ok: true, message: t('settingsAi.foundModels', { count: list.length, provider: def.label }) }
				: { ok: false, message: t('settingsAi.noModelsKey', { provider: def.label }) });
		} catch (err) {
			setByokOptions({ ...byokOptions, [p]: [] });
			setStatus({ ok: false, message: err instanceof Error ? err.message : t('settingsAi.loadFailed', { provider: def.label }) });
		} finally {
			setBusy(false);
		}
	}

	/** Add the pending pick (combo selection or typed id) to a provider's curated list, and make it
	 *  the active model when none is set yet. Clears the entry. Deduped. */
	function addByokModel(p: ByokProviderId): void {
		const id = byokPick[p].trim();
		if (!id) {
			return;
		}
		setByokCurated((prev) => (prev[p].includes(id) ? prev : { ...prev, [p]: [...prev[p], id] }));
		setByokModel((prev) => (prev[p].trim() ? prev : { ...prev, [p]: id }));
		setByokPick({ ...byokPick, [p]: '' });
	}

	/** Remove a model from a provider's curated list (it stops showing in the picker after Save). */
	function removeByokModel(p: ByokProviderId, id: string): void {
		setByokCurated((prev) => ({ ...prev, [p]: prev[p].filter((m) => m !== id) }));
		setByokModel((prev) => (prev[p] === id ? { ...prev, [p]: '' } : prev));
	}

	/** Key + curated-model picker + optional base-URL for a BYOK provider. The user loads the
	 *  provider's full catalogue into a combo, then adds the few models they want (opt-in, so the
	 *  picker isn't flooded). The text entry also accepts any model id (Anthropic / a model the
	 *  list doesn't include). Key -> keychain. */
	function byokFields(p: ByokProviderId): JSX.Element {
		const stored = statuses.find((s) => s.provider === p)?.configured ?? false;
		const def = BYOK_PROVIDER_DEFAULTS[p];
		const curated = byokCurated[p];
		const options = (byokOptions[p] ?? []).filter((m) => !curated.includes(m));
		return (
			<>
				<label>{t('settingsAi.apiKey')}
					<span style={{ display: 'flex', gap: 6 }}>
						<input style={{ flex: 1, minWidth: 0 }} type="password" value={byokKey[p]} placeholder={stored ? t('settingsAi.keepKey') : t('settingsAi.pasteKey', { provider: def.label })} onChange={(e) => setByokKey({ ...byokKey, [p]: e.target.value })} />
						<button type="button" className="secondary" title={t('settingsAi.saveLoadTitle', { provider: def.label })} disabled={busy} onClick={() => void loadByokModels(p)}><Icon name="cloud-download" /> {t('settingsAi.loadModels')}</button>
					</span>
				</label>
				<label>{t('settingsAi.addModel')}
					<span style={{ display: 'flex', gap: 6 }}>
						{options.length > 0 && (
							<select value="" style={{ flex: 1, minWidth: 0 }} onChange={(e) => { if (e.target.value) { setByokPick({ ...byokPick, [p]: e.target.value }); } }}>
								<option value="">{t('settingsAi.pickFrom', { count: options.length, provider: def.label })}</option>
								{options.map((m) => <option key={m} value={m}>{m}</option>)}
							</select>
						)}
						<input style={{ flex: 1, minWidth: 0 }} value={byokPick[p]} placeholder={options.length ? t('settingsAi.orTypeModelId') : t('settingsAi.typeModelId')} onChange={(e) => setByokPick({ ...byokPick, [p]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addByokModel(p); } }} />
						<button type="button" className="secondary" disabled={!byokPick[p].trim()} onClick={() => addByokModel(p)}><Icon name="add" /> {t('settingsAi.add')}</button>
					</span>
				</label>
				{curated.length > 0 ? (
					<div className="byok-added">
						{curated.map((m) => (
							<div className="byok-added-row" key={m}>
								<Icon name="check" />
								<span className="tree-label">{m}</span>
								<span className="spacer" />
								<button type="button" className="icon-btn" aria-label={t('settingsAi.removeFromPicker')} onClick={() => removeByokModel(p, m)}><Icon name="close" /></button>
							</div>
						))}
						<div className="muted small">{t('settingsAi.addedHelp')}</div>
					</div>
				) : (
					<div className="muted small">{t('settingsAi.noneAdded')}</div>
				)}
				<label>{t('settingsAi.baseUrl')}<input value={byokBaseUrl[p]} placeholder={def.baseUrl} onChange={(e) => setByokBaseUrl({ ...byokBaseUrl, [p]: e.target.value })} /></label>
				<div className="muted">{t('settingsAi.byokNote', { provider: def.label, place: keyPlace })}</div>
			</>
		);
	}

	return (
		<>
			<div className="tabs">
				<button type="button" className={aiTab === 'chat' ? 'tab active' : 'tab'} onClick={() => setAiTab('chat')}>{t('settingsAi.chatTab')}</button>
				<button type="button" className={aiTab === 'completion' ? 'tab active' : 'tab'} onClick={() => setAiTab('completion')}>{t('settingsAi.completionTab')}</button>
			</div>

			{aiTab === 'chat' && (
				<div className="tabs subtabs">
					<button type="button" className={chatTab === 'models' ? 'tab active' : 'tab'} onClick={() => setChatTab('models')}>{t('settingsAi.modelsTab')}</button>
					<button type="button" className={chatTab === 'settings' ? 'tab active' : 'tab'} onClick={() => setChatTab('settings')}>{t('settingsAi.settingsTab')}</button>
				</div>
			)}

			{aiTab === 'chat' && chatTab === 'models' && (
				<>
					<fieldset>
						<legend>{t('settingsAi.modelsLegend')}</legend>
						<div className="muted">{t('settingsAi.modelsHelp')}</div>
						{/* Only list providers that actually have models: an unconfigured BYOK provider has
						    none, so it would otherwise show as a confusing empty "No models" row here. */}
						{statuses.filter((s) => s.models.length > 0).map((s) => (
							<div className="ai-provider" key={s.provider}>
								<div className="ai-provider-head">
									<span className={`dot${s.reachable ? ' on' : ''}`}><Icon name="circle-filled" /></span>
									<span className="tree-label">{PROVIDER_LABELS[s.provider]}</span>
									{s.detail && <span className="muted small">{s.detail}</span>}
									<span className="spacer" />
									{s.provider === 'ollama' && <button type="button" className="icon-btn" aria-label={t('settingsAi.refreshModels')} onClick={() => void loadStatuses()}><Icon name="refresh" /></button>}
								</div>
								{s.models.map((m) => (
									<label className="ai-model-row" key={m.model} title={m.description ?? undefined}>
										<span className="ai-model-id">
											<span className="tree-label">{m.displayName?.trim() || m.model}</span>
											{m.description && <span className="muted small ai-model-desc">{m.description}</span>}
										</span>
										{/* The badges are one group, not three loose siblings with a spacer after them:
										    two flex:1 items (the name column and the spacer) split the row evenly, so
										    each row's tags landed at whatever x its own description happened to end at
										    and the blurb wrapped at half the width it had. One right-aligned column
										    instead, sharing a floor width so the toggles line up. */}
										<span className="ai-model-tags">
											{m.label && <span className="model-picker-label">{m.label}</span>}
											{m.recommended && <span className="model-picker-tag">{t('settingsAi.recommended')}</span>}
											{m.reasoning && <span className="reason-badge" title={t('settingsAi.reasoningTitle')}>{t('settingsAi.reasoningBadge')}</span>}
										</span>
										<span className="switch"><input type="checkbox" checked={m.enabled} onChange={(e) => void toggleModel(`${m.provider}:${m.model}`, e.target.checked)} /><span className="slider" /></span>
									</label>
								))}
							</div>
						))}
						{statuses.every((s) => s.models.length === 0) && <div className="muted small ai-model-row">{t('settingsAi.noModelsYet')}</div>}
					</fieldset>
					<fieldset>
						<legend>{t('settingsAi.activeLegend')}</legend>
						<div className="muted">{t(byokAllowed ? 'settingsAi.activeHelpByok' : 'settingsAi.activeHelp')}</div>
						<label>{t('settingsAi.provider')}
							<select value={provider} onChange={(e) => setProvider(e.target.value as AiProviderId)}>
								{/* BYOK providers are Plus, Pro and Business; only offer them when the tier allows it. */}
								{(Object.keys(PROVIDER_LABELS) as AiProviderId[]).filter((p) => byokAllowed || !BYOK_IDS.includes(p as ByokProviderId)).map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
								{/* A project's model is chosen in the assistant's model picker; shown here so the choice reads true. */}
								{loaded?.project && <option value="snout-project">{t('settingsAi.projectAi', { name: loaded.project.name ?? loaded.project.ref })}</option>}
							</select>
						</label>
						{/* Local Ollama is not offered here. Add 'ollama' back to PROVIDER_LABELS to surface it. */}
						{provider === 'ollama' && (
							<>
								<label>{t('settingsAi.endpoint')}<input value={ollamaEndpoint} onChange={(e) => setOllamaEndpoint(e.target.value)} placeholder="http://localhost:11434" /></label>
								<label>{t('settingsAi.model')}{ollamaModelField(ollamaModel, setOllamaModel)}</label>
							</>
						)}
						{provider === 'positron-cloud' && cloudFields('positron-cloud', gatewayModel, setGatewayModel)}
						{byokAllowed && BYOK_IDS.includes(provider as ByokProviderId) && byokFields(provider as ByokProviderId)}
					</fieldset>
					{byokAllowed && <MoveKeysPanel onMoved={() => {
						void window.sqlApi.aiSettings().then((s) => {
							setLoaded(s);
							setProvider(s.provider);
						});
						void loadStatuses();
						onAiSaved?.();
					}} />}
					{/* Discovery for Free users: BYOK exists but is a paid feature; show it disabled. */}
					{!byokAllowed && (
						<fieldset className="byok-plan-hint" disabled>
							<legend>{t('settingsAi.byokLegend')}</legend>
							<div className="muted">{t('settingsAi.byokPitch')}</div>
						</fieldset>
					)}
				</>
			)}

			{aiTab === 'chat' && chatTab === 'settings' && (
				<>
					<fieldset>
						<legend>{t('settingsAi.groundingLegend')}</legend>
						{/* First in the card, not loose above it: what the AI may see IS its grounding,
						    and a lone field between the tabs and the first card had no group to sit in. */}
						<label>{t('settingsAi.dataAccess')}
							<select value={effectiveDataAccess(dataAccess)} onChange={(e) => setDataAccess(e.target.value as DataAccessLevel)}>
								{DATA_ACCESS_LEVELS.map((level) => <option key={level} value={level}>{dataAccessText(level).label}</option>)}
							</select>
						</label>
						<p className="field-hint">
							{dataAccessText(effectiveDataAccess(dataAccess)).detail} {t('settingsAi.dataAccessScope')}
							{dataAccess === undefined && ` ${t('settingsAi.dataAccessDefault')}`}
						</p>
						<label>{t('settingsAi.extraInstructions')} {t('settingsAi.extraInstructionsHint')}
							<textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={t('settingsAi.instructionsPlaceholder')} rows={6} />
						</label>
						<label>{t('settingsAi.topTables')}
							<NumberField min={1} max={100} fallback={8} value={topTables} onCommit={setTopTables} />
						</label>
						<div className="muted">{t('settingsAi.topTablesHelp')}</div>
						<label>{t('settingsAi.maxSchemaChars')} {t('settingsAi.maxSchemaCharsHint')}
							<NumberField min={1000} max={200000} fallback={24000} value={maxSchemaChars} onCommit={setMaxSchemaChars} />
						</label>
						<label className="check"><input type="checkbox" checked={autoInsertSql} onChange={(e) => setAutoInsertSql(e.target.checked)} /> {t('settingsAi.autoInsertSql')}</label>
						{/* A build from source has no inexpensive observer model, so suggesting facts to
						    remember is a second model call per turn: off until a model is named here. */}
						{!OFFICIAL_BUILD && (
							<>
								<label>{t('settingsAi.observerModel')}
									<input type="text" value={observerModel} onChange={(e) => setObserverModel(e.target.value)} placeholder={t('settingsAi.observerPlaceholder')} spellCheck={false} />
								</label>
								<p className="field-hint">{t('settingsAi.observerHelp')}</p>
							</>
						)}
					</fieldset>
					<fieldset>
						<legend>{t('settingsAi.toolsLegend')}</legend>
							<div className="muted">{t('settingsAi.toolsHelp')}</div>
							<label className="check"><input type="checkbox" checked={toolListTables} onChange={(e) => setToolListTables(e.target.checked)} /> {t('settingsAi.listTables')}</label>
							<label className="check"><input type="checkbox" checked={toolDescribeTable} onChange={(e) => setToolDescribeTable(e.target.checked)} /> {t('settingsAi.describeTable')} {t('settingsAi.describeTableHint')}</label>
							<label className="check"><input type="checkbox" checked={toolSearchColumns} onChange={(e) => setToolSearchColumns(e.target.checked)} /> {t('settingsAi.searchColumns')}</label>
							<label className="check"><input type="checkbox" checked={toolRunQuery} onChange={(e) => setToolRunQuery(e.target.checked)} /> {t('settingsAi.runQueries')} <span className="muted">{t('settingsAi.runQueriesHint')}</span></label>
							{toolRunQuery && effectiveDataAccess(dataAccess) !== 'queries' && (
								<p className="field-hint">{t('settingsAi.runQueriesOff')}</p>
							)}
							{toolRunQuery && (
								<div className="auto-approve">
									<div className="muted small">{t('settingsAi.autoApproved')}</div>
									{autoApprove.length === 0
										? <div className="muted small">{t('settingsAi.noneAsked')}</div>
										: autoApprove.map((id) => (
											<div className="auto-approve-row" key={id}>
												<Icon name="database" />
												<span className="tree-label">{connList.find((c) => c.id === id)?.label ?? id}</span>
												<span className="spacer" />
												<button type="button" className="secondary small" title={t('settingsAi.askAgainTitle')} onClick={() => void revokeAutoApprove(id)}><Icon name="close" /> {t('settingsAi.revoke')}</button>
											</div>
										))}
								</div>
							)}
							<label>{t('settingsAi.maxSteps')}
								<NumberField min={1} max={20} fallback={15} value={agentMaxSteps} onCommit={setAgentMaxSteps} />
							</label>
							<label>{t('settingsAi.maxRows')}
								<NumberField min={1} max={5000} fallback={200} value={agentMaxRows} onCommit={setAgentMaxRows} />
							</label>
					</fieldset>
				</>
			)}

			{aiTab === 'completion' && (
				<>
					<label className="check"><input type="checkbox" checked={inlineCompletion} onChange={(e) => setInlineCompletion(e.target.checked)} /> {t('settingsAi.enableCompletion')} {t('settingsAi.enableCompletionHint')}</label>
					{BYOK_IDS.includes(provider as ByokProviderId) && (
						<div className="muted" data-testid="completion-byok-note">{t('settingsAi.byokCompletionNote')}</div>
					)}
					{inlineCompletion ? (
						<>
							<label>{t('settingsAi.trigger')}
								<select value={inlineCompletionMode} onChange={(e) => setInlineCompletionMode(e.target.value as InlineCompletionMode)}>
									<option value="manual">{t('settingsAi.triggerManual', { shortcut: formatShortcut('Alt+\\') })}</option>
									<option value="auto">{t('settingsAi.triggerAuto')}</option>
								</select>
							</label>
							<label>{t('settingsAi.completionModel')}
								{provider === 'ollama'
									? ollamaModelField(completionModel, setCompletionModel)
									: cloudCompletionField('positron-cloud', completionModel, setCompletionModel)}
							</label>
							<div className="muted">{t('settingsAi.completionHelp')}</div>
						</>
					) : (
						<div className="muted">{t('settingsAi.completionOff', { shortcut: formatShortcut('Ctrl+Space') })}</div>
					)}
				</>
			)}

			<div className="modal-actions">
				<button type="button" className="secondary" onClick={() => void test()} disabled={busy}><Icon name="beaker" /> {t('settingsAi.test')}</button>
				<span className="spacer" />
				<button type="button" onClick={() => void save()} disabled={busy}><Icon name="save" /> {t('settings.common.save')}</button>
			</div>
			{status && <div className={`form-status ${status.ok ? 'ok' : 'error'}`}>{status.message}</div>}
		</>
	);
}

/** A one-shot Claude Code CLI command that registers the server for every project (user scope),
 *  so there's nothing to paste into a file. Uses the `--transport http` + `--header` form rather
 *  than `add-json` — it avoids JSON-quoting/flag-order pitfalls and is the documented path. */
function claudeAddCommand(status: McpStatus): string {
	return `claude mcp add --transport http snoutdata ${status.url} --header "Authorization: Bearer ${status.token}" --scope user`;
}

/** True on Windows (chooses the shell syntax for env-var snippets). Reads the UA so no IPC is needed. */
function isWindows(): boolean {
	return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
}

/** The OpenAI Codex form: its CLI registers an HTTP server but only reads the bearer token from an
 *  env var (no inline-token/header flag), so we set the env var first, then run `codex mcp add`. */
function codexAddCommand(status: McpStatus): string {
	const setEnv = isWindows()
		? `setx SNOUTDATA_MCP_TOKEN "${status.token}"`
		: `export SNOUTDATA_MCP_TOKEN='${status.token}'`;
	return `${setEnv}\ncodex mcp add snoutdata --url ${status.url} --bearer-token-env-var SNOUTDATA_MCP_TOKEN`;
}

/** Per-client setup presets shown under the universal JSON. Each renders a copyable snippet plus a
 *  one-line "where this goes" note; the universal `mcpServers` JSON above already covers the many
 *  clients that read that shape (Cursor, Cline, Windsurf, Claude Desktop, …). */
const MCP_CLIENT_PRESETS: Array<{ id: string; label: string; noteKey: string; build(status: McpStatus): string }> = [
	{ id: 'claude', label: 'Claude Code', noteKey: 'settingsAgent.claudeNote', build: claudeAddCommand },
	{ id: 'codex', label: 'Codex', noteKey: isWindows() ? 'settingsAgent.codexNoteWin' : 'settingsAgent.codexNote', build: codexAddCommand },
];

/*
 * Agent access is five separate decisions, and stacked in one column they read as one long consent
 * form: which databases, which coding agents, what the app itself may be told to do, and how an
 * agent that is not one of ours connects. Tabbed, in the order the questions are actually asked.
 *
 * The master switch and the server's own state stay ABOVE the strip: they gate every tab, and a
 * switch that lives on one of four tabs is a switch three quarters of this screen cannot find.
 */
const AGENT_TABS = [
	{ id: 'databases', labelKey: 'settingsAgent.tabs.databases' },
	{ id: 'agents', labelKey: 'settingsAgent.tabs.agents' },
	{ id: 'actions', labelKey: 'settingsAgent.tabs.actions' },
	{ id: 'connect', labelKey: 'settingsAgent.tabs.connect' },
] as const;

type AgentTab = typeof AGENT_TABS[number]['id'];

/* Which tab holds a setting the Settings search jumped to. Without this the search still selects
   the Agent access page and then flashes a control that is on a panel the user cannot see, which
   is worse than not finding it. Keyed by the label keys in SETTING_INDEX. */
const AGENT_TAB_FOR_SETTING: Record<string, AgentTab> = {
	'settingsAgent.connectionsLegend': 'databases',
	'settingsAgent.allowWrites': 'databases',
	'settingsAgent.agentsLegend': 'agents',
	'settingsAgent.letChangeApp': 'actions',
	'settingsAgent.letProgramUse': 'connect',
};

/** Agent access (MCP): let an external agent (e.g. Claude Code) query the user's databases
 *  THROUGH the app, so credentials never leave the keychain. Read-only, opt-in per connection,
 *  gated by a bearer token. Drives the mcp:* IPC; each call returns the full status so this
 *  re-renders from one source of truth. */
const PROXY_MODES: Array<{ id: ProxyMode; labelKey: string; hintKey: string }> = [
	{ id: 'system', labelKey: 'settings.network.modeSystem', hintKey: 'settings.network.modeSystemHint' },
	{ id: 'direct', labelKey: 'settings.network.modeDirect', hintKey: 'settings.network.modeDirectHint' },
	{ id: 'manual', labelKey: 'settings.network.modeManual', hintKey: 'settings.network.modeManualHint' },
];

// Settings → Shortcuts: live keyboard-shortcut rebinding. The bindings are the resolved set from
// main (shared/keybindings.ts is the source of truth); clicking a row captures the next keystroke
// and persists it, which broadcasts back so the editor + global dispatchers update without a restart.
function ShortcutsSection(): JSX.Element {
	const t = useT();
	const [bindings, setBindings] = useState<ResolvedKeybinding[]>([]);
	const [capturingId, setCapturingId] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void window.sqlApi.keybindings.get().then((b) => { if (active) { setBindings(b); } });
		const off = window.sqlApi.keybindings.onChanged((b) => setBindings(b));
		return () => { active = false; off(); };
	}, []);

	const defaults = new Map(KEYBINDINGS.map((d) => [d.id, normalizeCombo(d.default)]));

	function capture(id: string, e: React.KeyboardEvent): void {
		// Swallow the keystroke so neither Monaco nor the window-level dispatcher acts on it.
		e.preventDefault();
		e.stopPropagation();
		if (e.key === 'Escape') {
			setCapturingId(null);
			return;
		}
		if (e.key === 'Backspace' || e.key === 'Delete') {
			void window.sqlApi.keybindings.reset(id).then(setBindings);
			setCapturingId(null);
			return;
		}
		const combo = eventToCombo(e.nativeEvent);
		if (!combo) {
			// A lone modifier or an unsupported key — keep waiting for a real combo.
			return;
		}
		void window.sqlApi.keybindings.set(id, combo).then(setBindings);
		setCapturingId(null);
	}

	return (
		<div className="shortcuts">
			<SettingsIntro art={KeysArt}>
				<p>{t('settings.shortcuts.intro')}</p>
			</SettingsIntro>
			{bindings.map((b) => {
				const bindingLabel = (id: string): string => t(`settings.shortcuts.commands.${id}`, { assistant: ASSISTANT_NAME });
				const conflictLabels = conflictingIds(bindings, b.id, b.combo, b.scope)
					.map((cid) => (bindings.some((x) => x.id === cid) ? bindingLabel(cid) : cid));
				const reserved = reservedHint(b.combo);
				const isDefault = defaults.get(b.id) === b.combo;
				const capturing = capturingId === b.id;
				return (
					<div className="shortcut-row" key={b.id}>
						<span>{bindingLabel(b.id)}</span>
						<span className="spacer" />
						{conflictLabels.length > 0 && (
							<span className="shortcut-conflict" title={t('settings.shortcuts.sameKeys', { names: conflictLabels.join(', ') })}><Icon name="warning" /> {t('settings.shortcuts.conflict')}</span>
						)}
						{conflictLabels.length === 0 && reserved && (
							<span className="shortcut-conflict" title={t('settings.shortcuts.overridesTitle', { name: reserved })}><Icon name="warning" /> {t('settings.shortcuts.overrides', { name: reserved })}</span>
						)}
						{!isDefault && !capturing && (
							<button className="icon-btn" aria-label={t('settings.shortcuts.resetToDefault')} onClick={() => void window.sqlApi.keybindings.reset(b.id).then(setBindings)}><Icon name="discard" /></button>
						)}
						<button
							className={`shortcut-key${capturing ? ' capturing' : ''}`}
							onClick={() => setCapturingId(b.id)}
							onKeyDown={capturing ? (e) => capture(b.id, e) : undefined}
						>
							{capturing ? t('settings.shortcuts.pressKeys') : <kbd>{formatShortcut(b.combo)}</kbd>}
						</button>
					</div>
				);
			})}
			<div style={{ marginTop: 12 }}>
				<button type="button" className="secondary" onClick={() => void window.sqlApi.keybindings.reset().then(setBindings)}><Icon name="discard" /> {t('settings.shortcuts.resetAll')}</button>
			</div>
		</div>
	);
}

function NetworkSection(): JSX.Element {
	const t = useT();
	const secretsWeak = useSecretsWeak();
	const [config, setConfig] = useState<ProxyConfig>(DEFAULT_PROXY_CONFIG);
	const [password, setPassword] = useState<string>('');
	const [pwTouched, setPwTouched] = useState(false);
	const [resolved, setResolved] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState(false);
	const [test, setTest] = useState<ProxyTestResult | null>(null);
	const [testing, setTesting] = useState(false);

	useEffect(() => {
		void window.sqlApi.proxy.status().then((s: ProxyStatus) => {
			setConfig(s.config);
			setResolved(s.resolved);
			setLoaded(true);
		}).catch(() => setLoaded(true));
	}, []);

	function patch(next: Partial<ProxyConfig>): void {
		setConfig((c) => ({ ...c, ...next }));
		setSaved(false);
	}

	async function save(): Promise<void> {
		setBusy(true);
		setSaved(false);
		try {
			// Send the password only when the user typed in the field; otherwise leave the stored one.
			const values = pwTouched ? { config, password } : { config };
			const status = await window.sqlApi.proxy.save(values);
			setConfig(status.config);
			setResolved(status.resolved);
			setPassword('');
			setPwTouched(false);
			setSaved(true);
			setTest(null);
		} finally {
			setBusy(false);
		}
	}

	async function runTest(): Promise<void> {
		setTesting(true);
		setTest(null);
		try {
			setTest(await window.sqlApi.proxy.test());
		} finally {
			setTesting(false);
		}
	}

	if (!loaded) {
		return <div className="muted">{t('settings.common.loading')}</div>;
	}

	return (
		<>
			<SettingsIntro art={NetworkArt}>
				<p>{t('settings.network.intro')}</p>
			</SettingsIntro>

			<fieldset>
				<legend>{t('settings.network.proxyLegend')}</legend>
				{PROXY_MODES.map((m) => (
					<div key={m.id}>
						<label className="check">
							<input type="radio" name="proxy-mode" checked={config.mode === m.id} disabled={busy} onChange={() => patch({ mode: m.id })} />
							{t(m.labelKey)}
						</label>
						<div className="muted small" style={{ marginLeft: 22 }}>{t(m.hintKey)}</div>
					</div>
				))}
			</fieldset>

			{config.mode === 'manual' && (
				<fieldset>
					<legend>{t('settings.network.manualLegend')}</legend>
					<label>
						<span>{t('settings.network.pacUrl')} {t('settings.network.pacUrlHint')}</span>
						<input type="text" placeholder="http://wpad/wpad.dat" value={config.pacUrl} disabled={busy} onChange={(e) => patch({ pacUrl: e.target.value })} />
					</label>
					<div className="muted small">{t('settings.network.pacHelp')}</div>
					<label>
						<span>{t('settings.network.proxyServer')}</span>
						<input type="text" placeholder="proxy.corp.com:8080" value={config.server} disabled={busy || config.pacUrl.trim() !== ''} onChange={(e) => patch({ server: e.target.value })} />
					</label>
					<label>
						<span>{t('settings.network.bypass')}</span>
						<input type="text" placeholder="localhost,127.0.0.1,*.internal" value={config.bypass} disabled={busy || config.pacUrl.trim() !== ''} onChange={(e) => patch({ bypass: e.target.value })} />
					</label>
				</fieldset>
			)}

			<fieldset>
				<legend>{t('settings.network.signIn')} {t('settings.network.optional')}</legend>
				<div className="muted small">{t('settings.network.signInHelp', { place: t(secretsWeak ? 'settings.secretsPlace.file' : 'settings.secretsPlace.keychain') })}</div>
				<label>
					<span>{t('settings.network.username')}</span>
					<input type="text" autoComplete="off" value={config.username} disabled={busy} onChange={(e) => patch({ username: e.target.value })} />
				</label>
				<label>
					<span>{t('settings.network.password')}</span>
					<input
						type="password"
						autoComplete="off"
						placeholder={config.hasPassword && !pwTouched ? t('settings.network.passwordSaved') : ''}
						value={password}
						disabled={busy}
						onChange={(e) => { setPassword(e.target.value); setPwTouched(true); setSaved(false); }}
					/>
				</label>
				{config.hasPassword && <div className="muted small">{t('settings.network.passwordHelp')}</div>}
			</fieldset>

			<fieldset>
				<legend>{t('settings.network.windowsLegend')}</legend>
				<div className="muted small">{t('settings.network.windowsHelp')}</div>
				<label>
					<span>{t('settings.network.authServers')}</span>
					<input type="text" autoComplete="off" placeholder="*.corp.example, auth.gateway.example" value={config.authServers} disabled={busy} onChange={(e) => patch({ authServers: e.target.value })} />
				</label>
				<label>
					<span>{t('settings.network.delegateServers')}</span>
					<input type="text" autoComplete="off" placeholder={t('settings.network.noneLabel')} value={config.delegateServers} disabled={busy} onChange={(e) => patch({ delegateServers: e.target.value })} />
				</label>
				<p className="field-hint">{rich(t('settings.network.hostsHelp'))}</p>
			</fieldset>

			{/* Same shape as every other settings pane: the secondary action on the left, the commit on
			    the right edge of the panel. This row had them the other way round, so Save sat under
			    the card's left corner here and under its right corner one tab over. */}
			<div className="modal-actions">
				<button type="button" className="secondary" onClick={() => void runTest()} disabled={busy || testing}><Icon name="pulse" /> {testing ? t('settings.common.testing') : t('settings.network.testConnection')}</button>
				{resolved && <span className="muted small" title={t('settings.network.resolvedTitle')}>{t('settings.network.resolved', { value: resolved })}</span>}
				<span className="spacer" />
				{saved && <span className="form-status ok">{t('settings.common.saved')}</span>}
				<button type="button" onClick={() => void save()} disabled={busy}><Icon name="save" /> {busy ? t('settings.network.saving') : t('settings.network.saveApply')}</button>
			</div>

			{test && (
				<fieldset>
					<legend>{t('settings.network.testResult')}</legend>
					{test.targets.map((target) => (
						<div className={`form-status ${target.ok ? 'ok' : 'error'}`} key={target.host}>
							{target.ok ? '✓' : '✗'} {target.label}{!target.ok && target.detail ? `: ${target.detail}` : ''}
						</div>
					))}
					<div className="muted small" style={{ marginTop: 6 }}>{rich(t('settings.network.reachableHelp'))}</div>
				</fieldset>
			)}
		</>
	);
}

/**
 * Why agents cannot reach the broker, with the one thing the person can do about it: move to
 * another port (a taken port is never walked past by itself), or replace the token after a lockout
 * (never done by itself either).
 */
function McpProblemPanel({ problem, busy, onMove, onReplaceToken }: { problem: McpProblem; busy: boolean; onMove: (port: number) => void; onReplaceToken: () => void }): JSX.Element {
	const t = useT();
	const notice = mcpProblemNotice(problem);
	const [port, setPort] = useState<string>(problem.kind === 'port-in-use' && problem.suggestedPort ? String(problem.suggestedPort) : '');
	const chosen = Number(port);
	const valid = Number.isInteger(chosen) && chosen >= 1024 && chosen <= 65535;
	return (
		<div className="mcp-problem" data-testid="mcp-problem">
			<div className={`form-status ${problem.kind === 'port-in-use' ? 'error' : 'warn'}`}>{notice.title}</div>
			<p className="field-hint">{notice.detail}</p>
			{problem.kind === 'port-in-use' ? (
				<>
					<label>
						{t('settingsAgent.anotherPort')}
						<input type="number" min={1024} max={65535} value={port} disabled={busy} onChange={(e) => setPort(e.target.value)} />
					</label>
					<div className="mcp-actions">
						<button type="button" disabled={busy || !valid} onClick={() => onMove(chosen)}>{t('settingsAgent.moveReplace')}</button>
					</div>
				</>
			) : (
				<div className="mcp-actions">
					<button type="button" className="secondary" disabled={busy} onClick={onReplaceToken}><Icon name="refresh" /> {t('settingsAgent.replaceToken')}</button>
				</div>
			)}
		</div>
	);
}

type GrantableCapability = { name: string; title: string; description: string; domain: string };

/** What each capability domain is called as a heading in the App actions list. A domain missing
 *  here still gets a heading, its own name capitalised. */
const GRANT_DOMAIN_LABEL_KEYS: Record<string, string> = {
	app: 'settingsAgent.domains.app',
	canvas: 'settingsAgent.domains.canvas',
	cloud: 'settingsAgent.domains.cloud',
	connections: 'settingsAgent.domains.connections',
	editor: 'settingsAgent.domains.editor',
	flows: 'settingsAgent.domains.flows',
	knowledge: 'settingsAgent.domains.knowledge',
	logs: 'settingsAgent.domains.logs',
	monitors: 'settingsAgent.domains.monitors',
	notifications: 'settingsAgent.domains.notifications',
	orbit: 'settingsAgent.domains.orbit',
	results: 'settingsAgent.domains.results',
	schema: 'settingsAgent.domains.schema',
	security: 'settingsAgent.domains.security',
	settings: 'settingsAgent.domains.settings',
	tunnels: 'settingsAgent.domains.tunnels',
	workspace: 'settingsAgent.domains.workspace',
};

/** The grantable actions grouped by domain, in the order the app published them, so a list of
 *  thirty-odd reads as a handful of headed groups rather than one long column. */
function grantGroups(caps: GrantableCapability[], translator: Translate): Array<{ domain: string; label: string; caps: GrantableCapability[] }> {
	const groups = new Map<string, GrantableCapability[]>();
	for (const cap of caps) {
		const list = groups.get(cap.domain);
		if (list) {
			list.push(cap);
		} else {
			groups.set(cap.domain, [cap]);
		}
	}
	return [...groups].map(([domain, list]) => ({
		domain,
		label: GRANT_DOMAIN_LABEL_KEYS[domain] ? translator(GRANT_DOMAIN_LABEL_KEYS[domain]) : domain.charAt(0).toUpperCase() + domain.slice(1),
		caps: list,
	}));
}

function AgentAccessSection({ reveal }: { reveal?: { label: string; labelKey?: string; nonce: number } }): JSX.Element {
	const t = useT();
	const [status, setStatus] = useState<McpStatus | null>(null);
	// The agent console's own settings, which is where "may an agent change the app" lives.
	const [agentConfig, setAgentConfig] = useState<AgentConsoleConfig | null>(null);
	// The coding agents on this machine. Re-probed when this page opens, so somebody who installs
	// one and comes straight here sees it without restarting the app.
	const [agents, setAgents] = useState<AgentConsoleStatus[]>([]);
	const [probing, setProbing] = useState(false);
	const [busy, setBusy] = useState(false);
	// Every app-changing action an agent could ask for, so a grant can be given here rather than only
	// in the moment the agent asks. Read from main, which holds what the renderer published.
	const [mutating, setMutating] = useState<GrantableCapability[]>([]);
	const [copiedKey, setCopiedKey] = useState<string | null>(null);
	const [client, setClient] = useState<string>(MCP_CLIENT_PRESETS[0].id);
	const [agentTab, setAgentTab] = useState<AgentTab>('databases');
	const [confirm, confirmDialog] = useConfirm();

	async function regenerate(): Promise<void> {
		const ok = await confirm({
			title: t('settingsAgent.regenerateTitle'),
			body: t('settingsAgent.regenerateBody'),
			confirmLabel: t('settingsAgent.regenerateToken'),
			danger: true,
		});
		if (!ok) {
			return;
		}
		await run(() => window.sqlApi.mcp.regenerateToken());
	}

	// Follow the search to the tab the setting is actually on. Runs before the page's own reveal
	// pass paints, so the control it flashes is on screen by the time it looks for it.
	useEffect(() => {
		const target = reveal?.labelKey && AGENT_TAB_FOR_SETTING[reveal.labelKey];
		if (target) {
			setAgentTab(target);
		}
	}, [reveal]);

	// Main reports a taken port or a lockout as it happens, so the notice shown must follow.
	useEffect(() => window.sqlApi.mcp.onChanged(() => {
		void window.sqlApi.mcp.status().then(setStatus).catch(() => undefined);
	}), []);

	useEffect(() => {
		void window.sqlApi.mcp.status().then(setStatus).catch(() => setStatus(null));
		void window.sqlApi.agentConsole.config().then(setAgentConfig).catch(() => setAgentConfig(null));
		void window.sqlApi.agentConsole.mutatingCapabilities().then(setMutating).catch(() => setMutating([]));
		setProbing(true);
		void window.sqlApi.agentConsole.discoverAll().then(setAgents).catch(() => setAgents([])).finally(() => setProbing(false));
	}, []);

	async function run(action: () => Promise<McpStatus>): Promise<void> {
		setBusy(true);
		try {
			setStatus(await action());
		} finally {
			setBusy(false);
		}
	}

	const granted = agentConfig?.autoApproveCapabilities ?? [];

	async function copy(text: string, key: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			setCopiedKey(key);
			setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
		} catch {
			// Clipboard denied — the user can still select the text manually.
		}
	}

	if (!status) {
		return <div className="muted">{t('settings.common.loading')}</div>;
	}

	const exposed = status.connections.filter((c) => c.allowed).length;
	const anyWrites = status.connections.some((c) => c.allowed && c.writes);
	const clientPreset = MCP_CLIENT_PRESETS.find((p) => p.id === client) ?? MCP_CLIENT_PRESETS[0];
	const clientText = clientPreset.build(status);

	return (
		<>
			<SettingsIntro art={AgentAccessArt}>
				<p>{t('settingsAgent.intro')}</p>
			</SettingsIntro>

			<label className="check">
				<input type="checkbox" checked={status.enabled} disabled={busy} onChange={(e) => void run(() => window.sqlApi.mcp.setEnabled(e.target.checked))} />
				{t('settingsAgent.allowAccess')} {t('settingsAgent.allowAccessHint')}
			</label>

			{status.enabled && (
				<>
					{status.problem ? (
						<McpProblemPanel problem={status.problem} busy={busy} onMove={(port) => void run(() => window.sqlApi.mcp.changePort(port))} onReplaceToken={() => void regenerate()} />
					) : (
						<div className={`form-status ${status.running ? 'ok' : 'error'}`}>
							{status.running ? t('settingsAgent.listening', { url: status.url }) : t('settingsAgent.notRunning')}
						</div>
					)}

					<div className="tabs agent-section-tabs">
						{AGENT_TABS.map((entry) => (
							<button
								type="button"
								key={entry.id}
								className={agentTab === entry.id ? 'tab active' : 'tab'}
								onClick={() => setAgentTab(entry.id)}
							>
								{t(entry.labelKey)}
							</button>
						))}
					</div>

					{agentTab === 'databases' && (
					<>
					<fieldset>
						<legend>{t('settingsAgent.connectionsLegend')}</legend>
						<div className="muted small">{t('settingsAgent.connectionsHelp')}</div>
						{status.connections.length === 0 && <div className="muted small">{t('settingsAgent.noConnections')}</div>}
						{status.connections.map((c) => (
							<div className="mcp-conn" key={c.id}>
								<label className="check">
									<input type="checkbox" checked={c.allowed} disabled={busy} onChange={(e) => void run(() => window.sqlApi.mcp.setAllowed(c.id, e.target.checked))} />
									{c.label}
									{c.environment && <span className={`env${c.environment === 'prod' ? ' prod' : ''}`} style={{ marginLeft: 6 }}>{c.environment}</span>}
									{c.readOnly && <span className="model-picker-label" style={{ marginLeft: 6 }}>{t('settingsAgent.readOnly')}</span>}
								</label>
								{c.allowed && !c.readOnly && (
									<label className="check mcp-writes">
										<input type="checkbox" checked={c.writes} disabled={busy} onChange={(e) => void run(() => window.sqlApi.mcp.setWrites(c.id, e.target.checked))} />
										{t('settingsAgent.allowWrites')} (INSERT/UPDATE/DELETE/DDL) <span className="muted">{t('settingsAgent.offByDefault')}</span>
									</label>
								)}
								{c.allowed && c.readOnly && (
									<div className="muted small mcp-writes">{t('settingsAgent.readOnlyNote')}</div>
								)}
								{c.allowed && (c.readOnly || !c.writes) && (
									<div className="muted small mcp-writes">{c.readOnlyBy}</div>
								)}
							</div>
						))}
						{anyWrites && <div className="form-status error" style={{ marginTop: 6 }}>{t('settingsAgent.writesEnabled')}</div>}
					</fieldset>
					<div className="muted small mcp-footnote">{t('settingsAgent.footnote')}</div>
					</>
					)}

					{agentTab === 'agents' && (
					<>
					<fieldset>
						<legend>{t('settingsAgent.agentsLegend')}</legend>
						<div className="muted small">{t('settingsAgent.agentsHelp')}</div>
						{AGENT_KINDS.map((kind) => {
							const descriptor = agentDescriptor(kind);
							const found = agents.find((a) => a.kind === kind);
							const installed = found?.install.installed === true;
							return (
								<div className="agent-pick" key={kind}>
									<label className="check">
										<input
											type="checkbox"
											checked={found?.visible === true}
											disabled={!installed || probing}
											onChange={(e) => { void window.sqlApi.agentConsole.setEnabled(kind, e.target.checked).then(setAgents); }}
										/>
										<Icon name={descriptor.icon} /> {descriptor.label}
									</label>
									<div className="muted small agent-pick-state">
										{installed
											? <>{found?.install.version ? t('settingsAgent.foundVersion', { version: found.install.version }) : t('settingsAgent.found')}. {t(descriptor.handoff === 'manual' ? 'settingsAgent.manualHandoff' : 'settingsAgent.autoHandoff')}</>
											: found?.install.pinned
												? <>{t('settingsAgent.gone')} <button type="button" className="link-btn" onClick={() => { void window.sqlApi.agentConsole.setPath(kind).then(setAgents); }}>{t('settingsAgent.chooseAgain')}</button></>
												: <>{t('settingsAgent.notInstalled')} <button type="button" className="link-btn" onClick={() => void window.sqlApi.openExternal(descriptor.installUrl)}>{t('settingsAgent.howToInstall')}</button></>}
									</div>
									{/* The failsafe behind discovery: we look on your PATH, and if we cannot find an
									    agent you know you have, you point us at it. */}
									<div className="muted small agent-pick-path">
										{found?.install.path
											? <>{found.install.pinned ? t('settingsAgent.youChose') : t('settingsAgent.at')} <code>{found.install.path}</code>{' '}
												<button type="button" className="link-btn" onClick={() => { void window.sqlApi.agentConsole.setPath(kind).then(setAgents); }}>{t('settingsAgent.chooseDifferent')}</button>
												{found.install.pinned && <> &middot; <button type="button" className="link-btn" onClick={() => { void window.sqlApi.agentConsole.setPath(kind, null).then(setAgents); }}>{t('settingsAgent.lookOnPath')}</button></>}</>
											: !found?.install.pinned && <button type="button" className="link-btn" onClick={() => { void window.sqlApi.agentConsole.setPath(kind).then(setAgents); }}>{t('settingsAgent.pointAtIt')}</button>}
									</div>
								</div>
							);
						})}
						<button type="button" className="secondary" disabled={probing} onClick={() => { setProbing(true); void window.sqlApi.agentConsole.discoverAll().then(setAgents).finally(() => setProbing(false)); }}>
							<Icon name="search" /> {probing ? t('settingsAgent.looking') : t('settingsAgent.lookAgain')}
						</button>
					</fieldset>

					<AgentAiRouteSettings agents={agents} />

					<fieldset>
						<legend>{t('settingsAgent.insideLegend')}</legend>
						<div className="muted small">{t('settingsAgent.insideHelp')}</div>
						<label className="check">
							<input
								type="checkbox"
								checked={agentConfig?.routeDatabaseThroughApp !== false}
								disabled={busy || !agentConfig}
								onChange={(e) => { void window.sqlApi.agentConsole.setRouteDatabase(e.target.checked).then(setAgentConfig); }}
							/>
							{t('settingsAgent.routeThroughApp')}
						</label>
						<div className="muted small">{t('settingsAgent.nextStart')}</div>
						{agentConfig?.routeDatabaseThroughApp !== false && (
							<details className="agent-house-rules">
								<summary>{t('settingsAgent.whatToldSummary')}</summary>
								<pre>{agentHouseRules({ serverName: MCP_SERVER_NAME, canDraw: true })}</pre>
							</details>
						)}
					</fieldset>
					</>
					)}

					{agentTab === 'actions' && (
					<>
					<fieldset>
						<legend>{t('settingsAgent.actionsLegend')}</legend>
						<div className="muted small">{t('settingsAgent.actionsHelp')}</div>
						<label className="check">
							<input
								type="checkbox"
								checked={agentConfig?.allowMutatingCapabilities === true}
								disabled={busy || !agentConfig}
								onChange={(e) => { void window.sqlApi.agentConsole.setAllowMutating(e.target.checked).then(setAgentConfig); }}
							/>
							{t('settingsAgent.letChangeApp')}
						</label>
						{agentConfig?.allowMutatingCapabilities && (
							<>
								<div className="muted small">{t('settingsAgent.autoHelp')}</div>
								{mutating.length === 0
									? <div className="muted small">{t('settingsAgent.nothingYet')}</div>
									: (
										<>
										{/* One click for the whole list. Each is disabled once it would do nothing,
										    so the pair also reads as where the list currently stands. The section's
										    own copy above says what a selected action means; the buttons only have
										    to say which way they go. */}
										<div className="agent-grant-actions">
											<button
												type="button"
												className="link-btn"
												disabled={busy || granted.length === mutating.length}
												onClick={() => { void window.sqlApi.agentConsole.setAutoApproveAll(mutating.map((cap) => cap.name), true).then(setAgentConfig); }}
											>
												{t('settingsAgent.selectAll')}
											</button>
											<button
												type="button"
												className="link-btn"
												disabled={busy || granted.length === 0}
												onClick={() => { void window.sqlApi.agentConsole.clearAutoApprove().then(setAgentConfig); }}
											>
												{t('settingsAgent.unselectAll')}
											</button>
										</div>
										<div className="agent-grant-list">
											{grantGroups(mutating, t).map((group) => (
												<section className="agent-grant-group" key={group.domain}>
													<h4 className="agent-grant-group-title">{group.label}</h4>
													{group.caps.map((cap) => (
														<label className="agent-grant" key={cap.name}>
															<input
																type="checkbox"
																checked={granted.includes(cap.name)}
																disabled={busy}
																onChange={(e) => { void window.sqlApi.agentConsole.setAutoApprove(cap.name, e.target.checked).then(setAgentConfig); }}
															/>
															<span className="agent-grant-text">
																<span className="agent-grant-title">{cap.title}</span>
																<span className="agent-grant-desc">{cap.description}</span>
															</span>
														</label>
													))}
												</section>
											))}
										</div>
										</>
									)}
							</>
						)}
					</fieldset>
					</>
					)}

					{agentTab === 'connect' && (
					<>
					<fieldset>
						<legend>{t('settingsAgent.connectLegend')}</legend>
						<div className="muted small">{rich(t('settingsAgent.connectHelp'))}</div>
						<pre className="mcp-snippet">{mcpConfigSnippet(status)}</pre>
						<div className="modal-actions">
							<button type="button" className="secondary" onClick={() => void copy(mcpConfigSnippet(status), 'json')}><Icon name="copy" /> {copiedKey === 'json' ? t('settings.common.copied') : t('settingsAgent.copyConfig')}</button>
							<span className="spacer" />
							<button type="button" className="secondary" disabled={busy} title={t('settingsAgent.regenerateHint')} onClick={() => void regenerate()}><Icon name="refresh" /> {t('settingsAgent.regenerateToken')}</button>
						</div>
						</fieldset>
						<fieldset>
							<legend>{t('settingsAgent.commandLegend')}</legend>
							<div className="mcp-client-row">
							<span className="muted small">{t('settingsAgent.specificClient')}</span>
							<select value={client} onChange={(e) => setClient(e.target.value)}>
								{MCP_CLIENT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
							</select>
						</div>
						<div className="muted small">{t(clientPreset.noteKey)}</div>
						<pre className="mcp-snippet">{clientText}</pre>
						<div className="modal-actions">
							<button type="button" className="secondary" onClick={() => void copy(clientText, 'client')}><Icon name="copy" /> {copiedKey === 'client' ? t('settings.common.copied') : t('settings.common.copy')}</button>
						</div>
						{exposed === 0 && <div className="muted small">{t('settingsAgent.tipSelect')}</div>}
					</fieldset>
					{/* The sign-in handoff. It sits on this tab because it is the same question as
					    the block above it, asked by a command line instead of an agent: how does
					    something else on this computer get in. */}
					<fieldset>
						<legend>{t('settingsAgent.accountLegend')}</legend>
						<div className="muted small">{rich(t('settingsAgent.accountHelp'))}</div>
						<label className="check">
							<input
								type="checkbox"
								checked={status.signInHandoff}
								disabled={busy}
								onChange={(e) => void run(() => window.sqlApi.mcp.setSignInHandoff(e.target.checked))}
							/>
							{t('settingsAgent.letProgramUse')} {t('settingsAgent.letProgramUseHint')}
						</label>
						{/* Said once and said honestly. Asking prevents surprise, not attack: a program
						    running as you already has whatever you have. Never "nothing could take it". */}
						<div className="muted small">{t('settingsAgent.courtesyHelp')}</div>
					</fieldset>
					</>
					)}
				</>
			)}
			{confirmDialog}
		</>
	);
}

/** A turn's (or a run's) cost as a share of the wallet, in PERCENT — never raw dollars (we show the
 *  user how fast the wallet drains, not dollars). Returns null when there's no metered cap to
 *  divide by (local/unlimited). Clamps tiny shares to "<0.01%" so a fraction of a cent still reads. */
function formatWalletShare(usd: number, maxBudget: number | undefined): string | null {
	if (!maxBudget || maxBudget <= 0) {
		return null;
	}
	if (usd <= 0) {
		return '0%';
	}
	const pct = (usd / maxBudget) * 100;
	return pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`;
}

/** The AI audit log: every recorded LLM interaction (chat, completion, edit), newest
 *  first, each expandable to its full conversation. Read-only apart from Clear. */
function AuditSection(props: { connections: ConnectionConfig[]; chatEnabled: boolean; completionEnabled: boolean; onToggleChat(v: boolean): void; onToggleCompletion(v: boolean): void }): JSX.Element {
	const t = useT();
	const PAGE_SIZE = 25;
	const [entries, setEntries] = useState<AiAuditEntry[] | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [kindFilter, setKindFilter] = useState<'all' | AiAuditKind>('all');
	const [query, setQuery] = useState('');
	const [page, setPage] = useState(0);
	// Live gateway wallet, so per-turn cost (below) can be read against the real balance, which is
	// what answers "does a small wallet survive a real session".
	const [budget, setBudget] = useState<AiBudgetStatus | null>(null);
	const [confirm, confirmDialog] = useConfirm();

	async function load(): Promise<void> {
		try {
			setEntries(await window.sqlApi.aiAuditLog());
		} catch {
			setEntries([]);
		}
		window.sqlApi.aiBudgetStatus().then(setBudget).catch(() => setBudget(null));
	}

	useEffect(() => { void load(); }, []);
	// Any filter change resets to the first page so the view never lands on an empty page.
	useEffect(() => { setPage(0); }, [kindFilter, query]);

	async function clear(): Promise<void> {
		if (!(await confirm({ title: t('settings.audit.clearTitle'), body: t('settings.audit.clearBody'), confirmLabel: t('settings.audit.clearLog'), danger: true }))) {
			return;
		}
		await window.sqlApi.clearAiAuditLog();
		await load();
	}

	function connLabel(id: string | undefined): string | null {
		if (!id) {
			return null;
		}
		return props.connections.find((c) => c.id === id)?.label ?? id;
	}

	if (!entries) {
		return <div className="muted">{t('settings.common.loading')}</div>;
	}

	const q = query.trim().toLowerCase();
	const filtered = entries.filter((e) => {
		if (kindFilter !== 'all' && e.kind !== kindFilter) {
			return false;
		}
		if (!q) {
			return true;
		}
		const hay = `${e.provider} ${e.model} ${e.response} ${e.messages.map((m) => m.content).join(' ')}`.toLowerCase();
		return hay.includes(q);
	});
	// Summed estimated cost of every recorded entry, shown as a SHARE of the wallet (never dollars)
	// so "what has the AI cost so far" reads as how much of the budget it drained (A5).
	const recordedCost = entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
	const recordedShare = recordedCost > 0 ? formatWalletShare(recordedCost, budget?.maxBudget) : null;
	const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	const clampedPage = Math.min(page, pageCount - 1);
	const pageEntries = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);
	const rangeStart = filtered.length === 0 ? 0 : clampedPage * PAGE_SIZE + 1;
	const rangeEnd = clampedPage * PAGE_SIZE + pageEntries.length;
	const filterActive = kindFilter !== 'all' || q.length > 0;

	return (
		<>
			{/* Not only chat: this one preference also governs every action taken on the user's behalf,
			    which includes a data flow's AI extraction stage running on a schedule with nobody
			    watching. Naming only chat left people who never open the assistant assuming it did
			    not apply to them. */}
			<label className="check"><input type="checkbox" checked={props.chatEnabled} onChange={(e) => props.onToggleChat(e.target.checked)} /> {t('settings.audit.recordChats', { assistant: ASSISTANT_NAME })}</label>
			<label className="check"><input type="checkbox" checked={props.completionEnabled} onChange={(e) => props.onToggleCompletion(e.target.checked)} /> {t('settings.audit.recordCompletion')}</label>
			<div className="muted">{t('settings.audit.help')}</div>
			{budget?.metered && budget.percentUsed !== undefined && (
				<div className="muted small audit-meta" title={t('settings.audit.walletTitle')}>
					<Icon name="credit-card" />
					<span>{t('settings.audit.wallet', { percent: budget.percentUsed })}</span>
					{recordedShare && <span className="muted">{t('settings.audit.recordedShare', { share: recordedShare })}</span>}
				</div>
			)}
			<div className="modal-actions">
				<button type="button" className="secondary" onClick={() => void load()}><Icon name="refresh" /> {t('settings.common.refresh')}</button>
				<span className="spacer" />
				<button type="button" className="secondary" disabled={entries.length === 0} onClick={() => void clear()}><Icon name="trash" /> {t('settings.audit.clearLog')}</button>
			</div>
			{entries.length === 0 && (
				<div className="settings-empty">
					<HistoryArt className="settings-empty-art" />
					<p>{t('settings.audit.empty')}</p>
				</div>
			)}
			{entries.length > 0 && (
				<div className="audit-filter">
					<select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as 'all' | AiAuditKind)}>
						<option value="all">{t('settings.audit.allKinds')}</option>
						<option value="chat">{t('settings.audit.kinds.chat')}</option>
						<option value="completion">{t('settings.audit.kinds.completion')}</option>
						<option value="edit">{t('settings.audit.kinds.edit')}</option>
						{/* A data flow's model calls are actions, and for a user who only runs flows they
						    are the ONLY entries in the log. Without this, every specific filter hid them. */}
						<option value="action">{t('settings.audit.kinds.action')}</option>
					</select>
					<input className="audit-search" value={query} placeholder={t('settings.audit.searchPlaceholder')} onChange={(e) => setQuery(e.target.value)} />
					<span className="spacer" />
					{filterActive && <span className="muted small">{t('settings.audit.matches', { count: filtered.length })}</span>}
				</div>
			)}
			{entries.length > 0 && filtered.length === 0 && <div className="muted">{t('settings.audit.noMatch')}</div>}
			<div className="audit-list">
				{pageEntries.map((e) => {
					const open = expanded === e.id;
					const conn = connLabel(e.connectionId);
					return (
						<div className={`audit-entry${e.ok ? '' : ' failed'}`} key={e.id}>
							<button type="button" className="audit-head" onClick={() => setExpanded(open ? null : e.id)}>
								<Icon name={open ? 'chevron-down' : 'chevron-right'} />
								<span className={`audit-kind ${e.kind}`}>{t(AUDIT_KIND_KEYS[e.kind])}</span>
								<span className="tree-label">{e.provider}{e.projectRef ? ` ${e.projectRef}` : ''} · {e.model}</span>
								{!e.ok && <span className="audit-badge error" title={e.error}>{t('settings.audit.failed')}</span>}
								<span className="spacer" />
								<span className="muted small">{new Date(e.timestamp).toLocaleString(formatLocale())}</span>
							</button>
							{open && (
								<div className="audit-body">
									<div className="muted small audit-meta">
										{conn && <span>{conn}</span>}
										<span>{e.durationMs} ms</span>
										{e.usage && <span>{t('settings.audit.tokens', { total: e.usage.totalTokens, prompt: e.usage.promptTokens, completion: e.usage.completionTokens })}</span>}
										{e.costUsd !== undefined && budget?.metered && formatWalletShare(e.costUsd, budget.maxBudget) && (
											<span title={t('settings.audit.shareTitle')}>{t('settings.audit.shareOfWallet', { share: formatWalletShare(e.costUsd, budget.maxBudget) ?? '' })}</span>
										)}
									</div>
									{e.error && <div className="form-status error">{e.error}</div>}
									{e.systemPrompt && (
										<div className="audit-msg grounding">
											{/* An action's system prompt is the stage's own instructions, not the schema
											    grounding a chat turn gets; calling it "schema" would misdescribe the
											    only entries a flows-only user ever sees. */}
											<div className="audit-role">{e.kind === 'action' ? t('settings.audit.instructionsSent') : t('settings.audit.contextSent')} · {t('settings.audit.chars', { chars: e.systemPrompt.length, tokens: Math.round(e.systemPrompt.length / 4) })}</div>
											<pre>{e.systemPrompt}</pre>
										</div>
									)}
									{e.messages.map((m, i) => (
										<div className="audit-msg" key={i}>
											<div className="audit-role">{m.role}</div>
											<pre>{m.content}</pre>
										</div>
									))}
									<div className="audit-msg reply">
										<div className="audit-role">{t('settings.audit.reply')}</div>
										<pre>{e.response || t('settings.audit.empty2')}</pre>
									</div>
								</div>
							)}
						</div>
					);
				})}
			</div>
			{pageCount > 1 && (
				<div className="audit-pager">
					<button type="button" className="secondary small" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}><Icon name="chevron-left" /> {t('settings.audit.prev')}</button>
					<span className="muted small">{t('settings.audit.range', { start: rangeStart, end: rangeEnd, total: filtered.length })}</span>
					<button type="button" className="secondary small" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)}>{t('settings.audit.next')} <Icon name="chevron-right" /></button>
				</div>
			)}
			{confirmDialog}
		</>
	);
}

const SCOPE_LABEL: Record<KnowledgeScope, string> = { glossary: 'settings.knowledge.scopes.glossary', table: 'settings.knowledge.scopes.table', column: 'settings.knowledge.scopes.column' };

/** Per-connection knowledge base management: the reviewable list that makes inline capture safe.
 *  Pick a connection, then view/toggle/edit/delete its notes or add one manually. Glossary notes
 *  are always injected; table/column notes ride schema linking. */
function KnowledgeSection(props: { connections: ConnectionConfig[]; activeConnectionId?: string }): JSX.Element {
	const t = useT();
	// "General" (all databases) is a first-class scope alongside each connection, so app-wide rules
	// have a home even with no connection selected. Default to the active DB, else General.
	const [connId, setConnId] = useState<string>(props.activeConnectionId ?? props.connections[0]?.id ?? GLOBAL_CONNECTION);
	const isGeneral = connId === GLOBAL_CONNECTION;
	const [notes, setNotes] = useState<KnowledgeNote[] | null>(null);
	const [editing, setEditing] = useState<KnowledgeNote | null>(null);
	const [adding, setAdding] = useState(false);
	const [confirm, confirmDialog] = useConfirm();

	async function load(): Promise<void> {
		if (!connId) {
			setNotes([]);
			return;
		}
		setNotes(await window.sqlApi.knowledgeNotes(connId));
	}

	useEffect(() => { void load(); }, [connId]);

	async function toggle(note: KnowledgeNote): Promise<void> {
		await window.sqlApi.setKnowledgeNoteEnabled(note.id, !note.enabled);
		await load();
	}

	async function remove(note: KnowledgeNote): Promise<void> {
		if (!(await confirm({ title: t('settings.knowledge.deleteNoteTitle'), body: note.text, confirmLabel: t('settings.common.delete'), danger: true }))) {
			return;
		}
		await window.sqlApi.deleteKnowledgeNote(note.id);
		await load();
	}

	async function approve(note: KnowledgeNote): Promise<void> {
		await window.sqlApi.approveKnowledgeNote(note.id);
		await load();
	}

	async function dismiss(note: KnowledgeNote): Promise<void> {
		await window.sqlApi.dismissKnowledgeNote(note.id);
		await load();
	}

	return (
		<>
			<SettingsIntro art={KnowledgeArt}>
				<p>{rich(t('settings.knowledge.intro', { assistant: ASSISTANT_NAME }))}</p>
			</SettingsIntro>
			<label>{t('settings.knowledge.appliesTo')}
				<select value={connId} onChange={(e) => { setConnId(e.target.value); setEditing(null); setAdding(false); }}>
					<option value={GLOBAL_CONNECTION}>{t('settings.knowledge.general')}</option>
					{props.connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
				</select>
			</label>
			{notes === null
				? <div className="muted">{t('settings.common.loading')}</div>
				: (
					<>
						{notes.length === 0 && !adding && <div className="muted knowledge-empty">{isGeneral
							? t('settings.knowledge.emptyGeneral')
							: rich(t('settings.knowledge.emptyTaught'))}</div>}
						{notes.some((n) => n.status === 'suggested') && (
							<div className="knowledge-list">
								<div className="muted small">{t('settings.knowledge.suggested')}</div>
								{notes.filter((n) => n.status === 'suggested').map((note) => (
									<div className="knowledge-item suggested" key={note.id}>
										<div className="knowledge-item-body">
											<div className="knowledge-item-text">{note.text}</div>
										</div>
										<div className="knowledge-item-actions">
											<button type="button" title={t('settings.knowledge.rememberTitle')} onClick={() => void approve(note)}><Icon name="check" /> {t('settings.knowledge.remember')}</button>
											<button type="button" className="icon-btn" aria-label={t('settings.common.dismiss')} onClick={() => void dismiss(note)}><Icon name="close" /></button>
										</div>
									</div>
								))}
							</div>
						)}
						<div className="knowledge-list">
							{notes.filter((n) => (n.status ?? 'active') === 'active').map((note) => editing?.id === note.id
								? <KnowledgeEditor key={note.id} connId={connId} globalOnly={isGeneral} note={note} onDone={() => { setEditing(null); void load(); }} onCancel={() => setEditing(null)} />
								: (
									<div className={`knowledge-item${note.enabled ? '' : ' disabled'}`} key={note.id}>
										<label className="knowledge-item-toggle" title={note.enabled ? t('settings.knowledge.enabledTitle') : t('settings.knowledge.disabledTitle')}>
											<input type="checkbox" checked={note.enabled} onChange={() => void toggle(note)} />
										</label>
										<div className="knowledge-item-body">
											<div className="knowledge-item-text">{note.text}</div>
											<div className="knowledge-item-meta muted small">
												<span className="knowledge-badge">{t(SCOPE_LABEL[note.scope])}</span>
												{note.target && <code>{note.target}</code>}
												{note.pinned && <span className="knowledge-badge" title={t('settings.knowledge.pinnedTitle')}>{t('settings.knowledge.pinned')}</span>}
											</div>
										</div>
										<div className="knowledge-item-actions">
											<button type="button" className="icon-btn" aria-label={t('settings.common.edit')} onClick={() => { setAdding(false); setEditing(note); }}><Icon name="edit" /></button>
											<button type="button" className="icon-btn" aria-label={t('settings.common.delete')} onClick={() => void remove(note)}><Icon name="trash" /></button>
										</div>
									</div>
								))}
						</div>
						{adding
							? <KnowledgeEditor connId={connId} globalOnly={isGeneral} onDone={() => { setAdding(false); void load(); }} onCancel={() => setAdding(false)} />
							: <button type="button" className="secondary knowledge-add" disabled={!connId} onClick={() => { setEditing(null); setAdding(true); }}><Icon name="add" /> {t('settings.knowledge.addNote')}</button>}
					</>
				)}
			{confirmDialog}
		</>
	);
}

/** The add/edit form for a single knowledge note. Reused for a fresh add (no `note`) and an
 *  in-place edit. Saves through the store (upsert by id); glossary notes carry no target. */
function KnowledgeEditor(props: { connId: string; globalOnly?: boolean; note?: KnowledgeNote; onDone(): void; onCancel(): void }): JSX.Element {
	const t = useT();
	const [text, setText] = useState(props.note?.text ?? '');
	// General (all-databases) rules are always glossary — table/column scopes are schema-specific.
	const [scope, setScope] = useState<KnowledgeScope>(props.globalOnly ? 'glossary' : props.note?.scope ?? 'glossary');
	const [target, setTarget] = useState(props.note?.target ?? '');
	const [pinned, setPinned] = useState(props.note?.pinned ?? true);

	async function save(): Promise<void> {
		const trimmed = text.trim();
		const tgt = scope === 'glossary' ? undefined : target.trim().toLowerCase() || undefined;
		if (!trimmed || (scope !== 'glossary' && !tgt)) {
			return;
		}
		const now = Date.now();
		await window.sqlApi.saveKnowledgeNote({
			id: props.note?.id ?? crypto.randomUUID(),
			connectionId: props.connId,
			scope,
			target: tgt,
			text: trimmed,
			enabled: props.note?.enabled ?? true,
			pinned: scope !== 'glossary' ? pinned : undefined,
			source: props.note?.source ?? 'manual',
			createdAt: props.note?.createdAt ?? now,
			updatedAt: now,
		});
		props.onDone();
	}

	return (
		<div className="chat-approval knowledge-capture knowledge-editor">
			<textarea
				className="knowledge-capture-text"
				value={text}
				rows={3}
				placeholder={t('settings.knowledge.placeholder')}
				onChange={(e) => setText(e.target.value)}
			/>
			<div className="knowledge-capture-row">
				{!props.globalOnly && (
				<label>{t('settings.knowledge.scope')}
					<select value={scope} onChange={(e) => setScope(e.target.value as KnowledgeScope)}>
						<option value="glossary">{t('settings.knowledge.scopeGlossary')}</option>
						<option value="table">{t('settings.knowledge.scopes.table')}</option>
						<option value="column">{t('settings.knowledge.scopes.column')}</option>
					</select>
				</label>
				)}
				{scope !== 'glossary' && (
					<label>{scope === 'column' ? 'table.column' : t('settings.knowledge.scopes.table')}
						<input type="text" value={target} placeholder={scope === 'column' ? 'customer_order.fulfilled_date' : 'customer_order'} onChange={(e) => setTarget(e.target.value)} />
					</label>
				)}
				{scope !== 'glossary' && (
					<label className="knowledge-capture-pin" title={t('settings.knowledge.pinTableTitle')}>
						<input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> {t('settings.knowledge.pinTable')}
					</label>
				)}
			</div>
			<div className="chat-approval-actions">
				<button type="button" disabled={!text.trim() || (scope !== 'glossary' && !target.trim())} onClick={() => void save()}><Icon name="save" /> {t('settings.common.save')}</button>
				<button type="button" className="secondary" onClick={props.onCancel}><Icon name="close" /> {t('settings.common.cancel')}</button>
			</div>
		</div>
	);
}

const RESET_ITEMS: Array<{ key: keyof ResetOptions; labelKey: string; detailKey: string }> = [
	{ key: 'layout', labelKey: 'settings.reset.items.layout', detailKey: 'settings.reset.items.layoutDetail' },
	{ key: 'preferences', labelKey: 'settings.reset.items.preferences', detailKey: 'settings.reset.items.preferencesDetail' },
	{ key: 'connections', labelKey: 'settings.reset.items.connections', detailKey: 'settings.reset.items.connectionsDetail' },
	{ key: 'queries', labelKey: 'settings.reset.items.queries', detailKey: 'settings.reset.items.queriesDetail' },
	{ key: 'chats', labelKey: 'settings.reset.items.chats', detailKey: 'settings.reset.items.chatsDetail' },
	{ key: 'audit', labelKey: 'settings.reset.items.audit', detailKey: 'settings.reset.items.auditDetail' },
];

const AUDIT_KIND_KEYS: Record<AiAuditKind, string> = {
	chat: 'settings.audit.kinds.chat',
	completion: 'settings.audit.kinds.completion',
	edit: 'settings.audit.kinds.edit',
	action: 'settings.audit.kinds.action',
};

const NO_RESET: ResetOptions = { layout: false, preferences: false, connections: false, queries: false, chats: false, audit: false };

/** Reset chosen categories of settings/data back to defaults. Destructive, so it confirms
 *  first and reports what it cleared. Each category maps to a localStorage reset (handled in
 *  App) or a store-clearing IPC call. */
/** GPU rendering opt-out. State lives in main (userData/gpu.json) because Electron has to read it
 *  before the app is ready, so it can't ride along in the localStorage appSettings. On by default;
 *  the escape hatch is for users whose graphics driver makes Chromium abort the app. Applies on the
 *  next launch, which the copy has to say plainly or the toggle looks broken. */
function HardwareAccelerationSetting(): JSX.Element | null {
	const t = useT();
	const [state, setState] = useState<{ enabled: boolean; autoDisabled: boolean } | null>(null);
	const [busy, setBusy] = useState(false);
	// Only shown after a change: the restart requirement is noise until it's true.
	const [restartNeeded, setRestartNeeded] = useState(false);

	useEffect(() => {
		void window.sqlApi.getGpu().then(setState).catch(() => setState({ enabled: true, autoDisabled: false }));
	}, []);

	async function toggle(next: boolean): Promise<void> {
		setBusy(true);
		try {
			const enabled = await window.sqlApi.setGpu(next);
			// Turning it back on is the user overruling our auto-disable, so the explanation goes away.
			setState({ enabled, autoDisabled: enabled ? false : (state?.autoDisabled ?? false) });
			setRestartNeeded(true);
		} finally {
			setBusy(false);
		}
	}

	if (!state) {
		return null;
	}

	return (
		<>
			<label className="check">
				<input type="checkbox" checked={state.enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} /> {t('settings.appearance.gpuToggle')}
			</label>
			<div className="muted">{t('settings.appearance.gpuHelp')}</div>
			{state.autoDisabled && (
				<div className="muted small">{t('settings.appearance.gpuAutoDisabled')}</div>
			)}
			{restartNeeded && <div className="muted small">{t('settings.appearance.gpuRestart')}</div>}
		</>
	);
}

/** Crash/error reporting opt-out. State lives in main (userData/telemetry.json); this reads and
 *  writes it over IPC. `available` is false when no DSN ships, in which case the toggle is inert. */
function PrivacySection({ signedIn }: { signedIn: boolean }): JSX.Element {
	const t = useT();
	const [state, setState] = useState<{ enabled: boolean; available: boolean } | null>(null);
	const [syncOn, setSyncOn] = useState<boolean>(() => syncEnabled());
	const [syncBusy, setSyncBusy] = useState(false);
	const [syncStatus, setSyncStatus] = useState<string | null>(null);
	const [confirm, confirmDialog] = useConfirm();
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void window.sqlApi.getTelemetry().then(setState).catch(() => setState({ enabled: false, available: false }));
	}, []);

	function toggleSync(on: boolean): void {
		setSyncEnabled(on);
		setSyncOn(on);
		setSyncStatus(on ? t('settings.privacy.syncOn') : t('settings.privacy.syncPaused'));
	}

	async function deleteSynced(): Promise<void> {
		const ok = await confirm({
			title: t('settings.privacy.deleteTitle'),
			body: t('settings.privacy.deleteBody'),
			confirmLabel: t('settings.common.delete'),
			danger: true,
		});
		if (!ok) {
			return;
		}
		setSyncBusy(true);
		try {
			await window.sqlApi.settingsSync.wipe();
			setSyncStatus(t('settings.privacy.deleted'));
		} catch {
			setSyncStatus(t('settings.privacy.deleteFailed'));
		} finally {
			setSyncBusy(false);
		}
	}

	async function toggle(enabled: boolean): Promise<void> {
		setBusy(true);
		try {
			const next = await window.sqlApi.setTelemetry(enabled);
			setState((prev) => (prev ? { ...prev, enabled: next } : prev));
		} finally {
			setBusy(false);
		}
	}

	if (!state) {
		return <div className="muted">{t('settings.common.loading')}</div>;
	}

	return (
		<>
			<SettingsIntro art={PrivacyArt}>
				<p>{t('settings.privacy.intro')}</p>
			</SettingsIntro>
			<label className="check">
				<input type="checkbox" checked={state.enabled} disabled={busy || !state.available} onChange={(e) => void toggle(e.target.checked)} /> {t('settings.privacy.sendReports')}
			</label>
			{/* The install heartbeat and the daily activity ping ride on this same switch, and only the
			    official build sends them (main/installHeartbeat.ts), so only it may say so. */}
			{OFFICIAL_BUILD ? (
				<div className="muted">{t('settings.privacy.official')}</div>
			) : (
				<div className="muted">{t('settings.privacy.openBuild')}</div>
			)}
			{!state.available && <div className="muted small">{t('settings.privacy.notConfigured')}</div>}
			<fieldset>
				<legend>{t('settings.privacy.syncLegend')}</legend>
				<label className="check">
					<input type="checkbox" checked={syncOn} disabled={!signedIn} onChange={(e) => toggleSync(e.target.checked)} /> {t('settings.privacy.syncToggle')}
				</label>
				<div className="muted">{t('settings.privacy.syncHelp')}</div>
				{!signedIn && <div className="muted small">{t('settings.privacy.signInToSync')}</div>}
				{signedIn && (
					<div className="modal-actions">
						<span className="spacer" />
						<button type="button" className="danger" disabled={syncBusy} onClick={() => void deleteSynced()}><Icon name="trash" /> {syncBusy ? t('settings.privacy.deleting') : t('settings.privacy.deleteSynced')}</button>
					</div>
				)}
				{syncStatus && <div className="form-status ok">{syncStatus}</div>}
			</fieldset>
			{confirmDialog}
		</>
	);
}

function ResetSection(props: { onReset(options: ResetOptions): Promise<void> }): JSX.Element {
	const t = useT();
	// "Liby, the AI assistant" in the official build, "the AI assistant" in the open one.
	const intro = ASSISTANT_INTRO.startsWith(ASSISTANT_NAME) ? t('settings.assistantIntro.named', { assistant: ASSISTANT_NAME }) : t('settings.assistantIntro.unnamed');
	const [selected, setSelected] = useState<ResetOptions>(NO_RESET);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [confirm, confirmDialog] = useConfirm();

	const anySelected = RESET_ITEMS.some((i) => selected[i.key]);

	function toggle(key: keyof ResetOptions, on: boolean): void {
		setSelected((prev) => ({ ...prev, [key]: on }));
		setStatus(null);
	}

	async function run(): Promise<void> {
		const chosen = RESET_ITEMS.filter((i) => selected[i.key]).map((i) => t(i.labelKey, { assistant: ASSISTANT_NAME }));
		if (chosen.length === 0) {
			return;
		}
		const ok = await confirm({
			title: t('settings.reset.confirmTitle'),
			body: (
				<>
					<div>{t('settings.reset.confirmBody')}</div>
					<ul className="confirm-list">{chosen.map((c) => <li key={c}>{c}</li>)}</ul>
				</>
			),
			confirmLabel: t('settings.reset.confirmLabel'),
			danger: true,
		});
		if (!ok) {
			return;
		}
		setBusy(true);
		try {
			await props.onReset(selected);
			setSelected(NO_RESET);
			setStatus(t('settings.reset.done'));
		} catch {
			setStatus(t('settings.reset.failed'));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<SettingsIntro art={ResetArt}>
				<p>{t('settings.reset.intro')}</p>
			</SettingsIntro>
			<fieldset>
				<legend>{t('settings.reset.clearLegend')}</legend>
				{RESET_ITEMS.map((item) => (
					<label className="reset-item" key={item.key}>
						<input type="checkbox" className="reset-check" checked={selected[item.key]} onChange={(e) => toggle(item.key, e.target.checked)} />
						<span className="reset-item-text">
							<span className="reset-item-label">{t(item.labelKey, { assistant: ASSISTANT_NAME })}</span>
							<span className="muted small reset-item-detail">{t(item.detailKey, { intro })}</span>
						</span>
					</label>
				))}
			</fieldset>
			<div className="modal-actions">
				<span className="spacer" />
				<button type="button" className="danger" disabled={busy || !anySelected} onClick={() => void run()}><Icon name="trash" /> {busy ? t('settings.reset.resetting') : t('settings.reset.resetSelected')}</button>
			</div>
			{status && <div className="form-status ok">{status}</div>}
			{confirmDialog}
		</>
	);
}

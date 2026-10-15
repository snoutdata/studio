/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState, type InputHTMLAttributes } from 'react';
import { HIDE_SETTING_HINT, LIBY_AVAILABLE } from '@snout/liby/studio';
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
import { DATA_ACCESS_INFO, DATA_ACCESS_LEVELS, effectiveDataAccess, type DataAccessLevel } from '../../../shared/engine';
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
import { secretsPlace, useSecretsWeak } from '../secretsPlace';

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
const TAB_GROUPS: Array<Array<{ id: SettingsTab; label: string; icon: string }>> = [
	[
		{ id: 'account', label: 'Account', icon: 'account' },
		{ id: 'appearance', label: 'Appearance', icon: 'symbol-color' },
		{ id: 'editor', label: 'Editor & Query', icon: 'edit' },
	],
	[
		{ id: 'ai', label: 'AI Settings', icon: 'sparkle' },
		{ id: 'datagen', label: 'Data Generation', icon: 'beaker' },
		{ id: 'extractmodel', label: 'Extraction Model', icon: 'circuit-board' },
		{ id: 'audit', label: 'AI Audit', icon: 'history' },
		{ id: 'agent', label: 'Agent access', icon: 'remote' },
		{ id: 'knowledge', label: 'Knowledge', icon: 'lightbulb' },
		{ id: 'snoutbot', label: 'Snoutbot (PR review)', icon: 'git-pull-request' },
	],
	[
		{ id: 'connections', label: 'Connections', icon: 'database' },
		{ id: 'cloud', label: 'Cloud accounts', icon: 'cloud' },
		{ id: 'network', label: 'Network', icon: 'globe' },
	],
	[
		{ id: 'privacy', label: 'Privacy', icon: 'shield' },
	],
	[
		{ id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard' },
		{ id: 'reset', label: 'Reset', icon: 'discard' },
	],
];

const TABS = TAB_GROUPS.flat();

/** One searchable setting inside a tab. `label` must be a substring of the control's rendered
 *  text (that's how the reveal below finds it in the DOM); `keywords` adds the words people
 *  actually type but that don't appear in the label ("gpu", "telemetry", "fk"). */
interface SettingEntry {
	tab: SettingsTab;
	label: string;
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
	{ tab: 'appearance', label: 'Theme', keywords: 'dark light color scheme' },
	{ tab: 'appearance', label: 'Activity bar position', keywords: 'sidebar top side' },
	{ tab: 'appearance', label: 'Reset panel layout', keywords: 'panels move dock left right bottom position sidebar assistant console default' },
	{ tab: 'appearance', label: 'Editor font size', keywords: 'text size zoom' },
	{ tab: 'appearance', label: 'Terminal font size', keywords: 'agent console terminal text size zoom claude code codex opencode' },
	{ tab: 'appearance', label: 'Word wrap' },
	{ tab: 'appearance', label: 'Show minimap' },
	{ tab: 'appearance', label: 'Disable onboarding tips', keywords: 'tour checklist getting started welcome' },
	{ tab: 'appearance', label: 'Show release notes after an update', keywords: "what's new changelog" },
	{ tab: 'appearance', label: 'Use hardware acceleration when available', keywords: 'gpu graphics rendering crash blank flicker' },

	{ tab: 'editor', label: 'Auto-show completions as you type', keywords: 'autocomplete intellisense suggest' },
	{ tab: 'editor', label: 'SQL keyword case', keywords: 'uppercase lowercase select' },
	{ tab: 'editor', label: 'Auto-append LIMIT to a bare SELECT' },
	{ tab: 'editor', label: 'Default LIMIT', keywords: 'rows' },
	{ tab: 'editor', label: `Auto-translate unsupported SQL to a MongoDB pipeline with ${ASSISTANT_NAME}`, keywords: 'mongo document transcribe' },
	{ tab: 'editor', label: 'Confirm destructive statements on prod connections', keywords: 'guard safety drop delete production' },
	{ tab: 'editor', label: 'Allow results-grid actions', keywords: 'edit value copy row prod production grid' },
	{ tab: 'editor', label: 'Resolve foreign-key ids to inline labels in the grid', keywords: 'fk lookup peek' },
	{ tab: 'editor', label: 'Connect automatically when picking a connection from a dropdown' },
	{ tab: 'editor', label: 'Warn before a query the planner expects to scan a huge number of rows', keywords: 'preflight explain scan large dataset' },
	{ tab: 'editor', label: 'Warn above (rows)', keywords: 'preflight threshold' },
	{ tab: 'editor', label: 'Warn a running query is slow after (ms)', keywords: 'slow long running timeout' },
	{ tab: 'editor', label: 'Advise on index/scans after a query takes (ms)', keywords: 'index advice slow' },
	{ tab: 'editor', label: 'Default connection on launch', keywords: 'startup' },
	{ tab: 'editor', label: 'Auto-disconnect idle connections after', keywords: 'idle timeout' },
	{ tab: 'editor', label: 'Reopen connections that were open last launch', keywords: 'reconnect restore startup' },

	{ tab: 'ai', label: 'Provider', keywords: 'model source cloud byok openai anthropic openrouter' },
	{ tab: 'ai', label: 'API key', keywords: 'token byok credentials' },
	{ tab: 'ai', label: 'Add a model', keywords: 'byok catalogue' },
	{ tab: 'ai', label: 'Base URL (optional)', keywords: 'byok endpoint gateway' },
	{ tab: 'ai', label: 'Extra instructions', keywords: 'tone conventions system prompt' },
	{ tab: 'ai', label: 'Top tables to fully describe', keywords: 'schema linking prompt context' },
	{ tab: 'ai', label: 'Max schema characters', keywords: 'prompt budget context' },
	{ tab: 'ai', label: 'Auto-insert proposed SQL into the editor' },
	{ tab: 'ai', label: 'Assistant tools', keywords: 'tools agent agentic inspect database' },
	{ tab: 'ai', label: 'List tables', keywords: 'tool agentic' },
	{ tab: 'ai', label: 'Describe a table', keywords: 'tool agentic columns keys indexes' },
	{ tab: 'ai', label: 'Search columns by name', keywords: 'tool agentic' },
	{ tab: 'ai', label: 'Run read-only queries', keywords: 'tool agentic approve' },
	{ tab: 'ai', label: 'Max tool steps per reply', keywords: 'agentic' },
	{ tab: 'ai', label: 'Max rows per query', keywords: 'agentic tool' },
	{ tab: 'ai', label: 'Enable AI completion', keywords: 'ghost text inline fim tab autocomplete' },
	{ tab: 'ai', label: 'Trigger', keywords: 'inline completion manual automatic' },
	{ tab: 'ai', label: 'Completion model', keywords: 'fim snout complete inline' },

	...PRO_SETTING_ENTRIES,

	{ tab: 'audit', label: `Record chats with ${ASSISTANT_NAME} and the actions they take`, keywords: 'audit log history actions tools capabilities' },
	{ tab: 'audit', label: 'Record auto-completion and inline edits', keywords: 'audit log fim' },

	{ tab: 'agent', label: 'Allow agent access', keywords: 'mcp claude code local server' },
	{ tab: 'agent', label: 'Let a program here use my account', keywords: 'cli snoutdata sign in token handoff terminal command line' },
	{ tab: 'agent', label: 'Connections the agent may use', keywords: 'mcp expose allowlist' },
	{ tab: 'agent', label: 'Allow writes', keywords: 'mcp insert update delete ddl' },
	{ tab: 'agent', label: 'Let an agent change the app', keywords: 'capabilities app actions mutating approve open tab setting' },
	{ tab: 'agent', label: 'Coding agents', keywords: 'claude code codex opencode console terminal agent' },

	{ tab: 'knowledge', label: 'Applies to', keywords: 'connection scope notes' },
	{ tab: 'knowledge', label: 'Scope', keywords: 'database table column note' },

	{ tab: 'connections', label: 'Add connection', keywords: 'new database server' },
	{ tab: 'cloud', label: 'Add a cloud account', keywords: 'aws amazon azure google gcp s3 bucket cloudwatch logs object storage r2 minio backblaze wasabi data flow source credential' },
	{ tab: 'cloud', label: 'Access key ID', keywords: 'aws s3 cloudwatch credentials bucket secret key' },
	{ tab: 'cloud', label: 'Import a profile', keywords: 'aws cli profile sso named credential adopt' },
	{ tab: 'cloud', label: 'Endpoint', keywords: 's3 compatible r2 minio backblaze wasabi ceph bucket' },
	{ tab: 'cloud', label: 'Region', keywords: 'aws s3 bucket cloudwatch log group' },

	{ tab: 'network', label: 'Proxy', keywords: 'corporate zscaler network system' },
	{ tab: 'network', label: 'PAC URL', keywords: 'proxy auto-config script wpad' },
	{ tab: 'network', label: 'Proxy server', keywords: 'manual host port' },
	{ tab: 'network', label: 'Bypass for these hosts', keywords: 'proxy no_proxy localhost' },
	{ tab: 'network', label: 'Proxy sign-in', keywords: 'username password credentials kerberos' },

	{ tab: 'privacy', label: 'Send crash and error reports', keywords: 'telemetry sentry analytics usage activity install id heartbeat account opt out' },
	{ tab: 'privacy', label: 'Sync my settings to my account', keywords: 'settings sync cloud account' },

	{ tab: 'reset', label: 'Window & pane sizing', keywords: 'reset layout' },
	{ tab: 'reset', label: 'Editor & appearance preferences', keywords: 'reset defaults' },
	{ tab: 'reset', label: 'Connections & saved credentials', keywords: 'reset delete' },
	{ tab: 'reset', label: 'Query history & saved queries', keywords: 'reset clear' },
	{ tab: 'reset', label: `${ASSISTANT_NAME} conversations`, keywords: 'reset clear ai chat history' },
	{ tab: 'reset', label: 'AI audit log', keywords: 'reset clear' },

	...KEYBINDINGS.map((k): SettingEntry => ({ tab: 'shortcuts', label: k.label, keywords: 'keybinding shortcut key' })),
];

function settingMatches(entry: SettingEntry, query: string): boolean {
	return entry.label.toLowerCase().includes(query) || (entry.keywords?.includes(query) ?? false);
}

/** The elements a setting's label can live on, for the scroll-to-and-flash reveal. */
const REVEAL_SELECTOR = 'label, legend, h4, .shortcut-row, .settings-conn-row';

// Only the gateway is user-selectable for now. Local Ollama is intentionally omitted
// (kept in the model, not offered in the picker).
const PROVIDER_LABELS: Partial<Record<AiProviderId, string>> = {
	'positron-cloud': 'SnoutData Cloud',
	'byok-openai': `${BYOK_PROVIDER_DEFAULTS['byok-openai'].label} (your key)`,
	'byok-openrouter': `${BYOK_PROVIDER_DEFAULTS['byok-openrouter'].label} (your key)`,
	'byok-anthropic': `${BYOK_PROVIDER_DEFAULTS['byok-anthropic'].label} (your key)`,
};

/** The BYOK providers, in display order. */
const BYOK_IDS: ByokProviderId[] = ['byok-openai', 'byok-openrouter', 'byok-anthropic'];

/** The Connections page's line on a machine with no password vault. */
const WEAK_SECRETS_LINE = "This computer has no password vault (keyring), so passwords are saved in a file only your user account can read. Install one, such as GNOME Keyring, and restart Studio to keep them in a vault.";

export function SettingsModal(props: SettingsModalProps): JSX.Element {
	const [tab, setTab] = useState<SettingsTab>(props.initialTab ?? 'appearance');
	const [navFilter, setNavFilter] = useState('');
	// The setting to scroll to and flash once its tab has rendered. The nonce lets the same
	// setting be revealed again on a second click.
	const [reveal, setReveal] = useState<{ label: string; nonce: number } | null>(null);
	const { appSettings, onAppSettingsChange, onClose } = props;
	// A Linux desktop with no password vault saves passwords in a file instead (main/secretStorageMode.ts);
	// the Connections page says so, since its own sentence would otherwise promise a keychain.
	const secretsWeak = useSecretsWeak();

	const navQuery = navFilter.trim().toLowerCase();
	const hits = new Map<SettingsTab, SettingEntry[]>();
	if (navQuery) {
		for (const entry of SETTING_INDEX) {
			if (tabShown(entry.tab) && settingMatches(entry, navQuery)) {
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
		.map((group) => group.filter((t) => tabShown(t.id) && (!navQuery || t.label.toLowerCase().includes(navQuery) || hits.has(t.id))))
		.filter((group) => group.length > 0);

	function openSetting(target: SettingsTab, label: string): void {
		setTab(target);
		setReveal((prev) => ({ label, nonce: (prev?.nonce ?? 0) + 1 }));
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
				<h2><PageMark art="settings" text="Settings" /></h2>
				<span className="spacer" />
				<button className="icon-btn" aria-label="Close (Esc)" onClick={onClose}><Icon name="close" /></button>
			</div>
			<div className="settings-main">
				<nav className="settings-nav">
					<div className="settings-nav-search">
						<Icon name="search" />
						<input
							type="text"
							placeholder="Search settings"
							value={navFilter}
							onChange={(e) => setNavFilter(e.target.value)}
						/>
						{navFilter && <button className="icon-btn" aria-label="Clear" onClick={() => setNavFilter('')}><Icon name="close" /></button>}
					</div>
					{groups.length === 0 && <div className="muted small settings-nav-empty">No matches</div>}
					{groups.map((group, gi) => (
						<div className="settings-nav-group" key={gi}>
							{group.map((t) => {
								const matched = hits.get(t.id) ?? [];
								return (
									<div key={t.id}>
										<button
											className={`settings-nav-item${tab === t.id ? ' active' : ''}`}
											onClick={() => matched.length > 0 ? openSetting(t.id, matched[0].label) : setTab(t.id)}
										>
											<Icon name={t.icon} className="settings-nav-icon" />
											<span>{t.label}</span>
											{matched.length > 0 && <span className="settings-nav-count">{matched.length}</span>}
										</button>
										{matched.map((s) => (
											<button key={s.label} className="settings-nav-subitem" title={s.label} onClick={() => openSetting(t.id, s.label)}>
												{s.label}
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
							? <PageMark art={tab} text={TABS.find((t) => t.id === tab)?.label ?? ''} />
							: TABS.find((t) => t.id === tab)?.label}
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
								<legend>Appearance</legend>
								<label>Theme
									<select value={props.theme} onChange={(e) => props.onSelectTheme(e.target.value)}>
										{THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
									</select>
								</label>
								<label>Activity bar position
									<select value={appSettings.activityBarPosition} onChange={(e) => patch({ activityBarPosition: e.target.value as ActivityBarPosition })}>
										<option value="side">Side (left)</option>
										<option value="top">Top</option>
									</select>
								</label>
							</fieldset>
							<fieldset>
								<legend>Panels</legend>
								<div className="muted">
									Drag a panel by its header, or right-click its header or its icon, to move it to the
									left, the right or the bottom. Where you put things is remembered on this computer.
								</div>
								<div className="settings-row-action">
									<button type="button" disabled={!props.panelsMoved} onClick={props.onResetPanels}>
										<Icon name="discard" /> Reset panel layout
									</button>
									{!props.panelsMoved && <span className="muted">Everything is already where it starts.</span>}
								</div>
							</fieldset>
							<fieldset>
								<legend>Editor</legend>
								<label>Editor font size
									<NumberField min={9} max={28} fallback={13} value={appSettings.fontSize} onCommit={(n) => patch({ fontSize: n })} />
								</label>
								<label className="check"><input type="checkbox" checked={appSettings.wordWrap} onChange={(e) => patch({ wordWrap: e.target.checked })} /> Word wrap</label>
								<label className="check"><input type="checkbox" checked={appSettings.minimap} onChange={(e) => patch({ minimap: e.target.checked })} /> Show minimap</label>
							</fieldset>
							<fieldset>
								<legend>Terminal</legend>
								<label>Terminal font size
									<NumberField min={TERMINAL_FONT_MIN} max={TERMINAL_FONT_MAX} fallback={13} value={appSettings.terminalFontSize} onCommit={(n) => patch({ terminalFontSize: n })} />
								</label>
								<div className="muted">
									The type size in a coding agent's console. You can also change it from the console's
									own header, with Ctrl+plus / Ctrl+minus / Ctrl+0, or by holding Ctrl and scrolling
									over the terminal.
								</div>
							</fieldset>
							<fieldset>
								<legend>Startup</legend>
								<label className="check"><input type="checkbox" checked={appSettings.disableOnboarding} onChange={(e) => patch({ disableOnboarding: e.target.checked })} /> Disable onboarding tips (the tour and getting-started checklist)</label>
								<div className="muted">You can still launch the tour or checklist anytime from the Help menu or the command palette.</div>
								{LIBY_AVAILABLE && (
									<label className="check"><input type="checkbox" checked={appSettings.disableMascot} onChange={(e) => patch({ disableMascot: e.target.checked })} /> Hide {ASSISTANT_NAME} ({HIDE_SETTING_HINT})</label>
								)}
								<label className="check"><input type="checkbox" checked={appSettings.showReleaseNotesAfterUpdate} onChange={(e) => patch({ showReleaseNotesAfterUpdate: e.target.checked })} /> Show release notes after an update</label>
							</fieldset>
							<fieldset>
								<legend>Graphics</legend>
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
									<legend>Editing</legend>
									<label className="check"><input type="checkbox" checked={appSettings.autoCompletion} onChange={(e) => patch({ autoCompletion: e.target.checked })} /> Auto-show completions as you type (otherwise only on {formatShortcut('Ctrl+Space')})</label>
									<label>SQL keyword case
										<select value={appSettings.keywordCase} onChange={(e) => patch({ keywordCase: e.target.value as KeywordCase })}>
											<option value="preserve">Match what I type</option>
											<option value="upper">UPPERCASE</option>
											<option value="lower">lowercase</option>
										</select>
									</label>
								</fieldset>

								<fieldset>
									<legend>Running queries</legend>
									<label className="check"><input type="checkbox" checked={appSettings.autoLimit} onChange={(e) => patch({ autoLimit: e.target.checked })} /> Auto-append LIMIT to a bare SELECT</label>
									<label>Default LIMIT
										<NumberField min={1} max={100000} fallback={100} value={appSettings.defaultLimit} onCommit={(n) => patch({ defaultLimit: n })} />
									</label>
									<label className="check"><input type="checkbox" checked={appSettings.aiAutoTranscribe} onChange={(e) => patch({ aiAutoTranscribe: e.target.checked })} /> Auto-translate unsupported SQL to a MongoDB pipeline with {ASSISTANT_NAME}</label>
									<div className="muted">On document connections (MongoDB), when a query is too complex for the built-in translator, use AI without asking each time. Every AI call uses your budget. Off by default, so the first such query asks first. Or write native pipelines in the Pipeline tab.</div>
								</fieldset>

								<fieldset>
									<legend>Results, and prod</legend>
									<label className="check"><input type="checkbox" checked={appSettings.confirmOnProd} onChange={(e) => patch({ confirmOnProd: e.target.checked })} /> Confirm destructive statements on prod connections</label>
									<label className="check"><input type="checkbox" checked={appSettings.allowProdGridActions} onChange={(e) => patch({ allowProdGridActions: e.target.checked })} /> Allow results-grid actions (edit value, copy, copy row) on prod connections</label>
									<label className="check"><input type="checkbox" checked={appSettings.resolveFkLabels} onChange={(e) => patch({ resolveFkLabels: e.target.checked })} /> Resolve foreign-key ids to inline labels in the grid</label>
									<div className="muted">Fires a small lookup per FK column over the visible rows. The hover/right-click peek card stays available either way.</div>
								</fieldset>
							</div>

							<div className="settings-col">
								<fieldset>
									<legend>Large datasets</legend>
									<label className="check"><input type="checkbox" checked={appSettings.preflightScan} onChange={(e) => patch({ preflightScan: e.target.checked })} /> Warn before a query the planner expects to scan a huge number of rows</label>
									<div className="muted">Runs one cheap EXPLAIN before a SELECT (on prod/tunnelled connections too, where a runaway scan hurts most). The same plan powers the index/scan advice, so there's no second round-trip.</div>
									<label>Warn above (rows)
										<NumberField min={1000} max={1000000000} fallback={1000000} value={appSettings.preflightWarnRows} onCommit={(n) => patch({ preflightWarnRows: n })} />
									</label>
									<label>Warn a running query is slow after (ms)
										<NumberField min={0} max={600000} fallback={5000} value={appSettings.slowQueryWarnMs} onCommit={(n) => patch({ slowQueryWarnMs: n })} />
									</label>
									<label>Advise on index/scans after a query takes (ms)
										<NumberField min={0} max={600000} fallback={2000} value={appSettings.slowQueryAdviseMs} onCommit={(n) => patch({ slowQueryAdviseMs: n })} />
									</label>
									<div className="muted">Set the two thresholds to 0 to turn off the long-running warning or the post-run index advice.</div>
								</fieldset>

								<fieldset>
									<legend>Connections</legend>
									<label className="check"><input type="checkbox" checked={appSettings.autoConnectOnSelect} onChange={(e) => patch({ autoConnectOnSelect: e.target.checked })} /> Connect automatically when picking a connection from a dropdown</label>
									<div className="muted">When off, the dropdowns only select; connect from the sidebar.</div>
									<label>Default connection on launch
										<select value={appSettings.defaultConnectionId ?? ''} onChange={(e) => patch({ defaultConnectionId: e.target.value || null })}>
											<option value="">None</option>
											{props.connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
										</select>
									</label>
									<label>Auto-disconnect idle connections after (minutes, 0 = never)
										<NumberField min={0} max={1440} fallback={240} value={appSettings.idleDisconnectMinutes} onCommit={(n) => patch({ idleDisconnectMinutes: n })} />
									</label>
									<label className="check"><input type="checkbox" checked={appSettings.reconnectOnLaunch} onChange={(e) => patch({ reconnectOnLaunch: e.target.checked })} /> Reopen connections that were open last launch</label>
									<div className="muted">Only non-prod connections reopen; prod always needs a manual connect.</div>
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
									<p>Every database this app can reach, the same list as the sidebar's. Connect, edit or remove one here; the passwords stay {secretsWeak ? "on this computer" : "in this computer's keychain"}.</p>
									{secretsWeak && <p className="muted">{WEAK_SECRETS_LINE}</p>}
								</SettingsIntro>
							)}
							{props.connections.length === 0 && (
								<div className="settings-empty">
									<ConnectArt className="settings-empty-art" />
									<p>No connections yet. Add one to browse its tables and query it.</p>
									{secretsWeak && <p className="field-hint">{WEAK_SECRETS_LINE}</p>}
									<button type="button" onClick={props.onAddConnection}><Icon name="add" /> Add connection…</button>
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
											? <button className="icon-btn" aria-label="Disconnect" onClick={() => props.onDisconnect(c.id)}><Icon name="debug-disconnect" /></button>
											: <button className="icon-btn" aria-label="Connect" onClick={() => props.onConnect(c.id)}><Icon name="plug" /></button>}
										<button className="icon-btn" aria-label="Edit" onClick={() => props.onEditConnection(c)}><Icon name="edit" /></button>
										<button className="icon-btn" aria-label="Delete" onClick={() => props.onDeleteConnection(c)}><Icon name="trash" /></button>
									</div>
								);
							})}
							{props.connections.length > 0 && (
								<div className="modal-actions">
									<button type="button" className="secondary" onClick={props.onAddConnection}><Icon name="add" /> Add connection…</button>
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
	const keyPlace = secretsPlace(useSecretsWeak());
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
	const [gatewayKey, setGatewayKey] = useState('');
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
					{!value && <option value="">{refreshing ? 'Loading…' : ollamaModels.length ? 'Select a model…' : 'No models found. Check the endpoint, then Refresh'}</option>}
					{options.map((m) => <option key={m} value={m}>{m}</option>)}
				</select>
				<button type="button" className="secondary" disabled={refreshing} title="Refresh model list from Ollama" onClick={() => void refreshOllama(ollamaEndpoint)}><Icon name="refresh" /> {refreshing ? '…' : 'Refresh'}</button>
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
				{models.length === 0 && <option value="">No completion models available</option>}
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
				'positron-cloud': gatewayKey || undefined,
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
		setStatus({ ok: true, message: 'Saved.' });
		setBusy(false);
	}

	async function test(): Promise<void> {
		setBusy(true);
		setStatus({ ok: true, message: 'Testing…' });
		await window.sqlApi.saveAiSettings(collect());
		setStatus(await window.sqlApi.aiTest());
		setBusy(false);
	}

	if (!loaded) {
		return null;
	}

	/** Model-id + API-key fields for a gateway-style provider. The model is a select fed by
	 *  the provider's live model list (like the chat picker); a stale saved value is kept as an
	 *  option so it stays visible. The key placeholder reflects whether one is already stored. */
	function cloudFields(p: AiProviderId, model: string, setModel: (v: string) => void, key: string, setKey: (v: string) => void): JSX.Element {
		const status = statuses.find((s) => s.provider === p);
		const stored = status?.configured ?? false;
		const models = (status?.models ?? []).map((m) => m.model);
		const options = model && !models.includes(model) ? [model, ...models] : models;
		return (
			<>
				<label>Model
					<span style={{ display: 'flex', gap: 6 }}>
						<select style={{ flex: 1, minWidth: 0 }} value={model} onChange={(e) => setModel(e.target.value)}>
							{!model && <option value="">{models.length ? 'Select a model…' : 'No models available. Add an API key, then Refresh'}</option>}
							{options.map((m) => <option key={m} value={m}>{m}</option>)}
						</select>
						<button type="button" className="secondary" title="Refresh model list from the gateway" onClick={() => void loadStatuses()}><Icon name="refresh" /> Refresh</button>
					</span>
				</label>
				<label>API key<input type="password" value={key} placeholder={stored ? 'leave blank to keep current' : 'paste your API key'} onChange={(e) => setKey(e.target.value)} /></label>
				<div className="muted">The key is kept {keyPlace}, never written to the config files. Use “Test” to verify it.</div>
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
		setStatus({ ok: true, message: `Loading ${def.label} models…` });
		try {
			await window.sqlApi.saveAiSettings(collect());
			const list = await window.sqlApi.aiByokModels(p);
			setByokOptions({ ...byokOptions, [p]: list });
			setStatus(list.length
				? { ok: true, message: `Found ${list.length} ${def.label} model${list.length === 1 ? '' : 's'}. Add the ones you want.` }
				: { ok: false, message: `No models found. Check your ${def.label} key.` });
		} catch (err) {
			setByokOptions({ ...byokOptions, [p]: [] });
			setStatus({ ok: false, message: err instanceof Error ? err.message : `Could not load ${def.label} models.` });
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
				<label>API key
					<span style={{ display: 'flex', gap: 6 }}>
						<input style={{ flex: 1, minWidth: 0 }} type="password" value={byokKey[p]} placeholder={stored ? 'leave blank to keep current' : `paste your ${def.label} API key`} onChange={(e) => setByokKey({ ...byokKey, [p]: e.target.value })} />
						<button type="button" className="secondary" title={`Save the key and load ${def.label}'s models`} disabled={busy} onClick={() => void loadByokModels(p)}><Icon name="cloud-download" /> Load models</button>
					</span>
				</label>
				<label>Add a model
					<span style={{ display: 'flex', gap: 6 }}>
						{options.length > 0 && (
							<select value="" style={{ flex: 1, minWidth: 0 }} onChange={(e) => { if (e.target.value) { setByokPick({ ...byokPick, [p]: e.target.value }); } }}>
								<option value="">{`Pick from ${options.length} ${def.label} model${options.length === 1 ? '' : 's'}…`}</option>
								{options.map((m) => <option key={m} value={m}>{m}</option>)}
							</select>
						)}
						<input style={{ flex: 1, minWidth: 0 }} value={byokPick[p]} placeholder={options.length ? 'or type a model id' : 'type a model id'} onChange={(e) => setByokPick({ ...byokPick, [p]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addByokModel(p); } }} />
						<button type="button" className="secondary" disabled={!byokPick[p].trim()} onClick={() => addByokModel(p)}><Icon name="add" /> Add</button>
					</span>
				</label>
				{curated.length > 0 ? (
					<div className="byok-added">
						{curated.map((m) => (
							<div className="byok-added-row" key={m}>
								<Icon name="check" />
								<span className="tree-label">{m}</span>
								<span className="spacer" />
								<button type="button" className="icon-btn" aria-label="Remove from the picker" onClick={() => removeByokModel(p, m)}><Icon name="close" /></button>
							</div>
						))}
						<div className="muted small">These show in the assistant's model menu after you Save.</div>
					</div>
				) : (
					<div className="muted small">No models added yet. Paste your key, click "Load models", then add the ones you want.</div>
				)}
				<label>Base URL (optional)<input value={byokBaseUrl[p]} placeholder={def.baseUrl} onChange={(e) => setByokBaseUrl({ ...byokBaseUrl, [p]: e.target.value })} /></label>
				<div className="muted">The assistant's chat and edits go straight to {def.label}, bypassing SnoutData's servers, so your key and those prompts never touch our gateway. AI completion needs a fill-in-the-middle model, which your provider may not offer, so if you switch it on it uses SnoutData's completion model through our gateway. The key is kept {keyPlace}. Use “Test” to verify it.</div>
			</>
		);
	}

	return (
		<>
			<div className="tabs">
				<button type="button" className={aiTab === 'chat' ? 'tab active' : 'tab'} onClick={() => setAiTab('chat')}>Chat</button>
				<button type="button" className={aiTab === 'completion' ? 'tab active' : 'tab'} onClick={() => setAiTab('completion')}>Auto-completion</button>
			</div>

			{aiTab === 'chat' && (
				<div className="tabs subtabs">
					<button type="button" className={chatTab === 'models' ? 'tab active' : 'tab'} onClick={() => setChatTab('models')}>Models</button>
					<button type="button" className={chatTab === 'settings' ? 'tab active' : 'tab'} onClick={() => setChatTab('settings')}>Settings</button>
				</div>
			)}

			{aiTab === 'chat' && chatTab === 'models' && (
				<>
					<fieldset>
						<legend>Models in the picker</legend>
						<div className="muted">These models can be chosen in the assistant's model menu. Toggle which ones show. Add a provider under "Active provider" below to get more.</div>
						{/* Only list providers that actually have models: an unconfigured BYOK provider has
						    none, so it would otherwise show as a confusing empty "No models" row here. */}
						{statuses.filter((s) => s.models.length > 0).map((s) => (
							<div className="ai-provider" key={s.provider}>
								<div className="ai-provider-head">
									<span className={`dot${s.reachable ? ' on' : ''}`}><Icon name="circle-filled" /></span>
									<span className="tree-label">{PROVIDER_LABELS[s.provider]}</span>
									{s.detail && <span className="muted small">{s.detail}</span>}
									<span className="spacer" />
									{s.provider === 'ollama' && <button type="button" className="icon-btn" aria-label="Refresh models" onClick={() => void loadStatuses()}><Icon name="refresh" /></button>}
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
											{m.recommended && <span className="model-picker-tag">Recommended</span>}
											{m.reasoning && <span className="reason-badge" title="Reasoning (thinking) model">✦ reasoning</span>}
										</span>
										<span className="switch"><input type="checkbox" checked={m.enabled} onChange={(e) => void toggleModel(`${m.provider}:${m.model}`, e.target.checked)} /><span className="slider" /></span>
									</label>
								))}
							</div>
						))}
						{statuses.every((s) => s.models.length === 0) && <div className="muted small ai-model-row">No models yet. Choose a provider below to get started.</div>}
					</fieldset>
					<fieldset>
						<legend>Active provider</legend>
						<div className="muted">Where the assistant's models come from. Use the managed SnoutData Cloud models{byokAllowed ? ", or bring your own key (OpenAI, OpenRouter, Anthropic) and the assistant's chat and edits go straight to that provider, never through our servers. AI completion needs a fill-in-the-middle model, so if you switch it on it uses SnoutData's completion model through our gateway." : "."}</div>
						<label>Provider
							<select value={provider} onChange={(e) => setProvider(e.target.value as AiProviderId)}>
								{/* BYOK providers are Plus, Pro and Business; only offer them when the tier allows it. */}
								{(Object.keys(PROVIDER_LABELS) as AiProviderId[]).filter((p) => byokAllowed || !BYOK_IDS.includes(p as ByokProviderId)).map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
							</select>
						</label>
						{/* Local Ollama is not offered here. Add 'ollama' back to PROVIDER_LABELS to surface it. */}
						{provider === 'ollama' && (
							<>
								<label>Endpoint<input value={ollamaEndpoint} onChange={(e) => setOllamaEndpoint(e.target.value)} placeholder="http://localhost:11434" /></label>
								<label>Model{ollamaModelField(ollamaModel, setOllamaModel)}</label>
							</>
						)}
						{provider === 'positron-cloud' && cloudFields('positron-cloud', gatewayModel, setGatewayModel, gatewayKey, setGatewayKey)}
						{byokAllowed && BYOK_IDS.includes(provider as ByokProviderId) && byokFields(provider as ByokProviderId)}
					</fieldset>
					{/* Discovery for Free users: BYOK exists but is a paid feature; show it disabled. */}
					{!byokAllowed && (
						<fieldset className="byok-plan-hint" disabled>
							<legend>Bring your own key</legend>
							<div className="muted">Point the assistant at your own OpenAI, OpenRouter, or Anthropic key. Your key stays on your machine: the assistant's chat and edits go straight to the provider, never through SnoutData's servers (AI completion needs a fill-in-the-middle model, so if you switch it on it uses SnoutData's). Part of Plus, Pro and Business.</div>
						</fieldset>
					)}
				</>
			)}

			{aiTab === 'chat' && chatTab === 'settings' && (
				<>
					<fieldset>
						<legend>Grounding & behavior</legend>
						{/* First in the card, not loose above it: what the AI may see IS its grounding,
						    and a lone field between the tabs and the first card had no group to sit in. */}
						<label>What the AI may see of your data
							<select value={effectiveDataAccess(dataAccess)} onChange={(e) => setDataAccess(e.target.value as DataAccessLevel)}>
								{DATA_ACCESS_LEVELS.map((level) => <option key={level} value={level}>{DATA_ACCESS_INFO[level].label}</option>)}
							</select>
						</label>
						<p className="field-hint">
							{DATA_ACCESS_INFO[effectiveDataAccess(dataAccess)].detail} Applies to the assistant and to coding agents connected to SnoutData. A connection can set its own level in its settings.
							{dataAccess === undefined && ' Not chosen yet, so this is the default.'}
						</p>
						<label>Extra instructions (tone, conventions)
							<textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. prefer CTEs; explain briefly" rows={6} />
						</label>
						<label>Top tables to fully describe
							<NumberField min={1} max={100} fallback={8} value={topTables} onCommit={setTopTables} />
						</label>
						<div className="muted">The top-N relevance-ranked tables for each question are described with full columns; the rest appear as name + column count. Smaller N keeps the prompt focused for local models.</div>
						<label>Max schema characters (upper bound)
							<NumberField min={1000} max={200000} fallback={24000} value={maxSchemaChars} onCommit={setMaxSchemaChars} />
						</label>
						<label className="check"><input type="checkbox" checked={autoInsertSql} onChange={(e) => setAutoInsertSql(e.target.checked)} /> Auto-insert proposed SQL into the editor</label>
						{/* A build from source has no inexpensive observer model, so suggesting facts to
						    remember is a second model call per turn: off until a model is named here. */}
						{!OFFICIAL_BUILD && (
							<>
								<label>Model for "Remember this?" suggestions
									<input type="text" value={observerModel} onChange={(e) => setObserverModel(e.target.value)} placeholder="Off" spellCheck={false} />
								</label>
								<p className="field-hint">After a reply that proposes SQL, a model can read the exchange and suggest one fact to remember about the database. That is a second model call, on the assistant's provider, for every such reply, so it is off until you name a model here. A small, inexpensive one is enough. Leave it empty to keep it off.</p>
							</>
						)}
					</fieldset>
					<fieldset>
						<legend>Tools</legend>
							<div className="muted">Choose what the assistant may do. Database tools need a connected database.</div>
							<label className="check"><input type="checkbox" checked={toolListTables} onChange={(e) => setToolListTables(e.target.checked)} /> List tables</label>
							<label className="check"><input type="checkbox" checked={toolDescribeTable} onChange={(e) => setToolDescribeTable(e.target.checked)} /> Describe a table (columns, keys, indexes)</label>
							<label className="check"><input type="checkbox" checked={toolSearchColumns} onChange={(e) => setToolSearchColumns(e.target.checked)} /> Search columns by name</label>
							<label className="check"><input type="checkbox" checked={toolRunQuery} onChange={(e) => setToolRunQuery(e.target.checked)} /> Run read-only queries <span className="muted">(you approve each query; writes are always refused)</span></label>
							{toolRunQuery && effectiveDataAccess(dataAccess) !== 'queries' && (
								<p className="field-hint">Switched off by "What the AI may see of your data" above, which does not include read-only queries.</p>
							)}
							{toolRunQuery && (
								<div className="auto-approve">
									<div className="muted small">Auto-approved connections. Queries run without asking (set via “Always allow” on the approval prompt):</div>
									{autoApprove.length === 0
										? <div className="muted small">None. You'll be asked before each query.</div>
										: autoApprove.map((id) => (
											<div className="auto-approve-row" key={id}>
												<Icon name="database" />
												<span className="tree-label">{connList.find((c) => c.id === id)?.label ?? id}</span>
												<span className="spacer" />
												<button type="button" className="secondary small" title="Ask again before running queries here" onClick={() => void revokeAutoApprove(id)}><Icon name="close" /> Revoke</button>
											</div>
										))}
								</div>
							)}
							<label>Max tool steps per reply
								<NumberField min={1} max={20} fallback={15} value={agentMaxSteps} onCommit={setAgentMaxSteps} />
							</label>
							<label>Max rows per query
								<NumberField min={1} max={5000} fallback={200} value={agentMaxRows} onCommit={setAgentMaxRows} />
							</label>
					</fieldset>
				</>
			)}

			{aiTab === 'completion' && (
				<>
					<label className="check"><input type="checkbox" checked={inlineCompletion} onChange={(e) => setInlineCompletion(e.target.checked)} /> Enable AI completion (ghost text in the editor)</label>
					{BYOK_IDS.includes(provider as ByokProviderId) && (
						<div className="muted" data-testid="completion-byok-note">Your own key covers the assistant's chat and edits only. AI completion needs a fill-in-the-middle model, which your provider may not offer, so it always uses SnoutData's completion model through our gateway. When it is on, the text around your cursor, the relevant schema and some of your earlier queries on that connection are sent to SnoutData's servers.</div>
					)}
					{inlineCompletion ? (
						<>
							<label>Trigger
								<select value={inlineCompletionMode} onChange={(e) => setInlineCompletionMode(e.target.value as InlineCompletionMode)}>
									<option value="manual">Manual ({formatShortcut('Alt+\\')})</option>
									<option value="auto">Automatic, as you type (best with a fast local model)</option>
								</select>
							</label>
							<label>Completion model
								{provider === 'ollama'
									? ollamaModelField(completionModel, setCompletionModel)
									: cloudCompletionField('positron-cloud', completionModel, setCompletionModel)}
							</label>
							<div className="muted">Completion uses its own dedicated model (these are separate from the chat list). It wants speed + SQL fill-in-the-middle, not raw intelligence, so a small FIM code model beats a big chat model here.</div>
						</>
					) : (
						<div className="muted">Off. The editor still has deterministic, local schema completion ({formatShortcut('Ctrl+Space')}). Turn this on to add model-generated ghost text.</div>
					)}
				</>
			)}

			<div className="modal-actions">
				<button type="button" className="secondary" onClick={() => void test()} disabled={busy}><Icon name="beaker" /> Test</button>
				<span className="spacer" />
				<button type="button" onClick={() => void save()} disabled={busy}><Icon name="save" /> Save</button>
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
const MCP_CLIENT_PRESETS: Array<{ id: string; label: string; note: string; build(status: McpStatus): string }> = [
	{ id: 'claude', label: 'Claude Code', note: 'Run once in a terminal. Registers it for every project, nothing to paste into a file:', build: claudeAddCommand },
	{ id: 'codex', label: 'Codex', note: isWindows()
		? 'Run in a terminal. setx stores the token for new terminals (reopen yours), then Codex registers the server:'
		: 'Run in a terminal (Codex reads the token from an env var; add the export to your shell profile to persist it):', build: codexAddCommand },
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
	{ id: 'databases', label: 'Databases' },
	{ id: 'agents', label: 'Coding agents' },
	{ id: 'actions', label: 'App actions' },
	{ id: 'connect', label: 'Outside agents' },
] as const;

type AgentTab = typeof AGENT_TABS[number]['id'];

/* Which tab holds a setting the Settings search jumped to. Without this the search still selects
   the Agent access page and then flashes a control that is on a panel the user cannot see, which
   is worse than not finding it. Keyed by the labels in SEARCH_INDEX, lowercased. */
const AGENT_TAB_FOR_SETTING: Record<string, AgentTab> = {
	'connections the agent may use': 'databases',
	'allow writes': 'databases',
	'coding agents': 'agents',
	'let an agent change the app': 'actions',
	'let a program here use my account': 'connect',
};

/** Agent access (MCP): let an external agent (e.g. Claude Code) query the user's databases
 *  THROUGH the app, so credentials never leave the keychain. Read-only, opt-in per connection,
 *  gated by a bearer token. Drives the mcp:* IPC; each call returns the full status so this
 *  re-renders from one source of truth. */
const PROXY_MODES: Array<{ id: ProxyMode; label: string; hint: string }> = [
	{ id: 'system', label: 'Use system proxy', hint: 'Resolve the OS proxy (PAC/WPAD/manual) the same way your browser does. Recommended.' },
	{ id: 'direct', label: 'No proxy (direct)', hint: 'Connect straight out, ignoring any system proxy.' },
	{ id: 'manual', label: 'Manual configuration', hint: 'Point the app at a specific PAC file or proxy server.' },
];

// Settings → Shortcuts: live keyboard-shortcut rebinding. The bindings are the resolved set from
// main (shared/keybindings.ts is the source of truth); clicking a row captures the next keystroke
// and persists it, which broadcasts back so the editor + global dispatchers update without a restart.
function ShortcutsSection(): JSX.Element {
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
				<p>Click a shortcut, then press the new key combination. Esc to cancel, Backspace to reset.</p>
			</SettingsIntro>
			{bindings.map((b) => {
				const conflictLabels = conflictingIds(bindings, b.id, b.combo, b.scope)
					.map((cid) => bindings.find((x) => x.id === cid)?.label ?? cid);
				const reserved = reservedHint(b.combo);
				const isDefault = defaults.get(b.id) === b.combo;
				const capturing = capturingId === b.id;
				return (
					<div className="shortcut-row" key={b.id}>
						<span>{b.label}</span>
						<span className="spacer" />
						{conflictLabels.length > 0 && (
							<span className="shortcut-conflict" title={`Same keys as: ${conflictLabels.join(', ')}`}><Icon name="warning" /> conflict</span>
						)}
						{conflictLabels.length === 0 && reserved && (
							<span className="shortcut-conflict" title={`These keys also trigger a built-in: ${reserved}. Your binding wins, but disables it.`}><Icon name="warning" /> overrides {reserved}</span>
						)}
						{!isDefault && !capturing && (
							<button className="icon-btn" aria-label="Reset to default" onClick={() => void window.sqlApi.keybindings.reset(b.id).then(setBindings)}><Icon name="discard" /></button>
						)}
						<button
							className={`shortcut-key${capturing ? ' capturing' : ''}`}
							onClick={() => setCapturingId(b.id)}
							onKeyDown={capturing ? (e) => capture(b.id, e) : undefined}
						>
							{capturing ? 'Press keys…' : <kbd>{formatShortcut(b.combo)}</kbd>}
						</button>
					</div>
				);
			})}
			<div style={{ marginTop: 12 }}>
				<button type="button" className="secondary" onClick={() => void window.sqlApi.keybindings.reset().then(setBindings)}><Icon name="discard" /> Reset all to defaults</button>
			</div>
		</div>
	);
}

function NetworkSection(): JSX.Element {
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
		return <div className="muted">Loading…</div>;
	}

	return (
		<>
			<SettingsIntro art={NetworkArt}>
				<p>
					How SnoutData Studio connects to the internet for sign-in, AI, and updates. The default follows your
					system proxy, like your browser. Change this only if you're on a company network that needs a
					specific proxy or proxy sign-in (for example Zscaler or a corporate firewall).
				</p>
			</SettingsIntro>

			<fieldset>
				<legend>Proxy</legend>
				{PROXY_MODES.map((m) => (
					<div key={m.id}>
						<label className="check">
							<input type="radio" name="proxy-mode" checked={config.mode === m.id} disabled={busy} onChange={() => patch({ mode: m.id })} />
							{m.label}
						</label>
						<div className="muted small" style={{ marginLeft: 22 }}>{m.hint}</div>
					</div>
				))}
			</fieldset>

			{config.mode === 'manual' && (
				<fieldset>
					<legend>Manual proxy</legend>
					<label>
						<span>PAC URL (auto-config script)</span>
						<input type="text" placeholder="http://wpad/wpad.dat" value={config.pacUrl} disabled={busy} onChange={(e) => patch({ pacUrl: e.target.value })} />
					</label>
					<div className="muted small">If you have a PAC URL, use it. Otherwise leave it blank and set a proxy server below.</div>
					<label>
						<span>Proxy server</span>
						<input type="text" placeholder="proxy.corp.com:8080" value={config.server} disabled={busy || config.pacUrl.trim() !== ''} onChange={(e) => patch({ server: e.target.value })} />
					</label>
					<label>
						<span>Bypass for these hosts</span>
						<input type="text" placeholder="localhost,127.0.0.1,*.internal" value={config.bypass} disabled={busy || config.pacUrl.trim() !== ''} onChange={(e) => patch({ bypass: e.target.value })} />
					</label>
				</fieldset>
			)}

			<fieldset>
				<legend>Proxy sign-in (optional)</legend>
				<div className="muted small">Only if your proxy asks for a username and password. Windows/Kerberos single sign-on is handled automatically and needs nothing here. Kept {secretsPlace(secretsWeak)}.</div>
				<label>
					<span>Username</span>
					<input type="text" autoComplete="off" value={config.username} disabled={busy} onChange={(e) => patch({ username: e.target.value })} />
				</label>
				<label>
					<span>Password</span>
					<input
						type="password"
						autoComplete="off"
						placeholder={config.hasPassword && !pwTouched ? '•••••••• (saved)' : ''}
						value={password}
						disabled={busy}
						onChange={(e) => { setPassword(e.target.value); setPwTouched(true); setSaved(false); }}
					/>
				</label>
				{config.hasPassword && <div className="muted small">A password is saved. Leave blank to keep it, or clear the field and save to remove it.</div>}
			</fieldset>

			<fieldset>
				<legend>Windows sign-in to servers (advanced)</legend>
				<div className="muted small">Your proxy can always use your Windows/Kerberos sign-in. Other servers can only if they are listed here, and nothing receives your Kerberos ticket unless it is listed under delegation. Leave both blank unless your IT team asks. Changes apply the next time SnoutData Studio starts.</div>
				<label>
					<span>Servers allowed to use your Windows sign-in</span>
					<input type="text" autoComplete="off" placeholder="*.corp.example, auth.gateway.example" value={config.authServers} disabled={busy} onChange={(e) => patch({ authServers: e.target.value })} />
				</label>
				<label>
					<span>Servers your Kerberos ticket may be delegated to</span>
					<input type="text" autoComplete="off" placeholder="None" value={config.delegateServers} disabled={busy} onChange={(e) => patch({ delegateServers: e.target.value })} />
				</label>
				<p className="field-hint">Comma separated host names. A leading <code>*.</code> covers a domain; a bare <code>*</code> is not accepted.</p>
			</fieldset>

			{/* Same shape as every other settings pane: the secondary action on the left, the commit on
			    the right edge of the panel. This row had them the other way round, so Save sat under
			    the card's left corner here and under its right corner one tab over. */}
			<div className="modal-actions">
				<button type="button" className="secondary" onClick={() => void runTest()} disabled={busy || testing}><Icon name="pulse" /> {testing ? 'Testing…' : 'Test connection'}</button>
				{resolved && <span className="muted small" title="What Chromium resolves for a sample request">Resolved: {resolved}</span>}
				<span className="spacer" />
				{saved && <span className="form-status ok">Saved.</span>}
				<button type="button" onClick={() => void save()} disabled={busy}><Icon name="save" /> {busy ? 'Saving…' : 'Save & apply'}</button>
			</div>

			{test && (
				<fieldset>
					<legend>Test result</legend>
					{test.targets.map((t) => (
						<div className={`form-status ${t.ok ? 'ok' : 'error'}`} key={t.host}>
							{t.ok ? '✓' : '✗'} {t.label}{!t.ok && t.detail ? `: ${t.detail}` : ''}
						</div>
					))}
					<div className="muted small" style={{ marginTop: 6 }}>"Reachable" means the app got a response from the host. A failure here with a code like <code>net::ERR_PROXY_CONNECTION_FAILED</code> tells you (or your IT team) what to fix.</div>
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
						Another port
						<input type="number" min={1024} max={65535} value={port} disabled={busy} onChange={(e) => setPort(e.target.value)} />
					</label>
					<div className="mcp-actions">
						<button type="button" disabled={busy || !valid} onClick={() => onMove(chosen)}>Move to this port and replace the token</button>
					</div>
				</>
			) : (
				<div className="mcp-actions">
					<button type="button" className="secondary" disabled={busy} onClick={onReplaceToken}><Icon name="refresh" /> Replace the token</button>
				</div>
			)}
		</div>
	);
}

function AgentAccessSection({ reveal }: { reveal?: { label: string; nonce: number } }): JSX.Element {
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
	const [mutating, setMutating] = useState<Array<{ name: string; title: string; description: string; domain: string }>>([]);
	const [copiedKey, setCopiedKey] = useState<string | null>(null);
	const [client, setClient] = useState<string>(MCP_CLIENT_PRESETS[0].id);
	const [agentTab, setAgentTab] = useState<AgentTab>('databases');
	const [confirm, confirmDialog] = useConfirm();

	async function regenerate(): Promise<void> {
		const ok = await confirm({
			title: 'Regenerate the token?',
			body: 'This mints a new token and immediately invalidates the current one. A config you pasted into an agent (Claude Code, Codex, Cline, …) stops working until you paste the new one. The coding agents this app starts get the new token on their next start.',
			confirmLabel: 'Regenerate token',
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
		const target = reveal && AGENT_TAB_FOR_SETTING[reveal.label.toLowerCase()];
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
		return <div className="muted">Loading…</div>;
	}

	const exposed = status.connections.filter((c) => c.allowed).length;
	const anyWrites = status.connections.some((c) => c.allowed && c.writes);
	const clientPreset = MCP_CLIENT_PRESETS.find((p) => p.id === client) ?? MCP_CLIENT_PRESETS[0];
	const clientText = clientPreset.build(status);

	return (
		<>
			<SettingsIntro art={AgentAccessArt}>
				<p>
					Let an external agent like Claude Code query your databases through SnoutData Studio. The agent
					connects to a local server here and asks it to run queries; your connection passwords and
					keys never leave this computer, and never touch the agent or a repo. Access is read-only by
					default and you choose exactly which connections are reachable.
				</p>
			</SettingsIntro>

			<label className="check">
				<input type="checkbox" checked={status.enabled} disabled={busy} onChange={(e) => void run(() => window.sqlApi.mcp.setEnabled(e.target.checked))} />
				Allow agent access (run a local server on this computer)
			</label>

			{status.enabled && (
				<>
					{status.problem ? (
						<McpProblemPanel problem={status.problem} busy={busy} onMove={(port) => void run(() => window.sqlApi.mcp.changePort(port))} onReplaceToken={() => void regenerate()} />
					) : (
						<div className={`form-status ${status.running ? 'ok' : 'error'}`}>
							{status.running ? `Listening on ${status.url}` : "Not running. Toggle off and on to retry."}
						</div>
					)}

					<div className="tabs agent-section-tabs">
						{AGENT_TABS.map((t) => (
							<button
								type="button"
								key={t.id}
								className={agentTab === t.id ? 'tab active' : 'tab'}
								onClick={() => setAgentTab(t.id)}
							>
								{t.label}
							</button>
						))}
					</div>

					{agentTab === 'databases' && (
					<>
					<fieldset>
						<legend>Connections the agent may use</legend>
						<div className="muted small">Off by default. Only the connections you select here are visible to agents; everything else stays private. Queries run read-only unless you also allow writes for a connection; under each connection is what its database itself enforces for a read.</div>
						{status.connections.length === 0 && <div className="muted small">No connections yet. Add one first, then expose it here.</div>}
						{status.connections.map((c) => (
							<div className="mcp-conn" key={c.id}>
								<label className="check">
									<input type="checkbox" checked={c.allowed} disabled={busy} onChange={(e) => void run(() => window.sqlApi.mcp.setAllowed(c.id, e.target.checked))} />
									{c.label}
									{c.environment && <span className={`env${c.environment === 'prod' ? ' prod' : ''}`} style={{ marginLeft: 6 }}>{c.environment}</span>}
									{c.readOnly && <span className="model-picker-label" style={{ marginLeft: 6 }}>read-only</span>}
								</label>
								{c.allowed && !c.readOnly && (
									<label className="check mcp-writes">
										<input type="checkbox" checked={c.writes} disabled={busy} onChange={(e) => void run(() => window.sqlApi.mcp.setWrites(c.id, e.target.checked))} />
										Allow writes (INSERT/UPDATE/DELETE/DDL) <span className="muted">(off by default)</span>
									</label>
								)}
								{c.allowed && c.readOnly && (
									<div className="muted small mcp-writes">This connection is read-only, so writes stay blocked. Remove read-only on the connection to allow them.</div>
								)}
								{c.allowed && (c.readOnly || !c.writes) && (
									<div className="muted small mcp-writes">{c.readOnlyBy}</div>
								)}
							</div>
						))}
						{anyWrites && <div className="form-status error" style={{ marginTop: 6 }}>Writes are enabled for one or more connections. An agent can change or delete data there.</div>}
					</fieldset>
					<div className="muted small mcp-footnote">Queries the agent runs are recorded in your query history. By default only read-only statements run (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN): each is checked before it runs, and the database is also asked to refuse writes where its engine can (the line under each connection says how). Writes and DDL are refused unless you allow writes for that connection.</div>
					</>
					)}

					{agentTab === 'agents' && (
					<>
					<fieldset>
						<legend>Coding agents</legend>
						<div className="muted small">
							Run your own coding agent inside SnoutData Studio, in your workspace folder. We look for
							these on this computer; the ones you have are switched on the first time we find
							them. Turn one off and it stays off, even if you reinstall it.
						</div>
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
											? <>Found{found?.install.version ? `: ${found.install.version}` : ''}{descriptor.handoff === 'manual' ? '. Connecting it to your databases is the one-time command below.' : '. It gets your databases automatically.'}</>
											: found?.install.pinned
												? <>The program you chose is not there any more. <button type="button" className="link-btn" onClick={() => { void window.sqlApi.agentConsole.setPath(kind).then(setAgents); }}>Choose it again</button></>
												: <>Not installed. <button type="button" className="link-btn" onClick={() => void window.sqlApi.openExternal(descriptor.installUrl)}>How to install it</button></>}
									</div>
									{/* The failsafe behind discovery: we look on your PATH, and if we cannot find an
									    agent you know you have, you point us at it. */}
									<div className="muted small agent-pick-path">
										{found?.install.path
											? <>{found.install.pinned ? "You chose" : "At"} <code>{found.install.path}</code>{' '}
												<button type="button" className="link-btn" onClick={() => { void window.sqlApi.agentConsole.setPath(kind).then(setAgents); }}>Choose a different one</button>
												{found.install.pinned && <> &middot; <button type="button" className="link-btn" onClick={() => { void window.sqlApi.agentConsole.setPath(kind, null).then(setAgents); }}>Look on my PATH instead</button></>}</>
											: !found?.install.pinned && <button type="button" className="link-btn" onClick={() => { void window.sqlApi.agentConsole.setPath(kind).then(setAgents); }}>I have it, let me point you at it</button>}
									</div>
								</div>
							);
						})}
						<button type="button" className="secondary" disabled={probing} onClick={() => { setProbing(true); void window.sqlApi.agentConsole.discoverAll().then(setAgents).finally(() => setProbing(false)); }}>
							<Icon name="search" /> {probing ? 'Looking...' : 'Look again'}
						</button>
					</fieldset>

					<fieldset>
						<legend>Inside SnoutData Studio</legend>
						<div className="muted small">
							An agent started here runs as part of the app: Studio's tools are its only route
							to a database, its other MCP servers are left out of this session, and results are
							shown in its own panel here instead of scrolling past in the terminal. That is what keeps
							your passwords in the keychain and every query on the agent log. Claude Code also
							has the local database clients (psql, mysql, mongosh and the rest) refused
							outright, which is its own permission system doing the refusing. Switch this off
							to run your agent exactly as it comes, with your own setup and no rules from us.
						</div>
						<label className="check">
							<input
								type="checkbox"
								checked={agentConfig?.routeDatabaseThroughApp !== false}
								disabled={busy || !agentConfig}
								onChange={(e) => { void window.sqlApi.agentConsole.setRouteDatabase(e.target.checked).then(setAgentConfig); }}
							/>
							Database work goes through SnoutData Studio
						</label>
						<div className="muted small">Applies the next time the agent starts.</div>
						{agentConfig?.routeDatabaseThroughApp !== false && (
							<details className="agent-house-rules">
								<summary>What the agent is told</summary>
								<pre>{agentHouseRules({ serverName: MCP_SERVER_NAME, canDraw: true })}</pre>
							</details>
						)}
					</fieldset>
					</>
					)}

					{agentTab === 'actions' && (
					<>
					<fieldset>
						<legend>App actions</legend>
						<div className="muted small">
							Beyond querying, an agent can drive the app itself: open a tab, put a query in the
							grid, change a setting. Reading what is on screen is always allowed. Changing
							anything needs your answer, every time, until you tell it not to for a particular
							action. With the setting below off, an agent that needs one of these asks you to
							turn it on rather than being refused quietly, and saying no stops it asking again.
						</div>
						<label className="check">
							<input
								type="checkbox"
								checked={agentConfig?.allowMutatingCapabilities === true}
								disabled={busy || !agentConfig}
								onChange={(e) => { void window.sqlApi.agentConsole.setAllowMutating(e.target.checked).then(setAgentConfig); }}
							/>
							Let an agent change the app
						</label>
						{agentConfig?.allowMutatingCapabilities && (
							<>
								<div className="muted small">
									Selected actions run without asking. Everything else raises the prompt, where
									"Always allow this" selects it here. Switching the setting above off forgets the lot.
								</div>
								{mutating.length === 0
									? <div className="muted small">Nothing to list yet: the app publishes what an agent can do once the window is up.</div>
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
												Select all
											</button>
											<button
												type="button"
												className="link-btn"
												disabled={busy || granted.length === 0}
												onClick={() => { void window.sqlApi.agentConsole.clearAutoApprove().then(setAgentConfig); }}
											>
												Unselect all
											</button>
										</div>
										<div className="agent-grant-list">
											{mutating.map((cap) => (
												<label className="agent-grant" key={cap.name}>
													<input
														type="checkbox"
														checked={granted.includes(cap.name)}
														disabled={busy}
														onChange={(e) => { void window.sqlApi.agentConsole.setAutoApprove(cap.name, e.target.checked).then(setAgentConfig); }}
													/>
													<span className="agent-grant-text">
														<span className="agent-grant-title">{cap.title}</span>
														<span className="muted small">{cap.description}</span>
													</span>
												</label>
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
						<legend>Connect your agent</legend>
						<div className="muted small">This is the standard MCP config any client accepts (Claude Code, Codex, Cline, …). Add it under your client's MCP servers, for example a <code>.mcp.json</code> in your project. The token authorizes the agent; keep it private. After repeated requests with a wrong token, the app refuses their sender for a while and tells you; it never replaces the token by itself.</div>
						<pre className="mcp-snippet">{mcpConfigSnippet(status)}</pre>
						<div className="modal-actions">
							<button type="button" className="secondary" onClick={() => void copy(mcpConfigSnippet(status), 'json')}><Icon name="copy" /> {copiedKey === 'json' ? 'Copied' : 'Copy config'}</button>
							<span className="spacer" />
							<button type="button" className="secondary" disabled={busy} title="Mint a new token; the old config stops working" onClick={() => void regenerate()}><Icon name="refresh" /> Regenerate token</button>
						</div>
						</fieldset>
						<fieldset>
							<legend>Command</legend>
							<div className="mcp-client-row">
							<span className="muted small">Set up a specific client:</span>
							<select value={client} onChange={(e) => setClient(e.target.value)}>
								{MCP_CLIENT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
							</select>
						</div>
						<div className="muted small">{clientPreset.note}</div>
						<pre className="mcp-snippet">{clientText}</pre>
						<div className="modal-actions">
							<button type="button" className="secondary" onClick={() => void copy(clientText, 'client')}><Icon name="copy" /> {copiedKey === 'client' ? 'Copied' : 'Copy'}</button>
						</div>
						{exposed === 0 && <div className="muted small">Tip: select at least one connection on the Databases tab, or the agent will have nothing to query.</div>}
					</fieldset>
					{/* The sign-in handoff. It sits on this tab because it is the same question as
					    the block above it, asked by a command line instead of an agent: how does
					    something else on this computer get in. */}
					<fieldset>
						<legend>Your SnoutData account</legend>
						<div className="muted small">
							The <code>snoutdata</code> command line, and anything else running here, can ask to use
							the account you are signed in with, so you do not have to open a browser in the middle
							of what you are doing. We ask you first, every time. What you approve is a new access
							token of its own, named for this computer: your sign-in is not handed over, and you can
							revoke the token from <code>snoutdata tokens list</code> or the dashboard whenever you
							like.
						</div>
						<label className="check">
							<input
								type="checkbox"
								checked={status.signInHandoff}
								disabled={busy}
								onChange={(e) => void run(() => window.sqlApi.mcp.setSignInHandoff(e.target.checked))}
							/>
							Let a program here use my account (asks you each time)
						</label>
						{/* Said once and said honestly. Asking prevents surprise, not attack: a program
						    running as you already has whatever you have. Never "nothing could take it". */}
						<div className="muted small">
							Switch this off and the request is refused outright. Worth knowing either way: asking
							is a courtesy, not a lock. Any program running as you on this computer can already
							read what SnoutData Studio keeps here, the same as it can read anything else of yours.
						</div>
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
		if (!(await confirm({ title: 'Clear the AI audit log?', body: 'Every recorded language-model interaction will be deleted. This cannot be undone.', confirmLabel: 'Clear log', danger: true }))) {
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
		return <div className="muted">Loading…</div>;
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
			<label className="check"><input type="checkbox" checked={props.chatEnabled} onChange={(e) => props.onToggleChat(e.target.checked)} /> Record chats with {ASSISTANT_NAME}, and every action taken on your behalf (data flows, agents)</label>
			<label className="check"><input type="checkbox" checked={props.completionEnabled} onChange={(e) => props.onToggleCompletion(e.target.checked)} /> Record auto-completion and inline edits</label>
			<div className="muted">Each enabled kind of language-model interaction is recorded here: when it ran, which model served it, and the full exchange. Off by default; existing entries are kept until cleared. Newest first; the most recent 500 are kept.</div>
			{budget?.metered && budget.percentUsed !== undefined && (
				<div className="muted small audit-meta" title="Your live gateway wallet (percent of the period's budget used), with the recorded turns' share to weigh against it">
					<Icon name="credit-card" />
					<span>Wallet: {budget.percentUsed}% used this period</span>
					{recordedShare && <span className="muted">recorded turns here ≈ {recordedShare} of the wallet</span>}
				</div>
			)}
			<div className="modal-actions">
				<button type="button" className="secondary" onClick={() => void load()}><Icon name="refresh" /> Refresh</button>
				<span className="spacer" />
				<button type="button" className="secondary" disabled={entries.length === 0} onClick={() => void clear()}><Icon name="trash" /> Clear log</button>
			</div>
			{entries.length === 0 && (
				<div className="settings-empty">
					<HistoryArt className="settings-empty-art" />
					<p>No interactions recorded yet. Switch recording on above and every exchange with a model lands here.</p>
				</div>
			)}
			{entries.length > 0 && (
				<div className="audit-filter">
					<select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as 'all' | AiAuditKind)}>
						<option value="all">All kinds</option>
						<option value="chat">Chat</option>
						<option value="completion">Completion</option>
						<option value="edit">Edit</option>
						{/* A data flow's model calls are actions, and for a user who only runs flows they
						    are the ONLY entries in the log. Without this, every specific filter hid them. */}
						<option value="action">Action</option>
					</select>
					<input className="audit-search" value={query} placeholder="Search provider, model, or text…" onChange={(e) => setQuery(e.target.value)} />
					<span className="spacer" />
					{filterActive && <span className="muted small">{filtered.length} match{filtered.length === 1 ? '' : 'es'}</span>}
				</div>
			)}
			{entries.length > 0 && filtered.length === 0 && <div className="muted">No interactions match the filter.</div>}
			<div className="audit-list">
				{pageEntries.map((e) => {
					const open = expanded === e.id;
					const conn = connLabel(e.connectionId);
					return (
						<div className={`audit-entry${e.ok ? '' : ' failed'}`} key={e.id}>
							<button type="button" className="audit-head" onClick={() => setExpanded(open ? null : e.id)}>
								<Icon name={open ? 'chevron-down' : 'chevron-right'} />
								<span className={`audit-kind ${e.kind}`}>{e.kind}</span>
								<span className="tree-label">{e.provider} · {e.model}</span>
								{!e.ok && <span className="audit-badge error" title={e.error}>failed</span>}
								<span className="spacer" />
								<span className="muted small">{new Date(e.timestamp).toLocaleString()}</span>
							</button>
							{open && (
								<div className="audit-body">
									<div className="muted small audit-meta">
										{conn && <span>{conn}</span>}
										<span>{e.durationMs} ms</span>
										{e.usage && <span>{e.usage.totalTokens} tokens ({e.usage.promptTokens}+{e.usage.completionTokens})</span>}
										{e.costUsd !== undefined && budget?.metered && formatWalletShare(e.costUsd, budget.maxBudget) && (
											<span title="Share of your wallet this turn used (prompt + completion)">≈ {formatWalletShare(e.costUsd, budget.maxBudget)} of wallet</span>
										)}
									</div>
									{e.error && <div className="form-status error">{e.error}</div>}
									{e.systemPrompt && (
										<div className="audit-msg grounding">
											{/* An action's system prompt is the stage's own instructions, not the schema
											    grounding a chat turn gets; calling it "schema" would misdescribe the
											    only entries a flows-only user ever sees. */}
											<div className="audit-role">{e.kind === 'action' ? 'instructions sent to the model' : "context sent to the model (schema + what you're looking at)"} · {e.systemPrompt.length.toLocaleString()} chars · ~{Math.round(e.systemPrompt.length / 4).toLocaleString()} tokens</div>
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
										<div className="audit-role">reply</div>
										<pre>{e.response || '(empty)'}</pre>
									</div>
								</div>
							)}
						</div>
					);
				})}
			</div>
			{pageCount > 1 && (
				<div className="audit-pager">
					<button type="button" className="secondary small" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}><Icon name="chevron-left" /> Prev</button>
					<span className="muted small">{rangeStart}-{rangeEnd} of {filtered.length}</span>
					<button type="button" className="secondary small" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)}>Next <Icon name="chevron-right" /></button>
				</div>
			)}
			{confirmDialog}
		</>
	);
}

const SCOPE_LABEL: Record<KnowledgeScope, string> = { glossary: 'Glossary', table: 'Table', column: 'Column' };

/** Per-connection knowledge base management: the reviewable list that makes inline capture safe.
 *  Pick a connection, then view/toggle/edit/delete its notes or add one manually. Glossary notes
 *  are always injected; table/column notes ride schema linking. */
function KnowledgeSection(props: { connections: ConnectionConfig[]; activeConnectionId?: string }): JSX.Element {
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
		if (!(await confirm({ title: 'Delete this note?', body: note.text, confirmLabel: 'Delete', danger: true }))) {
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
				<p>Durable facts you teach the assistant so it stops getting the same domain quirks wrong. <strong>General</strong> rules apply to every database (e.g. “always use CTEs”); pick a specific database for facts about its tables. These notes are sent to {ASSISTANT_NAME} with your prompts, just like your schema is.</p>
			</SettingsIntro>
			<label>Applies to
				<select value={connId} onChange={(e) => { setConnId(e.target.value); setEditing(null); setAdding(false); }}>
					<option value={GLOBAL_CONNECTION}>General (all databases)</option>
					{props.connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
				</select>
			</label>
			{notes === null
				? <div className="muted">Loading…</div>
				: (
					<>
						{notes.length === 0 && !adding && <div className="muted knowledge-empty">{isGeneral
							? <>No general rules yet. Add one like “always use CTEs” or “explain your SQL” that should apply to every database.</>
							: <>Nothing taught yet. Add a fact like “sales lives in <code>customer_order</code>, use <code>fulfilled_date</code>” so the assistant gets it right without you repeating it. The assistant also proposes facts as you work, which show up here to Remember.</>}</div>}
						{notes.some((n) => n.status === 'suggested') && (
							<div className="knowledge-list">
								<div className="muted small">Suggested from your chats. Remember the ones worth keeping:</div>
								{notes.filter((n) => n.status === 'suggested').map((note) => (
									<div className="knowledge-item suggested" key={note.id}>
										<div className="knowledge-item-body">
											<div className="knowledge-item-text">{note.text}</div>
										</div>
										<div className="knowledge-item-actions">
											<button type="button" title="Remember this" onClick={() => void approve(note)}><Icon name="check" /> Remember</button>
											<button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => void dismiss(note)}><Icon name="close" /></button>
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
										<label className="knowledge-item-toggle" title={note.enabled ? 'Enabled, sent to the assistant' : 'Disabled, kept but not sent'}>
											<input type="checkbox" checked={note.enabled} onChange={() => void toggle(note)} />
										</label>
										<div className="knowledge-item-body">
											<div className="knowledge-item-text">{note.text}</div>
											<div className="knowledge-item-meta muted small">
												<span className="knowledge-badge">{SCOPE_LABEL[note.scope]}</span>
												{note.target && <code>{note.target}</code>}
												{note.pinned && <span className="knowledge-badge" title="This table's columns are always included in the assistant's schema view">pinned</span>}
											</div>
										</div>
										<div className="knowledge-item-actions">
											<button type="button" className="icon-btn" aria-label="Edit" onClick={() => { setAdding(false); setEditing(note); }}><Icon name="edit" /></button>
											<button type="button" className="icon-btn" aria-label="Delete" onClick={() => void remove(note)}><Icon name="trash" /></button>
										</div>
									</div>
								))}
						</div>
						{adding
							? <KnowledgeEditor connId={connId} globalOnly={isGeneral} onDone={() => { setAdding(false); void load(); }} onCancel={() => setAdding(false)} />
							: <button type="button" className="secondary knowledge-add" disabled={!connId} onClick={() => { setEditing(null); setAdding(true); }}><Icon name="add" /> Add a note</button>}
					</>
				)}
			{confirmDialog}
		</>
	);
}

/** The add/edit form for a single knowledge note. Reused for a fresh add (no `note`) and an
 *  in-place edit. Saves through the store (upsert by id); glossary notes carry no target. */
function KnowledgeEditor(props: { connId: string; globalOnly?: boolean; note?: KnowledgeNote; onDone(): void; onCancel(): void }): JSX.Element {
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
				placeholder="e.g. There is no sales table; sales data lives in customer_order, fulfilled_date is the sale date."
				onChange={(e) => setText(e.target.value)}
			/>
			<div className="knowledge-capture-row">
				{!props.globalOnly && (
				<label>Scope
					<select value={scope} onChange={(e) => setScope(e.target.value as KnowledgeScope)}>
						<option value="glossary">Glossary (always used)</option>
						<option value="table">Table</option>
						<option value="column">Column</option>
					</select>
				</label>
				)}
				{scope !== 'glossary' && (
					<label>{scope === 'column' ? 'table.column' : 'Table'}
						<input type="text" value={target} placeholder={scope === 'column' ? 'customer_order.fulfilled_date' : 'customer_order'} onChange={(e) => setTarget(e.target.value)} />
					</label>
				)}
				{scope !== 'glossary' && (
					<label className="knowledge-capture-pin" title="Always include this table's columns in the assistant's schema view, even when the question doesn't mention it">
						<input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin table
					</label>
				)}
			</div>
			<div className="chat-approval-actions">
				<button type="button" disabled={!text.trim() || (scope !== 'glossary' && !target.trim())} onClick={() => void save()}><Icon name="save" /> Save</button>
				<button type="button" className="secondary" onClick={props.onCancel}><Icon name="close" /> Cancel</button>
			</div>
		</div>
	);
}

const RESET_ITEMS: Array<{ key: keyof ResetOptions; label: string; detail: string }> = [
	{ key: 'layout', label: 'Window & pane sizing', detail: 'Sidebar, results, and chat panel widths and collapsed state.' },
	{ key: 'preferences', label: 'Editor & appearance preferences', detail: 'Font size, theme, keyword case, auto-LIMIT, and the other Appearance/Editor options.' },
	{ key: 'connections', label: 'Connections & saved credentials', detail: 'Deletes every saved connection along with its stored passwords and SSH keys.' },
	{ key: 'queries', label: 'Query history & saved queries', detail: 'The run history and any named saved queries.' },
	{ key: 'chats', label: `${ASSISTANT_NAME} conversations`, detail: `All saved conversations with ${ASSISTANT_INTRO}.` },
	{ key: 'audit', label: 'AI audit log', detail: 'Every recorded language-model interaction.' },
];

const NO_RESET: ResetOptions = { layout: false, preferences: false, connections: false, queries: false, chats: false, audit: false };

/** Reset chosen categories of settings/data back to defaults. Destructive, so it confirms
 *  first and reports what it cleared. Each category maps to a localStorage reset (handled in
 *  App) or a store-clearing IPC call. */
/** GPU rendering opt-out. State lives in main (userData/gpu.json) because Electron has to read it
 *  before the app is ready, so it can't ride along in the localStorage appSettings. On by default;
 *  the escape hatch is for users whose graphics driver makes Chromium abort the app. Applies on the
 *  next launch, which the copy has to say plainly or the toggle looks broken. */
function HardwareAccelerationSetting(): JSX.Element | null {
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
				<input type="checkbox" checked={state.enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} /> Use hardware acceleration when available
			</label>
			<div className="muted">
				Draws the app using your graphics card, which is faster and is the right choice for almost everyone.
				Turn this off only if the app crashes on startup, shows blank or corrupted panels, or flickers. Those
				are usually signs of a graphics driver problem, and software rendering avoids it at some cost in speed.
			</div>
			{state.autoDisabled && (
				<div className="muted small">
					SnoutData Studio turned this off for you because your graphics card kept crashing, which was making the app
					close unexpectedly. Updating your graphics driver usually fixes it. You can turn it back on here.
				</div>
			)}
			{restartNeeded && <div className="muted small">Restart SnoutData Studio for this to take effect.</div>}
		</>
	);
}

/** Crash/error reporting opt-out. State lives in main (userData/telemetry.json); this reads and
 *  writes it over IPC. `available` is false when no DSN ships, in which case the toggle is inert. */
function PrivacySection({ signedIn }: { signedIn: boolean }): JSX.Element {
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
		setSyncStatus(on ? "Your settings will sync to your account." : "Sync is paused on this computer.");
	}

	async function deleteSynced(): Promise<void> {
		const ok = await confirm({
			title: "Delete synced settings?",
			body: "This removes the copy of your preferences stored in your account. Your settings on this computer are kept, and they sync again the next time you change one.",
			confirmLabel: "Delete",
			danger: true,
		});
		if (!ok) {
			return;
		}
		setSyncBusy(true);
		try {
			await window.sqlApi.settingsSync.wipe();
			setSyncStatus("Your synced settings were deleted from your account.");
		} catch {
			setSyncStatus("Could not delete your synced settings. Please try again.");
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
		return <div className="muted">Loading…</div>;
	}

	return (
		<>
			<SettingsIntro art={PrivacyArt}>
				<p>What the app sends us, and the switch for each. None of it carries your SQL, your results or your connection details.</p>
			</SettingsIntro>
			<label className="check">
				<input type="checkbox" checked={state.enabled} disabled={busy || !state.available} onChange={(e) => void toggle(e.target.checked)} /> Send crash and error reports
			</label>
			{/* The install heartbeat and the daily activity ping ride on this same switch, and only the
			    official build sends them (main/installHeartbeat.ts), so only it may say so. */}
			{OFFICIAL_BUILD ? (
				<div className="muted">
					This sends three things. When something goes wrong, a report (the error and a stack trace), scrubbed before
					it leaves your computer. When the app starts, an install id with its version, platform and locale. And once a
					day, a mark that the app was used. Once you sign in, these are linked to your account, so we can count
					installs and see when an account last used the app. None of it carries your SQL, query results, connection
					details or keys. Turning this off stops all of it.
				</div>
			) : (
				<div className="muted">
					When something goes wrong, a report (the error and a stack trace) is sent to help us fix it. Reports are
					scrubbed before they leave your computer: your SQL, query results, connection details and keys are never
					included. A build from source sends no install or usage pings.
				</div>
			)}
			{!state.available && <div className="muted small">Reporting is not configured in this build, so this setting has no effect.</div>}
			<fieldset>
				<legend>Settings sync</legend>
				<label className="check">
					<input type="checkbox" checked={syncOn} disabled={!signedIn} onChange={(e) => toggleSync(e.target.checked)} /> Sync my settings to my account
				</label>
				<div className="muted">
					Your appearance, editor, and query preferences (theme, pane layout, and options) are saved to your
					account, so a new computer starts set up the way you like. Passwords, keys, and connection details are
					never synced; they stay encrypted on this computer.
				</div>
				{!signedIn && <div className="muted small">Sign in to sync your settings across computers.</div>}
				{signedIn && (
					<div className="modal-actions">
						<span className="spacer" />
						<button type="button" className="danger" disabled={syncBusy} onClick={() => void deleteSynced()}><Icon name="trash" /> {syncBusy ? "Deleting…" : "Delete my synced settings"}</button>
					</div>
				)}
				{syncStatus && <div className="form-status ok">{syncStatus}</div>}
			</fieldset>
			{confirmDialog}
		</>
	);
}

function ResetSection(props: { onReset(options: ResetOptions): Promise<void> }): JSX.Element {
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
		const chosen = RESET_ITEMS.filter((i) => selected[i.key]).map((i) => i.label);
		if (chosen.length === 0) {
			return;
		}
		const ok = await confirm({
			title: 'Reset these settings?',
			body: (
				<>
					<div>The following will be cleared. This cannot be undone.</div>
					<ul className="confirm-list">{chosen.map((c) => <li key={c}>{c}</li>)}</ul>
				</>
			),
			confirmLabel: 'Reset',
			danger: true,
		});
		if (!ok) {
			return;
		}
		setBusy(true);
		try {
			await props.onReset(selected);
			setSelected(NO_RESET);
			setStatus('Done. Selected settings were reset.');
		} catch {
			setStatus('Something went wrong while resetting.');
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<SettingsIntro art={ResetArt}>
				<p>Choose what to clear, then Reset. Each box is independent. This cannot be undone.</p>
			</SettingsIntro>
			<fieldset>
				<legend>Clear</legend>
				{RESET_ITEMS.map((item) => (
					<label className="reset-item" key={item.key}>
						<input type="checkbox" className="reset-check" checked={selected[item.key]} onChange={(e) => toggle(item.key, e.target.checked)} />
						<span className="reset-item-text">
							<span className="reset-item-label">{item.label}</span>
							<span className="muted small reset-item-detail">{item.detail}</span>
						</span>
					</label>
				))}
			</fieldset>
			<div className="modal-actions">
				<span className="spacer" />
				<button type="button" className="danger" disabled={busy || !anySelected} onClick={() => void run()}><Icon name="trash" /> {busy ? 'Resetting…' : 'Reset selected'}</button>
			</div>
			{status && <div className="form-status ok">{status}</div>}
			{confirmDialog}
		</>
	);
}

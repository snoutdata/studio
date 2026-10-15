/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../shared/assistant';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, safeStorage, session, shell, type MenuItemConstructorOptions } from 'electron';
import { basename, join, resolve } from 'node:path';
import { homedir, hostname, tmpdir } from 'node:os';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { CompletionItem, Position } from 'vscode-languageserver-protocol';

// STARTUP BUDGET, main-process half (pairs with src/renderer/src/startupPerf.ts and
// e2e/startup.spec.ts). `bootMark` is declared before the feature imports below on purpose: module
// evaluation of those ~80 imports IS part of what a launch costs, so the origin has to be taken
// ahead of them or that cost measures as zero. Read from e2e via `global.__snoutBoot`.
const bootMarks: { name: string; at: number }[] = [];
const BOOT_ORIGIN = Date.now();
export function bootMark(name: string): void {
	bootMarks.push({ name, at: Date.now() - BOOT_ORIGIN });
}
(globalThis as unknown as { __snoutBoot?: () => { name: string; at: number }[] }).__snoutBoot = () => bootMarks;

import { migrateLegacyUserData } from './userDataMigration';
import { SqlServer } from './sqlServer';
import { appPageUrl } from './appOrigin';
import { guardAppWindow, installDefaultSessionPermissions, installGlobalWebContentsGuard, installIpcSenderGuard, openExternalIfAllowed } from './navigationGuard';
import { SecretStore } from './secretStore';
import { ensurePrivateDir, tightenPrivateFiles, writePrivateFile } from './privateFile';
import { ComponentStore } from './componentStore';
import { QueryStore } from './queryStore';
import { ChatStore } from './chatStore';
import { KnowledgeStore } from './knowledgeStore';
import { WorkspaceStore } from './workspaceStore';
import { fileSaveRoots, ImportGrants, PathGrants } from './pathGrants';
import type { DbeaverScriptScan } from '../shared/workspace';
import { MonitorStore } from './monitorStore';
import { MoveStore } from './moveStore';
import { checkMove, fixMove, pgToolsDir, pgToolsMajor, type MoveHost } from './moveService';
import { MoveRuns } from './moveRunner';
import { MoveRunStore } from './moveRunStore';
import { registerMain } from '@snout/studio-pro/main';
import type { MoveConfirmations } from '../shared/move';
import type { FixId, MoveSpec } from '@snout/move';
import { MonitorPoller } from './monitorPoller';
import { OrbitPulseSampler } from './orbitPulse';
import { guardMonitor, monitorQueryRefusal, type Monitor } from '../shared/monitor';
import { CloudStore } from './cloudStore';
import type { CloudAccountForm, CloudVendor } from '../shared/cloud';
import { CloudService } from './cloud/cloudService';
import { AuditStore } from './auditStore';
import { ConnectionManager } from './connectionManager';
import { SecurityService } from './securityService';
import { FailureMemory } from './failureMemory';
import { FailureMemoryStore } from './failureMemoryStore';
import { runFailureMemorySelfTest } from './failureMemorySelfTest';
import { runFailureMemoryBench } from './failureMemoryBench';
import { TunnelManager } from './tunnelManager';
import { ReviewService } from './review/reviewService';
import type { ReviewForge, ReviewMethod } from '../shared/review';
import { McpStore } from './mcpStore';
import { mintCliToken, type CliSignInOutcome } from './cliSignIn';
import { McpLogStore } from './mcpLogStore';
import { ProxyStore, readProxyFile } from './proxyStore';
import { KeybindingStore } from './keybindingStore';
import { markActive, sendInstallHeartbeat } from './installHeartbeat';
import { LocalMcpServer, McpPortInUseError, nextFreeLoopbackPort, loopbackPortFree, toConnectionRefs, type McpConnectionRef } from './mcpServer';
import { AgentConsole } from './agentConsole';
import { AgentConsoleStore } from './agentConsoleStore';
import { rewriteAgentMcpConfig, writeAgentConfig } from './agentMcpConfig';
import { resolveUserPath } from './loginPath';
import { AGENTS, AGENT_ACTION_TIMEOUT_MS, agentImagePasteKey, isAgentKind, type AgentActionRequest, type AgentApproval, type AgentConsoleSize, type AgentImagePaste } from '../shared/agentConsole';
import { AiSettingsStore } from './aiSettingsStore';
import { AiService } from './aiService';
import { startAiDebugServer } from './aiDebugServer';
import { aiDebugRequested } from './ai/debugLog';
import { ATTACHABLE_EXTENSIONS, extractDocument } from './ai/documentExtract';
import type { ScriptedReply } from './ai/scriptedProvider';
import { AuthStore } from './authStore';
import { SettingsSyncStore, type SettingsBlob } from './settingsSyncStore';
import { AppUpdater, logUpdate } from './updater';
import { readThirdPartyLicences } from './thirdPartyLicences';
import { ISSUES_URL, minimumVersionCheckAllowed, OFFICIAL_BUILD, OPEN_BUILD_PROFILE, registersAuthProtocol } from '../shared/officialBuild';
import type { UpdateStatus } from '../shared/update';
import type { MinimumVersionState } from '../shared/minimumVersion';
import { checkMinimumVersion } from './minimumVersionCheck';
import { decideTrayInstall, type BackgroundActivity } from './trayInstall';
import { runSelfCheck } from './selfCheck';
import { SELF_CHECK_FLAG, waitOutSwap } from './stagedUpdate';
import { allowTestHooks, testEnv } from './testHooks';
import { consumeRelaunchHidden, writeRelaunchHidden } from './relaunchHidden';
import { markWeakSecretsWarned, usePlainTextSecrets, weakSecretsWarned } from './secretStorageMode';
import { markTrayNoticeShown, readWindowSize, trayNoticeShown, writeWindowSize } from './windowStore';
import { AppTray } from './tray';
import type { TrayProjectVerb } from './trayMenu';
import { reportHandled, setTelemetryEnabled, startTelemetry, telemetryActive, telemetryAvailable, telemetryEnabled } from './telemetry';
import { applyHardwareAcceleration, hardwareAccelerationAutoDisabled, hardwareAccelerationEnabled, recordGpuCrash, setHardwareAccelerationEnabled } from './gpuStore';
import type { ConnectionFormValues, DiscoveryOptions, ImportItemRef, ImportScanResult, ImportSourceId, TunnelProfileFormValues } from '../shared/forms';
import { resolveDbeaverImport, scanDbeaver, scanDbeaverFiles, scanDbeaverScripts } from './dbeaverImport';
import { resolveSnoutdataCloudImport, scanSnoutdataCloud } from './cloudImport';
import { liveCloudApi } from './cloudApiLive';
import { askCloudProject, cloudProjectsView, createCloudProject, deleteCloudProject } from './cloudProjects';
import type { CloudCreateForm, CloudProjectOp, CloudProjectOps, CloudProjectRow, CloudProjectsView } from '../shared/cloudProjects';
import { runCloudProjectOp, type CloudProjectHost } from './cloudProjectOps';
import { buildAndDeploy } from './containerBuild';
import { uploadFile } from './netUpload';
import type { ContainerBuildForm, ContainerBuildProgress } from '../shared/cloudContainers';
import { syncCloudConnections } from './cloudSync';
import { rememberCloudRefs, seenCloudRefs } from './cloudSyncStore';
import { readConnections, writeConnection } from './configStore';
import { readTunnels } from './tunnelStore';
import { agentActionDetail, agentCallGate, type AgentActionDetail } from './agentActionDetail';
import { gateMonitorCall } from './monitorAgentGate';
import { LocalStackService } from './localStack/service';
import { ProjectAccess } from './projectAccess';
import { ProjectCopies } from './projectCopy';
import type { ProjectCopyRequest } from '../shared/projectCopy';
import { isProjectTarget, openProjectCommand, projectKey, type ProjectApiRequest, type ProjectTarget } from '../shared/projects';
import type { LocalCopyTarget, LocalMailKind, LocalProgress, LocalProjectRow, LocalProjectsView, LocalSettingsChange, LocalSetupForm } from '../shared/localStack';
import { resolveDatagripImport, scanDatagrip, scanDatagripFiles } from './datagripImport';
import { resolveNavicatImport, scanNavicat, scanNavicatFiles } from './navicatImport';
import { browseDiscoverySource, resolveDiscoveryImport, runDiscovery, scanDiscoverySource } from './discovery/run';
import { type AiAuditKind, type AiCompletionOutcomeParams, type AiCompletionParams, type AiCompletionResult, type AiEditParams, type AiEditResult, type AiProviderId, type AiSettingsFormValues, type AiToolEvent, type AmbientContext, type ByokProviderId, type ChatMessage, type ExtractDocumentResult, type LibyChatRequest } from '../shared/ai';
import type { CapabilityInvocation, CapabilityResult, CapabilitySpec } from '../shared/capabilities';
import { asksEveryTime, capabilityTitle } from '../shared/capabilities';
import type { AuthProviderId, AuthUser, Tier } from '../shared/auth';
import type { ChatSession } from '../shared/chat';
import type { KnowledgeNote } from '../shared/knowledge';
import type { ExecuteQueryResult, RunQueryParams } from '../shared/protocol';
import { DATA_ACCESS_LEVELS, readOnlyEnforcementFor, resolveDataAccess, type DataAccessLevel, bulkExportExtension, bulkFormatById, bulkFormatsFor, bulkLoadExtensions, credentialNote, describeStatement, emitBulkExport, emitBulkLoad, emitTableFunctionCall, importStatement, previewStatement, REDACTED, serverExportRefusal, tableFunctionById, encodingForFile, formatForFile, sqlSyntaxDiagnostics, type ApplyStatement, type SecurityChange, type MongoDdl, type MongoWrite } from '../shared/engine';
import type { CliSignInAnswer, CliSignInRequest, McpStatus } from '../shared/mcp';
import { networkErrorDetail, isNetworkError, netFetch } from './netFetch';
import { ACCOUNTS_HEALTH_URL, ACCOUNTS_HOST } from './cloudClient';
import { integratedAuthSwitches, type ProxyFormValues, type ProxyStatus, type ProxyTestResult, type ProxyTestTarget } from '../shared/proxy';
import { toAccelerator } from '../shared/keybindings';
import type { AppMenu, AppMenuItem } from '../shared/menu';
import type { XlsxSheet } from '../shared/export';
import { buildXlsx } from './xlsx';

// Dev and the installed app otherwise share one userData dir (and so one auth session in
// auth.json). With both auto-refreshing, whichever refreshes first rotates the refresh token and
// the other replays a now-stale one -> refresh_token_not_found (plus colliding connections/secrets).
// Give a dev run its own userData so the two never collide. Must run before any store below reads it.
// E2E (Playwright) runs point userData at a per-test scratch dir so tests never read or write
// the real connections/secrets/chats, and the legacy migration below never copies real data
// into the scratch profile. Set by e2e/helpers.ts, which runs the UNPACKAGED build, and by a staged
// update's self-check, which starts the next installed build with SELF_CHECK_FLAG against a scratch
// profile (stagedUpdate.ts; an older install passes it to this one, so it must keep working). A
// packaged build honours it for that self-check only, so the variable alone can neither move a real
// install's profile nor switch on the e2e hooks below. The other test-only variables are closed in a
// packaged build outright (testHooks.ts).
allowTestHooks(!app.isPackaged);
// A build from the open-source tree keeps its own profile, so it never opens (or migrates, or
// refreshes the session of) the official app's (shared/officialBuild.ts). The e2e and dev rules
// below apply on top of it, as they do to the official one.
if (!OFFICIAL_BUILD) {
	app.setPath('userData', join(app.getPath('appData'), OPEN_BUILD_PROFILE));
}
const e2eUserData = !app.isPackaged || process.argv.includes(SELF_CHECK_FLAG) ? process.env.SNOUT_E2E_USERDATA : undefined;
if (e2eUserData) {
	app.setPath('userData', e2eUserData);
} else if (!app.isPackaged) {
	app.setPath('userData', `${app.getPath('userData')}-dev`);
}

// A launch that lands while a staged update is moving folders (the icon double-clicked the second
// after quitting) waits for the swap and restarts from the install that is there now, rather than
// running from a folder about to be renamed under it (stagedUpdate.waitOutSwap). One existsSync on
// every other launch.
if (process.platform === 'win32' && app.isPackaged && !e2eUserData && waitOutSwap(process.execPath)) {
	process.exit(0);
}

// Rebrand: one-time copy of the legacy positron-db userData into the new snoutdata dir so
// existing users keep their connections/secrets/chats/session. Must run before the stores below
// read userData. No-op (a couple existsSync checks) on every launch after the first.
// The legacy profile is the official app's, so an open build never copies it.
if (!e2eUserData && OFFICIAL_BUILD) {
	migrateLegacyUserData();
}

// Integrated Windows auth (Kerberos/NTLM). Chromium answers a PROXY's Negotiate/NTLM challenge
// with the logged-in identity on its own (`AllowsDefaultCredentials` is true for `AUTH_PROXY`), so a
// corporate proxy needs neither switch. They only decide which SERVERS may ask for that identity
// and which may receive a delegated Kerberos ticket. Both used to be `*`, which answered any server
// on the internet; now the server list is the manually configured proxy plus what Settings →
// Network names, and delegation is off unless a server is named there. Must run before `ready`,
// so a change applies at the next launch (src/shared/proxy.ts, integratedAuthSwitches).
for (const [name, value] of Object.entries(integratedAuthSwitches(readProxyFile()))) {
	app.commandLine.appendSwitch(name, value);
}

// Hardware acceleration (Settings → Appearance). Must run before app `ready`: Electron fixes the
// GPU decision at startup and ignores disableHardwareAcceleration() after. On by default, so this
// is a no-op read for everyone except users whose GPU driver makes Chromium abort the app.
applyHardwareAcceleration();

// Which `child-process-gone` reasons mean the GPU process actually failed. A 'clean-exit' is
// normal teardown, and 'killed' is the OS or the user, so neither says anything about the driver.
const GPU_CRASH_REASONS = new Set(['crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit']);

// The auto-fallback behind the hardware-acceleration setting. A bad graphics driver crashes
// Chromium's GPU process; Chromium retries down a fallback ladder and, when it runs out of rungs,
// deliberately aborts the whole browser process ("GPU process isn't usable. Goodbye.") — which is
// the EXCEPTION_BREAKPOINT minidump we saw from a real user. The Settings toggle can't rescue them
// because by then there is no app left to open, so catch the crashes on the way down and turn
// acceleration off for the next launch. Registered before `ready` so a GPU crash during startup
// counts too. gpuStore persists on every crash: the fatal abort gives us no chance to save later.
app.on('child-process-gone', (_event, details) => {
	if (details.type !== 'GPU' || !GPU_CRASH_REASONS.has(details.reason)) {
		return;
	}
	const autoDisabled = recordGpuCrash();
	console.error(`[gpu] GPU process gone (${details.reason}, exit ${details.exitCode})${autoDisabled ? ' — turning off hardware acceleration for the next launch' : ''}`);
	if (autoDisabled) {
		// Worth knowing about: this fires only on hardware we've effectively given up on.
		reportHandled(new Error(`GPU process crashed repeatedly (${details.reason}); turned off hardware acceleration`), {
			reason: details.reason,
			exitCode: details.exitCode,
		});
	}
});

// Crash/error reporting (Sentry). Init as early as possible so a failure during boot is still
// captured. No-op in dev or when no DSN is configured; honors the persisted opt-out.
startTelemetry();

const sqlServer = new SqlServer();
// The one page that may run in the main window and talk to main (appOrigin.ts).
const APP_PAGE_URL = appPageUrl(process.env.ELECTRON_RENDERER_URL, join(__dirname, '../renderer/index.html'));
const secretStore = new SecretStore();

/** True when this machine has no password vault and secrets are sealed with Chromium's fixed
 *  `basic_text` key instead (secretStorageMode.ts). Settled once, right after `ready`, before
 *  anything reads or writes a secret; Settings and the one-time warning read it. */
let secretsWeak = false;

/** Linux with no Secret Service: save passwords anyway, with the fixed key, rather than refuse them.
 *  Two synchronous calls into Chromium and no disk, so it costs the boot path nothing. Every other
 *  machine (macOS, Windows, a Linux desktop whose keyring answers) is left exactly as it was. */
function settleSecretStorage(): void {
	if (process.platform !== 'linux') {
		return;
	}
	// Availability first: on Linux that call is what makes Chromium pick its backend.
	const available = safeStorage.isEncryptionAvailable();
	const backend = safeStorage.getSelectedStorageBackend();
	if (usePlainTextSecrets({ platform: process.platform, backend, available })) {
		safeStorage.setUsePlainTextEncryption(true);
		secretsWeak = true;
		console.warn('[secrets] no password vault on this desktop (basic_text): saving secrets with the fixed key');
	}
}
const componentStore = new ComponentStore();
const queryStore = new QueryStore();
const chatStore = new ChatStore();
const knowledgeStore = new KnowledgeStore();
const workspaceStore = new WorkspaceStore(app.getPath('userData'));
// Paths main produced (a dialog, a scan) that the renderer may hand back on the channels that
// write, copy or load a file (pathGrants.ts).
const pathGrants = new PathGrants();
// The import refs a scan main ran listed this session; `import:apply` re-reads only those.
const importGrants = new ImportGrants();
/** A DBeaver scan main ran: the scripts it listed are what the workspace may then copy in. */
function grantScan(scan: DbeaverScriptScan): DbeaverScriptScan {
	pathGrants.grant('workspace:importPaths', ...scan.scripts.map((script) => script.path));
	return scan;
}
const auditStore = new AuditStore();
const aiSettingsStore = new AiSettingsStore(secretStore);

const proxyStore = new ProxyStore(secretStore);

const keybindingStore = new KeybindingStore();

// Supply credentials to an authenticating (Basic/Digest) proxy from Settings → Network. The auth-*
// allowlist above handles integrated Kerberos/NTLM transparently; this covers the proxy that wants a
// typed username/password instead. Only acts on a proxy challenge with stored creds — otherwise it
// leaves the request to default handling so server (non-proxy) 401s are untouched.
app.on('login', (event, _webContents, _details, authInfo, callback) => {
	if (!authInfo.isProxy) {
		return;
	}
	const config = proxyStore.config();
	const password = proxyStore.password();
	if (!config.username || !password) {
		return;
	}
	event.preventDefault();
	callback(config.username, password);
});

/** A day, after which a pasted image nobody used is just a file in the temp directory. */
const PASTED_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Put a clipboard image somewhere the agent can read it, for the agents that take an image as a
 * path rather than reading the clipboard themselves. Returns the path, or null if it could not be
 * written (a full disk is not worth an error dialog over a paste).
 *
 * They go to a folder of the user's own under userData, made owner-only (0700, each file 0600):
 * a screenshot can hold anything that was on the screen, and the OS temp directory is shared by
 * every account on Linux, where a folder of this name someone else made first would have taken
 * the files (an outside review, 2026-10-14). An existing folder is used only when it is a real
 * folder owned by this user. Yesterday's are swept on the way in so a week of pasting screenshots
 * does not accumulate.
 */
function saveClipboardImage(png: Buffer): string | null {
	try {
		const dir = join(app.getPath('userData'), 'pasted-images');
		ensurePrivateDir(dir);
		const now = Date.now();
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			try {
				if (now - statSync(path).mtimeMs > PASTED_IMAGE_TTL_MS) {
					rmSync(path, { force: true });
				}
			} catch {
				// Someone else's file, or gone already. Not our business either way.
			}
		}
		const path = join(dir, `paste-${now}.png`);
		writePrivateFile(path, png);
		return path;
	} catch {
		return null;
	}
}

function broadcast(channel: string, ...args: unknown[]): void {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(channel, ...args);
	}
}


// Reusable SSH tunnel profiles, shared across connections. A tunnel change can affect a
// connection's effective config, so it broadcasts on the connections channel too.
function broadcastTunnelsChanged(): void {
	broadcast('tunnels:changed');
	connectionsChanged();
}

/** A connection came up, went down or was edited: tell the renderer, and redraw the tray, whose
 *  Connections submenu is the only view of this while the window is hidden. */
function connectionsChanged(): void {
	broadcast('connections:changed');
	tray?.refresh();
}
const connections = new ConnectionManager(sqlServer, secretStore, queryStore, connectionsChanged, broadcastTunnelsChanged, componentStore, app.isPackaged, { markActive });
const security = new SecurityService(connections);
const tunnels = new TunnelManager(secretStore, broadcastTunnelsChanged);
const aiService = new AiService(aiSettingsStore, connections, queryStore, auditStore, knowledgeStore);
// Wire the AI half of the hybrid SQL→native transcriber: on a document
// connection, SQL the deterministic compiler can't represent falls back to the model. Late-bound
// here because AiService depends on the connection manager (so it can't be a ctor arg).
connections.setAiTranscriber((sql, connectionId) => aiService.transcribeToNative(sql, connectionId));
// A cloud connection whose stored password was reset elsewhere reads the current one (connectionManager.ts).
connections.setCloudPassword(async (ref) => (await liveCloudApi.connection(ref)).password ?? null);
// Wire text→vector embedding, the other half of the vector story: a
// `similar_to('…')` predicate in SQL against a Pinecone index becomes a real similarity search.
connections.setEmbedder((text) => aiService.embed(text));
// Wire the failure-memory write sink. Late-bound like
// the transcriber: it resolves each failure's schema fingerprint through the connection manager, so
// the resolver closes over `connections` (created above) and the sink is handed back via a setter.
// In dev, log each captured failure to the terminal so the write path is observable by hand (run a
// query that fails, watch for the `[failure-memory]` line). No-op in packaged builds — nothing reads
// memory back yet, so there is no user-facing surface to leak.
const failureMemoryStore = new FailureMemoryStore(join(app.getPath('userData'), 'failures.db'));
const failureMemory = new FailureMemory(
	failureMemoryStore,
	(connectionId) => connections.schemaDigest(connectionId),
	app.isPackaged
		? undefined
		: (r) => console.log(`[failure-memory] ${r.errorClass} (${r.origin}/${r.backend}) fp=${r.schemaFingerprint || 'none'} error=${JSON.stringify(r.error).slice(0, 120)} shape=${JSON.stringify(r.queryShape).slice(0, 120)}`),
);
connections.setFailureMemory(failureMemory);
connections.setFailureQuery(failureMemoryStore);
/** The last thing the updater said. The toast in the renderer is one audience for it; the tray
 *  menu is the other, and it is the one a user sees while the window is hidden. */
let updateStatus: UpdateStatus | null = null;
const updater = new AppUpdater((status) => {
	updateStatus = status;
	// Sticky: a later re-check re-announces the same staged download, and nothing un-downloads one.
	if (status.state === 'downloaded') {
		updateReady = true;
		startTrayInstallWatch();
	}
	tray?.refresh();
	broadcast('update:status', status);
});

/** A downloaded update is waiting for a restart. */
let updateReady = false;

// ── Minimum supported version ──────────────────────────────────────────────────────────
// Read from accounts.snoutdata.com (the Worker answers it itself). Below it, the renderer shows a
// blocking "update required" sheet that drives the updater. Packaged builds only: a dev build's
// version is whatever package.json says and has no updater to drive. Never in a build from the
// open-source tree, which has no feed to update from (src/shared/officialBuild.ts).
let minimumVersionState: MinimumVersionState = { required: false };

async function runMinimumVersionCheck(): Promise<void> {
	if (!minimumVersionCheckAllowed({ official: OFFICIAL_BUILD, packaged: app.isPackaged, devOverride: Boolean(process.env.SNOUT_DEV_MINIMUM_VERSION) })) {
		return;
	}
	const state = await checkMinimumVersion({
		version: process.env.SNOUT_DEV_MINIMUM_VERSION && !app.isPackaged ? process.env.SNOUT_DEV_MINIMUM_VERSION : app.getVersion(),
		cachePath: join(app.getPath('userData'), 'minimum-version.json'),
		origin: `https://${ACCOUNTS_HOST}`,
	});
	const changed = state.required !== minimumVersionState.required;
	minimumVersionState = state;
	if (!changed) {
		return;
	}
	logUpdate(state.required ? `minimum version: v${state.current} is below the supported v${state.minimum}, update required` : 'minimum version: this version is supported again');
	broadcast('app:minimumVersion', state);
	// Start fetching the update now rather than waiting for the sheet to be seen: a hidden app can
	// then install it from the tray the moment it is idle.
	if (state.required) {
		updater.check();
	}
}

// ── Installing from the tray ──────────────────────────────────────────────────────────────────
// The close button hides to the tray, so an update that waits for a quit waits for ever for
// somebody who never quits. Once one is downloaded, look once a minute: when the window is hidden
// and nothing has run for a while (trayInstall.ts says what counts), install it and come back in
// the tray. Linux has no in-app install (apt owns it), and e2e runs never install anything.
const TRAY_INSTALL_TICK_MS = 60 * 1000;
let trayInstallTimer: ReturnType<typeof setInterval> | undefined;
let trayInstallQuietSince: number | null = null;
let trayInstallLastBlocker: string | null = null;

function startTrayInstallWatch(): void {
	if (trayInstallTimer || process.platform === 'linux' || e2eUserData || !app.isPackaged) {
		return;
	}
	trayInstallTimer = setInterval(trayInstallTick, TRAY_INSTALL_TICK_MS);
	trayInstallTimer.unref?.();
}

function backgroundActivity(): BackgroundActivity {
	const win = mainWindow();
	// Data Flows' share: runs in flight, the next scheduled run, model jobs.
	const flows = pro.backgroundActivity(schedulesPaused);
	return {
		windowVisible: Boolean(win && !win.isDestroyed() && win.isVisible()),
		flowRuns: flows.flowRuns,
		nextScheduledRunInMs: flows.nextScheduledRunInMs,
		queries: connections.queriesInFlight(),
		reviewing: reviewService.trayState().activity !== undefined,
		moveRuns: moveRuns.anyRunning() ? 1 : 0,
		modelJobs: flows.modelJobs,
		agentConsoles: agentConsole.statuses().filter((status) => status.running).length,
		aiStreams: chatAborts.size + agentActing.size,
	};
}

function trayInstallTick(): void {
	if (!updateReady || installingUpdate || tornDown) {
		return;
	}
	let decision;
	try {
		decision = decideTrayInstall(backgroundActivity(), trayInstallQuietSince, Date.now());
	} catch (err) {
		// Reading the app's state failed somewhere; the safe answer is "not now".
		trayInstallQuietSince = null;
		logUpdate(`tray install: could not read activity (${err instanceof Error ? err.message : String(err)})`);
		return;
	}
	trayInstallQuietSince = decision.quietSince;
	// Only log a change, or update.log fills with one line a minute for as long as the window is open.
	if (decision.blocker !== trayInstallLastBlocker) {
		trayInstallLastBlocker = decision.blocker;
		logUpdate(`tray install: ${decision.blocker ? `waiting (${decision.blocker})` : 'idle, counting'}`);
	}
	if (decision.install) {
		installUpdateInBackground();
	}
}

// Re-check for updates while the app stays open. The renderer kicks off ONE check per launch
// (deferred to idle, see App.tsx), and before this that was the only automatic check there was:
// leave the app running and it would never learn about a release, no matter how long it sat there.
// The user hit exactly that — a version shipped, the open app kept reporting the older one, and
// only a restart surfaced the toast. Every 4 hours is enough to fix that (an app left open for
// days still picks a release up the same session) while keeping the feed requests rare.
// A check that finds nothing is silent (the renderer only toasts a manual check or a ready
// download), so this never interrupts anyone.
const UPDATE_RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
let updateRecheckTimer: ReturnType<typeof setInterval> | undefined;

function startUpdateRechecks(): void {
	if (updateRecheckTimer) {
		return;
	}
	// Interval only: the first check is the renderer's launch one, so nothing extra runs at boot.
	updateRecheckTimer = setInterval(() => {
		updater.check();
		void runMinimumVersionCheck();
	}, UPDATE_RECHECK_INTERVAL_MS);
	// Must never be the reason the process stays alive.
	updateRecheckTimer.unref?.();
}

// Local MCP server: a credential broker that lets an external agent (Claude Code) query the
// user's DBs *through* the app, so credentials never leave the keychain.
// Read-only, opt-in per connection, gated by a bearer token. The server is electron-free; it
// reaches the broker through these injected adapters.
const reviewService = new ReviewService({
	connections,
	secrets: secretStore,
	// The tray's Pause Scheduled Flows switch pauses reviews too: it is one promise to the user
	// about background work, not one per feature.
	isPaused: () => schedulesPaused,
	// The prose half of a review, when a repository asked for one. The FINDINGS never touch this.
	commentary: (prompt, method) => aiService.reviewCommentary(prompt, method),
	onChanged: () => {
		void reviewService.status().then((status) => broadcast('review:changed', status));
		// The tray says what the reviewer is doing (trayMenu.ts, `reviewLine`), and a review that
		// finished behind a hidden window is exactly the case that reading has to cover.
		tray?.refresh();
	},
	onRun: (run) => broadcast('review:run', run),
	onStarted: (started) => broadcast('review:started', started),
});
const mcpStore = new McpStore();
const mcpLogStore = new McpLogStore();
const mcpServer = new LocalMcpServer({
	serverInfo: { name: 'snoutdata', version: app.getVersion() },
	token: () => mcpStore.token(),
	// Wrong bearers that keep arriving are refused outright for a while (a stale config, a retired
	// token, does not count); the right token always gets in. The token is never replaced here: the
	// person is told, and offered it.
	isRetiredToken: (bearer) => mcpStore.isRetiredToken(bearer),
	onLockout: (lockout) => {
		console.warn(`[mcp] ${lockout.remote} sent ${lockout.attempts} wrong tokens; its wrong tokens are refused until ${new Date(lockout.until).toISOString()}`);
		broadcast('mcp:changed');
	},
	connections: (): McpConnectionRef[] => toConnectionRefs(
		connections.state().connections,
		(id) => mcpStore.isAllowed(id),
		(id) => mcpStore.isWriteAllowed(id),
	),
	resolveSchema: async (id) => { await ensureConnected(id); return connections.getSchema(id); },
	// recordHistory=false: an agent's queries go to the MCP log, never the user's query history.
	execute: async (id, sql, options) => { await ensureConnected(id); return options?.readOnly ? connections.executeRead(id, sql, false) : connections.execute(id, sql, false); },
	log: (entry) => mcpLogStore.record(entry),
	// The agent path lands on the SAME audit trail as chat, tagged origin 'mcp' — it is the least
	// supervised path to the user's data, so it is the one that most needs to be reviewable.
	// Gated inside recordAgentAction by the same tier + preference as chat.
	audit: (record, client) => aiService.recordAgentAction(record, client),
	// The app's own capabilities, as tools. This is what lets an external agent act on the SCREEN
	// (open a tab, put a query in the grid, change a setting), not just read a database, and it is
	// the same registry the assistant drives.
	capabilities: () => publishedCapabilities,
	invokeCapability: (name, args, client, expect) => invokeAgentCapability(name, args, client, expect),
	// Which connection a capability would act on without naming it, asked of the window before
	// anything runs or anyone is asked, so one not exposed to agents is refused first.
	resolveCapabilityConnections: (name, args, client) => sendAgentCapability(name, args, client, { resolveConnections: true }),
	// Reported to the agent, not enforced here: the invoker above asks the user. Off means "has to
	// ask", not "cannot" (see invokeAgentCapability).
	allowMutatingCapabilities: () => agentConsoleStore.allowsMutatingCapabilities(),
	dataAccess: (connectionId) => resolveDataAccess(aiSettingsStore.get().dataAccess, connectionId ? connections.state().connections.find((c) => c.id === connectionId)?.aiDataAccess : undefined),
	autoApprovedCapabilities: () => agentConsoleStore.config().autoApproveCapabilities,
	// The sign-in handoff: the `snoutdata` CLI on this computer can ask
	// who is signed in, and ask for a credential of its own rather than sending the person to a
	// browser mid-task. The EMAIL is all that is reported, and what a yes produces is a NEW `sdt_`
	// token minted through the control plane — the app's session is never handed over, and
	// none of these three functions can reach one.
	machine: () => hostname(),
	account: () => authStore.state().user?.email ?? null,
	signInHandoff: () => mcpStore.signInHandoff(),
	mintCliToken: (request) => mintCliToken({
		account: () => authStore.state().user?.email ?? null,
		machine: () => hostname(),
		ask: requestCliSignIn,
		mint: (name) => liveCloudApi.mintToken(name),
		nextId: () => `cli-${++agentCallSeq}`,
	}, request),
});

// The Agent Console: the user's OWN coding agent (Claude Code)
// run inside the app, one singleton console per agent kind, pointed at the broker above. The agent
// is handed capabilities, never credentials: its environment is an allow-list that carries no
// secret, and the config written for it names our localhost endpoint and nothing else.
const agentConsoleStore = new AgentConsoleStore(app.getPath('userData'));

/**
 * Replace the broker's token, only ever because the person asked (Settings, or the notice after a
 * lockout or a taken port), and rewrite the config file the coding agents were handed so their next
 * start has the new one. A guess at the old token is moot now, so any lockout is lifted.
 */
function rotateMcpToken(): void {
	mcpStore.regenerateToken();
	mcpServer.clearLockouts();
	rewriteAgentConfigFile();
}

function rewriteAgentConfigFile(): void {
	try {
		rewriteAgentMcpConfig(app.getPath('userData'), agentMcpEndpoint());
	} catch (err) {
		console.error(`[mcp] could not rewrite the agent config: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** The configured port was taken when the broker last tried to start (null: it was not). */
let mcpPortTaken: { port: number; suggestedPort: number | null } | null = null;

/**
 * Move the broker to another port, because the person chose to after the configured one was taken.
 * The token is replaced too (whatever took the old port may have been waiting for it), and the
 * agent console's config is rewritten with the new address once the broker listens there.
 */
async function moveMcpPort(port: number): Promise<void> {
	if (!Number.isInteger(port) || port < 1024 || port > 65535) {
		throw new Error("Choose a port between 1024 and 65535.");
	}
	if (!(await loopbackPortFree(port))) {
		throw new Error(`Port ${port} is in use too. Choose another.`);
	}
	await mcpServer.stop();
	mcpStore.setPort(port);
	mcpStore.regenerateToken();
	mcpServer.clearLockouts();
	mcpPortTaken = null;
	await startMcpIfEnabled();
	rewriteAgentConfigFile();
}

/** The local MCP endpoint to hand an agent, or null when agent access is off or not listening. */
function agentMcpEndpoint(): { url: string; token: string } | null {
	if (!mcpStore.isEnabled() || !mcpServer.running()) {
		return null;
	}
	return { url: `http://127.0.0.1:${mcpStore.port()}/mcp`, token: mcpStore.token() };
}

const agentConsole = new AgentConsole({
	// The workspace root, never userData: the agent works where the user's .sql scripts live.
	cwd: () => workspaceStore.root(),
	mcp: agentMcpEndpoint,
	// Rewritten on every start, so a regenerated token or a moved port is picked up with no
	// action from the user.
	extraArgs: (kind) => writeAgentConfig(kind, app.getPath('userData'), agentMcpEndpoint(), {
		routeDatabaseThroughApp: agentConsoleStore.routesDatabaseThroughApp(),
	}),
	enabled: (kind) => agentConsoleStore.isEnabled(kind),
	decided: (kind) => agentConsoleStore.hasDecided(kind),
	// A GUI launch does not inherit the user's PATH (macOS gives an app started by launchd four
	// directories), so their agents are neither findable nor runnable down the one we were given.
	// Resolved once, lazily, inside the deferred discovery sweep: see src/main/loginPath.ts.
	userPath: () => resolveUserPath({ platform: process.platform, env: process.env }),
	// The failsafe for a machine we cannot work out: the user points us at the binary themselves
	// (Settings, Coding agents, "Locate it"), and that answer beats anything on PATH.
	pinnedPath: (kind) => agentConsoleStore.pinnedPath(kind),
	// The first sighting of an agent turns it on, so it appears on the activity bar the moment the
	// user has one, whether that is at first launch or after installing it months later. A user who
	// switched it off is never overridden: see AgentConsoleStore.noteDetected.
	noteDetected: (kind, now) => {
		const first = agentConsoleStore.noteDetected(kind, now);
		if (first) {
			broadcast('agentConsole:changed');
		}
		return first;
	},
});
agentConsole.onData((kind, data, seq) => broadcast('agentConsole:data', { kind, data, seq }));
agentConsole.onExit((exit) => broadcast('agentConsole:exit', exit));

/** Bring a connection live if it isn't already (the MCP path connects on demand). */
async function ensureConnected(id: string): Promise<void> {
	if (!connections.state().connectedIds.includes(id)) {
		await connections.connect(id);
	}
}

// Monitors (live DB monitors). Definitions in JSON, trend samples
// in SQLite. The poller runs trend widgets in the background (connecting on demand, like MCP) and
// broadcasts each tick; it's started DEFERRED off the boot path (did-finish-load below).
const monitorStore = new MonitorStore(app.getPath('userData'));

// Moving a database. The spec lives here, not in the view, so the assistant
// and a coding agent edit the document the screen shows. Checks read both databases at
// background priority and never touch query history.
const moveStore = new MoveStore(join(app.getPath('userData'), 'moves.json'));
const moveRunStore = new MoveRunStore(app.getPath('userData'));
const moveHost: MoveHost = {
	connections: () => connections.state().connections,
	ensureConnected,
	execute: (id, sql) => connections.execute(id, sql, false, false, 'background'),
	toolMajor: () => pgToolsMajor(pgTools()),
};
function pgTools(): string | null {
	return pgToolsDir(componentStore.pgToolsBin());
}
// Running one. Progress goes to every window; the tools are stopped on quit,
// because a spawned pg_restore outlives the app on Windows.
const moveRuns = new MoveRuns({
	...moveHost,
	resolved: (id) => connections.resolvedConfig(id),
	copyForDatabase: (id, database) => connections.copyForDatabase(id, database),
	saveConnection: (values) => connections.save(values),
	cloud: liveCloudApi,
	toolsDir: pgTools,
	record: (run) => moveRunStore.record(run),
	recoverInterrupted: () => {
		moveRunStore.recoverInterrupted(new Date().toISOString());
	},
	onProgress: (progress) => broadcast('moves:progress', progress),
	onFinished: (result) => broadcast('moves:finished', result),
});
app.on('will-quit', () => {
	moveRuns.cancelAll();
	moveRunStore.close();
});
/** The driver of a saved connection, for the dialect a monitor's read-only check reads by. */
function monitorDriverFor(id: string): string | undefined {
	return readConnections().find((entry) => entry.id === id)?.driver;
}
/** The flavor of a saved connection (TiDB on `mysql-aurora`), for the same check. */
function monitorFlavorFor(id: string): string | undefined {
	return readConnections().find((entry) => entry.id === id)?.flavor;
}
const monitorPoller = new MonitorPoller(
	monitorStore,
	// Forward EVERY argument: dropping `priority` here silently sent the poller's 'background'
	// queries down the interactive path, leaving backgroundGate dead code on its only caller.
	// executeRead, never execute: a widget only ever reads, and the database is asked to hold it to that.
	{
		executeRead: async (id, sql, recordHistory, priority) => { await ensureConnected(id); return connections.executeRead(id, sql, recordHistory, priority); },
		driverFor: monitorDriverFor,
		flavorFor: monitorFlavorFor,
	},
	(widgetId, samples) => broadcast('monitor:sample', widgetId, samples),
	(widgetId, error) => broadcast('monitor:status', widgetId, error),
	() => broadcast('monitors:changed'),
);

// Orbit's Pulse 3b sampler: the database's OWN activity, read from
// pg_stat_activity and friends. Constructed INERT. Unlike the monitor poller there is no
// `.start()` after first paint and no call anywhere on the boot path: it does nothing at all until
// an open Orbit tab asks for a connection by name, and closing that tab stops it again. It also
// deliberately does NOT connect on demand (the monitor poller does), because dialling out to a
// database the user may pay for by the read, on the strength of a 3D tab being open, is not a
// decision to take on their behalf.
const orbitPulse = new OrbitPulseSampler(
	{
		execute: (id, sql, recordHistory, allowAiTranscribe, priority) => connections.execute(id, sql, recordHistory, allowAiTranscribe, priority),
		driverFor: (id) => connections.state().connections.find((entry) => entry.id === id)?.driver,
	},
	(connectionId, samples) => broadcast('orbit:pulse', connectionId, samples),
	(connectionId, error) => broadcast('orbit:pulseStatus', connectionId, error),
);

// Buckets a flow can read from. Deliberately NOT a
// connection: `ConnectionConfig` is database-shaped, and a bucket expressed as one would turn up in
// the connections tree, the schema explorer, the editor's picker and the MCP broker, in every one of
// which it is wrong. This is the `tunnelStore` shape instead — a small named profile, referenced by
// id, with its secret in the keychain and nothing secret in its file.
const cloudService = new CloudService(new CloudStore(app.getPath('userData')), secretStore, (params) => sqlServer.verifyCloudAccount(params));
// A telemetry connection (CloudWatch / Azure Monitor / Cloud Logging) authenticates as one of these
// accounts rather than carrying credentials of its own — the account is the VENDOR's and is shared
// with Data Flows, which is the whole point.
connections.setCloudAccounts((accountId) => {
	const account = cloudService.get(accountId);
	return account ? { account, secret: cloudService.secretFor(accountId) } : undefined;
});



/** Start the MCP server if the user has enabled it; persist the actually-bound port. No-op if
 *  already running or disabled. Kept off the boot path (called after the window finishes loading). */
async function startMcpIfEnabled(): Promise<void> {
	if (!mcpStore.isEnabled() || mcpServer.running()) {
		return;
	}
	const port = mcpStore.port();
	try {
		await mcpServer.start(port);
		mcpPortTaken = null;
	} catch (err) {
		if (err instanceof McpPortInUseError) {
			// Not moved: the clients keep dialling this port with the token. The person is told and
			// offered another port, which replaces the token too (moveMcpPort).
			mcpPortTaken = { port, suggestedPort: await nextFreeLoopbackPort(port).catch(() => null) };
			console.warn(`[mcp] port ${port} is in use by another program; agent access did not start`);
			broadcast('mcp:changed');
			return;
		}
		console.error(`[mcp] failed to start: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Apply the saved network-proxy config to the default session (the one net.fetch uses). System
 *  mode mirrors the browser; manual/direct override it for a corporate network where auto-resolution
 *  doesn't reach the proxy. Fire-and-forget; never gates first paint. See proxyStore.ts. */
async function applyProxy(): Promise<void> {
	try {
		await session.defaultSession.setProxy(proxyStore.sessionConfig());
	} catch (err) {
		console.error(`[proxy] failed to apply: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Status the Settings → Network panel renders: the saved config plus what Chromium resolved for a
 *  representative HTTPS URL (a quick "is a proxy in the chain" diagnostic). */
async function proxyStatus(): Promise<ProxyStatus> {
	let resolved: string | null = null;
	try {
		const proxies = await session.defaultSession.resolveProxy(`https://${ACCOUNTS_HOST}`);
		resolved = proxies || null;
	} catch {
		resolved = null;
	}
	return { config: proxyStore.config(), resolved };
}

/** Ping the hosts that fail first on a blocking corporate network, through the current proxy config,
 *  so the user can see whether their proxy settings actually let the app reach them. "Reachable"
 *  means we got any HTTP response (even a 401) — only a connectivity failure counts as blocked. */
async function proxyTest(): Promise<ProxyTestResult> {
	const probes: Array<{ label: string; host: string; url: string }> = [
		{ label: 'Sign-in service', host: ACCOUNTS_HOST, url: ACCOUNTS_HEALTH_URL },
		{ label: 'AI service', host: 'api.snoutdata.com', url: 'https://api.snoutdata.com/health' },
	];
	const targets: ProxyTestTarget[] = await Promise.all(
		probes.map(async (p): Promise<ProxyTestTarget> => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 8000);
			try {
				await netFetch(p.url, { signal: controller.signal });
				return { label: p.label, host: p.host, ok: true, detail: '' };
			} catch (err) {
				// Any HTTP response throws nowhere above; a thrown value here is a connectivity failure
				// (or our own abort/timeout). Surface the net::ERR_* so the user/IT can act on it.
				const aborted = err instanceof Error && err.name === 'AbortError';
				const blocked = aborted || isNetworkError(err);
				const detail = aborted ? 'net::ERR_TIMED_OUT' : (networkErrorDetail(err, p.host).replace(/^\(|\)$/g, '') || 'unreachable');
				return { label: p.label, host: p.host, ok: !blocked, detail: blocked ? detail : '' };
			} finally {
				clearTimeout(timer);
			}
		}),
	);
	return { targets };
}

/** The full state the Settings panel renders (master switch, live server, connect snippet, allowlist). */
function mcpStatus(): McpStatus {
	const port = mcpStore.port();
	return {
		enabled: mcpStore.isEnabled(),
		running: mcpServer.running(),
		url: `http://127.0.0.1:${port}/mcp`,
		token: mcpStore.token(),
		port,
		problem: !mcpStore.isEnabled() ? null : mcpPortTaken && !mcpServer.running()
			? { kind: 'port-in-use' as const, ...mcpPortTaken }
			: (() => {
				const lockout = mcpServer.lockouts()[0];
				return lockout ? { kind: 'locked-out' as const, ...lockout } : null;
			})(),
		connections: connections.state().connections.map((c) => ({
			id: c.id, label: c.label, driver: c.driver, environment: c.environment, readOnly: c.readOnly, allowed: mcpStore.isAllowed(c.id), writes: mcpStore.isWriteAllowed(c.id),
			readOnlyBy: readOnlyEnforcementFor(c.driver, c.flavor).summary,
		})),
		signInHandoff: mcpStore.signInHandoff(),
	};
}

// Cloud-sync state (see runCloudSync); declared above authStore, whose onChange reads it.
let cloudSyncRun: Promise<void> | null = null;
/** False until the startup slot fires, so a restored session does not sync on the boot path. */
let cloudSyncArmed = false;
let cloudSyncUser: string | null = null;

// Accounts + soft feature-gating. Each change is broadcast to the renderer and re-gates AI
// logging in main (the audit recorder only runs for an entitled tier), so signing out or a
// downgrade stops recording immediately.
const authStore = new AuthStore(
	() => {
		const auth = authStore.state();
		broadcast('auth:changed', auth);
		aiService.setSignedIn(auth.user !== null);
		aiService.setAuditAllowed(auth.entitlements.aiLogging);
		aiService.setAgentAllowed(auth.entitlements.agentMode);
		aiService.setByokAllowed(auth.entitlements.byok);
		// A schedule saved while subscribed must stop running when the subscription lapses, and
		// start again when it comes back — the entitlement is checked on every sweep, this just
		// makes the change take effect now rather than at the next one.
		pro.entitlementsChanged();
		// Same for the tray, which says "schedule paused" for exactly this case.
		tray?.refresh();
		// Refresh the wallet→credits switch from the user's ai_preferences row so the routing
		// fallback honours it (off the boot path — this fires on auth changes, not first paint).
		// Signed out → false (AI pauses at the monthly limit rather than touching credits).
		// A sign-in (or a switch of account) brings that account's cloud databases in. Before the
		// startup slot has fired this is the session being restored, and that slot covers it.
		if (auth.user && auth.user.id !== cloudSyncUser && cloudSyncArmed) {
			void runCloudSync();
		}
		cloudSyncUser = auth.user?.id ?? null;
		if (auth.user) {
			void authStore.getCreditsEnabled().then((enabled) => aiService.setCreditsEnabled(enabled)).catch(() => undefined);
		} else {
			aiService.setCreditsEnabled(false);
		}
	},
	// On sign-in, store the user's minted gateway virtual key as the positron-cloud bearer and
	// the optional persistent top-up (credits) key; clear both on sign-out so chat falls back to
	// logged-out (no gateway access).
	(key, endUser, topupKey) => {
		aiSettingsStore.setGatewayKey(key, endUser);
		aiSettingsStore.setGatewayTopupKey(topupKey);
	},
	(message) => broadcast('auth:error', message),
);

// Data Flows, Studio's private half:
// its stores, runner, scheduler, model runtime and handlers are built by `registerMain` from the
// shell's services below, and the open-source build gets an inert one (packages/studio-pro-stub).
// Constructing it touches nothing on disk: every store in it opens lazily.
const pro = registerMain({
	secretStore,
	componentStore,
	connections,
	aiService,
	aiSettingsStore,
	authStore,
	cloudService,
	broadcast,
	mainWindow,
	runCommandInWindow,
	refreshTray: () => tray?.refresh(),
	proxyConfig: () => proxyStore.sessionConfig(),
	e2e: Boolean(e2eUserData),
});
// The reviewer's two LOCAL methods are served by Data Flows' reader models; a build without them has
// none, and the reviewer says so when one is chosen.
if (pro.localProse) {
	aiService.setLocalProse(pro.localProse);
}

// The e2e counterpart of the renderer's `__snoutDebugAmbient` / `__snoutDebugCapability` hooks,
// for the parts of the app that run in main on their own clock, which a test cannot otherwise
// reach. A spec drives them through these hooks, and what they then do is the real thing.
// Installed ONLY under the e2e scratch profile, so a normal launch never defines it.
if (e2eUserData) {
	(globalThis as unknown as { __snoutE2E?: unknown }).__snoutE2E = {
		// Data Flows' own, from its main half (none in a build without it).
		...pro.e2eHooks,
		/**
		 * Answer every model call from a script, and treat the session as able to reach a model.
		 *
		 * The other thing a test cannot otherwise reach: a scratch profile has no account, and the
		 * assistant is account-only, so nothing AI-shaped runs in an e2e at all. The script is
		 * installed at the `ModelProvider` seam (`ai/scriptedProvider.ts`), so everything around
		 * the model — the prompt this build actually sends, the streaming, the audit record, the
		 * consent gate, the parser that refuses what it cannot use — is production code.
		 *
		 * `null` uninstalls it, which also puts the session back to signed out.
		 */
		setModelScript: (replies: ScriptedReply[] | null) => { aiService.installScriptedModel(replies); },
		/** Present a made-up account as signed in, so the account-gated UI (the assistant, the
		 *  account page) can be driven and photographed without a real one. Null signs out. */
		signInAs: (user: AuthUser | null, tier: Tier = 'plus') => { authStore.e2eSignIn(user, tier); },
		/** The model list and plan usage shown while the scripted model answers. */
		setScriptedAccount: (account: Parameters<AiService['installScriptedAccount']>[0]) => { aiService.installScriptedAccount(account); },
		/** What the scripted model was actually asked, so a spec can assert the prompt as SENT. */
		modelPrompts: () => aiService.scriptedPrompts(),
		/** The same question for inline completion, which sends the editor's text as a fill-in-the-
		 *  middle request rather than a chat prompt. */
		modelFim: () => aiService.scriptedFim(),
	};
}

// Cloud sync for non-secret app preferences (appearance/editor/query prefs, theme, layout),
// keyed to the signed-in user so a fresh machine picks up where the last one left off. The
// renderer drives pull/push; main just shuttles the opaque blob to the user's RLS-scoped row.
// An e2e profile never syncs (unless a spec asks with SNOUT_E2E_SETTINGS_SYNC=1): the signed-in
// test profile is a real account, and the settings a spec seeds (Liby hidden, onboarding off) were
// being pushed to it and pulled by every real installation on the next launch.
const settingsSyncOff = e2eUserData !== undefined && testEnv('SNOUT_E2E_SETTINGS_SYNC') !== '1';
const settingsSync = new SettingsSyncStore(() => (settingsSyncOff ? null : authStore.state().user?.id ?? null));

const SITE_URL = 'https://snoutdata.com';
const DOCS_URL = 'https://docs.snoutdata.com';

// Custom protocol the OAuth redirect comes back on (snoutdata://auth-callback). Allowlisted
// in the auth server's redirect allow list; registered with the OS below so the browser can hand the link back.
const AUTH_PROTOCOL = 'snoutdata';

// Funnel a snoutdata:// deep link (the OAuth redirect) into the auth store. Surfaced from a
// second instance's argv on Windows, or app's open-url on macOS.
function handleAuthDeepLink(url: string | undefined): void {
	if (!url || !url.startsWith(`${AUTH_PROTOCOL}://`)) {
		return;
	}
	void authStore.completeSignIn(url).catch((err) => {
		broadcast('auth:error', err instanceof Error ? err.message : String(err));
	});
}

// In-flight chat streams, keyed by requestId, so the renderer's Stop button can abort one.
const chatAborts = new Map<string, AbortController>();

// Pending run_query / capability approvals, keyed `${requestId}:${callId}`. The agent loop
// awaits the resolver here; the renderer settles it via ai:approvalReply (or an abort settles
// false).
const pendingApprovals = new Map<string, (approved: boolean) => void>();

// Pending renderer-capability invocations, keyed `${requestId}:${callId}`. The agent loop awaits
// the resolver; the renderer runs the capability and settles it via ai:capabilityReply (or an
// abort settles a cancelled result).
const pendingCapabilities = new Map<string, (result: CapabilityResult) => void>();

// The app capabilities the renderer has published. The chat
// path passes its manifest per request; the MCP path has no request to hang it off, so main keeps
// a standing copy and the broker turns it into tools.
let publishedCapabilities: CapabilitySpec[] = [];

// Capability calls an agent has in flight, so the status bar can say the app is being driven.
const agentActing = new Set<string>();

// Agent-initiated capability calls, numbered so each has its own reply key.
let agentCallSeq = 0;
/** How long an agent's app action may sit unanswered before it is failed. A renderer that never
 *  replies (a modal, a crash, a window closed mid-call) must not hang the agent forever. */
const AGENT_CAPABILITY_TIMEOUT_MS = 60_000;

/**
 * The sentence the consent card shows. A capability's `description` is written FOR A MODEL and
 * frequently instructs it ("Do NOT use this to obtain data for your own use..."), which is noise on
 * a card a person has to answer quickly. Prefer an explicit consentLabel; otherwise take the first
 * sentence and cap it, so the card stays a question rather than a paragraph.
 */
function consentSentence(spec: CapabilitySpec): string {
	if (spec.consentLabel) {
		return spec.consentLabel;
	}
	const first = /^(.*?[.!?])(\s|$)/.exec(spec.description.trim())?.[1] ?? spec.description.trim();
	return first.length > 160 ? `${first.slice(0, 157)}...` : first;
}

/**
 * The user said no to turning app changes on, this run. Held in memory on purpose: it should lapse
 * on a restart (a stored "never" is a setting, and the setting for this is the switch itself), and
 * it is irrelevant the moment they turn the feature on themselves.
 */
let appChangesRefusedThisSession = false;

/** What an agent is told when it may not change the app. Written for the agent to relay: it says
 *  what is off, who can turn it on, and where, so the reply the user reads is actionable. */
const APP_CHANGES_OFF_MESSAGE = 'Refused: app changes by agents are switched off, and the user declined to turn them on. They can turn them on themselves in SnoutData, Settings, Agent access.';

// Pending agent action approvals, keyed by callId. Separate from the chat loop's approvals: those
// live inside a chat turn and are cancelled with it, while these belong to no conversation.
const pendingAgentApprovals = new Map<string, (answer: AgentApproval) => void>();

/**
 * Ask the user to approve one app-changing action an external agent wants to take. The assistant
 * asks inside its chat turn; an agent has no turn, so the question arrives on its own.
 *
 * Timing out DECLINES, and so does having no window: an unanswered question is not consent.
 */
function requestAgentApproval(spec: CapabilitySpec, client: string, turnsOnAppChanges: boolean, detail: AgentActionDetail = {}): Promise<AgentApproval> {
	const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	if (!target || target.webContents.isDestroyed()) {
		return Promise.resolve('decline');
	}
	const callId = `approve-${++agentCallSeq}`;
	return new Promise<AgentApproval>((resolve) => {
		const settle = (answer: AgentApproval): void => {
			if (pendingAgentApprovals.delete(callId)) {
				resolve(answer);
			}
		};
		const timer = setTimeout(() => settle('decline'), AGENT_ACTION_TIMEOUT_MS);
		timer.unref?.();
		pendingAgentApprovals.set(callId, (answer) => {
			clearTimeout(timer);
			resolve(answer);
		});
		const request: AgentActionRequest = {
			callId,
			name: spec.name,
			title: capabilityTitle(spec),
			description: consentSentence(spec),
			client,
			timeoutMs: AGENT_ACTION_TIMEOUT_MS,
			turnsOnAppChanges,
			changes: detail.changes,
			note: detail.note,
			allowAlways: !detail.askEveryTime,
		};
		target.webContents.send('agent:approvalRequest', request);
	});
}

// Pending sign-in handoff prompts, keyed by requestId. Separate from the agent-action approvals
// above: those are about the APP (open a tab, change a setting) and this is about the ACCOUNT, and
// conflating the two would let a standing yes for one become a standing yes for the other.
const pendingCliSignIns = new Map<string, (answer: CliSignInOutcome) => void>();

/**
 * Ask the person at this computer whether a local program may have a credential of its own.
 *
 * There is deliberately no "always allow" here, and there will not be one. An agent action repeats
 * dozens of times in a task, which is what earned that button; minting a credential happens once
 * per machine per tool, so a standing yes would buy nothing and cost the only moment a person ever
 * sees this happen.
 *
 * Timing out DECLINES, and so does having no window: an unanswered question is not consent. Both
 * are reported as themselves rather than as a no, because a caller can offer to try again after a
 * timeout and should not after a refusal.
 */
function requestCliSignIn(request: CliSignInRequest): Promise<CliSignInOutcome> {
	const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	if (!target || target.webContents.isDestroyed()) {
		return Promise.resolve('unavailable');
	}
	return new Promise<CliSignInOutcome>((resolve) => {
		const settle = (answer: CliSignInOutcome): void => {
			if (pendingCliSignIns.delete(request.requestId)) {
				resolve(answer);
			}
		};
		const timer = setTimeout(() => settle('timeout'), request.timeoutMs);
		timer.unref?.();
		pendingCliSignIns.set(request.requestId, (answer) => {
			clearTimeout(timer);
			resolve(answer);
		});
		// Bring the window forward: the person is looking at a terminal that is waiting on this, and
		// a prompt behind the window they are not in is a hang as far as they can tell.
		if (target.isMinimized()) {
			target.restore();
		}
		target.show();
		target.webContents.send('cli:signInRequest', request);
	});
}

/**
 * Run one app capability on behalf of an EXTERNAL agent (MCP), through the same
 * `ai:capabilityRequest` / `ai:capabilityReply` pair the assistant's own agent loop uses. One code
 * path, one audit trail, one place where "the app did something because a model asked" lives.
 *
 * Targets the focused window, falling back to the first one: with a singleton console and one main
 * window this is unambiguous, and a second window would make it a real decision rather than a
 * silent one.
 */
async function invokeAgentCapability(name: string, requested: Record<string, unknown>, client = 'an agent', expectConnections?: string[]): Promise<CapabilityResult> {
	// A monitor's query: only on a connection the user allowed agents to use, only a read, and pinned
	// to that connection before anyone is asked (monitorAgentGate.ts). Refused without a card.
	const gate = gateMonitorCall(name, requested, {
		connections: readConnections(),
		allowed: (id) => mcpStore.config().allow.includes(id),
		allowedWhere: 'SnoutData Studio, Settings, Agent access',
	});
	if (!gate.ok) {
		return { ok: false, summary: '', error: gate.error, refused: true };
	}
	const args = gate.arguments;
	// Anything that changes the app is approved one call at a time, even with the switch on. The
	// switch says "you may ask"; it does not say yes on the user's behalf.
	//
	// The one exception is a capability the user has ALREADY answered "always allow" for. That is
	// still their answer, given on this exact action, and revocable in Settings; what it removes is
	// being asked the same question forty times in one task.
	//
	// A call whose spec is not published (the window still loading its actions) is refused rather
	// than run: nothing says it only reads.
	const spec = publishedCapabilities.find((s) => s.name === name);
	const detail = spec?.mutates ? agentActionDetail(spec, args, readConnections, readTunnels) : {};
	const approval = agentCallGate(spec, detail, agentConsoleStore.isAutoApproved(name));
	if (approval.kind === 'refuse') {
		return { ok: false, summary: '', error: approval.error, refused: true };
	}
	if (spec && approval.kind === 'ask') {
		// With app changes switched OFF, the call used to be refused outright and the agent was told
		// to send the user to Settings. Nobody opens Settings to browse a list of things they did not
		// know existed, so in practice the feature was discoverable only to whoever already knew
		// about it. An agent may now ASK, and the same card carries the bigger question.
		const off = !agentConsoleStore.allowsMutatingCapabilities();
		if (off && appChangesRefusedThisSession) {
			return { ok: false, summary: '', error: APP_CHANGES_OFF_MESSAGE, refused: true };
		}
		const asked = await requestAgentApproval(spec, client, off, detail);
		// The card did not offer "always" for this call, so an answer of it is a once.
		const answer: AgentApproval = asked === 'always' && detail.askEveryTime ? 'once' : asked;
		if (answer === 'decline') {
			// A no while the feature is off means "stop asking", not "ask me again next call". The
			// switch being off is otherwise the only thing standing between a connected agent and an
			// unlimited supply of prompts, and prompt fatigue is how people learn to click Allow.
			if (off) {
				appChangesRefusedThisSession = true;
			}
			return { ok: false, summary: '', error: off ? APP_CHANGES_OFF_MESSAGE : 'The user declined that action.', refused: true };
		}
		if (off) {
			// Saying yes to the action is saying yes to the feature: the card said so.
			agentConsoleStore.setAllowMutatingCapabilities(true);
		}
		if (answer === 'always') {
			agentConsoleStore.setAutoApproved(name, true);
		}
		if (off || answer === 'always') {
			broadcast('agentConsole:changed');
		}
	}
	return sendAgentCapability(name, args, client, expectConnections ? { expectConnections } : {});
}

/**
 * Send one invocation to the window. `scope.resolveConnections` asks only which connections it
 * would act on (nothing runs, so nothing is shown as the agent acting); `scope.expectConnections`
 * pins the run to the connections main checked.
 */
function sendAgentCapability(name: string, args: Record<string, unknown>, client?: string, scope: Pick<CapabilityInvocation, 'resolveConnections' | 'expectConnections'> = {}): Promise<CapabilityResult> {
	const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	if (!target || target.webContents.isDestroyed()) {
		return Promise.resolve({ ok: false, summary: '', error: 'The app window is not open, so there is nothing to act on.' });
	}
	const callId = `agent-${++agentCallSeq}`;
	const key = `mcp:${callId}`;
	// Say out loud that something other than the user is driving. An app that moves on its own with
	// no visible cause is the uncanny half of this feature.
	const acting = scope.resolveConnections !== true;
	if (acting) {
		agentActing.add(callId);
		broadcast('agent:acting', { acting: true, name });
	}
	const done = (): void => {
		if (!acting) {
			return;
		}
		agentActing.delete(callId);
		if (agentActing.size === 0) {
			broadcast('agent:acting', { acting: false });
		}
	};
	return new Promise<CapabilityResult>((resolve) => {
		const timer = setTimeout(() => {
			if (pendingCapabilities.delete(key)) {
				done();
				resolve({ ok: false, summary: '', error: 'The app did not answer in time.' });
			}
		}, AGENT_CAPABILITY_TIMEOUT_MS);
		timer.unref?.();
		pendingCapabilities.set(key, (result) => {
			clearTimeout(timer);
			done();
			resolve(result);
		});
		const invocation: CapabilityInvocation = { id: callId, name, arguments: args, client, ...scope };
		target.webContents.send('ai:capabilityRequest', { requestId: 'mcp', invocation });
	});
}

// Set true once the user confirms quitting in the renderer's themed dialog, so the window's
// close handler lets the following close through instead of re-prompting.
let allowQuit = false;
// Set true while an auto-update install is in flight. On macOS the bundle swap + relaunch is
// driven by Squirrel.Mac/ShipIt; if our own window-all-closed -> app.quit() races that, the
// app terminates through our path before Squirrel can launch ShipIt and the update silently
// never applies. While this is set we step back and let the updater drive the quit.
let installingUpdate = false;

// The app lives in the tray now (src/main/tray.ts, which carries the reasoning). Closing the
// window HIDES it; schedules, pollers and background runs go on running behind the icon, and
// quitting is a deliberate act from the tray, the app menu or Ctrl/Cmd+Q. Created after the
// window has painted, never on the boot path.
let tray: AppTray | undefined;


// ── The Dashboard's projects, for the tray ──────────────────────────────────────────────────
// The tray's Dashboard submenu lists the same local and cloud projects as the panel, from the
// LAST reading of each: a menu rebuild runs often and must never run `docker ps` or call the
// control plane. A reading is remembered whenever the panel asks (`local:list`, `cloud:projects`),
// once when the tray starts, after anything the tray asked of a project, and when the menu closes
// (throttled), so the next opening is current.

/** The service behind the Local group, set by registerIpc, which owns it. */
let localStackForTray: LocalStackService | undefined;
let trayLocalProjects: LocalProjectRow[] = [];
let trayCloudProjects: CloudProjectRow[] = [];
/** Projects (by projectKey) the tray has a start, stop, pause or resume in flight for. */
const trayProjectsBusy = new Set<string>();
let trayProjectsRead: Promise<void> | null = null;
let trayProjectsReadAt = 0;
/** The least time between two readings asked for by closing the menu. */
const TRAY_PROJECTS_MIN_MS = 30_000;

function rememberLocalProjects(view: LocalProjectsView): LocalProjectsView {
	trayLocalProjects = view.projects;
	tray?.refresh();
	return view;
}

function rememberCloudProjects(view: CloudProjectsView): CloudProjectsView {
	trayCloudProjects = view.account ? view.projects : [];
	tray?.refresh();
	return view;
}

/** Read both groups again for the tray. Free for somebody with neither: an empty local registry
 *  never reaches docker, and a signed-out user never reaches the control plane. */
function readProjectsForTray(): Promise<void> {
	if (!tray?.available()) {
		return Promise.resolve();
	}
	trayProjectsRead ??= Promise.allSettled([
		localStackForTray?.list().then(rememberLocalProjects),
		authStore.state().user ? cloudProjectsView(liveCloudApi).then(rememberCloudProjects) : Promise.resolve(),
	])
		.then(() => { trayProjectsReadAt = Date.now(); })
		.finally(() => { trayProjectsRead = null; });
	return trayProjectsRead;
}

/** Start/stop a local project, or pause/resume a cloud one, because the tray asked. Nobody may be
 *  watching, so a refusal or a failure is posted as a desktop notification, the way a failed
 *  scheduled run is. */
async function runProjectActionFromTray(target: ProjectTarget, verb: TrayProjectVerb): Promise<void> {
	const key = projectKey(target);
	if (trayProjectsBusy.has(key)) {
		return;
	}
	trayProjectsBusy.add(key);
	tray?.refresh();
	let outcome: { ok: boolean; message: string };
	try {
		if (target.kind === 'local') {
			if (!localStackForTray) {
				return;
			}
			outcome = verb === 'start'
				? await localStackForTray.start(target.id, (progress) => broadcast('local:progress', progress))
				: await localStackForTray.stop(target.id);
			// The panel re-reads on a finished step; a stop reports none of its own, so say it here.
			if (verb === 'stop') {
				broadcast('local:progress', { installId: target.id, step: outcome.ok ? 'done' : 'failed', message: outcome.message } satisfies LocalProgress);
			}
		} else {
			outcome = await askCloudProject(liveCloudApi, verb === 'pause' ? 'pause' : 'resume', target.ref, closeCloudConnections);
		}
	} catch (err) {
		outcome = { ok: false, message: err instanceof Error ? err.message : String(err) };
	} finally {
		trayProjectsBusy.delete(key);
	}
	if (!outcome.ok) {
		notifyProjectOutside(outcome.message);
	}
	await readProjectsForTray();
	// A cloud pause or resume is ASKED, and the host agent acts on its next tick, so the reading
	// just taken still says "pausing". Look again once it has had time to finish.
	if (target.kind === 'cloud' && outcome.ok) {
		setTimeout(() => { void readProjectsForTray(); }, 20_000).unref();
	}
}

function notifyProjectOutside(message: string): void {
	console.error(`[tray] project action failed: ${message}`);
	if (!Notification.isSupported()) {
		return;
	}
	try {
		const notification = new Notification({ title: "SnoutData Studio", body: message });
		notification.on('click', () => runCommandInWindow('dashboardView'));
		notification.show();
	} catch (err) {
		console.error(`[tray] could not post a desktop notification: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Set once teardown() has run, so the second caller is a no-op rather than a double stop. */
let tornDown = false;

/**
 * Everything that must not outlive this process: the tray icon, the two long-lived children (the
 * SQL server and the model runtime, which holds a GPU), the coding agents, the batched audit
 * writes and any flow run's ledger row.
 *
 * This used to live inside `window-all-closed`, which only fires once every window has actually
 * closed. That is too late for an update: the Windows installer's first move is a graceful
 * `taskkill` (a WM_CLOSE to our windows), and since the tray landed a WM_CLOSE HIDES the window
 * instead of quitting, so the installer force-kills us a second later. A force-kill runs none of
 * this: the tray icon is left as a ghost in the notification area, and the SQL server, any
 * other child process and any agent are orphaned still holding files under the install directory,
 * which is exactly what stops the new version replacing the old one. So the update path calls
 * this FIRST and does not depend on the window closing at all. Idempotent, because both paths can reach it.
 */
function teardown(): void {
	if (tornDown) {
		return;
	}
	tornDown = true;
	// The icon goes with the app: a tray left behind keeps the process alive with nothing to
	// show for it, and a tray left behind by a KILLED process is a ghost the user has to mouse
	// over before Windows notices it is gone.
	tray?.destroy();
	tray = undefined;
	sqlServer.stop();
	// A coding agent must never outlive the app that hosts it: it spawns its own children and
	// an orphaned one keeps working (and spending) with no window to show for it.
	agentConsole.stopAll();
	// Orbit's activity samplers query someone's database every couple of seconds; nothing should
	// still be doing that while the app is on its way out.
	orbitPulse.stopAll();
	// Audit appends are batched (see AuditStore.scheduleFlush), so force the last ones out
	// before we exit — otherwise a quit within a second of an action loses that record.
	auditStore.flush();
	// Data Flows' half: its model runtime (the app's other long-lived child, and the one holding a
	// GPU) and its run ledger, so a run in flight shows "cancelled" rather than three days running.
	pro.shutdown();
}

/**
 * "Restart & Update", from the toast or from the tray. Both used to set the two flags and call
 * straight into the updater, leaving the shutdown to whatever order the window close happened to
 * take; now the app is torn down deliberately before the installer is spawned, so the installer
 * finds no icon, no children and no held files whether or not our own quit wins the race with its
 * kill. `installingUpdate` still stops `window-all-closed` calling app.quit(), which on macOS
 * races Squirrel.Mac's install-and-relaunch.
 */
/** The tray's own install: nobody clicked anything, so the new version comes back hidden, where
 *  this one was (relaunchHidden.ts), and the Windows installer runs silently. */
function installUpdateInBackground(): void {
	installingUpdate = true;
	allowQuit = true;
	logUpdate('tray install: idle in the tray with an update downloaded -> teardown() then a background install');
	writeRelaunchHidden(app.getPath('userData'));
	teardown();
	updater.quitAndInstall(true);
}

function installUpdateNow(source: string): void {
	installingUpdate = true;
	allowQuit = true;
	logUpdate(`${source}: Restart & Update -> teardown() then updater.quitAndInstall()`);
	teardown();
	updater.quitAndInstall();
}

/**
 * Whether scheduled flows are paused (the tray's Pause, the Data Flows panel's Resume).
 *
 * Deliberately NOT persisted: it is the "not right now" of somebody on a call or on battery, and a
 * pause that quietly survived a restart would be a schedule that silently never runs again. A
 * launch always starts scheduling.
 */
let schedulesPaused = false;

function setSchedulesPaused(paused: boolean): void {
	if (paused === schedulesPaused) {
		return;
	}
	schedulesPaused = paused;
	// Data Flows stops or restarts its scheduler and tells its panel.
	pro.setSchedulesPaused(paused);
	tray?.refresh();
}

// Accelerator hints shown in the app menu, keyed by command id. Rebuilt from the keybinding
// store on each buildMenu() so a rebind updates the menu hint. Display-only (see cmd below).
let menuAccelerators: Record<string, string> = {};

// An app-feature menu item: clicking it tells the renderer to run the command of that id
// (the same `commands` the palette uses). The accelerator is shown but NOT registered —
// the renderer/Monaco already own these keys, so registering here would double-fire; with
// registerAccelerator:false the menu just displays the hint and the in-app handler runs.
// The hint is derived from the keybinding store (menuAccelerators) unless one is passed
// explicitly (for the few menu keys that aren't user-rebindable commands).
function cmd(label: string, id: string, icon?: string, accelerator?: string): MenuItemConstructorOptions {
	// `id` is also what lets menuModel() below recover the command from the finished template,
	// so the drawn menu on a frameless window is generated from this one declaration rather than
	// from a second copy of the menu kept in the renderer.
	if (icon) {
		menuIcons.set(id, icon);
	}
	return { id, label, accelerator: accelerator ?? menuAccelerators[id], registerAccelerator: false, click: () => broadcast('menu:command', id) };
}

/**
 * Codicon per menu item, for the menu the title bar DRAWS (Windows, Linux). A native Electron menu
 * cannot show a font glyph, and macOS keeps its native bar, so this lives beside the template
 * rather than in it: `cmd` and `link` fill it from the one declaration, and `menuModel` reads it.
 */
const menuIcons = new Map<string, string>();

/** The Electron roles' icons, for the same drawn menu. */
const ROLE_ICONS: Record<string, string> = {
	undo: 'discard', redo: 'redo', copy: 'copy', paste: 'clippy', selectAll: 'list-selection',
	reload: 'refresh', toggleDevTools: 'tools', resetZoom: 'screen-normal', zoomIn: 'zoom-in', zoomOut: 'zoom-out',
	togglefullscreen: 'screen-full', quit: 'sign-out', close: 'close', minimize: 'chrome-minimize', zoom: 'chrome-maximize',
};

/** Pages the Help menu opens in the browser. */
const MENU_LINKS = { website: SITE_URL, docs: DOCS_URL, issues: ISSUES_URL } as const;

/**
 * A menu item that opens one of MENU_LINKS. Its id is `link:<key>`, which the drawn menu sends back
 * as a role (`app:menuRole`), because a renderer command cannot open a page outside the app. Before
 * this, the three Help links had neither a command nor a role and did nothing on Windows or Linux.
 */
function link(label: string, key: keyof typeof MENU_LINKS, icon: string): MenuItemConstructorOptions {
	const id = `link:${key}`;
	menuIcons.set(id, icon);
	return { id, label, click: () => { void openExternalIfAllowed(MENU_LINKS[key]); } };
}

/**
 * The custom title bar's height and its colour at boot.
 *
 * The colour is the Gold theme's `--bg-app`, the default theme's window ground: the window is
 * painted before the renderer has read the user's stored theme, and this is the value that is
 * right for most users and wrong by the least for the rest. The renderer corrects it on first
 * paint (app:setWindowChrome), so a Light user sees at most one frame of dark caption. The
 * height must match `--titlebar-h` in styles.css or the native buttons and the drawn strip
 * disagree by a few pixels.
 */
const TITLEBAR_HEIGHT = 34;
const TITLEBAR_BOOT_COLOR = '#050403';

// Replace Electron's default menu with one that keeps the standard roles (undo/copy/paste,
// reload/devtools/zoom, window, quit) AND surfaces the app's own features — file, query,
// view, and AI actions — each routed back to the renderer's command of the same id.
function buildMenu(): void {
	Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
}

/**
 * The menu, once, as an Electron template. `buildMenu` hands it to Electron; `menuModel` turns
 * it into data the renderer's own title bar draws on a frameless window.
 */
function menuTemplate(): MenuItemConstructorOptions[] {
	const isMac = process.platform === 'darwin';
	// Refresh the menu accelerator hints from the (possibly user-overridden) keybindings.
	menuAccelerators = Object.fromEntries(keybindingStore.resolved().map((b) => [b.id, toAccelerator(b.combo)]));
	const template: MenuItemConstructorOptions[] = [
		...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
		{
			label: "File",
			submenu: [
				cmd("New Query", 'new', 'new-file'),
				cmd("New Workspace File", 'newWorkspaceFile', 'file-add'),
				cmd("Open File…", 'open', 'folder-opened'),
				{ type: 'separator' },
				cmd("Save File", 'saveFile', 'save'),
				cmd("Save Query…", 'saveQuery', 'bookmark'),
				{ type: 'separator' },
				cmd("New Connection…", 'addConn', 'add'),
				cmd("Find Databases…", 'findDatabases', 'search'),
				{ type: 'separator' },
				cmd("Change Workspace Folder…", 'openWorkspaceFolder', 'folder'),
				cmd("Import Files to Workspace…", 'importWorkspaceFile', 'cloud-download'),
				{ type: 'separator' },
				cmd("Account…", 'account', 'account'),
				cmd("Settings…", 'settings', 'settings-gear'),
				{ type: 'separator' },
				cmd("Close Tab", 'closeTab', 'close'),
				{ type: 'separator' },
				isMac ? { role: 'close' } : { role: 'quit' },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: 'undo' },
				{ role: 'redo' },
				{ type: 'separator' },
				{ role: 'cut' },
				{ role: 'copy' },
				{ role: 'paste' },
				{ role: 'selectAll' },
				{ type: 'separator' },
				cmd("Format SQL", 'format', 'list-flat'),
			],
		},
		{
			label: "View",
			submenu: [
				cmd("Command Palette…", 'commandPalette', 'symbol-event'),
				{ type: 'separator' },
				cmd("Connections", 'connectionsView', 'database'),
				cmd("Workspace Files", 'workspaceView', 'folder'),
				cmd("Data Flows", 'flowsPanel', 'combine'),
				cmd("Query History & Saved", 'history', 'history'),
				cmd("Dashboard", 'dashboardView', 'glyph:dashboard'),
				cmd("Notifications", 'notifications', 'bell'),
				{ type: 'separator' },
				cmd("Toggle Sidebar", 'toggleSidebar', 'layout-sidebar-left'),
				cmd("Toggle Results Panel", 'toggleResults', 'layout-panel'),
				cmd("Switch Theme", 'theme', 'color-mode'),
				{ type: 'separator' },
				// Reload + dev tools are a development convenience (with their default
				// Ctrl+R / F12 accelerators); hide them and their shortcuts in packaged builds.
				...(app.isPackaged ? [] : [
					{ role: 'reload' } as MenuItemConstructorOptions,
					{ role: 'toggleDevTools' } as MenuItemConstructorOptions,
					{ type: 'separator' } as MenuItemConstructorOptions,
				]),
				{ role: 'resetZoom' },
				{ role: 'zoomIn' },
				{ role: 'zoomOut' },
				{ type: 'separator' },
				{ role: 'togglefullscreen' },
			],
		},
		{
			label: "Query",
			submenu: [
				cmd("Run Query", 'run', 'play'),
				cmd("Run in New Tab", 'runNewTab', 'empty-window'),
				cmd("Run as Script", 'runScript', 'run-all'),
				{ type: 'separator' },
				cmd("Query Performance…", 'queryPerformance', 'pulse'),
			],
		},
		{
			// Everything that moves data, which before this had no menu of its own: flows were on
			// File and the panel nowhere, and the Dashboard's projects were reachable only from the
			// activity bar and the palette.
			label: "Data",
			submenu: [
				cmd("New Data Flow…", 'newFlow', 'add'),
				cmd("Data Flows", 'flowsPanel', 'combine'),
				cmd("Import Data Flow…", 'importFlow', 'cloud-download'),
				cmd("Cloud Accounts…", 'cloudSettings', 'cloud'),
				{ type: 'separator' },
				cmd("Move Database…", 'moveDatabase', 'arrow-both'),
				{ type: 'separator' },
				cmd("Set Up a Local Project…", 'localSetup', 'vm'),
			],
		},
		{
			label: "AI",
			submenu: [
				cmd(`Toggle ${ASSISTANT_NAME}`, 'assistant', 'sparkle'),
				cmd(`Toggle ${ASSISTANT_NAME} Full Screen`, 'assistantFull', 'screen-full'),
				cmd("Fix Last Error", 'fixError', 'wand'),
				{ type: 'separator' },
				cmd("Complete at Cursor", 'aiComplete', 'lightbulb'),
				cmd("Edit / Generate (inline)", 'aiEdit', 'edit'),
				{ type: 'separator' },
				cmd("AI Settings…", 'aiSettings', 'settings-gear'),
				cmd("Data Generation Settings…", 'dataGenSettings', 'beaker'),
				cmd("AI Audit Log…", 'auditLog', 'checklist'),
			],
		},
		{
			label: "Tools",
			submenu: [
				cmd("Monitors…", 'monitors', 'graph-line'),
				cmd("Orbit: Map This Database in 3D", 'orbit', 'globe'),
				cmd("Sync Schema…", 'schemaSync', 'git-compare'),
				cmd("Users & Privileges…", 'security', 'shield'),
				{ type: 'separator' },
				cmd("ClickHouse Operations…", 'clickhouseOps', 'server-process'),
				cmd("ClickHouse Remote Data…", 'clickhouseRemote', 'cloud-download'),
				{ type: 'separator' },
				// Snoutbot, the pull-request reviewer. The same
				// three items the tray's submenu carries, in the same order, because they are the
				// same three things: read them, ask now, configure it. Unlike the tray line and the
				// activity-bar icon this is NOT gated on being set up: a menu is where somebody
				// looks for a feature they have not found yet, and the settings item is how they
				// find it.
				cmd("Snoutbot Reviews", 'reviews', 'git-pull-request'),
				cmd("Snoutbot: Check for New Pull Requests", 'snoutbotCheck', 'refresh'),
				cmd("Snoutbot Settings…", 'snoutbotSettings', 'settings-gear'),
			],
		},
		{ role: 'windowMenu' },
		{
			role: 'help',
			submenu: [
				cmd("Getting Started", 'gettingStarted', 'checklist'),
				cmd("Take a Quick Tour", 'startTour', 'compass'),
				{ type: 'separator' },
				link("Official Website", 'website', 'globe'),
				link("Documentation", 'docs', 'book'),
				link("Report an Issue", 'issues', 'issues'),
				{ type: 'separator' },
				cmd("Check for Updates…", 'checkUpdate', 'sync'),
				cmd("Release Notes", 'releaseNotes', 'note'),
				{ type: 'separator' },
				cmd("About SnoutData Studio", 'about', 'info'),
			],
		},
	];
	return template;
}

/**
 * The same menu, flattened for the renderer to draw (Windows/Linux, where the frameless window
 * has no native menu bar).
 *
 * `windowMenu` is expanded here rather than passed through: it is a macOS role that Electron
 * fills in itself, and macOS keeps its real menu bar, so the only consumers of this model need
 * the three items spelled out.
 */
function menuModel(): AppMenu[] {
	const out: AppMenu[] = [];
	for (const top of menuTemplate()) {
		if (top.role === 'appMenu') {
			continue;
		}
		if (top.role === 'windowMenu') {
			out.push({ label: "Window", items: [
				{ label: "Minimize", role: 'minimize', icon: ROLE_ICONS.minimize },
				// "Zoom" is the macOS word, and macOS keeps its native menu; here it maximizes and restores.
				{ label: "Maximize", role: 'zoom', icon: ROLE_ICONS.zoom },
				{ separator: true },
				{ label: "Close", role: 'close', icon: ROLE_ICONS.close },
			] });
			continue;
		}
		const submenu = Array.isArray(top.submenu) ? top.submenu : [];
		const items: AppMenuItem[] = submenu.map((item) => {
			if (item.type === 'separator') {
				return { separator: true };
			}
			const isLink = item.id?.startsWith('link:') ?? false;
			const role = item.role as string | undefined;
			return {
				label: item.label ?? roleLabel(String(role ?? '')),
				accelerator: typeof item.accelerator === 'string' ? item.accelerator : undefined,
				commandId: item.id && !isLink ? item.id : undefined,
				role: isLink ? item.id : (item.id ? undefined : role),
				icon: item.id ? menuIcons.get(item.id) : (role ? ROLE_ICONS[role] : undefined),
			};
		});
		// A top-level entry declared as a bare role ({ role: 'help' }) has no label of its own:
		// Electron names it. Name it here too, or the bar reads "help" in lower case next to File.
		out.push({ label: top.label ? String(top.label) : roleLabel(String(top.role ?? '')), items });
	}
	return out;
}

/** A readable label for a bare `{ role }` item, which Electron would otherwise name itself. */
function roleLabel(role: string): string {
	const named: Record<string, string> = {
		undo: "Undo", redo: "Redo", cut: "Cut", copy: "Copy", paste: "Paste", selectAll: "Select All",
		reload: "Reload", toggleDevTools: "Toggle Developer Tools", resetZoom: "Actual Size",
		zoomIn: "Zoom In", zoomOut: "Zoom Out", togglefullscreen: "Toggle Full Screen",
		quit: "Quit", close: "Close", minimize: "Minimize", zoom: "Zoom",
		help: "Help", fileMenu: "File", editMenu: "Edit", viewMenu: "View", windowMenu: "Window",
	};
	return named[role] ?? role;
}

// Background re-sync of the signed-in user's gateway entitlements (tier + the models their key
// can reach). Models are released server-side often, so we re-mint the key on a slow timer plus
// once shortly after startup, so users pick up new models without hitting "Refresh plan". The
// first run is deferred past the startup burst so it never slows the initial open, and the timers
// are unref'd so they never hold the process open. A no-op while signed out.
const ENTITLEMENT_RESYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 min — models change often, never urgently
const ENTITLEMENT_RESYNC_STARTUP_DELAY_MS = 8000; // settle after the renderer finishes loading
const AI_DEBUG_SERVER_DELAY_MS = 4000; // dev-only tuning endpoint: bind its port after first paint
const INSTALL_HEARTBEAT_DELAY_MS = 15000; // anonymous install ping: well after first paint, non-urgent
let entitlementResyncTimer: NodeJS.Timeout | null = null;

function startEntitlementResync(): void {
	if (entitlementResyncTimer) {
		return; // already running — a window reload/reopen must not stack timers
	}
	const tick = (): void => { void authStore.resyncEntitlements(); };
	setTimeout(tick, ENTITLEMENT_RESYNC_STARTUP_DELAY_MS).unref();
	entitlementResyncTimer = setInterval(tick, ENTITLEMENT_RESYNC_INTERVAL_MS);
	entitlementResyncTimer.unref();
}

// Cloud projects → connections (`cloudSync.ts`). Runs once past the startup burst, again on
// sign-in, and whenever the Cloud panel reads the list; never on the boot path. One run at a
// time: a sign-in landing during the startup run must not add the same project twice.

/** Save the given cloud projects as connections, through the import's own resolve, so each
 *  password is fetched and stored in main and never transits the renderer. */
async function addCloudConnections(refs: string[]): Promise<void> {
	const items = refs.map((ref) => ({ file: 'snoutdata-cloud', connId: ref }));
	for (const value of await resolveSnoutdataCloudImport(liveCloudApi, items, readConnections())) {
		await connections.save(value, { imported: true });
	}
}

/** Close this app's connections to a cloud project that was just paused: the front door wakes a
 *  paused project on connect, so a schema poll or a reconnecting pool would start it again. */
async function closeCloudConnections(ref: string): Promise<void> {
	for (const connection of readConnections().filter((c) => c.cloudProjectRef === ref)) {
		await connections.disconnect(connection.id).catch(() => undefined);
	}
}

function runCloudSync(): Promise<void> {
	cloudSyncRun ??= syncCloudConnections(liveCloudApi, readConnections(), seenCloudRefs, addCloudConnections)
		.then((result) => {
			if (result.account) {
				rememberCloudRefs(result.account, result.seen);
			}
		})
		.catch((err) => {
			// Offline or signed out mid-call: the next trigger tries again, and nothing is lost.
			console.warn(`[cloud] sync skipped: ${err instanceof Error ? err.message : String(err)}`);
		})
		.finally(() => { cloudSyncRun = null; });
	return cloudSyncRun;
}

/** The main window, or null when there is none (only true between a real quit and the process
 *  ending, or if the user's session somehow closed it for real). */
function mainWindow(): BrowserWindow | null {
	return BrowserWindow.getAllWindows()[0] ?? null;
}

/** Bring the window back: un-minimize, un-hide, focus, and create one if it is truly gone. */
function showMainWindow(): BrowserWindow {
	const win = mainWindow();
	if (!win) {
		createWindow();
		return mainWindow() as BrowserWindow;
	}
	if (win.isMinimized()) {
		win.restore();
	}
	win.show();
	win.focus();
	return win;
}

/** Show the window and run one of the renderer's commands in it (the ids the palette uses). A
 *  window that is still loading gets the command once it can act on it, rather than dropping it. */
function runCommandInWindow(commandId: string): void {
	const win = showMainWindow();
	if (win.webContents.isLoading()) {
		win.webContents.once('did-finish-load', () => win.webContents.send('menu:command', commandId));
		return;
	}
	win.webContents.send('menu:command', commandId);
}

/** Put the app in the tray. Deferred off the boot path like everything else that is not first
 *  paint; the window's close button already hides rather than quits, so the icon is what makes
 *  the app reachable again. */
function startTray(): void {
	if (tray) {
		return;
	}
	tray = new AppTray({
		show: () => { showMainWindow(); },
		state: () => {
			const auth = authStore.state();
			const connectionState = connections.state();
			return {
				// Scheduled and running flows, from Data Flows' main half.
				...pro.trayFlows(),
				paused: schedulesPaused,
				connections: connectionState.connections,
				connectedIds: new Set(connectionState.connectedIds),
				account: { email: auth.user?.email ?? null, tier: auth.tier, restoring: auth.restoring },
				update: updateStatus,
				review: reviewService.trayState(),
				projects: {
					local: trayLocalProjects,
					// Signed out is no cloud projects, whatever the last reading said.
					cloud: auth.user ? trayCloudProjects : [],
					busy: trayProjectsBusy,
				},
				now: Date.now(),
			};
		},
		runFlow: (flowId) => pro.runFromTray(flowId),
		setConnected: (connectionId, connected) => {
			// Connecting can fail (a VPN that is not up, a password that changed) and there is no
			// window to say so in, so it is logged and the menu simply does not change its dot.
			const work = connected ? connections.connect(connectionId) : connections.disconnect(connectionId);
			void Promise.resolve(work)
				.catch((err: unknown) => console.error(`[tray] ${connected ? 'connect' : 'disconnect'} failed: ${err instanceof Error ? err.message : String(err)}`))
				.finally(() => tray?.refresh());
		},
		setSchedulesPaused: (paused) => setSchedulesPaused(paused),
		openProject: (target, name) => runCommandInWindow(openProjectCommand(target, name)),
		projectAction: (target, verb) => { void runProjectActionFromTray(target, verb); },
		menuClosed: () => {
			if (Date.now() - trayProjectsReadAt >= TRAY_PROJECTS_MIN_MS) {
				void readProjectsForTray();
			}
		},
		// The same poll the Settings pane's "Check now" runs. A failure lands in the reviewer's own
		// lastError and is read back through the menu's next rebuild, so there is nothing to say
		// here that a tray with no window could say anyway.
		checkReviews: () => { void reviewService.pollNow(); },
		open: (commandId) => runCommandInWindow(commandId),
		openLink: (link) => { void openExternalIfAllowed(link === 'docs' ? DOCS_URL : SITE_URL); },
		update: (action) => {
			if (action === 'check') {
				updater.check();
				return;
			}
			if (action === 'download') {
				updater.download();
				return;
			}
			// Same path the toast's "Restart & Update" takes, including the flag that stops our own
			// quit racing Squirrel on macOS.
			installUpdateNow('tray');
		},
		quit: () => app.quit(),
	});
	tray.start();
	// startTray already runs off the boot path, so the first reading of the projects is too.
	void readProjectsForTray();
}

function createWindow(): void {
	// In a packaged app the OS uses the exe's embedded icon; this only dresses the dev
	// window/taskbar, where build/ sits two levels up from out/main. Guard so a missing
	// file is a no-op rather than a crash. Windows uses the .ico; macOS and Linux need the
	// PNG (an .ico is not a valid macOS/Linux image, so macOS would show the default
	// Electron icon instead).
	const devIcon = join(__dirname, '../../build/', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
	const hasIcon = existsSync(devIcon);
	// macOS ignores the BrowserWindow `icon` and dresses the dock from the app bundle, which
	// in dev is Electron's own bundle (so the dock shows "Electron"). Set the dock icon
	// explicitly. A packaged build gets the generated .icns, so this is dev-only in practice.
	if (hasIcon && process.platform === 'darwin' && app.dock) {
		app.dock.setIcon(nativeImage.createFromPath(devIcon));
	}
	// Default the native window chrome to dark so the title bar matches our dark
	// backgroundColor at boot; the renderer corrects this to the persisted theme on first
	// paint via app:setNativeTheme (so a "light" user sees at most a brief dark title bar).
	nativeTheme.themeSource = 'dark';
	const saved = readWindowSize();
	// The one launch right after an install from the tray comes back in the tray (relaunchHidden.ts).
	const startHidden = !e2eUserData && consumeRelaunchHidden(app.getPath('userData'));
	const win = new BrowserWindow({
		show: !startHidden,
		width: saved?.width ?? 1536,
		height: saved?.height ?? 960,
		title: "SnoutData Studio",
		backgroundColor: TITLEBAR_BOOT_COLOR,
		icon: hasIcon ? devIcon : undefined,
		/*
		 * The caption is ours. The native title bar takes
		 * only 'dark' or 'light' and so cannot follow a per-theme colour, which left every dark
		 * theme sharing one grey bar; and a generic OS caption above a themed app is the last
		 * piece of chrome we do not control.
		 *
		 * macOS keeps its traffic lights (`hiddenInset`) because they are a system affordance
		 * users reach for by position and muscle memory, and it keeps its real menu bar, which
		 * on macOS lives in the system bar rather than in the window. We only take the strip.
		 *
		 * Windows and Linux get the Window Controls Overlay: the buttons stay NATIVE, so snap
		 * layouts, hit-testing at the screen edge and per-monitor DPI all keep working, but we
		 * choose their colour. Drawing those three buttons in HTML would lose all of that for
		 * the sake of styling three glyphs. The colours are re-pushed on every theme change via
		 * app:setWindowChrome.
		 */
		...(process.platform === 'darwin'
			? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 10 } }
			: {
				titleBarStyle: 'hidden' as const,
				titleBarOverlay: { color: TITLEBAR_BOOT_COLOR, symbolColor: '#e9e4dc', height: TITLEBAR_HEIGHT },
			}),
		webPreferences: {
			preload: join(__dirname, '../preload/index.js'),
			contextIsolation: true,
			nodeIntegration: false,
			// The preload needs nothing a sandboxed one lacks: it is one CommonJS file that
			// requires only `electron` (contextBridge, ipcRenderer, webUtils) and reads
			// process.env, which a sandboxed preload still has.
			sandbox: true,
		},
	});
	// The window shows the app page and nothing else; a link opens in the system browser.
	guardAppWindow(win.webContents, APP_PAGE_URL);
	if (saved?.maximized && !startHidden) {
		win.maximize();
	}

	// Remember the size on close. getNormalBounds() gives the un-maximized size even when
	// the window is currently maximized, so we restore to a sensible size next launch.
	allowQuit = false;
	// When the user comes back to the app — focus the window, switch desktops, etc. —
	// re-probe every live connection so a socket that died while the app was idle
	// (NLB idle cull, OS sleep, server-side wait_timeout) gets caught right away
	// rather than waiting for the next 30s heartbeat tick.
	win.on('focus', () => {
		void connections.recheckAll();
		// Also re-read the user's tier: they may have just upgraded on the website and
		// come back, so a plan change shows up without restarting the app.
		void authStore.refreshTier();
		// The window coming forward is a person actually using the app, which is a different fact
		// from the app having been launched: the close button hides to the tray, so an install can
		// run for weeks without a second launch ping. Debounced to at most one call a day.
		markActive();
	});

	// macOS: while the window is hidden in the tray the app is a menu-bar app, like Docker or
	// Ollama, so the Dock icon goes with the window and comes back with it. Hung off the window's
	// own events rather than each show() call, so every way back (tray, deep link, a CLI sign-in
	// prompt, the quit confirm) gets it. Minimising is not hiding and keeps the icon. dock.show()
	// switches the activation policy back to regular, which can leave the window behind whatever
	// app was active, hence the focus once it settles.
	if (process.platform === 'darwin' && app.dock) {
		const dock = app.dock;
		win.on('hide', () => {
			dock.hide();
		});
		win.on('show', () => {
			if (!dock.isVisible()) {
				void dock.show().then(() => {
					if (!win.isDestroyed()) {
						win.focus();
					}
				});
			}
		});
	}

	// The OS is logging out / shutting down / restarting. There is no "are you sure" to be had at
	// that point (Windows gives an app seconds, not a conversation), and hiding to a tray that is
	// itself about to disappear would only get us force-terminated with the children still up.
	win.on('session-end', () => {
		updater.sessionEnding();
		allowQuit = true;
		teardown();
	});

	win.on('close', (event) => {
		const bounds = win.getNormalBounds();
		writeWindowSize({ width: bounds.width, height: bounds.height, maximized: win.isMaximized() });
		// Closing the window HIDES it. The app is a background service with a window on it now:
		// scheduled flows, the monitors poller and any run in flight have to survive the moment
		// somebody clicks the X, and before this they did not (the app quit, and a schedule was
		// only kept while a window happened to be open). A real quit comes from the tray, the app
		// menu or Ctrl/Cmd+Q, and sets allowQuit on its way through before-quit.
		// E2E runs close for real: Playwright's teardown closes the window, and a hidden window
		// would leave a process that never exits.
		if (allowQuit || e2eUserData) {
			return;
		}
		// A close on a window that is ALREADY HIDDEN did not come from a person: there is no X to
		// click on a window nobody can see. It is something outside asking us to go away, and the
		// one that matters is an installer: `taskkill` (the graceful pass electron-builder's NSIS
		// runs before it force-kills) posts WM_CLOSE to every top-level window of the process,
		// hidden ones included. Hiding again would leave the app running while the new version is
		// written underneath it, so an external close quits for real.
		if (!win.isVisible()) {
			logUpdate('close on a hidden window (external request, e.g. an installer) -> quitting for real');
			allowQuit = true;
			return;
		}
		event.preventDefault();
		// Nothing to hide into: a desktop that refused a tray icon, or a close in the first instants
		// before there is one. Closing then has to mean quitting, or the window would vanish with no
		// way back. Routed through app.quit() so the confirm dialog still gets its say.
		if (!tray?.available()) {
			app.quit();
			return;
		}
		// Say where the app went, once, in the app's own dialog, while there is still a window to
		// say it in. Answering it is what hides the window (app:hideToTray).
		if (!trayNoticeShown() && !win.webContents.isCrashed()) {
			win.webContents.send('app:hideNotice');
			return;
		}
		win.hide();
	});

	// Start the background entitlement re-sync only after the renderer has finished loading, so the
	// Snout Function round-trips never compete with startup; the helper then defers the first run.
	win.webContents.once('did-finish-load', () => {
		bootMark('did-finish-load');
		startEntitlementResync();
		// Start the MCP broker after first paint (never on the boot path) if the user enabled it.
		void startMcpIfEnabled();
		// Which coding agents does this machine have? Each probe is a process spawn, so the sweep
		// waits for idle: nothing here gates first paint, and the activity bar fills in a moment
		// later. This is also what turns on an agent the user installed since the last launch.
		setTimeout(() => {
			void agentConsole.discoverAll().then(() => broadcast('agentConsole:changed'));
		}, 0).unref();
		// The tray. After first paint, like everything else here: it is the app's way back once the
		// window is hidden, not part of showing the window in the first place.
		setTimeout(() => startTray(), 0).unref();
		// Start the monitor trend poller after first paint (startup is sacred). It accumulates
		// trend-widget samples in the background, connecting on demand. No-op if there are none.
		monitorPoller.start();
		// Data Flows: its scheduler, and closing out runs a crash left running (both deferred).
		pro.start();
		// Anonymous install heartbeat, deferred well past first paint so its network round-trip
		// never competes with startup. Gated on the telemetry opt-out + packaged build inside.
		setTimeout(() => { void sendInstallHeartbeat(); }, INSTALL_HEARTBEAT_DELAY_MS).unref();
		// Is this version still supported? Same slot as the heartbeat: a network round-trip
		// that must never touch first paint, and fails open if it cannot run.
		setTimeout(() => { void runMinimumVersionCheck(); }, INSTALL_HEARTBEAT_DELAY_MS).unref();
		// Bring the account's cloud databases in as connections. A network round-trip, so it takes
		// the same slot, well after first paint.
		setTimeout(() => {
			cloudSyncArmed = true;
			void runCloudSync();
		}, INSTALL_HEARTBEAT_DELAY_MS).unref();
		// Credential files written before they were owner-only lose group and other access. Local
		// file work, deferred off the boot path; a no-op on Windows and once it has run.
		setTimeout(() => { tightenPrivateFiles(app.getPath('userData')); }, 0).unref();
		// A connection string saved with its password in it (before 2026-10-14) gives the password
		// to the keychain and is rewritten without it. Local file work, off the boot path; a no-op
		// once nothing saved holds one.
		setTimeout(() => {
			if (connections.moveUriPasswordsToKeychain().length > 0) {
				connectionsChanged();
			}
		}, 0).unref();
		// One-time: fold the retired freeform "AI instructions" into a global knowledge
		// note, then clear the textarea. Local file work, deferred off the boot path anyway.
		setTimeout(() => {
			if (knowledgeStore.migrateInstructions(aiSettingsStore.get().behavior.instructions)) {
				aiSettingsStore.clearInstructions();
			}
		}, 0).unref();
	});

	if (process.env.ELECTRON_RENDERER_URL) {
		void win.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		void win.loadFile(join(__dirname, '../renderer/index.html'));
	}
}

function registerIpc(): void {
	// Connection management.
	ipcMain.handle('connections:state', () => connections.state());
	ipcMain.handle('connections:save', (_event, form: ConnectionFormValues) => connections.save(form));
	// Only the form's save, by the person at it, confirms an imported connection that is held until
	// someone looks at it (an AWS secret, an SSH tunnel). An assistant's or agent's edit_connection
	// comes through connections:save above and keeps the hold.
	ipcMain.handle('connections:saveFromForm', (_event, form: ConnectionFormValues) => connections.save(form, { confirmedByPerson: true }));
	ipcMain.handle('connections:delete', async (_event, id: string) => {
		await connections.remove(id);
		mcpStore.forget(id); // a deleted connection drops off the MCP allowlist too
	});
	ipcMain.handle('connections:test', (_event, form: ConnectionFormValues) => connections.test(form));
	ipcMain.handle('connections:testSaved', (_event, id: string) => connections.testSaved(String(id)));
	ipcMain.handle('connections:connect', (_event, id: string) => connections.connect(id));
	ipcMain.handle('connections:cancelConnect', (_event, id: string) => connections.cancelConnect(id));
	ipcMain.handle('connections:disconnect', (_event, id: string) => connections.disconnect(id));
	ipcMain.handle('connections:refresh', (_event, id: string) => connections.refresh(id));
	ipcMain.handle('connections:getSchema', (_event, id: string) => connections.getSchema(id));
	ipcMain.handle('connections:setIdleTimeout', (_event, ms: number) => connections.setIdleTimeout(ms));

	// On-demand native-driver components (e.g. Db2's ibm_db sidecar runtime). The renderer asks
	// what a driver needs, installs it (progress streamed on the `components:progress` channel),
	// then retries the connect. install resolves to a result envelope rather than throwing.
	ipcMain.handle('components:status', () => componentStore.all());
	ipcMain.handle('components:requiredFor', (_event, driver: string) => componentStore.requiredFor(driver));
	ipcMain.handle('components:acceptTerms', (_event, ids: unknown) => {
		componentStore.acceptTerms(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
	});
	ipcMain.handle('components:installFor', async (_event, driver: string) => {
		try {
			await componentStore.installFor(driver, (p) => broadcast('components:progress', p));
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	// Saved cloud accounts, referenced by id wherever they are used. A secret goes in
	// through `save` and never comes back out: there is no handler that returns one, and `list`
	// reports only WHETHER a profile has one, which is what the page needs to offer Remove.
	ipcMain.handle('cloud:vendors', () => cloudService.vendors());
	ipcMain.handle('cloud:list', () => cloudService.list());
	ipcMain.handle('cloud:save', (_event, form: CloudAccountForm) => cloudService.save(form));
	ipcMain.handle('cloud:delete', (_event, id: string) => { cloudService.remove(id); });
	// Tested against what is on SCREEN rather than what is saved, because Test-then-Save is the order
	// people do it in. A form with no typed secret falls back to the stored one.
	ipcMain.handle('cloud:test', (_event, form: CloudAccountForm) => cloudService.test(form));
	// The credentials this computer already has, so nobody re-types what their machine knows.
	// Read-only and secret-free by construction: a driver produces an auth that NAMES a local
	// credential, and the SDK resolves it at call time exactly as that vendor's CLI does.
	ipcMain.handle('cloud:importable', (_event, vendor: CloudVendor) => cloudService.importable(vendor));
	// Two doors on purpose: the settings page has a form and no saved account yet; the flow wizard
	// has a saved id and no form. Neither can be used for the other's job.
	ipcMain.handle('cloud:containers', (_event, form: CloudAccountForm) => cloudService.containers(form));
	ipcMain.handle('cloud:containersFor', (_event, accountId: string) => cloudService.containersFor(accountId));
	// The log half of the same account. `region` is a parameter and not the account's, because a log
	// scope is regional on every one of these providers and one credential commonly reads several.
	ipcMain.handle('cloud:logServices', () => cloudService.logServices());
	ipcMain.handle('cloud:logScopesFor', (_event, params: { accountId: string; region: string }) => cloudService.logScopesFor(params.accountId, params.region));

	// Reusable SSH tunnel profiles, referenced by connections via sshTunnelRef.
	ipcMain.handle('tunnels:state', () => tunnels.state());
	ipcMain.handle('tunnels:save', (_event, form: TunnelProfileFormValues) => tunnels.save(form));
	ipcMain.handle('tunnels:delete', (_event, id: string) => tunnels.remove(id));

	// Schema sync: compute a migration that morphs the target's schema into the source's
	// (schema:diff), then apply the user-selected statements against the target (schema:apply).
	ipcMain.handle('schema:diff', (_event, sourceId: string, targetId: string) => connections.buildSchemaPlan(sourceId, targetId));
	ipcMain.handle('schema:apply', (_event, targetId: string, statements: ApplyStatement[]) => connections.applyMigration(targetId, statements));

	// Users and privileges. `security:read` is a catalog read;
	// `security:plan` returns the statements for review WITHOUT running them; `security:apply`
	// takes the CHANGES again (never SQL) and re-plans in main, so only emitter output ever runs.
	ipcMain.handle('security:support', (_event, connectionId: string) => security.support(connectionId));
	ipcMain.handle('security:read', (_event, connectionId: string) => security.snapshot(connectionId));
	ipcMain.handle('security:plan', (_event, connectionId: string, changes: SecurityChange[]) => security.plan(connectionId, changes));
	ipcMain.handle('security:apply', (_event, connectionId: string, changes: SecurityChange[]) => security.apply(connectionId, changes));

	// Import connections from another database tool. Auto-detect (`import:scan`) or let the
	// user point us at a config file (`import:browse`). Dispatch on source so adding a tool
	// later is just another case; the renderer saves selected items via connections:save.
	ipcMain.handle('import:scan', async (_event, source: ImportSourceId): Promise<ImportScanResult> => importGrants.grantScan(await scanImportSource(source)));
	function scanImportSource(source: ImportSourceId): ImportScanResult | Promise<ImportScanResult> {
		// E2E only, and only under a scratch profile: what "this computer" has, so a spec of the
		// companion's offer does not depend on what the machine running it has.
		const fakeScan = e2eUserData ? testEnv('SNOUT_E2E_DISCOVERY') : undefined;
		const fake = fakeScan && (source === 'docker' || source === 'local')
			? (JSON.parse(fakeScan) as Partial<Record<ImportSourceId, ImportScanResult>>)[source] ?? { sourceId: source, sources: [], items: [] }
			: null;
		if (fake) {
			return fake;
		}
		switch (source) {
			case 'dbeaver': return scanDbeaver();
			case 'datagrip': return scanDatagrip();
			case 'navicat': return scanNavicat();
			// The one source that is a network call rather than a file, so it is the one
			// that can be refused for a reason the user can act on (not signed in, no
			// projects, offline). It answers with `unavailable` rather than an empty list.
			case 'snoutdata-cloud': return scanSnoutdataCloud(liveCloudApi, readConnections());
			default: return scanDiscoverySource(source, readConnections()) ?? { sourceId: source, sources: [], items: [], notFound: true };
		}
	}
	// Per-source title + file filter for the Browse dialog (each tool stores its
	// connections in a differently named/typed file).
	const browseDialog: Partial<Record<ImportSourceId, { title: string; filters: Electron.FileFilter[] }>> = {
		dbeaver: { title: "Choose a DBeaver data-sources.json", filters: [{ name: 'DBeaver config', extensions: ['json'] }] },
		datagrip: { title: "Choose a DataGrip dataSources.xml", filters: [{ name: 'DataGrip data sources', extensions: ['xml'] }] },
		navicat: { title: "Choose a Navicat .ncx export", filters: [{ name: 'Navicat connections', extensions: ['ncx', 'xml'] }] },
		pgadmin: { title: "Choose pgadmin4.db or a servers.json export", filters: [{ name: 'pgAdmin servers', extensions: ['db', 'json'] }] },
		'mysql-workbench': { title: "Choose MySQL Workbench's connections.xml", filters: [{ name: 'Workbench connections', extensions: ['xml'] }] },
		'azure-data-studio': { title: "Choose Azure Data Studio's settings.json", filters: [{ name: 'Settings', extensions: ['json'] }] },
		ssms: { title: "Choose an SSMS UserSettings.xml", filters: [{ name: 'SSMS settings', extensions: ['xml'] }] },
		heidisql: { title: "Choose HeidiSQL's portable_settings.txt", filters: [{ name: 'HeidiSQL settings', extensions: ['txt'] }] },
		// A .pgpass has no extension, so the filter is everything.
		pgpass: { title: "Choose a .pgpass or pgpass.conf", filters: [{ name: 'All files', extensions: ['*'] }] },
		tableplus: { title: "Choose TablePlus's Connections.plist", filters: [{ name: 'Property lists', extensions: ['plist'] }] },
	};
	ipcMain.handle('import:browse', async (_event, source: ImportSourceId): Promise<ImportScanResult | null> => {
		const opts = browseDialog[source];
		const result = await dialog.showOpenDialog({
			title: opts?.title ?? "Choose a config file",
			filters: opts?.filters ?? [{ name: 'All files', extensions: ['*'] }],
			properties: ['openFile', 'showHiddenFiles'],
		});
		if (result.canceled || result.filePaths.length === 0) {
			return null;
		}
		switch (source) {
			case 'dbeaver': return importGrants.grantScan(scanDbeaverFiles(result.filePaths));
			case 'datagrip': return importGrants.grantScan(scanDatagripFiles(result.filePaths));
			case 'navicat': return importGrants.grantScan(scanNavicatFiles(result.filePaths));
			default: return importGrants.grantScan(await browseDiscoverySource(source, result.filePaths, readConnections()) ?? { sourceId: source, sources: [], items: [], notFound: true });
		}
	});
	// Apply: re-resolve the selected connections (with secrets, where the source stores
	// them readably) in main and save them, so passwords never leave the main process.
	// Returns how many were saved.
	// Only refs a scan main ran this session listed for that source (ImportGrants): a file the page
	// names is never read for its passwords.
	ipcMain.handle('import:apply', async (_event, source: ImportSourceId, sent: ImportItemRef[]): Promise<number> => {
		const refs: ImportItemRef[] = importGrants.allowedRefs(source, sent);
		if (Array.isArray(sent) && refs.length < sent.length) {
			console.warn(`[import] ${sent.length - refs.length} ref(s) no scan listed were refused`);
		}
		let values: ConnectionFormValues[] = [];
		switch (source) {
			case 'dbeaver': values = resolveDbeaverImport(refs); break;
			case 'datagrip': values = resolveDatagripImport(refs); break;
			case 'navicat': values = resolveNavicatImport(refs); break;
			// Fetches each project's password from the control plane, in main, and puts it
			// on the form values below — the same path a DBeaver password takes, so it
			// never transits the renderer.
			case 'snoutdata-cloud': values = await resolveSnoutdataCloudImport(liveCloudApi, refs, readConnections()); break;
			// The discovery sources. Each re-reads its file, re-inspects
			// its container or rebuilds from the ref, here in main, so a password found in a
			// container's environment or a .pgpass goes straight into the keychain.
			default: values = await resolveDiscoveryImport(source, refs) ?? []; break;
		}
		for (const value of values) {
			await connections.save(value, { imported: true });
		}
		return values.length;
	});

	// First-run discovery ("Find databases"): every source at once, each
	// under its own time limit, with progress pushed per source. Only ever run when the user asks,
	// never on the boot path. Importing goes through `import:apply` per source, like any import.
	ipcMain.handle('discover:run', (event, options: DiscoveryOptions): Promise<ImportScanResult[]> => runDiscovery({
		existing: readConnections(),
		platform: process.platform,
		scanDbeaver,
		scanDatagrip,
		scanNavicat,
		// Signed out is not a finding: the source is left out quietly, as are an account with no
		// projects and a control plane we could not reach.
		async scanCloud() {
			if (!(await liveCloudApi.account())) {
				return null;
			}
			const result = await scanSnoutdataCloud(liveCloudApi, readConnections());
			return result.items.length > 0 ? result : null;
		},
		onProgress(progress) {
			if (!event.sender.isDestroyed()) {
				event.sender.send('discover:progress', progress);
			}
		},
	}, { network: options?.network === true }).then((results) => results.map((result) => importGrants.grantScan(result))));

	// The pods view: the account's hosted databases, and their
	// whole life (create, start, stop, delete). Fetched when the panel is opened and never on the boot path — the
	// rule under "Startup is sacred", applied to a network call.
	ipcMain.handle('cloud:projects', () => {
		// Opening or refreshing the panel is also when a project made elsewhere (the dashboard,
		// the CLI) should turn up as a connection. Not awaited: the list is what was asked for.
		void runCloudSync();
		// Remembered for the tray's Dashboard submenu, which draws the panel's last reading.
		return cloudProjectsView(liveCloudApi).then(rememberCloudProjects);
	});
	// Sets a DESIRED state and returns. The host agent does the work on its next tick, so
	// the answer is "asked", never "done", and the panel re-reads the list to find out.
	ipcMain.handle('cloud:ask', (_event, action: 'pause' | 'resume', ref: string) => askCloudProject(liveCloudApi, action, ref, closeCloudConnections));
	// A new project is added as a connection at once and marked seen, so deleting that
	// connection later is not undone by the next sync.
	ipcMain.handle('cloud:create', (_event, form: CloudCreateForm) => createCloudProject(liveCloudApi, form, async (ref) => {
		await addCloudConnections([ref]);
		const account = await liveCloudApi.account();
		if (account) {
			rememberCloudRefs(account, [ref]);
		}
	}));
	ipcMain.handle('cloud:delete-project', (_event, ref: string) => deleteCloudProject(liveCloudApi, ref, async (projectRef) => {
		const mine = readConnections().filter((c) => c.cloudProjectRef === projectRef);
		for (const connection of mine) {
			await connections.remove(connection.id);
		}
		return mine.length;
	}));
	// The Cloud project tab. A password or an API key
	// goes to the clipboard here and never back over IPC.
	const cloudProjectHost: CloudProjectHost = {
		copy: (text) => clipboard.writeText(text),
		async updatePassword(ref, password) {
			const mine = readConnections().filter((c) => c.cloudProjectRef === ref);
			for (const connection of mine) {
				secretStore.store(connection.id, 'password', password);
			}
			return mine.length;
		},
		sync: () => runCloudSync(),
	};
	ipcMain.handle('cloud:project', <K extends CloudProjectOp>(_event: Electron.IpcMainInvokeEvent, op: K, args: CloudProjectOps[K]['args']) =>
		runCloudProjectOp(liveCloudApi, cloudProjectHost, op, args));

	// Local projects: the SnoutData stack in the user's own
	// Docker. Nothing runs until the Projects panel asks; the list is one `docker ps`. Progress
	// (an install, a start, a settings change) is pushed as 'local:progress', keyed by the
	// install's id or the project's.
	const localStack = new LocalStackService({
		userDataDir: app.getPath('userData'),
		home: app.getPath('home'),
		platform: process.platform,
		env: process.env,
		userPath: () => resolveUserPath({ platform: process.platform, env: process.env }),
		fetch: (input, init) => netFetch(input, init),
		copy: (text) => clipboard.writeText(text),
		addConnection: (form) => connections.save(form).id,
		connectionsOf: (projectId) => readConnections().filter((c) => c.localProjectId === projectId).map((c) => ({ id: c.id, port: c.port })),
		updateConnection(connectionId, change) {
			const config = readConnections().find((c) => c.id === connectionId);
			if (config && change.port !== undefined) {
				writeConnection({ ...config, port: change.port });
				connectionsChanged();
			}
			if (change.password) {
				secretStore.store(connectionId, 'password', change.password);
			}
			if (change.production !== undefined) {
				const current = readConnections().find((c) => c.id === connectionId);
				if (current) {
					writeConnection({ ...current, environment: change.production ? 'prod' : 'dev' });
					connectionsChanged();
				}
			}
		},
		removeConnection: (connectionId) => connections.remove(connectionId),
		openPath: async (path) => { await shell.openPath(path); },
	});
	localStackForTray = localStack;
	// Snout Containers' "Deploy from a folder": built with the user's own Docker (the one the local
	// stack finds) into an image archive, and uploaded to the project's own upload link. A folder is
	// built only if this session's picker handed it out, so the page cannot point docker at a path of
	// its choosing. The upload link is used here and never crosses IPC; the progress lines are
	// docker's output and the steps'.
	const pickedBuildFolders = new Set<string>();
	ipcMain.handle('cloud:containers-pick-folder', async (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const options: Electron.OpenDialogOptions = { title: "Choose the folder with the Dockerfile", properties: ['openDirectory'] };
		const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
		const folder = picked.canceled ? null : picked.filePaths[0] ?? null;
		if (folder) {
			pickedBuildFolders.add(folder);
		}
		return folder;
	});
	ipcMain.handle('cloud:containers-build', async (event, ref: string, form: ContainerBuildForm, buildId: string) => {
		if (!form || typeof form.folder !== 'string' || !pickedBuildFolders.has(form.folder)) {
			return { ok: false, refused: true, message: "Choose the folder again with Choose folder." };
		}
		const say = (line: string): void => {
			if (!event.sender.isDestroyed()) {
				const progress: ContainerBuildProgress = { buildId, line };
				event.sender.send('cloud:containers-progress', progress);
			}
		};
		return buildAndDeploy(liveCloudApi, {
			docker: (args, options) => localStack.docker(args, options),
			hasDockerfile: (folder) => existsSync(join(folder, 'Dockerfile')),
			async scratch() {
				const dir = await mkdtemp(join(tmpdir(), 'snoutdata-build-'));
				return { dir, file: (name: string) => join(dir, name) };
			},
			fileSize: async (path) => (await stat(path)).size,
			upload: (url, file, sent) => uploadFile(url, file, sent),
			removeDir: (dir) => rm(dir, { recursive: true, force: true }),
			now: () => Date.now(),
		}, String(ref), { name: String(form.name ?? ''), folder: form.folder, ...(typeof form.port === 'number' ? { port: form.port } : {}) }, say);
	});
	const localProgress = (event: Electron.IpcMainInvokeEvent) => (progress: LocalProgress): void => {
		if (!event.sender.isDestroyed()) {
			event.sender.send('local:progress', progress);
		}
	};
	ipcMain.handle('local:requirements', () => localStack.requirements());
	ipcMain.handle('local:start-engine', () => localStack.startEngine());
	ipcMain.handle('local:defaults', (_event, name: string) => localStack.defaults(name));
	ipcMain.handle('local:ports-in-use', (_event, ports: number[]) => localStack.portsInUse(ports.filter((p) => Number.isInteger(p))));
	ipcMain.handle('local:pick-folder', async (event, current: string) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const options: Electron.OpenDialogOptions = { title: "Choose a folder for the project", defaultPath: current, properties: ['openDirectory', 'createDirectory'] };
		const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
		return picked.canceled ? null : picked.filePaths[0] ?? null;
	});
	ipcMain.handle('local:list', () => localStack.list().then(rememberLocalProjects));
	ipcMain.handle('local:install', (event, form: LocalSetupForm, installId: string) => localStack.install(form, installId, localProgress(event)));
	ipcMain.handle('local:start', (event, id: string) => localStack.start(id, localProgress(event)));
	ipcMain.handle('local:stop', (_event, id: string) => localStack.stop(id));
	ipcMain.handle('local:remove', (_event, id: string, options: { deleteData?: boolean; deleteFolder?: boolean }) =>
		localStack.remove(id, { deleteData: options?.deleteData === true, deleteFolder: options?.deleteFolder === true }));
	ipcMain.handle('local:logs', (_event, id: string, service: string | null) => localStack.logs(id, service));
	ipcMain.handle('local:facts', (_event, id: string) => localStack.facts(id));
	ipcMain.handle('local:copy', (_event, id: string, target: LocalCopyTarget) => localStack.copy(id, target));
	ipcMain.handle('local:open-folder', (_event, id: string, sub?: string) => localStack.openFolder(id, sub));
	ipcMain.handle('local:functions', (_event, id: string) => localStack.functions(id));
	ipcMain.handle('local:new-function', (_event, id: string, name: string) => localStack.newFunction(id, name));
	ipcMain.handle('local:deploy-functions', (event, id: string) => localStack.deployFunctions(id, localProgress(event)));
	ipcMain.handle('local:settings', (_event, id: string) => localStack.settings(id));
	ipcMain.handle('local:data-api', (_event, id: string) => localStack.dataApi(id));
	ipcMain.handle('local:set-data-api', (event, id: string, on: boolean) => localStack.setDataApi(id, on === true, localProgress(event)));
	ipcMain.handle('local:save-settings', (event, id: string, change: LocalSettingsChange) => localStack.saveSettings(id, change, localProgress(event)));
	// What the cloud's control plane does to a hosted project, done here to a local one: the
	// password, the keys, production, exports and restores, auth's emails, functions' secrets.
	ipcMain.handle('local:activity', (_event, id: string) => localStack.activity(id));
	ipcMain.handle('local:reset-password', (_event, id: string) => localStack.resetPassword(id));
	ipcMain.handle('local:rotate-keys', (event, id: string) => localStack.rotateKeys(id, localProgress(event)));
	ipcMain.handle('local:set-production', (_event, id: string, on: boolean) => localStack.setProduction(id, on === true));
	ipcMain.handle('local:exports', (_event, id: string) => localStack.exports(id));
	ipcMain.handle('local:export', (_event, id: string) => localStack.exportNow(id));
	ipcMain.handle('local:open-exports', (_event, id: string) => localStack.openExports(id));
	ipcMain.handle('local:restore', (event, id: string, name: string) => localStack.restore(id, String(name), localProgress(event)));
	ipcMain.handle('local:mail-templates', (_event, id: string) => localStack.mailTemplates(id));
	ipcMain.handle('local:save-mail-template', (event, id: string, kind: LocalMailKind, template: { subject: string; body: string } | null) =>
		localStack.saveMailTemplate(id, kind, template && typeof template.subject === 'string' && typeof template.body === 'string' ? { subject: template.subject, body: template.body } : null, localProgress(event)));
	ipcMain.handle('local:function-secrets', (_event, id: string) => localStack.functionSecrets(id));
	ipcMain.handle('local:set-function-secret', (event, id: string, name: string, value: string | null) =>
		localStack.setFunctionSecret(id, String(name), typeof value === 'string' ? value : null, localProgress(event)));
	// The dashboard's sections, locally: SQL as the owner and the gateway with the service key,
	// both from here, so neither secret ever reaches the renderer.
	// A project's sections, local or cloud (shared/projects.ts): SQL as the owner and the gateway
	// with the service key, both from here, so neither secret reaches the renderer.
	const projectAccess = new ProjectAccess({ local: (id) => localStack.target(id), cloud: liveCloudApi, fetch: (input, init) => netFetch(input, init) });
	const target = (value: unknown): ProjectTarget => {
		if (!isProjectTarget(value)) {
			throw new Error('Not a project.');
		}
		return value;
	};
	// Copying a whole project between this computer and SnoutData Cloud (shared/projectCopy.ts):
	// both projects' doors from here, the database through the Move's own runner.
	const projectCopies = new ProjectCopies({
		access: projectAccess,
		cloud: liveCloudApi,
		local: {
			describe: (id) => localStack.describe(id),
			functionSources: (id) => localStack.functionSources(id),
			functionSecretValues: (id) => localStack.functionSecretValues(id),
		},
		moves: {
			get: (id) => moveStore.get(id),
			save: (spec) => {
				const saved = moveStore.upsert(spec);
				broadcast('moves:changed', saved.id);
				return saved;
			},
			check: (spec) => checkMove(spec, moveHost),
			start: (spec, typed) => moveRuns.start(spec, typed),
			wait: (moveId) => moveRuns.wait(moveId),
			cancel: (runId) => moveRuns.cancel(runId),
			toolsInstalled: () => pgTools() !== null,
		},
		connections: () => connections.state().connections,
		saveConnection: (values) => connections.save(values),
		onProgress: (progress) => broadcast('projectCopy:progress', progress),
	});
	const copyRequest = (value: unknown): ProjectCopyRequest => {
		const r = value as ProjectCopyRequest | null;
		const destinationOk = r && r.target && (isProjectTarget(r.target) || (r.target.kind === 'newCloud' && typeof r.target.name === 'string' && typeof r.target.region === 'string'));
		if (!r || typeof r.id !== 'string' || !isProjectTarget(r.source) || !destinationOk || !Array.isArray(r.parts)) {
			throw new Error('Not a project copy.');
		}
		return r;
	};
	ipcMain.handle('projectCopy:check', (_event, request: unknown) => projectCopies.check(copyRequest(request)));
	ipcMain.handle('projectCopy:start', (_event, request: unknown, typed: unknown) => projectCopies.start(copyRequest(request), typeof typed === 'string' ? typed : undefined));
	ipcMain.handle('projectCopy:cancel', (_event, id: string) => projectCopies.cancel(String(id)));
	ipcMain.handle('projectCopy:state', (_event, id: string) => projectCopies.state(String(id)));
	ipcMain.handle('project:sql', (_event, which: unknown, sql: string) => projectAccess.sql(target(which), String(sql)));
	ipcMain.handle('project:api', (_event, which: unknown, request: ProjectApiRequest) => projectAccess.api(target(which), request));
	ipcMain.handle('project:upload', async (event, which: unknown, bucket: string, prefix: string, upsert: boolean) => {
		const project = target(which);
		const win = BrowserWindow.fromWebContents(event.sender);
		const options: Electron.OpenDialogOptions = { title: "Upload to " + bucket, properties: ['openFile', 'multiSelections'] };
		const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
		if (picked.canceled || picked.filePaths.length === 0) {
			return null;
		}
		return projectAccess.upload(project, bucket, String(prefix ?? ''), picked.filePaths, upsert === true);
	});
	ipcMain.handle('project:download', async (event, which: unknown, bucket: string, path: string) => {
		const project = target(which);
		const win = BrowserWindow.fromWebContents(event.sender);
		const options: Electron.SaveDialogOptions = { title: "Save " + path, defaultPath: path.split('/').pop() };
		const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
		if (picked.canceled || !picked.filePath) {
			return null;
		}
		return projectAccess.download(project, bucket, path, picked.filePath);
	});
	// Only Docker's install pages: a renderer string is not a way to open anything else. (The
	// project's own API is not opened in a browser: a browser cannot send the key header, so
	// the gateway answers no_api_key. The API docs section is where that button goes instead.)
	ipcMain.handle('local:open-url', async (_event, url: string) => {
		if (/^https:\/\/(www\.docker\.com|docs\.docker\.com)\//.test(url)) {
			await openExternalIfAllowed(url, { httpsOnly: true });
		}
	});

	// Query execution. Always resolve with an ExecuteQueryResult envelope — a throw here
	// would surface in the renderer as "Error invoking remote method 'sql:execute': …"
	// (Electron's IPC wrap), which is junk a user can't act on. Driver-level errors are
	// already returned in the envelope by the server; this guards LSP/transport-level
	// faults (the LSP child crashed, sendRequest rejected with "Connection is closed.",
	// …) so they're presented as a normal "Run failed: <reason>" instead.
	ipcMain.handle('sql:execute', async (_event, params: RunQueryParams) => {
		try {
			return 'native' in params
				? await connections.executeNative(params.connectionId, params.native, params.recordHistory ?? true)
				: await connections.execute(params.connectionId, params.sql, true, params.allowAiTranscribe ?? false, 'interactive', params.window);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	// Run a pre-built EXPLAIN statement for the post-run index/scan advisor (Pillar 2 Tier B). The
	// renderer builds the vendor EXPLAIN via `Dialect.explainJson`; this runs it WITHOUT recording
	// history (an internal advisory query, not the user's own), returning the plan result envelope.
	ipcMain.handle('sql:explain', async (_event, params: { connectionId: string; sql: string }) => {
		try {
			return await connections.execute(params.connectionId, params.sql, false);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	ipcMain.handle('sql:transcribe', async (_event, params: { connectionId: string; sql: string; allowAiTranscribe?: boolean }) => {
		try {
			await ensureConnected(params.connectionId);
			return await connections.transcribeOnly(params.connectionId, params.sql, params.allowAiTranscribe ?? false);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	// Pick the file to load, and say what it looks like. Separate from the load itself because the
	// person sees a confirm in between: what will run, read as what, with what warnings.
	ipcMain.handle('sql:chooseLoadFile', async (event, params: { connectionId: string; path?: string }) => {
		const driver = readConnections().find((entry) => entry.id === params.connectionId)?.driver ?? '';
		if (bulkFormatsFor(driver).length === 0) {
			return null;
		}
		let path = params.path;
		if (path && !pathGrants.allowed('sql:bulkLoad', path)) {
			return null; // only a file main itself was handed by a picker
		}
		if (!path) {
			const win = BrowserWindow.fromWebContents(event.sender);
			const options = {
				title: "Choose a file to load",
				properties: ['openFile' as const],
				filters: [
					{ name: "Data files", extensions: bulkLoadExtensions(driver) },
					{ name: "All files", extensions: ['*'] },
				],
			};
			const chosen = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
			if (chosen.canceled || chosen.filePaths.length === 0) {
				return null;
			}
			path = chosen.filePaths[0];
			pathGrants.grant('sql:bulkLoad', path);
		}
		const bytes = await stat(path).then((entry) => entry.size).catch(() => undefined);
		const format = formatForFile(driver, path);
		return { path, name: basename(path), bytes, formatId: format?.id, encoding: encodingForFile(path) };
	});
	// Load it. The STATEMENT is built here and not in the renderer: the format is the one part of
	// it that is not a quoted identifier, so it is looked up in the engine's own list on this side
	// of the IPC boundary or the load does not happen (bulkLoad.ts's header).
	ipcMain.handle('sql:bulkLoad', async (_event, params: { connectionId: string; schema?: string; table: string; formatId: string; filePath: string; columns?: string[] }) => {
		try {
			await ensureConnected(params.connectionId);
			const driver = readConnections().find((entry) => entry.id === params.connectionId)?.driver ?? '';
			const format = bulkFormatById(driver, params.formatId);
			if (!format) {
				return { ok: false, error: `"${params.formatId}" is not a format this connection can be handed a file of.` };
			}
			if (!pathGrants.allowed('sql:bulkLoad', params.filePath)) {
				return { ok: false, error: "That file was not chosen in this app's file picker, so it was not loaded. Choose it again." };
			}
			const sql = emitBulkLoad(driver, { schema: params.schema, table: params.table, columns: params.columns }, format);
			return await connections.bulkLoad(params.connectionId, { sql, filePath: params.filePath, encoding: encodingForFile(params.filePath) });
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	/*
	 * Table functions: the data that is not in this database.
	 *
	 * The STATEMENT is built here and never in the renderer, for the same reason the file load's is:
	 * the function's name is the one part of it that is not a quoted literal, so it is looked up in
	 * the engine's own list on this side of the IPC boundary.
	 *
	 * The credentials are the reason this handler exists at all. A key pair from a saved cloud
	 * account is resolved HERE, out of the keychain, and never travels to the renderer; a password
	 * the person typed does travel (they typed it), but neither reaches query history, because the
	 * statement is recorded through `executeRedacted` with the secrets replaced by value.
	 */
	ipcMain.handle('sql:tableFunction', async (_event, params: { connectionId: string; functionId: string; values: Record<string, string>; accountId?: string; action: 'describe' | 'preview' | 'import'; limit?: number; target?: { database?: string; table: string; orderBy: string[] } }) => {
		try {
			await ensureConnected(params.connectionId);
			const config = readConnections().find((entry) => entry.id === params.connectionId);
			const driver = config?.driver ?? '';
			const spec = tableFunctionById(driver, params.functionId);
			if (!spec) {
				return { ok: false, error: `"${params.functionId}" is not a table function this connection offers.` };
			}
			let values = params.values;
			let accountName: string | undefined;
			if (params.accountId) {
				if (!spec.keyPair) {
					return { ok: false, error: `${spec.label} does not take a key pair, so a saved account cannot fill it in.` };
				}
				const account = cloudService.get(params.accountId);
				if (!account) {
					return { ok: false, error: 'That cloud account is no longer saved.' };
				}
				// The SERVER fetches the object, so a credential that lives on THIS computer (an AWS
				// CLI profile, an instance role) is no use: it cannot be handed over. Only a key pair
				// can, and saying so by name is better than a permission error from a bucket.
				if (account.auth.mode !== 'key') {
					return { ok: false, error: `"${account.name}" is a ${account.auth.mode === 'named' ? 'named profile on this computer' : 'credential this computer resolves for itself'}, and the ClickHouse server is what reads the data. Use an account saved as an access key, or type the key here.` };
				}
				const secret = cloudService.secretFor(params.accountId);
				if (!secret) {
					return { ok: false, error: `"${account.name}" has no secret in the keychain on this computer.` };
				}
				accountName = account.name;
				values = { ...values, [spec.keyPair.idParam]: account.auth.keyId, [spec.keyPair.secretParam]: secret };
			}
			const call = emitTableFunctionCall(driver, spec, values);
			// What is recorded and shown: the same call with every secret, and an account's key id,
			// replaced by an unrunnable placeholder.
			const shownValues = spec.keyPair && accountName
				? { ...values, [spec.keyPair.idParam]: REDACTED, [spec.keyPair.secretParam]: REDACTED }
				: values;
			const shownCall = emitTableFunctionCall(driver, spec, shownValues, { redactSecrets: true });
			let sql: string;
			let shownSql: string;
			if (params.action === 'describe') {
				sql = describeStatement(call);
				shownSql = describeStatement(shownCall);
			} else if (params.action === 'preview') {
				sql = previewStatement(call, params.limit ?? 100);
				shownSql = previewStatement(shownCall, params.limit ?? 100);
			} else {
				if (!params.target) {
					return { ok: false, error: 'No table to create.' };
				}
				if (config?.readOnly) {
					return { ok: false, error: `Connection "${config.label}" is read-only; creating a table is blocked.` };
				}
				sql = importStatement(driver, params.target, call);
				shownSql = importStatement(driver, params.target, shownCall);
			}
			const result = await connections.executeRedacted(params.connectionId, sql, shownSql + credentialNote(accountName));
			return result.ok ? { ok: true, result: result.result, sql: shownSql } : { ok: false, error: result.error, sql: shownSql };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	// The other direction: the SERVER writes the whole result to a file, in one of its own formats,
	// and not one row passes through this process. The app's own export (`export:data`) serializes
	// rows it is holding, which is the right thing for a grid and the wrong thing for 50 million
	// rows. Same rule as the load: the format is looked up in the engine's list HERE.
	ipcMain.handle('sql:exportServerSide', async (event, params: { connectionId: string; sql: string; formatId: string; suggestedName?: string }) => {
		try {
			await ensureConnected(params.connectionId);
			const config = readConnections().find((entry) => entry.id === params.connectionId);
			const driver = config?.driver ?? '';
			const format = bulkFormatById(driver, params.formatId);
			if (!format) {
				return { ok: false, error: `"${params.formatId}" is not a format this connection can write.` };
			}
			// Before the save dialog, so a statement that writes is not asked where to put its file.
			// connections.bulkExport refuses it again on the way to the server.
			const refusal = serverExportRefusal(params.sql, driver, config?.flavor);
			if (refusal) {
				return { ok: false, error: refusal };
			}
			const extension = bulkExportExtension(format).slice(1);
			const win = BrowserWindow.fromWebContents(event.sender);
			const options = {
				title: "Export from the server",
				defaultPath: join(app.getPath('documents'), `${(params.suggestedName || 'export').replace(/[^\w .-]+/g, '_')}.${extension}`),
				filters: [{ name: format.label, extensions: [extension] }],
			};
			const chosen = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
			if (chosen.canceled || !chosen.filePath) {
				return { ok: false, cancelled: true };
			}
			const outcome = await connections.bulkExport(params.connectionId, { sql: emitBulkExport(params.sql, format), filePath: chosen.filePath });
			return outcome.ok ? { ok: true, path: chosen.filePath, bytes: outcome.result.bytesWritten, durationMs: outcome.result.durationMs } : outcome;
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	ipcMain.handle('sql:executeScript', async (_event, params: { connectionId: string; statements: string[] }) => {
		try {
			return await connections.executeScript(params.connectionId, params.statements);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	ipcMain.handle('sql:executeWrites', async (_event, params: { connectionId: string; writes: MongoWrite[] }) => {
		try {
			return await connections.executeWrites(params.connectionId, params.writes);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	ipcMain.handle('sql:executeMongoDdl', async (_event, params: { connectionId: string; ops: MongoDdl[] }) => {
		try {
			return await connections.executeMongoDdl(params.connectionId, params.ops);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	ipcMain.handle('sql:cancel', (_event, connectionId: string) => connections.cancel(connectionId));
	ipcMain.handle('sql:progress', (_event, connectionId: string) => connections.queryProgress(connectionId).catch(() => null));

	// Query history + saved queries.
	ipcMain.handle('history:list', () => queryStore.history());
	ipcMain.handle('history:clear', () => queryStore.clearHistory());
	ipcMain.handle('saved:list', () => queryStore.saved());
	ipcMain.handle('saved:save', (_event, name: string, sql: string) => queryStore.saveQuery(name, sql));
	ipcMain.handle('saved:delete', (_event, name: string) => queryStore.deleteQuery(name));

	// Moving a database. Every write is broadcast, whoever made it, for the
	// same reason monitors learned to: an agent's edit must appear in a view that is already open.
	ipcMain.handle('moves:list', () => moveStore.list());
	ipcMain.handle('moves:save', (_event, spec: MoveSpec) => {
		const saved = moveStore.upsert(spec);
		broadcast('moves:changed', saved.id);
		return saved;
	});
	ipcMain.handle('moves:delete', (_event, id: string) => {
		moveStore.remove(id);
		broadcast('moves:changed', id);
	});
	ipcMain.handle('moves:check', (_event, spec: MoveSpec) => checkMove(spec, moveHost));
	// A fix is applied against a FRESH check in main, never by the view editing the spec until a
	// finding goes away.
	ipcMain.handle('moves:fix', async (_event, spec: MoveSpec, key: string, fix: FixId) => {
		const outcome = await fixMove(spec, key, fix, moveHost);
		if (outcome.ok) {
			moveStore.upsert(outcome.spec);
			broadcast('moves:changed', outcome.spec.id);
		}
		return outcome;
	});
	// Only the review sheet's Start calls this; no capability and no MCP tool does.
	ipcMain.handle('moves:run', (_event, spec: MoveSpec, typed: MoveConfirmations) => moveRuns.start(spec, typed));
	ipcMain.handle('moves:cancel', (_event, runId: string) => moveRuns.cancel(runId));
	ipcMain.handle('moves:runState', (_event, moveId: string) => moveRuns.state(moveId));
	// The Postgres tools, downloaded from the "tools missing" card on first use. Progress
	// rides the same channel every other component download uses.
	ipcMain.handle('moves:installTools', async () => {
		try {
			await componentStore.install('pgtools', (p) => broadcast('components:progress', p));
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	// Monitors (live DB monitors).
	ipcMain.handle('monitor:list', () => monitorStore.list());
	// Every write tells the renderer, whoever made it. The monitors view used to read the list
	// once on mount and never again, so a monitor an AGENT created through MCP (which lands
	// here, not in the view's own state) stayed invisible until the tab was closed and reopened —
	// including the widgets added right after `create_monitor` opened the view.
	// A widget whose query is not a read is saved PAUSED, with the reason the view shows (guardMonitor),
	// whoever wrote it: the poller and runWidget refuse it either way, and this is what says so.
	ipcMain.handle('monitor:save', (_event, monitor: Monitor) => {
		monitorStore.upsert(guardMonitor(monitor, monitorDriverFor, monitorFlavorFor));
		monitorPoller.refresh();
		broadcast('monitors:changed');
	});
	ipcMain.handle('monitor:delete', (_event, id: string) => {
		monitorStore.remove(id);
		monitorPoller.refresh();
		broadcast('monitors:changed');
	});
	// A trend widget's accumulated samples (oldest-first), optionally since a cutoff.
	ipcMain.handle('monitor:samples', (_event, widgetId: string, sinceMs?: number) => monitorStore.samples(widgetId, sinceMs ?? 0));
	// The last poll status for a trend widget (an error string, or null when its last poll was ok) —
	// so a tile that mounts after a failing poll shows the error instead of hanging on "waiting".
	ipcMain.handle('monitor:status', (_event, widgetId: string) => monitorPoller.status(widgetId));
	// Run a widget's SQL once (snapshot refresh / manual refresh). Connects on demand; never
	// records history (an automated/monitor poll must not pollute the user's query history).
	// Only a read, checked here and again by the database (executeRead), as the poller does.
	ipcMain.handle('monitor:runWidget', async (_event, connectionId: string, sql: string): Promise<ExecuteQueryResult> => {
		const refusal = monitorQueryRefusal(sql, monitorDriverFor(connectionId), monitorFlavorFor(connectionId));
		if (refusal) {
			return { ok: false, error: refusal };
		}
		await ensureConnected(connectionId);
		return connections.executeRead(connectionId, sql, false);
	});

	// Orbit Pulse 3b: the database's own activity. Off until asked for,
	// stopped when the Orbit tab closes, sampled at background priority. `pulseSupported` is what an
	// engine with no activity view answers with, and it answers in a sentence so the UI can say why
	// rather than showing an empty world.
	ipcMain.handle('orbit:pulseSupported', (_event, connectionId: string) => orbitPulse.support(connectionId));
	ipcMain.handle('orbit:pulseStart', (_event, connectionId: string, intervalMs?: number) => orbitPulse.start(connectionId, intervalMs));
	ipcMain.handle('orbit:pulseStop', (_event, connectionId: string) => orbitPulse.stop(connectionId));
	// The last poll status for a connection (an error string, or null when the last poll was ok), so
	// a view that mounts after a failing poll shows the reason instead of waiting forever.
	ipcMain.handle('orbit:pulseStatus', (_event, connectionId: string) => orbitPulse.status(connectionId));

	// Data Flows' handlers (`flow:*`, `learn:*`, `distill:*`), from its main half.
	pro.registerIpc();
	// Scheduled flows can be paused from the tray while the window is hidden, so the panel has to be
	// able to read that state and put it back. The shell's switch: it pauses reviews too.
	ipcMain.handle('flow:schedulesPaused', () => schedulesPaused);
	ipcMain.handle('flow:setSchedulesPaused', (_event, paused: boolean) => {
		setSchedulesPaused(paused);
		return schedulesPaused;
	});

	// Assistant chat history.
	ipcMain.handle('chat:list', () => chatStore.list());
	ipcMain.handle('chat:save', (_event, session: ChatSession) => chatStore.save(session));
	ipcMain.handle('chat:delete', (_event, id: string) => chatStore.delete(id));
	ipcMain.handle('chat:clear', () => chatStore.clear());

	// Per-connection knowledge base.
	ipcMain.handle('knowledge:list', (_event, connectionId: string) => knowledgeStore.list(connectionId));
	ipcMain.handle('knowledge:save', (_event, note: KnowledgeNote) => knowledgeStore.save(note));
	ipcMain.handle('knowledge:delete', (_event, id: string) => knowledgeStore.delete(id));
	ipcMain.handle('knowledge:setEnabled', (_event, id: string, enabled: boolean) => knowledgeStore.setEnabled(id, enabled));
	// Suggested (observer-proposed) notes + one-tap approve/dismiss.
	ipcMain.handle('knowledge:listSuggested', (_event, connectionId: string) => knowledgeStore.listSuggested(connectionId));
	ipcMain.handle('knowledge:approve', (_event, id: string) => knowledgeStore.approve(id));
	ipcMain.handle('knowledge:dismiss', (_event, id: string) => knowledgeStore.dismiss(id));
	// Background observer: after a SQL/correction turn, distill the exchange into a
	// `suggested` note the user can one-tap Remember. Returns the note (or null if nothing new).
	ipcMain.handle('knowledge:observe', (_event, connectionId: string, messages: ChatMessage[]) => aiService.observeKnowledge({ connectionId, messages }));
	// "Refine with AI": distill a conversation into a proposed durable fact (the user reviews + saves).
	ipcMain.handle('knowledge:draft', (_event, connectionId: string | undefined, messages: ChatMessage[], hint: string | undefined) => aiService.draftKnowledgeNote({ connectionId, messages, hint }));

	// Workspace files (a folder of .sql scripts on disk; see workspaceStore.ts).
	ipcMain.handle('workspace:root', () => workspaceStore.root());
	ipcMain.handle('workspace:list', () => workspaceStore.list());
	ipcMain.handle('workspace:read', (_event, path: string) => workspaceStore.read(path));
	ipcMain.handle('workspace:save', (_event, path: string, content: string) => workspaceStore.save(path, content));
	ipcMain.handle('workspace:create', (_event, name: string, content?: string) => workspaceStore.create(name, content ?? ''));
	ipcMain.handle('workspace:rename', (_event, path: string, newName: string) => workspaceStore.rename(path, newName));
	ipcMain.handle('workspace:remove', (_event, path: string) => workspaceStore.remove(path));
	ipcMain.handle('workspace:search', (_event, query: string) => workspaceStore.search(query));
	// Pick one or more files from disk and copy them into the workspace (null if cancelled).
	ipcMain.handle('workspace:import', async (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const properties: Array<'openFile' | 'multiSelections'> = ['openFile', 'multiSelections'];
		const options = { properties, filters: [{ name: 'SQL', extensions: ['sql'] }, { name: 'All Files', extensions: ['*'] }] };
		const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
		if (result.canceled || result.filePaths.length === 0) {
			return null;
		}
		return result.filePaths.map((p) => workspaceStore.importFile(p));
	});
	// Copy already-known files (e.g. picked from the DBeaver scan) into the workspace.
	// Only paths a DBeaver scan in main listed this session: anything else is skipped.
	ipcMain.handle('workspace:importPaths', (_event, paths: string[]) => (Array.isArray(paths) ? paths : [])
		.filter((p) => {
			const ok = pathGrants.allowed('workspace:importPaths', p);
			if (!ok) {
				console.warn('[workspace] import refused for a path no scan listed');
			}
			return ok;
		})
		.map((p) => workspaceStore.importFile(p)));
	// Scan a DBeaver install for .sql scripts (for the workspace Import modal). An optional
	// dir lets the user point at a non-standard DBeaver workspace location. What it lists is what
	// `workspace:importPaths` may copy.
	// DBeaver's own data folder only: a folder from the page is never scanned, since every script a
	// scan lists may then be copied into the workspace. Another folder goes through the picker below.
	ipcMain.handle('workspace:dbeaverScripts', () => grantScan(scanDbeaverScripts()));
	// Pick a DBeaver workspace folder and scan it (null if cancelled).
	ipcMain.handle('workspace:dbeaverPickFolder', async (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const properties: Array<'openDirectory'> = ['openDirectory'];
		const result = win ? await dialog.showOpenDialog(win, { properties }) : await dialog.showOpenDialog({ properties });
		if (result.canceled || result.filePaths.length === 0) {
			return null;
		}
		return grantScan(scanDbeaverScripts(result.filePaths[0]));
	});
	// Pick a new workspace folder (returns the new root, or null if cancelled).
	ipcMain.handle('workspace:setRoot', async (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const properties: Array<'openDirectory' | 'createDirectory'> = ['openDirectory', 'createDirectory'];
		const options = { defaultPath: workspaceStore.root(), properties };
		const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
		if (result.canceled || result.filePaths.length === 0) {
			return null;
		}
		return workspaceStore.setRoot(result.filePaths[0]);
	});

	// Editor language features.
	ipcMain.handle('sql:didOpen', (_event, uri: string, text: string, version: number) => sqlServer.didOpen(uri, text, version));
	ipcMain.handle('sql:didChange', (_event, uri: string, version: number, text: string) => sqlServer.didChange(uri, version, text));
	ipcMain.handle('sql:completion', (_event, uri: string, position: Position, connectionId?: string) => sqlServer.completion(uri, position, connectionId));
	ipcMain.handle('sql:completionResolve', (_event, item: CompletionItem) => sqlServer.completionResolve(item));
	ipcMain.handle('sql:hover', (_event, uri: string, position: Position, connectionId?: string) => sqlServer.hover(uri, position, connectionId));
	// Syntax diagnostics for the backends whose SQL this app compiles itself (document/vector/
	// telemetry): a typo there is only ever found by running the query, since there is no database
	// on the other end to answer with a syntax error of its own. It runs HERE rather than in the
	// renderer because the SQL grammar is 2.5 MB of parser, and nothing that size goes near the
	// launch bundle ("Startup is sacred").
	ipcMain.handle('sql:syntaxDiagnostics', (_event, text: string) => sqlSyntaxDiagnostics(text));

	// File open/save (.sql multi-file editing).
	ipcMain.handle('file:open', async () => {
		const result = await dialog.showOpenDialog({
			properties: ['openFile'],
			filters: [{ name: 'SQL', extensions: ['sql'] }, { name: 'All Files', extensions: ['*'] }],
		});
		if (result.canceled || result.filePaths.length === 0) {
			return null;
		}
		const path = result.filePaths[0];
		pathGrants.grant('file:save', path);
		return { path, content: await readFile(path, 'utf8') };
	});

	// Attach a document to the AI chat: pick a file, then extract + size-cap its text in main (the
	// whole file never goes to the model — see ai/documentDigest.ts). Returns the capped attachment,
	// a clean error, or null when the user cancels. Filtered to the supported text/PDF/DOCX types.
	ipcMain.handle('ai:pickDocument', async (event): Promise<ExtractDocumentResult | null> => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const options = {
			title: "Attach a document to the chat",
			properties: ['openFile' as const],
			filters: [
				{ name: 'Documents', extensions: ATTACHABLE_EXTENSIONS },
				{ name: 'All Files', extensions: ['*'] },
			],
		};
		const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
		if (result.canceled || result.filePaths.length === 0) {
			return null;
		}
		try {
			return { ok: true, attachment: await extractDocument(result.filePaths[0]) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	// Pick a file and return just its path (no read) — used for the SSH private key, which the
	// server reads from disk by path at connect time. Defaults to ~/.ssh and shows hidden files
	// so the key folder is reachable.
	ipcMain.handle('file:pickPath', async () => {
		const result = await dialog.showOpenDialog({
			defaultPath: join(app.getPath('home'), '.ssh'),
			properties: ['openFile', 'showHiddenFiles'],
		});
		return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
	});
	// Saves straight to a path only when main handed that path out (a picker this session) or it
	// is in the workspace. Never into the app's own folder outside the workspace (fileSaveRoots):
	// main reads things back from there and trusts them. Any other path, such as a tab restored
	// from an earlier session, is offered in the Save dialog first, so nothing is written where the
	// person did not say.
	ipcMain.handle('file:save', async (event, path: string | null, content: string) => {
		let target: string | null = null;
		const { roots, denied } = fileSaveRoots(workspaceStore.root(), app.getPath('userData'));
		if (path && pathGrants.allowed('file:save', path, roots, denied)) {
			target = path;
		} else {
			const win = BrowserWindow.fromWebContents(event.sender);
			const options = { defaultPath: path || undefined, filters: [{ name: 'SQL', extensions: ['sql'] }] };
			const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
			if (result.canceled || !result.filePath) {
				return null;
			}
			target = result.filePath;
			pathGrants.grant('file:save', target);
		}
		await writeFile(target, content, 'utf8');
		return target;
	});

	// Export results to a file (CSV/JSON). The renderer serializes; we pick the path.
	ipcMain.handle('file:export', async (event, defaultName: string, content: string) => {
		const ext = defaultName.split('.').pop() || 'csv';
		const options = {
			defaultPath: defaultName,
			filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All Files', extensions: ['*'] }],
		};
		const win = BrowserWindow.fromWebContents(event.sender);
		const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
		if (result.canceled || !result.filePath) {
			return null;
		}
		await writeFile(result.filePath, content, 'utf8');
		return result.filePath;
	});

	// Export results to Excel. Unlike file:export the renderer can't serialize this one — an
	// .xlsx is a binary ZIP — so it hands over the sheet and we build the workbook here
	// (src/main/xlsx.ts, dependency-free) and write the bytes.
	ipcMain.handle('file:exportXlsx', async (event, defaultName: string, sheet: XlsxSheet) => {
		const options = {
			defaultPath: defaultName,
			filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }, { name: 'All Files', extensions: ['*'] }],
		};
		const win = BrowserWindow.fromWebContents(event.sender);
		const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
		if (result.canceled || !result.filePath) {
			return null;
		}
		await writeFile(result.filePath, buildXlsx(sheet));
		return result.filePath;
	});

	// Save a chart the assistant rendered in the chat. PNG arrives base64-encoded (binary);
	// SVG/CSV are utf8 text. The renderer picks the format + default name; we pick the path.
	ipcMain.handle('chart:save', async (event, defaultName: string, format: 'png' | 'svg' | 'csv', data: string) => {
		const options = {
			defaultPath: defaultName,
			filters: [{ name: format.toUpperCase(), extensions: [format] }, { name: 'All Files', extensions: ['*'] }],
		};
		const win = BrowserWindow.fromWebContents(event.sender);
		const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
		if (result.canceled || !result.filePath) {
			return null;
		}
		if (format === 'png') {
			await writeFile(result.filePath, Buffer.from(data, 'base64'));
		} else {
			await writeFile(result.filePath, data, 'utf8');
		}
		return result.filePath;
	});

	// AI assistant.
	ipcMain.handle('ai:settings', () => aiSettingsStore.get());
	ipcMain.handle('ai:saveSettings', (_event, values: AiSettingsFormValues) => aiSettingsStore.save(values));
	ipcMain.handle('ai:test', () => aiService.test());
	ipcMain.handle('ai:providerStatus', () => aiService.providerStatus());
	ipcMain.handle('ai:budgetStatus', () => aiService.budgetStatus());
	// The wallet→credits switch, backed by the shared ai_preferences row.
	// Get reads the user's row; set writes it through and updates the in-memory routing flag so the
	// next request honours it without waiting for an auth refresh.
	ipcMain.handle('ai:creditsEnabled', () => authStore.getCreditsEnabled());
	ipcMain.handle('ai:setCreditsEnabled', async (_event, enabled: boolean) => {
		await authStore.setCreditsEnabled(enabled);
		aiService.setCreditsEnabled(enabled);
	});
	ipcMain.handle('ai:setModelEnabled', (_event, key: string, enabled: boolean) => aiSettingsStore.setModelEnabled(key, enabled));
	ipcMain.handle('ai:ollamaModels', (_event, endpoint: string) => aiService.ollamaModels(endpoint));
	ipcMain.handle('ai:byokModels', (_event, provider: ByokProviderId) => aiService.byokModelList(provider));
	ipcMain.handle('ai:setActive', (_event, provider: AiProviderId, model: string) => aiSettingsStore.setActive(provider, model));

	// The renderer publishes its capability manifest whenever the registry changes. The chat path
	// passes its own per request; this standing copy is what the MCP broker turns into tools for an
	// external agent.
	ipcMain.handle('ai:publishCapabilities', (_event, specs: CapabilitySpec[]) => {
		publishedCapabilities = Array.isArray(specs) ? specs : [];
		return publishedCapabilities.length;
	});
	ipcMain.handle('ai:setDataAccess', (_event, level: DataAccessLevel) => {
		if (!DATA_ACCESS_LEVELS.includes(level)) {
			throw new Error(`Unknown data access level "${String(level)}".`);
		}
		return aiSettingsStore.setDataAccess(level);
	});
	ipcMain.handle('ai:chat', async (event, requestId: string, messages: ChatMessage[], activeConnectionId: string | undefined, capabilities: CapabilitySpec[] = [], ambient: AmbientContext = {}) => {
		const controller = new AbortController();
		chatAborts.set(requestId, controller);
		// A run_query approval: ask the renderer and await its reply (resolve false on abort).
		const approve = (sql: string, callId: string, connectionId: string): Promise<boolean> => new Promise((resolve) => {
			const key = `${requestId}:${callId}`;
			pendingApprovals.set(key, resolve);
			controller.signal.addEventListener('abort', () => { if (pendingApprovals.delete(key)) { resolve(false); } }, { once: true });
			event.sender.send('ai:approvalRequest', { requestId, callId, sql, connectionId });
		});
		// A generic mutating-capability approval: same lifecycle as above, but the card shows a
		// "the assistant wants to <summary>" prompt instead of SQL.
		const approveAction = (summary: string, callId: string): Promise<boolean> => new Promise((resolve) => {
			const key = `${requestId}:${callId}`;
			pendingApprovals.set(key, resolve);
			controller.signal.addEventListener('abort', () => { if (pendingApprovals.delete(key)) { resolve(false); } }, { once: true });
			event.sender.send('ai:approvalRequest', { requestId, callId, summary });
		});
		// Run a renderer capability: ask the renderer to execute it and await its result (a
		// cancelled result on abort).
		const invokeClient = (inv: CapabilityInvocation): Promise<CapabilityResult> => new Promise((resolve) => {
			const key = `${requestId}:${inv.id}`;
			pendingCapabilities.set(key, resolve);
			controller.signal.addEventListener('abort', () => { if (pendingCapabilities.delete(key)) { resolve({ ok: false, summary: '', error: 'Cancelled.' }); } }, { once: true });
			event.sender.send('ai:capabilityRequest', { requestId, invocation: inv });
		});
		try {
			const { usage } = await aiService.chat(messages, activeConnectionId, {
				onDelta: (delta) => event.sender.send('ai:chunk', requestId, delta),
				onTool: (toolEvent: AiToolEvent) => event.sender.send('ai:tool', requestId, toolEvent),
				approve,
				approveAction,
				invokeClient,
				capabilities,
				// Dev-only: stream the assembled system prompt to the renderer's debug panel. Gated
				// like the Reload / Toggle Dev Tools menu items so production never ships it.
				onSystemPrompt: app.isPackaged ? undefined : (prompt: string) => event.sender.send('ai:systemPrompt', requestId, prompt),
			}, controller.signal, ambient);
			return { ok: true, usage };
		} catch (err) {
			if (controller.signal.aborted) {
				return { ok: false, aborted: true };
			}
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		} finally {
			chatAborts.delete(requestId);
			// Drop any approvals / capability invocations still pending for this request.
			for (const key of [...pendingApprovals.keys()]) {
				if (key.startsWith(`${requestId}:`)) {
					pendingApprovals.delete(key);
				}
			}
			for (const key of [...pendingCapabilities.keys()]) {
				if (key.startsWith(`${requestId}:`)) {
					pendingCapabilities.delete(key);
				}
			}
		}
	});
	ipcMain.handle('ai:cancel', (_event, requestId: string) => {
		chatAborts.get(requestId)?.abort();
	});
	ipcMain.handle('ai:approvalReply', (_event, requestId: string, callId: string, approved: boolean) => {
		const key = `${requestId}:${callId}`;
		const resolve = pendingApprovals.get(key);
		if (resolve) {
			pendingApprovals.delete(key);
			resolve(approved);
		}
	});
	ipcMain.handle('ai:capabilityReply', (_event, requestId: string, callId: string, result: CapabilityResult) => {
		const key = `${requestId}:${callId}`;
		const resolve = pendingCapabilities.get(key);
		if (resolve) {
			pendingCapabilities.delete(key);
			resolve(result);
		}
	});
	ipcMain.handle('ai:allowConnection', (_event, connectionId: string, allowed: boolean) => aiSettingsStore.setConnectionAutoApprove(connectionId, allowed));
	// Liby, summoned to a screen with no helper of its own.
	ipcMain.handle('ai:liby', async (_event, request: LibyChatRequest): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
		try {
			return { ok: true, text: await aiService.libyChat(request) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	ipcMain.handle('ai:complete', async (_event, params: AiCompletionParams): Promise<AiCompletionResult> => {
		try {
			const { text, id } = await aiService.complete(params.prefix, params.suffix, params.connectionId);
			return { ok: true, text, id };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	// Fire-and-forget: what the user did with a suggestion that was shown. Measurement only, so it
	// never throws back into the editor's inline-completion path.
	ipcMain.on('ai:completionOutcome', (_event, params: AiCompletionOutcomeParams) => {
		try {
			aiService.completionOutcome(params);
		} catch {
			// Never let measurement break the editor.
		}
	});
	ipcMain.handle('ai:edit', async (event, requestId: string, params: AiEditParams): Promise<AiEditResult> => {
		try {
			const text = await aiService.edit(params, (delta) => event.sender.send('ai:editChunk', requestId, delta));
			return { ok: true, text };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	// AI audit log — every LLM interaction (chat, completion, edit), reviewable in Settings.
	ipcMain.handle('audit:list', () => auditStore.list());
	ipcMain.handle('audit:clear', () => auditStore.clear());
	ipcMain.handle('audit:setKinds', (_event, kinds: AiAuditKind[]) => aiService.setAuditKinds(kinds));

	// Auto-update. The renderer drives the initial check (after subscribing) and any
	// manual "Check for Updates"; main streams lifecycle status back over update:status.
	ipcMain.handle('update:check', () => updater.check());
	ipcMain.handle('update:download', () => updater.download());
	// The user explicitly chose "Restart & Update", so skip the close-confirmation dialog:
	// quitAndInstall() triggers app.quit(), and if win.on('close') intercepts it (allowQuit
	// false) to ask for confirmation, macOS Squirrel.Mac never gets the clean terminate it
	// needs and ShipIt silently fails to swap + relaunch (the app just closes, no update).
	ipcMain.handle('update:install', () => {
		installUpdateNow('update:install IPC');
	});

	// App info + opening external links (the About modal and its repo link).
	ipcMain.handle('app:version', () => app.getVersion());
	// About → Third-party licences: the files the build wrote, from the app's own path (never a renderer path).
	ipcMain.handle('app:thirdPartyLicences', () => readThirdPartyLicences(app.getAppPath()));
	ipcMain.handle('app:minimumVersion', (): MinimumVersionState => minimumVersionState);
	// Recolor the OS window chrome (title bar, frame) to match the app's light/dark theme.
	// Without this, the native title bar follows the OS theme, not the one picked in-app.
	ipcMain.handle('app:setNativeTheme', (_event, theme: 'dark' | 'light') => {
		nativeTheme.themeSource = theme;
	});
	// The custom title bar's own colours. The renderer sends
	// the resolved value of its --bg-app / --fg tokens after every theme change, so the NATIVE
	// window buttons on Windows/Linux sit on the same colour as the strip we draw beside them.
	// setTitleBarOverlay throws on a window created without an overlay (macOS), which is not an
	// error here: that platform keeps its traffic lights and has nothing to recolour.
	ipcMain.handle('app:setWindowChrome', (event, color: string, symbolColor: string) => {
		const target = BrowserWindow.fromWebContents(event.sender);
		if (!target) {
			return;
		}
		target.setBackgroundColor(color);
		try {
			target.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
		} catch {
			/* no overlay on this platform */
		}
	});
	// The application menu as data, for the title bar to draw where there is no native menu bar.
	ipcMain.handle('app:menuModel', (): AppMenu[] => menuModel());
	// The menu items only main can perform: Electron roles (undo/zoom/quit and friends). Command
	// items never come back here — the renderer owns those and runs them itself.
	ipcMain.handle('app:menuRole', (event, role: string) => {
		const target = BrowserWindow.fromWebContents(event.sender);
		if (!target) {
			return;
		}
		const contents = target.webContents;
		switch (role) {
			case 'undo': contents.undo(); return;
			case 'redo': contents.redo(); return;
			case 'cut': contents.cut(); return;
			case 'copy': contents.copy(); return;
			case 'paste': contents.paste(); return;
			case 'selectAll': contents.selectAll(); return;
			case 'reload': contents.reload(); return;
			case 'toggleDevTools': contents.toggleDevTools(); return;
			case 'resetZoom': contents.setZoomLevel(0); return;
			case 'zoomIn': contents.setZoomLevel(contents.getZoomLevel() + 0.5); return;
			case 'zoomOut': contents.setZoomLevel(contents.getZoomLevel() - 0.5); return;
			case 'togglefullscreen': target.setFullScreen(!target.isFullScreen()); return;
			case 'minimize': target.minimize(); return;
			case 'zoom': target.isMaximized() ? target.unmaximize() : target.maximize(); return;
			case 'close': target.close(); return;
			case 'quit': app.quit(); return;
			default: {
				const key = role.startsWith('link:') ? role.slice('link:'.length) : '';
				if (key in MENU_LINKS) {
					void openExternalIfAllowed(MENU_LINKS[key as keyof typeof MENU_LINKS]);
				}
				return;
			}
		}
	});
	// Total working-set memory across all of the app's processes (main, renderer, GPU,
	// the SQL server child), summed in bytes — shown in the status bar.
	//
	// It does NOT include a local model, and cannot: that runs in its own process (Ollama, say),
	// possibly on another machine, so a model's memory is reported separately or not at all.
	ipcMain.handle('app:memory', () => {
		let bytes = 0;
		for (const m of app.getAppMetrics()) {
			bytes += m.memory.workingSetSize * 1024;
		}
		return { bytes };
	});
	// The renderer answered the "it keeps running" notice: remember it has been said, and hide the
	// window it was said in. From here on the X hides without asking.
	ipcMain.handle('app:hideToTray', (event) => {
		markTrayNoticeShown();
		BrowserWindow.fromWebContents(event.sender)?.hide();
	});
	// The renderer confirmed quitting in its themed dialog: let the quit through.
	ipcMain.handle('app:quit', () => {
		allowQuit = true;
		app.quit();
	});
	// Crash/error reporting opt-out. `available` is false when no DSN ships, so the renderer can
	// show the control as inert. Toggling takes effect immediately (no restart).
	ipcMain.handle('telemetry:get', () => ({ enabled: telemetryEnabled(), available: telemetryAvailable(), active: telemetryActive() }));
	ipcMain.handle('telemetry:set', (_event, enabled: boolean) => setTelemetryEnabled(enabled));
	ipcMain.handle('gpu:get', () => ({ enabled: hardwareAccelerationEnabled(), autoDisabled: hardwareAccelerationAutoDisabled() }));
	ipcMain.handle('gpu:set', (_event, enabled: boolean) => setHardwareAccelerationEnabled(enabled));
	ipcMain.handle('shell:openExternal', (_event, url: string) => openExternalIfAllowed(url));

	// Account / auth + entitlements. Tokens stay in main; the renderer only ever gets the
	// resolved AuthState. Sign-in opens the system browser and resolves once that's launched;
	// the actual session arrives later via the snoutdata:// redirect (auth:changed push).
	ipcMain.handle('auth:state', () => authStore.state());
	// `workEmail` is only read for the 'sso' provider, whose DOMAIN picks the identity provider.
	ipcMain.handle('auth:signIn', async (event, provider: AuthProviderId, workEmail?: string) => {
		await authStore.signIn(provider, workEmail);
		// Google finishes in-process (the native loopback flow), so unlike the GitHub deep-link
		// path nothing brings the app forward afterwards. Focus our window so the user lands back
		// in the app automatically once sign-in resolves, instead of being left in the browser.
		if (provider === 'google') {
			const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0];
			if (win) {
				if (win.isMinimized()) {
					win.restore();
				}
				win.show();
				win.focus();
			}
		}
	});
	ipcMain.handle('auth:signOut', () => authStore.signOut());
	// Manual re-sync (the "Refresh plan" button): re-read the tier (e.g. just upgraded on the
	// website) AND re-mint the gateway key so newly released models become reachable now. Returns
	// the freshly-resolved state so the renderer can update even if the tier is unchanged; the
	// re-sync also pushes auth:changed via onChange so the live model list reloads.
	ipcMain.handle('auth:refresh', async () => {
		await authStore.resyncEntitlements();
		return authStore.state();
	});

	// Cloud sync of non-secret preferences. The renderer pulls on sign-in (last-write-wins by
	// the blob's own updatedAt) and pushes a debounced blob on change. wipe() is the GDPR/CCPA
	// "delete my synced settings" erasure. All three are no-ops when signed out (store-gated).
	ipcMain.handle('settings:pull', () => settingsSync.pull());
	ipcMain.handle('settings:push', (_event, blob: SettingsBlob) => settingsSync.push(blob));
	ipcMain.handle('settings:wipe', () => settingsSync.wipe());

	// Network proxy (Settings → Network). Lets a user on a
	// managed/corporate network override system proxy resolution and supply proxy credentials.
	ipcMain.handle('proxy:status', () => proxyStatus());
	ipcMain.handle('proxy:save', async (_event, values: ProxyFormValues) => {
		proxyStore.save(values.config, values.password);
		await applyProxy();
		return proxyStatus();
	});
	ipcMain.handle('proxy:test', () => proxyTest());

	// Where saved passwords are sealed. `weak` is the standing fact (Settings shows a line for it);
	// `warn` is whether the one-time notice is still owed on this profile. The e2e scratch profile is
	// never owed it unless a spec asks (SNOUT_E2E_SECRET_WARNING), so a warning card does not sit
	// on top of every Linux spec; the fallback itself runs there exactly as it does for a user.
	ipcMain.handle('secrets:storage', () => {
		const owed = secretsWeak && !weakSecretsWarned(app.getPath('userData'));
		return { weak: secretsWeak, warn: owed && (!e2eUserData || testEnv('SNOUT_E2E_SECRET_WARNING') === '1') };
	});
	ipcMain.handle('secrets:storageWarned', () => {
		markWeakSecretsWarned(app.getPath('userData'));
	});

	// Keyboard shortcuts (Settings → Shortcuts). The renderer reads the resolved bindings and
	// rebinds; on a change we rebuild the app menu (its accelerator hints) and broadcast so the
	// renderer's DOM + Monaco dispatchers pick up the new combos live (no restart).
	ipcMain.handle('keybindings:get', () => keybindingStore.resolved());
	ipcMain.handle('keybindings:set', (_event, id: string, combo: string) => {
		const bindings = keybindingStore.set(id, combo);
		buildMenu();
		broadcast('keybindings:changed', bindings);
		return bindings;
	});
	ipcMain.handle('keybindings:reset', (_event, id?: string) => {
		const bindings = keybindingStore.reset(id);
		buildMenu();
		broadcast('keybindings:changed', bindings);
		return bindings;
	});

	// Snoutbot: the pull-request reviewer running on this machine.
	// A webhook cannot reach a laptop, so the app POLLS the host; everything runs here, over the
	// user's own connections, and the only thing that leaves the machine is the comment their own
	// account posts. GitHub and GitLab both, behind one seam (`review/forge.ts`) — plenty of the
	// companies this is for self-host GitLab. Tokens live in the keychain like a database
	// password, one per host, and never cross IPC.
	ipcMain.handle('review:status', () => reviewService.status());
	ipcMain.handle('review:setToken', (_event, forge: ReviewForge, token: string) => reviewService.setToken(forge, token));
	ipcMain.handle('review:clearToken', (_event, forge: ReviewForge) => {
		reviewService.clearToken(forge);
		return reviewService.status();
	});
	// The GitHub App half: the choice between posting as the person and posting as
	// `snoutbot[bot]`. The private key is read HERE, from a file the user picks, and goes straight
	// into the keychain; it never crosses the bridge in either direction.
	ipcMain.handle('review:setGithubAuth', (_event, auth: 'token' | 'app') => reviewService.setGithubAuth(auth));
	ipcMain.handle('review:setGithubInstallation', (_event, id: number) => {
		reviewService.setGithubInstallation(id);
		return reviewService.status();
	});
	ipcMain.handle('review:chooseGithubApp', async (_event, appId: string) => {
		const picked = await dialog.showOpenDialog({
			title: "Choose the GitHub App's private key",
			properties: ['openFile'],
			filters: [{ name: 'Private key', extensions: ['pem'] }],
		});
		if (picked.canceled || picked.filePaths.length === 0) {
			return { ok: false, error: '' };
		}
		try {
			return await reviewService.setGithubApp(appId, readFileSync(picked.filePaths[0], 'utf8'));
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
	ipcMain.handle('review:setGitlabBaseUrl', (_event, url: string) => {
		reviewService.setGitlabBaseUrl(url);
		return reviewService.status();
	});
	ipcMain.handle('review:setEnabled', (_event, enabled: boolean) => {
		reviewService.setEnabled(enabled);
		return reviewService.status();
	});
	ipcMain.handle('review:setPollSeconds', (_event, seconds: number) => {
		reviewService.setPollSeconds(seconds);
		return reviewService.status();
	});
	ipcMain.handle('review:listRepositories', () => reviewService.listRepositories());
	ipcMain.handle('review:addRepo', (_event, ref: string, forge: ReviewForge = 'github') => reviewService.addRepo(ref, forge));
	ipcMain.handle('review:updateRepo', (_event, id: string, patch: Record<string, unknown>) => {
		reviewService.updateRepo(id, patch);
		return reviewService.status();
	});
	ipcMain.handle('review:removeRepo', (_event, id: string) => {
		reviewService.removeRepo(id);
		return reviewService.status();
	});
	ipcMain.handle('review:pollNow', () => reviewService.pollNow());
	ipcMain.handle('review:reviewPull', (_event, repoId: string, prNumber: number, deep?: boolean, method?: ReviewMethod) =>
		reviewService.reviewPull(repoId, prNumber, deep === true, method));
	ipcMain.handle('review:runs', () => reviewService.list());
	ipcMain.handle('review:approve', (_event, runId: string) => reviewService.approve(runId));
	ipcMain.handle('review:discard', (_event, runId: string) => {
		reviewService.discard(runId);
		return reviewService.list();
	});

	// Local MCP server (credential broker for external agents). The renderer's
	// Settings → Agent access panel reads mcp:status and drives the master switch + per-connection
	// allowlist; the connect snippet (url + token) is surfaced for the user to paste into their client.
	ipcMain.handle('mcp:status', () => mcpStatus());
	ipcMain.handle('mcp:setEnabled', async (_event, enabled: boolean) => {
		mcpStore.setEnabled(enabled);
		if (enabled) {
			await startMcpIfEnabled();
		} else {
			await mcpServer.stop();
		}
		return mcpStatus();
	});
	ipcMain.handle('mcp:setAllowed', (_event, id: string, allowed: boolean) => {
		mcpStore.setAllowed(id, allowed);
		return mcpStatus();
	});
	ipcMain.handle('mcp:setWrites', (_event, id: string, allowed: boolean) => {
		mcpStore.setWriteAllowed(id, allowed);
		return mcpStatus();
	});
	ipcMain.handle('mcp:regenerateToken', () => {
		rotateMcpToken();
		return mcpStatus();
	});
	// The configured port was taken: the person moves the broker to another (which replaces the token).
	ipcMain.handle('mcp:changePort', async (_event, port: number) => {
		await moveMcpPort(port);
		return mcpStatus();
	});
	/** The sign-in handoff switch: may a program on this computer ask to use the signed-in
	 *  account? Off refuses the mint endpoint outright. */
	ipcMain.handle('mcp:setSignInHandoff', (_event, allowed: boolean) => {
		mcpStore.setSignInHandoff(allowed);
		return mcpStatus();
	});
	// The Agent log: queries external agents ran over MCP (separate from the user's query history).
	// The Agent Console. Terminal traffic is high-frequency and
	// fire-and-forget, so write/resize are `on` (send) rather than `handle` (invoke); everything
	// that returns state is an invoke.
	ipcMain.handle('agentConsole:statuses', () => agentConsole.statuses());
	/** Re-probe every agent (Settings, and the panel when it opens): a tool installed while the app
	 *  was running should not need a restart to be noticed. */
	ipcMain.handle('agentConsole:discoverAll', async () => {
		const statuses = await agentConsole.discoverAll();
		broadcast('agentConsole:changed');
		return statuses;
	});
	ipcMain.handle('agentConsole:setEnabled', (_event, kind: string, enabled: boolean) => {
		if (!isAgentKind(kind)) {
			return agentConsole.statuses();
		}
		agentConsoleStore.setEnabled(kind, enabled === true);
		// Switching one off closes its console: leaving an agent running behind a hidden icon is
		// how a process outlives the only thing that could stop it.
		if (!enabled) {
			agentConsole.stop(kind);
		}
		broadcast('agentConsole:changed');
		return agentConsole.statuses();
	});
	/**
	 * Point us at an agent's binary by hand. The last resort behind discovery: an install in a
	 * place no PATH mentions, a second copy the user wants used instead, or a shell whose PATH we
	 * could not read. `path` omitted opens a file dialog; null clears the pin and goes back to PATH.
	 */
	ipcMain.handle('agentConsole:setPath', async (event, kind: string, path?: string | null) => {
		if (!isAgentKind(kind)) {
			return agentConsole.statuses();
		}
		if (typeof path === 'string') {
			// A program path is never taken from the page: it is run as soon as it is pinned, so it
			// has to come from the file dialog below, which only the person answers.
			console.warn('[agent-console] refused a program path that did not come from the file dialog');
			return agentConsole.statuses();
		}
		let chosen: string | undefined;
		if (path === undefined) {
			const win = BrowserWindow.fromWebContents(event.sender);
			const options = {
				title: `Choose the ${AGENTS[kind].label} program`,
				properties: ['openFile' as const],
			};
			const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
			if (result.canceled || result.filePaths.length === 0) {
				return agentConsole.statuses();
			}
			chosen = result.filePaths[0];
		}
		agentConsoleStore.setPinnedPath(kind, path === null ? undefined : chosen);
		// Re-probe at once: the user picked a file and wants to be told there and then whether it
		// is the agent, not on the next launch.
		await agentConsole.discover(kind);
		broadcast('agentConsole:changed');
		return agentConsole.statuses();
	});
	ipcMain.handle('agentConsole:discover', async (_event, kind: string) => {
		if (!isAgentKind(kind)) {
			return null;
		}
		await agentConsole.discover(kind);
		return agentConsole.status(kind);
	});
	ipcMain.handle('agentConsole:attach', (_event, kind: string) => (isAgentKind(kind) ? agentConsole.attach(kind) : null));
	ipcMain.handle('agentConsole:start', async (_event, kind: string, size?: AgentConsoleSize) => {
		if (!isAgentKind(kind)) {
			return null;
		}
		agentConsoleStore.setLastKind(kind);
		return agentConsole.start(kind, size);
	});
	ipcMain.handle('agentConsole:stop', (_event, kind: string) => {
		if (!isAgentKind(kind)) {
			return null;
		}
		agentConsole.stop(kind);
		return agentConsole.status(kind);
	});
	ipcMain.handle('agentConsole:restart', async (_event, kind: string, size?: AgentConsoleSize) => (isAgentKind(kind) ? agentConsole.restart(kind, size) : null));
	ipcMain.on('agentConsole:write', (_event, kind: string, data: string) => {
		if (isAgentKind(kind)) {
			agentConsole.write(kind, data);
		}
	});
	/**
	 * Ctrl+V found an image rather than text on the clipboard.
	 *
	 * Where the image is handed over is the AGENT's decision, not ours, because the point is that
	 * the console behaves like the terminal that agent was written for: Claude Code reads the
	 * clipboard itself and draws `[Image #1]`, so all it wants is its own key (alt+v on Windows,
	 * ctrl+v elsewhere) and it does the rest. An agent with no such key gets the image as a file,
	 * which every one of them can read, and the path is what lands in the prompt.
	 */
	ipcMain.handle('agentConsole:pasteImage', (_event, kind: string): AgentImagePaste => {
		if (!isAgentKind(kind)) {
			return { kind: 'none' };
		}
		const image = clipboard.readImage();
		if (image.isEmpty()) {
			return { kind: 'none' };
		}
		const key = agentImagePasteKey(kind, process.platform);
		if (key) {
			agentConsole.write(kind, key);
			return { kind: 'native' };
		}
		const path = saveClipboardImage(image.toPNG());
		return path ? { kind: 'file', path } : { kind: 'none' };
	});
	ipcMain.on('agentConsole:resize', (_event, kind: string, size: AgentConsoleSize) => {
		if (isAgentKind(kind)) {
			agentConsole.resize(kind, size);
		}
	});
	/** The user answered a sign-in handoff prompt. Anything that is not "allow" is a no. */
	ipcMain.handle('cli:signInReply', (_event, requestId: string, answer: CliSignInAnswer) => {
		pendingCliSignIns.get(requestId)?.(answer === 'allow' ? 'allow' : 'decline');
	});
	ipcMain.handle('agent:approvalReply', (_event, callId: string, answer: AgentApproval) => {
		// An older renderer sent a boolean; anything that is not one of the three words is a no.
		const normalised: AgentApproval = answer === 'always' ? 'always' : answer === 'once' ? 'once' : 'decline';
		pendingAgentApprovals.get(callId)?.(normalised);
	});
	/** Show the user where their agent keeps its settings. We open the folder and stop there: the
	 *  file inside is their tool's, and rewriting it for them is not ours to do. */
	ipcMain.handle('agentConsole:openConfigFolder', async (_event, kind: string) => {
		if (!isAgentKind(kind)) {
			return false;
		}
		const dir = join(homedir(), ...AGENTS[kind].configDir.split('/'));
		// openPath on a folder that does not exist returns an error string rather than throwing;
		// fall back to the home directory so the user still lands somewhere useful.
		const failed = await shell.openPath(dir);
		if (failed) {
			await shell.openPath(homedir());
		}
		return failed === '';
	});
	ipcMain.handle('agentConsole:config', () => agentConsoleStore.config());
	/** The house-rules switch: our tools only, the local DB clients denied, results drawn in the
	 *  app. Takes effect on the agent's NEXT start, since it is launch flags (the panel says so). */
	ipcMain.handle('agentConsole:setRouteDatabase', (_event, route: boolean) => {
		agentConsoleStore.setRouteDatabaseThroughApp(route === true);
		broadcast('agentConsole:changed');
		return agentConsoleStore.config();
	});
	ipcMain.handle('agentConsole:setAllowMutating', (_event, allowed: boolean) => {
		agentConsoleStore.setAllowMutatingCapabilities(allowed === true);
		return agentConsoleStore.config();
	});
	/** Grant or revoke a standing "always allow" for one capability, from Settings. */
	ipcMain.handle('agentConsole:setAutoApprove', (_event, name: string, approved: boolean) => {
		// A destructive or security-relevant action can never be standing-approved, from here
		// either. Taking a grant BACK is always allowed.
		const spec = publishedCapabilities.find((s) => s.name === name);
		if (approved === true && (!spec || asksEveryTime(spec))) {
			return agentConsoleStore.config();
		}
		if (typeof name === 'string' && name.length > 0) {
			agentConsoleStore.setAutoApproved(name, approved === true);
		}
		return agentConsoleStore.config();
	});
	/** The same, for every app-changing action at once (Settings' allow-all / ask-about-all). The
	 *  renderer sends the names it is showing, and only published capabilities are honoured, so a
	 *  stale list cannot grant something that no longer exists. */
	ipcMain.handle('agentConsole:setAutoApproveAll', (_event, names: string[], approved: boolean) => {
		if (Array.isArray(names)) {
			const known = new Set(publishedCapabilities.filter((spec) => spec.mutates && !asksEveryTime(spec)).map((spec) => spec.name));
			agentConsoleStore.setAutoApprovedAll(names.filter((name) => typeof name === 'string' && known.has(name)), approved === true);
		}
		return agentConsoleStore.config();
	});
	ipcMain.handle('agentConsole:clearAutoApprove', () => {
		agentConsoleStore.clearAutoApproved();
		return agentConsoleStore.config();
	});
	/** The app-changing capabilities the renderer has published, so Settings can list what an agent
	 *  is able to ask for rather than only what it has already asked. */
	// Only what CAN be standing-approved: a destructive action is asked about every time, so a
	// tick beside it in Settings would be a promise the gate does not keep.
	ipcMain.handle('agentConsole:mutatingCapabilities', () => publishedCapabilities
		.filter((spec) => spec.mutates && !asksEveryTime(spec))
		.map((spec) => ({ name: spec.name, title: capabilityTitle(spec), description: consentSentence(spec), domain: spec.domain })));

	ipcMain.handle('mcp:logs', () => mcpLogStore.list());
	ipcMain.handle('mcp:logsClear', () => mcpLogStore.clear());
	ipcMain.handle('mcp:logDelete', (_event, id: string) => mcpLogStore.delete(id));
}

// macOS delivers the OAuth deep link through open-url (which can fire before ready).
app.on('open-url', (event, url) => {
	event.preventDefault();
	handleAuthDeepLink(url);
});

if (!app.requestSingleInstanceLock()) {
	// A second launch exists only to forward an OAuth deep link to the first instance (handled
	// there via 'second-instance'); it has nothing to show, so quit at once.
	app.quit();
} else {
	// Register the custom protocol so the browser hands snoutdata:// links back to the app.
	// In dev (unpackaged) Electron must be told which exe + script to relaunch. The scheme is the
	// official app's: a build from the open-source tree never registers it, and signs in over a
	// 127.0.0.1 loopback instead (authStore.returnUrl).
	if (registersAuthProtocol(OFFICIAL_BUILD)) {
		if (process.defaultApp && process.argv.length >= 2) {
			app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [resolve(process.argv[1])]);
		} else {
			app.setAsDefaultProtocolClient(AUTH_PROTOCOL);
		}
	}

	// Windows/Linux hand a deep link to a freshly-spawned second instance; forward it to the
	// running one and focus the window.
	app.on('second-instance', (_event, argv) => {
		// A second launch is also how a user who forgot about the tray asks for the window back:
		// clicking the desktop icon while the app runs hidden lands here.
		showMainWindow();
		handleAuthDeepLink(argv.find((a) => a.startsWith(`${AUTH_PROTOCOL}://`)));
	});

	bootMark('modules-evaluated');
	void app.whenReady().then(async () => {
		bootMark('ready');
		// Before anything below can read or write a secret (the self-check included: it should start
		// the way a real launch does).
		settleSecretStorage();
		// A staged update proving it can start before it replaces this install (selfCheck.ts). Only
		// ever run by the previous version, against a scratch profile; nothing below it runs.
		if (process.argv.includes(SELF_CHECK_FLAG)) {
			app.exit((await runSelfCheck(join(__dirname, '..'), app.getPath('userData'), sqlServer)) ? 0 : 1);
			return;
		}
		// Don't await the server boot before creating the window: `sqlServer.start()` kicks off
		// the child spawn + LSP handshake (the ~0.5-0.8s that used to gate first paint), and
		// every sqlServer request awaits readiness internally, so Monaco loads in parallel with
		// the child's heavy require()s (mysql2/pg/mssql/ssh2).
		void sqlServer.start(join(__dirname, '../server/server.js'));
		// Live schema index: forward the server's schema-changed notifications so the
		// explorer refreshes its cached schema (completion refreshes server-side). Safe to wire
		// before the handshake finishes — it subscribes once the connection is ready.
		sqlServer.onSchemaUpdated((params) => broadcast('schema:changed', params.connectionId));
		// The child dying is the event worth seeing: it used to surface only as a flood of
		// downstream "Connection is closed" errors from whatever the user touched next, which
		// said nothing about the cause. Report it once, from the process that knows why.
		sqlServer.onDied((info) => {
			reportHandled(new Error(`SQL server child died: ${info.reason}`), {
				uptimeMs: info.uptimeMs,
				givingUp: info.givingUp,
				// The child's last words. Without them a death is just "the pipe closed", which
				// names no cause; an uncaught exception's stack only ever exists here.
				stderr: info.stderr,
			});
			// The replacement child inherits none of the dead one's database connections, so the
			// UI's "connected" dots are now lying. Re-probe: the ping lands on the fresh child,
			// comes back not-connected, and the probe's failure path flips the dots off instead
			// of leaving the user to discover it by running a query. Not awaited by design.
			void connections.recheckAll();
		});
		// Arm the hourly update re-check. Registering a timer is all this does at boot; the first
		// check is still the renderer's idle one, so nothing new competes with first paint.
		startUpdateRechecks();

		// Headless self-test of the failure-memory write + read paths (dev only, opt-in). Reuses the
		// real wiring above, then quits — it never opens a window or registers IPC. See
		// src/main/failureMemorySelfTest.ts.
		if (!app.isPackaged && process.env.SNOUT_MEMORY_SELFTEST === '1') {
			const passed = await runFailureMemorySelfTest({ connections, store: failureMemoryStore, failureMemory });
			app.exit(passed ? 0 : 1);
			return;
		}
		// Dev blackbox AI logging + the local tuning endpoint: off unless a DEV run asks for them
		// with SNOUT_AI_DEBUG=1 (aiDebugRequested), and never in a packaged build. setDebugEnabled
		// is instant (a flag), so it stays inline; binding the HTTP endpoint's port is deferred off
		// the boot path below (startup is sacred: it must not gate first paint).
		const aiDebug = aiDebugRequested(app.isPackaged);
		aiService.setDebugEnabled(aiDebug);

		// Headless live, model-in-the-loop failure-memory benchmark (dev only, opt-in). Runs the real
		// assistant + execute + memory wiring over the bench corpus and prints the memory-off vs
		// memory-on repeat-failure number, then quits — it never opens a window. Placed after debug
		// logging is enabled so every model round-trip lands in aiDebug.jsonl (with SNOUT_AI_DEBUG=1). See
		// src/main/failureMemoryBench.ts.
		if (!app.isPackaged && process.env.SNOUT_MEMORY_BENCH === '1') {
			const ok = await runFailureMemoryBench({ connections, store: failureMemoryStore, failureMemory, aiService });
			app.exit(ok ? 0 : 1);
			return;
		}

		// Before any handler or window exists: IPC answers only the app page, no web contents may
		// open a window or attach a webview, and pages get no camera, microphone or devices.
		installIpcSenderGuard(() => APP_PAGE_URL);
		installGlobalWebContentsGuard();
		installDefaultSessionPermissions(APP_PAGE_URL);
		registerIpc();
		buildMenu();
		bootMark('create-window');
		createWindow();

		// Make every outbound call resolve the proxy the same way the system browser does (default),
		// or honor the user's manual proxy override (Settings → Network) on a corporate network where
		// auto-resolution doesn't reach the proxy. Fire-and-forget (resolves in <1ms on the already-
		// ready default session); kept after createWindow so it never gates first paint. Pairs with the
		// auth-* allowlist above and the `login` handler below.
		void applyProxy();

		// Snoutbot's poller, with the rest of the deferred work. It returns immediately unless the
		// user has turned it on, and its first poll is a full interval away — startup is sacred,
		// and a network round-trip racing first paint is exactly what that rule forbids.
		setTimeout(() => reviewService.start(), AI_DEBUG_SERVER_DELAY_MS).unref();

		// Start the dev-only AI tuning endpoint a few seconds after the window is up, like the
		// other deferred startup work — it's a developer convenience, never part of first paint.
		if (aiDebug) {
			setTimeout(() => startAiDebugServer(aiService, connections), AI_DEBUG_SERVER_DELAY_MS).unref();
		}
		// Restore any saved session (and settle the feature gates) after the window exists, so
		// the auth:changed broadcast lands on a live renderer.
		void authStore.init();

		// Sleep → wake almost always orphans the pool's TCP sockets (and any SSH tunnel).
		// Re-probe every live connection right after the OS comes back; the probe's failure
		// path flips the UI's "connected" dot off so the user isn't lied to.
		powerMonitor.on('resume', () => {
			void connections.recheckAll();
			void authStore.onResume();
		});
		// Pause token auto-refresh before sleep so a thawed timer can't fire a refresh into a
		// still-reconnecting network on wake and lose the response, which would trip the auth server's
		// refresh-token reuse detection and revoke the session ("Refresh Token Not Found").
		powerMonitor.on('suspend', () => { void authStore.onSuspend(); });

		// Clicking the Dock icon (macOS) asks for the window back. It normally exists and is merely
		// hidden in the tray; showMainWindow re-creates one in the case where it does not.
		app.on('activate', () => {
			showMainWindow();
		});
	});

	/*
	 * Quitting is now a deliberate act - the tray's Quit, the app menu, Ctrl/Cmd+Q, an update
	 * installing - rather than something the window's close button does, so this is the ONE place
	 * that asks about it. While the window is up, the renderer's themed dialog gets the last word
	 * (it is the only thing that knows about unsaved edits) and calls back via app:quit. With the
	 * window hidden the question would land where nobody could see it, so a quit from the tray goes
	 * straight through - which is what the user just asked for anyway.
	 */
	app.on('before-quit', (event) => {
		if (allowQuit || e2eUserData || installingUpdate) {
			allowQuit = true;
			return;
		}
		const win = mainWindow();
		if (!win || win.isDestroyed() || !win.isVisible() || win.webContents.isCrashed()) {
			allowQuit = true;
			return;
		}
		event.preventDefault();
		win.show();
		win.focus();
		win.webContents.send('app:confirmQuit');
	});

	// By the time every window is closed the app IS quitting: the close button hides instead of
	// closing, so this only runs on the way out. Tear everything down and, on every platform
	// including macOS, finish the quit — an app left alive in the Dock with the SQL server already
	// stopped is a half-dead app whose next window throws "SQL server is not started" at every
	// editor request.
	app.on('window-all-closed', () => {
		teardown();
		// During an auto-update install, do NOT call app.quit(): on macOS that races
		// Squirrel.Mac's install-and-relaunch and the swap silently never runs (ShipIt is
		// registered but never spawned). Let the updater own the termination + relaunch.
		if (installingUpdate) {
			logUpdate('window-all-closed during update: stopped SQL server, NOT calling app.quit() (letting Squirrel/ShipIt drive)');
			return;
		}
		app.quit();
	});
}

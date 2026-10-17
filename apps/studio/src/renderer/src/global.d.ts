/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AppMenu } from '../../shared/menu';
import type { LoadFileChoice, ServerExportOutcome, SqlSyntaxDiagnostic, TableFunctionOutcome } from '../../shared/engine';
import type { CompletionItem, CompletionList, Hover, Position } from 'vscode-languageserver-protocol';
import type { ConnectionConfig, SshTunnelProfile } from '../../shared/connection';
import type { CloudAccountForm, CloudAccountView, CloudContainerList, CloudTestResult, CloudVendor, CloudVendorInfo, ImportableCredential, LogScopeList, LogServiceInfo } from '../../shared/cloud';
import type { ConnectionFormValues, ConnectionsState, DiscoveryOptions, DiscoveryProgress, ImportItemRef, ImportScanResult, ImportSourceId, TunnelProfileFormValues, TunnelProfilesState } from '../../shared/forms';
import type { CloudActionOutcome, CloudCreateForm, CloudCreateOutcome, CloudProjectOp, CloudProjectOps, CloudProjectOutcome, CloudProjectsView } from '../../shared/cloudProjects';
import type { CloudContainers, ContainerBuildForm, ContainerBuildProgress } from '../../shared/cloudContainers';
import type { ProjectActionOutcome, ProjectApiRequest, ProjectApiResponse, ProjectSqlResult, ProjectTarget } from '../../shared/projects';
import type { LocalActionOutcome, LocalActivity, LocalConnectionFacts, LocalCopyTarget, LocalExport, LocalFunctionRow, LocalInstallOutcome, LocalMailKind, LocalMailTemplate, LocalProgress, LocalProjectsView, LocalRequirements, LocalSettings, LocalSettingsChange, LocalSetupForm } from '../../shared/localStack';
import type { AiApprovalRequest, AiAuditEntry, AiAuditKind, AiBudgetStatus, AiChatResult, AiCompletionOutcomeParams, AiCompletionParams, AiCompletionResult, AiEditParams, AiEditResult, AiProviderId, AiProviderStatus, AiSettings, AiSettingsFormValues, AiToolEvent, AmbientContext, ByokProviderId, ChatMessage, ExtractDocumentResult, LibyChatRequest } from '../../shared/ai';
import type { AiCapabilityRequest, CapabilityResult, CapabilitySpec } from '../../shared/capabilities';
import type { AuthProviderId, AuthState } from '../../shared/auth';
import type { QueryHistoryEntry, SavedQuery } from '../../shared/queries';
import type { ChatSession } from '../../shared/chat';
import type { KnowledgeNote } from '../../shared/knowledge';
import type { Monitor, TrendSample } from '../../shared/monitor';
import type { FixId, MoveProgress, MoveRunResult, MoveSpec } from '@snout/move';
import type { MoveConfirmations, MoveRunState, MoveStartOutcome } from '../../shared/move';
import type { MoveCheck, MoveFixOutcome } from '../../shared/move';
import type { ProjectCopyCheck, ProjectCopyProgress, ProjectCopyRequest, ProjectCopyStartOutcome } from '../../shared/projectCopy';
import type { PulseSample, PulseStart, PulseSupport } from '../../shared/orbitPulse';
import type { DbeaverScriptScan, WorkspaceFile, WorkspaceSearchHit } from '../../shared/workspace';
import type { UpdateStatus } from '../../shared/update';
import type { CliSignInAnswer, CliSignInRequest, McpLogEntry, McpStatus } from '../../shared/mcp';
import type { ReviewAppCheck, ReviewForge, ReviewForgeAuth, ReviewMethod, ReviewPollResult, ReviewRepoList, ReviewRun, ReviewStarted, ReviewStatus, ReviewTokenCheck } from '../../shared/review';
import type { AgentActionRequest, AgentApproval, AgentConsoleAttach, AgentConsoleChunk, AgentConsoleConfig, AgentConsoleExit, AgentConsoleSize, AgentConsoleStatus, AgentImagePaste, AgentKind } from '../../shared/agentConsole';
import type { ProxyFormValues, ProxyStatus, ProxyTestResult } from '../../shared/proxy';
import type { ResolvedKeybinding } from '../../shared/keybindings';
import type { ComponentInfo, ComponentInstallProgress, ComponentInstallResult, ComponentRequirement } from '../../shared/components';
import type { XlsxSheet } from '../../shared/export';
import type {
	BulkLoadOutcome,
	ConnectResult,
	RunQueryParams,
	ExecuteQueryResult,
	TranscribeResult,
	GetSchemaResult,
	TestConnectionResult,
} from '../../shared/protocol';
import { type ApplyMigrationResult, type ApplyStatement, type MongoDdl, type MongoWrite, type SchemaDiffResult, type SecurityApplyResult, type SecurityChange, type SecurityPlan, type SecuritySnapshot, type SecuritySupport } from '../../shared/engine';
import type { SyncBlob } from './settingsSync';
import type { MinimumVersionState } from '../../shared/minimumVersion';
import type { QueryProgress } from '../../shared/query';

// Shape of the bridge exposed by the preload script (src/preload/index.ts) on
// `window.sqlApi`. Kept in sync by hand because the preload and renderer build into
// separate bundles.
export interface SqlApi {
	// Connection management.
	state(): Promise<ConnectionsState>;
	saveConnection(form: ConnectionFormValues): Promise<ConnectionConfig>;
	/** The connection form's own save, by the person at it. Only this one confirms an imported
	 *  connection that was held until someone checked where it connects. */
	saveConnectionFromForm(form: ConnectionFormValues): Promise<ConnectionConfig>;
	deleteConnection(id: string): Promise<void>;
	testConnection(form: ConnectionFormValues): Promise<TestConnectionResult>;
	/** Test a saved connection exactly as saved, its secrets resolved in main. */
	testSavedConnection(id: string): Promise<TestConnectionResult>;
	connect(id: string): Promise<ConnectResult>;
	cancelConnect(id: string): Promise<void>;
	disconnect(id: string): Promise<void>;
	refresh(id: string): Promise<ConnectResult>;
	getSchema(id: string): Promise<GetSchemaResult>;
	setIdleTimeout(ms: number): Promise<void>;
	schemaDiff(sourceId: string, targetId: string): Promise<SchemaDiffResult>;
	applyMigration(targetId: string, statements: ApplyStatement[]): Promise<ApplyMigrationResult>;
	securitySupport(connectionId: string): Promise<SecuritySupport>;
	securityRead(connectionId: string): Promise<SecuritySnapshot>;
	securityPlan(connectionId: string, changes: SecurityChange[]): Promise<SecurityPlan>;
	securityApply(connectionId: string, changes: SecurityChange[]): Promise<SecurityApplyResult>;
	importScan(source: ImportSourceId): Promise<ImportScanResult>;
	importBrowse(source: ImportSourceId): Promise<ImportScanResult | null>;
	importApply(source: ImportSourceId, refs: ImportItemRef[]): Promise<number>;
	discoverRun(options: DiscoveryOptions): Promise<ImportScanResult[]>;
	onDiscoverProgress(handler: (progress: DiscoveryProgress) => void): () => void;
	cloudProjects(): Promise<CloudProjectsView>;
	cloudAsk(action: 'pause' | 'resume', ref: string): Promise<CloudActionOutcome>;
	cloudCreate(form: CloudCreateForm): Promise<CloudCreateOutcome>;
	cloudDelete(ref: string): Promise<CloudActionOutcome>;
	/** The connection for one cloud project, added first if there is none. Its id, or null. */
	cloudEnsureConnection(ref: string): Promise<string | null>;
	/** A cloud project was asked to change somewhere other than the panel (the tray). */
	onCloudChanged(handler: (ref: string) => void): () => void;
	project: {
		sql(target: ProjectTarget, sql: string): Promise<ProjectSqlResult>;
		api(target: ProjectTarget, request: ProjectApiRequest): Promise<ProjectApiResponse>;
		upload(target: ProjectTarget, bucket: string, prefix: string, upsert: boolean): Promise<ProjectActionOutcome | null>;
		uploadDropped(target: ProjectTarget, bucket: string, prefix: string, upsert: boolean, files: File[]): Promise<ProjectActionOutcome | null>;
		download(target: ProjectTarget, bucket: string, path: string): Promise<ProjectActionOutcome | null>;
	};
	local: {
		requirements(): Promise<LocalRequirements>;
		startEngine(): Promise<LocalActionOutcome>;
		defaults(name: string): Promise<{ folder: string; apiPort: number; dbPort: number }>;
		portsInUse(ports: number[]): Promise<number[]>;
		pickFolder(current: string): Promise<string | null>;
		list(): Promise<LocalProjectsView>;
		install(form: LocalSetupForm, installId: string): Promise<LocalInstallOutcome>;
		start(id: string): Promise<LocalActionOutcome>;
		stop(id: string): Promise<LocalActionOutcome>;
		remove(id: string, options: { deleteData: boolean; deleteFolder: boolean }): Promise<LocalActionOutcome>;
		logs(id: string, service: string | null): Promise<string>;
		facts(id: string): Promise<LocalConnectionFacts>;
		copy(id: string, target: LocalCopyTarget): Promise<LocalActionOutcome>;
		openFolder(id: string, sub?: string): Promise<void>;
		functions(id: string): Promise<LocalFunctionRow[]>;
		newFunction(id: string, name: string): Promise<LocalActionOutcome>;
		deployFunctions(id: string): Promise<LocalActionOutcome>;
		settings(id: string): Promise<LocalSettings>;
		dataApi(id: string): Promise<{ on: boolean; switchable: boolean }>;
		setDataApi(id: string, on: boolean): Promise<LocalActionOutcome>;
		saveSettings(id: string, change: LocalSettingsChange): Promise<LocalActionOutcome>;
		activity(id: string): Promise<LocalActivity[]>;
		resetPassword(id: string): Promise<LocalActionOutcome>;
		rotateKeys(id: string): Promise<LocalActionOutcome>;
		setProduction(id: string, on: boolean): Promise<LocalActionOutcome>;
		exports(id: string): Promise<LocalExport[]>;
		exportNow(id: string): Promise<LocalActionOutcome>;
		openExports(id: string): Promise<void>;
		restore(id: string, name: string): Promise<LocalActionOutcome>;
		mailTemplates(id: string): Promise<LocalMailTemplate[]>;
		saveMailTemplate(id: string, kind: LocalMailKind, template: { subject: string; body: string } | null): Promise<LocalActionOutcome>;
		functionSecrets(id: string): Promise<string[]>;
		setFunctionSecret(id: string, name: string, value: string | null): Promise<LocalActionOutcome>;
		openUrl(url: string): Promise<void>;
		onProgress(handler: (progress: LocalProgress) => void): () => void;
	};
	cloudProject<K extends CloudProjectOp>(op: K, args: CloudProjectOps[K]['args']): Promise<CloudProjectOutcome<CloudProjectOps[K]['result']>>;
	cloudContainers: {
		pickFolder(): Promise<string | null>;
		build(ref: string, form: ContainerBuildForm, buildId: string): Promise<CloudProjectOutcome<CloudContainers>>;
		onProgress(handler: (progress: ContainerBuildProgress) => void): () => void;
	};
	onConnectionsChanged(handler: () => void): () => void;
	onSchemaChanged(handler: (connectionId: string) => void): () => void;

	// Orbit Pulse 3b: the database's OWN activity. Opt-in, per dialect, sampled in main at
	// background priority. The Orbit tab starts it and MUST stop it on close.
	orbitPulseSupported(connectionId: string): Promise<PulseSupport>;
	orbitPulseStart(connectionId: string, intervalMs?: number): Promise<PulseStart>;
	orbitPulseStop(connectionId: string): Promise<void>;
	orbitPulseStatus(connectionId: string): Promise<string | null>;
	onOrbitPulse(handler: (connectionId: string, samples: PulseSample[]) => void): () => void;
	onOrbitPulseStatus(handler: (connectionId: string, error: string | null) => void): () => void;
	componentsStatus(): Promise<ComponentInfo[]>;
	componentsRequiredFor(driver: string): Promise<ComponentRequirement | null>;
	componentsAcceptTerms(ids: string[]): Promise<void>;
	componentsInstallFor(driver: string): Promise<ComponentInstallResult>;
	onComponentProgress(handler: (progress: ComponentInstallProgress) => void): () => void;
	tunnelsState(): Promise<TunnelProfilesState>;
	saveTunnel(form: TunnelProfileFormValues): Promise<SshTunnelProfile>;
	deleteTunnel(id: string): Promise<void>;
	onTunnelsChanged(handler: () => void): () => void;

	// Query execution.
	execute(params: RunQueryParams): Promise<ExecuteQueryResult>;
	explain(params: { connectionId: string; sql: string }): Promise<ExecuteQueryResult>;
	transcribe(params: { connectionId: string; sql: string; allowAiTranscribe?: boolean }): Promise<TranscribeResult>;
	executeScript(params: { connectionId: string; statements: string[] }): Promise<ExecuteQueryResult>;
	executeWrites(params: { connectionId: string; writes: MongoWrite[] }): Promise<ExecuteQueryResult>;
	executeMongoDdl(params: { connectionId: string; ops: MongoDdl[] }): Promise<ExecuteQueryResult>;
	/** Pick (or describe) a file to load into a table. Null when cancelled or unsupported. */
	chooseLoadFile(params: { connectionId: string; path?: string }): Promise<LoadFileChoice | null>;
	/** Ask a table function for its columns, a preview, or a table made from it (ClickHouse). */
	tableFunction(params: { connectionId: string; functionId: string; values: Record<string, string>; accountId?: string; action: 'describe' | 'preview' | 'import'; limit?: number; target?: { database?: string; table: string; orderBy: string[] } }): Promise<TableFunctionOutcome>;
	/** Have the server write a whole result to a file, in one of its own formats. */
	exportServerSide(params: { connectionId: string; sql: string; formatId: string; suggestedName?: string }): Promise<ServerExportOutcome>;
	/** Load that file into the table, at the engine's own speed (ClickHouse only, today). */
	bulkLoad(params: { connectionId: string; schema?: string; table: string; formatId: string; filePath: string; columns?: string[] }): Promise<BulkLoadOutcome>;
	cancelQuery(connectionId: string): Promise<void>;
	/** How far the query running on a connection has got, or null (ClickHouse only, today). */
	queryProgress(connectionId: string): Promise<QueryProgress | null>;

	// Query history + saved queries.
	history(): Promise<QueryHistoryEntry[]>;
	clearHistory(): Promise<void>;
	savedQueries(): Promise<SavedQuery[]>;
	saveQuery(name: string, sql: string): Promise<void>;
	deleteQuery(name: string): Promise<void>;

	// Copying a whole project between this computer and SnoutData Cloud (shared/projectCopy.ts).
	projectCopy: {
		check(request: ProjectCopyRequest): Promise<ProjectCopyCheck>;
		start(request: ProjectCopyRequest, typed?: string): Promise<ProjectCopyStartOutcome>;
		cancel(id: string): Promise<boolean>;
		state(id: string): Promise<ProjectCopyProgress | null>;
		onProgress(handler: (progress: ProjectCopyProgress) => void): () => void;
	};

	// Moving a database.
	moves: {
		list(): Promise<MoveSpec[]>;
		save(spec: MoveSpec): Promise<MoveSpec>;
		remove(id: string): Promise<void>;
		check(spec: MoveSpec): Promise<MoveCheck>;
		fix(spec: MoveSpec, key: string, fix: FixId): Promise<MoveFixOutcome>;
		run(spec: MoveSpec, typed: MoveConfirmations): Promise<MoveStartOutcome>;
		cancel(runId: string): Promise<boolean>;
		installTools(): Promise<ComponentInstallResult>;
		runState(moveId: string): Promise<MoveRunState>;
		onProgress(handler: (progress: MoveProgress) => void): () => void;
		onFinished(handler: (result: MoveRunResult) => void): () => void;
		onChanged(handler: (id: string) => void): () => void;
	};

	// Monitors (live DB monitors).
	monitors: {
		list(): Promise<Monitor[]>;
		save(monitor: Monitor): Promise<void>;
		remove(id: string): Promise<void>;
		samples(widgetId: string, sinceMs?: number): Promise<TrendSample[]>;
		runWidget(connectionId: string, sql: string): Promise<ExecuteQueryResult>;
		status(widgetId: string): Promise<string | null>;
		onSample(handler: (widgetId: string, samples: TrendSample[]) => void): () => void;
		onStatus(handler: (widgetId: string, error: string | null) => void): () => void;
		/** The monitor set changed (by anyone, including an agent over MCP); returns an unsubscribe. */
		onChanged(handler: () => void): () => void;
	};

	// Saved cloud accounts. An account is a VENDOR credential; which of its services is used is
	// named by what uses it. Note what is absent: nothing returns a stored secret, so there is no
	// handler to get wrong.
	cloud: {
		vendors(): Promise<CloudVendorInfo[]>;
		list(): Promise<CloudAccountView[]>;
		save(form: CloudAccountForm): Promise<CloudAccountView>;
		remove(id: string): Promise<void>;
		test(form: CloudAccountForm): Promise<CloudTestResult>;
		importable(vendor: CloudVendor): Promise<ImportableCredential[]>;
		containers(form: CloudAccountForm): Promise<CloudContainerList>;
		containersFor(accountId: string): Promise<CloudContainerList>;
		/** The LOG half of the same accounts. */
		logServices(): Promise<LogServiceInfo[]>;
		logScopesFor(params: { accountId: string; region: string }): Promise<LogScopeList>;
	};

	// Data Flows (Source → Transforms → Sink).
	/** The tray's Pause Scheduled Flows switch (all background work: flows and reviews). */
	schedules: {
		paused(): Promise<boolean>;
		setPaused(paused: boolean): Promise<boolean>;
	};
	/** Data Flows' IPC, one generic bridge (its typed API is in its own renderer half);
	 *  only Data Flows' channels pass. */
	pro: {
		invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
		on(channel: string, listener: (...args: never[]) => void): () => void;
		pathForFile(file: File): string;
	};

	// Assistant chat history.
	chatSessions(): Promise<ChatSession[]>;
	saveChatSession(session: ChatSession): Promise<void>;
	deleteChatSession(id: string): Promise<void>;
	clearChatSessions(): Promise<void>;

	// Per-connection knowledge base.
	knowledgeNotes(connectionId: string): Promise<KnowledgeNote[]>;
	saveKnowledgeNote(note: KnowledgeNote): Promise<KnowledgeNote>;
	deleteKnowledgeNote(id: string): Promise<void>;
	setKnowledgeNoteEnabled(id: string, enabled: boolean): Promise<void>;
	suggestedKnowledgeNotes(connectionId: string): Promise<KnowledgeNote[]>;
	approveKnowledgeNote(id: string): Promise<void>;
	dismissKnowledgeNote(id: string): Promise<void>;
	observeKnowledge(connectionId: string, messages: ChatMessage[]): Promise<KnowledgeNote | null>;
	draftKnowledgeNote(connectionId: string | undefined, messages: ChatMessage[], hint: string | undefined): Promise<string>;

	// Workspace files (a folder of .sql scripts on disk).
	workspace: {
		root(): Promise<string>;
		setRoot(): Promise<string | null>;
		list(): Promise<WorkspaceFile[]>;
		read(path: string): Promise<string>;
		save(path: string, content: string): Promise<WorkspaceFile>;
		create(name: string, content?: string): Promise<WorkspaceFile>;
		rename(path: string, newName: string): Promise<WorkspaceFile>;
		remove(path: string): Promise<void>;
		search(query: string): Promise<WorkspaceSearchHit[]>;
		importFile(): Promise<WorkspaceFile[] | null>;
		importPaths(paths: string[]): Promise<WorkspaceFile[]>;
		dbeaverScripts(): Promise<DbeaverScriptScan>;
		dbeaverPickFolder(): Promise<DbeaverScriptScan | null>;
	};

	// File open/save (.sql).
	openFile(): Promise<{ path: string; content: string } | null>;
	pickFilePath(): Promise<string | null>;
	saveFile(path: string | null, content: string): Promise<string | null>;
	exportData(defaultName: string, content: string): Promise<string | null>;
	exportXlsx(defaultName: string, sheet: XlsxSheet): Promise<string | null>;
	saveChart(defaultName: string, format: 'png' | 'svg' | 'csv', data: string): Promise<string | null>;

	// Editor language features.
	didOpen(uri: string, text: string, version: number): Promise<void>;
	didChange(uri: string, version: number, text: string): Promise<void>;
	completion(uri: string, position: Position, connectionId?: string): Promise<CompletionList>;
	completionResolve(item: CompletionItem): Promise<CompletionItem>;
	hover(uri: string, position: Position, connectionId?: string): Promise<Hover | null>;
	syntaxDiagnostics(text: string): Promise<SqlSyntaxDiagnostic[]>;

	// AI assistant.
	aiSettings(): Promise<AiSettings>;
	saveAiSettings(values: AiSettingsFormValues): Promise<AiSettings>;
	aiTest(): Promise<{ ok: boolean; message: string }>;
	aiProviderStatus(): Promise<AiProviderStatus[]>;
	aiBudgetStatus(): Promise<AiBudgetStatus | null>;
	aiCreditsEnabled(): Promise<boolean>;
	aiSetCreditsEnabled(enabled: boolean): Promise<void>;
	aiSetModelEnabled(key: string, enabled: boolean): Promise<AiSettings>;
	aiOllamaModels(endpoint: string): Promise<string[]>;
	aiByokModels(provider: ByokProviderId): Promise<string[]>;
	aiSetActive(provider: AiProviderId, model: string): Promise<AiSettings>;

	aiSetDataAccess(level: NonNullable<AiSettings['dataAccess']>): Promise<AiSettings>;
	aiChat(requestId: string, messages: ChatMessage[], activeConnectionId: string | undefined, capabilities?: CapabilitySpec[], ambient?: AmbientContext): Promise<AiChatResult>;
	aiPickDocument(): Promise<ExtractDocumentResult | null>;
	cancelChat(requestId: string): Promise<void>;
	respondToolApproval(requestId: string, callId: string, approved: boolean): Promise<void>;
	publishCapabilities(specs: CapabilitySpec[]): Promise<number>;
	respondCapability(requestId: string, callId: string, result: CapabilityResult): Promise<void>;
	setConnectionAutoApprove(connectionId: string, allowed: boolean): Promise<AiSettings>;
	aiAuditLog(): Promise<AiAuditEntry[]>;
	clearAiAuditLog(): Promise<void>;
	setAuditKinds(kinds: AiAuditKind[]): Promise<void>;
	/** Liby's help for a screen with no helper of its own: the screen as labelled facts in, one line out. */
	aiLiby(request: LibyChatRequest): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
	aiComplete(params: AiCompletionParams): Promise<AiCompletionResult>;
	/** Report what the user did with a shown completion; one-way, never awaited. */
	aiCompletionOutcome(params: AiCompletionOutcomeParams): void;
	aiEdit(requestId: string, params: AiEditParams): Promise<AiEditResult>;
	onAiChunk(handler: (requestId: string, delta: string) => void): () => void;
	onAiEditChunk(handler: (requestId: string, delta: string) => void): () => void;
	onAiTool(handler: (requestId: string, event: AiToolEvent) => void): () => void;
	/** Dev-only: the assembled system prompt for the active chat request (fires only in unpackaged builds). */
	onAiSystemPrompt(handler: (requestId: string, prompt: string) => void): () => void;
	onAiApprovalRequest(handler: (request: AiApprovalRequest) => void): () => void;
	onAiCapabilityRequest(handler: (request: AiCapabilityRequest) => void): () => void;

	// Auto-update.
	checkForUpdate(): Promise<void>;
	downloadUpdate(): Promise<void>;
	installUpdate(): Promise<void>;
	onUpdateStatus(handler: (status: UpdateStatus) => void): () => void;

	// App info + external links (About modal).
	appVersion(): Promise<string>;
	/** Studio's NOTICE and the third-party licences the build wrote; null for a file the build did not write. */
	thirdPartyLicences(): Promise<{ notice: string | null; licences: string | null }>;
	/** Whether this version is below the minimum the backend supports. */
	minimumVersion(): Promise<MinimumVersionState>;
	onMinimumVersion(handler: (state: MinimumVersionState) => void): () => void;
	setNativeTheme(theme: 'dark' | 'light'): Promise<void>;
	/** The custom title bar: the colours for the native window-control overlay, the
	 *  application menu as data to draw, and the menu items only main can perform. */
	setWindowChrome(color: string, symbolColor: string): Promise<void>;
	menuModel(): Promise<AppMenu[]>;
	menuRole(role: string): Promise<void>;
	appMemory(): Promise<{ bytes: number }>;
	openExternal(url: string): Promise<void>;
	getTelemetry(): Promise<{ enabled: boolean; available: boolean; active: boolean }>;
	setTelemetry(enabled: boolean): Promise<boolean>;
	getGpu(): Promise<{ enabled: boolean; autoDisabled: boolean }>;
	/** Applies on the next launch: Electron fixes the GPU decision before `ready`. */
	setGpu(enabled: boolean): Promise<boolean>;
	confirmQuit(): Promise<void>;
	onConfirmQuit(handler: () => void): () => void;
	/** Answer the one-time tray notice: hide the window, and never ask again. */
	hideToTray(): Promise<void>;
	/** Fires the first time the window is closed, so the app can say it keeps running. */
	onHideNotice(handler: () => void): () => void;
	authState(): Promise<AuthState>;
	/** `workEmail` is read only for the 'sso' provider: its domain picks the identity provider. */
	authSignIn(provider: AuthProviderId, workEmail?: string): Promise<void>;
	authSignOut(): Promise<void>;
	authRefresh(): Promise<AuthState>;
	settingsSync: {
		pull(): Promise<SyncBlob | null>;
		push(blob: SyncBlob): Promise<void>;
		wipe(): Promise<void>;
	};
	onAuthChanged(handler: (state: AuthState) => void): () => void;
	onMenuCommand(handler: (commandId: string) => void): () => void;

	// Network proxy (Settings → Network).
	proxy: {
		status(): Promise<ProxyStatus>;
		save(values: ProxyFormValues): Promise<ProxyStatus>;
		test(): Promise<ProxyTestResult>;
	};

	// Where saved passwords are sealed (`weak`: a Linux desktop with no password vault).
	secretStorage: {
		status(): Promise<{ weak: boolean; warn: boolean }>;
		warned(): Promise<void>;
	};

	// Keyboard shortcuts (Settings → Shortcuts — shared/keybindings.ts is the source of truth).
	keybindings: {
		get(): Promise<ResolvedKeybinding[]>;
		set(id: string, combo: string): Promise<ResolvedKeybinding[]>;
		reset(id?: string): Promise<ResolvedKeybinding[]>;
		onChanged(handler: (bindings: ResolvedKeybinding[]) => void): () => void;
	};

	// The Agent Console: the user's own coding agent, run inside the app.
	agentConsole: {
		statuses(): Promise<AgentConsoleStatus[]>;
		discover(kind: AgentKind): Promise<AgentConsoleStatus | null>;
		discoverAll(): Promise<AgentConsoleStatus[]>;
		setEnabled(kind: AgentKind, enabled: boolean): Promise<AgentConsoleStatus[]>;
		setPath(kind: AgentKind, path?: string | null): Promise<AgentConsoleStatus[]>;
		onChanged(handler: () => void): () => void;
		attach(kind: AgentKind): Promise<AgentConsoleAttach | null>;
		start(kind: AgentKind, size?: AgentConsoleSize): Promise<AgentConsoleStatus | null>;
		stop(kind: AgentKind): Promise<AgentConsoleStatus | null>;
		restart(kind: AgentKind, size?: AgentConsoleSize): Promise<AgentConsoleStatus | null>;
		write(kind: AgentKind, data: string): void;
		pasteImage(kind: AgentKind): Promise<AgentImagePaste>;
		resize(kind: AgentKind, size: AgentConsoleSize): void;
		config(): Promise<AgentConsoleConfig>;
		openConfigFolder(kind: AgentKind): Promise<boolean>;
		setAllowMutating(allowed: boolean): Promise<AgentConsoleConfig>;
		/** The house-rules switch (our tools only, DB clients denied, results drawn in the app).
		 *  Applies to the agent's next start: these are launch flags. */
		setRouteDatabase(route: boolean): Promise<AgentConsoleConfig>;
		onApprovalRequest(handler: (request: AgentActionRequest) => void): () => void;
		respondApproval(callId: string, answer: AgentApproval): Promise<void>;
		setAutoApprove(name: string, approved: boolean): Promise<AgentConsoleConfig>;
		setAutoApproveAll(names: string[], approved: boolean): Promise<AgentConsoleConfig>;
		clearAutoApprove(): Promise<AgentConsoleConfig>;
		mutatingCapabilities(): Promise<Array<{ name: string; title: string; description: string; domain: string }>>;
		onActing(handler: (state: { acting: boolean; name?: string }) => void): () => void;
		onData(handler: (chunk: AgentConsoleChunk) => void): () => void;
		onExit(handler: (exit: AgentConsoleExit) => void): () => void;
	};

	// Snoutbot: the pull-request reviewer running on this machine. The GitHub token stays in
	// the keychain in main; only its existence crosses this bridge.
	review: {
		status(): Promise<ReviewStatus>;
		setToken(forge: ReviewForge, token: string): Promise<ReviewTokenCheck>;
		clearToken(forge: ReviewForge): Promise<ReviewStatus>;
		setGithubAuth(auth: ReviewForgeAuth): Promise<ReviewStatus>;
		setGithubInstallation(id: number): Promise<ReviewStatus>;
		chooseGithubApp(appId: string): Promise<ReviewAppCheck>;
		setGitlabBaseUrl(url: string): Promise<ReviewStatus>;
		setEnabled(enabled: boolean): Promise<ReviewStatus>;
		setPollSeconds(seconds: number): Promise<ReviewStatus>;
		listRepositories(): Promise<ReviewRepoList>;
		addRepo(ref: string, forge?: ReviewForge): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
		updateRepo(id: string, patch: Record<string, unknown>): Promise<ReviewStatus>;
		removeRepo(id: string): Promise<ReviewStatus>;
		pollNow(): Promise<ReviewPollResult>;
		/** `method` reviews it again on a different rung, for this run only. */
		reviewPull(repoId: string, prNumber: number, deep?: boolean, method?: ReviewMethod): Promise<ReviewRun | undefined>;
		runs(): Promise<ReviewRun[]>;
		approve(runId: string): Promise<{ ok: boolean; error?: string }>;
		discard(runId: string): Promise<ReviewRun[]>;
	};
	onReviewChanged(handler: (status: ReviewStatus) => void): () => void;
	onReviewRun(handler: (run: ReviewRun) => void): () => void;
	onReviewStarted(handler: (started: ReviewStarted) => void): () => void;

	// Local MCP server (credential broker for external agents).
	mcp: {
		status(): Promise<McpStatus>;
		setEnabled(enabled: boolean): Promise<McpStatus>;
		setAllowed(id: string, allowed: boolean): Promise<McpStatus>;
		setWrites(id: string, allowed: boolean): Promise<McpStatus>;
		regenerateToken(): Promise<McpStatus>;
		changePort(port: number): Promise<McpStatus>;
		/** The token was rotated by the app itself; returns an unsubscribe. */
		onChanged(handler: () => void): () => void;
		/** The sign-in handoff: may a program on this computer ask to use the signed-in account? */
		setSignInHandoff(allowed: boolean): Promise<McpStatus>;
		onSignInRequest(handler: (request: CliSignInRequest) => void): () => void;
		respondSignIn(requestId: string, answer: CliSignInAnswer): Promise<void>;
		logs(): Promise<McpLogEntry[]>;
		logsClear(): Promise<void>;
		logDelete(id: string): Promise<void>;
	};
}

declare global {
	interface Window {
		sqlApi: SqlApi;
	}
}

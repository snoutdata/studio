/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { CompletionItem, CompletionList, Hover, Position } from 'vscode-languageserver-protocol';

import type { AppMenu } from '../shared/menu';
import type { LoadFileChoice, ServerExportOutcome, SqlSyntaxDiagnostic, TableFunctionOutcome } from '../shared/engine';
import type { ConnectionConfig, SshTunnelProfile } from '../shared/connection';
import type { CloudAccountForm, CloudAccountView, CloudContainerList, CloudTestResult, CloudVendor, CloudVendorInfo, ImportableCredential, LogScopeList, LogServiceInfo } from '../shared/cloud';
import type { ConnectionFormValues, ConnectionsState, DiscoveryOptions, DiscoveryProgress, ImportItemRef, ImportScanResult, ImportSourceId, TunnelProfileFormValues, TunnelProfilesState } from '../shared/forms';
import type { CloudActionOutcome, CloudCreateForm, CloudCreateOutcome, CloudProjectOp, CloudProjectOps, CloudProjectOutcome, CloudProjectsView } from '../shared/cloudProjects';
import type { CloudContainers, ContainerBuildForm, ContainerBuildProgress } from '../shared/cloudContainers';
import type { ProjectActionOutcome, ProjectApiRequest, ProjectApiResponse, ProjectSqlResult, ProjectTarget } from '../shared/projects';
import type { LocalActionOutcome, LocalActivity, LocalConnectionFacts, LocalCopyTarget, LocalExport, LocalFunctionRow, LocalInstallOutcome, LocalMailKind, LocalMailTemplate, LocalProgress, LocalProjectsView, LocalRequirements, LocalSettings, LocalSettingsChange, LocalSetupForm } from '../shared/localStack';
import type { AiApprovalRequest, AiAuditEntry, AiAuditKind, AiBudgetStatus, AiChatResult, AiCompletionOutcomeParams, AiCompletionParams, AiCompletionResult, AiEditParams, AiEditResult, AiProviderId, AiProviderStatus, AiSettings, AiSettingsFormValues, AiToolEvent, AmbientContext, ByokProviderId, ChatMessage, ExtractDocumentResult, LibyChatRequest } from '../shared/ai';
import type { AiCapabilityRequest, CapabilityResult, CapabilitySpec } from '../shared/capabilities';
import type { AgentActionRequest, AgentApproval, AgentConsoleAttach, AgentConsoleChunk, AgentConsoleConfig, AgentConsoleExit, AgentConsoleSize, AgentConsoleStatus, AgentImagePaste, AgentKind } from '../shared/agentConsole';
import type { AuthProviderId, AuthState } from '../shared/auth';
import type { QueryHistoryEntry, SavedQuery } from '../shared/queries';
import type { ChatSession } from '../shared/chat';
import type { KnowledgeNote } from '../shared/knowledge';
import type { Monitor, TrendSample } from '../shared/monitor';
import type { FixId, MoveProgress, MoveRunResult, MoveSpec } from '@snout/move';
import type { MoveConfirmations, MoveRunState, MoveStartOutcome } from '../shared/move';
import type { MoveCheck, MoveFixOutcome } from '../shared/move';
import type { ProjectCopyCheck, ProjectCopyProgress, ProjectCopyRequest, ProjectCopyStartOutcome } from '../shared/projectCopy';
import type { PulseSample, PulseStart, PulseSupport } from '../shared/orbitPulse';
import type { DbeaverScriptScan, WorkspaceFile, WorkspaceSearchHit } from '../shared/workspace';
import type { UpdateStatus } from '../shared/update';
import type { MinimumVersionState } from '../shared/minimumVersion';
import type { CliSignInAnswer, CliSignInRequest, McpLogEntry, McpStatus } from '../shared/mcp';
import type { ReviewAppCheck, ReviewForge, ReviewForgeAuth, ReviewMethod, ReviewPollResult, ReviewRepoList, ReviewRun, ReviewStarted, ReviewStatus, ReviewTokenCheck } from '../shared/review';
import type { ProxyFormValues, ProxyStatus, ProxyTestResult } from '../shared/proxy';
import type { ResolvedKeybinding } from '../shared/keybindings';
import type { ComponentInfo, ComponentInstallProgress, ComponentInstallResult, ComponentRequirement } from '../shared/components';
import type { XlsxSheet } from '../shared/export';
import type {
	BulkLoadOutcome,
	ConnectResult,
	RunQueryParams,
	ExecuteQueryResult,
	GetSchemaResult,
	TestConnectionResult,
	TranscribeResult,
} from '../shared/protocol';
import { type ApplyMigrationResult, type ApplyStatement, type MongoDdl, type MongoWrite, type SchemaDiffResult, type SecurityApplyResult, type SecurityChange, type SecurityPlan, type SecuritySnapshot, type SecuritySupport } from '../shared/engine';
import type { QueryProgress } from '../shared/query';

// The renderer never touches Node, the LSP transport, or the keychain directly; it
// calls these thin wrappers, which `ipcRenderer.invoke` into the main process.

/** The channels the `pro` bridge may reach: Data Flows' own, and nothing of the shell's. */
const PRO_CHANNEL = /^(flow|learn|distill):|^app:neuralMemory$/;

function assertProChannel(channel: string): void {
	if (!PRO_CHANNEL.test(channel)) {
		throw new Error(`Not a Data Flows channel: ${channel}`);
	}
}

const sqlApi = {
	// Connection management.
	state: (): Promise<ConnectionsState> => ipcRenderer.invoke('connections:state'),
	saveConnection: (form: ConnectionFormValues): Promise<ConnectionConfig> => ipcRenderer.invoke('connections:save', form),
	// The connection FORM's save, by the person at it: the only save that confirms an imported
	// connection held until someone looked at it. Capabilities use saveConnection above.
	saveConnectionFromForm: (form: ConnectionFormValues): Promise<ConnectionConfig> => ipcRenderer.invoke('connections:saveFromForm', form),
	deleteConnection: (id: string): Promise<void> => ipcRenderer.invoke('connections:delete', id),
	testConnection: (form: ConnectionFormValues): Promise<TestConnectionResult> => ipcRenderer.invoke('connections:test', form),
	/** Test a saved connection as saved (secrets resolved in main). */
	testSavedConnection: (id: string): Promise<TestConnectionResult> => ipcRenderer.invoke('connections:testSaved', id),
	connect: (id: string): Promise<ConnectResult> => ipcRenderer.invoke('connections:connect', id),
	/** Cancel a slow connect the user gave up on (best-effort; frees the UI immediately). */
	cancelConnect: (id: string): Promise<void> => ipcRenderer.invoke('connections:cancelConnect', id),
	disconnect: (id: string): Promise<void> => ipcRenderer.invoke('connections:disconnect', id),
	refresh: (id: string): Promise<ConnectResult> => ipcRenderer.invoke('connections:refresh', id),
	getSchema: (id: string): Promise<GetSchemaResult> => ipcRenderer.invoke('connections:getSchema', id),
	/** Set the idle auto-disconnect window in ms (0 disables). */
	setIdleTimeout: (ms: number): Promise<void> => ipcRenderer.invoke('connections:setIdleTimeout', ms),
	/** Schema sync: compute the migration that morphs target's schema into source's. */
	schemaDiff: (sourceId: string, targetId: string): Promise<SchemaDiffResult> => ipcRenderer.invoke('schema:diff', sourceId, targetId),
	/** Schema sync: apply the selected (ordered) statements against the target. */
	applyMigration: (targetId: string, statements: ApplyStatement[]): Promise<ApplyMigrationResult> => ipcRenderer.invoke('schema:apply', targetId, statements),
	/** Users and privileges: what this connection's engine supports. */
	securitySupport: (connectionId: string): Promise<SecuritySupport> => ipcRenderer.invoke('security:support', connectionId),
	/** Read the principals and grants this connection is allowed to see. */
	securityRead: (connectionId: string): Promise<SecuritySnapshot> => ipcRenderer.invoke('security:read', connectionId),
	/** The statements a set of changes would run, for review. Runs nothing. */
	securityPlan: (connectionId: string, changes: SecurityChange[]): Promise<SecurityPlan> => ipcRenderer.invoke('security:plan', connectionId, changes),
	/** Apply reviewed changes. Takes the changes, not their SQL — main re-plans and runs only
	 *  what the engine's emitters produce. */
	securityApply: (connectionId: string, changes: SecurityChange[]): Promise<SecurityApplyResult> => ipcRenderer.invoke('security:apply', connectionId, changes),
	/** Auto-detect importable connections from another tool's local config. */
	importScan: (source: ImportSourceId): Promise<ImportScanResult> => ipcRenderer.invoke('import:scan', source),
	/** Pick a config file manually when auto-detect fails (null if cancelled). */
	importBrowse: (source: ImportSourceId): Promise<ImportScanResult | null> => ipcRenderer.invoke('import:browse', source),
	/** Save the selected scanned connections (secrets resolved in main); returns count saved. */
	importApply: (source: ImportSourceId, refs: ImportItemRef[]): Promise<number> => ipcRenderer.invoke('import:apply', source, refs),
	/** First-run discovery: every source at once. Only when asked. */
	discoverRun: (options: DiscoveryOptions): Promise<ImportScanResult[]> => ipcRenderer.invoke('discover:run', options),
	/** Per-source progress during `discoverRun`. Returns an unsubscribe. */
	onDiscoverProgress: (handler: (progress: DiscoveryProgress) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, progress: DiscoveryProgress): void => handler(progress);
		ipcRenderer.on('discover:progress', listener);
		return () => ipcRenderer.removeListener('discover:progress', listener);
	},
	/** The account's hosted databases, for the Cloud panel. On demand; never on boot. */
	cloudProjects: (): Promise<CloudProjectsView> => ipcRenderer.invoke('cloud:projects'),
	/** Ask a hosted database to stop or start. Sets a desired state; the host agent acts. */
	cloudAsk: (action: 'pause' | 'resume', ref: string): Promise<CloudActionOutcome> => ipcRenderer.invoke('cloud:ask', action, ref),
	cloudCreate: (form: CloudCreateForm): Promise<CloudCreateOutcome> => ipcRenderer.invoke('cloud:create', form),
	cloudDelete: (ref: string): Promise<CloudActionOutcome> => ipcRenderer.invoke('cloud:delete-project', ref),
	/** A project's sections, local or cloud (shared/projects.ts): SQL as the owner, the gateway with the service key. */
	project: {
		sql: (target: ProjectTarget, sql: string): Promise<ProjectSqlResult> => ipcRenderer.invoke('project:sql', target, sql),
		api: (target: ProjectTarget, request: ProjectApiRequest): Promise<ProjectApiResponse> => ipcRenderer.invoke('project:api', target, request),
		upload: (target: ProjectTarget, bucket: string, prefix: string, upsert: boolean): Promise<ProjectActionOutcome | null> => ipcRenderer.invoke('project:upload', target, bucket, prefix, upsert),
		download: (target: ProjectTarget, bucket: string, path: string): Promise<ProjectActionOutcome | null> => ipcRenderer.invoke('project:download', target, bucket, path),
	},
	/** Local projects: the SnoutData stack in the user's own Docker. */
	local: {
		requirements: (): Promise<LocalRequirements> => ipcRenderer.invoke('local:requirements'),
		startEngine: (): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:start-engine'),
		defaults: (name: string): Promise<{ folder: string; apiPort: number; dbPort: number }> => ipcRenderer.invoke('local:defaults', name),
		portsInUse: (ports: number[]): Promise<number[]> => ipcRenderer.invoke('local:ports-in-use', ports),
		pickFolder: (current: string): Promise<string | null> => ipcRenderer.invoke('local:pick-folder', current),
		list: (): Promise<LocalProjectsView> => ipcRenderer.invoke('local:list'),
		install: (form: LocalSetupForm, installId: string): Promise<LocalInstallOutcome> => ipcRenderer.invoke('local:install', form, installId),
		start: (id: string): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:start', id),
		stop: (id: string): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:stop', id),
		remove: (id: string, options: { deleteData: boolean; deleteFolder: boolean }): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:remove', id, options),
		logs: (id: string, service: string | null): Promise<string> => ipcRenderer.invoke('local:logs', id, service),
		facts: (id: string): Promise<LocalConnectionFacts> => ipcRenderer.invoke('local:facts', id),
		copy: (id: string, target: LocalCopyTarget): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:copy', id, target),
		openFolder: (id: string, sub?: string): Promise<void> => ipcRenderer.invoke('local:open-folder', id, sub),
		functions: (id: string): Promise<LocalFunctionRow[]> => ipcRenderer.invoke('local:functions', id),
		newFunction: (id: string, name: string): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:new-function', id, name),
		deployFunctions: (id: string): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:deploy-functions', id),
		settings: (id: string): Promise<LocalSettings> => ipcRenderer.invoke('local:settings', id),
		dataApi: (id: string): Promise<{ on: boolean; switchable: boolean }> => ipcRenderer.invoke('local:data-api', id),
		setDataApi: (id: string, on: boolean): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:set-data-api', id, on),
		saveSettings: (id: string, change: LocalSettingsChange): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:save-settings', id, change),
		activity: (id: string): Promise<LocalActivity[]> => ipcRenderer.invoke('local:activity', id),
		resetPassword: (id: string): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:reset-password', id),
		rotateKeys: (id: string): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:rotate-keys', id),
		setProduction: (id: string, on: boolean): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:set-production', id, on),
		exports: (id: string): Promise<LocalExport[]> => ipcRenderer.invoke('local:exports', id),
		exportNow: (id: string): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:export', id),
		openExports: (id: string): Promise<void> => ipcRenderer.invoke('local:open-exports', id),
		restore: (id: string, name: string): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:restore', id, name),
		mailTemplates: (id: string): Promise<LocalMailTemplate[]> => ipcRenderer.invoke('local:mail-templates', id),
		saveMailTemplate: (id: string, kind: LocalMailKind, template: { subject: string; body: string } | null): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:save-mail-template', id, kind, template),
		functionSecrets: (id: string): Promise<string[]> => ipcRenderer.invoke('local:function-secrets', id),
		setFunctionSecret: (id: string, name: string, value: string | null): Promise<LocalActionOutcome> => ipcRenderer.invoke('local:set-function-secret', id, name, value),
		openUrl: (url: string): Promise<void> => ipcRenderer.invoke('local:open-url', url),
		onProgress: (handler: (progress: LocalProgress) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, progress: LocalProgress): void => handler(progress);
			ipcRenderer.on('local:progress', listener);
			return () => ipcRenderer.removeListener('local:progress', listener);
		},
	},
	cloudProject: <K extends CloudProjectOp>(op: K, args: CloudProjectOps[K]['args']): Promise<CloudProjectOutcome<CloudProjectOps[K]['result']>> => ipcRenderer.invoke('cloud:project', op, args),
	/** Snout Containers' "Deploy from a folder": main picks the folder and runs docker. */
	cloudContainers: {
		pickFolder: (): Promise<string | null> => ipcRenderer.invoke('cloud:containers-pick-folder'),
		build: (ref: string, form: ContainerBuildForm, buildId: string): Promise<CloudProjectOutcome<CloudContainers>> => ipcRenderer.invoke('cloud:containers-build', ref, form, buildId),
		onProgress: (handler: (progress: ContainerBuildProgress) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, progress: ContainerBuildProgress): void => handler(progress);
			ipcRenderer.on('cloud:containers-progress', listener);
			return () => ipcRenderer.removeListener('cloud:containers-progress', listener);
		},
	},
	/** Subscribe to "connections changed" pushes from main; returns an unsubscribe. */
	onConnectionsChanged: (handler: () => void): (() => void) => {
		const listener = (): void => handler();
		ipcRenderer.on('connections:changed', listener);
		return () => ipcRenderer.removeListener('connections:changed', listener);
	},
	/** The saved reusable SSH tunnel profiles a connection can reference. */
	tunnelsState: (): Promise<TunnelProfilesState> => ipcRenderer.invoke('tunnels:state'),
	/** Create or update a reusable SSH tunnel profile (secrets stored in main). */
	saveTunnel: (form: TunnelProfileFormValues): Promise<SshTunnelProfile> => ipcRenderer.invoke('tunnels:save', form),
	/** Delete a reusable SSH tunnel profile by id. */
	deleteTunnel: (id: string): Promise<void> => ipcRenderer.invoke('tunnels:delete', id),
	/** Subscribe to "tunnel profiles changed" pushes from main; returns an unsubscribe. */
	onTunnelsChanged: (handler: () => void): (() => void) => {
		const listener = (): void => handler();
		ipcRenderer.on('tunnels:changed', listener);
		return () => ipcRenderer.removeListener('tunnels:changed', listener);
	},
	/** Subscribe to live-schema-index refreshes for a connection; returns an unsubscribe. */
	onSchemaChanged: (handler: (connectionId: string) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, connectionId: string): void => handler(connectionId);
		ipcRenderer.on('schema:changed', listener);
		return () => ipcRenderer.removeListener('schema:changed', listener);
	},

	// Orbit Pulse 3b: the database's OWN activity, read from its runtime views. Opt-in, per
	// dialect, sampled in main at background priority. Nothing here runs until the Orbit tab calls
	// pulseStart, and it must call pulseStop when the tab closes.
	/** Can this connection's engine be sampled at all, and which view would it read? A refusal comes
	 *  back as a sentence to show the user, never a bare flag. */
	orbitPulseSupported: (connectionId: string): Promise<PulseSupport> => ipcRenderer.invoke('orbit:pulseSupported', connectionId),
	/** Start sampling a connection's activity. Re-arms an already-running sampler at the new
	 *  interval, so the rail's slider needs no stop first. Interval is clamped in main. */
	orbitPulseStart: (connectionId: string, intervalMs?: number): Promise<PulseStart> => ipcRenderer.invoke('orbit:pulseStart', connectionId, intervalMs),
	/** Stop sampling a connection. Safe on one that was never started. */
	orbitPulseStop: (connectionId: string): Promise<void> => ipcRenderer.invoke('orbit:pulseStop', connectionId),
	/** The last poll status (an error string, or null when the last poll was ok), for a view that
	 *  mounts mid-stream. */
	orbitPulseStatus: (connectionId: string): Promise<string | null> => ipcRenderer.invoke('orbit:pulseStatus', connectionId),
	/** Subscribe to sampled activity for any connection; returns an unsubscribe. */
	onOrbitPulse: (handler: (connectionId: string, samples: PulseSample[]) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, connectionId: string, samples: PulseSample[]): void => handler(connectionId, samples);
		ipcRenderer.on('orbit:pulse', listener);
		return () => ipcRenderer.removeListener('orbit:pulse', listener);
	},
	/** Subscribe to sampler failures (null clears); returns an unsubscribe. */
	onOrbitPulseStatus: (handler: (connectionId: string, error: string | null) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, connectionId: string, error: string | null): void => handler(connectionId, error);
		ipcRenderer.on('orbit:pulseStatus', listener);
		return () => ipcRenderer.removeListener('orbit:pulseStatus', listener);
	},

	// On-demand native-driver components (downloaded the first time a driver like Db2 is used).
	/** Install state of all known components (Settings / diagnostics). */
	componentsStatus: (): Promise<ComponentInfo[]> => ipcRenderer.invoke('components:status'),
	/** What a driver still needs before it can connect (null = nothing/already installed). */
	componentsRequiredFor: (driver: string): Promise<ComponentRequirement | null> => ipcRenderer.invoke('components:requiredFor', driver),
	/** Accept vendor licences by id; a vendor's file is never downloaded before this. */
	componentsAcceptTerms: (ids: string[]): Promise<void> => ipcRenderer.invoke('components:acceptTerms', ids),
	/** Download + install every component a driver needs; progress streams via onComponentProgress. */
	componentsInstallFor: (driver: string): Promise<ComponentInstallResult> => ipcRenderer.invoke('components:installFor', driver),
	/** Subscribe to component download/extract progress; returns an unsubscribe. */
	onComponentProgress: (handler: (progress: ComponentInstallProgress) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, progress: ComponentInstallProgress): void => handler(progress);
		ipcRenderer.on('components:progress', listener);
		return () => ipcRenderer.removeListener('components:progress', listener);
	},

	// Query execution.
	execute: (params: RunQueryParams): Promise<ExecuteQueryResult> => ipcRenderer.invoke('sql:execute', params),
	/** Run a pre-built EXPLAIN statement for the post-run index/scan advisor, without recording it
	 *  to query history (an internal advisory query). Returns the plan result envelope. */
	explain: (params: { connectionId: string; sql: string }): Promise<ExecuteQueryResult> => ipcRenderer.invoke('sql:explain', params),
	/** Translate SQL to the connection's native query form without running it (the editor's
	 *  "Get pipeline translation" action). Deterministic-first; AI gated by `allowAiTranscribe`. */
	transcribe: (params: { connectionId: string; sql: string; allowAiTranscribe?: boolean }): Promise<TranscribeResult> => ipcRenderer.invoke('sql:transcribe', params),
	/** Run a batch of statements as one save (the editable grid's DELETE/UPDATE/INSERT set),
	 *  one at a time / transactional per driver. */
	executeScript: (params: { connectionId: string; statements: string[] }): Promise<ExecuteQueryResult> => ipcRenderer.invoke('sql:executeScript', params),
	/** Run a batch of document writes as one save (the editable grid's Mongo updateOne/insertOne/
	 *  deleteOne set) — the document-backend analog of executeScript. */
	executeWrites: (params: { connectionId: string; writes: MongoWrite[] }): Promise<ExecuteQueryResult> => ipcRenderer.invoke('sql:executeWrites', params),
	/** Run a batch of document structure ops (create/drop collection, create/drop index) — the
	 *  document-backend analog of DDL. A structure change, so the caller re-introspects after. */
	executeMongoDdl: (params: { connectionId: string; ops: MongoDdl[] }): Promise<ExecuteQueryResult> => ipcRenderer.invoke('sql:executeMongoDdl', params),
	/** Choose a file to load into a table (or describe one already chosen): its size, and what
	 *  format its name says it is. Null when cancelled, or when this engine takes no file. */
	chooseLoadFile: (params: { connectionId: string; path?: string }): Promise<LoadFileChoice | null> => ipcRenderer.invoke('sql:chooseLoadFile', params),
	/** Stream that file into the table, as one statement whose body is the file. */
	bulkLoad: (params: { connectionId: string; schema?: string; table: string; formatId: string; filePath: string; columns?: string[] }): Promise<BulkLoadOutcome> => ipcRenderer.invoke('sql:bulkLoad', params),
	/** Have the SERVER write this statement's whole result to a file, in one of its own formats.
	 *  Asks where to put it; null-ish `cancelled` when the person closed the picker. */
	exportServerSide: (params: { connectionId: string; sql: string; formatId: string; suggestedName?: string }): Promise<ServerExportOutcome> => ipcRenderer.invoke('sql:exportServerSide', params),
	/** Ask a table function for its columns, a preview, or a table made from it. The statement is
	 *  built in main; what comes back carries the REDACTED form of it, for the screen. */
	tableFunction: (params: { connectionId: string; functionId: string; values: Record<string, string>; accountId?: string; action: 'describe' | 'preview' | 'import'; limit?: number; target?: { database?: string; table: string; orderBy: string[] } }): Promise<TableFunctionOutcome> => ipcRenderer.invoke('sql:tableFunction', params),
	/** Cancel the query currently running on a connection (best-effort). */
	cancelQuery: (connectionId: string): Promise<void> => ipcRenderer.invoke('sql:cancel', connectionId),
	queryProgress: (connectionId: string): Promise<QueryProgress | null> => ipcRenderer.invoke('sql:progress', connectionId),

	// Query history + saved queries.
	history: (): Promise<QueryHistoryEntry[]> => ipcRenderer.invoke('history:list'),
	clearHistory: (): Promise<void> => ipcRenderer.invoke('history:clear'),
	savedQueries: (): Promise<SavedQuery[]> => ipcRenderer.invoke('saved:list'),
	saveQuery: (name: string, sql: string): Promise<void> => ipcRenderer.invoke('saved:save', name, sql),
	deleteQuery: (name: string): Promise<void> => ipcRenderer.invoke('saved:delete', name),

	// Moving a database.
	// Copying a whole project between this computer and SnoutData Cloud (shared/projectCopy.ts).
	projectCopy: {
		check: (request: ProjectCopyRequest): Promise<ProjectCopyCheck> => ipcRenderer.invoke('projectCopy:check', request),
		/** Main checks everything again, and the typed name when the target is production. */
		start: (request: ProjectCopyRequest, typed?: string): Promise<ProjectCopyStartOutcome> => ipcRenderer.invoke('projectCopy:start', request, typed),
		cancel: (id: string): Promise<boolean> => ipcRenderer.invoke('projectCopy:cancel', id),
		state: (id: string): Promise<ProjectCopyProgress | null> => ipcRenderer.invoke('projectCopy:state', id),
		onProgress: (handler: (progress: ProjectCopyProgress) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, progress: ProjectCopyProgress): void => handler(progress);
			ipcRenderer.on('projectCopy:progress', listener);
			return () => ipcRenderer.removeListener('projectCopy:progress', listener);
		},
	},
	moves: {
		/** Every saved move. A spec never holds a credential. */
		list: (): Promise<MoveSpec[]> => ipcRenderer.invoke('moves:list'),
		save: (spec: MoveSpec): Promise<MoveSpec> => ipcRenderer.invoke('moves:save', spec),
		remove: (id: string): Promise<void> => ipcRenderer.invoke('moves:delete', id),
		/** Read both databases and run the preflight rules. */
		check: (spec: MoveSpec): Promise<MoveCheck> => ipcRenderer.invoke('moves:check', spec),
		/** Apply one of a finding's own fixes, against a fresh check. */
		fix: (spec: MoveSpec, key: string, fix: FixId): Promise<MoveFixOutcome> => ipcRenderer.invoke('moves:fix', spec, key, fix),
		/** Start the move the review sheet shows. Main checks both databases and the typed names again. */
		run: (spec: MoveSpec, typed: MoveConfirmations): Promise<MoveStartOutcome> => ipcRenderer.invoke('moves:run', spec, typed),
		cancel: (runId: string): Promise<boolean> => ipcRenderer.invoke('moves:cancel', runId),
		/** Download the Postgres tools a move runs; progress arrives on onComponentProgress. */
		installTools: (): Promise<ComponentInstallResult> => ipcRenderer.invoke('moves:installTools'),
		runState: (moveId: string): Promise<MoveRunState> => ipcRenderer.invoke('moves:runState', moveId),
		onProgress: (handler: (progress: MoveProgress) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, progress: MoveProgress): void => handler(progress);
			ipcRenderer.on('moves:progress', listener);
			return () => ipcRenderer.removeListener('moves:progress', listener);
		},
		onFinished: (handler: (result: MoveRunResult) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, result: MoveRunResult): void => handler(result);
			ipcRenderer.on('moves:finished', listener);
			return () => ipcRenderer.removeListener('moves:finished', listener);
		},
		/** A move was saved or deleted, by anyone; returns an unsubscribe. */
		onChanged: (handler: (id: string) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, id: string): void => handler(id);
			ipcRenderer.on('moves:changed', listener);
			return () => ipcRenderer.removeListener('moves:changed', listener);
		},
	},

	// Monitors (live DB monitors).
	monitors: {
		/** All monitors (definitions only; samples are fetched per widget). */
		list: (): Promise<Monitor[]> => ipcRenderer.invoke('monitor:list'),
		/** Create or update a monitor (matched by id); reconciles the trend poller. */
		save: (monitor: Monitor): Promise<void> => ipcRenderer.invoke('monitor:save', monitor),
		/** Delete a monitor and all of its widgets' samples. */
		remove: (id: string): Promise<void> => ipcRenderer.invoke('monitor:delete', id),
		/** A trend widget's accumulated samples (oldest-first), optionally since a cutoff (epoch ms). */
		samples: (widgetId: string, sinceMs?: number): Promise<TrendSample[]> => ipcRenderer.invoke('monitor:samples', widgetId, sinceMs),
		/** Run a widget's SQL once (snapshot render / manual refresh). Connects on demand. */
		runWidget: (connectionId: string, sql: string): Promise<ExecuteQueryResult> => ipcRenderer.invoke('monitor:runWidget', connectionId, sql),
		/** The last poll status for a trend widget (error string, or null when its last poll was ok). */
		status: (widgetId: string): Promise<string | null> => ipcRenderer.invoke('monitor:status', widgetId),
		/** Subscribe to live trend-sample ticks from the poller; returns an unsubscribe. */
		onSample: (handler: (widgetId: string, samples: TrendSample[]) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, widgetId: string, samples: TrendSample[]): void => handler(widgetId, samples);
			ipcRenderer.on('monitor:sample', listener);
			return () => ipcRenderer.removeListener('monitor:sample', listener);
		},
		/** Subscribe to live trend poll status (error string, or null on a good poll); returns an unsubscribe. */
		onStatus: (handler: (widgetId: string, error: string | null) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, widgetId: string, error: string | null): void => handler(widgetId, error);
			ipcRenderer.on('monitor:status', listener);
			return () => ipcRenderer.removeListener('monitor:status', listener);
		},
		/**
		 * Subscribe to the monitor SET changing (created, renamed, deleted, widget added or
		 * removed); returns an unsubscribe.
		 *
		 * Main fires this on every write, whoever made it, which is the point: an agent driving the
		 * app through MCP writes through the same handler the UI does, and before this existed the
		 * open view never heard about it.
		 */
		onChanged: (handler: () => void): (() => void) => {
			const listener = (): void => handler();
			ipcRenderer.on('monitors:changed', listener);
			return () => ipcRenderer.removeListener('monitors:changed', listener);
		},
	},

	// Buckets a flow can read from.
	//
	// Note what is NOT here: any way to read a stored secret. It goes in through `save` and the only
	// thing that comes back is `hasSecret`, which is what a page needs to offer Remove.
	cloud: {
		/** Every provider, built or not, so a picker can decline honestly rather than hide an arm. */
		vendors: (): Promise<CloudVendorInfo[]> => ipcRenderer.invoke('cloud:vendors'),
		/** Every saved storage account, by name. */
		list: (): Promise<CloudAccountView[]> => ipcRenderer.invoke('cloud:list'),
		/** Create or update an account (matched by id), storing its secret if one was typed. */
		save: (form: CloudAccountForm): Promise<CloudAccountView> => ipcRenderer.invoke('cloud:save', form),
		/** Forget an account and its keychain entry. */
		remove: (id: string): Promise<void> => ipcRenderer.invoke('cloud:delete', id),
		/** Can this app reach this account — tested against the form on screen, before it is saved. */
		test: (form: CloudAccountForm): Promise<CloudTestResult> => ipcRenderer.invoke('cloud:test', form),
		/** Credentials this computer already has that a provider can adopt. Never carries a secret. */
		importable: (vendor: CloudVendor): Promise<ImportableCredential[]> => ipcRenderer.invoke('cloud:importable', vendor),
		/** Every container an UNSAVED form can see (the settings page's picker). */
		containers: (form: CloudAccountForm): Promise<CloudContainerList> => ipcRenderer.invoke('cloud:containers', form),
		/** Every container a SAVED account can see (the flow wizard's picker). */
		containersFor: (accountId: string): Promise<CloudContainerList> => ipcRenderer.invoke('cloud:containersFor', accountId),
		/** Every LOG provider, built or not, so a picker can decline honestly. */
		logServices: (): Promise<LogServiceInfo[]> => ipcRenderer.invoke('cloud:logServices'),
		/** Every log scope a SAVED account can see in one region. Regional, unlike a container list:
		 *  a log scope is per region on every one of these providers. */
		logScopesFor: (params: { accountId: string; region: string }): Promise<LogScopeList> => ipcRenderer.invoke('cloud:logScopesFor', params),
	},

	// Data Flows (Source → Transforms → Sink).

	// Assistant chat history.
	/** The tray's Pause Scheduled Flows switch, which pauses ALL background work (scheduled flows
	 *  and PR reviews), so it is the shell's. The channel names are historical. */
	schedules: {
		paused: (): Promise<boolean> => ipcRenderer.invoke('flow:schedulesPaused'),
		setPaused: (paused: boolean): Promise<boolean> => ipcRenderer.invoke('flow:setSchedulesPaused', paused),
	},
	/**
	 * Data Flows' IPC, as one generic bridge. Data Flows is private, so its typed wrappers live in
	 * its own renderer half and this preload, which is open, names none
	 * of its types. Only Data Flows' own channels pass.
	 */
	pro: {
		invoke: <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
			assertProChannel(channel);
			return ipcRenderer.invoke(channel, ...args);
		},
		on: (channel: string, listener: (...args: never[]) => void): (() => void) => {
			assertProChannel(channel);
			const wrapped = (_event: IpcRendererEvent, ...args: unknown[]): void => (listener as (...a: unknown[]) => void)(...args);
			ipcRenderer.on(channel, wrapped);
			return () => ipcRenderer.removeListener(channel, wrapped);
		},
		/** Where a DROPPED file lives on disk (`webUtils` is reachable only from a preload). */
		pathForFile: (file: File): string => webUtils.getPathForFile(file),
	},
	chatSessions: (): Promise<ChatSession[]> => ipcRenderer.invoke('chat:list'),
	saveChatSession: (session: ChatSession): Promise<void> => ipcRenderer.invoke('chat:save', session),
	deleteChatSession: (id: string): Promise<void> => ipcRenderer.invoke('chat:delete', id),
	clearChatSessions: (): Promise<void> => ipcRenderer.invoke('chat:clear'),

	// Per-connection knowledge base.
	knowledgeNotes: (connectionId: string): Promise<KnowledgeNote[]> => ipcRenderer.invoke('knowledge:list', connectionId),
	saveKnowledgeNote: (note: KnowledgeNote): Promise<KnowledgeNote> => ipcRenderer.invoke('knowledge:save', note),
	deleteKnowledgeNote: (id: string): Promise<void> => ipcRenderer.invoke('knowledge:delete', id),
	setKnowledgeNoteEnabled: (id: string, enabled: boolean): Promise<void> => ipcRenderer.invoke('knowledge:setEnabled', id, enabled),
	suggestedKnowledgeNotes: (connectionId: string): Promise<KnowledgeNote[]> => ipcRenderer.invoke('knowledge:listSuggested', connectionId),
	approveKnowledgeNote: (id: string): Promise<void> => ipcRenderer.invoke('knowledge:approve', id),
	dismissKnowledgeNote: (id: string): Promise<void> => ipcRenderer.invoke('knowledge:dismiss', id),
	observeKnowledge: (connectionId: string, messages: ChatMessage[]): Promise<KnowledgeNote | null> => ipcRenderer.invoke('knowledge:observe', connectionId, messages),
	draftKnowledgeNote: (connectionId: string | undefined, messages: ChatMessage[], hint: string | undefined): Promise<string> => ipcRenderer.invoke('knowledge:draft', connectionId, messages, hint),

	// Workspace files (a folder of .sql scripts on disk).
	workspace: {
		root: (): Promise<string> => ipcRenderer.invoke('workspace:root'),
		setRoot: (): Promise<string | null> => ipcRenderer.invoke('workspace:setRoot'),
		list: (): Promise<WorkspaceFile[]> => ipcRenderer.invoke('workspace:list'),
		read: (path: string): Promise<string> => ipcRenderer.invoke('workspace:read', path),
		save: (path: string, content: string): Promise<WorkspaceFile> => ipcRenderer.invoke('workspace:save', path, content),
		create: (name: string, content?: string): Promise<WorkspaceFile> => ipcRenderer.invoke('workspace:create', name, content),
		rename: (path: string, newName: string): Promise<WorkspaceFile> => ipcRenderer.invoke('workspace:rename', path, newName),
		remove: (path: string): Promise<void> => ipcRenderer.invoke('workspace:remove', path),
		search: (query: string): Promise<WorkspaceSearchHit[]> => ipcRenderer.invoke('workspace:search', query),
		importFile: (): Promise<WorkspaceFile[] | null> => ipcRenderer.invoke('workspace:import'),
		importPaths: (paths: string[]): Promise<WorkspaceFile[]> => ipcRenderer.invoke('workspace:importPaths', paths),
		dbeaverScripts: (): Promise<DbeaverScriptScan> => ipcRenderer.invoke('workspace:dbeaverScripts'),
		dbeaverPickFolder: (): Promise<DbeaverScriptScan | null> => ipcRenderer.invoke('workspace:dbeaverPickFolder'),
	},

	// File open/save (.sql).
	openFile: (): Promise<{ path: string; content: string } | null> => ipcRenderer.invoke('file:open'),
	pickFilePath: (): Promise<string | null> => ipcRenderer.invoke('file:pickPath'),
	saveFile: (path: string | null, content: string): Promise<string | null> => ipcRenderer.invoke('file:save', path, content),
	exportData: (defaultName: string, content: string): Promise<string | null> => ipcRenderer.invoke('file:export', defaultName, content),
	exportXlsx: (defaultName: string, sheet: XlsxSheet): Promise<string | null> => ipcRenderer.invoke('file:exportXlsx', defaultName, sheet),
	saveChart: (defaultName: string, format: 'png' | 'svg' | 'csv', data: string): Promise<string | null> => ipcRenderer.invoke('chart:save', defaultName, format, data),

	// Editor language features (LSP over IPC).
	didOpen: (uri: string, text: string, version: number): Promise<void> => ipcRenderer.invoke('sql:didOpen', uri, text, version),
	didChange: (uri: string, version: number, text: string): Promise<void> => ipcRenderer.invoke('sql:didChange', uri, version, text),
	completion: (uri: string, position: Position, connectionId?: string): Promise<CompletionList> => ipcRenderer.invoke('sql:completion', uri, position, connectionId),
	completionResolve: (item: CompletionItem): Promise<CompletionItem> => ipcRenderer.invoke('sql:completionResolve', item),
	hover: (uri: string, position: Position, connectionId?: string): Promise<Hover | null> => ipcRenderer.invoke('sql:hover', uri, position, connectionId),
	syntaxDiagnostics: (text: string): Promise<SqlSyntaxDiagnostic[]> => ipcRenderer.invoke('sql:syntaxDiagnostics', text),

	// AI assistant.
	aiSettings: (): Promise<AiSettings> => ipcRenderer.invoke('ai:settings'),
	saveAiSettings: (values: AiSettingsFormValues): Promise<AiSettings> => ipcRenderer.invoke('ai:saveSettings', values),
	aiTest: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('ai:test'),
	aiProviderStatus: (): Promise<AiProviderStatus[]> => ipcRenderer.invoke('ai:providerStatus'),
	/** The signed-in user's live gateway plan usage (spend vs. budget); null when signed out
	 *  or the gateway is unreachable. */
	aiBudgetStatus: (): Promise<AiBudgetStatus | null> => ipcRenderer.invoke('ai:budgetStatus'),
	/** The wallet→credits switch: whether the assistant falls back to purchased credits once the
	 *  monthly wallet is exhausted. Backed by the shared ai_preferences row. */
	aiCreditsEnabled: (): Promise<boolean> => ipcRenderer.invoke('ai:creditsEnabled'),
	aiSetCreditsEnabled: (enabled: boolean): Promise<void> => ipcRenderer.invoke('ai:setCreditsEnabled', enabled),
	aiSetModelEnabled: (key: string, enabled: boolean): Promise<AiSettings> => ipcRenderer.invoke('ai:setModelEnabled', key, enabled),
	aiOllamaModels: (endpoint: string): Promise<string[]> => ipcRenderer.invoke('ai:ollamaModels', endpoint),
	aiByokModels: (provider: ByokProviderId): Promise<string[]> => ipcRenderer.invoke('ai:byokModels', provider),
	aiSetActive: (provider: AiProviderId, model: string): Promise<AiSettings> => ipcRenderer.invoke('ai:setActive', provider, model),

	aiSetDataAccess: (level: NonNullable<AiSettings['dataAccess']>): Promise<AiSettings> => ipcRenderer.invoke('ai:setDataAccess', level),
	aiChat: (requestId: string, messages: ChatMessage[], activeConnectionId: string | undefined, capabilities: CapabilitySpec[] = [], ambient: AmbientContext = {}): Promise<AiChatResult> =>
		ipcRenderer.invoke('ai:chat', requestId, messages, activeConnectionId, capabilities, ambient),
	/** Attach a document to the chat: opens a file picker, then extracts + size-caps the text in
	 *  main. Resolves to the capped attachment, a clean error, or null when the user cancels. */
	aiPickDocument: (): Promise<ExtractDocumentResult | null> => ipcRenderer.invoke('ai:pickDocument'),
	/** Stop an in-flight chat stream by its request id. */
	cancelChat: (requestId: string): Promise<void> => ipcRenderer.invoke('ai:cancel', requestId),
	/** Approve or decline a run_query (or mutating capability) the agent proposed (settles the loop's await). */
	respondToolApproval: (requestId: string, callId: string, approved: boolean): Promise<void> =>
		ipcRenderer.invoke('ai:approvalReply', requestId, callId, approved),
	/** Publish the renderer's capability manifest to main, so an external agent (MCP) can be
	 *  offered the same app actions the assistant has. Called on every registry change. */
	publishCapabilities: (specs: CapabilitySpec[]): Promise<number> => ipcRenderer.invoke('ai:publishCapabilities', specs),
	/** Settle a renderer-capability invocation with its result (settles the loop's await). */
	respondCapability: (requestId: string, callId: string, result: CapabilityResult): Promise<void> =>
		ipcRenderer.invoke('ai:capabilityReply', requestId, callId, result),
	/** Add/remove a connection from the run_query auto-approve allowlist ("Always allow"). */
	setConnectionAutoApprove: (connectionId: string, allowed: boolean): Promise<AiSettings> =>
		ipcRenderer.invoke('ai:allowConnection', connectionId, allowed),
	/** Every recorded LLM interaction (chat, completion, edit), newest first. */
	aiAuditLog: (): Promise<AiAuditEntry[]> => ipcRenderer.invoke('audit:list'),
	/** Wipe the AI audit log. */
	clearAiAuditLog: (): Promise<void> => ipcRenderer.invoke('audit:clear'),
	/** Set which interaction kinds are recorded to the audit log (pushed from the app's settings). */
	setAuditKinds: (kinds: AiAuditKind[]): Promise<void> => ipcRenderer.invoke('audit:setKinds', kinds),
	aiLiby: (request: LibyChatRequest): Promise<{ ok: true; text: string } | { ok: false; error: string }> => ipcRenderer.invoke('ai:liby', request),
	aiComplete: (params: AiCompletionParams): Promise<AiCompletionResult> => ipcRenderer.invoke('ai:complete', params),
	/** Report what the user did with a shown completion (accepted / partially accepted / dismissed).
	 *  One-way and unawaited: this is measurement, and the editor must never wait on it. */
	aiCompletionOutcome: (params: AiCompletionOutcomeParams): void => ipcRenderer.send('ai:completionOutcome', params),
	/** Inline editor edit (Ctrl+K): rewrite a selection or generate SQL at the cursor. */
	aiEdit: (requestId: string, params: AiEditParams): Promise<AiEditResult> => ipcRenderer.invoke('ai:edit', requestId, params),
	/** Subscribe to streamed reply chunks; returns an unsubscribe. */
	onAiChunk: (handler: (requestId: string, delta: string) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, requestId: string, delta: string): void => handler(requestId, delta);
		ipcRenderer.on('ai:chunk', listener);
		return () => ipcRenderer.removeListener('ai:chunk', listener);
	},
	/** Subscribe to streamed Ctrl+K edit chunks (live progress line); returns an unsubscribe. */
	onAiEditChunk: (handler: (requestId: string, delta: string) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, requestId: string, delta: string): void => handler(requestId, delta);
		ipcRenderer.on('ai:editChunk', listener);
		return () => ipcRenderer.removeListener('ai:editChunk', listener);
	},
	/** Subscribe to agent tool steps (start/end) for the active chat request. */
	onAiTool: (handler: (requestId: string, event: AiToolEvent) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, requestId: string, toolEvent: AiToolEvent): void => handler(requestId, toolEvent);
		ipcRenderer.on('ai:tool', listener);
		return () => ipcRenderer.removeListener('ai:tool', listener);
	},
	/** Dev-only: subscribe to the assembled system prompt for the active chat request (only fires
	 *  in unpackaged builds; the main process gates the emit). Returns an unsubscribe. */
	onAiSystemPrompt: (handler: (requestId: string, prompt: string) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, requestId: string, prompt: string): void => handler(requestId, prompt);
		ipcRenderer.on('ai:systemPrompt', listener);
		return () => ipcRenderer.removeListener('ai:systemPrompt', listener);
	},
	/** Subscribe to run_query / capability approval requests from the agent loop. */
	onAiApprovalRequest: (handler: (request: AiApprovalRequest) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, request: AiApprovalRequest): void => handler(request);
		ipcRenderer.on('ai:approvalRequest', listener);
		return () => ipcRenderer.removeListener('ai:approvalRequest', listener);
	},
	/** Subscribe to renderer-capability invocation requests from the agent loop. */
	onAiCapabilityRequest: (handler: (request: AiCapabilityRequest) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, request: AiCapabilityRequest): void => handler(request);
		ipcRenderer.on('ai:capabilityRequest', listener);
		return () => ipcRenderer.removeListener('ai:capabilityRequest', listener);
	},

	// Auto-update.
	checkForUpdate: (): Promise<void> => ipcRenderer.invoke('update:check'),
	/** User-initiated download of the announced update (no auto-download — saves bandwidth). */
	downloadUpdate: (): Promise<void> => ipcRenderer.invoke('update:download'),
	installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
	/** Subscribe to auto-update lifecycle status; returns an unsubscribe. */
	onUpdateStatus: (handler: (status: UpdateStatus) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, status: UpdateStatus): void => handler(status);
		ipcRenderer.on('update:status', listener);
		return () => ipcRenderer.removeListener('update:status', listener);
	},

	// App info + external links (About modal).
	appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
	/** Studio's NOTICE and the third-party licences the build wrote (About → Third-party licences). */
	thirdPartyLicences: (): Promise<{ notice: string | null; licences: string | null }> => ipcRenderer.invoke('app:thirdPartyLicences'),
	/** Whether this version is below the minimum the backend supports. Starts not required
	 *  and changes only after main's deferred check, so subscribe as well as asking. */
	minimumVersion: (): Promise<MinimumVersionState> => ipcRenderer.invoke('app:minimumVersion'),
	onMinimumVersion: (handler: (state: MinimumVersionState) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, state: MinimumVersionState): void => handler(state);
		ipcRenderer.on('app:minimumVersion', listener);
		return () => ipcRenderer.removeListener('app:minimumVersion', listener);
	},
	/** Recolor the native OS window chrome (title bar/frame) to match the app theme. */
	setNativeTheme: (theme: 'dark' | 'light'): Promise<void> => ipcRenderer.invoke('app:setNativeTheme', theme),
	// The custom title bar: push the theme's resolved colours at the native window buttons, read
	// the application menu so the strip can draw it, and run the menu items that only main can
	// perform.
	setWindowChrome: (color: string, symbolColor: string): Promise<void> => ipcRenderer.invoke('app:setWindowChrome', color, symbolColor),
	menuModel: (): Promise<AppMenu[]> => ipcRenderer.invoke('app:menuModel'),
	menuRole: (role: string): Promise<void> => ipcRenderer.invoke('app:menuRole', role),
	/** Total working-set memory across all of the app's processes, in bytes (status bar). */
	appMemory: (): Promise<{ bytes: number }> => ipcRenderer.invoke('app:memory'),
	openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
	/** Crash/error reporting state: `enabled` is the user's opt-out, `available` is whether a DSN ships. */
	getTelemetry: (): Promise<{ enabled: boolean; available: boolean }> => ipcRenderer.invoke('telemetry:get'),
	/** Turn crash/error reporting on or off (takes effect immediately). Returns the new state. */
	setTelemetry: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('telemetry:set', enabled),
	/** GPU rendering state: `enabled` is on by default; `autoDisabled` is true when the app turned
	 *  it off itself after repeated GPU crashes (so the UI can explain why it changed). */
	getGpu: (): Promise<{ enabled: boolean; autoDisabled: boolean }> => ipcRenderer.invoke('gpu:get'),
	/** Turn GPU rendering on or off. Applies on the NEXT launch — Electron fixes the GPU decision
	 *  before `ready`, so the UI must tell the user to restart. Returns the new state. */
	setGpu: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('gpu:set', enabled),
	/** Confirm quitting after the in-app dialog; lets the quit proceed. */
	confirmQuit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
	/** Answer the one-time "closing leaves it running in the tray" notice: hides the window and
	 *  never asks again. */
	hideToTray: (): Promise<void> => ipcRenderer.invoke('app:hideToTray'),
	/** Current account + tier + entitlements (logged-out ⇒ free). */
	authState: (): Promise<AuthState> => ipcRenderer.invoke('auth:state'),
	/** Begin OAuth in the system browser; the session arrives later via onAuthChanged. */
	authSignIn: (provider: AuthProviderId, workEmail?: string): Promise<void> => ipcRenderer.invoke('auth:signIn', provider, workEmail),
	/** Sign out and drop the local session. */
	authSignOut: (): Promise<void> => ipcRenderer.invoke('auth:signOut'),
	/** Re-read the tier from the server (e.g. after upgrading on the website); returns the
	 *  refreshed state. A tier change also arrives via onAuthChanged. */
	authRefresh: (): Promise<AuthState> => ipcRenderer.invoke('auth:refresh'),
	// Cloud sync of non-secret preferences (theme + pane layout + app/editor/query prefs),
	// keyed to the signed-in user. The blob is opaque here; the renderer owns its shape.
	settingsSync: {
		/** Read the user's synced prefs blob (null when signed out / no row / offline). */
		pull: (): Promise<Record<string, unknown> | null> => ipcRenderer.invoke('settings:pull'),
		/** Upsert the user's prefs blob. */
		push: (blob: Record<string, unknown>): Promise<void> => ipcRenderer.invoke('settings:push', blob),
		/** Erase the user's synced prefs row ("delete my synced settings"). */
		wipe: (): Promise<void> => ipcRenderer.invoke('settings:wipe'),
	},

	// Network proxy (Settings → Network). For a corporate network where system proxy resolution
	// doesn't reach the proxy, or where it needs credentials.
	proxy: {
		/** Saved config + what Chromium resolved for a sample host (a quick "is a proxy in the chain" read). */
		status: (): Promise<ProxyStatus> => ipcRenderer.invoke('proxy:status'),
		/** Persist the config (+ optional password) and apply it live; returns the refreshed status. */
		save: (values: ProxyFormValues): Promise<ProxyStatus> => ipcRenderer.invoke('proxy:save', values),
		/** Ping the hosts that fail first on a blocking network, through the current proxy config. */
		test: (): Promise<ProxyTestResult> => ipcRenderer.invoke('proxy:test'),
	},

	// Where saved passwords are sealed. `weak` is true on a Linux desktop with no password vault,
	// where they are saved in a file only the user's account can read (main/secretStorageMode.ts).
	secretStorage: {
		/** The standing fact, plus whether the one-time notice is still owed on this profile. */
		status: (): Promise<{ weak: boolean; warn: boolean }> => ipcRenderer.invoke('secrets:storage'),
		/** Record that the notice was shown, so it is shown once per profile. */
		warned: (): Promise<void> => ipcRenderer.invoke('secrets:storageWarned'),
	},

	// Keyboard shortcuts (Settings → Shortcuts). The single source of truth is shared/keybindings.ts;
	// the DOM + Monaco dispatchers and the app menu all read the resolved bindings from here.
	keybindings: {
		/** The effective bindings (user overrides merged over defaults). */
		get: (): Promise<ResolvedKeybinding[]> => ipcRenderer.invoke('keybindings:get'),
		/** Rebind one command. An empty combo, or one equal to the default, clears the override. */
		set: (id: string, combo: string): Promise<ResolvedKeybinding[]> => ipcRenderer.invoke('keybindings:set', id, combo),
		/** Reset one command (by id) or all (id omitted) to defaults. */
		reset: (id?: string): Promise<ResolvedKeybinding[]> => ipcRenderer.invoke('keybindings:reset', id),
		/** Subscribe to binding changes (from any window/Settings); returns an unsubscribe. */
		onChanged: (handler: (bindings: ResolvedKeybinding[]) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, bindings: ResolvedKeybinding[]): void => handler(bindings);
			ipcRenderer.on('keybindings:changed', listener);
			return () => ipcRenderer.removeListener('keybindings:changed', listener);
		},
	},

	// Local MCP server (credential broker for external agents). Each call returns the full
	// McpStatus so the Settings panel re-renders from one source of truth.
	/** The Agent Console: the user's own coding agent, run inside the app.
	 *  One console per agent kind, owned by main, so this surface is deliberately stateless. */
	agentConsole: {
		/** Every known agent: installed?, running?, and whether it has tools from us. */
		statuses: (): Promise<AgentConsoleStatus[]> => ipcRenderer.invoke('agentConsole:statuses'),
		/** Re-probe every known agent, so one installed while the app was running is noticed. */
		discoverAll: (): Promise<AgentConsoleStatus[]> => ipcRenderer.invoke('agentConsole:discoverAll'),
		/** Show or hide one agent. Switching off is a DECISION: it is never auto-shown again. */
		setEnabled: (kind: AgentKind, enabled: boolean): Promise<AgentConsoleStatus[]> => ipcRenderer.invoke('agentConsole:setEnabled', kind, enabled),
		/** Point us at the binary by hand. Omit `path` to open a file dialog; null clears the pin. */
		setPath: (kind: AgentKind, path?: string | null): Promise<AgentConsoleStatus[]> => ipcRenderer.invoke('agentConsole:setPath', kind, path),
		/** Fired when the set of visible agents changes (found, enabled, disabled). */
		onChanged: (handler: () => void): (() => void) => {
			const listener = (): void => handler();
			ipcRenderer.on('agentConsole:changed', listener);
			return () => ipcRenderer.removeListener('agentConsole:changed', listener);
		},
		/** Re-check PATH for the binary (the panel calls this when it opens, and on demand). */
		discover: (kind: AgentKind): Promise<AgentConsoleStatus | null> => ipcRenderer.invoke('agentConsole:discover', kind),
		/** Status plus the scrollback to replay: closing the panel detaches, it never kills. */
		attach: (kind: AgentKind): Promise<AgentConsoleAttach | null> => ipcRenderer.invoke('agentConsole:attach', kind),
		/** Start the console, or attach to the running one. Idempotent (the singleton rule). */
		start: (kind: AgentKind, size?: AgentConsoleSize): Promise<AgentConsoleStatus | null> => ipcRenderer.invoke('agentConsole:start', kind, size),
		stop: (kind: AgentKind): Promise<AgentConsoleStatus | null> => ipcRenderer.invoke('agentConsole:stop', kind),
		restart: (kind: AgentKind, size?: AgentConsoleSize): Promise<AgentConsoleStatus | null> => ipcRenderer.invoke('agentConsole:restart', kind, size),
		/** Keystrokes. Fire-and-forget: a terminal cannot wait on a round-trip per character. */
		write: (kind: AgentKind, data: string): void => ipcRenderer.send('agentConsole:write', kind, data),
		/** Ctrl+V found an image, not text: hand it to the agent the way that agent takes one
		 *  (its own clipboard key, or a file whose path the caller pastes). */
		pasteImage: (kind: AgentKind): Promise<AgentImagePaste> => ipcRenderer.invoke('agentConsole:pasteImage', kind),
		/** Geometry, measured by the renderer (xterm's FitAddon) and forwarded to the PTY. */
		resize: (kind: AgentKind, size: AgentConsoleSize): void => ipcRenderer.send('agentConsole:resize', kind, size),
		config: (): Promise<AgentConsoleConfig> => ipcRenderer.invoke('agentConsole:config'),
		/** Open the folder where that agent keeps its own settings (we never edit what is in it). */
		openConfigFolder: (kind: AgentKind): Promise<boolean> => ipcRenderer.invoke('agentConsole:openConfigFolder', kind),
		/** Allow (or refuse) agent capabilities that CHANGE the app. Off by default. */
		setAllowMutating: (allowed: boolean): Promise<AgentConsoleConfig> => ipcRenderer.invoke('agentConsole:setAllowMutating', allowed),
		setRouteDatabase: (route: boolean): Promise<AgentConsoleConfig> => ipcRenderer.invoke('agentConsole:setRouteDatabase', route),
		/** An agent wants to take an action that CHANGES the app; the user answers. */
		onApprovalRequest: (handler: (request: AgentActionRequest) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, request: AgentActionRequest): void => handler(request);
			ipcRenderer.on('agent:approvalRequest', listener);
			return () => ipcRenderer.removeListener('agent:approvalRequest', listener);
		},
		/** Answer one such request. Not answering declines it, on a timer in main. `always` also
		 *  records a standing yes for that one capability (revocable in Settings). */
		respondApproval: (callId: string, answer: AgentApproval): Promise<void> => ipcRenderer.invoke('agent:approvalReply', callId, answer),
		/** Grant or revoke the standing yes for one capability, from Settings. */
		setAutoApprove: (name: string, approved: boolean): Promise<AgentConsoleConfig> => ipcRenderer.invoke('agentConsole:setAutoApprove', name, approved),
		/** Forget every standing yes. */
		setAutoApproveAll: (names: string[], approved: boolean): Promise<AgentConsoleConfig> => ipcRenderer.invoke('agentConsole:setAutoApproveAll', names, approved),
		clearAutoApprove: (): Promise<AgentConsoleConfig> => ipcRenderer.invoke('agentConsole:clearAutoApprove'),
		/** Every app-changing capability an agent could ask for, so Settings can grant ahead of time. */
		mutatingCapabilities: (): Promise<Array<{ name: string; title: string; description: string; domain: string }>> => ipcRenderer.invoke('agentConsole:mutatingCapabilities'),
		/** An agent is (or is no longer) driving the app, for the status bar. */
		onActing: (handler: (state: { acting: boolean; name?: string }) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, state: { acting: boolean; name?: string }): void => handler(state);
			ipcRenderer.on('agent:acting', listener);
			return () => ipcRenderer.removeListener('agent:acting', listener);
		},
		/** Terminal output for any console. The panel filters by kind. */
		onData: (handler: (chunk: AgentConsoleChunk) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, chunk: AgentConsoleChunk): void => handler(chunk);
			ipcRenderer.on('agentConsole:data', listener);
			return () => ipcRenderer.removeListener('agentConsole:data', listener);
		},
		/** A console ended (the agent quit, or the user stopped it). */
		onExit: (handler: (exit: AgentConsoleExit) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, exit: AgentConsoleExit): void => handler(exit);
			ipcRenderer.on('agentConsole:exit', listener);
			return () => ipcRenderer.removeListener('agentConsole:exit', listener);
		},
	},

	/** Snoutbot: the pull-request reviewer running on this machine.
	 *  The GitHub token stays in the keychain in main and never crosses this bridge — only
	 *  whether one exists, and which account it belongs to. */
	review: {
		/** Everything the Settings pane renders: switch, token state, watched repos, activity. */
		status: (): Promise<ReviewStatus> => ipcRenderer.invoke('review:status'),
		/** Verify a token against GitHub and store it only if it works. Empty string clears it. */
		setToken: (forge: ReviewForge, token: string): Promise<ReviewTokenCheck> => ipcRenderer.invoke('review:setToken', forge, token),
		/** Forget the token. Watched repositories are kept. */
		clearToken: (forge: ReviewForge): Promise<ReviewStatus> => ipcRenderer.invoke('review:clearToken', forge),
		/** Which GitLab. Changing it forgets the stored token, which belonged to the old one. */
		/** Post as the person whose token it is, or as the GitHub App. GitHub only: GitLab has no
		 *  App concept, and its project access tokens already run as a bot user. */
		setGithubAuth: (auth: ReviewForgeAuth): Promise<ReviewStatus> => ipcRenderer.invoke('review:setGithubAuth', auth),
		/** Which installation to review as, when the App is on more than one account. */
		setGithubInstallation: (id: number): Promise<ReviewStatus> => ipcRenderer.invoke('review:setGithubInstallation', id),
		/** Pick the App's `.pem` and store it. The key is read in main and put straight into the
		 *  keychain: it never crosses this bridge, in either direction. */
		chooseGithubApp: (appId: string): Promise<ReviewAppCheck> => ipcRenderer.invoke('review:chooseGithubApp', appId),
		setGitlabBaseUrl: (url: string): Promise<ReviewStatus> => ipcRenderer.invoke('review:setGitlabBaseUrl', url),
		/** Master switch. Off means nothing polls GitHub at all. */
		setEnabled: (enabled: boolean): Promise<ReviewStatus> => ipcRenderer.invoke('review:setEnabled', enabled),
		/** Seconds between polls (floored at 30 in main). */
		setPollSeconds: (seconds: number): Promise<ReviewStatus> => ipcRenderer.invoke('review:setPollSeconds', seconds),
		/** The repositories the stored token can reach — the token's own permission list. */
		listRepositories: (): Promise<ReviewRepoList> => ipcRenderer.invoke('review:listRepositories'),
		/** Watch a repository. Accepts `owner/name`, a URL, or a git remote. */
		addRepo: (ref: string, forge: ReviewForge = 'github'): Promise<{ ok: true; id: string } | { ok: false; error: string }> =>
			ipcRenderer.invoke('review:addRepo', ref, forge),
		/** Change one repository's binding, trigger mode, depth or approval setting. */
		updateRepo: (id: string, patch: Record<string, unknown>): Promise<ReviewStatus> =>
			ipcRenderer.invoke('review:updateRepo', id, patch),
		removeRepo: (id: string): Promise<ReviewStatus> => ipcRenderer.invoke('review:removeRepo', id),
		/** Poll now instead of waiting for the interval. */
		pollNow: (): Promise<ReviewPollResult> => ipcRenderer.invoke('review:pollNow'),
		/** Review one pull request on demand, ignoring the already-reviewed record. */
		reviewPull: (repoId: string, prNumber: number, deep?: boolean, method?: ReviewMethod): Promise<ReviewRun | undefined> =>
			ipcRenderer.invoke('review:reviewPull', repoId, prNumber, deep, method),
		/** Reviews held in memory, newest first. */
		runs: (): Promise<ReviewRun[]> => ipcRenderer.invoke('review:runs'),
		/** Post a review the user read and approved. */
		approve: (runId: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('review:approve', runId),
		/** Discard a review without posting it. */
		discard: (runId: string): Promise<ReviewRun[]> => ipcRenderer.invoke('review:discard', runId),
	},

	mcp: {
		/** Current state: master switch, whether the server is live, the connect snippet, the allowlist. */
		status: (): Promise<McpStatus> => ipcRenderer.invoke('mcp:status'),
		/** Turn the broker on (binds the localhost server) or off (stops it). */
		setEnabled: (enabled: boolean): Promise<McpStatus> => ipcRenderer.invoke('mcp:setEnabled', enabled),
		/** Expose or hide a single connection to agents. */
		setAllowed: (id: string, allowed: boolean): Promise<McpStatus> => ipcRenderer.invoke('mcp:setAllowed', id, allowed),
		/** Permit or revoke writes/DDL over MCP for a connection (off by default). */
		setWrites: (id: string, allowed: boolean): Promise<McpStatus> => ipcRenderer.invoke('mcp:setWrites', id, allowed),
		/** Mint a fresh bearer token (invalidates the old connect snippet). */
		regenerateToken: (): Promise<McpStatus> => ipcRenderer.invoke('mcp:regenerateToken'),
		/** Move the broker to another port after the configured one was taken (also replaces the token). */
		changePort: (port: number): Promise<McpStatus> => ipcRenderer.invoke('mcp:changePort', port),
		/** The broker's state changed in main (a taken port, a lockout); returns an unsubscribe. */
		onChanged: (handler: () => void): (() => void) => {
			const listener = (): void => handler();
			ipcRenderer.on('mcp:changed', listener);
			return () => ipcRenderer.removeListener('mcp:changed', listener);
		},
		/** May a program on this computer ask to use the signed-in account (the sign-in handoff)?
		 *  On by default and inert until something asks; off refuses it outright. */
		setSignInHandoff: (allowed: boolean): Promise<McpStatus> => ipcRenderer.invoke('mcp:setSignInHandoff', allowed),
		/** Something on this computer is asking to use the signed-in account; the user answers.
		 *  What a yes produces is a NEW revocable token, never the app's session. */
		onSignInRequest: (handler: (request: CliSignInRequest) => void): (() => void) => {
			const listener = (_event: IpcRendererEvent, request: CliSignInRequest): void => handler(request);
			ipcRenderer.on('cli:signInRequest', listener);
			return () => ipcRenderer.removeListener('cli:signInRequest', listener);
		},
		/** Answer one such request. Not answering declines it, on a timer in main. */
		respondSignIn: (requestId: string, answer: CliSignInAnswer): Promise<void> => ipcRenderer.invoke('cli:signInReply', requestId, answer),
		/** Queries external agents ran over MCP (newest first), separate from query history. */
		logs: (): Promise<McpLogEntry[]> => ipcRenderer.invoke('mcp:logs'),
		/** Wipe the entire MCP log. */
		logsClear: (): Promise<void> => ipcRenderer.invoke('mcp:logsClear'),
		/** Delete a single MCP log entry by id. */
		logDelete: (id: string): Promise<void> => ipcRenderer.invoke('mcp:logDelete', id),
	},
	/** Subscribe to Snoutbot state changes (a poll ran, a review finished); returns an unsubscribe. */
	onReviewChanged: (handler: (status: ReviewStatus) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, status: ReviewStatus): void => handler(status);
		ipcRenderer.on('review:changed', listener);
		return () => ipcRenderer.removeListener('review:changed', listener);
	},
	/** Subscribe to one review FINISHING. Separate from the status stream on purpose: a status is
	 *  a state the UI re-reads, this is an event that happened once, and the notifications centre
	 *  needs the second kind. Returns an unsubscribe. */
	onReviewRun: (handler: (run: ReviewRun) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, run: ReviewRun): void => handler(run);
		ipcRenderer.on('review:run', listener);
		return () => ipcRenderer.removeListener('review:run', listener);
	},
	/** Subscribe to one review STARTING, so the app can say so while it runs rather than only
	 *  when it is over. Returns an unsubscribe. */
	onReviewStarted: (handler: (started: ReviewStarted) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, started: ReviewStarted): void => handler(started);
		ipcRenderer.on('review:started', listener);
		return () => ipcRenderer.removeListener('review:started', listener);
	},
	/** Subscribe to auth/tier changes (sign-in completes, sign-out); returns an unsubscribe. */
	onAuthChanged: (handler: (state: AuthState) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, state: AuthState): void => handler(state);
		ipcRenderer.on('auth:changed', listener);
		return () => ipcRenderer.removeListener('auth:changed', listener);
	},
	/** Subscribe to main's request to confirm quitting; returns an unsubscribe. */
	onConfirmQuit: (handler: () => void): (() => void) => {
		const listener = (): void => handler();
		ipcRenderer.on('app:confirmQuit', listener);
		return () => ipcRenderer.removeListener('app:confirmQuit', listener);
	},
	/** Subscribe to main's one-time notice that closing the window leaves the app running in the
	 *  tray. Fires on the FIRST close only; returns an unsubscribe. */
	onHideNotice: (handler: () => void): (() => void) => {
		const listener = (): void => handler();
		ipcRenderer.on('app:hideNotice', listener);
		return () => ipcRenderer.removeListener('app:hideNotice', listener);
	},
	/** Subscribe to app-menu items: each fires with the command id to run (the same ids
	 *  the command palette uses). Returns an unsubscribe. */
	onMenuCommand: (handler: (commandId: string) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, commandId: string): void => handler(commandId);
		ipcRenderer.on('menu:command', listener);
		return () => ipcRenderer.removeListener('menu:command', listener);
	},
};

/**
 * The bridge is for the app's own page only. Main already refuses to navigate the
 * window anywhere else and answers IPC only from the app page; this is the third wall, so a page
 * that somehow loaded here would not even see the API. Packaged, the app is a file: page; in a dev
 * run it is the dev server, named by ELECTRON_RENDERER_URL (or, failing that, a loopback host).
 */
function isAppPage(): boolean {
	// The preload is type-checked without the DOM library, so the one DOM global it reads is typed here.
	const location = (globalThis as unknown as { location: { protocol: string; origin: string; hostname: string } }).location;
	if (location.protocol === 'file:') {
		return true;
	}
	const dev = process.env.ELECTRON_RENDERER_URL;
	if (dev) {
		try {
			return new URL(dev).origin === location.origin;
		} catch {
			return false;
		}
	}
	return location.protocol === 'http:' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
}

if (isAppPage()) {
	contextBridge.exposeInMainWorld('sqlApi', sqlApi);
}

export type SqlApi = typeof sqlApi;

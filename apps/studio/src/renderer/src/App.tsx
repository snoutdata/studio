/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../shared/assistant';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunLogsQuery } from './logContext';
import { createPortal } from 'react-dom';
import { lazyView } from './lazyView';
import { monaco } from './monaco';
import { notifyDidOpen, refreshAdvisorDiagnostics, setActiveConnectionId, setAdvisorSchemaProvider, setKeywordCase, setTableResolver } from './lspBridge';
import { configureAiCompletion, triggerAiCompletion } from './aiCompletion';
import { configureAiEdit, triggerAiEdit } from './aiEdit';
import type { AiAuditKind, AmbientCell, AmbientContext, AmbientFlowWizard, InlineCompletionMode } from '../../shared/ai';
import { AGENT_KINDS, agentDescriptor, type AgentActionRequest, type AgentApproval, type AgentConsoleStatus, type AgentKind } from '../../shared/agentConsole';
import { mcpProblemNotice, type CliSignInAnswer, type CliSignInRequest, type McpStatus } from '../../shared/mcp';
import type { ConnectionConfig } from '../../shared/connection';
import { clampPoolMax } from '../../shared/connection';
import { parseOpenProjectCommand, projectKey, projectSection, type ProjectSection, type ProjectTarget } from '../../shared/projects';
import type { ConnectionsState, ConnectionFormValues } from '../../shared/forms';
import type { ExecuteQueryResult } from '../../shared/protocol';
import { analyzePlan, applyHazardFixes, backendKindForDriver, browseShape, bulkFormatsFor, countingSql, DEFAULT_LOG_WINDOW_MS, destructiveStatement, dialectFor, keysetCursorFrom, keysetKeyFor, keysetSelect, lintSargability, partitionIndex, policyFor, profileFor, splitStatementSpans, statementAt, statementHazards, windowQuery, withLogTimeBound, type Advisory, type KeysetKey, type PlanAdvisorOptions, type MongoDdl, type MongoWrite, type NativeQuery, type PrincipalDraft, type QueryParameter, type SecurityChange, type StatementHazard, type StatementSpan } from '../../shared/engine';
import { parsePipeline, PIPELINE_TEMPLATE } from './pipeline';
import { registerPipelineCompletion, setPipelineSchema } from './pipelineCompletion';
import { setSqlDialect } from './sqlHighlight';
import type { DatabaseSchema, TableInfo } from '../../shared/schema';
import type { OrbitStatement } from '../../shared/orbit';
import { setOrbitBridge } from './capabilities/orbit';
import type { QueryProgress, QueryResult } from '../../shared/query';
import { formatBytes } from './formatBytes';
import type { ReviewStatus } from '../../shared/review';
import { describeUpdateFailure, type UpdateStatus } from '../../shared/update';
import type { WorkspaceFile } from '../../shared/workspace';
import type { AuthProviderId, AuthState } from '../../shared/auth';
import { Editor } from './components/Editor';
import { ResultsGrid } from './components/ResultsGrid';
import { TableView } from './components/TableView';
import { ObjectView, type ObjectDetail } from './components/ObjectView';
import { ConnectionChip } from './components/ConnectionChip';
import { Sidebar } from './components/Sidebar';
import { ConnectionPicker } from './components/ConnectionPicker';
import { IconButtonTips } from './components/HoverTip';
import { SelectPopover } from './components/SelectPopover';
import { HistoryPanel } from './components/HistoryPanel';
import { McpLogPanel } from './components/McpLogPanel';
import { WorkspaceFilesPanel } from './components/WorkspaceFilesPanel';
import { ActivityBar } from './components/ActivityBar';
import { ConnectionForm } from './components/ConnectionForm';
import { ConfirmRun } from './components/ConfirmRun';
import { AiTranslateConfirm } from './components/AiTranslateConfirm';
import { QueryParamsDialog } from './components/QueryParamsDialog';
import { FlowsPanel, PRO_AVAILABLE, ProStatusItems, importFlowFromFile as importFlowFile, useFlowRunNotices, useReviewCount } from '@snout/studio-pro/renderer';
import { ConfirmQuit } from './components/ConfirmQuit';
import { HideToTrayNotice } from './components/HideToTrayNotice';
import { ConfirmCloseTab } from './components/ConfirmCloseTab';
import { ChatPanel, type ChatRunOutcome } from './components/ChatPanel';
import { ExportMenu, type ExportSource, type CopyFormat } from './components/ExportMenu';
import { RunSplitButton } from './components/RunSplitButton';
import type { ResetOptions, SettingsTab } from './components/SettingsModal';
import type { ProEnginePage } from './proSeam';
import { TabBar, type EditorTab } from './components/TabBar';
import { TitleBar } from './components/TitleBar';
import { PipelineBar } from './components/PipelineBar';
import { FindBar } from './components/FindBar';
import { CommandPalette, type Command } from './components/CommandPalette';
import { StatusBar } from './components/StatusBar';
import { UpdateToast } from './components/UpdateToast';
import type { MinimumVersionState } from '../../shared/minimumVersion';
import { NotificationsCenter } from './components/NotificationsCenter';
import { NotificationToast } from './components/NotificationToast';
import { AboutModal } from './components/AboutModal';
import { parseComponentRequired, type ComponentRequirement } from '../../shared/components';
import { Welcome } from './components/Welcome';
import { Spotlight, type TourStep } from './components/Spotlight';
import { LibyArt } from '@snout/liby';
import { ReviewToast } from './components/ReviewToast';
import { finishedToast, replacesToast, reviewNotice, startedToast, type ReviewToastState } from './reviewRuns';
import { hasReleaseNotes } from './releaseNotes';
import { Splitter } from './components/Splitter';
import { AgentActionToast } from './components/AgentActionToast';
import { CliSignInToast } from './components/CliSignInToast';
import { useConfirm } from './components/ConfirmDialog';
import { Icon } from './components/Icon';
import { applyTheme, loadTheme, nextTheme, type Theme } from './theme';
import { clamp, DEFAULT_LAYOUT, loadLayout, saveLayout, type Layout, type SideView } from './layout';
import { DEFAULT_DOCKS, DOCK_AREAS, agentSurfaceHome, areaAtPoint, areaLabel, cloneDocks, dropTool, focusWorkbench, hideTool, isDefaultLayout, isToolVisible, moveTool, placementOf, resizeArea, showTool, toggleTool, toolLabel, type DockArea, type DockLayout, type DockRect, type ToolId } from './docking';
import { DockAreaView, DockTool, DomSlot } from './components/DockAreaView';
import { PanelMenu } from './components/PanelMenu';
import { DockDropZones } from './components/DockDropZones';
import { DEFAULT_APP_SETTINGS, adoptSyncedAppSettings, editorOptions, loadAppSettings, saveAppSettings, withAutoLimit, type AppSettings } from './appSettings';
import { buildBlob, fingerprint, localStamp, parseBlob, setLocalStamp, syncEnabled } from './settingsSync';
import { ScriptLog, type ScriptRun } from './components/ScriptLog';
import type { ExplainRun } from './components/ExplainPanel';
import { formatSql } from './sqlFormat';
import { serializeResult, exportFileName, toCsv, toTsv, toXlsxSheet, type ExportFormat } from './exportData';
import { loadSession, saveSession, type SavedTab } from './session';
import { suggestFileName } from './workspaceName';
import { loadOpenConnections, saveOpenConnections } from './connectionSession';
import { editableSource } from './editableQuery';
import { literalFromValue, primaryKeyNames } from './dml';
import { errorMessage } from './errors';
import { formatShortcut } from './shortcuts';
import { matchesEvent, type ResolvedKeybinding } from '../../shared/keybindings';
import { buildMigrationFixPrompt, buildErrorHelpPrompt, buildOptimizeQueryPrompt } from './aiFix';
import { AdvisoryStrip } from './components/AdvisoryStrip';
import { PreflightWarnModal } from './components/PreflightWarnModal';
import { useProdUnlocked } from './prodUnlock';
import { notify, notifyError, onNotify, useNotifications, dismiss as dismissNotification, clearAll as clearNotifications, markAllRead as markNotificationsRead, type AppNotification } from './notifications';
import type { TableDraft } from './ddl';
import { setCanvasFallbackAgent } from './capabilities/canvas';
import { canvasFor, subscribeCanvas } from './agentCanvas';
import { capabilityRegistry, staticCapabilities, type CapabilityContext } from './capabilities';
import type { CapabilityResult, CapabilitySpec } from '../../shared/capabilities';
import { install as installLogBuffer } from './capabilities/logBuffer';
import { allTasksDone, loadOnboarding, saveOnboarding, type ChecklistTaskId, type OnboardingState } from './onboarding';
import { Liby, LibyProvider, attentionSurface, getStage, helpAt, libyCall, libyClose, libyMoment, libyOut, libySummon, registerLibyHelper, trackAttention, type LibyCall, type LibyFact, type LibyHelp, type LibyLook } from '@snout/liby';
import {
	LIBY_AVAILABLE, MOMENTS, asLibyHelp, editorHelp, emptyWorkbenchHelp, flowHelp, installLibyTestHooks, libyFeel, loadIntroduced, loadMomentsSeen, markLibyIntroduced, messageFor, newlyDoneTasks,
	onMomentRequest, queryErrorAdvice, requestMoment, resultHelp, riskyAdvice, saveMomentsSeen, setHelpActionRunner, shouldShowMoment, sidebarHelp,
	signedOutHelp, signedOutQuestionHelp, studioHost, summonPoint, tableAdvice, tableHelp, TOUR_COPY, writtenTable,
} from '@snout/liby/studio';
import type { EditorFacts, HelpAction, HelpMove, ResultFacts, SchemaGlance, TableFacts, TourStepId } from './libyFacts';

// Feature views are code-split out of the launch chunk (see ./lazyView). Each of these is behind a
// tab, a modal or a dock the user has to open, so a launch should not pay to parse it: before this
// split the renderer shipped as one ~14 MB chunk containing Data Flows, Snoutbot, the monitors,
// the agent console and the settings tree, evaluated on every start whether or not they were ever
// used. Budget and the no-regression assertion live in e2e/startup.spec.ts.
//
// The names below shadow nothing: each wrapper takes the props its view took, so the JSX call
// sites are unchanged. Do NOT move a first-paint component in here (see lazyView's note).
const AgentCanvas = lazyView(() => import('./components/AgentCanvas').then((m) => ({ default: m.AgentCanvas })));
const AgentConsolePanel = lazyView(() => import('./components/AgentConsolePanel').then((m) => ({ default: m.AgentConsolePanel })));
const ComponentDownloadModal = lazyView(() => import('./components/ComponentDownloadModal').then((m) => ({ default: m.ComponentDownloadModal })));
const MonitorView = lazyView(() => import('./components/MonitorView').then((m) => ({ default: m.MonitorView })));
const FlowWizardView = lazyView(() => import('@snout/studio-pro/wizard').then((m) => ({ default: m.FlowWizardView })));
const MoveView = lazyView(() => import('./components/MoveView').then((m) => ({ default: m.MoveView })));
const ProjectCopyView = lazyView(() => import('./components/ProjectCopyView').then((m) => ({ default: m.ProjectCopyView })));
const VectorSearchView = lazyView(() => import('@snout/studio-pro/vector-search').then((m) => ({ default: m.VectorSearchView })));
const GettingStarted = lazyView(() => import('./components/GettingStarted').then((m) => ({ default: m.GettingStarted })));
const DashboardPanel = lazyView(() => import('./components/DashboardPanel').then((m) => ({ default: m.DashboardPanel })));
const ImportConnectionsModal = lazyView(() => import('./components/ImportConnectionsModal').then((m) => ({ default: m.ImportConnectionsModal })));
const DiscoveryModal = lazyView(() => import('./components/DiscoveryModal').then((m) => ({ default: m.DiscoveryModal })));
const OrbitView = lazyView(() => import('./components/OrbitView').then((m) => ({ default: m.OrbitView })));
const OrbitRailPanel = lazyView(() => import('./components/OrbitRailPanel').then((m) => ({ default: m.OrbitRailPanel })));
const PipelineBuilder = lazyView(() => import('./components/PipelineBuilder').then((m) => ({ default: m.PipelineBuilder })));
const QueryPerformanceView = lazyView(() => import('./components/QueryPerformanceView').then((m) => ({ default: m.QueryPerformanceView })));
const ReleaseNotesView = lazyView(() => import('./components/ReleaseNotesView').then((m) => ({ default: m.ReleaseNotesView })));
const ReviewView = lazyView(() => import('./components/ReviewView').then((m) => ({ default: m.ReviewView })));
const SchemaSyncView = lazyView(() => import('./components/SchemaSyncView').then((m) => ({ default: m.SchemaSyncView })));
const ProjectView = lazyView(() => import('./components/ProjectView').then((m) => ({ default: m.ProjectView })));
const LocalSetupView = lazyView(() => import('./components/LocalSetupView').then((m) => ({ default: m.LocalSetupView })));
const SecurityView = lazyView(() => import('./components/SecurityView').then((m) => ({ default: m.SecurityView })));
const ClickHouseOpsView = lazyView(() => import('./components/ClickHouseOpsView').then((m) => ({ default: m.ClickHouseOpsView })));
const ClickHouseRemoteView = lazyView(() => import('./components/ClickHouseRemoteView').then((m) => ({ default: m.ClickHouseRemoteView })));
const ExplainPanel = lazyView(() => import('./components/ExplainPanel').then((m) => ({ default: m.ExplainPanel })));
const SettingsModal = lazyView(() => import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal })));
const UpdateRequiredSheet = lazyView(() => import('./components/UpdateRequiredSheet').then((m) => ({ default: m.UpdateRequiredSheet })));
const WorkspaceImportModal = lazyView(() => import('./components/WorkspaceImportModal').then((m) => ({ default: m.WorkspaceImportModal })));

const EMPTY_STATE: ConnectionsState = { connections: [], connectedIds: [] };

// Friendly database name for the component-download prompt. Only native-driver vendors (whose
// client ships as a download) need an entry; others fall back to the driver id.
const DRIVER_DISPLAY_NAMES: Record<string, string> = { db2: 'IBM Db2', hana: 'SAP HANA', snowflake: 'Snowflake', duckdb: 'DuckDB' };
function driverDisplayName(driver: string): string {
	return DRIVER_DISPLAY_NAMES[driver] ?? driver;
}

// How many leading result rows to fold into the ambient AI context (the always-on "glance" at the
// data, A1). Kept small because it rides every chat turn a result is on screen; the prompt builder
// caps it again on its side. The precise, paged view is the get_query_result capability.
const AMBIENT_SAMPLE_ROWS = 5;

/** Stringify the first few result rows for the ambient context: NULL → "NULL", objects → JSON,
 *  everything else → String. Bounded to {@link AMBIENT_SAMPLE_ROWS}; per-cell length is clipped by
 *  the prompt builder, so this just makes the values structured-clone-safe to cross IPC. */
function sampleResultRows(rows: unknown[][]): string[][] | undefined {
	if (rows.length === 0) {
		return undefined;
	}
	return rows.slice(0, AMBIENT_SAMPLE_ROWS).map((row) =>
		row.map((cell) => (cell === null || cell === undefined ? 'NULL' : typeof cell === 'object' ? JSON.stringify(cell) : String(cell))));
}

/** One result tab in the results pane (DBeaver-style strip). Each run lands in a tab; pinning a
 *  tab keeps it from being overwritten by the next run. The active tab feeds the live grid. */
interface ResultTab {
	id: string;
	title: string;
	pinned: boolean;
	connectionId: string | undefined;   // the connection that produced the results (edit-safety guard)
	connectionLabel: string;
	response: ExecuteQueryResult | null;
	appliedLimit: number | undefined;   // auto-LIMIT size appended to the run (undefined when none)
	lastSql: string;                    // SQL (or native shell rendering) that produced the results
	lastRawSql: string;                 // the unlimited statement, for "Count total" + "fetch more"
	totalCount: number | null;
	ranAt: number;
	surface: 'sql' | 'native';          // how the run was authored (gates SQL-only count/edit/reconnect)
	nativeQuery?: NativeQuery;          // the executed native query (native surface), for reconnect replay
	rawNativeQuery?: NativeQuery;       // the authored, uncapped native query — the `lastRawSql` of the
	                                    // native surface, re-windowed by "fetch more"
	script?: ScriptRun;                 // present when this tab holds a "Run script" log (vs a grid)
	explain?: ExplainRun;               // present when this tab holds a query PLAN (vs a grid)
	advisories?: Advisory[];            // post-run index/scan advisories from the EXPLAIN plan advisor (Pillar 2 Tier B)
	keyset?: KeysetSequence;            // set when this result is being paged by key rather than OFFSET
}

/** A result opened as a keyset sequence: every "Next" seeks past the last row already loaded
 *  instead of re-counting from the top, so depth costs nothing. Present only
 *  when the run qualified — a plain single-table read (`browseShape`) whose table has a usable key
 *  (`keysetKeyFor`). Absent means this result pages by OFFSET, as before.
 *
 *  The whole sequence shares ONE ordering: the first window was itself fetched in `key` order, which
 *  is what makes appending later windows exact. A tab therefore either is a keyset sequence from its
 *  first row or never becomes one. */
interface KeysetSequence {
	key: KeysetKey;
	/** The statement up to but excluding WHERE, re-issued for each window. */
	select: string;
	/** The author's own WHERE conditions, already parenthesized. */
	conditions: string[];
}

const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** ` · 12.4M rows (45%) · 1.1 GB read · 512 MB memory`: what a running query has done so far. */
function describeProgress(progress: QueryProgress): string {
	const parts: string[] = [];
	if (progress.rowsRead !== undefined) {
		const pct = progress.totalRowsEstimate ? ` (${Math.min(100, Math.round((progress.rowsRead / progress.totalRowsEstimate) * 100))}%)` : '';
		parts.push(`${COMPACT.format(progress.rowsRead)} rows${pct}`);
	}
	if (progress.bytesRead !== undefined) {
		parts.push(`${formatBytes(progress.bytesRead)} read`);
	}
	if (progress.memoryBytes !== undefined) {
		parts.push(`${formatBytes(progress.memoryBytes)} memory`);
	}
	return parts.map((part) => ` · ${part}`).join('');
}

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

/** Where the next keyset window starts: the key values of the last row currently loaded. Returns
 *  undefined when the sequence can't be continued exactly (no rows yet, or a key column that isn't
 *  in the projection / is NULL) — the caller then retires paging rather than seeking from a wrong
 *  position. Derived on demand instead of stored, so it can never disagree with the loaded rows. */
function keysetCursorFor(sequence: KeysetSequence, result: QueryResult, driver: string | undefined): string[] | undefined {
	const last = result.rows[result.rows.length - 1];
	if (!last) {
		return undefined;
	}
	return keysetCursorFrom(sequence.key, result.fields, last, (v) => literalFromValue(v, driver ?? '')) ?? undefined;
}

/** Render a translated MongoDB pipeline as a SQL block comment, to drop below the SQL it came from
 *  ("Get Pipeline Translation"). A comment keeps the SQL buffer valid; copy the array into a Pipeline tab to run. */
function pipelineComment(native: Extract<NativeQuery, { lang: 'mongo' }>): string {
	const body = JSON.stringify(native.pipeline, null, 2);
	return `/* MongoDB pipeline for "${native.collection}" (copy into a Pipeline tab to run):\n${body}\n*/`;
}

export function App(): JSX.Element {
	const [state, setState] = useState<ConnectionsState>(EMPTY_STATE);
	// The cell + row the user has focused in the results grid, reported up by ResultsGrid, so the
	// AI chat can ground in "the value the user is looking at" (ambient context, A3). Cleared when
	// the grid clears its selection (page/result change). Held in a ref (not state) so moving
	// between cells doesn't re-render this large component; getAmbient reads it lazily at send.
	const gridSelectionRef = useRef<{ selectedCell: AmbientCell; selectedRow: AmbientCell[] } | null>(null);
	function setGridSelection(sel: { selectedCell: AmbientCell; selectedRow: AmbientCell[] } | null): void {
		gridSelectionRef.current = sel;
	}
	// The results pane is a strip of result tabs (DBeaver-style): each run lands in a result tab,
	// and pinning a tab keeps it from being overwritten by the next run. One tab is active; the
	// live grid + footer always reflect it. (These are global, not per-editor-tab — the results
	// pane has always been a single shared area.)
	const [resultTabs, setResultTabs] = useState<ResultTab[]>([]);
	const [activeResultId, setActiveResultId] = useState<string | null>(null);
	// The result tab being renamed inline (double-click a chip). window.prompt is unsupported in
	// Electron, so renaming is an in-place <input> rather than a dialog.
	const [renamingResultId, setRenamingResultId] = useState<string | null>(null);
	const resultSeq = useRef(0);
	// Refs mirror the live values so the async run path can resolve a target tab without a stale
	// closure (same pattern as activeIdRef below).
	const resultTabsRef = useRef<ResultTab[]>([]);
	resultTabsRef.current = resultTabs;
	const activeResultIdRef = useRef<string | null>(null);
	activeResultIdRef.current = activeResultId;
	const activeResult = resultTabs.find((t) => t.id === activeResultId) ?? null;
	// Derived views of the active result tab, so every existing read site keeps its old name.
	const response = activeResult?.response ?? null;
	const resultConnectionId = activeResult?.connectionId;   // the connection that produced the results
	const appliedLimit = activeResult?.appliedLimit;         // auto-LIMIT size, for the grid footer
	const lastSql = activeResult?.lastSql ?? '';             // SQL that produced the results (re-run/edit)
	const lastRawSql = activeResult?.lastRawSql ?? '';       // unlimited statement, for "Count total"
	const totalCount = activeResult?.totalCount ?? null;
	// Patch one result tab in place (the active tab's run/count writes go through here).
	const patchResult = useCallback((id: string, partial: Partial<ResultTab>): void => {
		setResultTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...partial } : t)));
	}, []);
	const [countingTotal, setCountingTotal] = useState(false);
	const [activeSchema, setActiveSchema] = useState<DatabaseSchema | null>(null);
	// The companion reads the schema to name the column you meant, through activeSchemaRef (declared
	// further down; read only when a query has failed, long after render).
	const coachQueryError = useCallback((error: string, sql: string | undefined): void => {
		const schema = activeSchemaRef.current;
		const glance: SchemaGlance | null = schema ? { tables: schema.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name) })) } : null;
		const move = queryErrorAdvice(error, sql, glance);
		if (move) {
			libyCall(move);
		}
	}, []);
	// The last statement the app ran, for Orbit's Pulse layer. Held here because App is where
	// every run passes through; Orbit reads it and lights the objects it touched. Undefined until
	// the user runs something, and never read by anything else.
	const [orbitStatement, setOrbitStatement] = useState<OrbitStatement | undefined>(undefined);
	// A focus request from the assistant or a coding agent ("show me orders in Orbit").
	const [orbitFocus, setOrbitFocus] = useState<{ table: string; nonce: number } | undefined>(undefined);
	// The element Orbit's control rail portals into. State rather than a ref, because the view has
	// to re-render when the docked panel appears or goes away.
	const [orbitRailHost, setOrbitRailHost] = useState<HTMLDivElement | null>(null);
	// Result targets (tabs) with a run in flight. A SET, not a single bool, so a long query in one
	// tab never blocks starting another in a different tab: the app is a concurrent client of the
	// per-connection pool. The toolbar/timer/glyph track the ACTIVE tab via the derived `running`.
	const [runningTargets, setRunningTargets] = useState<ReadonlySet<string>>(new Set());
	const runningTargetsRef = useRef<ReadonlySet<string>>(runningTargets);
	runningTargetsRef.current = runningTargets;
	// Wall-clock start of each in-flight run, keyed by result target, for the per-tab elapsed readout.
	const runStartsRef = useRef<Map<string, number>>(new Map());
	// The connection each in-flight run is executing on, keyed by result target, so Cancel targets the
	// connection behind the tab being viewed (runs can now be on different connections at once).
	const runConnsRef = useRef<Map<string, string>>(new Map());
	// Count of in-flight interactive runs per connection, for the status bar's "connections busy"
	// signal: when it reaches the connection's pool size the next query
	// on it queues at the pool. Reactive (unlike the refs above) because the status bar reads it.
	const [runningByConn, setRunningByConn] = useState<Record<string, number>>({});
	const startRunning = useCallback((targetId: string, connectionId: string): void => {
		runStartsRef.current.set(targetId, Date.now());
		runConnsRef.current.set(targetId, connectionId);
		setRunningTargets((s) => { const n = new Set(s); n.add(targetId); return n; });
		setRunningByConn((m) => ({ ...m, [connectionId]: (m[connectionId] ?? 0) + 1 }));
	}, []);
	const stopRunning = useCallback((targetId: string): void => {
		const conn = runConnsRef.current.get(targetId);
		runStartsRef.current.delete(targetId);
		runConnsRef.current.delete(targetId);
		setRunningTargets((s) => { if (!s.has(targetId)) { return s; } const n = new Set(s); n.delete(targetId); return n; });
		if (conn !== undefined) {
			setRunningByConn((m) => {
				const next = (m[conn] ?? 0) - 1;
				const copy = { ...m };
				if (next <= 0) { delete copy[conn]; } else { copy[conn] = next; }
				return copy;
			});
		}
	}, []);
	// "Is the tab I'm looking at running?" — drives the toolbar Run/Cancel toggle, the elapsed timer,
	// the progress bar and the status bar. A different tab's run does not make this true.
	const running = activeResultId !== null && runningTargets.has(activeResultId);
	// Set true to abort an in-flight "Run script" loop: the loop checks it between statements and
	// the Cancel button sets it (alongside the server-side cancel of the current statement).
	const cancelScriptRef = useRef(false);
	// True while a "Run script" loop is in flight. Scripts stay single-flight (unlike single-statement
	// runs, which are concurrent) because cancelScriptRef is shared, so two loops would race it.
	const scriptRunningRef = useRef(false);
	// True only while a Ctrl+Enter/Run that hit a not-yet-connected connection is connecting,
	// so the empty results pane shows a spinner where the user is looking. Connects from the
	// picker/sidebar don't set it, so they never disturb the grid.
	const [connecting, setConnecting] = useState(false);
	// The set of connection ids with a connect() in flight, so each connection's sidebar row (and
	// the toolbar slot for the active one) shows a spinner + Cancel. A SET, not a single id, because
	// launch reconnect can open several at once — each row tracks its own state independently.
	const [connectingIds, setConnectingIds] = useState<ReadonlySet<string>>(new Set());
	const startConnecting = useCallback((id: string): void => {
		setConnectingIds((s) => { const n = new Set(s); n.add(id); return n; });
	}, []);
	const stopConnecting = useCallback((id: string): void => {
		setConnectingIds((s) => { if (!s.has(id)) { return s; } const n = new Set(s); n.delete(id); return n; });
	}, []);
	// Briefly set to a connection id right after it connects from the toolbar, so the slot
	// flashes a success check for ~1.5s before settling. Cleared by a timeout.
	const [connectedFlashId, setConnectedFlashId] = useState<string | null>(null);
	// Elapsed time of the in-flight run (ms), ticked while `running`, for the toolbar timer.
	const [elapsedMs, setElapsedMs] = useState(0);
	// How far the active tab's run has got, from the server, where the driver can say (ClickHouse).
	const [runProgress, setRunProgress] = useState<QueryProgress | null>(null);
	// Live cursor position + selection length of the SQL editor, for the bottom status bar.
	const [cursor, setCursor] = useState({ line: 1, col: 1, selected: 0 });
	const [status, setStatusState] = useState<{ text: string; tone: 'info' | 'danger' }>({ text: '', tone: 'info' });
	// Stable setter; pass tone 'danger' to flag a message that needs to stand out.
	const setStatus = useCallback((text: string, tone: 'info' | 'danger' = 'info') => setStatusState({ text, tone }), []);
	const [form, setForm] = useState<{ existing?: ConnectionConfig; draft?: Partial<ConnectionFormValues> } | null>(null);
	const [importing, setImporting] = useState(false);
	const [pendingRun, setPendingRun] = useState<{ sql: string; targetId: string; verb: string; unfiltered: boolean; hazards: StatementHazard[]; corrected?: string; chatRunId?: string } | null>(null);
	// Pre-flight scan warning: a SELECT the planner says will scan a huge number of
	// rows waits here for the user to confirm. `advisories` are the plan's advisories, reused post-run.
	const [pendingPreflight, setPendingPreflight] = useState<{ sql: string; targetId: string; rows: number; table?: string; advisories: Advisory[]; keyset?: KeysetSequence; plainSql?: string; chatRunId?: string } | null>(null);
	// A SQL run on a document/vector connection the deterministic compiler couldn't translate, parked
	// awaiting consent to spend AI budget.
	const [pendingAiTranscribe, setPendingAiTranscribe] = useState<{ sql: string; targetId: string; chatRunId?: string } | null>(null);
	// A statement with `{name:Type}` placeholders waiting for their values (ClickHouse), and the values
	// last given on each connection, to start the next prompt from.
	const [pendingParams, setPendingParams] = useState<{ raw: string; newTab: boolean; chatRunId?: string; parameters: QueryParameter[] } | null>(null);
	const paramValuesRef = useRef(new Map<string, Record<string, string>>());
	// The settled outcome of the chat's "Run" button, handed back to ChatPanel so the block that was
	// run says what the database did. `chatRunId` rides through every gate below (prod confirm,
	// pre-flight, AI translate) because those hold a run for seconds or minutes before it settles,
	// and each of their exits — confirmed, cancelled, blocked — has to answer the click exactly once.
	const [chatRunOutcome, setChatRunOutcome] = useState<ChatRunOutcome | null>(null);
	// Like pendingRun, but for "Run script": one prod confirm gates the whole batch when any
	// statement is destructive. Confirmed → executeScriptSteps runs the held statements.
	const [pendingScriptRun, setPendingScriptRun] = useState<{ targetId: string; spans: StatementSpan[]; model: monaco.editor.ITextModel | null } | null>(null);
	// Like pendingRun, but for a native pipeline run on prod that writes ($out/$merge).
	const [pendingNativeRun, setPendingNativeRun] = useState<{ native: NativeQuery; display: string; targetId: string } | null>(null);
	// The lightweight Mongo find bar is open.
	const [findOpen, setFindOpen] = useState(false);
	// The visual staged-pipeline builder is open, seeded from the active tab's pipeline (Tier 2).
	const [builderInitial, setBuilderInitial] = useState<object[] | null>(null);
	// The assistant's full view: the ONE assistant, re-homed out of its dock into a roomy, centered
	// conversation that takes over the whole work area (editor + results hidden). A view of the
	// same instance, not a second chat: the thread, the draft and a reply in flight all carry over
	// (see `assistantEl`). Toggled from the assistant's header, the palette and the app menu.
	const [fullChat, setFullChat] = useState(false);
	// A tab coming to the front from anywhere (the palette, a tray command, the assistant opening a
	// view) means the user is meant to SEE it, and full-screen chat hides the workbench. So a change
	// of active tab leaves full chat. The activity bar's own buttons also leave it on click, because
	// re-clicking a view that is already the active tab changes nothing here.
	const lastActiveTabRef = useRef<string | null | undefined>(undefined);
	// The connection Liby grounds on while IT owns the choice: in the full view the editor (and its
	// toolbar) is hidden and may have ZERO tabs, so grounding can't ride `activeTab.connectionId`.
	// Seeded from the editor's connection each time the full view opens, then driven by Liby's own
	// picker; docked, the editor's connection wins again (`assistantConnId` below is the one rule).
	// The send-time gate owns the connect decision (it asks first), so this only SELECTS.
	const [fullChatConnId, setFullChatConnId] = useState<string | undefined>(undefined);
	// Liby is mounted ONCE (on first show) and thereafter only hidden/shown or moved, never
	// unmounted, so the conversation survives closing it, moving it to another dock and switching
	// to the full view. This latches true the first time it is shown; `chatOpen` defaults true, so
	// it flips on the first render exactly as the panel always mounted at boot.
	const [assistantEverOpened, setAssistantEverOpened] = useState(false);
	// The one element Liby is portalled into, for the life of the window. A portal whose container
	// changes remounts its contents, so the container never changes: this element is MOVED instead,
	// by a `DomSlot` in the dock or in the full view (components/DockAreaView.tsx).
	const [assistantEl] = useState(() => {
		const el = document.createElement('div');
		el.className = 'assistant-host';
		return el;
	});
	// Whether agent access (MCP) is on — gates the Agent log activity-bar icon/view.
	const [mcpActive, setMcpActive] = useState(false);
	const [settings, setSettings] = useState<{ tab?: SettingsTab; page?: ProEnginePage } | null>(null);
	const [paletteOpen, setPaletteOpen] = useState(false);
	// Resolved keyboard shortcuts (overrides merged over defaults). Drives the global keydown
	// dispatcher, the editor's bindings, and the palette/command hints. Source: shared/keybindings.ts.
	const [keybindings, setKeybindings] = useState<ResolvedKeybinding[]>([]);
	// Set when main asks to confirm a quit (the tray, the app menu, Ctrl/Cmd+Q); resolves via the
	// ConfirmQuit modal.
	const [quitOpen, setQuitOpen] = useState(false);
	// Set the first time the window is closed: closing hides the app in the tray rather than
	// quitting it, and that has to be said once, before the window goes.
	const [hideNotice, setHideNotice] = useState(false);
	// Set when closing a dirty tab; the ConfirmCloseTab modal confirms the discard.
	const [closeConfirm, setCloseConfirm] = useState<{ id: string; title: string } | null>(null);
	// Auto-update lifecycle (main → renderer); `updateManual` tracks a user-initiated
	// check so we only surface "checking/up to date/error" when the user asked.
	const [update, setUpdate] = useState<UpdateStatus | null>(null);
	const [updateManual, setUpdateManual] = useState(false);
	// True once the user clicks "Later" on the ready-to-install toast: the toast hides but a
	// quiet "Restart to update" pill stays in the status bar so the update isn't lost.
	const [updateDismissed, setUpdateDismissed] = useState(false);
	// About modal (Help → About / command palette) + the app version it shows.
	const [aboutOpen, setAboutOpen] = useState(false);
	// Set when a connect needs a native-driver component that isn't installed (e.g. Db2's client):
	// drives the one-time download prompt, then retries the connect.
	const [componentPrompt, setComponentPrompt] = useState<{ id: string; driver: string; driverLabel: string; requirement: ComponentRequirement } | null>(null);
	const [appVersion, setAppVersion] = useState('');
	/** Below the backend's minimum supported version: the blocking update sheet. Main decides
	 *  it on a deferred check after first paint, so it arrives by event, not at mount. */
	const [minimumVersion, setMinimumVersion] = useState<MinimumVersionState>({ required: false });
	const [memoryBytes, setMemoryBytes] = useState(0);
	// Account + tier + entitlements (logged-out defaults to free / nothing unlocked). The
	// account modal manages sign-in; `authBusy` covers the browser OAuth round-trip.
	// Starts `restoring` because we genuinely don't know yet: main answers auth:state on the next
	// tick, and a returning user must not be shown a sign-in prompt in the meantime. It resolves to
	// false the moment that first answer lands (see the auth effect), so a signed-out user waits
	// only an IPC round-trip for their prompt.
	const [auth, setAuth] = useState<AuthState>({ user: null, tier: 'free', entitlements: { aiLogging: true, agentMode: false, byok: false, scheduledFlows: false }, restoring: true });
	const [authBusy, setAuthBusy] = useState(false);
	/** Why the last sign-in did not start, shown on the sign-in form itself: the notification alone
	 *  sat under the full-window Settings page, so "Continue" looked like it did nothing. */
	const [signInError, setSignInError] = useState<string | null>(null);
	const [aiInlineEnabled, setAiInlineEnabled] = useState(false);
	const [aiInlineMode, setAiInlineMode] = useState<InlineCompletionMode>('manual');
	// Bumped when the settings modal closes, so the chat panel re-reads AI settings.
	const [settingsRev, setSettingsRev] = useState(0);
	// Bumped after the app saves/creates a workspace file, so the Workspace panel re-lists.
	const [workspaceRev, setWorkspaceRev] = useState(0);
	// Bumped when the assistant's remember_this capability saves a note, so the chat's
	// "Knows N things" chip counts it right away instead of waiting for the next settings close.
	const [knowledgeRev, setKnowledgeRev] = useState(0);
	// Whether the workspace import modal (this computer / DBeaver) is open.
	const [workspaceImport, setWorkspaceImport] = useState(false);
	// Set when "New collection" is clicked on a document connection: the name-prompt modal.
	const [newCollection, setNewCollection] = useState<{ connectionId: string; name: string } | null>(null);
	const [newCollectionBusy, setNewCollectionBusy] = useState(false);
	// Set when the user clicks "Fix with AI" on a query error: hands the failed SQL + error to
	// the chat panel, which opens a fresh chat grounded in that connection's schema. The nonce
	// re-triggers the panel's effect even when the same error is fixed twice.
	const [fixRequest, setFixRequest] = useState<{ nonce: number; sql: string; error: string; connectionId?: string; prompt?: string } | null>(null);
	// Set when the user clicks "Add to Chat" on a selection (or hits Ctrl+L): drops the selected
	// SQL into the chat composer as context, without sending. The nonce re-triggers each time.
	const [addToChatRequest, setAddToChatRequest] = useState<{ nonce: number; text: string } | null>(null);
	// Set by the editor's AI context-menu actions (Explain SQL / SQL Optimization / Text to SQL):
	// opens the chat panel and auto-runs a turn with the built prompt. The nonce re-triggers each time.
	const [askRequest, setAskRequest] = useState<{ nonce: number; prompt: string; connectionId?: string } | null>(null);
	// A Query Performance row action (Analyze / Suggest optimization): the grid's per-row buttons fire
	// this, opening the assistant and running the matching grounded turn on the chosen statement. The
	// nonce re-triggers even when the same statement+action is picked twice.
	const [perfActionRequest, setPerfActionRequest] = useState<{ nonce: number; action: 'analyze' | 'optimize'; connectionId: string; sql: string } | null>(null);
	// Which monitor the monitors view should show when something outside it made one (the
	// ClickHouse Operations panel's "Monitor over time"). The nonce is what makes a second request
	// for the SAME monitor arrive at all.
	const [monitorFocus, setMonitorFocus] = useState<{ nonce: number; id: string } | undefined>(undefined);
	// A user/privilege change the assistant proposed. It opens the Users & Privileges review sheet
	// with the exact statements; the assistant cannot run them.
	const [securityProposal, setSecurityProposal] = useState<{ nonce: number; draft?: PrincipalDraft; changes?: SecurityChange[] } | null>(null);
	// The notifications center (a persistent history of errors/events) and the transient toast
	// that pops for a freshly-recorded error.
	const [notifOpen, setNotifOpen] = useState(false);
	const [toast, setToast] = useState<AppNotification | null>(null);
	// Snoutbot's own card. Its own state and not a notification, because the interesting half is
	// transient one: a review that is RUNNING has nothing to keep, and the centre's rule (a clean
	// review that posted itself leaves no entry) is right for history and wrong for the nine
	// seconds after somebody pressed "Check now".
	const [reviewToast, setReviewToast] = useState<ReviewToastState | null>(null);
	/** Which review the view should show, when something outside it asked. */
	const [reviewSelect, setReviewSelect] = useState<{ runId: string; nonce: number } | undefined>();
	const notifications = useNotifications();
	const prodUnlocked = useProdUnlocked();
	const unreadCount = notifications.reduce((n, x) => n + (x.read ? 0 : 1), 0);
	const [theme, setTheme] = useState<Theme>(() => loadTheme());
	const [layout, setLayout] = useState<Layout>(() => loadLayout());
	// `chatOpen` is no longer its own state: since docking the assistant is a tool window like
	// any other, so "is it open" is "is its area showing it", wherever the user has put it. The
	// setter is kept with the same shape so every call site reads unchanged.
	const chatOpen = isToolVisible(layout.docks, 'assistant');
	const setChatOpen = useCallback((next: boolean | ((open: boolean) => boolean)): void => {
		setLayout((l) => {
			const open = typeof next === 'function' ? next(isToolVisible(l.docks, 'assistant')) : next;
			return { ...l, docks: open ? showTool(l.docks, 'assistant') : hideTool(l.docks, 'assistant') };
		});
	}, []);
	/** Every dock change goes through here, so the layout stays the single source of placement. */
	const setDocks = useCallback((fn: (docks: DockLayout) => DockLayout): void => {
		setLayout((l) => ({ ...l, docks: fn(l.docks) }));
	}, []);
	/** The tools on screen right now, in any area: what the activity bar highlights. */
	const shownTools: ToolId[] = useMemo(() => DOCK_AREAS
		.map((area) => (layout.docks[area].collapsed ? null : layout.docks[area].active))
		.filter((tool): tool is ToolId => tool !== null), [layout.docks]);
	// The host elements the tools portal into, one per area. In state rather than a ref because
	// the portals can only be created once the hosts have rendered.
	const [dockHosts, setDockHosts] = useState<Record<DockArea, HTMLDivElement | null>>({ left: null, right: null, bottom: null });
	// One STABLE callback per area, deliberately. React calls a ref callback with null and then the
	// element every time its identity changes, so an inline arrow here would detach and reattach the
	// host on every render, and since attaching sets state, that is an infinite render loop.
	const setHost = useCallback((area: DockArea, el: HTMLDivElement | null): void => {
		setDockHosts((hosts) => (hosts[area] === el ? hosts : { ...hosts, [area]: el }));
	}, []);
	const dockHostRefs = useMemo(() => ({
		left: (el: HTMLDivElement | null) => setHost('left', el),
		right: (el: HTMLDivElement | null) => setHost('right', el),
		bottom: (el: HTMLDivElement | null) => setHost('bottom', el),
	}), [setHost]);
	// Which tools have ever been on screen. A console (a live PTY) and the assistant (a
	// conversation) are mounted from the first time they are shown and never unmounted after,
	// which is what makes hiding and moving them free. Latched during render, deliberately: the
	// render that first shows a tool is the one that has to mount it.
	const everShownRef = useRef<Set<ToolId>>(new Set());
	for (const tool of shownTools) { everShownRef.current.add(tool); }
	// The "move this panel" menu, opened from a panel's own header or its activity-bar icon.
	const [panelMenu, setPanelMenu] = useState<{ tool: ToolId; x: number; y: number } | null>(null);
	// A panel being dragged: what is being carried, where the pointer is, and where it would land.
	const [drag, setDrag] = useState<{ tool: ToolId; rect: DockRect; x: number; y: number; over: DockArea | null } | null>(null);
	const bandRef = useRef<HTMLDivElement | null>(null);
	/**
	 * Drag a panel to where you want it. Pointer events rather than HTML5 drag-and-drop: we want
	 * our own drop bands drawn in the app's own tokens, a drag that can be abandoned with Escape,
	 * and no ghost image the OS picked for us.
	 *
	 * It only becomes a drag after the pointer has actually MOVED a few pixels, so a plain click on
	 * a header (or on the icon of a panel you just want to open) still behaves like a click.
	 */
	const beginToolDrag = useCallback((tool: ToolId, event: React.PointerEvent, fromIcon = false): void => {
		// A header's own buttons (collapse, refresh, close) are not drag handles. The activity-bar
		// icon IS one, and it is a button, so it says so.
		if (event.button !== 0 || (!fromIcon && (event.target as HTMLElement).closest('button, input, select, textarea, a'))) {
			return;
		}
		const band = bandRef.current;
		if (!band) {
			return;
		}
		// Read fresh on every move rather than once here: the window can be resized mid-drag, and
		// a cached rect would go on drawing bands for the window that used to be there.
		const bandRect = (): DockRect => {
			const box = (bandRef.current ?? band).getBoundingClientRect();
			return { left: box.left, top: box.top, width: box.width, height: box.height };
		};
		const startX = event.clientX;
		const startY = event.clientY;
		let started = false;
		const move = (moved: PointerEvent): void => {
			if (!started && Math.hypot(moved.clientX - startX, moved.clientY - startY) < 5) {
				return;
			}
			started = true;
			const rect = bandRect();
			setDrag({ tool, rect, x: moved.clientX, y: moved.clientY, over: areaAtPoint(moved.clientX, moved.clientY, rect) });
		};
		const finish = (dropped: PointerEvent | null): void => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('keydown', cancel, true);
			if (started && dropped) {
				const area = areaAtPoint(dropped.clientX, dropped.clientY, bandRect());
				// A drop in the middle is a cancel, not a guess at what the user meant.
				if (area) {
					setDocks((d) => moveTool(d, tool, area));
				}
			}
			setDrag(null);
		};
		const up = (event2: PointerEvent): void => finish(event2);
		const cancel = (key: KeyboardEvent): void => {
			if (key.key === 'Escape') { finish(null); }
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('keydown', cancel, true);
	}, [setDocks]);
	/**
	 * Right-click inside a docked panel. Only its HEADER opens the move menu: a right-click in a
	 * tree, a conversation or a terminal belongs to whatever is under it, and stealing it would
	 * break the agent console (where the right button is a paste in most terminals).
	 */
	const toolContextMenu = useCallback((tool: ToolId) => (event: React.MouseEvent<HTMLDivElement>): void => {
		if (!(event.target as HTMLElement).closest('.sidebar-header, .chat-header, .pane-header')) {
			return;
		}
		event.preventDefault();
		setPanelMenu({ tool, x: event.clientX, y: event.clientY });
	}, []);
	const [appSettings, setAppSettings] = useState<AppSettings>(() => loadAppSettings());
	// Stable read of the latest settings for callbacks that shouldn't be re-created on every change
	// (e.g. executeSql needs the current `aiAutoTranscribe` without taking appSettings as a dep).
	const appSettingsRef = useRef(appSettings);
	appSettingsRef.current = appSettings;
	const [confirm, confirmDialog] = useConfirm();
	// First-run onboarding: the spotlight tour + the "Getting started" checklist. `tourActive`
	// is transient (not persisted); `onboarding` carries the durable "seen / dismissed / tasks".
	const [onboarding, setOnboarding] = useState<OnboardingState>(() => loadOnboarding());
	const [tourActive, setTourActive] = useState(false);
	const [checklistOpen, setChecklistOpen] = useState(false);
	// "Find your databases": 'firstRun' is the popup a fresh install opens with, before the tour;
	// 'manual' is the same screen opened later from the palette or the import pre-screen. Closing
	// the first-run one marks it seen and lets the tour start.
	const [discovery, setDiscovery] = useState<'firstRun' | 'manual' | null>(null);
	// Set when the first-run popup handed off to the connection form: the tour waits for that form.
	const tourAfterFormRef = useRef(false);

	useEffect(() => {
		applyTheme(theme);
	}, [theme]);
	// The quick toggle (activity-bar icon, command palette) cycles through the registry, so
	// every theme is reachable without opening Settings; the Settings picker selects directly.
	const toggleTheme = (): void => setTheme((t) => nextTheme(t));

	// Persist onboarding progress (tour-seen / checklist-dismissed / completed tasks).
	useEffect(() => {
		saveOnboarding(onboarding);
	}, [onboarding]);

	// On first ever launch, auto-start the spotlight tour. On later launches, reopen the
	// getting-started checklist until the user finishes or dismisses it. Runs once, and never
	// when the user has turned onboarding off in Settings (manual launch still works).
	useEffect(() => {
		if (appSettings.disableOnboarding) {
			return;
		}
		if (!onboarding.discoverySeen) {
			// Before the tour and everything else. Mounting it scans nothing: the scan waits for the
			// user's "Find databases", so the boot path is untouched.
			setDiscovery('firstRun');
		} else if (!onboarding.tourSeen) {
			setTourActive(true);
		} else if (!onboarding.checklistDismissed && !allTasksDone(onboarding)) {
			setChecklistOpen(true);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// The companion's moments: anything may request one; this decides whether it is worth sending
	// (hidden, already sent, or a milestone already seen or with onboarding off) and passes it to the
	// companion (`libyMoment`), which decides the rest. A milestone is marked seen when sent, so it is
	// never sent twice even if the app quits mid-way; the launch greeting is never marked. Coaching
	// calls go to the companion directly (`libyCall`), and the host's `busy` reports the tour.
	const tourActiveRef = useRef(tourActive);
	tourActiveRef.current = tourActive;
	useEffect(() => onMomentRequest((id) => {
		const moment = MOMENTS[id];
		const seen = loadMomentsSeen();
		if (!shouldShowMoment(moment, seen, getStage().queue.map((t) => t.id), appSettingsRef.current)) {
			return;
		}
		if (moment.kind === 'milestone') {
			saveMomentsSeen([...seen, id]);
		}
		libyMoment({ id, kind: moment.kind, line: messageFor(id, moment.message, false), mood: moment.mood ?? 'hello', introduces: id === 'launch' && !loadIntroduced() });
	}), []);
	// Where the user is working, so the companion goes there. One passive listener,
	// after first paint.
	useEffect(() => {
		trackAttention();
	}, []);
	// Say hello on every launch, once the window is idle (never on the boot path). Not on the launch
	// that auto-starts the first-run tour: the tour's own welcome follows it.
	useEffect(() => {
		if (!onboarding.tourSeen && !appSettings.disableOnboarding) {
			return;
		}
		const greet = (): void => {
			// The first introduction on this profile is made from the assistant's panel, so a
			// hidden panel is opened first and laid out before it is asked.
			if (!appSettingsRef.current.disableMascot && !loadIntroduced()) {
				setChatOpen(true);
				window.setTimeout(() => requestMoment('launch'), 450);
				return;
			}
			requestMoment('launch');
		};
		const idle = window.requestIdleCallback?.(greet, { timeout: 4000 }) ?? window.setTimeout(greet, 1500);
		return () => {
			window.cancelIdleCallback?.(idle);
			window.clearTimeout(idle);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	// A getting-started task going from not done to done is a first, and so is finishing the list.
	// Compared against the previous snapshot, so tasks already done at launch never fire.
	const prevTasksRef = useRef(onboarding.tasks);
	useEffect(() => {
		const before = prevTasksRef.current;
		prevTasksRef.current = onboarding.tasks;
		if (before === onboarding.tasks) {
			return;
		}
		const done = newlyDoneTasks(before, onboarding.tasks);
		for (const id of done) {
			requestMoment(id);
		}
		if (done.length > 0 && allTasksDone(onboarding)) {
			requestMoment('allDone');
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onboarding.tasks]);

	// Mark a getting-started task done (idempotent — never un-checks or re-renders needlessly).
	const markTask = useCallback((id: ChecklistTaskId): void => {
		setOnboarding((o) => (o.tasks[id] ? o : { ...o, tasks: { ...o.tasks, [id]: true } }));
	}, []);

	function startTour(): void {
		setTourActive(true);
	}

	// The discovery popup closed. The first-run one counts as answered however it closed (Skip, Esc,
	// the close button, an import), and the tour it was holding back starts now, unless the user went
	// on to add a connection by hand, in which case it waits for that form.
	function closeDiscovery(options: { toForm?: boolean } = {}): void {
		const firstRun = discovery === 'firstRun';
		setDiscovery(null);
		if (!firstRun) {
			return;
		}
		setOnboarding((o) => ({ ...o, discoverySeen: true }));
		if (!onboarding.tourSeen && !appSettings.disableOnboarding) {
			if (options.toForm) {
				tourAfterFormRef.current = true;
			} else {
				setTourActive(true);
			}
		}
	}

	// Tour finished or skipped: remember it, and surface the checklist next (unless dismissed).
	function finishTour(): void {
		setTourActive(false);
		// The tour's first card introduces the assistant, so the package is told not to again.
		markLibyIntroduced();
		requestMoment('welcome');
		setOnboarding((o) => ({ ...o, tourSeen: true }));
		if (!onboarding.checklistDismissed && !allTasksDone(onboarding)) {
			setChecklistOpen(true);
		}
	}

	function dismissChecklist(): void {
		setChecklistOpen(false);
		setOnboarding((o) => ({ ...o, checklistDismissed: true }));
	}

	// Pop the getting-started checklist out as the side card (un-dismissing it if needed) —
	// used by the Welcome button, the Help menu, and the command palette.
	function openChecklist(): void {
		setOnboarding((o) => (o.checklistDismissed ? { ...o, checklistDismissed: false } : o));
		setChecklistOpen(true);
	}

	// Clicking a not-yet-done checklist task jumps the user to where they'd do it.
	function runChecklistTask(id: ChecklistTaskId): void {
		if (id === 'addConnection') { setForm({}); }
		else if (id === 'run') { if (tabs.length === 0) { newQueryTab(); } editorRef.current?.focus(); }
		else if (id === 'explore') { showSideView('connections'); }
		else if (id === 'ai') { setChatOpen(true); }
		else if (id === 'save') { void saveCurrentQuery(); }
	}

	// Subscribe to update status, then kick off a silent check. A fresh status clears any prior
	// "Later" dismissal so a newly-ready update surfaces its toast again. The check is deferred
	// off the boot path (like VSCode/Cursor delay their update check): we wait for the window to
	// go idle before the GitHub Releases round-trip, so first paint never competes with it.
	useEffect(() => {
		const off = window.sqlApi.onUpdateStatus((s) => { setUpdate(s); setUpdateDismissed(false); });
		const check = () => void window.sqlApi.checkForUpdate();
		const idle = window.requestIdleCallback?.(check, { timeout: 30000 }) ?? window.setTimeout(check, 30000);
		return () => {
			window.cancelIdleCallback?.(idle);
			window.clearTimeout(idle);
			off();
		};
	}, []);

	// Load the app version once (shown in the About modal).
	useEffect(() => {
		void window.sqlApi.appVersion().then(setAppVersion);
	}, []);

	// The minimum-version verdict: ask once (a reload after main already decided), then follow it.
	useEffect(() => {
		const off = window.sqlApi.onMinimumVersion(setMinimumVersion);
		void window.sqlApi.minimumVersion().then(setMinimumVersion);
		return off;
	}, []);

	// After an update lands on a new version, open the Release Notes document once (VSCode parity).
	// A fresh install (no version recorded yet) records silently — notes auto-open only after an
	// actual version change. Gated on the Settings toggle; the Help menu / palette open it anyway.
	useEffect(() => {
		if (!appVersion) {
			return;
		}
		const last = onboarding.lastReleaseNotesVersion;
		if (last === appVersion) {
			return;
		}
		if (last !== null && appSettings.showReleaseNotesAfterUpdate && hasReleaseNotes()) {
			openReleaseNotes();
		}
		setOnboarding((o) => ({ ...o, lastReleaseNotesVersion: appVersion }));
		// Fires when the version resolves; not re-run on onboarding/settings changes by design.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [appVersion]);

	// Poll total app memory (working set across all processes) for the status bar, and beside it
	// what the local model is holding — two numbers rather than one, because the model runs in its
	// own process and often on its own machine, so no single total is true of both.
	// Deferred to idle so the first sample never competes with the initial render/load.
	useEffect(() => {
		let alive = true;
		let interval = 0;
		const tick = () => {
			void window.sqlApi.appMemory().then((m) => {
				if (alive) {
					setMemoryBytes(m.bytes);
				}
			});
		};
		const start = () => {
			if (!alive) {
				return;
			}
			tick();
			interval = window.setInterval(tick, 10000);
		};
		const idle = window.requestIdleCallback?.(start, { timeout: 5000 }) ?? window.setTimeout(start, 2000);
		return () => {
			alive = false;
			window.cancelIdleCallback?.(idle);
			window.clearTimeout(idle);
			window.clearInterval(interval);
		};
	}, []);

	// A Linux desktop with no password vault: passwords are saved anyway, in a file only the user's
	// account can read, and the user is told so once per profile (main/secretStorageMode.ts). Off the
	// boot path, and a single IPC read on every other launch.
	useEffect(() => {
		let alive = true;
		const read = (): void => {
			void window.sqlApi.secretStorage.status().then((s) => {
				if (!alive || !s.warn) {
					return;
				}
				notify({
					severity: 'warn',
					source: 'secrets',
					title: "Passwords are saved without a password vault",
					detail: "This computer has no password vault (keyring), so Studio saves your database passwords in a file only your user account can read. Anyone who can use your account could read them. To keep them in a vault, install one, such as GNOME Keyring, and restart Studio.",
				});
				void window.sqlApi.secretStorage.warned();
			}).catch(() => undefined);
		};
		const idle = window.requestIdleCallback?.(read, { timeout: 5000 }) ?? window.setTimeout(read, 2000);
		return () => {
			alive = false;
			window.cancelIdleCallback?.(idle);
			window.clearTimeout(idle);
		};
	}, []);

	// Readings the extraction model has left for somebody to check, badged on the Data Flows icon
	// (Data Flows' renderer half; zero in a build without it).
	const reviewCount = useReviewCount(settingsRev);

	// Snoutbot's ambient reading: is it set up, and is it holding a review nobody has read.
	// Feeds the activity-bar icon and the app menu.
	//
	// Event-driven and deferred off boot, like every other reading here. One call answers both
	// questions, and main already broadcasts on every change (a review finishing, one being
	// approved or discarded, a host being connected), so nothing polls the poller.
	const [snoutbot, setSnoutbot] = useState<{ show: boolean; awaiting: number }>({ show: false, awaiting: 0 });
	useEffect(() => {
		let alive = true;
		const apply = (status: ReviewStatus): void => {
			if (alive) {
				// Either half counts as set up: a connected host with nothing watched yet is somebody
				// mid-setup, and a watched repository whose token was since removed still has reviews.
				setSnoutbot({
					show: status.repos.length > 0 || status.forges.some((f) => f.hasToken),
					awaiting: status.awaiting,
				});
			}
		};
		const read = (): void => { void window.sqlApi.review.status().then(apply).catch(() => undefined); };
		const idle = window.requestIdleCallback?.(read, { timeout: 5000 }) ?? window.setTimeout(read, 2000);
		const off = window.sqlApi.onReviewChanged(apply);
		return () => {
			alive = false;
			window.cancelIdleCallback?.(idle);
			window.clearTimeout(idle);
			off();
		};
	}, []);

	// Load the current account on mount and follow auth changes (sign-in completes via the
	// OAuth redirect, or sign-out). Each change settles `authBusy` and refreshes entitlements.
	useEffect(() => {
		// The initial pull and the change broadcast race: if main resolves the session while our
		// authState() call is in flight, the reply we get back is already stale, and applying it
		// would revert a signed-in user to the restoring skeleton until the next auth event. The
		// broadcast is always the fresher of the two, so once one lands the pull is discarded.
		let pushed = false;
		void window.sqlApi.authState().then((s) => {
			if (!pushed) {
				setAuth(s);
			}
		});
		// Bump settingsRev too, so the chat panel re-reads the live provider/model list: a tier
		// change or a background entitlement re-sync may have widened the models the key can reach.
		return window.sqlApi.onAuthChanged((s) => { pushed = true; setAuth(s); setAuthBusy(false); setSettingsRev((r) => r + 1); });
	}, []);

	function signIn(provider: AuthProviderId, workEmail?: string): void {
		setAuthBusy(true);
		setSignInError(null);
		void window.sqlApi.authSignIn(provider, workEmail).catch((err) => {
			notifyError("Sign-in failed", errorMessage(err), { source: 'auth' });
			setSignInError(errorMessage(err));
			setAuthBusy(false);
		});
	}

	function signOut(): void {
		setAuthBusy(true);
		// Stay on the Account tab so the signed-out state shows; authBusy clears on auth change.
		void window.sqlApi.authSignOut();
	}

	// The app menu's items dispatch by command id; run the matching command. Read through a
	// ref so the handler always sees the current closures (commands is rebuilt each render).
	const commandsRef = useRef<Command[]>([]);
	/** Opens a project's tab at Overview, kept current each render for runMenuCommand. */
	const openProjectRef = useRef<((target: ProjectTarget, name: string) => void) | null>(null);
	const keybindingsRef = useRef<ResolvedKeybinding[]>([]);
	keybindingsRef.current = keybindings;
	// The capability context the AI agent reaches the app through. Rebuilt each render (so it
	// closes over fresh state/handlers) and read by the capability-request listener via a ref.
	const capabilityCtxRef = useRef<CapabilityContext | null>(null);
	// A menu item's command, wherever the menu was drawn: main broadcasts these from the native
	// menu bar (macOS), and the custom title bar calls the same function directly for the menu it
	// draws itself on a frameless window. Stable identity so the title bar does not re-render on
	// every keystroke elsewhere in the app.
	const runMenuCommand = useCallback((id: string) => {
		if (id === 'commandPalette') {
			setPaletteOpen(true);
			return;
		}
		// The tray's "Show in App" on a project: one command per project would need the project
		// list here, and only the Dashboard panel has that.
		const project = parseOpenProjectCommand(id);
		if (project) {
			openProjectRef.current?.(project.target, project.name);
			return;
		}
		commandsRef.current.find((c) => c.id === id)?.run();
	}, []);
	useEffect(() => window.sqlApi.onMenuCommand(runMenuCommand), [runMenuCommand]);

	// Load the keyboard shortcuts and keep them current (a Settings rebind broadcasts a change).
	useEffect(() => {
		let active = true;
		void window.sqlApi.keybindings.get().then((b) => { if (active) { setKeybindings(b); } });
		const off = window.sqlApi.keybindings.onChanged((b) => setKeybindings(b));
		return () => { active = false; off(); };
	}, []);

	// An external agent (the console, or any MCP client) asking to change the app. It has no chat
	// turn to ask inside, so the question stands on its own. One at a time: a queue of consent
	// prompts is how a user starts clicking Allow without reading.
	const [agentAction, setAgentAction] = useState<AgentActionRequest | null>(null);
	useEffect(() => {
		return window.sqlApi.agentConsole.onApprovalRequest((request) => setAgentAction(request));
	}, []);
	// The coding agents this machine has. Main decides which are VISIBLE: installed, and not
	// switched off by the user. It re-probes on launch and tells us, so an agent installed while
	// the app is running turns up on the activity bar by itself.
	const [agentStatuses, setAgentStatuses] = useState<AgentConsoleStatus[]>([]);
	useEffect(() => {
		const load = (): void => { void window.sqlApi.agentConsole.statuses().then(setAgentStatuses).catch(() => undefined); };
		load();
		return window.sqlApi.agentConsole.onChanged(load);
	}, []);
	const visibleAgents = useMemo(() => agentStatuses.filter((a) => a.visible), [agentStatuses]);
	// Each agent's console is its OWN tool window, so there is no single "the dock's agent" any
	// more. This is the one the palette's Restart command acts on: whichever console is showing,
	// else the first agent the user has.
	const consoleKind: AgentKind = useMemo(() => {
		const showing = visibleAgents.find((a) => isToolVisible(layout.docks, `agent:${a.kind}`));
		return showing?.kind ?? visibleAgents[0]?.kind ?? 'claude';
	}, [layout.docks, visibleAgents]);

	// Where a push lands when the MCP client did not name itself recognisably: whichever console is
	// showing, so an unknown agent still draws somewhere the user is looking.
	useEffect(() => {
		setCanvasFallbackAgent(consoleKind);
	}, [consoleKind]);

	/*
	 * Keep each agent's surface where its console says it belongs (docking.ts, `agentSurfaceHome`).
	 *
	 * A console in a side dock renders its own surface; a console in the bottom strip has no room to
	 * be a terminal and a reading surface at once, so what it draws opens a workbench tab. This
	 * effect is the only thing that opens or closes that tab, and it runs both when the agent draws
	 * (the store is outside React) and when the user moves the console (the layout changed under it).
	 *
	 * The MARK is what stops a tab the user closed from reopening on its own: it remembers the last
	 * push a tab was opened for, so the tab comes back on something NEW and not on the next unrelated
	 * layout change.
	 */
	const agentTabMark = useRef(new Map<AgentKind, string>());
	useEffect(() => {
		const sync = (): void => {
			for (const kind of AGENT_KINDS) {
				const existing = tabsRef.current.find((t) => t.kind === 'agentView' && t.agent === kind);
				if (agentSurfaceHome(layout.docks, kind) === 'panel') {
					// The surface moved into the console. Leaving the tab behind would render the same
					// push in two places, which is two things to dismiss and two places to look.
					agentTabMark.current.delete(kind);
					if (existing) {
						closeAgentTab(existing.id);
					}
					continue;
				}
				const latest = canvasFor(kind).at(-1)?.id;
				if (!latest) {
					continue;
				}
				if (existing) {
					// The tab is already open. A push does NOT steal focus from the editor the user is
					// typing in; it marks the tab instead, so new work is visible without taking the screen.
					if (agentTabMark.current.get(kind) !== latest && activeTabIdRef.current !== existing.id) {
						setTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, attention: true } : t)));
					}
					agentTabMark.current.set(kind, latest);
					continue;
				}
				if (agentTabMark.current.get(kind) === latest) {
					// Nothing new since the tab the user closed: opening it again would be the app arguing.
					continue;
				}
				agentTabMark.current.set(kind, latest);
				openAgentTab(kind);
			}
		};
		sync();
		return subscribeCanvas(sync);
	}, [layout.docks]);

	// What an agent is doing to the app right now, for the status bar.
	const [agentActing, setAgentActing] = useState<string | undefined>(undefined);
	useEffect(() => {
		return window.sqlApi.agentConsole.onActing(({ acting, name }) => setAgentActing(acting ? name : undefined));
	}, []);
	const answerAgentAction = useCallback((answer: AgentApproval) => {
		setAgentAction((current) => {
			if (current) {
				void window.sqlApi.agentConsole.respondApproval(current.callId, answer);
			}
			return null;
		});
	}, []);

	// A program on this computer (the `snoutdata` CLI, most often) asking to use the signed-in
	// account, so it does not have to send the person to a browser mid-task. Answering yes creates a
	// NEW revocable token; the app's own sign-in is never handed over.
	const [cliSignIn, setCliSignIn] = useState<CliSignInRequest | null>(null);
	useEffect(() => {
		return window.sqlApi.mcp.onSignInRequest((request) => setCliSignIn(request));
	}, []);
	const answerCliSignIn = useCallback((answer: CliSignInAnswer) => {
		setCliSignIn((current) => {
			if (current) {
				void window.sqlApi.mcp.respondSignIn(current.requestId, answer);
			}
			return null;
		});
	}, []);

	// Register the always-on AI capabilities and route the agent's capability invocations through
	// the registry to the app. This is the renderer end of the main↔renderer capability bridge —
	// the seam that lets the chat drive the whole app (see src/shared/capabilities.ts).
	useEffect(() => {
		installLogBuffer();
		// `capabilityRegistry` is a module-level singleton that outlives this component, while dev
		// HMR can re-run this effect without running its cleanup (orphaning the prior registration).
		// Drop any leftover registration of these names first so re-running never throws on a dup
		// (which, with no error boundary above, would white-screen the app). register() still throws
		// on a genuine in-build duplicate name, which is the programmer error it's meant to catch.
		for (const h of staticCapabilities) {
			capabilityRegistry.unregister(h.spec.name);
		}
		const unregisters = staticCapabilities.map((h) => capabilityRegistry.register(h));
		// Keep main's standing copy of the manifest current. The chat sends its own per request;
		// this is what an EXTERNAL agent (the agent console, or any MCP client) is offered, and it
		// has no request to hang a manifest off. Coalesced to a microtask so registering fifteen
		// capabilities in a row is one IPC call, not fifteen.
		let publishQueued = false;
		function publishCapabilities(): void {
			if (publishQueued) {
				return;
			}
			publishQueued = true;
			void Promise.resolve().then(() => {
				publishQueued = false;
				void window.sqlApi.publishCapabilities(capabilityRegistry.list());
			});
		}
		const offChange = capabilityRegistry.onChange(publishCapabilities);
		publishCapabilities();
		const offRequest = window.sqlApi.onAiCapabilityRequest(async ({ requestId, invocation }) => {
			const ctx = capabilityCtxRef.current;
			const result = ctx
				? await capabilityRegistry.invoke(invocation, ctx)
				: { ok: false, summary: '', error: 'The app is not ready.' };
			void window.sqlApi.respondCapability(requestId, invocation.id, result);
		});
		return () => {
			offRequest();
			offChange();
			for (const off of unregisters) {
				off();
			}
		};
	}, []);

	function checkForUpdates(): void {
		setUpdateManual(true);
		setUpdate({ state: 'checking' });
		void window.sqlApi.checkForUpdate();
	}

	function dismissUpdate(): void {
		// A downloaded update isn't truly dismissable — "Later" collapses it to a quiet status-bar
		// restart pill (see updateDismissed). Any other state (manual check feedback) just clears.
		if (update?.state === 'downloaded') {
			setUpdateDismissed(true);
		} else {
			setUpdate(null);
			setUpdateManual(false);
		}
	}

	// The toast is reserved for moments that warrant a card: the "ready to install" CTA
	// (downloaded), and the feedback for an explicit "Check for Updates…" (checking / up-to-date
	// / available / error). Download PROGRESS is ambient in the status bar, never a toast, on
	// every platform (Windows reports a percent, macOS doesn't; Linux never reaches these states).
	// A dismissed "ready" toast collapses to the status-bar restart pill.
	const showToast = update !== null && !updateDismissed && (
		update.state === 'downloaded' ||
		(updateManual && update.state !== 'downloading')
	);

	// Activity-bar selection: clicking the icon of the view already showing puts it away (the
	// VSCode toggle we have always had), otherwise show it — wherever the user has docked it.
	function selectSideView(view: SideView): void {
		setDocks((d) => toggleTool(d, view));
	}

	/** Bring a view out, and never put it away. What the tour and every "go and look at this"
	 *  affordance wants: `selectSideView` TOGGLES, so calling it when the view is already open
	 *  hides the very thing the caller is about to point at. */
	function showSideView(view: SideView): void {
		setDocks((d) => showTool(d, view));
	}

	// Track whether agent access (MCP) is on, so the Agent log icon/view shows only then.
	// Re-read on mount and whenever Settings closes (where the toggle lives).
	// The same read tells the person, once, when agents cannot reach the broker: a port another
	// program took (it never moves by itself) or a sender locked out for wrong tokens.
	const mcpNoticeShown = useRef<string | null>(null);
	const noticeMcpProblem = useCallback((status: McpStatus): void => {
		const problem = status.problem;
		if (!problem) {
			mcpNoticeShown.current = null;
			return;
		}
		const key = problem.kind === 'port-in-use' ? `port:${problem.port}` : `lockout:${problem.remote}:${problem.until}`;
		if (mcpNoticeShown.current === key) {
			return;
		}
		mcpNoticeShown.current = key;
		const notice = mcpProblemNotice(problem);
		notify({ severity: problem.kind === 'port-in-use' ? 'error' : 'warn', title: notice.title, detail: notice.detail, source: 'agent-access' });
	}, []);
	const refreshMcpActive = useCallback((): void => {
		void window.sqlApi.mcp.status().then((s) => {
			setMcpActive(s.enabled);
			noticeMcpProblem(s);
		}).catch(() => setMcpActive(false));
	}, [noticeMcpProblem]);
	useEffect(() => { refreshMcpActive(); }, [refreshMcpActive]);
	useEffect(() => window.sqlApi.mcp.onChanged(() => refreshMcpActive()), [refreshMcpActive]);
	/**
	 * A tool can stop existing while it is on screen: an agent switched off in Settings, the Agent
	 * log when agent access is turned off. Whatever is showing then has to give way to something
	 * that is actually there, or the area sits open around nothing.
	 *
	 * `available` is the one place that decides, and `dropTool` promotes the neighbour, so the
	 * agent log falls back to the connections tree and a switched-off console falls back to
	 * whichever agent the user still has (or closes the dock, if none).
	 */
	const available = useCallback((tool: ToolId): boolean => {
		if (tool === 'mcplog') { return mcpActive; }
		if (tool.startsWith('agent:')) { return visibleAgents.some((a) => `agent:${a.kind}` === tool); }
		return true;
	}, [mcpActive, visibleAgents]);
	useEffect(() => {
		for (const area of DOCK_AREAS) {
			const active = layout.docks[area].active;
			if (active && !available(active)) {
				setDocks((d) => dropTool(d, active, available));
			}
		}
	}, [available, layout.docks, setDocks]);

	useEffect(() => {
		saveLayout(layout);
	}, [layout]);

	useEffect(() => {
		saveAppSettings(appSettings);
		editorRef.current?.updateOptions(editorOptions(appSettings));
		setKeywordCase(appSettings.keywordCase);
	}, [appSettings]);

	// Cloud settings sync (signed-in users, opt-out per machine): pull the account's prefs on
	// sign-in and push a debounced blob whenever a pref changes. Theme, pane layout, and app/
	// editor/query prefs are portable; secrets and connections never leave the machine. Merge is
	// last-write-wins by the blob's updatedAt. Applying a pulled blob must not echo back as a push,
	// so we both flag the apply and fingerprint the content; and we gate pushing until the initial
	// reconcile is done, so a stale local copy can't clobber newer cloud prefs on launch.
	const lastSyncFingerprint = useRef<string | null>(null);
	const applyingRemote = useRef(false);
	const syncReady = useRef(false);
	const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const userId = auth.user?.id ?? null;

	const applyRemoteBlob = useCallback((blob: ReturnType<typeof parseBlob>): void => {
		if (!blob) {
			return;
		}
		applyingRemote.current = true;
		lastSyncFingerprint.current = fingerprint(blob.theme, blob.layout, blob.appSettings);
		setLocalStamp(blob.updatedAt);
		setTheme(blob.theme);
		setLayout(blob.layout);
		// The blob holds no machine-local settings; this machine keeps its own (Liby on or off).
		setAppSettings((current) => adoptSyncedAppSettings(current, blob.appSettings));
	}, []);

	useEffect(() => {
		syncReady.current = false;
		if (!userId || !syncEnabled()) {
			return;
		}
		let cancelled = false;
		void window.sqlApi.settingsSync.pull().then((raw) => {
			if (cancelled) {
				return;
			}
			const remote = parseBlob(raw);
			if (remote && remote.updatedAt > localStamp()) {
				// Cloud is newer: adopt it (without echoing a push back up).
				applyRemoteBlob(remote);
			} else {
				// No row, or this machine's prefs are at least as new: upload them so the account
				// reflects this machine. Keep our own stamp so last-write-wins stays honest.
				const stamp = localStamp() || Date.now();
				setLocalStamp(stamp);
				lastSyncFingerprint.current = fingerprint(theme, layout, appSettings);
				void window.sqlApi.settingsSync.push(buildBlob(theme, layout, appSettings, stamp));
			}
			syncReady.current = true;
		});
		return () => { cancelled = true; };
		// theme/layout/appSettings are read only to seed the first upload; we intentionally do not
		// re-pull when they change (that's the push effect's job), so they're left out of the deps.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId, applyRemoteBlob]);

	useEffect(() => {
		if (applyingRemote.current) {
			applyingRemote.current = false;
			return;
		}
		if (!userId || !syncEnabled() || !syncReady.current) {
			return;
		}
		const print = fingerprint(theme, layout, appSettings);
		if (print === lastSyncFingerprint.current) {
			return;
		}
		lastSyncFingerprint.current = print;
		const stamp = Date.now();
		setLocalStamp(stamp);
		if (pushTimer.current) {
			clearTimeout(pushTimer.current);
		}
		pushTimer.current = setTimeout(() => {
			void window.sqlApi.settingsSync.push(buildBlob(theme, layout, appSettings, stamp));
		}, 1000);
	}, [theme, layout, appSettings, userId]);

	// Editor tabs: one Monaco model per tab, swapped onto the single editor instance.
	const [tabs, setTabs] = useState<EditorTab[]>([]);
	const [activeTabId, setActiveTabId] = useState<string | null>(null);
	useEffect(() => {
		// The first run only records the starting tab; it is not a change.
		if (lastActiveTabRef.current !== undefined && lastActiveTabRef.current !== activeTabId) {
			setFullChat(false);
		}
		lastActiveTabRef.current = activeTabId;
	}, [activeTabId]);
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
	// Tabs that should place the cursor at the end (last line) the first time their model is shown,
	// rather than at line 1 — used when opening a file from disk / the workspace list or restoring the
	// last session, so a big file lands at the bottom (where you resume) instead of the top. Consumed
	// (and cleared) by the model-swap effect below.
	const openAtEndRef = useRef<Set<string>>(new Set());
	// Per-tab stash of each surface's buffer (sql / native), so toggling SQL<->Pipeline keeps both
	// sides instead of clobbering the single Monaco model. Keyed by tab id; cleared when a tab closes.
	const surfaceBuffersRef = useRef<Map<string, { sql?: string; native?: string }>>(new Map());
	// Payload for 'table' tabs (no Monaco model), keyed by tab id. `table` is set when
	// browsing/editing an existing table; `createInSchema` marks a new-table designer.
	const tableTabsRef = useRef<Map<string, { connectionId: string; driver: string; table?: TableInfo; createInSchema?: string; seedDraft?: TableDraft; defaultTab?: 'data' | 'properties' | 'telemetry'; initialFilter?: { column: string; op: '=' | '<>'; value: unknown }[] }>>(new Map());
	// Payload for 'object' tabs (a read-only procedure/function/trigger DDL view), keyed by tab id.
	const objectTabsRef = useRef<Map<string, ObjectDetail>>(new Map());
	// What a 'flow' tab (the Data Flows wizard) opened with: a dropped file to sample, or a saved
	// flow to reopen. Kept out of tab state because it is a one-shot seed, not tab identity.
	const flowTabsRef = useRef<Map<string, { path?: string; flowId?: string }>>(new Map());
	// The Data Flow wizard's on-screen state (step, columns, destination), published by the
	// wizard itself, so the AI chat grounds in it when a flow tab is active.
	const flowAmbientRef = useRef<AmbientFlowWizard | null>(null);
	const tabSeq = useRef(0);
	const untitledSeq = useRef(1);
	const initialized = useRef(false);
	// The focused tab id read through a ref, so stable callbacks (connect, the picker) can
	// bind a connection to whatever tab has focus without re-creating each render.
	const activeTabIdRef = useRef<string | null>(null);
	activeTabIdRef.current = activeTabId;
	// The tab list, for the same reason: a coding agent's push arrives from main, outside React, and
	// the effect that answers it has to see the tabs as they are now, not as they were when it
	// subscribed.
	const tabsRef = useRef<EditorTab[]>(tabs);
	tabsRef.current = tabs;

	// Bind a connection to the focused tab — this is the per-tab "active connection".
	const bindConnection = useCallback((connectionId: string | undefined): void => {
		const tabId = activeTabIdRef.current;
		if (!tabId) {
			return;
		}
		setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, connectionId } : t)));
	}, []);
	// Connections that were open last launch (captured once so the restore below reads the
	// saved set, not a list the persist effect may have just rewritten), and a guard so the
	// reconnect only runs once.
	const [savedOpenConns] = useState<string[]>(() => loadOpenConnections());
	const restoredConns = useRef(false);

	function markDirty(id: string): void {
		setTabs((prev) => prev.map((t) => (t.id === id && !t.dirty ? { ...t, dirty: true } : t)));
	}

	function createTab(content: string, opts?: { filePath?: string; title?: string; connectionId?: string; surface?: 'sql' | 'native'; language?: string; collection?: string; atEnd?: boolean }): string {
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		if (opts?.atEnd) {
			openAtEndRef.current.add(id);
		}
		const language = opts?.language ?? 'sql';
		const model = monaco.editor.createModel(content, language);
		modelsRef.current.set(id, model);
		// Only SQL models join the LSP buffer mirror (the server speaks SQL); a json pipeline buffer
		// stays renderer-local (its completion is the pipeline provider, not the LSP).
		if (language === 'sql') {
			notifyDidOpen(model);
		}
		model.onDidChangeContent(() => markDirty(id));
		const title = opts?.title ?? `Untitled-${untitledSeq.current++}`;
		// New tabs inherit the focused tab's connection (fallback: the default connection).
		const connectionId = opts?.connectionId
			?? tabs.find((t) => t.id === activeTabIdRef.current)?.connectionId
			?? appSettings.defaultConnectionId
			?? undefined;
		setTabs((prev) => [...prev, { id, title, filePath: opts?.filePath, dirty: false, connectionId, surface: opts?.surface, language: opts?.language, collection: opts?.collection }]);
		setActiveTabId(id);
		return id;
	}

	/** Open a fresh native MongoDB aggregation-pipeline tab: a json editor seeded
	 *  with the starter pipeline, targeting `collection` on `connectionId` (defaults to the first
	 *  collection in that connection's schema once it loads). */
	function createPipelineTab(connectionId: string | undefined, collection?: string): string {
		return createTab(PIPELINE_TEMPLATE, { title: `Pipeline-${untitledSeq.current++}`, connectionId, surface: 'native', language: 'json', collection });
	}

	/** Open a blank "New Query" tab. On a document (MongoDB) connection this opens the native
	 *  aggregation-pipeline surface instead of SQL — SQL stays one click away
	 *  on the surface switch, but a Mongo user shouldn't land on "Mongo pretending to be relational"
	 *  first. The tab inherits the focused/default connection the same way {@link createTab} does. */
	function newQueryTab(): string {
		const inheritId = tabs.find((t) => t.id === activeTabIdRef.current)?.connectionId ?? appSettings.defaultConnectionId ?? undefined;
		const cfg = inheritId ? state.connections.find((c) => c.id === inheritId) : undefined;
		if (cfg && backendKindForDriver(cfg.driver) === 'document') {
			return createPipelineTab(inheritId, undefined);
		}
		return createTab('');
	}

	/** Open a native pipeline tab seeded with AI-proposed pipeline JSON (the chat's
	 *  "Insert into pipeline" action). Defaults the target collection to the connection's first when
	 *  it's the active one (the schema is loaded); otherwise PipelineBar's picker chooses it. */
	function openPipelineWithContent(connectionId: string | undefined, json: string): void {
		const collection = connectionId === activeId ? mongoCollectionNames()[0] : undefined;
		createTab(json, { title: `Pipeline-${untitledSeq.current++}`, connectionId, surface: 'native', language: 'json', collection });
	}

	/** Switch the focused editor tab between the SQL and native pipeline surfaces (Mongo only). Each
	 *  surface keeps its OWN buffer: the outgoing text is stashed and the incoming text restored, so
	 *  toggling SQL<->Pipeline never loses the other side (the pipeline template seeds only the first
	 *  time a tab enters the native surface with nothing saved). */
	function setActiveSurface(surface: 'sql' | 'native'): void {
		const tabId = activeTabIdRef.current;
		if (!tabId) {
			return;
		}
		const tab = tabs.find((t) => t.id === tabId);
		if (!tab) {
			return;
		}
		const from = tab.surface ?? 'sql';
		if (from === surface) {
			return;
		}
		const model = modelsRef.current.get(tabId);
		if (model) {
			let store = surfaceBuffersRef.current.get(tabId);
			if (!store) {
				store = {};
				surfaceBuffersRef.current.set(tabId, store);
			}
			store[from] = model.getValue(); // stash the surface we're leaving
			monaco.editor.setModelLanguage(model, surface === 'native' ? 'json' : 'sql');
			const saved = store[surface];
			model.setValue(saved !== undefined ? saved : surface === 'native' ? PIPELINE_TEMPLATE : '');
			if (surface === 'sql') {
				// Re-join the LSP buffer mirror so SQL completion/hover see the (now SQL) document.
				notifyDidOpen(model);
			}
		}
		const collection = tab.collection ?? mongoCollectionNames()[0];
		setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, surface, language: surface === 'native' ? 'json' : 'sql', collection } : t)));
	}

	/** Set the target collection of the focused native pipeline tab. */
	function setActiveCollection(collection: string): void {
		const tabId = activeTabIdRef.current;
		if (tabId) {
			setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, collection } : t)));
		}
	}

	/** Collection names from the active connection's schema (document backends only). */
	function mongoCollectionNames(): string[] {
		return (activeSchema?.tables ?? []).filter((t) => t.kind === 'collection' || t.kind === 'view').map((t) => t.name);
	}

	/** Drag-reorder: move the dragged tab to where the drop-target tab currently sits. */
	function reorderTabs(fromId: string, toId: string): void {
		setTabs((prev) => {
			const from = prev.findIndex((t) => t.id === fromId);
			const to = prev.findIndex((t) => t.id === toId);
			if (from < 0 || to < 0 || from === to) {
				return prev;
			}
			const next = [...prev];
			const [moved] = next.splice(from, 1);
			next.splice(to, 0, moved);
			return next;
		});
	}

	function closeTab(id: string, options: { keepFlowFocus?: boolean } = {}): void {
		const tab = tabs.find((t) => t.id === id);
		if (!tab) {
			return;
		}
		if (tab.dirty) {
			setCloseConfirm({ id, title: tab.title });
			return;
		}
		doCloseTab(id, options);
	}

	/** `keepFlowFocus` is for replacing one flow tab with another (openFlow): the panels must stay
	 *  collapsed, and what the user had open before the FIRST flow must not be forgotten. */
	function doCloseTab(id: string, options: { keepFlowFocus?: boolean } = {}): void {
		if (!options.keepFlowFocus && tabs.find((t) => t.id === id)?.kind === 'flow') {
			restoreFlowFocus();
		}
		// Orbit's panel is the tab's controls and nothing else, so it goes with the tab. Left
		// showing, it would be an empty pane offering to reopen what you just closed. The left
		// area hands itself back to the connections rather than to nothing: a side bar that
		// vanishes because you closed a tab is not an improvement on an empty panel.
		if (tabs.find((t) => t.id === id)?.kind === 'orbit') {
			setDocks((d) => {
				const next = hideTool(d, 'orbit');
				return placementOf(d, 'orbit') === 'left' ? showTool(next, 'connections') : next;
			});
		}
		modelsRef.current.get(id)?.dispose();
		modelsRef.current.delete(id);
		surfaceBuffersRef.current.delete(id);
		tableTabsRef.current.delete(id);
		objectTabsRef.current.delete(id);
		const remaining = tabs.filter((t) => t.id !== id);
		setTabs(remaining);
		if (activeTabId === id) {
			if (remaining.length > 0) {
				const idx = tabs.findIndex((t) => t.id === id);
				setActiveTabId(remaining[Math.min(idx, remaining.length - 1)].id);
			} else {
				// Closing the last tab: don't auto-spawn a new one — the workbench
				// drops to the Welcome view (VSCode/Cursor parity).
				setActiveTabId(null);
			}
		}
	}

	/*
	 * A coding agent's own surface, when its console lives in the BOTTOM strip: what it shows opens
	 * as a tab in the workbench, beside the SQL editor, the way a Data Flow does
	 * (`agentSurfaceHome` in docking.ts holds the rule and the reasoning). In a side dock the same
	 * surface renders inside the console instead, and these two functions are what moves it.
	 *
	 * One tab per agent, titled with its name and carrying its mark, so two agents drawing at once
	 * are two tabs rather than one confused one.
	 */
	function openAgentTab(kind: AgentKind): void {
		const existing = tabsRef.current.find((t) => t.kind === 'agentView' && t.agent === kind);
		if (existing) {
			setActiveTabId(existing.id);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		setTabs((prev) => [...prev, { id, title: agentDescriptor(kind).label, dirty: false, kind: 'agentView', agent: kind }]);
		setActiveTabId(id);
	}

	/** Close an agent's tab, keeping the focus somewhere sensible. Never dirty and never holds a
	 *  Monaco model, so this is the whole of it. */
	function closeAgentTab(id: string): void {
		const remaining = tabsRef.current.filter((t) => t.id !== id);
		setTabs(remaining);
		setActiveTabId((current) => (current === id ? (remaining.length > 0 ? remaining[remaining.length - 1].id : null) : current));
	}

	async function openFile(): Promise<void> {
		const result = await window.sqlApi.openFile();
		if (!result) {
			return;
		}
		// Already open: switch to its tab instead of opening a duplicate.
		const existing = tabs.find((t) => t.filePath === result.path);
		if (existing) {
			setActiveTabId(existing.id);
			return;
		}
		createTab(result.content, { filePath: result.path, title: basename(result.path), atEnd: true });
	}

	async function saveActiveFile(): Promise<void> {
		if (!activeTabId) {
			return;
		}
		const tab = tabs.find((t) => t.id === activeTabId);
		const model = modelsRef.current.get(activeTabId);
		if (!tab || !model) {
			return;
		}
		const content = model.getValue();
		if (tab.filePath) {
			// Already a file (workspace or opened from disk): overwrite in place, no dialog.
			const saved = await window.sqlApi.saveFile(tab.filePath, content);
			if (saved) {
				setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, dirty: false } : t)));
				setStatus(`Saved ${basename(saved)}`);
				setWorkspaceRev((r) => r + 1);
				markTask('save');
				libyFeel({ kind: 'saved' });
			}
			return;
		}
		// Untitled: auto-name from the SQL and save straight into the workspace (no save dialog).
		const file = await window.sqlApi.workspace.create(suggestFileName(content), content);
		setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, filePath: file.path, title: file.name, dirty: false } : t)));
		setStatus(`Saved ${file.name}`);
		setWorkspaceRev((r) => r + 1);
		markTask('save');
		libyFeel({ kind: 'saved' });
		// Reveal the Workspace panel so the new file shows up highlighted (it's the active tab's file).
		setDocks((d) => showTool(d, 'workspace'));
	}

	/** Open a workspace file in an editor tab (reuses the tab if it's already open). */
	async function openWorkspaceFile(path: string): Promise<void> {
		const existing = tabs.find((t) => t.filePath === path);
		if (existing) {
			setActiveTabId(existing.id);
			return;
		}
		const content = await window.sqlApi.workspace.read(path);
		createTab(content, { filePath: path, title: basename(path), atEnd: true });
	}

	/** Create a new file in the workspace and open it. */
	async function newWorkspaceFile(): Promise<void> {
		const file = await window.sqlApi.workspace.create('query');
		setWorkspaceRev((r) => r + 1);
		createTab('', { filePath: file.path, title: file.name });
	}

	/** After files are copied into the workspace: reveal the panel, refresh, and open the first. */
	function onWorkspaceImported(files: WorkspaceFile[]): void {
		setWorkspaceImport(false);
		if (files.length > 0) {
			setDocks((d) => showTool(d, 'workspace'));
			setWorkspaceRev((r) => r + 1);
			void openWorkspaceFile(files[0].path);
		}
	}

	// Restore last session's editor tabs once (guard against StrictMode double-invoke),
	// falling back to a single empty tab; then pre-select the default connection if set.
	useEffect(() => {
		if (!initialized.current) {
			initialized.current = true;
			const session = loadSession();
			if (session && session.tabs.length > 0) {
				const ids = session.tabs.map((t) => createTab(t.content, { filePath: t.filePath, title: t.title, connectionId: t.connectionId, surface: t.surface, language: t.language, collection: t.collection, atEnd: true }));
				setActiveTabId(ids[Math.min(session.activeIndex, ids.length - 1)] ?? ids[0]);
				untitledSeq.current = session.tabs.length + 1;
			} else {
				createTab('');
			}
			// (Per-tab connections: createTab seeds new/restored tabs from the default connection.)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Persist the SQL editor tabs on exit so the next launch reopens them. Reads live model
	// contents at unload time. Only SQL tabs survive: table/object (trigger/function/procedure)
	// tabs keep their payload in refs that don't persist, so restoring them would show an
	// empty/black view (and worse if the connection isn't reopened) — they reopen from the
	// tree on demand instead. (Result tabs live only in the results pane, never persisted.)
	useEffect(() => {
		function persist(): void {
			const sqlTabs = tabs.filter((t) => t.kind === undefined || t.kind === 'sql');
			const saved: SavedTab[] = sqlTabs.map((t) => ({
				title: t.title,
				content: modelsRef.current.get(t.id)?.getValue() ?? '',
				filePath: t.filePath,
				connectionId: t.connectionId,
				surface: t.surface,
				language: t.language,
				collection: t.collection,
			}));
			const activeIndex = Math.max(0, sqlTabs.findIndex((t) => t.id === activeTabId));
			saveSession({ tabs: saved, activeIndex });
		}
		window.addEventListener('beforeunload', persist);
		return () => window.removeEventListener('beforeunload', persist);
	}, [tabs, activeTabId]);

	// Opening a tab is reading it: the unread mark a coding agent's push left goes away.
	useEffect(() => {
		if (!activeTabId) {
			return;
		}
		setTabs((prev) => (prev.some((t) => t.id === activeTabId && t.attention) ? prev.map((t) => (t.id === activeTabId ? { ...t, attention: false } : t)) : prev));
	}, [activeTabId]);

	/** Put the cursor on the last line and scroll it into view. What "land at the end" means, in one
	 *  place, because two callers want it: opening a file (you resume where you left off) and
	 *  inserting SQL at the bottom of a document (a thousand-line script would otherwise take the
	 *  insert and leave the view at line 1, so nothing looks like it happened). */
	function landAtEnd(editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel): void {
		const last = model.getLineCount();
		editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
		editor.revealLine(last);
	}

	// Swap the editor's model when the active tab changes.
	useEffect(() => {
		const editor = editorRef.current;
		const model = activeTabId ? modelsRef.current.get(activeTabId) : undefined;
		if (!editor || !model || !activeTabId) {
			return;
		}
		const swapped = editor.getModel() !== model;
		if (swapped) {
			editor.setModel(model);
		}
		// Files opened from disk/the workspace list or restored on launch land at the last line
		// (where you resume), not line 1 — a big file shouldn't dump you at the top. New/other tabs
		// keep Monaco's default line-1 cursor. One-shot: cleared once applied. Checked even when the
		// model did not change: the editor can already hold this tab's model while the user is looking
		// at something else (an agent's tab), and that request has to survive coming back to it.
		if (openAtEndRef.current.delete(activeTabId)) {
			landAtEnd(editor, model);
		}
		if (swapped) {
			editor.focus();
		}
	}, [activeTabId]);

	const reload = useCallback(async (): Promise<void> => {
		setState(await window.sqlApi.state());
	}, []);

	useEffect(() => {
		void reload();
		return window.sqlApi.onConnectionsChanged(() => void reload());
	}, [reload]);

	// Reconnect the connections that were open last launch, once connections are loaded.
	// Prod is skipped — it always needs a deliberate connect. Goes straight to the IPC so it
	// doesn't churn the active-connection selection (the default-connection logic owns that).
	// Deferred to an idle callback so a slow (e.g. tunnelled) reconnect never delays the
	// window from painting — the app loads first, then reopens in the background.
	useEffect(() => {
		if (restoredConns.current || state.connections.length === 0) {
			return;
		}
		restoredConns.current = true;
		if (!appSettings.reconnectOnLaunch) {
			return;
		}
		const toOpen = savedOpenConns.filter((id) => {
			const cfg = state.connections.find((c) => c.id === id);
			return cfg !== undefined && policyFor(cfg.environment).allowsAutoConnect && !state.connectedIds.includes(id);
		});
		if (toOpen.length === 0) {
			return;
		}
		const handle = window.requestIdleCallback(() => {
			for (const id of toOpen) {
				// Through the shared connect() (not straight to IPC) so each row shows its spinner +
				// Cancel and can't be double-connected; bind=false keeps the active-tab selection put,
				// quiet=true keeps a background restore silent (no status line, toast, or dialog).
				void connect(id, false, true);
			}
		}, { timeout: 3000 });
		return () => window.cancelIdleCallback(handle);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state.connections]);

	// Persist the open non-prod connections so the next launch can reopen them. Held off
	// until the restore above has run, so it can't clobber the saved set on first load.
	useEffect(() => {
		if (!restoredConns.current) {
			return;
		}
		saveOpenConnections(state.connectedIds.filter((id) => {
			const cfg = state.connections.find((c) => c.id === id);
			return cfg !== undefined && policyFor(cfg.environment).allowsAutoConnect;
		}));
	}, [state.connectedIds, state.connections]);

	// Push the idle auto-disconnect window to main (where the timers live) on launch and
	// whenever the setting changes; 0 disables.
	useEffect(() => {
		void window.sqlApi.setIdleTimeout(appSettings.idleDisconnectMinutes * 60_000);
	}, [appSettings.idleDisconnectMinutes]);

	// Push the set of audit-logged interaction kinds to main (where the recording happens) on
	// launch and on change. Not plan-gated: every tier can record, so this follows the user's
	// own Settings toggles. The editor toggle covers both auto-completion and inline edits.
	useEffect(() => {
		const kinds: AiAuditKind[] = [];
		if (appSettings.auditLogChat) {
			// Actions ride with chat: recording a turn without what it did would be half a record.
			// They are no longer only chat's, though — a data flow's extraction stage is an action
			// with nobody in a conversation at all, which is why the checkbox says so.
			kinds.push('chat', 'action');
		}
		if (appSettings.auditLogCompletion) {
			kinds.push('completion', 'edit');
		}
		void window.sqlApi.setAuditKinds(kinds);
	}, [appSettings.auditLogChat, appSettings.auditLogCompletion]);

	// Main blocks a quit and asks us to confirm with a themed dialog (a native one ignores the app
	// theme). Showing the modal; the buttons either let the quit proceed or cancel it.
	useEffect(() => {
		return window.sqlApi.onConfirmQuit(() => setQuitOpen(true));
	}, []);

	// The first window close of all: main held it open so we can say the app keeps running in the
	// tray. Answering the notice is what hides the window.
	useEffect(() => {
		return window.sqlApi.onHideNotice(() => setHideNotice(true));
	}, []);

	// Reflect the AI-settings inline-completion toggle (loaded on mount, refreshed when
	// the settings modal closes since that's where it's changed).
	const refreshAiSettings = useCallback(async (): Promise<void> => {
		const ai = await window.sqlApi.aiSettings();
		setAiInlineEnabled(ai.behavior.inlineCompletion);
		setAiInlineMode(ai.behavior.inlineCompletionMode);
	}, []);

	useEffect(() => {
		void refreshAiSettings();
	}, [refreshAiSettings]);

	// The focused tab's connection IS the active connection — run, schema completion and AI
	// grounding all follow whichever tab has focus, so different tabs can target different DBs.
	const activeTab = tabs.find((t) => t.id === activeTabId);
	const activeId = activeTab?.connectionId;
	// The one rule for what Liby grounds on, in either view: docked, the editor's connection (its
	// toolbar is the picker); in the full view, Liby's own pick, since the editor is hidden and may
	// have no tab at all. Entering the full view seeds that pick from the editor (setAssistantFull).
	const assistantConnId = fullChat ? fullChatConnId : activeId;
	const activeConfig = state.connections.find((c) => c.id === activeId);
	// The prod policy for whatever is active, decided in one place (engine guard) rather than
	// re-read as `environment === 'prod'` at each gate. Cosmetic prod styling stays inline.
	const activePolicy = policyFor(activeConfig?.environment, { confirmDestructive: appSettings.confirmOnProd, allowGridActions: appSettings.allowProdGridActions || (activeId !== undefined && prodUnlocked.has(activeId)) }, activeConfig?.driver);
	const activeConnected = activeId !== undefined && state.connectedIds.includes(activeId);
	// What this engine will write a whole result in ITSELF, for the export menu's third group. Only
	// the formats that carry column names: an export nobody can read the columns of is not one.
	const serverExportFormats = useMemo(
		() => bulkFormatsFor(activeConfig?.driver ?? '').filter((f) => f.named).map((f) => ({ id: f.id, label: f.label })),
		[activeConfig?.driver]);
	// Latest active connection id, readable inside async callbacks (e.g. the connect-then-run
	// in run()) without capturing a stale value — used to bail if the user switched mid-connect.
	const activeIdRef = useRef(activeId);
	activeIdRef.current = activeId;
	// Connection roster readable inside async callbacks (e.g. the post-run plan advisor resolving a
	// connection's driver) without threading it through effect deps.
	const connectionsRef = useRef(state.connections);
	connectionsRef.current = state.connections;
	// Same, for the live schema — the keyset decision needs the browsed table's primary key at run
	// time without making every run callback depend on the schema poll.
	const activeSchemaRef = useRef(activeSchema);
	activeSchemaRef.current = activeSchema;
	// What the plan advisor cannot read off a plan: the statement itself, and each table's row count
	// from the schema (exact for a full scan, where the plan gives only granules). Only for the
	// connection whose schema is loaded.
	const planOptions = useCallback((sql: string, connId: string): PlanAdvisorOptions => {
		const schema = activeIdRef.current === connId ? activeSchemaRef.current : null;
		return {
			sql,
			tableRows: (table) => schema?.tables.find((t) => t.name === table)?.stats?.rowCount,
			partition: schema ? partitionIndex(schema.tables) : undefined,
		};
	}, []);

	// The Query Performance tab has no in-panel connection picker: the sidebar rebinds its connection
	// like any other tab. Keep its title naming the analyzed DB so it follows a sidebar rebind.
	const workloadConnId = tabs.find((t) => t.kind === 'workload')?.connectionId;
	useEffect(() => {
		setTabs((prev) => {
			let changed = false;
			const next = prev.map((t) => {
				if (t.kind !== 'workload') {
					return t;
				}
				const conn = t.connectionId ? state.connections.find((c) => c.id === t.connectionId) : undefined;
				const title = conn ? `Query Performance · ${conn.label}` : 'Query Performance';
				if (title === t.title) {
					return t;
				}
				changed = true;
				return { ...t, title };
			});
			return changed ? next : prev;
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workloadConnId, state.connections]);

	// Users & Privileges has no in-panel picker either: same sidebar rebinding, same title rule.
	const securityConnId = tabs.find((t) => t.kind === 'security')?.connectionId;
	useEffect(() => {
		setTabs((prev) => {
			let changed = false;
			const next = prev.map((t) => {
				if (t.kind !== 'security') {
					return t;
				}
				const conn = t.connectionId ? state.connections.find((c) => c.id === t.connectionId) : undefined;
				const title = conn ? `Users \u0026 Privileges \u00b7 ${conn.label}` : 'Users \u0026 Privileges';
				if (title === t.title) {
					return t;
				}
				changed = true;
				return { ...t, title };
			});
			return changed ? next : prev;
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [securityConnId, state.connections]);

	// The native (pipeline) surface only makes sense on a document connection. If the active tab is on
	// a relational/SQL connection (e.g. its connection was just switched), force it back to SQL — the
	// PipelineBar only renders for document backends, so otherwise the tab is stuck in json mode with
	// no way to toggle out. The surface-buffer stash restores the tab's SQL text losslessly.
	useEffect(() => {
		if (activeTab?.surface === 'native' && backendKindForDriver(activeConfig?.driver) === 'relational') {
			setActiveSurface('sql');
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeTab?.id, activeTab?.surface, activeConfig?.driver]);

	// Keep the active connection's schema handy so an editable single-table result can be
	// detected (and looked up for its primary key) without a round-trip per run.
	useEffect(() => {
		let cancelled = false;
		if (activeId && activeConnected) {
			void window.sqlApi.getSchema(activeId).then((s) => { if (!cancelled) { setActiveSchema(s); } });
		} else {
			setActiveSchema(null);
		}
		return () => { cancelled = true; };
	}, [activeId, activeConnected]);

	// Scope completion/hover to the active tab's connection so its tables aren't duplicated
	// once per other open connection.
	useEffect(() => {
		setActiveConnectionId(activeId);
	}, [activeId]);

	// Register the native pipeline (json) completion provider once.
	useEffect(() => {
		registerPipelineCompletion();
	}, []);

	// Feed the pipeline json completion the active tab's schema context: the target collection's
	// fields + all collection names (for $lookup). Cleared off a native tab so a stray json buffer
	// gets nothing.
	useEffect(() => {
		if (activeTab?.surface === 'native') {
			const collections = (activeSchema?.tables ?? []).filter((t) => t.kind === 'collection' || t.kind === 'view').map((t) => t.name);
			// Seed an empty target with the first collection once the schema is in.
			if (!activeTab.collection && collections.length > 0) {
				setActiveCollection(collections[0]);
			}
			const fields = activeTab.collection
				? (activeSchema?.tables.find((t) => t.name === activeTab.collection)?.columns.map((c) => c.name) ?? [])
				: [];
			setPipelineSchema(fields, collections);
		} else {
			setPipelineSchema([], []);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeTab, activeSchema]);

	useEffect(() => {
		return window.sqlApi.onSchemaChanged((id) => {
			if (id === activeId) {
				void window.sqlApi.getSchema(id).then(setActiveSchema);
			}
		});
	}, [activeId]);

	// Keep the editor's table-name resolver in sync with the active schema so Monaco
	// underlines a known table identifier (and switches the cursor to pointer) on
	// Ctrl/Cmd-hover. The actual open is handled by Editor.onMouseUp.
	useEffect(() => {
		setTableResolver((name) => {
			if (!activeSchema) {
				return false;
			}
			const lower = name.toLowerCase();
			return activeSchema.tables.some((tt) => tt.name.toLowerCase() === lower);
		});
		// Feed the inline index/scan advisor (Pillar 2 Tier A) the active schema + driver, and
		// re-lint the current buffer now that the schema changed (a squiggle can only appear once
		// introspection has landed the indexes it reasons about).
		setAdvisorSchemaProvider(() => ({ schema: activeSchema ?? undefined, driver: activeConfig?.driver }));
		refreshAdvisorDiagnostics(editorRef.current?.getModel() ?? null);
		// And colour the words this vendor adds (ClickHouse PREWHERE / FINAL / UInt64), which is the
		// same switch: the editor follows the active connection's dialect.
		setSqlDialect(activeConfig?.driver);
	}, [activeSchema, activeConfig]);

	// A result is editable (DBeaver-style in-grid edit) only when the query was a plain
	// single-table SELECT, that table has a primary key, the PK was selected, and every result
	// column maps to a real table column — so UPDATE/DELETE can target rows safely.
	//
	// Nine separate conditions can turn editing off and, until this carried a `reason`, every one
	// of them did it in silence: the grid simply had no edit affordances and a double-click did
	// nothing, with no way to tell an ambiguous table name from a missing primary key from a
	// connection the user had marked read-only months ago. The reason is what the results footer
	// puts behind its "Read-only" badge.
	const editTarget = useMemo((): { table: TableInfo; driver: string; reason?: undefined } | { table?: undefined; reason: string } => {
		// Only editable when the focused tab still points at the connection that produced
		// these rows — otherwise switching tabs could aim an UPDATE at the wrong database.
		if (!response?.ok) {
			return { reason: 'The last statement returned no result set to edit.' };
		}
		if (!activeConfig || resultConnectionId !== activeId) {
			return { reason: 'These rows came from a different connection than the one this tab is on.' };
		}
		if (!activeSchema) {
			return { reason: 'The schema has not been introspected yet, so the result cannot be traced to a table.' };
		}
		if (activeConfig.readOnly) {
			return { reason: 'This connection is marked read-only in its settings.' };
		}
		const src = editableSource(lastSql);
		if (!src) {
			return { reason: 'Editing needs a plain single-table SELECT: no join, union, group by, distinct, having or subquery.' };
		}
		const named = src.schema ? `${src.schema}.${src.table}` : src.table;
		const matches = activeSchema.tables.filter((t) =>
			t.name.toLowerCase() === src.table.toLowerCase()
			&& (src.schema === undefined || (t.schema ?? '').toLowerCase() === src.schema.toLowerCase()));
		if (matches.length === 0) {
			return { reason: `"${named}" is not in this connection's schema index. Refresh the schema, or qualify it with its schema name.` };
		}
		if (matches.length > 1) {
			// An ambiguous name ⇒ not editable: an UPDATE would have to guess which schema.
			return { reason: `"${named}" exists in ${matches.length} schemas on this connection. Qualify it as schema.table to edit.` };
		}
		const table = matches[0];
		if (table.kind !== 'table') {
			return { reason: `"${named}" is a ${table.kind}, not a table.` };
		}
		const pk = primaryKeyNames(table);
		if (pk.length === 0) {
			return { reason: `"${named}" has no primary key, so a row cannot be addressed for UPDATE or DELETE.` };
		}
		const cols = new Set(table.columns.map((c) => c.name.toLowerCase()));
		const selected = new Set(response.result.fields.map((f) => f.name.toLowerCase()));
		const foreign = response.result.fields.filter((f) => !cols.has(f.name.toLowerCase())).map((f) => f.name);
		if (foreign.length) {
			return { reason: `The result has columns that are not columns of "${named}": ${foreign.join(', ')}.` };
		}
		const missing = pk.filter((name) => !selected.has(name.toLowerCase()));
		if (missing.length) {
			return { reason: `Select the primary key (${missing.join(', ')}) for the rows to be editable.` };
		}
		return { table, driver: activeConfig.driver };
	}, [response, activeSchema, activeConfig, lastSql, resultConnectionId, activeId]);

	// The connection AI completion/edit grounds its schema in. The focused tab's bound connection
	// ALWAYS wins when it has one (the dialect resolves from the driver even when it isn't connected
	// yet, so we never silently swap to a different DB than the one selected). Only when the tab is
	// unbound (a fresh tab, or after a disconnect unbinds tabs) do we fall back — and then only when
	// exactly ONE connection is connected, so the choice is unambiguous. With several connected and
	// nothing selected, the dialect is genuinely ambiguous: completion/edit can't ask, so they ground
	// generically (undefined) rather than guess. (Chat handles that case by asking — see ChatPanel.)
	const groundingConnectionId = (): string | undefined => activeId ?? (state.connectedIds.length === 1 ? state.connectedIds[0] : undefined);

	// Keep the inline-completion provider's view of enablement + active connection current.
	useEffect(() => {
		configureAiCompletion({
			enabled: aiInlineEnabled,
			mode: aiInlineMode,
			getConnectionId: groundingConnectionId,
			onStatus: setStatus,
		});
		// The inline-edit (Ctrl+K) widget grounds in the same active connection.
		configureAiEdit({
			getConnectionId: groundingConnectionId,
			onStatus: setStatus,
			onAddToChat: (text) => {
				setChatOpen(true);
				setAddToChatRequest({ nonce: Date.now(), text });
			},
			onAsk: (prompt) => {
				setChatOpen(true);
				setAskRequest({ nonce: Date.now(), prompt, connectionId: groundingConnectionId() });
			},
			onTranslateToPipeline: async (sql) => {
				const id = groundingConnectionId();
				if (!id) {
					setStatus('Connect to a database first.', 'danger');
					return null;
				}
				// Explicit user action ⇒ allow the AI step (deterministic still wins for simple SQL).
				const res = await window.sqlApi.transcribe({ connectionId: id, sql, allowAiTranscribe: true });
				if (!res.ok) {
					setStatus(res.error, 'danger');
					return null;
				}
				if (res.native.lang !== 'mongo') {
					setStatus('Pipeline translation is only available for MongoDB connections.', 'danger');
					return null;
				}
				return pipelineComment(res.native);
			},
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [aiInlineEnabled, aiInlineMode, activeConnected, activeId, state.connectedIds]);

	// Connect ids the user cancelled mid-handshake, so connect()'s eventual resolution is
	// swallowed (no "Connected" flash, no failure toast) rather than surfacing a confusing error.
	const cancelledConnectsRef = useRef<Set<string>>(new Set());

	// `quiet` (used by launch reconnect) suppresses the status line + failure toast + component
	// prompt: a background restore should show only the row spinner and fail silently, not pop
	// dialogs. Every connect path flows through here so `connectingIds` is the single source of truth.
	const connect = useCallback(async (id: string, bind = true, quiet = false): Promise<boolean> => {
		if (bind) {
			bindConnection(id); // connecting binds the connection to the focused tab
		}
		cancelledConnectsRef.current.delete(id); // fresh attempt clears any stale cancel flag
		startConnecting(id); // drives the sidebar row's spinner + Cancel for EVERY connect path
		if (!quiet) {
			setStatus('Connecting…');
		}
		try {
			const result = await window.sqlApi.connect(id);
			// The user cancelled while this was still handshaking: swallow the late result (main has
			// already torn it down) instead of flashing "Connected".
			if (cancelledConnectsRef.current.delete(id)) {
				setStatus('');
				return false;
			}
			if (!quiet) {
				setStatus(`Connected · ${result.tableCount} tables`);
				const opened = state.connections.find((c) => c.id === id);
				libyFeel({ kind: 'connection-ok', label: opened?.label, production: opened?.environment === 'prod' });
			}
			return true;
		} catch (err) {
			// Same for a cancelled attempt that ends in an error: it's a user abort, not a failure,
			// so don't surface a connection-error toast.
			if (cancelledConnectsRef.current.delete(id)) {
				setStatus('');
				return false;
			}
			// A background launch restore fails silently — the user can connect by hand.
			if (quiet) {
				return false;
			}
			// A native-driver connection (Db2) whose client component isn't installed: prompt the
			// one-time download instead of a raw error; the modal retries the connect when done.
			const compDriver = parseComponentRequired(errorMessage(err));
			if (compDriver) {
				const requirement = await window.sqlApi.componentsRequiredFor(compDriver).catch(() => null);
				if (requirement) {
					setStatus('');
					setComponentPrompt({ id, driver: compDriver, driverLabel: driverDisplayName(compDriver), requirement });
					return false;
				}
			}
			// The error lives in the notifications center + toast now; clear the transient status line.
			setStatus('');
			notifyError("Connection failed", errorMessage(err), { source: 'connection', connectionId: id, connectionLabel: state.connections.find((c) => c.id === id)?.label });
			return false;
		} finally {
			stopConnecting(id);
		}
	}, [bindConnection, startConnecting, stopConnecting]);

	const disconnect = useCallback(async (id: string): Promise<void> => {
		await window.sqlApi.disconnect(id);
		setStatus('Disconnected');
	}, []);

	// Give up on a slow connect: flag it so the in-flight connect()'s late result/error is
	// swallowed, tell main to tear it down, and clear the status line.
	const cancelConnect = useCallback((id: string): void => {
		cancelledConnectsRef.current.add(id);
		void window.sqlApi.cancelConnect(id).catch(() => undefined);
		stopConnecting(id); // clear the row spinner immediately
		setStatus('');
	}, [stopConnecting]);

	// connect() from the toolbar; the spinner is driven by connectingIds (set inside connect()).
	// This wrapper only adds the brief "connected" check-mark flash on success.
	const connectFromToolbar = useCallback(async (id: string): Promise<void> => {
		const ok = await connect(id);
		if (ok) {
			setConnectedFlashId(id);
			setTimeout(() => setConnectedFlashId((cur) => (cur === id ? null : cur)), 1500);
		}
	}, [connect]);

	// Pick a connection for the focused tab; auto-connect it first if it isn't live yet.
	function selectConnection(id: string | undefined): void {
		if (id && !state.connectedIds.includes(id) && appSettings.autoConnectOnSelect) {
			void connectFromToolbar(id); // connect() also binds to the focused tab
		} else {
			bindConnection(id);
		}
	}

	const remove = useCallback(async (config: ConnectionConfig): Promise<void> => {
		if (!(await confirm({ title: `Delete connection "${config.label}"?`, body: "Its stored credentials will be removed too. This cannot be undone.", confirmLabel: "Delete", danger: true }))) {
			return;
		}
		await window.sqlApi.deleteConnection(config.id);
		// Unbind the deleted connection from any tab that referenced it.
		setTabs((prev) => prev.map((t) => (t.connectionId === config.id ? { ...t, connectionId: undefined } : t)));
	}, [confirm]);

	// Reset chosen categories of settings/data back to defaults. The Settings modal confirms
	// first; here we just apply. Renderer-only prefs (layout/appSettings/theme) reset through
	// their setters (the persistence effects rewrite localStorage); the rest clear via IPC.
	const resetSettings = useCallback(async (opts: ResetOptions): Promise<void> => {
		if (opts.layout) {
			setLayout({ ...DEFAULT_LAYOUT });
		}
		if (opts.preferences) {
			setAppSettings({ ...DEFAULT_APP_SETTINGS });
			setTheme('dark');
		}
		if (opts.connections) {
			const current = await window.sqlApi.state();
			for (const c of current.connections) {
				if (current.connectedIds.includes(c.id)) {
					await window.sqlApi.disconnect(c.id);
				}
				await window.sqlApi.deleteConnection(c.id);
			}
			// Unbind every tab from a now-deleted connection.
			setTabs((prev) => prev.map((t) => ({ ...t, connectionId: undefined })));
			await reload();
		}
		if (opts.queries) {
			await window.sqlApi.clearHistory();
			for (const q of await window.sqlApi.savedQueries()) {
				await window.sqlApi.deleteQuery(q.name);
			}
		}
		if (opts.chats) {
			await window.sqlApi.clearChatSessions();
		}
		if (opts.audit) {
			await window.sqlApi.clearAiAuditLog();
		}
	}, [reload]);

	// Append proposed SQL at the end of the document (on its own fresh line) rather than at
	// the cursor, so it never splices into and breaks a statement the user is mid-edit on.
	function insertAtCursor(text: string): void {
		const editor = editorRef.current;
		const model = editor?.getModel();
		if (editor && model) {
			const lastLine = model.getLineCount();
			const endCol = model.getLineMaxColumn(lastLine);
			const prefix = model.getValue().length > 0 ? (model.getLineLength(lastLine) > 0 ? '\n\n' : '\n') : '';
			const range = new monaco.Range(lastLine, endCol, lastLine, endCol);
			editor.executeEdits('insert', [{ range, text: prefix + text, forceMoveMarkers: true }]);
			editor.setPosition(model.getPositionAt(model.getValue().length));
			editor.revealLine(model.getLineCount());
			editor.focus();
			markTask('ai');
		}
	}

	/**
	 * Insert a coding agent's SQL into the editor, from a surface that is NOT the editor.
	 *
	 * The assistant sits beside the editor, so its cards can write at the cursor. An agent's surface
	 * may be a tab of its own, with the editor not on screen at all, and `insertAtCursor` would then
	 * write into whichever model Monaco happens to be holding and leave the user looking at the card
	 * they just clicked, wondering whether anything happened. So this writes to the tab's MODEL
	 * (which needs no editor) and then shows that tab.
	 */
	/** The SQL tab an agent's card acts on: the last one open. */
	function editorTabForAgent(): EditorTab | undefined {
		return tabsRef.current.filter((t) => t.kind === undefined || t.kind === 'sql').at(-1);
	}

	/**
	 * Show the editor before running an agent's SQL, because the RESULTS land in the editor's grid.
	 * Running from a surface that hides that grid is a query whose answer the user never sees.
	 */
	function focusEditorForResults(): void {
		const target = editorTabForAgent();
		if (target) {
			setActiveTabId(target.id);
			return;
		}
		createTab('');
	}

	function insertIntoEditorTab(text: string): void {
		const target = editorTabForAgent();
		const model = target ? modelsRef.current.get(target.id) : undefined;
		if (!target || !model) {
			// Nothing to insert into: a new tab holding the SQL is the same outcome, one step shorter.
			markTask('ai');
			createTab(text);
			return;
		}
		const lastLine = model.getLineCount();
		const endCol = model.getLineMaxColumn(lastLine);
		const prefix = model.getValue().length > 0 ? (model.getLineLength(lastLine) > 0 ? '\n\n' : '\n') : '';
		model.applyEdits([{ range: new monaco.Range(lastLine, endCol, lastLine, endCol), text: prefix + text, forceMoveMarkers: true }]);
		// Land on the SQL that just arrived. It goes at the END of the document, so in a long script
		// the edit is off-screen and the tab looks untouched. Move now only if that tab is the one on
		// screen; otherwise leave the one-shot for the effect that shows it, since scrolling a hidden
		// editor scrolls a stale layout.
		const editor = editorRef.current;
		if (editor && activeTabIdRef.current === target.id && editor.getModel() === model) {
			landAtEnd(editor, model);
			editor.focus();
		} else {
			openAtEndRef.current.add(target.id);
		}
		setActiveTabId(target.id);
		markTask('ai');
	}

	// Double-clicking a table in the explorer opens a dedicated tab (structure + data
	// browser). Reuse the tab if this table is already open; the optional `tab` hint
	// (the sidebar's pulse icon passes `'telemetry'`) re-seeds the inner tab so a
	// repeat click jumps the user back to the monitor.
	function openTable(connectionId: string, table: TableInfo, opts?: { tab?: 'data' | 'properties' | 'telemetry'; initialFilter?: { column: string; op: '=' | '<>'; value: unknown }[] }): void {
		markTask('explore');
		const driver = state.connections.find((c) => c.id === connectionId)?.driver ?? 'mysql-aurora';
		const existing = [...tableTabsRef.current.entries()].find(
			([, t]) => t.connectionId === connectionId && t.table?.schema === table.schema && t.table?.name === table.name,
		);
		if (existing) {
			if (opts?.tab || opts?.initialFilter) {
				tableTabsRef.current.set(existing[0], { ...existing[1], defaultTab: opts.tab ?? existing[1].defaultTab, initialFilter: opts.initialFilter ?? existing[1].initialFilter });
			}
			setActiveTabId(existing[0]);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		tableTabsRef.current.set(id, { connectionId, driver, table, defaultTab: opts?.tab, initialFilter: opts?.initialFilter });
		setTabs((prev) => [...prev, { id, title: table.name, dirty: false, kind: 'table', connectionId }]);
		setActiveTabId(id);
		coachTable(table);
	}

	// One true thing about a table you just opened (its links, its key, its size), said on the
	// table's own header once the tab has laid out. Its own tips budget keeps this to a few, ever.
	function tableFacts(table: TableInfo): TableFacts {
		const schema = activeSchemaRef.current;
		const referencedBy = schema ? schema.tables.filter((t) => t !== table && t.foreignKeys.some((fk) => fk.referencedTable === table.name)).map((t) => t.name) : [];
		return {
			name: table.name,
			columns: table.columns.length,
			primaryKey: table.primaryKey,
			references: [...new Set(table.foreignKeys.map((fk) => fk.referencedTable))].filter((n) => n !== table.name),
			referencedBy: [...new Set(referencedBy)],
			rows: table.stats?.rowCount,
		};
	}
	function coachTable(table: TableInfo): void {
		const move = tableAdvice(tableFacts(table));
		if (move) {
			window.setTimeout(() => libyCall(move), 500);
		}
	}

	// Navigate from an FK cell to the referenced row: open (or focus) the referenced table,
	// filtered to the looked-up key. Used by both result grids via the peek card's "Open" action.
	function navigateFk(connectionId: string, table: TableInfo, filters: { column: string; value: unknown }[]): void {
		openTable(connectionId, table, { tab: 'data', initialFilter: filters.map((f) => ({ column: f.column, op: '=' as const, value: f.value })) });
	}

	// Open a "New table" designer targeting a connection's database. An optional `seed` prefills
	// the designer (e.g. a draft the AI assistant proposed via the open_table_designer capability).
	function openNewTable(connectionId: string, schema?: string, seed?: TableDraft): void {
		const driver = state.connections.find((c) => c.id === connectionId)?.driver ?? 'mysql-aurora';
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		tableTabsRef.current.set(id, { connectionId, driver, createInSchema: schema, seedDraft: seed });
		setTabs((prev) => [...prev, { id, title: seed?.name ? seed.name : 'New table', dirty: false, kind: 'table', connectionId }]);
		setActiveTabId(id);
	}

	// Open (or focus) the Query Performance tool: a single tab that ranks the
	// heaviest statements from a database's own runtime statistics. The database is whichever
	// connection is active in the sidebar (seeded here to the active connection, then rebound by the
	// sidebar like any other tab), so there's just one tool tab — a second invocation focuses it
	// rather than stacking duplicates.
	function openQueryPerf(): void {
		const existing = tabs.find((t) => t.kind === 'workload');
		if (existing) {
			setActiveTabId(existing.id);
			return;
		}
		const conn = activeId ? state.connections.find((c) => c.id === activeId) : undefined;
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		const title = conn ? `Query Performance · ${conn.label}` : 'Query Performance';
		setTabs((prev) => [...prev, { id, title, dirty: false, kind: 'workload', connectionId: activeId }]);
		setActiveTabId(id);
	}


	// Open (or focus) Users & Privileges for the connection active in the sidebar. One tool tab at
	// a time, rebound by the sidebar like the Query Performance tab.
	function openSecurity(connectionId?: string): void {
		// A caller that names a connection (the assistant) rebinds the tab to it; otherwise the tab
		// follows the sidebar like the Query Performance one.
		const bindTo = connectionId ?? activeId;
		const existing = tabs.find((t) => t.kind === 'security');
		if (existing) {
			if (connectionId && existing.connectionId !== connectionId) {
				setTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, connectionId } : t)));
			}
			setActiveTabId(existing.id);
			return;
		}
		const conn = bindTo ? state.connections.find((c) => c.id === bindTo) : undefined;
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		const title = conn ? `Users \u0026 Privileges \u00b7 ${conn.label}` : 'Users \u0026 Privileges';
		setTabs((prev) => [...prev, { id, title, dirty: false, kind: 'security', connectionId: bindTo }]);
		setActiveTabId(id);
	}

	// Open (or focus) ClickHouse Operations for a connection: the one named (the sidebar row that
	// opened it), else the one active in the sidebar. One such tab at a time, like Query Performance.
	function openChOps(connectionId?: string): void {
		const bindTo = connectionId ?? activeId;
		const conn = bindTo ? state.connections.find((c) => c.id === bindTo) : undefined;
		const title = conn ? `Operations · ${conn.label}` : 'ClickHouse Operations';
		const existing = tabs.find((t) => t.kind === 'chOps');
		if (existing) {
			if (bindTo && existing.connectionId !== bindTo) {
				setTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, connectionId: bindTo, title } : t)));
			}
			setActiveTabId(existing.id);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		setTabs((prev) => [...prev, { id, title, dirty: false, kind: 'chOps', connectionId: bindTo }]);
		setActiveTabId(id);
	}

	/** Remote data: the table functions, as a form. One tab, rebound to whichever connection asked
	 *  for it, exactly like Operations. */
	function openChRemote(connectionId?: string): void {
		const bindTo = connectionId ?? activeId;
		const conn = bindTo ? state.connections.find((c) => c.id === bindTo) : undefined;
		const title = conn ? `Remote data · ${conn.label}` : 'Remote data';
		const existing = tabs.find((t) => t.kind === 'chRemote');
		if (existing) {
			if (bindTo && existing.connectionId !== bindTo) {
				setTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, connectionId: bindTo, title } : t)));
			}
			setActiveTabId(existing.id);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		setTabs((prev) => [...prev, { id, title, dirty: false, kind: 'chRemote', connectionId: bindTo }]);
		setActiveTabId(id);
	}

	// Double-clicking a procedure/function/trigger opens a read-only DDL detail tab. Reuse
	// the tab if the same object is already open (keyed by connection + kind + qualified name).
	function openObject(detail: ObjectDetail): void {
		const sig = (d: ObjectDetail): string => `${d.connectionId}:${d.kind}:${d.schema ?? ''}.${d.name}`;
		const existing = [...objectTabsRef.current.entries()].find(([, d]) => sig(d) === sig(detail));
		if (existing) {
			objectTabsRef.current.set(existing[0], detail);
			setActiveTabId(existing[0]);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		objectTabsRef.current.set(id, detail);
		setTabs((prev) => [...prev, { id, title: detail.name, dirty: false, kind: 'object', connectionId: detail.connectionId }]);
		setActiveTabId(id);
	}

	// Open (or focus) the schema-sync workspace as a tab, so the SQL editor and everything else
	// stay one click away in the tab strip. Only one sync tab exists at a time.
	function openSchemaSync(): void {
		const existing = tabs.find((t) => t.kind === 'schemaSync');
		if (existing) {
			setActiveTabId(existing.id);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		setTabs((prev) => [...prev, { id, title: 'Schema Sync', dirty: false, kind: 'schemaSync' }]);
		setActiveTabId(id);
	}

	// Open (or focus) the VSCode-style Release Notes document for this build. Only one notes tab
	// exists at a time. No-op if this build ships no notes.
	function openReleaseNotes(): void {
		if (!hasReleaseNotes()) {
			return;
		}
		const existing = tabs.find((t) => t.kind === 'releaseNotes');
		if (existing) {
			setActiveTabId(existing.id);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		setTabs((prev) => [...prev, { id, title: 'Release Notes', dirty: false, kind: 'releaseNotes' }]);
		setActiveTabId(id);
	}

	// Open (or focus) Snoutbot's reviews. One tab at a time: the view is a list plus what is
	// selected in it, so a second copy would only be the same list twice.
	function openReviews(runId?: string): void {
		// Naming the review is the difference between "open the reviews" and "open THIS review".
		// The view otherwise picks for itself (oldest waiting, else newest), which is right when
		// nobody said, and wrong when the card in the corner was about a particular one.
		if (runId) {
			setReviewSelect({ runId, nonce: Date.now() });
		}
		const existing = tabs.find((t) => t.kind === 'review');
		if (existing) {
			setActiveTabId(existing.id);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		setTabs((prev) => [...prev, { id, title: 'Reviews', dirty: false, kind: 'review' }]);
		setActiveTabId(id);
	}

	// A SnoutData Cloud project's tab: one per project, opened at the section the tree row named.
	function openCloudProject(ref: string, name: string, section: ProjectSection): void {
		const existing = tabs.find((t) => t.kind === 'cloudProject' && t.cloudRef === ref);
		if (existing) {
			setTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, cloudSection: section } : t)));
			setActiveTabId(existing.id);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		setTabs((prev) => [...prev, { id, title: name, dirty: false, kind: 'cloudProject', cloudRef: ref, cloudSection: section }]);
		setActiveTabId(id);
	}

	// Copying a whole project to the other side (shared/projectCopy.ts): one tab per source project.
	function openProjectCopy(source: ProjectTarget, name: string): void {
		const existing = tabs.find((t) => t.kind === 'projectCopy' && t.copySource && projectKey(t.copySource) === projectKey(source));
		if (existing) {
			setActiveTabId(existing.id);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		setTabs((prev) => [...prev, { id, title: `Copy ${name}`, dirty: false, kind: 'projectCopy', copySource: source }]);
		setActiveTabId(id);
	}

	// Local projects: one setup wizard tab, and one tab per project.
	function openLocalSetup(): void {
		const existing = tabs.find((t) => t.kind === 'localSetup');
		if (existing) {
			setActiveTabId(existing.id);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		setTabs((prev) => [...prev, { id, title: "Set up a local project", dirty: false, kind: 'localSetup' }]);
		setActiveTabId(id);
	}

	function openLocalProject(localId: string, name: string, section: ProjectSection): void {
		const existing = tabs.find((t) => t.kind === 'localProject' && t.localId === localId);
		if (existing) {
			setTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, localSection: section } : t)));
			setActiveTabId(existing.id);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		setTabs((prev) => [...prev, { id, title: name, dirty: false, kind: 'localProject', localId, localSection: section }]);
		setActiveTabId(id);
	}

	// A local project's database is a connection too, tagged with the project's id.
	async function openLocalDatabase(localId: string): Promise<void> {
		const fresh = await window.sqlApi.state();
		const config = fresh.connections.find((c) => c.localProjectId === localId);
		setDocks((d) => showTool(d, 'connections'));
		if (config) {
			selectConnection(config.id);
		}
	}

	// A cloud project's database IS a connection: show Connections and put it on the focused tab.
	// Asking main to sync first covers a project the background sync has not reached yet.
	async function openCloudDatabase(ref: string): Promise<void> {
		let id = state.connections.find((c) => c.cloudProjectRef === ref)?.id;
		if (!id) {
			// Added here even when the user deleted it: they just asked for this database by name.
			id = (await window.sqlApi.cloudEnsureConnection(ref).catch(() => null)) ?? undefined;
			setState(await window.sqlApi.state());
		}
		setDocks((d) => showTool(d, 'connections'));
		if (id) {
			selectConnection(id);
		}
	}

	// "Run a statement" on a project's Overview: a new SQL tab on the project's connection,
	// connected without taking over the tab the user was on.
	async function openProjectSql(target: ProjectTarget): Promise<void> {
		const find = (list: ConnectionConfig[]): ConnectionConfig | undefined => list.find((c) => (target.kind === 'local' ? c.localProjectId === target.id : c.cloudProjectRef === target.ref));
		let config = find(state.connections);
		if (!config) {
			if (target.kind === 'cloud') {
				await window.sqlApi.cloudEnsureConnection(target.ref).catch(() => null);
			}
			const fresh = await window.sqlApi.state();
			setState(fresh);
			config = find(fresh.connections);
		}
		if (!config) {
			return;
		}
		createTab('', { connectionId: config.id });
		if (!state.connectedIds.includes(config.id)) {
			void connect(config.id, false);
		}
	}

	// A monitor over a SnoutTime series' rollups (shared/seriesMonitor.ts): the same one again
	// if it was made before, so a second click opens it rather than a copy.
	async function openSeriesMonitor(connectionId: string, table: TableInfo): Promise<void> {
		// imported on first use: nothing about series monitors belongs in the launch bundle
		const { seriesMonitor } = await import('../../shared/seriesMonitor');
		const schema = await window.sqlApi.getSchema(connectionId);
		const label = state.connections.find((c) => c.id === connectionId)?.label ?? '';
		const monitor = seriesMonitor(table, schema?.tables ?? [], connectionId, label, () => crypto.randomUUID());
		if (!monitor) {
			return;
		}
		const existing = (await window.sqlApi.monitors.list()).find((d) => d.name === monitor.name);
		if (!existing) {
			await window.sqlApi.monitors.save(monitor);
		}
		setMonitorFocus({ nonce: Date.now(), id: existing?.id ?? monitor.id });
		openMonitors();
	}

	// Open (or focus) the monitors view (live DB monitors). Only one monitor tab exists at a time.
	function openMonitors(): void {
		const existing = tabs.find((t) => t.kind === 'monitor');
		if (existing) {
			setActiveTabId(existing.id);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		setTabs((prev) => [...prev, { id, title: 'Monitors', dirty: false, kind: 'monitor' }]);
		setActiveTabId(id);
	}

	// What the assistant and an external coding agent drive Orbit through.
	// The registry lives outside the React tree, so this is a registration rather than a
	// prop, and it is re-registered whenever the answers change.
	useEffect(() => {
		setOrbitBridge({
			openOrbit: (table?: string) => openOrbit(table),
			focusOrbit: (table: string) => {
				// Honest false rather than a silent no-op: the tool tells the model to open Orbit
				// first instead of reporting a focus that never happened.
				if (!tabs.some((t) => t.kind === 'orbit') || !activeSchema) {
					return false;
				}
				setOrbitFocus({ table, nonce: Date.now() });
				return true;
			},
		});
		return () => setOrbitBridge(undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeSchema, tabs]);

	// Open (or focus) Snout Orbit, the database drawn as a 3D world. One Orbit tab at a time:
	// two WebGL contexts fighting over the same schema is nobody's feature.
	function openOrbit(table?: string): void {
		if (table) {
			setOrbitFocus({ table, nonce: Date.now() });
		}
		// The controls are a docked panel, so opening Orbit means showing both halves.
		setDocks((d) => showTool(d, 'orbit'));
		const existing = tabs.find((t) => t.kind === 'orbit');
		if (existing) {
			setActiveTabId(existing.id);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		// Orbit opens on whatever the tab you came from was pointed at. Without this it opened
		// bound to NOTHING, which made `activeId` undefined for the whole tab: the schema was
		// whatever happened to be loaded, and Pulse could never ask the database anything because
		// it had no connection to ask. The rail's picker rebinds it from here on.
		setTabs((prev) => [...prev, { id, title: 'Orbit', dirty: false, kind: 'orbit', connectionId: activeIdRef.current }]);
		setActiveTabId(id);
	}

	// Open (or focus) the Data Flows wizard. One flow tab at a time; a dropped file or a saved
	// flow id opens it already parsed rather than on a blank step.
	function openFlow(options: { path?: string; flowId?: string; companion?: ToolId } = {}): void {
		const existing = tabs.find((t) => t.kind === 'flow');
		if (existing && !options.path && !options.flowId) {
			setActiveTabId(existing.id);
			return;
		}
		if (existing) {
			// A new file or flow means a fresh wizard: close the old one so its state can't leak in.
			closeTab(existing.id, { keepFlowFocus: true });
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		flowTabsRef.current.set(id, options);
		setTabs((prev) => [...prev.filter((t) => t.kind !== 'flow'), { id, title: 'Data Flow', dirty: false, kind: 'flow' }]);
		setActiveTabId(id);
		takeFlowFocus(options.companion);
	}

	// Open (or focus) Move Database. One move tab at a time, like a flow. `preview` is the dev-only
	// simulated run that shows the progress screen before the runner exists.
	const movePreviewRef = useRef(false);
	function openMove(options: { preview?: boolean } = {}): void {
		const existing = tabs.find((t) => t.kind === 'move');
		if (existing && !options.preview) {
			setActiveTabId(existing.id);
			return;
		}
		if (existing) {
			closeTab(existing.id);
		}
		movePreviewRef.current = options.preview === true;
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		setTabs((prev) => [...prev.filter((t) => t.kind !== 'move'), { id, title: 'Move Database', dirty: false, kind: 'move' }]);
		setActiveTabId(id);
	}

	// Open (or focus) the search over what a vector flow built. One tab; opening it for
	// another flow switches the flow it shows.
	const [vectorSearchFlowId, setVectorSearchFlowId] = useState<string | null>(null);
	function openVectorSearch(flowId: string): void {
		setVectorSearchFlowId(flowId);
		const existing = tabs.find((t) => t.kind === 'vectorSearch');
		if (existing) {
			setActiveTabId(existing.id);
			return;
		}
		tabSeq.current += 1;
		const id = `tab-${tabSeq.current}`;
		setTabs((prev) => [...prev, { id, title: 'Search Vectors', dirty: false, kind: 'vectorSearch' }]);
		setActiveTabId(id);
	}

	/**
	 * A flow is a whole-screen job (a wide preview grid, a column table, the generation workbench),
	 * so opening one collapses the side bar and the docked assistant to hand it the room. Both stay
	 * one click away on the activity bar, and what the user had open is remembered and put back when
	 * the flow tab closes — this is a focus mode, not a layout the app silently rewrites.
	 *
	 * `companion` is the one tool that survives it: whoever OPENED the wizard and is standing by to
	 * walk the user through it. An agent that opens the wizard and is then hidden by the act of
	 * opening it leaves the user alone on a screen they did not ask for, unable to see the thing
	 * that just said "I've opened it, walk through the steps". The room a flow needs is the SIDE
	 * BAR's and the other panels', not its guide's.
	 */
	const flowFocusRef = useRef<DockLayout | null>(null);

	function takeFlowFocus(companion?: ToolId): void {
		// Only remember on the way IN, so reopening a flow from inside a flow can't record the
		// emptied layout as "what the user had". The whole dock layout is what gets remembered now,
		// so a panel the user MOVED comes back where they put it, not where it started.
		setLayout((l) => {
			if (!flowFocusRef.current) {
				flowFocusRef.current = l.docks;
			}
			return { ...l, docks: focusWorkbench(l.docks, companion) };
		});
	}

	function restoreFlowFocus(): void {
		const previous = flowFocusRef.current;
		if (!previous) {
			return;
		}
		flowFocusRef.current = null;
		setLayout((l) => ({ ...l, docks: previous }));
	}

	// Import a `.snoutflow` and open it (Data Flows' renderer half does the import and says how it
	// went); on the palette so a file somebody was sent is one command away.
	async function importFlowFromFile(): Promise<void> {
		await importFlowFile({ openFlow: (options) => openFlow(options) });
	}

	// Dropping a data file ON THE APP is the hero entry point: the wizard opens with the file
	// already parsed, typed and shaped. It also stops Electron's default drop behaviour, which is
	// to NAVIGATE the window to the dropped file and leave the user staring at raw CSV.
	const openFlowRef = useRef(openFlow);
	openFlowRef.current = openFlow;
	const openWorkspaceFileRef = useRef(openWorkspaceFile);
	openWorkspaceFileRef.current = openWorkspaceFile;
	useEffect(() => {
		const stop = (event: DragEvent): void => { event.preventDefault(); };
		const onDrop = (event: DragEvent): void => {
			event.preventDefault();
			const file = event.dataTransfer?.files?.[0];
			// Not `file.path`: Electron removed that augmentation in version 32, so reading it here
			// meant the hero entry point silently did nothing at all.
			const path = file ? window.sqlApi.pro.pathForFile(file) : '';
			if (!path) {
				return;
			}
			// A .sql file is the one extension that still decides, because opening a SCRIPT and
			// ingesting DATA are different acts and the extension is what the user means by it.
			if (/\.sql$/i.test(path)) {
				void openWorkspaceFileRef.current(path);
				return;
			}
			// Everything else goes to the wizard WITHOUT being filtered by name. The list that used
			// to be here (csv|tsv|json|ndjson|jsonl|log|txt) is exactly the guess the classifier
			// exists to replace: it turned away every PDF, every spreadsheet, and every export
			// somebody named `.dat`.
			openFlowRef.current({ path });
		};
		window.addEventListener('dragover', stop);
		window.addEventListener('drop', onDrop);
		return () => {
			window.removeEventListener('dragover', stop);
			window.removeEventListener('drop', onDrop);
		};
	}, []);

	// Run designer-generated DDL, then re-introspect so the tree + completion catch up.
	const runDdl = useCallback(async (connectionId: string, sql: string): Promise<{ ok: boolean; error?: string }> => {
		const res = await window.sqlApi.execute({ connectionId, sql });
		if (!res.ok) {
			notifyError("Apply changes failed", res.error, { source: 'ddl', connectionId });
			return { ok: false, error: res.error };
		}
		await window.sqlApi.refresh(connectionId).catch(() => undefined);
		setStatus('Applied changes');
		return { ok: true };
	}, [setStatus]);

	// Save the editable grid's batch of statements (DELETE/UPDATE/INSERT) as one logical save.
	// The connection layer runs them one at a time (transactional per driver), so a multi-row
	// save isn't sent as one multi-statement query (which MySQL rejects).
	const runScript = useCallback(async (connectionId: string, statements: string[]): Promise<{ ok: boolean; error?: string }> => {
		const res = await window.sqlApi.executeScript({ connectionId, statements });
		if (!res.ok) {
			notifyError("Apply changes failed", res.error, { source: 'ddl', connectionId });
			return { ok: false, error: res.error };
		}
		await window.sqlApi.refresh(connectionId).catch(() => undefined);
		setStatus('Applied changes');
		return { ok: true };
	}, [setStatus]);

	// The document-backend (MongoDB) analog of runScript: the editable grid's batch of native
	// writes (updateOne/insertOne/deleteOne) committed as one save.
	const runWrites = useCallback(async (connectionId: string, writes: MongoWrite[]): Promise<{ ok: boolean; error?: string }> => {
		const res = await window.sqlApi.executeWrites({ connectionId, writes });
		if (!res.ok) {
			notifyError("Apply changes failed", res.error, { source: 'ddl', connectionId });
			return { ok: false, error: res.error };
		}
		// A data write doesn't change structure, so don't block the save on a full re-introspection
		// (for MongoDB that samples every collection — seconds on a real DB). Fire it off; the grid
		// reload shows the new rows and the 15s schema poll catches any structural drift.
		void window.sqlApi.refresh(connectionId).catch(() => undefined);
		setStatus('Applied changes');
		return { ok: true };
	}, [setStatus]);

	// Run a MongoDB structure op batch (create/drop collection, create/drop index) from the
	// collection-properties panel, then re-introspect so the tree + completion catch up (a
	// structure change, unlike a data write, must update the schema).
	const runMongoDdl = useCallback(async (connectionId: string, ops: MongoDdl[]): Promise<{ ok: boolean; error?: string }> => {
		const res = await window.sqlApi.executeMongoDdl({ connectionId, ops });
		if (!res.ok) {
			notifyError("Apply changes failed", res.error, { source: 'ddl', connectionId });
			return { ok: false, error: res.error };
		}
		await window.sqlApi.refresh(connectionId).catch(() => undefined);
		setStatus('Applied changes');
		return { ok: true };
	}, [setStatus]);

	// Create a new MongoDB collection from the sidebar name prompt, then open it.
	async function submitNewCollection(): Promise<void> {
		if (!newCollection) {
			return;
		}
		const name = newCollection.name.trim();
		if (name === '') {
			return;
		}
		setNewCollectionBusy(true);
		const res = await runMongoDdl(newCollection.connectionId, [{ op: 'createCollection', collection: name }]);
		setNewCollectionBusy(false);
		if (!res.ok) {
			return; // runMongoDdl already surfaced the error notification; keep the modal open.
		}
		const cid = newCollection.connectionId;
		setNewCollection(null);
		const schema = await window.sqlApi.getSchema(cid);
		const created = schema?.tables.find((t) => t.name === name);
		if (created) {
			openTable(cid, created, { tab: 'properties' });
		}
	}

	// After a create/alter, adopt the re-introspected table on the active tab (a created
	// table flips the tab from "New table" designer to a full browse/edit view).
	function persistTableTab(table: TableInfo): void {
		if (!activeTabId) {
			return;
		}
		const cur = tableTabsRef.current.get(activeTabId);
		if (!cur) {
			return;
		}
		tableTabsRef.current.set(activeTabId, { ...cur, table, createInSchema: undefined });
		setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, title: table.name } : t)));
	}

	// Pin/unpin a result tab. A pinned tab is never overwritten by the next run (a fresh live tab
	// opens instead), so the user can keep a result around while iterating.
	function toggleResultPin(id: string): void {
		setResultTabs((prev) => prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)));
	}

	// Close a result tab; if it was active, fall to a neighbour (DBeaver-style).
	function closeResultTab(id: string): void {
		setResultTabs((prev) => {
			const idx = prev.findIndex((t) => t.id === id);
			const remaining = prev.filter((t) => t.id !== id);
			if (activeResultIdRef.current === id) {
				setActiveResultId(remaining.length > 0 ? remaining[Math.min(idx, remaining.length - 1)].id : null);
			}
			return remaining;
		});
	}

	// Commit an inline rename (Enter or blur); empty keeps the old title. Always clears edit mode.
	function commitResultRename(id: string, value: string): void {
		const trimmed = value.trim();
		if (trimmed) {
			patchResult(id, { title: trimmed });
		}
		setRenamingResultId(null);
	}

	// The statement under the caret, read by the guard the run path uses (the companion says what to
	// say). Each warning once until something runs: a run is the user having read it.
	const riskTimerRef = useRef(0);
	const riskSaidRef = useRef(new Set<string>());
	const riskCheckRef = useRef<() => void>(() => undefined);
	riskCheckRef.current = () => {
		const editor = editorRef.current;
		const model = editor?.getModel();
		if (!editor || !model || !activeConfig || !editor.hasTextFocus()) {
			return;
		}
		const position = editor.getPosition();
		const sql = statementAt(model.getValue(), position ? model.getOffsetAt(position) : 0);
		const found = sql ? destructiveStatement(sql, activeConfig.driver) : undefined;
		if (!found) {
			return;
		}
		const production = activeConfig.environment === 'prod';
		const move: LibyCall | null = riskyAdvice({ verb: found.verb, unfiltered: found.unfiltered, production, confirms: production && appSettings.confirmOnProd, table: writtenTable(sql), label: activeConfig.label });
		if (move && !riskSaidRef.current.has(move.topic)) {
			riskSaidRef.current.add(move.topic);
			libyCall(move);
		}
	};

	function currentSql(): string {
		const editor = editorRef.current;
		const model = editor?.getModel();
		if (!editor || !model) {
			return '';
		}
		const selection = editor.getSelection();
		if (selection && !selection.isEmpty()) {
			return model.getValueInRange(selection).trim();
		}
		// No selection: run just the statement under the caret, not the whole buffer.
		const position = editor.getPosition();
		return statementAt(model.getValue(), position ? model.getOffsetAt(position) : 0);
	}

	// Snapshot of "what the user is looking at right now" for the AI chat: the SQL in the active
	// editor (+ what's highlighted), the shape of the result currently showing, and the last
	// error. Read on demand at send time (not memoized) so it always reflects the live editor/
	// grid. Shapes + a tiny bounded sample of values, never the whole result.
	function getAmbient(): AmbientContext {
		const editor = editorRef.current;
		const model = editor?.getModel();
		const buffer = model?.getValue() ?? undefined;
		const sel = editor?.getSelection();
		const selection = sel && model && !sel.isEmpty() ? model.getValueInRange(sel) : undefined;
		// `response` is the result the main grid is showing; pair it with the connection it ran on
		// only matters for display, so here we just read shape (columns) or the error text.
		const resultColumns = response?.ok ? response.result.fields : undefined;
		const lastError = response && !response.ok && !response.cancelled ? response.error : undefined;
		// A tiny sample of the actual rows (raw result order), so even the free one-shot path can
		// reason about the data on screen, not just the column shape. Stringified here (NULL→"NULL",
		// objects→JSON) to stay structured-clone-safe; the prompt builder caps how much it inlines.
		const resultRows = response?.ok ? sampleResultRows(response.result.rows) : undefined;
		// The focused grid cell + its row, when the result currently shown is the one selected in
		// (cleared by the grid on a result/page change, so it can't go stale against `response`).
		const gridSel = response?.ok ? gridSelectionRef.current : null;
		// "The table I have open": when the active tab is a table-view tab (browsing/designing a
		// table from the schema explorer), it has no editor buffer, so without this the AI can't
		// see which table the user is looking at. `tableTabsRef` only holds table-kind tabs, so a
		// hit here means the active tab is one; the "New table" designer has no `table` yet (skip).
		const openTable = activeTabId ? tableTabsRef.current.get(activeTabId)?.table : undefined;
		const focusedTable = openTable ? { schema: openTable.schema, name: openTable.name } : undefined;
		// Same idea for an object tab (procedure/function/trigger): no editor buffer, and its body
		// has no other cheap channel into the prompt, so the DDL rides along (clipped by the builder).
		const openObject = activeTabId ? objectTabsRef.current.get(activeTabId) : undefined;
		const focusedObject = openObject ? { kind: openObject.kind, schema: openObject.schema, name: openObject.name, ddl: openObject.ddl } : undefined;
		// Cross-tab query awareness: the SQL of the user's OTHER open editor tabs (only SQL tabs have
		// a Monaco model in modelsRef), so "combine this with my other query" works. Skip the active
		// tab (already editorBuffer) and empty tabs; the builder caps count + per-tab chars.
		const otherTabs: { title: string; sql: string }[] = [];
		for (const [id, m] of modelsRef.current) {
			if (id === activeTabId) {
				continue;
			}
			const sql = m.getValue().trim();
			if (!sql) {
				continue;
			}
			otherTabs.push({ title: tabs.find((t) => t.id === id)?.title ?? 'query', sql });
		}
		// The user's saved connections (identity only — no host/credentials), so the assistant can
		// resolve "prod"/"staging"/a name to a connection and know which one is active, without a
		// tool round-trip. Powers "look at this in prod" on both the agentic and one-shot paths.
		const connectionRoster = state.connections.map((c) => ({
			id: c.id,
			label: c.label,
			environment: c.environment,
			connected: state.connectedIds.includes(c.id),
			active: c.id === activeId,
		}));
		// The Data Flow wizard's state, only while a flow tab is what the user is looking at.
		const flowWizard = activeTab?.kind === 'flow' ? flowAmbientRef.current ?? undefined : undefined;
		return { editorBuffer: buffer, selection, resultColumns, resultRows, selectedCell: gridSel?.selectedCell, selectedRow: gridSel?.selectedRow, lastError, focusedTable, focusedObject, otherTabs: otherTabs.length > 0 ? otherTabs : undefined, connections: connectionRoster.length > 0 ? connectionRoster : undefined, flowWizard };
	}
	// Introspection hooks for the e2e suite: the ambient bundle is invisible in the UI, so a
	// regression that silently drops a field (exactly what happened to flowWizard) is otherwise
	// untestable; the capability invoker lets tests drive the assistant's write path without a
	// model round-trip. Local app, no remote content in this renderer.
	(window as unknown as { __snoutDebugAmbient?: () => AmbientContext }).__snoutDebugAmbient = getAmbient;
	// The manifest ChatPanel sends with every turn (`capabilityRegistry.list()`). A spec driving a
	// chat turn over the IPC has to pass the same list, or the tools the model is offered are the
	// test's invention rather than the app's.
	(window as unknown as { __snoutDebugCapabilities?: () => CapabilitySpec[] }).__snoutDebugCapabilities = () => capabilityRegistry.list();
	(window as unknown as { __snoutDebugCapability?: (name: string, args: Record<string, unknown>) => Promise<CapabilityResult> }).__snoutDebugCapability = (name, args) => {
		const ctx = capabilityCtxRef.current;
		return ctx
			? capabilityRegistry.invoke({ id: 'e2e', name, arguments: args }, ctx)
			: Promise.resolve({ ok: false, summary: '', error: 'The app is not ready.' });
	};

	function formatEditor(): void {
		const editor = editorRef.current;
		const model = editor?.getModel();
		if (!editor || !model) {
			return;
		}
		const driver = activeConfig?.driver;
		const selection = editor.getSelection();
		// Format the selection if there is one, otherwise the whole buffer.
		const range = selection && !selection.isEmpty() ? selection : model.getFullModelRange();
		const formatted = formatSql(model.getValueInRange(range), driver, appSettings.keywordCase);
		editor.executeEdits('format', [{ range, text: formatted, forceMoveMarkers: true }]);
		editor.focus();
	}

	// Export the grid as CSV/JSON. "current" serializes the loaded result; "full" re-runs
	// the raw statement (no auto-LIMIT, but a manual LIMIT in the SQL still applies).
	function copyResults(format: CopyFormat): void {
		if (!response || !response.ok) {
			return;
		}
		const text = format === 'tsv' ? toTsv(response.result) : toCsv(response.result);
		void navigator.clipboard.writeText(text).then(
			() => setStatus(`Copied ${response.result.rows.length} rows as ${format.toUpperCase()}.`),
			() => setStatus('Copy failed.', 'danger'),
		);
	}

	async function exportResults(format: ExportFormat, source: ExportSource): Promise<void> {
		try {
			let data;
			// Name the file after the query (FROM table + date); fall back when the editor is empty.
			const nameSql = currentSql();
			if (source === 'full') {
				if (!activeId || !activeConnected) {
					setStatus('Connect to the database first.', 'danger');
					return;
				}
				if (!nameSql) {
					setStatus('Nothing to export.', 'danger');
					return;
				}
				setStatus('Exporting…');
				const res = await window.sqlApi.execute({ connectionId: activeId, sql: nameSql });
				if (!res.ok) {
					setStatus('');
					notifyError("Export failed", res.error, { source: 'export', connectionId: activeId, sql: nameSql });
					return;
				}
				data = res.result;
			} else {
				if (!response || !response.ok) {
					setStatus('No results to export.', 'danger');
					return;
				}
				data = response.result;
			}
			const name = exportFileName(nameSql, format);
			// Excel is binary, so main builds the workbook from the raw rows; CSV/JSON are
			// serialized here and written as text.
			const saved = format === 'xlsx'
				? await window.sqlApi.exportXlsx(name, toXlsxSheet(data, nameSql))
				: await window.sqlApi.exportData(name, serializeResult(data, format));
			if (saved) {
				setStatus(`Exported ${data.rows.length.toLocaleString()} ${data.rows.length === 1 ? 'row' : 'rows'} → ${basename(saved)}`);
			}
		} catch (err) {
			setStatus('');
			notifyError("Export failed", errorMessage(err), { source: 'export' });
		}
	}

	/**
	 * Export by asking the SERVER to write the file (ClickHouse's `FORMAT Parquet` and friends).
	 *
	 * Not a third branch of `exportResults`: nothing is serialized here and no rows come back, so
	 * the size of the answer stops being the app's problem. The statement is the one in the editor,
	 * run again, with the app's auto-LIMIT deliberately NOT applied - a person exporting to Parquet
	 * wants the whole thing, and a LIMIT they wrote themselves still stands.
	 */
	async function exportFromServer(formatId: string): Promise<void> {
		const sql = currentSql();
		if (!activeId || !activeConnected) {
			setStatus('Connect to the database first.', 'danger');
			return;
		}
		if (!sql) {
			setStatus('Nothing to export.', 'danger');
			return;
		}
		setStatus('Exporting…');
		const outcome = await window.sqlApi.exportServerSide({ connectionId: activeId, sql, formatId, suggestedName: exportFileName(sql, 'csv').replace(/\.csv$/, '') });
		if (outcome.ok) {
			setStatus(`Exported ${formatBytes(outcome.bytes)} in ${(outcome.durationMs / 1000).toFixed(1)}s → ${basename(outcome.path)}`);
			return;
		}
		setStatus('');
		if (!outcome.cancelled) {
			notifyError("Export failed", outcome.error ?? 'The server did not say why.', { source: 'export', connectionId: activeId, sql });
		}
	}

	async function saveCurrentQuery(): Promise<void> {
		const sql = currentSql();
		if (!sql) {
			setStatus('Nothing to save');
			return;
		}
		const name = window.prompt('Save query as:');
		if (!name?.trim()) {
			return;
		}
		await window.sqlApi.saveQuery(name.trim(), sql);
		markTask('save');
		libyFeel({ kind: 'saved' });
		setStatus(`Saved query "${name.trim()}"`);
	}

	// Post-run index/scan advisor (query advisor, Pillar 2 Tier B). When a SELECT ran slower than the
	// configured threshold, EXPLAIN it once (history-clean) and check the plan for full scans /
	// filesorts, landing any advisories on the result tab. Advisory-only: it never delays results,
	// never surfaces an error, and no-ops for non-SELECTs and vendors without a supported plan format.
	const adviseOnSlowQuery = useCallback(async (sql: string, targetId: string, connId: string, result: ExecuteQueryResult): Promise<void> => {
		if (!result.ok) {
			return;
		}
		const thresholdMs = appSettingsRef.current.slowQueryAdviseMs;
		if (thresholdMs <= 0 || (result.result.durationMs ?? 0) < thresholdMs) {
			return;
		}
		if (!/^\s*(select|with)\b/i.test(sql)) {
			return; // only wrap plain reads in EXPLAIN, never a write/DDL
		}
		const driver = connectionsRef.current.find((c) => c.id === connId)?.driver;
		const explainSql = dialectFor(driver).explainJson?.(sql);
		if (!explainSql) {
			return; // vendor without a supported plan JSON → silently skip
		}
		try {
			const res = await window.sqlApi.explain({ connectionId: connId, sql: explainSql });
			if (!res.ok) {
				return; // EXPLAIN denied / failed — advisory is best-effort, stay silent
			}
			const advisories = analyzePlan(driver, res.result.rows[0]?.[0], planOptions(sql, connId));
			if (advisories.length > 0) {
				patchResult(targetId, { advisories });
			}
		} catch {
			// advisory only — never bubble an error into the run path
		}
	}, [patchResult]);

	// Pre-flight scan check: before a SELECT runs, ask the planner (one EXPLAIN) how
	// many rows it will scan and whether it can use an index, so a huge scan can be warned about BEFORE
	// it runs (not after the screen freezes). The same plan feeds the index/scan advisor, so its
	// advisories ride back for reuse (no second EXPLAIN). Returns null when pre-flight doesn't apply
	// (disabled, non-SELECT, tunnelled connection, or a vendor without a plan format) — the caller then
	// runs normally and the post-run advisor still fires on a slow query.
	const runPreflightScan = useCallback(async (sql: string, connId: string): Promise<{ warn: boolean; rows?: number; table?: string; advisories: Advisory[] } | null> => {
		const settings = appSettingsRef.current;
		if (!settings.preflightScan || !/^\s*(select|with)\b/i.test(sql)) {
			return null;
		}
		const config = connectionsRef.current.find((c) => c.id === connId);
		const explainSql = dialectFor(config?.driver).explainJson?.(sql);
		if (!explainSql) {
			return null;
		}
		try {
			const res = await window.sqlApi.explain({ connectionId: connId, sql: explainSql });
			if (!res.ok) {
				return null; // EXPLAIN denied / failed — don't block the run
			}
			const advisories = analyzePlan(config?.driver, res.result.rows[0]?.[0], planOptions(sql, connId));
			const heavy = advisories.find((a) => (a.kind === 'large-scan' || a.kind === 'full-scan') && (a.rows ?? 0) >= settings.preflightWarnRows);
			return { warn: heavy !== undefined, rows: heavy?.rows, table: heavy?.table, advisories };
		} catch {
			return null;
		}
	}, []);

	// Run `sql` and land the outcome in the result tab `targetId` (resolved by run()/callers).
	// `opts.preAdvisories` carries plan advisories already computed by the pre-flight EXPLAIN, so the
	// post-run advisor reuses them instead of a second EXPLAIN round-trip.
	const executeSql = useCallback(async (sql: string, targetId: string, opts?: { allowAi?: boolean; preAdvisories?: Advisory[]; keyset?: KeysetSequence; plainSql?: string; chatRunId?: string; window?: { start: number; end: number } }): Promise<void> => {
		if (!activeId) {
			return;
		}
		// Set on a run started from the chat's Run button: every exit below reports back to it.
		const chatRunId = opts?.chatRunId;
		// A fresh run invalidates any counted total + any script log. It also re-tags the tab as the SQL
		// surface: a result tab is reused across runs, so one that last held a native pipeline must drop
		// that surface (and its stashed native queries) or the SQL-only affordances stay gated off.
		// `keyset` likewise belongs to ONE run: a re-run that no longer qualifies must not inherit the
		// previous one's cursor, so it is written here (undefined when the caller didn't open a sequence)
		// rather than left standing.
		patchResult(targetId, { lastSql: sql, totalCount: null, script: undefined, explain: undefined, surface: 'sql', nativeQuery: undefined, rawNativeQuery: undefined, keyset: opts?.keyset });
		startRunning(targetId, activeId);
		// Pulse: Orbit lights the objects this statement touches. Fired when the query LEAVES
		// rather than when it lands, because that is what someone watching a live map expects to
		// see, and a slow query should glow for as long as it takes.
		setOrbitStatement({ sql, connectionId: activeId, at: Date.now() });
		setStatus(''); // the toolbar timer shows the running state now
		try {
			// Spend AI budget only with consent: the always-translate setting (or an explicit confirm,
			// passed as opts.allowAi) gates the model fallback. Without it, an untranslatable query
			// comes back as `needsAiTranscribe` and we ask first.
			const allowAiTranscribe = opts?.allowAi ?? appSettingsRef.current.aiAutoTranscribe;
			let result = await window.sqlApi.execute({ connectionId: activeId, sql, allowAiTranscribe, window: opts?.window });
			// A keyset run is the user's statement REWRITTEN using the cached schema — it carries an
			// ORDER BY they didn't write, on a column we believe is the primary key. If the cache is
			// stale (that column was just dropped or renamed, or the name resolved to a different table
			// than the one we matched), the rewrite fails a query that would have succeeded as typed.
			// That is this feature breaking working behavior, which it is never allowed to do, so fall
			// back to the plain statement once and let the run stand on its own.
			if (!result.ok && !result.cancelled && !result.needsAiTranscribe && opts?.keyset && opts.plainSql && opts.plainSql !== sql) {
				const plain = await window.sqlApi.execute({ connectionId: activeId, sql: opts.plainSql, allowAiTranscribe });
				if (plain.ok) {
					// It ran without the rewrite, so this result is NOT a keyset sequence: drop the
					// descriptor or "Next" would seek over rows fetched in the engine's own order.
					sql = opts.plainSql;
					result = plain;
					patchResult(targetId, { lastSql: opts.plainSql, keyset: undefined });
				}
			}
			if (!result.ok && result.cancelled) {
				// User aborted: leave any prior results in place; just note the cancellation.
				setStatus('Query cancelled.');
				if (chatRunId) {
					setChatRunOutcome({ runId: chatRunId, status: 'cancelled' });
				}
				return;
			}
			if (!result.ok && result.needsAiTranscribe) {
				// Deterministic translation failed; ask before spending AI budget (leave prior results).
				setStatus('');
				setPendingAiTranscribe({ sql, targetId, chatRunId });
				return;
			}
			// Tag the results with the connection that ran them (edit-safety guard).
			patchResult(targetId, { response: result, connectionId: activeId, ranAt: Date.now(), advisories: undefined });
			if (result.ok) {
				markTask('run');
				riskSaidRef.current.clear();
				libyFeel({ kind: 'query-ok', rows: result.result.rowCount, ms: result.result.durationMs, changed: result.result.fields.length === 0, sql });
				if (opts?.preAdvisories !== undefined) {
					// Pre-flight already ran EXPLAIN: attach its advisories directly, no second round-trip.
					patchResult(targetId, { advisories: opts.preAdvisories.length > 0 ? opts.preAdvisories : undefined });
				} else {
					// Post-run index/scan advisor (Pillar 2 Tier B): a slow SELECT gets one EXPLAIN and its
					// plan is checked for full scans / filesorts. Fire-and-forget so it never delays results.
					void adviseOnSlowQuery(sql, targetId, activeId, result);
				}
			}
			// Row count + duration live in the results footer; a failure shows in the grid + the
			// notifications center, so just clear the "Running…" line either way.
			setStatus(result.ok && result.aiTranslated ? `Translated by ${ASSISTANT_NAME}.` : '');
			if (!result.ok) {
				// The companion is told before the notifications center records the failure, so the
				// center can see it has already been passed on.
				coachQueryError(result.error, sql);
				notifyError("Query failed", result.error, { source: 'query', connectionId: activeId, sql });
			}
			if (chatRunId) {
				// A statement with no result set (an UPDATE/INSERT/DELETE/DDL) reports affected rows in
				// `rowCount`, so `changed` tells the chat which of the two numbers it is showing.
				setChatRunOutcome(result.ok
					? { runId: chatRunId, status: 'ok', rowCount: result.result.rowCount, durationMs: result.result.durationMs, changed: result.result.fields.length === 0 }
					: { runId: chatRunId, status: 'error', message: result.error });
			}
		} catch (err) {
			const msg = errorMessage(err);
			patchResult(targetId, { response: { ok: false, error: msg }, connectionId: activeId, ranAt: Date.now() });
			setStatus('');
			coachQueryError(msg, sql);
			notifyError("Query failed", msg, { source: 'query', connectionId: activeId, sql });
			if (chatRunId) {
				setChatRunOutcome({ runId: chatRunId, status: 'error', message: msg });
			}
		} finally {
			stopRunning(targetId);
		}
	}, [activeId, markTask, patchResult, adviseOnSlowQuery, startRunning, stopRunning, coachQueryError]);

	// Run a native query (the MongoDB pipeline surface) into the result tab
	// `targetId`. Mirrors executeSql but dispatches an already-built NativeQuery and tags the tab
	// as native (so SQL-only affordances — count, in-grid edit, SQL replay — stay off). `display`
	// is the shell-style rendering shown in the footer/history.
	const executeNativeQuery = useCallback(async (native: NativeQuery, display: string, targetId: string, rawNative?: NativeQuery): Promise<void> => {
		if (!activeId) {
			return;
		}
		// `rawNative` is the authored, uncapped query behind `native` — set only by callers whose result
		// can be paged (the pipeline editor). Callers that can't be windowed (find bar, explain) leave it
		// undefined, which also clears any value a previous run left on this reused tab. `keyset` is
		// cleared for the same reason and it MATTERS here: result tabs are reused across runs, so a tab
		// that last held a keyed SQL browse would otherwise keep that sequence and try to page a Mongo
		// pipeline with SQL seek statements.
		patchResult(targetId, { lastSql: display, surface: 'native', nativeQuery: native, rawNativeQuery: rawNative, totalCount: null, script: undefined, explain: undefined, keyset: undefined });
		startRunning(targetId, activeId);
		setStatus('');
		try {
			const result = await window.sqlApi.execute({ connectionId: activeId, native });
			if (!result.ok && result.cancelled) {
				setStatus('Query cancelled.');
				return;
			}
			patchResult(targetId, { response: result, connectionId: activeId, ranAt: Date.now() });
			if (result.ok) {
				markTask('run');
				libyFeel({ kind: 'query-ok', rows: result.result.rowCount, ms: result.result.durationMs, changed: result.result.fields.length === 0, sql: display });
			}
			setStatus('');
			if (!result.ok) {
				notifyError("Query failed", result.error, { source: 'query', connectionId: activeId, sql: display });
			}
		} catch (err) {
			const msg = errorMessage(err);
			patchResult(targetId, { response: { ok: false, error: msg }, connectionId: activeId, ranAt: Date.now() });
			setStatus('');
			notifyError("Query failed", msg, { source: 'query', connectionId: activeId, sql: display });
		} finally {
			stopRunning(targetId);
		}
	}, [activeId, markTask, patchResult, startRunning, stopRunning]);

	// Hand the failed query + its error to the assistant. Opens the chat panel and pre-seeds a
	// fresh fix chat grounded in the connection that produced the result; the user inserts/runs
	// the corrected SQL via the chat's existing buttons (propose-only — the run guardrails stay).
	const fixWithAI = useCallback((): void => {
		// Reached from the AI menu and the palette with nothing on screen to fix, this used to
		// return without a word, which reads as a broken menu item.
		if (!response || response.ok || !lastSql) {
			setStatus("Nothing to fix: the last query did not fail. When one does, this sends it and its error to the assistant.");
			return;
		}
		const connectionId = resultConnectionId ?? activeId;
		if (!connectionId) {
			setStatus("Nothing to fix: the failed query's connection is gone.");
			return;
		}
		setChatOpen(true);
		setFixRequest({ nonce: Date.now(), sql: lastSql, error: response.error, connectionId });
	}, [response, lastSql, resultConnectionId, activeId, setStatus]);

	// ---- Liby, summoned ---------------------------------------------------------------------
	// The help shortcut (or the palette) calls the companion package's summon with the element the
	// user is on; what happens next is the package's. Studio registers a helper for three surfaces
	// (just below; the connection form registers its own) and answers `help` with `libyHelp`.
	function keyHint(id: string): string {
		const combo = keybindingsRef.current.find((b) => b.id === id)?.combo;
		return combo ? formatShortcut(combo) : '';
	}
	function libyGlance(): SchemaGlance | null {
		const schema = activeSchemaRef.current;
		return schema ? { tables: schema.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name) })) } : null;
	}
	function libyResult(): ResultFacts | undefined {
		if (!response) {
			return undefined;
		}
		if (!response.ok) {
			return response.cancelled ? undefined : { ok: false, error: response.error, sql: lastSql || undefined };
		}
		// A write (no columns) has no result to talk about; the statement is the thing then.
		const { fields, rows, durationMs } = response.result;
		return fields.length > 0 ? { ok: true, rows: rows.length, columns: fields.map((f) => f.name), ms: durationMs, sql: lastSql } : undefined;
	}
	function libyEditor(): EditorFacts {
		const editor = editorRef.current;
		const model = editor?.getModel();
		const sql = model?.getValue() ?? '';
		const sel = editor?.getSelection();
		const selected = sel && model && !sel.isEmpty() ? model.getValueInRange(sel) : undefined;
		const position = editor?.getPosition();
		const statement = (selected ?? (model ? statementAt(sql, position ? model.getOffsetAt(position) : 0) : '')).trim() || undefined;
		const found = statement && activeConfig ? destructiveStatement(statement, activeConfig.driver) : undefined;
		const production = activeConfig?.environment === 'prod';
		return {
			connected: activeConnected,
			connections: state.connections.length,
			connectionLabel: activeConfig?.label,
			sql,
			statement,
			risky: found && statement ? { verb: found.verb, unfiltered: found.unfiltered, production, confirms: production && appSettings.confirmOnProd, table: writtenTable(statement), label: activeConfig?.label } : null,
			advisory: statement && activeConfig ? lintSargability(statement, activeSchemaRef.current ?? undefined, activeConfig.driver)[0]?.message : undefined,
			result: libyResult(),
			schema: libyGlance(),
			runKey: keyHint('run') || 'Ctrl+Enter',
			editKey: keyHint('aiEdit') || 'Ctrl+K',
		};
	}
	// The helpers, rebuilt every render (so they read the live app) and registered once.
	const libyHelpersRef = useRef<Record<'workbench' | 'results' | 'sidebar', { place(el: Element): string; help(el: Element): HelpMove | null }> | null>(null);
	libyHelpersRef.current = {
		workbench: {
			place: () => {
				if (!activeTab) {
					return 'the empty workbench';
				}
				switch (activeTab.kind ?? 'sql') {
					case 'sql': return `the SQL editor (tab ${activeTab.title})`;
					case 'table': return `the table ${activeTab.title}`;
					case 'flow': return `the Data Flow wizard (${activeTab.title})`;
					default: return `the ${activeTab.title} tab`;
				}
			},
			help: () => {
				if (!activeTab) {
					return state.connections.length === 0
						? editorHelp(libyEditor())
						: emptyWorkbenchHelp(keyHint('new') || 'Ctrl+N');
				}
				switch (activeTab.kind ?? 'sql') {
					case 'sql': return editorHelp(libyEditor());
					case 'table': {
						const table = activeTabId ? tableTabsRef.current.get(activeTabId)?.table : undefined;
						return table ? tableHelp(tableFacts(table)) : null;
					}
					case 'flow': return flowAmbientRef.current ? flowHelp(flowAmbientRef.current) : null;
					default: return null;
				}
			},
		},
		results: { place: () => 'the results', help: () => resultHelp(libyResult(), libyGlance()) },
		sidebar: { place: () => 'the Connections panel', help: () => sidebarHelp({ connections: state.connections.length, connected: state.connectedIds.length }) },
	};
	useEffect(() => {
		const selectors = { workbench: '.workbench', results: '.results-pane', sidebar: '.sidebar' } as const;
		const offs = (Object.keys(selectors) as (keyof typeof selectors)[]).map((k) => registerLibyHelper({
			selector: selectors[k],
			place: (el) => libyHelpersRef.current?.[k].place(el) ?? '',
			help: (el) => {
				const move = libyHelpersRef.current?.[k].help(el) ?? null;
				return move ? asLibyHelp(move) : null;
			},
		}));
		return () => offs.forEach((off) => off());
	}, []);

	/** What Studio returns for `target` and an optional question: the screen helper's move when
	 *  there is one and no question; signed out, the signed-out help; otherwise the place, its root
	 *  element and the app facts below. */
	function libyHelp(target: Element, question?: string): LibyHelp | LibyLook {
		const found = helpAt(target);
		if (found.help && !question) {
			return found.help;
		}
		if (auth.user === null) {
			return asLibyHelp(question ? signedOutQuestionHelp() : signedOutHelp(found.place));
		}
		const facts: LibyFact[] = [];
		if (activeConfig) {
			facts.push({ label: 'Connection', value: `${activeConfig.label} (${dialectFor(activeConfig.driver).displayName}${activeConfig.environment === 'prod' ? ', tagged prod' : ''}${activeConnected ? '' : ', not connected'})` });
		}
		// The editor and the result are added only when the target is in the work area (or is the
		// page itself), not when it is in the sidebar or a dialog.
		if (found.root === document.body || found.root.closest('.workbench')) {
			const statement = activeTab && (activeTab.kind ?? 'sql') === 'sql' ? libyEditor().statement : undefined;
			if (statement) {
				facts.push({ label: 'Editor holds', value: statement });
			}
			const r = libyResult();
			if (r && !r.ok) {
				facts.push({ label: 'Last error', value: r.error });
			} else if (r) {
				facts.push({ label: 'Result showing', value: `${r.rows.toLocaleString('en-US')} rows of ${r.columns.slice(0, 8).join(', ')}${r.columns.length > 8 ? ', …' : ''}${r.ms !== undefined ? ` in ${r.ms} ms` : ''}` });
			}
		}
		return { place: found.place, root: found.root, facts };
	}

	/** Closes the companion and opens the assistant panel with `question`. */
	function libyDeeper(question: string): void {
		libyClose();
		setChatOpen(true);
		setAskRequest({ nonce: Date.now(), prompt: question, connectionId: activeId });
	}
	// The host passed to the package: made once, reading the live app through this ref.
	const libyLiveRef = useRef({ help: libyHelp, deeper: libyDeeper });
	libyLiveRef.current = { help: libyHelp, deeper: libyDeeper };
	const [libyHost] = useState(() => studioHost({
		help: (target, question) => libyLiveRef.current.help(target, question),
		deeper: (question) => libyLiveRef.current.deeper(question),
		busy: () => tourActiveRef.current,
		off: () => setAppSettings((current) => ({ ...current, disableMascot: true })),
	}));

	// A screen helper's actions run here.
	setHelpActionRunner((action) => libyAction(action));
	// The companion package's own e2e hooks, if it has any (the stub has none).
	useEffect(() => {
		installLibyTestHooks();
	}, []);
	function libyAction(action: HelpAction): void {
		if (action.kind === 'do') {
			action.run();
			return;
		}
		// Any other action closes the companion, then opens the panel or runs a command.
		libyClose();
		if (action.kind === 'ask') {
			setChatOpen(true);
			setAskRequest({ nonce: Date.now(), prompt: action.prompt, connectionId: activeId });
		} else if (action.kind === 'fix') {
			fixWithAI();
		} else {
			commandsRef.current.find((c) => c.id === action.id)?.run();
		}
	}

	/** The help shortcut: summon the companion to what the user is on, or dismiss it if it is out. */
	function summonLiby(): void {
		// A build without her (the open-source tree, packages/liby-stub): help is the assistant.
		if (!LIBY_AVAILABLE) {
			setChatOpen(true);
			return;
		}
		if (libyOut()) {
			libyClose();
			return;
		}
		const surface = attentionSurface();
		const area = surface?.el ?? document.querySelector('.workbench');
		const active = document.activeElement;
		const focused = active && active !== document.body && area?.contains(active) ? active : null;
		const box = area?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
		libySummon(summonPoint(box, { width: window.innerWidth, height: window.innerHeight }), focused ?? area);
	}

	// Latch Liby as mounted the first time it's shown, so it's never torn down and rebuilt on a later
	// toggle, move or switch of view (which is what preserves the conversation).
	useEffect(() => {
		if (chatOpen || fullChat) {
			setAssistantEverOpened(true);
		}
	}, [chatOpen, fullChat]);

	// Pop a toast for each freshly-recorded error so a failure isn't missed; it then lives on in
	// the notifications center. Subscribed once for the app's lifetime.
	useEffect(() => onNotify((entry) => {
		// Snoutbot is excluded because it has its OWN card (`ReviewToast`), which says the same
		// thing better and is already up by the time this fires. Its entry still goes to the
		// centre; what it must not do is put two cards in the corner for one review.
		if (entry.severity !== 'info' && entry.source !== 'snoutbot') {
			setToast(entry);
		}
	}), []);

	// A finished flow run that did not fully work becomes a notification (Data Flows' renderer half).
	useFlowRunNotices();

	// A finished review leaves something behind in the notifications centre.
	//
	// The tray already shows the reviewer's state, but a tray reading is a STATE you have to go and
	// look at, and the case that matters most here happens with no window up: a review is written,
	// nothing is posted, and it waits. `reviewNotice` decides what is worth saying (a clean review
	// that posted itself is not; a blocker is). Subscribed once for the app's lifetime.
	useEffect(() => window.sqlApi.onReviewRun((run) => {
		const notice = reviewNotice(run);
		if (notice) {
			notify({ severity: notice.severity, title: notice.title, detail: notice.detail, source: 'snoutbot' });
		}
		// The card always speaks, even where the centre stays quiet: somebody watching the app is
		// owed the answer to the review they just triggered.
		setReviewToast((current) => {
			const next = finishedToast(run);
			return replacesToast(current, next) ? next : current;
		});
	}), []);

	// And the other half: a review has STARTED. Everything between here and the outcome used to be
	// silence, which is what made "Check now" look like a button that did nothing.
	useEffect(() => window.sqlApi.onReviewStarted((started) => {
		setReviewToast((current) => {
			const next = startedToast(started);
			return replacesToast(current, next) ? next : current;
		});
	}), []);

	// "Ask AI" from a notification: open the chat and seed it with the error. A query error carries
	// its SQL (so the assistant proposes a corrected query); anything else gets a plain-language
	// "what does this mean / how do I fix it" prompt grounded in the connection if there was one.
	const askAiAboutNotification = useCallback((n: AppNotification): void => {
		setNotifOpen(false);
		// Liby is one instance in either view, so the fix lands in whichever one is showing.
		setChatOpen(true);
		// A connection that just failed is not grounded on: grounding connects first, which would only
		// fail again and raise this same card on top of the answer.
		const connectionId = n.source === 'connection' ? undefined : n.connectionId;
		if (n.sql) {
			setFixRequest({ nonce: Date.now(), sql: n.sql, error: n.detail ?? n.title, connectionId });
		} else {
			setFixRequest({ nonce: Date.now(), sql: '', error: n.detail ?? n.title, connectionId, prompt: buildErrorHelpPrompt(n.title, n.detail ?? '') });
		}
	}, []);

	const openNotifications = useCallback((): void => {
		setNotifOpen(true);
		setToast(null);
		markNotificationsRead();
	}, []);

	// Resolve which result tab a run lands in: reuse the active tab whenever it isn't pinned (no
	// matter the connection/database), otherwise open a fresh one. `newTab` (the "Run in new tab"
	// button) always opens a fresh one. The title is set only at creation so a rename sticks.
	const resolveResultTarget = useCallback((newTab: boolean, label: string): string => {
		// A run always shows its result: the pane starts closed for a new user, and one the user
		// collapsed would otherwise hide what they just asked for.
		setLayout((l) => (l.resultsCollapsed ? { ...l, resultsCollapsed: false } : l));
		const cur = resultTabsRef.current.find((t) => t.id === activeResultIdRef.current) ?? null;
		// Reuse the active result tab only when it isn't mid-run: routing a new run into a busy tab
		// would clobber its in-flight result, so a run started while the current tab is working
		// transparently opens a fresh tab and runs there concurrently.
		if (!newTab && cur && !cur.pinned && !runningTargetsRef.current.has(cur.id)) {
			return cur.id;
		}
		resultSeq.current += 1;
		const id = `result-${resultSeq.current}`;
		setResultTabs((prev) => [...prev, {
			id, title: label, pinned: false, connectionId: undefined, connectionLabel: label,
			response: null, appliedLimit: undefined, lastSql: '', lastRawSql: '', totalCount: null, ranAt: 0,
			surface: 'sql',
		}]);
		setActiveResultId(id);
		return id;
	}, []);

	// Make sure there's a live connection to run against: select-check + connect-on-demand (the
	// explicit run intent sets the grid spinner). Returns false when there's nothing to run against,
	// or the user switched connections mid-connect (a tunnelled connect takes seconds). Shared by
	// run() (editor buffer) and runProposedSql() (the chat "Run" button).
	const ensureRunnableConnection = useCallback(async (): Promise<boolean> => {
		if (!activeId) {
			setStatus('Select a connection to run a query.', 'danger');
			return false;
		}
		if (!activeConnected) {
			const target = activeId;
			setConnecting(true);
			const ok = await connect(target).finally(() => setConnecting(false));
			if (!ok || activeIdRef.current !== target) {
				return false;
			}
		}
		return true;
	}, [activeId, activeConnected, connect]);

	// Decide whether this run can be opened as a keyset sequence, and if so return the statement to
	// run in its place. Only capped runs qualify: an uncapped statement returns
	// everything, so there is no next window to make cheap. The rewrite adds an ORDER BY the author
	// didn't write, which is the deliberate trade the doc calls out (open decision 2) — a browse gets
	// a defined order instead of the engine's incidental one, and that defined order is what makes
	// every later window exact rather than "probably disjoint".
	const openKeysetSequence = useCallback((raw: string, limit: number | undefined, driver: string | undefined): { sql: string; keyset: KeysetSequence } | null => {
		if (!limit) {
			return null;
		}
		const shape = browseShape(raw);
		if (!shape) {
			return null;
		}
		const tables = activeSchemaRef.current?.tables ?? [];
		const wanted = shape.table.toLowerCase();
		const qualifier = shape.schema?.toLowerCase();
		const candidates = tables.filter((t) => t.name.toLowerCase() === wanted && (!qualifier || t.schema?.toLowerCase() === qualifier));
		// An ambiguous name (same table in two schemas, unqualified) could resolve to the wrong
		// table's key, so require exactly one match.
		const key = candidates.length === 1 ? keysetKeyFor(candidates[0]) : null;
		if (!key) {
			return null;
		}
		return {
			sql: keysetSelect({ select: shape.select, conditions: shape.conditions, key, limit }, driver),
			keyset: { key, select: shape.select, conditions: shape.conditions },
		};
	}, []);

	// Run a raw SQL string through the same guards as the editor's run() (auto-LIMIT, read-only
	// block, prod confirm) and land it in a result tab. Shared by run() (the editor buffer) and the
	// chat "Run" button (the AI's proposed SQL). Assumes a live connection — callers gate first via
	// ensureRunnableConnection.
	const runSqlGuarded = useCallback(async (raw: string, opts?: { newTab?: boolean; chatRunId?: string; parametersBound?: boolean }): Promise<void> => {
		const chatRunId = opts?.chatRunId;
		// Named placeholders the server binds (`{id:UInt32}`): ask for their values first. They are
		// bound once on the connection, so the next page, EXPLAIN and a re-run all see them.
		const parameters = opts?.parametersBound ? [] : dialectFor(activeConfig?.driver).queryParameters?.(raw) ?? [];
		if (parameters.length > 0) {
			setPendingParams({ raw, newTab: opts?.newTab ?? false, chatRunId, parameters });
			return;
		}
		const capped = withAutoLimit(raw, appSettings, activeConfig?.driver);
		// (withAutoLimit only ever appends a row cap, so a changed string ⇒ a LIMIT/TOP was applied.)
		const limit = capped !== raw ? appSettings.defaultLimit : undefined;
		const sequence = openKeysetSequence(raw, limit, activeConfig?.driver);
		const sql = sequence?.sql ?? capped;
		// Read-only connections: hard-block destructive statements before they leave the renderer
		// (before allocating a result tab, so a blocked run leaves the pane untouched).
		if (activeConfig?.readOnly) {
			const destructive = destructiveStatement(sql, activeConfig.driver);
			if (destructive) {
				const message = `Connection is read-only, so ${destructive.verb} is blocked.`;
				setStatus(message, 'danger');
				if (chatRunId) {
					setChatRunOutcome({ runId: chatRunId, status: 'blocked', message });
				}
				return;
			}
		}
		const label = activeConfig?.label ?? '?';
		const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		const targetId = resolveResultTarget(opts?.newTab ?? false, label);
		// Refresh the target (the live, non-pinned tab) with this run's title + metadata.
		patchResult(targetId, {
			title: `${label} · ${ts}`,
			connectionLabel: label,
			appliedLimit: limit,
			lastRawSql: raw, // the unlimited statement, for "Count total"
		});
		const destructive = activePolicy.confirmationFor(sql);
		if (destructive) {
			// Carry any statement hazards into the dialog. "This UPDATE has no WHERE" is a warning the
			// user has already accepted by writing the statement; "only this one column is assigned" is
			// news, so the dialog offers the corrected statement as its primary action.
			const hazards = statementHazards(sql);
			const corrected = applyHazardFixes(sql, hazards);
			setPendingRun({ sql, targetId, verb: destructive.verb, unfiltered: destructive.unfiltered, hazards, corrected: corrected === sql ? undefined : corrected, chatRunId });
			return;
		}
		// Pre-flight scan check: warn before a query the planner says will scan a huge
		// number of rows. On a warn, hold the run behind a confirm; either way the plan's advisories
		// ride into executeSql so the post-run advisor reuses them (no second EXPLAIN).
		const connId = activeId;
		const pre = connId ? await runPreflightScan(sql, connId) : null;
		if (pre?.warn) {
			setPendingPreflight({ sql, targetId, rows: pre.rows ?? 0, table: pre.table, advisories: pre.advisories, keyset: sequence?.keyset, plainSql: capped, chatRunId });
			return;
		}
		await executeSql(sql, targetId, { preAdvisories: pre?.advisories, keyset: sequence?.keyset, plainSql: capped, chatRunId });
	}, [appSettings, activeConfig, activeId, resolveResultTarget, patchResult, executeSql, runPreflightScan, openKeysetSequence]);

	// The chat "Run" button: run the AI's proposed SQL through the same guards as the editor, landing
	// the rows in a result tab. The SQL stays visible in chat; this is an explicit user click (never
	// silent auto-run), so the prod-confirm / read-only guards in runSqlGuarded still apply. `runId`
	// tags the click so the chat gets a deterministic answer once the run settles, however it ends.
	const runProposedSql = useCallback(async (sql: string, runId: string): Promise<void> => {
		if (!(await ensureRunnableConnection())) {
			setChatRunOutcome({
				runId,
				status: 'blocked',
				message: activeIdRef.current ? "Couldn't connect, so nothing ran." : "Select a connection to run a query.",
			});
			return;
		}
		await runSqlGuarded(sql, { newTab: false, chatRunId: runId });
	}, [ensureRunnableConnection, runSqlGuarded]);

	const run = useCallback(async (opts?: { newTab?: boolean }): Promise<void> => {
		if (!(await ensureRunnableConnection())) {
			return;
		}
		// Native pipeline surface (Mongo): build a NativeQuery from the JSON buffer + target
		// collection and dispatch it directly, instead of the SQL statement-at-cursor path.
		if (activeTab?.surface === 'native') {
			const buffer = modelsRef.current.get(activeTab.id)?.getValue() ?? '';
			const collection = activeTab.collection;
			if (!collection) {
				setStatus('Pick a collection for the pipeline.', 'danger');
				return;
			}
			let pipeline: object[];
			try {
				pipeline = parsePipeline(buffer);
			} catch (err) {
				setStatus(errorMessage(err), 'danger');
				return;
			}
			const native: NativeQuery = { lang: 'mongo', collection, pipeline };
			const profile = profileFor(backendKindForDriver(activeConfig?.driver));
			const writes = profile.isDestructive(native, activeConfig?.driver);
			if (activeConfig?.readOnly && writes) {
				setStatus('Connection is read-only, so this pipeline (it writes data) is blocked.', 'danger');
				return;
			}
			const label = activeConfig?.label ?? '?';
			const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
			const targetId = resolveResultTarget(opts?.newTab ?? false, label);
			const display = `db.${collection}.aggregate(${buffer.trim()})`;
			// The document surface gets the same auto-LIMIT the SQL surface gets: a read pipeline with
			// no `$limit` of its own is capped at the default window, so a pipeline can't pull a whole
			// collection into the grid and "Next" can fetch the window after it. A pipeline that caps
			// itself (the template's `$limit`, the find bar) or writes is returned unwindowed (null).
			const capped = appSettings.autoLimit ? windowQuery(native, { limit: appSettings.defaultLimit, offset: 0 }) : null;
			patchResult(targetId, {
				title: `${label} · ${ts}`, connectionLabel: label, lastRawSql: display,
				appliedLimit: capped ? appSettings.defaultLimit : undefined,
			});
			if (activePolicy.confirmsWrites() && writes) {
				setPendingNativeRun({ native, display, targetId });
				return;
			}
			await executeNativeQuery(capped ?? native, display, targetId, native);
			return;
		}
		const raw = currentSql();
		if (!raw) {
			return;
		}
		await runSqlGuarded(raw, { newTab: opts?.newTab ?? false });
	}, [activeConfig, activeTab, executeNativeQuery, appSettings, resolveResultTarget, patchResult, ensureRunnableConnection, runSqlGuarded]);

	/** Run a find-shaped pipeline from the find bar against a collection. A
	 *  find is always read-only (no `$out`/`$merge`), so it skips the prod-write confirm the pipeline
	 *  run path applies. */
	const runFind = useCallback(async (collection: string, pipeline: object[]): Promise<void> => {
		if (!(await ensureRunnableConnection())) {
			return;
		}
		const native: NativeQuery = { lang: 'mongo', collection, pipeline };
		const label = activeConfig?.label ?? '?';
		const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		const targetId = resolveResultTarget(false, label);
		const display = `db.${collection}.aggregate(${JSON.stringify(pipeline)})`;
		patchResult(targetId, { title: `${label} · ${ts}`, connectionLabel: label, appliedLimit: undefined, lastRawSql: display });
		await executeNativeQuery(native, display, targetId);
	}, [ensureRunnableConnection, activeConfig, resolveResultTarget, patchResult, executeNativeQuery]);

	/** Explain the active native tab's pipeline: run it with the explain flag
	 *  and show the query plan in the grid (nested, so the tree viewer expands it; the chat can then
	 *  reason about it via ambient context to advise on indexes/rewrites). Read-only. */
	const runExplain = useCallback(async (): Promise<void> => {
		const tab = activeTab;
		const collection = tab?.collection;
		if (!tab || !collection) {
			setStatus('Pick a collection to explain.', 'danger');
			return;
		}
		let pipeline: object[];
		try {
			pipeline = parsePipeline(modelsRef.current.get(tab.id)?.getValue() ?? '');
		} catch (err) {
			setStatus(errorMessage(err), 'danger');
			return;
		}
		if (!(await ensureRunnableConnection())) {
			return;
		}
		const native: NativeQuery = { lang: 'mongo', collection, pipeline, explain: true };
		const label = activeConfig?.label ?? '?';
		const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		const targetId = resolveResultTarget(false, label);
		const display = `db.${collection}.aggregate(${JSON.stringify(pipeline)}).explain()`;
		patchResult(targetId, { title: `${label} · explain · ${ts}`, connectionLabel: label, appliedLimit: undefined, lastRawSql: display });
		await executeNativeQuery(native, display, targetId);
	}, [activeTab, activeConfig, ensureRunnableConnection, resolveResultTarget, patchResult, executeNativeQuery]);

	/** Open the visual staged-pipeline builder, seeded from the active native tab's pipeline buffer.
	 *  A buffer that doesn't parse seeds an empty builder (the user is here to compose/fix it). */
	function openPipelineBuilder(): void {
		const tabId = activeTabIdRef.current;
		const buffer = tabId ? (modelsRef.current.get(tabId)?.getValue() ?? '') : '';
		let pipeline: object[] = [];
		try {
			pipeline = parsePipeline(buffer);
		} catch {
			pipeline = [];
		}
		setBuilderInitial(pipeline);
	}

	/** Write a pipeline back to the active native tab's editor as pretty JSON (the builder's Apply). */
	function applyPipelineToEditor(pipeline: object[]): void {
		const tabId = activeTabIdRef.current;
		const model = tabId ? modelsRef.current.get(tabId) : undefined;
		if (model) {
			model.setValue(`${JSON.stringify(pipeline, null, '\t')}\n`);
		}
	}

	// Patch one step of the script log on the given result tab (immutable, leaves other tabs/steps).
	const patchScriptStep = useCallback((id: string, index: number, partial: Partial<ScriptRun['steps'][number]>): void => {
		setResultTabs((prev) => prev.map((t) => {
			if (t.id !== id || !t.script) {
				return t;
			}
			const steps = t.script.steps.map((s, i) => (i === index ? { ...s, ...partial } : s));
			return { ...t, script: { ...t.script, steps } };
		}));
	}, []);

	// Run a "Run script": every statement in `statements`, one at a time, into the script-log tab
	// `targetId`. Continue-on-error (a failed statement is logged, the rest still run) and NO
	// surrounding transaction. The last successful result set also lands in `response` so the grid
	// can show it. Cancel (cancelScriptRef / the Cancel button) stops between statements.
	const executeScriptSteps = useCallback(async (targetId: string, spans: StatementSpan[], sourceModel: monaco.editor.ITextModel | null): Promise<void> => {
		if (!activeId) {
			return;
		}
		cancelScriptRef.current = false;
		scriptRunningRef.current = true;
		startRunning(targetId, activeId);
		setStatus('');
		// Mark the statement currently running in the editor: a red ">" in the glyph margin plus a
		// whole-line highlight, scrolled into view. Only when the editor still shows the script's own
		// buffer (the user may have switched tabs). glyphMargin is normally off (tight gutter), so we
		// turn it on for the run and back off in the finally below.
		const editor = editorRef.current;
		const model = sourceModel && !sourceModel.isDisposed() ? sourceModel : null;
		const decorations = model ? editor?.createDecorationsCollection() : undefined;
		if (model && editor && editor.getModel() === model) {
			editor.updateOptions({ glyphMargin: true });
		}
		const markStatement = (index: number): void => {
			// Only paint when the editor still shows the script's own buffer; the decorations
			// collection is editor-bound, so writing it while another tab is showing would mark
			// the wrong model.
			if (!model || !decorations || !editor || editor.getModel() !== model) {
				return;
			}
			const span = spans[index];
			if (!span) {
				decorations.clear();
				return;
			}
			const startPos = model.getPositionAt(span.start);
			const endPos = model.getPositionAt(span.end);
			decorations.set([{
				range: new monaco.Range(startPos.lineNumber, 1, endPos.lineNumber, 1),
				options: {
					isWholeLine: true,
					className: 'script-running-line',
					glyphMarginClassName: 'script-running-glyph',
				},
			}]);
			editor.revealRangeInCenterIfOutsideViewport(new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column));
		};
		let okCount = 0;
		let errorCount = 0;
		let lastOk: ExecuteQueryResult | null = null;
		let cancelled = false;
		for (let i = 0; i < spans.length; i++) {
			if (cancelScriptRef.current) {
				cancelled = true;
				break;
			}
			setResultTabs((prev) => prev.map((t) => (t.id === targetId && t.script ? { ...t, script: { ...t.script, current: i } } : t)));
			patchScriptStep(targetId, i, { status: 'running' });
			markStatement(i);
			const sql = spans[i].sql;
			// Read-only connection: log the block and move on (non-destructive statements still run).
			if (activeConfig?.readOnly) {
				const destructive = destructiveStatement(sql, activeConfig.driver);
				if (destructive) {
					patchScriptStep(targetId, i, { status: 'error', error: `Connection is read-only, so ${destructive.verb} is blocked.` });
					errorCount += 1;
					continue;
				}
			}
			const started = Date.now();
			try {
				const result = await window.sqlApi.execute({ connectionId: activeId, sql });
				const durationMs = Date.now() - started;
				if (!result.ok && result.cancelled) {
					cancelled = true;
					patchScriptStep(targetId, i, { status: 'skipped' });
					break;
				}
				if (result.ok) {
					okCount += 1;
					lastOk = result;
					patchScriptStep(targetId, i, { status: 'ok', rowCount: result.result.rowCount, durationMs });
				} else {
					errorCount += 1;
					patchScriptStep(targetId, i, { status: 'error', error: result.error, durationMs });
				}
			} catch (err) {
				errorCount += 1;
				patchScriptStep(targetId, i, { status: 'error', error: errorMessage(err), durationMs: Date.now() - started });
			}
		}
		// Clear the editor markers and restore the tight gutter now the run is over (unconditional:
		// the user may have switched tabs, but it's the same editor instance either way).
		decorations?.clear();
		editor?.updateOptions({ glyphMargin: false });
		// Finalize: mark any not-yet-run steps as skipped (cancel), drop the running marker, and show
		// the last successful result in the grid alongside the log.
		setResultTabs((prev) => prev.map((t) => {
			if (t.id !== targetId || !t.script) {
				return t;
			}
			const steps = cancelled ? t.script.steps.map((s) => (s.status === 'pending' ? { ...s, status: 'skipped' as const } : s)) : t.script.steps;
			return { ...t, script: { ...t.script, steps, current: -1, finishedAt: Date.now() }, response: lastOk ?? t.response, connectionId: activeId, ranAt: Date.now() };
		}));
		stopRunning(targetId);
		scriptRunningRef.current = false;
		if (okCount > 0) {
			markTask('run');
		}
		setStatus(cancelled ? `Script cancelled: ${okCount} ok, ${errorCount} failed.` : `Script done: ${okCount} ok, ${errorCount} failed.`, errorCount > 0 ? 'danger' : 'info');
	}, [activeId, activeConfig, markTask, patchScriptStep, setStatus, startRunning, stopRunning]);

	// "Run script" entry: split the whole editor buffer into statements and run them sequentially.
	// Mirrors run()'s connect-first + prod-confirm guards, but the read-only block is per-statement
	// (inside the loop) so a script of mostly-SELECTs still runs.
	const runAllStatements = useCallback(async (opts?: { newTab?: boolean }): Promise<void> => {
		if (scriptRunningRef.current) {
			return;
		}
		// A native pipeline tab has no SQL statements to split — "Run script" just runs the pipeline.
		if (activeTab?.surface === 'native') {
			await run(opts);
			return;
		}
		if (!activeId) {
			setStatus('Select a connection to run a query.', 'danger');
			return;
		}
		if (!activeConnected) {
			const target = activeId;
			setConnecting(true);
			const ok = await connect(target).finally(() => setConnecting(false));
			if (!ok || activeIdRef.current !== target) {
				return;
			}
		}
		const sourceModel = editorRef.current?.getModel() ?? null;
		const buffer = sourceModel?.getValue() ?? '';
		const spans = splitStatementSpans(buffer);
		if (spans.length === 0) {
			setStatus('Nothing to run.');
			return;
		}
		const label = activeConfig?.label ?? '?';
		const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		const targetId = resolveResultTarget(opts?.newTab ?? false, label);
		patchResult(targetId, {
			title: `Script · ${ts}`,
			connectionLabel: label,
			appliedLimit: undefined,
			lastRawSql: buffer,
			lastSql: '',
			response: null,
			totalCount: null,
			keyset: undefined, // a reused tab must not carry a previous run's paging sequence
			explain: undefined,
			script: { steps: spans.map((s) => ({ sql: s.sql, status: 'pending' as const })), startedAt: Date.now(), current: -1 },
		});
		// Prod safety: a single confirm gates the whole script when any statement is destructive.
		const destructive = spans.map((s) => activePolicy.confirmationFor(s.sql)).find(Boolean);
		if (destructive) {
			setPendingScriptRun({ targetId, spans, model: sourceModel });
			return;
		}
		await executeScriptSteps(targetId, spans, sourceModel);
	}, [activeId, activeConnected, activeConfig, activeTab, run, appSettings, connect, resolveResultTarget, patchResult, executeScriptSteps, setStatus]);

	/**
	 * Explain the statement at the cursor.
	 *
	 * The plan lands in a RESULT TAB beside the rows, because it is about the statement that is
	 * about to run. Only a read is ever explained: on some engines `EXPLAIN <write statement>`
	 * plans the write for real, so the gate is the same one the pre-flight scan uses.
	 */
	async function explainStatement(): Promise<void> {
		const dialect = dialectFor(activeConfig?.driver);
		const variants = dialect.explainVariants;
		if (!variants || variants.length === 0) {
			setStatus(`${dialect.displayName} has one plan form, which the query advisor already reads for you.`, 'danger');
			return;
		}
		const sql = currentSql();
		if (!sql) {
			return;
		}
		if (!/^\s*(select|with)\b/i.test(sql)) {
			setStatus('Only a SELECT can be explained.', 'danger');
			return;
		}
		if (!(await ensureRunnableConnection())) {
			return;
		}
		const connectionId = activeIdRef.current;
		if (!connectionId) {
			return;
		}
		const label = activeConfig?.label ?? '?';
		const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		const targetId = resolveResultTarget(false, label);
		patchResult(targetId, {
			title: `Explain · ${ts}`,
			connectionId,
			connectionLabel: label,
			appliedLimit: undefined,
			lastSql: sql,
			lastRawSql: sql,
			response: null,
			totalCount: null,
			advisories: undefined,
			keyset: undefined,
			script: undefined,
			explain: { connectionId, connectionLabel: label, sql, variants, nonce: Date.now() },
		});
	}

	/** The live schema's row count for a table a plan names, which is what turns the estimate's
	 *  "rows it would read" into a share of the table. Only for the connection whose schema is
	 *  loaded, and absent is normal rather than an error. */
	function explainTableRows(connectionId: string, database: string, table: string): number | undefined {
		if (activeIdRef.current !== connectionId) {
			return undefined;
		}
		const found = (activeSchemaRef.current?.tables ?? []).filter((t) => t.name === table && (database === '' || !t.schema || t.schema === database));
		return found.length === 1 ? found[0].stats?.rowCount : undefined;
	}

	// Cancel the in-flight run. The driver issues a server-side cancel, so the execute
	// promise settles as cancelled and executeSql's finally clears `running`.
	const cancelRun = useCallback(async (): Promise<void> => {
		// Cancel the query behind the tab being viewed: the connection it's running on (tracked per
		// in-flight run) so switching connections mid-run still cancels the right one. If two tabs
		// share one connection, the driver cancels its current query on that connection (it can't
		// target one of several) — a known limit until per-statement cancel handles are threaded.
		const conn = (activeResultId !== null && runConnsRef.current.get(activeResultId)) || activeId;
		if (!conn) {
			return;
		}
		if (activeResult?.script) {
			cancelScriptRef.current = true; // stop this "Run script" loop between statements
		}
		setStatus('Cancelling…');
		await window.sqlApi.cancelQuery(conn).catch(() => undefined);
	}, [activeResultId, activeResult, activeId, setStatus]);

	/**
	 * Swap one statement for another IN PLACE in the editor, leaving the rest of the buffer alone.
	 *
	 * Matched by TEXT rather than by the caret: the statement being replaced is the one a result tab
	 * ran, and the caret has usually moved on (or is in another tab) by the time the results pane
	 * offers to change it. No match means the user has edited or closed it since, and the right
	 * answer is then to touch nothing — the run still happens, it just isn't mirrored in a buffer
	 * whose contents no longer say what ran.
	 */
	const replaceStatementInEditor = useCallback((previous: string, next: string): void => {
		const editor = editorRef.current;
		const model = editor?.getModel();
		if (!editor || !model) {
			return;
		}
		const span = splitStatementSpans(model.getValue()).find((one) => one.sql === previous);
		if (!span) {
			return;
		}
		const from = model.getPositionAt(span.start);
		const to = model.getPositionAt(span.end);
		editor.executeEdits('log-range', [{ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: next, forceMoveMarkers: true }]);
	}, []);

	/**
	 * The time range behind a TELEMETRY result, and the way to ask for another one.
	 *
	 * A log query is always bounded, and a statement that names no bound gets the last hour from
	 * the compiler. The driver reports which of the two happened on every result, and this is what
	 * carries it to the footer: without it an empty grid says "there is nothing" when the truth is
	 * "there is nothing in an hour nobody chose".
	 *
	 * Asking for another range REWRITES THE STATEMENT — `… WHERE ts >= ago('6h')` goes into the
	 * editor, and the run that follows is an ordinary run of the SQL now on the screen. A window
	 * held on the side instead would mean a result nobody can reproduce by reading their own query,
	 * and a second click would widen a range the statement still does not mention. The invisible
	 * window survives only as the fallback for a statement `withLogTimeBound` will not touch (a
	 * bound somebody else wrote, a comment, more than one statement), where editing blind is worse.
	 */
	const logWindow = useMemo(() => {
		const cost = response?.ok ? response.result.cost : undefined;
		if (!cost?.window) {
			return undefined;
		}
		const target = activeResultId;
		// Any span answers "can this statement be rewritten at all": the refusals are about the SQL's
		// shape, never about how far back the user asked to look.
		const editsSql = !!lastRawSql && withLogTimeBound(lastRawSql, DEFAULT_LOG_WINDOW_MS) !== null;
		// A range the statement chose is normally the control's business to leave alone — unless it is
		// a range this control WROTE, which it can move again.
		const canRerun = !!target && !!lastSql && activeConnected && (!cost.windowFromSql || editsSql);
		return {
			start: cost.window.start,
			end: cost.window.end,
			fromSql: cost.windowFromSql === true,
			editsSql,
			onRerun: canRerun
				? (ms: number) => {
					const rewritten = editsSql ? withLogTimeBound(lastRawSql, ms) : null;
					if (!rewritten) {
						const end = Date.now();
						void executeSql(lastSql, target, { window: { start: end - ms, end } });
						return;
					}
					replaceStatementInEditor(lastRawSql, rewritten);
					// The same auto-LIMIT bookkeeping a run from the editor does, so the footer's row cap
					// and "Count total" keep describing the statement that actually ran.
					const capped = withAutoLimit(rewritten, appSettings, activeConfig?.driver);
					patchResult(target, { lastRawSql: rewritten, appliedLimit: capped === rewritten ? undefined : appSettings.defaultLimit });
					void executeSql(capped, target);
				}
				: undefined,
		};
	}, [response, activeResultId, lastSql, lastRawSql, activeConnected, executeSql, replaceStatementInEditor, appSettings, activeConfig, patchResult]);

	// Reconnect the active tab's connection and replay the last query — surfaced by the
	// results pane as a one-click recovery when an error reads like a dropped socket
	// (heartbeat lag, NLB cull, wait_timeout) so the user doesn't have to find the
	// sidebar's Connect button + Run again.
	const reconnectAndRetry = useCallback(async (): Promise<void> => {
		if (!activeId) {
			return;
		}
		setStatus('Reconnecting…');
		try {
			await window.sqlApi.connect(activeId);
		} catch (err) {
			setStatus('');
			notifyError("Reconnect failed", errorMessage(err), { source: 'connection', connectionId: activeId });
			return;
		}
		// Replay the same query that just failed into the same result tab (the auto-LIMITed SQL the
		// grid is showing, or the native query for a pipeline result).
		if (activeResult?.surface === 'native' && activeResult.nativeQuery && activeResultId) {
			await executeNativeQuery(activeResult.nativeQuery, activeResult.lastSql, activeResultId);
		} else if (lastSql && activeResultId) {
			// Carry the keyset sequence across the replay. `lastSql` IS this sequence's first window,
			// so re-running it reproduces page 1 exactly — but dropping the descriptor would leave the
			// tab holding key-ordered rows while "Next" fell back to an unordered OFFSET window, which
			// is precisely the mismatch that repeats or skips rows.
			await executeSql(lastSql, activeResultId, { keyset: activeResult?.keyset });
		} else {
			setStatus('Reconnected.');
		}
	}, [activeId, lastSql, activeResult, activeResultId, executeSql, executeNativeQuery, setStatus]);

	// Tick the elapsed-time readout for the ACTIVE tab's run. Keyed off its recorded start (not a
	// fresh Date.now()) so switching to a tab mid-run shows its true elapsed, not a reset clock.
	useEffect(() => {
		if (!running || activeResultId === null) {
			setElapsedMs(0);
			return;
		}
		const target = activeResultId;
		const tick = (): void => setElapsedMs(Date.now() - (runStartsRef.current.get(target) ?? Date.now()));
		tick();
		const timer = setInterval(tick, 100);
		return () => clearInterval(timer);
	}, [running, activeResultId]);

	// Poll the ACTIVE tab's run for its progress once a second. Nothing is asked before the first
	// second (most queries are done by then), and a driver that cannot say answers null for free.
	useEffect(() => {
		setRunProgress(null);
		if (!running || activeResultId === null) {
			return;
		}
		const connectionId = runConnsRef.current.get(activeResultId);
		if (!connectionId) {
			return;
		}
		let alive = true;
		const timer = setInterval(() => {
			void window.sqlApi.queryProgress(connectionId).then((progress) => {
				if (alive && progress) {
					setRunProgress(progress);
				}
			}).catch(() => undefined);
		}, 1000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [running, activeResultId]);

	// Count the true total for the last run, ignoring the auto-LIMIT, by wrapping the raw
	// statement as a subquery. Run on demand (the footer button) — never on every query.
	const countTotal = useCallback(async (): Promise<void> => {
		if (!activeId || !activeConnected || !lastRawSql) {
			return;
		}
		const targetId = activeResultIdRef.current;
		setCountingTotal(true);
		try {
			const sql = countingSql(lastRawSql, backendKindForDriver(activeConfig?.driver));
			if (!sql) {
				return;
			}
			const res = await window.sqlApi.execute({ connectionId: activeId, sql });
			if (res.ok && res.result.rows.length > 0 && targetId) {
				patchResult(targetId, { totalCount: Number(res.result.rows[0][0]) });
			} else if (res.ok) {
				setStatus('Count returned no rows.');
			} else {
				setStatus('');
				notifyError("Count failed", res.error, { source: 'query', connectionId: activeId });
			}
		} catch (err) {
			setStatus('');
			notifyError("Count failed", errorMessage(err), { source: 'query', connectionId: activeId });
		} finally {
			setCountingTotal(false);
		}
	}, [activeId, activeConnected, activeConfig?.driver, lastRawSql, patchResult, setStatus]);

	// "Next" past the last loaded row: re-run the SAME query one window further in and APPEND the
	// rows to this result tab, so a user who hit the auto-LIMIT keeps paging instead of rewriting
	// their statement. The window is built by the engine (`windowQuery`), which also decides whether
	// a query can be paged at all: SQL gets LIMIT/OFFSET (or TOP / OFFSET..FETCH per dialect), a
	// Mongo pipeline gets $skip/$limit, a Pinecone query gets nothing (opaque cursor).
	//
	// Returns how many rows arrived and whether more are likely. A SHORT read (fewer rows than the
	// window asked for) is a free end-of-data signal, so only an exactly-full final window costs the
	// one empty round-trip that retires the button. Windows are shallow OFFSET paging: without a
	// total ordering they aren't guaranteed disjoint.
	const fetchMore = useCallback(async (): Promise<{ added: number; more: boolean }> => {
		const targetId = activeResultIdRef.current;
		const tab = resultTabsRef.current.find((t) => t.id === targetId) ?? null;
		const limit = tab?.appliedLimit;
		const connId = activeIdRef.current;
		if (!tab || !targetId || !limit || !connId || !tab.response?.ok) {
			return { added: 0, more: false };
		}
		// Only the connection that produced these rows may extend them. The button is already gated on
		// this, but the user can switch connections between the render and the click.
		if (tab.connectionId && tab.connectionId !== connId) {
			return { added: 0, more: false };
		}
		const previous = tab.response;
		const driver = connectionsRef.current.find((c) => c.id === connId)?.driver;
		// Keyset sequence: seek past the last row already loaded. Flat cost at any depth, and exact —
		// the whole sequence shares the ordering its first window was fetched in. The seek position is
		// READ OFF the loaded rows rather than tracked alongside them, so it cannot drift out of step
		// with what the grid is showing. Everything else falls through to the OFFSET window below.
		const sequence = tab.keyset;
		const cursor = sequence ? keysetCursorFor(sequence, previous.result, driver) : undefined;
		const next: NativeQuery | null = sequence
			? (cursor ? { lang: 'sql', sql: keysetSelect({ select: sequence.select, conditions: sequence.conditions, key: sequence.key, after: cursor, limit }, driver) } : null)
			: (() => {
				const authored: NativeQuery | null = tab.surface === 'native'
					? tab.rawNativeQuery ?? null
					: tab.lastRawSql ? { lang: 'sql', sql: tab.lastRawSql } : null;
				return authored ? windowQuery(authored, { limit, offset: previous.result.rows.length }, driver) : null;
			})();
		if (!next) {
			return { added: 0, more: false };
		}
		startRunning(targetId, connId);
		try {
			const res = await window.sqlApi.execute(next.lang === 'sql'
				? { connectionId: connId, sql: next.sql, allowAiTranscribe: appSettingsRef.current.aiAutoTranscribe }
				: { connectionId: connId, native: next });
			if (!res.ok) {
				if (!res.cancelled) {
					notifyError("Fetch more failed", res.error, { source: 'query', connectionId: connId, sql: next.lang === 'sql' ? next.sql : undefined });
				}
				// Leave the button live so the user can retry; nothing in the grid changed.
				return { added: 0, more: true };
			}
			// The tab was re-run (or reloaded) while this window was in flight: drop it rather than
			// stitch rows onto a result they no longer belong to.
			const current = resultTabsRef.current.find((t) => t.id === targetId);
			if (!current || current.response !== previous) {
				return { added: 0, more: false };
			}
			// Rows are positional, so a window whose shape doesn't match would garble the grid rather
			// than extend it (a DDL change between windows is the realistic way this happens).
			if (res.result.fields.length !== previous.result.fields.length) {
				notifyError("Fetch more failed", "The next rows came back with a different set of columns, so they weren't added. Re-run the query.", { source: 'query', connectionId: connId });
				return { added: 0, more: false };
			}
			const added = res.result.rows.length;
			if (added > 0) {
				patchResult(targetId, {
					response: { ok: true, result: {
						fields: previous.result.fields,
						rows: [...previous.result.rows, ...res.result.rows],
						rowCount: previous.result.rowCount + res.result.rowCount,
						// Cumulative: the footer's "ms" then reads as the time spent fetching these rows.
						durationMs: previous.result.durationMs + res.result.durationMs,
					} },
				});
			}
			return { added, more: added >= limit };
		} catch (err) {
			notifyError("Fetch more failed", errorMessage(err), { source: 'query', connectionId: connId });
			return { added: 0, more: true };
		} finally {
			stopRunning(targetId);
		}
	}, [patchResult, startRunning, stopRunning]);

	// Whether this result can be paged past its cap at all. The engine's `windowQuery` is the single
	// authority (a Pinecone result can't — opaque cursor; nor can a write or a self-capped statement),
	// so the paginator asks it here rather than re-deriving the rule from the driver id.
	const canFetchMore = useMemo((): boolean => {
		const limit = activeResult?.appliedLimit;
		if (!activeResult || !limit || !activeResult.response?.ok) {
			return false;
		}
		// Only the connection that produced the rows can extend them, and it has to be the live one.
		if ((activeResult.connectionId ?? activeId) !== activeId) {
			return false;
		}
		const driver = connectionsRef.current.find((c) => c.id === activeId)?.driver;
		// A keyset result pages as long as a seek position can be read off the rows on screen.
		if (activeResult.keyset) {
			return keysetCursorFor(activeResult.keyset, activeResult.response.result, driver) !== undefined;
		}
		const authored: NativeQuery | null = activeResult.surface === 'native'
			? activeResult.rawNativeQuery ?? null
			: activeResult.lastRawSql ? { lang: 'sql', sql: activeResult.lastRawSql } : null;
		return authored !== null && windowQuery(authored, { limit, offset: limit }, driver) !== null;
	}, [activeResult, activeId]);

	// App-level shortcuts: the global-scope keybindings (new/open/save/close/palette). Editor-scope
	// bindings (run/format/AI) are dispatched inside Monaco (see Editor.tsx). Reads the live
	// bindings + commands via refs, so a rebind takes effect with no listener re-attach.
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			for (const b of keybindingsRef.current) {
				if (b.scope !== 'global' || !matchesEvent(b.combo, e)) {
					continue;
				}
				e.preventDefault();
				if (b.id === 'commandPalette') {
					setPaletteOpen(true);
				} else {
					commandsRef.current.find((c) => c.id === b.id)?.run();
				}
				return;
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	const canRun = activeConnected && !running;
	// The Explain panel appears only where the engine has more than one EXPLAIN to pick between
	// (ClickHouse today); everywhere else the one plan is the query advisor's, read for the user.
	const canExplain = canRun && (dialectFor(activeConfig?.driver).explainVariants?.length ?? 0) > 0;
	// Document (Mongo) connections expose the SQL/Pipeline surface switch; the active tab's surface
	// drives the editor language + run path.
	const activeIsDocument = activeConfig !== undefined && backendKindForDriver(activeConfig.driver) === 'document';
	// Whether the connection that produced the CURRENT results is a document backend — gates the
	// results grid's per-row "View document" tree affordance. Keyed off the
	// result's own connection, not the active one, so a stale result never mislabels its rows.
	const resultConfig = resultConnectionId ? state.connections.find((c) => c.id === resultConnectionId) : undefined;
	const resultIsDocument = resultConfig !== undefined && backendKindForDriver(resultConfig.driver) === 'document';
	// …and whether it came from a cloud LOG service, which is what offers the results pane its log
	// reader instead of the grid. Decided by the BACKEND and not by the column names: a relational
	// table with a `ts` and a `message` is a table, and would open in the wrong instrument if the
	// shape alone were allowed to answer.
	const resultIsLogs = resultConfig !== undefined && backendKindForDriver(resultConfig.driver) === 'telemetry';
	// The log reader's "Surrounding events": a structured read of the same scope, against the
	// connection that produced the result, kept out of query history since nobody typed it.
	const runLogContext = useCallback<RunLogsQuery>(async (query) => {
		const outcome = await window.sqlApi.execute({ connectionId: resultConnectionId ?? '', native: { lang: 'logs', query }, recordHistory: false });
		if (!outcome.ok) {
			throw new Error(outcome.error);
		}
		return { fields: outcome.result.fields, rows: outcome.result.rows, truncated: outcome.result.cost?.truncated === true };
	}, [resultConnectionId]);
	const activeSurface: 'sql' | 'native' = activeTab?.surface === 'native' ? 'native' : 'sql';

	// The active tab may be a double-clicked table view rather than a SQL editor.
	const isTableTab = activeTab?.kind === 'table';
	const isObjectTab = activeTab?.kind === 'object';
	const isWorkloadTab = activeTab?.kind === 'workload';
	const isSecurityTab = activeTab?.kind === 'security';
	const isSchemaSyncTab = activeTab?.kind === 'schemaSync';
	const isReleaseNotesTab = activeTab?.kind === 'releaseNotes';
	const isMonitorTab = activeTab?.kind === 'monitor';
	const schemaSyncTab = tabs.find((t) => t.kind === 'schemaSync');
	const monitorTab = tabs.find((t) => t.kind === 'monitor');
	// Orbit stays MOUNTED while another tab is on screen (a WebGL context recreated on every tab
	// switch is worse than one kept alive) and its render loop is paused instead — see OrbitView.
	const isOrbitTab = activeTab?.kind === 'orbit';
	const isChOpsTab = activeTab?.kind === 'chOps';
	const isChRemoteTab = activeTab?.kind === 'chRemote';
	const isCloudProjectTab = activeTab?.kind === 'cloudProject';
	const isLocalTab = activeTab?.kind === 'localSetup' || activeTab?.kind === 'localProject' || activeTab?.kind === 'projectCopy';
	const projectCopyTabs = tabs.filter((t) => t.kind === 'projectCopy' && t.copySource);
	const orbitTab = tabs.find((t) => t.kind === 'orbit');
	// Orbit's own database picker. Built here so the rail can say which connection it drew and
	// point at another without Orbit knowing anything about how a connection is opened.
	const orbitConnections = useMemo(
		() => state.connections.map((c) => ({ ...c, connected: state.connectedIds.includes(c.id) })),
		[state.connections, state.connectedIds],
	);
	const isFlowTab = activeTab?.kind === 'flow';
	const flowTab = tabs.find((t) => t.kind === 'flow');
	const isMoveTab = activeTab?.kind === 'move';
	const moveTab = tabs.find((t) => t.kind === 'move');
	const isVectorSearchTab = activeTab?.kind === 'vectorSearch';
	const vectorSearchTab = tabs.find((t) => t.kind === 'vectorSearch');
	const isReviewTab = activeTab?.kind === 'review';
	const reviewTab = tabs.find((t) => t.kind === 'review');
	// What a coding agent has shown, when its console is docked at the bottom. One per agent.
	const isAgentTab = activeTab?.kind === 'agentView';
	const agentTabs = tabs.filter((t) => t.kind === 'agentView');
	const objectData = activeTabId && isObjectTab ? objectTabsRef.current.get(activeTabId) : undefined;
	const tableData = activeTabId ? tableTabsRef.current.get(activeTabId) : undefined;
	// The assistant header's grounding chip: named ONLY for surfaces the ambient context really
	// carries (flow wizard, table tab, object tab) — a chip on a tab the model can't see would
	// promise context that isn't there.
	const assistantContext = isFlowTab
		? "Data Flow wizard"
		: tableData?.table
			? `Table ${tableData.table.name}`
			: objectData
				? `${objectData.kind} ${objectData.name}`
				: undefined;
	const tableTabConn = tableData ? state.connections.find((c) => c.id === tableData.connectionId) : undefined;
	const tableTabProd = tableTabConn?.environment === 'prod';
	// The table tab may be a different connection than the active one, so it gets its own policy.
	const tableTabPolicy = policyFor(tableTabConn?.environment, { confirmDestructive: appSettings.confirmOnProd, allowGridActions: appSettings.allowProdGridActions || (tableTabConn !== undefined && prodUnlocked.has(tableTabConn.id)) }, tableTabConn?.driver);
	const tableTabReadOnly = tableTabConn?.readOnly === true;
	// Read-only tabs (table/object) can't switch connection, so instead of the run bar they show
	// a connection chip in the same top-toolbar slot. Resolve which connection the active
	// read-only view belongs to (the toolbar stays mounted either way, so the tab strip never
	// shifts vertically between SQL and non-SQL tabs).
	const isReadOnlyTab = isTableTab || isObjectTab || isWorkloadTab || isSecurityTab || isChOpsTab || isChRemoteTab || isCloudProjectTab || isLocalTab;
	const viewConnId = isTableTab ? tableData?.connectionId : isObjectTab ? objectData?.connectionId : isWorkloadTab || isSecurityTab || isChOpsTab || isChRemoteTab ? activeTab?.connectionId : undefined;
	const viewConn = viewConnId ? state.connections.find((c) => c.id === viewConnId) : undefined;

	// The connection the bottom status bar reflects: a read-only tab's owning connection, else
	// the active editor tab's. The cursor/language segment shows only while a SQL editor is up.
	const statusConn = isReadOnlyTab ? viewConn : activeConfig;
	const statusConnId = isReadOnlyTab ? viewConnId : activeId;
	const statusConnected = statusConnId !== undefined && state.connectedIds.includes(statusConnId);
	// Concurrent interactive runs on the status-bar connection, and its pool size, for the
	// "connections busy" hint: at or above the pool size the next query queues.
	const statusConnRunning = statusConnId !== undefined ? (runningByConn[statusConnId] ?? 0) : 0;
	const statusPoolMax = clampPoolMax(statusConn?.poolMax);
	const showEditorStatus = tabs.length > 0 && !isReadOnlyTab && !isSchemaSyncTab && !isMonitorTab && !isFlowTab && !isMoveTab && !isVectorSearchTab && !isAgentTab && !isReviewTab && !isOrbitTab;

	// The first-run spotlight tour. Anchors resolve to `data-tour="…"` elements; `onEnter`
	// makes sure the anchor exists (open the sidebar / chat) before the step is shown.
	// The words are Liby's (`TOUR_COPY`, @snout/liby/studio), or the app's own in a build without her.
	function tourCopy(id: TourStepId): Pick<TourStep, 'title' | 'body' | 'liby'> {
		const copy = TOUR_COPY[id];
		return { title: copy.title, body: copy.body, liby: copy.mood };
	}
	const tourSteps: TourStep[] = [
		{ ...tourCopy('welcome'), liby: undefined, placement: 'bottom', art: TOUR_COPY.welcome.mood ? <div className="liby tour-liby-hero" data-mood={TOUR_COPY.welcome.mood}><LibyArt /></div> : undefined },
		{ anchor: 'activity-bar', ...tourCopy('activity-bar'), placement: 'right', onEnter: () => showSideView('connections') },
		{ anchor: 'add-connection', ...tourCopy('add-connection'), placement: 'right', onEnter: () => showSideView('connections') },
		{ anchor: 'editor', ...tourCopy('editor'), placement: 'top' },
		{ anchor: 'run-button', ...tourCopy('run-button'), placement: 'bottom' },
		{ anchor: 'results', ...tourCopy('results'), placement: 'top' },
		{ anchor: 'ai-assistant', ...tourCopy('ai-assistant'), placement: 'left', onEnter: () => setChatOpen(true) },
	];

	// Live shortcut hint for a command id (formatted for the platform), or '' if unbound — so the
	// palette + menu hints follow a rebind instead of carrying hardcoded key strings.
	const hintFor = (id: string): string => {
		const combo = keybindings.find((b) => b.id === id)?.combo;
		return combo ? formatShortcut(combo) : '';
	};
	// Every tool this user actually has: the agents they installed, the Agent log only while agent
	// access is on. One list, so the palette and the pane header menus offer the same moves.
	const movableTools: ToolId[] = useMemo(() => [
		'connections' as ToolId, 'workspace' as ToolId, 'history' as ToolId, 'flows' as ToolId,
		...(mcpActive ? ['mcplog' as ToolId] : []),
		'assistant' as ToolId,
		...visibleAgents.map((a) => `agent:${a.kind}` as ToolId),
	], [mcpActive, visibleAgents]);
	const movePanelCommands: Command[] = useMemo(() => movableTools.flatMap((tool) =>
		DOCK_AREAS.filter((area) => area !== placementOf(layout.docks, tool)).map((area) => ({
			id: `move:${tool}:${area}`,
			label: `Move ${toolLabel(tool)} to ${areaLabel(area)}`,
			run: () => setDocks((d) => moveTool(d, tool, area)),
		}))
	), [movableTools, layout.docks, setDocks]);

	/**
	 * Liby's two views. Full is a view of the SAME instance (the panel is re-homed, never
	 * remounted), so opening it also opens the assistant, and leaving it puts the panel back in its
	 * dock, open, where the conversation carries on.
	 */
	function setAssistantFull(full: boolean): void {
		if (full && !fullChat) {
			// Seed Liby's own connection with a REAL one so the picker's selection and the grounding
			// agree (an undefined here makes the picker show nothing selected, and the send-time gate
			// never asks to connect): the editor's, else the one picked last time the full view was
			// open, else a connected one, else the first saved.
			const kept = fullChatConnId !== undefined && state.connections.some((c) => c.id === fullChatConnId) ? fullChatConnId : undefined;
			setFullChatConnId(activeId ?? kept ?? state.connectedIds[0] ?? state.connections[0]?.id);
		}
		setChatOpen(true);
		setFullChat(full);
	}

	/** The activity-bar icon and "Toggle Liby": docked show/hide; from the full view, back to the dock. */
	function toggleAssistant(): void {
		if (fullChat) {
			setAssistantFull(false);
			return;
		}
		setChatOpen((v) => !v);
	}

	const commands: Command[] = [
		{ id: 'new', label: 'New Query', hint: hintFor('new'), run: () => newQueryTab() },
		...(activeIsDocument ? [{ id: 'newPipeline', label: 'New Aggregation Pipeline (MongoDB)', run: () => { createPipelineTab(activeId, mongoCollectionNames()[0]); } }] : []),
		{ id: 'open', label: 'Open File…', hint: hintFor('open'), run: () => void openFile() },
		{ id: 'saveFile', label: 'Save File', hint: hintFor('saveFile'), run: () => void saveActiveFile() },
		{ id: 'saveQuery', label: 'Save Query…', run: () => void saveCurrentQuery() },
		{ id: 'run', label: 'Run Query', hint: hintFor('run'), run: () => void run() },
		{ id: 'runNewTab', label: 'Run in New Tab', run: () => void run({ newTab: true }) },
		{ id: 'runScript', label: 'Run as Script', run: () => void runAllStatements() },
		...(canExplain ? [{ id: 'explain', label: 'Explain Query Plan', run: () => void explainStatement() }] : []),
		{ id: 'format', label: 'Format SQL', hint: hintFor('format'), run: formatEditor },
		...(visibleAgents.length > 0 ? [
			{ id: 'agentConsole', label: 'Agent Console: Show/Hide', run: () => setDocks((d) => toggleTool(d, `agent:${consoleKind}`)) },
			{ id: 'agentConsoleRestart', label: 'Agent Console: Restart Agent', run: () => { setDocks((d) => showTool(d, `agent:${consoleKind}`)); void window.sqlApi.agentConsole.restart(consoleKind); } },
		] : []),
		{ id: 'connectionsView', label: 'Show Connections', run: () => showSideView('connections') },
		{ id: 'workspaceView', label: 'Show Workspace Files', run: () => showSideView('workspace') },
		{ id: 'newWorkspaceFile', label: 'New Workspace File', run: () => void newWorkspaceFile() },
		{ id: 'importWorkspaceFile', label: 'Import Files to Workspace…', run: () => setWorkspaceImport(true) },
		{ id: 'openWorkspaceFolder', label: 'Change Workspace Folder…', run: () => void window.sqlApi.workspace.setRoot().then((root) => { if (root) { showSideView('workspace'); setWorkspaceRev((r) => r + 1); } }) },
		{ id: 'history', label: 'Show Query History & Saved', run: () => showSideView('history') },
		...(mcpActive ? [{ id: 'agentLog', label: 'Show Agent (MCP) Log', run: () => showSideView('mcplog') }] : []),
		{ id: 'notifications', label: 'Show Notifications', run: openNotifications },
		{ id: 'assistant', label: `Toggle ${ASSISTANT_NAME}`, run: toggleAssistant },
		{ id: 'assistantFull', label: fullChat ? `${ASSISTANT_NAME}: Exit Full Screen` : `${ASSISTANT_NAME}: Full Screen`, run: () => setAssistantFull(!fullChat) },
		{ id: 'libyHelp', label: `${ASSISTANT_NAME}: Help Me Here`, hint: hintFor('libyHelp'), run: summonLiby },
		{ id: 'fixError', label: `${ASSISTANT_NAME}: Fix Last Error`, run: fixWithAI },
		{ id: 'aiComplete', label: `${ASSISTANT_NAME}: Complete at Cursor`, hint: hintFor('aiComplete'), run: () => triggerAiCompletion(editorRef.current) },
		{ id: 'aiEdit', label: `${ASSISTANT_NAME}: Edit / Generate (inline)`, hint: hintFor('aiEdit'), run: () => triggerAiEdit(editorRef.current) },
		{ id: 'settings', label: 'Settings…', run: () => setSettings({}) },
		{ id: 'account', label: 'Account…', run: () => setSettings({ tab: 'account' }) },
		{ id: 'aiSettings', label: 'AI Settings…', run: () => setSettings({ tab: 'ai' }) },
		{ id: 'dataGenSettings', label: 'Data Generation Settings…', run: () => setSettings({ tab: 'datagen' }) },
		{ id: 'cloudSettings', label: 'Cloud Accounts…', run: () => setSettings({ tab: 'cloud' }) },
		{ id: 'dashboardView', label: 'Show Dashboard', run: () => showSideView('dashboard') },
		{ id: 'localSetup', label: 'Dashboard: Set Up a Local Project…', run: openLocalSetup },
		{ id: 'auditLog', label: 'AI Audit Log…', run: () => setSettings({ tab: 'audit' }) },
		{ id: 'addConn', label: 'Add Connection…', run: () => setForm({}) },
		{ id: 'schemaSync', label: 'Sync Schema…', run: openSchemaSync },
		{ id: 'monitors', label: 'Monitors…', run: openMonitors },
		{ id: 'orbit', label: 'Orbit: map this database in 3D', run: openOrbit },
		// Snoutbot. Both ids are also what the tray's submenu opens.
		{ id: 'reviews', label: 'Snoutbot: Show Reviews', run: openReviews },
		{ id: 'snoutbotSettings', label: 'Snoutbot Settings…', run: () => setSettings({ tab: 'snoutbot' }) },
		// The same poll the tray's "Check Now" and the settings button run. It says nothing itself:
		// a review that starts puts up its own card, and one that finds nothing should not.
		{ id: 'snoutbotCheck', label: 'Snoutbot: Check for New Pull Requests', run: () => { void window.sqlApi.review.pollNow(); } },
		{ id: 'moveDatabase', label: 'Move Database…', run: () => openMove() },
		{ id: 'flowsPanel', label: 'Show Data Flows', run: () => showSideView('flows') },
		// Creating and importing a flow are only offered by a build that has Data Flows; without it
		// the Flows view says where the feature is.
		...(PRO_AVAILABLE ? [
			{ id: 'newFlow', label: 'New Data Flow…', run: () => openFlow() },
			// Import is on the palette as well as the Flows panel, so a `.snoutflow` somebody sent
			// you is openable without first knowing which side view it lives behind.
			{ id: 'importFlow', label: 'Import Data Flow…', run: () => { void importFlowFromFile(); } },
		] : []),
		{ id: 'queryPerformance', label: 'Query Performance…', run: openQueryPerf },
		{ id: 'security', label: 'Users & Privileges…', run: openSecurity },
		{ id: 'clickhouseOps', label: 'ClickHouse Operations…', run: () => openChOps() },
		{ id: 'clickhouseRemote', label: 'ClickHouse Remote Data…', run: () => openChRemote() },
		{ id: 'closeTab', label: 'Close Tab', hint: hintFor('closeTab'), run: () => { if (activeTabId) { closeTab(activeTabId); } } },
		{ id: 'toggleSidebar', label: 'Toggle Sidebar', run: () => setDocks((d) => (d.left.active ? hideTool(d, d.left.active) : showTool(d, d.left.tools[0] ?? 'connections'))) },
		// Moving a panel is on the palette as well as its header menu, so it is keyboard-reachable.
		// One command per tool per area it is not already in.
		...movePanelCommands,
		{ id: 'toggleResults', label: 'Toggle Results Panel', run: () => setLayout((l) => ({ ...l, resultsCollapsed: !l.resultsCollapsed })) },
		{ id: 'theme', label: 'Switch Theme', run: toggleTheme },
		{ id: 'checkUpdate', label: 'Check for Updates…', run: checkForUpdates },
		// DEV-ONLY: preview the auto-update UI without a real release (the dev build's updater
		// always reports "up to date"). "Downloading" shows the ambient status-bar progress;
		// "Ready" shows the restart toast (click Later to see it collapse to the status-bar pill).
		// Stripped from packaged builds (import.meta.env.DEV is false there).
		...(import.meta.env.DEV ? [
			{ id: 'devUpdateDownloading', label: 'Dev: Preview Update Downloading', run: () => { setUpdateManual(false); setUpdateDismissed(false); setUpdate({ state: 'downloading', percent: 42 }); } },
			// The macOS path, which reports no percent: the status bar counts and the label grows.
			// Started a minute ago so the last of those steps is on screen straight away.
			{ id: 'devUpdateDownloadingSlow', label: 'Dev: Preview Update Downloading (no progress, slow)', run: () => { setUpdateManual(false); setUpdateDismissed(false); setUpdate({ state: 'downloading', startedAt: Date.now() - 62_000 }); } },
			...(LIBY_AVAILABLE ? [
				{ id: 'devMascot', label: `Dev: Preview ${ASSISTANT_NAME} (the welcome)`, run: () => { saveMomentsSeen([]); requestMoment('welcome'); } },
				{ id: 'devMascotResults', label: `Dev: Preview ${ASSISTANT_NAME} on the results`, run: () => { saveMomentsSeen([]); requestMoment('run'); } },
			] : []),
			{ id: 'devUpdateReady', label: 'Dev: Preview Update Ready', run: () => { setUpdateManual(false); setUpdateDismissed(false); setUpdate({ state: 'downloaded', version: '0.0.40' }); } },
			// The failure states, which are the hardest to see on purpose: they need GitHub to be
			// having a bad day. The sentences come from the same classifier the real path uses.
			{ id: 'devUpdateFailedFeed', label: 'Dev: Preview Update Failed (feed down)', run: () => { setUpdateManual(true); setUpdateDismissed(false); setUpdate({ state: 'error', ...describeUpdateFailure('Cannot parse releases feed: HttpError: 504 Gateway Time-out', 504) }); } },
			{ id: 'devUpdateFailedOffline', label: 'Dev: Preview Update Failed (offline)', run: () => { setUpdateManual(true); setUpdateDismissed(false); setUpdate({ state: 'error', ...describeUpdateFailure('getaddrinfo ENOTFOUND github.com') }); } },
			{ id: 'devUpdateFailedSignature', label: 'Dev: Preview Update Failed (signature)', run: () => { setUpdateManual(true); setUpdateDismissed(false); setUpdate({ state: 'error', ...describeUpdateFailure('sha512 checksum mismatch') }); } },
			{ id: 'devUpdateClear', label: 'Dev: Clear Update Preview', run: () => { setUpdate(null); setUpdateManual(false); setUpdateDismissed(false); } },
			// The move's progress screen on a simulated run, before the runner exists.
			{ id: 'devMoveProgress', label: 'Dev: Preview Move Progress', run: () => openMove({ preview: true }) },
		] : []),
		{ id: 'about', label: 'About SnoutData Studio', run: () => setAboutOpen(true) },
		...(hasReleaseNotes() ? [{ id: 'releaseNotes', label: 'Show Release Notes', run: openReleaseNotes }] : []),
		{ id: 'startTour', label: 'Take a Quick Tour', run: startTour },
		{ id: 'findDatabases', label: 'Find Databases…', run: () => setDiscovery('manual') },
		{ id: 'gettingStarted', label: 'Show Getting Started Checklist', run: openChecklist },
		...state.connections
			.filter((c) => !state.connectedIds.includes(c.id))
			.map((c) => ({ id: `connect-${c.id}`, label: `Connect: ${c.label}`, run: () => void connect(c.id) })),
		...state.connections
			.filter((c) => state.connectedIds.includes(c.id))
			.map((c) => ({ id: `disconnect-${c.id}`, label: `Disconnect: ${c.label}`, run: () => void disconnect(c.id) })),
	];
	// Keep the menu-command handler's view of the commands current (rebuilt each render).
	commandsRef.current = commands;
	openProjectRef.current = (target, name) => {
		if (target.kind === 'local') {
			openLocalProject(target.id, name, 'overview');
		} else {
			openCloudProject(target.ref, name, 'overview');
		}
	};

	// The bridge the AI capabilities drive the app through. Plain closures over the current
	// handlers/state — the registry calls these when the model invokes a renderer capability.
	capabilityCtxRef.current = {
		api: window.sqlApi,
		app: {
			createTab: (sql: string) => createTab(sql),
			insertAtCursor,
			runCurrent: () => run(),
			openConnectionForm: (draft) => setForm({ draft }),
			openTableDesigner: (connectionId, schema, seed) => openNewTable(connectionId, schema, seed),
			openWorkspaceFile: (path) => openWorkspaceFile(path),
			openFlow: (options) => openFlow(options),
			openMonitors: () => openMonitors(),
			openCloudProject: (ref, name, section) => openCloudProject(ref, name, section),
			// The assistant opens this view and fills a form in; the review sheet and the person
			// reading it are what decide whether anything runs.
			openSecurity: (connectionId, proposal) => {
				openSecurity(connectionId);
				if (proposal) {
					setSecurityProposal({ nonce: Date.now(), draft: proposal.draft, changes: proposal.changes });
				}
			},
			connect: (id) => connect(id),
			disconnect,
			setAppSetting: (key, value) => setAppSettings((s) => ({ ...s, [key]: value }) as AppSettings),
			setTheme: (dark) => setTheme(dark ? 'dark' : 'light'),
			notifyKnowledgeChanged: () => setKnowledgeRev((r) => r + 1),
			resultConnectionId: () => resultTabsRef.current.find((t) => t.id === activeResultIdRef.current)?.connectionId,
			getQueryResult: (maxRows) => {
				// Read from the refs, not the `response` closure: a capability call arrives via IPC
				// after run_current's own round-trip, by which point this render's closure is stale —
				// the refs always mirror the live active result tab.
				const active = resultTabsRef.current.find((t) => t.id === activeResultIdRef.current) ?? null;
				const resp = active?.response ?? null;
				if (!resp) {
					return { status: 'none' };
				}
				if (!resp.ok) {
					return { status: 'error', error: resp.error };
				}
				const r = resp.result;
				const cap = Math.max(1, Math.min(Math.floor(maxRows) || 100, 1000));
				const rows = r.rows.slice(0, cap).map((row) => row.map((cell) => {
					if (cell === null || cell === undefined) {
						return null;
					}
					if (typeof cell === 'number' || typeof cell === 'boolean' || typeof cell === 'string') {
						return cell;
					}
					return cell instanceof Date ? cell.toISOString() : JSON.stringify(cell);
				}));
				return { status: 'ok', view: { columns: r.fields.map((f) => ({ name: f.name, dataType: f.dataType })), rows, rowCount: r.rows.length, truncated: r.rows.length > cap } };
			},
		},
		snapshot: () => ({
			connections: state.connections.map((c) => ({ id: c.id, label: c.label, driver: c.driver, environment: c.environment, connected: state.connectedIds.includes(c.id) })),
			activeConnectionId: activeId,
			tabs: tabs.map((t) => ({ id: t.id, title: t.title, kind: t.kind ?? 'sql', connectionId: t.connectionId, active: t.id === activeTabId })),
			appSettings,
			shortcuts: keybindingsRef.current.map((b) => ({ id: b.id, label: b.label, keys: formatShortcut(b.combo) })),
		}),
	};

	const activityBar = (
		<ActivityBar
				agents={visibleAgents.map((a) => ({ kind: a.kind, label: a.label, icon: agentDescriptor(a.kind).icon }))}
				// Clicking the icon of the console you are already looking at puts it away, the way
				// every other activity-bar icon toggles its tool — wherever that tool is docked.
				onOpenAgent={(kind) => setDocks((d) => toggleTool(d, `agent:${kind}`))}
			position={appSettings.activityBarPosition}
			visibleTools={shownTools}
			onToolMenu={(tool, x, y) => setPanelMenu({ tool, x, y })}
			onToolDragStart={(tool, event) => beginToolDrag(tool, event, true)}
			notificationCount={unreadCount}
			reviewCount={reviewCount}
			showSnoutbot={snoutbot.show}
			snoutbotAwaiting={snoutbot.awaiting}
			// Each of these opens a WORKBENCH tab, which full-screen chat hides, so they leave it first;
			// otherwise the click opened the view behind the chat and looked like it did nothing.
			onOpenReviews={() => { setFullChat(false); openReviews(); }}
			onSelectView={selectSideView}
			onOpenMonitors={() => { setFullChat(false); openMonitors(); }}
			onOpenMove={() => { setFullChat(false); openMove(); }}
			onOpenOrbit={() => { setFullChat(false); openOrbit(); }}
			onToggleChat={toggleAssistant}
			onOpenNotifications={openNotifications}
			onOpenSettings={() => setSettings({})}
			theme={theme}
			onSelectTheme={setTheme}
		/>
	);

	/**
	 * The five side views. Each is rendered only while it is on screen: they are cheap and they
	 * re-read their data when they mount, so keeping one mounted-but-hidden would buy nothing and
	 * cost a stale list. The assistant and the agent consoles are the opposite case, and those two
	 * stay mounted wherever they are docked.
	 */
	function sidePanelNode(tool: ToolId): JSX.Element | null {
		switch (tool) {
			case 'connections': return (
				<Sidebar
					state={state}
					activeId={activeId}
					onCollapse={() => setDocks((d) => hideTool(d, 'connections'))}
					onAdd={() => setForm({})}
					onImport={() => setImporting(true)}
					onEdit={(config) => setForm({ existing: config })}
					onDelete={(config) => void remove(config)}
					onConnect={connect}
					onCancelConnect={cancelConnect}
					connectingIds={connectingIds}
					onDisconnect={(id) => void disconnect(id)}
					onSelectActive={(id) => selectConnection(id)}
					onOpenTable={openTable}
					onNewTable={openNewTable}
					onNewCollection={(connectionId) => setNewCollection({ connectionId, name: '' })}
					onOpenSecurity={(connectionId) => openSecurity(connectionId)}
					onOpenClickHouseOps={(connectionId) => openChOps(connectionId)}
					onOpenClickHouseRemote={(connectionId) => openChRemote(connectionId)}
					onOpenSeriesMonitor={(connectionId, table) => void openSeriesMonitor(connectionId, table)}
					onOpenObject={openObject}
				/>
			);
			case 'workspace': return (
				<WorkspaceFilesPanel
					activePath={tabs.find((t) => t.id === activeTabId)?.filePath}
					rev={workspaceRev}
					onOpen={(path) => void openWorkspaceFile(path)}
					onImport={() => setWorkspaceImport(true)}
					onCollapse={() => setDocks((d) => hideTool(d, 'workspace'))}
				/>
			);
			case 'flows': return (
				<FlowsPanel
					connections={state.connections}
					onOpen={(flowId) => openFlow({ flowId })}
					onNew={() => openFlow()}
					onOpenModel={(page) => setSettings({ tab: 'extractmodel', page })}
					settingsRev={settingsRev}
					onSearch={(flowId) => openVectorSearch(flowId)}
					onExplain={({ prompt, error, connectionId }) => {
						// A failed run gets the same treatment as a failed query: the assistant,
						// grounded in the destination connection so it can see the real schema.
						setChatOpen(true);
						setFixRequest({ nonce: Date.now(), sql: '', error, connectionId, prompt });
					}}
					onCollapse={() => setDocks((d) => hideTool(d, 'flows'))}
				/>
			);
			case 'history': return (
				<HistoryPanel
					onPick={(sql) => createTab(sql)}
					onCollapse={() => setDocks((d) => hideTool(d, 'history'))}
				/>
		
			);
			case 'mcplog': return (
				<McpLogPanel
					onPick={(sql) => createTab(sql)}
					onCollapse={() => setDocks((d) => hideTool(d, 'mcplog'))}
				/>
			);
			case 'orbit': return (
				<OrbitRailPanel
					open={tabs.some((t) => t.kind === 'orbit')}
					onOpen={() => openOrbit()}
					hostRef={setOrbitRailHost}
					onCollapse={() => setDocks((d) => hideTool(d, 'orbit'))}
				/>
			);
			case 'dashboard': return (
				<DashboardPanel
					onCollapse={() => setDocks((d) => hideTool(d, 'dashboard'))}
					onOpenProject={openCloudProject}
					onOpenDatabase={(ref) => void openCloudDatabase(ref)}
					onSetupLocal={openLocalSetup}
					onOpenLocalProject={openLocalProject}
					onOpenLocalDatabase={(id) => void openLocalDatabase(id)}
					onCopyProject={openProjectCopy}
				/>
			);
			default: return null;
		}
	}

	return (
		<LibyProvider host={libyHost}>
		<div className={`app activity-bar-${appSettings.activityBarPosition}`}>
			<TitleBar title={activeTab?.title} onCommand={runMenuCommand} />
			{/* Every icon-only button's tooltip, app-wide (HoverTip.tsx says why not `title`). */}
			<IconButtonTips />
			{/* Every <select>'s list, app-wide: ours instead of the OS menu (SelectPopover.tsx). */}
			<SelectPopover />
			{appSettings.activityBarPosition === 'top' && activityBar}
			<div className="app-body" ref={bandRef}>
				{appSettings.activityBarPosition === 'side' && activityBar}
				<DockAreaView
					area="left"
					size={layout.docks.left.size}
					// In the full view Liby has left its dock, so a left area showing only Liby is empty.
					visible={shownTools.some((t) => placementOf(layout.docks, t) === 'left' && !(fullChat && t === 'assistant'))}
					onResize={(delta) => setLayout((l) => ({ ...l, docks: resizeArea(l.docks, 'left', l.docks.left.size + delta, window.innerWidth, window.innerHeight) }))}
					hostRef={dockHostRefs.left}
				/>
				<div className="dock-center" style={fullChat ? { display: 'none' } : undefined}>
				<div className="workbench" style={fullChat ? { display: 'none' } : undefined}>
				{tabs.length > 0 && isReadOnlyTab && (
					<div className="toolbar">
						<ConnectionChip
							label={viewConn?.label ?? viewConnId ?? "No connection"}
							connected={viewConnId !== undefined && state.connectedIds.includes(viewConnId)}
							prod={viewConn?.environment === 'prod'}
						/>
						<span className="spacer" />
					</div>
				)}
				{tabs.length > 0 && !isReadOnlyTab && !isSchemaSyncTab && !isMonitorTab && !isFlowTab && !isMoveTab && !isVectorSearchTab && !isAgentTab && !isOrbitTab && (
					<div className="toolbar editor-toolbar">
						{running ? (
							<button className="run cancel" type="button" onClick={() => void cancelRun()} title="Cancel the running query">
								<Icon name="stop-circle" /> Cancel
							</button>
						) : (
							<RunSplitButton
								disabled={!canRun}
								onRun={() => void run()}
								onRunNewTab={() => void run({ newTab: true })}
								onRunScript={() => void runAllStatements()}
								onExplain={canExplain ? () => void explainStatement() : undefined}
							/>
						)}
						{running && (() => {
							const warn = appSettings.slowQueryWarnMs > 0 && elapsedMs >= appSettings.slowQueryWarnMs;
							return (
								<span className={`run-elapsed${warn ? ' warn' : ''}`} title={warn ? "This query is taking longer than expected. Click Cancel to stop it." : undefined}>
									{warn && <Icon name="warning" />}
									{warn ? 'Taking longer than expected… ' : 'Running… '}{(elapsedMs / 1000).toFixed(1)}s
									{runProgress && <span className="run-progress" title="What the server has read so far, and the memory the query holds">{describeProgress(runProgress)}</span>}
								</span>
							);
						})()}
						<ConnectionPicker
							connections={state.connections}
							isConnected={(id) => state.connectedIds.includes(id)}
							value={activeId}
							onChange={selectConnection}
							noneLabel="No connection"
							title="Connection for this editor tab"
							onAdd={() => setForm({})}
						/>
						{activeIsDocument && (
							<PipelineBar
								surface={activeSurface}
								collections={mongoCollectionNames()}
								collection={activeTab?.collection}
								onSurfaceChange={setActiveSurface}
								onCollectionChange={setActiveCollection}
								findOpen={findOpen}
								onToggleFind={() => setFindOpen((o) => !o)}
								onOpenBuilder={openPipelineBuilder}
								onExplain={() => void runExplain()}
							/>
						)}
						{/* Spinner AND a way out. The sidebar row has offered Cancel since connectingIds
						    existed; the toolbar showed the same spinner with nothing to press, so a
						    connect that hung could only be waited out from here. */}
						{activeId !== undefined && connectingIds.has(activeId) && (
							<span className="connect-inflight">
								<span className="icon-btn connecting" aria-label="Connecting…"><Icon name="loading" className="codicon-modifier-spin" /></span>
								<button className="icon-btn cancel-connect" type="button" aria-label="Cancel connecting" onClick={() => cancelConnect(activeId)}><Icon name="stop-circle" /></button>
							</span>
						)}
						{activeId !== undefined && !connectingIds.has(activeId) && connectedFlashId === activeId && (
							<span className="icon-btn connected-flash" aria-label="Connected"><Icon name="check" /></span>
						)}
						{activeId !== undefined && !connectingIds.has(activeId) && connectedFlashId !== activeId && !activeConnected && (
							<button className="icon-btn" type="button" aria-label="Connect" onClick={() => void connectFromToolbar(activeId)}><Icon name="plug" /></button>
						)}
						<span className="spacer" />
						<span className={status.tone === 'danger' ? 'status danger' : 'status'}>{status.text}</span>
						<button className="secondary" type="button" onClick={() => void saveActiveFile()}><Icon name="save" /> Save File</button>
					</div>
				)}
				{activeIsDocument && findOpen && !isReadOnlyTab && (
					<FindBar
						collections={mongoCollectionNames()}
						collection={activeTab?.collection ?? mongoCollectionNames()[0]}
						onCollectionChange={setActiveCollection}
						onRun={(collection, pipeline) => void runFind(collection, pipeline)}
					/>
				)}
				<TabBar
					tabs={tabs}
					activeTabId={activeTabId}
					connections={state.connections}
					connectedIds={state.connectedIds}
					onSelect={(id) => {
						setActiveTabId(id);
						// Selecting the Orbit tab brings its controls back with it. Orbit is the one
						// tab whose panel is not optional furniture: without the rail there is nothing
						// to operate the world with, and the floating fallback is for somebody who
						// deliberately hid it, not the default anyone should meet.
						if (tabs.find((t) => t.id === id)?.kind === 'orbit') {
							setDocks((d) => showTool(d, 'orbit'));
						}
					}}
					onClose={closeTab}
					onNew={() => newQueryTab()}
					onReorder={reorderTabs}
				/>
				{tabs.length === 0 && (
					<Welcome
						onNewQuery={() => newQueryTab()}
						onOpenCommandPalette={() => setPaletteOpen(true)}
						onOpenFile={() => void openFile()}
						onSave={() => void saveActiveFile()}
						onRun={() => void run()}
						onFormat={formatEditor}
						onCloseTab={() => { if (activeTabId) { closeTab(activeTabId); } }}
						onAddConnection={() => setForm({})}
						bindings={keybindings}
						tasks={onboarding.tasks}
						onOpenChecklist={openChecklist}
						onboardingEnabled={!appSettings.disableOnboarding}
					/>
				)}
				{/* The Monaco editor stays mounted (models persist per tab); hide it for table tabs and the empty Welcome view. */}
				<div className="sql-body" style={tabs.length === 0 || isTableTab || isObjectTab || isWorkloadTab || isSecurityTab || isSchemaSyncTab || isReleaseNotesTab || isMonitorTab || isFlowTab || isMoveTab || isVectorSearchTab || isAgentTab || isReviewTab || isOrbitTab || isChOpsTab || isChRemoteTab || isCloudProjectTab || isLocalTab ? { display: 'none' } : undefined}>
					<div className="editor-pane" data-tour="editor">
						<Editor onReady={(editor) => {
							editorRef.current = editor;
							// Mirror the cursor/selection into the status bar. Listeners live on the
							// editor instance (stable across per-tab model swaps), so attach once.
							editor.onDidChangeCursorSelection((e) => {
								const model = editor.getModel();
								const selected = model ? model.getValueInRange(e.selection).length : 0;
								setCursor({ line: e.selection.positionLineNumber, col: e.selection.positionColumn, selected });
							});
							// After a pause in typing, the statement is checked for a risk (a write that
							// would hit every row, any write on prod) and a risk is passed to the companion.
							editor.onDidChangeModelContent(() => {
								window.clearTimeout(riskTimerRef.current);
								riskTimerRef.current = window.setTimeout(() => riskCheckRef.current(), 1500);
							});
						}} editorBindings={keybindings} onGlobalShortcut={(id) => { if (id === 'commandPalette') { setPaletteOpen(true); } else { commandsRef.current.find((c) => c.id === id)?.run(); } }} onRun={() => void run()} onFormat={formatEditor} onIdentifierClick={(name) => { if (!activeSchema || !activeId) { return false; } const lower = name.toLowerCase(); const matches = activeSchema.tables.filter((tt) => tt.name.toLowerCase() === lower); if (matches.length === 0) { return false; } const primary = activeConfig?.database; const chosen = matches.find((tt) => tt.schema === primary) ?? matches[0]; openTable(activeId, chosen); return true; }} options={editorOptions(appSettings)} />
					</div>
					{!layout.resultsCollapsed && (
						<Splitter
							orientation="horizontal"
							onDrag={(_dx, dy) => setLayout((l) => ({ ...l, resultsHeight: clamp(l.resultsHeight - dy, 80, window.innerHeight - 160) }))}
						/>
					)}
					<div
						className="results-pane"
						data-tour="results"
						style={layout.resultsCollapsed ? undefined : { flex: `0 0 ${layout.resultsHeight}px` }}
					>
						<div className="pane-header">
							<button
								className="icon-btn"
								aria-label={layout.resultsCollapsed ? 'Expand results' : 'Collapse results'}
								onClick={() => setLayout((l) => ({ ...l, resultsCollapsed: !l.resultsCollapsed }))}
							>
								<Icon name={layout.resultsCollapsed ? 'chevron-up' : 'chevron-down'} />
							</button>
							<span>RESULTS</span>
							<span className="spacer" />
							<ExportMenu
								hasResults={response?.ok === true}
								canRunFull={activeConnected}
								onExport={(format, source) => void exportResults(format, source)}
								onCopy={copyResults}
								serverFormats={serverExportFormats}
								onServerExport={(formatId) => void exportFromServer(formatId)}
							/>
						</div>
						{!layout.resultsCollapsed && resultTabs.length > 0 && (
							<div className="result-tabs" role="tablist">
								{resultTabs.map((t) => (
									<div
										key={t.id}
										role="tab"
										aria-selected={t.id === activeResultId}
										className={`result-tab-chip${t.id === activeResultId ? ' active' : ''}${t.pinned ? ' pinned' : ''}`}
										onClick={() => setActiveResultId(t.id)}
										onDoubleClick={() => setRenamingResultId(t.id)}
										title={`${t.connectionLabel}${t.ranAt ? ` · ${new Date(t.ranAt).toLocaleString()}` : ''}\nDouble-click to rename`}
									>
										<span
											className="result-tab-pin"
											title={t.pinned ? 'Unpin (allow overwrite)' : 'Pin (keep across runs)'}
											onClick={(e) => { e.stopPropagation(); toggleResultPin(t.id); }}
										>
											<Icon name={t.pinned ? 'pinned' : 'pin'} />
										</span>
										{runningTargets.has(t.id) && (
											<span className="result-tab-running" title="Query running…"><Icon name="loading" className="codicon-modifier-spin" /></span>
										)}
										{renamingResultId === t.id ? (
											<input
												className="result-tab-rename"
												defaultValue={t.title}
												autoFocus
												onFocus={(e) => e.target.select()}
												onClick={(e) => e.stopPropagation()}
												onBlur={(e) => commitResultRename(t.id, e.target.value)}
												onKeyDown={(e) => {
													if (e.key === 'Enter') { commitResultRename(t.id, e.currentTarget.value); }
													else if (e.key === 'Escape') { setRenamingResultId(null); }
												}}
											/>
										) : (
											<span className="result-tab-title">{t.title || 'Results'}</span>
										)}
										<span
											className="result-tab-close"
											title="Close result tab"
											onClick={(e) => { e.stopPropagation(); closeResultTab(t.id); }}
										>
											<Icon name="close" />
										</span>
									</div>
								))}
							</div>
						)}
						{running && <div className="progress-bar" title="Query running…" />}
						{!layout.resultsCollapsed && activeResult?.script && (
							<ScriptLog run={activeResult.script} />
						)}
						{!layout.resultsCollapsed && activeResult?.explain && (
							<ExplainPanel
								run={activeResult.explain}
								tableRows={(database, table) => explainTableRows(activeResult.explain?.connectionId ?? '', database, table)}
							/>
						)}
						{!layout.resultsCollapsed && !activeResult?.script && !activeResult?.explain && activeResult?.advisories && activeResult.advisories.length > 0 && (
							<AdvisoryStrip
								advisories={activeResult.advisories}
								onAskAi={() => {
									const connId = activeResult.connectionId ?? activeId;
									const driver = connectionsRef.current.find((c) => c.id === connId)?.driver;
									const sql = activeResult.lastRawSql || activeResult.lastSql;
									setFixRequest({ nonce: Date.now(), sql, error: activeResult.advisories?.[0]?.message ?? "Slow query", connectionId: connId, prompt: buildOptimizeQueryPrompt(sql, dialectFor(driver)) });
								}}
								onDismiss={() => { if (activeResultId) { patchResult(activeResultId, { advisories: undefined }); } }}
							/>
						)}
						{!layout.resultsCollapsed && !activeResult?.script && !activeResult?.explain && (
							<ResultsGrid
								response={response}
								connecting={connecting}
								live={(resultConnectionId ?? activeId) ? state.connectedIds.includes((resultConnectionId ?? activeId) as string) : false}
								active={!isReadOnlyTab && tabs.length > 0}
								appliedLimit={appliedLimit}
								resultKey={`${activeResultId}:${activeResult?.ranAt ?? 0}`}
								onFetchMore={appliedLimit && activeConnected && canFetchMore ? fetchMore : undefined}
								totalCount={totalCount}
								countingTotal={countingTotal}
								onCountTotal={response?.ok && activeConnected && countingSql(lastRawSql, backendKindForDriver(activeConfig?.driver)) !== null ? () => void countTotal() : undefined}
								logWindow={logWindow}
								onReconnect={activeId && lastSql ? () => void reconnectAndRetry() : undefined}
								onSelectionChange={setGridSelection}
								aiActions
								documentView={resultIsDocument}
								logView={resultIsLogs}
								runLogContext={resultIsLogs && resultConnectionId && state.connectedIds.includes(resultConnectionId) ? runLogContext : undefined}
								isProd={activeConfig?.environment === 'prod'}
								policy={activePolicy}
								schema={activeSchema}
								resolveFkLabels={appSettings.resolveFkLabels}
								onNavigateFk={activeId ? (table, filters) => navigateFk(activeId, table, filters) : undefined}
								notEditableReason={editTarget.reason}
								edit={editTarget.table && activeId ? {
									table: editTarget.table,
									driver: editTarget.driver,
									connectionId: activeId,
									isProd: activeConfig?.environment === 'prod',
									onRunScript: runScript,
									onRunWrites: runWrites,
									onReload: () => { if (activeResultId) { void executeSql(lastSql, activeResultId, { keyset: activeResult?.keyset }); } },
								} : undefined}
							/>
						)}
					</div>
				</div>
				{isTableTab && tableData && (
					<TableView
						key={activeTabId}
						connectionId={tableData.connectionId}
						driver={tableData.driver}
						isProd={tableTabProd}
						policy={tableTabPolicy}
						readOnly={tableTabReadOnly}
						table={tableData.table}
						createInSchema={tableData.createInSchema}
						seedDraft={tableData.seedDraft}
						defaultTab={tableData.defaultTab}
						initialFilter={tableData.initialFilter}
						schema={activeSchema}
						resolveFkLabels={appSettings.resolveFkLabels}
						onNavigateFk={(table, filters) => navigateFk(tableData.connectionId, table, filters)}
						onRunDdl={runDdl}
						onRunScript={runScript}
						onRunWrites={runWrites}
						onRunMongoDdl={runMongoDdl}
						onPersisted={persistTableTab}
						onDropped={() => { if (activeTabId) { closeTab(activeTabId); } }}
					/>
				)}
				{isObjectTab && objectData && (
					<ObjectView key={activeTabId} detail={objectData} />
				)}
				{isReleaseNotesTab && (
					<ReleaseNotesView
						version={appVersion}
						showAfterUpdate={appSettings.showReleaseNotesAfterUpdate}
						onToggleShowAfterUpdate={(v) => setAppSettings((s) => ({ ...s, showReleaseNotesAfterUpdate: v }))}
						onOpenLink={(url) => void window.sqlApi.openExternal(url)}
					/>
				)}
				{isWorkloadTab && activeTabId && (
					<QueryPerformanceView
						key={activeTabId}
						connections={state.connections}
						connectedIds={state.connectedIds}
						connectionId={activeTab?.connectionId}
						keywordCase={appSettings.keywordCase}
						onAnalyze={(connectionId, sql) => { setPerfActionRequest({ nonce: Date.now(), action: 'analyze', connectionId, sql }); setChatOpen(true); }}
						onSuggest={(connectionId, sql) => { setPerfActionRequest({ nonce: Date.now(), action: 'optimize', connectionId, sql }); setChatOpen(true); }}
					/>
				)}
				{isChOpsTab && activeTabId && (
					<ClickHouseOpsView
						key={activeTabId}
						connections={state.connections}
						connectedIds={state.connectedIds}
						connectionId={activeTab?.connectionId}
						onOpenMonitor={(id) => { setMonitorFocus({ nonce: Date.now(), id }); openMonitors(); }}
					/>
				)}
				{activeTab?.kind === 'localSetup' && activeTabId && (
					<LocalSetupView
						key={activeTabId}
						onOpenProject={(id, name) => {
							setTabs((prev) => prev.filter((t) => t.id !== activeTabId));
							openLocalProject(id, name, 'overview');
						}}
						onOpenDatabase={(id) => void openLocalDatabase(id)}
					/>
				)}
				{/* A project, local or cloud: one tab, one menu (shared/projects.ts). */}
				{activeTabId && ((activeTab?.kind === 'localProject' && activeTab.localId) || (isCloudProjectTab && activeTab?.cloudRef)) && (
					<ProjectView
						key={activeTabId}
						target={(activeTab?.kind === 'localProject' ? { kind: 'local', id: activeTab.localId as string } : { kind: 'cloud', ref: activeTab?.cloudRef as string }) satisfies ProjectTarget}
						section={projectSection(activeTab?.kind === 'localProject' ? activeTab.localSection : activeTab?.cloudSection)}
						onSection={(section) => setTabs((prev) => prev.map((t) => (t.id === activeTabId ? (t.kind === 'localProject' ? { ...t, localSection: section } : { ...t, cloudSection: section }) : t)))}
						onOpenDatabase={(target) => void (target.kind === 'local' ? openLocalDatabase(target.id) : openCloudDatabase(target.ref))}
						onRunSql={(target) => void openProjectSql(target)}
						onClosed={() => closeTab(activeTabId)}
						onCopy={openProjectCopy}
					/>
				)}
				{/* Kept mounted while open, like a move: a copy in progress must not lose its screen. */}
				{projectCopyTabs.map((tab) => (
					<div key={tab.id} className="flow-wizard-host" style={tab.id === activeTabId ? undefined : { display: 'none' }}>
						<ProjectCopyView
							source={tab.copySource as ProjectTarget}
							sourceName={tab.title.replace(/^Copy /, '')}
							active={tab.id === activeTabId}
							onClose={() => closeTab(tab.id)}
							onOpenProject={(target, name) => (target.kind === 'local' ? openLocalProject(target.id, name, 'overview') : openCloudProject(target.ref, name, 'overview'))}
							onSetupLocal={openLocalSetup}
						/>
					</div>
				))}
				{isChRemoteTab && activeTabId && (
					<ClickHouseRemoteView
						key={activeTabId}
						connections={state.connections}
						connectedIds={state.connectedIds}
						connectionId={activeTab?.connectionId}
						onOpenInEditor={(sql) => createTab(sql, { atEnd: true })}
					/>
				)}
				{isSecurityTab && activeTabId && (
					<SecurityView
						key={activeTabId}
						connections={state.connections}
						connectedIds={state.connectedIds}
						connectionId={activeTab?.connectionId}
						proposal={securityProposal}
					/>
				)}
				{schemaSyncTab && (
					<div className="schema-sync-host" style={isSchemaSyncTab ? undefined : { display: 'none' }}>
						<SchemaSyncView
							connections={state.connections}
							connectedIds={state.connectedIds}
							onApplied={(id) => { void window.sqlApi.refresh(id); }}
							onFixWithAI={(p) => {
								setChatOpen(true);
								setFixRequest({ nonce: Date.now(), sql: p.sql, error: p.error, connectionId: p.connectionId, prompt: buildMigrationFixPrompt(p.sql, p.error, p.objectName) });
							}}
							onClose={() => closeTab(schemaSyncTab.id)}
						/>
					</div>
				)}
				{monitorTab && (
					<div className="monitor-host" style={isMonitorTab ? undefined : { display: 'none' }}>
						<MonitorView
							connections={state.connections}
							active={isMonitorTab}
							focus={monitorFocus}
							onClose={() => closeTab(monitorTab.id)}
						/>
					</div>
				)}
				{orbitTab && (
					<div className="orbit-host" style={isOrbitTab ? undefined : { display: 'none' }}>
						<OrbitView
							active={isOrbitTab}
							schema={activeSchema}
							connectionId={activeId}
							connectionLabel={activeConfig ? `${activeConfig.label}${activeSchema ? ` / ${activeSchema.database}` : ''}` : undefined}
							connections={orbitConnections}
							connecting={activeId !== undefined && connectingIds.has(activeId)}
							connectedFlash={activeId !== undefined && connectedFlashId === activeId}
							onConnect={(id) => void connectFromToolbar(id)}
							onCancelConnect={cancelConnect}
							onSelectConnection={(id) => {
								// Bind the ORBIT tab explicitly rather than through bindConnection, which targets
								// whatever has focus: the rail is a docked panel and can be on screen while
								// another tab is the focused one.
								setTabs((prev) => prev.map((t) => (t.id === orbitTab.id ? { ...t, connectionId: id } : t)));
								if (id !== undefined && !state.connectedIds.includes(id)) {
									void connect(id, false);
								}
							}}
							statement={orbitStatement}
							focusRequest={orbitFocus}
							railHost={orbitRailHost}
							onOpenTable={(ref) => {
								const found = activeSchema?.tables.find((t) => t.name === ref.name && (ref.schema === undefined || t.schema === ref.schema));
								if (found && activeId) {
									openTable(activeId, found);
								}
							}}
						/>
					</div>
				)}
				{reviewTab && (
					<div className="review-view-host" style={isReviewTab ? undefined : { display: 'none' }}>
						<ReviewView
							active={isReviewTab}
							select={reviewSelect}
							onOpenSettings={() => setSettings({ tab: 'snoutbot' })}
							onClose={() => closeTab(reviewTab.id)}
						/>
					</div>
				)}
				{flowTab && (
					<div className="flow-wizard-host" style={isFlowTab ? undefined : { display: 'none' }}>
						<FlowWizardView
							key={flowTab.id}
							connections={state.connections}
							connectedIds={state.connectedIds}
							initialPath={flowTabsRef.current.get(flowTab.id)?.path}
							flowId={flowTabsRef.current.get(flowTab.id)?.flowId}
							defaultConnectionId={activeId ?? undefined}
							active={isFlowTab}
							scheduledFlowsAllowed={auth.entitlements.scheduledFlows}
							generatePanelWidth={layout.generatePanelWidth}
							onGeneratePanelResize={(dx) => setLayout((l) => ({ ...l, generatePanelWidth: clamp(l.generatePanelWidth + dx, 280, 720) }))}
							onOpenAccount={() => setSettings({ tab: 'account' })}
							onOpenExtractionModel={() => setSettings({ tab: 'extractmodel' })}
							onOpenCloudStorage={() => setSettings({ tab: 'cloud' })}
							settingsRev={settingsRev}
							onRan={(id) => { void window.sqlApi.refresh(id); }}
							onAmbient={(summary) => { flowAmbientRef.current = summary; }}
							guided={appSettings.flowWizardGuided}
							onGuidedChange={(flowWizardGuided) => setAppSettings((s) => ({ ...s, flowWizardGuided }))}
							onClose={() => closeTab(flowTab.id)}
						/>
					</div>
				)}
				{moveTab && (
					<div className="flow-wizard-host" style={isMoveTab ? undefined : { display: 'none' }}>
						<MoveView
							key={moveTab.id}
							connections={state.connections}
							connectedIds={state.connectedIds}
							active={isMoveTab}
							preview={movePreviewRef.current}
							onClose={() => closeTab(moveTab.id)}
						/>
					</div>
				)}
				{vectorSearchTab && vectorSearchFlowId && (
					<div className="flow-wizard-host" style={isVectorSearchTab ? undefined : { display: 'none' }}>
						<VectorSearchView
							flowId={vectorSearchFlowId}
							connections={state.connections}
							onFlowChange={setVectorSearchFlowId}
							onClose={() => closeTab(vectorSearchTab.id)}
						/>
					</div>
				)}
				{agentTabs.map((tab) => (
					// What a coding agent has shown, as its own tab beside the editor: the placement its
					// console gets when it sits in the bottom strip (docking.ts, `agentSurfaceHome`).
					// Hidden rather than unmounted, like every other workbench view, so switching tabs
					// does not throw away what is on it.
					<div className="agent-canvas-host" key={tab.id} style={activeTabId === tab.id ? undefined : { display: 'none' }}>
						<AgentCanvas
							kind={tab.agent ?? 'claude'}
							placement="tab"
							connectionLabel={activeConfig?.label ?? "no connection"}
							isDocument={activeIsDocument}
							hasConnection={activeId !== undefined && state.connectedIds.includes(activeId)}
							onInsertSql={insertIntoEditorTab}
							onInsertSqlNewTab={(sql) => { markTask('ai'); createTab(sql); }}
							onInsertPipeline={(json) => { markTask('ai'); openPipelineWithContent(activeId, json); }}
							onRunSql={(sql, runId) => { markTask('ai'); focusEditorForResults(); void runProposedSql(sql, runId); }}
							runOutcome={chatRunOutcome}
						/>
					</div>
				))}
				{agentAction && <AgentActionToast request={agentAction} onAnswer={answerAgentAction} />}
				{cliSignIn && <CliSignInToast request={cliSignIn} onAnswer={answerCliSignIn} />}
				{toast && !notifOpen && (
					<NotificationToast
						notification={toast}
						onAskAI={askAiAboutNotification}
						onOpen={openNotifications}
						onDismiss={() => setToast(null)}
					/>
				)}
			</div>
				<DockAreaView
					area="bottom"
					size={layout.docks.bottom.size}
					visible={shownTools.some((t) => placementOf(layout.docks, t) === 'bottom')}
					onResize={(delta) => setLayout((l) => ({ ...l, docks: resizeArea(l.docks, 'bottom', l.docks.bottom.size + delta, window.innerWidth, window.innerHeight) }))}
					hostRef={dockHostRefs.bottom}
				/>
			</div>
			<DockAreaView
				area="right"
				size={layout.docks.right.size}
				visible={shownTools.some((t) => placementOf(layout.docks, t) === 'right') && !fullChat}
				onResize={(delta) => setLayout((l) => ({ ...l, docks: resizeArea(l.docks, 'right', l.docks.right.size + delta, window.innerWidth, window.innerHeight) }))}
				hostRef={dockHostRefs.right}
			/>
			{/*
			 * Every tool window that must SURVIVE being hidden or moved, portalled into whichever
			 * area it is docked in. React unmounts a subtree when it is re-parented, and an
			 * unmounted assistant is a lost conversation, so these are mounted once, here, and
			 * only ever hidden.
			 */}
			{shownTools.filter((t) => t !== 'assistant' && !t.startsWith('agent:')).map((tool) => (
				<DockTool key={tool} host={dockHosts[placementOf(layout.docks, tool)]} visible onContextMenu={toolContextMenu(tool)} onHeaderPointerDown={(e) => beginToolDrag(tool, e)}>
					{sidePanelNode(tool)}
				</DockTool>
			))}
			{/*
			 * Liby's place in its dock: a slot the one assistant element is moved into, while the
			 * full view is not up (DomSlot says why it is a slot).
			 */}
			{assistantEverOpened && !fullChat && (
				<DockTool host={dockHosts[placementOf(layout.docks, 'assistant')]} visible={chatOpen}>
					<DomSlot node={assistantEl} />
				</DockTool>
			)}
			{visibleAgents.filter((a) => everShownRef.current.has(`agent:${a.kind}`)).map((agent) => {
				const tool: ToolId = `agent:${agent.kind}`;
				const area = placementOf(layout.docks, tool);
				return (
					<DockTool key={tool} host={dockHosts[area]} visible={isToolVisible(layout.docks, tool)} onContextMenu={toolContextMenu(tool)} onHeaderPointerDown={(e) => beginToolDrag(tool, e)}>
						<AgentConsolePanel
							collapsed={layout.docks[area].collapsed}
							kind={agent.kind}
							onToggleCollapse={() => setDocks((d) => ({ ...d, [area]: { ...d[area], collapsed: !d[area].collapsed } }))}
							onClose={() => setDocks((d) => hideTool(d, tool))}
							onOpenSettings={() => setSettings({ tab: 'agent' })}
							themeId={theme}
							fontSize={appSettings.terminalFontSize}
							onFontSize={(size) => setAppSettings((prev) => ({ ...prev, terminalFontSize: size }))}
							surfaceInPanel={agentSurfaceHome(layout.docks, agent.kind) === 'panel'}
							onOpenSurface={() => openAgentTab(agent.kind)}
							canvasHeight={layout.agentCanvasHeight}
							onResizeCanvas={(dy) => setLayout((l) => ({ ...l, agentCanvasHeight: clamp(l.agentCanvasHeight + dy, 100, 720) }))}
							connectionLabel={activeConfig?.label ?? "no connection"}
							isDocument={activeIsDocument}
							hasConnection={activeId !== undefined && state.connectedIds.includes(activeId)}
							onInsertSql={insertIntoEditorTab}
							onInsertSqlNewTab={(sql) => { markTask('ai'); createTab(sql); }}
							onInsertPipeline={(json) => { markTask('ai'); openPipelineWithContent(activeId, json); }}
							onRunSql={(sql, runId) => { markTask('ai'); void runProposedSql(sql, runId); }}
							runOutcome={chatRunOutcome}
						/>
					</DockTool>
				);
			})}
			{/* Liby's full view: the same element, moved here, filling the work area. */}
			{fullChat && <DomSlot node={assistantEl} />}
			{/*
			 * Liby itself, ONE instance for both views. Rendered after both slots so a slot has
			 * adopted the element before the panel's own layout effects run. Its header is the drag
			 * handle and the right-click menu, handled here rather than by DockTool, because React
			 * bubbles a portal's events up the tree it is RENDERED in, which is this one.
			 */}
			{assistantEverOpened && (fullChat || dockHosts[placementOf(layout.docks, 'assistant')] !== null) && createPortal(
				<div
					className="assistant-frame"
					onContextMenu={fullChat ? undefined : toolContextMenu('assistant')}
					onPointerDown={(event) => {
						if (!fullChat && (event.target as HTMLElement).closest('.chat-header')) {
							beginToolDrag('assistant', event);
						}
					}}
				>
					<ChatPanel
						variant={fullChat ? 'full' : 'docked'}
						composerHeight={layout.composerHeight}
						connections={state.connections}
						connectedIds={state.connectedIds}
						activeConnectionId={assistantConnId}
						// The header chip names what Liby sees beside the editor; the full view hides it.
						contextLabel={fullChat ? undefined : assistantContext}
						getAmbient={getAmbient}
						settingsRev={settingsRev}
						knowledgeRev={knowledgeRev}
						fixRequest={fixRequest}
						addToChatRequest={addToChatRequest}
						askRequest={askRequest}
						perfActionRequest={perfActionRequest}
						signedIn={auth.user !== null}
						authRestoring={auth.restoring}
						tier={auth.tier}
						onConnect={(id) => connect(id)}
						onInsertSql={insertAtCursor}
						onInsertSqlNewTab={(sql) => { markTask('ai'); createTab(sql); }}
						onInsertPipeline={(json) => { markTask('ai'); openPipelineWithContent(assistantConnId, json); }}
						// No Run in the full view: there is no editor or results grid in view, so the model
						// presents the data in the reply itself (gridInView is false there).
						onRunSql={fullChat ? undefined : (sql, runId) => { markTask('ai'); void runProposedSql(sql, runId); }}
						runOutcome={chatRunOutcome}
						onResizeComposer={(dy) => setLayout((l) => ({ ...l, composerHeight: clamp(l.composerHeight - dy, 64, 400) }))}
						// The picker shows only while Liby owns its connection. It just SELECTS (never
						// auto-connects, even with autoConnectOnSelect on): the send-time gate asks first.
						onSelectConnection={fullChat ? (id) => setFullChatConnId(id) : undefined}
						onToggleFull={() => setAssistantFull(!fullChat)}
						onOpenSettings={() => setSettings({ tab: 'ai' })}
						onOpenAccount={() => setSettings({ tab: 'account' })}
						onClose={() => setChatOpen(false)}
					/>
				</div>,
				assistantEl,
			)}
			</div>
			{drag && <DockDropZones tool={drag.tool} rect={drag.rect} x={drag.x} y={drag.y} over={drag.over} />}
			{panelMenu && (
				<PanelMenu
					tool={panelMenu.tool}
					at={{ x: panelMenu.x, y: panelMenu.y }}
					current={placementOf(layout.docks, panelMenu.tool)}
					onMove={(area) => setDocks((d) => moveTool(d, panelMenu.tool, area))}
					onHide={() => setDocks((d) => hideTool(d, panelMenu.tool))}
					onClose={() => setPanelMenu(null)}
				/>
			)}
			<StatusBar
				agentActing={agentActing}
				connectionLabel={statusConn?.label}
				connected={statusConnected}
				prod={statusConn?.environment === 'prod'}
				database={statusConn?.database}
				editor={showEditorStatus ? cursor : undefined}
				result={response?.ok ? { rows: response.result.rowCount, ms: response.result.durationMs } : undefined}
				running={running}
				concurrentRuns={statusConnRunning}
				poolMax={statusPoolMax}
				memoryBytes={memoryBytes}
				proItems={<ProStatusItems onOpenEngine={() => setSettings({ tab: 'extractmodel', page: 'engine' })} />}
				version={appVersion}
				update={update ?? undefined}
				updateDismissed={updateDismissed}
				onClickConnection={() => showSideView('connections')}
				onInstallUpdate={() => void window.sqlApi.installUpdate()}
			/>
			{settings && (
				<SettingsModal
					initialTab={settings.tab}
					initialPage={settings.page}
					onOpenFlows={() => { setSettings(null); showSideView('flows'); }}
					onOpenReviews={() => { setSettings(null); openReviews(); }}
					appSettings={appSettings}
					entitlements={auth.entitlements}
					auth={auth}
					authBusy={authBusy}
					signInError={signInError}
					onSignIn={signIn}
					onSignOut={signOut}
					onCancelSignIn={() => setAuthBusy(false)}
					onAppSettingsChange={setAppSettings}
					theme={theme}
					onSelectTheme={setTheme}
					panelsMoved={!isDefaultLayout(layout.docks)}
					onResetPanels={() => setDocks(() => cloneDocks(DEFAULT_DOCKS))}
					connections={state.connections}
					connectedIds={state.connectedIds}
					activeConnectionId={activeId}
					onAddConnection={() => setForm({})}
					onEditConnection={(config) => setForm({ existing: config })}
					onDeleteConnection={(config) => void remove(config)}
					onConnect={(id) => void connect(id)}
					onDisconnect={(id) => void disconnect(id)}
					onReset={resetSettings}
					onAiSaved={() => void refreshAiSettings()}
					onClose={() => { setSettings(null); setSettingsRev((n) => n + 1); void refreshAiSettings(); refreshMcpActive(); }}
				/>
			)}
			{form && (
				<ConnectionForm
					existing={form.existing}
					initialDraft={form.draft}
					onClose={() => {
						setForm(null);
						if (tourAfterFormRef.current) {
							tourAfterFormRef.current = false;
							setTourActive(true);
						}
					}}
					onSaved={() => { markTask('addConnection'); void reload(); }}
					// Closes the form and opens the picker: two modals at once would leave
					// the user deciding which one they are answering.
					onImport={() => { setForm(null); setImporting(true); }}
				/>
			)}
			{importing && (
				<ImportConnectionsModal
					onClose={() => setImporting(false)}
					onImported={() => { markTask('addConnection'); void reload(); }}
					onFindDatabases={() => { setImporting(false); setDiscovery('manual'); }}
				/>
			)}
			{discovery && (
				<DiscoveryModal
					onClose={() => closeDiscovery()}
					onImported={(count) => {
						if (count > 0) {
							markTask('addConnection');
							showSideView('connections');
						}
						void reload();
					}}
					onAddConnection={() => { closeDiscovery({ toForm: true }); setForm({}); }}
				/>
			)}
			{workspaceImport && (
				<WorkspaceImportModal
					onClose={() => setWorkspaceImport(false)}
					onImported={onWorkspaceImported}
				/>
			)}
			{newCollection && (
				<div className="modal-backdrop" onClick={() => !newCollectionBusy && setNewCollection(null)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h3>New collection</h3>
						<label>Collection name
							<input
								type="text"
								autoFocus
								value={newCollection.name}
								placeholder="my_collection"
								disabled={newCollectionBusy}
								onChange={(e) => setNewCollection((c) => (c ? { ...c, name: e.target.value } : c))}
								onKeyDown={(e) => { if (e.key === 'Enter') { void submitNewCollection(); } }}
							/>
						</label>
						<div className="modal-actions">
							<button type="button" className="copy" onClick={() => setNewCollection(null)} disabled={newCollectionBusy}><Icon name="close" /> Cancel</button>
							<button type="button" onClick={() => void submitNewCollection()} disabled={newCollectionBusy || newCollection.name.trim() === ''}>
								<Icon name={newCollectionBusy ? 'loading' : 'add'} className={newCollectionBusy ? 'codicon-modifier-spin' : undefined} /> Create
							</button>
						</div>
					</div>
				</div>
			)}
			{pendingRun && activeConfig && (
				<ConfirmRun
					label={activeConfig.label}
					database={activeConfig.database}
					verb={pendingRun.verb}
					unfiltered={pendingRun.unfiltered}
					hazards={pendingRun.hazards}
					corrected={pendingRun.corrected}
					onRunCorrected={pendingRun.corrected === undefined ? undefined : () => {
						const { corrected, targetId, chatRunId } = pendingRun;
						setPendingRun(null);
						void executeSql(corrected as string, targetId, { chatRunId });
					}}
					onCancel={() => {
						const { chatRunId } = pendingRun;
						setPendingRun(null);
						setStatus('Cancelled');
						if (chatRunId) {
							setChatRunOutcome({ runId: chatRunId, status: 'cancelled' });
						}
					}}
					onConfirm={() => { const { sql, targetId, chatRunId } = pendingRun; setPendingRun(null); void executeSql(sql, targetId, { chatRunId }); }}
				/>
			)}
			{pendingPreflight && (
				<PreflightWarnModal
					rows={pendingPreflight.rows}
					table={pendingPreflight.table}
					onCancel={() => {
						const { chatRunId } = pendingPreflight;
						setPendingPreflight(null);
						setStatus('Cancelled');
						if (chatRunId) {
							setChatRunOutcome({ runId: chatRunId, status: 'cancelled' });
						}
					}}
					onRunAnyway={() => { const { sql, targetId, advisories, keyset, plainSql, chatRunId } = pendingPreflight; setPendingPreflight(null); void executeSql(sql, targetId, { preAdvisories: advisories, keyset, plainSql, chatRunId }); }}
				/>
			)}
			{pendingParams && (
				<QueryParamsDialog
					parameters={pendingParams.parameters}
					initial={(activeId && paramValuesRef.current.get(activeId)) || {}}
					onCancel={() => {
						const { chatRunId } = pendingParams;
						setPendingParams(null);
						if (chatRunId) {
							setChatRunOutcome({ runId: chatRunId, status: 'cancelled' });
						}
					}}
					onRun={(values) => {
						const { raw, newTab, chatRunId } = pendingParams;
						setPendingParams(null);
						const bind = dialectFor(activeConfig?.driver).bindParameters?.(values);
						if (!activeId || !bind) {
							return;
						}
						paramValuesRef.current.set(activeId, { ...paramValuesRef.current.get(activeId), ...values });
						void window.sqlApi.explain({ connectionId: activeId, sql: bind }).then((res) => {
							if (!res.ok) {
								setStatus(res.error, 'danger');
								return;
							}
							void runSqlGuarded(raw, { newTab, chatRunId, parametersBound: true });
						});
					}}
				/>
			)}
			{pendingAiTranscribe && (
				<AiTranslateConfirm
					onCancel={() => {
						const { chatRunId } = pendingAiTranscribe;
						setPendingAiTranscribe(null);
						setStatus('Translation cancelled.');
						if (chatRunId) {
							setChatRunOutcome({ runId: chatRunId, status: 'cancelled' });
						}
					}}
					onConfirm={(always) => {
						const { sql, targetId, chatRunId } = pendingAiTranscribe;
						setPendingAiTranscribe(null);
						if (always) {
							setAppSettings((s) => ({ ...s, aiAutoTranscribe: true }));
						}
						void executeSql(sql, targetId, { allowAi: true, chatRunId });
					}}
				/>
			)}
			{pendingScriptRun && activeConfig && (
				<ConfirmRun
					label={activeConfig.label}
					database={activeConfig.database}
					verb="script"
					unfiltered={false}
					onCancel={() => { setPendingScriptRun(null); setStatus('Cancelled'); }}
					onConfirm={() => { const { targetId, spans, model } = pendingScriptRun; setPendingScriptRun(null); void executeScriptSteps(targetId, spans, model); }}
				/>
			)}
			{pendingNativeRun && activeConfig && (
				<ConfirmRun
					label={activeConfig.label}
					database={activeConfig.database}
					verb="write"
					unfiltered={false}
					onCancel={() => { setPendingNativeRun(null); setStatus('Cancelled'); }}
					onConfirm={() => { const { native, display, targetId } = pendingNativeRun; setPendingNativeRun(null); void executeNativeQuery(native, display, targetId); }}
				/>
			)}
			{builderInitial && (
				<PipelineBuilder
					initial={builderInitial}
					canRun={activeConnected && Boolean(activeTab?.collection ?? mongoCollectionNames()[0])}
					onRunTo={(pipeline) => { const collection = activeTab?.collection ?? mongoCollectionNames()[0]; if (collection) { void runFind(collection, pipeline); } }}
					onApply={applyPipelineToEditor}
					onClose={() => setBuilderInitial(null)}
				/>
			)}
			{paletteOpen && (
				<CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
			)}
			{hideNotice && (
				<HideToTrayNotice
					flows={PRO_AVAILABLE}
					onHide={() => { setHideNotice(false); void window.sqlApi.hideToTray(); }}
					onQuit={() => { setHideNotice(false); void window.sqlApi.confirmQuit(); }}
				/>
			)}
			{quitOpen && (
				<ConfirmQuit
					dirty={tabs.some((t) => t.dirty)}
					onCancel={() => setQuitOpen(false)}
					onConfirm={() => { setQuitOpen(false); void window.sqlApi.confirmQuit(); }}
				/>
			)}
			{closeConfirm && (
				<ConfirmCloseTab
					title={closeConfirm.title}
					onCancel={() => setCloseConfirm(null)}
					onConfirm={() => { const { id } = closeConfirm; setCloseConfirm(null); doCloseTab(id); }}
				/>
			)}
			{minimumVersion.required && (
				<UpdateRequiredSheet
					minimum={minimumVersion.minimum}
					current={minimumVersion.current}
					update={update}
					onCheck={() => void window.sqlApi.checkForUpdate()}
					onInstall={() => void window.sqlApi.installUpdate()}
					onQuit={() => void window.sqlApi.confirmQuit()}
					onDownloadPage={() => void window.sqlApi.openExternal('https://snoutdata.com/download')}
				/>
			)}
			{showToast && update && (
				<UpdateToast
					status={update}
					// Align to the right edge of the activity bar (the 48px icon strip), so the chip
					// clears it but stays put when the sidebar panel opens/closes/resizes. When the
					// activity bar is docked to the top instead, there's no left strip, so sit at the edge.
					style={{ left: (appSettings.activityBarPosition === 'side' ? 48 : 0) + 8 }}
					onInstall={() => void window.sqlApi.installUpdate()}
					onDismiss={dismissUpdate}
					onReleaseNotes={hasReleaseNotes() ? openReleaseNotes : undefined}
				/>
			)}
			{reviewToast && (
				<ReviewToast
					state={reviewToast}
					// Above the update card when both are up, and clearing the activity bar the same way.
					style={{ left: (appSettings.activityBarPosition === 'side' ? 48 : 0) + 8, bottom: showToast && update ? 92 : undefined }}
					onOpen={(runId) => { setReviewToast(null); openReviews(runId); }}
					onDismiss={() => setReviewToast(null)}
				/>
			)}
			{notifOpen && (
				<NotificationsCenter
					notifications={notifications}
					onAskAI={askAiAboutNotification}
					onDismiss={dismissNotification}
					onClear={clearNotifications}
					onClose={() => setNotifOpen(false)}
				/>
			)}
			{confirmDialog}
			{aboutOpen && <AboutModal version={appVersion} onClose={() => setAboutOpen(false)} />}
			{componentPrompt && (
				<ComponentDownloadModal
					driver={componentPrompt.driver}
					driverLabel={componentPrompt.driverLabel}
					requirement={componentPrompt.requirement}
					onClose={() => setComponentPrompt(null)}
					onInstalled={() => {
						const { id } = componentPrompt;
						setComponentPrompt(null);
						void connectFromToolbar(id);
					}}
				/>
			)}
			{tourActive && <Spotlight steps={tourSteps} onFinish={finishTour} finishLabel="Let's go!" />}
			{/* The companion (@snout/liby), mounted once, and paused while the tour runs. */}
			<Liby paused={tourActive} />
			{/* The getting-started checklist as a floating side card (or collapsed pill). On the
			    Welcome screen the "Getting started" button pops this same card out on the side.
			    Once every task is done it retires itself (no lingering pill) unless it's still
			    open showing the "all set" banner; X dismisses it for good either way. */}
			{!tourActive && !onboarding.checklistDismissed && (checklistOpen || (!appSettings.disableOnboarding && !allTasksDone(onboarding))) && (
				<GettingStarted
					state={onboarding}
					open={checklistOpen}
					onToggleOpen={() => setChecklistOpen((v) => !v)}
					onStartTour={startTour}
					onDismiss={dismissChecklist}
					onRunTask={runChecklistTask}
				/>
			)}
		</div>
		</LibyProvider>
	);
}

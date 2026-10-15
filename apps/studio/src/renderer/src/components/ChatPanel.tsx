/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../../shared/assistant';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { ConnectionPicker } from './ConnectionPicker';
import { AssistantArt, GroundingArt } from '../art/Illustrations';
import { Splitter } from './Splitter';
import { ChatHistoryModal } from './ChatHistoryModal';
import { ModelPicker } from './ModelPicker';
import { AttachmentChip } from './AttachmentChip';
import { RenderSurface, type ChatRunOutcome, type ChatRunState, type RenderItem } from './RenderSurface';
import { blocksFromMarkdown, proseOnly, sqlBlocks } from '../renderBlocks';
import { resolveSurface, type SessionKind, type SurfaceConfig } from '../chatSurface';
import { isByokProvider } from '../../../shared/ai';
import type { AiApprovalRequest, AiModelInfo, AiProviderId, AiProviderStatus, AiToolEvent, AmbientContext, ChatMessage, DocumentAttachment, TokenUsage } from '../../../shared/ai';
import type { ChatSession, ChatTurn } from '../../../shared/chat';
import type { KnowledgeNote } from '../../../shared/knowledge';
import { KnowledgePopover } from './KnowledgePopover';
import type { Tier } from '../../../shared/auth';
import type { ConnectionConfig } from '../../../shared/connection';
import { buildFixPrompt, buildExplainQueryPrompt, buildOptimizeQueryPrompt, buildOptimizeFollowUp } from '../aiFix';
import { backendKindForDriver, dialectFor, DATA_ACCESS_INFO, DATA_ACCESS_LEVELS, type DataAccessLevel } from '../../../shared/engine';
import { errorMessage } from '../errors';
import { libyHeard } from '@snout/liby';
import { libyFeel } from '@snout/liby/studio';
import { capabilityRegistry } from '../capabilities';

/** A chat turn as shown in the panel — plus the agent tool steps for an assistant reply
 *  (live only; steps aren't persisted to history). */
interface PanelMessage extends ChatTurn {
	steps?: AiToolEvent[];
}

/** Capability domains hidden when `dbRestricted` (the user was asked to connect the selected database
 *  and declined): everything that needs a live database, so the assistant can't query, inspect schema,
 *  or silently reconnect; it answers generally and says precise data needs a connection. Layered on top
 *  of the surface's own {@link SurfaceConfig.blockedDomains} at send time. The exception is
 *  {@link RESTRICTED_SAFE_CAPABILITIES}: creating a connection needs no live database, so declining to
 *  connect must not hide the way to add one. */
const RESTRICTED_DOMAINS = ['results', 'schema', 'connections', 'tunnels'];

/** Capabilities that survive a blocked domain because they need no live database: creating a
 *  connection (open the prefilled form, test a saved one or, once the user approves the card, draft
 *  settings, list saved connections) is exactly
 *  what a user with no working connection wants to do, so the restricted gate must not hide it.
 *  These are all `connections`-domain, which is only ever blocked by `dbRestricted`. */
const RESTRICTED_SAFE_CAPABILITIES = new Set(['open_connection_form', 'test_connection', 'test_connection_settings', 'list_connections']);

const ZERO_TOKENS: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
	return {
		promptTokens: a.promptTokens + b.promptTokens,
		completionTokens: a.completionTokens + b.completionTokens,
		totalTokens: a.totalTokens + b.totalTokens,
	};
}

/** A compact char count for an attachment chip: "1.2k" / "48k". */
/** A chat's title is its first user message, trimmed; an attachment-only turn falls back to the
 *  attached file's name so the session is still recognisable in history. */
function titleOf(turns: ChatTurn[]): string {
	const first = turns.find((m) => m.role === 'user');
	if (!first) {
		return "New chat";
	}
	const text = first.content.replace(/\s+/g, ' ').trim();
	if (text) {
		return text.slice(0, 60);
	}
	return first.attachments?.[0]?.name ?? "New chat";
}

/** What actually happened to a SQL block the user ran from the chat, reported back by App once the
 *  run settles. Defined with the surface that draws its outcome line; re-exported here because App
 *  has always imported it from this module. */
export type { ChatRunOutcome } from './RenderSurface';

interface ChatPanelProps {
	/** How the panel is laid out. `docked` (default) is the fixed-width side panel next to the
	 *  editor; `full` fills the whole work area as a roomy, centered conversation (the editor and
	 *  results are hidden by App while it's up). The chat body is identical either way — only the
	 *  shell sizing, the composer's connection picker, and the close button's meaning differ. */
	variant?: 'docked' | 'full';
	/** Names what the assistant is currently grounded in beyond the editor (e.g. "Data Flow
	 *  wizard" while a flow tab is active), shown as a header chip so the user knows the chat
	 *  sees what they see. Absent on plain editor tabs. */
	contextLabel?: string;
	/** Docked only: height of the composer input box; the user grows it by dragging the divider
	 *  above. `full` lets the composer size to its content. */
	composerHeight?: number;
	connections: ConnectionConfig[];
	connectedIds: string[];
	/** The editor's active connection. The assistant grounds on this directly (there is no
	 *  separate chat picker): whatever the user has selected above the editor is what the chat
	 *  sees, shown read-only as the "Context:" indicator. */
	activeConnectionId: string | undefined;
	/** Snapshot of what the user is looking at on screen (the query in the editor, the result
	 *  shape, the last error), read lazily at send so the assistant grounds in the live app
	 *  state without the user restating it. */
	getAmbient?: () => AmbientContext;
	/** Bumped when the settings modal closes, so the panel re-reads AI settings (provider,
	 *  model, agent mode) that may have changed there. */
	settingsRev: number;
	/** Bumped when the assistant's `remember_this` capability saves a note, so the "Knows N things"
	 *  chip counts it the moment the user approves it. */
	knowledgeRev?: number;
	/** Set when the user clicks "Fix with AI" on a query error: opens a fresh chat grounded in
	 *  the connection that produced the error and auto-sends the failed SQL + error. The nonce
	 *  re-triggers the auto-send even when the same error is fixed twice. */
	fixRequest?: { nonce: number; sql: string; error: string; connectionId?: string; prompt?: string } | null;
	/** Set when the user clicks "Add to Chat" on an editor selection (or Ctrl+L): drops the
	 *  selected SQL into the composer as a fenced block, focused and ready for a question. The
	 *  nonce re-triggers each time, even for the same text. */
	addToChatRequest?: { nonce: number; text: string } | null;
	/** Set by the editor's AI context-menu actions (Explain SQL / SQL Optimization / Text to SQL):
	 *  opens a fresh chat grounded on the active connection and auto-sends the built prompt. The
	 *  nonce re-triggers each time, even for the same prompt. */
	askRequest?: { nonce: number; prompt: string; connectionId?: string } | null;
	/** Fired by the Query Performance grid's per-row Analyze / Suggest-optimization buttons: runs that
	 *  action on the chosen statement here in the assistant. The nonce re-triggers even when the same
	 *  statement+action is picked twice. */
	perfActionRequest?: { nonce: number; action: 'analyze' | 'optimize'; connectionId: string; sql: string } | null;
	/** Whether a user is signed in. The assistant is account-gated (every reply runs through
	 *  the gateway with the user's key), so signed out we replace the composer with a sign-in
	 *  prompt rather than letting a send fail. */
	signedIn: boolean;
	/** True while a saved session is still being restored on launch, so `signedIn: false` isn't yet
	 *  the answer. We hold a skeleton rather than tell a returning user to sign in and then yank it
	 *  away a moment later. Bounded in main, so this always resolves. */
	authRestoring: boolean;
	/** The signed-in user's subscription tier. The free plan reaches a smaller set of models with
	 *  a smaller monthly allowance, so a dismissible hint at the top says so and links to the
	 *  plans (paid tiers reach every released model). */
	tier: Tier;
	/** Connect a connection by id and resolve whether it succeeded. Used by the connection gate
	 *  (the user clicks "Connect" before the assistant runs) and the "Fix with AI" flow (which
	 *  grounds on the connection that produced the error). */
	onConnect(id: string): Promise<boolean>;
	onInsertSql(sql: string): void;
	onInsertSqlNewTab(sql: string): void;
	/** Insert a proposed MongoDB aggregation pipeline (a ```json block) into a new pipeline tab
	 *  on the active document connection. */
	onInsertPipeline(json: string): void;
	/** Run a proposed ```sql block (the "Run" button) through the app's normal run guards, landing
	 *  the rows in a result tab. The SQL stays visible; this is an explicit click, never auto-run.
	 *  Docked only — full-screen chat has no editor/grid, so the Run button isn't offered there.
	 *  `runId` tags this click so the outcome can be reported back against the right block. */
	onRunSql?(sql: string, runId: string): void;
	/** The settled outcome of a `onRunSql` click, echoed back so the block that was run can say what
	 *  happened. Every click is answered exactly once (including cancels and blocked runs), so a
	 *  block never sits on "Running…" forever. */
	runOutcome?: ChatRunOutcome | null;
	/** Docked only: drag the composer divider. dy is the pointer's vertical movement (up is
	 *  negative). The `full` composer is fixed height, so this is unused there. */
	onResizeComposer?(dy: number): void;
	/** Pick the connection the assistant grounds on, from the composer's bottom selector. Passed
	 *  only while the assistant owns its connection (the full view, where the editor toolbar is
	 *  hidden); docked, the editor toolbar above owns it and no picker is drawn. */
	onSelectConnection?(id: string): void;
	/** Switch between the docked panel and the full view. They are two VIEWS of this one
	 *  instance (one conversation, one draft, one stream), so App re-homes the panel rather than
	 *  mounting another. */
	onToggleFull?(): void;
	onOpenSettings(): void;
	/** Open the Account modal (e.g. when locked Agentic mode is chosen). */
	onOpenAccount(): void;
	onClose(): void;
}

let counter = 0;
function nextRequestId(): string {
	counter += 1;
	return `req-${Date.now()}-${counter}`;
}

/** Whether a chat error is the "monthly AI allowance exhausted" message (see AiService.explain).
 *  Such an error is a billing matter, not a configuration one, so the error banner points the
 *  user at the Account modal (manage/upgrade plan) rather than the AI settings. */
function isBudgetError(message: string): boolean {
	return /billing period|usage allowance/i.test(message);
}

/** A live status line for the in-flight assistant turn, shown the whole time the stop button
 *  is enabled so the user always knows the agent is still working and at what. Derived from the
 *  current tool step (if any) and whether we're blocked on the user's approval. */
function busyStatus(steps: AiToolEvent[] | undefined, waitingApproval: boolean): string {
	if (waitingApproval) {
		return "Waiting for your approval…";
	}
	// The last step still in its 'start' phase is the one currently executing.
	const running = steps?.slice().reverse().find((s) => s.phase === 'start');
	if (running) {
		switch (running.tool) {
			case 'run_query': return "Running query…";
			case 'list_tables': return "Listing tables…";
			case 'describe_table': return running.summary ? `Reading ${running.summary}…` : "Reading table…";
			case 'search_columns': return "Searching columns…";
			default: return "Working…";
		}
	}
	return "Planning next moves…";
}

export function ChatPanel({ variant = 'docked', contextLabel, composerHeight, connections, connectedIds, activeConnectionId, getAmbient, settingsRev, knowledgeRev, fixRequest, addToChatRequest, askRequest, perfActionRequest, signedIn, authRestoring, tier, onConnect, onInsertSql, onInsertSqlNewTab, onInsertPipeline, onRunSql, runOutcome, onResizeComposer, onSelectConnection, onToggleFull, onOpenSettings, onOpenAccount, onClose }: ChatPanelProps): JSX.Element {
	const isFull = variant === 'full';
	const [messages, setMessages] = useState<PanelMessage[]>([]);
	const [input, setInput] = useState('');
	// Documents the user has attached to the NEXT turn (extracted + size-capped in main). Cleared
	// when the turn is sent; each rides that user message as reference context.
	const [attachments, setAttachments] = useState<DocumentAttachment[]>([]);
	const [attaching, setAttaching] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The companion is told when a reply starts and how it ended (`libyFeel`).
	const wasBusy = useRef(false);
	useEffect(() => {
		if (busy && !wasBusy.current) {
			libyFeel({ kind: 'reply-start' });
		} else if (!busy && wasBusy.current) {
			libyFeel({ kind: error !== null ? 'reply-error' : 'reply-done' });
		}
		wasBusy.current = busy;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [busy]);
	// Set when a BYOK turn fails (revoked key, rate limit): captures the failed turn so the user
	// can one-click retry it on managed credits (the gateway). Never switched silently — the user
	// chooses. Cleared on the next send.
	const [byokRetry, setByokRetry] = useState<null | { text: string; priorTurns: PanelMessage[]; groundConnId: string | undefined; baseTokens: TokenUsage; persistId: string; attachments?: DocumentAttachment[] }>(null);
	const [autoInsert, setAutoInsert] = useState(false);
	// The statement (its SQL) we've already analyzed in the CURRENT chat session, so the Query
	// Performance card's "Suggest optimization" can continue that conversation (reusing the diagnosis)
	// instead of starting a fresh, context-free turn. Cleared on a new chat or a new selection.
	const [perfAnalyzedSql, setPerfAnalyzedSql] = useState<string | null>(null);
	// When set, this chat is a dedicated "query optimization" session (seeded by Analyze / Suggest
	// optimization): it holds the statement being tuned. It marks the chat with a banner and hides
	// attachments, so the specialized session can't quietly become a general chat. Cleared on New chat / load.
	const [perfSession, setPerfSession] = useState<string | null>(null);
	// Same flag as a ref, read inside runTurn: the seeding Analyze/Suggest turn fires in the SAME tick
	// it sets perfSession, so the state closure is still stale there — the ref is current. Drives the
	// trimmed ambient (a perf chat is about the staged statement, not the on-screen editor/grid).
	const perfSessionRef = useRef<string | null>(null);
	const [provider, setProvider] = useState<AiProviderId>('ollama');
	const [model, setModel] = useState('');
	const [statuses, setStatuses] = useState<AiProviderStatus[]>([]);
	const [tokens, setTokens] = useState<TokenUsage>(ZERO_TOKENS);
	const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID());
	const [historyOpen, setHistoryOpen] = useState(false);
	// Background observer: after a SQL turn, main distills the exchange into a `suggested`
	// note and returns it here, surfaced as a one-tap "Remember this?" card. It is ALREADY persisted
	// as `suggested` (never injected until approved, so "never silent" holds); the card just makes it
	// prominent. Remember -> approve; Not now -> leave it in the list to Remember later.
	const [suggestion, setSuggestion] = useState<KnowledgeNote | null>(null);
	// "🧠 Knows N things" chip: count of active notes injected for the grounded connection, and
	// whether the manage-popover is open. Bumped after approve/observe to keep the badge live.
	const [knownCount, setKnownCount] = useState(0);
	const [knowledgeOpen, setKnowledgeOpen] = useState(false);
	/** Dismiss the free plan's hint for the rest of this session. */
	const [planHintDismissed, setPlanHintDismissed] = useState(false);
	// What the AI may see of the user's data (engine/context/dataAccess.ts). `undefined` until the
	// settings load; `null` once loaded when the user has never chosen, which is what shows the
	// banner. Choosing, here or in Settings → AI, removes it for good.
	const [dataAccess, setDataAccess] = useState<DataAccessLevel | null | undefined>(undefined);
	// Set right after a choice made in the banner, so the same slot confirms it and says where to
	// change it; cleared by its own dismiss.
	const [dataAccessChosen, setDataAccessChosen] = useState<DataAccessLevel | null>(null);
	const [pendingApproval, setPendingApproval] = useState<AiApprovalRequest | null>(null);
	// The connection gate: set when the user sends a turn while the selected connection is offline.
	// We ask up front whether to connect (no model call until they choose) — connecting then runs
	// grounded, declining runs with DB access restricted. Holds the queued message + prior turns.
	const [pendingConnect, setPendingConnect] = useState<null | { text: string; priorTurns: PanelMessage[]; attachments?: DocumentAttachment[] }>(null);
	// What happened to each SQL block the user ran from the chat, keyed by block ("message index:
	// block index") so a re-run replaces the previous answer in place. Live only, never persisted:
	// it describes this session's clicks, not the conversation.
	const [runs, setRuns] = useState<Record<string, ChatRunState>>({});
	// Dev-only: the exact system prompt main built for the last turn (schema + ambient grounding),
	// shown in a debug panel gated on import.meta.env.DEV. Null until the first turn streams it.
	const [devSystemPrompt, setDevSystemPrompt] = useState<string | null>(null);
	// Index of the reply whose "Copy" was just clicked, so its button shows a tick for a beat.
	// Live only: it's feedback on a click, not part of the conversation.
	const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
	const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const activeRequest = useRef<string | null>(null);
	const replyRef = useRef('');
	const createdAtRef = useRef(Date.now());

	// Load on mount and whenever the settings modal closes (settingsRev), so a provider/
	// model/agent-mode change made in Settings is reflected in the composer too.
	useEffect(() => {
		void window.sqlApi.aiSettings().then((s) => {
			setAutoInsert(s.behavior.autoInsertSql);
			setDataAccess(s.dataAccess ?? null);
			setProvider(s.provider);
			setModel(isByokProvider(s.provider) ? s.byok[s.provider].model : s[s.provider].model);
		});
		void refreshStatuses();
	}, [settingsRev]);

	function refreshStatuses(): Promise<void> {
		return window.sqlApi.aiProviderStatus().then(setStatuses);
	}

	// Self-heal a stale selection: if the saved model is gone from its provider's live list
	// (e.g. renamed/removed on the gateway), switch to the first available model and persist,
	// so the picker doesn't keep surfacing a model that no longer exists. A model that still
	// exists but is toggled off in Settings is left alone (it's force-shown in the combo).
	useEffect(() => {
		if (!model) {
			return;
		}
		// BYOK models are free-text; the provider's status list is only suggestions (Anthropic has
		// no /models at all), so never self-heal a BYOK selection or we'd clobber the user's model.
		if (isByokProvider(provider)) {
			return;
		}
		const status = statuses.find((s) => s.provider === provider);
		if (!status || !status.reachable || status.models.length === 0) {
			return;
		}
		if (status.models.some((m) => m.model === model)) {
			return;
		}
		const fallback = status.models.find((m) => m.recommended && m.enabled) ?? status.models.find((m) => m.enabled) ?? status.models[0];
		void changeActive(`${fallback.provider}:${fallback.model}`);
	}, [statuses, provider, model]);

	// A combo value is "provider:model"; provider has no colon, so split on the first.
	async function changeActive(value: string): Promise<void> {
		const idx = value.indexOf(':');
		if (idx < 0) {
			return;
		}
		const p = value.slice(0, idx) as AiProviderId;
		const m = value.slice(idx + 1);
		setProvider(p);
		setModel(m);
		await window.sqlApi.aiSetActive(p, m);
	}

	async function chooseDataAccess(level: DataAccessLevel): Promise<void> {
		setDataAccess(level);
		setDataAccessChosen(level);
		await window.sqlApi.aiSetDataAccess(level);
	}

	useEffect(() => {
		return window.sqlApi.onAiChunk((requestId, delta) => {
			if (requestId !== activeRequest.current) {
				return;
			}
			replyRef.current += delta;
			setMessages((prev) => {
				const next = [...prev];
				const last = next[next.length - 1];
				if (last && last.role === 'assistant') {
					next[next.length - 1] = { ...last, content: last.content + delta };
				}
				return next;
			});
		});
	}, []);

	// Dev-only: capture the system prompt main assembled for the active turn, for the debug panel.
	// The main process only emits this in unpackaged builds, but gate the listener too so the
	// subscription strips from production bundles.
	useEffect(() => {
		if (!import.meta.env.DEV) {
			return;
		}
		return window.sqlApi.onAiSystemPrompt((requestId, prompt) => {
			if (requestId !== activeRequest.current) {
				return;
			}
			setDevSystemPrompt(prompt);
		});
	}, []);

	// Agent tool steps: attach start/end to the in-flight assistant message.
	useEffect(() => {
		return window.sqlApi.onAiTool((requestId, toolEvent) => {
			if (requestId !== activeRequest.current) {
				return;
			}
			setMessages((prev) => {
				const next = [...prev];
				const last = next[next.length - 1];
				if (!last || last.role !== 'assistant') {
					return prev;
				}
				const steps = [...(last.steps ?? [])];
				const i = steps.findIndex((s) => s.callId === toolEvent.callId);
				if (i >= 0) {
					steps[i] = toolEvent;
				} else {
					steps.push(toolEvent);
				}
				next[next.length - 1] = { ...last, steps };
				return next;
			});
		});
	}, []);

	// The agent asks before running each query; surface a Run/Skip card.
	useEffect(() => {
		return window.sqlApi.onAiApprovalRequest((request) => {
			if (request.requestId === activeRequest.current) {
				setPendingApproval(request);
			}
		});
	}, []);

	useEffect(() => {
		scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
	}, [messages, pendingApproval, suggestion]);

	// Switching between the docked panel and the full view moves this panel's DOM to another
	// parent (App re-homes it rather than remounting it), which drops the browser's focus and the
	// thread's scroll offset. Put both back, so the switch reads as the same conversation growing
	// or shrinking. Skipped on mount: opening the app must not steal focus into the composer.
	const lastVariantRef = useRef(variant);
	useEffect(() => {
		if (lastVariantRef.current === variant) {
			return;
		}
		lastVariantRef.current = variant;
		scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
		composerRef.current?.focus();
	}, [variant]);

	// Keep the "Knows N things" badge in sync with the grounded connection, edits made in
	// Settings → Knowledge (settingsRev), and notes the assistant saved via remember_this
	// (knowledgeRev). refreshKnownCount reads the current connection's notes.
	useEffect(() => {
		void refreshKnownCount();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeConnectionId, settingsRev, knowledgeRev]);

	// The assistant grounds on the editor's active connection (no separate chat picker).
	const activeConn = activeConnectionId ? connections.find((c) => c.id === activeConnectionId) : undefined;
	// Document (MongoDB) connection: the assistant proposes a native ```json aggregation pipeline,
	// inserted into a pipeline tab, rather than ```sql into the editor.
	const activeIsDocument = activeConn ? backendKindForDriver(activeConn.driver) === 'document' : false;
	const activeConnected = activeConnectionId !== undefined && connectedIds.includes(activeConnectionId);
	// The connection this turn grounds in. The selected connection ALWAYS wins when there is one,
	// connected or not: its dialect resolves from the driver even offline (and the agent connects on
	// demand), so we never silently swap to a different DB than the one selected. When NOTHING is
	// selected, fall back only when exactly ONE connection is connected (unambiguous); with several
	// connected we don't pick — see `ambiguousDb`.
	const groundConnId = activeConnectionId !== undefined
		? activeConnectionId
		: connectedIds.length === 1 ? connectedIds[0] : undefined;

	// What this surface exposes (insert buttons, attach, forced mode), resolved from the layout +
	// whether we're in a perf-optimization session. Used by the render below; runTurn re-resolves
	// from perfSessionRef so a same-tick seeding turn sees the perf session before state settles.
	const renderConfig = resolveSurface(variant, perfSession ? 'perf' : 'general');

	// Combined "provider:model" options for the runtime model picker: only enabled models
	// from configured/reachable providers (the gateway stays hidden until it has an API key).
	// The current selection is always included so it shows even if it's been toggled off.
	const current = model ? `${provider}:${model}` : '';
	// Models to offer the picker: enabled ones across providers, plus the current selection even if
	// it's been toggled off (so it still shows). Order/metadata come from aiProviderStatus.
	const enabledModels = statuses.flatMap((s) => s.models.filter((m) => m.enabled));
	const currentModel = statuses.flatMap((s) => s.models).find((m) => `${m.provider}:${m.model}` === current);
	const pickerModels: AiModelInfo[] = current && currentModel && !enabledModels.some((m) => `${m.provider}:${m.model}` === current)
		? [currentModel, ...enabledModels]
		: enabledModels;
	const selectedStatus = statuses.find((s) => s.provider === provider);

	function placeholder(): string {
		if (activeConn && activeConnected) {
			return `Ask ${ASSISTANT_NAME} about ${activeConn.label}…`;
		}
		return `Ask ${ASSISTANT_NAME} anything…  (⏎ send · ⇧⏎ newline)`;
	}

	function emptyHint(): string {
		if (activeConn && activeConnected) {
			return `Ask for SQL grounded in “${activeConn.label}”'s schema.`;
		}
		if (activeConn && !activeConnected) {
			return `“${activeConn.label}” isn't connected. Connect it for schema-aware answers, or ask a general SQL question.`;
		}
		if (connections.length === 0) {
			return "No connections yet. Add one in the Connections panel to get schema-aware answers. You can still ask general SQL questions.";
		}
		return onSelectConnection
			? "Choose a connection below to ground answers in its schema, or ask a general SQL question."
			: "Select a connection above the editor to ground answers in its schema, or ask a general SQL question.";
	}

	/** Upsert a conversation into history. Called after each completed reply so the session is
	 *  always recoverable; the title tracks the first user message. The session id + grounding
	 *  connection are passed in (not read from state) so the fix-flow can persist a freshly
	 *  started session without waiting for its setState to settle. */
	function persist(turns: ChatTurn[], tok: TokenUsage, id: string, conn: ConnectionConfig | undefined): void {
		if (turns.length === 0) {
			return;
		}
		void window.sqlApi.saveChatSession({
			id,
			title: titleOf(turns),
			createdAt: createdAtRef.current,
			updatedAt: Date.now(),
			connectionId: conn?.id,
			connectionLabel: conn?.label,
			messages: turns,
			tokens: tok,
		});
	}

	// Run states are keyed by position in THIS thread, so they can't outlive it: every path that
	// starts or loads a different conversation (New chat, history, and the seeded Fix/Explain/perf
	// chats) takes a new session id, which is the one place this needs to be dropped.
	useEffect(() => {
		setRuns({});
	}, [sessionId]);

	// Land a settled run outcome on the block it came from. Matching on the run id (not the block
	// key) keeps a stale answer off a block the user has since re-run.
	useEffect(() => {
		if (!runOutcome) {
			return;
		}
		setRuns((prev) => {
			const key = Object.keys(prev).find((k) => prev[k].runId === runOutcome.runId);
			return key ? { ...prev, [key]: runOutcome } : prev;
		});
	}, [runOutcome]);

	/** The chat's "Run" button: hand the SQL to the app with a fresh run id and mark the block as
	 *  running, so the click is acknowledged immediately and answered when the run settles. */
	function runBlock(sql: string, key: string): void {
		const runId = nextRequestId();
		setRuns((prev) => ({ ...prev, [key]: { runId, status: 'running' } }));
		onRunSql?.(sql, runId);
	}

	/** Copy a whole assistant reply to the clipboard, exactly as the model wrote it (markdown and
	 *  code fences included) so it pastes usefully anywhere. The per-block Copy buttons take a
	 *  single statement; this one is the answer entire, which is what selecting it by hand costs.
	 *  The button shows a tick for a beat so the click is acknowledged. */
	function copyReply(index: number, text: string): void {
		// Acknowledged only once the write has happened: the browser clipboard refuses a window
		// that is not focused, and a check mark over a copy that did not happen is worse than none.
		navigator.clipboard.writeText(text).then(() => acknowledgeCopy(index), () => undefined);
	}

	function acknowledgeCopy(index: number): void {
		setCopiedIndex(index);
		if (copiedTimer.current) {
			clearTimeout(copiedTimer.current);
		}
		copiedTimer.current = setTimeout(() => {
			copiedTimer.current = null;
			setCopiedIndex(null);
		}, 1400);
	}

	// The copy acknowledgement is the only thing that outlives an unmount here; drop its timer so a
	// closed panel can't set state.
	useEffect(() => () => {
		if (copiedTimer.current) {
			clearTimeout(copiedTimer.current);
		}
	}, []);

	/** Start a fresh conversation. The previous one is already saved (we persist after
	 *  every reply), so this just resets the panel to a new session. */
	function newChat(): void {
		setMessages([]);
		setSessionId(crypto.randomUUID());
		setTokens(ZERO_TOKENS);
		createdAtRef.current = Date.now();
		setError(null);
		setInput('');
		setAttachments([]);
		setPendingApproval(null);
		setPendingConnect(null);
		setPerfAnalyzedSql(null);
		setPerfSession(null);
		perfSessionRef.current = null;
		resetLearning();
	}

	function loadSession(session: ChatSession): void {
		setMessages(session.messages);
		setSessionId(session.id);
		setTokens(session.tokens);
		createdAtRef.current = session.createdAt;
		setError(null);
		setHistoryOpen(false);
		setPerfAnalyzedSql(null);
		setPerfSession(null);
		perfSessionRef.current = null;
		resetLearning();
	}

	/** Clear the pending observer suggestion when starting or loading a different conversation. */
	function resetLearning(): void {
		setSuggestion(null);
	}

	/** Stop the in-flight reply; the partial text already streamed is kept. */
	function stop(): void {
		const id = activeRequest.current;
		if (id) {
			void window.sqlApi.cancelChat(id);
		}
		setPendingApproval(null);
		setPendingConnect(null);
	}

	/** Answer the agent's run_query approval card. `always` trusts this connection so the
	 *  agent won't ask again for it (revertable in Settings → AI → Agent). */
	function respondApproval(approved: boolean, always = false): void {
		if (!pendingApproval) {
			return;
		}
		if (always && pendingApproval.connectionId) {
			void window.sqlApi.setConnectionAutoApprove(pendingApproval.connectionId, true);
		}
		void window.sqlApi.respondToolApproval(pendingApproval.requestId, pendingApproval.callId, approved);
		setPendingApproval(null);
	}

	/** Background observer: after a SQL turn on a grounded connection, ask main to distill
	 *  the exchange into a proposed durable fact (already saved as `suggested`, never injected until
	 *  approved). Surface it as the "Remember this?" card. Silent on no-op/failure so a background
	 *  pass never interrupts the chat. */
	async function observe(turns: ChatTurn[], connectionId: string): Promise<void> {
		try {
			const context = turns.map((m) => ({ role: m.role, content: m.content })) as ChatMessage[];
			const note = await window.sqlApi.observeKnowledge(connectionId, context);
			if (note) {
				setSuggestion(note);
			}
		} catch {
			// Deliberately silent: a failed observation just means no suggestion this turn.
		}
	}

	/** "Remember" on the suggestion card: promote the suggested note to an injected fact. */
	async function rememberSuggestion(): Promise<void> {
		if (!suggestion) {
			return;
		}
		await window.sqlApi.approveKnowledgeNote(suggestion.id);
		setSuggestion(null);
		void refreshKnownCount();
	}

	/** "Not now": hide the card. The note stays `suggested` in the list (Remember it later there);
	 *  it is not injected and not deleted. */
	function dismissSuggestion(): void {
		setSuggestion(null);
	}

	/** Refresh the "Knows N things" badge: active notes injected for the grounded connection,
	 *  including global (every-database) rules — matches what the popover lists. */
	async function refreshKnownCount(): Promise<void> {
		if (!activeConnectionId) {
			setKnownCount(0);
			return;
		}
		try {
			const [own, global] = await Promise.all([
				window.sqlApi.knowledgeNotes(activeConnectionId),
				window.sqlApi.knowledgeNotes('*'),
			]);
			const active = (n: { enabled: boolean; status?: string }): boolean => n.enabled && (n.status ?? 'active') === 'active';
			setKnownCount(own.filter(active).length + global.filter((n) => n.connectionId === '*' && active(n)).length);
		} catch {
			// Non-critical badge; leave the last count on failure.
		}
	}

	/** The label of the connection a pending query runs against, for the "Always" button. */
	function approvalConnLabel(): string {
		const id = pendingApproval?.connectionId;
		return connections.find((c) => c.id === id)?.label ?? 'this connection';
	}

	/** The label shown in a proposed-SQL block's header — the connection the chat is grounded in. */
	function activeConnLabel(): string {
		return connections.find((c) => c.id === activeConnectionId)?.label ?? 'SQL';
	}

	/** Stream one assistant turn: build the history from `priorTurns` + `text`, ground it in
	 *  `groundConnId`, then handle the reply (auto-insert, token tally, persist). The session id,
	 *  base token count, and grounding connection are passed in so both a normal send (continuing
	 *  the current chat) and the fix-flow (a freshly started chat) share the same code path
	 *  without depending on not-yet-settled state. Callers seed the visible thread first. */
	async function runTurn(text: string, priorTurns: PanelMessage[], groundConnId: string | undefined, baseTokens: TokenUsage, persistId: string, restricted = false, turnAttachments: DocumentAttachment[] = []): Promise<void> {
		setError(null);
		setByokRetry(null);
		// Carry prior turns' attachments too: they're already capped, and the model needs them to
		// keep reasoning over a document referenced earlier in the conversation.
		const history: ChatMessage[] = [
			...priorTurns.map((m) => ({ role: m.role, content: m.content, attachments: m.attachments })),
			{ role: 'user', content: text, attachments: turnAttachments.length > 0 ? turnAttachments : undefined },
		];
		setBusy(true);
		const requestId = nextRequestId();
		activeRequest.current = requestId;
		replyRef.current = '';
		try {
			// Push a snapshot of what the user is looking at right now (the query on screen, the
			// result shape, the last error) so the assistant grounds in it without the user
			// restating it. Read lazily at send time so it reflects the live editor/grid, not a
			// stale render.
			// The assistant never drives the editor: editor-control capabilities are withheld on both
			// surfaces (the user inserts proposed SQL manually). Full chat also gets no editor ambient
			// (it's a standalone DB surface), so it can't anchor on a stale on-screen query; the docked
			// panel still sees the editor for grounding ("explain this query"), it just can't run it.
			const ambient = getAmbient?.() ?? {};
			// Re-resolve from the ref, not `renderConfig`: the seeding Analyze/Suggest turn runs in the
			// same tick it enters the perf session, so the perfSession STATE is still stale here.
			const runConfig = resolveSurface(variant, perfSessionRef.current ? 'perf' : 'general');
			const blocked = new Set(runConfig.blockedDomains);
			if (restricted) {
				for (const d of RESTRICTED_DOMAINS) {
					blocked.add(d);
				}
			}
			const caps = capabilityRegistry.list().filter((c) => RESTRICTED_SAFE_CAPABILITIES.has(c.name) || !blocked.has(c.domain));
			// restricted (user declined to connect a selected DB) takes precedence; otherwise flag the
			// ambiguous-dialect case so main asks which DB instead of guessing. Keyed off the actual
			// `groundConnId` this turn uses (not the dropdown), so the perf/retry call sites that pass
			// an explicit connection are never flagged ambiguous. Both can't co-occur: restricted has a
			// selected connection, ambiguous has none + several connected.
			const ambiguousDb = groundConnId === undefined && connectedIds.length > 1;
			const dbAccess = restricted ? 'restricted' as const : ambiguousDb ? 'ambiguous' as const : undefined;
			// The roster's "active" flag must mark the connection THIS turn is grounded on (groundConnId),
			// not whatever the editor tab points at — in full chat the chat's own picker drives the
			// connection, so the editor's active id can differ. When restricted (declined), nothing is
			// grounded, so nothing is active.
			const roster = ambient.connections?.map((c) => ({ ...c, active: c.id === groundConnId }));
			// When the surface withholds editor ambient (full chat, or a perf session about the staged
			// statement, NOT what's on screen) we drop the editor buffer, other tabs, result grid,
			// selection and last error — pure noise there — and keep only the connection roster.
			const sentAmbient: AmbientContext = runConfig.editorAmbient
				? { ...ambient, connections: roster, surface: 'docked', dbAccess }
				: { connections: roster, surface: isFull ? 'full' : 'docked', dbAccess };
			const result = await window.sqlApi.aiChat(requestId, history, groundConnId, caps, sentAmbient);
			if (!result.ok && !result.aborted) {
				setError(result.error ?? 'The assistant request failed.');
				// A BYOK turn failed: offer a one-click retry on managed credits (the gateway).
				if (isByokProvider(provider)) {
					setByokRetry({ text, priorTurns, groundConnId, baseTokens, persistId, attachments: turnAttachments });
				}
				return;
			}
			// On success or a user stop, keep what streamed and save the turn. Auto-insert is
			// off by default — normally the user inserts via the buttons under each SQL block.
			const reply = replyRef.current;
			if (result.ok && autoInsert) {
				const blocks = sqlBlocks(reply);
				if (blocks[0]) {
					onInsertSql(blocks[0]);
				}
			}
			const turns: ChatTurn[] = [
				...priorTurns.map((m) => ({ role: m.role, content: m.content, attachments: m.attachments })),
				{ role: 'user', content: text, attachments: turnAttachments.length > 0 ? turnAttachments : undefined },
				{ role: 'assistant', content: reply },
			];
			const nextTokens = result.usage ? sumUsage(baseTokens, result.usage) : baseTokens;
			setTokens(nextTokens);
			persist(turns, nextTokens, persistId, groundConnId ? connections.find((c) => c.id === groundConnId) : undefined);
			// Background observer: on a SQL/correction turn on a grounded connection, distill the
			// exchange into a proposed durable fact and offer the "Remember this?" card. Gated on
			// the reply actually proposing SQL so chit-chat turns don't spend a (cheap) distiller
			// call off the metered wallet. Deferred so it never blocks the UI. Main decides the model
			// (`observerModelFor`): in a build from source it answers null with no model call until
			// the user names an observer model in Settings → AI.
			if (result.ok && groundConnId && sqlBlocks(reply).length > 0) {
				const observeTurns = turns;
				const observeConn = groundConnId;
				setTimeout(() => void observe(observeTurns, observeConn), 0);
			}
		} catch (err) {
			setError(errorMessage(err));
			if (isByokProvider(provider)) {
				setByokRetry({ text, priorTurns, groundConnId, baseTokens, persistId, attachments: turnAttachments });
			}
		} finally {
			setBusy(false);
			// `activeRequest` is deliberately NOT cleared here. A streamed chunk and the turn's own
			// reply reach the renderer over two different IPC paths (`webContents.send` vs. the
			// `invoke` reply), and nothing orders them: when the reply wins, clearing the id here
			// made the chunk handler drop text the model had already sent, and the thread renders
			// what the deltas put there and nothing else. Found driving this panel with a scripted
			// model, where the whole turn lands in one tick and the reply wins every time; against a
			// real model the same race can only lose the tail of a reply, which is worse to debug.
			// A new turn overwrites the id, so a superseded turn's chunks are still ignored.
			setPendingApproval(null);
		}
	}

	/** Retry the last failed BYOK turn on managed credits: switch the active provider to the
	 *  gateway (its recommended/first model), then re-run the captured turn. Explicit, never
	 *  silent — the user clicked. No-op if the gateway has no available model. */
	async function retryOnManaged(): Promise<void> {
		const r = byokRetry;
		const gw = statuses.find((s) => s.provider === 'positron-cloud');
		const m = gw?.models.find((x) => x.recommended && x.enabled) ?? gw?.models.find((x) => x.enabled) ?? gw?.models[0];
		if (!r || !m) {
			return;
		}
		setByokRetry(null);
		await changeActive(`${m.provider}:${m.model}`);
		await runTurn(r.text, r.priorTurns, r.groundConnId, r.baseTokens, r.persistId, false, r.attachments ?? []);
	}

	/** Attach a document to the next turn: main opens the picker and returns the extracted +
	 *  size-capped text (never the whole file). Surfaces a clean error for an unsupported/unreadable
	 *  file; a cancelled picker is a no-op. */
	async function attachDocument(): Promise<void> {
		if (attaching) {
			return;
		}
		setAttaching(true);
		try {
			const result = await window.sqlApi.aiPickDocument();
			if (!result) {
				return;
			}
			if (!result.ok) {
				setError(result.error);
				return;
			}
			setError(null);
			setAttachments((prev) => [...prev.filter((a) => a.name !== result.attachment.name), result.attachment]);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setAttaching(false);
		}
	}

	async function send(): Promise<void> {
		const text = input.trim();
		if ((!text && attachments.length === 0) || busy || !signedIn || pendingConnect) {
			return;
		}
		const priorTurns = messages;
		const turnAttachments = attachments;
		// Every message is shown to the companion (`libyHeard`), which decides whether it was meant for it.
		if (text) {
			libyHeard(text);
		}
		// Connection gate (the user's most important lever): a selected-but-offline connection is
		// resolved HERE, by the user, before any model call — never lazily mid-loop by the agent.
		// Ask whether to connect; we run only after they choose. (A connection that's already live,
		// or no connection selected at all, falls straight through to the normal flow.)
		if (activeConnectionId && !activeConnected) {
			setInput('');
			setAttachments([]);
			setError(null);
			setPendingConnect({ text, priorTurns, attachments: turnAttachments });
			return;
		}
		setMessages((prev) => [...prev, { role: 'user', content: text, attachments: turnAttachments.length > 0 ? turnAttachments : undefined }, { role: 'assistant', content: '' }]);
		setInput('');
		setAttachments([]);
		// Ground on the editor's active connection (general SQL when nothing is selected).
		await runTurn(text, priorTurns, groundConnId, tokens, sessionId, false, turnAttachments);
	}

	/** The user chose to connect the offline database: connect first (still no model call), wait for
	 *  it, then run the queued turn grounded in it. A failed connect surfaces an error and runs
	 *  nothing — the user can retry or rephrase. */
	async function connectThenSend(): Promise<void> {
		const p = pendingConnect;
		if (!p || !activeConnectionId) {
			return;
		}
		setPendingConnect(null);
		setMessages((prev) => [...prev, { role: 'user', content: p.text, attachments: p.attachments }, { role: 'assistant', content: '' }]);
		setBusy(true);
		const ok = await onConnect(activeConnectionId);
		setBusy(false);
		if (!ok) {
			// Connect failed: drop the empty assistant placeholder and tell the user. No tokens spent.
			setMessages((prev) => (prev[prev.length - 1]?.role === 'assistant' && !prev[prev.length - 1].content ? prev.slice(0, -1) : prev));
			setError(`Couldn't connect to "${activeConn?.label ?? 'the database'}". Check the connection settings and try again, or continue without a connection.`);
			return;
		}
		await runTurn(p.text, p.priorTurns, activeConnectionId, tokens, sessionId, false, p.attachments ?? []);
	}

	/** The user chose NOT to connect: run the queued turn with DB access restricted. No DB tools (or
	 *  DB-touching capabilities) are advertised and the assistant is told it can't fetch precise
	 *  data, so it answers generally and points the user at connecting for a data-backed answer. */
	async function sendRestricted(): Promise<void> {
		const p = pendingConnect;
		if (!p) {
			return;
		}
		setPendingConnect(null);
		setMessages((prev) => [...prev, { role: 'user', content: p.text, attachments: p.attachments }, { role: 'assistant', content: '' }]);
		await runTurn(p.text, p.priorTurns, undefined, tokens, sessionId, true, p.attachments ?? []);
	}

	// An AI request made while signed out (startGroundedChat), run as soon as the user signs in.
	const [held, setHeld] = useState<{ prompt: string; connectionId?: string; about?: string } | null>(null);
	useEffect(() => {
		if (signedIn && held) {
			startGroundedChat(held.prompt, held.connectionId);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [signedIn]);

	// "Fix with AI" from a query error: open a fresh chat grounded in the connection that
	// produced the error and auto-send the failed SQL + error. Keyed on the nonce so the same
	// error can be fixed again. Connects the target first if needed, so grounding has a schema.
	useEffect(() => {
		if (!fixRequest) {
			return;
		}
		// The fix-flow grounds on the connection that produced the error, connecting it first if
		// needed so grounding has a schema.
		startGroundedChat(fixRequest.prompt ?? buildFixPrompt(fixRequest.sql, fixRequest.error), fixRequest.connectionId, fixRequest.error);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fixRequest?.nonce]);

	// Editor AI context-menu actions (Explain / Optimize / Text to SQL): open a fresh chat grounded
	// on the active connection and auto-send the built prompt. Mirrors "Fix with AI" — connects the
	// target first if needed so grounding has a schema; keyed on the nonce so the same prompt re-runs.
	useEffect(() => {
		if (!askRequest) {
			return;
		}
		startGroundedChat(askRequest.prompt, askRequest.connectionId);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [askRequest?.nonce]);

	// "Add to Chat" from an editor selection: append the selected SQL as a fenced block to the
	// composer (keeping anything already typed) and focus it, so the user can add their question.
	// Unlike "Fix with AI" this never auto-sends — it just stages context.
	useEffect(() => {
		if (!addToChatRequest) {
			return;
		}
		const block = '```sql\n' + addToChatRequest.text.trim() + '\n```\n';
		setInput((current) => (current.trim() ? current.replace(/\s*$/, '\n\n') + block : block));
		const ta = composerRef.current;
		if (ta) {
			requestAnimationFrame(() => {
				ta.focus();
				const end = ta.value.length;
				ta.setSelectionRange(end, end);
				ta.scrollTop = ta.scrollHeight;
			});
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [addToChatRequest?.nonce]);

	// The Query Performance grid's per-row buttons drive Analyze / Suggest optimization here. Keyed on
	// the nonce so picking the same row+action twice re-runs it.
	useEffect(() => {
		if (!perfActionRequest) {
			return;
		}
		if (perfActionRequest.action === 'analyze') {
			perfAnalyze(perfActionRequest.sql, perfActionRequest.connectionId);
		} else {
			perfOptimize(perfActionRequest.sql, perfActionRequest.connectionId);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [perfActionRequest?.nonce]);

	/** Start a fresh chat that auto-sends one prompt grounded on a connection (the fix-with-AI, Ask AI
	 *  and editor-action paths all come here): connect the target first if needed, reset the session,
	 *  then run the turn. Signed out, nothing runs and nothing connects: the request is HELD, the
	 *  sign-in panel says what it is waiting to do, and it runs once the user has signed in. Connecting
	 *  first is what made a failed connection's "Ask AI" loop: it retried the connection, which failed
	 *  again and raised the same error card, while the assistant could do nothing signed out. */
	function startGroundedChat(prompt: string, connectionId: string | undefined, about?: string): void {
		if (!signedIn) {
			setHeld({ prompt, connectionId, about });
			return;
		}
		setHeld(null);
		const id = crypto.randomUUID();
		if (connectionId && !connectedIds.includes(connectionId)) {
			void onConnect(connectionId);
		}
		setSessionId(id);
		setTokens(ZERO_TOKENS);
		createdAtRef.current = Date.now();
		setError(null);
		setInput('');
		setMessages([{ role: 'user', content: prompt }, { role: 'assistant', content: '' }]);
		void runTurn(prompt, [], connectionId, ZERO_TOKENS, id);
	}

	function perfDialect(connectionId: string): ReturnType<typeof dialectFor> {
		return dialectFor(connections.find((c) => c.id === connectionId)?.driver);
	}

	// Mark this chat as a query-optimization session for `sql`.
	function enterPerfSession(sql: string): void {
		setPerfSession(sql);
		perfSessionRef.current = sql;
	}

	// "Analyze": a fresh, grounded chat asking what the statement does and why it's heavy (no fix yet).
	function perfAnalyze(sql: string, connectionId: string): void {
		if (busy) {
			return;
		}
		enterPerfSession(sql);
		startGroundedChat(buildExplainQueryPrompt(sql, perfDialect(connectionId)), connectionId);
		setPerfAnalyzedSql(sql);
	}

	// "Suggest optimization": if we just analyzed THIS statement, continue that conversation so the
	// model builds on its own diagnosis; otherwise start fresh with the self-contained optimize prompt
	// (which already tells it to run EXPLAIN first), so going straight to a suggestion loses nothing.
	// Either way the prompt carries the engine's vendor-specific tuning levers (optimizationHints).
	function perfOptimize(sql: string, connectionId: string): void {
		if (busy) {
			return;
		}
		enterPerfSession(sql);
		if (perfAnalyzedSql === sql && messages.length > 0) {
			const followUp = buildOptimizeFollowUp(perfDialect(connectionId));
			const priorTurns = messages;
			setError(null);
			setInput('');
			setMessages((prev) => [...prev, { role: 'user', content: followUp }, { role: 'assistant', content: '' }]);
			void runTurn(followUp, priorTurns, groundConnId ?? connectionId, tokens, sessionId);
		} else {
			startGroundedChat(buildOptimizeQueryPrompt(sql, perfDialect(connectionId)), connectionId);
		}
	}

	// The surface draws BLOCKS; a conversation is what maps its messages onto them.
	// Everything optional on a RenderItem is this panel's own furniture, which is why an
	// agent console can leave all of it out.
	const items: RenderItem[] = messages.map((message, i) => {
		const assistant = message.role === 'assistant';
		const streaming = busy && i === messages.length - 1;
		return {
			id: String(i),
			variant: message.role,
			label: assistant ? ASSISTANT_NAME : "You",
			steps: assistant ? message.steps : undefined,
			attachments: assistant ? undefined : message.attachments,
			// A user turn is shown verbatim: what they typed is not a proposal to act on, so it never
			// becomes a SQL card with a Run button.
			blocks: assistant
				? blocksFromMarkdown(message.content, { pipeline: activeIsDocument })
				: (message.content ? [{ kind: 'prose' as const, text: message.content }] : []),
			actions: assistant && message.content.trim() !== '' && !streaming
				? (
					<button
						type="button"
						className="icon-btn chat-copy"
						title={copiedIndex === i ? "Copied" : "Copy this reply"}
						aria-label="Copy this reply"
						onClick={() => copyReply(i, message.content)}
					>
						<Icon name={copiedIndex === i ? 'check' : 'copy'} />
					</button>
				)
				: undefined,
			trailing: assistant && streaming
				? (
					<div className="chat-thinking">
						<Icon
							name={pendingApproval ? 'clock' : 'loading'}
							className={pendingApproval ? '' : 'codicon-modifier-spin'}
						/>
						{' '}{busyStatus(message.steps, Boolean(pendingApproval))}
					</div>
				)
				: undefined,
		};
	});

	return (
		<div className={`chat-panel${isFull ? ' chat-full' : ''}`} data-tour="ai-assistant">
			<div className="chat-header" data-liby="chat-header">
				{!isFull && <button className="icon-btn" aria-label="Collapse" onClick={onClose}><Icon name="chevron-right" /></button>}
				<span className="chat-title">{ASSISTANT_NAME}</span>
				{contextLabel && <span className="chat-context-chip" title={`${ASSISTANT_NAME} sees the ${contextLabel} you have open.`}><Icon name="eye" /> {contextLabel}</span>}
				<span className="spacer" />
				{signedIn && activeConnectionId && (
					<button className={`icon-btn chat-knows${knowledgeOpen ? ' active' : ''}`} aria-label="What I know about this database" onClick={() => setKnowledgeOpen((o) => !o)}>
						<Icon name="lightbulb" />{knownCount > 0 && <span className="chat-knows-count">{knownCount}</span>}
					</button>
				)}
				<button className="icon-btn" aria-label="New chat" onClick={newChat}><Icon name="add" /></button>
				<button className="icon-btn" aria-label="Chat history" onClick={() => setHistoryOpen(true)}><Icon name="history" /></button>
				<button className="icon-btn" aria-label="AI settings" onClick={onOpenSettings}><Icon name="gear" /></button>
				{onToggleFull && (
					<button className="icon-btn chat-full-toggle" aria-label={isFull ? "Exit full screen" : "Full screen"} aria-pressed={isFull} onClick={onToggleFull}>
						<Icon name={isFull ? 'screen-normal' : 'screen-full'} />
					</button>
				)}
			</div>
			{knowledgeOpen && activeConnectionId && (
				<KnowledgePopover
					connectionId={activeConnectionId}
					connectionLabel={activeConnLabel()}
					onClose={() => setKnowledgeOpen(false)}
					onChanged={() => void refreshKnownCount()}
				/>
			)}
			{!signedIn && authRestoring ? (
				<div className="chat-signin-skeleton" aria-busy="true" aria-label="Restoring your account">
					<div className="chat-skeleton-line chat-skeleton-art" />
					<div className="chat-skeleton-line chat-skeleton-title" />
					<div className="chat-skeleton-line chat-skeleton-body" />
					<div className="chat-skeleton-line chat-skeleton-body" />
					<div className="chat-skeleton-line chat-skeleton-body short" />
					<div className="chat-skeleton-line chat-skeleton-button" />
				</div>
			) : !signedIn ? (
				<div className="chat-signin" data-test="chat-signin">
					<AssistantArt className="chat-signin-art" />
					{held ? (
						<>
							<div className="chat-signin-title">Sign in and {ASSISTANT_NAME} will take it from here</div>
							<div className="muted small">It is ready to look at this for you. Sign in and it starts right away.</div>
							{held.about && <div className="chat-signin-held" data-test="chat-signin-held"><Icon name="error" /> <span>{held.about}</span></div>}
						</>
					) : (
						<>
							<div className="chat-signin-title">{ASSISTANT_NAME}, one assistant for your data and the Studio</div>
							<div className="muted small">Sign in to have it write SQL, find answers in your databases, and set up connections, monitors, data flows and settings for you.</div>
						</>
					)}
					<div className="chat-signin-actions">
						<button type="button" onClick={onOpenAccount}><Icon name="account" /> Sign in</button>
						{held && <button type="button" className="secondary" onClick={() => setHeld(null)}><Icon name="close" /> Not now</button>}
					</div>
				</div>
			) : (
			<>
			{perfSession && (
				<div className="chat-mode-banner" title="This chat is dedicated to optimizing one statement. Start a new chat for anything else.">
					<Icon name="dashboard" className="chat-mode-icon" />
					<div className="chat-mode-text">
						<div className="chat-mode-title">Query optimization</div>
						<div className="muted small">Tuned for this one statement. Start a new chat for other questions.</div>
					</div>
					<button type="button" className="chat-mode-new" title="New chat" onClick={newChat}><Icon name="add" /> New chat</button>
				</div>
			)}
			{dataAccess === null && (
				<div className="chat-data-access" role="group" aria-labelledby="chat-data-access-title">
					<div className="chat-data-access-head">
						<Icon name="shield" className="chat-plan-hint-icon" />
						<div className="chat-plan-hint-text">
							<div id="chat-data-access-title" className="chat-data-access-title">What may the AI see of your data?</div>
							<div className="muted">The less it sees, the more generic its answers about your data.</div>
						</div>
					</div>
					<div className="chat-data-access-options">
						{DATA_ACCESS_LEVELS.map((level) => (
							<button key={level} type="button" className="chat-data-access-option" onClick={() => void chooseDataAccess(level)}>
								<span className="chat-data-access-label">{DATA_ACCESS_INFO[level].label}</span>
							</button>
						))}
					</div>
				</div>
			)}
			{dataAccessChosen && (
				<div className="chat-plan-hint" role="status">
					<Icon name="check" className="chat-plan-hint-icon" />
					<div className="chat-plan-hint-text">
						Saved. You can change it anytime in AI settings.
					</div>
					<button type="button" className="chat-plan-hint-cta" onClick={onOpenSettings}><Icon name="settings-gear" /> Open settings</button>
					<button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setDataAccessChosen(null)}><Icon name="close" /></button>
				</div>
			)}
			{tier === 'free' && !planHintDismissed && !isFull && dataAccess !== null && !dataAccessChosen && (
				<div className="chat-plan-hint">
					<Icon name="sparkle" className="chat-plan-hint-icon" />
					<div className="chat-plan-hint-text">
						You're on the free plan, which has a monthly AI allowance. Paid plans have more, across every model.
					</div>
					<button type="button" className="chat-plan-hint-cta" onClick={onOpenAccount}><Icon name="credit-card" /> View plans</button>
					<button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setPlanHintDismissed(true)}><Icon name="close" /></button>
				</div>
			)}
			<RenderSurface
				items={items}
				insertTargets={renderConfig.insertTargets}
				connectionLabel={activeConnLabel()}
				runs={runs}
				onInsertSql={onInsertSql}
				onInsertSqlNewTab={onInsertSqlNewTab}
				onInsertPipeline={onInsertPipeline}
				onRunSql={runBlock}
				scrollRef={scrollRef}
				empty={(
					<div className="chat-empty">
						<GroundingArt grounded={Boolean(activeConn && activeConnected)} className="chat-empty-art" />
						<div className="muted small">{emptyHint()}</div>
					</div>
				)}
				header={import.meta.env.DEV && devSystemPrompt
					? (
						<details className="chat-dev-prompt" style={{ margin: '4px 8px', fontSize: 11, border: '1px solid var(--vscode-panel-border, #333)', borderRadius: 4 }}>
							<summary style={{ cursor: 'pointer', padding: '4px 6px', userSelect: 'none' }} title="Dev only: the exact context (schema + what you're looking at) sent to the model.">
								System prompt sent to model ({devSystemPrompt.length} chars)
							</summary>
							<pre style={{ margin: 0, padding: '6px 8px', maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{devSystemPrompt}</pre>
						</details>
					)
					: undefined}
				footer={<>
				{suggestion && (
					<div className="chat-approval knowledge-learned">
						<div className="chat-approval-head"><Icon name="lightbulb" /> Want me to remember this?</div>
						<div className="knowledge-learned-text">{suggestion.text}</div>
						<div className="muted small">I'll keep this in mind for “{activeConnLabel()}” so I get it right next time.</div>
						<div className="chat-approval-actions">
							<button type="button" onClick={() => void rememberSuggestion()}><Icon name="check" /> Remember</button>
							<button type="button" className="secondary" onClick={dismissSuggestion}>Not now</button>
						</div>
					</div>
				)}
				{pendingConnect && (
					<div className="chat-approval">
						<div className="chat-approval-head"><Icon name="plug" /> Connect to “{activeConn?.label ?? 'the database'}”?</div>
						<div className="muted small">It isn't connected. Connect so the assistant can read its schema and run read-only queries for an accurate, data-backed answer, or continue without a connection (general answers only, no live data).</div>
						<div className="chat-approval-actions">
							<button type="button" onClick={() => void connectThenSend()}><Icon name="plug" /> Connect</button>
							<button type="button" className="secondary" onClick={() => void sendRestricted()}>Continue without</button>
						</div>
					</div>
				)}
				{pendingApproval && pendingApproval.sql !== undefined && (
					<div className="chat-approval">
						<div className="chat-approval-head"><Icon name="play" /> The assistant wants to run a query</div>
						<pre>{pendingApproval.sql}</pre>
						<div className="chat-approval-actions">
							<button type="button" onClick={() => respondApproval(true)}><Icon name="play" /> Run</button>
							<button type="button" className="secondary chat-approval-always" onClick={() => respondApproval(true, true)} title={`Stop asking before running read-only queries on ${approvalConnLabel()}`}><Icon name="check-all" /> Always allow {approvalConnLabel()}</button>
							<button type="button" className="secondary" onClick={() => respondApproval(false)}><Icon name="debug-step-over" /> Skip</button>
						</div>
					</div>
				)}
				{pendingApproval && pendingApproval.sql === undefined && (
					<div className="chat-approval">
						<div className="chat-approval-head"><Icon name="play" /> The assistant wants to {pendingApproval.summary ?? "perform an action"}</div>
						<div className="chat-approval-actions">
							<button type="button" onClick={() => respondApproval(true)}><Icon name="check" /> Allow</button>
							<button type="button" className="secondary" onClick={() => respondApproval(false)}><Icon name="debug-step-over" /> Skip</button>
						</div>
					</div>
				)}
				{error && (
					<div className="chat-error">
						<div>{error}</div>
						{byokRetry && statuses.some((s) => s.provider === 'positron-cloud' && s.models.length > 0) && (
							<button type="button" onClick={() => void retryOnManaged()}><Icon name="refresh" /> Retry on managed credits</button>
						)}
						{isBudgetError(error)
							? <button type="button" className="secondary" onClick={onOpenAccount}><Icon name="credit-card" /> Manage plan</button>
							: <button type="button" className="secondary" onClick={onOpenSettings}><Icon name="settings-gear" /> Open AI settings</button>}
					</div>
				)}
				</>}
			/>
			{tokens.totalTokens > 0 && (
				<div className="chat-tokens" title="Tokens used in this chat (prompt + completion)">
					<Icon name="symbol-numeric" />
					<span>{tokens.totalTokens.toLocaleString()} tokens</span>
					<span className="muted">{tokens.promptTokens.toLocaleString()} in · {tokens.completionTokens.toLocaleString()} out</span>
				</div>
			)}
			<Splitter orientation="horizontal" onDrag={(_dx, dy) => onResizeComposer?.(dy)} />
			<div className="composer" style={composerHeight ? { flex: `0 0 ${composerHeight}px` } : undefined}>
				{attachments.length > 0 && (
					<div className="composer-attachments">
						{attachments.map((att, k) => (
							<AttachmentChip key={k} att={att} onRemove={() => setAttachments((prev) => prev.filter((_, i) => i !== k))} />
						))}
					</div>
				)}
				<textarea
					ref={composerRef}
					className="composer-input"
					value={input}
					placeholder={placeholder()}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
				/>
				<div className="composer-bar">
					{onSelectConnection && (
						<ConnectionPicker
							className="composer-conn"
							connections={connections}
							isConnected={(id) => connectedIds.includes(id)}
							value={activeConnectionId}
							onChange={(id) => { if (id) { onSelectConnection?.(id); } }}
							placeholder={connections.length === 0 ? "No connections" : "Choose a connection"}
							title={`Connection ${ASSISTANT_NAME} grounds on`}
						/>
					)}
					<span
						className={`dot${selectedStatus?.reachable ? ' on' : ''}`}
						title={selectedStatus?.detail ?? (selectedStatus?.reachable ? `${provider} ready` : provider)}
					>
						<Icon name="circle-filled" />
					</span>
					<ModelPicker
						models={pickerModels}
						current={current}
						onChange={(v) => void changeActive(v)}
						onOpen={() => void refreshStatuses()}
					/>
					<span className="spacer" />
					<button
						type="button"
						className="icon-btn composer-attach"
						aria-label={perfSession ? "Attachments are off in a query optimization chat. Start a new chat to attach a document." : "Attach a document (txt, md, csv, json; PDF and Word on Windows and macOS) as context"}
						onClick={() => void attachDocument()}
						disabled={attaching || busy || !renderConfig.allowAttach}
					>
						<Icon name={attaching ? 'loading' : 'attach'} className={attaching ? 'codicon-modifier-spin' : ''} />
					</button>
					<button
						type="button"
						className={busy ? 'composer-send stop' : 'composer-send'}
						title={busy ? "Stop" : "Send (Enter)"}
						onClick={() => { if (busy) { stop(); } else { void send(); } }}
						disabled={busy ? false : (!input.trim() && attachments.length === 0)}
					>
						<Icon name={busy ? 'stop-circle' : 'send'} />
					</button>
				</div>
			</div>
			</>
			)}
			{historyOpen && (
				<ChatHistoryModal
					currentId={sessionId}
					onLoad={loadSession}
					onClose={() => setHistoryOpen(false)}
				/>
			)}
		</div>
	);
}

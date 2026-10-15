/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';

import { GATEWAY_EMBED_MODEL, observerModelFor } from '../shared/ai';
import { OFFICIAL_BUILD } from '../shared/officialBuild';
import { BYOK_ANTHROPIC_MODELS, BYOK_PROVIDER_DEFAULTS, isByokProvider, isCompletionOnlyModel, isReasoningModel, supportsPromptCaching, usageWeightForCost, type AiAuditKind, type AiBudgetStatus, type AiCompletionOutcomeParams, type AiCompletionRecord, type AiEditParams, type AiModelInfo, type AiProviderId, type AiProviderStatus, type AiSettings, type AiToolEvent, type AmbientContext, type ByokProviderId, type ChatMessage, type CloudProviderId, type TokenUsage } from '../shared/ai';
import { getModelCatalog, isCompletionModel, preferredCompletionModel, type ModelMeta } from './modelCatalog';
import { getCloudClient } from './cloudClient';
import { readCreditBalance } from './creditBalance';
import { autoRunBlocker, backendKindForDriver, dataAccessAllows, dataAccessPromptNote, dataAccessRefusal, gateValuesResult, limitAmbient, resolveDataAccess, strictestDataAccess, type DataAccessLevel, buildAgentPrompt, buildAmbientComment, buildCompletionPrompt, buildCompletionUser, buildEditPrompt, buildEditUser, buildGlossaryBlock, buildHistoryComment, buildKnowledgeDraftPrompt, buildKnowledgeDraftUser, buildSchemaComment, buildSystemPrompt, buildTableUsage, buildToolSpecs, cleanKnowledgeDraft, engineAiDisplayName, editDecoyTables, completionFocus, extractCompletion, guardCompletion, partialIdentifier, inlineAttachments, runTool, type BackendKind, type ConnectionHandle, type NativeQuery, type ToolAuditRecord, type ToolContext } from '../shared/engine';
import type { DatabaseSchema } from '../shared/schema';
import { buildMongoTranscribePrompt, parseMongoPipeline } from './ai/transcribe';
import type { ConnectionManager } from './connectionManager';
import { agentActionDetail } from './agentActionDetail';
import { gateMonitorCall } from './monitorAgentGate';
import { editConnectionApproval, editTunnelApproval } from '../shared/connectionDestination';
import type { AiSettingsStore } from './aiSettingsStore';
import type { QueryStore } from './queryStore';
import type { AuditedExchange, AuditStore } from './auditStore';
import type { KnowledgeStore } from './knowledgeStore';
import { readTunnels } from './tunnelStore';
import type { KnowledgeNote } from '../shared/knowledge';
import type { ModelProvider } from './ai/modelProvider';
import { OllamaProvider } from './ai/ollamaProvider';
import { OpenAiProvider } from './ai/openaiProvider';
import { ScriptedProvider, type ScriptedReply } from './ai/scriptedProvider';
import { LoggingProvider } from './ai/loggingProvider';
import { setAiDebugEnabled } from './ai/debugLog';
import { isNetworkError, networkBlockedMessage, networkErrorDetail } from './netFetch';
import { benchmarkModels } from './ai/benchmarkModels';
import { runAgentLoop } from './ai/agent';
import type { CapabilityInvocation, CapabilityResult, CapabilitySpec } from '../shared/capabilities';
import { toToolSpec } from '../shared/capabilities';
import type { AiModelChoice, LibyChatRequest, ToolSpec } from '../shared/ai';
import type { ReviewMethod } from '../shared/review';

/** Default public API base for the gateway; overridable via settings['positron-cloud'].baseUrl. */
const CLOUD_BASE: Record<CloudProviderId, string> = {
	'positron-cloud': 'https://api.snoutdata.com/v1',
};

const CLOUD_LABEL: Record<CloudProviderId, string> = {
	'positron-cloud': 'SnoutData Cloud',
};

/** The gateway embeddings-model id used by {@link AiService.embed} and the vector flows:
 *  `mxbai-embed-large`, served by the gateway. */
const EMBEDDING_MODEL = GATEWAY_EMBED_MODEL;

// The gateway model the knowledge observer distills with. It fires on every SQL turn, so the official
// build names an inexpensive one as a build constant. A build from the open-source tree has none, and
// using the chat model there would be a hidden second call at full price per turn, so its observer is
// OFF unless the user names a model in Settings → AI (`behavior.observerModel`).
declare const __SNOUT_OBSERVER_MODEL__: string | undefined;
const OBSERVER_CLOUD_MODEL = typeof __SNOUT_OBSERVER_MODEL__ === 'string' ? __SNOUT_OBSERVER_MODEL__ : '';
/** A companion request is written by the renderer (@snout/liby), so it is bounded here: per text,
 *  and how many messages. */
const LIBY_MAX_CHARS = 12_000;
const LIBY_MAX_MESSAGES = 6;


/** Drop the obviously-non-chat ids from a provider's /models list (embeddings, audio, image,
 *  moderation, legacy base models), so a BYOK OpenAI key doesn't flood the picker with TTS and
 *  embedding models. Conservative: anything not matching a known non-chat marker is kept. */
function isLikelyChatModel(model: string): boolean {
	return !/embedding|whisper|tts|audio|dall-?e|image|moderation|rerank|babbage|davinci|realtime|transcribe/i.test(model);
}

/** What the chat needs from the renderer beyond plain text: tool-step notifications and a
 *  way to ask the user to approve a run_query before it executes. */
export interface ChatHooks {
	/** Each streamed text delta of the reply. */
	onDelta(text: string): void;
	/** A tool step (start/end) as the agent loop runs. */
	onTool(event: AiToolEvent): void;
	/** Ask the user to approve a run_query; resolves true to run it. `connectionId` lets the
	 *  card offer "Always allow" for that connection. */
	approve(sql: string, callId: string, connectionId: string): Promise<boolean>;
	/** Ask the user to approve a generic mutating renderer capability ("the assistant wants to
	 *  <summary>"). Resolves true to run it. */
	approveAction(summary: string, callId: string): Promise<boolean>;
	/** Run a renderer capability (a client-side tool) and return its result. */
	invokeClient(inv: CapabilityInvocation): Promise<CapabilityResult>;
	/** The renderer capabilities advertised for this turn (the manifest). */
	capabilities: CapabilitySpec[];
	/** Dev-only: the exact system-prompt message built for this turn (schema + ambient grounding),
	 *  emitted once before the model is called so a dev panel can show what was sent. Wired only in
	 *  unpackaged builds; undefined in production. */
	onSystemPrompt?(prompt: string): void;
}

/** A single-turn benchmark request: send one question through the real chat path, optionally
 *  overriding the provider+model so we can probe a specific benchmark model without touching
 *  the user's saved settings. Drives the dev-only /ai/benchmark endpoint (aiDebugServer.ts). */
export interface AiDebugChatRequest {
	question: string;
	/** Override the provider for this call (defaults to the saved chat provider). */
	provider?: AiProviderId;
	/** Override the model for this call (defaults to the provider's saved model). */
	model?: string;
	/** Connection to ground the prompt in (dialect + schema). Undefined ⇒ no schema. */
	connectionId?: string;
	/** Run the agent tool loop instead of one-shot Ask. Tool calls are auto-approved (dev). */
	agent?: boolean;
	/** Ambient "what you're looking at" context folded into the grounding block, exactly as the
	 *  live chat path does it. Defaults to none. The failure-memory bench harness uses this to inject
	 *  a `memoryNote` (the retrieved caution) for its memory-ON condition, so the prompt is byte-identical
	 *  to what live chat would send with that note — see src/main/failureMemoryBench.ts. */
	ambient?: AmbientContext;
	/** Force SQL mode even on a document (Mongo) connection. Live chat picks the surface from the
	 *  backend — a document connection gets the native-pipeline prompt, so the assistant proposes a
	 *  Mongo pipeline and never emits SQL. The failure-memory bench sets this for its Mongo
	 *  `unsupported-translation` scenarios: it drives the UNIVERSAL SQL-EDITOR surface (a developer
	 *  authoring SQL against Mongo), whose JOIN the deterministic SQL→Mongo compiler refuses — the only
	 *  path that exercises that error class. Defaults to false (backend picks the surface). */
	sqlMode?: boolean;
}

/** A single Ctrl+K edit sent through the real edit path (buildEditPrompt + buildEditUser),
 *  for prompt tuning. Empty `selection` ⇒ generate mode, mirroring the live widget. Drives
 *  the /ai/edit dev endpoint. */
export interface AiDebugEditRequest {
	/** The natural-language instruction (e.g. "fix this sql"). */
	instruction: string;
	/** The selected SQL to rewrite; empty/omitted ⇒ generate at the cursor. */
	selection?: string;
	/** The surrounding document; defaults to the selection when omitted. */
	document?: string;
	provider?: AiProviderId;
	model?: string;
	connectionId?: string;
}

/** The full, capturable outcome of one {@link AiDebugChatRequest} — system prompt included —
 *  so prompt tuning can see exactly what the model was asked and how it answered. */
export interface AiDebugChatResult {
	ok: boolean;
	provider: AiProviderId;
	model: string;
	dialect: string;
	connectionId?: string;
	agent: boolean;
	question: string;
	/** The exact system prompt sent (the same builder the live chat path uses). */
	systemPrompt: string;
	/** The model's reply (accumulated deltas; the final answer for an agent run). */
	reply: string;
	usage?: TokenUsage;
	/** Agent-loop tool steps, when `agent` was set. */
	toolEvents: AiToolEvent[];
	ms: number;
	error?: string;
}

/** A model that can't do tool calls (often a small local one) errors before streaming any
 *  text; recognise that so we can fall back to the one-shot path. */
function looksLikeToolUnsupported(err: unknown): boolean {
	const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return message.includes('tool') && (message.includes('support') || message.includes('not') || message.includes('unknown') || message.includes('400'));
}

/** Whether a provider error is the gateway's "monthly budget exhausted" signal — LiteLLM returns
 *  a 400 whose body mentions the budget (e.g. "ExceededBudget", "Budget has been exceeded"). Drives
 *  the fallback to the top-up (credits) key. Kept broad on purpose; verify the exact string against
 *  the live gateway. A 429 rate-limit is NOT a budget error. */
function isBudgetExceeded(err: unknown): boolean {
	const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return message.includes('budget') && !message.includes('rate limit');
}

/** The conversation an inline completion records in the audit log: the text around the
 *  cursor (tail of the prefix + head of the suffix), so the request is reviewable without
 *  storing the whole document. The store clips further if needed. */
function completionMessages(prefix: string, suffix: string): ChatMessage[] {
	const before = prefix.length > 2000 ? `…${prefix.slice(-2000)}` : prefix;
	const after = suffix.length > 500 ? `${suffix.slice(0, 500)}…` : suffix;
	const content = after ? `${before}⟪cursor⟫${after}` : `${before}⟪cursor⟫`;
	return [{ role: 'user', content }];
}

/** The conversation a Ctrl+K edit records: the instruction, plus the selection it was
 *  asked to rewrite (absent ⇒ generate at the cursor). */
function editMessages(params: AiEditParams): ChatMessage[] {
	const content = params.selection.trim()
		? `${params.instruction}\n\n--- selection ---\n${params.selection}`
		: params.instruction;
	return [{ role: 'user', content }];
}

/** What an inline edit ranks the schema against. Folds the selection + document into the
 *  focus, not just the instruction: "improve this" carries no table names, so without the
 *  selected SQL the involved tables would never rank into the detailed-DDL slice of the
 *  prompt. The text is only tokenised for lexical ranking, so including the document is cheap. */
function editFocus(params: AiEditParams): string {
	return [params.instruction, params.selection, params.document].filter((s) => s.trim()).join('\n');
}

/** Always appended to the system prompt: a brief plan-before-answering nudge. A prompt-level
 *  instruction rather than a provider reasoning flag, so it works with any BYO model — local
 *  or cloud — without special-casing a backend. */
const THINKING_INSTRUCTION = 'Think step by step before answering. First reason through the request in a brief "Reasoning:" section — restate the goal, identify the relevant tables and columns, and note edge cases or ambiguities — then give your final answer and SQL.';

/** Inline completion fires (debounced) on keystrokes against a small code model over two
 *  network hops, so its prompt must stay tiny — a fraction of the chat schema budget — or
 *  first-token latency makes the ghost text useless. These cap the schema grounding for the
 *  completion path only (chat/edit keep the user's larger {@link AiSettings} budget). */
const COMPLETION_MAX_SCHEMA_CHARS = 3000;
const COMPLETION_TOP_TABLES = 6;
/** How many of a connection's most-recent queries to scan for table-usage ranking (A5). Bounds
 *  the per-turn parse; the recent tail is the relevant signal for what the user works on now. */
const USAGE_HISTORY_LIMIT = 300;
/** Abort an inline completion that outruns this budget. Generous (cold model loads are slow)
 *  but bounded, so a stalled request can't pin a connection open indefinitely. */
const COMPLETION_TIMEOUT_MS = 20000;

/** Abort reason for a completion we abandoned because a newer cursor arrived. Distinguishes our
 *  own supersede from a real failure, so it is neither surfaced nor audited. */
const SUPERSEDED_COMPLETION = 'superseded-completion';

/**
 * Orchestrates the assistant: picks the configured ModelProvider, grounds the
 * conversation in the active connection's dialect + cached schema, and streams the
 * reply. Mirrors how the rest of the app stays vendor-neutral behind a seam.
 */
/**
 * Resolving a review's local rung to something that can be asked for prose.
 *
 * Only a build with Data Flows has one (its local runtime is what runs the model); without it the
 * rung is not offered, and a repository already set to it is refused with a sentence saying so.
 * `ok: false` carries a sentence for the USER naming the fix (that no model has been downloaded yet,
 * and where to get one), never a stack trace: the same contract the flow reader's model resolution
 * keeps, and for the same reason, since it is the same two backends underneath.
 */
export type LocalProseResolver = (method: ReviewMethod) =>
	| { ok: true; label: string; model: string; providerId: AiProviderId; ask(request: { system: string; user: string; signal?: AbortSignal }): Promise<string> }
	| { ok: false; because: string };

export class AiService {
	/** Which interaction kinds the user wants recorded (mirrors Settings → AI Audit). Empty
	 *  until the renderer pushes the setting on launch (no AI call can happen before then). */
	private auditKinds = new Set<AiAuditKind>();
	/** Whether audit logging is permitted. No longer plan-gated (every tier, signed in or not),
	 *  so this starts true and the auth state only ever re-affirms it; recording is now decided
	 *  by the user's own preference, i.e. the kind being in {@link auditKinds}. */
	private auditAllowed = true;
	/** Whether the user's tier permits Agentic mode (Plus+). Set from the auth state on launch
	 *  and on every auth change, so signing out (or a downgrade) falls back to one-shot Ask
	 *  even if the agent setting is still on. */
	private agentAllowed = false;
	/** Whether the user's tier permits Bring-Your-Own-Key (Plus+). Set from the auth state on
	 *  launch and on every auth change, so signing out (or a downgrade) disables routing the
	 *  assistant at the user's own provider key. Enforced in {@link rawProvider}, not just the
	 *  settings UI — the panel can be bypassed by editing local state. */
	private byokAllowed = false;
	/** Whether someone is signed in. The assistant is account-gated: every model call (chat,
	 *  completion, edit) goes through our gateway with the user's minted key, so a signed-out
	 *  request has no key and must be refused up front with a clear message. Set from the auth
	 *  state on launch and on every change. */
	private signedIn = false;
	/** E2E only: a model that answers from a script. Null in every real build — see
	 *  {@link installScriptedModel}. */
	private scriptedModel: ScriptedProvider | null = null;
	/** E2E only, beside the scripted model: what the picker lists and what the account page reads,
	 *  so a screenshot shows a believable account rather than "no models". */
	private scriptedAccount: { models: AiModelInfo[]; completionModels: AiModelInfo[]; budget: AiBudgetStatus | null } | null = null;
	/** How a review's two LOCAL rungs are reached. Set from main's wiring, where the extraction
	 *  model's settings and components live. See {@link localCommentary}. */
	private localProse: LocalProseResolver | null = null;
	/** Dev blackbox logging: when on, every provider round-trip is wrapped + recorded (full
	 *  system prompt + reply + usage) to aiDebug.jsonl. Off in production. */
	private debugEnabled = false;
	/** The user's wallet→credits switch. When false, the assistant pauses
	 *  at the monthly limit; when true, it falls back to the persistent top-up (credits) key once
	 *  the monthly wallet is exhausted. Set from `ai_preferences` on auth changes and when the user
	 *  flips the toggle. Default false (explicit opt-in to spend real money). */
	private creditsEnabled = false;
	/** Cached per-model gateway prices (USD per 1M input/output tokens), keyed by model id. Warmed
	 *  as a side effect of {@link providerStatus} (which the renderer calls on load), so the chat
	 *  path never fetches prices itself — keeping per-turn cost estimation off the latency budget.
	 *  Empty until the first providerStatus; then a turn's {@link record} can stamp an estimated
	 *  `costUsd`. */
	private modelPrices = new Map<string, { inputPerMTok: number; outputPerMTok: number }>();
	/** The inline completion currently in flight, so a newer cursor can abandon it. Inline
	 *  completion is strictly single-flight: an older answer is never wanted once the cursor moves. */
	private completionAbort: AbortController | null = null;

	constructor(
		private readonly settings: AiSettingsStore,
		private readonly connections: ConnectionManager,
		private readonly queries: QueryStore,
		private readonly audit: AuditStore,
		private readonly knowledge: KnowledgeStore,
		/** The control plane's model catalog. A seam only so a test can see whether it was read; every
		 *  real caller takes the default. */
		private readonly readCatalog: () => Promise<Map<string, ModelMeta>> = getModelCatalog,
	) {}

	/** Set which interaction kinds are recorded (mirrors the per-kind Settings → AI Audit toggles). */
	setAuditKinds(kinds: AiAuditKind[]): void {
		this.auditKinds = new Set(kinds);
	}

	/** Mirror entitlements.aiLogging (true for every tier today). Independent of the user's
	 *  on/off preference: both must be true for an interaction to be logged. */
	setAuditAllowed(allowed: boolean): void {
		this.auditAllowed = allowed;
	}

	/** Gate the agent tool loop on the user's tier (entitlements.agentMode). When false, chat
	 *  always takes the one-shot path even if the agent setting is on. */
	setAgentAllowed(allowed: boolean): void {
		this.agentAllowed = allowed;
	}

	/** Gate Bring-Your-Own-Key on the user's tier (entitlements.byok). When false, a BYOK
	 *  provider can't be used to serve a model even if it's selected (rawProvider enforces it). */
	setByokAllowed(allowed: boolean): void {
		this.byokAllowed = allowed;
	}

	/** Record whether a user is signed in; gates every model call (the assistant is
	 *  account-only — no signed-out access to the gateway). */
	setSignedIn(signedIn: boolean): void {
		this.signedIn = signedIn;
	}

	/** Whether a model call could be made at all right now. Cheap and local (it is the same gate
	 *  {@link requireSignedIn} enforces), never a network probe — the flow runner asks BEFORE it
	 *  opens a destination, so a signed-out run refuses cleanly instead of failing one batch in. */
	canCallModel(): boolean {
		return this.signedIn;
	}

	/**
	 * E2E ONLY: answer every model call from a script (see `ai/scriptedProvider.ts`). Installed by
	 * the main-process e2e hook, which exists only under the scratch profile. A scratch profile can
	 * never be signed in, so this stands in for that too — the point is to test everything AROUND
	 * the model, not to bypass the account gate in a real build.
	 */
	installScriptedModel(replies: ScriptedReply[] | null): void {
		this.scriptedModel = replies === null ? null : new ScriptedProvider(replies);
		this.signedIn = this.scriptedModel !== null;
	}

	/** E2E only: the model list and plan usage presented while the scripted model is installed. */
	installScriptedAccount(account: { models: AiModelInfo[]; completionModels: AiModelInfo[]; budget: AiBudgetStatus | null } | null): void {
		this.scriptedAccount = account;
	}

	/** What the scripted model has been asked, in order. Empty in every real build. */
	scriptedPrompts(): { system: string; user: string; messages: { role: string; content: string }[] }[] {
		return this.scriptedModel?.prompts ?? [];
	}

	/** The fill-in-the-middle requests the scripted model has been given (inline completion sends
	 *  the editor's own text, so a test has to be able to read what left). Empty in a real build. */
	scriptedFim(): { prefix: string; suffix: string }[] {
		return this.scriptedModel?.fimRequests ?? [];
	}

	/** Set the wallet→credits switch. Drives whether the chat path falls
	 *  back to the top-up (credits) key when the monthly wallet is exhausted. */
	setCreditsEnabled(enabled: boolean): void {
		this.creditsEnabled = enabled;
	}

	/** Guard a model call on being signed in. The renderer also hides the composer when
	 *  signed out, so this is the defensive backstop (e.g. inline completion / a direct IPC). */
	private requireSignedIn(): void {
		if (!this.signedIn) {
			throw new Error('Sign in to use the AI assistant. Open Account to sign in (it\'s free).');
		}
	}

	/** Turn dev blackbox round-trip logging on or off. Main enables it in dev, never in a
	 *  packaged build; it both wraps providers with {@link LoggingProvider} and flips
	 *  the logger module's own gate. */
	setDebugEnabled(enabled: boolean): void {
		this.debugEnabled = enabled;
		setAiDebugEnabled(enabled);
	}

	/**
	 * Stream a reply to `history`, grounded in the given active connection. When agent mode
	 * is on and a schema is connected, runs the tool loop ({@link runAgentLoop}) so the
	 * model can inspect the DB and (with approval) run read-only queries; otherwise — or
	 * when the model can't do tool calls — uses the one-shot, schema-grounded path. Resolves
	 * with the turn's summed token usage; `signal` stops it mid-flight.
	 */
	async chat(history: ChatMessage[], activeConnectionId: string | undefined, hooks: ChatHooks, signal?: AbortSignal, ambient: AmbientContext = {}): Promise<{ usage?: TokenUsage; responseId?: string }> {
		this.requireSignedIn();
		const stored = this.settings.get();
		// What the AI may see of the active database (its own setting, else Settings → AI). Tools that
		// hand the model values it does not allow are left out, so the model is never offered one.
		const level = this.dataLevel(stored, activeConnectionId);
		const settings = this.withDataAccess(stored, level);
		hooks = { ...hooks, capabilities: hooks.capabilities.filter((c) => !dataAccessRefusal(c.name, level)) };
		const { providerId, model } = this.chatTarget(settings);
		const provider = this.buildProvider(settings, providerId, model);
		const { dialect, schema, kind } = await this.context(activeConnectionId);
		const documentMode = kind === 'document';
		// Failure memory: if the query the user is looking at is structurally similar to one that
		// failed before on this schema, ground the turn with a caution. Best-effort and off the
		// critical path — a null just means no relevant memory. Merged into `ambient` so it reaches
		// every prompt-build site (one-shot and agent) unchanged.
		if (activeConnectionId) {
			const query = ambient.selection?.trim() || ambient.editorBuffer?.trim();
			if (query) {
				const memoryNote = await this.connections.retrieveFailureNote(activeConnectionId, query);
				if (memoryNote) {
					ambient = { ...ambient, memoryNote };
				}
			}
		}
		// Every turn is agentic (the Ask/Agentic switch was retired 2026-10-09); only the
		// entitlement gate can turn the tool loop off. DB tools need a connected schema; renderer
		// capabilities (the chat driving the app) don't, so the loop runs when EITHER is available.
		const agentic = this.agentAllowed;
		// Advertise the DB tools whenever a connection is SELECTED, even if it isn't connected yet:
		// the tool executor connects on demand (with the user's approval) on first use. The schema
		// may be absent until then — the model uses list_tables/describe_table to learn it.
		const hasConnection = activeConnectionId !== undefined;
		const dbSpecs = agentic && hasConnection ? buildToolSpecs(settings.tools, true, documentMode) : [];
		const clientSpecs = agentic ? this.clientToolSpecs(hooks.capabilities, dbSpecs) : [];
		const allSpecs: ToolSpec[] = [...dbSpecs, ...clientSpecs];
		const useTools = agentic && allSpecs.length > 0;

		// Track whether anything streamed: a tool-unsupported error only warrants the
		// one-shot fallback if it happened before the model produced any text. Accumulate
		// the reply too, so the audit log keeps the full exchange.
		let streamed = false;
		let reply = '';
		const onDelta = (text: string): void => { streamed = true; reply += text; hooks.onDelta(text); };
		const startedAt = Date.now();

		// For the audit log: capture the exact grounding prompt the model is fed (schema + the
		// ambient "what you're looking at" block), but only build it when chat recording is on, so
		// it costs nothing otherwise. Same inputs as the live turn, so it matches what was sent.
		// The exact system message this turn will send. Built when chat recording is on (for the
		// audit log) OR when a dev system-prompt panel is listening — same inputs as the live turn,
		// so it matches byte-for-byte. Costs nothing when neither is active.
		const systemPrompt = (this.recordingEnabled('chat') || !!hooks.onSystemPrompt)
			? this.buildChatMessages(history, dialect, schema, settings, useTools, ambient, activeConnectionId, documentMode)[0].content
			: undefined;
		if (systemPrompt && hooks.onSystemPrompt) {
			hooks.onSystemPrompt(systemPrompt);
		}
		const auditPrompt = this.recordingEnabled('chat') ? systemPrompt : undefined;

		// One full attempt with a given provider (agent loop, with a one-shot fallback for models
		// that can't do tool calls). Factored out so we can retry the whole turn on the top-up
		// (credits) key if the monthly wallet is exhausted — see the budget fallback below.
		const attempt = async (p: ModelProvider): Promise<{ usage?: TokenUsage; responseId?: string }> => {
			if (useTools) {
				try {
					return await this.runAgent(p, history, activeConnectionId, dialect, schema, settings, allSpecs, onDelta, hooks, signal, ambient, documentMode);
				} catch (err) {
					if (!streamed && looksLikeToolUnsupported(err)) {
						return await this.oneShot(p, history, dialect, schema, settings, onDelta, signal, ambient, activeConnectionId, documentMode);
					}
					throw err;
				}
			}
			return await this.oneShot(p, history, dialect, schema, settings, onDelta, signal, ambient, activeConnectionId, documentMode);
		};

		try {
			let result: { usage?: TokenUsage; responseId?: string };
			try {
				result = await attempt(provider);
			} catch (err) {
				// The monthly wallet is exhausted. If the user opted into spending credits and has a
				// top-up key, retry the whole turn once on it — but only when nothing streamed yet
				// (fail-fast, never mid-stream). Otherwise surface the paused/limit error as before.
				const topup = !streamed && this.creditsEnabled && isBudgetExceeded(err) ? this.buildTopupProvider(settings, providerId, model) : undefined;
				if (!topup) {
					throw err;
				}
				result = await attempt(topup);
			}
			this.record('chat', providerId, model, activeConnectionId, history, reply, startedAt, { ok: true, usage: result.usage }, auditPrompt);
			// BYOK prompts go straight to the user's provider — we never see them, so there's no
			// gateway response to attach a reward signal to. Drop the id so the renderer reports no
			// outcome (the join key it pings against). Audit logging stays on; it's client-side.
			return isByokProvider(providerId) ? { usage: result.usage } : result;
		} catch (err) {
			const explained = this.explain(err, settings, providerId);
			// A user-stopped stream isn't a failure — keep the partial reply, no error.
			const aborted = signal?.aborted === true;
			this.record('chat', providerId, model, activeConnectionId, history, reply, startedAt, { ok: aborted, error: aborted ? undefined : explained.message }, auditPrompt);
			throw explained;
		}
	}

	/**
	 * Single-turn benchmark: send one question through the real chat path (the same prompt
	 * builders + provider seam the live assistant uses), optionally overriding the
	 * provider+model, and return the full exchange — system prompt included — so we can see
	 * exactly what a model was asked and how it answered. Backs the /ai/benchmark dev
	 * endpoint. Never throws: a provider failure comes back as `{ ok: false, error }`.
	 */
	async debugChat(req: AiDebugChatRequest): Promise<AiDebugChatResult> {
		const stored = this.settings.get();
		const settings = this.withDataAccess(stored, this.dataLevel(stored, req.connectionId));
		const providerId = req.provider ?? settings.provider;
		const model = req.model ?? this.modelFor(settings, providerId);
		const { dialect, schema, kind } = await this.context(req.connectionId);
		const useTools = (req.agent ?? false) && !!schema && schema.tables.length > 0 && req.connectionId !== undefined;
		// The bench's `unsupported-translation` scenarios force SQL mode on a document backend to drive
		// the SQL-editor surface (see AiDebugChatRequest.sqlMode); otherwise the backend picks the surface.
		const documentMode = req.sqlMode ? false : kind === 'document';
		const history: ChatMessage[] = [{ role: 'user', content: req.question }];
		const messages = this.buildChatMessages(history, dialect, schema, settings, useTools, req.ambient ?? {}, req.connectionId, documentMode);
		const systemPrompt = messages[0].content;
		const toolEvents: AiToolEvent[] = [];
		let reply = '';
		const onDelta = (text: string): void => { reply += text; };
		const startedAt = Date.now();
		try {
			const provider = this.buildProvider(settings, providerId, model);
			let usage: TokenUsage | undefined;
			if (useTools && schema && req.connectionId) {
				const toolSpecs = buildToolSpecs(settings.tools, true, documentMode);
				const connectionId = req.connectionId;
				const ctx: ToolContext = {
					schema,
					dialect,
					settings: settings.tools,
					documentMode,
					execute: (sql) => this.connections.executeRead(connectionId, sql),
					executeNative: (query) => this.connections.executeNative(connectionId, query),
					// Auto-approve run_query: this is a dev tuning path with no interactive UI, and
					// run_query is read-only-enforced. Don't point a benchmark at production.
					approve: () => Promise.resolve(true),
					emit: (event) => toolEvents.push(event),
				};
				usage = (await runAgentLoop(provider, messages, toolSpecs, (call) => runTool(call, ctx), { onDelta }, settings.tools.maxSteps)).usage;
			} else {
				usage = (await provider.chat(messages, { onDelta })).usage;
			}
			return { ok: true, provider: providerId, model, dialect, connectionId: req.connectionId, agent: useTools, question: req.question, systemPrompt, reply, usage, toolEvents, ms: Date.now() - startedAt };
		} catch (err) {
			return { ok: false, provider: providerId, model, dialect, connectionId: req.connectionId, agent: useTools, question: req.question, systemPrompt, reply, toolEvents, ms: Date.now() - startedAt, error: this.explain(err, settings, providerId).message };
		}
	}

	/** The models the dev benchmark compares: the build's own list, or the saved chat model. */
	benchmarkModels(): AiModelChoice[] {
		const settings = this.settings.get();
		return benchmarkModels({ provider: settings.provider, model: this.modelFor(settings, settings.provider) });
	}

	/** Run one question across every {@link benchmarkModels} entry, sequentially (Ollama is
	 *  local — parallel calls would just thrash it). Returns one result per model. */
	async benchmark(req: Omit<AiDebugChatRequest, 'provider' | 'model'>): Promise<AiDebugChatResult[]> {
		const results: AiDebugChatResult[] = [];
		for (const choice of this.benchmarkModels()) {
			results.push(await this.debugChat({ ...req, provider: choice.provider, model: choice.model }));
		}
		return results;
	}

	/** Send one Ctrl+K edit through the real edit prompt (buildEditPrompt + buildEditUser),
	 *  returning the exact system prompt + reply. Faithful to {@link edit} — the same builder,
	 *  focus, and fence-stripping — so prompt tuning sees what the widget would. */
	async debugEdit(req: AiDebugEditRequest): Promise<AiDebugChatResult> {
		const settings = this.settings.get();
		const providerId = req.provider ?? settings.provider;
		const model = req.model ?? this.modelFor(settings, providerId);
		const { dialect, driverId, schema } = await this.context(req.connectionId);
		const selection = req.selection ?? '';
		const document = req.document ?? selection;
		const mode = selection.trim() ? 'edit' : 'generate';
		const params: AiEditParams = { connectionId: req.connectionId, instruction: req.instruction, selection, document };
		const systemPrompt = buildEditPrompt(dialect, schema, {
			driverId,
			maxSchemaChars: settings.behavior.maxSchemaChars,
			topTables: settings.behavior.topTables,
			instructions: settings.behavior.instructions,
			focus: editFocus(params),
			excludeTables: editDecoyTables(selection, schema),
			tableUsage: this.tableUsage(req.connectionId),
		}, mode);
		const user = buildEditUser(params.instruction, selection, document, mode, schema);
		let reply = '';
		const startedAt = Date.now();
		try {
			const provider = this.buildProvider(settings, providerId, model);
			const usage = (await provider.chat([{ role: 'system', content: systemPrompt }, { role: 'user', content: user }], { onDelta: (t) => { reply += t; } })).usage;
			return { ok: true, provider: providerId, model, dialect, connectionId: req.connectionId, agent: false, question: req.instruction, systemPrompt, reply: extractCompletion(reply, ''), usage, toolEvents: [], ms: Date.now() - startedAt };
		} catch (err) {
			return { ok: false, provider: providerId, model, dialect, connectionId: req.connectionId, agent: false, question: req.instruction, systemPrompt, reply, toolEvents: [], ms: Date.now() - startedAt, error: this.explain(err, settings, providerId).message };
		}
	}

	/** Run one edit across every {@link benchmarkModels} entry, sequentially. */
	async benchmarkEdit(req: Omit<AiDebugEditRequest, 'provider' | 'model'>): Promise<AiDebugChatResult[]> {
		const results: AiDebugChatResult[] = [];
		for (const choice of this.benchmarkModels()) {
			results.push(await this.debugEdit({ ...req, provider: choice.provider, model: choice.model }));
		}
		return results;
	}

	/** Build the system+history messages for a chat turn — the single place the prompt is
	 *  assembled, so the one-shot path, the agent path, and the debug/benchmark path can't
	 *  drift. `useTools` picks the agent prompt (tool protocol) over the one-shot prompt. */
	private buildChatMessages(history: ChatMessage[], dialect: string, schema: DatabaseSchema | null, settings: AiSettings, useTools: boolean, ambient: AmbientContext = {}, connectionId?: string, documentMode = false): ChatMessage[] {
		// What the AI may see (engine/context/dataAccess.ts): values the level does not allow are taken
		// out HERE, the one place every chat prompt is assembled, so no path can send them by accident.
		const dataLevel = this.dataLevel(settings, connectionId);
		ambient = limitAmbient(ambient, dataLevel);
		const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content;
		// The connection's knowledge base: enabled notes only, bucketed into always-injected
		// glossary + per-table notes + pinned tables. Null with no connection.
		const kb = connectionId ? this.knowledge.notesFor(connectionId) : null;
		const opts = {
			// The active connection's driver id: selects the dialect whose identifier-quoting is applied
			// to reserved-word table/column names in the rendered schema (so the model copies `"order"` /
			// `` `order` `` / `[order]` rather than emitting a bare reserved word — a syntax error).
			driverId: connectionId ? this.connections.state().connections.find((c) => c.id === connectionId)?.driver : undefined,
			// Document (MongoDB) backend: propose a native ```json aggregation pipeline, not ```sql
			// Only the final-answer framing changes; schema grounding is shared.
			documentMode,
			maxSchemaChars: settings.behavior.maxSchemaChars,
			topTables: settings.behavior.topTables,
			instructions: settings.behavior.instructions,
			// Rank the schema by what the user actually queries (their history on this connection),
			// not just lexical relevance — so the detailed-schema budget skips tables they never
			// touch (smart selection before token caps).
			tableUsage: this.tableUsage(connectionId),
			// Rank the schema by relevance to the last user message AND the SQL the user is
			// looking at on screen (the editor buffer + selection). The question alone often
			// carries no table names ("optimize this", "why is this slow"), so without the
			// on-screen SQL the involved tables never rank into the detailed-DDL slice. Same
			// trick `editFocus()` uses for Ctrl+K edits; the text is only tokenised for lexical
			// ranking, so folding it in is cheap.
			// Fold the open table's name in too (B1): when the user is on a table-view tab there's
			// no editor buffer, so its name is the only signal that ranks that table's detailed DDL
			// into the schema slice for "what columns does this have" / "add an index here".
			// Fold the active surface's table/object name in too (B1): on a table/object tab there's
			// no editor buffer, so the name is the only signal that ranks its detailed DDL into the
			// schema slice. Other (background) tabs are NOT folded here — they ride the ambient block
			// but shouldn't skew the ranking toward tables the user isn't actively looking at.
			focus: [lastUser, ambient.selection, ambient.editorBuffer, ambient.focusedTable?.name, ambient.focusedObject?.name].filter((s) => s && s.trim()).join('\n') || undefined,
			// Full-screen AI Chat: when the ask is a chart, render it and skip the raw SQL block.
			chartNoSql: ambient.surface === 'full',
			// A results grid is on screen everywhere EXCEPT full-screen chat: a run_query the agent runs
			// surfaces its rows there, so the model must not re-print the table (it would show twice).
			gridInView: ambient.surface !== 'full',
			// A connection is selected but not connected yet (so no schema is loaded): tell the agent
			// prompt its tools still work and the first call will ask the user to connect.
			connectionPending: useTools && connectionId !== undefined && (!schema || schema.tables.length === 0),
			// The user was asked to connect the selected database and declined (the renderer gates this
			// up front, before we're ever called): no connection is passed, so answer generally and
			// tell the user precise/data-backed answers need a connection — never fake data.
			dbRestricted: ambient.dbAccess === 'restricted',
			// No connection is selected and more than one is connected (renderer's `ambiguousDb`): the
			// dialect can't be inferred, so list the connected DBs + their dialects and have the prompt
			// ask the user which they mean rather than guess. Dialect resolved here (where dialectFor
			// lives), mirroring context(): document backends show "MongoDB", relational the vendor name.
			ambiguousConnections: ambient.dbAccess === 'ambiguous' ? this.connectedDialects() : undefined,
			// Knowledge-base table/column notes: rendered as trailing `-- NOTE:` comments on the
			// detailed schema lines, and a pinned note force-includes its table into the detailed
			// slice even when the question never lexically matched it.
			notesByTable: kb?.byTable,
			pinnedTables: kb?.pinnedTables,
			// The same glossary, put to a second use: widening the QUESTION during schema linking, so
			// a table whose name shares no word with what the user asked can still be found. It is
			// what this app has instead of an embedding model on the way to every prompt.
			vocabulary: kb?.glossary.map((note) => note.text),
		};
		const base = useTools ? buildAgentPrompt(dialect, schema, opts) : buildSystemPrompt(dialect, schema, opts);
		// The always-included glossary block (bucket A): the durable facts the user has taught the app
		// about this database. Placed right after the schema (connection-stable content, near where it's
		// relevant) and kept separate from opts.instructions so each stays independently sourced.
		const glossaryBlock = kb ? buildGlossaryBlock(kb.glossary) : '';
		// Staple on the live "what the user is looking at" block (the SQL on screen, result shape,
		// last error) so the assistant grounds in it without the user restating it — the spine of
		// the UX thesis (A1). Empty when nothing is on screen, so it adds zero cost to a cold chat.
		const ambientBlock = buildAmbientComment(ambient);
		const system = [base, glossaryBlock, ambientBlock, dataAccessPromptNote(dataLevel), THINKING_INSTRUCTION].filter(Boolean).join('\n\n');
		// Fold any attached documents into the user turn that carried them: their text is already
		// extracted + size-capped in main (a budget-bounded digest), so it goes straight into the
		// content the model sees. Reference material, framed as such — see documentDigest.ts.
		const folded = history.map((m) =>
			m.role === 'user' && m.attachments && m.attachments.length > 0
				? { ...m, content: inlineAttachments(m.content, m.attachments), attachments: undefined }
				: m,
		);
		return [{ role: 'system', content: system }, ...folded];
	}

	/** The tool loop: build the agent prompt + a tool executor. DB tools bind to the active
	 *  connection (when there is one); client capabilities round-trip to the renderer. The
	 *  connection may be absent — then only client capabilities are advertised, so the
	 *  connection-bound closures are never called. */
	private runAgent(
		provider: ModelProvider,
		history: ChatMessage[],
		connectionId: string | undefined,
		dialect: string,
		schema: DatabaseSchema | null,
		settings: AiSettings,
		toolSpecs: ToolSpec[],
		onDelta: (text: string) => void,
		hooks: ChatHooks,
		signal?: AbortSignal,
		ambient: AmbientContext = {},
		documentMode = false,
	): Promise<{ usage?: TokenUsage; responseId?: string }> {
		const messages = this.buildChatMessages(history, dialect, schema, settings, true, ambient, connectionId, documentMode);
		// Which model is driving this turn, recorded on each action so the audit shows what asked
		// for it. Same resolution chat() uses to pick the provider it handed us.
		const { providerId: auditProvider, model: auditModel } = this.chatTarget(settings);
		const noConnection = (): never => { throw new Error('No active connection.'); };
		// Re-introspect at most once per turn: the first authoritative schema lookup pays for a fresh
		// snapshot, later lookups in the same turn reuse it.
		let schemaRefreshed = false;
		// Handles for SECOND connections the model targets via a DB tool's `connection` argument, cached
		// per turn (by id) so repeat lookups reuse one freshened schema + once-per-turn refresh guard.
		const targetHandles = new Map<string, ConnectionHandle>();
		const ctx: ToolContext = {
			schema,
			dialect,
			driverId: connectionId ? this.connections.state().connections.find((c) => c.id === connectionId)?.driver : undefined,
			flavor: connectionId ? this.connections.state().connections.find((c) => c.id === connectionId)?.flavor : undefined,
			settings: settings.tools,
			// Connect-on-demand: when a DB tool fires against a selected-but-offline connection, ask
			// the user for permission, connect, and refresh ctx.schema so the schema tools have data.
			ensureConnected: connectionId
				? async () => {
					// Connect first if needed (asking the user). Then ALWAYS make sure the schema is
					// loaded — not only when WE did the connecting: the model may have connected via the
					// `connect` capability, or the turn may have started disconnected (schema null), in
					// which case a DB tool would otherwise see an empty schema ("no tables").
					if (!this.connections.state().connectedIds.includes(connectionId)) {
						const label = this.connections.state().connections.find((c) => c.id === connectionId)?.label ?? 'the database';
						const approved = hooks.approveAction ? await hooks.approveAction(`connect to ${label}`, `connect:${connectionId}`) : false;
						if (!approved) {
							return { ok: false, declined: true };
						}
						try {
							await this.connections.connect(connectionId);
						} catch (err) {
							return { ok: false, error: err instanceof Error ? err.message : String(err) };
						}
					}
					if (!ctx.schema || ctx.schema.tables.length === 0) {
						ctx.schema = (await this.connections.getSchema(connectionId)) ?? ctx.schema;
					}
					return { ok: true };
				}
				: undefined,
			// Force a live re-introspect for the authoritative schema tools (describe_table /
			// search_columns) so they never answer from a stale cache. Runs at most once per turn;
			// the connection is already live here (ensureConnected runs first for DB tools). A refresh
			// failure (e.g. gone offline) leaves the cached schema in place rather than failing the turn.
			refreshSchema: connectionId
				? async () => {
					if (schemaRefreshed) {
						return;
					}
					schemaRefreshed = true;
					try {
						await this.connections.refresh(connectionId);
						ctx.schema = (await this.connections.getSchema(connectionId)) ?? ctx.schema;
					} catch {
						// Keep the cached schema; the tool still answers rather than hard-failing.
					}
				}
				: undefined,
			execute: (sql) => (connectionId ? this.connections.executeRead(connectionId, sql) : noConnection()),
			// Document (MongoDB) backend: run_query takes an aggregation pipeline, executed natively.
			documentMode,
			executeNative: connectionId ? (query) => this.connections.executeNative(connectionId, query) : undefined,
			// Skip the prompt for connections the user has chosen to always allow; read the
			// list fresh so an "Always allow" mid-conversation takes effect immediately. The list only
			// lets a plain read through: see mayRunUnasked.
			approve: (sql, callId) =>
				connectionId && this.mayRunUnasked(connectionId, sql)
					? Promise.resolve(true)
					: connectionId
						? hooks.approve(sql, callId, connectionId)
						: Promise.resolve(false),
			emit: hooks.onTool,
			// Every tool and capability invocation lands on the audit trail, through the engine's
			// one audit call rather than per-capability logging. Gated on the same
			// tier + preference as chat recording, and best-effort inside runTool.
			audit: this.recordingEnabled('action')
				? (record) => this.audit.recordAction(record, auditProvider, auditModel)
				: undefined,
			origin: 'chat',
			connectionId,
			// The result grid may hold rows from a connection other than the active one, so a result that
			// carries values is checked against the level of the connection it came from.
			// Content tied to no connection (a log line the app could not attribute) is held to the
			// strictest level any saved database is set to: it may have come from any of them.
			invokeClient: async (inv) => gateValuesResult(inv.name, await hooks.invokeClient(inv), (id) => (id ? this.dataLevel(settings, id) : this.unattributedLevel(settings, connectionId))),
			approveAction: hooks.approveAction,
			// An edit to a saved connection is approved on what it changes, field by field; anything
			// else on every argument it was given (which project, which product, which setting and
			// its new value), not only on its name.
			describeAction: (call) => {
				if (call.name === 'edit_connection') {
					const existing = this.connections.state().connections.find((c) => c.id === String(call.arguments.id ?? ''));
					return existing ? editConnectionApproval(existing, call.arguments) : undefined;
				}
				if (call.name === 'edit_tunnel') {
					const tunnel = readTunnels().find((t) => t.id === String(call.arguments.id ?? ''));
					return tunnel ? editTunnelApproval(tunnel, call.arguments) : undefined;
				}
				const spec = hooks.capabilities.find((c) => c.name === call.name);
				const detail = spec ? agentActionDetail(spec, call.arguments, () => this.connections.state().connections) : {};
				const changes = detail.changes;
				const note = detail.note ? `. ${detail.note}` : '';
				return changes && changes.length > 0 ? `${call.name.replace(/_/g, ' ')} (${changes.join(', ')})${note}` : undefined;
			},
			// A monitor's query: on a connection the assistant may query (its AI access), only a read,
			// and pinned to that connection before the card names it (monitorAgentGate.ts).
			prepareAction: (call) => gateMonitorCall(call.name, call.arguments, {
				connections: this.connections.state().connections,
				allowed: (id) => dataAccessAllows(this.dataLevel(settings, id), 'queries'),
				allowedWhere: 'SnoutData Studio, Settings, AI (or the connection\'s own AI access)',
				fallbackConnectionId: connectionId,
			}),
			clientCapabilities: new Set(hooks.capabilities.map((c) => c.name)),
			clientMutates: new Set(hooks.capabilities.filter((c) => c.mutates).map((c) => c.name)),
			// Cross-connection targeting: a DB tool's `connection` argument resolves to a handle bound to
			// a SECOND saved connection, so one turn can span two databases (compare prod vs dev, propose a
			// column for another DB) — the model no longer has to (and cannot) "switch" the active one. The
			// handle is cached per turn so a repeat lookup reuses the same freshened schema + refresh guard.
			resolveConnection: async (ref) => {
				const conns = this.connections.state().connections;
				const needle = ref.toLowerCase();
				const config = conns.find((c) => c.id === ref) ?? conns.find((c) => c.label.toLowerCase() === needle);
				if (!config) {
					return null;
				}
				const cached = targetHandles.get(config.id);
				if (cached) {
					return cached;
				}
				const targetId = config.id;
				let refreshed = false;
				const handle: ConnectionHandle = {
					label: config.label,
					dataAccess: this.dataLevel(settings, targetId),
					documentMode: backendKindForDriver(config.driver) === 'document',
					driverId: config.driver,
					flavor: config.flavor,
					schema: (await this.connections.getSchema(targetId)) ?? null,
					ensureConnected: async () => {
						if (!this.connections.state().connectedIds.includes(targetId)) {
							const approved = hooks.approveAction ? await hooks.approveAction(`connect to ${config.label}`, `connect:${targetId}`) : false;
							if (!approved) {
								return { ok: false, declined: true };
							}
							try {
								await this.connections.connect(targetId);
							} catch (err) {
								return { ok: false, error: err instanceof Error ? err.message : String(err) };
							}
						}
						if (!handle.schema || handle.schema.tables.length === 0) {
							handle.schema = (await this.connections.getSchema(targetId)) ?? handle.schema;
						}
						return { ok: true };
					},
					refreshSchema: async () => {
						if (refreshed) {
							return;
						}
						refreshed = true;
						try {
							await this.connections.refresh(targetId);
							handle.schema = (await this.connections.getSchema(targetId)) ?? handle.schema;
						} catch {
							// Keep the cached schema; the tool still answers rather than hard-failing.
						}
					},
					execute: (sql) => this.connections.executeRead(targetId, sql),
					executeNative: (query) => this.connections.executeNative(targetId, query),
					approve: (preview, callId) =>
						this.mayRunUnasked(targetId, preview)
							? Promise.resolve(true)
							: hooks.approve(preview, callId, targetId),
				};
				targetHandles.set(targetId, handle);
				return handle;
			},
		};
		return runAgentLoop(provider, messages, toolSpecs, (call) => runTool(call, ctx), { onDelta, signal }, settings.tools.maxSteps);
	}

	/**
	 * Whether a run_query on this connection may skip the approval prompt. Only when the user has put
	 * the connection on "Always allow", and even then only for a statement the guard positively reads
	 * as a plain read that calls no function outside the known-pure built-ins, and never on a
	 * production connection (`SELECT pg_terminate_backend(pid)` reads as a SELECT to a lexer alone).
	 * A document backend's query is a pipeline the tool already holds to read-only stages, so for one
	 * of those the list still applies off production.
	 */
	private mayRunUnasked(connectionId: string, query: string): boolean {
		if (!this.settings.get().tools.autoApproveConnections.includes(connectionId)) {
			return false;
		}
		const config = this.connections.state().connections.find((c) => c.id === connectionId);
		const production = config?.environment === 'prod';
		if (backendKindForDriver(config?.driver) === 'document') {
			return !production;
		}
		return autoRunBlocker(query, { driver: config?.driver, flavor: config?.flavor, production }) === undefined;
	}

	/** What the AI may see of one database: the connection's own level, else Settings → AI. */
	private dataLevel(settings: AiSettings, connectionId: string | undefined): DataAccessLevel {
		const config = connectionId ? this.connections.state().connections.find((c) => c.id === connectionId) : undefined;
		return resolveDataAccess(settings.dataAccess, config?.aiDataAccess);
	}

	/** The level for values no connection can be named for: the strictest of the active
	 *  connection's and every saved one's. */
	private unattributedLevel(settings: AiSettings, activeConnectionId: string | undefined): DataAccessLevel {
		const saved = this.connections.state().connections.map((c) => resolveDataAccess(settings.dataAccess, c.aiDataAccess));
		return strictestDataAccess([this.dataLevel(settings, activeConnectionId), ...saved]);
	}

	/** The settings with the data-access level applied to the agent's tools: below "read-only
	 *  queries", run_query is switched off whatever Settings → AI → Agent says, so it is neither
	 *  advertised nor runnable. The stored settings are untouched. */
	private withDataAccess(settings: AiSettings, level: DataAccessLevel): AiSettings {
		if (dataAccessAllows(level, 'queries') || !settings.tools.runQuery) {
			return settings;
		}
		return { ...settings, tools: { ...settings.tools, runQuery: false } };
	}

	/** Project the renderer capability manifest onto wire ToolSpecs, dropping any whose name
	 *  collides with a built-in DB tool (built-ins win) or is a duplicate. */
	private clientToolSpecs(capabilities: CapabilitySpec[], builtins: ToolSpec[]): ToolSpec[] {
		const taken = new Set(builtins.map((s) => s.name));
		const specs: ToolSpec[] = [];
		for (const c of capabilities) {
			if (taken.has(c.name)) {
				continue;
			}
			taken.add(c.name);
			specs.push(toToolSpec(c));
		}
		return specs;
	}

	/** The original one-shot path: inline the relevance-ranked schema and stream one reply. */
	private async oneShot(
		provider: ModelProvider,
		history: ChatMessage[],
		dialect: string,
		schema: DatabaseSchema | null,
		settings: AiSettings,
		onDelta: (text: string) => void,
		signal?: AbortSignal,
		ambient: AmbientContext = {},
		connectionId?: string,
		documentMode = false,
	): Promise<{ usage?: TokenUsage; responseId?: string }> {
		const messages = this.buildChatMessages(history, dialect, schema, settings, false, ambient, connectionId, documentMode);
		const { usage, responseId } = await provider.chat(messages, { onDelta, signal });
		return { usage, responseId };
	}

	/**
	 * One-shot, non-streaming SQL completion for on-demand inline (ghost-text) insertion.
	 * Grounded in the active connection's dialect + schema like chat, but the model is
	 * asked to return only the raw text to insert at the cursor. Opt-in: throws when the
	 * inline-completion behavior toggle is off, since unlike deterministic completion it
	 * calls the model.
	 */
	async complete(prefix: string, suffix: string, activeConnectionId: string | undefined): Promise<{ text: string; id: string }> {
		this.requireSignedIn();
		const settings = this.settings.get();
		if (!settings.behavior.inlineCompletion) {
			throw new Error('AI completion is off. Enable it under Settings → AI.');
		}
		const { providerId, model } = await this.completionTarget(settings);
		const provider = this.buildProvider(settings, providerId, model);
		const { dialect, driverId, schema } = await this.context(activeConnectionId);
		// A tight schema budget for completion only (see COMPLETION_* above): the model runs on
		// the keystroke path, so a large preamble would blow first-token latency. `focus` is the
		// text around the cursor (what the user is typing, e.g. `from customer_`), so the schema
		// ranking surfaces the tables they're actually referencing instead of the first N in the
		// database — otherwise a base completer hallucinates a plausible table it never saw.
		const focus = completionFocus(prefix, suffix);
		const promptOpts = {
			driverId,
			maxSchemaChars: COMPLETION_MAX_SCHEMA_CHARS,
			topTables: COMPLETION_TOP_TABLES,
			instructions: settings.behavior.instructions,
			focus,
			// Rank by the tables this user actually queries, not just lexical relevance to the
			// cursor. Completion is the path that needs this MOST and was the only one without it:
			// with hundreds of tables only ~50 names fit the prompt, and a half-typed `cus` gave
			// the ranker nothing to go on, so a status lookup table made the list while
			// `customer_order` — one of the user's most-queried tables — did not.
			tableUsage: this.tableUsage(activeConnectionId),
			// The half-typed name under the cursor, prefix-matched against table/column names.
			// Without it `from cus` scores every table zero and the ranking is arbitrary.
			partialName: partialIdentifier(prefix),
		};
		// Ground in the SQL the user has written before against this connection, so completion
		// follows their style — the part prefix/suffix + schema alone can't supply.
		const historyComment = buildHistoryComment(prefix, activeConnectionId, this.queries.history());
		// SINGLE-FLIGHT. Monaco cancels a superseded keystroke in the renderer, but that never
		// reached main, so every request kept running: they serialize at the model, the backlog
		// grows, and each new one waits behind all the orphans (observed: a staircase of 13s → 20s
		// durations ending in timeouts, from a queue that only ever got longer). Only the newest
		// cursor can still be useful, so abort the one in flight before starting another.
		this.completionAbort?.abort(SUPERSEDED_COMPLETION);
		const abort = new AbortController();
		this.completionAbort = abort;
		const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(COMPLETION_TIMEOUT_MS)]);
		const startedAt = Date.now();
		let reply = '';
		try {
			if (provider.fim) {
				// Code models: raw fill-in-the-middle, with the schema (and prior queries) as
				// comments in the prefix (works for instruct and -base models alike). The schema
				// goes first so it stays a stable prefix the backend's KV-cache can reuse.
				const preamble = [buildSchemaComment(dialect, schema, promptOpts), historyComment].filter(Boolean).join('\n');
				reply = await provider.fim({ prefix: preamble ? `${preamble}\n${prefix}` : prefix, suffix, signal });
			} else {
				// No FIM (the gateway's chat models): instruct the model to return only insertable text.
				const system = buildCompletionPrompt(dialect, schema, promptOpts);
				const user = historyComment ? `${historyComment}\n\n${buildCompletionUser(prefix, suffix)}` : buildCompletionUser(prefix, suffix);
				await provider.chat(
					[{ role: 'system', content: system }, { role: 'user', content: user }],
					{ onDelta: (text) => { reply += text; }, signal },
				);
			}
		} catch (err) {
			// A request we abandoned ourselves isn't a failure the user should see or that belongs
			// in the audit log — the cursor it was answering no longer exists.
			if (abort.signal.reason === SUPERSEDED_COMPLETION) {
				return { text: '', id: '' };
			}
			const explained = this.explain(err, settings, providerId);
			this.record('completion', providerId, model, activeConnectionId, completionMessages(prefix, suffix), reply, startedAt, { ok: false, error: explained.message });
			throw explained;
		} finally {
			if (this.completionAbort === abort) {
				this.completionAbort = null;
			}
		}
		// Syntax cleanup first (fences, echoed prefix, runaway past the gap), then the SCHEMA guard:
		// a completion naming a table or column this database doesn't have is repaired to the real
		// name or cut where it went wrong. The model can't be trusted with identifiers it only saw
		// as `--` comments, and we know the right answer deterministically — see completionGuard.ts.
		const cleaned = extractCompletion(reply, prefix, suffix);
		const guarded = guardCompletion(cleaned, prefix, suffix, schema);
		const id = this.record('completion', providerId, model, activeConnectionId, completionMessages(prefix, suffix), reply, startedAt, {
			ok: true,
			completion: { verdict: guarded.verdict, repairs: guarded.repairs.length, cut: guarded.cut, shownChars: guarded.text.length },
		});
		return { text: guarded.text, id };
	}

	/**
	 * Inline editor edit (Ctrl+K): rewrite the selection, or generate SQL at the cursor when
	 * the selection is empty. Uses the chat model (an edit wants intelligence, not FIM speed),
	 * grounded in the dialect + schema ranked by the instruction. Returns the raw SQL to apply,
	 * with any stray markdown fence stripped.
	 */
	async edit(params: AiEditParams, onDelta?: (text: string) => void): Promise<string> {
		this.requireSignedIn();
		const settings = this.settings.get();
		const { providerId, model } = this.editTarget(settings, params);
		const provider = this.buildProvider(settings, providerId, model);
		const { dialect, driverId, schema } = await this.context(params.connectionId);
		const mode = params.selection.trim() ? 'edit' : 'generate';
		// The connection's knowledge base, exactly as the chat path resolves it: the glossary rides the
		// system prompt, per-table notes ride the detailed schema lines, and a pinned note force-includes
		// its table. A Ctrl+K edit is a SQL-writing turn like any other, so it gets the same grounding.
		const kb = params.connectionId ? this.knowledge.notesFor(params.connectionId) : null;
		const base = buildEditPrompt(dialect, schema, {
			driverId,
			maxSchemaChars: settings.behavior.maxSchemaChars,
			topTables: settings.behavior.topTables,
			instructions: settings.behavior.instructions,
			focus: editFocus(params),
			excludeTables: editDecoyTables(params.selection, schema),
			tableUsage: this.tableUsage(params.connectionId),
			notesByTable: kb?.byTable,
			pinnedTables: kb?.pinnedTables,
			// A Ctrl+K edit grounds on the same widened vocabulary the chat does: the user should not
			// have to know which surface they are on for their own words to work.
			vocabulary: kb?.glossary.map((note) => note.text),
		}, mode);
		// Failure memory: if what the user is editing is structurally similar to a query that failed
		// before on this schema, carry the same caution the chat carries. Best-effort — a null just
		// means no relevant memory, and it must never fail the edit.
		const memoryNote = params.connectionId
			? await this.connections.retrieveFailureNote(params.connectionId, params.selection.trim() || params.document).catch(() => undefined)
			: undefined;
		const system = [base, kb ? buildGlossaryBlock(kb.glossary) : '', memoryNote ? buildAmbientComment({ memoryNote }) : ''].filter(Boolean).join('\n\n');
		const user = buildEditUser(params.instruction, params.selection, params.document, mode, schema);
		const startedAt = Date.now();
		let reply = '';
		try {
			await provider.chat([{ role: 'system', content: system }, { role: 'user', content: user }], { onDelta: (text) => { reply += text; onDelta?.(text); } });
		} catch (err) {
			const explained = this.explain(err, settings, providerId);
			this.record('edit', providerId, model, params.connectionId, editMessages(params), reply, startedAt, { ok: false, error: explained.message });
			throw explained;
		}
		this.record('edit', providerId, model, params.connectionId, editMessages(params), reply, startedAt, { ok: true });
		return extractCompletion(reply, '');
	}

	/**
	 * "Refine with AI" for the knowledge base: distill a chat conversation (+ the user's optional
	 * note) into ONE durable, self-contained fact about their database, grounded in the schema so it
	 * uses real identifiers. Returns plain text that fills the capture popover for the user to review
	 * and Save — it is NEVER saved from here (never-silent stays intact). Uses the chat model (this
	 * wants comprehension, not FIM speed). Not audit-recorded: it's a UI helper, not a data-touching
	 * turn, and the saved note itself is the durable artifact.
	 */
	async draftKnowledgeNote(params: { connectionId?: string; messages: ChatMessage[]; hint?: string }): Promise<string> {
		this.requireSignedIn();
		const settings = this.settings.get();
		const { providerId, model } = this.chatTarget(settings);
		const provider = this.buildProvider(settings, providerId, model);
		const { dialect, driverId, schema } = await this.context(params.connectionId);
		const system = buildKnowledgeDraftPrompt(dialect, schema, {
			driverId,
			maxSchemaChars: settings.behavior.maxSchemaChars,
			topTables: settings.behavior.topTables,
			// Rank the schema toward the tables the conversation is about, so the drafter sees their columns.
			focus: params.messages.filter((m) => m.content.trim()).slice(-4).map((m) => m.content).join('\n') || undefined,
			tableUsage: this.tableUsage(params.connectionId),
		});
		const user = buildKnowledgeDraftUser(params.messages, params.hint);
		let reply = '';
		await provider.chat([{ role: 'system', content: system }, { role: 'user', content: user }], { onDelta: (text) => { reply += text; } });
		return cleanKnowledgeDraft(reply, params.hint);
	}

	/**
	 * Background observer: after a SQL/correction turn, distill the exchange into ONE
	 * durable fact and record it as a `suggested` note the user can one-tap Remember. Distinct from
	 * {@link draftKnowledgeNote} in two ways: it uses a CHEAP model (this fires per SQL turn —
	 * don't spend the flagship off the metered wallet), and it dedups + saves as `suggested` (never
	 * injects until approved). Fails soft: returns null on any error or when there's nothing new to
	 * propose, so a background pass never disrupts the chat.
	 */
	async observeKnowledge(params: { connectionId: string; messages: ChatMessage[] }): Promise<KnowledgeNote | null> {
		try {
			if (!this.signedIn || !params.connectionId) {
				return null;
			}
			const settings = this.settings.get();
			const { providerId } = this.chatTarget(settings);
			const model = observerModelFor(OFFICIAL_BUILD, providerId, OBSERVER_CLOUD_MODEL, settings.behavior.observerModel, () => this.modelFor(settings, providerId));
			if (!model) {
				return null;
			}
			const provider = this.buildProvider(settings, providerId, model);
			const { dialect, driverId, schema } = await this.context(params.connectionId);
			const system = buildKnowledgeDraftPrompt(dialect, schema, {
				driverId,
				maxSchemaChars: settings.behavior.maxSchemaChars,
				topTables: settings.behavior.topTables,
				focus: params.messages.filter((m) => m.content.trim()).slice(-4).map((m) => m.content).join('\n') || undefined,
				tableUsage: this.tableUsage(params.connectionId),
			});
			const user = buildKnowledgeDraftUser(params.messages, undefined);
			let reply = '';
			await provider.chat([{ role: 'system', content: system }, { role: 'user', content: user }], { onDelta: (text) => { reply += text; } });
			const text = cleanKnowledgeDraft(reply, undefined);
			return text ? this.knowledge.suggest(params.connectionId, text) : null;
		} catch {
			return null;
		}
	}

	/**
	 * The AI half of the hybrid SQL→native transcriber: translate SQL the deterministic
	 * `sqlToMongo` compiler couldn't represent into a MongoDB aggregation pipeline, grounded in the
	 * connection's collections + inferred fields. Returns a `{ lang: 'mongo' }`
	 * {@link NativeQuery}. Wired into the connection manager's transcription path (the fallback
	 * fires only on `UnsupportedQueryError`). Throws on an unavailable model or unparseable output,
	 * so the grid surfaces a clean error rather than running a wrong query.
	 */
	async transcribeToNative(sql: string, connectionId: string | undefined): Promise<NativeQuery> {
		this.requireSignedIn();
		const settings = this.settings.get();
		const { providerId, model } = this.chatTarget(settings);
		const provider = this.buildProvider(settings, providerId, model);
		const { schema, kind } = await this.context(connectionId);
		// Vector (Pinecone): the deterministic `sqlToPinecone` covers the metadata-filter subset; an
		// AI SQL→vector fallback would have to invent a query vector (similarity is the embed/NL path),
		// so decline here rather than emit a wrong (Mongo-shaped) query.
		if (kind === 'vector') {
			throw new Error('AI translation for Pinecone queries is not available yet. Use a WHERE metadata filter the compiler supports, or author a native query.');
		}
		// Telemetry (CloudWatch / Azure Monitor / Cloud Logging): a log service runs Logs Insights,
		// KQL or a Cloud Logging filter — never a MongoDB pipeline — and the prompt below writes only
		// pipelines. Declining is the whole guard: the deterministic path already reports these as
		// non-recoverable, but the always-translate setting reaches this method with consent
		// already given and no dialog in between.
		if (kind === 'telemetry') {
			throw new Error('AI translation for log queries is not available yet. Write the query as a plain SELECT over one log scope, with WHERE, GROUP BY, ORDER BY and LIMIT.');
		}
		const { system, user } = buildMongoTranscribePrompt(sql, schema);
		let reply = '';
		try {
			await provider.chat([{ role: 'system', content: system }, { role: 'user', content: user }], { onDelta: (t) => { reply += t; } });
		} catch (err) {
			throw this.explain(err, settings, providerId);
		}
		return parseMongoPipeline(reply, sql);
	}

	/**
	 * Embed text into a vector via the gateway's embeddings model (the vector-DB "find similar to
	 * X" path: NL/text → vector → Pinecone query). Routed through the cloud provider only
	 * (BYOK/Ollama don't serve our embeddings model). NOTE: this throws until an embeddings model
	 * is configured on the gateway (a separate gateway task);
	 * {@link EMBEDDING_MODEL} must match that model's id.
	 */
	async embed(text: string, signal?: AbortSignal): Promise<number[]> {
		this.requireSignedIn();
		const settings = this.settings.get();
		const cloud = settings['positron-cloud'];
		const baseUrl = cloud.baseUrl?.trim() || CLOUD_BASE['positron-cloud'];
		const apiKey = this.settings.apiKey('positron-cloud') ?? '';
		const provider = new OpenAiProvider({ baseUrl, apiKey, model: EMBEDDING_MODEL, endUser: this.settings.endUser() });
		try {
			return await provider.embeddings({ input: text, model: EMBEDDING_MODEL, signal });
		} catch (err) {
			throw this.explain(err, settings, 'positron-cloud');
		}
	}





	/**
	 * Snoutbot's optional prose pass over a review that has ALREADY been produced.
	 *
	 * The rule set is deterministic and stays that way: this model is handed findings that were
	 * decided and measured without it, and asked to say what they mean. It never decides whether
	 * something will fail, never reads a measurement, and never judges severity — the prompt
	 * (`review-core`'s `commentaryPrompt`) forbids all three, and what comes back is rendered in
	 * its own folded, model-attributed section rather than mixed into a finding.
	 *
	 * `mode` is the user's choice per repository:
	 *   - `snoutdata` — our gateway, spending their own AI allowance like the assistant does.
	 *   - `byok` — their own vendor key, so the review text never reaches our servers. Gated on
	 *     the `byok` entitlement by `rawProvider`, exactly like the assistant.
	 *
	 * Returns the prose and the model that wrote it, so the comment can attribute it. Throws on
	 * failure: the caller turns that into a printed gap rather than pretending nothing was asked.
	 */
	/** Wire the local rungs. Called once on launch by main, which owns the stores they need. */
	setLocalProse(resolver: LocalProseResolver): void {
		this.localProse = resolver;
	}

	async reviewCommentary(
		prompt: { system: string; user: string },
		method: ReviewMethod,
		signal?: AbortSignal,
	): Promise<{ text: string; model: string }> {
		if (method.kind === 'deterministic') {
			// The runner gates this, and a caller that gets here has lost the gate rather than
			// asked for something reasonable. Loud, because the alternative is a review that
			// quietly grew an explanation the user did not choose.
			throw new Error('This repository is reviewed by the rules alone. No model is called.');
		}
		// The two LOCAL rungs never touch our gateway, so they never touch the account either: a
		// model on this computer does not care whether anybody is signed in, and asking them to be
		// would be a sign-in wall in front of the one option that needs nothing from us.
		if (method.kind === 'localEngine' || (method.kind === 'byok' && method.provider === 'ollama')) {
			return await this.localCommentary(prompt, method, signal);
		}
		this.requireSignedIn();
		const settings = this.settings.get();
		const { providerId, model } = this.reviewTarget(settings, method.kind === 'snoutAi' ? 'snoutdata' : 'byok');
		const provider = this.buildProvider(settings, providerId, model);
		const started = Date.now();
		let reply = '';
		try {
			await provider.chat(
				[{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
				{ onDelta: (text) => { reply += text; }, signal },
			);
		} catch (err) {
			this.recordFlowCall({
				callId: `review-${started}`, tool: 'review.commentary', origin: 'review', mutates: false,
				arguments: { method: method.kind }, ok: false, summary: 'Writing the review commentary failed',
				error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started,
			}, providerId, model, { systemPrompt: prompt.system, user: prompt.user, reply });
			throw this.explain(err, settings, providerId);
		}
		this.recordFlowCall({
			callId: `review-${started}`, tool: 'review.commentary', origin: 'review', mutates: false,
			arguments: { method: method.kind }, ok: true,
			summary: `Wrote the prose half of a pull-request review (${reply.length} characters back)`,
			durationMs: Date.now() - started,
		}, providerId, model, { systemPrompt: prompt.system, user: prompt.user, reply });
		return { text: reply, model };
	}

	/**
	 * Write a review's prose on a model that is NOT ours: the local runtime, or the user's own
	 * Ollama. Audited exactly like the other two rungs, because where the call went is the one
	 * thing an audit trail is for.
	 *
	 * It goes through `localProse` rather than resolving anything itself. Reaching one of these
	 * means reaching the extraction-model settings, the downloaded components and the model store,
	 * all of which live in main's wiring; the same reasoning, and the same seam shape, as the
	 * document reader's own model seam.
	 */
	private async localCommentary(
		prompt: { system: string; user: string },
		method: ReviewMethod,
		signal?: AbortSignal,
	): Promise<{ text: string; model: string }> {
		if (!this.localProse) {
			throw new Error("This build does not include a model on this computer, so it cannot explain the review. Choose another way to review this repository in Settings, Snoutbot.");
		}
		const resolved = this.localProse(method);
		if (!resolved.ok) {
			throw new Error(resolved.because);
		}
		const started = Date.now();
		let reply = '';
		try {
			reply = await resolved.ask({ system: prompt.system, user: prompt.user, signal });
		} catch (err) {
			this.recordFlowCall({
				callId: `review-${started}`, tool: 'review.commentary', origin: 'review', mutates: false,
				arguments: { method: method.kind }, ok: false, summary: 'Writing the review commentary failed',
				error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started,
			}, resolved.providerId, resolved.model, { systemPrompt: prompt.system, user: prompt.user, reply });
			throw err;
		}
		this.recordFlowCall({
			callId: `review-${started}`, tool: 'review.commentary', origin: 'review', mutates: false,
			arguments: { method: method.kind }, ok: true,
			summary: `Wrote the prose half of a pull-request review on ${resolved.label} (${reply.length} characters back)`,
			durationMs: Date.now() - started,
		}, resolved.providerId, resolved.model, { systemPrompt: prompt.system, user: prompt.user, reply });
		return { text: reply, model: resolved.model };
	}

	/**
	 * The (provider, model) a review's prose pass runs on.
	 *
	 * `snoutdata` is pinned to the gateway rather than following the assistant's picker: a
	 * repository set to "use my SnoutData allowance" must not silently start using a BYOK key
	 * because the user switched the chat provider. `byok` prefers the BYOK provider they are
	 * already using for chat, and otherwise takes the first one they have configured.
	 */
	private reviewTarget(settings: AiSettings, mode: 'snoutdata' | 'byok'): { providerId: AiProviderId; model: string } {
		if (mode === 'snoutdata') {
			return { providerId: 'positron-cloud', model: settings['positron-cloud'].model };
		}
		const byokIds = Object.keys(BYOK_PROVIDER_DEFAULTS) as ByokProviderId[];
		const chosen = isByokProvider(settings.provider)
			? settings.provider
			: byokIds.find((p) => this.settings.byokKey(p));
		if (!chosen) {
			throw new Error('No bring-your-own-key provider is set up. Add a key under Settings → AI.');
		}
		return { providerId: chosen, model: settings.byok[chosen].model };
	}



	/**
	 * The model function Studio exposes to the companion package: it takes the system text and
	 * messages the renderer sends and returns the reply. It runs on the chat provider, with
	 * OBSERVER_CLOUD_MODEL on the gateway and the chat model otherwise. Recorded in the audit log
	 * like any other model call; bounded, since the renderer wrote the request.
	 */
	async libyChat(request: LibyChatRequest): Promise<string> {
		this.requireSignedIn();
		const system = String(request.system ?? '').slice(0, LIBY_MAX_CHARS);
		const messages: ChatMessage[] = (Array.isArray(request.messages) ? request.messages : [])
			.slice(-LIBY_MAX_MESSAGES)
			.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '').slice(0, LIBY_MAX_CHARS) }));
		if (messages.length === 0) {
			throw new Error('Nothing to ask.');
		}
		const settings = this.settings.get();
		const { providerId } = this.chatTarget(settings);
		const model = providerId === 'positron-cloud' && OBSERVER_CLOUD_MODEL ? OBSERVER_CLOUD_MODEL : this.modelFor(settings, providerId);
		const provider = this.buildProvider(settings, providerId, model);
		const started = Date.now();
		let reply = '';
		try {
			const { usage } = await provider.chat([{ role: 'system', content: system }, ...messages], { onDelta: (text) => { reply += text; } });
			this.record('chat', providerId, model, undefined, messages, reply, started, { ok: true, usage }, system);
		} catch (err) {
			this.record('chat', providerId, model, undefined, messages, reply, started, { ok: false, error: err instanceof Error ? err.message : String(err) }, system);
			throw this.explain(err, settings, providerId);
		}
		return reply;
	}

	/** Which model a call outside the chat goes to: the assistant's own target (the model the user
	 *  can see in the picker), or the BYOK one a caller names. */
	modelTarget(target?: { provider: AiProviderId; model: string }): { provider: AiProviderId; model: string } {
		if (target) {
			return target;
		}
		const { providerId, model } = this.chatTarget(this.settings.get());
		return { provider: providerId, model };
	}

	/**
	 * One model call outside a conversation: a system prompt and one message, no history, no tools,
	 * no panel. For a feature built ON the assistant's model rather than inside it (Data Flows' half
	 * reads, extracts and proposes through this). Signed-in only, and a failure is explained the
	 * way chat explains it. NOT recorded: the caller records the exchange through
	 * {@link recordCall}, because only it knows what the reply was for. `onDelta` sees the reply as
	 * it arrives, so a caller can record what came back before a failure.
	 */
	async completeOnce(prompt: { system: string; user: string }, target: { provider: AiProviderId; model: string }, options: { signal?: AbortSignal; onDelta?(text: string): void } = {}): Promise<string> {
		this.requireSignedIn();
		const settings = this.settings.get();
		const provider = this.buildProvider(settings, target.provider, target.model);
		let reply = '';
		try {
			await provider.chat(
				[{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
				{ onDelta: (text) => { reply += text; options.onDelta?.(text); }, signal: options.signal },
			);
		} catch (err) {
			throw this.explain(err, settings, target.provider);
		}
		return reply;
	}

	/** Record one exchange made outside the chat (see {@link completeOnce}), or one this service did
	 *  not serve at all (a user's own Ollama), through the same two gates as chat: the tier and the
	 *  recording preference. */
	recordCall(record: ToolAuditRecord, provider: AiProviderId, model: string, exchange?: AuditedExchange): void {
		this.recordFlowCall(record, provider, model, exchange);
	}

	/** Embed several texts in one round-trip through the gateway (the vector sink writes in batches). */
	async embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]> {
		this.requireSignedIn();
		const settings = this.settings.get();
		const baseUrl = settings['positron-cloud'].baseUrl?.trim() || CLOUD_BASE['positron-cloud'];
		const apiKey = this.settings.apiKey('positron-cloud') ?? '';
		const provider = new OpenAiProvider({ baseUrl, apiKey, model: EMBEDDING_MODEL, endUser: this.settings.endUser() });
		try {
			return await provider.embedMany({ inputs: texts, model: EMBEDDING_MODEL, signal });
		} catch (err) {
			throw this.explain(err, settings, 'positron-cloud');
		}
	}

	/** Dev diagnostic: the two gates that decide whether anything reaches the audit log. Surfaced
	 *  on the dev /ai/info endpoint because a silent "nothing is being recorded" is otherwise
	 *  invisible - both gates fail closed and neither is shown anywhere in the UI. */
	auditState(): { allowed: boolean; kinds: AiAuditKind[]; store: { cached: number | null; flushScheduled: boolean } } {
		return { allowed: this.auditAllowed, kinds: [...this.auditKinds], store: this.audit.pending() };
	}

	/**
	 * Record one action an EXTERNAL agent drove over MCP, onto the same audit trail as the chat
	 * path. Held here rather than wired straight to the store so the MCP path passes the same two
	 * gates as chat (tier + the recording preference) and cannot become a way to log when the user
	 * has asked us not to. No model of ours served it, so the entry is attributed to `mcp` and the
	 * agent's own client name.
	 */
	recordAgentAction(record: ToolAuditRecord, client: string): void {
		if (!this.recordingEnabled('action')) {
			return;
		}
		this.audit.recordAction(record, 'mcp', client);
	}

	/**
	 * The same, for an action a model of OURS served with nobody watching: a Data Flow's extraction
	 * stage, on a schedule or on a run the user started and walked away from.
	 *
	 * Separate from {@link recordAgentAction} because the attribution differs in both fields that
	 * name who did it. These entries used to read `mcp · flow` — MCP had nothing to do with them,
	 * and the model that served it was not recorded at all — and carried the tool's own summary in
	 * place of the exchange. This is the one path where a flow's record content leaves the machine,
	 * so the log holds the prompt and the reply, as it does for a chat turn.
	 */
	private recordFlowCall(record: ToolAuditRecord, provider: AiProviderId, model: string, exchange?: AuditedExchange): void {
		if (!this.recordingEnabled('action')) {
			return;
		}
		this.audit.recordAction(record, provider, model, exchange);
	}

	/** Whether an interaction of this kind will be recorded (tier + per-kind preference). Lets a
	 *  caller skip assembling extra audit-only data (the grounding prompt) when nothing is logged. */
	private recordingEnabled(kind: AiAuditKind): boolean {
		return this.auditKinds.has(kind) && this.auditAllowed;
	}

	/** Estimated USD a turn spent against the wallet, from the cached gateway prices: prompt tokens
	 *  × input rate + completion tokens × output rate. Returns 0 for a known free ($0) model and
	 *  undefined when the model's price isn't cached yet (no providerStatus has run) or usage is
	 *  absent — so the audit only shows a dollar figure it can actually stand behind (A5). */
	private estimateCostUsd(model: string, usage: TokenUsage | undefined): number | undefined {
		const price = this.modelPrices.get(model);
		if (!price || !usage) {
			return undefined;
		}
		return (usage.promptTokens * price.inputPerMTok + usage.completionTokens * price.outputPerMTok) / 1_000_000;
	}

	/** Append one model round-trip to the audit log. Best-effort: a store failure must
	 *  never break the chat/completion it's recording, so swallow any error here. The user-facing
	 *  conversation is always kept; the grounding `systemPrompt` (schema + ambient context) is
	 *  recorded too when the caller supplies it, so the audit shows what the AI was actually fed. */
	private record(
		kind: AiAuditKind,
		provider: AiProviderId,
		model: string,
		connectionId: string | undefined,
		messages: ChatMessage[],
		response: string,
		startedAt: number,
		outcome: { ok: boolean; error?: string; usage?: TokenUsage; completion?: AiCompletionRecord },
		systemPrompt?: string,
	): string {
		const id = randomUUID();
		if (!this.recordingEnabled(kind)) {
			return id;
		}
		try {
			this.audit.append({
				id,
				timestamp: startedAt,
				kind,
				provider,
				model,
				connectionId,
				messages: messages.filter((m) => m.role !== 'system'),
				response,
				systemPrompt,
				completion: outcome.completion,
				usage: outcome.usage,
				costUsd: this.estimateCostUsd(model, outcome.usage),
				durationMs: Date.now() - startedAt,
				ok: outcome.ok,
				error: outcome.error,
			});
		} catch {
			// Auditing is non-essential; never let it surface to the user.
		}
		return id;
	}

	/**
	 * Record what the user did with a completion that was shown (renderer → main, fire and forget).
	 * Acceptance is the ONLY honest measure of whether inline completion is any good: the round-trip
	 * log says what the model answered, never whether anyone took it. Joined to the round-trip by
	 * the audit id returned from {@link complete}.
	 */
	completionOutcome(params: AiCompletionOutcomeParams): void {
		this.audit.annotate(params.id, (entry) => {
			if (!entry.completion) {
				return entry;
			}
			// `shown` never overwrites a real decision — Monaco can re-show an item after a partial
			// accept, and the accept is the fact worth keeping.
			if (params.outcome === 'shown' && entry.completion.outcome) {
				return entry;
			}
			return { ...entry, completion: { ...entry.completion, outcome: params.outcome, acceptedChars: params.acceptedChars } };
		});
	}

	/** Per-provider readiness + the models each currently offers, with each model's
	 *  enabled flag. A provider contributes models only once it's configured/reachable,
	 *  so the chat picker never lists a backend you haven't set up (e.g. the gateway with
	 *  no API key). Backs both the chat picker and the Settings model list. */
	async providerStatus(): Promise<AiProviderStatus[]> {
		if (this.scriptedAccount) {
			return [{ provider: 'positron-cloud', configured: true, reachable: true, models: this.scriptedAccount.models, completionModels: this.scriptedAccount.completionModels }];
		}
		const settings = this.settings.get();
		const disabled = new Set(settings.disabledModels ?? []);
		const statuses: AiProviderStatus[] = [];

		// Local Ollama is kept for the (soon-to-be-gated) BYO-local-model feature but is
		// hidden from the picker for now — so it isn't surfaced here. Flip OLLAMA_VISIBLE
		// (or gate it) to bring it back: list its pulled models like the gateway does below.

		// SnoutData Cloud — our own OpenAI-compatible gateway. It serves a small, curated model
		// set we can enumerate cheaply, so (once a key is stored) we list the gateway's models
		// rather than surfacing a single configured one.
		const pcKey = this.settings.apiKey('positron-cloud');
		// Signed out, the gateway cannot be used (every model call is refused up front, see
		// requireSignedIn), and the catalog below only decorates the gateway's models. So nothing is
		// asked of anybody: a signed-out app talks only to the databases the user configured. This is
		// what the assistant panel reads on mount, and it is open on a fresh profile. BYOK is gated on
		// a tier, which a signed-out user does not have, and its status makes no network call anyway.
		if (!this.signedIn) {
			statuses.push({
				provider: 'positron-cloud',
				configured: Boolean(pcKey),
				reachable: false,
				detail: pcKey ? 'Sign in to use the assistant' : 'No API key: add it below',
				models: [],
				completionModels: [],
			});
			if (this.byokAllowed) {
				for (const provider of Object.keys(BYOK_PROVIDER_DEFAULTS) as ByokProviderId[]) {
					statuses.push(this.byokStatus(provider, settings, disabled));
				}
			}
			return statuses;
		}
		let pcModels: string[] = [];
		let pcDetail: string | undefined;
		let pcReachable = false;
		let costs = new Map<string, { metered: boolean; outputPerMTok: number; inputPerMTok: number }>();
		let pcBudgetBlocked = false;
		// Best-effort cost classification for whichever key successfully listed; a failure leaves
		// every model free/unmetered. Warms the price cache so a chat turn can estimate its dollar
		// cost without a network call on the chat path (A5: cost legible, latency untouched).
		const classifyCosts = async (provider: OpenAiProvider): Promise<void> => {
			try {
				costs = new Map((await provider.modelCosts()).map((c) => [c.model, { metered: c.metered, outputPerMTok: c.outputPerMTok, inputPerMTok: c.inputPerMTok }]));
				this.modelPrices = new Map([...costs].map(([m, c]) => [m, { inputPerMTok: c.inputPerMTok, outputPerMTok: c.outputPerMTok }]));
			} catch {
				costs = new Map();
			}
		};
		if (!pcKey) {
			pcDetail = 'No API key: add it below';
		} else {
			const pc = settings['positron-cloud'];
			const base = pc.baseUrl?.trim() || CLOUD_BASE['positron-cloud'];
			try {
				const provider = new OpenAiProvider({ baseUrl: base, apiKey: pcKey, model: pc.model });
				pcModels = await provider.listModels();
				pcReachable = true;
				await classifyCosts(provider);
			} catch (err) {
				// The monthly wallet is spent: LiteLLM refuses this key on every route — including
				// /v1/models — so the list comes back empty even though the user may still run
				// questions on pay-as-you-go credits. Never let a spent wallet hide the picker; the
				// budget wall belongs at send time (see chat()), not here.
				if (isBudgetExceeded(err)) {
					pcBudgetBlocked = true;
					// Credits on + a top-up key: list via it (the same key the chat path falls back to),
					// so the picker shows the real per-user model set and sends keep working.
					const topupKey = this.creditsEnabled ? this.settings.topupKey() : undefined;
					if (topupKey) {
						try {
							const topup = new OpenAiProvider({ baseUrl: base, apiKey: topupKey, model: pc.model });
							pcModels = await topup.listModels();
							pcReachable = true;
							pcDetail = "Monthly limit reached, using your credits";
							await classifyCosts(topup);
						} catch {
							// Credits dry or unreachable: fall through to the catalog fallback below.
						}
					}
				} else {
					// Name the real cause + host so Settings shows e.g. "net::ERR_TIMED_OUT reaching
					// api.snoutdata.com" instead of a bare "Offline" (the key diagnostic on a corp network).
					let host = base;
					try {
						host = new URL(base).host;
					} catch {
						// keep the raw base if it isn't a parseable URL
					}
					pcDetail = `Offline: can't reach the gateway ${networkErrorDetail(err, host)}`.trim();
				}
			}
		}
		// Editorial metadata (display name, blurb, label, context, recommended) from the control plane,
		// merged onto each model by id. Empty when offline — models then show their raw ids.
		const catalog = await this.readCatalog();
		// Monthly wallet spent and no top-up key covered the list: source the ids from the released
		// catalog so the picker still shows the models. Enforcement stays at send time; a spent wallet
		// must not hide the picker. (released_models only, so a private model_grant is dropped while
		// over budget with no credits — an accepted edge case.)
		if (pcBudgetBlocked && pcModels.length === 0) {
			pcModels = [...catalog.keys()];
			pcReachable = true;
			pcDetail = "Monthly usage limit reached";
		}
		const decorate = (model: string): AiModelInfo => {
			const meta = catalog.get(model);
			const cost = costs.get(model);
			const metered = cost?.metered ?? false;
			return {
				provider: 'positron-cloud',
				model,
				enabled: !disabled.has(`positron-cloud:${model}`),
				reasoning: isReasoningModel('positron-cloud', model),
				metered,
				usageWeight: usageWeightForCost(metered, cost?.outputPerMTok ?? 0),
				displayName: meta?.displayName,
				description: meta?.description,
				label: meta?.label,
				contextWindow: meta?.contextWindow,
				recommended: meta?.recommended,
			};
		};
		// Order chat models by the catalog's sort_order (then by id), so the editor controls the
		// picker order; unknown models sort last. Completion models keep list order (rarely shown).
		const sortKey = (model: string): number => catalog.get(model)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
		const byOrder = (a: string, b: string): number => sortKey(a) - sortKey(b) || a.localeCompare(b);
		statuses.push({
			provider: 'positron-cloud',
			configured: Boolean(pcKey),
			reachable: pcReachable,
			detail: pcDetail,
			// Completion-only (base/FIM) models back inline completion, not chat — keep them out of
			// the chat picker / model list so they're never selectable as the chat model, and
			// surface them on their own for the Auto-completion picker (the inverse filter). The
			// chat/completion split is server-owned (the catalog `role`), with a hard-coded fallback.
			models: pcModels.filter((model) => !isCompletionModel(model, catalog)).sort(byOrder).map(decorate),
			completionModels: pcModels.filter((model) => isCompletionModel(model, catalog)).map(decorate),
		});

		// Bring-Your-Own-Key providers (Plus/Pro only). Surfaced like the gateway once a key is
		// stored, but they bypass our gateway entirely, so they carry no wallet/cost metadata (the
		// user pays their provider directly). Gated on the tier so Free never lists BYOK models in
		// the picker; the Settings panel shows its own disabled upgrade state.
		if (this.byokAllowed) {
			for (const provider of Object.keys(BYOK_PROVIDER_DEFAULTS) as ByokProviderId[]) {
				statuses.push(this.byokStatus(provider, settings, disabled));
			}
		}

		return statuses;
	}

	/** Status for one BYOK provider. Surfaces ONLY the models the user curated (`byok[p].models`),
	 *  not the provider's full catalogue, which can be dozens of models and would flood the picker.
	 *  The full list for the Settings combo is fetched separately ({@link byokModelList}). No network
	 *  call here: a BYOK key's validity is verified on use (and on "Load models"). Unmetered, since
	 *  BYOK bypasses our gateway/wallet (the user pays their provider directly). */
	private byokStatus(provider: ByokProviderId, settings: AiSettings, disabled: Set<string>): AiProviderStatus {
		const label = BYOK_PROVIDER_DEFAULTS[provider].label;
		const key = this.settings.byokKey(provider);
		if (!key) {
			return { provider, configured: false, reachable: false, detail: `No API key: add your ${label} key below`, models: [], completionModels: [] };
		}
		const curated = settings.byok[provider].models ?? [];
		const decorate = (model: string): AiModelInfo => ({
			provider,
			model,
			enabled: !disabled.has(`${provider}:${model}`),
			reasoning: isReasoningModel(provider, model),
			metered: false,
		});
		return {
			provider,
			configured: true,
			reachable: true,
			detail: curated.length ? undefined : `Add models under "Active provider" below`,
			models: curated.map(decorate),
			completionModels: [],
		};
	}

	/** The provider's full list of selectable chat models, for the Settings "add a model" combo.
	 *  Reads the STORED key (so the renderer saves before calling this). OpenAI/OpenRouter expose
	 *  `/models` (filtered to chat models); Anthropic has no usable `/models`, so a short static
	 *  list. Throws the provider's verbatim error on a bad key, so the renderer can surface it. */
	async byokModelList(provider: ByokProviderId): Promise<string[]> {
		// Gate the whole BYOK surface on the entitlement, not just the serving path: a non-entitled
		// caller (e.g. a direct IPC) gets nothing to enumerate. Harmless either way (it's the user's
		// own key against their own provider), but keeps BYOK uniformly Plus/Pro.
		if (!this.byokAllowed) {
			return [];
		}
		const key = this.settings.byokKey(provider);
		if (!key) {
			return [];
		}
		if (provider === 'byok-anthropic') {
			return [...BYOK_ANTHROPIC_MODELS];
		}
		const cfg = this.settings.get().byok[provider];
		const baseUrl = cfg.baseUrl?.trim() || BYOK_PROVIDER_DEFAULTS[provider].baseUrl;
		const ids = await new OpenAiProvider({ baseUrl, apiKey: key, model: cfg.model }).listModels();
		return ids.filter(isLikelyChatModel).sort((a, b) => a.localeCompare(b));
	}

	/** The signed-in user's live gateway plan usage (spend vs. budget), for the Account
	 *  modal's usage readout. Returns null when there's no gateway key (signed out) or the
	 *  gateway can't be reached — the modal then simply omits the usage section. */
	async budgetStatus(): Promise<AiBudgetStatus | null> {
		if (this.scriptedAccount) {
			return this.scriptedAccount.budget;
		}
		const apiKey = this.settings.apiKey('positron-cloud');
		if (!apiKey) {
			return null;
		}
		const cloud = this.settings.get()['positron-cloud'];
		const baseUrl = cloud.baseUrl?.trim() || CLOUD_BASE['positron-cloud'];
		try {
			const status = await new OpenAiProvider({ baseUrl, apiKey, model: cloud.model }).keyInfo();
			// The pay-as-you-go credit balance, when the user has bought any, so the Account screen
			// can show it beside the monthly wallet. Best-effort: when it cannot be read the credits
			// block is simply omitted.
			const credits = await this.creditStatus();
			return credits ? { ...status, credits } : status;
		} catch {
			return null;
		}
	}

	/** The pay-as-you-go credit balance as the account service reports it (the `ai-credits` Snout
	 *  Function, with the user's own session), or null when the user has no top-up key (no credits
	 *  bought) or the balance cannot be read. Never computed here. */
	private async creditStatus(): Promise<AiBudgetStatus['credits'] | null> {
		if (!this.settings.topupKey()) {
			return null;
		}
		return readCreditBalance((name) => getCloudClient().fn.call(name));
	}


	/** List models from a specific Ollama endpoint — backs the settings model picker's
	 *  refresh, using the in-form endpoint (not necessarily the saved one). */
	async ollamaModels(endpoint: string): Promise<string[]> {
		return new OllamaProvider(endpoint, '').listModels();
	}

	/** Validate the current settings with a tiny round-trip; returns ok + a sample. */
	async test(): Promise<{ ok: boolean; message: string }> {
		const settings = this.settings.get();
		const { providerId, model } = this.chatTarget(settings);
		try {
			const provider = this.buildProvider(settings, providerId, model);
			let sample = '';
			await provider.chat([{ role: 'user', content: 'Reply with exactly: OK' }], { onDelta: (t) => { sample += t; } });
			return { ok: true, message: sample.trim() ? `Model replied: ${sample.trim().slice(0, 60)}` : 'Connected (empty reply).' };
		} catch (err) {
			return { ok: false, message: this.explain(err, settings, providerId).message };
		}
	}

	/** Turn low-level provider errors (e.g. "fetch failed") into actionable guidance,
	 *  keyed on the provider actually used (which differs from `settings.provider` when
	 *  completion overrides the model). */
	private explain(err: unknown, settings: AiSettings, providerId: AiProviderId): Error {
		const message = err instanceof Error ? err.message : String(err);
		const networkErr = isNetworkError(err);
		// The gateway's monthly budget (or a BYO provider's spend cap) is exhausted. The raw body
		// ("OpenAI 429: {…budget_exceeded…}") is useless to a user, so translate it before it can
		// reach the chat. If we got here with credits enabled, the top-up key fallback also ran dry.
		if (isBudgetExceeded(err)) {
			if (isByokProvider(providerId)) {
				return new Error(`${BYOK_PROVIDER_DEFAULTS[providerId].label} reports your account has hit its spending limit. Raise the limit (or check billing) with ${BYOK_PROVIDER_DEFAULTS[providerId].label}, then try again.`);
			}
			return new Error("You've used up your monthly AI credits. Upgrade or manage your plan at snoutdata.com to keep using the assistant, or wait for them to reset next month.");
		}
		if (providerId === 'ollama' && networkErr) {
			return new Error(`Can't reach Ollama at ${settings.ollama.endpoint}. Start it (run "ollama serve") and make sure the model is pulled, then try again.`);
		}
		if (providerId === 'positron-cloud' && /\b401\b|\b403\b|invalid.*api.*key|unauthor|authentication|incorrect api key/i.test(message)) {
			return new Error(`${CLOUD_LABEL[providerId]} rejected the request. Check the API key under Settings → AI → Chat. (${message})`);
		}
		// BYOK: keep the provider's verbatim error (bad-key UX is where BYOK products die), but
		// point the user at where their key lives. Auth failures are the common case.
		if (isByokProvider(providerId) && /\b401\b|\b403\b|invalid.*api.*key|unauthor|authentication|incorrect api key/i.test(message)) {
			return new Error(`${BYOK_PROVIDER_DEFAULTS[providerId].label} rejected your API key. Check it under Settings → AI. (${message})`);
		}
		// Couldn't reach the AI service at all (timeout, refused/reset, DNS, or a corporate
		// TLS/proxy block). Say so plainly instead of leaking a raw "net::ERR_…" into the chat; the
		// company-policy sentence is kept for an error that actually shows a proxy or certificate
		// block. BYOK hits the user's own provider, so name that one.
		if (networkErr) {
			return new Error(networkBlockedMessage(isByokProvider(providerId) ? BYOK_PROVIDER_DEFAULTS[providerId].label : 'the AI service', err));
		}
		return err instanceof Error ? err : new Error(message);
	}

	/** Build a provider for an explicit (providerId, model), wrapping it in
	 *  {@link LoggingProvider} when dev debug logging is on so every round-trip is captured. */
	private buildProvider(settings: AiSettings, providerId: AiProviderId, model: string): ModelProvider {
		// E2E only, and only ever installed under the scratch profile. Here rather than at each
		// caller because this is the one funnel: scripting it leaves the prompt building, the
		// streaming, the audit record and the error handling as the real thing.
		if (this.scriptedModel) {
			return this.scriptedModel;
		}
		const provider = this.rawProvider(settings, providerId, model);
		return this.debugEnabled ? new LoggingProvider(provider, { provider: providerId, model }) : provider;
	}

	/** The bare provider for an explicit (providerId, model), reusing the shared
	 *  endpoint/API-key from settings. Local Ollama (hidden, gated later) still resolves so
	 *  saved-as-ollama settings keep working; everything else is the OpenAI-compatible gateway. */
	private rawProvider(settings: AiSettings, providerId: AiProviderId, model: string): ModelProvider {
		if (providerId === 'ollama') {
			return new OllamaProvider(settings.ollama.endpoint, model);
		}
		// Bring-Your-Own-Key: talk to the user's provider directly, bypassing our gateway, so keys
		// and prompts never touch our servers. The entitlement is enforced HERE, not just in the
		// settings UI — assume the panel can be bypassed by editing local state. No `endUser` is
		// sent (it's not our gateway, there's no end-user attribution).
		if (isByokProvider(providerId)) {
			if (!this.byokAllowed) {
				throw new Error('Bring-your-own-key is part of Plus, Pro and Business. Upgrade your plan to point the assistant at your own provider key.');
			}
			const cfg = settings.byok[providerId];
			const apiKey = this.settings.byokKey(providerId);
			if (!apiKey) {
				throw new Error(`Add your ${BYOK_PROVIDER_DEFAULTS[providerId].label} API key under Settings → AI to use this provider.`);
			}
			const baseUrl = cfg.baseUrl?.trim() || BYOK_PROVIDER_DEFAULTS[providerId].baseUrl;
			return new OpenAiProvider({ baseUrl, apiKey, model });
		}
		const cloud = settings['positron-cloud'];
		const baseUrl = cloud.baseUrl?.trim() || CLOUD_BASE['positron-cloud'];
		const apiKey = this.settings.apiKey('positron-cloud') ?? '';
		// Cache the prompt prefix on the gateway path only, and only for models that actually
		// support it: a non-Anthropic Bedrock model answers a cache_control request with a 500, so
		// this is correctness, not tuning (see supportsPromptCaching). BYOK above leaves it off so
		// the user's raw provider endpoint never sees the field.
		return new OpenAiProvider({ baseUrl, apiKey, model, endUser: this.settings.endUser(), cacheControl: supportsPromptCaching(model) });
	}

	/** A provider that bills the persistent top-up (credits) key instead of the monthly key, for
	 *  the credits fallback. Only applies to the gateway and only when a top-up key is stored;
	 *  returns undefined otherwise so the caller surfaces the limit instead.
	 *  Wrapped in {@link LoggingProvider} in dev like {@link buildProvider}. */
	private buildTopupProvider(settings: AiSettings, providerId: AiProviderId, model: string): ModelProvider | undefined {
		if (providerId !== 'positron-cloud') {
			return undefined;
		}
		const topupKey = this.settings.topupKey();
		if (!topupKey) {
			return undefined;
		}
		const cloud = settings['positron-cloud'];
		const baseUrl = cloud.baseUrl?.trim() || CLOUD_BASE['positron-cloud'];
		const provider = new OpenAiProvider({ baseUrl, apiKey: topupKey, model, endUser: this.settings.endUser(), cacheControl: supportsPromptCaching(model) });
		return this.debugEnabled ? new LoggingProvider(provider, { provider: providerId, model }) : provider;
	}

	/** The (provider, model) for the chat assistant — the primary provider selection. */
	private chatTarget(settings: AiSettings): { providerId: AiProviderId; model: string } {
		return { providerId: settings.provider, model: this.modelFor(settings, settings.provider) };
	}

	/** The (provider, model) for an inline edit: the model picked in the Ctrl+K widget when
	 *  both fields are present, else the chat target. */
	private editTarget(settings: AiSettings, params: AiEditParams): { providerId: AiProviderId; model: string } {
		if (params.provider && params.model) {
			return { providerId: params.provider, model: params.model };
		}
		return this.chatTarget(settings);
	}

	private modelFor(settings: AiSettings, provider: AiProviderId): string {
		switch (provider) {
			case 'ollama': return settings.ollama.model;
			case 'positron-cloud': return settings['positron-cloud'].model;
			case 'byok-openai':
			case 'byok-openrouter':
			case 'byok-anthropic': return settings.byok[provider].model;
		}
	}

	/** The (provider, model) for inline completion. Server-driven: the FIM model id lives in the
	 *  gateway catalog (`role: 'completion'`), so a completion-model swap/rename lands with no app
	 *  release. The stored override is honored while it's still a live completion model; once it
	 *  isn't (e.g. the id was retired server-side) the app follows the catalog's preferred
	 *  completion model. Falls back to the stored/default id when the catalog is unavailable
	 *  (offline) or holds no completion model, so completion still works cold. */
	private async completionTarget(settings: AiSettings): Promise<{ providerId: AiProviderId; model: string }> {
		const choice = settings.completion;
		if (choice && choice.model) {
			// Completion-only (base/FIM) models live only on the gateway, never on a BYOK provider
			// (BYOK surfaces no completion models): completion needs a fill-in-the-middle model, and
			// we cannot count on the user's own provider or model offering one, so completion always
			// uses SnoutData's completion model through our gateway, even with a BYOK key set. The
			// settings and the website say so wherever they describe BYOK. The completion picker stamps the active chat
			// provider onto the choice, so a BYOK active provider can leave a gateway model (e.g.
			// snout-fim-1.0) paired with a BYOK provider id — route it back to the gateway so
			// completion still works instead of demanding a BYOK key for a model BYOK can't serve.
			if (isCompletionOnlyModel(choice.model)) {
				return { providerId: 'positron-cloud', model: choice.model };
			}
			// When the catalog is reachable it's the source of truth: keep the stored model if it's
			// still tagged a completion model, else follow the catalog's preferred one (so a
			// server-side id swap needs no release). Offline / nothing tagged → trust the stored id.
			const catalog = await this.readCatalog();
			if (catalog.size > 0 && catalog.get(choice.model)?.role !== 'completion') {
				const preferred = preferredCompletionModel(catalog);
				if (preferred) {
					return { providerId: 'positron-cloud', model: preferred };
				}
			}
			return { providerId: choice.provider, model: choice.model };
		}
		return this.chatTarget(settings);
	}

	/** Per-table query-history frequency for a connection (lowercased name → count), used to rank
	 *  the schema toward tables the user actually queries (A5). Reads the most recent
	 *  {@link USAGE_HISTORY_LIMIT} queries for the connection so the parse stays cheap. Undefined
	 *  with no connection (nothing to count). */
	private tableUsage(connectionId: string | undefined): Map<string, number> | undefined {
		if (!connectionId) {
			return undefined;
		}
		const sqls = this.queries.history()
			.filter((q) => q.connectionId === connectionId)
			.slice(0, USAGE_HISTORY_LIMIT)
			.map((q) => q.sql);
		return sqls.length > 0 ? buildTableUsage(sqls) : undefined;
	}

	private async context(activeConnectionId: string | undefined): Promise<{ dialect: string; driverId: string | undefined; schema: DatabaseSchema | null; kind: BackendKind }> {
		if (!activeConnectionId) {
			return { dialect: 'SQL', driverId: undefined, schema: null, kind: 'relational' };
		}
		const config = this.connections.state().connections.find((c) => c.id === activeConnectionId);
		const kind = backendKindForDriver(config?.driver);
		// Document backends (MongoDB) ground the prompt in their native flavour ("MongoDB aggregation
		// pipeline") rather than the SQL dialect name; the document-mode prompt then proposes a ```json
		// pipeline. Relational connections keep the per-vendor SQL dialect name.
		const dialect = kind === 'document' ? 'MongoDB' : engineAiDisplayName(config?.driver, config?.flavor);
		const schema = (await this.connections.getSchema(activeConnectionId)) ?? null;
		// The driver id selects the dialect whose identifier-quoting the prompt applies to reserved-word
		// table/column names (so the model is shown `"order"` / `` `order` `` / `[order]`, not bare order).
		return { dialect, driverId: config?.driver, schema, kind };
	}

	/** Every currently-connected database as `{ label, dialect }`, for the "ambiguous dialect" prompt
	 *  (no connection selected + more than one connected). Dialect resolution mirrors {@link context}:
	 *  a document backend is "MongoDB", a relational one its vendor display name. */
	private connectedDialects(): { label: string; dialect: string }[] {
		const { connections, connectedIds } = this.connections.state();
		return connectedIds.map((id) => {
			const config = connections.find((c) => c.id === id);
			const dialect = backendKindForDriver(config?.driver) === 'document' ? 'MongoDB' : engineAiDisplayName(config?.driver, config?.flavor);
			return { label: config?.label ?? id, dialect };
		});
	}
}

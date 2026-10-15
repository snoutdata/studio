/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// App-shell contracts for the AI assistant. The ModelProvider seam mirrors the
// DatabaseDriver seam: one interface, multiple implementations behind it, and the
// assistant never special-cases a backend. Non-secret settings live in config; the
// only secret (the gateway API key) goes to the keychain.

import type { QueryField } from './query';
import type { DataAccessLevel } from './engine';

export type AiProviderId = 'ollama' | 'positron-cloud' | ByokProviderId;

/** Bring-Your-Own-Key providers: the user supplies their own API key and the assistant talks to
 *  the provider directly, bypassing the hosted gateway so keys/prompts never touch our servers.
 *  All three are served by `OpenAiProvider` — OpenAI and OpenRouter are natively OpenAI-compatible,
 *  Anthropic via its OpenAI-compatible `/v1/chat/completions` endpoint. Plus/Pro only. */
export type ByokProviderId = 'byok-openai' | 'byok-openrouter' | 'byok-anthropic';

/** Per-BYOK-provider defaults: display label + the default `baseUrl` (including the version
 *  segment — the provider appends `/chat/completions`). The user may override `baseUrl` per
 *  provider (proxies, Azure OpenAI, self-host); see {@link ByokSettings}. */
export const BYOK_PROVIDER_DEFAULTS: Record<ByokProviderId, { label: string; baseUrl: string }> = {
	'byok-openai': { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
	'byok-openrouter': { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
	'byok-anthropic': { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' },
};

/**
 * The Anthropic models offered when a user brings an Anthropic key. Anthropic's OpenAI-compatible
 * endpoint has no usable /models list, so this is a static set; the model field is free text, so a
 * newer id can always be typed. Kept to ids Anthropic serves now: a retired id here is a suggestion
 * that fails on the user's first message.
 */
export const BYOK_ANTHROPIC_MODELS: readonly string[] = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

/** Whether a provider id is one of the BYOK providers (vs. the gateway / local Ollama). */
export function isByokProvider(provider: AiProviderId): provider is ByokProviderId {
	return provider === 'byok-openai' || provider === 'byok-openrouter' || provider === 'byok-anthropic';
}

/** Hosted, API-key chat providers. `positron-cloud` is the app's own OpenAI-compatible
 *  gateway (api.snoutdata.com): same wire format as OpenAI, so it reuses that provider,
 *  but it serves a curated model set we enumerate cheaply (like Ollama) rather than a
 *  single configured model. Vendor models (GPT, Claude, …) are offered *through* the
 *  gateway — added to its config server-side — not as separate in-app providers. */
export type CloudProviderId = 'positron-cloud';

/** How AI inline completion is triggered: on demand (Alt+\) or automatically as you
 *  type (debounced — best with a fast local model). */
export type InlineCompletionMode = 'manual' | 'auto';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	/** On an assistant turn: the tools the model asked to call this turn. */
	toolCalls?: ToolCall[];
	/** On a tool turn: which {@link ToolCall} this message answers. */
	toolCallId?: string;
	/** On an assistant turn from a reasoning model (DeepSeek thinking mode): the
	 *  chain-of-thought the API requires echoed back to continue a tool-call turn. */
	reasoningContent?: string;
	/** On a user turn: documents the user attached as reference context (a report, spec, notes).
	 *  Each is already extracted + size-capped in main (a budget-bounded digest, never the raw
	 *  file — see src/main/ai/documentDigest.ts), so AiService folds them straight into the
	 *  message the model sees. Never on other roles. */
	attachments?: DocumentAttachment[];
}

/**
 * A document the user attached to a chat turn so the assistant can reason over it (e.g. "write
 * the query this report describes"). The whole file is never sent: main extracts the text and, if
 * it exceeds {@link DOCUMENT_CHAR_BUDGET}, replaces it with a cross-document digest (the lead of
 * each page/section) so the budget buys coverage of the WHOLE file rather than just its first
 * pages. The `text` here is already that bounded result, safe to fold into the prompt and persist
 * with the chat.
 */
export interface DocumentAttachment {
	/** The file's base name, shown as a chip and labelled in the prompt (e.g. "q3-report.pdf"). */
	name: string;
	/** Extracted, whitespace-cleaned text: the whole document when it fit the budget, else a
	 *  digest of leads sampled across it. Always within the budget. */
	text: string;
	/** True when {@link text} is a digest/excerpt rather than the whole document. */
	truncated: boolean;
	/** Characters extracted before capping, so the chip can show "6k of 48k sent". */
	originalChars: number;
	/** How the digest was assembled, for the chip + the prompt label (e.g. "lead of each of 12
	 *  pages", "sampled 30 of 210 pages"). Absent when the whole document was sent. */
	coverage?: string;
}

/** Hard per-document character budget after extraction. Small on purpose: an attachment rides
 *  every later turn (the history replays in full each turn), so it must stay a fraction of the
 *  schema budget. Over this, the document is digested (lead-per-section) instead of head-cut. */
export const DOCUMENT_CHAR_BUDGET = 6000;

/** Result of an `ai:pickDocument` request: the extracted + capped attachment, a clean error
 *  (unsupported type, unreadable, parse failure), or null when the user cancelled the picker. */
export type ExtractDocumentResult =
	| { ok: true; attachment: DocumentAttachment }
	| { ok: false; error: string };

/**
 * A tool the model may call, with JSON-Schema arguments. Each provider translates this
 * neutral shape to its own wire format, the same way {@link ChatMessage} is translated —
 * so the agent loop never special-cases a backend.
 */
export interface ToolSpec {
	name: string;
	description: string;
	/** JSON Schema (an object schema) describing the tool's arguments. */
	parameters: Record<string, unknown>;
}

/** The model's request to call a tool — one step of the agent loop. */
export interface ToolCall {
	/** Provider-assigned id, used to match the result back to the call. */
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** The outcome fed back to the model for a {@link ToolCall}. */
export interface ToolResult {
	callId: string;
	/** Serialized result the model reads (a text table, DDL, or an error message). */
	content: string;
	isError?: boolean;
}

/** A tool step surfaced to the chat panel as the agent loop runs. */
export interface AiToolEvent {
	callId: string;
	/** The tool name, e.g. "describe_table". */
	tool: string;
	/** 'start' when the call begins, 'end' when it resolves. */
	phase: 'start' | 'end';
	/** Human summary, e.g. the table name (start) or "42 rows" (end). */
	summary: string;
	isError?: boolean;
}

/** Main → renderer: a request to approve an action before it runs. Either `sql` (a run_query
 *  call, with a connection) or `summary` (a generic mutating renderer capability) is present. */
export interface AiApprovalRequest {
	requestId: string;
	callId: string;
	/** Present for run_query: the SQL to show in a code block. */
	sql?: string;
	/** Present for a generic mutating capability: a one-line "the assistant wants to <summary>". */
	summary?: string;
	/** The connection the query runs against — lets the card offer "Always allow for <it>". */
	connectionId?: string;
}

export interface OllamaSettings {
	endpoint: string;
	model: string;
}

/** A hosted, API-key chat provider (OpenAI, Anthropic, DeepSeek). The API key itself is
 *  encrypted in the keychain, never stored here. */
export interface CloudSettings {
	model: string;
	/** Optional base-URL override; defaults to the vendor's public endpoint. */
	baseUrl?: string;
}

/** Non-secret settings for one Bring-Your-Own-Key provider: the selected model and an optional
 *  base-URL override (defaults to the provider's endpoint in {@link BYOK_PROVIDER_DEFAULTS}). The
 *  API key itself is encrypted in the keychain (`__byok_<provider>__`), never stored here. */
export interface ByokSettings {
	/** The currently-selected (active) model when this provider is the active one. Set by the chat
	 *  model picker; kept in sync with {@link models} (always one of them, or empty). */
	model: string;
	/** The curated models the user added for this provider: the only ones surfaced in the picker.
	 *  Opt-in by design, because a provider's full catalogue (OpenAI lists ~70+) would flood the
	 *  picker. The full list is fetched separately for the Settings combo, never auto-added here. */
	models: string[];
	/** Base-URL override; blank/absent ⇒ the provider's default endpoint is used. */
	baseUrl?: string;
}

/** How the assistant behaves, independent of which provider serves the model. */
export interface AiBehaviorSettings {
	/** Extra free-text guidance appended to the system prompt (tone, conventions). */
	instructions: string;
	/** Max characters of schema to inline before falling back to table-names-only. */
	maxSchemaChars: number;
	/** How many relevance-ranked tables to fully describe (columns + keys) in the prompt.
	 *  The remaining tables aren't enumerated — the assistant discovers them on demand via
	 *  tools. Keeps the prompt small enough for local models to actually follow while still
	 *  grounding on the tables that matter for the question. */
	topTables: number;
	/** Auto-insert the first proposed SQL block into the editor when a reply finishes.
	 *  Off by default — the user inserts via the buttons under each SQL block. */
	autoInsertSql: boolean;
	/** Enable AI completion (ghost text). Off by default: unlike the deterministic
	 *  completion it calls the model, so it's opt-in. */
	inlineCompletion: boolean;
	/** When enabled, whether it fires on demand (Alt+\) or automatically as you type. */
	inlineCompletionMode: InlineCompletionMode;
	/** The model the knowledge observer ("Remember this?" after a reply that proposes SQL) asks, on
	 *  the assistant's own provider. ONLY read by a build from the open-source tree, which has no
	 *  inexpensive observer model of its own: there the observer is a second, hidden model call per
	 *  such turn, so it stays OFF while this is empty. The official build ignores it. */
	observerModel: string;
}

/**
 * Which agent tools the assistant may call, and the loop's safety caps. The user controls
 * exactly what the assistant can see and do from Settings → AI → Agent. When `enabled` is
 * off (or the selected model can't do tool calls), the assistant uses the one-shot,
 * schema-grounded path instead of the loop.
 */
export interface AiToolSettings {
	/** Master switch for the agent loop. */
	enabled: boolean;
	/** List table names from the cached schema (no DB round-trip). */
	listTables: boolean;
	/** Read a table's columns/types/keys/indexes (its DDL) from the cached schema. */
	describeTable: boolean;
	/** Search tables/columns by name across the schema. */
	searchColumns: boolean;
	/** Run a read-only query against the database — each call needs the user's approval. */
	runQuery: boolean;
	/** Connection ids the user trusts to run read-only queries without per-query approval
	 *  ("Always allow" on the approval card; revertable in Settings → AI → Agent). */
	autoApproveConnections: string[];
	/** Max model↔tool round-trips before the loop stops and must conclude. */
	maxSteps: number;
	/** Max rows run_query returns (it auto-LIMITs unbounded SELECTs to this). */
	maxRows: number;
}

/** A provider+model pick for a specific role (used to override the completion model). */
export interface AiModelChoice {
	provider: AiProviderId;
	model: string;
}

/** Gateway models that are base/FIM (completion) models, never valid as a chat target. They
 *  back inline completion via the `completion` override but must not appear in the chat picker
 *  or be selectable as the chat model. Keep in sync with the gateway's `config.yaml`. */
export const COMPLETION_ONLY_MODELS = new Set<string>(['snout-fim-1.0']);

/** Whether `model` is a completion-only (base/FIM) gateway model — see {@link COMPLETION_ONLY_MODELS}. */
export function isCompletionOnlyModel(model: string): boolean {
	return COMPLETION_ONLY_MODELS.has(model);
}

/** Old → current completion-model ids, applied when reading stored settings. The completion model
 *  is `snout-fim-1.0`, served from Qwen2.5-Coder with fill-in-the-middle; earlier ids were the
 *  vendor's own (`qwen2.5-coder-3b`) and the unversioned `snout-fim-1`. An existing user's
 *  `ai.json` may still name one of those, so it is migrated on read. */
export const COMPLETION_MODEL_RENAMES: Record<string, string> = {
	'qwen2.5-coder-3b': 'snout-fim-1.0',
	'snout-fim-1': 'snout-fim-1.0',
};

/** Non-secret AI settings. The gateway API key is stored separately (keychain). */
export interface AiSettings {
	/** Primary provider — used for the chat assistant, and for completion unless
	 *  `completion` overrides it. */
	provider: AiProviderId;
	/** Local Ollama — kept for the (soon-to-be-gated) BYO-local-model feature; hidden from
	 *  the picker for now. */
	ollama: OllamaSettings;
	/** The app's own OpenAI-compatible gateway (api.snoutdata.com). Keyed by the provider
	 *  id so `settings[provider]` resolves uniformly across the codebase. */
	'positron-cloud': CloudSettings;
	/** Bring-Your-Own-Key providers, keyed by provider id. Each holds the chosen model + an
	 *  optional baseUrl override; the API key lives in the keychain. Gated to Plus/Pro and
	 *  enforced in main. */
	byok: Record<ByokProviderId, ByokSettings>;
	behavior: AiBehaviorSettings;
	/** The agent loop's tool permissions + caps. */
	tools: AiToolSettings;
	/** Optional separate model for inline completion (e.g. a faster gateway model for
	 *  completion than chat). When omitted, completion uses the chat provider+model. */
	completion?: AiModelChoice;
	/** Models the user has hidden from the chat picker, keyed "provider:model".
	 *  Default-on: any available model not listed here shows in the picker. */
	disabledModels?: string[];
	/** What the AI may see of a database (engine/context/dataAccess.ts). Absent means the user has
	 *  never chosen: it then behaves as `DEFAULT_DATA_ACCESS`, and the assistant asks. Applies to
	 *  the assistant and to agents over MCP alike. */
	dataAccess?: DataAccessLevel;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
	provider: 'positron-cloud',
	ollama: { endpoint: 'http://localhost:11434', model: 'qwen2.5-coder:7b' },
	// New users default to the recommended gateway model rather than a local one: a better first
	// impression, with a large context. A returning user keeps whatever they saved; this only seeds a
	// fresh install. Keep it in step with the model the server marks recommended, which is what the
	// picker tags and what ChatPanel falls back to when a saved model disappears.
	'positron-cloud': { model: 'gpt-5.6-luna' },
	// BYOK: no key/model chosen until the user configures one (Plus/Pro, Settings → AI). baseUrl
	// left unset so the provider default (BYOK_PROVIDER_DEFAULTS) applies unless overridden.
	byok: {
		'byok-openai': { model: '', models: [] },
		'byok-openrouter': { model: '', models: [] },
		'byok-anthropic': { model: '', models: [] },
	},
	behavior: { instructions: '', maxSchemaChars: 24000, topTables: 8, autoInsertSql: false, inlineCompletion: false, inlineCompletionMode: 'manual', observerModel: '' },
	tools: { enabled: true, listTables: true, describeTable: true, searchColumns: true, runQuery: true, autoApproveConnections: [], maxSteps: 15, maxRows: 200 },
	// Completion uses `snout-fim-1.0`, served from Qwen2.5-Coder with fill-in-the-middle; chat
	// uses the instruct model above. A FIM model is a text-completer, not chat-tuned, so it must
	// never serve the chat role.
	completion: { provider: 'positron-cloud', model: 'snout-fim-1.0' },
};

/** Values the AI settings form submits; secrets are optional on edit (blank = keep the
 *  stored one). The gateway API key goes to the keychain. */
export interface AiSettingsFormValues extends AiSettings {
	/** API key(s) for the gateway and any configured BYOK provider; absent/blank leaves the
	 *  stored key intact. Each goes to its own keychain slot. */
	apiKeys?: Partial<Record<CloudProviderId | ByokProviderId, string>>;
}

/** Token accounting for one model turn — and, summed, for a whole chat session.
 *  Best-effort: providers that don't report counts leave this undefined. */
export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Prefix tokens served from the provider's prompt cache (~0.1x input price). Present only
	 *  when the backend reports caching (the gateway models that support it); 0 or absent
	 *  otherwise. The signal that caching is actually firing. */
	cacheReadTokens?: number;
	/** Prefix tokens written to the prompt cache this turn (~1.25x input price for the 5m TTL).
	 *  Paid once when a new prefix is cached; subsequent turns read it instead. */
	cacheWriteTokens?: number;
}

/** A compact snapshot of what the user is looking at on screen *right now*, pushed with each
 *  chat turn so the assistant grounds in the live app state (the query in the editor, the
 *  result shape, the last error) without the user restating it. The "the app already knows
 *  this" set. Shapes + a small bounded sample of values (the focused cell/row and the first
 *  few result rows) — never secrets, never the whole result set. Assembled cheaply in the
 *  renderer at send time; folded into the prompt by AiService. Every field is optional: an
 *  empty bundle (no editor open, nothing run yet) is valid. */
export interface AmbientContext {
	/** The full SQL of the active editor tab — what the user is looking at / about to run. */
	editorBuffer?: string;
	/** The text highlighted in the editor, if any (a sub-range of {@link editorBuffer}). */
	selection?: string;
	/** The columns (name + type) of the result grid currently showing — shape, not rows. */
	resultColumns?: QueryField[];
	/** A tiny sample of the result rows (the first few, stringified the way the grid shows them,
	 *  aligned to {@link resultColumns}), so even the free one-shot path can reason about the
	 *  actual DATA on screen ("what's the max here", "which row looks wrong") — not just the
	 *  shape. Tightly bounded by the prompt builder (rows + per-cell chars); pushed every turn a
	 *  result is up, so it stays small on purpose. The precise, on-demand view is the
	 *  `get_query_result` capability (agentic); this is the always-on cheap glance. */
	resultRows?: string[][];
	/** The cell the user has focused in the result grid (its column + stringified value), so
	 *  "what is this value" / "filter to rows like this" work without the user describing it. */
	selectedCell?: AmbientCell;
	/** The whole row the focused cell sits in (column + stringified value, per field). Bounded
	 *  by the prompt builder; gives "explain this row" the surrounding values. */
	selectedRow?: AmbientCell[];
	/** The error text from the most recent failed run, when the last run failed. */
	lastError?: string;
	/** A caution retrieved from failure memory when the query in the editor is structurally similar
	 *  to one that previously failed on this schema. Unlike the other fields, this is filled by
	 *  MAIN (not the renderer): it's derived server-side from the editor buffer + the failure
	 *  store, and injected into the grounding block. */
	memoryNote?: string;
	/** The table the user is looking at when the active tab is a table-view tab (browsing or
	 *  designing a table from the schema explorer), rather than a SQL editor. A table tab has no
	 *  editor buffer, so without this the AI is blind to "the table I have open" — identity only
	 *  (schema + name); its columns come from the ranked schema block. */
	focusedTable?: { schema?: string; name: string };
	/** The database object (procedure/function/trigger) the user is viewing when the active tab is
	 *  an object tab. Unlike a table (whose columns ride the schema block), a routine/trigger body
	 *  has no other cheap channel into the prompt, so a clipped DDL comes along so "explain this
	 *  procedure" / "what does this trigger do" work with no paste. */
	focusedObject?: { kind: string; schema?: string; name: string; ddl?: string };
	/** The OTHER open SQL editor tabs (not the active one, which is already {@link editorBuffer}):
	 *  title + clipped SQL, so "combine this with the query in my other tab" works. Empty/whitespace
	 *  tabs are skipped; capped in count and per-tab chars by the prompt builder so a wall of tabs
	 *  can't blow the budget. */
	otherTabs?: { title: string; sql: string }[];
	/** The user's saved connections (identity only — no host/credentials), so the assistant can
	 *  resolve an environment ("prod"/"staging"/"dev") or a name to a specific connection and know
	 *  which is currently active, WITHOUT a tool round-trip. This is the always-on cheap glance;
	 *  the precise read is the `list_connections` capability. Powers "look at this in prod": the
	 *  assistant matches by tag or by name, and opens a not-yet-connected match via the approval-
	 *  gated `connect` capability. */
	connections?: { id: string; label: string; environment?: string; connected: boolean; active: boolean }[];
	/** The Data Flow wizard on screen when the active tab is a flow tab. The wizard is a multi-step
	 *  form (source → preview → columns → destination → schedule → review), so the assistant gets
	 *  the step the user is on and what the flow holds so far — "these columns", "this file",
	 *  "the destination" resolve without the user restating them. Filled by the wizard, rendered
	 *  by the engine prompt builder as the fixed per-step grounding; the user's typed message is
	 *  the custom half. */
	flowWizard?: AmbientFlowWizard;
	/** Which chat surface sent this turn: the docked side panel or the full-screen AI Chat. Full
	 *  chat is a results-first surface (the user isn't looking at their editor), so when the ask is
	 *  for a chart the assistant renders the chart and skips the raw ```sql block. */
	surface?: 'docked' | 'full';
	/** `'restricted'` when a connection is selected but the user, asked up front, chose NOT to
	 *  connect it for this turn: the assistant gets no DB tools (or DB-touching client capabilities)
	 *  and is told it can't fetch precise data, so it answers generally and points the user at
	 *  connecting for a data-backed answer.
	 *  `'ambiguous'` when NO connection is selected and MORE THAN ONE is connected: the SQL dialect
	 *  can't be inferred, so rather than guess, the assistant is told to ask the user which connected
	 *  database they mean before writing any SQL (main fills the candidate list + each one's dialect).
	 *  Absent ⇒ normal (a connection is selected/connected, or nothing is connected at all). */
	dbAccess?: 'restricted' | 'ambiguous';
}

/** One result-grid cell as ambient context: a column name and its value, already stringified
 *  for the prompt (NULLs/dates/blobs rendered the same way the grid shows them). */
export interface AmbientCell {
	column: string;
	value: string;
}

/** The Data Flow wizard's on-screen state, summarized for the prompt. Strings are pre-rendered
 *  by the wizard (it knows how to describe its own source/destination); the prompt builder only
 *  clips and formats, so this stays a dumb data bag. */
export interface AmbientFlowWizard {
	/** The wizard step on screen: 'source' | 'preview' | 'columns' | 'destination' | 'schedule' | 'review'. */
	step: string;
	/** Where the rows come from, one human line ("the CSV file orders.csv", "a crawl of https://…"). */
	source?: string;
	/** The proposed columns so far, with the wizard's current name/type/key/include decisions. */
	columns?: { name: string; type: string; included: boolean; key: boolean }[];
	/** Sampling warnings the wizard is showing (ambiguous dates, unreadable lines, …). */
	warnings?: string[];
	/** Where the rows land, one human line ("the table orders on Staging", "the CSV file out.csv"). */
	destination?: string;
	/** The declared purpose card ("Query and analyze it", …) — it steers typing and keys. */
	outcome?: string;
	/** The sample's row estimate for the full run, when known. */
	estimatedRows?: number;
	/** What the user can do on this step, already rendered by the wizard; the prompt builder adds it as is. */
	stepNote?: string;
	/** The workbench's own description of what it is set to write, when the records come from a
	 *  model rather than a source: already rendered by the wizard, so the prompt builder adds it as is. */
	generation?: string;
}

/** Result of an `ai:chat` request. Failures come back as a clean message (no raw
 *  "Error invoking remote method" wrapper) so the panel can show something useful. */
export interface AiChatResult {
	ok: boolean;
	error?: string;
	/** True when the user stopped the reply mid-stream (not a failure). */
	aborted?: boolean;
	/** Token usage the provider reported for this turn, when available. */
	usage?: TokenUsage;
}

/** One model call from the companion package: the renderer sends it, main runs and audits it
 *  (`AiService.libyChat`). */
export interface LibyChatRequest {
	system: string;
	messages: { role: 'user' | 'assistant'; content: string }[];
}

/** A selectable provider+model pair for the chat panel's combo (e.g. ollama:llama3). */
export interface AiModelOption {
	provider: AiProviderId;
	model: string;
}

/** Which kind of model call an {@link AiAuditEntry} records. */
export type AiAuditKind = 'chat' | 'completion' | 'edit' | 'action';

/** Who served an audited interaction. Usually one of our model providers, but an action can also
 *  come from `mcp` — an external agent driving the app's own tools, with no model of ours in the
 *  loop at all. The audit log is one trail across both, so this widens rather than forking it. */
export type AiAuditSource = AiProviderId | 'mcp';

/**
 * One recorded round-trip with a language model for the audit log — chat, inline
 * completion, or a Ctrl+K edit. Captures when it ran, which provider/model served it,
 * the conversation sent (system prompt omitted), and the model's reply, so every
 * interaction is reviewable after the fact. Persisted to userData/aiAudit.json.
 */
export interface AiAuditEntry {
	id: string;
	/** Epoch ms when the call started. */
	timestamp: number;
	kind: AiAuditKind;
	/** The model provider that served it, or `mcp` for an action an external agent drove. */
	provider: AiAuditSource;
	/** The model that served it. For an `mcp` action, the agent's client name (e.g. "claude-code"). */
	model: string;
	/** The connection the call was grounded in, when any. */
	connectionId?: string;
	/** The conversation sent to the model (system prompt omitted), oldest-first. */
	messages: ChatMessage[];
	/** The grounding system prompt the model was actually given for this turn — the dialect,
	 *  the relevance-ranked schema, and the ambient "what the user is looking at" block (the
	 *  pre-warmed context). Recorded so the audit shows what the AI knew and how big that
	 *  context was, for cost review. Chat turns only; omitted otherwise. */
	systemPrompt?: string;
	/** The model's reply text (may be partial if the user stopped a chat stream). */
	response: string;
	/**
	 * Set on `kind: 'action'` entries only: the structured facts of one tool or capability
	 * invocation. The generic fields carry it too, so the audit viewer renders an action with
	 * no special-casing (`messages` holds the call, `response` the outcome); this is for
	 * anything that needs to filter or reason about actions rather than read them.
	 */
	action?: {
		tool: string;
		/** `mcp` means an external agent drove it, which is the least-supervised path; `flow` is a
		 *  Data Flow's consent-gated extraction stage, which runs with nobody watching at all;
		 *  `review` is Snoutbot's optional prose pass over a finished pull-request review, which
		 *  runs on a poller with nobody watching either. */
		origin: 'chat' | 'mcp' | 'flow' | 'review';
		mutates: boolean;
		durationMs: number;
	};
	/** Set on `kind: 'completion'` entries only: what the guard did to the model's text and
	 *  whether the user took it. See {@link AiCompletionRecord}. */
	completion?: AiCompletionRecord;
	/** Token usage the provider reported, when available. */
	usage?: TokenUsage;
	/** Estimated USD this turn spent against the wallet: prompt tokens × input price + completion
	 *  tokens × output price, from the gateway's configured per-token rates.
	 *  0 for a model priced at $0; undefined when the price for the model isn't cached yet. Lets
	 *  the audit show per-turn dollar cost beside the token count, to judge how far a small wallet
	 *  stretches before deciding any caps. */
	costUsd?: number;
	/** Wall-clock duration of the call in ms. */
	durationMs: number;
	/** False when the call errored; a user-stopped stream stays true (partial reply kept). */
	ok: boolean;
	/** The error message when `ok` is false. */
	error?: string;
}

/** One model a provider offers, with whether it's enabled in the chat picker, plus the
 *  editorial metadata that drives the rich picker (display name, blurb, speed/power label,
 *  context window, recommended flag) sourced from the control plane's `released_models`, and the
 *  metered flag derived from the gateway price. All metadata fields are optional: a model
 *  with no row just shows its raw id. */
export interface AiModelInfo {
	provider: AiProviderId;
	model: string;
	/** False when the user has toggled it off under Settings → AI. */
	enabled: boolean;
	/** True for a reasoning ("thinking") model — see {@link isReasoningModel}. Marked in
	 *  the picker so the user can tell a chain-of-thought model from a plain one. */
	reasoning: boolean;
	/** True when calls draw down the wallet (gateway price > 0); false/undefined for a model the
	 *  gateway prices at $0. Every tier is metered by a dollar wallet and the local models are
	 *  priced, so false is the exception, not "local". Splits the Account screen's Included vs.
	 *  Metered lists. */
	metered?: boolean;
	/** How fast the model spends the wallet, bucketed from price — drives the picker's
	 *  "Included" / "Uses your balance" / "Uses more of your balance" hint. */
	usageWeight?: AiUsageWeight;
	/** Friendlier name than the raw id (e.g. "Qwen2.5 Coder 7B"). */
	displayName?: string;
	/** One- or two-line blurb shown in the picker's hover detail. */
	description?: string;
	/** Short speed/power tag shown as the picker sub-label (e.g. "Fast", "Balanced", "Powerful"). */
	label?: string;
	/** Token context window, shown in the hover detail (e.g. 32768 → "32K context"). */
	contextWindow?: number;
	/** True for the model flagged as the recommended default (tagged in the picker, and the
	 *  preferred fallback when the saved model is gone). */
	recommended?: boolean;
}

/**
 * Whether a model name denotes a reasoning ("thinking") model — one that produces a
 * chain of thought before answering. No provider exposes a capability flag in its model
 * list, so this is a name-based heuristic, matched case-insensitively. Used only to mark
 * models in the picker; it never changes how a model is called. Covers the cross-vendor
 * reasoning families: OpenAI o-series (o1/o3/o4), DeepSeek R1/reasoner, Qwen QwQ, and any
 * name carrying a "reason"/"think" marker. Hybrid models (e.g. Claude) aren't flagged —
 * there's no clean signal that a given name is in its thinking mode.
 */
export function isReasoningModel(_provider: AiProviderId, model: string): boolean {
	const name = model.toLowerCase();
	if (/reason|think/.test(name)) {
		return true;
	}
	// Token-level markers, so "deepseek-r1" → ["deepseek","r1"] and "gpt-4o" → ["gpt","4o"]
	// (the latter must NOT match the o-series rule).
	for (const token of name.split(/[^a-z0-9]+/)) {
		if (token === 'r1' || token === 'qwq') {
			return true;
		}
		// OpenAI o-series: a bare "o" followed by a version number (o1, o3, o4, o4-mini → "o4").
		if (/^o[1-9][0-9]?$/.test(token)) {
			return true;
		}
	}
	return false;
}

/**
 * Whether a gateway model accepts Anthropic-style `cache_control` breakpoints.
 *
 * This is a name heuristic in the same spirit as {@link isReasoningModel}, and it exists because
 * getting it wrong is not a missed optimisation but a HARD FAILURE: a model host answers a request
 * that carries cache_control for a model without prompt caching with an error ("You invoked an
 * unsupported model or your request did not allow prompt caching"), and the gateway surfaces that
 * as a 500 for the whole turn. Sending it to every gateway model was harmless only while every model
 * the gateway served supported it; the first OpenAI-family model there broke that assumption.
 *
 * It therefore DEFAULTS TO FALSE and opts in by family. An unknown model loses a cost saving; an
 * unknown model wrongly opted in loses the user's turn. Local models are excluded too: the gateway
 * drops the field for them, so there is nothing to gain and no reason to rely on that behaviour.
 *
 * The durable version of this is a `supports_caching` column on the control plane's `released_models`,
 * alongside `role` and `recommended`, so a new model needs no app release. Worth doing; this
 * function is what keeps the currently shipped builds from breaking in the meantime.
 */
export function supportsPromptCaching(model: string): boolean {
	return /claude|anthropic/i.test(model);
}

/** A provider's readiness plus the models it currently offers. Backs the Settings
 *  model list and the chat picker's availability gating: a provider only contributes
 *  models once it's configured/reachable. */
export interface AiProviderStatus {
	provider: AiProviderId;
	/** Has the minimum settings/credentials to be usable at all. */
	configured: boolean;
	/** Verified reachable (the endpoint answered with a model list). */
	reachable: boolean;
	/** Why it's unavailable, when it is (e.g. "Offline", "No credentials"). */
	detail?: string;
	/** Available chat models from this provider (empty when unconfigured/offline).
	 *  Completion-only base/FIM models are excluded — they live in {@link completionModels}. */
	models: AiModelInfo[];
	/** Completion-only (base/FIM) models — the complement of {@link models}. Back the
	 *  Auto-completion model picker, kept out of the chat list. Empty for providers that
	 *  expose none. */
	completionModels: AiModelInfo[];
}

/** A signed-in user's gateway plan usage, read live from the gateway (`/key/info`).
 *  Drives the Account modal's usage readout. A key with no `max_budget` (no spending cap) is
 *  not metered: `metered` is false and the dollar/percent fields are not meaningful. */
export interface AiBudgetStatus {
	/** True when the gateway reports a spending cap. When false the key carries no cap, so the
	 *  modal shows "Unlimited" instead of a bar. */
	metered: boolean;
	/** Real dollars spent this budget period (0 when nothing priced has been used). */
	spend: number;
	/** Hard spending cap in USD for the period, when the key carries one. */
	maxBudget?: number;
	/** Soft (early-warning) threshold in USD, when set — typically 80% of {@link maxBudget}. */
	softBudget?: number;
	/** Spend as a 0-100 percentage of {@link maxBudget}; only present when {@link metered}. */
	percentUsed?: number;
	/** ISO timestamp when the period (and the spend tally) next resets, when the gateway reports it. */
	resetAt?: string;
	/** Persistent, never-expiring pay-as-you-go credits, when the paid user has bought any, as the
	 *  account service reports them (the `ai-credits` Snout Function); absent for free users, paid
	 *  users with no purchases, and whenever the balance cannot be read. */
	credits?: AiCreditStatus;
}

/** The pay-as-you-go credit wallet: a pure lifetime ledger that never resets. All three fields are
 *  in the dollars the customer PAID (a $5 pack shows $5), computed by the account service; the app
 *  displays them and never derives them. */
export interface AiCreditStatus {
	/** Remaining credit in USD (`purchasedTotal − spend`). What's left to spend. */
	balance: number;
	/** Lifetime USD purchased. */
	purchasedTotal: number;
	/** Lifetime credit spend in USD (only ever grows). */
	spend: number;
}

/** One model the gateway offers, with whether using it costs real money. Read live from the
 *  gateway (`/model/info`): a model priced at $0 does not debit the wallet, so it is "included";
 *  a priced model, which since 2026-06-06 includes the self-hosted local models, is "metered"
 *  and counts toward the plan's spend. Drives the Account screen's "what's included vs.
 *  metered" model lists. */
export interface AiModelCost {
	/** The model id, matching the ids from `/v1/models` and the picker. */
	model: string;
	/** True when the model has a nonzero per-token price, so each use spends real budget.
	 *  False only for a model the gateway prices at $0. */
	metered: boolean;
	/** Headline price: USD per 1M output tokens (0 for a $0 model). Used to bucket how
	 *  fast a model spends the wallet ("Uses your balance" vs. "Uses more of your balance"). */
	outputPerMTok: number;
	/** USD per 1M *input* (prompt) tokens (0 for a $0 model). The schema-grounded system
	 *  prompt makes input the dominant cost, so this is needed to estimate a turn's true spend
	 *  against the wallet. */
	inputPerMTok: number;
}

/** How fast a model spends the wallet, bucketed from its price. `free` = a model priced at $0;
 *  `normal` = cheaper metered models; `heavy` = pricey ones (e.g. premium cloud) that drain the
 *  balance faster. Drives the picker's cost hint. */
export type AiUsageWeight = 'free' | 'normal' | 'heavy';

/** USD-per-1M-output-tokens at or above which a metered model counts as `heavy` (drains the
 *  balance noticeably faster). A rough line, re-tune as vendor prices move. */
export const HEAVY_USAGE_OUTPUT_PER_MTOK = 2;

/** Bucket a model's price into an {@link AiUsageWeight}. */
export function usageWeightForCost(metered: boolean, outputPerMTok: number): AiUsageWeight {
	if (!metered) {
		return 'free';
	}
	return outputPerMTok >= HEAVY_USAGE_OUTPUT_PER_MTOK ? 'heavy' : 'normal';
}

/** Request for an on-demand inline completion: the text around the editor cursor. */
export interface AiCompletionParams {
	/** Active connection, for dialect + schema grounding (undefined when none). */
	connectionId: string | undefined;
	/** Document text before the cursor. */
	prefix: string;
	/** Document text after the cursor. */
	suffix: string;
}

/** Result of an `ai:complete` request: the raw text to insert, or a clean error. `id` matches the
 *  audit entry, so the renderer can report back whether the suggestion was actually taken
 *  (see {@link AiCompletionOutcomeParams}). */
export type AiCompletionResult =
	| { ok: true; text: string; id: string }
	| { ok: false; error: string };

/** What the deterministic completion guard did to the model's text before it was shown
 *  (`shared/engine/context/completionGuard.ts`): passed it through, rewrote a hallucinated
 *  identifier to the real one, cut it where it went wrong, or dropped it entirely. */
export type CompletionVerdict = 'clean' | 'repaired' | 'truncated' | 'rejected';

/** What the user did with a suggestion that was shown. `partial` is Monaco's word/line accept
 *  (Ctrl+→), which is the common case for an identifier: the user takes the first word only. */
export type CompletionOutcome = 'shown' | 'partial' | 'accepted' | 'dismissed';

/** Renderer → main report on a shown completion. Fire-and-forget: this is measurement, and it
 *  must never block or fail the editor. */
export interface AiCompletionOutcomeParams {
	/** The `id` from the {@link AiCompletionResult} being reported on. */
	id: string;
	outcome: CompletionOutcome;
	/** Characters actually taken, for a `partial` accept. */
	acceptedChars?: number;
}

/** The completion-specific facts recorded on an audit entry: what the guard did, and what the
 *  user did with the result. This is the only place acceptance is measured — without it there is
 *  no way to tell whether a change to the completion path helped. */
export interface AiCompletionRecord {
	verdict: CompletionVerdict;
	/** How many identifiers the guard rewrote. */
	repairs: number;
	/** The identifier the completion was cut at, when it was truncated or rejected. */
	cut?: string;
	/** Characters of ghost text actually shown (post-guard). */
	shownChars: number;
	/** Filled in later, when the renderer reports back. */
	outcome?: CompletionOutcome;
	acceptedChars?: number;
}

/** Request for an inline editor edit (Ctrl+K): rewrite a selection, or generate SQL at the
 *  cursor when `selection` is empty. The model returns raw SQL to drop into the editor. */
export interface AiEditParams {
	/** Active connection, for dialect + schema grounding (undefined when none). */
	connectionId: string | undefined;
	/** Natural-language instruction — what to change, or what to create. */
	instruction: string;
	/** The selected SQL to rewrite; empty ⇒ generate new SQL at the cursor. */
	selection: string;
	/** The whole editor document, for context (aliases, CTEs). */
	document: string;
	/** Model override picked in the Ctrl+K widget. Both set ⇒ use this provider+model;
	 *  absent ⇒ fall back to the configured chat model. */
	provider?: AiProviderId;
	model?: string;
}

/** Result of an `ai:edit` request: the SQL to apply, or a clean error. */
export type AiEditResult =
	| { ok: true; text: string }
	| { ok: false; error: string };

/** The model the gateway serves embeddings under: `mxbai-embed-large` (1024 dimensions), the same
 *  model Ollama's default names, so an index built through either is searchable the same way. */
export const GATEWAY_EMBED_MODEL = 'mxbai-embed-large';

/**
 * The model the knowledge observer asks, or '' when it must not run.
 *
 * The official build is unchanged: its inexpensive gateway model on the gateway, else the chat
 * model (`chatModel`, read only then). A build from the open-source tree has no inexpensive model of
 * its own, so falling back to the chat model would be a hidden second call at full price after every
 * reply that proposes SQL; there the observer runs only on a model the user named
 * (`behavior.observerModel`), and is off while that is empty.
 */
export function observerModelFor(official: boolean, providerId: AiProviderId, officialObserverModel: string, userObserverModel: string, chatModel: () => string): string {
	if (!official) {
		return userObserverModel.trim();
	}
	return providerId === 'positron-cloud' && officialObserverModel ? officialObserverModel : chatModel();
}

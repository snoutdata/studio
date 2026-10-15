/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolCall } from '../../shared/ai';

// Some models emit tool calls as XML-ish text instead of via the provider's native
// tool-calling API — e.g. a model mimicking Claude's <invoke>/<parameter> markup, or any
// model nudged to use tools it can't structurally call. Left alone it streams to the user as
// gibberish and the agent loop, seeing no structured call, just stops. So we detect that
// markup, keep it out of the user-visible stream, and parse it into ToolCalls the loop runs
// like native ones. Namespace-agnostic: an optional "ns:" prefix on each tag is tolerated.

/** Opening/closing tag of a tool-call markup block (any namespace prefix). Also catches
 *  Gemma/harmony-style `<channel|>` / `<|channel|>` chat-template tokens that leak through
 *  Ollama's chat API — we treat them as end-of-real-content and suppress from there. */
const TOOL_TAG = /<\/?(?:[A-Za-z][\w.-]*:)?(?:function_calls?|tool_calls?|invoke|parameter)\b|<\|?channel\|>?/i;

/** A trailing fragment that might still grow into a tool tag — held back while streaming so
 *  a half-arrived "<invoke" never reaches the user. Anchored to the end of the buffer. */
const PARTIAL_TAG = /<\/?(?:[A-Za-z][\w.-]*:?)?$/;

/** One <invoke name="…"> … </invoke> block (with its inner parameters captured in group 2). */
const INVOKE = /<(?:[A-Za-z][\w.-]*:)?invoke\b[^>]*?\bname\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?invoke>/gi;

/** Fresh regex per call — these carry lastIndex state, so we never share one. */
function paramRegex(): RegExp {
	return /<(?:[A-Za-z][\w.-]*:)?parameter\b[^>]*?\bname\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?parameter>/gi;
}

function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

/** True when `text` contains tool-call markup we should handle. */
export function hasToolMarkup(text: string): boolean {
	return TOOL_TAG.test(text);
}

/** Parse any <invoke name="…"><parameter name="…">…</parameter></invoke> blocks into tool
 *  calls. Returns [] when there's no (complete) markup. */
export function parseTextToolCalls(text: string): ToolCall[] {
	const calls: ToolCall[] = [];
	INVOKE.lastIndex = 0;
	let invoke: RegExpExecArray | null;
	let index = 0;
	while ((invoke = INVOKE.exec(text)) !== null) {
		const args: Record<string, unknown> = {};
		const params = paramRegex();
		let param: RegExpExecArray | null;
		while ((param = params.exec(invoke[2])) !== null) {
			args[param[1]] = decodeEntities(param[2].trim());
		}
		calls.push({ id: `text_call_${index++}`, name: invoke[1], arguments: args });
	}
	return calls;
}

/** Natural-language tool calls small models emit instead of issuing a structured call:
 *  `Tool Call: list_tables()`, `Tool: describe_table({"name":"x"})`, `Calling
 *  run_query with {"sql":"..."}`. Anchored to a list of `validNames` so we don't
 *  false-match the model casually mentioning a tool in its prose. */
const NL_PATTERNS: RegExp[] = [
	/(?:Tool\s*Call|Tool|Calling|Invoke)\s*[:\s]\s*([a-zA-Z_]\w*)\s*\(\s*([\s\S]*?)\s*\)/gi,
	/(?:Calling|Invoke)\s+([a-zA-Z_]\w*)\s+with\s+(\{[\s\S]*?\})/gi,
];

/** Best-effort parse of the inside of `name(...)` into a key/value bag. Accepts JSON
 *  (`{"name":"x"}`), a bare quoted string (`"orders"` → `{value:"orders"}`), or
 *  comma-separated `key=value` pairs. Empty / unparseable → empty args; the tool
 *  dispatcher will reject with an actionable error the model can recover from. */
function parseLooseArgs(text: string): Record<string, unknown> {
	const trimmed = text.trim();
	if (!trimmed) {
		return {};
	}
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		if (typeof parsed === 'string') {
			return { value: parsed };
		}
	} catch {
		// Fall through to looser shapes.
	}
	const stripped = trimmed.replace(/^['"]|['"]$/g, '');
	if (!stripped.includes('=') && !stripped.includes(':')) {
		return { value: stripped };
	}
	const args: Record<string, unknown> = {};
	for (const part of stripped.split(',')) {
		const m = /^\s*([a-zA-Z_]\w*)\s*[:=]\s*(.+)\s*$/.exec(part);
		if (m) {
			args[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
		}
	}
	return args;
}

/**
 * Best-effort extraction of natural-language tool calls. `validNames` is required so the
 * parser doesn't match a model casually mentioning a tool ("I might call describe_table
 * later") — only `Tool Call: <name>(…)` style invocations where the name is in the
 * provided allowlist are returned.
 */
export function parseNaturalLanguageToolCalls(text: string, validNames: string[]): ToolCall[] {
	const allowed = new Set(validNames);
	if (allowed.size === 0) {
		return [];
	}
	const calls: ToolCall[] = [];
	let index = 0;
	for (const pattern of NL_PATTERNS) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) {
			const name = match[1];
			if (!allowed.has(name)) {
				continue;
			}
			calls.push({ id: `nl_call_${index++}`, name, arguments: parseLooseArgs(match[2] ?? '') });
		}
	}
	return calls;
}

/** Scan `text` for top-level balanced `{…}` objects, ignoring braces inside JSON strings.
 *  Returns each object's raw substring (so a value wrapped in ```json fences or
 *  `<tool_call>` tags is still found — we only care about the brace span). */
function extractJsonObjects(text: string): string[] {
	const objects: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === '{') {
			if (depth === 0) {
				start = i;
			}
			depth++;
		} else if (ch === '}' && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				objects.push(text.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return objects;
}

/** Pull `{name, arguments}` call candidates out of a parsed JSON value, tolerating the few
 *  shapes models use: a bare `{name, arguments}`, OpenAI's `{function:{name, arguments}}`,
 *  a `{tool:"name", arguments}` pair, a `{tool_call:{…}}` wrapper, and arrays of any of these.
 *  Name-matching against the real tool list happens in the caller, not here. */
function candidateCalls(parsed: unknown): { name: string; arguments: unknown }[] {
	const out: { name: string; arguments: unknown }[] = [];
	const consider = (value: unknown): void => {
		if (!value || typeof value !== 'object') {
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				consider(item);
			}
			return;
		}
		const obj = value as Record<string, unknown>;
		if (typeof obj.name === 'string') {
			// Only a `{name, arguments}`-shaped object is a call. A data object that merely happens
			// to carry a `name` field (`{"name":"orders","rows":5}`) is NOT — it must either pair
			// name with an args key, or be a bare `{name}` with nothing else, to count.
			const hasArgsKey = 'arguments' in obj || 'parameters' in obj || 'args' in obj;
			const onlyName = Object.keys(obj).every((k) => k === 'name' || k === 'arguments' || k === 'parameters' || k === 'args');
			if (hasArgsKey || onlyName) {
				out.push({ name: obj.name, arguments: obj.arguments ?? obj.parameters ?? obj.args ?? {} });
			}
			return;
		}
		if (typeof obj.tool === 'string') {
			out.push({ name: obj.tool, arguments: obj.arguments ?? obj.parameters ?? obj.args ?? {} });
			return;
		}
		const fn = obj.function;
		if (fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string') {
			const f = fn as Record<string, unknown>;
			out.push({ name: f.name as string, arguments: f.arguments ?? {} });
			return;
		}
		for (const key of ['tool_call', 'toolCall']) {
			if (obj[key]) {
				consider(obj[key]);
			}
		}
	};
	consider(parsed);
	return out;
}

/** A bare JSON object some models (e.g. qwen2.5-coder via Ollama) print as their whole turn
 *  instead of issuing a native tool call: `{"name":"list_tables","arguments":{}}`. We accept
 *  an object only when its `name` is one of `validNames`, so ordinary JSON in a reply (a result
 *  set, a snippet the user asked for) is never mistaken for a call. `arguments` may arrive as a
 *  nested object or a JSON string; both are normalized to a key/value bag. */
export function parseJsonToolCalls(text: string, validNames: string[]): ToolCall[] {
	const allowed = new Set(validNames);
	if (allowed.size === 0) {
		return [];
	}
	const calls: ToolCall[] = [];
	let index = 0;
	for (const raw of extractJsonObjects(text)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		for (const candidate of candidateCalls(parsed)) {
			if (!allowed.has(candidate.name)) {
				continue;
			}
			const args = candidate.arguments;
			const bag = typeof args === 'string'
				? parseLooseArgs(args)
				: args && typeof args === 'object' && !Array.isArray(args)
					? (args as Record<string, unknown>)
					: {};
			calls.push({ id: `json_call_${index++}`, name: candidate.name, arguments: bag });
		}
	}
	return calls;
}

/** Strip everything from the first tool-call tag onward (the markup is always the tail of a
 *  turn), leaving just the model's prose. */
export function stripToolMarkup(text: string): string {
	const tag = TOOL_TAG.exec(text);
	return tag ? text.slice(0, tag.index).replace(/\s+$/, '') : text;
}

/** The body of a text tool-call lead-in a model writes mid-reply (after its reasoning prose):
 *  a `Tool Call:` / `Calling` / `Invoke` line, or a line that opens a JSON object/array. The
 *  HEAD form anchors it at the very start of the current buffer (used only when that position is
 *  truly a line start); the BODY form requires a preceding newline so it matches anywhere. We
 *  hold from there to the turn's end and decide at finish() — a real call is hidden, prose that
 *  merely looks like one is flushed. Only armed when tool names are known. */
const LEADIN_ALT = '(?:Tool[ \\t]*Call|Tool[ \\t]*:|Function[ \\t]*Call|Calling\\b|Invoke\\b|[[{])';
const HOLD_LEADIN_HEAD = new RegExp(`^[ \\t]*${LEADIN_ALT}`, 'i');
const HOLD_LEADIN_BODY = new RegExp(`\\n[ \\t]*${LEADIN_ALT}`, 'i');

/** Lower-case lead-in phrases, for catching a trailing fragment still growing into one
 *  (so `Tool Ca` at a line end waits for the next delta instead of leaking). */
const HOLD_MARKERS = ['tool call', 'tool:', 'function call', 'calling', 'invoke'];

/**
 * Forwards a model's streamed text to `emit`, but withholds tool-call markup so it never reaches
 * the user. Two cases: provider-native XML tags (`<invoke>…`) are suppressed outright; a text
 * tool call a weak model writes itself (`Tool Call:` then a JSON object, even after some
 * reasoning prose) is held from its lead-in and confirmed at {@link finish} — kept hidden if it
 * parses to a call, flushed as ordinary prose otherwise. Trailing partials ("<inv", "Tool Ca")
 * are buffered so a marker split across deltas never leaks.
 */
export class ToolMarkupStream {
	private buffer = '';
	private suppressing = false;
	private holding = false;
	// Whether the next unemitted character sits at the start of a line. Tracked across deltas so
	// a `{` we already split prose away from isn't mistaken for a line-opening JSON tool call.
	private atLineStart = true;

	/** `toolNames` arms text tool-call holding (some models emit calls as text); empty disables
	 *  it (e.g. the final, tools-withheld concluding turn, which should stream prose freely). */
	constructor(private readonly emit: (text: string) => void, private readonly toolNames: string[] = []) {}

	push(delta: string): void {
		this.buffer += delta;
		if (this.suppressing || this.holding) {
			return;
		}
		const tag = TOOL_TAG.exec(this.buffer);
		const leadIndex = this.leadInIndex();
		// Whichever tool-call region starts first wins: a native tag is suppressed outright; a
		// text lead-in is held and verified at finish().
		if (tag && (leadIndex < 0 || tag.index <= leadIndex)) {
			this.emitText(this.buffer.slice(0, tag.index));
			this.buffer = this.buffer.slice(tag.index);
			this.suppressing = true;
			return;
		}
		if (leadIndex >= 0) {
			this.emitText(this.buffer.slice(0, leadIndex));
			this.buffer = this.buffer.slice(leadIndex);
			this.holding = true;
			return;
		}
		// No complete trigger yet: emit all but a trailing partial that could still grow into a
		// tag or a text lead-in, so "<inv" / "Tool Ca" wait for the next delta instead of leaking.
		const partialTag = PARTIAL_TAG.exec(this.buffer);
		const cut = Math.min(
			partialTag ? partialTag.index : this.buffer.length,
			this.partialLeadInIndex(),
		);
		if (cut > 0) {
			this.emitText(this.buffer.slice(0, cut));
			this.buffer = this.buffer.slice(cut);
		}
	}

	/** Index where a text tool-call lead-in begins in the buffer, or -1 if none. A buffer-start
	 *  (HEAD) match counts only when we're actually at a line start; a mid-buffer (BODY) match
	 *  always counts (it carries its own newline). */
	private leadInIndex(): number {
		if (this.toolNames.length === 0) {
			return -1;
		}
		if (this.atLineStart && HOLD_LEADIN_HEAD.test(this.buffer)) {
			return 0;
		}
		const body = HOLD_LEADIN_BODY.exec(this.buffer);
		return body ? body.index : -1;
	}

	private emitText(text: string): void {
		if (text) {
			this.emit(text);
			this.atLineStart = text.endsWith('\n');
		}
	}

	/** Index of a trailing line that is a strict prefix of a tool-call lead-in marker (so it
	 *  might still grow into one), or `buffer.length` when there's nothing to hold back. */
	private partialLeadInIndex(): number {
		if (this.toolNames.length === 0) {
			return this.buffer.length;
		}
		const nl = this.buffer.lastIndexOf('\n');
		// A buffer with no newline whose start isn't a line start is a continuation of earlier
		// prose, so a marker-looking prefix in it is just words, not a lead-in.
		if (nl < 0 && !this.atLineStart) {
			return this.buffer.length;
		}
		const lineStart = nl + 1;
		const lead = this.buffer.slice(lineStart).replace(/^[ \t]+/, '').toLowerCase();
		if (lead) {
			for (const marker of HOLD_MARKERS) {
				if (marker.length > lead.length && marker.startsWith(lead)) {
					return lineStart;
				}
			}
		}
		return this.buffer.length;
	}

	/** End the turn: a held region that parses to a tool call (a JSON object or a `Tool Call:`
	 *  line) stays hidden; anything else was ordinary prose and is flushed now. */
	finish(): void {
		if (this.suppressing) {
			return;
		}
		if (this.holding) {
			const isCall = parseJsonToolCalls(this.buffer, this.toolNames).length > 0
				|| parseNaturalLanguageToolCalls(this.buffer, this.toolNames).length > 0;
			if (isCall) {
				this.buffer = '';
				return;
			}
		}
		if (this.buffer) {
			this.emit(this.buffer);
			this.buffer = '';
		}
	}
}

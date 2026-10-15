/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Reading a LOG LINE.
 *
 *  A telemetry result is a table by construction — `ts`, `message`, `stream`, `id`, `ingested_at`
 *  plus whatever the message parsed into — and a table is the wrong shape to READ it in. A log
 *  line's text is the whole point of the row, and in a grid cell it is a 60-character stub beside
 *  four columns of machinery: the stream name, the provider's event id, the ingestion clock. The
 *  vendor consoles all reach the same answer, which is a stream of lines you expand one at a time.
 *
 *  This is the half of that which is pure: what one message SAYS, worked out from the text alone.
 *  Three things come out of it, and each removes noise the grid could not.
 *
 *    - The line repeats its own timestamp. Almost every runtime prefixes one, and the row already
 *      has a time column, so the prefix is a second copy of a fact already on screen. It is lifted
 *      out into {@link LogLine.stamp} and shown back only when it DISAGREES with the event clock,
 *      which is the one case where it is news rather than noise.
 *    - The line carries a correlation id (a Lambda request id). Every line of one invocation
 *      repeats it, so it is a column of identical text; it moves to the expanded reading.
 *    - The line embeds JSON. That is what makes a log grid unreadable: an entire request object
 *      on one line, clipped at the cell edge. {@link parseLogLine} finds each balanced payload so
 *      the reader can pretty-print it in place.
 *
 *  Pure and synchronous. Nothing here knows what React is, so it is tested by `node --test`.
 *--------------------------------------------------------------------------------------------*/

/** How loud a line is, normalized from the many spellings runtimes use for the same five levels. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** The spellings that mean one of the five. A TAB-delimited field is a field, so its case does not
 *  matter; a token at the head of prose only counts when it was already upper-case, because "error"
 *  inside a sentence is prose and `ERROR` is a level. */
const LEVELS: Readonly<Record<string, LogLevel>> = {
	ERROR: 'error',
	ERR: 'error',
	FATAL: 'error',
	CRITICAL: 'error',
	CRIT: 'error',
	SEVERE: 'error',
	PANIC: 'error',
	WARN: 'warn',
	WARNING: 'warn',
	INFO: 'info',
	NOTICE: 'info',
	LOG: 'info',
	DEBUG: 'debug',
	FINE: 'debug',
	TRACE: 'trace',
	VERBOSE: 'trace',
	// Cloud Logging's ladder goes two rungs above ERROR, and Azure spells INFO in full.
	ALERT: 'error',
	EMERGENCY: 'error',
	EMERG: 'error',
	INFORMATION: 'info',
	INFORMATIONAL: 'info',
	// GCP's `DEFAULT` means "this entry declared no severity", which is not a level and must not
	// become one: an unlevelled line shows no badge, the same as a CloudWatch control line.
};

/** The keys a structured line calls its level, in the order they are believed. LOWER CASE, and
 *  matched that way: `level` on a Node logger, `severity` on Cloud Logging, `Level` /
 *  `SeverityLevel` on a Log Analytics table, and the case is the vendor's business rather than
 *  something the reader should have to be told about one provider at a time. */
const LEVEL_KEYS = ['level', 'severity', 'levelname', 'severitylevel', 'log.level', 'loglevel', '@level'];

/** The keys a structured record uses for its own readable line, in the order they are believed.
 *  Lower case, matched that way, for the same reason as {@link LEVEL_KEYS}. */
const TEXT_KEYS = ['message', 'msg', 'textpayload', 'renderedmessage', 'body', 'log', 'event', 'text', 'description'];

/** How much of one field's value the collapsed line spends before saying "and so on". */
const FIELD_VALUE_LIMIT = 120;

/** An ISO-8601 instant as a runtime prefixes one: `2026-09-10T20:52:13.744Z`, with a space instead
 *  of the `T` and a numeric offset instead of `Z` both accepted. */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** The same instant at the head of a line, with the rest of the line after it. Spelled separately
 *  from {@link ISO_STAMP} because the `2026-09-10 20:52:13` form has a SPACE in the middle, so
 *  "the first whitespace-delimited token" is half a timestamp. */
const LEADING_STAMP = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)\s+/;

/** A level at the head of a line: `[WARN] `, `WARN: ` or `WARN `. The trailing whitespace is
 *  required, so a line that is nothing BUT a level keeps it as its text. */
const LEADING_LEVEL = /^(?:\[([A-Z]{2,8})\]|([A-Z]{2,8}):?)\s+/;

/** A v4-shaped correlation id (a Lambda request id, a trace id). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A request id named in the text of a control line (`START RequestId: <uuid> Version: $LATEST`). */
const NAMED_REQUEST_ID = /\brequest[ _-]?id["']?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** The longest message this bothers to segment. Past it the line is a payload dump, not a line: the
 *  reader shows it verbatim, and a brace scan over a megabyte on every render is not worth the JSON. */
const SEGMENT_LIMIT = 200_000;

/** How much of a line the collapsed row can possibly show. Held down so a 200 KB message does not
 *  put 200 KB of text in the DOM for a row that is one line tall. */
const SUMMARY_LIMIT = 2000;

/** A piece of a message: prose, or a JSON value found embedded in it. */
export type LogSegment =
	| { kind: 'text'; text: string }
	| { kind: 'json'; text: string; value: unknown };

/** One message, read. */
export interface LogLine {
	/** The timestamp the message carried itself, verbatim, or null. Taken OUT of `summary`/`body`
	 *  because the row has a time column; shown back by the reader only when it disagrees with it. */
	stamp: string | null;
	/** A correlation id the line carried. Never in the collapsed row (every line of one invocation
	 *  repeats it) — it belongs to the expanded reading, where it identifies what to search for. */
	correlation: string | null;
	level: LogLevel | null;
	/** The line as ONE line: `body` with its newlines and runs of whitespace collapsed, capped. */
	summary: string;
	/** The message with the stamp, correlation and level prefix removed; newlines intact. */
	body: string;
	/** `body`, split into prose and embedded JSON payloads. One text segment when there is none. */
	segments: LogSegment[];
	/** Is there more to see than `summary` — a payload to pretty-print, or a line that wraps? */
	expandable: boolean;
}

/** Where the fixed log contract's columns sit in a result, plus everything else the message parsed
 *  into. Returned only for a result that HAS the contract: an aggregate (`GROUP BY level`) is a
 *  real table and belongs in the grid. */
export interface LogShape {
	/** Null when the projection dropped the clock (`SELECT message FROM …`). */
	ts: number | null;
	message: number;
	stream: number | null;
	id: number | null;
	ingestedAt: number | null;
	/** Every other column, in result order — the fields the message parsed into. */
	extras: number[];
}

/**
 * Is this result a stream of log EVENTS, and if so where is everything?
 *
 * THE TEST IS THE LINE AND NOTHING ELSE. Every other column of the contract is furniture the reader
 * shows if it is there and leaves out if it is not — including `ts`, which it is tempting to demand
 * because a log reader has a time column. `SELECT message FROM "/aws/lambda/orders-worker"` is a projection
 * that says "just the lines, please", and answering it with the grid is answering a narrower
 * question with a worse instrument. A result with no `message` has no line to read and is a table.
 *
 * What this deliberately does NOT decide is whether a row is one EVENT: `SELECT message, count(*)
 * … GROUP BY message` has a message column and is a table. Column names cannot tell, so they are
 * not asked to — `QueryCost.grouped` is, by the caller.
 */
export function logShapeOf(fields: readonly { name: string }[]): LogShape | null {
	const at = (name: string): number => fields.findIndex((f) => f.name.toLowerCase() === name);
	const message = at('message');
	if (message < 0) {
		return null;
	}
	const ts = at('ts');
	const stream = at('stream');
	const id = at('id');
	const ingestedAt = at('ingested_at');
	const fixed = new Set([ts, message, stream, id, ingestedAt]);
	const extras: number[] = [];
	for (let i = 0; i < fields.length; i++) {
		if (!fixed.has(i)) {
			extras.push(i);
		}
	}
	return { ts: ts < 0 ? null : ts, message, stream: stream < 0 ? null : stream, id: id < 0 ? null : id, ingestedAt: ingestedAt < 0 ? null : ingestedAt, extras };
}

/**
 * Read one message.
 *
 * The prefix is consumed field by field rather than matched as a whole, because the runtimes do not
 * agree on which fields are present or in what order: Lambda writes `<iso>\t<uuid>\t<LEVEL>\t…`, a
 * container writes `<iso> <LEVEL> …`, a structured logger writes the whole line as JSON and nothing
 * else. Each recognised field is taken; the first unrecognised one ends the prefix, so a message
 * that happens to start with a word is never eaten by a rule meant for a level.
 */
export function parseLogLine(message: unknown): LogLine {
	const text = typeof message === 'string' ? message : message === null || message === undefined ? '' : String(message);
	let rest = text.replace(/\s+$/, '');
	let stamp: string | null = null;
	let correlation: string | null = null;
	let level: LogLevel | null = null;

	// Tab-separated prefix fields (Lambda and anything that copies it). Never consume the LAST
	// field: a line that is nothing but a level is that level's text, not a prefix with no line.
	if (rest.includes('\t')) {
		const parts = rest.split('\t');
		let taken = 0;
		while (taken < parts.length - 1) {
			const part = parts[taken].trim();
			if (stamp === null && ISO_STAMP.test(part)) {
				stamp = part;
			} else if (correlation === null && UUID.test(part)) {
				correlation = part;
			} else if (level === null && Object.prototype.hasOwnProperty.call(LEVELS, part.toUpperCase())) {
				level = LEVELS[part.toUpperCase()];
			} else {
				break;
			}
			taken++;
		}
		if (taken > 0) {
			rest = parts.slice(taken).join('\t');
		}
	}

	// Space-separated prefix: a leading instant, then a level, bracketed or bare.
	if (stamp === null) {
		const head = rest.match(LEADING_STAMP);
		if (head) {
			stamp = head[1];
			rest = rest.slice(head[0].length);
		}
	}
	if (level === null) {
		const head = rest.match(LEADING_LEVEL);
		const token = head?.[1] ?? head?.[2];
		if (token && Object.prototype.hasOwnProperty.call(LEVELS, token)) {
			level = LEVELS[token];
			rest = rest.slice(head![0].length);
		}
	}

	const body = rest.replace(/^\s+/, '');
	const segments = segmentsOf(body);

	// A structured line says its own level inside the object, which is the only place a JSON-only
	// logger ever puts it.
	let levelKey: string | null = null;
	if (level === null) {
		for (const segment of segments) {
			if (segment.kind === 'json') {
				const found = levelOfValue(segment.value);
				level = found?.level ?? null;
				levelKey = found?.key ?? null;
			}
			if (level !== null) {
				break;
			}
		}
	}
	// A control line names the invocation it belongs to in its text. Read, never removed: for
	// `END RequestId: <uuid>` the id IS the line.
	if (correlation === null) {
		correlation = body.match(NAMED_REQUEST_ID)?.[1] ?? null;
	}

	// A message that IS one record has no prose to summarize — that is Azure's every row and GCP's
	// structured ones — so the one-line reading is composed from the record instead.
	const record = segments.length === 1 && segments[0].kind === 'json' ? segments[0].value : null;
	const summary = (record !== null ? recordSummary(record, levelKey) : null) ?? summarize(body);
	const expandable = segments.some((s) => s.kind === 'json') || body.includes('\n') || summary.endsWith('…');
	return { stamp, correlation, level, summary, body, segments, expandable };
}

/** A plain object's fields, indexed by lower-cased key, or null when the value is not one. */
function fieldsOf(value: unknown): Map<string, [string, unknown]> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null;
	}
	const out = new Map<string, [string, unknown]>();
	for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
		out.set(key.toLowerCase(), [key, held]);
	}
	return out;
}

/**
 * The level a structured line declares, and the field it declared it in.
 *
 * The KEY comes back because the reader has already spent a badge on it: repeating
 * `severity=ERROR` in the one-line summary beside a red ERROR badge is the column of identical
 * values this whole view exists to stop.
 *
 * A NUMERIC level is deliberately not read. Azure's `SeverityLevel` counts up from verbose (0) to
 * critical (4) and syslog counts DOWN from emergency (0) to debug (7), so the same `3` is an error
 * on one and a warning on the other. A wrong colour on a log line is worse than no colour.
 */
function levelOfValue(value: unknown): { level: LogLevel; key: string } | null {
	const fields = fieldsOf(value);
	if (!fields) {
		return null;
	}
	for (const key of LEVEL_KEYS) {
		const entry = fields.get(key);
		if (entry && typeof entry[1] === 'string') {
			const found = LEVELS[entry[1].trim().toUpperCase()];
			if (found) {
				return { level: found, key };
			}
		}
	}
	return null;
}

/**
 * The one-line reading of a message that is entirely ONE record.
 *
 * Azure has no text column at all — a Log Analytics row is named, typed columns, and the driver
 * serialises the whole row into `message` — and Cloud Logging does the same for a `jsonPayload`,
 * even folding a plain text line into `{severity, textPayload}`. Left to {@link summarize} those
 * arrive as a compacted JSON blob on every row: the grid's problem again, one panel to the left.
 *
 * So: the record's own text field leads if it has one, and the remaining SCALARS follow as
 * `key=value`. Nested objects and arrays are left out of the LINE, not lost — they are one click
 * away, pretty-printed, and a `{…}` on a line nobody can expand in place is what a cell already was.
 */
function recordSummary(value: unknown, levelKey: string | null): string | null {
	const fields = fieldsOf(value);
	if (!fields || fields.size === 0) {
		return null;
	}
	const spent = new Set<string>();
	if (levelKey !== null) {
		spent.add(levelKey);
	}
	const parts: string[] = [];
	for (const key of TEXT_KEYS) {
		const entry = fields.get(key);
		if (entry && typeof entry[1] === 'string' && entry[1].trim() !== '') {
			parts.push(entry[1]);
			spent.add(key);
			break;
		}
	}
	for (const [lower, [key, held]] of fields) {
		if (spent.has(lower) || held === null || held === undefined || typeof held === 'object') {
			continue;
		}
		parts.push(`${key}=${String(held)}`);
	}
	return parts.length === 0 ? null : summarize(parts.map(capField).join(' '));
}

/** One field of a composed line, held to a readable length. */
function capField(text: string): string {
	return text.length > FIELD_VALUE_LIMIT ? `${text.slice(0, FIELD_VALUE_LIMIT)}…` : text;
}

/** The one-line reading: newlines and runs of whitespace collapsed to single spaces, capped. */
function summarize(body: string): string {
	const flat = body.replace(/\s+/g, ' ').trim();
	return flat.length > SUMMARY_LIMIT ? `${flat.slice(0, SUMMARY_LIMIT)}…` : flat;
}

/**
 * Split a message into prose and the JSON payloads embedded in it.
 *
 * The scan is a brace/bracket counter that respects strings and escapes, not a regex, because the
 * thing being found is recursive and a regex cannot count. A candidate is only accepted when it
 * both balances AND parses, so a line of prose containing `{}` or a lone `[` stays prose.
 */
export function segmentsOf(body: string): LogSegment[] {
	if (body.length === 0) {
		return [];
	}
	if (body.length > SEGMENT_LIMIT) {
		return [{ kind: 'text', text: body }];
	}
	const segments: LogSegment[] = [];
	let cursor = 0;
	let at = 0;
	while (at < body.length) {
		const ch = body[at];
		if (ch !== '{' && ch !== '[') {
			at++;
			continue;
		}
		const found = scanValue(body, at);
		if (!found) {
			at++;
			continue;
		}
		if (at > cursor) {
			segments.push({ kind: 'text', text: body.slice(cursor, at) });
		}
		segments.push({ kind: 'json', text: body.slice(at, found.end), value: found.value });
		cursor = found.end;
		at = found.end;
	}
	if (cursor < body.length) {
		segments.push({ kind: 'text', text: body.slice(cursor) });
	}
	return segments;
}

/** The balanced JSON value starting at `from`, if it both balances and parses. */
function scanValue(text: string, from: number): { end: number; value: unknown } | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = from; i < text.length; i++) {
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
		} else if (ch === '{' || ch === '[') {
			depth++;
		} else if (ch === '}' || ch === ']') {
			depth--;
			if (depth === 0) {
				const slice = text.slice(from, i + 1);
				try {
					return { end: i + 1, value: JSON.parse(slice) };
				} catch {
					return null;
				}
			}
			if (depth < 0) {
				return null;
			}
		}
	}
	return null;
}

/** A JSON payload as the reader shows it: indented, one field per line. */
export function prettyJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/** A piece of pretty-printed JSON, tinted by what it is. */
export interface JsonToken {
	text: string;
	kind: 'key' | 'string' | 'number' | 'atom' | 'plain';
}

/** Every literal in one pass: a string (a KEY when a colon follows it), a number, or an atom. */
const JSON_TOKEN = /"(?:[^"\\]|\\.)*"(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;

/**
 * {@link prettyJson} output, split for colouring.
 *
 * A tokenizer rather than a parser, and safe because the input is not the user's text: it is what
 * `JSON.stringify` just produced, so a quote inside a string is escaped and the shapes are known.
 * The reader gets keys apart from values, which is the whole readability difference between a
 * payload and a wall of punctuation.
 */
export function jsonTokens(pretty: string): JsonToken[] {
	const out: JsonToken[] = [];
	let cursor = 0;
	for (const match of pretty.matchAll(JSON_TOKEN)) {
		const at = match.index ?? 0;
		if (at > cursor) {
			out.push({ text: pretty.slice(cursor, at), kind: 'plain' });
		}
		const text = match[0];
		if (match[1] !== undefined) {
			// The colon is what MADE this a key, but it is punctuation and is coloured as such —
			// so the key token is the quoted name alone and the colon follows it as plain text.
			out.push({ text: text.slice(0, text.length - match[1].length), kind: 'key' });
			out.push({ text: match[1], kind: 'plain' });
		} else {
			out.push({ text, kind: text.startsWith('"') ? 'string' : text[0] === '-' || (text[0] >= '0' && text[0] <= '9') ? 'number' : 'atom' });
		}
		cursor = at + text.length;
	}
	if (cursor < pretty.length) {
		out.push({ text: pretty.slice(cursor), kind: 'plain' });
	}
	return out;
}

/** An event's clock as a number of ms, or null when the column held something else. */
export function logTimeOf(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (value instanceof Date) {
		return value.getTime();
	}
	if (typeof value === 'string' && value !== '') {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

/**
 * The time column's text, in the reader's own zone and to the millisecond.
 *
 * Milliseconds are not decoration here: log lines arrive in bursts, and a column of identical
 * `20:52:13` is no ordering at all. The date is only spent when the result spans more than one, so
 * a five-minute window does not repeat today's date on every row.
 */
export function logTimeText(at: number | null, withDate: boolean): string {
	if (at === null) {
		return '';
	}
	const date = new Date(at);
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
	return withDate ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}` : time;
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

/** Does the result cross a local midnight (so the time column has to carry the date)? */
export function spansDays(first: number | null, last: number | null): boolean {
	if (first === null || last === null) {
		return false;
	}
	return new Date(first).toDateString() !== new Date(last).toDateString();
}

/** How much of a line a match fragment shows, and how much of that is spent BEFORE the match — a
 *  third, so the hit sits near the left where the eye lands and the text after it still reads. */
const CONTEXT_WIDTH = 200;
const CONTEXT_LEAD = Math.round(CONTEXT_WIDTH / 3);

/**
 * A window of `text` around its first case-insensitive occurrence of `query`, or null when there
 * is none.
 *
 * This is what a search over LOG lines needs that a search over table cells does not. A cell is
 * roughly what a cell shows; a log line is a paragraph, and the thing you searched for is usually
 * three hundred characters into a payload that is folded away. Without this the search narrows the
 * list to rows that all look like they do not match, and the only way to see why one did is to open
 * every one of them.
 *
 * Whitespace is collapsed so the fragment stays one line, and an ellipsis marks each end that was
 * cut — so a fragment is never mistaken for the start of the line.
 */
export function matchContext(text: string, query: string): string | null {
	const needle = query.trim().toLowerCase();
	if (needle === '' || text === '') {
		return null;
	}
	const at = text.toLowerCase().indexOf(needle);
	if (at < 0) {
		return null;
	}
	const start = Math.max(0, at - CONTEXT_LEAD);
	const end = Math.min(text.length, at + needle.length + (CONTEXT_WIDTH - CONTEXT_LEAD));
	const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
	return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`;
}

/**
 * `text` split around every case-insensitive occurrence of `query`, alternating miss/hit/miss.
 *
 * The array always starts with a miss (possibly empty), so the caller renders odd indices as the
 * highlight without checking anything. An empty query is the whole string as one miss.
 */
export function highlightParts(text: string, query: string): string[] {
	const needle = query.trim().toLowerCase();
	if (needle === '') {
		return [text];
	}
	const haystack = text.toLowerCase();
	const parts: string[] = [];
	let cursor = 0;
	for (;;) {
		const hit = haystack.indexOf(needle, cursor);
		if (hit < 0) {
			break;
		}
		parts.push(text.slice(cursor, hit), text.slice(hit, hit + needle.length));
		cursor = hit + needle.length;
	}
	parts.push(text.slice(cursor));
	return parts;
}

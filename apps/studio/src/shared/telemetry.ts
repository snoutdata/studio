/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Crash/error telemetry (Sentry) config + the redaction the whole app runs before anything
// leaves the machine. This file has NO electron/Node imports so it is shared by main and the
// renderer and is unit-testable under `node --test`.

// The Sentry DSN, compiled in by the OFFICIAL build only (scripts/pro.mjs, from a private file): a
// build from the open-source tree has none, so its telemetry
// is dormant and never reports into ours. A DSN is not a secret (it only authorizes SENDING
// events), but it is ours. An empty string means dormant: the SDK is never initialized and nothing
// is captured or sent. `SNOUTDATA_SENTRY_DSN` still overrides it in main.
declare const __SNOUT_SENTRY_DSN__: string | undefined;
export const SENTRY_DSN: string = typeof __SNOUT_SENTRY_DSN__ === 'string' ? __SNOUT_SENTRY_DSN__ : '';

// Object keys whose *values* are dropped wholesale wherever they appear in an event (extra,
// contexts, request data). These are the things that must never leave the machine.
const SENSITIVE_KEYS = /^(sql|query|statement|password|passwd|pwd|secret|api[_-]?key|apikey|token|authorization|auth|cookie|dsn|connection[_-]?string|connstring|conn|host|user|username|ssh|passphrase|privatekey|private[_-]?key)$/i;

const REDACTED = '[redacted]';

// Free-text patterns redacted inside any string (error messages, breadcrumbs, stack frame
// vars): database connection URIs, credentials in any URL, provider tokens (OpenAI, GitHub,
// GitLab, SnoutData, AWS), JWTs, signed-URL signatures, bearer tokens, and
// `password=`/`apiKey:`-style pairs.
const TEXT_PATTERNS: Array<[RegExp, string]> = [
	// mysql://user:pass@host/db, postgres://…, sqlserver://…, mongodb://…, redis://…
	[/\b(?:mysql|mysqlx|postgres|postgresql|sqlserver|mssql|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s"'`<>)]+/gi, '[redacted-connection-uri]'],
	// user:password@ in any other URL scheme (https://user:password@host/…, ftp://…).
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'`<>]+:[^\s/@"'`<>]+@/gi, '$1[redacted]@'],
	// A JSON Web Token: three base64url segments, the header always starting `eyJ` (`{"`).
	[/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
	// GitHub tokens (ghp_ personal, gho_ OAuth, ghu_/ghs_ app, ghr_ refresh, github_pat_ fine-grained).
	[/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted-key]'],
	// GitLab tokens (glpat- personal, and the deploy/runner/trigger/OAuth kinds that share the shape).
	[/\bgl(?:pat|dt|rt|ptt|oas|cbt|imt|ft|agent|soat)-[A-Za-z0-9_-]{16,}/g, '[redacted-key]'],
	// SnoutData access tokens (`snoutdata tokens create`).
	[/\bsdt_[A-Za-z0-9_-]{8,}/g, '[redacted-key]'],
	// Signed-URL query values: S3/GCS presigned parameters, Azure SAS `sig=`, and token-ish params.
	[/([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature|X-Goog-Credential|Signature|Credential|sig|token|access_token|id_token|refresh_token|code|key|Policy|Key-Pair-Id)=)[^&\s"'`#<>]+/gi, '$1[redacted]'],
	// OpenAI-style and generic long bearer/secret keys: sk-…, Bearer …, gateway virtual keys.
	[/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted-key]'],
	[/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]'],
	// key=value / "key": "value" pairs for a sensitive name, regardless of quoting around
	// either side (so JSON `"apiKey": "v"` and `password=v` both match).
	[/\b(password|passwd|pwd|secret|(?:aws_)?secret[_-]?access[_-]?key|api[_-]?key|apikey|token|authorization|passphrase)\b["']?\s*[:=]\s*["']?[^\s"'`,;}{)]+/gi, '$1=[redacted]'],
];

// An AWS access key id (long-term AKIA, temporary ASIA). Its secret has no prefix of its own, so a
// 40-character base64 run is redacted only in a string that also carries a key id: on its own it is
// as likely to be a hash as a secret.
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const AWS_SECRET_NEAR_KEY = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;

/** Redact secrets from a single free-text string. Safe on any input; returns it unchanged
 *  when there's nothing sensitive. */
export function scrubText(input: string): string {
	let out = input;
	if (AWS_ACCESS_KEY.test(out)) {
		AWS_ACCESS_KEY.lastIndex = 0;
		out = out.replace(AWS_ACCESS_KEY, '[redacted-aws-key]').replace(AWS_SECRET_NEAR_KEY, '[redacted-aws-secret]');
	}
	AWS_ACCESS_KEY.lastIndex = 0;
	for (const [pattern, replacement] of TEXT_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

/** Deep-scrub an arbitrary JSON-ish value: redact values under a sensitive key by name, and
 *  run {@link scrubText} over every remaining string. Guards against cycles and runaway depth
 *  so a malformed event can never wedge `beforeSend`. */
export function scrubValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (typeof value === 'string') {
		return scrubText(value);
	}
	if (value === null || typeof value !== 'object' || depth > 12) {
		return value;
	}
	if (seen.has(value as object)) {
		return REDACTED;
	}
	seen.add(value as object);
	if (Array.isArray(value)) {
		return value.map((v) => scrubValue(v, depth + 1, seen));
	}
	const out: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		out[key] = SENSITIVE_KEYS.test(key) ? REDACTED : scrubValue(val, depth + 1, seen);
	}
	return out;
}

/** Errors that mean the system worked as designed, and must never be reported.
 *
 *  Monaco/VSCode signal cancellation by rejecting with a `CancellationError` whose message is
 *  the literal "Canceled" (one 'l' — their spelling, not our "Cancelled" status string). Every
 *  keystroke that supersedes an in-flight inline suggestion or completion cancels the previous
 *  request, and Monaco's internals reject a promise nobody awaits, which lands as an unhandled
 *  rejection. Nothing is broken for the user: the suggestion was cancelled on purpose. Reporting
 *  it just buries real crashes under noise. Kept deliberately narrow (exact message, not a
 *  substring) so a genuine error that merely mentions cancelling still gets through. */
export const IGNORED_ERROR_MESSAGES: readonly RegExp[] = [
	/^Canceled$/,
];

// The subset of a Sentry event we touch. Kept structural (not importing @sentry types) so this
// file stays dependency-free and node-testable.
interface SentryLike {
	message?: unknown;
	exception?: { values?: Array<{ value?: string; stacktrace?: { frames?: Array<{ vars?: Record<string, unknown> }> } }> };
	breadcrumbs?: Array<{ message?: string; data?: unknown }>;
	extra?: unknown;
	contexts?: unknown;
	request?: { headers?: Record<string, unknown>; cookies?: unknown; data?: unknown; query_string?: unknown };
	user?: unknown;
}

/** Scrub a whole Sentry event in place-ish (returns a cleaned copy of the fields we touch).
 *  Belt-and-braces: we never intentionally attach SQL or secrets, but errors can embed a
 *  connection string or a query in their message, and stack-frame locals can capture a
 *  password, so everything outbound passes through here. */
export function scrubEvent<T extends SentryLike>(event: T): T {
	if (typeof event.message === 'string') {
		event.message = scrubText(event.message);
	}
	for (const ex of event.exception?.values ?? []) {
		if (typeof ex.value === 'string') {
			ex.value = scrubText(ex.value);
		}
		for (const frame of ex.stacktrace?.frames ?? []) {
			if (frame.vars) {
				frame.vars = scrubValue(frame.vars) as Record<string, unknown>;
			}
		}
	}
	for (const crumb of event.breadcrumbs ?? []) {
		if (typeof crumb.message === 'string') {
			crumb.message = scrubText(crumb.message);
		}
		if (crumb.data !== undefined) {
			crumb.data = scrubValue(crumb.data);
		}
	}
	if (event.extra !== undefined) {
		event.extra = scrubValue(event.extra);
	}
	if (event.contexts !== undefined) {
		event.contexts = scrubValue(event.contexts);
	}
	if (event.request) {
		// Drop auth-bearing transport metadata outright.
		delete event.request.headers;
		delete event.request.cookies;
		if (event.request.data !== undefined) {
			event.request.data = scrubValue(event.request.data);
		}
		if (typeof event.request.query_string === 'string') {
			event.request.query_string = scrubText(event.request.query_string);
		}
	}
	// We don't send PII; if anything ever set a user, keep only a non-identifying id.
	if (event.user && typeof event.user === 'object') {
		const id = (event.user as { id?: unknown }).id;
		event.user = id !== undefined ? { id } : undefined;
	}
	return event;
}

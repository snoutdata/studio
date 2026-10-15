/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { net } from 'electron';

// Shared outbound-HTTP helper for the main process. Every remote call the app makes (the accounts backend
// auth + REST, the Google OAuth token exchange, the AI gateway / BYOK providers, the update feed)
// should go through this instead of Node's global `fetch`.
//
// Why: Node's `fetch` (undici) ships its OWN certificate bundle and its own proxy handling. On a
// corporate network that does TLS inspection — a proxy re-signs HTTPS with a company root CA that
// IT installs into the OS trust store — Node's fetch does NOT trust that CA, so its TLS handshake
// stalls or fails. The system browser DOES trust it (so e.g. Google's consent screen loads), which
// is why sign-in could get to the browser and then hang on the app's own call. Electron's
// `net.fetch` uses Chromium's network stack: it trusts the SAME OS certificate store the browser
// does and honors the system proxy (PAC, auto-config, authenticated proxies). Routing through it
// is what makes the whole app work behind corporate proxies / VPNs / TLS inspection.
//
// It is a drop-in for `fetch`: same (input, init) signature, returns a standard web `Response`
// (its `.body` is a WHATWG `ReadableStream`, so SSE streaming via sse.ts works unchanged) and
// supports `AbortSignal`. Only usable after the app is ready (the case for all our callers).
//
// Falls back to Node's global `fetch` when `net.fetch` is unavailable — namely under `node --test`,
// where modules are bundled without a real Electron runtime so `net` is undefined. Provider unit
// tests (openaiProvider.test.ts) hit a localhost mock server through this fallback, with no Electron.
/**
 * A cache mode, which `net.fetch` honours because it is Chromium's.
 *
 * Node's own `RequestInit` (undici) has no `cache` field, so a caller that wants one has nowhere
 * to put it without an `any`. This is that place. It matters most to anything that POLLS: without
 * a mode, a response carrying `Cache-Control: max-age=…` can be served out of Chromium's cache
 * without the request ever going out, and a poller handed a cached list silently stops seeing new
 * things until the entry goes stale.
 */
export type NetCacheMode = 'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache' | 'only-if-cached';

/** `RequestInit`, plus the cache mode Chromium understands and Node's types do not describe. */
export type NetFetchInit = RequestInit & { cache?: NetCacheMode };

export const netFetch: typeof fetch = (input, init) =>
	net && typeof net.fetch === 'function' ? net.fetch(input as never, init as never) : fetch(input, init);

/** Why a call could not reach its destination, as far as the error can tell us.
 *  - `offline`: this computer has no network at all (the OS said so).
 *  - `local-network`: something between us and the internet stepped in: a proxy, a TLS-inspecting
 *    middlebox re-signing certificates, an administrator block. The one case where the user's
 *    network, VPN or company policy is the honest thing to name.
 *  - `unreachable`: everything else (timeout, refused/reset, DNS, a 5xx edge). The default, and
 *    deliberately NOT blamed on the user: after the backend moves, an unreachable service is far
 *    more often ours than their firewall. */
export type NetworkFailureKind = 'offline' | 'local-network' | 'unreachable';

/** The message + code of an error and its `.cause` chain, which is where `net.fetch` and undici
 *  put the real reason. */
function errorChainText(err: unknown): string {
	const seen = new Set<unknown>();
	const parts: string[] = [];
	let cur: unknown = err;
	for (let i = 0; cur && i < 5 && !seen.has(cur); i++) {
		seen.add(cur);
		if (typeof cur === 'string') {
			parts.push(cur);
			break;
		}
		const e = cur as { message?: unknown; code?: unknown; cause?: unknown };
		if (typeof e.code === 'string') {
			parts.push(e.code);
		}
		if (typeof e.message === 'string') {
			parts.push(e.message);
		}
		cur = e.cause;
	}
	return parts.join(' ');
}

export function classifyNetworkFailure(err: unknown): NetworkFailureKind {
	const text = errorChainText(err);
	if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ENETUNREACH|ENETDOWN/i.test(text)) {
		return 'offline';
	}
	if (/ERR_PROXY_|ERR_TUNNEL_CONNECTION_FAILED|ERR_MANDATORY_PROXY|ERR_BLOCKED_BY_ADMINISTRATOR|ERR_CERT_|ERR_SSL_|ERR_BAD_SSL|certificate|self[- ]signed|UNABLE_TO_VERIFY|unable to verify|proxy|tunnel|407/i.test(text)) {
		return 'local-network';
	}
	return 'unreachable';
}

/** User-facing message for a call that couldn't reach its destination. `service` names what we
 *  were trying to reach, e.g. "the sign-in service" / "the AI service". Pass the error: only one
 *  that shows a proxy, certificate or administrator block gets the network/VPN/firewall sentence.
 *  Without it, or for a plain timeout/refusal/DNS failure, the message does not blame the user's
 *  network, because that is usually not where the problem is. */
export function networkBlockedMessage(service = 'the service', err?: unknown): string {
	switch (classifyNetworkFailure(err)) {
		case 'offline':
			return `Could not reach ${service}. This computer appears to be offline. Check your internet connection and try again.`;
		case 'local-network':
			return `Could not reach ${service}. Your network, VPN, or firewall may be blocking it. If you are on a company network, this may be restricted by company policy. Try another network, or contact your IT department.`;
		case 'unreachable':
			return `Could not reach ${service}. It may be down or having trouble right now. Try again in a few minutes.`;
	}
}

/** A short technical suffix for diagnosing a failed network call: the underlying error code
 *  (a `net::ERR_*` from Chromium's `net.fetch`, or an errno like `ETIMEDOUT`/`ECONNRESET` from
 *  Node) and the host we were trying to reach. Meant to be appended to the user-facing
 *  {@link networkBlockedMessage} so the notification's "Details" names the real cause + domain
 *  (e.g. `(net::ERR_TIMED_OUT reaching oauth2.googleapis.com)`) instead of a bare "fetch failed".
 *  Walks the `.cause` chain because `net.fetch` (and undici) nest the real code one level down.
 *  Returns '' when nothing useful can be extracted. */
export function networkErrorDetail(err: unknown, host?: string): string {
	const seen = new Set<unknown>();
	let token = '';
	let cur: unknown = err;
	for (let i = 0; cur && i < 5 && !seen.has(cur); i++) {
		seen.add(cur);
		const e = cur as { message?: unknown; code?: unknown; cause?: unknown };
		const text = `${typeof e.code === 'string' ? `${e.code} ` : ''}${typeof e.message === 'string' ? e.message : ''}`;
		const m = text.match(/net::ERR_[A-Z0-9_]+|\bE[A-Z]{2,}\b/);
		if (m) {
			token = m[0];
			break;
		}
		cur = e.cause;
	}
	const parts: string[] = [];
	if (token) {
		parts.push(token);
	}
	if (host) {
		parts.push(`reaching ${host}`);
	}
	return parts.length ? `(${parts.join(' ')})` : '';
}

/** Heuristic: does this thrown value look like a connectivity failure (couldn't reach the server)
 *  rather than a real server/auth response (401/403/429/500…)? Covers Node's undici errors
 *  ("fetch failed", ECONN*, ENOTFOUND) AND Electron/Chromium's `net.fetch` errors (net::ERR_*,
 *  certificate/proxy/tunnel failures) — the latter is what we get on a corporate TLS-inspection or
 *  proxy block. Callers swap in {@link networkBlockedMessage} when this is true. Deliberately does
 *  NOT match a user-initiated abort ("AbortError") so a Stop click isn't mislabeled as a network
 *  problem. */
export function isNetworkError(err: unknown): boolean {
	const name = err instanceof Error ? err.name : '';
	const message = err instanceof Error ? err.message : String(err);
	if (name === 'AuthRetryableFetchError' || name === 'TimeoutError') {
		return true;
	}
	return /fetch failed|failed to fetch|network|socket hang up|timed out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|net::ERR|ERR_(CONNECTION|PROXY|NAME|NETWORK|CERT|SSL|TIMED|ADDRESS|INTERNET)|certificate|unable to (verify|reach)|proxy|tunnel/i.test(message);
}

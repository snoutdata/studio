/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A session store in browser cookies, so two sites under one parent domain share one sign-in:
 *
 *     snout(url, key, { auth: { storage: cookieStorage({ domain: '.example.com' }) } })
 *
 * The format, which every SnoutData site reads and writes, so a visitor signed in on one is signed
 * in on the others:
 *
 * - A stored value is `base64-` followed by the base64url of its UTF-8 bytes, without padding.
 *   A value without that prefix (written before it existed) is read as it is.
 * - A cookie's value is URI-encoded on the wire. When the encoded value is at most
 *   `COOKIE_VALUE_LIMIT` characters it is one cookie, named as the key. Otherwise it is cut into
 *   pieces named `<key>.0`, `<key>.1`, …, each at most that many characters once encoded, and
 *   never cut through a character (so never through a `%XX` escape either).
 * - Reading takes the cookie named as the key when there is one, or else joins `<key>.0`,
 *   `<key>.1`, … in order up to the first missing number. Pieces that do not decode to JSON
 *   came from two different writes, and read as no session at all.
 * - Writing a shorter value clears the numbered pieces it no longer uses. A clear at a parent
 *   domain also clears the host-only copy, which a site that once stored host-only would
 *   otherwise bring back after sign-out.
 *
 * The limit leaves room under a browser's 4,096 bytes per cookie for the name and attributes.
 */

import type { SessionStorage } from './auth.js';

export interface CookieOptions {
	/** `.example.com` to share between subdomains. Leave unset for host-only. */
	domain?: string;
	path?: string;
	sameSite?: 'lax' | 'strict' | 'none';
	secure?: boolean;
	/** Seconds. 400 days by default, the most a browser honours. */
	maxAge?: number;
}

/** What `document` offers; a test passes its own. */
export interface CookieJar {
	cookie: string;
}

/** The most characters a cookie's URI-encoded value may hold before the value is cut into pieces. */
export const COOKIE_VALUE_LIMIT = 3180;
const BASE64_PREFIX = 'base64-';
const DEFAULTS: Required<Omit<CookieOptions, 'domain' | 'secure'>> = { path: '/', sameSite: 'lax', maxAge: 400 * 24 * 60 * 60 };

function toBase64Url(text: string): string {
	let binary = '';
	for (const byte of new TextEncoder().encode(text)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
	const base64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/[\s=]/g, '');
	const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
	return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** One cookie to write: a name and its value before URI encoding. */
export interface CookiePiece {
	name: string;
	value: string;
}

/**
 * Lays a value out as cookies. A value whose encoding fits in `limit` is one cookie named `key`;
 * a longer one is packed, a whole character at a time, into `<key>.0`, `<key>.1`, … with each
 * piece's encoding filled as far as `limit` allows. Measuring each character's own encoding
 * is what keeps a `%XX` escape, and a character of several bytes, inside one piece.
 */
export function splitCookieValue(key: string, value: string, limit = COOKIE_VALUE_LIMIT): CookiePiece[] {
	if (encodeURIComponent(value).length <= limit) {
		return [{ name: key, value }];
	}
	const pieces: CookiePiece[] = [];
	let current = '';
	let used = 0;
	for (const character of value) {
		const width = encodeURIComponent(character).length;
		if (width > limit) {
			throw new RangeError(`A cookie value limit of ${limit} cannot hold a character that encodes to ${width}`);
		}
		if (used + width > limit) {
			pieces.push({ name: `${key}.${pieces.length}`, value: current });
			current = '';
			used = 0;
		}
		current += character;
		used += width;
	}
	if (current) {
		pieces.push({ name: `${key}.${pieces.length}`, value: current });
	}
	return pieces;
}

/** Whether `name` is `key` itself or one of its numbered pieces (`key.0`, `key.12`; not `key.01`). */
function belongsTo(name: string, key: string): boolean {
	if (name === key) {
		return true;
	}
	if (!name.startsWith(`${key}.`)) {
		return false;
	}
	const index = name.slice(key.length + 1);
	return index !== '' && String(Number.parseInt(index, 10)) === index;
}

/** Decodes one cookie value: surrounding quotes dropped, escapes undone where they are valid. */
function readValue(raw: string): string {
	const unquoted = raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"' ? raw.slice(1, -1) : raw;
	if (!unquoted.includes('%')) {
		return unquoted;
	}
	try {
		return decodeURIComponent(unquoted);
	} catch {
		return unquoted;
	}
}

/** The `document.cookie` string as a map. Of two cookies with one name, the first is kept: it is the more specific one. */
function parse(header: string): Map<string, string> {
	const cookies = new Map<string, string>();
	for (const pair of header.split(';')) {
		const [rawName, ...rest] = pair.split('=');
		if (rest.length === 0) {
			continue;
		}
		const name = rawName.trim();
		if (name && !cookies.has(name)) {
			cookies.set(name, readValue(rest.join('=').trim()));
		}
	}
	return cookies;
}

/** The stored value for `key`: its own cookie, or else its numbered pieces joined in order. */
function assemble(cookies: Map<string, string>, key: string): string | null {
	const whole = cookies.get(key);
	if (whole) {
		return whole;
	}
	let joined = '';
	for (let index = 0; ; index += 1) {
		const piece = cookies.get(`${key}.${index}`);
		if (!piece) {
			return joined || null;
		}
		joined += piece;
	}
}

function serialize(name: string, value: string, options: CookieOptions & { maxAge: number }): string {
	const parts = [`${name}=${encodeURIComponent(value)}`, `Max-Age=${Math.floor(options.maxAge)}`];
	if (options.domain) {
		parts.push(`Domain=${options.domain}`);
	}
	parts.push(`Path=${options.path ?? DEFAULTS.path}`);
	if (options.secure) {
		parts.push('Secure');
	}
	const sameSite = options.sameSite ?? DEFAULTS.sameSite;
	parts.push(`SameSite=${sameSite[0].toUpperCase()}${sameSite.slice(1)}`);
	return parts.join('; ');
}

export function cookieStorage(options: CookieOptions = {}, jar?: CookieJar): SessionStorage {
	const doc = (): CookieJar => {
		const target = jar ?? (typeof document === 'undefined' ? undefined : document);
		if (!target) {
			throw new Error('cookieStorage needs a document: it is for browsers');
		}
		return target;
	};
	const remove = (names: string[]): void => {
		const gone = { ...options, maxAge: 0 };
		for (const name of names) {
			if (options.domain) {
				// The host-only copy first, then the one at the domain: see the header.
				doc().cookie = serialize(name, '', { ...gone, domain: undefined });
			}
			doc().cookie = serialize(name, '', gone);
		}
	};
	const namesFor = (key: string): string[] => [...parse(doc().cookie).keys()].filter((name) => belongsTo(name, key));

	return {
		getItem(key) {
			const stored = assemble(parse(doc().cookie), key);
			if (stored === null || !stored.startsWith(BASE64_PREFIX)) {
				return stored;
			}
			try {
				const text = fromBase64Url(stored.slice(BASE64_PREFIX.length));
				JSON.parse(text);
				return text;
			} catch {
				// Pieces from two different writes: no session, rather than a corrupt one.
				return null;
			}
		},
		setItem(key, value) {
			const pieces = splitCookieValue(key, BASE64_PREFIX + toBase64Url(value));
			const written = new Set(pieces.map((piece) => piece.name));
			remove(namesFor(key).filter((name) => !written.has(name)));
			const set = { ...options, maxAge: options.maxAge ?? DEFAULTS.maxAge };
			for (const piece of pieces) {
				doc().cookie = serialize(piece.name, piece.value, set);
			}
		},
		removeItem(key) {
			remove(namesFor(key));
		}
	};
}

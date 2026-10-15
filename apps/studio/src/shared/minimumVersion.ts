/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The oldest desktop version the backend still supports.
//
// Served by the accounts.snoutdata.com Worker itself (its MIN_DESKTOP_VERSION), so it answers
// whichever origin the Worker points at. Pure: main does the fetch and the file, this decides.
//
// The rules, in the order they matter:
// - It FAILS OPEN. An unreachable Worker, a garbled answer or no answer yet never blocks anyone;
//   only a live, well-formed answer can.
// - A cached "you are fine" is trusted for MINIMUM_VERSION_TTL_MS, so a launch is not a request. A cached
//   "update required" is never trusted on its own: it is re-asked every time, so lowering the
//   minimum releases a user at once instead of a TTL later.
import { isNewerVersion } from './update';

/** Path on accounts.snoutdata.com. Must match MIN_DESKTOP_VERSION_PATH in the Worker. */
export const MINIMUM_VERSION_PATH = '/desktop/v1/minimum-version';

/** How long a "not below the minimum" answer is reused before asking again. */
export const MINIMUM_VERSION_TTL_MS = 6 * 60 * 60 * 1000;

/** What is kept on disk between launches. `minimum` null means "no version is refused". */
export interface MinimumVersionCache {
	minimum: string | null;
	fetchedAt: number;
}

export type MinimumVersionState =
	| { required: false }
	| { required: true; minimum: string; current: string };

const VERSION = /^\d+\.\d+\.\d+$/;

/** The minimum out of the Worker's JSON body, or null when there is none (absent, malformed, 0.0.0). */
export function parseMinimumVersion(body: unknown): string | null {
	if (!body || typeof body !== 'object') {
		return null;
	}
	const minimum = (body as { minimum?: unknown }).minimum;
	if (typeof minimum !== 'string') {
		return null;
	}
	const trimmed = minimum.trim();
	if (!VERSION.test(trimmed) || !isNewerVersion(trimmed, '0.0.0')) {
		return null;
	}
	return trimmed;
}

/** A cache file's contents, or null when it is missing or not ours. */
export function parseMinimumVersionCache(raw: unknown): MinimumVersionCache | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const { minimum, fetchedAt } = raw as { minimum?: unknown; fetchedAt?: unknown };
	if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) {
		return null;
	}
	if (minimum !== null && (typeof minimum !== 'string' || !VERSION.test(minimum))) {
		return null;
	}
	return { minimum, fetchedAt };
}

/** Whether `current` is older than `minimum`. No minimum is never below it. */
export function isBelowMinimum(current: string, minimum: string | null): boolean {
	return minimum !== null && isNewerVersion(minimum, current);
}

/** Whether to ask the Worker, or reuse what is cached. */
export function shouldFetchMinimum(cache: MinimumVersionCache | null, current: string, now: number): boolean {
	if (!cache) {
		return true;
	}
	// A block is only ever shown on a fresh answer.
	if (isBelowMinimum(current, cache.minimum)) {
		return true;
	}
	// A clock that went backwards makes the entry's age meaningless; ask.
	const age = now - cache.fetchedAt;
	return age < 0 || age >= MINIMUM_VERSION_TTL_MS;
}

/** The result of a check: the state to show, and the cache to write (null leaves it alone). */
export interface MinimumVersionDecision {
	state: MinimumVersionState;
	cache: MinimumVersionCache | null;
}

/**
 * Decide from what was fetched. `fetched` is undefined when the cache was reused, `{ ok: false }`
 * when the request failed, and the parsed minimum when it succeeded.
 */
export function decideMinimumVersion(
	current: string,
	fetched: { ok: true; minimum: string | null } | { ok: false } | undefined,
	now: number,
): MinimumVersionDecision {
	if (fetched === undefined) {
		// Only reached for a fresh cache that does not block (shouldFetchMinimum), but stay safe.
		return { state: { required: false }, cache: null };
	}
	if (!fetched.ok) {
		return { state: { required: false }, cache: null };
	}
	const next: MinimumVersionCache = { minimum: fetched.minimum, fetchedAt: now };
	if (fetched.minimum !== null && isBelowMinimum(current, fetched.minimum)) {
		return { state: { required: true, minimum: fetched.minimum, current }, cache: next };
	}
	return { state: { required: false }, cache: next };
}

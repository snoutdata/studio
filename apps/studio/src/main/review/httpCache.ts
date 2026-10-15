/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Conditional requests: how the reviewer polls without spending its rate limit on silence.
 *
 *  A webhook cannot reach a laptop, so the desktop asks instead of being told (`reviewPoller.ts`).
 *  The cost of asking is the problem this file exists for. A pass over one repository is one call
 *  for the open pull requests plus one for the comments on each of them, so a repository with
 *  twenty open pull requests is twenty-one calls a minute, and four such repositories is over
 *  GitHub's 5,000-an-hour ceiling for an authenticated user. Reaching that limit does not degrade
 *  the reviewer, it stops it, and it stops the rest of the app's GitHub work with it.
 *
 *  Both hosts answer `If-None-Match` with **304 Not Modified**, and on GitHub a 304 **does not
 *  count against the rate limit at all**. On a quiet repository, which is nearly all of them
 *  nearly all of the time, every one of those calls becomes free. Nothing else changes: on a 304
 *  the client returns the body it already had, so the poller sees exactly what a 200 would have
 *  given it and no caller knows the difference.
 *
 *  Two things this deliberately is NOT:
 *
 *   - **Not a general HTTP cache.** No `Cache-Control`, no expiry, no revalidation policy. An
 *     entry is only ever used to ASK the server whether it is still current; the server decides,
 *     every time. That is why there is no staleness bug to have: we never serve a cached body
 *     without being told, in that request, that it is still the answer.
 *   - **Not shared between hosts or tokens.** It lives on `reviewService`, one per app, and is
 *     cleared whenever the identity changes (a token pasted, an App chosen, a GitLab instance
 *     repointed). GitHub's ETags are content-derived and a different token would get a 200 rather
 *     than a 304, so this is belt and braces rather than a correctness requirement; it costs one
 *     `Map.clear()` at a moment that already re-reads everything.
 *--------------------------------------------------------------------------------------------*/

/**
 * How many responses to remember.
 *
 * The bodies are lists of pull requests and comments, so a few KB each at the API's 100-item page
 * cap. The number that matters is how many DISTINCT urls a poll pass touches: one per repository
 * plus one per open pull request, which for any realistic setup is tens. This is generous enough
 * that a normal poll never evicts and small enough to be uninteresting in memory.
 */
const MAX_ENTRIES = 200;

interface CacheEntry {
	etag: string;
	body: unknown;
}

/**
 * ETags for GET requests, keyed by full url.
 *
 * The url is the whole key, query string included, which is what makes the comments endpoint work
 * at all: it is fetched as `…/comments?since=<cursor>`, and the cursor only moves when a pull
 * request actually changed. A quiet repository therefore asks the same url every pass and gets a
 * 304 every pass; a busy one moves the cursor, misses, and does the work it was always going to
 * have to do.
 */
export class ConditionalCache {
	private readonly entries = new Map<string, CacheEntry>();

	/**
	 * The entry for a url, if we hold one.
	 *
	 * Returns the etag AND the body together, on purpose. Sending `If-None-Match` without holding
	 * the body it refers to is the one way to turn this into a bug: the server answers 304, there
	 * is nothing to return, and the caller gets an empty list that reads as "no pull requests"
	 * rather than as an error. Handing both out at once makes that state unrepresentable.
	 */
	peek(url: string): CacheEntry | undefined {
		const entry = this.entries.get(url);
		if (entry) {
			// Re-insert to make eviction least-recently-USED rather than oldest-stored: a repository
			// polled every minute should never be evicted by a one-off settings-pane listing.
			this.entries.delete(url);
			this.entries.set(url, entry);
		}
		return entry;
	}

	/** Remember a response. A response with no ETag is not remembered: there would be nothing to
	 *  ask the server with next time, and an unconditional cache is not what this is. */
	store(url: string, etag: string | null | undefined, body: unknown): void {
		if (!etag) {
			return;
		}
		this.entries.delete(url);
		this.entries.set(url, { etag, body });
		while (this.entries.size > MAX_ENTRIES) {
			// Map iterates in insertion order, so the first key is the least recently used.
			const oldest = this.entries.keys().next();
			if (oldest.done) {
				break;
			}
			this.entries.delete(oldest.value);
		}
	}

	/** Forget everything. Called when the identity behind the requests changes. */
	clear(): void {
		this.entries.clear();
	}

	/** How many responses are held. For tests, and for anyone wondering where the memory went. */
	get size(): number {
		return this.entries.size;
	}
}

/**
 * Is this request one a conditional cache may be used for?
 *
 * GET only, and only when the caller has not asked for something other than JSON. A POST or PATCH
 * changes state and must always be sent; a diff is fetched once per review rather than per poll,
 * so caching it would buy nothing and would hold the largest bodies in the app.
 */
export function cacheable(method: string | undefined): boolean {
	return method === undefined || method.toUpperCase() === 'GET';
}

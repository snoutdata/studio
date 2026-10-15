/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { cacheable, ConditionalCache } from './httpCache';

/*
 * The conditional-request cache. Small, but every rule in it exists to stop a specific way of
 * turning "poll cheaply" into "poll wrongly", so each one is pinned rather than trusted.
 */

describe('ConditionalCache', () => {
	test('an unseen url has nothing to ask with', () => {
		assert.equal(new ConditionalCache().peek('https://api.github.com/x'), undefined);
	});

	test('the etag and the body come back TOGETHER, or not at all', () => {
		// This is the whole safety property. Sending If-None-Match without holding the body it
		// refers to gets a 304 with nothing to return, and the caller reads an empty list as "no
		// pull requests" rather than as an error. One accessor for both makes that unrepresentable.
		const cache = new ConditionalCache();
		cache.store('https://api.github.com/pulls', 'W/"abc"', [{ number: 7 }]);
		assert.deepEqual(cache.peek('https://api.github.com/pulls'), { etag: 'W/"abc"', body: [{ number: 7 }] });
	});

	test('a response with no ETag is not remembered', () => {
		// There would be nothing to ask the server with next time, and serving it unconditionally
		// is not what this is: the server decides on every single request.
		const cache = new ConditionalCache();
		cache.store('https://api.github.com/pulls', null, [1]);
		cache.store('https://api.github.com/other', undefined, [2]);
		cache.store('https://api.github.com/third', '', [3]);
		assert.equal(cache.size, 0);
	});

	test('storing the same url again replaces it rather than growing', () => {
		const cache = new ConditionalCache();
		cache.store('https://api.github.com/pulls', 'one', ['old']);
		cache.store('https://api.github.com/pulls', 'two', ['new']);
		assert.equal(cache.size, 1);
		assert.deepEqual(cache.peek('https://api.github.com/pulls'), { etag: 'two', body: ['new'] });
	});

	test('the query string is part of the key, because it is part of the question', () => {
		// The comments endpoint is fetched as `…/comments?since=<cursor>`. Two cursors are two
		// different questions and must never share an answer.
		const cache = new ConditionalCache();
		cache.store('https://x/comments?since=A', 'a', ['first']);
		cache.store('https://x/comments?since=B', 'b', ['second']);
		assert.equal(cache.peek('https://x/comments?since=A')?.etag, 'a');
		assert.equal(cache.peek('https://x/comments?since=B')?.etag, 'b');
	});

	test('it is bounded, so a large account cannot grow it forever', () => {
		const cache = new ConditionalCache();
		for (let i = 0; i < 500; i++) {
			cache.store(`https://x/${i}`, `e${i}`, [i]);
		}
		assert.ok(cache.size <= 200, `size was ${cache.size}`);
		// The most recent survive; the oldest are gone.
		assert.ok(cache.peek('https://x/499'));
		assert.equal(cache.peek('https://x/0'), undefined);
	});

	test('eviction is least recently USED, not oldest stored', () => {
		// A repository polled every minute must not be evicted by a one-off settings-pane listing
		// of four hundred repositories. Reading an entry has to count as using it.
		const cache = new ConditionalCache();
		cache.store('https://x/hot', 'hot', ['polled every minute']);
		for (let i = 0; i < 199; i++) {
			cache.store(`https://x/${i}`, `e${i}`, [i]);
			// The hot entry is read on every pass, as the poller would.
			cache.peek('https://x/hot');
		}
		cache.store('https://x/one-more', 'x', ['pushes it over']);
		assert.ok(cache.peek('https://x/hot'), 'the entry being used every pass was evicted');
	});

	test('clear forgets everything, for when the identity behind the requests changes', () => {
		const cache = new ConditionalCache();
		cache.store('https://x/a', 'a', [1]);
		cache.clear();
		assert.equal(cache.size, 0);
		assert.equal(cache.peek('https://x/a'), undefined);
	});
});

describe('cacheable', () => {
	test('GET, and a request with no method stated, which is a GET', () => {
		assert.equal(cacheable(undefined), true);
		assert.equal(cacheable('GET'), true);
		assert.equal(cacheable('get'), true);
	});

	test('anything that changes state is always sent', () => {
		// A conditional POST is not a cheaper POST, it is a comment that never gets posted.
		for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
			assert.equal(cacheable(method), false, method);
		}
	});
});

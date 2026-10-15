/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { classifyNetworkFailure, isNetworkError, networkBlockedMessage } from './netFetch';

// isNetworkError decides which auto-update failures get reported (updater.ts reportUpdateError):
// connectivity problems are the user's network and not worth a crash report, everything else is a
// real bug we must hear about. Getting that boundary wrong is dangerous in one direction — an
// over-broad match would silence a genuine broken-feed error, which is exactly the outage that
// went unnoticed when `components-v1` shadowed /latest and latest.yml started 404ing. These pin
// both sides of the line using the real strings observed in Sentry.

describe('isNetworkError', () => {
	it('matches the connectivity failures we do not want reported', () => {
		// Verbatim from Sentry: an offline laptop checking for updates.
		assert.equal(isNetworkError(new Error('net::ERR_INTERNET_DISCONNECTED')), true);
		assert.equal(isNetworkError(new Error('net::ERR_NAME_NOT_RESOLVED')), true);
		assert.equal(isNetworkError(new Error('net::ERR_PROXY_CONNECTION_FAILED')), true);
		assert.equal(isNetworkError(new Error('fetch failed')), true);
		assert.equal(isNetworkError(new Error('connect ETIMEDOUT 140.82.121.4:443')), true);
	});

	it('does NOT swallow a broken update feed', () => {
		// Verbatim from Sentry (the components-v1 shadowing outage). If this ever reads as a
		// network error, auto-update can break for every user and no one will be told.
		const brokenFeed = new Error(
			'Cannot find latest.yml in the latest release artifacts ' +
			'(https://github.com/snoutdata/studio/releases/download/components-v1/latest.yml): HttpError: 404 ' +
			'method: GET url: https://github.com/snoutdata/studio/releases/download/components-v1/latest.yml',
		);
		assert.equal(isNetworkError(brokenFeed), false, 'a 404 feed is our bug and must still be reported');
	});

	it('does NOT swallow other real updater failures', () => {
		assert.equal(isNetworkError(new Error('HttpError: 404')), false);
		assert.equal(isNetworkError(new Error('sha512 checksum mismatch')), false);
		assert.equal(isNetworkError(new Error('New version 1.0.11 is not signed by the application owner')), false);
		assert.equal(isNetworkError(new Error('ENOENT: no such file or directory')), false);
	});

	it('does not mistake a user-initiated abort for a network problem', () => {
		const abort = new Error('The operation was aborted');
		abort.name = 'AbortError';
		assert.equal(isNetworkError(abort), false);
	});
});

describe('networkBlockedMessage', () => {
	it('does not blame the network of the user by default', () => {
		// An unreachable backend is usually ours, not their firewall.
		for (const err of [undefined, new Error('timeout'), new Error('fetch failed'), new Error('net::ERR_CONNECTION_REFUSED'), new Error('net::ERR_NAME_NOT_RESOLVED'), new Error('connect ETIMEDOUT 1.2.3.4:443')]) {
			const message = networkBlockedMessage('the sign-in service', err);
			assert.doesNotMatch(message, /firewall|VPN|company|IT department/i, String(err));
			assert.match(message, /^Could not reach the sign-in service\./);
		}
	});

	it('names the network only when the error shows a proxy, certificate or admin block', () => {
		for (const err of [
			new Error('net::ERR_PROXY_CONNECTION_FAILED'),
			new Error('net::ERR_TUNNEL_CONNECTION_FAILED'),
			new Error('net::ERR_CERT_AUTHORITY_INVALID'),
			new Error('net::ERR_BLOCKED_BY_ADMINISTRATOR'),
			Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) }),
		]) {
			assert.equal(classifyNetworkFailure(err), 'local-network', String(err));
			assert.match(networkBlockedMessage('the sign-in service', err), /firewall/);
		}
	});

	it('says offline when the OS says there is no network', () => {
		const err = new Error('net::ERR_INTERNET_DISCONNECTED');
		assert.equal(classifyNetworkFailure(err), 'offline');
		assert.match(networkBlockedMessage('the AI service', err), /offline/);
		assert.doesNotMatch(networkBlockedMessage('the AI service', err), /firewall/);
	});

	it('reads the cause chain, where net.fetch puts the real code', () => {
		const err = new Error('fetch failed', { cause: { code: 'ENETUNREACH', message: 'connect ENETUNREACH' } });
		assert.equal(classifyNetworkFailure(err), 'offline');
	});
});

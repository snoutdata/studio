/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isRejectedToken } from './authErrors';

describe('isRejectedToken', () => {
	it('recognises the PostgREST body our own stack returns for a foreign-signed token', () => {
		// Copied from a real 401 against accounts.snoutdata.com, 2026-09-17.
		assert.equal(isRejectedToken({
			code: 'PGRST301',
			details: 'No suitable key was found to decode the JWT',
			hint: null,
			message: 'No suitable key or wrong key type',
		}), true);
	});

	it('recognises the auth server saying bad_jwt, under either spelling', () => {
		assert.equal(isRejectedToken({ code: 'bad_jwt', status: 403 }), true);
		assert.equal(isRejectedToken({ error_code: 'bad_jwt' }), true);
	});

	it('recognises a bare 401/403 from a function that checks the JWT itself', () => {
		assert.equal(isRejectedToken({ status: 401 }), true);
		assert.equal(isRejectedToken({ status: 403 }), true);
	});

	it('does NOT claim a network failure or a timeout is a bad token', () => {
		// This is the distinction the whole fix rests on: an unreachable backend must leave the
		// session (and the user's tier) exactly as it found them.
		assert.equal(isRejectedToken(new Error('net::ERR_NAME_NOT_RESOLVED')), false);
		assert.equal(isRejectedToken(new Error('timeout')), false);
		assert.equal(isRejectedToken({ status: 500, message: 'upstream is down' }), false);
		assert.equal(isRejectedToken({ code: 'PGRST116', message: 'no rows' }), false);
	});

	it('is safe on the things an error is not', () => {
		assert.equal(isRejectedToken(null), false);
		assert.equal(isRejectedToken(undefined), false);
		assert.equal(isRejectedToken('PGRST301'), false);
	});
});

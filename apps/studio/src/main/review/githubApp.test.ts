/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';

import { appJwtClaims, defaultInstallation, looksLikePrivateKey, signAppJwt, tokenExpired } from './githubApp';

/*
 * The GitHub App credentials, which is how a review comes from `snoutbot[bot]` rather than from
 * a person. Everything here is pure and everything here fails CONFUSINGLY when it is wrong: a
 * clock a few seconds fast, a key that is not the App's, an App installed twice. None of it
 * announces itself as the cause, so each one is pinned rather than discovered on somebody's
 * repository.
 */

const KEY = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

function decode(part: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

describe('appJwtClaims', () => {
	test('iat is BACKDATED, or a clock running fast means a 401 on some machines and not others', () => {
		// GitHub rejects a token issued in its own future. A workstation a few seconds ahead is
		// common, and the failure it produces says nothing about clocks.
		const claims = appJwtClaims('1234567', NOW);
		assert.ok(claims.iat < Math.floor(NOW / 1000), 'iat must be in the past');
		assert.equal(Math.floor(NOW / 1000) - claims.iat, 60);
	});

	test('exp is inside the ten minutes GitHub allows', () => {
		const claims = appJwtClaims('1234567', NOW);
		const life = claims.exp - Math.floor(NOW / 1000);
		assert.ok(life > 0 && life <= 600, `lifetime was ${life}s`);
	});

	test('the issuer is the App id', () => {
		assert.equal(appJwtClaims('1234567', NOW).iss, '1234567');
	});
});

describe('signAppJwt', () => {
	test('produces three base64url parts that verify against the public key', () => {
		const jwt = signAppJwt({ appId: '1234567', privateKeyPem: KEY.privateKey }, NOW);
		const parts = jwt.split('.');
		assert.equal(parts.length, 3);
		assert.deepEqual(decode(parts[0]), { alg: 'RS256', typ: 'JWT' });
		assert.equal(decode(parts[1]).iss, '1234567');
		// Base64url, not base64: a `+` or `/` in the signature makes the whole token invalid, and
		// it only happens for some keys, so it is exactly the bug that ships.
		assert.ok(!/[+/=]/.test(parts[2]), 'signature must be base64url');

		const verifier = createVerify('RSA-SHA256');
		verifier.update(`${parts[0]}.${parts[1]}`);
		verifier.end();
		assert.ok(verifier.verify(KEY.publicKey, Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64')));
	});

	test('a key that is not a key fails with something a person can act on', () => {
		assert.throws(
			() => signAppJwt({ appId: '1', privateKeyPem: 'not a key' }),
			/private key/i,
		);
	});
});

describe('looksLikePrivateKey', () => {
	test('accepts what GitHub actually downloads, and both header spellings', () => {
		assert.equal(looksLikePrivateKey(KEY.privateKey), true);
		assert.equal(looksLikePrivateKey('-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----'), true);
	});

	test('rejects the two things people paste by mistake', () => {
		// The public half, and the App id.
		assert.equal(looksLikePrivateKey(KEY.publicKey), false);
		assert.equal(looksLikePrivateKey('1234567'), false);
		assert.equal(looksLikePrivateKey(''), false);
	});
});

describe('tokenExpired', () => {
	test('an installation token is renewed BEFORE it lapses, not after', () => {
		// It lasts an hour and a review takes seconds, so the only way to be caught is to start
		// one just as it expires. A minute of margin removes the whole class.
		const expires = NOW + 3_600_000;
		assert.equal(tokenExpired(expires, NOW), false);
		assert.equal(tokenExpired(expires, expires - 30_000), true);
		assert.equal(tokenExpired(expires, expires - 120_000), false);
	});

	test('no token at all is expired', () => {
		assert.equal(tokenExpired(undefined, NOW), true);
	});
});

describe('defaultInstallation', () => {
	test('one installation is chosen silently, because there is nothing to ask', () => {
		assert.equal(defaultInstallation([{ id: 42, account: 'acme' }]), 42);
	});

	test('several is not guessable, so it asks rather than picking', () => {
		// An App installed on two organizations could review either, and choosing wrong means
		// reviewing the wrong company's pull requests.
		assert.equal(defaultInstallation([{ id: 1, account: 'acme' }, { id: 2, account: 'other' }]), undefined);
		assert.equal(defaultInstallation([]), undefined);
	});
});

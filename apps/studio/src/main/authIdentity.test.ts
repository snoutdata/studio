/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sessionProvider, ssoFailureMessage } from './authIdentity';
import { ssoDomainFromEmail } from '../shared/auth';

describe('ssoDomainFromEmail', () => {
	it('takes the domain out of a work email', () => {
		assert.equal(ssoDomainFromEmail('ada@acme.com'), 'acme.com');
		assert.equal(ssoDomainFromEmail('ada.lovelace@mail.corp.acme.co.uk'), 'mail.corp.acme.co.uk');
	});

	it('normalises what a person actually types', () => {
		assert.equal(ssoDomainFromEmail('  Ada@ACME.com '), 'acme.com');
	});

	it('accepts a bare domain, which people type just as readily', () => {
		assert.equal(ssoDomainFromEmail('acme.com'), 'acme.com');
		assert.equal(ssoDomainFromEmail('my-company.co.uk'), 'my-company.co.uk');
	});

	it('refuses what cannot be a domain, so a typo never becomes a backend call', () => {
		assert.equal(ssoDomainFromEmail(''), null);
		assert.equal(ssoDomainFromEmail('   '), null);
		assert.equal(ssoDomainFromEmail('ada'), null);
		assert.equal(ssoDomainFromEmail('@acme.com'), null);
		assert.equal(ssoDomainFromEmail('ada@'), null);
		assert.equal(ssoDomainFromEmail('ada@@acme.com'), null);
		assert.equal(ssoDomainFromEmail('ada@acme'), null);
		assert.equal(ssoDomainFromEmail('ada@localhost'), null);
		assert.equal(ssoDomainFromEmail('ada@acme.1'), null);
		assert.equal(ssoDomainFromEmail('ada@-acme.com'), null);
		assert.equal(ssoDomainFromEmail('ada@acme-.com'), null);
		assert.equal(ssoDomainFromEmail('ada@acme .com'), null);
		assert.equal(ssoDomainFromEmail('ada@acme..com'), null);
	});
});

describe('sessionProvider', () => {
	it('reports the identity this session used, not the account\'s first one', () => {
		// The live bug: an account created with Google and signed into with GitHub reported
		// "google" forever, because app_metadata.provider is written once at creation.
		assert.equal(sessionProvider({
			app_metadata: { provider: 'google', providers: ['google', 'github'] },
			identities: [
				{ provider: 'google', created_at: '2026-01-01T00:00:00Z', last_sign_in_at: '2026-01-01T00:00:00Z' },
				{ provider: 'github', created_at: '2026-02-01T00:00:00Z', last_sign_in_at: '2026-09-17T09:00:00Z' },
			],
		}), 'github');
	});

	it('reports a SAML sign-in as plain sso, never the raw provider uuid', () => {
		assert.equal(sessionProvider({
			app_metadata: { provider: 'sso:0e5c0f1a-2b3c-4d5e-8f60-718293a4b5c6' },
			identities: [{ provider: 'sso:0e5c0f1a-2b3c-4d5e-8f60-718293a4b5c6', last_sign_in_at: '2026-09-17T09:00:00Z' }],
			is_sso_user: true,
		}), 'sso');
	});

	it('picks the SSO identity when it is the one just used on a linked account', () => {
		assert.equal(sessionProvider({
			app_metadata: { provider: 'google' },
			identities: [
				{ provider: 'google', last_sign_in_at: '2026-05-02T10:00:00Z' },
				{ provider: 'sso:0e5c0f1a-2b3c-4d5e-8f60-718293a4b5c6', last_sign_in_at: '2026-09-17T09:00:00Z' },
			],
		}), 'sso');
	});

	it('falls back to server_data when there are no identities to read', () => {
		assert.equal(sessionProvider({ server_data: { provider: 'github' } }), 'github');
		assert.equal(sessionProvider({ server_data: { provider: 'github' }, identities: null }), 'github');
		// Its earlier name, which an identity server not yet on the new names sends alone.
		assert.equal(sessionProvider({ app_metadata: { provider: 'github' } }), 'github');
		assert.equal(sessionProvider({ server_data: { provider: 'gitlab' }, app_metadata: { provider: 'github' } }), 'gitlab');
	});

	it('never reports an SSO account as something else, and answers nothing when it knows nothing', () => {
		assert.equal(sessionProvider({ is_sso_user: true }), 'sso');
		assert.equal(sessionProvider({}), undefined);
		assert.equal(sessionProvider({ app_metadata: { provider: 42 } }), undefined);
	});

	it('ignores identities with no usable provider name', () => {
		assert.equal(sessionProvider({
			app_metadata: { provider: 'google' },
			identities: [{ provider: '' }, { last_sign_in_at: '2026-09-17T09:00:00Z' }],
		}), 'google');
	});

	it('keeps the first identity when nothing distinguishes them', () => {
		assert.equal(sessionProvider({
			identities: [{ provider: 'github' }, { provider: 'google' }],
		}), 'github');
	});
});

describe('ssoFailureMessage', () => {
	it('turns "nobody has connected a provider" into something a person can act on', () => {
		// What the auth server answers a domain it has no provider for.
		const message = ssoFailureMessage({ status: 404, message: 'No SSO provider assigned for this domain' }, 'acme.com');
		assert.match(message, /^No single sign-on is set up for acme\.com\./);
		assert.match(message, /identity provider/);
		assert.doesNotMatch(message, /404/);
	});

	it('treats a 404 with no wording, and the wording with no status, the same way', () => {
		assert.match(ssoFailureMessage({ status: 404 }, 'acme.com'), /^No single sign-on is set up for acme\.com\./);
		assert.match(ssoFailureMessage({ message: 'no sso provider assigned for this domain' }, 'acme.com'), /^No single sign-on is set up/);
	});

	it('says so plainly when SAML itself is off', () => {
		assert.match(ssoFailureMessage({ status: 400, message: 'SAML 2.0 is disabled' }, 'acme.com'), /^Single sign-on is not available for acme\.com yet\./);
	});

	it('keeps the backend\'s own words for anything it does not recognise', () => {
		assert.equal(ssoFailureMessage({ status: 500, message: 'Internal server error' }, 'acme.com'), 'Internal server error');
	});

	it('still produces a sentence when there is no error to read', () => {
		assert.equal(ssoFailureMessage(null, 'acme.com'), 'Could not start single sign-on for acme.com.');
		assert.equal(ssoFailureMessage({}, 'acme.com'), 'Could not start single sign-on for acme.com.');
	});
});

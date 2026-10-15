/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scrubEvent, scrubText, scrubValue } from './telemetry';

test('scrubText redacts database connection URIs', () => {
	const input = 'failed to connect to mysql://admin:s3cret@db.prod.internal:3306/orders on startup';
	const out = scrubText(input);
	assert.ok(!out.includes('s3cret'));
	assert.ok(!out.includes('db.prod.internal'));
	assert.ok(out.includes('[redacted-connection-uri]'));
});

test('scrubText redacts postgres and sqlserver URIs too', () => {
	assert.ok(!scrubText('postgres://u:p@h/db').includes('p@h'));
	assert.ok(!scrubText('sqlserver://sa:pw@host').includes('pw@host'));
});

test('scrubText redacts bearer tokens and sk- keys', () => {
	assert.ok(!scrubText('Authorization: Bearer abcdef123456').includes('abcdef123456'));
	assert.ok(!scrubText('key sk-abcdEFGH12345678 used').includes('sk-abcdEFGH'));
});

test('scrubText redacts password= / apiKey: pairs regardless of quoting', () => {
	assert.ok(!scrubText('password=hunter2').includes('hunter2'));
	assert.ok(!scrubText('"apiKey": "abc123def"').includes('abc123def'));
	assert.ok(!scrubText('passphrase = topSecret').includes('topSecret'));
});

// The fixtures below are assembled at run time, so the source holds nothing a secret scanner (or
// the open-source gate) reads as a real credential.
const join = (...parts: string[]): string => parts.join('');
const AWS_KEY_ID = join('AK', 'IA', 'IOSFODNN7', 'EXAMPLE');
const AWS_TEMP_KEY_ID = join('AS', 'IA', 'Y34FZKBOKMUTVV7A');
const AWS_SECRET = join('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY');

test('scrubText redacts GitHub, GitLab and SnoutData tokens', () => {
	const tokens = [
		join('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'),
		join('gh', 'o_', 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789ab'),
		join('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'),
		join('gl', 'pat-', 'abcdefghij0123456789'),
		join('sd', 't_', 'k7Qm2xY9pLw4Rz8vN1'),
	];
	for (const token of tokens) {
		const out = scrubText(`push failed with ${token} as the credential`);
		assert.ok(!out.includes(token), `${token} leaked: ${out}`);
		assert.ok(out.includes('[redacted-key]'));
	}
});

test('scrubText redacts an AWS access key id and the secret beside it', () => {
	const out = scrubText(`aws configure: ${AWS_KEY_ID} ${AWS_SECRET} region us-west-2`);
	assert.ok(!out.includes(AWS_KEY_ID));
	assert.ok(!out.includes(AWS_SECRET));
	assert.ok(out.includes('us-west-2'));
	assert.ok(!scrubText(`temporary ${AWS_TEMP_KEY_ID} expired`).includes(AWS_TEMP_KEY_ID));
	assert.ok(!scrubText(`aws_secret_access_key = ${AWS_SECRET}`).includes(AWS_SECRET));
	// A 40-character hex hash on its own (a git sha) is not a secret and stays readable.
	const sha = 'commit 3f786850e387550fdab836ed7e6dc881de23001b failed';
	assert.equal(scrubText(sha), sha);
});

test('scrubText redacts a JWT', () => {
	const segment = (json: string): string => Buffer.from(json).toString('base64url');
	const jwt = [segment('{"alg":"HS256","typ":"JWT"}'), segment('{"sub":"1234567890","role":"anon"}'), 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.');
	const out = scrubText(`refresh failed for ${jwt}`);
	assert.ok(!out.includes(jwt.split('.')[1]));
	assert.ok(out.includes('[redacted-jwt]'));
});

test('scrubText redacts signed-URL query values and credentials in any URL', () => {
	const s3 = 'GET https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261014%2Fus-west-2&X-Amz-Signature=fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024 403';
	const out = scrubText(s3);
	assert.ok(!out.includes('fe5f80f77d5fa3beca038a248ff027d0445342fe'));
	assert.ok(!out.includes('AKIDEXAMPLE'));
	assert.ok(out.includes('X-Amz-Algorithm=AWS4-HMAC-SHA256'));
	assert.ok(!scrubText('https://acct.blob.core.windows.net/c/f?sv=2022&sig=abcDEF%2B123%3D&sp=r').includes('abcDEF'));
	assert.ok(!scrubText('https://x.example/cb?code=4%2F0AQlEd8x&state=1').includes('4%2F0AQlEd8x'));
	const userinfo = scrubText(join('clone https://someone:', 'hunter2value', '@', 'example.com/repo.git failed'));
	assert.ok(!userinfo.includes('hunter2value'));
	assert.ok(userinfo.includes('example.com/repo.git'));
});

test('scrubText leaves benign text untouched', () => {
	const benign = 'TypeError: cannot read property foo of undefined';
	assert.equal(scrubText(benign), benign);
});

test('scrubValue redacts values under sensitive keys by name', () => {
	const out = scrubValue({ password: 'p', sql: 'SELECT 1', host: 'h', label: 'keep me' }) as Record<string, unknown>;
	assert.equal(out.password, '[redacted]');
	assert.equal(out.sql, '[redacted]');
	assert.equal(out.host, '[redacted]');
	assert.equal(out.label, 'keep me');
});

test('scrubValue recurses into nested objects and arrays', () => {
	const out = scrubValue({ a: [{ token: 'x' }, { ok: 'y' }] }) as { a: Array<Record<string, unknown>> };
	assert.equal(out.a[0].token, '[redacted]');
	assert.equal(out.a[1].ok, 'y');
});

test('scrubValue survives cyclic structures', () => {
	const cyclic: Record<string, unknown> = { name: 'n' };
	cyclic.self = cyclic;
	assert.doesNotThrow(() => scrubValue(cyclic));
});

test('scrubEvent cleans message, exception value, stack vars, and breadcrumbs', () => {
	const event = {
		message: 'connect mysql://u:pw@h/db failed',
		exception: { values: [{ value: 'auth failed with password=hunter2', stacktrace: { frames: [{ vars: { password: 'hunter2', line: 'ok' } }] } }] },
		breadcrumbs: [{ message: 'ran query', data: { sql: 'DELETE FROM users', rows: 3 } }],
		extra: { apiKey: 'sk-12345678', note: 'fine' },
		request: { headers: { authorization: 'Bearer xyz' }, query_string: 'token=abc' },
		user: { id: 'anon-1', email: 'alex@example.com' },
	};
	const out = scrubEvent(event);
	assert.ok(!out.message.includes('pw@h'));
	assert.ok(!out.exception.values[0].value.includes('hunter2'));
	assert.equal(out.exception.values[0].stacktrace.frames[0].vars.password, '[redacted]');
	assert.equal(out.exception.values[0].stacktrace.frames[0].vars.line, 'ok');
	assert.equal(out.breadcrumbs[0].data.sql, '[redacted]');
	assert.equal(out.breadcrumbs[0].data.rows, 3);
	assert.equal(out.extra.apiKey, '[redacted]');
	assert.equal(out.extra.note, 'fine');
	assert.equal(out.request.headers, undefined);
	// PII stripped to a bare id.
	assert.deepEqual(out.user, { id: 'anon-1' });
});

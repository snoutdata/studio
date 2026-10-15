/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudStore } from '../cloudStore';
import type { SecretStore } from '../secretStore';
import type { CloudAccount, CloudVendor } from '../../shared/cloud';
import type { VerifyCloudAccountParams, VerifyCloudAccountResult } from '../../shared/protocol';
import { CloudService } from './cloudService';

// Test with no storage or log-source driver registered, which is a unit test's state and the
// open-source build's (those drivers are Data Flows there): the account is signed in to the
// vendor's LOG service through the server child instead.

const noSecrets = { get: () => undefined, store: () => {}, delete: () => {} } as unknown as SecretStore;

function account(vendor: CloudVendor): CloudAccount {
	return { id: `a-${vendor}`, name: vendor, vendor, auth: { mode: 'key', keyId: 'KEYID' } };
}

function service(verify?: (params: VerifyCloudAccountParams) => Promise<VerifyCloudAccountResult>): CloudService {
	return new CloudService(new CloudStore(mkdtempSync(join(tmpdir(), 'snout-cloud-'))), noSecrets, verify);
}

describe('a cloud account\'s Test with no driver in the build', () => {
	test('signs in to the vendor\'s log service, with the secret just typed', async () => {
		const asked: VerifyCloudAccountParams[] = [];
		const cloud = service(async (params) => {
			asked.push(params);
			return { ok: true };
		});
		const result = await cloud.test({ account: account('aws'), secret: 'typed-secret' });
		assert.equal(result.ok, true);
		assert.match(result.message ?? '', /Signed in to Amazon CloudWatch Logs\. Choose the region on the connection\./);
		assert.deepEqual(asked.map((p) => [p.service, p.secret]), [['cloudwatch', 'typed-secret']]);
	});

	test('a refusal is the service\'s own explanation', async () => {
		const cloud = service(async () => ({ ok: false, message: 'The client secret is wrong. Re-enter it.' }));
		const result = await cloud.test({ account: account('azure'), secret: 'bad' });
		assert.equal(result.ok, false);
		assert.equal(result.message, 'The client secret is wrong. Re-enter it.');
	});

	test('a server that fails to answer is a failed test, not a thrown one', async () => {
		const cloud = service(async () => {
			throw new Error('the server child is not running');
		});
		const result = await cloud.test({ account: account('gcp'), secret: '{}' });
		assert.equal(result.ok, false);
		assert.match(result.message ?? '', /not running/);
	});

	test('S3-compatible storage has no log service, so it is not signed in anywhere', async () => {
		let called = false;
		const cloud = service(async () => {
			called = true;
			return { ok: true };
		});
		const result = await cloud.test({ account: account('s3compat'), secret: 'x' });
		assert.equal(result.ok, false);
		assert.equal(called, false);
	});
});

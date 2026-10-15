/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CloudStore, stripSecrets } from './cloudStore';
import { cloudSecretId, type CloudAccount } from '../shared/cloud';

function accountFor(id: string, name = id): CloudAccount {
	return {
		id,
		name,
		vendor: 'aws',
		region: 'eu-west-1',
		auth: { mode: 'key', keyId: 'AKIAEXAMPLE' },
	};
}

function withStore(fn: (store: CloudStore, dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'cloudstore-'));
	try {
		fn(new CloudStore(dir), dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('CloudStore', () => {
	test('saves, reads back and removes', () => {
		withStore((store) => {
			assert.deepEqual(store.list(), []);
			store.save(accountFor('a', 'acme'));
			store.save(accountFor('b', 'beta'));
			assert.deepEqual(store.list().map((p) => p.id), ['a', 'b']);
			assert.equal(store.get('a')?.region, 'eu-west-1');
			store.remove('a');
			assert.deepEqual(store.list().map((p) => p.id), ['b']);
			assert.equal(store.get('a'), undefined);
		});
	});

	test('cloud.json is readable by its owner only, even over an older world-readable one', { skip: process.platform === 'win32' }, () => {
		withStore((store, dir) => {
			const path = join(dir, 'cloud.json');
			writeFileSync(path, '{"accounts":[]}');
			chmodSync(path, 0o644);
			store.save(accountFor('a', 'acme'));
			assert.equal(statSync(path).mode & 0o777, 0o600);
		});
	});

	test('saving the same id replaces rather than duplicates', () => {
		withStore((store) => {
			store.save(accountFor('a', 'acme'));
			store.save({ ...accountFor('a', 'acme renamed'), region: 'us-east-1' });
			assert.equal(store.list().length, 1);
			assert.equal(store.get('a')?.region, 'us-east-1');
		});
	});

	test('listing is by name, so a picker does not reshuffle between launches', () => {
		withStore((store) => {
			store.save(accountFor('1', 'zeta'));
			store.save(accountFor('2', 'Alpha'));
			store.save(accountFor('3', 'beta'));
			assert.deepEqual(store.list().map((p) => p.name), ['Alpha', 'beta', 'zeta']);
		});
	});

	test('a secret cannot be written to the file, whatever the caller passed', () => {
		// The type says it cannot be here. That guarantee is exactly what a plain object off an IPC
		// channel does not carry, and this file sits in userData in the clear beside connections.json.
		withStore((store, dir) => {
			const smuggled = {
				...accountFor('a'),
				secretAccessKey: 'super-secret',
				auth: { mode: 'key', keyId: 'AKIAEXAMPLE', secretAccessKey: 'super-secret' },
			} as unknown as CloudAccount;
			store.save(smuggled);
			const onDisk = readFileSync(join(dir, 'cloud.json'), 'utf8');
			assert.doesNotMatch(onDisk, /super-secret/, 'the secret reached the disk');
			assert.match(onDisk, /AKIAEXAMPLE/, 'the non-secret half is still stored');
			assert.equal((store.get('a')?.auth as unknown as { keyId: string }).keyId, 'AKIAEXAMPLE');
		});
	});

	test('stripSecrets does not mutate what it was handed', () => {
		const original = { ...accountFor('a'), auth: { mode: 'key', keyId: 'A', secretAccessKey: 's' } } as unknown as CloudAccount;
		stripSecrets(original);
		assert.equal((original.auth as unknown as { secretAccessKey?: string }).secretAccessKey, 's');
	});

	test('an unreadable file is empty rather than a crash', () => {
		withStore((store, dir) => {
			writeFileSync(join(dir, 'cloud.json'), '{ not json', 'utf8');
			assert.deepEqual(store.list(), []);
			// And it is still writable afterwards, so a corrupt file is recoverable by using the app.
			store.save(accountFor('a'));
			assert.equal(store.list().length, 1);
		});
	});

	test('the keychain id is derived and stable', () => {
		assert.equal(cloudSecretId('abc'), 'cloud:abc');
	});
});

describe('CloudStore migration — a service tag becomes a vendor', () => {
	// An account used to be tagged with the SERVICE it was for (`provider: 's3'`), which is what
	// made a credential something you entered twice and a Settings page something a new service had
	// to be added to. A file written by that build must still open, and must be rewritten the
	// moment anything touches it.
	function withLegacy(accounts: unknown[], fn: (store: CloudStore, dir: string) => void): void {
		const dir = mkdtempSync(join(tmpdir(), 'cloudstore-legacy-'));
		try {
			writeFileSync(join(dir, 'cloud.json'), JSON.stringify({ accounts }, null, 2), 'utf8');
			fn(new CloudStore(dir), dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test('every old service tag lands on the vendor that owns it', () => {
		withLegacy([
			{ id: 'a', name: 'files', provider: 's3', auth: { mode: 'chain' } },
			{ id: 'b', name: 'logs', provider: 'cloudwatch', auth: { mode: 'chain' } },
			{ id: 'c', name: 'blob', provider: 'azureBlob', auth: { mode: 'chain' } },
			{ id: 'd', name: 'monitor', provider: 'azureMonitor', auth: { mode: 'chain' } },
			{ id: 'e', name: 'gcs', provider: 'gcs', auth: { mode: 'chain' } },
			{ id: 'f', name: 'gcplogs', provider: 'gcpLogging', auth: { mode: 'chain' } },
		], (store) => {
			const byId = new Map(store.list().map((account) => [account.id, account.vendor]));
			assert.equal(byId.get('a'), 'aws');
			assert.equal(byId.get('b'), 'aws');
			assert.equal(byId.get('c'), 'azure');
			assert.equal(byId.get('d'), 'azure');
			assert.equal(byId.get('e'), 'gcp');
			assert.equal(byId.get('f'), 'gcp');
		});
	});

	test('an s3 account with an endpoint was never Amazon', () => {
		// The one case the old tag does not decide on its own, and the reason `s3compat` is a vendor:
		// an R2 or MinIO account calling itself `aws` would be offered the AWS CLI's profiles, which
		// cannot sign a request to somebody else's endpoint.
		withLegacy([
			{ id: 'r2', name: 'r2', provider: 's3', endpoint: 'https://acct.r2.cloudflarestorage.com', auth: { mode: 'key', keyId: 'K' } },
		], (store) => {
			assert.equal(store.get('r2')?.vendor, 's3compat');
		});
	});

	test('the old field is gone from what is written back', () => {
		withLegacy([{ id: 'a', name: 'files', provider: 's3', auth: { mode: 'chain' } }], (store, dir) => {
			const migrated = store.get('a');
			assert.ok(migrated);
			store.save(migrated);
			const raw = JSON.parse(readFileSync(join(dir, 'cloud.json'), 'utf8')) as { accounts: Record<string, unknown>[] };
			assert.equal(raw.accounts[0].vendor, 'aws');
			assert.equal('provider' in raw.accounts[0], false);
		});
	});

	test('an account with a tag nobody recognises is kept, not dropped', () => {
		// An account that vanishes takes every flow pointing at it with it. A wrong vendor is on
		// screen and one click from being right.
		withLegacy([{ id: 'x', name: 'mystery', provider: 'oracleCloud', auth: { mode: 'chain' } }], (store) => {
			assert.equal(store.list().length, 1);
			assert.equal(store.get('x')?.vendor, 'aws');
		});
	});
});

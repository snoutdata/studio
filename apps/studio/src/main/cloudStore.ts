/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { VENDOR_SERVICES, type CloudAccount, type CloudVendor } from '../shared/cloud';
import { writePrivateFile } from './privateFile';

// Cloud accounts → userData/cloud.json.
//
// The `tunnelStore.ts` shape, with a ctor-injected baseDir so it is node-testable
// without Electron. Holds NO secrets: an account's secret access key lives in `secretStore` under
// `cloudSecretId(id)`, and `save` strips anything secret-shaped that reaches it anyway (see below).
//
// Why this is not a connection is the first thing in `shared/cloud.ts` and is not repeated here.

interface CloudState {
	accounts: CloudAccount[];
}

/**
 * Fields that must never be written to this file, checked by NAME rather than trusted to the type.
 *
 * The type already says a secret cannot be here. That guarantee is exactly what evaporates at a
 * boundary: an account arriving over IPC is a plain object, and a renderer that helpfully kept the
 * key beside the id would persist it in the clear next to `connections.json`. This is the same
 * argument `pairIsWritable` makes for checking membership rather than switching on a union.
 */
const NEVER_STORED = ['secretAccessKey', 'secret', 'password', 'sessionToken', 'token'];

export class CloudStore {
	constructor(private readonly userDataDir: string) {}

	private path(): string {
		return join(this.userDataDir, 'cloud.json');
	}

	private read(): CloudState {
		const path = this.path();
		if (!existsSync(path)) {
			return { accounts: [] };
		}
		try {
			const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<CloudState>;
			return {
				accounts: (raw.accounts ?? [])
					.filter((account) => typeof account?.id === 'string')
					.map((account) => migrateAccount(account)),
			};
		} catch {
			// Unreadable is empty, not a crash: a corrupt profile file must not stop the app opening,
			// and every other *Store here reads the same way.
			return { accounts: [] };
		}
	}

	private write(state: CloudState): void {
		writePrivateFile(this.path(), JSON.stringify(state, null, 2));
	}

	/** Every saved account, by name, so a picker is stable between launches. */
	list(): CloudAccount[] {
		return [...this.read().accounts].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
	}

	get(id: string): CloudAccount | undefined {
		return this.read().accounts.find((account) => account.id === id);
	}

	/** Insert or replace an account, matched by id. Returns what was actually stored. */
	save(account: CloudAccount): CloudAccount {
		const clean = stripSecrets(migrateAccount(account));
		const others = this.read().accounts.filter((entry) => entry.id !== clean.id);
		this.write({ accounts: [...others, clean] });
		return clean;
	}

	/** Forget an account. The caller deletes its keychain entry; this file never held one. */
	remove(id: string): void {
		this.write({ accounts: this.read().accounts.filter((account) => account.id !== id) });
	}
}

/** An account with anything secret-shaped removed, whatever the type claimed. */
export function stripSecrets(account: CloudAccount): CloudAccount {
	const copy: Record<string, unknown> = { ...account, auth: { ...account.auth } };
	const auth = copy.auth as Record<string, unknown>;
	for (const field of NEVER_STORED) {
		delete copy[field];
		delete auth[field];
	}
	return copy as unknown as CloudAccount;
}

/**
 * The service ids an account used to be tagged with, and the vendor each one belongs to.
 *
 * An account was once per SERVICE (`provider: 's3'`, `provider: 'cloudwatch'`), which meant one
 * credential entered twice and a Settings page that had to know every service. It is now per
 * VENDOR. This runs on every read AND on every save, so a file written by an older build is read
 * correctly and rewritten the moment anything touches it.
 *
 * An `s3` account with an endpoint set was never Amazon: that is exactly what the field means, and
 * it is the one case where the old tag does not determine the answer on its own.
 */
const VENDOR_OF_SERVICE: Record<string, CloudVendor> = {
	s3: 'aws',
	cloudwatch: 'aws',
	azureBlob: 'azure',
	azureMonitor: 'azure',
	gcs: 'gcp',
	gcpLogging: 'gcp',
};

export function migrateAccount(account: CloudAccount): CloudAccount {
	if (account.vendor && VENDOR_SERVICES[account.vendor]) {
		return account;
	}
	const legacy = (account as unknown as { provider?: string }).provider;
	const copy = { ...account } as CloudAccount & { provider?: string };
	delete copy.provider;
	// An unknown tag becomes `aws` rather than being dropped: an account that vanishes takes every
	// flow pointing at it with it, and a wrong vendor is visible on screen and one click to fix.
	copy.vendor = legacy === 's3' && account.endpoint ? 's3compat' : VENDOR_OF_SERVICE[legacy ?? ''] ?? 'aws';
	return copy;
}

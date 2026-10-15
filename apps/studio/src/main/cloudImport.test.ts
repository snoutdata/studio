/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConnectionConfig } from '../shared/connection';
import { projectToValues, resolveSnoutdataCloudImport, scanSnoutdataCloud } from './cloudImport';
import type { CloudApi, CloudConnectionDetails, CloudProjectSummary } from './cloudApi';

// Importing hosted databases. Everything that decides is here and takes a `CloudApi`, so a
// signed-out user, an empty account, a project already imported and one that has been deleted
// are all provable in a millisecond.

const REF = 'exampleref001';

function project(over: Partial<CloudProjectSummary> = {}): CloudProjectSummary {
	return {
		ref: REF,
		name: "first light",
		region: 'us-west-2',
		production: false,
		state: 'ready',
		host: `${REF}.db.snoutdata.com`,
		database: REF,
		user: `${REF}_owner`,
		wakesInstantly: true,
		readOnly: false,
		...over,
	};
}

function details(over: Partial<CloudConnectionDetails> = {}): CloudConnectionDetails {
	return {
		ref: REF,
		host: `${REF}.db.snoutdata.com`,
		port: 5432,
		database: REF,
		user: `${REF}_owner`,
		password: 'the-real-password',
		state: 'ready',
		...over,
	};
}

function api(over: Partial<CloudApi> = {}): CloudApi {
	return {
		account: async () => 'alex@example.com',
		list: async () => [project()],
		connection: async () => details(),
		pause: async () => ({ project: project(), changed: true }),
		resume: async () => ({ project: project(), changed: true }),
		mintToken: async () => { throw new Error('not used'); },
		create: async () => { throw new Error('not used'); },
		requestExport: async () => { throw new Error('not used'); },
		exportStatus: async () => { throw new Error('not used'); },
		remove: async () => { throw new Error('not used'); },
		request: async () => { throw new Error('not used'); },
		...over,
	};
}

function saved(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
	return { id: 'conn-1', label: "my database", driver: 'postgres', host: 'h', port: 5432, username: 'u', ...over };
}

test('a signed-out user is told to sign in, not shown an empty list', async () => {
	// "You have no databases" and "you are not signed in" are different answers, and only
	// one of them is the user's to fix. An empty list would say the discouraging one.
	const scan = await scanSnoutdataCloud(api({ account: async () => null }), []);
	assert.equal(scan.items.length, 0);
	assert.match(scan.unavailable ?? '', /Sign in/);
	// And NOT notFound: there is no file to browse for, so the Browse button must not appear.
	assert.equal(scan.notFound, undefined);
});

test('an account with no projects is told where to make one', async () => {
	const scan = await scanSnoutdataCloud(api({ list: async () => [] }), []);
	assert.equal(scan.items.length, 0);
	assert.match(scan.unavailable ?? '', /no hosted databases yet/);
	assert.deepEqual(scan.sources, ['alex@example.com']);
});

test('a control plane that cannot be reached says so, and says why', async () => {
	const scan = await scanSnoutdataCloud(
		api({ list: async () => { throw new Error("network is unreachable"); } }),
		[],
	);
	assert.match(scan.unavailable ?? '', /Could not reach SnoutData Cloud: network is unreachable/);
});

test('a project becomes an ordinary Postgres connection, verified against the system trust store', async () => {
	const values = projectToValues(project());
	assert.equal(values.driver, 'postgres');
	assert.equal(values.host, `${REF}.db.snoutdata.com`);
	assert.equal(values.port, 5432);
	assert.equal(values.database, REF);
	assert.equal(values.username, `${REF}_owner`);
	assert.equal(values.ssl, true);
	// NOT the bundled Amazon RDS CA: the front door's certificate is Let's Encrypt, and
	// verifying it against the RDS bundle would reject a perfectly good chain.
	assert.equal(values.sslMode, 'system');
	assert.equal(values.cloudProjectRef, REF);
});

test('a project marked production carries that through, so the desktop guard applies', async () => {
	assert.equal(projectToValues(project({ production: true })).environment, 'prod');
	assert.equal(projectToValues(project()).environment, undefined);
});

test('a project over its storage quota comes in read-only, because the database already is', async () => {
	assert.equal(projectToValues(project({ readOnly: true })).readOnly, true);
	const scan = await scanSnoutdataCloud(api({ list: async () => [project({ readOnly: true })] }), []);
	assert.match(scan.items[0].note ?? '', /refusing writes/);
});

test('a paused project says the first connection will be slow, rather than looking broken', async () => {
	const scan = await scanSnoutdataCloud(
		api({ list: async () => [project({ state: 'paused', wakesInstantly: false })] }),
		[],
	);
	assert.match(scan.items[0].note ?? '', /wakes it and takes a few seconds/);
});

test('a deleted project is not offered', async () => {
	// It is still listed for a while so its owner can see what happened to it. That is
	// not a thing to make a connection to.
	const scan = await scanSnoutdataCloud(api({ list: async () => [project({ state: 'deleted' })] }), []);
	assert.equal(scan.items.length, 0);
});

test('a project already imported is marked as an update, and keeps the name the user gave it', async () => {
	const existing = [saved({ cloudProjectRef: REF, label: "prod (careful)" })];
	const scan = await scanSnoutdataCloud(api(), existing);
	assert.equal(scan.items[0].duplicate, true);
	assert.equal(scan.items[0].values.id, 'conn-1', 'must write to the SAME connection, not beside it');
	assert.equal(scan.items[0].values.label, "prod (careful)");
	assert.match(scan.items[0].note ?? '', /updates "prod \(careful\)"/);
});

test('a connection with the same host but no cloud tag is NOT treated as the same project', async () => {
	// Identity is the ref, never the address. Two people can point a hand-made connection
	// at a hosted database, and adopting it silently on import would rewrite settings the
	// user chose.
	const scan = await scanSnoutdataCloud(api(), [saved({ host: `${REF}.db.snoutdata.com` })]);
	assert.equal(scan.items[0].duplicate, false);
	assert.equal(scan.items[0].values.id, undefined);
});

test('the scan never asks for a password, so opening the picker reads nobody credentials', async () => {
	let asked = 0;
	const scan = await scanSnoutdataCloud(api({ connection: async () => { asked++; return details(); } }), []);
	assert.equal(asked, 0);
	assert.equal(scan.items[0].values.password, undefined);
	// It still promises one, because the account owns these databases and the control
	// plane hands the credential to any signed-in client that asks.
	assert.equal(scan.items[0].importsPassword, true);
});

test('applying fetches the password and saves the same values the preview showed', async () => {
	const values = await resolveSnoutdataCloudImport(api(), [{ file: 'snoutdata-cloud', connId: REF }], []);
	assert.equal(values.length, 1);
	assert.equal(values[0].password, 'the-real-password');
	// The preview's own mapping, with the password added — not a second mapping that
	// could promise one thing and save another.
	const preview = projectToValues(project());
	for (const key of ['label', 'driver', 'host', 'port', 'database', 'username', 'sslMode', 'cloudProjectRef'] as const) {
		assert.equal(values[0][key], preview[key], `apply and preview disagree about ${key}`);
	}
});

test('applying to an already-imported project writes to it, keeping its id and its name', async () => {
	const existing = [saved({ cloudProjectRef: REF, label: "prod (careful)" })];
	const values = await resolveSnoutdataCloudImport(api(), [{ file: 'snoutdata-cloud', connId: REF }], existing);
	assert.equal(values[0].id, 'conn-1');
	assert.equal(values[0].label, "prod (careful)");
	assert.equal(values[0].password, 'the-real-password');
});

test('a list that fails at apply time costs a label, never the import', async () => {
	// The credential call is the one that must work. The list is only there for the name
	// and the quota flag, so losing it degrades rather than fails.
	const values = await resolveSnoutdataCloudImport(
		api({ list: async () => { throw new Error("offline"); } }),
		[{ file: 'snoutdata-cloud', connId: REF }],
		[],
	);
	assert.equal(values[0].password, 'the-real-password');
	assert.equal(values[0].label, REF);
	assert.equal(values[0].cloudProjectRef, REF);
});

test('the address comes from the connection call, which is the authority on where a project answers', async () => {
	const values = await resolveSnoutdataCloudImport(
		api({ connection: async () => details({ host: 'moved.db.snoutdata.com', port: 5433 }) }),
		[{ file: 'snoutdata-cloud', connId: REF }],
		[],
	);
	assert.equal(values[0].host, 'moved.db.snoutdata.com');
	assert.equal(values[0].port, 5433);
});

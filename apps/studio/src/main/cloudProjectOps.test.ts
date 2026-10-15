/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_TIMEOUT_MS, CloudRequestError, cloudTimeoutFor, type CloudApi, type CloudConnectionDetails, type CloudProjectSummary } from './cloudApi';
import { containerListing, copyText, deployBody, runCloudProjectOp, type CloudProjectHost } from './cloudProjectOps';
import { BUILT_IMAGE, redeployArgs, type CloudContainer } from '../shared/cloudContainers';

// The Cloud project tab's operations. The rules are the control plane's; what is proved here is
// that each asks the right function the right thing, that a secret only ever reaches the
// clipboard, and that a refusal stays a refusal.

// The control plane answers under the keys' earlier names until it is migrated (copyText reads both).
const DETAILS: CloudConnectionDetails & { anonKey: string | null; serviceRoleKey: string | null } = {
	ref: 'r1', host: 'r1.db.snoutdata.com', port: 5432, database: 'r1', user: 'r1_owner', password: 'p@ss', state: 'ready',
	anonKey: 'app.jwt', serviceRoleKey: null,
};

function project(): CloudProjectSummary {
	return {
		ref: 'r1', name: 'one', region: 'us-west-2', production: false, state: 'ready', desiredState: 'running',
		host: 'r1.db.snoutdata.com', database: 'r1', user: 'r1_owner', wakesInstantly: true, readOnly: false,
	};
}

function setup(request: CloudApi['request']): { api: CloudApi; host: CloudProjectHost; copied: string[]; passwords: string[]; synced: number[] } {
	const unused = async (): Promise<never> => { throw new Error('not used'); };
	const copied: string[] = [];
	const passwords: string[] = [];
	const synced: number[] = [];
	const api: CloudApi = {
		account: async () => 'alex@example.com', list: async () => [project()],
		connection: async () => DETAILS, pause: unused, resume: unused, mintToken: unused, create: unused,
		requestExport: unused, exportStatus: async () => ({ pending: false, url: null, error: null }), remove: unused,
		request,
	};
	const host: CloudProjectHost = {
		copy: (text) => { copied.push(text); },
		updatePassword: async (_ref, password) => { passwords.push(password); return 2; },
		sync: async () => { synced.push(1); },
	};
	return { api, host, copied, passwords, synced };
}

test('copy puts the secret on the clipboard and answers only what was copied', async () => {
	const { api, host, copied } = setup(async () => { throw new Error('not used'); });
	const outcome = await runCloudProjectOp(api, host, 'copy', { ref: 'r1', what: 'password' });
	assert.deepEqual(outcome, { ok: true, data: { copied: 'password' } });
	assert.deepEqual(copied, ['p@ss']);
	assert.equal(JSON.stringify(outcome).includes('p@ss'), false);
});

test('a missing API key is a refusal, not an empty clipboard', async () => {
	const { api, host, copied } = setup(async () => { throw new Error('not used'); });
	const outcome = await runCloudProjectOp(api, host, 'copy', { ref: 'r1', what: 'serverKey' });
	assert.equal(outcome.ok, false);
	assert.equal(copied.length, 0);
});

test('a key is read under its new name first and its earlier name second', () => {
	assert.equal(copyText(DETAILS, 'appKey'), 'app.jwt');
	assert.equal(copyText({ ...DETAILS, appKey: 'new.jwt' }, 'appKey'), 'new.jwt');
	assert.equal(copyText({ ...DETAILS, serviceRoleKey: 'old.server' }, 'serverKey'), 'old.server');
	assert.equal(copyText({ ...DETAILS, serverKey: 'new.server', serviceRoleKey: 'old.server' }, 'serverKey'), 'new.server');
});

test('the connection string encodes the password and requires TLS', () => {
	assert.equal(copyText(DETAILS, 'uri'), 'postgres://r1_owner:p%40ss@r1.db.snoutdata.com:5432/r1?sslmode=require');
});

test('a password reset updates the local connections and never returns the password', async () => {
	const { api, host, passwords } = setup(async (fn) => {
		assert.equal(fn, 'cloud-project-reset-password');
		return { password: 'new-one', appliesIn: 'within a minute' } as never;
	});
	const outcome = await runCloudProjectOp(api, host, 'resetPassword', { ref: 'r1' });
	assert.deepEqual(outcome, { ok: true, data: { appliesIn: 'within a minute', updatedConnections: 2 } });
	assert.deepEqual(passwords, ['new-one']);
});

test('services reads all three, and one refusing does not hide the others', async () => {
	const { api, host } = setup(async (fn) => {
		if (fn === 'cloud-project-auth') {
			throw new CloudRequestError('not yours', 403);
		}
		if (fn === 'cloud-project-storage') {
			return { storage: { enabled: true, pending: false, bytes: 10, files: 1, lastError: null, limit: { maxFilesBytes: 100 } } } as never;
		}
		return { dataApi: { enabled: false, allowed: false } } as never;
	});
	const outcome = await runCloudProjectOp(api, host, 'services', { ref: 'r1' });
	assert.ok(outcome.ok);
	assert.equal(outcome.data.auth, null);
	assert.equal(outcome.data.errors.auth, 'not yours');
	assert.equal(outcome.data.storage?.enabled, true);
	assert.deepEqual(outcome.data.dataApi, { enabled: false, allowed: false });
});

test('turning a service on asks the right function', async () => {
	const asked: unknown[] = [];
	const { api, host } = setup(async (fn, body) => { asked.push([fn, body]); return {} as never; });
	await runCloudProjectOp(api, host, 'setService', { ref: 'r1', service: 'dataApi', enable: true });
	await runCloudProjectOp(api, host, 'setService', { ref: 'r1', service: 'auth', enable: false });
	assert.deepEqual(asked, [['cloud-project-data-api', { ref: 'r1', enable: true }], ['cloud-project-auth', { ref: 'r1', action: 'disable' }]]);
});

test('push is read beside the others and switched through its own function, saying the database restarts', async () => {
	const asked: unknown[] = [];
	const { api, host } = setup(async (fn, body) => {
		asked.push([fn, body]);
		return (fn === 'cloud-project-push' ? { push: { enabled: true, scheduling: false } } : {}) as never;
	});
	const read = await runCloudProjectOp(api, host, 'services', { ref: 'r1' });
	assert.ok(read.ok);
	assert.deepEqual(read.data.push, { enabled: true, scheduling: false });
	const on = await runCloudProjectOp(api, host, 'setService', { ref: 'r1', service: 'push', enable: true });
	assert.ok(on.ok);
	assert.match(on.data.note ?? '', /restarts once/);
	assert.deepEqual(asked.at(-1), ['cloud-project-push', { ref: 'r1', enable: true }]);
});

test('a control plane without push says it is not available yet, and the others still read', async () => {
	const { api, host } = setup(async (fn) => {
		if (fn === 'cloud-project-push') {
			throw new CloudRequestError('Requested function was not found', 404);
		}
		return (fn === 'cloud-project-data-api' ? { dataApi: { enabled: true, allowed: true } } : {}) as never;
	});
	const outcome = await runCloudProjectOp(api, host, 'services', { ref: 'r1' });
	assert.ok(outcome.ok);
	assert.equal(outcome.data.push, null);
	assert.equal(outcome.data.errors.push, 'Push is not available on SnoutData Cloud yet.');
	assert.deepEqual(outcome.data.dataApi, { enabled: true, allowed: true });
});

test('a restore brings the new project in through the sync', async () => {
	const { api, host, synced } = setup(async (_fn, _body, method) => {
		assert.equal(method, undefined);
		return { project: { ref: 'r2', name: 'one (restored)' } } as never;
	});
	const outcome = await runCloudProjectOp(api, host, 'restore', { ref: 'r1', at: '2026-09-20T10:00:00Z' });
	assert.deepEqual(outcome, { ok: true, data: { ref: 'r2', name: 'one (restored)' } });
	assert.equal(synced.length, 1);
});

test('the restore window is read with GET, never the verb that performs one', async () => {
	const methods: (string | undefined)[] = [];
	const { api, host } = setup(async (_fn, _body, method) => { methods.push(method); return { restore: { available: false, pitrEnabled: false, tier: 'free', earliest: null, latest: null, retentionDays: null } } as never; });
	const outcome = await runCloudProjectOp(api, host, 'backups', { ref: 'r1' });
	assert.ok(outcome.ok);
	assert.deepEqual(methods, ['GET']);
});

test('a refusal from the control plane stays a refusal', async () => {
	const { api, host } = setup(async () => { throw new CloudRequestError('Custom domains are on paid plans', 402); });
	const outcome = await runCloudProjectOp(api, host, 'domain', { ref: 'r1', action: 'add', hostname: 'api.example.com' });
	assert.deepEqual(outcome, { ok: false, refused: true, message: 'Custom domains are on paid plans' });
});

test('a function is sized through the functions endpoint, and the plan comes back with it', async () => {
	const asked: unknown[] = [];
	const { api, host } = setup(async (fn, body) => {
		asked.push([fn, body]);
		if (fn === 'cloud-project-secrets') {
			return { secrets: [] } as never;
		}
		return {
			functions: [{ name: 'hello', verifyJwt: true, bytes: 10, updatedAt: null, memoryMb: 256, concurrency: 4 }],
			limit: { tier: 'plus', functionMemoryMb: 256, concurrencyMax: 4, podMemoryMb: 1024 },
		} as never;
	});
	const sized = await runCloudProjectOp(api, host, 'sizeFunction', { ref: 'r1', name: 'hello', memoryMb: 256, concurrency: 4 });
	assert.ok(sized.ok);
	assert.deepEqual(sized.data.plan, { tier: 'plus', functionMemoryMb: 256, concurrencyMax: 4, podMemoryMb: 1024 });
	assert.deepEqual(asked[0], ['cloud-project-functions', { ref: 'r1', action: 'size', name: 'hello', memoryMb: 256, concurrency: 4 }]);
	await runCloudProjectOp(api, host, 'sizeFunction', { ref: 'r1', name: 'hello', reset: true });
	assert.deepEqual(asked[2], ['cloud-project-functions', { ref: 'r1', action: 'size', name: 'hello', reset: true }]);
});

test('a control plane that sizes nothing reads as no plan, not as a broken one', async () => {
	const { api, host } = setup(async (fn) => (fn === 'cloud-project-secrets' ? { secrets: [] } : { functions: [], limit: { deployed: 0, maxFunctions: 5 } }) as never);
	const listed = await runCloudProjectOp(api, host, 'functions', { ref: 'r1' });
	assert.ok(listed.ok);
	assert.equal(listed.data.plan, null);
});

// Snout Containers: the same endpoint the dashboard and the CLI call, one action each.

const CONTAINER = {
	name: 'web', image: 'ghcr.io/acme/web:1', built: false, digest: 'sha256:' + 'a'.repeat(64), port: 8080,
	url: 'https://r1.api.snoutdata.com/containers/v1/web/', privateRegistry: true, status: 'running',
	statusDetail: null, restarts: 0, statusAt: null, allowed: true, updatedAt: null,
};

test('containers are listed, and a sparse answer reads as defaults rather than a crash', async () => {
	const asked: unknown[] = [];
	const { api, host } = setup(async (fn, body) => { asked.push([fn, body]); return { allowance: { deployed: 1, maxContainers: 2, memoryMb: 256 }, containers: [{ ...CONTAINER, restarts: undefined }] } as never; });
	const outcome = await runCloudProjectOp(api, host, 'containers', { ref: 'r1' });
	assert.ok(outcome.ok);
	assert.deepEqual(asked, [['cloud-project-containers', { ref: 'r1' }]]);
	assert.equal(outcome.data.containers[0].restarts, 0);
	assert.deepEqual(outcome.data.allowance, { deployed: 1, maxContainers: 2, memoryMb: 256, cpuPercent: 0, egress: null });
	assert.deepEqual(containerListing({}), { allowance: null, containers: [] });
});

test('a deploy sends the image, and the registry login only with a user name', async () => {
	const asked: Record<string, unknown>[] = [];
	const { api, host } = setup(async (_fn, body) => { asked.push(body); return { containers: [] } as never; });
	await runCloudProjectOp(api, host, 'deployContainer', { ref: 'r1', name: ' web ', image: ' ghcr.io/acme/web:1 ', port: 3000, registryUser: 'me', registryPassword: 'tok' });
	await runCloudProjectOp(api, host, 'deployContainer', { ref: 'r1', name: 'web', image: 'nginx', registryUser: '  ', registryPassword: 'ignored' });
	assert.deepEqual(asked, [
		{ ref: 'r1', action: 'deploy', name: 'web', image: 'ghcr.io/acme/web:1', port: 3000, registryUser: 'me', registryPassword: 'tok' },
		{ ref: 'r1', action: 'deploy', name: 'web', image: 'nginx' },
	]);
});

test('a built container is redeployed by its digest, a registry one by its image', async () => {
	const asked: Record<string, unknown>[] = [];
	const { api, host } = setup(async (_fn, body) => { asked.push(body); return { containers: [] } as never; });
	const built = { ...CONTAINER, built: true, image: BUILT_IMAGE } as CloudContainer;
	await runCloudProjectOp(api, host, 'deployContainer', { ref: 'r1', ...redeployArgs(built) });
	await runCloudProjectOp(api, host, 'deployContainer', { ref: 'r1', ...redeployArgs(CONTAINER as CloudContainer) });
	assert.deepEqual(asked, [
		{ ref: 'r1', action: 'deploy', name: 'web', pushed: CONTAINER.digest, port: 8080 },
		{ ref: 'r1', action: 'deploy', name: 'web', image: 'ghcr.io/acme/web:1', port: 8080 },
	]);
});

test('a deploy naming both an image and a build is refused before it is sent', async () => {
	const { api, host } = setup(async () => { throw new Error('not sent'); });
	const outcome = await runCloudProjectOp(api, host, 'deployContainer', { ref: 'r1', name: 'web', image: 'nginx', pushed: CONTAINER.digest });
	assert.deepEqual(outcome, { ok: false, refused: true, message: 'A deploy is an image or a build, not both.' });
	assert.equal(deployBody({ ref: 'r1', name: 'web', pushed: CONTAINER.digest, registryUser: 'me' }).registryUser, undefined);
});

test('restart, remove and logs each ask their own action, and the endpoint refusal stays one', async () => {
	const asked: Record<string, unknown>[] = [];
	const { api, host } = setup(async (_fn, body) => {
		asked.push(body);
		if (body.action === 'logs') {
			return { lines: [{ name: 'web', stream: 'stderr', message: 'boom', at: '2026-10-14T10:00:00Z' }] } as never;
		}
		if (body.action === 'delete') {
			throw new CloudRequestError('this project has no container called web', 404);
		}
		return { containers: [CONTAINER] } as never;
	});
	assert.ok((await runCloudProjectOp(api, host, 'restartContainer', { ref: 'r1', name: 'web' })).ok);
	const logs = await runCloudProjectOp(api, host, 'containerLogs', { ref: 'r1', name: 'web', errorsOnly: true });
	assert.ok(logs.ok);
	assert.equal(logs.data[0].message, 'boom');
	const removed = await runCloudProjectOp(api, host, 'removeContainer', { ref: 'r1', name: 'web' });
	assert.deepEqual(removed, { ok: false, refused: true, message: 'this project has no container called web' });
	assert.deepEqual(asked, [
		{ ref: 'r1', action: 'restart', name: 'web' },
		{ ref: 'r1', action: 'logs', name: 'web', errorsOnly: true, limit: 200 },
		{ ref: 'r1', action: 'delete', name: 'web' },
	]);
});

test('a call the server deliberately holds open gets more than the server waits, under the front door ceiling', () => {
	// The server's own bounds: functionsLive.ts (15.5 s), rotate-jwt (31.5 s), cloud-project-sql
	// (55 s budget, a 40 s cold connect). With 15 s here each turned a done thing into "did not answer".
	assert.ok(cloudTimeoutFor('cloud-project-secrets') > 15_500 + 5_000);
	assert.ok(cloudTimeoutFor('cloud-project-functions') > 15_500 + 5_000);
	assert.ok(cloudTimeoutFor('cloud-project-rotate-jwt') > 31_500 + 5_000);
	assert.ok(cloudTimeoutFor('cloud-project-sql') > 55_000);
	for (const fn of ['cloud-project-secrets', 'cloud-project-functions', 'cloud-project-rotate-jwt', 'cloud-project-sql', 'cloud-project-shards']) {
		assert.ok(cloudTimeoutFor(fn) < 60_000, `${fn} under the front door ceiling`);
	}
	assert.equal(cloudTimeoutFor('cloud-project-usage'), CLOUD_TIMEOUT_MS);
	assert.equal(cloudTimeoutFor('cloud-project-export?ref=abc'), CLOUD_TIMEOUT_MS);
});

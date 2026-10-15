/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudApi } from './cloudApi';
import { CloudRequestError } from './cloudApi';
import { buildAndDeploy, buildArgs, buildFailure, dockerUnavailable, uploadFailure, type ContainerBuildHost, type DockerResult } from './containerBuild';
import { containerNameProblem, parsePort, withoutCloudInternals } from '../shared/cloudContainers';

// "Deploy from a folder": the steps in their order against a fake Docker, a fake upload and a fake
// control plane, the sentence for each way it fails, and nothing of the cloud's infrastructure in
// anything the user is shown.

const DIGEST = 'sha256:' + 'b'.repeat(64);
const TICKET_URL = `https://r1abcdefghijk.api.snoutdata.com/containers/v1/_upload/${'t'.repeat(43)}`;
/** What a leaked infrastructure name would look like; none of it may reach the user. */
const LEAKY = /amazonaws|dkr\.ecr|\b\d{12}\b|arn:aws|registry login|docker login/i;

interface FakeOptions {
	docker?: (args: string[]) => DockerResult;
	dockerfile?: boolean;
	buildLine?: string;
	size?: number;
	upload?: { status: number; body: string };
	ticketExpiresInMs?: number;
	deployError?: Error;
}

function fake(options: FakeOptions = {}) {
	const calls: { args: string[]; input?: string }[] = [];
	const asked: Record<string, unknown>[] = [];
	const uploads: { url: string; file: string }[] = [];
	const removed: string[] = [];
	const clock = 1_000_000;
	const host: ContainerBuildHost = {
		async docker(args, opts) {
			calls.push({ args, input: opts?.input });
			const result = options.docker?.(args) ?? { code: 0, stdout: '', stderr: '' };
			if (args[0] === 'buildx' && args[1] === 'build') {
				opts?.onLine?.(options.buildLine ?? '#1 [internal] load build definition from Dockerfile');
			}
			return result;
		},
		hasDockerfile: () => options.dockerfile !== false,
		async scratch() {
			return { dir: '/tmp/s', file: (name: string) => `/tmp/s/${name}` };
		},
		async fileSize() {
			return options.size ?? 64 * 1024 * 1024;
		},
		async upload(url, file, sent) {
			uploads.push({ url, file });
			const size = options.size ?? 64 * 1024 * 1024;
			for (const part of [0.3, 0.6, 1]) {
				sent?.(Math.round(size * part));
			}
			return options.upload ?? { status: 200, body: JSON.stringify({ name: 'web', digest: DIGEST }) };
		},
		async removeDir(dir) {
			removed.push(dir);
		},
		now: () => clock,
	};
	const unused = async (): Promise<never> => { throw new Error('not used'); };
	const api: CloudApi = {
		account: unused, list: unused, connection: unused, pause: unused, resume: unused, mintToken: unused, create: unused,
		requestExport: unused, exportStatus: unused, remove: unused,
		async request<T>(_fn: string, body: Record<string, unknown>): Promise<T> {
			asked.push(body);
			if (body.action === 'upload-ticket') {
				return { ref: 'r1', url: TICKET_URL, expiresAt: new Date(clock + (options.ticketExpiresInMs ?? 15 * 60_000)).toISOString() } as T;
			}
			if (options.deployError) {
				throw options.deployError;
			}
			return { containers: [{ name: 'web', image: 'built from a Dockerfile', built: true, digest: DIGEST, port: 3000, status: 'pending' }] } as T;
		},
	};
	return { host, api, calls, asked, uploads, removed };
}

test('a folder is built for arm64 into an archive, uploaded to the project link, and deployed by its digest', async () => {
	const { host, api, calls, asked, uploads, removed } = fake();
	const said: string[] = [];
	const outcome = await buildAndDeploy(api, host, 'r1', { name: 'web', folder: '/src/web', port: 3000 }, (line) => said.push(line));
	assert.ok(outcome.ok);
	assert.equal(outcome.data.containers[0].built, true);
	assert.deepEqual(calls.map((c) => c.args.slice(0, 2).join(' ')), ['version --format', 'buildx version', 'buildx build']);
	assert.ok(calls[2].args.includes('type=oci,dest=/tmp/s/image.tar'));
	assert.ok(!calls[2].args.includes('--push'));
	assert.deepEqual(asked[0], { ref: 'r1', action: 'upload-ticket', name: 'web' });
	assert.deepEqual(uploads, [{ url: TICKET_URL, file: '/tmp/s/image.tar' }]);
	assert.deepEqual(asked.at(-1), { ref: 'r1', action: 'deploy', name: 'web', pushed: DIGEST, port: 3000 });
	assert.deepEqual(removed, ['/tmp/s']);
	assert.ok(said.includes('#1 [internal] load build definition from Dockerfile'));
	assert.ok(said.some((line) => /^Uploaded \d+ MB of 64 MB$/.test(line)));
});

test('nothing the user is shown names the cloud provider, an account, a registry or a login, even when the cloud slips', async () => {
	// The happy path: every progress line and every docker argument.
	const happy = fake();
	const said: string[] = [];
	await buildAndDeploy(happy.api, happy.host, 'r1', { name: 'web', folder: '/src/web' }, (line) => said.push(line));
	for (const line of [...said, ...happy.calls.flatMap((c) => c.args)]) {
		assert.doesNotMatch(line, LEAKY, line);
	}
	// A refusal from the upload, and an error from the deploy, that DID carry a name of ours.
	const leakyRefusal = fake({
		upload: { status: 502, body: JSON.stringify({ error: 'could not push to 123456789012.dkr.ecr.us-east-1.amazonaws.com/repo/r1abcdefghijk: denied' }) },
	});
	const one = await buildAndDeploy(leakyRefusal.api, leakyRefusal.host, 'r1', { name: 'web', folder: '/src' }, () => undefined);
	assert.ok(!one.ok);
	assert.doesNotMatch(one.message, LEAKY, one.message);
	const leakyDeploy = fake({ deployError: new CloudRequestError('the image at 123456789012.dkr.ecr.us-east-1.amazonaws.com/repo/x is missing', 409) });
	const two = await buildAndDeploy(leakyDeploy.api, leakyDeploy.host, 'r1', { name: 'web', folder: '/src' }, () => undefined);
	assert.ok(!two.ok);
	assert.doesNotMatch(two.message, LEAKY, two.message);
});

test('docker missing, docker stopped and no buildx each say so before anything is asked of the cloud', async () => {
	const missing = fake({ docker: () => ({ code: -1, stdout: '', stderr: 'The docker command was not found on this computer.' }) });
	const one = await buildAndDeploy(missing.api, missing.host, 'r1', { name: 'web', folder: '/src' }, () => undefined);
	assert.ok(!one.ok && /none was found/.test(one.message));
	assert.equal(missing.asked.length, 0);

	const stopped = fake({ docker: (args) => (args[0] === 'version' ? { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' } : { code: 0, stdout: '', stderr: '' }) });
	const two = await buildAndDeploy(stopped.api, stopped.host, 'r1', { name: 'web', folder: '/src' }, () => undefined);
	assert.ok(!two.ok && /not running/.test(two.message));

	const noBuildx = fake({ docker: (args) => (args[0] === 'buildx' ? { code: 1, stdout: '', stderr: "'buildx' is not a docker command" } : { code: 0, stdout: '', stderr: '' }) });
	const three = await buildAndDeploy(noBuildx.api, noBuildx.host, 'r1', { name: 'web', folder: '/src' }, () => undefined);
	assert.ok(!three.ok && /buildx/.test(three.message));
	assert.equal(noBuildx.asked.length, 0);
});

test('a bad name or a folder with no Dockerfile is refused before docker runs', async () => {
	const named = fake();
	const one = await buildAndDeploy(named.api, named.host, 'r1', { name: 'Web App', folder: '/src' }, () => undefined);
	assert.ok(!one.ok && one.refused);
	assert.equal(named.calls.length, 0);
	const empty = fake({ dockerfile: false });
	const two = await buildAndDeploy(empty.api, empty.host, 'r1', { name: 'web', folder: '/src' }, () => undefined);
	assert.ok(!two.ok && /no Dockerfile/.test(two.message));
});

test('a failed build cleans up, uploads and deploys nothing, and says why', async () => {
	const { host, api, asked, uploads, removed } = fake({
		docker: (args) => (args[1] === 'build' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
		buildLine: 'ERROR: failed to solve: python:3.12: no match for platform in manifest',
	});
	const outcome = await buildAndDeploy(api, host, 'r1', { name: 'web', folder: '/src' }, () => undefined);
	assert.ok(!outcome.ok);
	assert.match(outcome.message, /no linux\/arm64 version/);
	assert.deepEqual(removed, ['/tmp/s']);
	assert.equal(uploads.length, 0);
	assert.equal(asked.some((b) => b.action === 'deploy'), false);
});

test('an image over the upload cap is refused before it is sent, and a refused upload deploys nothing', async () => {
	const big = fake({ size: 3 * 1024 ** 3 });
	const one = await buildAndDeploy(big.api, big.host, 'r1', { name: 'web', folder: '/src' }, () => undefined);
	assert.ok(!one.ok && one.refused && /at most 1 GB compressed/.test(one.message));
	assert.equal(big.uploads.length, 0);
	const refused = fake({ upload: { status: 401, body: JSON.stringify({ error: 'This upload link is not valid: it was used already.' }) } });
	const two = await buildAndDeploy(refused.api, refused.host, 'r1', { name: 'web', folder: '/src' }, () => undefined);
	assert.ok(!two.ok && two.refused && /not valid/.test(two.message));
	assert.equal(refused.asked.some((b) => b.action === 'deploy'), false);
});

test('a link about to run out after a long build is asked for again', async () => {
	const { host, api, asked } = fake({ ticketExpiresInMs: 60_000 });
	const outcome = await buildAndDeploy(api, host, 'r1', { name: 'web', folder: '/src' }, () => undefined);
	assert.ok(outcome.ok);
	assert.equal(asked.filter((b) => b.action === 'upload-ticket').length, 2);
});

test('the pure helpers', () => {
	assert.deepEqual(buildArgs({ context: '/src', archive: '/tmp/s/image.tar' }), [
		'buildx', 'build', '--platform', 'linux/arm64', '--provenance=false', '--progress=plain', '--output', 'type=oci,dest=/tmp/s/image.tar', '/src',
	]);
	assert.match(buildFailure('exec /bin/sh: exec format error'), /cannot run/);
	assert.match(buildFailure('exec /bin/sh: exec format error'), /multi-platform guide.*root-level access/);
	assert.match(buildFailure('ERROR: failed to solve: process "/bin/sh -c make" did not complete successfully'), /^The build failed: failed to solve/);
	assert.match(buildFailure('ERROR: OCI exporter is not supported for the docker driver.'), /containerd image store/);
	assert.match(dockerUnavailable({ code: -1, stdout: '', stderr: 'spawn docker ENOENT' }), /none was found/);
	assert.match(uploadFailure(413, ''), /at most 1 GB/);
	assert.match(uploadFailure(500, 'not json'), /\(500\)/);
	assert.equal(uploadFailure(422, JSON.stringify({ error: 'The image is built for linux/amd64.' })), 'The image is built for linux/amd64.');
	assert.equal(withoutCloudInternals('pushed to 123456789012.dkr.ecr.us-east-1.amazonaws.com/repo/x:web'), "pushed to SnoutData's registry");
	assert.equal(containerNameProblem('web-1'), null);
	assert.ok(containerNameProblem('-web'));
	assert.deepEqual(parsePort(''), {});
	assert.deepEqual(parsePort('3000'), { port: 3000 });
	assert.ok(parsePort('70000').problem);
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Server, utils, type Connection } from 'ssh2';

import { checkHostKey, hostKeyFingerprint, onHostKeyLearned } from './sshHostKey';
import { openSshTunnel } from './sshTunnel';

describe('hostKeyFingerprint', () => {
	it('matches what ssh-keygen -lf prints for the same key', () => {
		// ssh-keygen -lf of: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDEhrjlSg64LK1c8CaLfL/fAtP2aHBOG+JMRL9lNMrcx
		const blob = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIDEhrjlSg64LK1c8CaLfL/fAtP2aHBOG+JMRL9lNMrcx', 'base64');
		assert.equal(hostKeyFingerprint(blob), 'SHA256:XaaudGJRZaY2ojUPusuH88DP961LM7M5PIltLEms74A');
	});
});

describe('checkHostKey', () => {
	it('trusts a key on first use and reports it as learned', () => {
		assert.deepEqual(checkHostKey(undefined, 'SHA256:a', 'bastion', 22), { ok: true, learned: true });
	});

	it('accepts the remembered key', () => {
		assert.deepEqual(checkHostKey('SHA256:a', 'SHA256:a', 'bastion', 22), { ok: true, learned: false });
	});

	it('refuses a changed key, naming both fingerprints and the host', () => {
		const decision = checkHostKey('SHA256:a', 'SHA256:b', 'bastion', 2222);
		assert.equal(decision.ok, false);
		const error = decision.ok ? '' : decision.error;
		assert.match(error, /bastion:2222/);
		assert.match(error, /expected SHA256:a, got SHA256:b/);
		assert.match(error, /Forget the saved host key/);
		assert.doesNotMatch(error, /—/);
	});
});

describe('openSshTunnel host-key checking', () => {
	const hostKey = utils.generateKeyPairSync('ed25519');
	const parsed = utils.parseKey(hostKey.public);
	const expected = hostKeyFingerprint((Array.isArray(parsed) ? parsed[0] : parsed as Exclude<typeof parsed, Error>).getPublicSSH());
	let server: Server;
	let port = 0;

	before(async () => {
		server = new Server({ hostKeys: [hostKey.private] }, (client: Connection) => {
			client.on('error', () => undefined);
			client.on('authentication', (ctx) => ctx.accept());
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		port = (server.address() as AddressInfo).port;
	});

	after(() => {
		server.close();
	});

	it('trusts the first key, reports it, and pins it on the config', async () => {
		const learned: string[] = [];
		onHostKeyLearned((host, p, fingerprint) => learned.push(`${host}:${p}=${fingerprint}`));
		const config = { host: '127.0.0.1', port, username: 'u', password: 'p', keepAlive: false };
		const tunnel = await openSshTunnel(config, '127.0.0.1', 5432);
		await tunnel.close();
		assert.deepEqual(learned, [`127.0.0.1:${port}=${expected}`]);
		assert.equal((config as { hostKeyFingerprint?: string }).hostKeyFingerprint, expected);
	});

	it('connects when the remembered key matches', async () => {
		const learned: string[] = [];
		onHostKeyLearned((host) => learned.push(host));
		const tunnel = await openSshTunnel({ host: '127.0.0.1', port, username: 'u', password: 'p', keepAlive: false, hostKeyFingerprint: expected }, '127.0.0.1', 5432);
		await tunnel.close();
		assert.deepEqual(learned, []);
	});

	it('refuses a server whose key changed, with the explanation', async () => {
		await assert.rejects(
			openSshTunnel({ host: '127.0.0.1', port, username: 'u', password: 'p', keepAlive: false, hostKeyFingerprint: 'SHA256:somethingElse' }, '127.0.0.1', 5432),
			/host key for 127\.0\.0\.1:\d+ has changed \(expected SHA256:somethingElse, got SHA256:/,
		);
	});
});

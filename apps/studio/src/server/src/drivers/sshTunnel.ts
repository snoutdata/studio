/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type ConnectConfig } from 'ssh2';

import type { SshTunnelConfig } from '../../../shared/connection';
import { checkHostKey, hostKeyFingerprint, reportHostKeyLearned } from './sshHostKey';

/** A live SSH tunnel exposing a local endpoint that forwards to the remote DB. */
export interface SshTunnel {
	/** Local host the DB client should connect to (always loopback). */
	readonly host: string;
	/** Local port bound for this tunnel. */
	readonly port: number;
	/** Tear down the local listener and the SSH connection. */
	close(): Promise<void>;
}

/** Expand a leading `~` to the user's home directory (key paths often use it). */
function expandHome(filePath: string): string {
	if (filePath === '~' || filePath.startsWith('~/') || filePath.startsWith('~\\')) {
		return path.join(os.homedir(), filePath.slice(1));
	}
	return filePath;
}

/**
 * Open an SSH tunnel and a local TCP listener that forwards every accepted
 * socket to `remoteHost:remotePort` over the SSH connection. The DB pool then
 * connects to the returned loopback endpoint as if the database were local.
 * Vendor-agnostic — used by every driver that supports tunnelling.
 *
 * A `net.Server` (rather than a single `forwardOut`) is used so a connection
 * pool can open multiple concurrent sockets through the one SSH session.
 */
export async function openSshTunnel(config: SshTunnelConfig, remoteHost: string, remotePort: number): Promise<SshTunnel> {
	const ssh = new Client();

	const connectConfig: ConnectConfig = {
		host: config.host,
		port: config.port ?? 22,
		username: config.username,
		passphrase: config.passphrase,
		password: config.password,
	};
	// Keep the SSH session alive during inactivity (on unless explicitly disabled). The DB
	// pool's TCP keepalive only covers the loopback hop to our local listener, never the SSH
	// session to the bastion, so without this the bastion's idle timeout (and any NLB in
	// front of it) silently tears the tunnel down after a few idle minutes and the next
	// query dies with "Connection is closed". 15s × 3 missed = ~45s grace before we give up.
	if (config.keepAlive !== false) {
		connectConfig.keepaliveInterval = 15_000;
		connectConfig.keepaliveCountMax = 3;
	}
	if (config.privateKeyPath) {
		connectConfig.privateKey = fs.readFileSync(expandHome(config.privateKeyPath));
	}
	// Host-key check (trust on first use): a key main remembered for this host must match, and
	// one seen for the first time is remembered. The learned key is also pinned on `config`, so
	// a reconnect from the same driver (resetPool) is held to it as well.
	const sshPort = config.port ?? 22;
	let hostKeyError: string | undefined;
	connectConfig.hostVerifier = (key: Buffer): boolean => {
		const seen = hostKeyFingerprint(key);
		const decision = checkHostKey(config.hostKeyFingerprint, seen, config.host, sshPort);
		if (!decision.ok) {
			hostKeyError = decision.error;
			return false;
		}
		if (decision.learned) {
			config.hostKeyFingerprint = seen;
			reportHostKeyLearned(config.host, sshPort, seen);
		}
		return true;
	};

	await new Promise<void>((resolve, reject) => {
		ssh.once('ready', resolve).once('error', (err) => reject(hostKeyError ? new Error(hostKeyError) : err)).connect(connectConfig);
	});

	// Past this point nothing has a caller left to reject, and an 'error' with no listener is
	// thrown as an uncaughtException — which killed the whole server child (every OTHER
	// connection with it) whenever a bastion hung up on an idle session. These handlers are
	// deliberately silent: the pool's own socket goes down with the tunnel, so the driver
	// already sees a dead connection and recovers by rebuilding both (see resetPool).
	ssh.on('error', () => undefined);

	const server = net.createServer((socket) => {
		socket.on('error', () => socket.destroy());
		ssh.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, remoteHost, remotePort, (err, stream) => {
			if (err) {
				// destroy(err) makes the socket emit 'error' — harmless now that it has a
				// listener, an uncaught throw before.
				socket.destroy(err);
				return;
			}
			// pipe() forwards data, never errors: without this, a tunnel that dropped mid-stream
			// took the process out. Tearing down the other half turns it into a closed socket,
			// which is what the driver knows how to handle.
			stream.on('error', () => socket.destroy());
			socket.pipe(stream).pipe(socket);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject).listen(config.localPort ?? 0, '127.0.0.1', () => resolve());
	});
	server.on('error', () => undefined);

	const { port } = server.address() as net.AddressInfo;
	return {
		host: '127.0.0.1',
		port,
		close: () => new Promise<void>((resolve) => {
			server.close(() => {
				ssh.end();
				resolve();
			});
		}),
	};
}

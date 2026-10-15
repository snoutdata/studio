/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { toSessionProxyConfig, type ProxyConfig, type SessionProxyConfig } from '../shared/proxy';
import type { SecretStore } from './secretStore';

// Non-secret network-proxy config lives in userData/proxy.json; the proxy password (for an
// authenticating proxy) is encrypted in the keychain via SecretStore, reusing its (id, kind)
// scheme under a reserved pseudo-connection id (same trick as the AI gateway key).
const PROXY_SECRET_ID = '__proxy__';

function proxyFilePath(): string {
	return join(app.getPath('userData'), 'proxy.json');
}

/** proxy.json as saved, without the keychain. Safe to call before the app is ready (it touches no
 *  keychain), which is when the integrated-auth switches have to be set. */
export function readProxyFile(): Omit<ProxyConfig, 'hasPassword'> {
	let data: Partial<ProxyConfig> = {};
	const path = proxyFilePath();
	if (existsSync(path)) {
		try {
			const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
			if (raw && typeof raw === 'object') {
				data = raw as Partial<ProxyConfig>;
			}
		} catch {
			// Corrupt file — fall back to defaults.
		}
	}
	const text = (value: unknown): string => (typeof value === 'string' ? value : '');
	return {
		mode: data.mode === 'direct' || data.mode === 'manual' ? data.mode : 'system',
		pacUrl: text(data.pacUrl),
		server: text(data.server),
		bypass: text(data.bypass),
		username: text(data.username),
		authServers: text(data.authServers),
		delegateServers: text(data.delegateServers),
	};
}

export class ProxyStore {
	private cache: ProxyConfig | null = null;

	constructor(private readonly secrets: SecretStore) {}

	private read(): ProxyConfig {
		if (this.cache) {
			return this.cache;
		}
		const config: ProxyConfig = {
			...readProxyFile(),
			// Authoritative: the keychain, not whatever the file claims.
			hasPassword: this.secrets.get(PROXY_SECRET_ID, 'password') !== undefined,
		};
		this.cache = config;
		return config;
	}

	/** The saved proxy config (with `hasPassword` reflecting the keychain). */
	config(): ProxyConfig {
		return { ...this.read() };
	}

	/** The electron session config for the saved proxy. */
	sessionConfig(): SessionProxyConfig {
		return toSessionProxyConfig(this.read());
	}

	/** The stored proxy password, or undefined when none is set. */
	password(): string | undefined {
		return this.secrets.get(PROXY_SECRET_ID, 'password');
	}

	/** Persist the config. `password` is applied only when defined: a non-empty value is stored,
	 *  an empty string clears it, `undefined` leaves the existing password untouched. */
	save(config: ProxyConfig, password?: string): ProxyConfig {
		if (password !== undefined) {
			const trimmed = password.trim();
			if (trimmed) {
				this.secrets.store(PROXY_SECRET_ID, 'password', trimmed);
			} else {
				this.secrets.delete(PROXY_SECRET_ID, 'password');
			}
		}
		const hasPassword = this.secrets.get(PROXY_SECRET_ID, 'password') !== undefined;
		const next: ProxyConfig = {
			mode: config.mode,
			pacUrl: config.pacUrl ?? '',
			server: config.server ?? '',
			bypass: config.bypass ?? '',
			username: config.username ?? '',
			hasPassword,
			authServers: config.authServers ?? '',
			delegateServers: config.delegateServers ?? '',
		};
		const path = proxyFilePath();
		mkdirSync(dirname(path), { recursive: true });
		// hasPassword is derived from the keychain on read, but persist it too for clarity.
		writeFileSync(path, JSON.stringify(next, null, 2), 'utf8');
		this.cache = next;
		return { ...next };
	}
}

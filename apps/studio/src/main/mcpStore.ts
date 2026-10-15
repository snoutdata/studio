/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writePrivateFile } from './privateFile';

// Non-secret config for the local MCP server: the master enable switch, the per-connection
// allowlist (connection ids exposed to agents), the bound port, and the bearer token. The token
// gates localhost access; it's stored here (userData is user-scoped, like the other *.json) rather
// than in safeStorage because the Settings panel must display it for the user to paste into their
// MCP client config — it's a local capability gate, not a high-value secret like a DB password.

export interface McpConfig {
	enabled: boolean;
	/** Connection ids exposed to agents over MCP. */
	allow: string[];
	/** Connection ids further permitted to run writes/DDL over MCP (a subset of `allow`; off by
	 *  default — the MCP path is read-only unless a connection opts in here). */
	allowWrites: string[];
	/** The port the broker listens on, and the only one: a taken port is reported, never walked past
	 *  (the person moves it, in Settings, which also replaces the token). */
	port: number;
	token: string;
	/**
	 * May a program on this computer ask to use the signed-in account? (The sign-in handoff.)
	 * On by default and inert until something asks: asking raises a prompt, and what the user
	 * approves is a NEW `sdt_` token minted through the control plane, revocable in `snoutdata
	 * tokens list` and on the cloud audit log as itself. The app's own session is never handed
	 * over. Off refuses the mint endpoint outright.
	 *
	 * It lives HERE, in the file the CLI already reads for the port and token, so a caller
	 * can tell "switched off" from "the app is not running" before it asks anybody anything.
	 */
	signInHandoff: boolean;
	/**
	 * SHA-256 (hex) of the tokens this one replaced, newest first, at most {@link RETIRED_KEPT}. A
	 * request carrying one of them is a config left behind by a rotation, which the server refuses
	 * without counting it toward the next rotation. Hashes, so the file never holds an old token.
	 */
	retired: string[];
}

/** How many replaced tokens are remembered as stale rather than unknown. */
const RETIRED_KEPT = 8;

function tokenHash(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/** Default port. If it is taken the broker does not start, and the person is asked to choose another. */
export const DEFAULT_MCP_PORT = 7311;

function mcpPath(): string {
	return join(app.getPath('userData'), 'mcp.json');
}

function newToken(): string {
	return randomBytes(32).toString('base64url');
}

export class McpStore {
	private cache: McpConfig | null = null;

	private read(): McpConfig {
		if (this.cache) {
			return this.cache;
		}
		let data: Partial<McpConfig> = {};
		const path = mcpPath();
		if (existsSync(path)) {
			try {
				const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
				if (raw && typeof raw === 'object') {
					data = raw as Partial<McpConfig>;
				}
			} catch {
				// Corrupt file — fall back to defaults (and rewrite below).
			}
		}
		const hadToken = typeof data.token === 'string' && data.token.length > 0;
		// The CLI reads this file to find the port and the token, and it reads `signInHandoff`
		// there too so it can tell "switched off" from "the app is not running" before it asks
		// anybody anything. A file written by an older build has no such key, so it is written
		// back the first time it is read rather than left to be inferred.
		const hadHandoff = typeof data.signInHandoff === 'boolean';
		const config: McpConfig = {
			// On by default (only an explicit `false` keeps it off). The server is token-gated and
			// exposes NO connection until one is opt-in allowed, so a default-on server is inert
			// until the user picks what an agent may reach.
			enabled: data.enabled !== false,
			allow: Array.isArray(data.allow) ? data.allow.filter((id): id is string => typeof id === 'string') : [],
			allowWrites: Array.isArray(data.allowWrites) ? data.allowWrites.filter((id): id is string => typeof id === 'string') : [],
			port: typeof data.port === 'number' && data.port > 0 ? data.port : DEFAULT_MCP_PORT,
			token: hadToken ? data.token! : newToken(),
			// Default-ASK, like `enabled` above and for the same reason: it does nothing at all
			// until something asks, and what it does then is put a question on screen.
			signInHandoff: data.signInHandoff !== false,
			retired: Array.isArray(data.retired) ? data.retired.filter((h): h is string => typeof h === 'string').slice(0, RETIRED_KEPT) : [],
		};
		this.cache = config;
		if (!hadToken || !hadHandoff) {
			// Persist the freshly-minted token (stable across launches) and any key an older build
			// did not write. Off the boot path: the first read happens after first paint.
			this.write(config);
		}
		return config;
	}

	private write(config: McpConfig): void {
		this.cache = config;
		writePrivateFile(mcpPath(), JSON.stringify(config, null, 2));
	}

	config(): McpConfig {
		return { ...this.read() };
	}

	isEnabled(): boolean {
		return this.read().enabled;
	}

	setEnabled(enabled: boolean): void {
		this.write({ ...this.read(), enabled });
	}

	isAllowed(id: string): boolean {
		return this.read().allow.includes(id);
	}

	allowList(): string[] {
		return [...this.read().allow];
	}

	setAllowed(id: string, allowed: boolean): void {
		const config = this.read();
		const set = new Set(config.allow);
		const writes = new Set(config.allowWrites);
		if (allowed) {
			set.add(id);
		} else {
			set.delete(id);
			writes.delete(id); // hiding a connection also revokes its write grant
		}
		this.write({ ...config, allow: [...set], allowWrites: [...writes] });
	}

	isWriteAllowed(id: string): boolean {
		return this.read().allowWrites.includes(id);
	}

	/** Permit (or revoke) writes/DDL over MCP for a connection. A write grant only takes effect
	 *  while the connection is on the allowlist; granting also ensures it's exposed. */
	setWriteAllowed(id: string, allowed: boolean): void {
		const config = this.read();
		const allow = new Set(config.allow);
		const writes = new Set(config.allowWrites);
		if (allowed) {
			allow.add(id);
			writes.add(id);
		} else {
			writes.delete(id);
		}
		this.write({ ...config, allow: [...allow], allowWrites: [...writes] });
	}

	/** Drop a connection from the allow/write lists (called when the connection is deleted). */
	forget(id: string): void {
		const config = this.read();
		if (config.allow.includes(id) || config.allowWrites.includes(id)) {
			this.write({ ...config, allow: config.allow.filter((x) => x !== id), allowWrites: config.allowWrites.filter((x) => x !== id) });
		}
	}

	port(): number {
		return this.read().port;
	}

	setPort(port: number): void {
		if (port !== this.read().port) {
			this.write({ ...this.read(), port });
		}
	}

	token(): string {
		return this.read().token;
	}

	/** May a local program ask to use the signed-in account (see {@link McpConfig.signInHandoff})? */
	signInHandoff(): boolean {
		return this.read().signInHandoff;
	}

	setSignInHandoff(allowed: boolean): void {
		this.write({ ...this.read(), signInHandoff: allowed });
	}

	/** Replace the token. The old one is remembered (hashed) as retired, see {@link McpConfig.retired}. */
	regenerateToken(): string {
		const config = this.read();
		const token = newToken();
		const retired = [tokenHash(config.token), ...config.retired.filter((h) => h !== tokenHash(config.token))].slice(0, RETIRED_KEPT);
		this.write({ ...config, token, retired });
		return token;
	}

	/** Was `bearer` once the token here (see {@link McpConfig.retired})? */
	isRetiredToken(bearer: string): boolean {
		return this.read().retired.includes(tokenHash(bearer));
	}
}

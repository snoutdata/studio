/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// User-facing network-proxy configuration. By default the app resolves the OS proxy the same way
// the system browser does (`mode: 'system'`); this lets a user on a managed/corporate network
// override that when auto-resolution doesn't reach the proxy, or supply credentials for an
// authenticating proxy. See src/main/proxyStore.ts.

export type ProxyMode = 'system' | 'direct' | 'manual';

export interface ProxyConfig {
	/** How outbound HTTP picks a proxy:
	 *  - `system`  resolve the OS proxy (PAC/WPAD/manual), like the browser. The default.
	 *  - `direct`  bypass any proxy, connect straight out.
	 *  - `manual`  use the PAC URL / fixed server below. */
	mode: ProxyMode;
	/** Manual mode: a PAC (proxy auto-config) script URL. Takes precedence over `server` when set. */
	pacUrl: string;
	/** Manual mode: a fixed proxy, e.g. `proxy.corp.com:8080` or a scheme map
	 *  `http=proxy:8080;https=proxy:8443`. Used when `pacUrl` is blank. */
	server: string;
	/** Hosts that skip the proxy (comma/semicolon separated), e.g. `localhost,127.0.0.1,*.internal`. */
	bypass: string;
	/** Username for an authenticating (basic/digest) proxy, supplied via the session `login` event.
	 *  Integrated Windows auth (Kerberos/NTLM) does NOT need this — it's negotiated automatically. */
	username: string;
	/** True when a proxy password is stored in the keychain. The password itself never crosses IPC. */
	hasPassword: boolean;
	/** Extra SERVERS (not proxies) that may sign the user in with their Windows/Kerberos identity,
	 *  comma separated, e.g. `*.corp.example`. A proxy's own challenge never needs this (Chromium
	 *  always answers a proxy with integrated auth); it is for a server that asks with a 401, such
	 *  as an authentication host some corporate gateways redirect to. Applied at the next launch. */
	authServers: string;
	/** Servers the user's Kerberos ticket may be DELEGATED to, comma separated. Empty (the default)
	 *  is no delegation anywhere. Applied at the next launch. */
	delegateServers: string;
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
	mode: 'system',
	pacUrl: '',
	server: '',
	bypass: '',
	username: '',
	hasPassword: false,
	authServers: '',
	delegateServers: '',
};

/** What the renderer receives: the saved config plus what Chromium actually resolved for a sample
 *  URL (a quick diagnostic, e.g. `PROXY proxy.corp.com:8080` vs `DIRECT`). */
export interface ProxyStatus {
	config: ProxyConfig;
	/** Chromium's proxy resolution for a representative HTTPS URL, or null if it couldn't be read. */
	resolved: string | null;
}

/** Values posted from the Settings form. The password is sent only when the user (re)enters one;
 *  `undefined` leaves the stored password untouched, empty string clears it. */
export interface ProxyFormValues {
	config: ProxyConfig;
	password?: string;
}

/** Result of pinging one host through the current proxy config — drives the Settings "Test" button. */
export interface ProxyTestTarget {
	/** Human label, e.g. "Sign-in service". */
	label: string;
	/** The host we tried to reach, e.g. `accounts.snoutdata.com`. */
	host: string;
	/** True when we got any HTTP response (reachable); false on a connectivity failure. */
	ok: boolean;
	/** Diagnostic detail on failure, e.g. `net::ERR_PROXY_CONNECTION_FAILED`. Empty when ok. */
	detail: string;
}

export interface ProxyTestResult {
	targets: ProxyTestTarget[];
}

/** The subset of Electron's `Session.setProxy` config we produce. Declared structurally here (no
 *  electron import) so the mapping below stays a pure, unit-testable function. */
export interface SessionProxyConfig {
	mode: 'system' | 'direct' | 'pac_script' | 'fixed_servers';
	pacScript?: string;
	proxyRules?: string;
	proxyBypassRules?: string;
}

/** Map our user-facing {@link ProxyConfig} onto Electron's session proxy config. Pure — no I/O.
 *  Manual mode prefers a PAC URL when set, else a fixed server; a manual mode with neither falls
 *  back to system resolution, so a half-filled form never silently severs all networking. */
export function toSessionProxyConfig(config: ProxyConfig): SessionProxyConfig {
	if (config.mode === 'direct') {
		return { mode: 'direct' };
	}
	if (config.mode === 'manual') {
		const pac = config.pacUrl.trim();
		if (pac) {
			return { mode: 'pac_script', pacScript: pac };
		}
		const server = config.server.trim();
		if (server) {
			return { mode: 'fixed_servers', proxyRules: server, proxyBypassRules: config.bypass.trim() || undefined };
		}
		return { mode: 'system' };
	}
	return { mode: 'system' };
}

/** Chromium's two integrated-auth switches, as this config asks for them. A key that is absent
 *  means the switch is not set at all, which is Chromium's own default. */
export interface IntegratedAuthSwitches {
	'auth-server-allowlist'?: string;
	'auth-negotiate-delegate-allowlist'?: string;
}

/** One allowlist entry: a host name or address, optionally with a leading `*.` wildcard. A bare
 *  `*` (every server on the internet) is refused, which is the point of having a list. */
function allowlistEntry(raw: string): string | undefined {
	let host = raw.trim().toLowerCase();
	host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // a scheme someone typed
	host = host.replace(/\/.*$/, ''); // a path
	if (host.startsWith('[')) {
		const end = host.indexOf(']');
		host = end === -1 ? '' : host.slice(0, end + 1);
	} else {
		host = host.replace(/:\d*$/, ''); // a port
	}
	if (!host || host === '*' || host === '*.' || !/^(\*\.)?[a-z0-9._\-\[\]:]+$/.test(host)) {
		return undefined;
	}
	return host;
}

function allowlist(text: string): string[] {
	return text.split(/[,;\s]+/).map(allowlistEntry).filter((host): host is string => host !== undefined);
}

/** The hosts of a manual fixed-proxy rule: `proxy:8080`, `http=a:80;https=b:443`, `socks5://c:1080`. */
export function manualProxyHosts(config: Pick<ProxyConfig, 'mode' | 'pacUrl' | 'server'>): string[] {
	if (config.mode !== 'manual' || config.pacUrl.trim() || !config.server.trim()) {
		return [];
	}
	return config.server
		.split(';')
		.map((rule) => rule.slice(rule.indexOf('=') + 1))
		.map(allowlistEntry)
		.filter((host): host is string => host !== undefined);
}

/**
 * Which servers Chromium may answer with the user's Windows/Kerberos identity, and which it may
 * delegate their ticket to.
 *
 * Chromium answers a PROXY's Negotiate or NTLM challenge with integrated auth whatever this says
 * (`AllowsDefaultCredentials` returns true for `AUTH_PROXY` in both handlers) and never delegates
 * to one, so a corporate proxy works with neither switch. They matter only for SERVERS: the app
 * once set both to `*`, which answered any server on the internet that asked with NTLM or
 * Negotiate. So the server list is the configured proxy (harmless, and what a person setting one
 * expects) plus whatever the user added, and delegation is off unless the user named a server.
 */
export function integratedAuthSwitches(config: Pick<ProxyConfig, 'mode' | 'pacUrl' | 'server' | 'authServers' | 'delegateServers'>): IntegratedAuthSwitches {
	const out: IntegratedAuthSwitches = {};
	const servers = [...new Set([...manualProxyHosts(config), ...allowlist(config.authServers)])];
	if (servers.length > 0) {
		out['auth-server-allowlist'] = servers.join(',');
	}
	const delegate = [...new Set(allowlist(config.delegateServers))];
	if (delegate.length > 0) {
		out['auth-negotiate-delegate-allowlist'] = delegate.join(',');
	}
	return out;
}

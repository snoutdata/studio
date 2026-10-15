/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DEFAULT_PROXY_CONFIG, integratedAuthSwitches, manualProxyHosts, toSessionProxyConfig, type ProxyConfig } from './proxy';

function config(over: Partial<ProxyConfig>): ProxyConfig {
	return { ...DEFAULT_PROXY_CONFIG, ...over };
}

test('system mode maps to system', () => {
	assert.deepEqual(toSessionProxyConfig(config({ mode: 'system' })), { mode: 'system' });
});

test('direct mode maps to direct', () => {
	assert.deepEqual(toSessionProxyConfig(config({ mode: 'direct' })), { mode: 'direct' });
});

test('manual with a PAC URL maps to pac_script (and ignores a fixed server)', () => {
	const out = toSessionProxyConfig(config({ mode: 'manual', pacUrl: ' http://wpad/wpad.dat ', server: 'proxy:8080' }));
	assert.deepEqual(out, { mode: 'pac_script', pacScript: 'http://wpad/wpad.dat' });
});

test('manual with a fixed server (no PAC) maps to fixed_servers + bypass', () => {
	const out = toSessionProxyConfig(config({ mode: 'manual', server: ' proxy.corp.com:8080 ', bypass: ' localhost,127.0.0.1 ' }));
	assert.deepEqual(out, { mode: 'fixed_servers', proxyRules: 'proxy.corp.com:8080', proxyBypassRules: 'localhost,127.0.0.1' });
});

test('manual with a server but no bypass omits proxyBypassRules', () => {
	const out = toSessionProxyConfig(config({ mode: 'manual', server: 'proxy:8080' }));
	assert.deepEqual(out, { mode: 'fixed_servers', proxyRules: 'proxy:8080', proxyBypassRules: undefined });
});

test('manual with neither PAC nor server falls back to system (never cuts the network)', () => {
	assert.deepEqual(toSessionProxyConfig(config({ mode: 'manual' })), { mode: 'system' });
});

test('by default neither integrated-auth switch is set: no server is answered, nothing is delegated', () => {
	assert.deepEqual(integratedAuthSwitches(DEFAULT_PROXY_CONFIG), {});
	assert.deepEqual(integratedAuthSwitches(config({ mode: 'system' })), {});
	assert.deepEqual(integratedAuthSwitches(config({ mode: 'manual', pacUrl: 'http://wpad/wpad.dat', server: 'proxy:8080' })), {});
});

test('a manual fixed proxy is on the server list, by host only', () => {
	assert.deepEqual(manualProxyHosts(config({ mode: 'manual', server: 'http=proxy.corp.com:8080;https=Secure.Corp.com:8443;socks5://[::1]:1080' })), ['proxy.corp.com', 'secure.corp.com', '[::1]']);
	assert.deepEqual(integratedAuthSwitches(config({ mode: 'manual', server: ' proxy.corp.com:8080 ' })), { 'auth-server-allowlist': 'proxy.corp.com' });
	// Not manual, so not a configured proxy.
	assert.deepEqual(manualProxyHosts(config({ mode: 'system', server: 'proxy.corp.com:8080' })), []);
});

test('servers the user names are added; delegation happens only when a server is named', () => {
	const out = integratedAuthSwitches(config({ mode: 'manual', server: 'proxy:8080', authServers: '*.corp.example, https://auth.gw.example/login proxy', delegateServers: '' }));
	assert.deepEqual(out, { 'auth-server-allowlist': 'proxy,*.corp.example,auth.gw.example' });
	assert.deepEqual(integratedAuthSwitches(config({ delegateServers: 'sql.corp.example' })), { 'auth-negotiate-delegate-allowlist': 'sql.corp.example' });
});

test('a bare wildcard, or anything that is not a host, never reaches a switch', () => {
	assert.deepEqual(integratedAuthSwitches(config({ authServers: '*, *., ,foo bar$', delegateServers: '*' })), { 'auth-server-allowlist': 'foo' });
	assert.deepEqual(integratedAuthSwitches(config({ authServers: '*', delegateServers: '*' })), {});
});

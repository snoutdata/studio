/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import type { NetworkInterfaceInfo } from 'node:os';
import { test } from 'node:test';

import { isPrivateIpv4, isVirtualInterface, planScan } from './subnet';

function v4(address: string, cidrBits: number, internal = false): NetworkInterfaceInfo {
	return { address, netmask: '', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/${cidrBits}` };
}

test('private ranges only', () => {
	for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.10']) {
		assert.ok(isPrivateIpv4(ip), ip);
	}
	for (const ip of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '169.254.1.1']) {
		assert.ok(!isPrivateIpv4(ip), ip);
	}
});

test('virtual adapters are skipped', () => {
	for (const name of ['docker0', 'br-3f2a', 'veth12ab', 'vEthernet (WSL)', 'vEthernet (Hyper-V Virtual Ethernet Adapter)', 'vboxnet0', 'vmnet8', 'utun3', 'bridge100', 'VirtualBox Host-Only Network']) {
		assert.ok(isVirtualInterface(name), name);
	}
	for (const name of ['en0', 'eth0', 'wlan0', 'Wi-Fi', 'Ethernet 2', 'wlp3s0']) {
		assert.ok(!isVirtualInterface(name), name);
	}
});

test('a /16 is scanned as the /24 around us, without our own address or the ends', () => {
	const { networks, own } = planScan({
		lo0: [v4('127.0.0.1', 8, true)],
		en0: [v4('10.20.30.40', 16)],
		docker0: [v4('172.17.0.1', 16)],
		utun4: [v4('10.8.0.2', 24)],
		en1: [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: 'fe80::1/64', scopeid: 4 }],
	});
	assert.deepEqual(networks.map((n) => n.cidr), ['10.20.30.0/24']);
	const hosts = networks[0].hosts;
	assert.equal(hosts.length, 253);
	assert.ok(!hosts.includes('10.20.30.40'));
	assert.ok(!hosts.includes('10.20.30.0') && !hosts.includes('10.20.30.255'));
	assert.ok(own.includes('172.17.0.1'), 'a virtual adapter\'s address is still ours');
});

test('a narrower network stays narrow, and a public one is never scanned', () => {
	const { networks } = planScan({ en0: [v4('192.168.5.18', 28)], en1: [v4('203.0.113.9', 24)] });
	assert.deepEqual(networks.map((n) => [n.cidr, n.hosts.length]), [['192.168.5.16/28', 13]]);
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { NetworkInterfaceInfo } from 'node:os';

// Which addresses a local-network scan may knock on. Pure: it is handed `os.networkInterfaces()`
// and returns the hosts. The rules, each of which exists to keep the scan small and aimed at the
// network the user is actually on:
//   - IPv4 on a private range only (10/8, 172.16/12, 192.168/16): never a public address.
//   - Never more than the /24 containing the interface's address, however wide its netmask.
//   - Not virtual adapters (container bridges, VM host-only networks, VPN tunnels): the machines
//     behind those are not "the local network", and a VPN is usually somebody's workplace.
//   - Never this computer's own addresses.

const VIRTUAL = /^(docker|br-|veth|virbr|vboxnet|vmnet|vnic|utun|tun|tap|bridge\d|awdl|llw|lxc|lxd|cni|flannel|podman|cali|zt|tailscale|wg|anpi|ap\d)|vEthernet \((WSL|Default Switch|Hyper-V|nat)|VirtualBox|VMware/i;

function toInt(ip: string): number {
	return ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
}

function toIp(n: number): string {
	return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

export function isPrivateIpv4(ip: string): boolean {
	const [a, b] = ip.split('.').map(Number);
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** One network to scan. */
export interface ScanNetwork {
	/** The interface it was found on. */
	iface: string;
	/** "192.168.1.0/24". */
	cidr: string;
	hosts: string[];
}

export function isVirtualInterface(name: string): boolean {
	return VIRTUAL.test(name);
}

/** The networks to scan and this computer's own addresses. Pure. */
export function planScan(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): { networks: ScanNetwork[]; own: string[] } {
	const own: string[] = [];
	const networks = new Map<string, ScanNetwork>();
	for (const [name, list] of Object.entries(interfaces)) {
		for (const info of list ?? []) {
			if (info.family === 'IPv4') {
				own.push(info.address);
			}
		}
		if (isVirtualInterface(name)) {
			continue;
		}
		for (const info of list ?? []) {
			if (info.family !== 'IPv4' || info.internal || !isPrivateIpv4(info.address)) {
				continue;
			}
			const addr = toInt(info.address);
			// The narrower of the interface's own mask and /24: a /16 office network is scanned as the
			// /24 around this computer, and a /28 stays a /28.
			const maskBits = Math.max(24, info.cidr ? Number(info.cidr.split('/')[1]) : 24);
			if (maskBits > 30) {
				continue;
			}
			const mask = (0xffffffff << (32 - maskBits)) >>> 0;
			const base = (addr & mask) >>> 0;
			const cidr = `${toIp(base)}/${maskBits}`;
			if (networks.has(cidr)) {
				continue;
			}
			const size = 2 ** (32 - maskBits);
			const hosts: string[] = [];
			for (let i = 1; i < size - 1; i++) {
				hosts.push(toIp(base + i));
			}
			networks.set(cidr, { iface: name, cidr, hosts });
		}
	}
	const ownSet = new Set(own);
	for (const n of networks.values()) {
		n.hosts = n.hosts.filter((h) => !ownSet.has(h));
	}
	return { networks: [...networks.values()], own };
}

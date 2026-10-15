/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createSocket } from 'node:dgram';
import { promises as dns } from 'node:dns';
import { networkInterfaces } from 'node:os';

import type { ConnectionConfig } from '../../shared/connection';
import type { ImportScanResult } from '../../shared/forms';
import { toScanResult, type Found } from './common';
import { engineName, foundFromProbe } from './local';
import { MDNS_ADDRESS, MDNS_PORT, MDNS_SERVICES, buildMdnsQuery, parseMdnsResponse, servicesFromRecords, type MdnsRecord } from './mdns';
import { pool, probePort, type ProbeOutcome } from './probe';
import { PROBE_PORTS, type ProbePort } from './sniff';
import { planScan } from './subnet';

// The local network, only when the user switched it on: ask mDNS who announces a Postgres or MySQL,
// then knock on the well-known database ports of every address in the /24 around this computer
// (`subnet.ts` says which), with the same sniffers as "this computer". Bounded three ways: at most
// `concurrency` sockets in flight, `connectTimeoutMs` per knock, and a hard `deadlineMs` after which
// nothing new starts.
//
// macOS 15+ refuses local-network traffic until the user grants the Local Network permission, and a
// refusal looks like "no route to host" on every address. That is reported as a sentence saying where
// to allow it, never as "nothing found", which would be untrue.

export interface NetworkScanOptions {
	concurrency?: number;
	connectTimeoutMs?: number;
	deadlineMs?: number;
	/** How long to listen for mDNS answers. */
	mdnsMs?: number;
}

const DENIED_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EPERM', 'EACCES']);

export const LOCAL_NETWORK_DENIED = "macOS is not letting SnoutData reach your local network. Allow it in System Settings, Privacy & Security, Local Network, then run this again.";

/** Ask mDNS once and collect answers for `ms`. Resolves with the records and any send error code. */
function queryMdns(ms: number): Promise<{ records: MdnsRecord[]; error?: string }> {
	return new Promise((resolve) => {
		const records: MdnsRecord[] = [];
		let error: string | undefined;
		const socket = createSocket({ type: 'udp4', reuseAddr: true });
		const done = (): void => {
			try {
				socket.close();
			} catch {
				// already closed
			}
			resolve({ records, error });
		};
		socket.on('message', (msg) => records.push(...parseMdnsResponse(msg)));
		socket.on('error', (err: NodeJS.ErrnoException) => {
			error = err.code;
		});
		socket.bind(0, () => {
			socket.send(buildMdnsQuery(Object.keys(MDNS_SERVICES)), MDNS_PORT, MDNS_ADDRESS, (err) => {
				if (err) {
					error = (err as NodeJS.ErrnoException).code;
				}
			});
			setTimeout(done, ms);
		});
	});
}

/** A reverse-DNS name for an address, or undefined, never slower than `ms`. */
async function reverseName(ip: string, ms: number): Promise<string | undefined> {
	const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms));
	const lookup = dns.reverse(ip).then((names) => names[0]?.replace(/\.$/, '')).catch(() => undefined);
	return Promise.race([lookup, timeout]);
}

/** The probe statistics that say whether macOS refused us. Pure. */
export function looksDenied(platform: NodeJS.Platform, outcomes: ProbeOutcome[], mdnsError?: string): boolean {
	if (platform !== 'darwin') {
		return false;
	}
	if (mdnsError && DENIED_CODES.has(mdnsError)) {
		return true;
	}
	let reached = 0;
	let refusedByMac = 0;
	for (const o of outcomes) {
		if (o.kind !== 'closed' || o.code === 'ECONNREFUSED') {
			reached++;
		} else if (o.code && DENIED_CODES.has(o.code)) {
			refusedByMac++;
		}
	}
	// Any address that answered, even with "connection refused", proves the network is reachable.
	return reached === 0 && refusedByMac > 0 && refusedByMac >= outcomes.length / 2;
}

export async function scanNetwork(existing: ConnectionConfig[], options: NetworkScanOptions = {}): Promise<ImportScanResult> {
	const concurrency = options.concurrency ?? 128;
	const connectTimeoutMs = options.connectTimeoutMs ?? 400;
	const deadline = Date.now() + (options.deadlineMs ?? 20_000);
	const { networks } = planScan(networkInterfaces());

	const mdnsRun = queryMdns(options.mdnsMs ?? 1500);
	const tasks: (() => Promise<{ host: string; spec: ProbePort; outcome: ProbeOutcome }>)[] = [];
	for (const net of networks) {
		for (const host of net.hosts) {
			for (const spec of PROBE_PORTS) {
				tasks.push(async () => ({ host, spec, outcome: await probePort(host, spec, connectTimeoutMs) }));
			}
		}
	}
	const [probed, mdns] = await Promise.all([pool(tasks, concurrency, deadline), mdnsRun]);

	if (looksDenied(process.platform, probed.map((p) => p.outcome), mdns.error)) {
		return { sourceId: 'network', sources: [], items: [], unavailable: LOCAL_NETWORK_DENIED };
	}

	const byEndpoint = new Map<string, Found>();
	// Announced services first: they come with a name somebody chose.
	for (const svc of servicesFromRecords(mdns.records)) {
		const spec = PROBE_PORTS.find((p) => p.driver === svc.driver && p.sniff !== 'tcp') ?? { port: svc.port, driver: svc.driver, sniff: 'tcp' as const };
		const verdict = { driver: svc.driver, product: engineName(svc.driver) };
		const f = foundFromProbe(svc.host, { ...spec, port: svc.port }, { kind: 'answered', verdict }, svc.instance, `Announced on the local network as "${svc.instance}".`);
		if (f) {
			byEndpoint.set(`${svc.host}:${svc.port}`, f);
		}
	}
	const hits = probed.filter((p) => p.outcome.kind !== 'closed' && !byEndpoint.has(`${p.host}:${p.spec.port}`));
	const names = new Map<string, string | undefined>();
	await Promise.all([...new Set(hits.map((h) => h.host))].map(async (ip) => names.set(ip, await reverseName(ip, 400))));
	for (const h of hits) {
		const f = foundFromProbe(h.host, h.spec, h.outcome, names.get(h.host));
		if (f) {
			byEndpoint.set(`${h.host}:${h.spec.port}`, f);
		}
	}
	const sources = [...networks.map((n) => `${n.cidr} (${n.iface})`), ...(mdns.records.length > 0 ? ["mDNS"] : [])];
	const result = toScanResult('network', sources, [...byEndpoint.values()], existing);
	// Past the deadline, what was not knocked on is not known to be empty: say the scan was cut short.
	return tasks.length > probed.length ? { ...result, sources: [...result.sources, "stopped at the time limit"] } : result;
}

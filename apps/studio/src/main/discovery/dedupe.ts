/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ImportItem, ImportScanResult } from '../../shared/forms';

// One database found by two sources is shown once. Pure. The rules, in the order they apply:
//   1. Inside one source, the same identity twice (SSMS remembers a server per version) is one row,
//      and the copy that carries a password wins.
//   2. A port on this computer that answered a probe ("Running on this computer") is dropped when
//      any other source already describes that port: a Docker container that publishes it (which
//      carries the credentials) or a tool's saved connection to it (which carries a name).
//   3. The same for the local network: an address and port a tool already names is not listed
//      again as something found on the network.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);

function identity(item: ImportItem): string {
	const v = item.values;
	const host = LOCAL_HOSTS.has(v.host.toLowerCase()) ? 'localhost' : v.host.toLowerCase();
	return [v.driver, host, v.port, v.database ?? '', v.username ?? ''].join('|');
}

function endpoint(item: ImportItem): string {
	const host = item.values.host.toLowerCase();
	return `${LOCAL_HOSTS.has(host) ? 'localhost' : host}:${item.values.port}`;
}

function withItems(result: ImportScanResult, items: ImportItem[]): ImportScanResult {
	return { ...result, items, notFound: result.unavailable ? result.notFound : items.length === 0 };
}

export function dedupeAcrossSources(results: ImportScanResult[]): ImportScanResult[] {
	// 1. Within a source.
	const inner = results.map((r) => {
		const keep = new Map<string, ImportItem>();
		for (const item of r.items) {
			const id = identity(item);
			const prior = keep.get(id);
			if (!prior || (!prior.importsPassword && item.importsPassword)) {
				keep.set(id, item);
			}
		}
		return keep.size === r.items.length ? r : withItems(r, r.items.filter((i) => keep.get(identity(i)) === i));
	});

	// 2 and 3. Endpoints a tool, a container or the cloud names.
	const named = new Set<string>();
	for (const r of inner) {
		if (r.sourceId === 'local' || r.sourceId === 'network') {
			continue;
		}
		for (const item of r.items) {
			if (item.supported) {
				named.add(endpoint(item));
			}
		}
	}
	return inner.map((r) => {
		if (r.sourceId !== 'local' && r.sourceId !== 'network') {
			return r;
		}
		const items = r.items.filter((item) => !named.has(endpoint(item)));
		return items.length === r.items.length ? r : withItems(r, items);
	});
}

/**
 * What a saved connection already points at is not news, so the popup never lists it (not even
 * unticked). After dedupe, on purpose: a probed port another source names is dropped there by that
 * source's item, which may itself be one of these.
 */
export function dropMapped(results: ImportScanResult[]): ImportScanResult[] {
	return results.map((r) => {
		const items = r.items.filter((i) => !i.duplicate);
		return items.length === r.items.length ? r : withItems(r, items);
	});
}

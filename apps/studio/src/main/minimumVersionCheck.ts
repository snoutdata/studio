/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'fs';
import {
	decideMinimumVersion,
	MINIMUM_VERSION_PATH,
	parseMinimumVersion,
	parseMinimumVersionCache,
	shouldFetchMinimum,
	type MinimumVersionCache,
	type MinimumVersionState,
} from '../shared/minimumVersion';
import { netFetch } from './netFetch';

/** A request that has not answered in this long counts as failed, which fails open. */
const FETCH_TIMEOUT_MS = 10_000;

export interface MinimumVersionCheckOptions {
	/** The running version (app.getVersion()). */
	version: string;
	/** userData/minimum-version.json. */
	cachePath: string;
	/** https://accounts.snoutdata.com, no trailing slash. */
	origin: string;
	now?: () => number;
}

function readCache(path: string): MinimumVersionCache | null {
	try {
		return parseMinimumVersionCache(JSON.parse(readFileSync(path, 'utf8')));
	} catch {
		return null;
	}
}

/**
 * Whether this version is below the minimum the backend still supports. The decisions are
 * in shared/minimumVersion.ts; this is only the file and the request. Never throws, and every
 * failure answers "not required": a check that cannot run must never lock anyone out.
 *
 * Not on the boot path: main calls it from a timer after first paint, like the install heartbeat.
 */
export async function checkMinimumVersion(options: MinimumVersionCheckOptions): Promise<MinimumVersionState> {
	const now = options.now ?? Date.now;
	try {
		const cache = readCache(options.cachePath);
		if (!shouldFetchMinimum(cache, options.version, now())) {
			return { required: false };
		}
		let fetched: { ok: true; minimum: string | null } | { ok: false };
		try {
			const res = await netFetch(`${options.origin}${MINIMUM_VERSION_PATH}`, {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				headers: { Accept: 'application/json' },
			});
			fetched = res.ok ? { ok: true, minimum: parseMinimumVersion(await res.json()) } : { ok: false };
		} catch {
			fetched = { ok: false };
		}
		const decision = decideMinimumVersion(options.version, fetched, now());
		if (decision.cache) {
			try {
				writeFileSync(options.cachePath, JSON.stringify(decision.cache));
			} catch {
				// An unwritable cache only means asking again next time.
			}
		}
		return decision.state;
	} catch {
		return { required: false };
	}
}

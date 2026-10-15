/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AiModelChoice } from '../../shared/ai';

// The models the dev-only tuning endpoint (aiDebugServer.ts) and the memory benchmark compare a
// prompt across. The list is a build constant: the official build compiles in its own, and a build
// without one benchmarks the model saved in Settings → AI, so the endpoint works either way.
declare const __SNOUT_BENCHMARK_MODELS__: string | undefined;

function parseModels(raw: string | undefined): AiModelChoice[] {
	if (!raw) {
		return [];
	}
	try {
		const list: unknown = JSON.parse(raw);
		return Array.isArray(list) ? list.filter((m): m is AiModelChoice => typeof m?.provider === 'string' && typeof m?.model === 'string') : [];
	} catch {
		return [];
	}
}

const CONFIGURED: AiModelChoice[] = parseModels(typeof __SNOUT_BENCHMARK_MODELS__ === 'string' ? __SNOUT_BENCHMARK_MODELS__ : undefined);

/** The benchmark set: the build's own list, or else just `saved`, the model the settings name. */
export function benchmarkModels(saved: AiModelChoice): AiModelChoice[] {
	return CONFIGURED.length > 0 ? CONFIGURED : [saved];
}

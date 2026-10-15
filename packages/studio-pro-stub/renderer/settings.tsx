/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Data Flows' Settings pages, as the open-source tree builds them: none (Settings hides both tabs
// when `PRO_AVAILABLE` is false). See ../README.md.

import type { ProEnginePage } from '@snout/studio/renderer/src/proSeam';

export function DataGenerationSection(_props: { vendorAllowed: boolean }): null {
	return null;
}

export function ExtractionModelSection(_props: { initialPage?: ProEnginePage; onOpenFlows?(): void }): null {
	return null;
}

/** Settings search entries for those pages: none. */
export const PRO_SETTING_ENTRIES: Array<{ tab: 'datagen' | 'extractmodel'; label: string; keywords?: string }> = [];

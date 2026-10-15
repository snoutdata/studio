/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Compact bytes formatter ("12.3 MB"). `missing` is what an unknown size shows as. */
export function formatBytes(n: number | undefined, missing = '?'): string {
	if (n === undefined || !Number.isFinite(n)) {
		return missing;
	}
	if (n < 1024) {
		return `${n} B`;
	}
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

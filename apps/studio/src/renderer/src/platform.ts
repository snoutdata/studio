/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ImportPlatform } from '../../shared/forms';

/** The system this renderer runs on, as `process.platform` names it. */
export function currentPlatform(): ImportPlatform {
	const p = typeof navigator !== 'undefined' ? (navigator.platform || navigator.userAgent) : '';
	return /mac/i.test(p) ? 'darwin' : /win/i.test(p) ? 'win32' : 'linux';
}

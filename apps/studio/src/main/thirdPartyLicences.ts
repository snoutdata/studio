/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The licences the build writes into out/licenses (scripts/third-party-licenses.mjs), read for
// About → Third-party licences. The path is fixed here from the app's own path, never taken from the
// renderer: packaged, that is app.asar (Electron's fs reads inside it); in development, the app folder,
// whose out/ holds the last build's files.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Kept equal to LICENSES_DIR and the file names in scripts/third-party-licenses.mjs. */
const LICENSES_DIR = ['out', 'licenses'];
const NOTICE_FILE = 'NOTICE.txt';
const THIRD_PARTY_FILE = 'THIRD-PARTY-LICENSES.txt';

export interface ThirdPartyLicences {
	/** Studio's own NOTICE, or null when the build did not write it. */
	notice: string | null;
	/** Every third-party package in the app with its licence text, or null when the build did not write it. */
	licences: string | null;
}

async function readOrNull(file: string): Promise<string | null> {
	try {
		return await readFile(file, 'utf8');
	} catch {
		return null;
	}
}

export async function readThirdPartyLicences(appPath: string): Promise<ThirdPartyLicences> {
	const dir = join(appPath, ...LICENSES_DIR);
	const [notice, licences] = await Promise.all([readOrNull(join(dir, NOTICE_FILE)), readOrNull(join(dir, THIRD_PARTY_FILE))]);
	return { notice, licences };
}

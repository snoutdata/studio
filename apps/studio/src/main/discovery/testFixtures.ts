/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A fixture's bytes. Tests run from apps/studio, where the sources are. */
export function fixtureBytes(name: string): Buffer {
	return readFileSync(fixturePath(name));
}

export function fixturePath(name: string): string {
	return join(process.cwd(), 'src', 'main', 'discovery', 'fixtures', name);
}

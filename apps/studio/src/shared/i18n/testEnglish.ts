/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Injected into every unit-test bundle (esbuild.server.mjs, `inject`), so a module that says t('x.y')
// answers in English under `node --test`, as the app does. Not part of the app.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { catalogOf, registerCatalog } from './core';

const DIR = join(process.cwd(), 'src/shared/i18n/en');
const files: Record<string, unknown> = {};
for (const name of readdirSync(DIR)) {
	if (name.endsWith('.json')) {
		files[name] = JSON.parse(readFileSync(join(DIR, name), 'utf8')) as unknown;
	}
}
registerCatalog('en', catalogOf(files));

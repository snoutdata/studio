/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Carries package.json's version into the two places that state it: `src/version.ts`, which the
// client sends as `X-Client-Info`, and the README's pinned CDN import. npm runs this as the
// `version` script, after `npm version` has written the new number and before the commit, and
// `version.test.ts` fails if either has drifted.

import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

const source = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Written by scripts/version.mjs from package.json, which npm runs on \`npm version\`.

/** This client's version, as published to npm. */
export const VERSION = '${version}';
`;
writeFileSync(new URL('src/version.ts', root), source);

const readmeUrl = new URL('README.md', root);
const readme = readFileSync(readmeUrl, 'utf8');
writeFileSync(readmeUrl, readme.replace(/@snoutdata\/client@\d+\.\d+\.\d+/g, `@snoutdata/client@${version}`));
console.log(`version ${version}: src/version.ts and README.md`);

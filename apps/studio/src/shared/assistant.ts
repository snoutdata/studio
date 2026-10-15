/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The assistant's name and identity, for every process (main, the renderer, the server child, the
// engine). They come from the build: "Liby" from her private package in the official build, "AI"
// from packages/liby-stub in the open-source one (apps/studio/scripts/liby.mjs picks). Import the
// name from HERE, never write it into a string: a literal "Liby" in user-facing text is a bug in
// the open build.
export { ASSISTANT_IDENTITY, ASSISTANT_INTRO, ASSISTANT_NAME, assistantIs } from '@snout/liby/name';

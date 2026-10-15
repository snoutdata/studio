/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Node half of `@snout/move`: spawning the tools, streaming, progress, cancel, verify.
 * Imported by the desktop's main process and the CLI, never by a renderer, which is why it is a
 * separate entry (`@snout/move/runner`) from the pure core.
 */

export { toolEnv, type PgAccess, type PgSslMode, type ToolEnv } from './env.js';
export { runPipeline, type PipelineOptions, type PipelineResult, type ToolProcess } from './pipeline.js';
export { psqlQuery } from './psql.js';
export { runMove, type MoveRunHost, type MoveRunInput, type Side, type ToolCommand } from './run.js';

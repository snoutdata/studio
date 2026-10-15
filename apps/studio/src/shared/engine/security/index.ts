/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  snout-engine / security — who can reach a database, and what they may do with it.
 *
 *  Pure and isomorphic like the rest of the engine: this module produces SQL and consumes rows,
 *  and never touches a driver, a filesystem or a model. Main runs the statements; the renderer
 *  renders the plan; both import through `shared/engine`.
 *--------------------------------------------------------------------------------------------*/

export * from './types';
export * from './catalog';
export * from './emitter';
export * from './plan';
export * from './redact';

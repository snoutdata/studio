/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The agent loop lives in `@snout/harness` (packages/harness), which the Cloud dashboard runs too.
// This file keeps the import path every caller and test already uses; `ModelProvider` is a
// `ChatProvider` there, structurally, so nothing that calls it had to change.
export { runAgentLoop, type AgentLoopHooks, type AgentLoopResult } from '@snout/harness';

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @snout/harness: the assistant harness SnoutData Studio and the SnoutData Cloud dashboard share:
// the tool loop, the tool-call parser, the grant rules, the stream reader and the trace format. The
// Cloud dashboard's own tools and prompt are `@snout/harness/cloud`, which is not part of this tree,
// and nothing here imports it.
export * from './types.ts';
export { runAgentLoop, type AgentLoopHooks, type AgentLoopResult } from './loop.ts';
export { ToolMarkupStream, hasToolMarkup, parseJsonToolCalls, parseNaturalLanguageToolCalls, parseTextToolCalls, stripToolMarkup } from './textToolCalls.ts';
export { DECLINED, answersFor, applyAnswer, decide, emptyGrants, gatedRunner, mustAsk, type GatedRunnerOptions, type GrantState } from './grants.ts';
export { readChatStream, toOpenAiMessages } from './stream.ts';
export { parsePartialJson, partialFunctionArgs, type PartialFile, type PartialFunction } from './partial.ts';
export { memorySink, now, toJsonl, type TraceRecord, type TraceSink } from './trace.ts';

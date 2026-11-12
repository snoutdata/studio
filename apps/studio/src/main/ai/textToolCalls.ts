/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The text tool-call parser (XML, JSON and natural-language calls, and the markup stream filter)
// lives in `@snout/harness` (packages/harness) beside the loop that uses it. This file keeps the
// import path Studio's callers and tests already use.
export { ToolMarkupStream, hasToolMarkup, parseJsonToolCalls, parseNaturalLanguageToolCalls, parseTextToolCalls, stripToolMarkup } from '@snout/harness';

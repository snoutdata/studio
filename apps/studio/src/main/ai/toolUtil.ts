/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolSpec } from '../../shared/ai';

/** Parse a tool call's argument JSON defensively — models occasionally emit nothing or
 *  malformed fragments, so a bad parse degrades to empty args rather than throwing. */
export function parseToolArgs(raw: string | undefined): Record<string, unknown> {
	if (!raw || !raw.trim()) {
		return {};
	}
	try {
		const value = JSON.parse(raw) as unknown;
		return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** OpenAI/Ollama-style function-tool wrapper. */
export function asFunctionTools(tools: ToolSpec[]): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
	return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

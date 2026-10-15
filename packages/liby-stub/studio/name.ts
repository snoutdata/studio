/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the open-source build calls its assistant: "AI", with no persona. The official build names it
// (and gives it a character) in the private package's studio/name.ts. Same exports; see ../README.md.

/** The assistant's name, everywhere a user reads it. */
export const ASSISTANT_NAME = 'AI';

/** The name with what it is, for a sentence that introduces it. */
export const ASSISTANT_INTRO = 'the AI assistant';

/** How a system prompt introduces the assistant in a role: "You are the SQL assistant". */
export function assistantIs(role: string): string {
	return `the ${role}`;
}

/** Who the assistant is when asked. */
export const ASSISTANT_IDENTITY = 'If asked who you are, you are the AI assistant in SnoutData Studio. Be exact about data.';

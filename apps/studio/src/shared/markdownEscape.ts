/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Text the DATABASE supplied (a comment, a name), made plain markdown text: every ASCII punctuation
 * character is backslash-escaped, which CommonMark allows for all of them, so it renders as the
 * characters it holds and never as markup. Monaco renders hover and completion docs as markdown,
 * with images: a column comment `![](file://host/share/x.png)` was an image the editor fetched on
 * hover, and on Windows a file: URL with a host is an SMB connection that hands the user's NTLM hash
 * to that host. A link or a bare URL in a comment is plain text too.
 */
export function markdownText(text: string): string {
	return text.replace(/[!-/:-@[-`{-~]/g, '\\$&');
}

/**
 * {@link markdownText} for text of several lines (a server's own documentation, an example): each
 * line break is kept as a hard break and leading indentation as no-break spaces, so the text reads
 * as it was written while still being nothing but text.
 */
export function markdownLines(text: string): string {
	return markdownText(text)
		.replace(/^[ \t]+/gm, (indent) => ' '.repeat(indent.replace(/\t/g, '    ').length))
		.replace(/[ \t]*\r?\n/g, '  \n');
}

/**
 * Text the database supplied, as a code span nothing inside can close: the fence is one backtick
 * longer than the longest run in the text, and whitespace (a blank line would end the paragraph and
 * the span with it) is one space. Backslashes are literal inside a code span, so this is the escape.
 */
export function markdownCode(text: string): string {
	const flat = text.replace(/\s+/g, ' ');
	const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
	const fence = '`'.repeat(longest + 1);
	const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
	return `${fence}${pad}${flat}${pad}${fence}`;
}

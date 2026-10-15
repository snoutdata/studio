/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Markdown that a pull request cannot break out of.
 *
 *  Table names, column names, file paths and whole statements come from the pull request, and
 *  the comment they end up in is markdown posted under somebody's name. A name with a backtick
 *  in it closed the code span it was put in, and everything after it was rendered as markdown:
 *  a link, an image, a fake heading. These two helpers are the only way PR text reaches the
 *  comment inside code: a span or fence longer than any backtick run in the text, so the text
 *  can never close it.
 *--------------------------------------------------------------------------------------------*/

/** The longest run of backticks in `text`. */
function longestBacktickRun(text: string): number {
	let longest = 0;
	let run = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 96) {
			run++;
			if (run > longest) {
				longest = run;
			}
		} else {
			run = 0;
		}
	}
	return longest;
}

/**
 * An inline code span holding `text` literally.
 *
 * Line breaks become spaces (a blank line inside a span ends the paragraph, and the span with
 * it), the delimiter is one backtick longer than any run inside, and the content is padded with
 * a space when it starts or ends with a backtick or a space, which CommonMark then strips.
 */
export function codeSpan(text: string | undefined): string {
	const flat = String(text ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ');
	if (flat === '') {
		return '` `';
	}
	const fence = '`'.repeat(longestBacktickRun(flat) + 1);
	const pad = /^[` ]|[` ]$/.test(flat) && flat.trim() !== '' ? ' ' : '';
	return `${fence}${pad}${flat}${pad}${fence}`;
}

/**
 * A fenced code block holding `text` literally, as lines (so a caller can prefix each one, for
 * a blockquote). The fence is at least three backticks and longer than any run in the text, so
 * a statement that contains ``` cannot end the block early.
 */
export function codeFence(text: string, lang = ''): string[] {
	const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
	return [`${fence}${lang}`, ...text.split(/\r?\n/), fence];
}

/** The most of one name a pull request chose that a probe's purpose shows, in characters. */
export const NAME_CAP = 80;

/**
 * A name the pull request chose (a table, a column), as a code span cut to {@link NAME_CAP}.
 * The span keeps it from being markup; the cap keeps a 5,000-character name from becoming the
 * comment.
 */
export function nameSpan(name: string | undefined): string {
	const chars = Array.from(String(name ?? ''));
	return codeSpan(chars.length > NAME_CAP ? `${chars.slice(0, NAME_CAP).join('')}…` : chars.join(''));
}

/** Several names, each a {@link nameSpan}, the first `most` of them and then how many more. */
export function nameList(names: readonly string[], most = 5): string {
	const shown = names.slice(0, most).map(nameSpan).join(', ');
	return names.length > most ? `${shown} and ${names.length - most} more` : shown;
}

/** Free text from a person or a pull request, kept on one line so it cannot start a block. */
export function oneLine(text: string): string {
	return String(text).replace(/\s+/g, ' ').trim();
}

/** Fenced code in untrusted text: up to three spaces, then three or more backticks or tildes. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;

/**
 * Markdown from a source that must not be trusted with markup, as lines ready to prefix (a
 * blockquote, say): a MODEL's prose, whose prompt held names the pull request chose. It keeps
 * paragraphs, lists, emphasis, inline code and fenced code, and takes away everything that could
 * break out of the section it sits in or speak for somebody: HTML (a `</details>` that closes the
 * fold, an `<img>`, an HTML comment that copies our marker) is escaped; images, links and link
 * definitions lose their brackets; a bare URL or an email address becomes a code span, so it is
 * not a link; an `@mention` becomes a code span, so nobody is notified; a heading's `#` and a
 * setext underline are escaped. Code is re-fenced with {@link codeSpan} and {@link codeFence}, so
 * nothing inside it can end it, and a fence the text never closes is closed here.
 */
export function untrustedMarkdown(text: string): string[] {
	const out: string[] = [];
	const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
	for (let i = 0; i < lines.length; i++) {
		const open = FENCE_OPEN.exec(lines[i]);
		if (open) {
			const marker = open[1];
			const body: string[] = [];
			i++;
			while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			out.push(...codeFence(body.join('\n'), open[2]));
			continue;
		}
		out.push(untrustedLine(lines[i]));
	}
	return out;
}

/** One line of untrusted prose: code spans re-made, everything else inert. */
function untrustedLine(line: string): string {
	// A setext underline (or a thematic break, which is how `---` reads under a paragraph).
	if (/^ {0,3}(?:=+|-{2,})\s*$/.test(line)) {
		return line.replace(/[=-]/, (c) => `\\${c}`);
	}
	let out = '';
	let i = 0;
	while (i < line.length) {
		if (line[i] === '`') {
			const run = /^`+/.exec(line.slice(i))![0];
			const close = line.indexOf(run, i + run.length);
			// A span closes on a run of exactly the same length.
			if (close !== -1 && line[close + run.length] !== '`') {
				out += codeSpan(line.slice(i + run.length, close).replace(/^ (.*) $/, '$1'));
				i = close + run.length;
				continue;
			}
			out += '\\`'.repeat(run.length);
			i += run.length;
			continue;
		}
		const next = line.indexOf('`', i);
		out += inertText(line.slice(i, next === -1 ? line.length : next));
		i = next === -1 ? line.length : next;
	}
	// A heading, wherever the line's first character is a `#`.
	return out.replace(/^( {0,3})#/, '$1\\#');
}

/** URLs, email addresses and mentions: shown as code, so none of them is a link or a ping. */
const LINKISH = /\b(?:https?|ftp):\/\/[^\s<>"'`]+|\bmailto:[^\s<>"'`]+|\bwww\.[^\s<>"'`]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<![\w`])@[\w-]+(?:\/[\w.-]+)?/gi;

/** Untrusted text that is not code: links, pings and markup made inert. */
function inertText(text: string): string {
	let out = '';
	let last = 0;
	for (const m of text.matchAll(LINKISH)) {
		const at = m.index ?? 0;
		out += escapeMarkup(text.slice(last, at));
		// A sentence's full stop or closing bracket is not part of the address.
		const token = m[0].replace(/[.,;:!?)\]]+$/, '');
		out += codeSpan(token);
		last = at + token.length;
	}
	return out + escapeMarkup(text.slice(last));
}

function escapeMarkup(text: string): string {
	return text
		.replace(/\\/g, '\\\\')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/[[\]]/g, (c) => `\\${c}`);
}

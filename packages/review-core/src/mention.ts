/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Reading `@handle <command>` out of a comment.
 *
 *  Deliberately forgiving about how somebody types it and deliberately strict about where it
 *  can appear: a mention inside a fenced code block or a blockquote is somebody QUOTING the
 *  bot, not summoning it, and replying to a quote is how a bot gets into a loop with itself.
 *--------------------------------------------------------------------------------------------*/

export type ReviewCommandName = 'review' | 'explain' | 'fix' | 'ignore' | 'status' | 'help';

export interface ReviewCommand {
	name: ReviewCommandName;
	/** `--deep`: run the probes that are skipped as expensive by default. */
	deep: boolean;
	/** `--on <name>`: review against a named destination instead of the default. */
	destination?: string;
	/** A path argument, when one was given: `review db/migrate/003.sql`. */
	path?: string;
	/** The finding id for `explain` / `fix` / `ignore`. */
	findingId?: string;
	/** Free text after an `ignore` id — the reason, kept and shown. */
	reason?: string;
	/** The command exactly as written, for the audit log. */
	raw: string;
	/** Set when the mention was understood but the command word was not, so the host can reply
	 *  with help instead of silence. `name` is `help` in that case. */
	unknown?: string;
}

/** Strip fenced code blocks, inline code and blockquotes — a mention in any of them is a
 *  quotation. Newlines are preserved so nothing else shifts. */
function stripQuoted(body: string): string {
	return body
		.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/~~~[\s\S]*?~~~/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
		.split('\n')
		.map((line) => (/^\s*>/.test(line) ? ' '.repeat(line.length) : line))
		.join('\n');
}

const NAMES: ReviewCommandName[] = ['review', 'explain', 'fix', 'ignore', 'status', 'help'];

/**
 * The command in `body`, or `undefined` when the bot was not addressed. A bare mention
 * (`@handle`) means `review`, because that is what everyone means by it.
 */
export function parseMention(body: string, handle: string): ReviewCommand | undefined {
	if (!body || !handle) {
		return undefined;
	}
	const text = stripQuoted(body);
	const at = new RegExp(`(^|[^\\w/])@${handle.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i').exec(text);
	if (!at) {
		return undefined;
	}

	// The command is the rest of that line.
	const from = at.index + at[0].length;
	const lineEnd = text.indexOf('\n', from);
	const rest = text.slice(from, lineEnd === -1 ? text.length : lineEnd).trim();
	const raw = rest;

	const tokens = rest.split(/\s+/).filter((t) => t !== '');
	const command: ReviewCommand = { name: 'review', deep: false, raw };
	if (tokens.length === 0) {
		return command;
	}

	const first = tokens[0].toLowerCase();
	const named = NAMES.find((n) => n === first);
	if (named) {
		command.name = named;
		tokens.shift();
	} else if (first.startsWith('-')) {
		// `@handle --deep` — flags with no verb still mean review.
		command.name = 'review';
	} else {
		// An unrecognised word is not a dead end. Somebody who typed `@handle revew` or
		// `@handle please look at this` wants a review, and answering "I do not understand"
		// to a person who addressed you by name is how a bot gets muted. Run the review and
		// let the host mention, in one line, that it did not recognise the word.
		command.unknown = tokens[0];
	}

	const positional: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const lower = token.toLowerCase();
		if (lower === '--deep' || lower === '-d' || lower === 'deep') {
			command.deep = true;
			continue;
		}
		if (lower === '--on' || lower === 'on' || lower === '--against') {
			command.destination = tokens[i + 1];
			i++;
			continue;
		}
		if (lower.startsWith('--on=')) {
			command.destination = token.slice(5);
			continue;
		}
		positional.push(token);
	}

	if (command.name === 'explain' || command.name === 'fix' || command.name === 'ignore') {
		command.findingId = positional.shift();
		if (command.name === 'ignore' && positional.length > 0) {
			command.reason = positional.join(' ');
			positional.length = 0;
		}
	}
	if (positional.length > 0) {
		command.path = positional[0];
	}
	return command;
}

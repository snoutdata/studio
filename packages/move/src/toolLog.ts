/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What `pg_restore --verbose` and `pg_dump --verbose` print, read as events.
 *
 * The tools say where they are one line at a time, on stderr: "creating TABLE "public.orders"",
 * "processing data for table "public.orders"", and for a failure an `error:` line whose message and
 * the statement it ran ("Command was: ...") both run on over the unprefixed lines after it. Reading
 * that is pure, so it lives in the core and is tested on the text the tools really print; the runner
 * only feeds it lines.
 *
 * Measured 2026-09-13: `pg_restore` exits 1 with "errors ignored on restore: 16" and carries on, so
 * the failures ARE the report. One kind is noise and is marked `harmless` rather than dropped: the
 * comment on an extension the platform installed, which the project's owner role does not own
 * (the snoutdata CLI's restore records the same finding).
 */

import { PLATFORM_EVENT_TRIGGERS, PLATFORM_FUNCTION_SCHEMAS } from './platform.js';
import { redactSecrets } from './redact.js';

export type ToolLogEvent =
	| { readonly kind: 'creating'; readonly desc: string; readonly object: string }
	| { readonly kind: 'data'; readonly schema: string; readonly table: string }
	| { readonly kind: 'error' }
	| { readonly kind: 'ignored'; readonly count: number };

export interface RestoreFailure {
	/** The entry it happened on, as the tool names it (`TABLE orders`), when it said. */
	readonly object: string | null;
	readonly message: string;
	/** The statement that failed, when the tool printed it. */
	readonly command: string | null;
	/** Known noise that loses nothing; counted, never reported as a failure. */
	readonly harmless: boolean;
}

const PREFIXED = /^(pg_restore|pg_dump): (?:(error|warning|detail|hint): )?(.*)$/;

/**
 * Errors that lose nothing. Each is here because it was measured, with the reason beside it.
 *
 * The first: COMMENT ON EXTENSION for an extension the hosted platform installed and its
 * superuser owns. It is matched on STRUCTURE, never on a substring: the server's error text quotes
 * object names, and the source's names are not ours, so a view called "must be owner of extension x"
 * must not be able to mark its own failure as noise and let a move delete the source. The entry has
 * to be that comment, the message's first line has to be exactly that error for that extension, and
 * the statement has to be exactly that COMMENT and nothing after it.
 */
function harmless(failure: OpenFailure): boolean {
	return platformCommentOnExtension(failure) || platformEventTrigger(failure);
}

function platformCommentOnExtension(failure: OpenFailure): boolean {
	const entry = /^COMMENT EXTENSION ("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)$/.exec(failure.object ?? '');
	if (!entry || failure.command === null) {
		return false;
	}
	const token = entry[1];
	const name = token.startsWith('"') ? token.slice(1, -1).replace(/""/g, '"') : token;
	const firstLine = failure.message.trim().split('\n')[0];
	const message = /^could not execute query: ERROR:\s+must be owner of extension (\S+)$/.exec(firstLine);
	if (!message || message[1] !== name) {
		return false;
	}
	const command = failure.command.trim();
	const prefix = `COMMENT ON EXTENSION ${token} IS `;
	return command.startsWith(prefix) && /^'(?:[^']|'')*';$/.test(command.slice(prefix.length));
}

/**
 * The second, measured 2026-10-15: one of the platform's own event triggers (`platform.ts`), which
 * cannot be restored anywhere and is not the customer's. Matched on STRUCTURE like the comment: the
 * entry is that trigger by its exact name, the first line is one of the three errors its restore
 * gives (its schema missing, it already being there, or not being a superuser), and the statement
 * is exactly that trigger calling the function of its own name in a platform schema.
 */
function platformEventTrigger(failure: OpenFailure): boolean {
	const entry = /^EVENT TRIGGER ([a-z_]+)$/.exec(failure.object ?? '');
	if (!entry || !PLATFORM_EVENT_TRIGGERS.includes(entry[1]) || failure.command === null) {
		return false;
	}
	const name = entry[1];
	const firstLine = failure.message.trim().split('\n')[0];
	const error = /^could not execute query: ERROR:\s+(.*)$/.exec(firstLine)?.[1] ?? '';
	const schemaMissing = /^schema "([a-z_]+)" does not exist$/.exec(error);
	const expected = (schemaMissing !== null && PLATFORM_FUNCTION_SCHEMAS.includes(schemaMissing[1]))
		|| error === `event trigger "${name}" already exists`
		|| error === `permission denied to create event trigger "${name}"`;
	if (!expected) {
		return false;
	}
	const command = /^CREATE EVENT TRIGGER ([a-z_]+) ON ddl_command_end\s+WHEN TAG IN \('CREATE SCHEMA'\)\s+EXECUTE FUNCTION ([a-z_]+)\.([a-z_]+)\(\);$/.exec(failure.command.trim());
	return command !== null && command[1] === name && command[3] === name && PLATFORM_FUNCTION_SCHEMAS.includes(command[2]);
}

interface OpenFailure {
	object: string | null;
	message: string;
	command: string | null;
}

/** Split `schema.table` as the tools print it. A dot in a schema name is not supported. */
function qualified(name: string): { schema: string; table: string } {
	const dot = name.indexOf('.');
	return dot < 0 ? { schema: '', table: name } : { schema: name.slice(0, dot), table: name.slice(dot + 1) };
}

export class ToolLog {
	private readonly all: OpenFailure[] = [];
	private current: OpenFailure | null = null;
	private continuing: 'message' | 'command' | null = null;
	/** The entry the next error belongs to: `from TOC entry` comes just before it. */
	private entry: string | null = null;

	/** Read one line of stderr. Returns what it means, or null for a line that only continues. */
	push(raw: string): ToolLogEvent | null {
		const line = raw.replace(/\r$/, '');
		const match = PREFIXED.exec(line);
		if (!match) {
			this.continueWith(line);
			return null;
		}
		const level = match[2];
		const text = match[3];

		if (level === 'error') {
			this.current = { object: this.entry, message: text, command: null };
			this.all.push(this.current);
			this.continuing = 'message';
			this.entry = null;
			return { kind: 'error' };
		}
		if (level === 'detail' || level === 'hint') {
			if (this.current) {
				const command = /^(?:Command|Query) was: (.*)$/.exec(text);
				if (command) {
					this.current.command = command[1];
					this.continuing = 'command';
				} else {
					this.current.message += `\n${text}`;
					this.continuing = 'message';
				}
			}
			return null;
		}
		this.continuing = null;
		if (level === 'warning') {
			const ignored = /errors ignored on restore: (\d+)/.exec(text);
			return ignored ? { kind: 'ignored', count: Number(ignored[1]) } : null;
		}

		// The last word is the owner, which is "(no owner)" for an extension: measured against a
		// hosted project, where `(.+) \S+` read the entry as "EXTENSION vector (no".
		const entry = /^from TOC entry \d+; \d+ \d+ (.+?) (?:\(no owner\)|\S+)$/.exec(text);
		if (entry) {
			this.entry = entry[1];
			return null;
		}
		const creating = /^creating (.+?) "(.+)"$/.exec(text);
		if (creating) {
			return { kind: 'creating', desc: creating[1], object: creating[2] };
		}
		const data = /^processing data for table "(.+)"$/.exec(text);
		if (data) {
			return { kind: 'data', ...qualified(data[1]) };
		}
		return null;
	}

	private continueWith(line: string): void {
		if (!this.current || this.continuing === null) {
			return;
		}
		// Before PG 16 the statement came on its own unprefixed line.
		const command = /^Command was: (.*)$/.exec(line);
		if (command && this.continuing === 'message') {
			this.current.command = command[1];
			this.continuing = 'command';
			return;
		}
		if (this.continuing === 'command') {
			this.current.command = `${this.current.command ?? ''}\n${line}`;
		} else if (line.trim() !== '') {
			this.current.message += `\n${line}`;
		}
	}

	/**
	 * The failures, with any password in a statement or a message redacted. `harmless` is decided
	 * on the text as printed, before redaction, so redacting can only make a failure count, never
	 * hide one.
	 */
	failures(): RestoreFailure[] {
		return this.all.map((failure) => ({
			object: failure.object,
			message: redactSecrets(failure.message.trim()),
			command: failure.command === null ? null : redactSecrets(failure.command.trim()),
			harmless: harmless(failure)
		}));
	}
}

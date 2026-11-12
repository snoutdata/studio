/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Half a JSON document, read as far as it goes.
//
// A tool call's arguments stream in pieces (`readChatStream`'s `onToolDelta`), and a surface that
// shows a function being written wants the files while they are still arriving: the name as soon
// as it is there, each file's path, and its content up to the last character sent. JSON.parse
// refuses all of that until the last brace, so this reads a prefix instead:
//
//   * a string cut off mid-way is its text so far (an escape cut in half is left out until the rest
//     arrives);
//   * an object or array cut off is what it held so far, and a key with no value yet is left out;
//   * a number, `true`, `false` or `null` at the very end is left out, since it may still grow;
//   * anything malformed stops the read where it went wrong, keeping what came before.
//
// Which objects and arrays were CLOSED is reported too, so a file whose object ended is known to
// be whole.

interface Reader {
	text: string;
	at: number;
	closed: WeakSet<object>;
}

/** Nothing usable here yet (a number at the end, a literal cut short, or malformed input). */
const NOTHING = Symbol('nothing');

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function space(r: Reader): void {
	while (r.at < r.text.length && /\s/.test(r.text[r.at])) {
		r.at++;
	}
}

/** A string starting at the opening quote. `complete` is false when the text ran out inside it. */
function readString(r: Reader): { value: string; complete: boolean } {
	r.at++;
	let value = '';
	while (r.at < r.text.length) {
		const c = r.text[r.at];
		if (c === '"') {
			r.at++;
			return { value, complete: true };
		}
		if (c === '\\') {
			const next = r.text[r.at + 1];
			if (next === undefined) {
				break;
			}
			if (next === 'u') {
				const hex = r.text.slice(r.at + 2, r.at + 6);
				if (hex.length < 4) {
					break;
				}
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
					r.at = r.text.length;
					break;
				}
				value += String.fromCharCode(parseInt(hex, 16));
				r.at += 6;
				continue;
			}
			value += ESCAPES[next] ?? next;
			r.at += 2;
			continue;
		}
		value += c;
		r.at++;
	}
	r.at = r.text.length;
	return { value, complete: false };
}

function readScalar(r: Reader): unknown {
	const rest = r.text.slice(r.at);
	const match = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(rest);
	if (!match) {
		r.at = r.text.length;
		return NOTHING;
	}
	r.at += match[0].length;
	// At the very end it may not be finished: `12` may be `123`, `nul` is not `null` yet.
	if (r.at >= r.text.length) {
		return NOTHING;
	}
	return JSON.parse(match[0]) as unknown;
}

function readValue(r: Reader): unknown {
	space(r);
	if (r.at >= r.text.length) {
		return NOTHING;
	}
	const c = r.text[r.at];
	if (c === '{') {
		return readObject(r);
	}
	if (c === '[') {
		return readArray(r);
	}
	if (c === '"') {
		return readString(r).value;
	}
	return readScalar(r);
}

function readObject(r: Reader): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	r.at++;
	for (;;) {
		space(r);
		if (r.at >= r.text.length) {
			return out;
		}
		if (r.text[r.at] === '}') {
			r.at++;
			r.closed.add(out);
			return out;
		}
		if (r.text[r.at] !== '"') {
			r.at = r.text.length;
			return out;
		}
		const key = readString(r);
		if (!key.complete) {
			return out;
		}
		space(r);
		if (r.text[r.at] !== ':') {
			r.at = r.text.length;
			return out;
		}
		r.at++;
		const value = readValue(r);
		if (value !== NOTHING) {
			out[key.value] = value;
		}
		space(r);
		if (r.text[r.at] === ',') {
			r.at++;
		} else if (r.text[r.at] !== '}') {
			r.at = r.text.length;
			return out;
		}
	}
}

function readArray(r: Reader): unknown[] {
	const out: unknown[] = [];
	r.at++;
	for (;;) {
		space(r);
		if (r.at >= r.text.length) {
			return out;
		}
		if (r.text[r.at] === ']') {
			r.at++;
			r.closed.add(out);
			return out;
		}
		const value = readValue(r);
		if (value !== NOTHING) {
			out.push(value);
		}
		space(r);
		if (r.text[r.at] === ',') {
			r.at++;
		} else if (r.text[r.at] !== ']') {
			r.at = r.text.length;
			return out;
		}
	}
}

/** Read a JSON prefix. `closed` holds every object and array whose closing bracket has arrived. */
export function parsePartialJson(text: string): { value: unknown; closed: WeakSet<object> } {
	const r: Reader = { text, at: 0, closed: new WeakSet() };
	const value = readValue(r);
	return { value: value === NOTHING ? undefined : value, closed: r.closed };
}

/** A file of a function as it is being written. */
export interface PartialFile {
	path: string;
	content: string;
	/** Its object has closed: the content is whole. */
	complete: boolean;
}

/** `deploy_function`'s arguments as far as they have arrived. */
export interface PartialFunction {
	/** The name so far (it may still grow until `nameComplete`). */
	name: string;
	nameComplete: boolean;
	entrypoint?: string;
	files: PartialFile[];
	/** The whole argument object has closed. */
	complete: boolean;
}

/**
 * `{"name": .., "files": [{"path": .., "content": ..}], ...}` read from half its text: what a
 * function editor shows while the model writes. A file appears once its path has started.
 */
export function partialFunctionArgs(text: string): PartialFunction {
	const { value, closed } = parsePartialJson(text);
	const args = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const name = typeof args.name === 'string' ? args.name : '';
	// The name is whole once anything after it has started, or the object closed.
	const keys = Object.keys(args);
	const nameComplete = typeof args.name === 'string' && (keys.indexOf('name') < keys.length - 1 || closed.has(args));
	const files: PartialFile[] = [];
	for (const raw of Array.isArray(args.files) ? args.files : []) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			continue;
		}
		const f = raw as Record<string, unknown>;
		if (typeof f.path !== 'string') {
			continue;
		}
		const content = typeof f.content === 'string' ? f.content : typeof f.text === 'string' ? f.text : '';
		files.push({ path: f.path, content, complete: closed.has(f) });
	}
	return {
		name,
		nameComplete,
		entrypoint: typeof args.entrypoint === 'string' ? args.entrypoint : undefined,
		files,
		complete: closed.has(args)
	};
}

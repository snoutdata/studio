/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  A small, tolerant SQL tokenizer.
 *
 *  Why this and not the masking scan: masking blanks the CONTENT of quoted identifiers, which
 *  is exactly what a reviewer needs to read (`ALTER TABLE "orders" DROP COLUMN "ship_date"`).
 *  Masking stays the right tool for finding statement boundaries and paren depth in raw text;
 *  reading structure out of a statement wants tokens.
 *
 *  Tolerant on purpose. It never throws, an unterminated literal runs to end of input, and
 *  anything it does not recognise comes back as punctuation. SQL in a pull request is often
 *  half-written, vendor-specific, or templated by a migration tool, and a reviewer that falls
 *  over on the first surprise reviews nothing.
 *--------------------------------------------------------------------------------------------*/

export type TokenType = 'ident' | 'string' | 'number' | 'punct' | 'param';

export interface Token {
	type: TokenType;
	/** For `ident`, the identifier with its quoting removed. For `string`, the literal's text. */
	value: string;
	/** `value` uppercased — every keyword comparison in the parser goes through this. */
	upper: string;
	/** True when the identifier was written quoted, so it is a name and never a keyword. */
	quoted: boolean;
	start: number;
	end: number;
	/** Paren nesting depth AT the token (the `(` itself carries the outer depth). */
	depth: number;
}

const PUNCT3 = ['->>'];
const PUNCT2 = ['<=', '>=', '<>', '!=', '||', '::', '->', ':=', '|/', '!!'];

function isIdentStart(c: string): boolean {
	return /[A-Za-z_#@]/.test(c) || c.charCodeAt(0) > 127;
}

function isIdentPart(c: string): boolean {
	return /[A-Za-z0-9_$#@]/.test(c) || c.charCodeAt(0) > 127;
}

/** Tokenize `sql`. Comments are dropped; every other character lands in a token. */
export function tokenize(sql: string): Token[] {
	const out: Token[] = [];
	let depth = 0;
	let i = 0;

	const push = (type: TokenType, value: string, start: number, end: number, quoted = false): void => {
		out.push({ type, value, upper: value.toUpperCase(), quoted, start, end, depth });
	};

	while (i < sql.length) {
		const c = sql[i];

		if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f') {
			i++;
			continue;
		}
		if (c === '-' && sql[i + 1] === '-') {
			while (i < sql.length && sql[i] !== '\n') {
				i++;
			}
			continue;
		}
		if (c === '/' && sql[i + 1] === '*') {
			const close = sql.indexOf('*/', i + 2);
			i = close === -1 ? sql.length : close + 2;
			continue;
		}

		// Quoted identifiers. `[` is SQL Server; `"` is the standard; backtick is MySQL.
		if (c === '"' || c === '`' || c === '[') {
			const closer = c === '[' ? ']' : c;
			const start = i;
			i++;
			let value = '';
			while (i < sql.length) {
				if (sql[i] === closer) {
					if (closer !== ']' && sql[i + 1] === closer) {
						value += closer; // a doubled quote escapes itself
						i += 2;
						continue;
					}
					i++;
					break;
				}
				value += sql[i];
				i++;
			}
			push('ident', value, start, i, true);
			continue;
		}

		// String literals, including the E'' / N'' / X'' prefixes and $$dollar quoting$$.
		if (c === "'") {
			const start = i;
			i++;
			let value = '';
			while (i < sql.length) {
				if (sql[i] === '\\' && i + 1 < sql.length) {
					value += sql[i + 1];
					i += 2;
					continue;
				}
				if (sql[i] === "'") {
					if (sql[i + 1] === "'") {
						value += "'";
						i += 2;
						continue;
					}
					i++;
					break;
				}
				value += sql[i];
				i++;
			}
			push('string', value, start, i);
			continue;
		}
		if (c === '$') {
			// Postgres dollar quoting: $tag$ ... $tag$ (used by every function body).
			const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
			if (tag) {
				const start = i;
				const close = sql.indexOf(tag[0], i + tag[0].length);
				const end = close === -1 ? sql.length : close + tag[0].length;
				push('string', sql.slice(i + tag[0].length, close === -1 ? sql.length : close), start, end);
				i = end;
				continue;
			}
		}

		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
			const start = i;
			while (i < sql.length && /[0-9.eE]/.test(sql[i])) {
				// An exponent's sign is part of the number; a following '-' is an operator.
				if ((sql[i] === 'e' || sql[i] === 'E') && /[+-]/.test(sql[i + 1] ?? '')) {
					i++;
				}
				i++;
			}
			push('number', sql.slice(start, i), start, i);
			continue;
		}

		// Bind parameters, in every shape a migration tool emits: ?, $1, :name, @name.
		if (c === '?' || (c === '$' && /[0-9]/.test(sql[i + 1] ?? '')) || (c === ':' && isIdentStart(sql[i + 1] ?? ''))) {
			const start = i;
			i++;
			while (i < sql.length && isIdentPart(sql[i])) {
				i++;
			}
			push('param', sql.slice(start, i), start, i);
			continue;
		}

		if (isIdentStart(c)) {
			const start = i;
			while (i < sql.length && isIdentPart(sql[i])) {
				i++;
			}
			push('ident', sql.slice(start, i), start, i);
			continue;
		}

		if (c === '(') {
			push('punct', c, i, i + 1);
			depth++;
			i++;
			continue;
		}
		if (c === ')') {
			depth = Math.max(0, depth - 1);
			push('punct', c, i, i + 1);
			i++;
			continue;
		}

		const three = sql.slice(i, i + 3);
		if (PUNCT3.includes(three)) {
			push('punct', three, i, i + 3);
			i += 3;
			continue;
		}
		const two = sql.slice(i, i + 2);
		if (PUNCT2.includes(two)) {
			push('punct', two, i, i + 2);
			i += 2;
			continue;
		}
		push('punct', c, i, i + 1);
		i++;
	}

	return out;
}

/** A dotted name starting at `i`, e.g. `sales.orders` or `"public"."users"`, with the index of
 *  the token after it. Returns an empty name when `i` is not on an identifier. */
export function readQualifiedName(tokens: Token[], i: number): { name: string; parts: string[]; next: number } {
	const parts: string[] = [];
	let at = i;
	while (at < tokens.length && tokens[at].type === 'ident') {
		parts.push(tokens[at].value);
		at++;
		if (at < tokens.length && tokens[at].type === 'punct' && tokens[at].value === '.') {
			at++;
			continue;
		}
		break;
	}
	return { name: parts.join('.'), parts, next: at };
}

/** The last segment of a dotted name — the object's own name, without its schema. */
export function bareName(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot === -1 ? name : name.slice(dot + 1);
}

/** Index of the first token matching `word` at paren depth `depth`, at or after `from`. */
export function findKeyword(tokens: Token[], word: string, from = 0, depth = 0): number {
	for (let i = from; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.depth === depth && t.type === 'ident' && !t.quoted && t.upper === word) {
			return i;
		}
	}
	return -1;
}

/** True when the tokens at `i` are the given keyword sequence (unquoted, case-insensitive). */
export function matches(tokens: Token[], i: number, ...words: string[]): boolean {
	return words.every((w, k) => {
		const t = tokens[i + k];
		return !!t && t.type === 'ident' && !t.quoted && t.upper === w;
	});
}

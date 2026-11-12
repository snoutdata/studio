/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePartialJson, partialFunctionArgs } from './partial.ts';

const WHOLE = JSON.stringify({
	name: 'send-mail',
	files: [
		{ path: 'index.ts', content: 'import { mail } from "./mail.ts";\nDeno.serve(() => new Response("ok \\u00e9"));\n' },
		{ path: 'mail.ts', content: 'export const mail = 1;\n' }
	],
	summary: 'Sends mail'
});

test('a whole document reads as JSON.parse reads it', () => {
	assert.deepEqual(parsePartialJson(WHOLE).value, JSON.parse(WHOLE));
	assert.deepEqual(parsePartialJson('[1, 2.5, true, null, "x"] ').value, [1, 2.5, true, null, 'x']);
});

test('every prefix reads without throwing, and never invents text', () => {
	const full = JSON.parse(WHOLE) as { name: string; files: Array<{ path: string; content: string }> };
	for (let i = 0; i <= WHOLE.length; i++) {
		const partial = partialFunctionArgs(WHOLE.slice(0, i));
		assert.ok(full.name.startsWith(partial.name), `name at ${i}`);
		partial.files.forEach((file, n) => {
			assert.ok(full.files[n].path.startsWith(file.path), `path at ${i}`);
			assert.ok(full.files[n].content.startsWith(file.content), `content at ${i}: ${JSON.stringify(file.content)}`);
		});
	}
});

test('the files fill in as they stream, and a closed file is whole', () => {
	const cut = WHOLE.indexOf('export const');
	const partial = partialFunctionArgs(WHOLE.slice(0, cut + 6));
	assert.equal(partial.name, 'send-mail');
	assert.equal(partial.nameComplete, true);
	assert.equal(partial.files.length, 2);
	assert.equal(partial.files[0].complete, true);
	assert.equal(partial.files[1].path, 'mail.ts');
	assert.equal(partial.files[1].content, 'export');
	assert.equal(partial.files[1].complete, false);
	assert.equal(partial.complete, false);
	assert.equal(partialFunctionArgs(WHOLE).complete, true);
});

test('a name still arriving is not yet complete', () => {
	const partial = partialFunctionArgs('{"name":"send-ma');
	assert.equal(partial.name, 'send-ma');
	assert.equal(partial.nameComplete, false);
	assert.deepEqual(partial.files, []);
});

test('an escape cut in half waits for the rest', () => {
	assert.equal(partialFunctionArgs('{"files":[{"path":"a.ts","content":"x\\').files[0].content, 'x');
	assert.equal(partialFunctionArgs('{"files":[{"path":"a.ts","content":"x\\u00').files[0].content, 'x');
	assert.equal(partialFunctionArgs('{"files":[{"path":"a.ts","content":"x\\n').files[0].content, 'x\n');
});

test('a number or literal at the end is left out until it is finished', () => {
	assert.deepEqual(parsePartialJson('{"a":1').value, {});
	assert.deepEqual(parsePartialJson('{"a":12,').value, { a: 12 });
	assert.deepEqual(parsePartialJson('{"a":nul').value, {});
});

test('malformed input keeps what came before', () => {
	assert.deepEqual(parsePartialJson('{"a":"b", oops').value, { a: 'b' });
	assert.equal(parsePartialJson('').value, undefined);
	assert.deepEqual(partialFunctionArgs('not json'), { name: '', nameComplete: false, entrypoint: undefined, files: [], complete: false });
});

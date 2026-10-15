/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { describeCatalogName, emptyCatalog, findCatalogEntry, splitCombinator, type DialectCatalog } from './catalog';

const catalog: DialectCatalog = {
	...emptyCatalog('clickhouse'),
	functions: [
		{ name: 'sum', aggregate: true, syntax: 'sum(num)', description: 'Calculates the sum.', arguments: '- `num`', returns: 'The sum.', examples: 'SELECT sum(x)' },
		{ name: 'sumCount', aggregate: true, description: 'Counts and sums at once.' },
		{ name: 'toString', description: 'Casts to a String.' },
		{ name: 'CAST', aliasTo: 'cast' },
	],
	combinators: [
		{ name: 'If', description: 'Takes an extra condition argument.' },
		{ name: 'State', description: 'Keeps the intermediate state.' },
		{ name: 'Or', description: 'Not a real one, here to be the wrong answer.' },
		{ name: 'OrDefault', description: 'Gives the default when there is nothing to aggregate.' },
	],
	dataTypes: [{ name: 'UInt64', description: 'An unsigned 64-bit integer.' }],
	settings: [{ name: 'max_threads', value: '8', valueType: 'MaxThreads', description: 'How many threads.', tier: 'Beta' }],
	formats: [{ name: 'Pretty', output: true }],
};

describe('looking a name up in the engine catalog', () => {
	test('a name is found whatever its case', () => {
		assert.equal(findCatalogEntry(catalog, 'function', 'TOSTRING')?.name, 'toString');
		assert.equal(findCatalogEntry(catalog, 'function', 'nothing')?.name, undefined);
	});

	test('a function reads as what it is, with the server\'s own argument list and example', () => {
		const doc = describeCatalogName(catalog, 'function', 'sum') ?? '';
		assert.match(doc, /\*\*sum\*\* \(aggregate function\)/);
		assert.match(doc, /`sum\(num\)`/);
		assert.match(doc, /Calculates the sum\\\./);
		assert.match(doc, /\*\*Arguments\*\*/);
		assert.match(doc, /\*\*Returns\*\*/);
		assert.match(doc, /\*\*Example\*\*/);
	});

	test('a setting says its value, its type and that it is not production', () => {
		const doc = describeCatalogName(catalog, 'setting', 'max_threads') ?? '';
		assert.match(doc, /Current value `8`/);
		assert.match(doc, /\*\*Beta\*\*/);
	});

	test('a name the engine has never heard of is undefined, so the caller keeps looking', () => {
		assert.equal(describeCatalogName(catalog, 'function', 'notAFunction'), undefined);
	});
});

// A combinator variant is built by the parser, not declared: `sumIf` is in no system table, so the
// only way to describe one is to take it apart.
describe('an aggregate wearing combinators', () => {
	test('is split into the aggregate and the suffixes', () => {
		const split = splitCombinator(catalog, 'sumIfState');
		assert.equal(split?.base.name, 'sum');
		assert.deepEqual(split?.combinators.map((c) => c.name), ['If', 'State']);
	});

	// `sum` and `sumCount` are both aggregates, so `sumCountIf` has two readings and only one of
	// them is right: the longest base wins.
	test('the longest aggregate wins, so sumCountIf is not sum + CountIf', () => {
		assert.equal(splitCombinator(catalog, 'sumCountIf')?.base.name, 'sumCount');
	});

	// The same for the suffix: `Or` before `OrDefault` would leave a `Default` that is not one.
	test('the longest combinator wins, so sumOrDefault is not sum + Or + Default', () => {
		assert.deepEqual(splitCombinator(catalog, 'sumOrDefault')?.combinators.map((c) => c.name), ['OrDefault']);
	});

	test('a tail that is not a chain of combinators is not a variant at all', () => {
		assert.equal(splitCombinator(catalog, 'sumNonsense'), undefined);
		assert.equal(splitCombinator(catalog, 'toString'), undefined);
	});

	test('it is described as the aggregate plus what each combinator does', () => {
		const doc = describeCatalogName(catalog, 'function', 'sumIf') ?? '';
		assert.match(doc, /`sum` with the `If` combinator/);
		assert.match(doc, /Takes an extra condition argument\\\./);
		assert.match(doc, /Calculates the sum\\\./);
	});
});

// The catalog is the SERVER's text: a server, or a user who can set a setting or create a
// function, decides it. Monaco renders hover as markdown with images, so none of it may be markup.
describe('catalog text is shown as text', () => {
	const IMAGE = '![x](http://evil.example/x.png)';
	const hostile: DialectCatalog = {
		...emptyCatalog('clickhouse'),
		functions: [{ name: 'f', aggregate: true, syntax: 'f`' + IMAGE, description: IMAGE, arguments: IMAGE, returns: IMAGE, examples: 'SELECT 1\n' + IMAGE, aliasTo: 'g`' + IMAGE }],
		combinators: [{ name: 'If', description: IMAGE }],
		settings: [{ name: 's', value: 'a` ' + IMAGE + ' `b', valueType: 'T`' + IMAGE, description: IMAGE, tier: IMAGE }],
	};
	const unescapedImage = /(^|[^\\`])!\[x\]\(/;

	function outsideCode(doc: string): string {
		// What is inside a code span is literal; strip the spans so only the rest is checked.
		return doc.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, '');
	}

	test('a function\'s description, arguments, result and example are escaped', () => {
		for (const name of ['f', 'fIf']) {
			const doc = describeCatalogName(hostile, 'function', name) ?? '';
			assert.ok(doc.length > 0, name);
			assert.doesNotMatch(outsideCode(doc), unescapedImage, doc);
		}
	});

	test('a setting\'s value cannot close its code span', () => {
		const doc = describeCatalogName(hostile, 'setting', 's') ?? '';
		assert.ok(doc.includes('``a` ' + IMAGE + ' `b``'), doc);
		assert.doesNotMatch(outsideCode(doc), unescapedImage, doc);
	});

	test('an example keeps its lines and its indentation, as text', () => {
		const doc = describeCatalogName({ ...catalog, functions: [{ name: 'g', examples: 'SELECT sum(x)\n    FROM t' }] }, 'function', 'g') ?? '';
		assert.ok(doc.includes('SELECT sum\\(x\\)  \n\u00a0\u00a0\u00a0\u00a0FROM t'), doc);
	});
});

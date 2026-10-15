/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { blocksFromMarkdown, chartBlocks, jsonBlocks, proseOnly, sqlBlocks } from './renderBlocks';

/*
 * The coverage these parsers never had while they were private to ChatPanel.tsx.
 * They are what decides whether an agent's markdown becomes a SQL card with a Run button or a wall
 * of monospace, so they are worth pinning.
 */

const CHART = JSON.stringify({ type: 'bar', x: 'day', series: [{ key: 'hits' }], data: [{ day: 'Mon', hits: 3 }] });

describe('renderBlocks', () => {
	test('a reply with no fences is one prose block', () => {
		assert.deepEqual(blocksFromMarkdown('Just a sentence.'), [{ kind: 'prose', text: 'Just a sentence.' }]);
	});

	test('blocks come back in DOCUMENT ORDER, not grouped by kind', () => {
		// The bug this replaced: prose, then every SQL, then every chart, so "first do X, then do Y"
		// rendered as both sentences followed by both queries.
		const text = 'First:\n```sql\nselect 1;\n```\nThen:\n```sql\nselect 2;\n```\nDone.';
		assert.deepEqual(blocksFromMarkdown(text).map((b) => b.kind), ['prose', 'sql', 'prose', 'sql', 'prose']);
		assert.deepEqual(sqlBlocks(text), ['select 1;', 'select 2;']);
	});

	test('an unterminated fence stays in the prose instead of swallowing the reply', () => {
		const text = 'Careful:\n```sql\nselect 1;\nand then some more words';
		const blocks = blocksFromMarkdown(text);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0].kind, 'prose');
		assert.equal(sqlBlocks(text).length, 0);
	});

	test('a json fence is a pipeline only on a document backend', () => {
		const text = 'Try:\n```json\n[{"$match":{"a":1}}]\n```';
		// SQL connection: it is an ordinary code block, so it must survive INSIDE the prose.
		const asSql = blocksFromMarkdown(text);
		assert.deepEqual(asSql.map((b) => b.kind), ['prose']);
		assert.match((asSql[0] as { text: string }).text, /\$match/);
		// Document connection: it becomes its own card.
		assert.deepEqual(blocksFromMarkdown(text, { pipeline: true }).map((b) => b.kind), ['prose', 'pipeline']);
		assert.deepEqual(jsonBlocks(text), ['[{"$match":{"a":1}}]']);
	});

	test('a malformed chart becomes an error block rather than throwing', () => {
		const blocks = blocksFromMarkdown('Look:\n```chart\n{not json\n```');
		assert.deepEqual(blocks.map((b) => b.kind), ['prose', 'chartError']);
		assert.match((blocks[1] as { error: string }).error, /JSON/);
	});

	test('a valid chart block parses into a spec', () => {
		const blocks = blocksFromMarkdown(`\`\`\`chart\n${CHART}\n\`\`\``);
		assert.deepEqual(blocks.map((b) => b.kind), ['chart']);
		assert.equal(chartBlocks(`\`\`\`chart\n${CHART}\n\`\`\``).length, 1);
	});

	test('proseOnly drops the cards and keeps the words, in order', () => {
		const text = `Before.\n\`\`\`sql\nselect 1;\n\`\`\`\nAfter.\n\`\`\`chart\n${CHART}\n\`\`\`\nEnd.`;
		assert.equal(proseOnly(text), 'Before.\n\nAfter.\n\nEnd.');
	});

	test('proseOnly keeps a json fence unless the backend is a document one', () => {
		const text = 'See:\n```json\n{"a":1}\n```';
		assert.match(proseOnly(text), /"a":1/);
		assert.equal(proseOnly(text, true), 'See:');
	});

	test('the fence tag is matched case-insensitively, and indentation inside is kept', () => {
		const text = '```SQL\nselect\n\tone\n```';
		assert.deepEqual(sqlBlocks(text), ['select\n\tone']);
	});

	test('a reply that is nothing but a fence has no empty prose block around it', () => {
		assert.deepEqual(blocksFromMarkdown('```sql\nselect 1;\n```').map((b) => b.kind), ['sql']);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DECLINED, answersFor, decide, emptyGrants, gatedRunner } from './grants.ts';
import type { ProposalAnswer, ProposalCard, ToolDefinition } from './types.ts';

function def(name: string, mutates: boolean, alwaysAsk?: ToolDefinition['alwaysAsk']): ToolDefinition {
	return { spec: { name, description: name, parameters: {} }, domain: 'test', mutates, alwaysAsk };
}

const read = def('list_functions', false);
const write = def('set_product', true);
const sql = def('apply_sql', true, (args) => (String(args.sql).startsWith('drop') ? 'destructive' : null));
const off = { production: false };

describe('decide', () => {
	test('a read runs without asking, even on production', () => {
		assert.equal(decide(read, {}, emptyGrants(), { production: true }), 'run');
	});
	test('a write asks until it is allowed', () => {
		const grants = emptyGrants();
		assert.equal(decide(write, {}, grants, off), 'ask');
		grants.chat.add('set_product');
		assert.equal(decide(write, {}, grants, off), 'run');
		assert.equal(decide(write, {}, emptyGrants(['set_product']), off), 'run');
	});
	test('a grant never covers destructive SQL or production', () => {
		const grants = emptyGrants(['apply_sql', 'set_product']);
		assert.equal(decide(sql, { sql: 'create table t()' }, grants, off), 'run');
		assert.equal(decide(sql, { sql: 'drop table t' }, grants, off), 'ask');
		assert.equal(decide(write, {}, grants, { production: true }), 'ask');
	});
	test('a call that always asks offers only once and dismiss', () => {
		assert.deepEqual(answersFor(sql, { sql: 'drop table t' }, off), ['once', 'dismiss']);
		assert.deepEqual(answersFor(write, {}, off), ['once', 'chat', 'always', 'dismiss']);
	});
});

describe('gatedRunner', () => {
	function runner(answer: ProposalAnswer, always: string[] = []) {
		const cards: ProposalCard[] = [];
		const ran: string[] = [];
		const stored: string[] = [];
		const grants = emptyGrants(always);
		const run = gatedRunner({
			tools: new Map([read, write, sql].map((t) => [t.spec.name, t])),
			grants,
			context: () => off,
			card: (call) => ({ title: call.name }),
			ask: async (card) => {
				cards.push(card);
				return answer;
			},
			onAlways: (tool) => {
				stored.push(tool);
			},
			run: async (call) => {
				ran.push(call.name);
				return { callId: call.id, content: 'ok' };
			}
		});
		return { run, cards, ran, stored, grants };
	}

	test('dismiss runs nothing and tells the model', async () => {
		const r = runner('dismiss');
		const result = await r.run({ id: '1', name: 'set_product', arguments: {} });
		assert.equal(result.content, DECLINED);
		assert.deepEqual(r.ran, []);
	});
	test('allow for this chat asks once', async () => {
		const r = runner('chat');
		await r.run({ id: '1', name: 'set_product', arguments: {} });
		await r.run({ id: '2', name: 'set_product', arguments: {} });
		assert.equal(r.cards.length, 1);
		assert.deepEqual(r.ran, ['set_product', 'set_product']);
	});
	test('always allow is stored', async () => {
		const r = runner('always');
		await r.run({ id: '1', name: 'set_product', arguments: {} });
		assert.deepEqual(r.stored, ['set_product']);
	});
	test('an answer the card did not offer is a no', async () => {
		const r = runner('always');
		const result = await r.run({ id: '1', name: 'apply_sql', arguments: { sql: 'drop table t' } });
		assert.equal(result.content, DECLINED);
		assert.equal(r.cards[0].askedBecause, 'destructive');
	});
	test('an unknown tool and a throwing tool are results, not exceptions', async () => {
		const r = runner('once');
		assert.equal((await r.run({ id: '1', name: 'nope', arguments: {} })).isError, true);
		const failing = gatedRunner({
			tools: new Map([[read.spec.name, read]]),
			grants: emptyGrants(),
			context: () => off,
			card: () => ({ title: '' }),
			ask: async () => 'once',
			run: async () => {
				throw new Error('boom');
			}
		});
		const result = await failing({ id: '1', name: 'list_functions', arguments: {} });
		assert.equal(result.isError, true);
		assert.match(result.content, /boom/);
	});
});

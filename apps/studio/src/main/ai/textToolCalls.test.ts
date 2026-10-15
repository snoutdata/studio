/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolMarkupStream, hasToolMarkup, parseJsonToolCalls, parseNaturalLanguageToolCalls, parseTextToolCalls, stripToolMarkup } from './textToolCalls';

describe('parseTextToolCalls', () => {
	test('parses a plain <invoke>/<parameter> block', () => {
		const text = '<invoke name="run_query"><parameter name="sql">SELECT 1</parameter></invoke>';
		const calls = parseTextToolCalls(text);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].name, 'run_query');
		assert.equal(calls[0].arguments.sql, 'SELECT 1');
	});

	test('tolerates a namespace prefix and an extra attribute', () => {
		const text = '<ns:invoke name="run_query"><ns:parameter name="sql" string="true">SELECT MAX(d) FROM t</ns:parameter></ns:invoke>';
		const calls = parseTextToolCalls(text);
		assert.equal(calls[0].name, 'run_query');
		assert.equal(calls[0].arguments.sql, 'SELECT MAX(d) FROM t');
	});

	test('decodes entities and reads multiple parameters', () => {
		const text = '<invoke name="t"><parameter name="a">x &lt; y</parameter><parameter name="b">&amp;z</parameter></invoke>';
		const [call] = parseTextToolCalls(text);
		assert.equal(call.arguments.a, 'x < y');
		assert.equal(call.arguments.b, '&z');
	});

	test('returns [] when there is no markup', () => {
		assert.deepEqual(parseTextToolCalls('just prose, no tools here'), []);
	});
});

describe('hasToolMarkup / stripToolMarkup', () => {
	test('detects and strips markup from the tail', () => {
		const text = 'Let me check the data.\n<invoke name="run_query"><parameter name="sql">SELECT 1</parameter></invoke>';
		assert.equal(hasToolMarkup(text), true);
		assert.equal(stripToolMarkup(text), 'Let me check the data.');
	});

	test('leaves SQL comparison operators alone', () => {
		assert.equal(hasToolMarkup('WHERE a < b AND c <= d'), false);
		assert.equal(stripToolMarkup('WHERE a < b'), 'WHERE a < b');
	});
});

describe('parseNaturalLanguageToolCalls', () => {
	const names = ['list_tables', 'describe_table', 'search_columns', 'run_query'];

	test('catches the bare `Tool Call: name()` form (small-model favourite)', () => {
		const calls = parseNaturalLanguageToolCalls('Reasoning…\nTool Call: list_tables()', names);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].name, 'list_tables');
		assert.deepEqual(calls[0].arguments, {});
	});

	test('parses JSON args inside the parens', () => {
		const calls = parseNaturalLanguageToolCalls('Tool Call: describe_table({"name": "orders"})', names);
		assert.equal(calls[0].name, 'describe_table');
		assert.equal(calls[0].arguments.name, 'orders');
	});

	test('coerces a bare quoted string to {value}', () => {
		const calls = parseNaturalLanguageToolCalls('Tool: describe_table("orders")', names);
		assert.equal(calls[0].arguments.value, 'orders');
	});

	test('reads `Calling name with {json}` form too', () => {
		const calls = parseNaturalLanguageToolCalls('Calling run_query with {"sql": "SELECT 1"}', names);
		assert.equal(calls[0].name, 'run_query');
		assert.equal(calls[0].arguments.sql, 'SELECT 1');
	});

	test('refuses to match unknown names (avoids false positives in prose)', () => {
		const calls = parseNaturalLanguageToolCalls('Tool Call: do_a_thing()', names);
		assert.deepEqual(calls, []);
	});

	test('returns [] when no allowlist is provided', () => {
		assert.deepEqual(parseNaturalLanguageToolCalls('Tool Call: list_tables()', []), []);
	});
});

describe('parseJsonToolCalls', () => {
	const names = ['list_tables', 'describe_table', 'run_query'];

	test('parses a bare {name, arguments} object (qwen2.5-coder via Ollama)', () => {
		const calls = parseJsonToolCalls('{"name": "list_tables", "arguments": {}}', names);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].name, 'list_tables');
		assert.deepEqual(calls[0].arguments, {});
	});

	test('reads nested object arguments', () => {
		const [call] = parseJsonToolCalls('{"name": "describe_table", "arguments": {"name": "orders"}}', names);
		assert.equal(call.name, 'describe_table');
		assert.equal(call.arguments.name, 'orders');
	});

	test('handles a ```json fence and an OpenAI {function:{…}} shape', () => {
		const fenced = '```json\n{"function": {"name": "run_query", "arguments": "{\\"sql\\": \\"SELECT 1\\"}"}}\n```';
		const [call] = parseJsonToolCalls(fenced, names);
		assert.equal(call.name, 'run_query');
		assert.equal(call.arguments.sql, 'SELECT 1');
	});

	test('parses multiple objects in one turn', () => {
		const calls = parseJsonToolCalls('{"name":"list_tables","arguments":{}} {"tool":"describe_table","arguments":{"name":"t"}}', names);
		assert.equal(calls.length, 2);
		assert.equal(calls[1].name, 'describe_table');
		assert.equal(calls[1].arguments.name, 't');
	});

	test('ignores JSON whose name is not a real tool (avoids false positives)', () => {
		assert.deepEqual(parseJsonToolCalls('{"name": "Alice", "arguments": {}}', names), []);
		assert.deepEqual(parseJsonToolCalls('{"id": 1, "title": "orders"}', names), []);
	});

	test('ignores a data object that merely carries a matching `name` field', () => {
		// A result row whose name equals a tool, but with extra non-arg keys, is not a call.
		assert.deepEqual(parseJsonToolCalls('{"name": "list_tables", "rows": 5, "owner": "dbo"}', names), []);
		// A bare {name} (no other keys) still counts — some models omit empty arguments.
		assert.equal(parseJsonToolCalls('{"name": "list_tables"}', names).length, 1);
	});

	test('does not choke on braces inside JSON strings', () => {
		const [call] = parseJsonToolCalls('{"name":"run_query","arguments":{"sql":"SELECT \'{}\' AS x"}}', names);
		assert.equal(call.arguments.sql, "SELECT '{}' AS x");
	});

	test('returns [] with no allowlist', () => {
		assert.deepEqual(parseJsonToolCalls('{"name":"list_tables","arguments":{}}', []), []);
	});
});

describe('ToolMarkupStream', () => {
	function collect(deltas: string[]): string {
		let out = '';
		const stream = new ToolMarkupStream((t) => { out += t; });
		for (const d of deltas) {
			stream.push(d);
		}
		stream.finish();
		return out;
	}

	function collectWithTools(deltas: string[], names: string[]): string {
		let out = '';
		const stream = new ToolMarkupStream((t) => { out += t; }, names);
		for (const d of deltas) {
			stream.push(d);
		}
		stream.finish();
		return out;
	}

	test('passes ordinary prose through unchanged', () => {
		assert.equal(collect(['Hello ', 'world', '.']), 'Hello world.');
	});

	test('suppresses tool markup, even split across deltas', () => {
		// The opening tag arrives in fragments, mimicking SSE chunking.
		const out = collect(['Looking now.\n', '<inv', 'oke name="run_query">', '<parameter name="sql">SELECT 1</parameter>', '</invoke>']);
		assert.equal(out, 'Looking now.\n');
	});

	test('does not delay SQL with < operators at end of stream', () => {
		assert.equal(collect(['SELECT * FROM t WHERE a < ', '5']), 'SELECT * FROM t WHERE a < 5');
	});

	test('suppresses `<channel|>` chat-template leak (Gemma quirk)', () => {
		const out = collect(['answer text', '<channel|>', 'trailing junk']);
		assert.equal(out, 'answer text');
	});

	const names = ['list_tables', 'describe_table'];

	test('hides a turn-opening JSON tool call (only when tool names are given)', () => {
		const deltas = ['{"name": "list', '_tables", "arg', 'uments": {}}'];
		assert.equal(collectWithTools(deltas, names), '');
		// Without an allowlist the hold is disabled, so the same text streams through verbatim.
		assert.equal(collect(deltas), '{"name": "list_tables", "arguments": {}}');
	});

	test('flushes a leading JSON object that is NOT a tool call', () => {
		const out = collectWithTools(['{"id": 1, ', '"name": "orders"}'], names);
		assert.equal(out, '{"id": 1, "name": "orders"}');
	});

	test('does not hold JSON that appears mid-reply, after prose', () => {
		const out = collectWithTools(['Here is the row: ', '{"name": "list_tables"}'], names);
		assert.equal(out, 'Here is the row: {"name": "list_tables"}');
	});

	test('suppresses a `Tool Call:` + JSON that follows reasoning prose, keeping the prose', () => {
		// The exact qwen2.5-coder shape: reasoning, then a `Tool Call:` line, then a JSON object.
		const out = collectWithTools(
			['Reasoning:\nI will search the schema.', '\n\nTool Call:\n', '{"name": "search_columns", "arguments": {"term": "user"}}'],
			['search_columns', 'list_tables'],
		);
		// Trailing whitespace before the suppressed call is kept (same convention as the <invoke>
		// case); the `Tool Call:` line and its JSON are gone.
		assert.equal(out, 'Reasoning:\nI will search the schema.\n');
	});

	test('suppresses a `Tool Call:` lead-in even when split mid-marker across deltas', () => {
		const out = collectWithTools(['Let me check.\n', 'Tool Ca', 'll:\n{"name": "list_tables"}'], names);
		assert.equal(out, 'Let me check.\n');
	});

	test('keeps a final answer that merely mentions a tool name in prose', () => {
		const out = collectWithTools(['You can call ', 'list_tables to see them.'], names);
		assert.equal(out, 'You can call list_tables to see them.');
	});
});

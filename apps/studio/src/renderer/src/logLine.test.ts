/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightParts, jsonTokens, logShapeOf, logTimeText, matchContext, parseLogLine, prettyJson, segmentsOf, spansDays } from './logLine';

test('a log result is recognised by its clock and its text', () => {
	const shape = logShapeOf([{ name: 'ts' }, { name: 'message' }, { name: 'stream' }, { name: 'id' }, { name: 'ingested_at' }]);
	assert.ok(shape);
	assert.deepEqual(shape, { ts: 0, message: 1, stream: 2, id: 3, ingestedAt: 4, extras: [] });
});

test('a projection that dropped the machinery is still a log result', () => {
	const shape = logShapeOf([{ name: 'ts' }, { name: 'message' }]);
	assert.deepEqual(shape, { ts: 0, message: 1, stream: null, id: null, ingestedAt: null, extras: [] });
});

test('the LINE is the whole requirement: `SELECT message` is still a log result', () => {
	// "Just the lines, please" is a narrower question, not a different one, and answering it with
	// the grid answers it with a worse instrument.
	assert.deepEqual(logShapeOf([{ name: 'message' }]), { ts: null, message: 0, stream: null, id: null, ingestedAt: null, extras: [] });
	assert.deepEqual(logShapeOf([{ name: 'message' }, { name: 'stream' }])?.ts, null);
});

test('a result with no line to read is a table', () => {
	assert.equal(logShapeOf([{ name: 'ts' }, { name: 'stream' }]), null);
});

test('parsed fields land in extras, in result order', () => {
	const shape = logShapeOf([{ name: 'level' }, { name: 'ts' }, { name: 'message' }, { name: 'request_id' }]);
	assert.deepEqual(shape?.extras, [0, 3]);
});

test('an aggregate over anything but the message is a table by its columns alone', () => {
	assert.equal(logShapeOf([{ name: 'level' }, { name: 'count' }]), null);
	assert.equal(logShapeOf([{ name: 'ts' }, { name: 'count' }]), null);
	// …and one that DOES project the message is not distinguishable here, on purpose: the caller
	// asks `QueryCost.grouped`, which is the only thing that actually knows.
	assert.ok(logShapeOf([{ name: 'message' }, { name: 'count' }]));
});

test("Lambda's tab prefix comes off: stamp, request id and level", () => {
	const line = parseLogLine('2026-01-15T08:30:00.125Z\t3f2b6c1e-8a4d-4e7b-9c05-1d2e3f4a5b6c\tINFO\torder handler invoked');
	assert.equal(line.stamp, '2026-01-15T08:30:00.125Z');
	assert.equal(line.correlation, '3f2b6c1e-8a4d-4e7b-9c05-1d2e3f4a5b6c');
	assert.equal(line.level, 'info');
	assert.equal(line.summary, 'order handler invoked');
});

test('a prefix never eats the whole line', () => {
	const line = parseLogLine('ERROR');
	assert.equal(line.level, null);
	assert.equal(line.summary, 'ERROR');
});

test('a space-separated prefix comes off too', () => {
	const line = parseLogLine('2026-01-15 08:30:00.125 WARN  disk is filling up');
	assert.equal(line.stamp, '2026-01-15 08:30:00.125');
	assert.equal(line.level, 'warn');
	assert.equal(line.summary, 'disk is filling up');
});

test('a bracketed level comes off', () => {
	assert.equal(parseLogLine('[ERROR] connection refused').level, 'error');
	assert.equal(parseLogLine('[ERROR] connection refused').summary, 'connection refused');
});

test('lower-case prose is not a level', () => {
	const line = parseLogLine('error handling is the subject of this line');
	assert.equal(line.level, null);
	assert.equal(line.summary, 'error handling is the subject of this line');
});

test('a structured line declares its own level', () => {
	const line = parseLogLine('{"level":"ERROR","msg":"boom"}');
	assert.equal(line.level, 'error');
	assert.equal(line.segments.length, 1);
	assert.equal(line.segments[0].kind, 'json');
});

test('a control line names the invocation it belongs to, and keeps saying so', () => {
	const line = parseLogLine('END RequestId: 3f2b6c1e-8a4d-4e7b-9c05-1d2e3f4a5b6c');
	assert.equal(line.correlation, '3f2b6c1e-8a4d-4e7b-9c05-1d2e3f4a5b6c');
	assert.equal(line.summary, 'END RequestId: 3f2b6c1e-8a4d-4e7b-9c05-1d2e3f4a5b6c');
});

test('an embedded payload is found, and the prose around it kept', () => {
	const line = parseLogLine('2026-01-15T08:30:00.125Z\t3f2b6c1e-8a4d-4e7b-9c05-1d2e3f4a5b6c\tINFO\tParsed event: {\n  "path": "/v1/orders",\n  "httpMethod": "GET"\n}');
	assert.deepEqual(line.segments.map((s) => s.kind), ['text', 'json']);
	assert.equal(line.segments[0].text, 'Parsed event: ');
	assert.deepEqual((line.segments[1] as { value: unknown }).value, { path: '/v1/orders', httpMethod: 'GET' });
	assert.ok(line.expandable);
});

test('a payload with braces inside its strings still balances', () => {
	const segments = segmentsOf('sent {"body":"a } and a { in text","ok":true}');
	assert.deepEqual(segments.map((s) => s.kind), ['text', 'json']);
	assert.deepEqual((segments[1] as { value: unknown }).value, { body: 'a } and a { in text', ok: true });
});

test('an escaped quote does not end the string', () => {
	const segments = segmentsOf('{"q":"he said \\"hi\\"}"}');
	assert.deepEqual(segments.map((s) => s.kind), ['json']);
	assert.deepEqual((segments[0] as { value: unknown }).value, { q: 'he said "hi"}' });
});

test('braces in prose stay prose', () => {
	assert.deepEqual(segmentsOf('use ${VAR} here').map((s) => s.kind), ['text']);
	assert.deepEqual(segmentsOf('unterminated { payload').map((s) => s.kind), ['text']);
});

test('two payloads on one line are both found', () => {
	const segments = segmentsOf('in {"a":1} out {"b":2}');
	assert.deepEqual(segments.map((s) => s.kind), ['text', 'json', 'text', 'json']);
});

test('an array payload is found', () => {
	const segments = segmentsOf('rows [1,2,3]');
	assert.deepEqual(segments.map((s) => s.kind), ['text', 'json']);
});

test('a one-line message with nothing embedded is not expandable', () => {
	assert.equal(parseLogLine('START RequestId: abc Version: $LATEST').expandable, false);
});

test('a message that is nothing but a payload has no prose segment', () => {
	assert.deepEqual(segmentsOf('{"a":1}').map((s) => s.kind), ['json']);
});

test('the summary is one line, whatever the message was', () => {
	const line = parseLogLine('first\n  second\n\tthird');
	assert.equal(line.summary, 'first second third');
	assert.ok(line.expandable);
});

test('a non-string message does not throw', () => {
	assert.equal(parseLogLine(null).summary, '');
	assert.equal(parseLogLine(undefined).summary, '');
	assert.equal(parseLogLine(42).summary, '42');
});

test('the time column spends the date only when the result crosses one', () => {
	const at = new Date(2026, 0, 15, 8, 30, 0, 125).getTime();
	assert.equal(logTimeText(at, false), '08:30:00.125');
	assert.equal(logTimeText(at, true), '2026-01-15 08:30:00.125');
	assert.equal(logTimeText(null, true), '');
});

test('spansDays compares local days, not elapsed time', () => {
	const morning = new Date(2026, 8, 10, 9, 0, 0).getTime();
	const evening = new Date(2026, 8, 10, 23, 0, 0).getTime();
	const nextDay = new Date(2026, 8, 11, 1, 0, 0).getTime();
	assert.equal(spansDays(morning, evening), false);
	assert.equal(spansDays(evening, nextDay), true);
	assert.equal(spansDays(null, evening), false);
});

test('highlight alternates miss and hit, starting with a miss', () => {
	assert.deepEqual(highlightParts('abcABCabc', 'ABC'), ['', 'abc', '', 'ABC', '', 'abc', '']);
	assert.deepEqual(highlightParts('nothing here', 'zzz'), ['nothing here']);
	assert.deepEqual(highlightParts('nothing here', '  '), ['nothing here']);
});

test('a payload is tinted key by key, and reassembles to itself', () => {
	const pretty = prettyJson({ path: '/v1/orders', tries: 3, ok: true, extra: null });
	const tokens = jsonTokens(pretty);
	assert.equal(tokens.map((t) => t.text).join(''), pretty);
	assert.deepEqual(tokens.filter((t) => t.kind === 'key').map((t) => t.text), ['"path"', '"tries"', '"ok"', '"extra"']);
	assert.deepEqual(tokens.filter((t) => t.kind === 'string').map((t) => t.text), ['"/v1/orders"']);
	assert.deepEqual(tokens.filter((t) => t.kind === 'number').map((t) => t.text), ['3']);
	assert.deepEqual(tokens.filter((t) => t.kind === 'atom').map((t) => t.text), ['true', 'null']);
});

test('a colon inside a string value does not make it a key', () => {
	const tokens = jsonTokens(prettyJson({ url: 'https://x/y' }));
	assert.deepEqual(tokens.filter((t) => t.kind === 'key').map((t) => t.text), ['"url"']);
	assert.deepEqual(tokens.filter((t) => t.kind === 'string').map((t) => t.text), ['"https://x/y"']);
});

/*
 * The other two vendors. Neither writes a line of text: Azure serialises a whole Log Analytics row
 * into `message`, and Cloud Logging serialises a `jsonPayload` (and folds even a plain text line
 * into `{severity, textPayload}`). Left alone, those arrive as a JSON blob on every row.
 */

test('GCP: a text entry reads as its text, and the severity becomes the badge', () => {
	const line = parseLogLine(JSON.stringify({ severity: 'INFO', textPayload: 'listening on 8080' }));
	assert.equal(line.level, 'info');
	assert.equal(line.summary, 'listening on 8080');
});

test('GCP: a structured entry leads with its message and keeps the scalars beside it', () => {
	const line = parseLogLine(JSON.stringify({ severity: 'ERROR', message: 'upstream failed', httpRequest: { status: 502 }, trace: 'abc123' }));
	assert.equal(line.level, 'error');
	// The nested request is NOT on the line (it is one click away, pretty-printed).
	assert.equal(line.summary, 'upstream failed trace=abc123');
	assert.ok(line.expandable);
});

test("GCP's two rungs above ERROR are errors, and DEFAULT is not a level at all", () => {
	assert.equal(parseLogLine(JSON.stringify({ severity: 'ALERT', textPayload: 'x' })).level, 'error');
	assert.equal(parseLogLine(JSON.stringify({ severity: 'EMERGENCY', textPayload: 'x' })).level, 'error');
	assert.equal(parseLogLine(JSON.stringify({ severity: 'DEFAULT', textPayload: 'x' })).level, null);
});

test('Azure: a row with no text column reads as its own columns', () => {
	const line = parseLogLine(JSON.stringify({ Level: 'Error', OperationName: 'Delete', ResultDescription: 'denied', DurationMs: 12 }));
	// `Level`, not `level` — the case is the vendor's business.
	assert.equal(line.level, 'error');
	// …and the level is not repeated on the line, because the badge already carries it.
	assert.equal(line.summary, 'OperationName=Delete ResultDescription=denied DurationMs=12');
});

test('Azure: Informational and Verbose are spelled in full', () => {
	assert.equal(parseLogLine(JSON.stringify({ Level: 'Informational', Msg: 'ok' })).level, 'info');
	assert.equal(parseLogLine(JSON.stringify({ SeverityLevel: 'Verbose', Msg: 'ok' })).level, 'trace');
});

test('a NUMERIC level is not guessed at: the two scales run opposite ways', () => {
	// Azure AppTraces counts UP to critical (4); syslog counts DOWN from emergency (0). The same
	// 3 is an error on one and a warning on the other, so neither is claimed.
	assert.equal(parseLogLine(JSON.stringify({ SeverityLevel: 3, Msg: 'ok' })).level, null);
	assert.equal(parseLogLine(JSON.stringify({ severity: 3, msg: 'ok' })).level, null);
});

test('a record of nothing but nested values keeps its JSON reading', () => {
	const line = parseLogLine(JSON.stringify({ request: { path: '/a' } }));
	assert.equal(line.summary, '{"request":{"path":"/a"}}');
});

test('one long field does not swallow the line', () => {
	const line = parseLogLine(JSON.stringify({ msg: 'x'.repeat(300), id: 7 }));
	assert.ok(line.summary.startsWith('xxx'));
	assert.ok(line.summary.endsWith('… id=7'));
});

test('a record beside prose is still prose plus a payload', () => {
	// Only a message that is ENTIRELY one record is read as one; `Parsed event: {...}` is not.
	const line = parseLogLine('Parsed event: {"level":"warn","a":1}');
	assert.equal(line.summary, 'Parsed event: {"level":"warn","a":1}');
	assert.equal(line.level, 'warn');
});

test('a match buried in a line comes back as a fragment around it', () => {
	const body = `${'a'.repeat(400)} needle ${'b'.repeat(400)}`;
	const fragment = matchContext(body, 'NEEDLE');
	assert.ok(fragment);
	assert.ok(fragment.includes('needle'));
	// Cut at both ends, and both cuts say so.
	assert.ok(fragment.startsWith('…'));
	assert.ok(fragment.endsWith('…'));
	assert.ok(fragment.length < 220);
});

test('a fragment is one line, and does not claim a cut it did not make', () => {
	const fragment = matchContext('first\n  second needle third', 'needle');
	assert.equal(fragment, 'first second needle third');
});

test('no match, no fragment', () => {
	assert.equal(matchContext('nothing here', 'zzz'), null);
	assert.equal(matchContext('nothing here', '   '), null);
	assert.equal(matchContext('', 'a'), null);
});

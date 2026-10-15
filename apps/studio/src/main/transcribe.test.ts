/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type NativeQuery } from '../shared/engine';
import { compileSqlDeterministic, TranscribeError, transcribeFailureMessage, transcribeSql, type AiTranscriber } from './transcribe';

/** A spy AiTranscriber: records whether it ran and returns a fixed native query. */
function spyFallback(result: NativeQuery): AiTranscriber & { calls: number } {
	const fn = (async () => {
		fn.calls++;
		return result;
	}) as AiTranscriber & { calls: number };
	fn.calls = 0;
	return fn;
}

const AI_RESULT: NativeQuery = { lang: 'mongo', collection: 'users', pipeline: [{ $match: { vip: true } }] };

test('relational backend identity-transcribes SQL and never calls the AI fallback', async () => {
	const fallback = spyFallback(AI_RESULT);
	const native = await transcribeSql('relational', 'SELECT 1', fallback);
	assert.deepEqual(native, { lang: 'sql', sql: 'SELECT 1' });
	assert.equal(fallback.calls, 0);
});

test('document backend uses the deterministic compiler for the common subset (no AI fallback)', async () => {
	const fallback = spyFallback(AI_RESULT);
	const native = await transcribeSql('document', 'SELECT name FROM users WHERE age > 21 LIMIT 10', fallback);
	assert.equal(native.lang, 'mongo');
	assert.equal((native as Extract<NativeQuery, { lang: 'mongo' }>).collection, 'users');
	// The compiler handled it, so the model is never consulted.
	assert.equal(fallback.calls, 0);
});

test('document backend hands UnsupportedQueryError to the AI fallback and returns its result', async () => {
	const fallback = spyFallback(AI_RESULT);
	// A UNION is outside the deterministic subset → UnsupportedQueryError → AI fallback.
	const native = await transcribeSql('document', 'SELECT * FROM a UNION SELECT * FROM b', fallback);
	assert.equal(fallback.calls, 1);
	assert.deepEqual(native, AI_RESULT);
});

test('document backend with no AI fallback surfaces a friendly TranscribeError', async () => {
	await assert.rejects(
		() => transcribeSql('document', 'SELECT * FROM a UNION SELECT * FROM b'),
		(err: unknown) => {
			assert.ok(err instanceof TranscribeError);
			assert.match(err.message, /MongoDB pipeline/);
			return true;
		},
	);
});

test('vector backend deterministically compiles a metadata-filter query (no AI fallback)', async () => {
	const fallback = spyFallback(AI_RESULT);
	const native = await transcribeSql('vector', "SELECT * FROM docs WHERE genre = 'drama' LIMIT 5", fallback);
	assert.equal(native.lang, 'pinecone');
	assert.equal((native as Extract<NativeQuery, { lang: 'pinecone' }>).index, 'docs');
	assert.equal(fallback.calls, 0);
});

test('vector backend with no fallback surfaces a friendly TranscribeError for an unsupported query', async () => {
	await assert.rejects(
		// ORDER BY is unsupported for Pinecone (results are score-ordered).
		() => transcribeSql('vector', 'SELECT * FROM docs ORDER BY score LIMIT 5'),
		(err: unknown) => {
			assert.ok(err instanceof TranscribeError);
			assert.match(err.message, /Pinecone query/);
			return true;
		},
	);
});

// compileSqlDeterministic is the consent-gate's core: it NEVER calls the model, and reports whether
// the AI could recover an unsupported query — so the caller can ask before spending budget.
test('compileSqlDeterministic compiles the common subset with no AI involved', () => {
	const rel = compileSqlDeterministic('relational', 'SELECT 1');
	assert.deepEqual(rel, { ok: true, native: { lang: 'sql', sql: 'SELECT 1' } });
	const doc = compileSqlDeterministic('document', 'SELECT name FROM users WHERE age > 21 LIMIT 10');
	assert.ok(doc.ok && doc.native.lang === 'mongo');
});

test('compileSqlDeterministic marks an unsupported document query AI-recoverable', () => {
	const res = compileSqlDeterministic('document', 'SELECT * FROM a UNION SELECT * FROM b');
	assert.equal(res.ok, false);
	assert.ok(!res.ok && res.aiRecoverable, 'a document backend can fall back to the model');
	assert.ok(!res.ok && /MongoDB pipeline/.test(res.message));
});

test('compileSqlDeterministic marks an unsupported vector query NOT AI-recoverable', () => {
	const res = compileSqlDeterministic('vector', 'SELECT * FROM docs ORDER BY score LIMIT 5');
	assert.equal(res.ok, false);
	// The AI declines vector SQL (no query vector to invent), so we never offer/charge for it.
	assert.ok(!res.ok && res.aiRecoverable === false);
});

test('an unsupported log query is NOT AI-recoverable, and says why in log terms', () => {
	// The only transcriber wired writes MongoDB pipelines, which no log service can run — so a
	// CloudWatch connection must never be offered "translate with AI" (which asked to spend budget
	// on a pipeline for a connection that has no such thing). The compiler's own reason is the
	// answer instead. Flip this when a log prompt exists.
	const res = compileSqlDeterministic('telemetry', `SELECT ts, message FROM "/aws/lambda/x" WHERE message LIKE '%a%' OR message LIKE '%b%'`);
	assert.equal(res.ok, false);
	assert.ok(!res.ok && res.aiRecoverable === false);
	assert.ok(!res.ok && /log query/.test(res.message), res.ok ? '' : res.message);
	assert.ok(!res.ok && /OR in a WHERE/.test(res.message), res.ok ? '' : res.message);
});

test('telemetry never invokes the AI fallback, and its hint names no Pipeline tab', async () => {
	let called = false;
	const fb: AiTranscriber = async () => {
		called = true;
		return { lang: 'mongo', collection: 'x', pipeline: [] };
	};
	await assert.rejects(
		() => transcribeSql('telemetry', `SELECT ts FROM "/aws/lambda/x" LIMIT 10 OFFSET 5`, fb),
		(err: Error) => err instanceof TranscribeError && /log scope/.test(err.message) && !/Pipeline tab/.test(err.message),
	);
	assert.equal(called, false, 'a log backend must not spend an AI call it cannot use');
});

test('a document AI fallback that rejects propagates, not swallowed', async () => {
	const failing: AiTranscriber = async () => {
		throw new Error('model unavailable');
	};
	await assert.rejects(
		() => transcribeSql('document', 'SELECT * FROM a UNION SELECT * FROM b', failing),
		/model unavailable/,
	);
});

test('vector never invokes the AI fallback (the model declines vector SQL)', async () => {
	let called = false;
	const fb: AiTranscriber = async () => {
		called = true;
		return { lang: 'pinecone', index: 'docs', query: { topK: 1 } };
	};
	await assert.rejects(() => transcribeSql('vector', 'SELECT * FROM docs ORDER BY score LIMIT 5', fb), TranscribeError);
	assert.equal(called, false, 'a vector backend must not spend an AI call it cannot use');
});

// A typo is NOT an unsupported query: the model can't read it, so offering to spend budget on it
// buys the user nothing, and the "try a simpler SELECT" hint points away from the one-character fix.
test('a syntax error is terminal, un-hinted and never offered to the model', () => {
	const res = compileSqlDeterministic('document', "SELECT * FROM orders WHERE placedAt => '2025-03-01'");
	assert.ok(!res.ok);
	assert.equal(res.aiRecoverable, false);
	assert.equal(res.hint, false);
	assert.match(res.message, /Syntax error at line 1, column 37/);
	assert.match(res.message, /Did you mean ">="\?/);
	assert.equal(transcribeFailureMessage('document', res), res.message);
});

test('an unsupported (but valid) query still gets the hint and the model', () => {
	const res = compileSqlDeterministic('document', 'SELECT * FROM a UNION SELECT * FROM b');
	assert.ok(!res.ok);
	assert.equal(res.aiRecoverable, true);
	assert.match(transcribeFailureMessage('document', res), /Pipeline tab/);
});

test('a syntax error on a telemetry connection is terminal too', () => {
	const res = compileSqlDeterministic('telemetry', 'SELECT ts FROM "/aws/lambda/x" WHERE status => 500');
	assert.ok(!res.ok);
	assert.equal(res.aiRecoverable, false);
	assert.match(res.message, /Did you mean ">="\?/);
});

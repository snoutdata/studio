/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Transcription orchestration. Turns an authored SQL string into the connection's
 *  native query form. This lives in main because main can both import the shared deterministic
 *  compiler AND call the AI transcriber for the fallback; the server stays a dumb
 *  dispatcher that just routes a resolved NativeQuery to the driver.
 *
 *  Relational backends pass SQL through unchanged (identity transcription). Document backends
 *  compile via the deterministic `sqlToMongo`; when that can't represent the query, the AI
 *  transcriber takes over — not yet wired, so for now we surface a friendly message.
 *--------------------------------------------------------------------------------------------*/

import { CompileError, SqlSyntaxError, sqlToLogs, sqlToMongo, sqlToPinecone, UnsupportedQueryError, type BackendKind, type NativeQuery } from '../shared/engine';
import type { DatabaseSchema } from '../shared/schema';

/** A user-facing transcription failure — surfaced in the results grid as a normal error envelope. */
export class TranscribeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TranscribeError';
	}
}

/** The AI half of the hybrid transcriber: translate SQL the deterministic
 *  compiler can't represent into the backend's native form, grounded in its schema. Resolved lazily
 *  (only when the compiler throws {@link UnsupportedQueryError}). Returns the native query, or throws
 *  if the model is unavailable / its output can't be parsed. */
export type AiTranscriber = () => Promise<NativeQuery>;

/** A friendly tail appended to the "can't auto-translate" message, in the backend's own terms: only
 *  a document connection HAS a Pipeline tab to write the query in, so telling a log or vector user
 *  to use one sends them looking for a surface that is not there. */
export function transcribeHint(kind: BackendKind): string {
	if (kind === 'document') {
		return 'Try a simpler SELECT/WHERE/LIMIT, or write it in the Pipeline tab.';
	}
	if (kind === 'telemetry') {
		return 'Try a plain SELECT over one log scope, with WHERE, GROUP BY, ORDER BY and LIMIT.';
	}
	return 'Try a simpler SELECT/WHERE/LIMIT.';
}

/**
 * The outcome of a DETERMINISTIC-ONLY transcription attempt (no AI, no spend). `aiRecoverable` says
 * whether handing the query to the AI transcriber could plausibly succeed: true for a document
 * backend (the model can translate SQL → aggregation pipeline); false for vector (an AI SQL → vector
 * translation would have to invent a query vector) and for any non-`UnsupportedQueryError` failure.
 * The caller decides whether to spend the user's AI budget: AI transcription is consent-gated.
 */
export type DeterministicTranscription =
	| { ok: true; native: NativeQuery }
	| { ok: false; aiRecoverable: boolean; message: string; hint?: boolean };

/** A parse failure as a transcription outcome: never the model, never the hint. */
function syntaxFailure(err: SqlSyntaxError): DeterministicTranscription {
	return { ok: false, aiRecoverable: false, message: err.message, hint: false };
}

/**
 * What the user is told when a transcription failed for good. The backend hint ("try a simpler
 * SELECT") is only true of a query we could not EXPRESS; a statement that does not parse is not a
 * simpler-query problem, and saying so sent people looking in the wrong place.
 */
export function transcribeFailureMessage(kind: BackendKind, det: { message: string; hint?: boolean }): string {
	return det.hint === false ? det.message : `${det.message} ${transcribeHint(kind)}`;
}

/**
 * Compile an authored SQL string to the backend's {@link NativeQuery} using ONLY the deterministic
 * compiler — never the model. This is the free, offline, instant path; the AI fallback is a separate,
 * explicit step the caller takes (with consent) when `aiRecoverable` is true.
 */
export function compileSqlDeterministic(kind: BackendKind, sql: string, schema?: DatabaseSchema | null, window?: { start: number; end: number }): DeterministicTranscription {
	if (kind === 'relational') {
		return { ok: true, native: { lang: 'sql', sql } };
	}
	if (kind === 'telemetry') {
		// A log scope is a table and the user wrote SQL over it. The one thing the compiler may
		// decide for itself is the WINDOW: an unbounded log query is a bill rather than a slow
		// query, so a statement whose WHERE names no time bound is given the caller's (the
		// time-range control's) instead of being rejected.
		try {
			const compiled = sqlToLogs(sql, { schema, window });
			return { ok: true, native: { lang: 'logs', query: compiled.query, windowFromSql: compiled.windowFromSql } };
		} catch (err) {
			if (err instanceof SqlSyntaxError) {
				return syntaxFailure(err);
			}
			if (err instanceof CompileError) {
				return { ok: false, aiRecoverable: false, message: err.message };
			}
			if (err instanceof UnsupportedQueryError) {
				// NOT AI-recoverable, and the reason is worth keeping: the only AI transcriber wired
				// today writes MongoDB aggregation pipelines, which a log service cannot run at all —
				// so offering to spend budget here buys the user a wrong query in a foreign language.
				// Each of these services does have a query language more capable than this compiler's
				// subset (Logs Insights, KQL, a Cloud Logging filter), so this flips back to `true` the
				// day `transcribeToNative` learns to write one; until then the honest answer is the
				// compiler's own reason.
				return { ok: false, aiRecoverable: false, message: `This SQL can't be auto-translated to a log query (${err.message}).` };
			}
			throw err;
		}
	}
	if (kind === 'document' || kind === 'vector') {
		const compile = kind === 'document' ? sqlToMongo : sqlToPinecone;
		const nativeName = kind === 'document' ? 'MongoDB pipeline' : 'Pinecone query';
		try {
			// The schema is what lets the compiler type-coerce literals (a date field compared to a
			// string literal) and catch a name that doesn't exist. It is optional everywhere: without
			// one the compiler still produces the same mechanical translation it always did.
			return { ok: true, native: compile(sql, { schema }) };
		} catch (err) {
			if (err instanceof SqlSyntaxError) {
				// Not SQL at all. Terminal for the same reason a CompileError is, and then some: the AI
				// transcriber would be handed a statement it cannot read, spend the user's budget and
				// return nothing. The compiler's own located message is the whole answer, so the
				// "try a simpler SELECT" hint is suppressed as well (it points away from the fix).
				return syntaxFailure(err);
			}
			if (err instanceof CompileError) {
				// Deterministically wrong for this connection (unknown collection, a filter on something
				// that isn't filterable). A model can't fix it, so never offer to spend budget on it.
				return { ok: false, aiRecoverable: false, message: err.message };
			}
			if (err instanceof UnsupportedQueryError) {
				return { ok: false, aiRecoverable: kind === 'document', message: `This SQL can't be auto-translated to a ${nativeName} (${err.message}).` };
			}
			throw err;
		}
	}
	return { ok: false, aiRecoverable: false, message: `The '${kind}' backend doesn't support SQL queries yet.` };
}

/**
 * Compile an authored SQL string to the backend's {@link NativeQuery}. Hybrid for document/vector
 * backends: the deterministic compiler handles the common subset exactly and offline; when it rejects
 * a query the `aiFallback`, if supplied, takes over. The relational and deterministic paths resolve
 * immediately. (The consent-gated callers in `connectionManager` use {@link compileSqlDeterministic}
 * directly so they can ask before spending budget; this convenience wrapper keeps the old behavior.)
 */
export async function transcribeSql(kind: BackendKind, sql: string, aiFallback?: AiTranscriber, schema?: DatabaseSchema | null, window?: { start: number; end: number }): Promise<NativeQuery> {
	const det = compileSqlDeterministic(kind, sql, schema, window);
	if (det.ok) {
		return det.native;
	}
	if (det.aiRecoverable && aiFallback) {
		return await aiFallback();
	}
	throw new TranscribeError(transcribeFailureMessage(kind, det));
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ErrorClass } from './errorClass';
import type { BackendKind } from '../compile/native';
import type { FailureQuery, FailureRecord } from './failureMemory';

/**
 * Failure-memory retrieval. The dumbest thing that could work, by design: an EXACT gate (same
 * `schema_fingerprint` AND `backend`) done by the store, then rank the survivors by `query_shape`
 * similarity and take the top one over a threshold.
 *
 * Similarity is token-set Jaccard over the canonical shape — cheap, deterministic, and enough to
 * tell "the same query with different literals" (identical shape → 1.0) from "a different query".
 * Tree-edit-distance / semantic similarity is a benchmark-gated upgrade: it ships only when the
 * replay benchmark shows a miss it would fix, never on spec.
 */

/** Below this shape similarity a candidate is treated as unrelated and not injected. Tuned by the
 *  replay benchmark; conservative by default so a weak match doesn't become prompt noise. */
export const DEFAULT_MIN_SIMILARITY = 0.5;

/** Token-set Jaccard over the space-separated tokens of two canonical shapes. 1.0 == identical. */
export function shapeSimilarity(a: string, b: string): number {
	if (a === b) {
		return a ? 1 : 0;
	}
	const ta = new Set(a.split(' ').filter(Boolean));
	const tb = new Set(b.split(' ').filter(Boolean));
	if (ta.size === 0 || tb.size === 0) {
		return 0;
	}
	let intersection = 0;
	for (const token of ta) {
		if (tb.has(token)) {
			intersection++;
		}
	}
	const union = ta.size + tb.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/** Pick the single best prior failure for an incoming shape, or null if none clears the threshold.
 *  Candidates are assumed already gated to the right schema + backend. Ties keep the earlier (the
 *  store returns newest-first, so the most recent wins a tie). */
export function selectMemory(
	candidates: readonly FailureRecord[],
	incomingShape: string,
	minSimilarity: number = DEFAULT_MIN_SIMILARITY,
): FailureRecord | null {
	let best: FailureRecord | null = null;
	let bestScore = -1;
	for (const candidate of candidates) {
		const score = shapeSimilarity(candidate.queryShape, incomingShape);
		if (score >= minSimilarity && score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	return best;
}

const CLASS_PHRASE: Record<ErrorClass, string> = {
	'unsupported-translation': 'could not be translated to this backend',
	deadlock: 'hit a deadlock',
	timeout: 'timed out',
	'constraint-violation': 'violated a constraint',
	'type-mismatch': 'failed on a type mismatch',
	'resource-limit': 'ran into a resource limit (memory, a quota, or too many parts)',
	unclassified: 'failed',
};

/**
 * A concrete corrective per class — what to DO differently, not just what went wrong. The benchmark
 * showed a generic "take that into account" note didn't change a modest model's behavior (it re-ran
 * the identical statement), so the note now tells the model the fix path for the class. v1 has no
 * stored resolution yet (open question #4), so this is class-level advice, not a replayed successful
 * query; a "Resolution that worked: …" clause replaces it once resolution backfill lands.
 */
const CLASS_ACTION: Record<ErrorClass, string> = {
	'unsupported-translation':
		"Rewrite it without the construct this backend can't run (for example avoid JOINs and DISTINCT); a single-collection SELECT / WHERE / GROUP BY that this backend supports is fine.",
	deadlock: 'Retry with smaller or serialized writes and a consistent access order so the lock cycle cannot form.',
	timeout: 'Make it cheaper before retrying: add a LIMIT, narrow the WHERE, or filter on an indexed column.',
	'constraint-violation':
		'First check what the constraint requires (the allowed values, the NOT NULL columns, or whether the row already exists) and adjust the values to satisfy it; for a duplicate use an idempotent write (INSERT OR IGNORE / ON CONFLICT) rather than a plain INSERT.',
	'type-mismatch': "Supply a value of the column's declared type (cast or reformat the literal) instead of the mismatched one.",
	'resource-limit': 'Make it read and hold less before retrying: filter earlier (on the sort or partition key where there is one), select fewer columns, aggregate before joining, and keep the smaller side of a JOIN on the right. For an insert that hit too many parts, batch the rows into fewer, larger inserts.',
	unclassified:
		'This came from a rule that is not visible in the schema (often a trigger or a business constraint the database enforces), and the error text above is the rule. Add a guard so the statement cannot hit that condition, or tell the user the operation is blocked and why — do not just resubmit it.',
};

/** The compact prompt note injected for a retrieved memory. Failure-only in v1 (no resolution yet;
 *  resolution backfill is a deferred step, at which point a "Resolution that worked: …" clause is
 *  appended). `error` is display-only detail, never a match key. Actionable by design: it names the
 *  fix path for the class and forbids resubmitting the same statement, because a warning alone was
 *  measured not to move a modest model. */
export function formatMemoryNote(record: FailureRecord): string {
	const detail = record.error ? ` ("${truncate(record.error, 160)}")` : '';
	return `A structurally similar query against this schema previously ${CLASS_PHRASE[record.errorClass]}${detail}. ${CLASS_ACTION[record.errorClass]} Do not re-run the same statement unchanged — change the approach so it will not fail the same way again.`;
}

/**
 * The retrieval entry point: gate to this schema + backend, rank by shape, and return the best prior
 * failure with its injectable note (or null). Reused by the replay benchmark and, once wired, by the
 * assistant's prompt builder. An empty fingerprint yields nothing (an unknown schema must not match).
 */
export function retrieveMemory(
	store: FailureQuery,
	schemaFingerprint: string,
	backend: BackendKind,
	incomingShape: string,
	minSimilarity: number = DEFAULT_MIN_SIMILARITY,
): { record: FailureRecord; note: string } | null {
	if (!schemaFingerprint) {
		return null;
	}
	const record = selectMemory(store.match(schemaFingerprint, backend), incomingShape, minSimilarity);
	return record ? { record, note: formatMemoryNote(record) } : null;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

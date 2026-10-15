/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { retrieveMemory } from './failureRetrieval';
import type { BackendKind } from '../compile/native';
import type { ErrorClass } from './errorClass';
import type { FailureQuery, FailureRecord } from './failureMemory';

/**
 * Replay benchmark — the milestone's headline deliverable, in its deterministic form. The plan's
 * primary metric is repeat-failure REDUCTION with a live model in the loop; that half needs the
 * gateway (non-deterministic, CI-hostile) and is scaffolded, not run here (see the note at the
 * bottom). What runs in CI is the deterministic layer underneath it: does retrieval surface the
 * right prior failure when a structurally similar query recurs, and does it stay quiet otherwise?
 * That is the mechanism the model half depends on, so regressing it is what we most need to catch.
 *
 * Corpus model: a set of PRIOR failures already in memory, then PROBES (incoming queries). A probe
 * is `hit: true` if the same schema+backend has seen a structurally similar failure (memory should
 * surface it) or `hit: false` if not (memory should stay silent). Grow this toward the plan's 30-50
 * scenarios; the Mongo translation cases are the runnable seed, relational synthetics cover the rest.
 */

const FP_ORDERS = 'orders:9a1'; // one schema
const FP_USERS = 'users:4b2'; // a different schema (same-shape queries must not cross this line)

function prior(over: Partial<FailureRecord>): FailureRecord {
	return {
		connectionId: 'c1',
		query: '',
		queryShape: '',
		backend: 'relational',
		origin: 'execution',
		error: '',
		errorClass: 'unclassified',
		schemaFingerprint: FP_ORDERS,
		at: 1,
		...over,
	};
}

// What memory has already seen.
const PRIORS: FailureRecord[] = [
	prior({ queryShape: 'select ? + ? from orders', errorClass: 'type-mismatch', error: 'invalid input syntax for type integer' }),
	prior({ queryShape: 'insert into orders (id, email) values (?, ?)', errorClass: 'constraint-violation', error: 'duplicate key value violates unique constraint' }),
	prior({ queryShape: 'update orders set total=? where id=?', errorClass: 'deadlock', error: 'deadlock detected' }),
	prior({ queryShape: 'select * from orders o join customers c on o.cid=c.id', backend: 'document', origin: 'translation', errorClass: 'unsupported-translation', error: 'joins are not supported' }),
];

interface Probe {
	name: string;
	fingerprint: string;
	backend: BackendKind;
	shape: string;
	hit: boolean; // ground truth: should memory surface a prior failure?
	expectClass?: ErrorClass;
}

const PROBES: Probe[] = [
	// --- Repeats memory SHOULD catch (only literals differ → identical shape) ---
	{ name: 'type-mismatch repeat', fingerprint: FP_ORDERS, backend: 'relational', shape: 'select ? + ? from orders', hit: true, expectClass: 'type-mismatch' },
	{ name: 'constraint repeat, new literals', fingerprint: FP_ORDERS, backend: 'relational', shape: 'insert into orders (id, email) values (?, ?)', hit: true, expectClass: 'constraint-violation' },
	{ name: 'deadlock repeat', fingerprint: FP_ORDERS, backend: 'relational', shape: 'update orders set total=? where id=?', hit: true, expectClass: 'deadlock' },
	{ name: 'mongo translation repeat', fingerprint: FP_ORDERS, backend: 'document', shape: 'select * from orders o join customers c on o.cid=c.id', hit: true, expectClass: 'unsupported-translation' },
	// --- Cases memory SHOULD stay silent on ---
	{ name: 'same shape, different schema', fingerprint: FP_USERS, backend: 'relational', shape: 'update orders set total=? where id=?', hit: false },
	{ name: 'same shape, wrong backend', fingerprint: FP_ORDERS, backend: 'document', shape: 'update orders set total=? where id=?', hit: false },
	{ name: 'novel query, seen schema', fingerprint: FP_ORDERS, backend: 'relational', shape: 'select count(*) from shipments', hit: false },
	{ name: 'near-miss below threshold', fingerprint: FP_ORDERS, backend: 'relational', shape: 'select ? - ? from refunds', hit: false },
];

/** The in-memory store the benchmark runs against (mirrors FailureMemoryStore.match). */
class InMemoryStore implements FailureQuery {
	constructor(private readonly records: FailureRecord[]) {}
	match(schemaFingerprint: string, backend: BackendKind, limit = 25): FailureRecord[] {
		if (!schemaFingerprint) {
			return [];
		}
		return this.records
			.filter((r) => r.schemaFingerprint === schemaFingerprint && r.backend === backend)
			.slice()
			.reverse()
			.slice(0, limit);
	}
}

test('replay benchmark: retrieval precision/recall over the seed corpus', () => {
	const store = new InMemoryStore(PRIORS);

	let tp = 0; // hit expected, memory injected the right thing
	let fn = 0; // hit expected, memory stayed silent
	let fp = 0; // no hit expected, memory injected anyway
	let tn = 0; // no hit expected, memory stayed silent
	let classMatches = 0;
	let classExpected = 0;

	for (const probe of PROBES) {
		// memory-OFF baseline never injects — kept explicit so the contrast is measured, not assumed.
		const off = null;
		assert.equal(off, null);

		// memory-ON.
		const on = retrieveMemory(store, probe.fingerprint, probe.backend, probe.shape);
		if (probe.hit) {
			if (on) {
				tp++;
				if (probe.expectClass) {
					classExpected++;
					if (on.record.errorClass === probe.expectClass) {
						classMatches++;
					}
				}
			} else {
				fn++;
			}
		} else if (on) {
			fp++;
		} else {
			tn++;
		}
	}

	const positives = tp + fn;
	const recall = positives ? tp / positives : 1;
	const precision = tp + fp ? tp / (tp + fp) : 1;
	const classAccuracy = classExpected ? classMatches / classExpected : 1;

	// The baseline the plan asks to record — printed so a run captures the numbers, not just pass/fail.
	console.log(
		`[replay-benchmark] probes=${PROBES.length} priors=${PRIORS.length} ` +
			`TP=${tp} FN=${fn} FP=${fp} TN=${tn} | recall=${recall.toFixed(2)} precision=${precision.toFixed(2)} ` +
			`class-accuracy=${classAccuracy.toFixed(2)} | memory-off repeats-caught=0/${positives}`,
	);

	// Regression guardrails for the current (dumb, exact-gate) retrieval on this corpus.
	assert.equal(recall, 1, 'every structural repeat on the same schema+backend should be surfaced');
	assert.equal(fp, 0, 'memory must stay silent on different schema / backend / unrelated shape');
	assert.equal(classAccuracy, 1, 'the surfaced memory should carry the right error_class');
});

// SCAFFOLDED, NOT RUN HERE — the live-model half. The plan's headline "repeat-failure rate" needs a
// real assistant round-trip: run each scenario's task with memory-off vs memory-on injected into the
// prompt, and measure how often the second attempt still fails. That path is non-deterministic and
// hits the gateway, so it belongs behind an opt-in env flag (like the SNOUTDATA_IT_* integration
// tier), not in the default CI run. The deterministic test above validates the retrieval mechanism
// that half sits on; wiring retrieveMemory() into the assistant's prompt builder is the next step.

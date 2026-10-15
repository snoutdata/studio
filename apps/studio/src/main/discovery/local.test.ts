/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOCALHOST, foundFromProbe, valuesFromProbeRef } from './local';
import { looksDenied } from './network';
import { PROBE_PORTS } from './sniff';

const PG = PROBE_PORTS.find((p) => p.port === 5432)!;
const MSSQL = PROBE_PORTS.find((p) => p.port === 1433)!;

test('a port that answered is offered with the default user and no password', () => {
	const f = foundFromProbe(LOCALHOST, PG, { kind: 'answered', verdict: { driver: 'postgres', product: 'PostgreSQL' } });
	assert.ok(f);
	assert.deepEqual([f.values.host, f.values.port, f.values.username, f.values.password], ['localhost', 5432, 'postgres', undefined]);
	assert.equal(f.sourceName, 'PostgreSQL on localhost:5432');
	assert.equal(f.tentative, undefined);
	assert.equal(f.importsPassword, false);
	assert.match(f.note ?? '', /No password is known/);
});

test('an open port that said nothing is a guess, left unselected', () => {
	const f = foundFromProbe(LOCALHOST, MSSQL, { kind: 'open' });
	assert.equal(f?.tentative, true);
	assert.equal(f?.values.username, 'sa');
	assert.match(f?.note ?? '', /did not say what it is/);
	assert.equal(foundFromProbe(LOCALHOST, MSSQL, { kind: 'closed', code: 'ECONNREFUSED' }), null);
});

test('apply rebuilds the same values from the ref, and refuses a ref that is not one', () => {
	const f = foundFromProbe('192.168.1.40', PG, { kind: 'answered', verdict: { driver: 'mariadb' } }, 'nas.lan')!;
	assert.deepEqual(valuesFromProbeRef(f.ref), f.values);
	assert.equal(valuesFromProbeRef({ file: 'x', connId: 'evil:1' }), null);
	assert.equal(valuesFromProbeRef({ file: 'x', connId: 'nonsense' }), null);
});

test('macOS refusing local-network access is told apart from an empty network', () => {
	const denied = Array.from({ length: 20 }, () => ({ kind: 'closed' as const, code: 'EHOSTUNREACH' }));
	assert.equal(looksDenied('darwin', denied), true);
	assert.equal(looksDenied('linux', denied), false, 'only macOS has the permission');
	assert.equal(looksDenied('darwin', [...denied, { kind: 'closed', code: 'ECONNREFUSED' }]), false, 'a refusal proves the network is reachable');
	assert.equal(looksDenied('darwin', Array.from({ length: 20 }, () => ({ kind: 'closed' as const, code: 'ETIMEDOUT' }))), false, 'silence is an empty network');
	assert.equal(looksDenied('darwin', [], 'EHOSTUNREACH'), true, 'the multicast send was refused');
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ImportItem, ImportScanResult, ImportSourceId } from '../../shared/forms';
import { dedupeAcrossSources, dropMapped } from './dedupe';

function item(key: string, host: string, port: number, extra: Partial<ImportItem> = {}): ImportItem {
	return {
		key,
		values: { label: key, driver: 'postgres', host, port, username: 'postgres', ssl: false, readOnly: false },
		sourceName: key,
		supported: true,
		duplicate: false,
		importsPassword: false,
		ref: { file: host, connId: key },
		...extra,
	};
}

function result(sourceId: ImportSourceId, items: ImportItem[]): ImportScanResult {
	return { sourceId, sources: [], items, notFound: items.length === 0 };
}

test('a local port a Docker container publishes is shown once, as the container', () => {
	const out = dedupeAcrossSources([
		result('docker', [item('pg', 'localhost', 5432, { importsPassword: true })]),
		result('local', [item('probe-pg', 'localhost', 5432), item('probe-my', 'localhost', 3306)]),
	]);
	assert.deepEqual(out.find((r) => r.sourceId === 'local')?.items.map((i) => i.key), ['probe-my']);
	assert.equal(out.find((r) => r.sourceId === 'docker')?.items.length, 1);
});

test('127.0.0.1 and localhost are the same place; an unsupported container names nothing', () => {
	const out = dedupeAcrossSources([
		result('pgpass', [item('pass', '127.0.0.1', 5432)]),
		result('docker', [item('unpublished', 'localhost', 3306, { supported: false })]),
		result('local', [item('probe-pg', 'localhost', 5432), item('probe-my', 'localhost', 3306)]),
	]);
	assert.deepEqual(out.find((r) => r.sourceId === 'local')?.items.map((i) => i.key), ['probe-my']);
});

test('the same connection twice in one source is one row, and the one with a password wins', () => {
	const out = dedupeAcrossSources([result('ssms', [item('a', 'db', 1433), item('b', 'db', 1433, { importsPassword: true }), item('c', 'db2', 1433)])]);
	assert.deepEqual(out[0].items.map((i) => i.key), ['b', 'c']);
});

test('a network endpoint a tool already names is not listed again; a source emptied says notFound', () => {
	const out = dedupeAcrossSources([
		result('dbeaver', [item('saved', '192.168.1.40', 5432)]),
		result('network', [item('probe', '192.168.1.40', 5432)]),
	]);
	const net = out.find((r) => r.sourceId === 'network');
	assert.deepEqual(net?.items, []);
	assert.equal(net?.notFound, true);
});

test('what a saved connection already points at is not listed at all, even after dedupe used it', () => {
	const out = dropMapped(dedupeAcrossSources([
		result('docker', [item('local-test', 'localhost', 54342, { duplicate: true }), item('other', 'localhost', 54332)]),
		result('local', [item('probe', 'localhost', 54342)]),
		result('dbeaver', [item('only', 'db.example', 3306, { duplicate: true })]),
	]));
	assert.deepEqual(out.find((r) => r.sourceId === 'docker')?.items.map((i) => i.key), ['other']);
	assert.equal(out.find((r) => r.sourceId === 'local')?.items.length, 0);
	assert.equal(out.find((r) => r.sourceId === 'dbeaver')?.notFound, true);
});

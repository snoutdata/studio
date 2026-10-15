/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { assessHealth, healthSql, keeperChild, keeperListSql, keeperPath, keeperTrail, namedRows, OPS_VIEWS, opsView, quoteName, unavailableMessage } from './clickhouseOps';
import type { ReplicaScope } from './engine';

describe('ClickHouse health', () => {
	const calm = { running: { n: 0, longest: 0 }, mutations: { pending: 0, failing: 0 }, replication: { tables: 0, readonly: 0, delay: 0 } };

	test('parts: ok, piling up, slowed, refused, against the server\'s own limits', () => {
		const at = (parts: number) => assessHealth({ ...calm, worstPartition: { database: 'shop', table: 'events', parts }, delayAt: 1000, throwAt: 3000 })[0];
		assert.equal(at(12).level, 'ok');
		assert.equal(at(600).title, 'Parts piling up');
		assert.equal(at(1200).title, 'Inserts slowed');
		assert.equal(at(3000).level, 'error');
		assert.match(at(3000).detail, /shop\.events has 3,000 parts/);
	});

	test('parts use ClickHouse\'s defaults when the limits could not be read', () => {
		assert.equal(assessHealth({ ...calm, worstPartition: { database: 'd', table: 't', parts: 1500 } })[0].title, 'Inserts slowed');
	});

	test('a failing mutation is an error, a pending one a warning', () => {
		assert.equal(assessHealth({ ...calm, worstPartition: null, mutations: { pending: 2, failing: 1 } })[1].level, 'error');
		assert.equal(assessHealth({ ...calm, worstPartition: null, mutations: { pending: 2, failing: 0 } })[1].level, 'warn');
	});

	test('replication: none, read-only, lagging', () => {
		assert.equal(assessHealth({ ...calm, worstPartition: null })[2].detail, 'No replicated tables on this server.');
		assert.equal(assessHealth({ ...calm, worstPartition: null, replication: { tables: 3, readonly: 1, delay: 0 } })[2].level, 'error');
		assert.equal(assessHealth({ ...calm, worstPartition: null, replication: { tables: 3, readonly: 0, delay: 900 } })[2].title, 'Replica lag');
	});

	test('a check this user cannot read says so instead of failing the summary', () => {
		const items = assessHealth({});
		assert.equal(items.length, 7);
		assert.ok(items.every((item) => item.level === 'unknown'));
	});
});

describe('ClickHouse health, storage and dictionaries', () => {
	const calm = { worstPartition: null, running: { n: 0, longest: 0 }, mutations: { pending: 0, failing: 0 }, replication: { tables: 0, readonly: 0, delay: 0 } };
	const card = (input: Parameters<typeof assessHealth>[0], title: RegExp) => assessHealth(input).find((item) => title.test(item.title));

	test('disk: fine, filling, nearly full; detached parts show when the disk is fine', () => {
		assert.equal(card({ ...calm, disk: { name: 'default', usedPercent: 40, free: 5e11 } }, /^Disk/)?.level, 'ok');
		assert.equal(card({ ...calm, disk: { name: 'default', usedPercent: 85, free: 1e10 } }, /^Disk/)?.level, 'warn');
		assert.equal(card({ ...calm, disk: { name: 'default', usedPercent: 95, free: 1e9 } }, /^Disk/)?.level, 'error');
		assert.equal(card({ ...calm, disk: { name: 'default', usedPercent: 40, free: 5e11 }, detached: 3 }, /Detached/)?.view, 'detached');
	});

	test('a failed dictionary is an error', () => {
		assert.equal(card({ ...calm, dictionaries: { total: 2, failing: 1 } }, /Dictionar/)?.level, 'error');
		assert.equal(card({ ...calm, dictionaries: { total: 2, failing: 0 } }, /Dictionar/)?.level, 'ok');
	});

	test('a few failed queries are typos, a stream of them is worth a look', () => {
		assert.equal(card({ ...calm, failed: { n: 3, kinds: 2 } }, /Failed/)?.level, 'ok');
		assert.equal(card({ ...calm, failed: { n: 50, kinds: 1 } }, /Failed/)?.level, 'warn');
	});

	test('reloading a dictionary quotes its names', () => {
		assert.equal(opsView('dictionaries').action!.sql({ database: 'shop', name: 'country`names' }), 'SYSTEM RELOAD DICTIONARY `shop`.`country``names`');
	});
});

const cloud: ReplicaScope = { replicas: 3, cluster: 'default', settings: 'SETTINGS max_execution_time = 15, skip_unavailable_shards = 1' };
const single: ReplicaScope = { replicas: 1, settings: '' };

describe('ClickHouse operations views', () => {
	test('the two row actions name exactly the row, quoted', () => {
		const stop = opsView('running').action!;
		assert.equal(stop.sql({ query_id: "a'b" }), "KILL QUERY WHERE query_id = 'a\\'b'");
		const cancel = opsView('mutations').action!;
		assert.equal(cancel.sql({ database: 'shop', table: 'events', mutation_id: 'mutation_7.txt' }),
			"KILL MUTATION WHERE database = 'shop' AND table = 'events' AND mutation_id = 'mutation_7.txt'");
	});

	test('every view reads and only reads', () => {
		for (const view of OPS_VIEWS) {
			assert.match(view.sql().trim(), /^(SELECT|WITH)\b/, view.id);
			assert.match(view.sql(cloud).trim(), /^(SELECT|WITH)\b/, view.id);
		}
	});

	test('on one node nothing reads across replicas', () => {
		for (const view of OPS_VIEWS) {
			assert.doesNotMatch(view.sql(), /clusterAllReplicas|hostName\(\)|SETTINGS/, view.id);
			assert.doesNotMatch(view.sql(single), /clusterAllReplicas|hostName\(\)|SETTINGS/, view.id);
		}
		for (const sql of Object.values(healthSql(single))) {
			assert.doesNotMatch(sql, /clusterAllReplicas/);
		}
	});

	test('with replicas, node-local state is read from every one and says which', () => {
		const running = opsView('running').sql(cloud);
		assert.match(running, /FROM clusterAllReplicas\('default', system\.processes\)/);
		assert.match(running, /^SELECT hostName\(\) AS replica, /);
		assert.match(running, /AND is_initial_query/);
		assert.match(running, /\nSETTINGS max_execution_time = 15, skip_unavailable_shards = 1$/);
		for (const id of ['failed', 'merges', 'dictionaries', 'disks', 'detached', 'replication', 'refreshes', 'backups'] as const) {
			assert.match(opsView(id).sql(cloud), /clusterAllReplicas/, id);
		}
		// Parts, mutations and schema are the same on every replica: read once, not counted N times.
		for (const id of ['parts', 'mutations', 'columns', 'views', 'clusters', 'ddl', 'settings'] as const) {
			assert.doesNotMatch(opsView(id).sql(cloud), /clusterAllReplicas/, id);
		}
		assert.match(healthSql(cloud).running, /clusterAllReplicas\('default', system\.processes\)/);
		assert.doesNotMatch(healthSql(cloud).parts, /clusterAllReplicas/);
	});

	test('a readonly user reads across replicas without the SETTINGS it may not send', () => {
		const sql = opsView('running').sql({ ...cloud, settings: '' });
		assert.match(sql, /clusterAllReplicas/);
		assert.doesNotMatch(sql, /SETTINGS/);
	});

	test('with replicas, Stop and Reload reach every one, with the local form to fall back on', () => {
		const stop = opsView('running').action!;
		assert.equal(stop.sql({ query_id: 'q1' }, cloud), "KILL QUERY ON CLUSTER `default` WHERE query_id = 'q1'");
		assert.equal(stop.local!({ query_id: 'q1' }), "KILL QUERY WHERE query_id = 'q1'");
		const reload = opsView('dictionaries').action!;
		assert.equal(reload.sql({ database: 'shop', name: 'd' }, cloud), 'SYSTEM RELOAD DICTIONARY ON CLUSTER `default` `shop`.`d`');
	});

	test('named rows', () => {
		assert.deepEqual(namedRows([{ name: 'a' }, { name: 'b' }], [[1, 'x']]), [{ a: 1, b: 'x' }]);
	});
});

describe('the cluster queues and Keeper', () => {
	const cloud = { replicas: 3, cluster: 'default', settings: 'SETTINGS max_execution_time = 15, skip_unavailable_shards = 1' };

	test('both queues are per NODE, so they are read from every replica and say which', () => {
		for (const id of ['repqueue', 'distqueue'] as const) {
			const sql = opsView(id).sql(cloud);
			assert.match(sql, /clusterAllReplicas/, id);
			assert.match(sql, /^SELECT hostName\(\) AS replica, /, id);
		}
		assert.match(opsView('repqueue').sql(cloud), /system\.replication_queue/);
		assert.match(opsView('distqueue').sql(cloud), /system\.distribution_queue/);
	});

	test('Keeper is read ONCE however many replicas there are', () => {
		// The opposite of every other view in the group, and the thing to get right: each replica
		// talks to the SAME Keeper, so reading it per replica would show the tree three times over.
		assert.doesNotMatch(opsView('keeper').sql(cloud), /clusterAllReplicas/);
		assert.doesNotMatch(keeperListSql('/'), /clusterAllReplicas/);
	});

	test('a repair acts on the node the entry is stuck on, never ON CLUSTER', () => {
		// Restarting every replica of a table at once is how a stuck replica becomes an outage.
		const restart = opsView('repqueue').action!;
		assert.equal(restart.sql({ database: 'shop', table: 'orders' }, cloud), 'SYSTEM RESTART REPLICA `shop`.`orders`');
		assert.doesNotMatch(restart.sql({ database: 'shop', table: 'orders' }, cloud), /ON CLUSTER/);
		const flush = opsView('distqueue').action!;
		assert.equal(flush.sql({ database: 'shop', table: 'orders_all' }, cloud), 'SYSTEM FLUSH DISTRIBUTED `shop`.`orders_all`');
	});

	test('a server without replication says so instead of showing an error', () => {
		const view = opsView('repqueue');
		assert.equal(unavailableMessage(view, "Code: 60. DB::Exception: Table system.replication_queue doesn't exist"),
			'This server has no replication queue, so it has no replicated tables.');
		assert.equal(unavailableMessage(opsView('keeper'), 'Code: 999. Coordination::Exception: All connection tries failed, Keeper'),
			'This server has no Keeper configured, so there is no coordination tree to read.');
	});

	test('a Keeper path is normalised, and a child of it is built from its name', () => {
		assert.equal(keeperPath('/'), '/');
		assert.equal(keeperPath(''), '/');
		assert.equal(keeperPath('/clickhouse/'), '/clickhouse');
		assert.equal(keeperPath('//clickhouse///tables'), '/clickhouse/tables');
		assert.equal(keeperChild('/', 'clickhouse'), '/clickhouse');
		assert.equal(keeperChild('/clickhouse', 'tables'), '/clickhouse/tables');
	});

	test('the path is a literal, so a node name cannot end the statement', () => {
		// Names come from the server, but they are still interpolated, and ClickHouse takes a
		// backslash as an escape inside a string where most engines do not.
		assert.match(keeperListSql("/a'; DROP TABLE x --"), /WHERE path = '\/a\\'; DROP TABLE x --'/);
		assert.equal(keeperListSql('/x').includes("path = '/x'"), true);
	});

	test('the breadcrumb is every ancestor, root first', () => {
		assert.deepEqual(keeperTrail('/clickhouse/tables/01').map((c) => c.path), ['/', '/clickhouse', '/clickhouse/tables', '/clickhouse/tables/01']);
		assert.deepEqual(keeperTrail('/').map((c) => c.name), ['/']);
	});

	test('the Keeper view browses, and the others do not', () => {
		assert.equal(opsView('keeper').browse?.root, '/');
		assert.equal(opsView('keeper').browse?.nameColumn, 'name');
		for (const id of ['repqueue', 'distqueue', 'running', 'replication'] as const) {
			assert.equal(opsView(id).browse, undefined, id);
		}
	});
});

describe('the server log', () => {
	const cloud = { replicas: 3, cluster: 'default', settings: 'SETTINGS max_execution_time = 15, skip_unavailable_shards = 1' };

	test('unfiltered it is the recent problems, filtered it is everything for one query', () => {
		const quiet = opsView('serverlog').sql();
		// Without a filter the log is thousands of lines of startup chatter, so it is the last hour
		// at Warning and worse. Spelled as a LIST on purpose: `level` is an Enum8 ordered
		// Fatal .. Trace, and `level <= 'Warning'` compares the STRING, so Trace and Debug sort
		// under Warning alphabetically and the filter lets the whole log through. That version
		// shipped for an hour and a live server caught it.
		assert.match(quiet, /level IN \('Fatal', 'Critical', 'Error', 'Warning'\)/);
		assert.doesNotMatch(quiet, /level <= /);
		assert.match(quiet, /INTERVAL 1 HOUR/);

		const loud = opsView('serverlog').filter!.sql('abc-123');
		assert.doesNotMatch(loud, /level IN/);
		assert.match(loud, /INTERVAL 1 DAY/);
		assert.match(loud, /query_id = 'abc-123'/);
		// Oldest first when it is one query's story, newest first when it is a list of problems.
		assert.match(loud, /ORDER BY event_time, event_time_microseconds/);
		assert.match(quiet, /ORDER BY event_time DESC/);
	});

	test('a filter is a literal, and text matches without case', () => {
		assert.match(opsView('serverlog').filter!.sql("o'brien"), /positionCaseInsensitive\(message, 'o\\'brien'\) > 0/);
	});

	test('both log views read every replica: a log is the node’s own', () => {
		assert.match(opsView('serverlog').sql(cloud), /clusterAllReplicas\('default', system\.text_log\)/);
		assert.match(opsView('serverlog').filter!.sql('x', cloud), /clusterAllReplicas\('default', system\.text_log\)/);
		assert.match(opsView('crashlog').sql(cloud), /clusterAllReplicas\('default', system\.crash_log\)/);
	});

	test('a server that does not log to a table says which switch, not "table not found"', () => {
		assert.match(unavailableMessage(opsView('serverlog'), "Code: 60. DB::Exception: Table system.text_log doesn't exist") ?? '', /<text_log> section/);
		// And a missing crash_log is the GOOD outcome: ClickHouse creates it on the first crash.
		assert.match(unavailableMessage(opsView('crashlog'), "Code: 60. DB::Exception: Table system.crash_log doesn't exist") ?? '', /No crash has ever been recorded/);
	});

	test('a failed query carries the id its log lines are under', () => {
		const sql = opsView('failed').sql();
		assert.match(sql, /argMax\(query_id, event_time\) AS last_query_id/);
		const jump = opsView('failed').jump!;
		assert.equal(jump.view, 'serverlog');
		assert.equal(jump.column, 'last_query_id');
	});
});

test('a name with a backslash before a backtick stays one identifier', () => {
	assert.equal(quoteName('a\\`; DROP TABLE t; --'), '`a\\\\``; DROP TABLE t; --`');
	assert.equal(quoteName('a\\'), '`a\\\\`');
});

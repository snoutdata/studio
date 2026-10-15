/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { containerFound, credentialsFromEnv, engineForImage, imageRepository, type ContainerInspect } from './containers';

const SOCK = '/var/run/docker.sock';

function container(image: string, env: string[], ports: ContainerInspect['NetworkSettings'] extends infer N ? N extends { Ports?: infer P } ? P : never : never, extra: Partial<ContainerInspect> = {}): ContainerInspect {
	return { Id: 'a'.repeat(64), Name: '/db', Config: { Image: image, Env: env, Labels: extra.Config?.Labels ?? {} }, NetworkSettings: { Ports: ports } };
}

test('image names: registry, tag and digest do not matter', () => {
	assert.equal(imageRepository('docker.io/library/postgres:16-alpine@sha256:abc123'), 'docker.io/library/postgres'); // pins-allow: a user's container, not the fleet's pin
	assert.equal(imageRepository('localhost:5000/mysql'), 'localhost:5000/mysql');
	for (const [image, driver] of [
		['postgres:16', 'postgres'], ['postgis/postgis:16-3.4', 'postgres'], ['timescale/timescaledb:latest-pg16', 'postgres'],
		['pgvector/pgvector:pg16', 'postgres'], ['bitnami/postgresql:16', 'postgres'], ['registry.example.com/team/snoutpod-postgres:17', 'postgres'],
		['mysql:8', 'mysql-aurora'], ['mariadb:11', 'mariadb'], ['mcr.microsoft.com/mssql/server:2022-latest', 'sqlserver'],
		['mcr.microsoft.com/azure-sql-edge', 'sqlserver'], ['gvenzl/oracle-free:23-slim', 'oracle'], ['clickhouse/clickhouse-server:24', 'clickhouse'],
		['mongo:7', 'mongodb'], ['icr.io/db2_community/db2', 'db2'],
	] as const) {
		assert.equal(engineForImage(image)?.driver, driver, image);
	}
	assert.equal(engineForImage('nginx:latest'), null);
	assert.equal(engineForImage('redis:7'), null);
});

test('credentials come from each image\'s documented variables', () => {
	const env = (pairs: Record<string, string>): Map<string, string> => new Map(Object.entries(pairs));
	assert.deepEqual(credentialsFromEnv('postgres', 'postgres', env({ POSTGRES_PASSWORD: 'pw' })), { username: 'postgres', password: 'pw', database: 'postgres', note: undefined });
	assert.deepEqual(credentialsFromEnv('postgres', 'postgres', env({ POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'shop' })), { username: 'app', password: 'pw', database: 'shop', note: undefined });
	assert.match(credentialsFromEnv('postgres', 'postgres', env({ POSTGRES_HOST_AUTH_METHOD: 'trust' })).note ?? '', /trusts/);
	assert.deepEqual(credentialsFromEnv('mysql-aurora', 'mysql', env({ MYSQL_ROOT_PASSWORD: 'r', MYSQL_DATABASE: 'shop' })), { username: 'root', password: 'r', database: 'shop' });
	assert.deepEqual(credentialsFromEnv('mysql-aurora', 'mysql', env({ MYSQL_ROOT_PASSWORD: 'r', MYSQL_USER: 'app', MYSQL_PASSWORD: 'a' })), { username: 'app', password: 'a', database: undefined });
	assert.match(credentialsFromEnv('mysql-aurora', 'mysql', env({ MYSQL_RANDOM_ROOT_PASSWORD: 'yes' })).note ?? '', /log/);
	assert.deepEqual(credentialsFromEnv('mariadb', 'mariadb', env({ MARIADB_ROOT_PASSWORD: 'm' })), { username: 'root', password: 'm', database: undefined });
	assert.deepEqual(credentialsFromEnv('mariadb', 'mariadb', env({ MYSQL_ROOT_PASSWORD: 'legacy' })).password, 'legacy', 'MariaDB still honours MYSQL_*');
	assert.deepEqual(credentialsFromEnv('sqlserver', 'mssql', env({ MSSQL_SA_PASSWORD: 'S' })), { username: 'sa', password: 'S' });
	assert.deepEqual(credentialsFromEnv('sqlserver', 'mssql', env({ SA_PASSWORD: 'old' })).password, 'old');
	assert.deepEqual(credentialsFromEnv('oracle', 'gvenzl/oracle-free', env({ ORACLE_PASSWORD: 'o' })), { username: 'system', password: 'o', database: 'FREEPDB1' });
	assert.deepEqual(credentialsFromEnv('clickhouse', 'clickhouse/clickhouse-server', env({ CLICKHOUSE_USER: 'u', CLICKHOUSE_PASSWORD: 'p', CLICKHOUSE_DB: 'd' })), { username: 'u', password: 'p', database: 'd' });
	assert.deepEqual(credentialsFromEnv('mongodb', 'mongo', env({ MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'x' })), { username: 'root', password: 'x' });
	assert.deepEqual(credentialsFromEnv('db2', 'db2', env({ DB2INST1_PASSWORD: 'd', DBNAME: 'testdb' })), { username: 'db2inst1', password: 'd', database: 'testdb' });
});

test('a published postgres container carries its password and localhost port', () => {
	const f = containerFound(SOCK, 'Docker', container('postgres:16', ['POSTGRES_PASSWORD=pw', 'PATH=/usr/bin'], { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '55432' }, { HostIp: '::', HostPort: '55432' }] }));
	assert.ok(f);
	assert.deepEqual([f.values.host, f.values.port, f.values.username, f.values.password, f.values.database], ['localhost', 55432, 'postgres', 'pw', 'postgres']);
	assert.equal(f.importsPassword, true);
	assert.equal(f.supported, true);
	assert.deepEqual(f.ref, { file: SOCK, connId: 'a'.repeat(64) });
	assert.equal(f.sourceName, 'db');
});

test('an unpublished container is listed as unsupported, with how to publish it', () => {
	const f = containerFound(SOCK, 'Docker', container('mysql:8', ['MYSQL_ROOT_PASSWORD=r'], { '3306/tcp': null, '33060/tcp': null }));
	assert.equal(f?.supported, false);
	assert.match(f?.note ?? '', /-p 3306:3306/);
});

test('an unknown image with a database port is a guess; one without is nothing', () => {
	const guess = containerFound(SOCK, 'Podman', container('acme/custom-db', [], { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] }));
	assert.equal(guess?.tentative, true);
	assert.equal(guess?.values.driver, 'postgres');
	assert.match(guess?.note ?? '', /Podman/);
	assert.equal(containerFound(SOCK, 'Docker', container('nginx', [], { '80/tcp': [{ HostPort: '8080' }] })), null);
});

test('our stack: recognised by its label, named, with the owner role; its other parts are not databases', () => {
	const labels = { 'com.snoutdata.stack': '1', 'com.snoutdata.component': 'postgres' };
	const env = ['SNOUTPOD_REF=abcdefghjkmnp', 'SNOUTPOD_OWNER_PASSWORD=owner-pw', 'POSTGRES_USER=admin', 'POSTGRES_PASSWORD=admin-pw'];
	const f = containerFound(SOCK, 'Podman', { ...container('localhost/whatever:1', env, { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }] }), Config: { Image: 'localhost/whatever:1', Env: env, Labels: labels } });
	assert.equal(f?.sourceName, 'SnoutData stack (abcdefghjkmnp)');
	assert.deepEqual([f?.values.username, f?.values.password, f?.values.database, f?.values.port], ['abcdefghjkmnp_owner', 'owner-pw', 'abcdefghjkmnp', 54322]);
	// A pod started before the label existed is still ours: the runtime has always stamped snoutpod.ref.
	const older = containerFound(SOCK, 'Podman', { ...container('registry.example.com/team/snoutpod-postgres:17', env, { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }] }), Config: { Image: 'registry.example.com/team/snoutpod-postgres:17', Env: env, Labels: { 'snoutpod.ref': 'abcdefghjkmnp' } } });
	assert.equal(older?.sourceName, 'SnoutData stack (abcdefghjkmnp)');
	const auth = { ...container('snout-auth', [], {}), Config: { Image: 'snout-auth', Env: [], Labels: { 'com.snoutdata.stack': '1', 'com.snoutdata.component': 'auth' } } };
	assert.equal(containerFound(SOCK, 'Docker', auth), null);
	const svc = { ...container('postgrest', [], { '3000/tcp': [{ HostPort: '3000' }] }), Config: { Image: 'postgrest', Env: [], Labels: { 'snoutpod.ref': 'abcdefghjkmnp', 'snoutpod.service': 'rest' } } };
	assert.equal(containerFound(SOCK, 'Docker', svc), null);
	// A local project's metadata service is a stock postgres, known only by its compose project.
	const compose = (service: string): Record<string, string> => ({ 'com.docker.compose.project': 'snout-abcdefghjkmnp', 'com.docker.compose.service': service });
	const metaEnv = ['POSTGRES_USER=postgres', 'POSTGRES_PASSWORD=m', 'POSTGRES_DB=realtime'];
	const meta = { ...container('postgres:17-alpine', metaEnv, {}), Config: { Image: 'postgres:17-alpine', Env: metaEnv, Labels: compose('metadata') } };
	assert.equal(containerFound(SOCK, 'Docker', meta), null);
	const db = containerFound(SOCK, 'Docker', { ...container('registry.example.com/team/snoutpod-postgres:17', env, { '5432/tcp': [{ HostPort: '54342' }] }), Config: { Image: 'registry.example.com/team/snoutpod-postgres:17', Env: env, Labels: { ...labels, ...compose('db') } } });
	assert.equal(db?.supported, true);
});

test('a container on the host network is reachable at its own port without publishing it', () => {
	const c: ContainerInspect = { ...container('postgres:16-alpine', ['POSTGRES_PASSWORD=rl'], {}), HostConfig: { NetworkMode: 'host' } };
	const f = containerFound(SOCK, 'Podman', c);
	assert.equal(f?.supported, true);
	assert.deepEqual([f?.values.host, f?.values.port, f?.values.password], ['localhost', 5432, 'rl']);
	assert.match(f?.note ?? '', /shares this computer's network/);
});

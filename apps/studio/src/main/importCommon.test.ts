/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeXml, findElements, firstElementText, mapDriver, mapEnvironment, mapFlavor, parseJdbcUrl, parseXmlTree, xmlChild, xmlDescendants, xmlText } from './importCommon';

test('mapDriver picks MariaDB before the generic MySQL match', () => {
	assert.equal(mapDriver('mariadb org.mariadb.jdbc.Driver'), 'mariadb');
	assert.equal(mapDriver('mysql com.mysql.cj.jdbc.Driver'), 'mysql-aurora');
	assert.equal(mapDriver('aurora'), 'mysql-aurora');
});

test('mapDriver maps the common engines (incl. SQL Server / Navicat spellings)', () => {
	assert.equal(mapDriver('postgresql'), 'postgres');
	// Redshift has its own driver now (its catalog is not Postgres's), and a Redshift JDBC URL
	// often names postgresql too — so it must win over the generic Postgres match.
	assert.equal(mapDriver('redshift'), 'redshift');
	assert.equal(mapDriver('jdbc:redshift://c.eu-west-1.redshift.amazonaws.com:5439/dev'), 'redshift');
	assert.equal(mapDriver('com.sap.db.jdbc.Driver hana'), 'hana');
	assert.equal(mapDriver('SQL Server'), 'sqlserver');
	assert.equal(mapDriver('ms_sql microsoft'), 'sqlserver');
	assert.equal(mapDriver('oracle'), 'oracle');
	assert.equal(mapDriver('db2'), 'db2');
	assert.equal(mapDriver('mongodb'), null);
});

test('parseJdbcUrl pulls host/port/database from a JDBC URL', () => {
	assert.deepEqual(parseJdbcUrl('jdbc:mysql://db.example.com:3307/shop?useSSL=true'), {
		host: 'db.example.com', port: 3307, database: 'shop',
	});
	assert.deepEqual(parseJdbcUrl('jdbc:postgresql://localhost/app'), {
		host: 'localhost', port: undefined, database: 'app',
	});
	assert.deepEqual(parseJdbcUrl(undefined), {});
});

test('mapEnvironment normalizes tool-specific labels', () => {
	assert.equal(mapEnvironment('production'), 'prod');
	assert.equal(mapEnvironment('qa'), 'stage');
	assert.equal(mapEnvironment('dev'), 'dev');
	assert.equal(mapEnvironment('whatever'), undefined);
});

test('decodeXml resolves named and numeric entities', () => {
	assert.equal(decodeXml('a &amp; b &lt;c&gt; &quot;d&quot; &#65; &#x42;'), 'a & b <c> "d" A B');
});

test('findElements reads both block and self-closing elements with decoded attrs', () => {
	const xml = `<Connections>
		<Connection ConnectionName="main &amp; co" ConnType="MySQL" Host="h1" Port="3306" UserName="root"/>
		<data-source name="pg" uuid="u-1"><jdbc-url>jdbc:postgresql://h2:5432/app</jdbc-url><user-name>postgres</user-name></data-source>
	</Connections>`;

	const conns = findElements(xml, 'Connection');
	assert.equal(conns.length, 1);
	assert.equal(conns[0].attrs.ConnectionName, 'main & co');
	assert.equal(conns[0].attrs.Host, 'h1');

	const sources = findElements(xml, 'data-source');
	assert.equal(sources.length, 1);
	assert.equal(sources[0].attrs.uuid, 'u-1');
	assert.equal(firstElementText(sources[0].inner, 'jdbc-url'), 'jdbc:postgresql://h2:5432/app');
	assert.equal(firstElementText(sources[0].inner, 'user-name'), 'postgres');
	assert.equal(firstElementText(sources[0].inner, 'missing'), undefined);
});

test('a wire-compatible engine imports as its base driver plus a flavor', () => {
	assert.equal(mapDriver('postgresql cockroachdb jdbc:postgresql://h:26257/db'), 'postgres');
	assert.equal(mapFlavor('postgresql cockroachdb jdbc:postgresql://h:26257/db'), 'cockroachdb');
	// TiDB's profile never says "mysql", so without the flavor it would not import at all.
	assert.equal(mapDriver('tidb'), 'mysql-aurora');
	assert.equal(mapFlavor('tidb'), 'tidb');
	assert.equal(mapDriver('greenplum'), 'postgres');
	assert.equal(mapFlavor('greenplum'), 'greenplum');
	assert.equal(mapFlavor('postgresql org.postgresql.Driver'), undefined);
	assert.equal(mapFlavor('create table'), undefined);
});

test('a ClickHouse profile imports as the ClickHouse driver', () => {
	assert.equal(mapDriver('clickhouse com.clickhouse.jdbc.ClickHouseDriver jdbc:clickhouse://h:8123/db'), 'clickhouse');
});

test('parseXmlTree: nested same-name elements, attributes in either quote, CDATA, comments', () => {
	const tree = parseXmlTree(`<?xml version="1.0"?><!-- c --><a x='1'><value key="outer"><value key="inner">v &amp; w</value></value><b><![CDATA[<raw>]]></b><e/></a>`);
	const a = tree.children[0];
	assert.equal(a.attrs.x, '1');
	const outer = xmlChild(a, 'value');
	assert.equal(outer?.attrs.key, 'outer');
	assert.equal(outer?.children[0].text, 'v & w');
	assert.equal(xmlText(a, 'b'), '<raw>');
	assert.deepEqual(xmlDescendants(a, 'value').map((n) => n.attrs.key), ['outer'], 'does not descend into a match');
	assert.equal(xmlChild(a, 'e')?.children.length, 0);
});

test('parseXmlTree: a stray close tag unwinds to the element it names, and garbage is empty', () => {
	const tree = parseXmlTree('<a><b><c>1</b><d>2</d></a>');
	assert.deepEqual(tree.children[0].children.map((n) => n.name), ['b', 'd']);
	assert.equal(parseXmlTree('no markup').children.length, 0);
});

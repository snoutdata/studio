/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { appliesToLabel, planFor, policyLabel, principalLabel, privilegesFor, securityCatalogFor, securityEmitterFor, securitySupport } from './plan';
import type { SecurityChange } from './types';

/** The SQL for a single-statement change, for the many one-liner assertions below. */
function sql(driverId: string, change: SecurityChange): string {
	const plan = planFor(driverId, [change]);
	assert.equal(plan.statements.length, 1, `expected one statement, got ${plan.statements.length}`);
	return plan.statements[0].sql;
}

const SUPPORTED = ['postgres', 'mysql-aurora', 'mariadb', 'sqlserver', 'oracle', 'clickhouse'];

describe('securitySupport', () => {
	it('supports the four covered engines and reports their shape', () => {
		for (const driverId of SUPPORTED) {
			const support = securitySupport(driverId);
			assert.equal(support.supported, true, driverId);
			assert.equal(support.hasAccounts, true, driverId);
			assert.ok(support.principalKinds.length > 0, driverId);
			assert.ok(support.grantScopes.length > 0, driverId);
			assert.ok(securityCatalogFor(driverId));
			assert.ok(securityEmitterFor(driverId));
		}
	});

	it('says WHY an unsupported engine is unsupported, in a sentence', () => {
		for (const driverId of ['sqlite', 'duckdb', 'mongodb', 'pinecone', 'snowflake', 'db2', 'hana', 'redshift']) {
			const support = securitySupport(driverId);
			assert.equal(support.supported, false, driverId);
			assert.ok(support.reason && support.reason.endsWith('.'), `${driverId} needs a reason sentence`);
			assert.equal(securityCatalogFor(driverId), null);
		}
	});

	it('distinguishes "has no users" from "not supported yet"', () => {
		// SQLite will never grow users; Snowflake has them and we have not covered it. Saying
		// "coming soon" for SQLite would promise something that cannot arrive, and the flag is what
		// lets the connection tree offer the screen for one and not the other.
		assert.match(securitySupport('sqlite').reason ?? '', /no users/i);
		assert.equal(securitySupport('sqlite').hasAccounts, false);
		assert.equal(securitySupport('duckdb').hasAccounts, false);
		assert.equal(securitySupport('pinecone').hasAccounts, false);
		assert.match(securitySupport('snowflake').reason ?? '', /not supported yet/i);
		assert.equal(securitySupport('snowflake').hasAccounts, true);
		assert.equal(securitySupport('mongodb').hasAccounts, true);
		// An engine we have never heard of is assumed to have accounts: a new SQL backend almost
		// certainly does, and hiding the screen silently is the worse of the two guesses.
		assert.equal(securitySupport('some-new-engine').hasAccounts, true);
	});

	it('gives a log service no users, on every vendor', () => {
		// The credential is the cloud account the connection references and the permissions live in
		// the provider's IAM, so "Users & Privileges" on a CloudWatch connection is a row that can
		// only ever apologise. Answered by backend kind, so a fourth log service is right for free.
		for (const driverId of ['cloudwatch', 'azureMonitor', 'gcpLogging']) {
			assert.equal(securitySupport(driverId).hasAccounts, false, driverId);
			assert.equal(securitySupport(driverId).supported, false, driverId);
			assert.match(securitySupport(driverId).reason ?? '', /no database users/i, driverId);
		}
	});

	it('only MySQL and MariaDB identify a principal by host', () => {
		assert.equal(securitySupport('mysql-aurora').usesHost, true);
		assert.equal(securitySupport('mariadb').usesHost, true);
		assert.equal(securitySupport('postgres').usesHost, false);
		assert.equal(securitySupport('sqlserver').usesHost, false);
		assert.equal(securitySupport('oracle').usesHost, false);
	});

	it('refuses to plan for an engine it does not support', () => {
		assert.throws(
			() => planFor('sqlite', [{ kind: 'drop-principal', principal: { name: 'a' }, principalKind: 'user' }]),
			/SQLite has no users/,
		);
	});
});

describe('catalog SQL', () => {
	it('every catalog query is a read-only SELECT', () => {
		for (const driverId of SUPPORTED) {
			const catalog = securityCatalogFor(driverId);
			assert.ok(catalog);
			for (const query of [...catalog.principals, ...catalog.grants]) {
				assert.ok(query.candidates.length > 0, `${driverId}/${query.label} has no candidates`);
				for (const candidate of query.candidates) {
					assert.match(candidate.trimStart(), /^SELECT\b/i, `${driverId}/${query.label} must start with SELECT`);
					assert.doesNotMatch(candidate, /;\s*\S/, `${driverId}/${query.label} must be one statement`);
				}
			}
		}
	});

	it('every catalog query aliases the contract columns', () => {
		for (const driverId of SUPPORTED) {
			const catalog = securityCatalogFor(driverId);
			assert.ok(catalog);
			for (const query of catalog.principals) {
				for (const candidate of query.candidates) {
					for (const column of ['AS name', 'AS kind', 'AS can_login', 'AS is_superuser', 'AS member_of']) {
						assert.ok(candidate.includes(column), `${driverId}/${query.label} is missing "${column}"`);
					}
				}
			}
			for (const query of catalog.grants) {
				for (const candidate of query.candidates) {
					for (const column of ['AS grantee', 'AS scope', 'AS privilege', 'AS is_grantable', 'AS is_deny']) {
						assert.ok(candidate.includes(column), `${driverId}/${query.label} is missing "${column}"`);
					}
				}
			}
		}
	});

	it('Oracle falls back from the dba_ views to what any account can read', () => {
		const catalog = securityCatalogFor('oracle');
		const users = catalog?.principals.find((query) => query.label === 'users');
		assert.ok(users);
		assert.match(users.candidates[0], /dba_users/);
		assert.match(users.candidates[1], /all_users/);
	});

	it('SQL Server asks for server logins separately from database principals', () => {
		// Two queries, because the login list needs server-level visibility the connection may
		// not have — losing it must cost a warning, not the whole screen.
		const catalog = securityCatalogFor('sqlserver');
		assert.equal(catalog?.principals.length, 2);
		assert.match(catalog.principals[1].candidates[0], /sys\.server_principals/);
	});

	it('SQL Server reads DENY as well as GRANT', () => {
		const permissions = securityCatalogFor('sqlserver')?.grants[0].candidates[0] ?? '';
		assert.match(permissions, /state IN \('G', 'W', 'D'\)/);
		assert.match(permissions, /state = 'D' THEN 1 ELSE 0 END AS is_deny/);
	});

	it('Postgres reads the catalog ACLs, not the information_schema views', () => {
		// information_schema.table_privileges is filtered to the CURRENT user's own grants, so an
		// administrator inspecting someone else would be shown an empty list.
		const grants = securityCatalogFor('postgres')?.grants.map((query) => query.candidates[0]).join('\n') ?? '';
		assert.match(grants, /aclexplode/);
		assert.doesNotMatch(grants, /information_schema\.table_privileges/i);
		assert.match(grants, /COALESCE\(g\.rolname, 'PUBLIC'\)/);
	});

	it('MySQL splits the GRANTEE pair back into user and host', () => {
		const grants = securityCatalogFor('mysql-aurora')?.grants[0].candidates[0] ?? '';
		assert.match(grants, /SUBSTRING_INDEX\(GRANTEE, '@', 1\)\) AS grantee/);
		assert.match(grants, /SUBSTRING_INDEX\(GRANTEE, '@', -1\)\) AS grantee_host/);
	});

	it('MariaDB reads roles from its own catalog, not MySQL 8s', () => {
		const mariadb = securityCatalogFor('mariadb')?.principals[0].candidates[0] ?? '';
		const mysql = securityCatalogFor('mysql-aurora')?.principals[0].candidates[0] ?? '';
		assert.match(mariadb, /mysql\.roles_mapping/);
		assert.match(mysql, /mysql\.role_edges/);
	});
});

describe('creating a principal', () => {
	it('Postgres creates a role with LOGIN and a password', () => {
		const plan = planFor('postgres', [{ kind: 'create-principal', draft: { kind: 'user', name: 'app', password: 'hunter2' } }]);
		assert.equal(plan.statements[0].sql, `CREATE ROLE "app" WITH LOGIN PASSWORD 'hunter2'`);
		assert.equal(plan.statements[0].carriesSecret, true);
		assert.equal(plan.statements[0].destructive, false);
	});

	it('Postgres creates a plain role with NOLOGIN', () => {
		assert.equal(
			sql('postgres', { kind: 'create-principal', draft: { kind: 'role', name: 'readers' } }),
			`CREATE ROLE "readers" WITH NOLOGIN`,
		);
	});

	it('MySQL creates the account at a host, defaulting to %', () => {
		assert.equal(
			sql('mysql-aurora', { kind: 'create-principal', draft: { kind: 'user', name: 'app', host: 'localhost', password: 'p' } }),
			`CREATE USER 'app'@'localhost' IDENTIFIED BY 'p'`,
		);
		assert.equal(
			sql('mysql-aurora', { kind: 'create-principal', draft: { kind: 'user', name: 'app', password: 'p' } }),
			`CREATE USER 'app'@'%' IDENTIFIED BY 'p'`,
		);
	});

	it('SQL Server creates the login AND the database user that maps to it', () => {
		// A user with no login authenticates as nobody, which is indistinguishable from a wrong
		// password to whoever tries to connect.
		const plan = planFor('sqlserver', [{ kind: 'create-principal', draft: { kind: 'user', name: 'app', password: 'p' } }]);
		assert.deepEqual(plan.statements.map((s) => s.sql), [
			`CREATE LOGIN [app] WITH PASSWORD = 'p'`,
			`CREATE USER [app] FOR LOGIN [app]`,
		]);
	});

	it('SQL Server creates a passwordless user WITHOUT LOGIN rather than a broken one', () => {
		assert.equal(
			sql('sqlserver', { kind: 'create-principal', draft: { kind: 'user', name: 'app' } }),
			`CREATE USER [app] WITHOUT LOGIN`,
		);
	});

	it('Oracle grants CREATE SESSION, without which the account cannot connect at all', () => {
		const plan = planFor('oracle', [{ kind: 'create-principal', draft: { kind: 'user', name: 'app', password: 'p' } }]);
		assert.deepEqual(plan.statements.map((s) => s.sql), [
			`CREATE USER "APP" IDENTIFIED BY "p"`,
			`GRANT CREATE SESSION TO "APP"`,
		]);
	});

	it('Oracle refuses to create a user with no password', () => {
		assert.throws(() => planFor('oracle', [{ kind: 'create-principal', draft: { kind: 'user', name: 'app' } }]), /needs a password/);
	});

	it('grants the requested roles as part of creating the principal', () => {
		const plan = planFor('postgres', [{ kind: 'create-principal', draft: { kind: 'user', name: 'app', password: 'p', memberOf: ['readers', 'writers'] } }]);
		assert.deepEqual(plan.statements.slice(1).map((s) => s.sql), [
			`GRANT "readers" TO "app"`,
			`GRANT "writers" TO "app"`,
		]);
	});
});

describe('granting and revoking', () => {
	const table = { scope: 'table' as const, schema: 'public', object: 'orders' };

	it('Postgres grants on a qualified table', () => {
		assert.equal(
			sql('postgres', { kind: 'grant', principal: { name: 'app' }, target: table, privileges: ['SELECT', 'INSERT'] }),
			`GRANT SELECT, INSERT ON "public"."orders" TO "app"`,
		);
	});

	it('MySQL grants on database.table, with the host in the grantee', () => {
		assert.equal(
			sql('mysql-aurora', { kind: 'grant', principal: { name: 'app', host: '%' }, target: { scope: 'table', database: 'shop', object: 'orders' }, privileges: ['SELECT'] }),
			'GRANT SELECT ON `shop`.`orders` TO \'app\'@\'%\'',
		);
	});

	it('MySQL grants server-wide on *.*', () => {
		assert.equal(
			sql('mysql-aurora', { kind: 'grant', principal: { name: 'app' }, target: { scope: 'global' }, privileges: ['PROCESS'] }),
			`GRANT PROCESS ON *.* TO 'app'@'%'`,
		);
	});

	it('SQL Server puts no ON clause on a database-scope permission', () => {
		assert.equal(
			sql('sqlserver', { kind: 'grant', principal: { name: 'app' }, target: { scope: 'database' }, privileges: ['CONNECT'] }),
			`GRANT CONNECT TO [app]`,
		);
	});

	it('SQL Server scopes a schema grant with SCHEMA::', () => {
		assert.equal(
			sql('sqlserver', { kind: 'grant', principal: { name: 'app' }, target: { scope: 'schema', schema: 'dbo' }, privileges: ['SELECT'] }),
			`GRANT SELECT ON SCHEMA::[dbo] TO [app]`,
		);
	});

	it('Oracle uses ADMIN OPTION for a system privilege and GRANT OPTION for an object one', () => {
		// The two are not interchangeable: the wrong keyword is a syntax error.
		assert.equal(
			sql('oracle', { kind: 'grant', principal: { name: 'app' }, target: { scope: 'global' }, privileges: ['CREATE TABLE'], withGrantOption: true }),
			`GRANT CREATE TABLE TO "APP" WITH ADMIN OPTION`,
		);
		assert.equal(
			sql('oracle', { kind: 'grant', principal: { name: 'app' }, target: { scope: 'table', schema: 'hr', object: 'employees' }, privileges: ['SELECT'], withGrantOption: true }),
			`GRANT SELECT ON "HR"."EMPLOYEES" TO "APP" WITH GRANT OPTION`,
		);
	});

	it('Oracle refuses a schema-wide grant instead of emitting something that is not Oracle', () => {
		assert.throws(
			() => planFor('oracle', [{ kind: 'grant', principal: { name: 'app' }, target: { scope: 'schema', schema: 'hr' }, privileges: ['SELECT'] }]),
			/no schema-wide or database-wide GRANT/,
		);
	});

	it('Postgres refuses a server-wide grant, which it does not have', () => {
		assert.throws(
			() => planFor('postgres', [{ kind: 'grant', principal: { name: 'app' }, target: { scope: 'global' }, privileges: ['SELECT'] }]),
			/no server-wide GRANT/,
		);
	});

	it('attaches the column list to each privilege, not once to the list', () => {
		// `GRANT SELECT, UPDATE (a) ON t` grants SELECT on the whole table and UPDATE on one
		// column, which is not what was asked for.
		assert.equal(
			sql('postgres', { kind: 'grant', principal: { name: 'app' }, target: { scope: 'column', schema: 'public', object: 'orders', columns: ['total', 'status'] }, privileges: ['SELECT', 'UPDATE'] }),
			`GRANT SELECT ("total", "status"), UPDATE ("total", "status") ON "public"."orders" TO "app"`,
		);
	});

	it('marks a revoke as destructive and a grant as not', () => {
		const grant = planFor('postgres', [{ kind: 'grant', principal: { name: 'app' }, target: table, privileges: ['SELECT'] }]);
		const revoke = planFor('postgres', [{ kind: 'revoke', principal: { name: 'app' }, target: table, privileges: ['SELECT'] }]);
		assert.equal(grant.statements[0].destructive, false);
		assert.equal(revoke.statements[0].destructive, true);
		assert.match(revoke.statements[0].description, /^Take SELECT on public\.orders away from app\.$/);
	});

	it('rejects a privilege that is not a privilege', () => {
		// Privileges cannot be quoted, so they are the one interpolation that must be validated.
		assert.throws(
			() => planFor('postgres', [{ kind: 'grant', principal: { name: 'app' }, target: table, privileges: ['SELECT; DROP TABLE orders'] }]),
			/is not a valid privilege name/,
		);
	});

	it('rejects a name carrying a statement terminator', () => {
		assert.throws(
			() => planFor('postgres', [{ kind: 'drop-principal', principal: { name: 'app; DROP DATABASE x' }, principalKind: 'user' }]),
			/not allowed in a name/,
		);
	});

	it('escapes a quote in a name rather than letting it break out', () => {
		assert.equal(
			sql('postgres', { kind: 'drop-principal', principal: { name: 'we"ird' }, principalKind: 'user' }),
			`DROP ROLE "we""ird"`,
		);
		assert.equal(
			sql('mysql-aurora', { kind: 'drop-principal', principal: { name: "o'brien" }, principalKind: 'user' }),
			`DROP USER 'o''brien'@'%'`,
		);
	});

	it('escapes a quote in a password', () => {
		const statement = planFor('mysql-aurora', [{ kind: 'set-password', principal: { name: 'app' }, password: "it's" }]).statements[0];
		assert.equal(statement.sql, `ALTER USER 'app'@'%' IDENTIFIED BY 'it''s'`);
		assert.equal(statement.carriesSecret, true);
	});
});

/**
 * The string literals and quoted identifiers in a statement, read the way a server whose literals
 * take backslash escapes reads them (MySQL and MariaDB by default, ClickHouse always). With
 * `noBackslashEscapes`, the way MySQL reads them under NO_BACKSLASH_ESCAPES. Returns each quoted
 * token's decoded value and the text left between them, so a test can see how many principals a
 * statement really names.
 */
function lexQuoted(sqlText: string, noBackslashEscapes = false): { values: string[]; between: string[] } {
	const values: string[] = [];
	const between: string[] = [];
	let gap = '';
	let i = 0;
	while (i < sqlText.length) {
		const quote = sqlText[i];
		if (quote !== "'" && quote !== '`') {
			gap += quote;
			i++;
			continue;
		}
		between.push(gap);
		gap = '';
		let value = '';
		i++;
		for (;;) {
			assert.ok(i < sqlText.length, `unterminated quoted token in ${sqlText}`);
			const c = sqlText[i];
			if (c === '\\' && !noBackslashEscapes) {
				value += sqlText[i + 1];
				i += 2;
			} else if (c === quote && sqlText[i + 1] === quote) {
				value += quote;
				i += 2;
			} else if (c === quote) {
				i++;
				break;
			} else {
				value += c;
				i++;
			}
		}
		values.push(value);
	}
	between.push(gap);
	return { values, between };
}

describe('MySQL and MariaDB literals hold one value each, whatever the name', () => {
	// A name ending in a backslash, and a host that tries to end the account and name a second one.
	const user = 'x\\';
	const host = ", evil@'%' --";

	for (const driverId of ['mysql-aurora', 'mariadb']) {
		it(`${driverId}: a granted role reaches the one account named, and no other`, () => {
			const statement = sql(driverId, { kind: 'grant-role', principal: { name: user, host }, role: 'r' });
			const read = lexQuoted(statement);
			assert.deepEqual(read.values, ['r', user, host]);
			assert.deepEqual(read.between, ['GRANT ', ' TO ', '@', '']);
			// Under NO_BACKSLASH_ESCAPES the values read differently, but there are still exactly three
			// literals and nothing between or after them but the statement's own words.
			const strict = lexQuoted(statement, true);
			assert.equal(strict.values.length, 3);
			assert.deepEqual(strict.between, ['GRANT ', ' TO ', '@', '']);
		});

		it(`${driverId}: a role name and a password ending in a backslash stay inside their literal`, () => {
			const statements = planFor(driverId, [
				{ kind: 'create-principal', draft: { kind: 'user', name: 'app', host: '%', password: 'pa\\', memberOf: ["r\\' , 'admin"] } },
			]).statements.map((statement) => statement.sql);
			assert.deepEqual(lexQuoted(statements[0]).values, ['app', '%', 'pa\\']);
			assert.deepEqual(lexQuoted(statements[1]).values, ["r\\' , 'admin", 'app', '%']);
			assert.deepEqual(lexQuoted(statements[1]).between, ['GRANT ', ' TO ', '@', '']);
		});
	}

	it('a typed newline escape is the two characters typed, not a newline', () => {
		const statement = sql('mysql-aurora', { kind: 'set-password', principal: { name: 'app' }, password: 'a\\nb' });
		assert.deepEqual(lexQuoted(statement).values, ['app', '%', 'a\\nb']);
	});

	it('ClickHouse names and passwords stay inside their quotes too', () => {
		const statement = sql('clickhouse', { kind: 'grant-role', principal: { name: 'x\\' }, role: 'r\\` TO `admin' });
		const read = lexQuoted(statement);
		assert.deepEqual(read.values, ['r\\` TO `admin', 'x\\']);
		assert.deepEqual(read.between, ['GRANT ', ' TO ', '']);
		const password = sql('clickhouse', { kind: 'set-password', principal: { name: 'app' }, password: 'pa\\' });
		assert.deepEqual(lexQuoted(password).values, ['app', 'pa\\']);
	});
});

describe('disabling an account', () => {
	it('locks the account where the engine can, and removes LOGIN where it cannot', () => {
		assert.equal(sql('mysql-aurora', { kind: 'set-enabled', principal: { name: 'app' }, enabled: false }), `ALTER USER 'app'@'%' ACCOUNT LOCK`);
		assert.equal(sql('oracle', { kind: 'set-enabled', principal: { name: 'app' }, enabled: false }), `ALTER USER "APP" ACCOUNT LOCK`);
		assert.equal(sql('sqlserver', { kind: 'set-enabled', principal: { name: 'app' }, enabled: false }), `ALTER LOGIN [app] DISABLE`);
		// Postgres has no disable; NOLOGIN is the closest true equivalent and keeps the grants.
		assert.equal(sql('postgres', { kind: 'set-enabled', principal: { name: 'app' }, enabled: false }), `ALTER ROLE "app" WITH NOLOGIN`);
	});

	it('counts disabling as destructive and enabling as not', () => {
		assert.equal(planFor('postgres', [{ kind: 'set-enabled', principal: { name: 'a' }, enabled: false }]).statements[0].destructive, true);
		assert.equal(planFor('postgres', [{ kind: 'set-enabled', principal: { name: 'a' }, enabled: true }]).statements[0].destructive, false);
	});
});

describe('ClickHouse', () => {
	it('quotes with backticks and addresses a grant as *.*, db.* or db.table', () => {
		// There is no level between a database and a table: a ClickHouse database IS the namespace.
		assert.equal(sql('clickhouse', { kind: 'grant', principal: { name: 'app' }, target: { scope: 'global' }, privileges: ['SELECT'] }), 'GRANT SELECT ON *.* TO `app`');
		assert.equal(sql('clickhouse', { kind: 'grant', principal: { name: 'app' }, target: { scope: 'database', database: 'shop' }, privileges: ['SELECT'] }), 'GRANT SELECT ON `shop`.* TO `app`');
		assert.equal(sql('clickhouse', { kind: 'grant', principal: { name: 'app' }, target: { scope: 'table', database: 'shop', object: 'events' }, privileges: ['SELECT', 'INSERT'] }), 'GRANT SELECT, INSERT ON `shop`.`events` TO `app`');
		assert.equal(sql('clickhouse', { kind: 'revoke', principal: { name: 'app' }, target: { scope: 'table', database: 'shop', object: 'events' }, privileges: ['SELECT'] }), 'REVOKE SELECT ON `shop`.`events` FROM `app`');
	});

	it('refuses a schema grant by saying ClickHouse has none, rather than inventing one', () => {
		assert.throws(
			() => planFor('clickhouse', [{ kind: 'grant', principal: { name: 'a' }, target: { scope: 'schema', schema: 'public' }, privileges: ['USAGE'] }]),
			/ClickHouse has no schemas/,
		);
		assert.deepEqual(privilegesFor('clickhouse', 'schema'), []);
		assert.ok(!securitySupport('clickhouse').grantScopes.includes('schema'));
	});

	it('puts the column list on each privilege, the way ClickHouse takes it', () => {
		assert.equal(
			sql('clickhouse', { kind: 'grant', principal: { name: 'app' }, target: { scope: 'column', database: 'shop', object: 'events', columns: ['id', 'ts'] }, privileges: ['SELECT'] }),
			'GRANT SELECT(`id`, `ts`) ON `shop`.`events` TO `app`',
		);
	});

	it('names the password scheme rather than leaving it to the server', () => {
		// A server configured for plaintext would otherwise quietly store one.
		const plan = planFor('clickhouse', [{ kind: 'create-principal', draft: { kind: 'user', name: 'app', password: 'hunter2' } }]);
		assert.match(plan.statements[0].sql, /^CREATE USER `app` IDENTIFIED WITH sha256_password BY 'hunter2'$/);
		assert.equal(plan.statements[0].carriesSecret, true);
	});

	it('creates a role without a password, and says so if one is offered', () => {
		assert.equal(sql('clickhouse', { kind: 'create-principal', draft: { kind: 'role', name: 'readers' } }), 'CREATE ROLE `readers`');
		assert.throws(
			() => planFor('clickhouse', [{ kind: 'create-principal', draft: { kind: 'role', name: 'readers', password: 'x' } }]),
			/role has no password/,
		);
	});

	it('drops a role with DROP ROLE and a user with DROP USER', () => {
		assert.equal(sql('clickhouse', { kind: 'drop-principal', principal: { name: 'readers' }, principalKind: 'role' }), 'DROP ROLE `readers`');
		assert.equal(sql('clickhouse', { kind: 'drop-principal', principal: { name: 'app' }, principalKind: 'user' }), 'DROP USER `app`');
	});

	it('switches an account off with VALID UNTIL, because ClickHouse has no DISABLE', () => {
		assert.equal(sql('clickhouse', { kind: 'set-enabled', principal: { name: 'app' }, enabled: false }), `ALTER USER \`app\` VALID UNTIL '1970-01-02 00:00:00'`);
		assert.equal(sql('clickhouse', { kind: 'set-enabled', principal: { name: 'app' }, enabled: true }), `ALTER USER \`app\` VALID UNTIL 'infinity'`);
	});

	it('reads a partial revoke as a deny, because that is what it does', () => {
		// REVOKE SELECT(secret) after a wider GRANT SELECT does not delete the grant: it adds a row
		// that beats it. Showing only the grants would say the opposite of what is true.
		const grants = securityCatalogFor('clickhouse')?.grants ?? [];
		assert.equal(grants.length, 1);
		assert.match(grants[0].candidates[0], /is_partial_revoke AS is_deny/);
	});

	it('reads the enum as a string, and the scope off which level is filled in', () => {
		const query = securityCatalogFor('clickhouse')!.grants[0].candidates[0];
		// An Enum16 compared or concatenated directly is a type error on every server.
		assert.match(query, /toString\(access_type\) AS privilege/);
		assert.match(query, /multiIf\(column IS NOT NULL, 'column', table IS NOT NULL, 'table', database IS NOT NULL, 'database', 'global'\) AS scope/);
	});

	it('finds the administrator by CREATE USER, not by an ALL row that does not exist', () => {
		// ClickHouse's own `default` holds about sixty separate global grants and no ALL at all.
		const users = securityCatalogFor('clickhouse')!.principals.find((q) => q.label === 'users')!;
		assert.match(users.candidates[0], /'CREATE USER'/);
		assert.match(users.candidates[0], /AS is_superuser/);
	});

	it('says where an account is defined, because users.xml cannot be changed with SQL', () => {
		const users = securityCatalogFor('clickhouse')!.principals.find((q) => q.label === 'users')!;
		assert.match(users.candidates[0], /users\.xml \(cannot be changed with SQL\)/);
	});

	it('reads users and roles as two queries against two catalogs', () => {
		const catalog = securityCatalogFor('clickhouse')!;
		assert.deepEqual(catalog.principals.map((q) => q.label), ['users', 'roles']);
		assert.match(catalog.principals[0].candidates[0], /FROM system\.users/);
		assert.match(catalog.principals[1].candidates[0], /FROM system\.roles/);
	});
});

describe('the plan itself', () => {
	it('carries a sentence for every statement', () => {
		const plan = planFor('postgres', [
			{ kind: 'create-principal', draft: { kind: 'user', name: 'app', password: 'p', memberOf: ['readers'] } },
			{ kind: 'grant', principal: { name: 'app' }, target: { scope: 'table', schema: 'public', object: 'orders' }, privileges: ['SELECT'] },
		]);
		assert.equal(plan.statements.length, 3);
		for (const statement of plan.statements) {
			assert.ok(statement.description.length > 0);
			assert.ok(statement.description.endsWith('.'));
			assert.ok(statement.id.length > 0);
		}
		assert.equal(new Set(plan.statements.map((s) => s.id)).size, 3, 'statement ids must be unique');
	});

	it('flags exactly the statements that carry a secret', () => {
		const plan = planFor('mysql-aurora', [
			{ kind: 'create-principal', draft: { kind: 'user', name: 'app', password: 'hunter2' } },
			{ kind: 'grant', principal: { name: 'app' }, target: { scope: 'table', database: 'shop', object: 'orders' }, privileges: ['SELECT'] },
		]);
		assert.deepEqual(plan.statements.map((s) => s.carriesSecret), [true, false]);
	});

	it('never emits a trailing semicolon', () => {
		// The drivers send one statement per call; Oracle rejects a terminator outright.
		for (const driverId of SUPPORTED) {
			const plan = planFor(driverId, [{ kind: 'set-enabled', principal: { name: 'app' }, enabled: false }]);
			for (const statement of plan.statements) {
				assert.doesNotMatch(statement.sql, /;\s*$/, driverId);
			}
		}
	});
});

describe('privilege pickers', () => {
	it('offers privileges for every scope the engine supports, and none for those it does not', () => {
		for (const driverId of SUPPORTED) {
			for (const scope of securitySupport(driverId).grantScopes) {
				assert.ok(privilegesFor(driverId, scope).length > 0, `${driverId}/${scope}`);
			}
		}
		// Postgres has no server-wide grant, so it offers no privileges for one.
		assert.equal(privilegesFor('postgres', 'global').length, 0);
	});
});

describe('principalLabel', () => {
	it('shows the host only where the host is part of the identity', () => {
		assert.equal(principalLabel({ name: 'app', host: '%' }), 'app@%');
		assert.equal(principalLabel({ name: 'app' }), 'app');
	});
});

describe('row policies, quotas and settings profiles', () => {
	const on = { database: 'shop', object: 'orders' };

	it('is offered by ClickHouse and by nobody else yet', () => {
		assert.deepEqual([...securitySupport('clickhouse').policyKinds], ['row-policy', 'quota', 'settings-profile']);
		for (const driverId of ['postgres', 'mysql-aurora', 'mariadb', 'sqlserver', 'oracle']) {
			assert.deepEqual(securitySupport(driverId).policyKinds, [], driverId);
		}
	});

	it('refuses BY NAME on an engine that does not do them', () => {
		// Postgres really has row policies. "Not supported yet" is the honest sentence; silence, or
		// a statement written by guesswork, is not.
		assert.throws(
			() => planFor('postgres', [{ kind: 'create-policy', draft: { kind: 'row-policy', name: 'p', ...on, expression: 'true' } }]),
			/Postgres row policy objects are not supported/);
		assert.throws(
			() => planFor('oracle', [{ kind: 'drop-policy', policy: { kind: 'quota', name: 'q' } }]),
			/Oracle quota objects are not supported/);
	});

	it('writes a row policy, with its filter as the person wrote it', () => {
		assert.equal(
			sql('clickhouse', { kind: 'create-policy', draft: { kind: 'row-policy', name: 'own_rows', ...on, expression: 'tenant_id = currentUser()', appliesTo: ['app'] } }),
			"CREATE ROW POLICY `own_rows` ON `shop`.`orders` USING tenant_id = currentUser() TO `app`");
		assert.equal(
			sql('clickhouse', { kind: 'create-policy', draft: { kind: 'row-policy', name: 'own_rows', ...on, expression: 'x > 0', restrictive: true, appliesTo: ['admin'], appliesToAll: true } }),
			"CREATE ROW POLICY `own_rows` ON `shop`.`orders` AS RESTRICTIVE USING x > 0 TO ALL EXCEPT `admin`");
	});

	it('refuses a filter that could carry a second statement', () => {
		// The one value on this screen that cannot be quoted or picked from a list. The review
		// sheet is the real control, and this is what stops it being shown half of what will run.
		for (const expression of ['1 = 1; DROP TABLE orders', 'x = 1 -- and the rest', 'x = 1 /* hidden */']) {
			assert.throws(
				() => planFor('clickhouse', [{ kind: 'create-policy', draft: { kind: 'row-policy', name: 'p', ...on, expression } }]),
				/cannot contain a semicolon or a comment/, expression);
		}
		// And an ordinary expression, which has spaces and operators, goes through untouched.
		assert.match(
			sql('clickhouse', { kind: 'create-policy', draft: { kind: 'row-policy', name: 'p', ...on, expression: "region = 'eu' AND amount >= 10" } }),
			/USING region = 'eu' AND amount >= 10$/);
	});

	it('writes a quota, and refuses a limit ClickHouse does not have', () => {
		assert.equal(
			sql('clickhouse', { kind: 'create-policy', draft: { kind: 'quota', name: 'reader', interval: { duration: 1, unit: 'hour', limits: [{ name: 'queries', value: '100' }, { name: 'read_rows', value: '1000000' }] }, appliesTo: ['app'] } }),
			"CREATE QUOTA `reader` KEYED BY user_name FOR INTERVAL 1 hour MAX queries = 100, read_rows = 1000000 TO `app`");
		// A window with no caps is ClickHouse's TRACKING ONLY, which is a real thing to want and
		// not an empty MAX clause.
		assert.match(
			sql('clickhouse', { kind: 'create-policy', draft: { kind: 'quota', name: 'watch', interval: { duration: 5, unit: 'minute', limits: [] } } }),
			/FOR INTERVAL 5 minute TRACKING ONLY$/);
		assert.throws(
			() => planFor('clickhouse', [{ kind: 'create-policy', draft: { kind: 'quota', name: 'q', interval: { duration: 1, unit: 'hour', limits: [{ name: 'queries; DROP', value: '1' }] } } }]),
			/is not something a ClickHouse quota can limit/);
		assert.throws(
			() => planFor('clickhouse', [{ kind: 'create-policy', draft: { kind: 'quota', name: 'q', interval: { duration: 1, unit: 'fortnight', limits: [] } } }]),
			/is not a window/);
		assert.throws(
			() => planFor('clickhouse', [{ kind: 'create-policy', draft: { kind: 'quota', name: 'q', interval: { duration: 1, unit: 'hour', limits: [{ name: 'queries', value: 'lots' }] } } }]),
			/has to be a number/);
	});

	it('writes a settings profile, quoting only what is not a number', () => {
		assert.equal(
			sql('clickhouse', { kind: 'create-policy', draft: { kind: 'settings-profile', name: 'lean', settings: [{ name: 'max_memory_usage', value: '1000000000' }, { name: 'log_comment', value: 'lean' }], appliesTo: ['app', 'reader'] } }),
			"CREATE SETTINGS PROFILE `lean` SETTINGS max_memory_usage = 1000000000, log_comment = 'lean' TO `app`, `reader`");
		assert.throws(
			() => planFor('clickhouse', [{ kind: 'create-policy', draft: { kind: 'settings-profile', name: 'p', settings: [{ name: 'readonly = 1, max_x', value: '1' }] } }]),
			/is not a valid setting name/);
	});

	it('drops and re-targets, naming the table only where there is one', () => {
		assert.equal(
			sql('clickhouse', { kind: 'drop-policy', policy: { kind: 'row-policy', name: 'own_rows', ...on } }),
			'DROP ROW POLICY `own_rows` ON `shop`.`orders`');
		assert.equal(
			sql('clickhouse', { kind: 'drop-policy', policy: { kind: 'settings-profile', name: 'lean' } }),
			'DROP SETTINGS PROFILE `lean`');
		assert.equal(
			sql('clickhouse', { kind: 'set-policy-principals', policy: { kind: 'quota', name: 'reader' }, appliesTo: ['app'], appliesToAll: false }),
			'ALTER QUOTA `reader` TO `app`');
		// Emptying the list has to SAY so: an ALTER with no TO clause changes nobody, so a screen
		// that removed the last name would silently do nothing.
		assert.equal(
			sql('clickhouse', { kind: 'set-policy-principals', policy: { kind: 'quota', name: 'reader' }, appliesTo: [], appliesToAll: false }),
			'ALTER QUOTA `reader` TO NONE');
		assert.equal(
			sql('clickhouse', { kind: 'set-policy-principals', policy: { kind: 'row-policy', name: 'p', ...on }, appliesTo: [], appliesToAll: true }),
			'ALTER ROW POLICY `p` ON `shop`.`orders` TO ALL');
	});

	it('marks the changes that take access away', () => {
		const dropped = planFor('clickhouse', [{ kind: 'drop-policy', policy: { kind: 'quota', name: 'q' } }]).statements[0];
		assert.equal(dropped.destructive, true);
		// Creating a row policy TAKES rows away from everyone it applies to, which is the opposite
		// of how a CREATE usually reads, so it is marked like a revoke.
		const policy = planFor('clickhouse', [{ kind: 'create-policy', draft: { kind: 'row-policy', name: 'p', ...on, expression: 'x' } }]).statements[0];
		assert.equal(policy.destructive, true);
		const profile = planFor('clickhouse', [{ kind: 'create-policy', draft: { kind: 'settings-profile', name: 'p', settings: [{ name: 'readonly', value: '1' }] } }]).statements[0];
		assert.equal(profile.destructive, false);
	});

	it('explains each statement in a sentence that names who it hits', () => {
		const plan = planFor('clickhouse', [{ kind: 'create-policy', draft: { kind: 'row-policy', name: 'own_rows', ...on, expression: 'x', appliesTo: ['admin'], appliesToAll: true } }]);
		assert.equal(plan.statements[0].description, 'Create the row policy own_rows on shop.orders, applying to everyone except admin.');
		assert.equal(policyLabel({ kind: 'quota', name: 'reader' }), 'quota reader');
		assert.equal(appliesToLabel([], false), 'nobody');
		assert.equal(appliesToLabel([], true), 'everyone');
	});

	it('reads the three catalogs with statements that only ever SELECT', () => {
		const catalog = securityCatalogFor('clickhouse');
		assert.ok(catalog?.policies);
		assert.deepEqual(catalog?.policies?.map((query) => query.label), ['row policies', 'quotas', 'settings profiles']);
		for (const query of catalog?.policies ?? []) {
			for (const candidate of query.candidates) {
				assert.match(candidate, /^SELECT/, query.label);
			}
		}
	});
});

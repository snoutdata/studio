/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DatabaseDriver, DriverFactory } from './databaseDriver';
import { createDb2Driver } from './db2/db2Driver';
import { createClickHouseDriver } from './clickhouse/clickhouseDriver';
import { createDuckDbDriver } from './duckdb/duckdbDriver';
import { createHanaDriver } from './hana/hanaDriver';
import { createMariaDbDriver } from './mariadb/mariadbDriver';
import { createMongoDriver } from './mongo/mongoDriver';
import { createMySqlAuroraDriver } from './mysql/mysqlAuroraDriver';
import { createOracleDriver } from './oracle/oracleDriver';
import { createPineconeDriver } from './pinecone/pineconeDriver';
import { createPostgresDriver } from './postgres/postgresDriver';
import { createRedshiftDriver } from './redshift/redshiftDriver';
import { createSnowflakeDriver } from './snowflake/snowflakeDriver';
import { createSqliteDriver } from './sqlite/sqliteDriver';
import { createSqlServerDriver } from './sqlserver/sqlServerDriver';
import { createAzureMonitorPlugin } from './telemetry/azureMonitor';
import { createCloudWatchTelemetryPlugin } from './telemetry/cloudwatch';
import { createGcpLoggingPlugin } from './telemetry/gcpLogging';
import { createTelemetryDriver } from './telemetry/telemetryDriver';
import { registerTelemetryPlugin } from './telemetry/telemetrySource';

const factories = new Map<string, DriverFactory>();

export function registerDriver(id: string, factory: DriverFactory): void {
	factories.set(id, factory);
}

export function createDriver(id: string): DatabaseDriver {
	const factory = factories.get(id);
	if (!factory) {
		const known = [...factories.keys()].join(', ') || '(none)';
		throw new Error(`Unknown database driver '${id}'. Registered drivers: ${known}.`);
	}
	return factory();
}

export function listDrivers(): string[] {
	return [...factories.keys()];
}

/** Call once at server startup. New vendors are added here only. */
export function registerBuiltInDrivers(): void {
	registerDriver('mysql-aurora', createMySqlAuroraDriver);
	registerDriver('mariadb', createMariaDbDriver);
	registerDriver('postgres', createPostgresDriver);
	registerDriver('sqlserver', createSqlServerDriver);
	registerDriver('oracle', createOracleDriver);
	registerDriver('db2', createDb2Driver);
	registerDriver('sqlite', createSqliteDriver);
	registerDriver('duckdb', createDuckDbDriver);
	registerDriver('snowflake', createSnowflakeDriver);
	registerDriver('redshift', createRedshiftDriver);
	registerDriver('hana', createHanaDriver);
	registerDriver('clickhouse', createClickHouseDriver);
	registerDriver('mongodb', createMongoDriver);
	registerDriver('pinecone', createPineconeDriver);
	registerBuiltInTelemetryPlugins();
}

/**
 * The cloud LOG services.
 *
 * Two registrations each, and they are different things: the PLUGIN is the vendor's API and query
 * language, and the DRIVER is one shared class (`telemetryDriver.ts`) that turns any of them into a
 * connection. So a fourth log service is a plugin and a line here, and no new driver.
 *
 * Statically imported for the reason `logSource.ts` records having shipped as a bug: a lazy
 * `require` of a RELATIVE path does not survive bundling. The driver INSTANCE and each vendor's SDK
 * are still lazy, so nothing is constructed and no SDK is loaded until a telemetry connection is
 * actually opened.
 */
function registerBuiltInTelemetryPlugins(): void {
	registerTelemetryPlugin('cloudwatch', createCloudWatchTelemetryPlugin);
	registerTelemetryPlugin('azureMonitor', createAzureMonitorPlugin);
	registerTelemetryPlugin('gcpLogging', createGcpLoggingPlugin);
	for (const service of ['cloudwatch', 'azureMonitor', 'gcpLogging']) {
		registerDriver(service, () => createTelemetryDriver(service));
	}
}

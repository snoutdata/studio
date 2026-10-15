/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Minimal ambient declaration for the parts of `snowflake-sdk` this driver uses. The module is
// loaded by dynamic require (a devDependency in dev, the on-demand component dir when packaged) and
// is never bundled (esbuild external), so we declare only the surface we call rather than depend on
// @types/snowflake-sdk. Mirrors the local db2/ibm_db.d.ts pattern.

declare module 'snowflake-sdk' {
	export interface SnowflakeError extends Error {
		code?: string | number;
		sqlState?: string;
	}

	export interface Column {
		getName(): string;
	}

	export interface Statement {
		getColumns(): Column[];
		/** Cancel this in-flight statement (server-side abort). */
		cancel(callback: (err: SnowflakeError | undefined) => void): void;
	}

	export interface ExecuteOptions {
		sqlText: string;
		binds?: unknown[];
		/** Return each row as an object keyed by column name (the SDK default). */
		complete: (err: SnowflakeError | undefined, stmt: Statement, rows: Record<string, unknown>[] | undefined) => void;
	}

	export interface Connection {
		connect(callback: (err: SnowflakeError | undefined, conn: Connection) => void): void;
		execute(options: ExecuteOptions): Statement;
		destroy(callback: (err: SnowflakeError | undefined, conn: Connection) => void): void;
	}

	export interface ConnectionOptions {
		account: string;
		username?: string;
		password?: string;
		database?: string;
		schema?: string;
		warehouse?: string;
		role?: string;
		host?: string;
		application?: string;
		clientSessionKeepAlive?: boolean;
	}

	export function createConnection(options: ConnectionOptions): Connection;
	export function configure(options: { logLevel?: string; additionalLogToConsole?: boolean }): void;
}

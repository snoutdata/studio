/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Minimal ambient types for the `ibm_db` client (it ships no bundled types and there is no
 *  @types/ibm_db). Only the surface the Db2 driver uses is declared: a connection pool keyed by
 *  connection string, callback-style query/close, and the module's default export object.
 *--------------------------------------------------------------------------------------------*/

declare module 'ibm_db' {
	export interface Db2Connection {
		query(sql: string, callback: (err: Error | null, rows: Record<string, unknown>[]) => void): void;
		query(sql: string, params: unknown[], callback: (err: Error | null, rows: Record<string, unknown>[]) => void): void;
		close(callback: (err: Error | null) => void): void;
		closeSync(): void;
	}

	export interface Db2Pool {
		open(connStr: string, callback: (err: Error | null, conn: Db2Connection) => void): void;
		close(callback?: (err: Error | null) => void): void;
		setMaxPoolSize(size: number): void;
	}

	export interface IbmDb {
		open(connStr: string, callback: (err: Error | null, conn: Db2Connection) => void): void;
		Pool: { new (): Db2Pool };
	}

	const ibmdb: IbmDb;
	export default ibmdb;
}

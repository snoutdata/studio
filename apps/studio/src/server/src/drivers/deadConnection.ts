/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Classification of pool/socket-level "the connection is dead" errors that we know
 * happen BEFORE the user's statement reached the server. Returning true here means
 * the driver can safely retry the query on a fresh connection without risking a
 * double-write/double-DDL — the server never saw the statement, so replaying it is
 * equivalent to running it once.
 *
 * Things deliberately NOT classified as preflight-dead:
 *   - mysql2 ECONNRESET / EPIPE mid-query (server may have run the statement)
 *   - pg "Connection terminated unexpectedly" (server may have run the statement)
 * Those still surface to the user — we don't silently retry writes/DDL that could
 * already have committed.
 */
export function isPreflightDeadConnectionError(err: unknown, vendor: 'mysql' | 'postgres' | 'sqlserver' | 'oracle' | 'db2' | 'hana'): boolean {
	if (!err || typeof err !== 'object') {
		return false;
	}
	const e = err as { code?: string; errno?: number; message?: string; fatal?: boolean };
	const code = e.code ?? '';
	const message = (e.message ?? '').toLowerCase();

	if (vendor === 'hana') {
		// @sap/hana-client surfaces a torn-down pooled connection with its own negative error codes
		// before the statement is sent: -10807 "connection down / session not connected" and -10709
		// "connection failed" are the two the pool hands back on a dead socket. A mid-query drop isn't
		// distinguishable here, so this stays conservative and only retries on those explicit signals.
		// hana-client reports `code` as a NUMBER, so compare it as text.
		const hanaCode = String((e as { code?: unknown }).code ?? '');
		if (hanaCode === '-10807' || hanaCode === '-10709' || message.includes('-10807') || message.includes('-10709')) {
			return true;
		}
		if (message.includes('connection down') || message.includes('not connected') || message.includes('session is not connected')) {
			return true;
		}
		return false;
	}

	if (vendor === 'db2') {
		// ibm_db surfaces a torn-down connection with a CLI/DRDA SQLCODE in the message before the
		// statement is sent: SQL30081N (communication error), SQL1224N (database agent could not be
		// started / connection no longer usable), or a "connection is closed" message. A mid-query
		// SQL30081N isn't distinguishable here, so this stays conservative and only retries on these.
		if (message.includes('sql30081') || message.includes('sql1224') || message.includes('sql1031')) {
			return true;
		}
		if (message.includes('connection is closed') || message.includes('connection is not active')) {
			return true;
		}
		return false;
	}

	if (vendor === 'oracle') {
		// oracledb surfaces a torn-down pooled connection with ORA-/NJS- codes in the message
		// before the statement is sent: ORA-03113 (end-of-file on the communication channel),
		// ORA-03114 (not connected to ORACLE), ORA-12541 (no listener), or the NJS connection-
		// pool/closed-connection errors. A mid-query ORA-03113 isn't distinguishable here, so
		// this stays conservative and only retries on these explicit signals.
		if (message.includes('ora-03113') || message.includes('ora-03114') || message.includes('ora-12541')) {
			return true;
		}
		if (message.includes('njs-500') || message.includes('njs-003') || message.includes('njs-040') || message.includes('connection is closed')) {
			return true;
		}
		return false;
	}

	if (vendor === 'sqlserver') {
		// tedious/mssql surface a torn-down pooled socket as an ESOCKET/ECONNCLOSED error,
		// or a "connection is closed"/"connection lost" message, before the statement is
		// sent — safe to recreate the pool and retry once. A mid-query ESOCKET (server may
		// have run the statement) isn't distinguishable here, so this stays conservative:
		// only the explicit closed/lost signals qualify.
		if (code === 'ECONNCLOSED' || message.includes('connection is closed') || message.includes('connection lost')) {
			return true;
		}
		return false;
	}

	if (vendor === 'mysql') {
		// mysql2 throws `Error: Connection is closed.` when the pooled connection's
		// underlying socket was closed by the server (idle wait_timeout, NLB cull,
		// OS sleep) before the query was issued — the query never reached the DB.
		if (message === 'connection is closed' || message === 'connection is closed.') {
			return true;
		}
		// PROTOCOL_CONNECTION_LOST is mysql2's signal that the socket was torn down
		// during the next-message handshake — also preflight.
		if (code === 'PROTOCOL_CONNECTION_LOST') {
			return true;
		}
		// Pool exhaustion timeouts on acquire — fresh acquire should work.
		if (code === 'POOL_CLOSED') {
			return false; // pool itself is shut → caller should reconnect, not retry
		}
		return false;
	}

	// Postgres: only the explicit administrator-shutdown SQLSTATEs are safe to retry —
	// the server tells us it terminated the backend before running anything.
	if (code === '57P01' || code === '57P02' || code === '57P03') {
		return true;
	}
	// node-postgres surfaces this exact message when acquiring from a dead idle client.
	if (message === 'connection terminated' || message.includes('client has encountered a connection error')) {
		return true;
	}
	return false;
}

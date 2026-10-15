/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Does this error string look like a dropped/dead connection rather than a real SQL
 * error? Shared by the renderer (to offer "Reconnect & retry" instead of "Fix with AI")
 * and the main process (to proactively mark a connection dropped the moment a query fails
 * this way, rather than waiting up to a heartbeat interval for the next probe to notice).
 */
export function looksLikeConnectionLoss(error: string): boolean {
	const s = error.toLowerCase();
	return s.includes('connection is closed')
		|| s.includes('connection terminated')
		|| s.includes('protocol_connection_lost')
		|| s.includes('econnreset')
		|| s.includes('epipe')
		|| s.includes('etimedout')
		|| isNotConnected(s)
		|| s.includes('server has gone away')
		|| s.includes('client has encountered a connection error');
}

/**
 * Does this error mean the connection simply isn't live (no pool/driver), as opposed to a
 * mid-query socket death? Matches both the server's `'<id>' is not connected` and a driver's
 * `<driver>: not connected` (e.g. after a user disconnect or an idle cull). Because the pool was
 * absent, NO statement was sent — so the manager can safely reconnect and replay the query once.
 */
export function isNotConnected(error: string): boolean {
	return error.toLowerCase().includes('not connected');
}

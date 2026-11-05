/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where a connection whose password is not stored gets one, each time its pool opens a
 * connection: a Cloud connection signing in as the person (`ConnectionConfig.cloudTokenSignIn`),
 * whose password is a database token that lasts an hour. The server holds no session and no
 * token; it asks main (`SnoutProtocol.ConnectionPassword`), which `server.ts` sets up here.
 */
let source: ((connectionId: string) => Promise<string>) | undefined;

export function setPasswordSource(fn: ((connectionId: string) => Promise<string>) | undefined): void {
	source = fn;
}

export function fetchPassword(connectionId: string): Promise<string> {
	if (!source) {
		return Promise.reject(new Error("This connection signs in with your SnoutData account, which is not available here."));
	}
	return source(connectionId);
}

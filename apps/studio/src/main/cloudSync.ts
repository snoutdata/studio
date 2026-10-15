/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../shared/connection';
import type { CloudApi } from './cloudApi';

// Keeps the connection list in step with SnoutData Cloud: every hosted database the signed-in
// account has shows up as a connection without an Import.
//
// Pure, like the rest of the desktop's cloud half: it takes a `CloudApi`, the connections that
// exist, the refs already seen and an `add` that does the saving, so every case is provable
// without a network. `cloudSyncStore.ts` holds the seen refs and `index.ts` wires the two.
//
// ## Seen, not merely missing
//
// A project is added the FIRST time this account's sync sees it, and never again. Adding
// everything that has no connection would bring back, on every launch, a connection the user
// deleted on purpose; remembering what has been offered is what makes a deletion stick. A
// project created from this app is marked seen at once for the same reason.
//
// ## Adds only
//
// A connection whose project has gone is left where it is by the SYNC: a list that failed or came
// back short must never cost somebody a connection. Deleting a project from the app is different
// and removes its connection (`deleteCloudProject`), because there the user asked. Existing connections
// are not rewritten either: re-reading a project's password is `project.connection.read` on the
// audit log, and a launch should not write one per database.

export interface CloudSyncResult {
	/** The signed-in account, or null when nobody is (then nothing else happened). */
	account: string | null;
	/** Refs added as connections this time. */
	added: string[];
	/** Every ref this account has now seen, to be stored for next time. */
	seen: string[];
}

export async function syncCloudConnections(
	api: CloudApi,
	existing: ConnectionConfig[],
	seenBefore: (account: string) => string[],
	add: (refs: string[]) => Promise<void>,
): Promise<CloudSyncResult> {
	const account = await api.account();
	if (!account) {
		return { account: null, added: [], seen: [] };
	}
	const projects = (await api.list()).filter((p) => p.state !== 'deleted' && p.desiredState !== 'deleted');
	const seen = new Set(seenBefore(account));
	const connected = new Set(existing.map((c) => c.cloudProjectRef).filter((ref): ref is string => !!ref));
	const missing = projects.map((p) => p.ref).filter((ref) => !seen.has(ref) && !connected.has(ref));
	if (missing.length > 0) {
		await add(missing);
	}
	for (const project of projects) {
		seen.add(project.ref);
	}
	return { account, added: missing, seen: [...seen] };
}

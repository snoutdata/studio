/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReadOnlyEnforcement } from '../../../shared/engine';

/** The one session a statement runs on, as a read-only run needs it. */
export interface ReadOnlySession {
	/** Run one statement on this session (results ignored). */
	run(sql: string): Promise<unknown>;
	/** The session could not be put back as it was found: make sure no later caller gets it (a
	 *  pooled connection is destroyed rather than released). A single embedded connection that
	 *  cannot be replaced may make this a no-op. */
	discard(): void;
	/** Run one query on this session and say whether its first column of its first row is true.
	 *  Needed only for an enforcement with `verify`; a session without it fails such a run. */
	check?(sql: string): Promise<boolean>;
}

/** The run left the transaction `begin` opened, or made it writable. */
export const READ_ONLY_RUN_LEFT = 'The query left the read-only transaction it was run in (it ended it, or made it writable), so its result is not shown. Anything it changed after that may have been committed.';

/**
 * Run `body` with the database asked to refuse writes (`enforcement.begin`), then put the session
 * back (`enforcement.end`) whether `body` succeeded or not. The answer is `body`'s, and so is the
 * error when it failed.
 *
 * - A `begin` that fails means the read does NOT run: it was asked to be read-only and the
 *   database would not say yes. The session is discarded, since a partial `begin` may have
 *   changed it.
 * - An `end` that fails discards the session, so a connection left read-only (or inside the
 *   read-only transaction) never reaches an interactive write later.
 *
 * - A `verify` (Postgres) is asked after `body` succeeds: a run no longer inside the read-only
 *   transaction fails, and `end` still rolls back whatever is open.
 *
 * Nothing is run when the enforcement has no statements (`setting` and `none`).
 */
export async function withReadOnlySession<T>(enforcement: ReadOnlyEnforcement, session: ReadOnlySession, body: () => Promise<T>): Promise<T> {
	if (enforcement.begin.length === 0 && enforcement.end.length === 0) {
		return body();
	}
	try {
		for (const statement of enforcement.begin) {
			await session.run(statement);
		}
	} catch (err) {
		session.discard();
		throw new Error(`The database could not start a read-only run, so the query was not sent: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		const answer = await body();
		if (enforcement.verify) {
			let inside: boolean;
			try {
				if (!session.check) {
					throw new Error('this session cannot run the check');
				}
				inside = await session.check(enforcement.verify);
			} catch (err) {
				throw new Error(`The database could not confirm the query stayed read-only, so its result is not shown: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (!inside) {
				throw new Error(READ_ONLY_RUN_LEFT);
			}
		}
		return answer;
	} finally {
		try {
			for (const statement of enforcement.end) {
				await session.run(statement);
			}
		} catch {
			session.discard();
		}
	}
}

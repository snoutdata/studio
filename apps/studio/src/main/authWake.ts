/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  What the account side does when the OS wakes.
 *
 *  With a session, the client's token auto-refresh was paused on suspend and is restarted once the
 *  auth backend answers again (a refresh fired into a half-up network can lose its response and get
 *  the session revoked; see `waitForAuthReachable`). Without one there is nothing to refresh, so a
 *  wake contacts nobody: a signed-out build, including one built from source, talks only to the
 *  databases its user configured.
 *
 *  Pure (the network and the client are handed in) so it is tested without Electron.
 *--------------------------------------------------------------------------------------------*/

export interface AuthWakeHost {
	/** Is there a session to keep fresh (signed in, or one saved on disk being restored)? */
	hasSession(): boolean;
	/** Resolve once the auth backend answers; rejects if it never does in its window. */
	waitForReachable(): Promise<void>;
	startAutoRefresh(): Promise<void>;
	stopAutoRefresh(): Promise<void>;
}

/** Wired to `powerMonitor` 'suspend'. Best-effort and local: it never touches the network. */
export async function authOnSuspend(host: AuthWakeHost): Promise<void> {
	if (!host.hasSession()) {
		return;
	}
	try {
		await host.stopAutoRefresh();
	} catch {
		// Best-effort: if it can't pause, the worst case is the pre-existing behaviour.
	}
}

/**
 * Wired to `powerMonitor` 'resume'. With a session: wait for the backend, then restart auto-refresh,
 * even when the network never settled, so a flaky wake cannot leave refresh paused for good. Without
 * one: nothing at all.
 */
export async function authOnResume(host: AuthWakeHost): Promise<void> {
	if (!host.hasSession()) {
		return;
	}
	try {
		await host.waitForReachable();
	} catch {
		// Network never settled in the window: start anyway, the client retries itself.
	}
	try {
		await host.startAutoRefresh();
	} catch {
		// Best-effort.
	}
}

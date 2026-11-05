/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Right after an interactive sign-in, tell the account this computer's timezone.
//
// A SnoutData Cloud project's default maintenance window (when a running database may be moved to
// another server) is 2 to 6 AM in its owner's timezone, and the control plane learns it from the
// sign-ins: `set_my_timezone(tz, 'signin')` stores it unless the owner set one by hand on the
// dashboard's Account page. The website, the dashboard and the
// CLI do the same on theirs.
//
// Main reads the timezone itself: Node's Intl in main answers from the same operating system the
// renderer would, so nothing crosses IPC for it. Only `AuthStore.completeSignIn` calls this, never a
// launch restore, so it is off the boot path; it is fired without await and never throws.

/** This computer's IANA timezone, or null when Intl does not say. */
export function systemTimezone(): string | null {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
	} catch {
		return null;
	}
}

/** Store it through `send` (the control plane's `set_my_timezone`); a failure is logged and swallowed. */
export async function reportSignInTimezone(
	send: (timezone: string) => PromiseLike<{ error: { message: string } | null }>,
	timezone: string | null = systemTimezone(),
	log: (message: string) => void = (message) => console.warn(message),
): Promise<void> {
	if (!timezone) {
		return;
	}
	try {
		const { error } = await send(timezone);
		if (error) {
			log(`[auth] could not record the timezone at sign-in: ${error.message}`);
		}
	} catch (err) {
		log(`[auth] could not record the timezone at sign-in: ${err instanceof Error ? err.message : String(err)}`);
	}
}

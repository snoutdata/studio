/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a failed backend call means for the SESSION — kept apart from authStore.ts so it can be
// tested without Electron, and because the question it answers is one authStore kept getting
// wrong: is this "we could not find out" or "the token you are holding is no good"?

/**
 * Whether an error means the backend REFUSED the token we sent, as opposed to a network failure,
 * a timeout, or a real answer we did not like.
 *
 * Two shapes, because two servers say it differently and the remedy is the same for both:
 *
 *  - **PostgREST** answers a token it cannot verify with 401 and `code: "PGRST301"`. Measured
 *    against our own stack with a foreign-signed JWT: `{"code":"PGRST301","details":"No suitable
 *    key was found to decode the JWT","message":"No suitable key or wrong key type"}`.
 *  - **The auth server** answers the same class of token (one signed by a key it does not accept)
 *    with 403 and `error_code: "bad_jwt"`.
 *
 * A bare 401/403 counts too: a Snout Function that checks the JWT itself answers that way and
 * carries neither code.
 */
export function isRejectedToken(error: unknown): boolean {
	if (!error || typeof error !== 'object') {
		return false;
	}
	const e = error as { code?: unknown; error_code?: unknown; status?: unknown };
	return e.code === 'PGRST301' || e.code === 'bad_jwt' || e.error_code === 'bad_jwt' || e.status === 401 || e.status === 403;
}

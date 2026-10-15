/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The most recent user-facing error, held DOM-free so the `get_last_error` capability can hand
 * it to the assistant ("fix it for me") without the user pasting anything. Fed by the
 * notifications store (notifications.ts) whenever it records an error; node-safe (no DOM, no
 * React, no localStorage) so the capability stays testable.
 */

export interface LastError {
	ts: number;
	title: string;
	/** The raw message (e.g. the driver error). */
	detail?: string;
	/** Where it came from, e.g. 'connection', 'query'. */
	source?: string;
	/** The connection involved, so the assistant can map it to a saved connection to edit. */
	connectionId?: string;
	/** The connection's label, resolved at record time. */
	connectionLabel?: string;
	/** The SQL that produced the error, if any. */
	sql?: string;
}

let last: LastError | undefined;

/** Record the latest error (called by the notifications store for error-severity entries). */
export function recordError(error: LastError): void {
	last = error;
}

/** The most recent error, or undefined if none this session. */
export function lastError(): LastError | undefined {
	return last;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LogsQuery } from '../../shared/engine';
import { logShapeOf, logTimeOf } from './logLine';

/*---------------------------------------------------------------------------------------------
 *  SURROUNDING EVENTS for one line of the log reader.
 *
 *  A query answers with the lines that MATCHED, and a matched line is rarely the whole story: the
 *  error is the last line of a request whose first nine lines said what went wrong. CloudWatch's
 *  console answers that by showing the line in its stream, with what came before and after it, and
 *  this is the same read: the anchor's own stream (where the provider has streams), unfiltered, in
 *  both directions from its timestamp.
 *
 *  Pure apart from the `run` it is handed, so the windowing rules are testable without a cloud.
 *
 *  The two directions are NOT symmetric, and that is the part worth reading. A scan runs oldest
 *  first and may stop early at a LIMIT, so "the next 25" is one cheap call. "The previous 25" has
 *  no such shape: a limit returns the OLDEST events of a window, not the ones nearest the anchor.
 *  So it reads a short window ending at the anchor and keeps its tail, widening when the window
 *  held too few and narrowing when it held so many the scan hit its cap (a capped scan's tail is
 *  the middle of the window, not the edge next to the anchor).
 *--------------------------------------------------------------------------------------------*/

/** One event around the anchor, in the reader's own terms. */
export interface ContextEvent {
	/** Dedupe key: the provider's event id, or the clock plus the text when the id is absent. */
	key: string;
	at: number | null;
	message: unknown;
	stream: string | null;
}

/** What a context read runs: a structured log query, answered as rows plus the cap flag. */
export type RunLogsQuery = (query: LogsQuery) => Promise<{ fields: readonly { name: string }[]; rows: readonly unknown[][]; truncated: boolean }>;

/** Where the surrounding events are read from. */
export interface ContextAnchor {
	scope: string;
	/** Null when the provider has no streams or the projection dropped the column: the whole scope
	 *  is read then, which is what the console does at log-group level. */
	stream: string | null;
}

/** Events loaded per click, in either direction. */
export const CONTEXT_PAGE = 25;
/** The first window looked back over. Widened ten-fold while it holds too few events. */
const BACK_FIRST_MS = 60_000;
/** The furthest back a read will look for earlier events: a stream quiet for longer than a day has
 *  no "just before" worth showing, and the read has to end somewhere. */
const BACK_MAX_MS = 24 * 60 * 60_000;
/** The narrowest window, for a stream so busy a whole second overflows the scan's cap. */
const BACK_MIN_MS = 1_000;
/** How far forward a read looks for later events. The limit stops it early; this only bounds it. */
const FORWARD_MAX_MS = 24 * 60 * 60_000;
/** Reads a single "earlier" click may make before it settles for what it has. */
const MAX_ATTEMPTS = 6;

/** A cell as text, the way the grid shows it. Here rather than imported from DataGrid, which is a
 *  component and would drag React into a pure module. */
function cellText(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** The key a context event is deduplicated by. Exported so the reader can key its own anchor row. */
export function contextKey(id: unknown, at: number | null, message: unknown): string {
	const text = cellText(id);
	return text !== null && text !== '' ? `id:${text}` : `at:${at ?? ''}:${cellText(message) ?? ''}`;
}

function baseQuery(anchor: ContextAnchor, start: number, end: number): LogsQuery {
	const query: LogsQuery = { scope: anchor.scope, start, end };
	if (anchor.stream !== null) {
		// The prefix is what the provider can push down (CloudWatch's logStreamNamePrefix); the
		// predicate is what makes it exact, since `app/1` is also a prefix of `app/10`.
		query.streamPrefix = anchor.stream;
		query.where = [{ op: '=', field: 'stream', value: anchor.stream }];
	}
	return query;
}

function eventsOf(fields: readonly { name: string }[], rows: readonly unknown[][]): ContextEvent[] {
	const shape = logShapeOf(fields);
	if (!shape) {
		return [];
	}
	return rows.map((row) => {
		const at = shape.ts === null ? null : logTimeOf(row[shape.ts]);
		const message = row[shape.message];
		return {
			key: contextKey(shape.id === null ? null : row[shape.id], at, message),
			at,
			message,
			stream: shape.stream === null ? null : cellText(row[shape.stream]),
		};
	});
}

/**
 * Up to `count` events before `boundary`, oldest first, none of them in `known`.
 *
 * `boundary` is the clock of the earliest event already shown. The window ends one millisecond PAST
 * it, so events sharing that millisecond are not lost; the ones already on screen are dropped by
 * key. `exhausted` is true when a full day back held fewer than asked for.
 */
export async function eventsBefore(run: RunLogsQuery, anchor: ContextAnchor, boundary: number, known: ReadonlySet<string>, count = CONTEXT_PAGE): Promise<{ events: ContextEvent[]; exhausted: boolean }> {
	const end = boundary + 1;
	let span = BACK_FIRST_MS;
	// Once a window has overflowed, widening again would only overflow again.
	let overflowed = false;
	let fresh: ContextEvent[] = [];
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const result = await run(baseQuery(anchor, end - span, end));
		fresh = eventsOf(result.fields, result.rows).filter((event) => !known.has(event.key));
		if (result.truncated && span > BACK_MIN_MS) {
			overflowed = true;
			span = Math.max(BACK_MIN_MS, Math.floor(span / 10));
			continue;
		}
		if (fresh.length >= count || overflowed || span >= BACK_MAX_MS) {
			break;
		}
		span = Math.min(BACK_MAX_MS, span * 10);
	}
	return { events: fresh.slice(-count), exhausted: fresh.length < count && span >= BACK_MAX_MS };
}

/**
 * Up to `count` events after `boundary`, oldest first, none of them in `known`.
 *
 * One read: a scan with a LIMIT stops as soon as it has enough, so the window only bounds how far
 * it may go. The limit is padded by what is already known at the boundary, since those rows come
 * back too and are dropped here.
 */
export async function eventsAfter(run: RunLogsQuery, anchor: ContextAnchor, boundary: number, known: ReadonlySet<string>, count = CONTEXT_PAGE, now = Date.now()): Promise<{ events: ContextEvent[]; exhausted: boolean }> {
	const query = baseQuery(anchor, boundary, Math.max(boundary + 1, Math.min(boundary + FORWARD_MAX_MS, now + 60_000)));
	query.limit = count + known.size;
	const result = await run(query);
	const fresh = eventsOf(result.fields, result.rows).filter((event) => !known.has(event.key));
	return { events: fresh.slice(0, count), exhausted: result.rows.length < query.limit };
}

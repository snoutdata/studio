/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Icon } from './Icon';
import { cellText, wrappedLines } from './DataGrid';
import {
	highlightParts,
	jsonTokens,
	matchContext,
	logTimeOf,
	logTimeText,
	parseLogLine,
	prettyJson,
	spansDays,
	type LogLine,
	type LogShape,
} from '../logLine';
import { contextKey, eventsAfter, eventsBefore, type ContextEvent, type RunLogsQuery } from '../logContext';
import type { QueryField } from '../../../shared/query';

/*---------------------------------------------------------------------------------------------
 *  The LOG READER.
 *
 *  A telemetry result arrives as a table — `ts`, `message`, `stream`, `id`, `ingested_at` — and the
 *  grid was the only thing that could show it. That is the wrong instrument. A grid spends its width
 *  equally on five columns, four of which repeat the same value down the whole page (one stream, one
 *  ingestion second, an event id nobody reads), and gives the fifth, which is the entire content of
 *  the row, whatever is left. An embedded request object then ends at the cell edge, and the JSON
 *  view shows ONE row's escaped `\t`s and `\n`s.
 *
 *  So this is a stream of lines instead: time, level, and the line itself, with everything the line
 *  was carrying (its own repeated timestamp, its request id, its payload) moved into an expansion
 *  that opens in place. What the vendor consoles do, and for the same reason.
 *
 *  Three things about the implementation are load-bearing.
 *
 *    - READING is all this does. There is no editing path (an ingested event cannot be changed) and
 *      no column model, which is what lets it be a few hundred lines instead of {@link DataGrid}.
 *    - It is virtualized over VARIABLE heights, because an expanded row is as tall as its payload.
 *      Rows lay out in normal flow between two spacers, exactly as the grid's full-wrap mode does,
 *      so a height computed one line short shows blank space rather than clipping the text.
 *    - The parse is {@link parseLogLine} and lives elsewhere, pure and tested. Nothing here decides
 *      what a line MEANS; it only decides how much room the answer takes.
 *--------------------------------------------------------------------------------------------*/

/** A collapsed row: one line of text plus its padding. Matches `--row-h`. */
const ROW_H = 24;
/** One line of wrapped monospace text in the expansion. */
const LINE_H = 18;
/** The expansion's own furniture, in the order `.log-detail` spends it: the metadata strip (24),
 *  the block's bottom padding (8) and the open row's bottom rule (1). A strip that WRAPS onto a
 *  second line is taller than this, which is why rows lay out in flow: the estimate being low
 *  costs a little scroll unevenness and never a clipped payload. */
const DETAIL_CHROME = 24 + 8 + 1;
/** The expansion's own left inset plus its right padding — the width its text does NOT get.
 *  Must agree with `.log-detail`'s padding in styles.css. */
const DETAIL_INDENT = 46;
/** Everything the COLLAPSED line spends before its text: the caret, the row number, the clock and
 *  the level, plus the padding either side. Rounded UP on purpose — it is used to work out how much
 *  of a line the reader can actually see, and believing a search hit is visible when it is one
 *  character off the right edge is the failure worth avoiding. */
const LINE_INDENT = 240;
/** Rows rendered above and below the visible window, so a fast scroll doesn't show a gap. */
const OVERSCAN = 6;
/** Past this many rows the height of every expansion is estimated rather than counted — the count
 *  walks the whole page, and "All rows" on a busy log group is tens of thousands of them. */
const MEASURE_LIMIT = 5000;

/** Width of one character in the reader's monospace font, measured once off a real line. */
let cachedCharW = 0;
function charWidth(root: HTMLElement | null): number {
	if (cachedCharW > 0) {
		return cachedCharW;
	}
	const ctx = document.createElement('canvas').getContext('2d');
	const sample = root?.querySelector('.log-summary');
	if (!ctx) {
		return 7.2;
	}
	ctx.font = (sample ? getComputedStyle(sample).font : '') || '12px monospace';
	const w = ctx.measureText('M'.repeat(50)).width / 50;
	if (w > 0) {
		cachedCharW = w;
	}
	return w > 0 ? w : 7.2;
}

/** Index of the row containing pixel `y`, given running row-top offsets (binary search). */
function rowAt(offsets: number[], y: number): number {
	let lo = 0;
	let hi = offsets.length - 2;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (offsets[mid] <= y) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return Math.max(0, lo);
}

/** One surrounding event, parsed once when it arrives. */
interface ContextLine extends ContextEvent {
	line: LogLine;
}

/**
 * The surrounding events open under one row: the row's own event among the ones before and after
 * it in its stream, the way CloudWatch shows a line in context. `events` is in stream order and
 * always holds the anchor, so "earlier" and "later" are read from its two ends.
 */
interface RowContext {
	status: 'loading' | 'ready' | 'error';
	error?: string;
	anchorKey: string;
	events: ContextLine[];
	/** Which end is being read right now, so its button can say so and not be pressed twice. */
	busy: 'before' | 'after' | null;
	/** A read came back short: there is nothing further that way (within the day a read looks). */
	startReached: boolean;
	endReached: boolean;
}

/** One row, read once: its clock, its parsed line, and the raw values behind it. */
interface LogEntry {
	at: number | null;
	line: LogLine;
	row: unknown[];
}

/**
 * `text` with every occurrence of `query` marked.
 *
 * One function for every place the reader shows text, so a search highlights in the line, in the
 * metadata chips, in the prose and inside a pretty-printed payload rather than in whichever one
 * happened to get the treatment. An empty query costs one array and no wrapping.
 */
function marked(text: string, query: string): JSX.Element | string {
	if (query.trim() === '') {
		return text;
	}
	const parts = highlightParts(text, query);
	if (parts.length === 1) {
		return text;
	}
	return <>{parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}</>;
}

/** The expansion's text, as one block: prose kept, every payload pretty-printed. */
function detailText(line: LogLine): string {
	if (line.segments.length === 0) {
		return line.body;
	}
	return line.segments.map((segment) => (segment.kind === 'json' ? prettyJson(segment.value) : segment.text)).join('');
}

function parsed(events: ContextEvent[]): ContextLine[] {
	return events.map((event) => ({ ...event, line: parseLogLine(event.message) }));
}

/** Height the surrounding-events block adds to an open row: a head, a button each end, a line per
 *  event, and the whole text of any line opened out. An estimate, like the rest (rows lay out in
 *  flow, so low costs scroll unevenness and never clipping). */
function contextHeight(ctx: RowContext, wrapped: ReadonlySet<string>, cols: number): number {
	if (ctx.status === 'loading') {
		return 2 * ROW_H + 8;
	}
	let h = (ctx.events.length + 3) * ROW_H + 8;
	for (const event of ctx.events) {
		if (wrapped.has(event.key)) {
			h += Math.max(0, wrappedLines(detailText(event.line), cols) * LINE_H - ROW_H);
		}
	}
	return h + (ctx.status === 'error' ? ROW_H : 0);
}

interface LogViewProps {
	/** Where the log contract's columns sit in the result. */
	shape: LogShape;
	fields: QueryField[];
	/** Rows on the page being shown. */
	count: number;
	/** A row of the page, by page-relative index. */
	getRow(index: number): unknown[];
	/** The number the first row of the page carries, so the reader agrees with the grid's gutter. */
	rowOffset?: number;
	/** The parent's statement that the rows behind `getRow` changed. Resets scroll and expansion. */
	resetKey: string;
	/** The footer's search text, highlighted wherever it appears in a line. */
	search?: string;
	/** Open every row (the footer's expand toggle). */
	expandAll?: boolean;
	/** Report the row the reader is on, so the assistant can ground in the line being looked at. */
	onActiveRow?(index: number | null): void;
	/** How to read the events around a row: the scope the result came from and a way to query it.
	 *  Absent (a native query that named no scope, a disconnected tab) hides the action. */
	context?: { scope: string; run: RunLogsQuery };
}

export function LogView({ shape, fields, count, getRow, rowOffset = 0, resetKey, search = '', expandAll = false, onActiveRow, context }: LogViewProps): JSX.Element {
	const scrollRef = useRef<HTMLDivElement>(null);
	// Force a re-render on scroll/resize so the visible window recomputes.
	const [, bump] = useReducer((n: number) => n + 1, 0);
	const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
	const [cursor, setCursor] = useState(0);
	// Which row's raw text was last copied, so the button can say so for a moment.
	const [copied, setCopied] = useState<number | null>(null);
	// Surrounding events, per page-relative row, and which of their lines are opened out in full.
	const [contexts, setContexts] = useState<ReadonlyMap<number, RowContext>>(() => new Map());
	const [wrappedContext, setWrappedContext] = useState<ReadonlySet<string>>(() => new Set());
	// Bumped with every new page, so a read that lands after the rows changed is thrown away rather
	// than attached to whichever row now has its index.
	const generation = useRef(0);

	// Read every line of the page once. `getRow` is re-created on every render, so `resetKey` (the
	// parent's identity for these rows) is what says the work has to be done again.
	const entries = useMemo<LogEntry[]>(() => {
		const out: LogEntry[] = [];
		for (let i = 0; i < count; i++) {
			const row = getRow(i);
			out.push({ at: shape.ts === null ? null : logTimeOf(row[shape.ts]), line: parseLogLine(row[shape.message]), row });
		}
		return out;
		// eslint-disable-next-line react-hooks/exhaustive-deps -- see `resetKey`.
	}, [resetKey, count, shape]);

	// A new page is a new reading: nothing expanded, cursor at the top, scrolled to the first line.
	useEffect(() => {
		setOpen(new Set());
		setCursor(0);
		setCopied(null);
		setContexts(new Map());
		setWrappedContext(new Set());
		generation.current += 1;
		if (scrollRef.current) {
			scrollRef.current.scrollTop = 0;
		}
	}, [resetKey]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) {
			return;
		}
		// Coalesce to one re-render per frame: a trackpad fires many scroll events per frame and
		// each render walks the visible window.
		let raf: number | null = null;
		const onScroll = (): void => {
			if (raf !== null) {
				return;
			}
			raf = requestAnimationFrame(() => { raf = null; bump(); });
		};
		el.addEventListener('scroll', onScroll);
		const observer = new ResizeObserver(() => bump());
		observer.observe(el);
		return () => {
			el.removeEventListener('scroll', onScroll);
			observer.disconnect();
			if (raf !== null) {
				cancelAnimationFrame(raf);
			}
		};
	}, []);

	const onActiveRowRef = useRef(onActiveRow);
	onActiveRowRef.current = onActiveRow;
	useEffect(() => {
		onActiveRowRef.current?.(count === 0 ? null : cursor);
	}, [cursor, count]);

	const isOpen = useCallback((i: number): boolean => expandAll || open.has(i), [expandAll, open]);
	const query = search.trim();

	function toggle(i: number): void {
		setCursor(i);
		setOpen((prev) => {
			const next = new Set(prev);
			// With "expand all" on, the per-row set is what CLOSES one: the row is open either way,
			// so adding it would be a no-op click.
			if (expandAll ? !next.has(i) : next.has(i)) {
				next.delete(i);
			} else {
				next.add(i);
			}
			return next;
		});
	}

	// The date is only worth a column when the result crosses one.
	const withDate = useMemo(() => spansDays(entries[0]?.at ?? null, entries[entries.length - 1]?.at ?? null), [entries]);

	// Running top edge of every row. An open row is as tall as its text wraps to at the reader's
	// current width; a closed one is a single line. Rebuilt whenever any of those change.
	const width = scrollRef.current?.clientWidth ?? 0;
	const charW = charWidth(scrollRef.current);
	const cols = Math.max(20, Math.floor((width - DETAIL_INDENT - 12) / charW));
	// How much of a collapsed line is on screen before the ellipsis takes over. Not a styling
	// number: it is what decides whether a search hit can be SEEN, which is a different question
	// from whether the text contains it.
	const lineCols = Math.max(20, Math.floor((width - LINE_INDENT) / charW));
	const offsets = useMemo(() => {
		const offs = new Array<number>(entries.length + 1);
		offs[0] = 0;
		for (let i = 0; i < entries.length; i++) {
			let h = ROW_H;
			if (isOpen(i)) {
				const text = detailText(entries[i].line);
				const lines = entries.length > MEASURE_LIMIT
					? Math.min(40, Math.ceil(text.length / Math.max(1, cols)) + 1)
					: wrappedLines(text, cols);
				h += lines * LINE_H + DETAIL_CHROME;
				const ctx = contexts.get(i);
				if (ctx) {
					h += contextHeight(ctx, wrappedContext, cols);
				}
			}
			offs[i + 1] = offs[i] + h;
		}
		return offs;
	}, [entries, isOpen, cols, contexts, wrappedContext]);

	const el = scrollRef.current;
	const scrollTop = el?.scrollTop ?? 0;
	const clientH = el?.clientHeight ?? 0;
	const first = Math.max(0, rowAt(offsets, scrollTop) - OVERSCAN);
	const last = Math.min(entries.length, rowAt(offsets, scrollTop + clientH) + 1 + OVERSCAN);
	const visible: number[] = [];
	for (let i = first; i < last; i++) {
		visible.push(i);
	}

	// Keep the cursor row on screen when the keyboard moves it, using the same offsets the
	// virtualizer does (a row's height is not uniform, so `index * ROW_H` is not its top edge).
	function reveal(i: number): void {
		const node = scrollRef.current;
		if (!node) {
			return;
		}
		const top = offsets[i];
		const h = offsets[i + 1] - offsets[i];
		if (top < node.scrollTop) {
			node.scrollTop = top;
		} else if (top + h > node.scrollTop + node.clientHeight) {
			node.scrollTop = top + h - node.clientHeight;
		}
	}

	function move(to: number): void {
		const next = Math.max(0, Math.min(entries.length - 1, to));
		setCursor(next);
		reveal(next);
	}

	function onKeyDown(e: import('react').KeyboardEvent<HTMLDivElement>): void {
		if (entries.length === 0) {
			return;
		}
		switch (e.key) {
			case 'ArrowDown': move(cursor + 1); break;
			case 'ArrowUp': move(cursor - 1); break;
			case 'PageDown': move(cursor + 20); break;
			case 'PageUp': move(cursor - 20); break;
			case 'Home': move(0); break;
			case 'End': move(entries.length - 1); break;
			case 'ArrowRight': if (!isOpen(cursor)) { toggle(cursor); } break;
			case 'ArrowLeft': if (isOpen(cursor)) { toggle(cursor); } break;
			case 'Enter': case ' ': toggle(cursor); break;
			default: return;
		}
		e.preventDefault();
	}

	function copyLine(i: number): void {
		void navigator.clipboard.writeText(cellText(entries[i].row[shape.message]) ?? '');
		setCopied(i);
		setTimeout(() => setCopied((was) => (was === i ? null : was)), 1500);
	}

	function patchContext(i: number, gen: number, patch: (was: RowContext) => RowContext): void {
		if (gen !== generation.current) {
			return;
		}
		setContexts((prev) => {
			const was = prev.get(i);
			if (!was) {
				return prev;
			}
			const next = new Map(prev);
			next.set(i, patch(was));
			return next;
		});
	}

	function anchorOf(i: number): { stream: string | null; key: string; at: number } | null {
		const { at, row } = entries[i];
		if (at === null) {
			return null;
		}
		const stream = shape.stream === null ? null : cellText(row[shape.stream]);
		return { stream: stream === '' ? null : stream, key: contextKey(shape.id === null ? null : row[shape.id], at, row[shape.message]), at };
	}

	/** Open (or close) the events around row `i`: a page each way from its timestamp, in its stream. */
	function toggleContext(i: number): void {
		if (contexts.has(i)) {
			setContexts((prev) => {
				const next = new Map(prev);
				next.delete(i);
				return next;
			});
			return;
		}
		const anchor = anchorOf(i);
		if (!context || !anchor) {
			return;
		}
		const gen = generation.current;
		const self: ContextLine = { key: anchor.key, at: anchor.at, message: entries[i].row[shape.message], stream: anchor.stream, line: entries[i].line };
		setContexts((prev) => new Map(prev).set(i, { status: 'loading', anchorKey: anchor.key, events: [self], busy: null, startReached: false, endReached: false }));
		const where = { scope: context.scope, stream: anchor.stream };
		const known = new Set([anchor.key]);
		void Promise.all([eventsBefore(context.run, where, anchor.at, known), eventsAfter(context.run, where, anchor.at, known)]).then(([before, after]) => {
			// Events sharing the anchor's millisecond come back from both reads; they belong after it.
			const later = new Set(after.events.map((e) => e.key));
			patchContext(i, gen, (was) => ({
				...was,
				status: 'ready',
				events: [...parsed(before.events.filter((e) => !later.has(e.key))), self, ...parsed(after.events)],
				startReached: before.exhausted,
				endReached: after.exhausted,
			}));
		}, (err: unknown) => {
			patchContext(i, gen, (was) => ({ ...was, status: 'error', error: err instanceof Error ? err.message : String(err) }));
		});
	}

	/** Read another page of surrounding events off one end. */
	function extendContext(i: number, direction: 'before' | 'after'): void {
		const ctx = contexts.get(i);
		if (!context || !ctx || ctx.busy) {
			return;
		}
		const edge = direction === 'before' ? ctx.events.find((e) => e.at !== null) : [...ctx.events].reverse().find((e) => e.at !== null);
		if (!edge || edge.at === null) {
			return;
		}
		const gen = generation.current;
		const where = { scope: context.scope, stream: anchorOf(i)?.stream ?? null };
		const known = new Set(ctx.events.map((e) => e.key));
		patchContext(i, gen, (was) => ({ ...was, busy: direction }));
		const read = direction === 'before' ? eventsBefore(context.run, where, edge.at, known) : eventsAfter(context.run, where, edge.at, known);
		void read.then(({ events, exhausted }) => {
			patchContext(i, gen, (was) => ({
				...was,
				busy: null,
				events: direction === 'before' ? [...parsed(events), ...was.events] : [...was.events, ...parsed(events)],
				...(direction === 'before' ? { startReached: exhausted } : { endReached: exhausted }),
			}));
		}, (err: unknown) => {
			patchContext(i, gen, (was) => ({ ...was, busy: null, status: 'error', error: err instanceof Error ? err.message : String(err) }));
		});
	}

	function toggleContextLine(key: string): void {
		setWrappedContext((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}

	function contextBlock(i: number, ctx: RowContext): JSX.Element {
		const first = ctx.events.find((e) => e.at !== null)?.at ?? null;
		const last = [...ctx.events].reverse().find((e) => e.at !== null)?.at ?? null;
		const dated = withDate || spansDays(first, last);
		const where = anchorOf(i)?.stream;
		return (
			<div className="log-context">
				<div className="log-context-head">
					<Icon name="list-flat" />
					<span>{where ? <>Around this event in <span className="log-context-where">{where}</span></> : "Around this event"}</span>
				</div>
				{ctx.status === 'loading' && <div className="log-context-note"><Icon name="loading" className="spin" />Reading the events around it…</div>}
				{ctx.status === 'error' && <div className="log-context-note error">{ctx.error}</div>}
				{ctx.status !== 'loading' && (
					<button type="button" className="log-context-more" disabled={ctx.startReached || ctx.busy !== null} onClick={() => extendContext(i, 'before')}>
						<Icon name={ctx.busy === 'before' ? 'loading' : 'arrow-up'} className={ctx.busy === 'before' ? 'spin' : undefined} />
						{ctx.startReached ? "No earlier events in the day before" : "Load earlier"}
					</button>
				)}
				{ctx.events.map((event) => {
					const anchor = event.key === ctx.anchorKey;
					const full = wrappedContext.has(event.key);
					return (
						<div
							key={event.key}
							className={`log-context-line${event.line.level ? ` log-${event.line.level}` : ''}${anchor ? ' anchor' : ''}${full ? ' full' : ''}`}
							onClick={() => toggleContextLine(event.key)}
							title={full ? "Collapse" : "Show the whole line"}
						>
							{shape.ts !== null && <time className="log-time">{logTimeText(event.at, dated)}</time>}
							<span className="log-level">{event.line.level ?? ''}</span>
							<span className="log-summary">{full ? marked(detailText(event.line), search) : marked(event.line.summary, search)}</span>
						</div>
					);
				})}
				{ctx.status !== 'loading' && (
					<button type="button" className="log-context-more" disabled={ctx.endReached || ctx.busy !== null} onClick={() => extendContext(i, 'after')}>
						<Icon name={ctx.busy === 'after' ? 'loading' : 'arrow-down'} className={ctx.busy === 'after' ? 'spin' : undefined} />
						{ctx.endReached ? "No later events yet" : "Load later"}
					</button>
				)}
			</div>
		);
	}

	/** A chip in the expansion's metadata strip: a fact about the event, not part of its text. */
	function chip(label: string, value: unknown): JSX.Element | null {
		const text = cellText(value);
		if (text === null || text === '') {
			return null;
		}
		return (
			<span className="log-chip" key={label} title={`${label}: ${text}`}>
				<span className="log-chip-label">{label}</span>
				<span className="log-chip-value">{marked(text, search)}</span>
			</span>
		);
	}

	return (
		<div className="log-view" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown}>
			<div className="log-body">
				{/* Rows lay out in normal flow between two spacers standing in for the ones above and
				    below the window, so a row is sized by its own content and can never be cut short
				    by a height computed for it. */}
				<div style={{ height: offsets[first] }} />
				{visible.map((i) => {
					const { at, line, row } = entries[i];
					const expanded = isOpen(i);
					const stampDiffers = line.stamp !== null && (at === null || Math.abs(Date.parse(line.stamp) - at) > 1000);
					// The row is here because it matched, so the line has to SHOW why. The test is what
					// is VISIBLE, not what the string contains: a hit 400 characters into a line is in
					// the summary and off the right edge of it, which looks exactly like no match at
					// all. When it cannot be seen the line carries a fragment from around it instead —
					// out of the body first, since that is where a folded-away payload lives, and out
					// of the composed summary otherwise. Both null (the hit was in a column rather than
					// in the text) leaves the line as it was.
					const fragment = query !== '' && !line.summary.slice(0, lineCols).toLowerCase().includes(query.toLowerCase())
						? matchContext(line.body, query) ?? matchContext(line.summary, query)
						: null;
					return (
						<div
							key={i}
							className={`log-row${line.level ? ` log-${line.level}` : ''}${expanded ? ' expanded' : ''}${cursor === i ? ' cursor' : ''}`}
							style={{ minHeight: offsets[i + 1] - offsets[i] }}
						>
							<div className="log-line" onClick={() => toggle(i)} title={expanded ? "Collapse" : "Expand"}>
								<span className={`log-caret${line.expandable ? '' : ' plain'}`}><Icon name={expanded ? 'chevron-down' : 'chevron-right'} /></span>
								<span className="log-num">{rowOffset + i + 1}</span>
								{/* No column at all when the projection dropped the clock (`SELECT message FROM …`):
								    an empty one would leave a gap where a time is supposed to be. */}
								{shape.ts !== null && (
									<time className="log-time" dateTime={at === null ? undefined : new Date(at).toISOString()}>{logTimeText(at, withDate)}</time>
								)}
								<span className="log-level">{line.level ?? ''}</span>
								<span className={`log-summary${fragment !== null ? ' fragment' : ''}`} title={fragment !== null ? line.summary : undefined}>
									{marked(fragment ?? line.summary, search)}
								</span>
							</div>
							{expanded && (
								<div className="log-detail">
									<div className="log-meta">
										{shape.stream !== null && chip('stream', row[shape.stream])}
										{line.correlation && chip('request', line.correlation)}
										{stampDiffers && chip('logged at', line.stamp)}
										{shape.ingestedAt !== null && chip('ingested', logTimeText(logTimeOf(row[shape.ingestedAt]), true))}
										{shape.id !== null && chip('event', row[shape.id])}
										{shape.extras.map((col) => chip(fields[col]?.name ?? String(col), row[col]))}
										{context && at !== null && (
											<button type="button" className={`log-copy${contexts.has(i) ? ' on' : ''}`} onClick={() => toggleContext(i)} title="Show the events logged just before and after this one, in the same stream">
												<Icon name="list-flat" />{contexts.has(i) ? "Hide surrounding" : "Surrounding events"}
											</button>
										)}
										<button type="button" className="log-copy" onClick={() => copyLine(i)} title="Copy the message exactly as the service stored it">
											<Icon name={copied === i ? 'check' : 'copy'} />{copied === i ? "Copied" : "Copy"}
										</button>
									</div>
									<div className="log-detail-body">
										{line.segments.length === 0
											? <span className="log-detail-empty">This event has no message.</span>
											: line.segments.map((segment, s) => (segment.kind === 'json'
												? <pre className="log-json" key={s}>{jsonTokens(prettyJson(segment.value)).map((token, t) => (
													token.kind === 'plain'
														? <span key={t}>{marked(token.text, search)}</span>
														: <span className={`json-${token.kind}`} key={t}>{marked(token.text, search)}</span>
												))}</pre>
												: <span className="log-text" key={s}>{marked(segment.text, search)}</span>
											))}
									</div>
									{contexts.has(i) && contextBlock(i, contexts.get(i)!)}
								</div>
							)}
						</div>
					);
				})}
				<div style={{ height: Math.max(0, offsets[entries.length] - offsets[last]) }} />
			</div>
		</div>
	);
}

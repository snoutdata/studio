/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseChartSpec, type ChartSpec } from '../../shared/chart';

/*
 * What a reply is made of, once the fences are taken out of it.
 *
 * These parsers used to be private to ChatPanel.tsx, where only a chat could reach them. They are
 * pure string functions with no DOM and no React, so they live here instead: the renderer's shared
 * surface reads them, a coding agent's pushed markdown goes through exactly the same ones, and they
 * are finally unit-testable (they never had a single test).
 *
 * The contract is deliberately "markdown with fenced blocks", not a payload format of our own:
 * ```sql, ```json and ```chart are what the assistant already writes, which is why an agent needs
 * to learn nothing new to get a SQL card with a Run button.
 */

/** One renderable piece of a reply, in the order it appeared. */
export type RenderBlock =
	| { kind: 'prose'; text: string }
	| { kind: 'sql'; sql: string }
	| { kind: 'pipeline'; json: string }
	| { kind: 'chart'; spec: ChartSpec }
	| { kind: 'chartError'; error: string };

export interface BlockOptions {
	/**
	 * Treat ```json fences as native pipeline blocks, which is what they are on a
	 * document backend. Off, a ```json fence is left in the prose and renders as an ordinary code
	 * block, because on a SQL connection that is all it is.
	 */
	pipeline?: boolean;
}

/** Matches a fenced block we render specially. The `\n` after the tag is required, matching what
 *  the assistant emits and what the original per-kind regexes accepted. */
const FENCE = /```(sql|json|chart)\s*\n([\s\S]*?)```/gi;

/**
 * Split a reply into blocks **in document order**.
 *
 * The order is the point. The JSX this replaced rendered all the prose, then every SQL block, then
 * every pipeline block, then every chart, regardless of where they appeared — invisible while a
 * reply has one of each, wrong the moment it has two of two ("first do X ```sql``` then do Y
 * ```sql```" came out as both sentences, then both queries).
 *
 * An unterminated fence is not a block. It stays in the prose, where the markdown renderer shows it
 * as text, rather than swallowing the rest of the reply.
 */
export function blocksFromMarkdown(text: string, options: BlockOptions = {}): RenderBlock[] {
	const blocks: RenderBlock[] = [];
	const pushProse = (raw: string): void => {
		const trimmed = raw.trim();
		if (trimmed !== '') {
			blocks.push({ kind: 'prose', text: trimmed });
		}
	};
	const re = new RegExp(FENCE.source, 'gi');
	let cursor = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const tag = match[1].toLowerCase();
		if (tag === 'json' && options.pipeline !== true) {
			// Not ours: leave it where it is, so the prose run that follows still contains it.
			continue;
		}
		pushProse(text.slice(cursor, match.index));
		cursor = match.index + match[0].length;
		const body = match[2].trim();
		if (tag === 'sql') {
			blocks.push({ kind: 'sql', sql: body });
		} else if (tag === 'json') {
			blocks.push({ kind: 'pipeline', json: body });
		} else {
			const parsed = parseChartSpec(body);
			blocks.push('spec' in parsed ? { kind: 'chart', spec: parsed.spec } : { kind: 'chartError', error: parsed.error });
		}
	}
	pushProse(text.slice(cursor));
	return blocks;
}

/** Extract the SQL from every ```sql fenced block in `text`. */
export function sqlBlocks(text: string): string[] {
	return blocksFromMarkdown(text).flatMap((b) => (b.kind === 'sql' ? [b.sql] : []));
}

/** Extract the pipeline from every ```json fenced block in `text`. On a document
 *  (MongoDB) connection the assistant proposes a native aggregation pipeline this way; each block
 *  becomes an "Insert into pipeline" action. */
export function jsonBlocks(text: string): string[] {
	return blocksFromMarkdown(text, { pipeline: true }).flatMap((b) => (b.kind === 'pipeline' ? [b.json] : []));
}

/** Parse every ```chart fenced block in `text` into a chart spec; malformed blocks become an
 *  inline error so the user sees what went wrong instead of the chart silently vanishing. */
export function chartBlocks(text: string): ({ spec: ChartSpec } | { error: string })[] {
	const out: ({ spec: ChartSpec } | { error: string })[] = [];
	for (const b of blocksFromMarkdown(text)) {
		if (b.kind === 'chart') {
			out.push({ spec: b.spec });
		} else if (b.kind === 'chartError') {
			out.push({ error: b.error });
		}
	}
	return out;
}

/** Drop the ```sql and ```chart fences so the prose renders as markdown — SQL and charts are shown
 *  separately (SQL with an "Insert into editor" button, charts rendered inline). On a document
 *  connection (`stripJson`) the ```json pipeline blocks are pulled out too, since they render as
 *  their own "Insert into pipeline" cards. */
export function proseOnly(text: string, stripJson = false): string {
	return blocksFromMarkdown(text, { pipeline: stripJson })
		.flatMap((b) => (b.kind === 'prose' ? [b.text] : []))
		.join('\n\n')
		.trim();
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CapabilityHandler } from './registry';
import { clearCanvas, pushCanvas } from '../agentCanvas';
import { agentKindForClient, type AgentKind } from '../../../shared/agentConsole';
import { blocksFromMarkdown } from '../renderBlocks';

/*
 * Showing the user something, in the app's own language.
 *
 * A coding agent in our console can only speak monospace. This gives it the surface the assistant
 * draws into: markdown becomes prose, a ```sql fence becomes a card with Copy / Insert / Run, a
 * ```chart fence becomes a chart. That is deliberately the SAME contract the assistant already
 * writes, so an agent has nothing new to learn to get a Run button.
 *
 * A push lands in THIS AGENT'S OWN surface, never in the assistant's conversation: an agent writing
 * into that thread reads as the assistant saying things it never said. Where that surface is
 * rendered follows where the user has put the console (`agentSurfaceHome` in docking.ts) — above the
 * terminal in a side dock, its own workbench tab from the bottom strip — which is the renderer's
 * business, not the agent's, so the tool description does not promise a place.
 *
 * Counted as NON-MUTATING, on the same reasoning as notify_user: it writes no data, changes no
 * setting, and touches nothing the user would have to undo. Requiring consent for "may I show you
 * something" trains the reflex that makes real consent prompts worthless.
 *
 * STATIC, not component-scoped, and that is load-bearing: `mcpServer.ts` snapshots the tool list at
 * `initialize` and its transport cannot deliver `notifications/tools/list_changed`, so a capability
 * that only exists while some view is mounted is a capability most agents never see.
 */

/** Where a push lands when the client did not name itself recognisably. Set by App to whichever
 *  console is on screen, so an unknown client still draws somewhere the user is looking. */
let fallbackKind: AgentKind = 'claude';

export function setCanvasFallbackAgent(kind: AgentKind): void {
	fallbackKind = kind;
}

/** How many rows a markdown table may have before it reads as a pasted result set rather than a
 *  point being made. Four is generous: a comparison or a plan summary rarely needs more. */
const RESULT_DUMP_ROWS = 4;

/**
 * Does this markdown look like rows pasted out of a result set?
 *
 * A launch-time rule is read once and drifts; this is the same rule arriving IN THE LOOP, in the
 * result of the call that broke it, which is what actually moves a modest model. It is a hint on a
 * successful call, never a refusal: the app does not get to decide that a table the agent wanted to
 * show is wrong, only to say there is a better way to show it.
 */
export function looksLikeResultDump(markdown: string): boolean {
	let rows = 0;
	let best = 0;
	for (const line of markdown.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2) {
			// The header and its `|---|` separator are the table's frame, not its data.
			if (!/^\|[\s:|-]+\|$/.test(trimmed)) {
				rows += 1;
				best = Math.max(best, rows);
			}
			continue;
		}
		rows = 0;
	}
	return best - 1 >= RESULT_DUMP_ROWS;
}

export const canvasCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'show_in_app',
			description: [
				"Show something to the user inside SnoutData Studio. It appears in your own panel in the app, rendered as a real interface instead of terminal text.",
				"The body is markdown. A ```sql fenced block becomes a card with Copy, Insert into editor and Run buttons; a ```chart fenced block (see the chart JSON format) renders as a chart; everything else renders as formatted prose, including tables.",
				"Show the QUERY, not a copy of the rows: the user presses Run on the card and the rows arrive in the app's results grid, where they can be sorted, filtered, edited and exported. A table you paste can do none of that. So send the SQL plus a line or two on what you found, and keep markdown tables for when the table IS the point (a short comparison, a summary), not for rows you fetched.",
				"Prefer it to printing results into your terminal, which is for your own working notes. Do not use it to talk to the app (there are tools for that), and do not narrate as though the user has pressed a button: you cannot see what they do with what you show, so read the outcome with get_query_result if you need it.",
				"Pushes accumulate, newest last. Pass clear: true to start a fresh surface.",
			].join(' '),
			parameters: {
				type: 'object',
				properties: {
					markdown: { type: 'string', description: 'The markdown to show. Fenced ```sql and ```chart blocks get their own cards.' },
					title: { type: 'string', description: 'Optional short heading above this push.' },
					clear: { type: 'boolean', description: 'Replace everything shown so far instead of appending. Defaults to false.' },
				},
				required: ['markdown'],
			},
			domain: 'canvas',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: (args, ctx) => {
			const markdown = typeof args.markdown === 'string' ? args.markdown.trim() : '';
			const clear = args.clear === true;
			const kind = agentKindForClient(ctx.client) ?? fallbackKind;
			if (markdown === '') {
				// "Clear and show nothing" is a real request; "show nothing" is a mistake worth naming.
				if (clear) {
					clearCanvas(kind);
					return { ok: true, summary: 'Cleared what you had shown' };
				}
				return { ok: false, summary: '', error: 'Provide markdown: the content to show the user.' };
			}
			const title = typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : undefined;
			pushCanvas(kind, { markdown, title, clear });
			// Say what it will LOOK like, not just that it worked: an agent that knows its SQL became
			// a card with a Run button writes differently from one that thinks it printed text.
			const blocks = blocksFromMarkdown(markdown, { pipeline: true });
			const cards = blocks.filter((b) => b.kind === 'sql').length;
			const charts = blocks.filter((b) => b.kind === 'chart').length;
			const parts = [`Shown in the app${title ? `: ${title}` : ''}`];
			if (cards > 0) {
				parts.push(`${cards} SQL card${cards === 1 ? '' : 's'} the user can run`);
			}
			if (charts > 0) {
				parts.push(`${charts} chart${charts === 1 ? '' : 's'}`);
			}
			if (looksLikeResultDump(markdown)) {
				parts.push("next time show the QUERY instead of the rows: the user runs the card and the rows land in the app's results grid, where they can be sorted, filtered and exported");
			}
			return { ok: true, summary: parts.join(', ') };
		},
	},
];

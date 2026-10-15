/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react';

import { Icon } from './Icon';
import { RenderSurface, type ChatRunOutcome, type ChatRunState, type InsertTarget, type RenderItem } from './RenderSurface';
import { blocksFromMarkdown } from '../renderBlocks';
import { canvasFor, clearCanvas, subscribeCanvas } from '../agentCanvas';
import { agentDescriptor, type AgentKind } from '../../../shared/agentConsole';

/*
 * What ONE coding agent has shown the user.
 *
 * The agent's own thread, and nobody else's. It renders with the same component the assistant's
 * replies do, so a ```sql fence is a card with Run wherever it is drawn, but it is deliberately a
 * SEPARATE surface: an agent writing into the assistant's conversation reads as the assistant
 * saying things it never said, and two AIs sharing one thread is a thread where "who told me this"
 * is a detail you have to look for.
 *
 * It has no composer, on purpose. The terminal underneath (or in the dock) is the composer; a
 * second input into the same agent is a second place for the conversation to live.
 *
 * The same component in two placements ({@link agentSurfaceHome}):
 * `panel` above the terminal in a side dock, `tab` as its own workbench tab beside the editor.
 * The only differences are the frame and what it shows when nothing has been drawn yet.
 */

export interface AgentCanvasProps {
	kind: AgentKind;
	/** `panel` (above the terminal, side dock) or `tab` (a workbench tab, like the flow wizard). */
	placement: 'panel' | 'tab';
	/** The connection a drawn card would act on, named on the card. */
	connectionLabel: string;
	/** A document backend proposes native pipelines, so ```json fences become their own cards. */
	isDocument: boolean;
	/** True when something is connected, which is what decides whether Run is offered. */
	hasConnection: boolean;
	onInsertSql(sql: string): void;
	onInsertSqlNewTab(sql: string): void;
	onInsertPipeline(json: string): void;
	onRunSql(sql: string, runId: string): void;
	/** The settled outcome of a Run, echoed back so the card that ran can say what happened. Shared
	 *  with the assistant's cards: run ids are unique, so each surface matches only its own. */
	runOutcome?: ChatRunOutcome | null;
}

export function AgentCanvas({
	kind, placement, connectionLabel, isDocument, hasConnection,
	onInsertSql, onInsertSqlNewTab, onInsertPipeline, onRunSql, runOutcome,
}: AgentCanvasProps): JSX.Element {
	// What this agent has drawn. The store lives outside React because the thing that writes to it is
	// a capability invoked from main, which has no component to call into.
	const [canvas, setCanvas] = useState(() => canvasFor(kind));
	const [runs, setRuns] = useState<Record<string, ChatRunState>>({});

	useEffect(() => {
		setCanvas(canvasFor(kind));
		return subscribeCanvas(() => setCanvas(canvasFor(kind)));
	}, [kind]);

	// A run settles long after the click (a prod write waits for a confirm dialog), so the outcome
	// comes back by id and is matched to whichever card started it. Ids are unique across the app,
	// so sharing this channel with the assistant's cards costs nothing.
	useEffect(() => {
		if (!runOutcome) {
			return;
		}
		setRuns((prev) => {
			const key = Object.keys(prev).find((k) => prev[k].runId === runOutcome.runId);
			return key ? { ...prev, [key]: runOutcome } : prev;
		});
	}, [runOutcome]);

	const runCanvasSql = useCallback((sql: string, key: string): void => {
		const runId = `agent-run-${Date.now()}-${key}`;
		setRuns((prev) => ({ ...prev, [key]: { runId, status: 'running' } }));
		onRunSql(sql, runId);
	}, [onRunSql]);

	const descriptor = agentDescriptor(kind);
	const items: RenderItem[] = canvas.map((entry) => ({
		id: entry.id,
		variant: 'assistant',
		label: entry.title,
		blocks: blocksFromMarkdown(entry.markdown, { pipeline: isDocument }),
	}));

	// Run is offered only when there is something to run against; the rest are always useful.
	const targets: InsertTarget[] = [
		'editor',
		'newTab',
		...(isDocument ? ['pipeline' as InsertTarget] : []),
		...(hasConnection ? ['run' as InsertTarget] : []),
	];

	return (
		<div className={`agent-canvas${placement === 'tab' ? ' in-tab' : ''}`}>
			<div className="agent-canvas-head">
				<Icon name={descriptor.icon} />
				<span className="agent-canvas-title">Shown by {descriptor.label}</span>
				<span className="spacer" />
				{canvas.length > 0 && (
					<button className="icon-btn" aria-label="Clear what is shown" onClick={() => clearCanvas(kind)}><Icon name="clear-all" /></button>
				)}
			</div>
			<RenderSurface
				className="agent-canvas-surface"
				items={items}
				insertTargets={targets}
				connectionLabel={connectionLabel}
				runs={runs}
				onInsertSql={onInsertSql}
				onInsertSqlNewTab={onInsertSqlNewTab}
				onInsertPipeline={onInsertPipeline}
				onRunSql={runCanvasSql}
				empty={(
					// Only ever seen in a TAB: in a side panel the surface is absent until something is
					// drawn, since an empty box above every terminal is a permanent tax on the consoles
					// that never use it. A tab the user has open is different: it has to say why it is
					// empty rather than look broken.
					<div className="agent-canvas-empty">
						<Icon name="preview" />
						<h3>Nothing shown yet</h3>
						<p>
							{descriptor.label} shows things here instead of printing them into its terminal: rows it
							fetched, a query it is proposing, a chart. Anything with SQL in it arrives as a card you
							can insert or run.
						</p>
					</div>
				)}
			/>
		</div>
	);
}

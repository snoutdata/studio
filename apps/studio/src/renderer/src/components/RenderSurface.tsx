/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode, RefObject } from 'react';

import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { ChartView } from './ChartView';
import { SqlCode } from './SqlCode';
import { AttachmentChip } from './AttachmentChip';
import type { RenderBlock } from '../renderBlocks';
import type { AiToolEvent, DocumentAttachment } from '../../../shared/ai';
import type { InsertTarget } from '../chatSurface';

export type { InsertTarget };

/*
 * Where things are DRAWN.
 *
 * This was the `.chat-messages` block inside ChatPanel.tsx, and it is now a component of its own so
 * three surfaces can draw into it: the docked assistant, the full assistant, and a coding agent's
 * console (which has no composer, because its terminal is one).
 *
 * TWO RULES, and breaking either one is how this stops being reusable:
 *
 * 1. It consumes RENDER BLOCKS, not chat messages. A chat maps its ChatMessage[] down onto items;
 *    an agent's pushed markdown goes through the same parser. Neither has to pretend to be the
 *    other, and a surface added later does not inherit a conversation shape it does not have.
 * 2. It holds NO conversation state. The composer, model picker, token tally, approval cards and
 *    the "thinking" line are the caller's, passed in as `header` / `footer` / per-item `trailing`.
 *    A console that inherited a spinner reading "asking the model..." would be lying.
 */

/** The outcome of running a block's SQL from the card, written from the run's own result. */
export interface ChatRunOutcome {
	runId: string;
	status: 'ok' | 'error' | 'cancelled' | 'blocked';
	rowCount?: number;
	changed?: boolean;
	durationMs?: number;
	message?: string;
}

export type ChatRunState = { runId: string; status: 'running' } | ChatRunOutcome;

/** Labels for the built-in DB tools in the step strip. Unknown tools show their own name. */
const TOOL_LABEL: Record<string, string> = {
	list_tables: 'List tables',
	describe_table: 'Describe',
	search_columns: 'Search columns',
	run_query: 'Run query',
};

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The one-line answer under a SQL block the user ran: what the database actually did. Written from
 *  the run's own result, so it is exact (and free) rather than a model's account of it. */
export function runOutcomeLabel(run: ChatRunState): string {
	switch (run.status) {
		case 'running':
			return "Running…";
		case 'ok': {
			const rows = run.rowCount ?? 0;
			const what = run.changed ? `${plural(rows, 'row')} changed` : `${plural(rows, 'row')} returned`;
			return run.durationMs === undefined ? `Ran. ${what}.` : `Ran. ${what} in ${Math.round(run.durationMs)} ms.`;
		}
		case 'cancelled':
			return "Cancelled, nothing ran.";
		case 'blocked':
			return run.message ?? "Blocked, nothing ran.";
		case 'error':
			return run.message ?? "The query failed.";
	}
}

/**
 * One thing shown on the surface. For a chat that is one message; for an agent console it is one
 * push. Everything optional here is the caller's own furniture, which is why the console can leave
 * all of it out and still look like it belongs.
 */
export interface RenderItem {
	/** Stable within the surface. Used for React keys and as the prefix of a block's run key. */
	id: string;
	/** Extra class on the item wrapper, e.g. the chat's `user` / `assistant` role. */
	variant?: string;
	/** Small label at the head of the item ("You", "Assistant", an agent's name). */
	label?: string;
	/** Head-right controls, e.g. the chat's per-reply Copy button. */
	actions?: ReactNode;
	/** The agent-loop step strip, when there was one. */
	steps?: AiToolEvent[];
	/** What to draw, in document order. */
	blocks: RenderBlock[];
	/** Attachment chips under the item (a user turn that sent a file). */
	attachments?: DocumentAttachment[];
	/** Anything the caller wants at the end of the item (the chat's "thinking" line). */
	trailing?: ReactNode;
}

export interface RenderSurfaceProps {
	items: RenderItem[];
	/** Which affordances a SQL/pipeline card carries here. `[]` is copy-only. */
	insertTargets: InsertTarget[];
	/** The connection a card would act on, named on the card. */
	connectionLabel: string;
	/** Run state keyed `${item.id}:${blockIndex}`. */
	runs?: Record<string, ChatRunState>;
	onInsertSql?(sql: string): void;
	onInsertSqlNewTab?(sql: string): void;
	onInsertPipeline?(json: string): void;
	onRunSql?(sql: string, key: string): void;
	/** Shown when there are no items. */
	empty?: ReactNode;
	/** Above the items, inside the scroller (the chat's dev system-prompt disclosure). */
	header?: ReactNode;
	/** Below the items, inside the scroller (the chat's approval cards and error banner). */
	footer?: ReactNode;
	scrollRef?: RefObject<HTMLDivElement>;
	className?: string;
}

export function RenderSurface(props: RenderSurfaceProps): JSX.Element {
	const {
		items, insertTargets, connectionLabel, runs, onInsertSql, onInsertSqlNewTab, onInsertPipeline,
		onRunSql, empty, header, footer, scrollRef, className,
	} = props;
	const can = (target: InsertTarget): boolean => insertTargets.includes(target);

	return (
		<div className={`chat-messages${className ? ` ${className}` : ''}`} ref={scrollRef}>
			{header}
			{items.length === 0 && empty}
			{items.map((item) => (
				<div className={`chat-msg${item.variant ? ` ${item.variant}` : ''}`} key={item.id}>
					{(item.label || item.actions) && (
						<div className="chat-msg-head">
							{item.label && <span className="chat-role">{item.label}</span>}
							{item.actions}
						</div>
					)}
					{item.steps && item.steps.length > 0 && (
						<div className="chat-steps">
							{item.steps.map((step) => (
								<div className={`chat-step${step.isError ? ' error' : ''}`} key={step.callId}>
									<Icon
										name={step.phase === 'start' ? 'loading' : step.isError ? 'error' : 'check'}
										className={step.phase === 'start' ? 'codicon-modifier-spin' : ''}
									/>
									<span className="chat-step-label">{TOOL_LABEL[step.tool] ?? step.tool}</span>
									<span className="chat-step-summary">{step.summary}</span>
								</div>
							))}
						</div>
					)}
					{item.blocks.map((block, index) => {
						const key = `${item.id}:${index}`;
						if (block.kind === 'prose') {
							return <Markdown key={key} className="chat-content" source={block.text} />;
						}
						if (block.kind === 'chart') {
							return <ChartView key={key} spec={block.spec} />;
						}
						if (block.kind === 'chartError') {
							return <div className="chart-block-error" key={key}><Icon name="warning" /> {block.error}</div>;
						}
						const isSql = block.kind === 'sql';
						const body = isSql ? block.sql : block.json;
						const run = runs?.[key];
						return (
							<div className="sql-block" key={key}>
								<div className="sql-block-head">
									<span className="sql-block-title"><Icon name="database" /> {connectionLabel}{isSql ? '' : ' pipeline'}</span>
									<div className="sql-block-tools">
										<button type="button" className="icon-btn" aria-label="Copy" onClick={() => void navigator.clipboard.writeText(body)}><Icon name="copy" /></button>
										{isSql && can('editor') && onInsertSql && (
											<button type="button" className="icon-btn" aria-label="Insert into editor" onClick={() => onInsertSql(body)}><Icon name="insert" /></button>
										)}
										{isSql && can('newTab') && onInsertSqlNewTab && (
											<button type="button" className="icon-btn" aria-label="Insert into new editor" onClick={() => onInsertSqlNewTab(body)}><Icon name="split-horizontal" /></button>
										)}
										{isSql && can('run') && onRunSql && (
											<button type="button" className="icon-btn" aria-label="Run" onClick={() => onRunSql(body, key)}><Icon name="play" /></button>
										)}
										{!isSql && can('pipeline') && onInsertPipeline && (
											<button type="button" className="icon-btn" aria-label="Insert into pipeline tab" onClick={() => onInsertPipeline(body)}><Icon name="insert" /></button>
										)}
									</div>
								</div>
								<SqlCode sql={body} lang={isSql ? undefined : 'json'} />
								{run && (
									<div className={`sql-block-outcome${run.status === 'error' || run.status === 'blocked' ? ' error' : ''}`}>
										<Icon
											name={run.status === 'running' ? 'loading' : run.status === 'ok' ? 'check' : run.status === 'cancelled' ? 'circle-slash' : 'error'}
											className={run.status === 'running' ? 'codicon-modifier-spin' : ''}
										/>
										<span>{runOutcomeLabel(run)}</span>
									</div>
								)}
							</div>
						);
					})}
					{item.attachments && item.attachments.length > 0 && (
						<div className="chat-attachments">
							{item.attachments.map((att, k) => <AttachmentChip key={k} att={att} />)}
						</div>
					)}
					{item.trailing}
				</div>
			))}
			{footer}
		</div>
	);
}

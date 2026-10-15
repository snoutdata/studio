/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';

export type ScriptStepStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped';

export interface ScriptStep {
	sql: string;
	status: ScriptStepStatus;
	rowCount?: number;
	durationMs?: number;
	error?: string;
}

/** State of a "Run script" execution: every statement in the editor, run one at a time. `current`
 *  is the index of the statement running now, or -1 when the run hasn't started / has finished. */
export interface ScriptRun {
	steps: ScriptStep[];
	startedAt: number;
	finishedAt?: number;
	current: number;
}

interface ScriptLogProps {
	run: ScriptRun;
}

// First non-blank line of a statement, clipped, for the one-line log row.
function firstLine(sql: string): string {
	const line = sql.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? sql.trim();
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

const ICON: Record<ScriptStepStatus, string> = {
	pending: 'circle-large-outline',
	running: 'chevron-right',
	ok: 'pass',
	error: 'error',
	skipped: 'circle-slash',
};

/** The "Run script" output: a log of every statement with its status, a `>` marker on the one
 *  running now, and a per-statement row count / duration or error. Continue-on-error, so a failed
 *  statement doesn't stop the rest. */
export function ScriptLog({ run }: ScriptLogProps): JSX.Element {
	const ok = run.steps.filter((s) => s.status === 'ok').length;
	const failed = run.steps.filter((s) => s.status === 'error').length;
	const done = run.current < 0;
	const summary = done
		? `Done: ${ok} succeeded, ${failed} failed of ${run.steps.length}`
		: `Running ${run.current + 1} of ${run.steps.length}…`;
	return (
		<div className="script-log">
			<div className={`script-log-summary${failed > 0 ? ' has-errors' : ''}`}>{summary}</div>
			<ol className="script-log-steps">
				{run.steps.map((s, i) => (
					<li key={i} className={`script-step ${s.status}`}>
						<span className="script-step-no">{i + 1}</span>
						<span className="script-step-icon"><Icon name={ICON[s.status]} /></span>
						<span className="script-step-sql" title={s.sql}>{firstLine(s.sql)}</span>
						<span className="script-step-meta">
							{s.status === 'error' ? (
								<span className="script-step-error" title={s.error}>{s.error}</span>
							) : s.status === 'ok' ? (
								<>
									{`${s.rowCount ?? 0} ${s.rowCount === 1 ? 'row' : 'rows'}`}
									{s.durationMs !== undefined ? ` · ${(s.durationMs / 1000).toFixed(2)}s` : ''}
								</>
							) : s.status === 'skipped' ? (
								'skipped'
							) : null}
						</span>
					</li>
				))}
			</ol>
		</div>
	);
}

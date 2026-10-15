/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { SqlCode } from './SqlCode';
import {
	explainText,
	parseExplainPlan,
	planReads,
	readExplainEstimate,
	type ExplainEstimateRow,
	type ExplainNode,
	type ExplainRead,
	type ExplainVariant,
} from '../../../shared/engine';

// The Explain panel. An engine that has more than one EXPLAIN declares them on its dialect
// (`explainVariants`); this draws a picker over whatever it declared and reads each answer in the
// shape the variant says it has. Nothing here knows ClickHouse from any other engine: the five
// names, the statements and the fallbacks are all the dialect's.
//
// It lands in a RESULT TAB, beside the rows, because a plan is about the statement you are about to
// run and belongs where that statement's output lands. Reads go through `sqlApi.explain`, the path
// that runs a statement without recording it in query history: asking what a query would do is not
// one of the queries you ran.

/** What a result tab holds when it is showing a plan instead of rows. */
export interface ExplainRun {
	connectionId: string;
	connectionLabel: string;
	/** The statement being explained, as the person wrote it. */
	sql: string;
	variants: readonly ExplainVariant[];
	/** Bumped to explain again, so the panel re-reads a plan that may have changed under it. */
	nonce: number;
}

interface ExplainPanelProps {
	run: ExplainRun;
	/** The table's own row count from the live schema, where it is loaded — what turns "57,344 rows
	 *  would be read" into "57,344 of 5,001,140". Absent is normal, never an error. */
	tableRows?(database: string, table: string): number | undefined;
}

type Answer =
	| { state: 'loading' }
	| { state: 'error'; message: string }
	| { state: 'plan'; nodes: ExplainNode[] }
	| { state: 'estimate'; rows: ExplainEstimateRow[] }
	| { state: 'text'; text: string; sql: boolean };

const NUM = new Intl.NumberFormat();

/** `210 of 1,194 (18%)`. */
function narrowed(initial: number, selected: number): string {
	const pct = initial > 0 ? Math.round((selected / initial) * 100) : 100;
	return `${NUM.format(selected)} of ${NUM.format(initial)} (${pct}%)`;
}

/** One sentence per table read: what the indexes left to read, or that they left everything. */
function readSummary(read: ExplainRead): { text: string; skipped: boolean } {
	const granules = read.granules;
	if (!granules) {
		return { text: read.target, skipped: true };
	}
	const skipped = granules.selected < granules.initial;
	const parts = read.parts ? `, ${narrowed(read.parts.initial, read.parts.selected)} parts` : '';
	const what = read.fromProjection ? `Answered from projection ${read.target}` : `Reads ${read.target}`;
	return {
		text: skipped
			? `${what}: ${narrowed(granules.initial, granules.selected)} granules${parts}.`
			: `${what}: all ${NUM.format(granules.initial)} granules, none skipped.`,
		skipped,
	};
}

export function ExplainPanel({ run, tableRows }: ExplainPanelProps): JSX.Element {
	const [variantId, setVariantId] = useState(run.variants[0]?.id ?? '');
	const [answer, setAnswer] = useState<Answer>({ state: 'loading' });
	const variant = run.variants.find((v) => v.id === variantId) ?? run.variants[0];

	// A fresh statement starts at the first variant again: the picker's memory belongs to the plan
	// being read, not to the panel.
	useEffect(() => {
		setVariantId(run.variants[0]?.id ?? '');
	}, [run.sql, run.nonce, run.variants]);

	const read = useCallback(async (): Promise<void> => {
		if (!variant) {
			return;
		}
		setAnswer({ state: 'loading' });
		// Richest first: an EXPLAIN option a server version has not got is an error, not a word it
		// ignores, so the attempts step down until one answers. The last one's message is the one
		// worth showing, since it asked for the least.
		let message = 'This server would not explain that statement.';
		for (const sql of variant.statements(run.sql)) {
			const res = await window.sqlApi.explain({ connectionId: run.connectionId, sql });
			if (!res.ok) {
				message = res.error;
				continue;
			}
			const { fields, rows } = res.result;
			if (variant.shape === 'plan') {
				const nodes = parseExplainPlan(rows[0]?.[0]);
				if (nodes) {
					setAnswer({ state: 'plan', nodes });
					return;
				}
				message = 'The server answered, but not with a plan this can read.';
				continue;
			}
			if (variant.shape === 'estimate') {
				setAnswer({ state: 'estimate', rows: readExplainEstimate(fields, rows) });
				return;
			}
			setAnswer({ state: 'text', text: explainText(rows), sql: variant.shape === 'sql' });
			return;
		}
		setAnswer({ state: 'error', message });
	}, [variant, run.connectionId, run.sql, run.nonce]);

	useEffect(() => {
		void read();
	}, [read]);

	function copyAnswer(): void {
		const text = answer.state === 'text'
			? answer.text
			: answer.state === 'estimate'
				? answer.rows.map((r) => `${r.database}.${r.table}\t${r.parts}\t${r.rows}\t${r.marks}`).join('\n')
				: answer.state === 'plan'
					? planAsText(answer.nodes)
					: '';
		if (text !== '') {
			void navigator.clipboard.writeText(text);
		}
	}

	return (
		<div className="explain-panel">
			<div className="explain-head">
				<div className="explain-variants" role="tablist" aria-label="Explain">
					{run.variants.map((v) => (
						<button
							key={v.id}
							type="button"
							role="tab"
							aria-selected={v.id === variant?.id}
							className={`explain-variant${v.id === variant?.id ? ' active' : ''}`}
							title={v.hint}
							onClick={() => setVariantId(v.id)}
						>
							{v.label}
						</button>
					))}
				</div>
				<span className="spacer" />
				<button type="button" className="explain-action" title="Copy this answer" onClick={copyAnswer}>
					<Icon name="copy" /> Copy
				</button>
				<button type="button" className="explain-action" title="Explain again" onClick={() => void read()}>
					<Icon name="refresh" /> Refresh
				</button>
			</div>
			<div className="explain-hint muted">{variant?.hint}</div>
			<div className="explain-body">
				{answer.state === 'loading' && <div className="results-message">Explaining…</div>}
				{answer.state === 'error' && <div className="results-error explain-error">{answer.message}</div>}
				{answer.state === 'plan' && <PlanView nodes={answer.nodes} />}
				{answer.state === 'estimate' && <EstimateView rows={answer.rows} tableRows={tableRows} />}
				{answer.state === 'text' && (answer.sql
					? <SqlCode sql={answer.text} />
					: <pre className="explain-text">{answer.text}</pre>)}
			</div>
		</div>
	);
}

/** The plan: what each table read costs, then the steps that produced it. */
function PlanView({ nodes }: { nodes: ExplainNode[] }): JSX.Element {
	const reads = planReads(nodes);
	return (
		<>
			{reads.length > 0 && (
				<div className="explain-reads">
					{reads.map((r, i) => {
						const summary = readSummary(r);
						return (
							<div key={i} className={`explain-read${summary.skipped ? '' : ' explain-read-full'}`}>
								<Icon name={summary.skipped ? 'filter' : 'warning'} />
								<span>{summary.text}</span>
							</div>
						);
					})}
				</div>
			)}
			<ul className="explain-tree">
				{nodes.map((node, i) => <PlanNode key={i} node={node} />)}
			</ul>
		</>
	);
}

function PlanNode({ node }: { node: ExplainNode }): JSX.Element {
	return (
		<li className="explain-node">
			<div className="explain-node-head">
				<span className="explain-node-type">{node.type}</span>
				{node.description && <span className="explain-node-desc">{node.description}</span>}
			</div>
			{node.facts.length > 0 && (
				<div className="explain-facts">
					{node.facts.map((fact) => (
						<span key={fact.label} className="explain-fact" title={`${fact.label}: ${fact.value}`}>
							<span className="explain-fact-label">{fact.label}</span>
							{fact.value}
						</span>
					))}
				</div>
			)}
			{node.read && node.read.indexes.length > 0 && (
				<table className="explain-indexes">
					<thead>
						<tr><th>Index</th><th>Keys</th><th>Condition</th><th>Parts</th><th>Granules</th></tr>
					</thead>
					<tbody>
						{node.read.indexes.map((index, i) => (
							<tr key={i}>
								<td>{index.name ? `${index.type} ${index.name}` : index.type}</td>
								<td>{index.keys?.join(', ') ?? index.description ?? ''}</td>
								<td className="explain-condition" title={index.condition}>{index.condition ?? ''}</td>
								<td className="explain-num">{index.parts ? narrowed(index.parts.initial, index.parts.selected) : ''}</td>
								<td className="explain-num">{index.granules ? narrowed(index.granules.initial, index.granules.selected) : ''}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{node.children.length > 0 && (
				<ul className="explain-tree">
					{node.children.map((child, i) => <PlanNode key={i} node={child} />)}
				</ul>
			)}
		</li>
	);
}

/** What running it would read, per table, against what the table holds. */
function EstimateView({ rows, tableRows }: { rows: ExplainEstimateRow[]; tableRows?: (database: string, table: string) => number | undefined }): JSX.Element {
	if (rows.length === 0) {
		return <div className="results-message">This statement reads no table, so there is nothing to estimate.</div>;
	}
	const total = rows.reduce((sum, r) => sum + r.rows, 0);
	return (
		<>
			<div className="explain-reads">
				<div className="explain-read">
					<Icon name="database" />
					<span>Would read about {NUM.format(total)} rows from {rows.length === 1 ? '1 table' : `${rows.length} tables`}, before running it.</span>
				</div>
			</div>
			<table className="explain-estimate">
				<thead>
					<tr><th>Table</th><th className="explain-num">Parts</th><th className="explain-num">Rows</th><th className="explain-num">Of the table</th><th className="explain-num">Marks</th></tr>
				</thead>
				<tbody>
					{rows.map((row, i) => {
						const held = tableRows?.(row.database, row.table);
						// The estimate counts whole granules, so it can exceed a small table's rows.
						const share = held && held > 0 ? `${Math.min(100, Math.round((row.rows / held) * 100))}%` : '';
						return (
							<tr key={i}>
								<td>{row.database ? `${row.database}.${row.table}` : row.table}</td>
								<td className="explain-num">{NUM.format(row.parts)}</td>
								<td className="explain-num">{NUM.format(row.rows)}</td>
								<td className="explain-num" title={held ? `${NUM.format(held)} rows in the table` : 'The row count for this table is not loaded.'}>{share}</td>
								<td className="explain-num">{NUM.format(row.marks)}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</>
	);
}

/** The plan as indented text, for the clipboard (and for pasting into a chat or an issue). */
function planAsText(nodes: readonly ExplainNode[], depth = 0): string {
	const lines: string[] = [];
	for (const node of nodes) {
		const pad = '  '.repeat(depth);
		lines.push(`${pad}${node.type}${node.description ? ` (${node.description})` : ''}`);
		for (const fact of node.facts) {
			lines.push(`${pad}  ${fact.label}: ${fact.value}`);
		}
		for (const index of node.read?.indexes ?? []) {
			const g = index.granules ? ` granules ${index.granules.selected}/${index.granules.initial}` : '';
			lines.push(`${pad}  ${index.type}${index.name ? ` ${index.name}` : ''}${g}`);
		}
		if (node.children.length > 0) {
			lines.push(planAsText(node.children, depth + 1));
		}
	}
	return lines.join('\n');
}

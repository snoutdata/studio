/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Reading the destination's own execution plan.
 *
 *  This is the one finding that carries the vendor's own opinion rather than ours: the planner
 *  says how many rows it expects to read and how it means to read them. It is worth more than
 *  any static guess and it is worth less than a measurement, because an estimate is an
 *  estimate — so everything here says "the planner expects", never "this reads".
 *
 *  Every vendor writes its plan differently and several change the shape between versions, so
 *  the walk is structural rather than schema-driven: recurse, recognise the keys we know, and
 *  ignore everything else. A plan we cannot read produces no findings and a gap.
 *--------------------------------------------------------------------------------------------*/

import type { ReviewFinding } from '../types.js';
import { codeSpan } from '../markdown.js';
import { evidence, finding, rows } from './context.js';
import type { RuleContext } from './context.js';

/** Rows a step must be expected to touch before it is worth a comment. */
const NOTABLE_ROWS = 50_000;

interface Step {
	kind: 'scan' | 'index' | 'sort' | 'temp' | 'other';
	label: string;
	table?: string;
	rows?: number;
}

function num(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) {
		return Number(value);
	}
	return undefined;
}

/** Walk any vendor's plan JSON, collecting the steps we recognise. */
function walk(node: unknown, out: Step[]): void {
	if (Array.isArray(node)) {
		for (const item of node) {
			walk(item, out);
		}
		return;
	}
	if (!node || typeof node !== 'object') {
		return;
	}
	const obj = node as Record<string, unknown>;

	// Postgres: { "Node Type": "Seq Scan", "Relation Name": "orders", "Plan Rows": 18400000 }
	const nodeType = typeof obj['Node Type'] === 'string' ? (obj['Node Type'] as string) : undefined;
	if (nodeType) {
		const estimate = num(obj['Plan Rows']);
		const table = typeof obj['Relation Name'] === 'string' ? (obj['Relation Name'] as string) : undefined;
		const lower = nodeType.toLowerCase();
		out.push({
			kind: lower.includes('seq scan') ? 'scan'
				: lower.includes('sort') ? 'sort'
					: lower.includes('index') ? 'index'
						: lower.includes('materialize') || lower.includes('hash') ? 'temp'
							: 'other',
			label: nodeType,
			table,
			rows: estimate,
		});
	}

	// MySQL: { "table": { "access_type": "ALL", "table_name": "orders",
	//                     "rows_examined_per_scan": 18400000, "using_filesort": true } }
	const access = typeof obj['access_type'] === 'string' ? (obj['access_type'] as string) : undefined;
	if (access) {
		const estimate = num(obj['rows_examined_per_scan']) ?? num(obj['rows']);
		const table = typeof obj['table_name'] === 'string' ? (obj['table_name'] as string) : undefined;
		out.push({
			kind: access.toUpperCase() === 'ALL' ? 'scan' : 'index',
			label: access.toUpperCase() === 'ALL' ? 'full table scan' : `access by ${access}`,
			table,
			rows: estimate,
		});
	}
	if (obj['using_filesort'] === true) {
		out.push({ kind: 'sort', label: 'filesort' });
	}
	if (obj['using_temporary_table'] === true) {
		out.push({ kind: 'temp', label: 'temporary table' });
	}

	for (const value of Object.values(obj)) {
		walk(value, out);
	}
}

/** Findings from one EXPLAIN result. `plan` is whatever the driver returned. */
export function planFindings(ctx: RuleContext, plan: unknown, probeSql: string): ReviewFinding[] {
	let parsed: unknown = plan;
	if (typeof plan === 'string') {
		try {
			parsed = JSON.parse(plan);
		} catch {
			return []; // not JSON (a text plan) — nothing to read, and the caller records a gap
		}
	}
	const steps: Step[] = [];
	walk(parsed, steps);
	if (steps.length === 0) {
		return [];
	}

	const out: ReviewFinding[] = [];
	const worstScan = steps
		.filter((s) => s.kind === 'scan')
		.sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0))[0];

	if (worstScan && (worstScan.rows === undefined || worstScan.rows >= NOTABLE_ROWS)) {
		const where = worstScan.table ? `${codeSpan(worstScan.table)}` : 'a table in this statement';
		out.push(finding(ctx, {
			kind: 'plan',
			severity: worstScan.rows !== undefined && worstScan.rows >= 1_000_000 ? 'warn' : 'note',
			subject: `scan:${worstScan.table ?? ''}`,
			title: worstScan.rows !== undefined
				? `The planner expects to scan ${rows(worstScan.rows)} of ${where}`
				: `The planner reads all of ${where}`,
			detail: 'This is the destination\'s own plan for the statement as written, not an estimate of ours. A full scan is fine on a small table and is the thing to fix on a large one; the row count above is what the planner expects, so it moves as the table grows.',
			evidence: evidence(ctx, `${worstScan.label}${worstScan.rows !== undefined ? ` over ${rows(worstScan.rows)}` : ''}`, probeSql),
		}));
	}

	const sort = steps.find((s) => s.kind === 'sort');
	if (sort) {
		out.push(finding(ctx, {
			kind: 'plan',
			severity: 'note',
			subject: 'sort',
			title: 'The sort is not served by an index',
			detail: 'The planner has to materialise and sort the result rather than walking an index already in that order. On a large result this is the step that spills to disk.',
			evidence: evidence(ctx, sort.label, probeSql),
		}));
	}
	return out;
}

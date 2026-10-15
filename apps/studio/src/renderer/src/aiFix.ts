/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { classifyError, type ErrorClass } from '../../shared/engine';

// What the error's CLASS says about the fix, where that is not "correct a name": a query that ran
// out of memory or time is usually valid SQL, and a small model told only "fix it" rewrites names
// that were never wrong. Classified by the engine's own code where it has one (ClickHouse).
const FIX_HINTS: Partial<Record<ErrorClass, string>> = {
	'resource-limit': "This is a resource limit, not a syntax or naming error: the query is probably valid. Make it read and hold less: filter earlier (on the table's sort or partition key if it has one), select fewer columns, aggregate before joining, and put the smaller side of a JOIN on the right.",
	timeout: "This query ran out of time, not into a syntax or naming error: the query is probably valid. Make it read less: filter earlier (on the table's sort or partition key if it has one), select fewer columns, or pre-aggregate.",
	'type-mismatch': "This is a type error: a value or expression has the wrong type for where it is used. Cast it explicitly or compare it to a literal of the column's own type.",
};

// Builds the assistant message for "Fix with AI" on a failed query: the exact DB error plus
// the SQL that produced it. Embedding the SQL is deliberate — its FROM/JOIN table names drive
// the schema-ranking in main so the tables the query touches are inlined (with columns) into
// the prompt, and in agentic mode the loop can inspect the DB to verify a fix. Pure string
// templating (no DOM/Monaco) so it's unit-testable under node --test.
export function buildFixPrompt(sql: string, error: string): string {
	const hint = FIX_HINTS[classifyError(error, 'execution')];
	return [
		"The SQL below failed against the connected database. Diagnose the cause from the error, then return a corrected query.",
		'',
		'Error:',
		error.trim(),
		...(hint ? ['', hint] : []),
		'',
		'SQL:',
		'```sql',
		sql.trim(),
		'```',
		'',
		"Fix any wrong table or column names using the database's real schema (the involved tables are described in your context). Briefly explain the fix, then give the corrected SQL in a single ```sql block.",
	].join('\n');
}
// Builds the assistant message for "Ask AI" on a notification that isn't a failed query (a
// connection failure, an export error, a sign-in problem, …) — there's no SQL to correct, so we
// hand it the error text and ask for a plain explanation plus the things to check. Pure string
// templating (no DOM/Monaco) so it stays node-testable alongside buildFixPrompt.
export function buildErrorHelpPrompt(title: string, detail: string): string {
	return [
		"I hit this error in the app. Explain in plain terms what it means and the most likely fix.",
		'',
		'Error:',
		[title.trim(), detail.trim()].filter(Boolean).join('\n'),
		'',
		"If it's a database connection or configuration problem, give a short checklist of what to verify (the host and port being reachable, credentials, SSL/TLS settings, a firewall or VPN, and whether the database server is actually running). Keep it concise.",
	].join('\n');
}

// The two prompts behind the Query Performance tool's per-row analysis. Both
// embed the exact statement (its FROM/JOIN tables drive the schema-ranking in main so the touched
// tables are inlined with columns) and take the connection's `dialect` so the SQL flavour
// (aiDisplayName) and the vendor-specific tuning playbook (optimizationHints) are correct. The
// generic chat system prompt is built for Q&A, so on a modest model these prompts must carry the
// optimization domain knowledge themselves. Pure string templating (no DOM/Monaco) so they stay
// node-testable alongside the other prompt builders.

/** The minimal slice of a Dialect the optimization prompts need (so a test can pass a literal). */
export interface OptimizeDialect {
	readonly aiDisplayName: string;
	readonly optimizationHints?: string;
}

// Step 1 — "Analyze": describe what the statement DOES and why it is heavy, in plain language. No fix
// yet (that is the deliberate second step), so the user understands the query before deciding.
export function buildExplainQueryPrompt(sql: string, dialect: OptimizeDialect): string {
	return [
		`This is one of the heaviest statements by total execution time on a connected ${dialect.aiDisplayName} database (from its runtime statistics). Explain it for the developer.`,
		'',
		'Statement:',
		'```sql',
		sql.trim(),
		'```',
		'',
		`Work against the database's real schema (the involved tables are described in your context). In a few sentences: say what this query returns / what it is for, then the most likely reason it is expensive (a full table scan, a missing index, a large join or sort, a non-sargable filter). Do NOT propose a fix or write any SQL yet, just the diagnosis. Be concise.`,
	].join('\n');
}

// Step 2 — "Suggest optimization" (user-triggered): propose the smallest effective fix, confirming
// the plan with EXPLAIN first, grounded in the engine's own tuning levers (optimizationHints).
// Doubles as the chat-seed when the user chooses to APPLY a fix, so its reply routes through the
// existing approval-gated DDL path rather than being applied blind.
export function buildOptimizeQueryPrompt(sql: string, dialect: OptimizeDialect): string {
	const flavour = dialect.aiDisplayName;
	const lines = [
		`This statement is one of the heaviest by total execution time on the connected ${flavour} database (from its runtime statistics). Diagnose why it is slow and propose how to make it faster.`,
		'',
		'Statement:',
		'```sql',
		sql.trim(),
		'```',
		'',
		`Work against the database's real schema (the involved tables are described in your context). First confirm the plan by running EXPLAIN (vendor-correct for ${flavour}) on it, looking for full scans, missing indexes, or expensive joins.`,
	];
	if (dialect.optimizationHints) {
		lines.push('', `Then recommend the smallest effective fix, choosing from these ${flavour} tuning levers (apply only the ones the plan justifies):`, dialect.optimizationHints);
	} else {
		lines.push('', 'Then recommend the smallest effective fix: a covering/filtering index or a query rewrite.');
	}
	lines.push('', `If you propose a CREATE INDEX or a rewrite, give the final SQL in a single \`\`\`sql block so it can be reviewed and run. Be concise.`);
	return lines.join('\n');
}

/** The continuation prompt for "Suggest optimization" *after* an Analyze on the same statement: reuse
 *  the model's own diagnosis above and just ask for the fix, still grounded in the vendor levers. */
export function buildOptimizeFollowUp(dialect: OptimizeDialect): string {
	const lines = [
		"Now suggest the single most effective optimization for this statement, building on your analysis above. Confirm with EXPLAIN if useful.",
	];
	if (dialect.optimizationHints) {
		lines.push('', `Pick from these ${dialect.aiDisplayName} tuning levers (only what the plan justifies):`, dialect.optimizationHints);
	}
	lines.push('', "Then give any index or rewrite as DDL in one ```sql block so it can be reviewed and run.");
	return lines.join('\n');
}

// Builds the assistant message for "Ask AI to fix" on a failed schema-sync migration statement.
// Frames it as part of a schema-synchronization run (morphing this database to match a source),
// names the object so the schema-ranking in main inlines the right table/view, and demands a
// single drop-in replacement: its reply replaces the failing statement and is re-run verbatim, so
// it must be one complete, runnable DDL statement in exactly one ```sql block.
export function buildMigrationFixPrompt(sql: string, error: string, objectName: string): string {
	return [
		`This is a schema-synchronization task: a generated migration is changing this database's schema to match a source database, and one statement failed while changing \`${objectName}\`. Diagnose the cause from the error, then return a corrected statement.`,
		'',
		'Error:',
		error.trim(),
		'',
		'Failing statement:',
		'```sql',
		sql.trim(),
		'```',
		'',
		`Use the database's real schema (the involved object is described in your context). Common causes: the change was already partly applied, a duplicate/conflicting value blocks a unique index, or a dependency is missing.`,
		`Your corrected statement will replace the failing one and be re-run verbatim, so it must be a drop-in replacement: one complete, runnable DDL statement achieving the same intent (make it idempotent where possible, e.g. guard against the existing object). Briefly explain the cause and the fix, then give exactly one \`\`\`sql block with the replacement statement. If the change is already satisfied and should simply be skipped, say so instead of returning SQL.`,
	].join('\n');
}

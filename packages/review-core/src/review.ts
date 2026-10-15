/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The orchestrator: a pull request in, a report out.
 *
 *  Two entry points, in the order a host calls them:
 *
 *    planReview(input)  → the statements, and the probes they want answered
 *    review(input)      → the report, given whatever probe results came back (or none)
 *
 *  A host with no database calls `review` alone and gets the static tier. A host with one
 *  calls `planReview`, runs the probes it is willing to pay for, and passes the results to
 *  `review`. Same code, same rules, three products.
 *--------------------------------------------------------------------------------------------*/

import { dialectFor } from './dialect.js';
import { PROBE_FAILURE_REASONS, probeFailureOf } from './failure.js';
import { codeSpan } from './markdown.js';
import { reviewableFiles } from './diff.js';
import type { PathFilter } from './diff.js';
import { describeSize, resolveLimits } from './limits.js';
import type { ReviewLimits } from './limits.js';
import { planProbes, probeFindings } from './probes.js';
import { alterFindings } from './rules/alter.js';
import { applyToPending, emptyPendingSchema, summarisePullRequest } from './rules/context.js';
import type { RuleContext } from './rules/context.js';
import { planFindings } from './rules/plan.js';
import { schemaFindings } from './rules/schema.js';
import { staticFindings } from './rules/static.js';
import { parseStatement } from './sql/parse.js';
import type { ParsedStatement } from './sql/parse.js';
import { touchedStatements } from './statements.js';
import type { LocalProbeError, Probe, ReviewDepth, ReviewFinding, ReviewInput, ReviewReport, ReviewStatement } from './types.js';

export interface ReviewOptions extends ReviewInput {
	/** Which paths count as reviewable. Defaults in `diff.ts`. */
	paths?: PathFilter;
	/** Run the probes that are skipped as expensive by default (`review --deep`). */
	deep?: boolean;
	/** Rule kinds the repository has switched off. */
	disabledKinds?: string[];
	/** Size caps; the defaults in `limits.ts` apply to anything not given. */
	limits?: Partial<ReviewLimits>;
}

export interface ReviewPlan {
	statements: ReviewStatement[];
	parsed: ParsedStatement[];
	probes: Probe[];
	/** Files whose full content was not supplied, so their statements may be clipped. */
	clippedFiles: string[];
	/** One sentence per size cap this pull request hit, saying what was not reviewed. */
	limits: string[];
}

/** Where a few statements are, for a sentence: `a.sql` line 3, `b.sql` line 9 and 4 more. */
function locations(statements: ReviewStatement[]): string {
	const shown = statements.slice(0, 3).map((s) => `${codeSpan(s.file)} line ${s.line}`);
	const more = statements.length - shown.length;
	return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/** The statements this PR touched and the probes they want answered. */
export function planReview(input: ReviewOptions): ReviewPlan {
	const limits = resolveLimits(input.limits);
	const notes: string[] = [];

	if (input.diff.length > limits.diffChars) {
		notes.push(`This pull request's diff is ${describeSize(input.diff.length)}, over the ${describeSize(limits.diffChars)} this reviewer reads, so none of it was reviewed. Splitting the SQL change into a smaller pull request gets it reviewed.`);
		return { statements: [], parsed: [], probes: [], clippedFiles: [], limits: notes };
	}

	const files = reviewableFiles(input.diff, input.paths);
	const dialect = dialectFor(input.driverId);

	// A file too large to read whole is read from its added lines, which the diff cap bounds.
	let contents = input.files;
	if (contents) {
		const big = files.filter((f) => (contents![f.path]?.length ?? 0) > limits.fileChars).map((f) => f.path);
		if (big.length > 0) {
			contents = { ...contents };
			for (const path of big) {
				delete contents[path];
			}
			notes.push(`${big.map(codeSpan).join(', ')} ${big.length === 1 ? 'is' : 'are'} over ${describeSize(limits.fileChars)}, so only the changed lines were read.`);
		}
	}

	// Split the way the destination lexes: where a string ends decides where a statement ends.
	const split = touchedStatements(files, contents, dialect.lex);
	const clipped = split.clipped;
	const tooLong = split.statements.filter((s) => s.sql.length > limits.statementChars);
	let statements = tooLong.length > 0 ? split.statements.filter((s) => s.sql.length <= limits.statementChars) : split.statements;
	if (tooLong.length > 0) {
		notes.push(`${tooLong.length === 1 ? 'One statement is' : `${tooLong.length} statements are`} longer than ${describeSize(limits.statementChars)} and ${tooLong.length === 1 ? 'was' : 'were'} not reviewed: ${locations(tooLong)}.`);
	}
	if (statements.length > limits.statements) {
		const rest = statements.slice(limits.statements);
		statements = statements.slice(0, limits.statements);
		notes.push(`This pull request touches ${limits.statements + rest.length} statements. The first ${limits.statements} were reviewed and the other ${rest.length} were not, starting at ${locations(rest.slice(0, 1))}.`);
	}
	const parsed = statements.map((s) => parseStatement(s.sql));

	const probes: Probe[] = [];
	if (input.schema) {
		for (let i = 0; i < statements.length; i++) {
			probes.push(
				...planProbes({
					statement: statements[i],
					parsed: parsed[i],
					dialect,
					schema: input.schema,
					deep: input.deep,
				}),
			);
		}
	}
	return { statements, parsed, probes, clippedFiles: clipped, limits: notes };
}

function severityRank(finding: ReviewFinding): number {
	return finding.severity === 'blocker' ? 0 : finding.severity === 'warn' ? 1 : 2;
}

/** Review the pull request. Safe to call with nothing but a diff. */
export function review(input: ReviewOptions): ReviewReport {
	const now = input.now ?? Date.now();
	const dialect = dialectFor(input.driverId);
	const plan = planReview(input);
	const results = new Map((input.probeResults ?? []).map((r) => [r.id, r]));

	const depth: ReviewDepth = !input.schema ? 'static' : results.size > 0 ? 'connected' : 'schema';
	const disabled = new Set(input.disabledKinds ?? []);
	const gaps: string[] = [];
	const localErrors: LocalProbeError[] = [];
	const findings: ReviewFinding[] = [];

	for (const file of plan.clippedFiles) {
		gaps.push(`${codeSpan(file)}: only the changed lines were available, so a statement that starts in unchanged context may have been read incomplete.`);
	}

	// Group the parsed statements by file, so a rule can ask about the file it sits in.
	const byFile = new Map<string, ParsedStatement[]>();
	for (let i = 0; i < plan.statements.length; i++) {
		const file = plan.statements[i].file;
		const list = byFile.get(file) ?? [];
		list.push(plan.parsed[i]);
		byFile.set(file, list);
	}

	// The PR's own effects accumulate as we walk it, so a migration that creates a table and
	// then alters it reads correctly instead of reporting the table as missing.
	const pending = emptyPendingSchema();
	// Order matters for "does this exist yet" and must not matter for "did the author think of
	// it", so the whole PR's effect set is computed before the walk starts.
	const pr = summarisePullRequest(plan.parsed);
	let cleanProbes = 0;

	for (let i = 0; i < plan.statements.length; i++) {
		const statement = plan.statements[i];
		const parsed = plan.parsed[i];

		const ctx: RuleContext = {
			statement,
			parsed,
			dialect,
			schema: input.schema,
			pending,
			pr,
			destinationName: input.destinationName,
			probes: results,
			fileStatements: byFile.get(statement.file) ?? [],
			now,
		};

		findings.push(...staticFindings(ctx));
		findings.push(...schemaFindings(ctx));
		findings.push(...alterFindings(ctx));

		const mine = plan.probes.filter((p) => p.statementId === statement.id);

		for (const probe of mine) {
			const result = results.get(probe.id);
			if (!result) {
				if (input.schema) {
					gaps.push(`Not checked: ${probe.purpose}.`);
				}
				continue;
			}
			if (!result.ok) {
				// A fixed reason, never the database's words: they echo names the pull request
				// chose (an image, a mention, a `</details>`) and carry hosts, roles and values.
				// The text is kept for the host's own screen.
				const failure = result.failure ?? probeFailureOf(result.error);
				gaps.push(`Could not check ${probe.purpose}: ${PROBE_FAILURE_REASONS[failure]}.`);
				if (result.error) {
					localErrors.push({ about: probe.purpose, error: result.error });
				}
				continue;
			}
			// A probe counts as clean only when it produced nothing. "I checked and it is fine"
			// is a number in the footer, never a paragraph on the page.
			const raised = probe.kind === 'explain'
				? planFindings(ctx, result.rows?.[0] ? Object.values(result.rows[0])[0] : undefined, probe.sql)
				: probeFindings(ctx, [probe]);
			findings.push(...raised);
			if (raised.length === 0) {
				cleanProbes++;
			}
		}

		if (parsed.partial) {
			gaps.push(`${codeSpan(statement.file)} line ${statement.line}: ${parsed.partial}.`);
		}
		applyToPending(parsed, pending);
	}

	// A probe that answered cleanly is counted, never printed: "I checked and it is fine" on
	// every statement is how a reviewer teaches people to skim past it.
	const kept = findings.filter((f) => !disabled.has(f.kind));
	kept.sort((a, b) => severityRank(a) - severityRank(b) || a.file.localeCompare(b.file) || a.line - b.line);

	return {
		depth,
		findings: dedupe(kept),
		files: [...byFile.keys()],
		statementCount: plan.statements.length,
		gaps,
		destinationName: input.destinationName,
		schemaFetchedAt: input.schema?.fetchedAt,
		checksPassed: cleanProbes,
		limits: plan.limits.length > 0 ? plan.limits : undefined,
		localErrors: localErrors.length > 0 ? localErrors : undefined,
	};
}

/**
 * Review a set of whole files rather than a diff — the standing audit rather than the change.
 *
 * The groundwork for "scan the repository for queries that will not use an index": the rules and
 * the probes are the same, and the only difference is that every statement counts as touched. Kept
 * deliberately small until it is decided how a repository-wide report should be presented,
 * which is not a comment on a pull request.
 */
export function reviewFiles(files: Record<string, string>, options: Omit<ReviewOptions, 'diff' | 'files'> = {}): ReviewReport {
	const NL = String.fromCharCode(10);
	const diff = Object.entries(files)
		.map(([path, content]) => {
			const lines = content.split(NL);
			return [
				`diff --git a/${path} b/${path}`,
				'--- /dev/null',
				`+++ b/${path}`,
				`@@ -0,0 +1,${lines.length} @@`,
				...lines.map((line) => `+${line}`),
			].join(NL);
		})
		.join(NL);
	return review({ ...options, diff, files });
}

/** Two rules can reach the same conclusion about the same statement; say it once. */
function dedupe(findings: ReviewFinding[]): ReviewFinding[] {
	const seen = new Set<string>();
	const out: ReviewFinding[] = [];
	for (const f of findings) {
		if (seen.has(f.id)) {
			continue;
		}
		seen.add(f.id);
		out.push(f);
	}
	return out;
}

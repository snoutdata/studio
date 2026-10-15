/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The prompt for the OPTIONAL model pass over a finished review.
 *
 *  The rule set is deterministic: no model decides whether something will fail, reads a
 *  measurement, or judges severity. A model is allowed exactly one job here — turning findings
 *  that have ALREADY been measured into prose a reviewer wants to read — and it is given nothing
 *  it could use to do more.
 *
 *  So this builds a prompt and nothing else. It is pure, like everything in this package: the
 *  host calls the model, and the host decides whether one is called at all. What comes back is
 *  rendered in its own folded section labelled with the model that wrote it (`report.ts`), never
 *  mixed into a finding.
 *
 *  What the model is NOT given, deliberately:
 *    - the schema, so it cannot describe a table it has not been shown
 *    - the probe results, so it cannot restate a measurement in its own words and get it wrong
 *    - any instruction that would let it add, remove or re-rank a finding
 *
 *  It gets the findings as they will be printed, and it is told to explain those and only those.
 *--------------------------------------------------------------------------------------------*/

import { resolveBranding, type Branding } from './branding.js';
import type { ReviewReport } from './types.js';

/** How much of the review goes in the prompt. A review with sixty findings is a review nobody
 *  will read in prose either, and the budget is the user's own AI allowance. */
const MAX_FINDINGS = 20;

export interface CommentaryPromptOptions {
	branding?: Partial<Branding>;
	/** What the destination is called, when there was one. Only so the prose can name it. */
	destinationName?: string;
}

/** A system + user pair for the commentary pass, or null when there is nothing worth saying. */
export function commentaryPrompt(
	report: ReviewReport,
	options: CommentaryPromptOptions = {},
): { system: string; user: string } | null {
	if (report.findings.length === 0) {
		// A clean review needs no essay about being clean.
		return null;
	}
	const branding = resolveBranding(options.branding);
	const findings = report.findings.slice(0, MAX_FINDINGS);

	const system = [
		`You are ${branding.displayName}, writing the human-readable half of a database pull-request review.`,
		'',
		'The findings below were produced by a deterministic rule set, and some of them were measured against the real destination database. Your job is to explain what they mean for the person who has to merge this, in a few short paragraphs.',
		'',
		'Rules you must not break:',
		'- Do NOT add findings. If something is not in the list, it was not found, and you must not raise it.',
		'- Do NOT change how serious anything is. The severities are given and they are not yours to re-rank.',
		'- Do NOT state any number that is not in the input. You cannot see the database. If you want a count that is not there, say it was not measured.',
		'- Do NOT repeat each finding in turn. They are already printed above what you write; a list of the same list is worse than nothing.',
		'- Do NOT suggest running anything, and do NOT write SQL unless a finding already contains it.',
		'',
		// The house punctuation rule applies to what a model writes under our name
		// too: this text is posted into somebody's pull request as part of the review.
		'- Do NOT use dashes as punctuation. No em dashes, no en dashes. Use a comma, a full stop, a colon or brackets.',
		'',
		'Write what a reviewer would want said out loud: what the real risk is, what order to deal with things in, and what is safe to ignore for now. Plain prose, no headings, under 200 words. If the findings genuinely need no commentary, reply with nothing at all.',
	].join('\n');

	const lines: string[] = [];
	lines.push(`Depth of this review: ${describeDepth(report, options.destinationName)}`);
	lines.push('');
	lines.push('Findings:');
	for (const finding of findings) {
		lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}:${finding.line})`);
		if (finding.detail) {
			lines.push(`  ${finding.detail}`);
		}
		// The evidence is what makes a finding a measurement rather than an opinion, so the prose
		// can refer to it — but only as given, never recomputed.
		if (finding.evidence) {
			lines.push(`  measured on ${finding.evidence.source}: ${finding.evidence.measured}`);
		}
	}
	if (report.findings.length > findings.length) {
		lines.push('');
		lines.push(`(${report.findings.length - findings.length} further findings are not shown to you; do not guess at them.)`);
	}
	if (report.gaps.length > 0) {
		lines.push('');
		lines.push('Could not be checked:');
		for (const gap of report.gaps) {
			lines.push(`- ${gap}`);
		}
	}
	return { system, user: lines.join('\n') };
}

function describeDepth(report: ReviewReport, destinationName: string | undefined): string {
	const on = destinationName ?? report.destinationName;
	switch (report.depth) {
		case 'connected':
			return on
				? `the diff, the schema of "${on}", and read-only measurements against it`
				: 'the diff, the schema, and read-only measurements against the destination';
		case 'schema':
			return on ? `the diff and the schema of "${on}". No data was measured.` : 'the diff and the schema. No data was measured.';
		default:
			return 'the diff only. No database was consulted at all, so nothing here has been checked against real data.';
	}
}

/**
 * Take the dashes out of what a model wrote.
 *
 * The prompt above forbids them, and a prompt is not a guarantee: this text is posted into
 * somebody's pull request under our name, and the house rule is that user-facing
 * text does not use a dash where a comma, a full stop, a colon or brackets would do. Asking
 * nicely works most of the time on a large model and less of the time on a small one, so the
 * rule is enforced here instead of hoped for. Deterministic, pure, and cheap.
 *
 * Fenced code is left exactly as it is: a dash inside a code block is code, not punctuation,
 * and `--` is a SQL comment.
 */
export function tidyPunctuation(text: string): string {
	// Split on fences so the replacements only ever touch prose. An odd number of fences means
	// an unclosed block, and the tail is then treated as code, which is the safe way to be wrong.
	return text
		.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
		.map((part, index) => (index % 2 === 1 ? part : tidyProse(part)))
		.join('');
}

function tidyProse(text: string): string {
	return text
		// An em or en dash between two things, spaced or not, becomes a comma.
		.replace(/(\S)[ \t]*[\u2014\u2013][ \t]*(?=\S)/g, '$1, ')
		// A hyphen doing the same job. Anchored on word characters either side so a list bullet
		// (`- item`, always at the start of a line) and a compound word are both left alone.
		.replace(/(\w)[ \t]+-[ \t]+(?=\w)/g, '$1, ')
		// What those two can leave behind: a doubled comma where a dash sat beside one, a comma
		// pushed up against the end of a sentence, and a space before it.
		.replace(/,[ \t]*,/g, ',')
		.replace(/[ \t]+,/g, ',')
		.replace(/,[ \t]*([.;:!?])/g, '$1');
}

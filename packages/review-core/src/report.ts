/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The comment.
 *
 *  One comment per pull request, edited in place, carrying a hidden marker so the host can find
 *  it again. Everything about its shape follows from one belief: a reviewer is read for about
 *  four seconds before somebody decides whether to trust it. So the first line is the verdict,
 *  the blockers are open, everything else is folded away, and the footer says plainly how much
 *  of the database it could actually see.
 *--------------------------------------------------------------------------------------------*/

import { resolveBranding } from './branding.js';
import { codeFence, codeSpan, oneLine, untrustedMarkdown } from './markdown.js';
import type { Branding } from './branding.js';
import type { ReviewFinding, ReviewReport, ReviewSeverity } from './types.js';

/** The most of a model's prose a comment quotes. Findings are the comment; this is an aside. */
const COMMENTARY_CAP = 6000;

/** Identifies our comment so a re-review edits it instead of adding another. */
export const COMMENT_MARKER = '<!-- snout-review:v1 -->';

export interface RenderOptions {
	branding?: Partial<Branding>;
	/** Finding ids somebody has asked to ignore, with the reason. Shown struck through, never
	 *  removed: a finding that vanishes when it is inconvenient is a finding nobody trusts. */
	ignored?: Record<string, string | undefined>;
	/** Ids present in the previous review of this PR, so the comment can say what is new. */
	previousIds?: string[];
	/** A link to the run, when the host has one. */
	runUrl?: string;
	/**
	 * Prose a MODEL wrote about this review, when the host ran one, and which model wrote it.
	 *
	 * Rendered in its own section, below the findings, behind a fold, and labelled with the model
	 * that produced it — never mixed into a finding. That separation is the product's whole claim:
	 * every finding above it is deterministic and measured, and a sentence that came from a model
	 * is not a measurement. The core does not call anything to get this; the host passes it in, or
	 * does not.
	 */
	commentary?: { text: string; model: string };
}

const HEADING: Record<ReviewSeverity, string> = {
	blocker: 'Will not run, or will lose data',
	warn: 'Will run, and will hurt',
	note: 'Worth knowing',
};

const ICON: Record<ReviewSeverity, string> = {
	blocker: '🛑',
	warn: '⚠️',
	note: '💬',
};

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** The one-line verdict everything else hangs off. */
function verdict(report: ReviewReport): string {
	const blockers = report.findings.filter((f) => f.severity === 'blocker').length;
	const warns = report.findings.filter((f) => f.severity === 'warn').length;

	if (report.statementCount === 0) {
		return report.limits && report.limits.length > 0
			? '**Not reviewed.** This pull request is over the size this reviewer reads.'
			: 'No SQL changed in this pull request.';
	}
	if (blockers > 0) {
		return `**${plural(blockers, 'problem')} that will stop this migration or lose data.**`;
	}
	if (warns > 0) {
		return `**No blockers. ${plural(warns, 'thing')} worth fixing before this runs.**`;
	}
	if (report.depth === 'connected') {
		return `**Nothing to flag.** ${plural(report.statementCount, 'statement')} reviewed against ${codeSpan(report.destinationName ?? 'the destination')}.`;
	}
	return `**Nothing to flag** in ${plural(report.statementCount, 'statement')}.`;
}

/** What the reviewer could actually see. Never dress this up. */
function depthLine(report: ReviewReport, branding: Branding): string {
	if (report.depth === 'static') {
		const link = branding.connectUrl ? ` [Connect one](${branding.connectUrl})` : '';
		return `_Read from the diff only. No database was connected, so nothing here has been checked against real data. Connecting a staging database turns "consider an index" into "this will fail: 412 rows are NULL".${link}_`;
	}
	const age = report.schemaFetchedAt ? describeAge(Date.now() - report.schemaFetchedAt) : undefined;
	const where = report.destinationName ? `${codeSpan(report.destinationName)}` : 'the destination';
	if (report.depth === 'schema') {
		return `_Checked against the schema of ${where}${age ? `, introspected ${age}` : ''}. No data was read._`;
	}
	const clean = report.checksPassed > 0
		? ` ${plural(report.checksPassed, 'check')} ran against real data and came back clean.`
		: '';
	return `_Checked against ${where}${age ? `, schema introspected ${age}` : ''}.${clean}_`;
}

function describeAge(ms: number): string {
	if (ms < 90_000) {
		return 'just now';
	}
	const minutes = Math.round(ms / 60_000);
	if (minutes < 90) {
		return `${minutes} minutes ago`;
	}
	const hours = Math.round(minutes / 60);
	return hours < 36 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

function renderFinding(finding: ReviewFinding, options: RenderOptions): string {
	const ignoredReason = options.ignored ? options.ignored[finding.id] : undefined;
	const isIgnored = options.ignored ? Object.prototype.hasOwnProperty.call(options.ignored, finding.id) : false;
	const isNew = options.previousIds ? !options.previousIds.includes(finding.id) : false;

	const title = isIgnored ? `~~${finding.title}~~` : finding.title;
	const badge = isNew && options.previousIds ? ' `new`' : '';
	const lines: string[] = [];

	lines.push(`#### ${ICON[finding.severity]} ${title}${badge}`);
	lines.push('');
	lines.push(`${codeSpan(finding.file)}:${finding.line} (${codeSpan(finding.id)})`);
	lines.push('');
	lines.push(finding.detail);

	if (finding.evidence) {
		const when = new Date(finding.evidence.at).toISOString().replace('T', ' ').slice(0, 16);
		lines.push('');
		lines.push(`> **Measured:** ${finding.evidence.measured}, on ${codeSpan(finding.evidence.source)}, ${when} UTC.`);
		if (finding.evidence.sql) {
			lines.push('>');
			lines.push(`> <details><summary>the read-only query that measured it</summary>`);
			lines.push('>');
			for (const line of codeFence(finding.evidence.sql, 'sql')) {
				lines.push(`> ${line}`);
			}
			lines.push('> </details>');
		}
	}

	lines.push('');
	// The statement is the pull request's own text, so the fence is longer than any run of
	// backticks in it: a statement cannot end its own block and write the rest of the comment.
	lines.push(...codeFence(finding.statement, 'sql'));

	if (finding.suggestedSql) {
		lines.push('');
		lines.push('<details><summary>Suggested instead</summary>');
		lines.push('');
		lines.push(...codeFence(finding.suggestedSql, 'sql'));
		lines.push('');
		lines.push('</details>');
	}

	if (isIgnored) {
		lines.push('');
		lines.push(`_Ignored on this pull request${ignoredReason ? `: ${oneLine(ignoredReason)}` : ''}._`);
	}
	return lines.join('\n');
}

function section(severity: ReviewSeverity, findings: ReviewFinding[], options: RenderOptions): string {
	if (findings.length === 0) {
		return '';
	}
	const body = findings.map((f) => renderFinding(f, options)).join('\n\n---\n\n');
	// Blockers are open; everything else is folded, so the comment stays four seconds long.
	if (severity === 'blocker') {
		return `### ${HEADING[severity]}\n\n${body}`;
	}
	return `<details><summary><b>${HEADING[severity]}</b> (${findings.length})</summary>\n\n${body}\n\n</details>`;
}

/** The whole comment body, ready to post. */
export function renderComment(report: ReviewReport, options: RenderOptions = {}): string {
	const branding = resolveBranding(options.branding);
	const parts: string[] = [COMMENT_MARKER];

	parts.push(`### ${branding.displayName}`);
	parts.push('');
	parts.push(verdict(report));

	// A cap that was hit is said up front, never folded: "nothing to flag" on half a pull
	// request is only honest next to the sentence saying which half.
	for (const limit of report.limits ?? []) {
		parts.push('');
		parts.push(`> **Not fully reviewed:** ${limit}`);
	}

	if (options.previousIds && report.findings.length > 0) {
		const fixed = options.previousIds.filter((id) => !report.findings.some((f) => f.id === id));
		const added = report.findings.filter((f) => !options.previousIds!.includes(f.id));
		const bits: string[] = [];
		if (added.length > 0) {
			bits.push(`${plural(added.length, 'new finding')}`);
		}
		if (fixed.length > 0) {
			bits.push(`${plural(fixed.length, 'fixed')}`);
		}
		if (bits.length > 0) {
			parts.push('');
			parts.push(`_Since the last push: ${bits.join(', ')}._`);
		}
	}

	for (const severity of ['blocker', 'warn', 'note'] as ReviewSeverity[]) {
		const chunk = section(severity, report.findings.filter((f) => f.severity === severity), options);
		if (chunk !== '') {
			parts.push('');
			parts.push(chunk);
		}
	}

	if (report.gaps.length > 0) {
		parts.push('');
		parts.push(`<details><summary><b>What this review could not check</b> (${report.gaps.length})</summary>`);
		parts.push('');
		for (const gap of report.gaps) {
			parts.push(`- ${gap}`);
		}
		parts.push('');
		parts.push('</details>');
	}

	// Below every finding, folded, and labelled with the model. A reader who opens it knows they
	// have left the measured part of this comment.
	//
	// The text is UNTRUSTED. The model's prompt holds names the pull request chose, so what it
	// writes is, as far as this comment is concerned, the PR author's, and it is posted under the
	// user's name: it is quoted with every piece of markup that could close the fold, draw an
	// image, link out, ping somebody or fake a heading made inert (`untrustedMarkdown`).
	if (options.commentary && options.commentary.text.trim() !== '') {
		const text = options.commentary.text.trim();
		const capped = text.length > COMMENTARY_CAP ? `${text.slice(0, COMMENTARY_CAP)} (cut short)` : text;
		parts.push('');
		parts.push('<details><summary><b>What this looks like, in prose</b> (written by a model)</summary>');
		parts.push('');
		parts.push(`_Written by ${codeSpan(options.commentary.model)} from the findings above. It did not run any check and it cannot see the database; everything measured is above this line. Quoted as written, with links, images, mentions and HTML made inert._`);
		parts.push('');
		for (const line of untrustedMarkdown(capped)) {
			parts.push(line === '' ? '>' : `> ${line}`);
		}
		parts.push('');
		parts.push('</details>');
	}

	parts.push('');
	parts.push('---');
	parts.push('');
	parts.push(depthLine(report, branding));

	// The reviewer signs its own comment.
	//
	// On a host, the byline belongs to whatever account the token belongs to, and with a personal
	// token that is a person: neither host has any way to post under another name. So the comment
	// says who wrote it, twice (the heading and here), and the settings pane offers the only real
	// fix, which is a token from a bot account.
	const footer: string[] = [branding.displayName];
	if (report.statementCount > 0) {
		footer.push(`${plural(report.statementCount, 'statement')} in ${plural(report.files.length, 'file')}`);
	}
	footer.push(`${codeSpan(`@${branding.handle} help`)}`);
	if (options.runUrl) {
		footer.push(`[run](${options.runUrl})`);
	}
	parts.push('');
	parts.push(`<sub>${footer.join(' · ')}</sub>`);

	return parts.join('\n');
}

/** The reply to `@handle help`. */
export function renderHelp(options: RenderOptions = {}): string {
	const branding = resolveBranding(options.branding);
	const h = `@${branding.handle}`;
	return [
		COMMENT_MARKER,
		`### ${branding.displayName}`,
		'',
		'| Command | What it does |',
		'| --- | --- |',
		`| ${codeSpan(`${h} review`)} | review this pull request as it stands |`,
		`| ${codeSpan(`${h} review --deep`)} | also run the checks skipped as expensive |`,
		`| ${codeSpan(`${h} review --on <name>`)} | review against a different destination |`,
		`| ${codeSpan(`${h} explain <id>`)} | expand one finding |`,
		`| ${codeSpan(`${h} ignore <id> [why]`)} | keep a finding listed but struck through |`,
		`| ${codeSpan(`${h} status`)} | what it can see right now |`,
		'',
		branding.url ? `_${branding.displayName} reviews the database change against the database it is going to land on. [More](${branding.url})_` : '',
	]
		.filter((line) => line !== '')
		.join('\n');
}

/** Whether the check run should pass, given what the repository asked to fail on. */
export function checkConclusion(report: ReviewReport, failOn: ReviewSeverity | 'never' = 'blocker'): 'success' | 'failure' | 'neutral' {
	if (failOn === 'never') {
		return 'neutral';
	}
	const rank: Record<ReviewSeverity, number> = { blocker: 0, warn: 1, note: 2 };
	const worst = report.findings.reduce<number>((acc, f) => Math.min(acc, rank[f.severity]), 3);
	if (worst <= rank[failOn]) {
		return 'failure';
	}
	// Part of the pull request was not read, so "success" would be a claim about SQL nobody saw.
	return report.limits && report.limits.length > 0 ? 'neutral' : 'success';
}

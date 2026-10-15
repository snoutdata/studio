/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { commentaryPrompt, tidyPunctuation } from './commentary.js';
import { renderComment } from './report.js';
import type { ReviewFinding, ReviewReport } from './types.js';

function finding(partial: Partial<ReviewFinding> = {}): ReviewFinding {
	return {
		id: 'a1b2',
		kind: 'destructive',
		severity: 'warn',
		title: 'Drops the table `legacy_orders`',
		detail: 'The table and its data are gone.',
		file: 'db/migrate/007.sql',
		line: 1,
		statement: 'DROP TABLE legacy_orders;',
		...partial,
	} as ReviewFinding;
}

function report(partial: Partial<ReviewReport> = {}): ReviewReport {
	return {
		depth: 'connected',
		findings: [finding()],
		files: ['db/migrate/007.sql'],
		statementCount: 1,
		gaps: [],
		destinationName: 'staging',
		checksPassed: 0,
		...partial,
	};
}

describe('commentaryPrompt', () => {
	test('a clean review gets no prompt at all', () => {
		// Nothing to explain, and the user's AI allowance is real money.
		assert.equal(commentaryPrompt(report({ findings: [] })), null);
	});

	// The rule: a model never decides whether something will fail, reads a measurement, or judges
	// severity. The prompt has to SAY so, or the next model will do it.
	test('the model is forbidden from adding findings, re-ranking them, or inventing a number', () => {
		const prompt = commentaryPrompt(report())!;
		assert.match(prompt.system, /Do NOT add findings/);
		assert.match(prompt.system, /Do NOT change how serious anything is/);
		assert.match(prompt.system, /Do NOT state any number that is not in the input/);
	});

	test('a static review tells the model, in the prompt, that no database was consulted', () => {
		// Otherwise the prose invents a database it was never shown, which is the one thing this
		// product cannot afford to do.
		const prompt = commentaryPrompt(report({ depth: 'static', destinationName: undefined }))!;
		assert.match(prompt.user, /No database was consulted at all/);
	});

	test('measurements travel with what they were measured on, and are never recomputed', () => {
		const prompt = commentaryPrompt(report({
			findings: [finding({
				evidence: { measured: '412 rows with ship_date IS NULL', source: 'staging', at: 0 },
			})],
		}))!;
		assert.match(prompt.user, /measured on staging: 412 rows with ship_date IS NULL/);
	});

	test('a long review is capped, and the model is told there are more rather than left to guess', () => {
		const many = Array.from({ length: 25 }, (_v, i) => finding({ id: `f${i}`, title: `Finding ${i}` }));
		const prompt = commentaryPrompt(report({ findings: many }))!;
		assert.match(prompt.user, /5 further findings are not shown to you; do not guess/);
		assert.ok(!prompt.user.includes('Finding 20'));
	});

	test('what it could not check goes in too, so the prose does not claim it was checked', () => {
		const prompt = commentaryPrompt(report({ gaps: ['could not reach `staging`'] }))!;
		assert.match(prompt.user, /Could not be checked:\n- could not reach `staging`/);
	});
});

describe('renderComment with commentary', () => {
	test('prose is folded, attributed to the model, and kept out of the findings', () => {
		const body = renderComment(report(), {
			commentary: { text: 'The drop is the only thing here that cannot be undone.', model: 'example-model-7b' },
		});
		assert.match(body, /written by a model/i);
		assert.match(body, /example-model-7b/);
		assert.match(body, /did not run any check and it cannot see the database/);
		// Below every finding: a reader reaches the measured part first.
		assert.ok(body.indexOf('Drops the table') < body.indexOf('in prose'));
	});

	test('no commentary, no section — the deterministic comment is unchanged', () => {
		const plain = renderComment(report());
		assert.ok(!plain.includes('in prose'));
		// An empty reply from a model is the same as no reply.
		assert.equal(renderComment(report(), { commentary: { text: '   ', model: 'x' } }), plain);
	});
});

// The model's prompt holds names the pull request controls, so its reply is the PR author's text
// as far as the comment is concerned, posted under the user's name (an outside review,
// 2026-10-14). It may not close the fold, draw an image, link out, ping anyone or fake a heading.
describe('the commentary is untrusted text', () => {
	const hostile = [
		'</details>',
		'# Approved by the database team',
		'Fine to merge. <img src="https://evil.example/p.png"> <!-- snout-review:v1 -->',
		'![pixel](https://evil.example/t.png) and [the fix](https://evil.example/fix) and [ref]: https://evil.example',
		'Ask @octocat or @org/admins, or mail ops@example.com, or see https://evil.example/x and www.evil.example.',
		'Use `ALTER TABLE t ADD c int` here.',
		'Heading',
		'===',
		'```sql',
		'SELECT 1; -- </details>',
		'```',
		'```',
		'never closed </details>',
	].join('\n');

	function prose(body: string): string {
		// From the first quoted line: the summary and the label above it are ours.
		const start = body.indexOf('\n>', body.indexOf('in prose'));
		const end = body.lastIndexOf('</details>');
		assert.ok(start > 0 && end > start);
		return body.slice(start, end);
	}

	/** The text outside code spans and fences, which is what markdown renders as markup. */
	function outsideCode(text: string): string {
		return text
			.replace(/^> ?(`{3,})[^\n]*\n[\s\S]*?^> ?\1\s*$/gm, '')
			.replace(/(`+)[\s\S]*?\1/g, '');
	}

	test('it cannot close the fold or write HTML', () => {
		const body = renderComment(report(), { commentary: { text: hostile, model: 'm' } });
		const section = prose(body);
		assert.ok(!/<(?!\/?b>)/.test(outsideCode(section)), section);
		// One fold opened for it and closed after it, and the footer is still outside every fold.
		const markup = outsideCode(body);
		const opens = (markup.match(/<details>/g) ?? []).length;
		const closes = (markup.match(/<\/details>/g) ?? []).length;
		assert.equal(opens, closes);
		assert.ok(markup.lastIndexOf('</details>') < markup.indexOf('<sub>'));
	});

	test('no image, link, mention or heading survives', () => {
		const text = outsideCode(prose(renderComment(report(), { commentary: { text: hostile, model: 'm' } })));
		assert.ok(!/!\[/.test(text), 'image');
		assert.ok(!/(?<!\\)\[[^\]]*(?<!\\)\]\s*[(:]/.test(text), 'link');
		assert.ok(!/https?:\/\/|www\./i.test(text), 'bare URL');
		assert.ok(!/(^|[^\w`])@\w/.test(text), 'mention');
		assert.ok(!/@example\.com/.test(text), 'email');
		assert.ok(!/^(?:> ?)? {0,3}#/m.test(text), 'heading');
		assert.ok(!/^(?:> ?)? {0,3}=+\s*$/m.test(text), 'setext heading');
	});

	test('the code it writes is still code, in a fence it cannot close', () => {
		const section = prose(renderComment(report(), { commentary: { text: hostile, model: 'm' } }));
		assert.match(section, /`ALTER TABLE t ADD c int`/);
		assert.match(section, /SELECT 1; -- <\/details>/);
		assert.match(section, /never closed <\/details>/);
	});

	test('it is labelled as the model\'s, in a section of its own', () => {
		const body = renderComment(report(), { commentary: { text: 'Plain words.', model: 'm' } });
		assert.match(body, /written by a model/i);
		assert.match(prose(body), /^> Plain words\.$/m);
	});
});

describe('tidyPunctuation', () => {
	// The prompt forbids dashes; this is what makes it TRUE. A prompt is a request, and the
	// smaller the model the more often it is ignored. What comes back is posted into somebody's
	// pull request under our name, so the house punctuation rule is enforced, not hoped for.
	test('a spaced dash becomes a comma', () => {
		assert.equal(
			tidyPunctuation('The unique index is the blocker — everything else can wait.'),
			'The unique index is the blocker, everything else can wait.',
		);
		assert.equal(tidyPunctuation('An en dash – like this – too.'), 'An en dash, like this, too.');
	});

	test('an unspaced dash becomes a comma with a space after it', () => {
		assert.equal(tidyPunctuation('Two things—both cheap.'), 'Two things, both cheap.');
	});

	test('a hyphen doing a dash job goes, and a real hyphen stays', () => {
		assert.equal(tidyPunctuation('Fix the index - it is cheap.'), 'Fix the index, it is cheap.');
		// Compound words and negative numbers are not punctuation.
		assert.equal(tidyPunctuation('A read-only, fine-grained token.'), 'A read-only, fine-grained token.');
		assert.equal(tidyPunctuation('Set it to -1 for no limit.'), 'Set it to -1 for no limit.');
	});

	test('a markdown bullet list survives, because a bullet is not a dash', () => {
		const list = 'Deal with them in this order:\n- the unique index\n- the NOT NULL\n';
		assert.equal(tidyPunctuation(list), list);
	});

	test('code is left exactly alone: a dash in there is code, and `--` is a SQL comment', () => {
		const text = 'Run this:\n```sql\nSELECT 1; -- the count\n```\nand `a — b` stays too.';
		assert.equal(tidyPunctuation(text), text);
	});

	test('it does not leave debris where a dash sat next to other punctuation', () => {
		assert.equal(tidyPunctuation('It fails, — and then stops.'), 'It fails, and then stops.');
		assert.equal(tidyPunctuation('Two rows —.'), 'Two rows.');
	});

	test('text with nothing to fix is returned unchanged', () => {
		const clean = 'The unique index is the blocker. Everything else can wait.';
		assert.equal(tidyPunctuation(clean), clean);
	});
});

describe('who the comment is from', () => {
	// A comment's byline belongs to whatever account posted it, and with a personal token that is
	// a person: neither host lets a token post under another name. So the comment says who wrote
	// it in its own text, at the top and at the bottom, and it reads as the reviewer's either way.
	test('the reviewer signs its own comment, heading and footer', () => {
		const body = renderComment({
			depth: 'static',
			findings: [finding()],
			files: ['db/m.sql'],
			statementCount: 1,
			gaps: [],
			checksPassed: 0,
		} as never, { branding: { displayName: 'Snoutbot', handle: 'snoutbot' } });
		assert.ok(body.startsWith('<!-- snout-review:v1 -->'));
		assert.ok(body.includes('### Snoutbot'));
		assert.match(body, /<sub>Snoutbot ·/);
	});

	test('and it is the CONFIGURED name, since a self-hosted install may have its own', () => {
		const body = renderComment({
			depth: 'static', findings: [finding()], files: ['a.sql'], statementCount: 1, gaps: [], checksPassed: 0,
		} as never, { branding: { displayName: 'Acme Reviewer', handle: 'acmebot' } });
		assert.match(body, /### Acme Reviewer/);
		assert.match(body, /<sub>Acme Reviewer ·/);
	});
});

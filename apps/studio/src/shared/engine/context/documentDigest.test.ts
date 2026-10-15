/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DOCUMENT_CHAR_BUDGET } from '../../ai';
import { buildAttachment, cleanText, inlineAttachments, renderAttachment, splitSections } from './documentDigest';

test('cleanText collapses noisy whitespace but keeps paragraphs', () => {
	const out = cleanText('a\r\n\r\n\r\n\r\nb   c\t\td   \n');
	assert.equal(out, 'a\n\nb c d');
});

test('cleanText turns form-feeds (PDF page breaks) into newlines', () => {
	assert.equal(cleanText('page1\fpage2'), 'page1\npage2');
});

test('cleanText expands ligatures and strips control/zero-width noise', () => {
	const cc = (n: number): string => String.fromCharCode(n);
	// A NUL mid-word (dropped ﬀ ligature), a real ﬃ ligature, a zero-width space, and a soft hyphen.
	const input = `E${cc(0)}ectiveness ${cc(0xfb03)}ne${cc(0x200b)} text${cc(0xad)} here`;
	assert.equal(cleanText(input), 'Eectiveness ffine text here');
});

test('splitSections splits markdown on headings', () => {
	const md = '# Title\n\nIntro para.\n\n## Section A\n\nBody A.\n\n## Section B\n\nBody B.';
	const sections = splitSections(md, true);
	assert.equal(sections.length, 3);
	assert.ok(sections[1].startsWith('## Section A'));
});

test('splitSections falls back to paragraphs for plain text', () => {
	const sections = splitSections('one para\n\ntwo para\n\nthree para');
	assert.deepEqual(sections, ['one para', 'two para', 'three para']);
});

test('splitSections even-chunks a single structureless blob', () => {
	const blob = 'x'.repeat(5000);
	const sections = splitSections(blob);
	assert.ok(sections.length > 1, 'a 5k blob should chunk into multiple sections');
});

test('buildAttachment reports zero originalChars for empty/whitespace input (drives rejection)', () => {
	assert.equal(buildAttachment({ name: 'blank.pdf', text: '   \n\n  ', sections: ['', '  '], unit: 'page' }).originalChars, 0);
	assert.equal(buildAttachment({ name: 'blank.txt', text: '' }).originalChars, 0);
});

test('buildAttachment accepts a genuinely tiny text document', () => {
	const att = buildAttachment({ name: 'note.txt', text: 'hi' });
	assert.equal(att.originalChars, 2);
	assert.equal(att.truncated, false);
});

test('buildAttachment sends a short document whole, untruncated', () => {
	const att = buildAttachment({ name: 'note.txt', text: 'A short note.\n\nSecond paragraph.' });
	assert.equal(att.truncated, false);
	assert.equal(att.coverage, undefined);
	assert.equal(att.text, 'A short note.\n\nSecond paragraph.');
	assert.equal(att.name, 'note.txt');
});

test('buildAttachment digests an over-budget document within the budget', () => {
	// 20 "pages", each well over the per-section share, so the whole far exceeds the budget.
	const pages = Array.from({ length: 20 }, (_unused, i) => `Page ${i + 1} title.\n\n${'lorem ipsum '.repeat(200)}`);
	const att = buildAttachment({ name: 'report.pdf', text: pages.join('\n\n'), sections: pages, unit: 'page' });
	assert.equal(att.truncated, true);
	assert.ok(att.text.length <= DOCUMENT_CHAR_BUDGET, `digest ${att.text.length} must be within budget`);
	assert.ok(att.originalChars > DOCUMENT_CHAR_BUDGET);
});

test('digest samples ACROSS the whole document, not just the front', () => {
	// Each page leads with a UNIQUE word (not a digit-only-differing line, which would look like a
	// running header and be stripped) followed by filler, so a page's lead carries its marker.
	const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet',
		'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango'];
	const pages = words.map((w) => `${w.toUpperCase()}MARK ${'filler text '.repeat(200)}`);
	const att = buildAttachment({ name: 'report.pdf', text: pages.join('\n\n'), sections: pages, unit: 'page' });
	// A late page's lead must appear — a head-truncation would never reach the last page.
	assert.match(att.text, /TANGOMARK/);
	assert.match(att.text, /ALPHAMARK/);
});

test('a single giant section is sampled across, not head-truncated', () => {
	// One "page" of ~17k chars with markers at the start and very end. A head-cut would only see
	// START; the sub-split sampler (with end-inclusive sampling) must reach END too, in several
	// excerpts spread across the page — not one contiguous head slice.
	const filler = 'lorem ipsum dolor sit amet. ';
	const text = `STARTMARK ${filler.repeat(300)} ${filler.repeat(300)} ENDMARK`;
	const att = buildAttachment({ name: 'one-page.pdf', text, sections: [text], unit: 'page' });
	assert.equal(att.truncated, true);
	assert.ok(att.text.length <= DOCUMENT_CHAR_BUDGET);
	assert.match(att.text, /STARTMARK/);
	assert.match(att.text, /ENDMARK/, 'the end of a long single page must be sampled (not head-truncated)');
	assert.match(att.coverage ?? '', /excerpts sampled across 1 page/);
	// Multiple spread excerpts, not one head slice.
	assert.ok((att.text.match(/\[page 1\]/g) ?? []).length >= 3, 'should emit several spread excerpts');
});

test('digest of a huge doc samples (caps) the number of sections and says so', () => {
	const pages = Array.from({ length: 210 }, (_unused, i) => `Page ${i + 1}.\n\n${'body '.repeat(80)}`);
	const att = buildAttachment({ name: 'big.pdf', text: pages.join('\n\n'), sections: pages, unit: 'page' });
	assert.equal(att.truncated, true);
	assert.match(att.coverage ?? '', /sampled \d+ of 210 pages/);
	assert.ok(att.text.length <= DOCUMENT_CHAR_BUDGET);
});

test('repeated page headers/footers are stripped from a paginated PDF digest', () => {
	// Every page carries the same running header + a "Page N" footer; the real content differs.
	const pages = Array.from({ length: 12 }, (_unused, i) =>
		`Proposta de Trabalho de Mestrado\nPage ${i + 1} of 12\n\nUnique content for page ${i + 1}: ${'detail '.repeat(120)}`);
	const att = buildAttachment({ name: 'thesis.pdf', text: pages.join('\n\n'), sections: pages, unit: 'page' });
	assert.equal(att.truncated, true);
	assert.doesNotMatch(att.text, /Proposta de Trabalho de Mestrado/, 'the running header must be stripped');
	assert.doesNotMatch(att.text, /Page \d+ of 12/, 'the running footer (page numbers) must be stripped');
	assert.match(att.text, /Unique content for page/, 'real page content must survive');
});

test('renderAttachment marks an excerpt as NOT the whole document', () => {
	const pages = Array.from({ length: 20 }, (_unused, i) => `Page ${i + 1}.\n\n${'word '.repeat(300)}`);
	const att = buildAttachment({ name: 'r.pdf', text: pages.join('\n\n'), sections: pages, unit: 'page' });
	const block = renderAttachment(att);
	assert.match(block, /EXCERPT/);
	assert.match(block, /NOT the whole document/);
	assert.match(block, /r\.pdf/);
});

test('renderAttachment labels a complete short document', () => {
	const block = renderAttachment(buildAttachment({ name: 'n.txt', text: 'hello world' }));
	assert.match(block, /complete/);
	assert.doesNotMatch(block, /EXCERPT/);
});

test('inlineAttachments folds documents into the user content as reference context', () => {
	const att = buildAttachment({ name: 'n.txt', text: 'the body text' });
	const out = inlineAttachments('summarize this', [att]);
	assert.match(out, /^summarize this/);
	assert.match(out, /reference context/);
	assert.match(out, /the body text/);
	// Must steer the model to chart/aggregate from the document, not the grid/DB.
	assert.match(out, /do not call get_query_result or run_query/i);
});

test('inlineAttachments is a no-op with no attachments', () => {
	assert.equal(inlineAttachments('hi', undefined), 'hi');
	assert.equal(inlineAttachments('hi', []), 'hi');
});

test('inlineAttachments caps the number of documents folded in', () => {
	const atts = Array.from({ length: 7 }, (_unused, i) => buildAttachment({ name: `doc${i}.txt`, text: `body ${i}` }));
	const out = inlineAttachments('q', atts);
	assert.match(out, /doc0\.txt/);
	assert.doesNotMatch(out, /doc4\.txt/, 'only the first 4 documents should be folded in');
});

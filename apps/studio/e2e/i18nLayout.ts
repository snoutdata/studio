/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

// Whether a screen still fits in the longer languages. A spec walks its screens in English and, at
// each one, switches the language live (nothing remounts, so the same screen stays open), screenshots
// it and lists the text that leaves its box.

export interface LayoutProblem {
	kind: 'leak' | 'cut' | 'ellipsis' | 'page';
	path: string;
	text: string;
	px: number;
}

/** Text outside the box around it, read from the rendered rectangles. */
async function problems(page: Page): Promise<LayoutProblem[]> {
	return page.evaluate(() => {
		const found: { kind: 'leak' | 'cut' | 'ellipsis' | 'page'; path: string; text: string; px: number }[] = [];
		const skip = '.monaco-editor, .xterm, script, style, canvas, pre, code, [data-layout-ignore]';
		const pathOf = (el: Element): string => {
			const parts: string[] = [];
			for (let at: Element | null = el, i = 0; at && at !== document.body && i < 4; at = at.parentElement, i += 1) {
				const name = typeof at.className === 'string' && at.className.trim() ? `.${at.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
				parts.unshift(`${at.tagName.toLowerCase()}${name}`);
			}
			return parts.join(' > ');
		};
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) {
			const node = walker.currentNode;
			const text = (node.textContent ?? '').trim();
			const el = node.parentElement;
			if (!el || !/\p{L}{2,}/u.test(text) || el.closest(skip)) {
				continue;
			}
			const style = getComputedStyle(el);
			if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
				continue;
			}
			const range = document.createRange();
			range.selectNodeContents(node);
			const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
			if (rects.length === 0) {
				continue;
			}
			if (style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) {
				found.push({ kind: 'ellipsis', path: pathOf(el), text: text.slice(0, 80), px: el.scrollWidth - el.clientWidth });
				continue;
			}
			for (let box: Element | null = el; box && box !== document.body; box = box.parentElement) {
				const boxStyle = getComputedStyle(box);
				const clips = boxStyle.overflowX === 'hidden' || boxStyle.overflowX === 'clip';
				if (boxStyle.overflowX === 'auto' || boxStyle.overflowX === 'scroll') {
					break;
				}
				const paints = boxStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(boxStyle.borderLeftWidth) > 0 || parseFloat(boxStyle.borderRightWidth) > 0;
				if (!paints && !clips) {
					continue;
				}
				const bounds = box.getBoundingClientRect();
				const px = Math.max(...rects.map((rect) => Math.max(rect.right - bounds.right, bounds.left - rect.left, rect.bottom - bounds.bottom)));
				if (px > 1) {
					found.push({ kind: clips ? 'cut' : 'leak', path: pathOf(el), text: text.slice(0, 80), px: Math.round(px) });
				}
				break;
			}
		}
		const sideways = document.documentElement.scrollWidth - document.documentElement.clientWidth;
		if (sideways > 1) {
			found.push({ kind: 'page', path: 'html', text: 'the page scrolls sideways', px: sideways });
		}
		return found;
	});
}

async function setLanguage(page: Page, language: string): Promise<void> {
	await page.evaluate((next) => (window as unknown as { __snoutDebugSetLanguage(next: string): void }).__snoutDebugSetLanguage(next), language);
	await page.waitForFunction((next) => document.documentElement.lang === next, language, { timeout: 10_000 });
	// One frame for React, one for layout, and a little for what fades.
	await page.waitForTimeout(350);
}

/**
 * Screenshots the open screen in each language and records what English did not already have wrong.
 * Leaves the app in English, because the spec's next step reads English.
 */
export async function checkLanguages(page: Page, name: string, languages: readonly string[], dir: string): Promise<void> {
	mkdirSync(dir, { recursive: true });
	const report = join(dir, 'report.txt');
	const known = (entry: LayoutProblem): string => `${entry.kind}|${entry.path}`;
	const english = new Set((await problems(page)).map(known));
	for (const language of languages) {
		await setLanguage(page, language);
		await page.screenshot({ path: join(dir, `${name}.${language}.png`) });
		for (const entry of await problems(page)) {
			if (!english.has(known(entry))) {
				appendFileSync(report, `${name}\t${language}\t${entry.kind}\t${entry.px}px\t${entry.path}\t${entry.text}\n`);
			}
		}
	}
	await setLanguage(page, 'en');
}

/** The languages a run should look at, or none. */
export function layoutLanguages(): string[] {
	return (process.env.SNOUTDATA_SHOTS_LANGUAGES ?? '').split(',').filter((language) => language.length > 0);
}

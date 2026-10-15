/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What rendered markdown may load and where its links may go. Pure, so it is tested under Node.
//
// The Markdown component renders text a model or a coding agent wrote, which an attacker can steer
// with a poisoned row, document or column comment. Two rules follow:
//
// - nothing remote is fetched while the text renders: an image, video or any other resource whose
//   URL is not inline (data:/blob:) is not loaded, and is shown as a link the person can choose
//   to open in their browser instead; and
// - a link never navigates the app's window: http(s) and mailto open in the system browser, and
//   anything else does nothing.

/** True when `url` is inline content the page can show without a request: a data: image, or a blob:. */
export function isInlineResourceUrl(url: string | null | undefined): boolean {
	if (!url) {
		return false;
	}
	const trimmed = url.trim().toLowerCase();
	return trimmed.startsWith('data:image/') || trimmed.startsWith('blob:');
}

/** The absolute URL a clicked link should open in the system browser, or undefined when it should do nothing. */
export function externalLinkTarget(href: string | null | undefined): string | undefined {
	if (!href) {
		return undefined;
	}
	let parsed: URL;
	try {
		parsed = new URL(href.trim());
	} catch {
		// Relative (or garbage): it would only navigate the app's own window, so it goes nowhere.
		return undefined;
	}
	if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
		return parsed.href;
	}
	return undefined;
}

/** The words shown in place of a remote image that was not loaded. */
export function blockedImageLabel(url: string, alt: string | null | undefined): string {
	let where = '';
	try {
		where = new URL(url).host;
	} catch {
		where = '';
	}
	const name = alt?.trim() ? `"${alt.trim()}"` : 'Image';
	return where ? `${name} not loaded, from ${where}` : `${name} not loaded`;
}

/** Attributes that make an element fetch a URL as it renders. */
export const RESOURCE_ATTRIBUTES = ['src', 'srcset', 'poster', 'background', 'data', 'lowsrc', 'dynsrc', 'xlink:href'];

/**
 * True when an attribute's value names a URL outside the page with CSS's `url(...)`: SVG takes one
 * in `fill`, `stroke`, `filter`, `mask`, `clip-path`, `marker-*`, `cursor` and more, and the
 * renderer fetches it as it paints. Only `url(#id)`, a reference to something on the page itself,
 * is not. CSS comments and escapes are undone first, so `url/**\/(` and `u\72l(` are seen.
 */
export function referencesRemoteUrl(value: string): boolean {
	const plain = value
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\\([0-9a-f]{1,6})\s?/gi, (_escape, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
		.replace(/\\([\s\S])/g, '$1');
	for (const match of plain.matchAll(/url\s*\(\s*['"]?\s*([^'")\s]*)/gi)) {
		if (!match[1].startsWith('#')) {
			return true;
		}
	}
	return false;
}

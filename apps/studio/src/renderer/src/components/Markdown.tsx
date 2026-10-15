/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { blockedImageLabel, externalLinkTarget, isInlineResourceUrl, referencesRemoteUrl, RESOURCE_ATTRIBUTES } from '../markdownSafety';

interface MarkdownProps {
	source: string;
	className?: string;
}

// Renders model replies, coding-agent output (show_in_app) and Snoutbot review comments. All of
// it is attacker-influenced: a row, a document or a column comment the model read can steer what
// it writes. marked turns it into HTML, DOMPurify strips script and handlers, and then
// `withoutRemoteResources` makes sure nothing in it is fetched as it paints (an image URL could
// carry query results to another host with no click). Links are handed to the system browser on
// click and never navigate this window.
export function Markdown({ source, className }: MarkdownProps): JSX.Element {
	const html = useMemo(() => {
		const raw = marked.parse(source, { async: false, gfm: true, breaks: true }) as string;
		return withoutRemoteResources(DOMPurify.sanitize(raw, { FORBID_TAGS: ['style'], FORBID_ATTR: ['style'] }));
	}, [source]);
	return (
		<div
			className={`markdown${className ? ` ${className}` : ''}`}
			onClick={openLinkExternally}
			onAuxClick={(e) => {
				// A middle click would open the link as a new window; a right click is left alone.
				if (e.button === 1) {
					openLinkExternally(e);
				}
			}}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

/**
 * `html` (already sanitised) with every remote resource removed. It is parsed into a <template>,
 * whose content is inert, so nothing is fetched while it is examined. A remote image becomes a
 * link with its alt text and host, which the person can open in their browser if they want it.
 */
function withoutRemoteResources(html: string): string {
	const template = document.createElement('template');
	template.innerHTML = html;
	for (const element of Array.from(template.content.querySelectorAll('*'))) {
		const tag = element.tagName.toLowerCase();
		if (tag === 'img' || tag === 'video' || tag === 'audio' || tag === 'picture') {
			const src = element.getAttribute('src') ?? element.querySelector('source')?.getAttribute('src') ?? '';
			if (!isInlineResourceUrl(src) || element.hasAttribute('srcset') || element.querySelector('source')) {
				const link = template.ownerDocument.createElement('a');
				const target = externalLinkTarget(src);
				if (target) {
					link.setAttribute('href', target);
				}
				link.className = 'markdown-blocked-image';
				link.textContent = blockedImageLabel(src, element.getAttribute('alt'));
				element.replaceWith(link);
				continue;
			}
		}
		for (const name of RESOURCE_ATTRIBUTES) {
			const value = element.getAttribute(name);
			if (value !== null && !isInlineResourceUrl(value)) {
				element.removeAttribute(name);
			}
		}
		// SVG paints, filters, masks, clip paths and markers fetch a `url(...)` from any attribute.
		for (const attribute of Array.from(element.attributes)) {
			if (referencesRemoteUrl(attribute.value)) {
				element.removeAttribute(attribute.name);
			}
		}
		// Only a link may carry a URL to go to; an SVG <image href> or <use href> would fetch it.
		if (tag !== 'a' && element.hasAttribute('href')) {
			element.removeAttribute('href');
		}
		if (tag === 'a') {
			element.setAttribute('rel', 'noreferrer noopener');
		}
	}
	return template.innerHTML;
}

/** A click on a link inside the rendered text: http(s) and mailto open in the system browser,
 *  anything else (a relative path, an in-page anchor) does nothing rather than navigate the app. */
function openLinkExternally(e: React.MouseEvent<HTMLDivElement>): void {
	const anchor = (e.target as HTMLElement).closest('a');
	if (!anchor) {
		return;
	}
	e.preventDefault();
	const target = externalLinkTarget(anchor.getAttribute('href'));
	if (target) {
		void window.sqlApi.openExternal(target);
	}
}

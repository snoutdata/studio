/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { releaseNotes } from '../releaseNotes';
import logoMark from '../assets/logo-mark.png';

interface ReleaseNotesViewProps {
	/** The running app version, shown in the title (the embedded notes describe this build). */
	version: string;
	/** The "Show release notes after an update" preference (mirrors the Settings toggle). */
	showAfterUpdate: boolean;
	onToggleShowAfterUpdate(value: boolean): void;
	/** Open an http(s) link from the notes in the user's browser. */
	onOpenLink(url: string): void;
}

interface TocEntry {
	depth: number;
	text: string;
	slug: string;
}

/** Strip HTML tags from a heading's inner markup to get its plain text (for the slug + TOC). */
function plainText(html: string): string {
	return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

function slugify(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Render the markdown to sanitized HTML, inject stable ids onto the `##`/`###` headings, and
 *  collect those headings as the "IN THIS UPDATE" table of contents (VSCode parity). */
function render(body: string): { html: string; toc: TocEntry[] } {
	const raw = marked.parse(body, { async: false, gfm: true, breaks: false }) as string;
	const toc: TocEntry[] = [];
	const used = new Map<string, number>();
	const withIds = raw.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/g, (whole, depthStr: string, attrs: string, inner: string) => {
		const text = plainText(inner);
		let slug = slugify(text) || 'section';
		const seen = used.get(slug) ?? 0;
		used.set(slug, seen + 1);
		if (seen > 0) {
			slug = `${slug}-${seen}`;
		}
		toc.push({ depth: parseInt(depthStr, 10), text, slug });
		// Don't double-add an id if the markdown already carried one.
		const attrsWithId = /\bid=/.test(attrs) ? attrs : `${attrs} id="${slug}"`;
		return `<h${depthStr}${attrsWithId}>${inner}</h${depthStr}>`;
	});
	// Allow inline media so release notes can ship images/videos (DOMPurify already keeps <img>).
	const html = DOMPurify.sanitize(withIds, {
		ADD_TAGS: ['video', 'source'],
		ADD_ATTR: ['controls', 'muted', 'loop', 'autoplay', 'playsinline', 'poster'],
	});
	return { html, toc };
}

/** The VSCode-style "Release Notes" document, shown in its own editor tab. A sticky "IN THIS
 *  UPDATE" table of contents on the left, the rendered per-version markdown on the right, and the
 *  "Show release notes after an update" toggle up top. */
export function ReleaseNotesView({ version, showAfterUpdate, onToggleShowAfterUpdate, onOpenLink }: ReleaseNotesViewProps): JSX.Element {
	const note = releaseNotes();
	const bodyRef = useRef<HTMLDivElement>(null);
	const { html, toc } = useMemo(() => render(note.body), [note.body]);

	if (!note.body) {
		return (
			<div className="release-notes">
				<div className="release-notes-empty">No release notes are available for this version.</div>
			</div>
		);
	}

	function scrollTo(slug: string): void {
		const target = bodyRef.current?.querySelector(`#${CSS.escape(slug)}`);
		target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	// Open http(s) links from the notes in the browser instead of navigating the renderer.
	function onClickBody(e: React.MouseEvent<HTMLDivElement>): void {
		const anchor = (e.target as HTMLElement).closest('a');
		const href = anchor?.getAttribute('href');
		if (href && /^https?:/i.test(href)) {
			e.preventDefault();
			onOpenLink(href);
		}
	}

	return (
		<div className="release-notes">
			<div className="release-notes-scroll">
				<div className="release-notes-head">
					<div className="release-notes-titlebar">
						<img src={logoMark} className="release-notes-logo" alt="" />
						<h1 className="release-notes-title">SnoutData Studio {version}</h1>
					</div>
					<label className="release-notes-toggle">
						<input
							type="checkbox"
							checked={showAfterUpdate}
							onChange={(e) => onToggleShowAfterUpdate(e.target.checked)}
						/>
						Show release notes after an update
					</label>
					{note.date && <div className="release-notes-date">Release date: {note.date}</div>}
				</div>
				<div className="release-notes-cols">
					{toc.length > 0 && (
						<nav className="release-notes-toc" aria-label="What's new">
							<div className="release-notes-toc-head">WHAT'S NEW</div>
							{toc.map((t) => (
								<button
									key={t.slug}
									type="button"
									className={`release-notes-toc-link depth-${t.depth}`}
									onClick={() => scrollTo(t.slug)}
								>
									{t.text}
								</button>
							))}
						</nav>
					)}
					<div
						ref={bodyRef}
						className="release-notes-body markdown"
						onClick={onClickBody}
						dangerouslySetInnerHTML={{ __html: html }}
					/>
				</div>
			</div>
		</div>
	);
}

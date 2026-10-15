/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The release notes for THIS build (the VSCode-style "Release Notes" surface). Only the current
// version's notes are embedded; the doc is titled by the running app version at display time. The
// text comes through the private half (`@snout/studio-pro/renderer`, `RELEASE_NOTES`) because it
// describes the official build; a build without it has none, and the tab and its command never
// appear. Rich media: a video under `src/renderer/public/release-notes/`, referenced by relative
// path, is copied into the renderer output, and that folder is published with the source, so put
// nothing there that shows a private feature or a real account. An IMAGE cannot be a file there:
// the renderer's CSP allows no file: images (src/shared/rendererCsp.ts), so write it as a data: URL.

import { RELEASE_NOTES as raw } from '@snout/studio-pro/renderer';

export interface ReleaseNotes {
	/** Optional human release date, from the file's `date:` frontmatter line. */
	date?: string;
	/** The markdown body, with any frontmatter stripped. */
	body: string;
}

/** Pull a `date:` line out of a leading `--- … ---` frontmatter block; return the date + the body
 *  with the block removed. No frontmatter ⇒ undefined date and the source unchanged. */
function parse(src: string): ReleaseNotes {
	const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) {
		return { body: src.trim() };
	}
	const date = match[1].match(/^\s*date:\s*(.+?)\s*$/m)?.[1];
	return { date, body: src.slice(match[0].length).trim() };
}

const NOTES = parse(raw);

/** This build's release notes (date + markdown body). */
export function releaseNotes(): ReleaseNotes {
	return NOTES;
}

/** True when this build actually ships notes (an empty one, as in a build without the private half, ⇒ nothing to show). */
export function hasReleaseNotes(): boolean {
	return NOTES.body.length > 0;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The marks of the coding agents we host.
 *
 * These are third-party trademarks, used the way an IDE uses them: to identify the user's OWN
 * installed tool, on the button that opens it. They are unmodified in shape and drawn in the
 * current text colour like every other glyph in the strip, so the strip stays one visual system
 * and no mark is recoloured into something its owner did not draw. Nothing here implies that
 * Anthropic, OpenAI or the opencode project endorse or are affiliated with SnoutData.
 *
 * Each is a 24x24 `currentColor` path. Replace one here if a brand refreshes its mark; nothing
 * else needs to change.
 *
 * The eye holes in the Claude Code mark are wound the opposite way to its body ON PURPOSE: the
 * svg fills with the default nonzero rule, which is what the other paths here rely on, and
 * reverse winding is what knocks a hole out under it. Redrawing one of those subpaths in the same
 * direction as the body fills the eyes in.
 *
 * They are drawn by {@link PathMark}, which is also what our own {@link Glyph} shapes use.
 *
 * The `openai` and `opencode` paths are taken unmodified from LobeHub's lobe-icons
 * (https://github.com/lobehub/lobe-icons), under its MIT licence, whose notice follows. The
 * `claude-code` path is our own drawing. The licence covers the drawings, not the marks: those stay
 * their owners' trademarks (TRADEMARKS.md).
 *
 *   MIT License
 *
 *   Copyright (c) 2023 LobeHub
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 *   and associated documentation files (the "Software"), to deal in the Software without
 *   restriction, including without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 *   BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import { PathMark } from './PathMark';

const MARKS: Record<string, string> = {
	// Claude Code's own mark, not Anthropic's sunburst: a 16x10 pixel glyph (body, two eyes, the
	// arm bar, four legs), traced to its grid and laid out on a 3.5px cell scaled to 1.5 units, so
	// every edge lands on a whole coordinate and the blocks stay square at any size.
	'claude-code': "M3 4.5h18v12H3ZM6 7.5v3h1.5v-3ZM16.5 7.5v3H18v-3ZM0 10.5h24v3H0ZM4.5 16.5h1.5v3H4.5ZM7.5 16.5h1.5v3H7.5ZM15 16.5h1.5v3H15ZM18 16.5h1.5v3H18Z",
	openai: "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z",
	opencode: "M16 6H8v12h8V6zm4 16H4V2h16v20z",
};


/** Is this icon name a brand mark rather than a Codicon? */
export function isBrandMark(name: string): boolean {
	return name.startsWith('brand:') && MARKS[name.slice('brand:'.length)] !== undefined;
}

interface BrandMarkProps {
	/** `brand:<id>`, matching a key of {@link MARKS}. */
	name: string;
	className?: string;
}

export function BrandMark({ name, className }: BrandMarkProps): JSX.Element {
	return <PathMark path={MARKS[name.slice('brand:'.length)]} className={className} />;
}

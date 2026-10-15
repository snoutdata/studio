/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Glyphs we drew ourselves, for the places where the Codicon set has nothing that says the thing.
 *
 * The bar for adding one is high: a Codicon is preferred every time, because the whole strip is
 * one visual system and a bespoke glyph is the one shape in it nobody else has already made read
 * well at 16px. Add one only when the nearest Codicon is actively misleading about what the view
 * is (`brand:` in {@link BrandMark} is the separate case: somebody else's trademark).
 *
 * Each is a 24x24 `currentColor` path with the nonzero fill rule, so a hole is a subpath wound the
 * opposite way to the body it sits in. They render through {@link PathMark}, which is also what
 * the brand marks use.
 */

import { PathMark } from './PathMark';

const GLYPHS: Record<string, string> = {
	// The Dashboard panel (local and cloud projects, each opening the online dashboard's sections).
	// Four tiles of uneven height, the mark a dashboard has everywhere else. The Codicon called
	// `dashboard` is a SPEEDOMETER, which this app already uses for speed (Query Performance,
	// Explain, a move's transfer rate), so on this panel it read as a network speed test. Outlined at
	// the Codicons' line weight (1.5 of 24) so it sits in the activity bar as one of them.
	dashboard: "M3 3H11V13H3ZM4.5 4.5V11.5H9.5V4.5ZM3 15H11V21H3ZM4.5 16.5V19.5H9.5V16.5ZM13 3H21V9H13ZM14.5 4.5V7.5H19.5V4.5ZM13 11H21V21H13ZM14.5 12.5V19.5H19.5V12.5Z",
	// SnoutData's own butterfly (assets/logo-mark.png), marking a connection that is a SnoutData
	// Cloud database. The logo is a line drawing with circuit traces, which turned to a smudge at
	// 14px as lines; a filled silhouette of the same four wings, body and antennae is what survives
	// the size a tree row draws it at.
	butterfly: "M10.6 10.4C9 5.2 4.2 2.6 2.3 4.6C0.6 6.5 2.2 10.9 6.4 11.8C8 12.1 9.6 11.9 10.6 11.5ZM 13.4 10.4 C 15 5.2 19.8 2.6 21.7 4.6 C 23.4 6.5 21.8 10.9 17.6 11.8 C 16 12.1 14.4 11.9 13.4 11.5 ZM10.6 12.9C8.2 12.6 4.8 13.6 4.7 16.6C4.6 19.5 7.9 20.1 10.6 16ZM 13.4 12.9 C 15.8 12.6 19.2 13.6 19.3 16.6 C 19.4 19.5 16.1 20.1 13.4 16 ZM12 7.6C12.5 7.6 12.7 8.6 12.7 11.6C12.7 16.6 12.5 19 12 19C11.5 19 11.3 16.6 11.3 11.6C11.3 8.6 11.5 7.6 12 7.6ZM11.6 8.2L9.6 4.2L10.2 3.9L12 7.8ZM12.4 8.2L14.4 4.2L13.8 3.9L12 7.8Z",
	// Snout Orbit: a barred spiral seen face on, two arms sweeping out of a ringed core.
	// Codicons had nothing for it: `graph-scatter` is a scatter PLOT and read as one more analysis
	// view, `globe` reads as the internet, `circuit-board` is the agent tooling, and `compass`
	// (what this replaced) says "navigation" without saying what you are navigating. Traced from a
	// reference drawing at 128px and simplified, so the arm tips stay pointed rather than rounding
	// off into commas at small sizes.
	galaxy: "M22.45,19.45Q23.25,18.09 23.62,16.68Q24,15.28 23.81,13.12Q23.62,10.97 22.87,9.33Q22.12,7.69 21.05,6.5Q19.97,5.3 18.56,4.53Q17.16,3.75 15.26,3.54Q13.36,3.33 10.5,4.08L10.5,4.08L11.48,3.45Q12.47,2.81 13.62,2.53Q14.77,2.25 16.2,2.34Q17.62,2.44 18.94,2.96Q20.25,3.47 20.6,3.17Q20.95,2.86 20.74,2.46Q20.53,2.06 19.38,1.43Q18.23,0.8 16.73,0.4Q15.23,0 13,0.21Q10.78,0.42 9.09,1.24Q7.41,2.06 6.14,3.33Q4.88,4.59 4.25,5.95Q3.61,7.31 3.5,9.25Q3.38,11.2 4.08,13.55L4.08,13.55L3.45,12.54Q2.81,11.53 2.53,10.38Q2.25,9.23 2.34,7.8Q2.44,6.38 2.96,5.06Q3.47,3.75 3.17,3.4Q2.86,3.05 2.46,3.26Q2.06,3.47 1.41,4.69Q0.75,5.91 0.38,7.32Q0,8.72 0.19,10.88Q0.38,13.03 1.22,14.81Q2.06,16.59 3.33,17.86Q4.59,19.12 5.95,19.76Q7.31,20.39 8.95,20.53Q10.59,20.67 13.5,19.92L13.5,19.92L12.52,20.55Q11.53,21.19 10.38,21.47Q9.23,21.75 7.8,21.66Q6.38,21.56 5.04,21.05Q3.7,20.53 3.38,20.84Q3.05,21.14 3.26,21.54Q3.47,21.94 4.62,22.57Q5.77,23.2 7.27,23.6Q8.77,24 10.9,23.81Q13.03,23.62 14.67,22.87Q16.31,22.12 17.5,21.05Q18.7,19.97 19.48,18.56Q20.25,17.16 20.46,15.3Q20.67,13.45 19.92,10.45L19.92,10.45L20.46,11.25Q21,12.05 21.35,13.25Q21.7,14.44 21.63,16.03Q21.56,17.62 21.05,18.91Q20.53,20.2 20.67,20.5Q20.81,20.81 21.23,20.81Q21.66,20.81 22.45,19.45ZM14.41,14.79Q13.97,15.19 13.27,15.45Q12.56,15.7 11.7,15.63Q10.83,15.56 10.27,15.25Q9.7,14.95 9.25,14.46Q8.81,13.97 8.55,13.27Q8.3,12.56 8.37,11.7Q8.44,10.83 8.75,10.27Q9.05,9.7 9.54,9.25Q10.03,8.81 10.73,8.55Q11.44,8.3 12.3,8.37Q13.17,8.44 13.73,8.75Q14.3,9.05 14.75,9.54Q15.19,10.03 15.45,10.73Q15.7,11.44 15.63,12.3Q15.56,13.17 15.21,13.78Q14.86,14.39 14.41,14.79ZM13.88,13.03Q14.3,12.23 14.07,11.39Q13.83,10.55 13.03,10.12Q12.23,9.7 11.39,9.93Q10.55,10.17 10.12,10.97Q9.7,11.77 9.93,12.61Q10.17,13.45 10.97,13.88Q11.77,14.3 12.61,14.07Q13.45,13.83 13.88,13.03Z",
};

/** Is this icon name one of our own glyphs rather than a Codicon? */
export function isGlyph(name: string): boolean {
	return name.startsWith('glyph:') && GLYPHS[name.slice('glyph:'.length)] !== undefined;
}

interface GlyphProps {
	/** `glyph:<id>`, matching a key of {@link GLYPHS}. */
	name: string;
	className?: string;
}

export function Glyph({ name, className }: GlyphProps): JSX.Element {
	return <PathMark path={GLYPHS[name.slice('glyph:'.length)]} className={className} />;
}

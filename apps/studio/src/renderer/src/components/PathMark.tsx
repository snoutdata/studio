/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The one inline-SVG glyph, shared by {@link BrandMark} (somebody else's trademark) and
 * {@link Glyph} (a shape we drew). Nothing else should draw a 24x24 path by hand.
 *
 * It renders with the `codicon` class ON PURPOSE. Every size rule in the app is written against
 * that class (the activity bar puts icons at 22px, a pane header at 16px, and so on), so an
 * inline mark lands at exactly the size a Codicon would have landed at in the same place, with no
 * second set of rules to keep in step. `.brand-mark` then trims it slightly, because a Codicon
 * carries its own padding inside the box and a traced mark does not.
 */

interface PathMarkProps {
	/** A 24x24 path, filled with the nonzero rule (a hole is a subpath wound the other way). */
	path: string;
	className?: string;
}

export function PathMark({ path, className }: PathMarkProps): JSX.Element {
	return (
		<svg
			className={`codicon brand-mark${className ? ` ${className}` : ''}`}
			viewBox="0 0 24 24"
			width="1em"
			height="1em"
			fill="currentColor"
			aria-hidden="true"
			focusable="false"
		>
			<path d={path} />
		</svg>
	);
}

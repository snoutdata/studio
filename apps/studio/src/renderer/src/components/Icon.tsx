/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrandMark, isBrandMark } from './BrandMark';
import { Glyph, isGlyph } from './Glyph';

interface IconProps {
	/**
	 * Codicon name without the `codicon-` prefix, e.g. "gear", "chevron-right" — or an inline mark,
	 * `brand:<id>` for a third-party one (see {@link BrandMark}) and `glyph:<id>` for one we drew
	 * (see {@link Glyph}). Either renders as an SVG at the size and colour a Codicon would have
	 * taken in the same place.
	 */
	name: string;
	className?: string;
}

/** A single glyph. Inherits color and (via CSS) size from its context. */
export function Icon({ name, className }: IconProps): JSX.Element {
	if (isBrandMark(name)) {
		return <BrandMark name={name} className={className} />;
	}
	if (isGlyph(name)) {
		return <Glyph name={name} className={className} />;
	}
	return <span className={`codicon codicon-${name}${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}

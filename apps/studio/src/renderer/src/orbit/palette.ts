/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Orbit's colours.
 *
 * The design system's rule applies here even though the surface is WebGL
 * rather than CSS: nothing hardcodes a colour. Orbit's default palette is DERIVED from the theme
 * tokens on `:root`, so Orbit under Gold is gold, Orbit under Tron-ish Dark is cool, and Orbit
 * under Light is legible instead of a black hole in a white window.
 *
 * The three named presets are a deliberate OVERRIDE, offered in the rail because the look is half
 * the point of the feature and a user should be allowed to pick one. They are the only place in
 * this file with literal colours, and they are art direction, not theme.
 *
 * Pure: this returns CSS colour STRINGS and knows nothing about three.js. The scene converts them
 * with `THREE.Color.setStyle`, which is what keeps this file node-testable.
 */

export type PaletteId = 'theme' | 'gold' | 'tron' | 'ember';

export interface OrbitPalette {
	/** The void the graph sits in. */
	bg: string;
	/** Node colours by kind. */
	table: string;
	view: string;
	index: string;
	routine: string;
	/** Relations at rest, and at full traffic. */
	link: string;
	linkHot: string;
	/** The far starfield, and an in-flight statement. */
	star: string;
	packet: string;
	/** INK, not light: the ground is light, so the world is drawn as dark ink on paper (normal
	 *  blending, no bloom) instead of light glowing in a void. Additive light on a near-white ground
	 *  adds nearly nothing, which is how Orbit under the Light theme drew a blank canvas. */
	ink: boolean;
}

/** Just enough of `CSSStyleDeclaration` to read a custom property, so a test can hand in a fake. */
export interface TokenSource {
	getPropertyValue(property: string): string;
}

const FALLBACK: OrbitPalette = {
	bg: '#04050a',
	table: '#f0b940', view: '#4ec9b0', index: '#74829c', routine: '#e0863a',
	link: '#1a2131', linkHot: '#ffe9b0',
	star: '#2a2e3c', packet: '#fff2cf',
	ink: false,
};

/** Relative luminance (0 black, 1 white) of a `#rgb` / `#rrggbb` / `rgb()` colour, or null for
 *  anything else (a `color-mix()` the browser did not resolve): the caller then assumes dark. */
export function luminance(colour: string): number | null {
	const c = colour.trim().toLowerCase();
	let rgb: number[] | null = null;
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
	if (hex) {
		const h = hex[1].length === 3 ? hex[1].split('').map((d) => d + d).join('') : hex[1];
		rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
	} else {
		const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
		if (fn) {
			rgb = [fn[1], fn[2], fn[3]].map(Number);
		}
	}
	if (!rgb) {
		return null;
	}
	const [r, g, b] = rgb.map((v) => {
		const x = v / 255;
		return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function token(source: TokenSource, name: string, fallback: string): string {
	const value = source.getPropertyValue(name).trim();
	return value === '' ? fallback : value;
}

/**
 * The palette the current theme implies. Every colour is an existing token, so adding a theme to
 * `theme.ts` gives Orbit a look for free and adding a colour here is not something a theme author
 * has to think about.
 */
export function themePalette(source: TokenSource): OrbitPalette {
	const bg = token(source, '--bg-app', FALLBACK.bg);
	const ink = (luminance(bg) ?? 0) > 0.5;
	return {
		bg,
		// On paper the kinds take the theme's HUES: a light theme's accent is its ink (near-black in
		// Light), and a world drawn all in it was one grey mass. Tables are the green, the one hue
		// of the app's flat art; views the ochre, routines the clay red, indexes the dim ink.
		table: token(source, ink ? '--ok' : '--accent', FALLBACK.table),
		view: token(source, ink ? '--warn' : '--ok', FALLBACK.view),
		index: token(source, '--fg-dim', FALLBACK.index),
		routine: token(source, ink ? '--error' : '--warn', FALLBACK.routine),
		// On a dark ground a relation is a faint line in the border colour; on a light one the border
		// colour IS nearly the ground, so the filaments are drawn in the dim ink instead.
		link: token(source, ink ? '--fg-dim' : '--border', FALLBACK.link),
		linkHot: token(source, '--fg', FALLBACK.linkHot),
		star: token(source, ink ? '--fg-dim' : '--border', FALLBACK.star),
		packet: token(source, ink ? '--accent' : '--fg', FALLBACK.packet),
		ink,
	};
}

/** The art-directed overrides. Gold Void is what the prototype shipped as. */
export const PRESETS: Record<Exclude<PaletteId, 'theme'>, OrbitPalette> = {
	gold: {
		bg: '#04050a',
		table: '#ffc247', view: '#e0863a', index: '#6f93c4', routine: '#b87ad6',
		link: '#6d5327', linkHot: '#ffe6b0',
		star: '#2a2e3c', packet: '#fff2cf',
		ink: false,
	},
	tron: {
		bg: '#03060b',
		table: '#45e8ff', view: '#9df3ff', index: '#ff8a3d', routine: '#ffd166',
		link: '#14556b', linkHot: '#d8fbff',
		star: '#1d2c38', packet: '#ffffff',
		ink: false,
	},
	ember: {
		bg: '#07040a',
		table: '#ff7a4d', view: '#ffb35c', index: '#9a6ad6', routine: '#ffe08a',
		link: '#6b2d24', linkHot: '#ffd0bb',
		star: '#30222b', packet: '#fff0e6',
		ink: false,
	},
};

/** The palette to render with: the theme's own, or the preset the user picked in the rail. */
export function resolvePalette(id: PaletteId, source: TokenSource): OrbitPalette {
	return id === 'theme' ? themePalette(source) : PRESETS[id];
}

export const PALETTE_LABELS: Record<PaletteId, string> = {
	theme: "Theme",
	gold: "Gold",
	tron: "Tron",
	ember: "Ember",
};

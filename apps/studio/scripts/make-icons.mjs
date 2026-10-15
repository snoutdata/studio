/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Generates the derived icon artifacts from build/icon.png (the master logo):
//   build/icon.ico    Windows (png-to-ico resizes the source to 16/32/48/256)
//   build/icons/*.png the Linux hicolor icon SET (16x16.png, 32x32.png, ...)
// build/icon.png stays the source macOS uses directly, so it only needs committing once.
// Run with `npm run icons`.
//
// Why the Linux set exists: given a single .png, electron-builder shipped ONE icon at the
// source's own size, /usr/share/icons/hicolor/1024x1024/apps/snoutdata.png. `1024x1024` is
// not a directory listed in hicolor's index.theme on Debian/Ubuntu, so the freedesktop icon
// lookup ignored it entirely and the dock/launcher fell back to a generic gear. Pointing
// electron-builder's `linux.icon` at a DIRECTORY of size-named PNGs makes it install one per
// standard hicolor size instead. Sizes below are all real hicolor dirs.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pngToIco from 'png-to-ico';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'build', 'icon.png');
const out = join(root, 'build', 'icon.ico');

const ico = await pngToIco(src);
await writeFile(out, ico);
console.log(`Wrote ${out} (${ico.length} bytes) from ${src}`);

const iconsDir = join(root, 'build', 'icons');
await mkdir(iconsDir, { recursive: true });
const image = await loadImage(src);
for (const size of LINUX_SIZES) {
	const canvas = createCanvas(size, size);
	const ctx = canvas.getContext('2d');
	ctx.drawImage(image, 0, 0, size, size);
	const file = join(iconsDir, `${size}x${size}.png`);
	await writeFile(file, canvas.toBuffer('image/png'));
	console.log(`Wrote ${file}`);
}

// The TRAY assets, inlined into src/main/trayIcon.ts as base64.
//
// electron-builder never packs directories.buildResources (build/) into the app, so a packaged
// build has no build/icons/*.png to read at runtime: a tray that loaded one would work in dev and
// show an empty square everywhere else. Two icon sizes, 16 and 32, are what the menu bar (1x/2x)
// and a HiDPI notification area ask for.
//
// A TRAY ICON IS NOT AN APP ICON, and this used to be `drawImage(icon.png, 0, 0, 16, 16)`, which is
// how the menu bar ended up showing a dark opaque tile with a speck in it. build/icon.png is a
// FULLY OPAQUE square: the #21201d ground is part of the artwork, and the mark only occupies about
// 63% of the box because an app icon is supposed to have that margin. Handed to a tray, the ground
// has no way to composite against the bar and the margin is dead space, so what the user sees is
// the square, not the logo. A tray glyph has to be alpha the whole way to the edge of its box, and
// on macOS a TEMPLATE image (black + alpha) that the menu bar tints to match itself.
//
// It is also line art. At 32px, and far more so at 16, the circuit traces inside the wings are
// below one pixel and turn into speckle, so the mark is REDUCED to what a tray pixel can carry:
// keep the structure (the two wing outlines and the body), fill the hollow wings, and drop the
// traces. See trayMask() for the pipeline and why each step is there.
const TRAY_SIZES = [16, 32];
/** Luminance above which an icon.png pixel is the mark rather than the ground. */
const TRAY_INK = 128;
/** Morphology radii, as a fraction of the mark's own span, so 16 and 32 are the same drawing at two
 *  resolutions rather than two drawings that happen to share a logo. Tuned by eye at both sizes:
 *  SEAL is what closes the gaps in the line art (too small and the fill leaks out through them and
 *  the shape collapses; too large and the wings fuse into one lump), TRIM is what sheds the thin
 *  stems left behind by the circuit pads once the wings are solid. */
const TRAY_SEAL = 0.022;
const TRAY_TRIM = 0.018;
/** How far the update arrow sits in from the bottom-right corner, in badge pixels. */
const TRAY_BADGE_MOAT = 1;
/** Radius of the hollow the arrow sits in, in badge pixels. The gap is a DISC, not the arrow's own
 *  outline grown by a pixel: an outline gap traces every step of the arrow's staircase, and at 16px
 *  a one-pixel channel wandering around six corners is read as ragged edges on the arrow rather
 *  than as a gap. A circle has no corners to go ragged, it is the shape every notification badge
 *  already uses, and it says "something has been dropped into the mark" instead of "the mark has a
 *  crack in it". It is kept as tight to the arrow as the clearance allows (3.7 leaves half a pixel
 *  at 1x on the arrow's widest row) because every tenth of it is bitten out of a wing: the mark is
 *  what the hollow is cut from, so the hollow is as small as it can be and still be a gap. */
const TRAY_BADGE_DISC = 3.7;
const DOTS = {
	ok: '#6fd08c',
	busy: '#e0b256',
	idle: '#8a8a8a',
	warn: '#e0a33a',
	error: '#f0705c',
	info: '#5aa9f0',
};

function pngLines(buffer) {
	const b64 = buffer.toString('base64');
	const lines = [];
	for (let i = 0; i < b64.length; i += 100) {
		lines.push('\t' + JSON.stringify(b64.slice(i, i + 100)));
	}
	return lines.join(' +\n');
}

/**
 * The mark, reduced to a solid silhouette on transparency, at the size a tray asks for.
 *
 * Every step earns its place:
 *  - threshold        icon.png has no alpha, so the mark has to be found by luminance.
 *  - keep structure   the mark is one drawing made of eleven separate strokes: two wing outlines,
 *                     the body, and eight interior circuit traces. Only the first three survive a
 *                     tray pixel, and the rule that keeps them is a span at least half the widest
 *                     stroke's, not a hardcoded list, so re-drawing the logo does not silently
 *                     start shipping its traces again.
 *  - close            the outlines have gaps in them (a trace runs out through the wing edge). The
 *                     fill below floods the OUTSIDE, so an unsealed gap lets it into the wing and
 *                     there is nothing left to draw.
 *  - fill + erode     the wings are hollow outlines; filled they become the two masses that make a
 *                     butterfly readable small. The erode undoes the close's bulge, so the
 *                     silhouette keeps the contour the designer drew.
 *  - open             the circuit pads on the wing edges hang off thin stems. Solid, they read as
 *                     detached specks, which is exactly the noise this is here to remove.
 *
 * The result is size-independent (every radius is a fraction of the mark, not of a tray pixel), so
 * this runs once and trayGlyph() below does the per-size part: the downscale, and the badge.
 */
function traySilhouette() {
	const W = image.width;
	const source = createCanvas(W, W).getContext('2d');
	source.drawImage(image, 0, 0);
	const px = source.getImageData(0, 0, W, W).data;
	const ink = new Uint8Array(W * W);
	for (let p = 0; p < W * W; p++) {
		const o = p * 4;
		ink[p] = px[o] * 0.299 + px[o + 1] * 0.587 + px[o + 2] * 0.114 > TRAY_INK ? 1 : 0;
	}

	// Separable box dilate/erode. Off the edge of the frame counts as empty for a dilate and as
	// filled for an erode, so a mark touching the border is not eaten from the outside in.
	function morph(src, r, grow) {
		if (r <= 0) {
			return src;
		}
		const pass = (input, horiz) => {
			const out = new Uint8Array(W * W);
			for (let a = 0; a < W; a++) {
				for (let b = 0; b < W; b++) {
					let hit = false;
					for (let d = -r; d <= r; d++) {
						const c = b + d;
						if (c < 0 || c >= W) {
							if (!grow) {
								hit = true;
								break;
							}
							continue;
						}
						const v = horiz ? input[a * W + c] : input[c * W + a];
						if (grow ? v : !v) {
							hit = true;
							break;
						}
					}
					out[horiz ? a * W + b : b * W + a] = grow === Boolean(hit) ? 1 : 0;
				}
			}
			return out;
		};
		return pass(pass(src, true), false);
	}

	function components(src) {
		const seen = new Int32Array(W * W).fill(-1);
		const list = [];
		for (let s = 0; s < W * W; s++) {
			if (!src[s] || seen[s] >= 0) {
				continue;
			}
			const id = list.length;
			const cells = [];
			let x0 = W, y0 = W, x1 = -1, y1 = -1;
			const stack = [s];
			seen[s] = id;
			while (stack.length) {
				const p = stack.pop();
				cells.push(p);
				const x = p % W, y = (p / W) | 0;
				if (x < x0) { x0 = x; }
				if (x > x1) { x1 = x; }
				if (y < y0) { y0 = y; }
				if (y > y1) { y1 = y; }
				const visit = (q, ok) => {
					if (ok && src[q] && seen[q] < 0) {
						seen[q] = id;
						stack.push(q);
					}
				};
				visit(p - 1, x > 0);
				visit(p + 1, x < W - 1);
				visit(p - W, y > 0);
				visit(p + W, y < W - 1);
			}
			list.push({ cells, span: Math.max(x1 - x0 + 1, y1 - y0 + 1) });
		}
		return list;
	}

	// Flood the outside; whatever the flood never reached and is not ink is an interior hole.
	function fillHoles(src) {
		const out = new Uint8Array(W * W).fill(1);
		const stack = [];
		const push = (p) => {
			if (!src[p] && out[p]) {
				out[p] = 0;
				stack.push(p);
			}
		};
		for (let i = 0; i < W; i++) {
			push(i);
			push((W - 1) * W + i);
			push(i * W);
			push(i * W + W - 1);
		}
		while (stack.length) {
			const p = stack.pop();
			const x = p % W, y = (p / W) | 0;
			if (x > 0) { push(p - 1); }
			if (x < W - 1) { push(p + 1); }
			if (y > 0) { push(p - W); }
			if (y < W - 1) { push(p + W); }
		}
		return out;
	}

	function bounds(src) {
		let x0 = W, y0 = W, x1 = -1, y1 = -1;
		for (let y = 0; y < W; y++) {
			for (let x = 0; x < W; x++) {
				if (src[y * W + x]) {
					if (x < x0) { x0 = x; }
					if (x > x1) { x1 = x; }
					if (y < y0) { y0 = y; }
					if (y > y1) { y1 = y; }
				}
			}
		}
		return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
	}

	const strokes = components(ink);
	const widest = Math.max(...strokes.map((stroke) => stroke.span));
	const structure = new Uint8Array(W * W);
	for (const stroke of strokes) {
		if (stroke.span >= widest * 0.5) {
			for (const p of stroke.cells) {
				structure[p] = 1;
			}
		}
	}

	const span = Math.max(bounds(structure).w, bounds(structure).h);
	const seal = Math.max(1, Math.round(TRAY_SEAL * span));
	const trim = Math.max(1, Math.round(TRAY_TRIM * span));
	const filled = morph(fillHoles(morph(morph(structure, seal, true), seal, false)), seal, false);
	const solid = morph(morph(filled, trim, false), trim, true);

	const mask = createCanvas(W, W);
	const maskCtx = mask.getContext('2d');
	const bitmap = maskCtx.createImageData(W, W);
	for (let p = 0; p < W * W; p++) {
		bitmap.data[p * 4 + 3] = solid[p] ? 255 : 0;
	}
	maskCtx.putImageData(bitmap, 0, 0);

	return { mask, box: bounds(solid) };
}

/** The update badge, as a bitmap rather than a path.
 *
 *  A down arrow at 16px is 8 pixels across. Stroking one with canvas paths at that size gives a
 *  grey smudge, so it is spelled out pixel by pixel at 1x and blitted at a whole-number scale: the
 *  32px badge is this exact drawing at 2x, crisp on both, and unmistakably the same arrow. */
const BADGE = [
	'..##..',
	'..##..',
	'..##..',
	'######',
	'.####.',
	'..##..',
];

/**
 * One tray glyph: the silhouette scaled into the frame, optionally with the update badge.
 *
 * The badge is not an overlay. It is one ink on transparency like everything else here (it has to
 * be: on macOS this whole image is a template and the menu bar throws the colour away), so the
 * only thing that can separate it from the mark is a GAP.
 *
 * The mark is NOT shrunk to make room for it. A tray glyph is already only 16 pixels of butterfly,
 * and taking 30% off it to park an arrow in the corner spends the mark to say something the arrow
 * says anyway: the icon changes SIZE, which is the change the eye notices first, and what it
 * notices is that the logo got smaller. So the badge is CARVED instead. The mark is drawn at
 * exactly the size it always is, and the arrow plus its moat are erased straight through it in the
 * bottom-right corner, leaving a hollow the arrow sits in. Same silhouette, same weight, one
 * corner bitten out of it, which is how a notification badge reads everywhere else.
 */
function trayGlyph(size, badged) {
	const { mask, box } = silhouette;
	// One pixel of margin at 16, two at 32. The bar adds its own padding around a status item, so
	// this is only here to keep the antialiased edge off the very edge of the frame.
	const unit = Math.round(size / 16);
	const pad = unit;
	const out = createCanvas(size, size);
	const ctx = out.getContext('2d');
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';

	// The mark is drawn the same way badged or not: full frame, centred. The badge takes nothing
	// from it, it takes a bite out of it.
	const frame = size - pad * 2;
	const fit = Math.min(frame / box.w, frame / box.h);
	const w = Math.round(box.w * fit), h = Math.round(box.h * fit);
	const x = Math.round((size - w) / 2);
	const y = Math.round((size - h) / 2);
	ctx.drawImage(mask, box.x, box.y, box.w, box.h, x, y, w, h);
	if (!badged) {
		return out;
	}

	// The arrow is inset one badge pixel from the bottom-right corner, which puts the far side of
	// its hollow on the frame edge. That is the placement that reads: the gap opens onto the edge,
	// so the hollow is a bite taken out of the wing rather than an enclosed hole (which reads as a
	// fault in the drawing), and the arrow itself still sits wholly inside the frame.
	const arrow = BADGE[0].length;
	const ox = size - (arrow + TRAY_BADGE_MOAT) * unit;
	const oy = size - (BADGE.length + TRAY_BADGE_MOAT) * unit;
	// The hollow first, then the arrow into it. destination-out erases, which is the only way to cut
	// a gap in an image whose ink is decided later by somebody else.
	ctx.globalCompositeOperation = 'destination-out';
	ctx.beginPath();
	ctx.arc(ox + (arrow * unit) / 2, oy + (BADGE.length * unit) / 2, TRAY_BADGE_DISC * unit, 0, Math.PI * 2);
	ctx.fill();
	ctx.globalCompositeOperation = 'source-over';
	ctx.fillStyle = '#000000';
	for (let row = 0; row < BADGE.length; row++) {
		for (let col = 0; col < arrow; col++) {
			if (BADGE[row][col] === '#') {
				ctx.fillRect(ox + col * unit, oy + row * unit, unit, unit);
			}
		}
	}
	return out;
}

/** Paint the silhouette one flat colour, keeping its alpha. */
function trayInk(mask, color) {
	const size = mask.width;
	const out = createCanvas(size, size);
	const ctx = out.getContext('2d');
	ctx.drawImage(mask, 0, 0);
	ctx.globalCompositeOperation = 'source-in';
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, size, size);
	return pngLines(out.toBuffer('image/png'));
}

const silhouette = traySilhouette();
const trayIcons = TRAY_SIZES.map((size) => trayInk(trayGlyph(size, false), '#000000'));
const trayIconsWhite = TRAY_SIZES.map((size) => trayInk(trayGlyph(size, false), '#ffffff'));
const trayIconsUpdate = TRAY_SIZES.map((size) => trayInk(trayGlyph(size, true), '#000000'));
const trayIconsUpdateWhite = TRAY_SIZES.map((size) => trayInk(trayGlyph(size, true), '#ffffff'));


const dots = Object.entries(DOTS).map(([name, color]) => {
	// 16x16 so the OS scales it like any other menu icon; the disc is 9px across and centred, which
	// is the weight a status dot has next to menu text.
	const canvas = createCanvas(16, 16);
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.arc(8, 8, 4.5, 0, Math.PI * 2);
	ctx.fill();
	return { name, color, body: pngLines(canvas.toBuffer('image/png')) };
});

const header = [
	"// The tray's images, inlined. GENERATED by scripts/make-icons.mjs (`npm run icons`) from",
	'// build/icon.png - edit that, not this.',
	'//',
	'// They are carried here as base64 rather than read from disk because electron-builder does NOT',
	'// pack directories.buildResources (build/) into the app: a packaged build has no build/icons to',
	'// read, so a tray that loaded one would work in dev and show an empty square everywhere else.',
	'//',
	'// The mark is a SILHOUETTE on transparency, not the app icon: an app icon carries its own',
	'// opaque ground and its own margin, and a tray that is handed one shows the ground as a tile.',
	'// It comes in two inks because only macOS can tint it for us (a template image); Windows and',
	'// Linux get whichever one their notification area is not, chosen at runtime in tray.ts.',
	'',
	'/** The states the menu draws a dot for. */',
	`export type TrayDotName = ${dots.map((dot) => `'${dot.name}'`).join(' | ')};`,
	'',
	'/** 16x16 PNG, BLACK on transparency: the 1x menu-bar / notification-area size. On macOS this is',
	' *  the template representation, which the menu bar tints itself; elsewhere it is the glyph for a',
	' *  LIGHT notification area. */',
	'export const TRAY_ICON_16 =',
	`${trayIcons[0]};`,
	'',
	'/** 32x32 PNG, BLACK on transparency: the 2x representation, and what a Windows or Linux',
	' *  notification area is handed directly. */',
	'export const TRAY_ICON_32 =',
	`${trayIcons[1]};`,
	'',
	'/** The same mark in WHITE, for a DARK Windows or Linux notification area. There is no 16 to go',
	' *  with it because nothing would read one: macOS is the only platform handed both scales, and it',
	' *  takes the template (black) pair, since asking for white there would break the inversion the',
	' *  menu bar does on click and in its own light mode. */',
	'export const TRAY_ICON_WHITE_32 =',
	`${trayIconsWhite[1]};`,
	'',
	'/** The same four again, wearing the UPDATE BADGE: the mark at its FULL size with a down arrow',
	' *  carved into its bottom-right corner, so an update waiting is legible from the bar itself and',
	' *  not only from the menu. The mark is not shrunk to make room, which would make "the logo got',
	' *  smaller" the loudest thing about the change; the arrow and its gap are erased through it and',
	' *  it sits in the hollow. The badge is cut out of the same alpha, never painted a second colour,',
	' *  because on macOS the menu bar inks the whole image and would flatten any colour we chose. */',
	'export const TRAY_ICON_UPDATE_16 =',
	`${trayIconsUpdate[0]};`,
	'',
	'export const TRAY_ICON_UPDATE_32 =',
	`${trayIconsUpdate[1]};`,
	'',
	'export const TRAY_ICON_UPDATE_WHITE_32 =',
	`${trayIconsUpdateWhite[1]};`,
	'',
	'/** The status dots, one 16x16 PNG each, in the theme’s own status colours: ' +
		dots.map((dot) => `${dot.name} ${dot.color}`).join(', ') + '. */',
	'export const TRAY_DOTS: Record<TrayDotName, string> = {',
	...dots.map((dot) => `\t${dot.name}:\n${dot.body},`),
	'};',
	'',
].join('\n');

const trayFile = join(root, 'src', 'main', 'trayIcon.ts');
await writeFile(trayFile, header);
console.log(`Wrote ${trayFile}`);

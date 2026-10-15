/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Our own hover tooltip, for icon-only buttons.
//
// An icon-only button has to say what it is on hover, and the native `title` tooltip is not a
// thing this app can rely on for that: Electron does not show it reliably in a window whose title
// bar is hidden (ours, on every platform), so on a Mac every icon said nothing until you clicked
// it. Playwright cannot see a native tooltip either, so no test could have caught that. This one is
// drawn by us, in the theme.
//
// Delegated: one listener reads the `aria-label` of whichever matching element the pointer (or
// keyboard focus) is on, so a button needs nothing but that label, which is also what a screen
// reader says. Two are mounted: the activity bar's (beside the icon) and the app's, for every
// `.icon-btn` (below it, or above near the bottom of the window).

/** How long the pointer rests before the first tip shows. */
const DELAY_MS = 450;
/** After a tip hides, the next one within this window shows at once, so sweeping along a row of
 *  icons reads each in turn instead of waiting on every one. */
const WARM_MS = 600;
const GAP = 6;
const EDGE = 6;

/** Where a tip goes relative to its element: beside it (a vertical strip) or below it. */
export type TipPlacement = 'beside' | 'below';

interface Shown {
	text: string;
	rect: DOMRect;
}

/**
 * Tooltips for the elements matching `selector` under `root` (an element ref, or the whole
 * document). Returns the tooltip to render, portalled to <body>, or null.
 */
export function useHoverTip(root: React.RefObject<HTMLElement> | 'document', selector: string, placement: TipPlacement): JSX.Element | null {
	const [shown, setShown] = useState<Shown | null>(null);
	const [pos, setPos] = useState<{ left: number; top: number; side: string } | null>(null);
	const tipRef = useRef<HTMLDivElement>(null);
	const target = useRef<HTMLElement | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const hiddenAt = useRef(0);
	/** Whether a tip is on screen right now, for the events that should close one but must not
	 *  cancel one that is about to appear. */
	const visible = useRef(false);
	/** The element just pressed: it gets no tip again until the pointer has left it. */
	const pressed = useRef<HTMLElement | null>(null);
	visible.current = shown !== null;

	const hide = useCallback((): void => {
		clearTimeout(timer.current);
		if (target.current) {
			hiddenAt.current = Date.now();
		}
		target.current = null;
		setShown(null);
	}, []);

	const show = useCallback((el: HTMLElement, immediate: boolean): void => {
		if (target.current === el) {
			return;
		}
		clearTimeout(timer.current);
		const warm = target.current !== null || Date.now() - hiddenAt.current < WARM_MS;
		target.current = el;
		const reveal = (): void => {
			const text = el.getAttribute('aria-label');
			if (text && target.current === el && el.isConnected) {
				setShown({ text, rect: el.getBoundingClientRect() });
			}
		};
		if (immediate || warm) {
			reveal();
		} else {
			setShown(null);
			timer.current = setTimeout(reveal, DELAY_MS);
		}
	}, []);

	useEffect(() => {
		const el: HTMLElement | Document | null = root === 'document' ? document : root.current;
		if (!el) {
			return;
		}
		const over = (e: Event): void => {
			const hit = (e.target as Element).closest?.<HTMLElement>(selector);
			if (hit && hit === pressed.current) {
				return;
			}
			pressed.current = null;
			if (hit && el.contains(hit)) {
				show(hit, false);
			} else if (target.current) {
				hide();
			}
		};
		// Keyboard focus shows it at once, but only a VISIBLE focus: a click also focuses the
		// button, and a tip popping up under the pointer after a click is noise.
		const focus = (e: Event): void => {
			const hit = (e.target as Element).closest?.<HTMLElement>(selector);
			if (hit && hit.matches(':focus-visible')) {
				show(hit, true);
			}
		};
		const out = (e: Event): void => {
			if (target.current && (e.target as Node) === target.current) {
				hide();
			}
		};
		// The pointer leaving the window altogether (no element under it any more).
		const leave = (e: MouseEvent): void => {
			if (!e.relatedTarget) {
				hide();
			}
		};
		// A scroll, a resize or a key closes a tip that is SHOWING (it would point at the wrong place,
		// or the user has moved on). It must not cancel one that is still waiting to appear: the app
		// scrolls things on its own (an editor settling after launch), and a pointer resting on an
		// icon through that would otherwise never get its tip.
		const dismiss = (): void => {
			if (visible.current) {
				hide();
			}
		};
		el.addEventListener('mouseover', over);
		// And moving re-arms it: after a tip was put away (a key, a scroll), the next movement over
		// the same icon brings it back without leaving and re-entering.
		el.addEventListener('mousemove', over);
		el.addEventListener('mouseleave', hide);
		// Pressing it (or starting to drag it somewhere) is past the point of asking what it is.
		const press = (e: Event): void => {
			pressed.current = (e.target as Element).closest?.<HTMLElement>(selector) ?? null;
			hide();
		};
		el.addEventListener('pointerdown', press, true);
		el.addEventListener('contextmenu', hide);
		el.addEventListener('focusin', focus);
		el.addEventListener('focusout', out);
		window.addEventListener('blur', hide);
		window.addEventListener('resize', dismiss);
		window.addEventListener('scroll', dismiss, true);
		window.addEventListener('keydown', dismiss, true);
		document.addEventListener('mouseout', leave);
		return () => {
			clearTimeout(timer.current);
			el.removeEventListener('mouseover', over);
			el.removeEventListener('mousemove', over);
			el.removeEventListener('mouseleave', hide);
			el.removeEventListener('pointerdown', press, true);
			el.removeEventListener('contextmenu', hide);
			el.removeEventListener('focusin', focus);
			el.removeEventListener('focusout', out);
			window.removeEventListener('blur', hide);
			window.removeEventListener('resize', dismiss);
			window.removeEventListener('scroll', dismiss, true);
			window.removeEventListener('keydown', dismiss, true);
			document.removeEventListener('mouseout', leave);
		};
	}, [root, selector, show, hide]);

	// A button removed while its tip is up (a row that re-rendered, a panel that closed) takes the
	// tip with it, rather than leaving it pointing at nothing.
	useEffect(() => {
		if (!shown) {
			return;
		}
		const check = setInterval(() => {
			if (!target.current?.isConnected) {
				hide();
			}
		}, 250);
		return () => clearInterval(check);
	}, [shown, hide]);

	// Placed once its size is known: beside or below as asked, flipped to the other side when
	// there is no room, and kept inside the window.
	useLayoutEffect(() => {
		const tip = tipRef.current;
		if (!shown || !tip) {
			setPos(null);
			return;
		}
		const { rect } = shown;
		const w = tip.offsetWidth;
		const h = tip.offsetHeight;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		let left: number;
		let top: number;
		let side: string;
		if (placement === 'beside') {
			top = rect.top + rect.height / 2 - h / 2;
			if (rect.right + GAP + w <= vw - EDGE || rect.left < vw / 2) {
				side = 'right';
				left = rect.right + GAP;
			} else {
				side = 'left';
				left = rect.left - GAP - w;
			}
		} else {
			left = rect.left + rect.width / 2 - w / 2;
			if (rect.bottom + GAP + h <= vh - EDGE) {
				side = 'below';
				top = rect.bottom + GAP;
			} else {
				side = 'above';
				top = rect.top - GAP - h;
			}
		}
		setPos({
			left: Math.max(EDGE, Math.min(left, vw - w - EDGE)),
			top: Math.max(EDGE, Math.min(top, vh - h - EDGE)),
			side,
		});
	}, [shown, placement]);

	if (!shown) {
		return null;
	}
	return createPortal(
		<div
			ref={tipRef}
			className={`hover-tip${pos ? ` ${pos.side}` : ''}`}
			role="tooltip"
			style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
		>
			{shown.text}
		</div>,
		document.body,
	);
}

/** The app-wide tooltips: every `.icon-btn` with an aria-label, wherever it is. Mounted once. */
export function IconButtonTips(): JSX.Element | null {
	return useHoverTip('document', '.icon-btn[aria-label]', 'below');
}

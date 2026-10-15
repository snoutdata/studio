/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { LibyArt, type LibyMood } from '@snout/liby';

export interface TourStep {
	/** Matches a `data-tour="<anchor>"` element. Absent or not found ⇒ a centered card. */
	anchor?: string;
	title: string;
	body: string;
	/** Preferred tooltip side relative to the anchor; auto-falls back if it won't fit. */
	placement?: 'top' | 'bottom' | 'left' | 'right';
	/** Run before the step shows — e.g. open a panel so its anchor exists. */
	onEnter?: () => void;
	/** Optional call-to-action: a labelled link button opening `ctaUrl` (needs `onOpenLink`). */
	ctaLabel?: string;
	ctaUrl?: string;
	/** A drawing over the title (art/Illustrations.tsx); for a centred step, which has the room. */
	art?: JSX.Element;
	/** A `LibyMood` for this step, passed to the companion (`@snout/liby`) with the card; absent, the card is the app's own. */
	liby?: LibyMood;
}

interface SpotlightProps {
	steps: TourStep[];
	/** Called when the tour completes (last step) or is skipped. */
	onFinish(): void;
	/** Label for the final button (default "Done"). */
	finishLabel?: string;
	/** A small eyebrow chip in the header (e.g. "What's New"); omit to show only the counter. */
	badge?: string;
	/** Label for the header dismiss link (default "Skip"). */
	skipLabel?: string;
	/** Open a step's CTA url (the renderer wires this to window.sqlApi.openExternal). */
	onOpenLink?: (url: string) => void;
}

interface Rect { top: number; left: number; width: number; height: number; }

const GAP = 14; // space between the highlighted anchor and the card
const MARGIN = 10; // keep the card this far from the viewport edge

/**
 * Hand-rolled guided-tour overlay. Dims the screen, cuts a spotlight hole over the
 * step's anchor (via a big box-shadow), and floats a card beside it with Back / Next /
 * Skip. Anchors are resolved by `data-tour="…"` so steps stay decoupled from markup.
 * Reused for both the first-run tour and single-step feature announcements.
 */
export function Spotlight({ steps, onFinish, finishLabel = "Done", badge, skipLabel = "Skip", onOpenLink }: SpotlightProps): JSX.Element {
	const [index, setIndex] = useState(0);
	const [rect, setRect] = useState<Rect | null>(null);
	const [pos, setPos] = useState<{ top: number; left: number; place: string }>({ top: 0, left: 0, place: 'center' });
	const cardRef = useRef<HTMLDivElement>(null);
	const step = steps[index];
	const last = index === steps.length - 1;

	function locate(anchor?: string): Rect | null {
		const el = anchor ? document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`) : null;
		if (!el) {
			return null;
		}
		const r = el.getBoundingClientRect();
		return { top: r.top, left: r.left, width: r.width, height: r.height };
	}

	// Enter a step: run its side-effect, then find the anchor — retrying across a few frames
	// while a just-opened panel settles into its final position.
	useEffect(() => {
		step.onEnter?.();
		let raf = 0;
		let tries = 0;
		function measure(): void {
			const found = locate(step.anchor);
			if (found || !step.anchor || tries >= 20) {
				setRect(found);
			} else {
				tries += 1;
				raf = requestAnimationFrame(measure);
			}
		}
		raf = requestAnimationFrame(measure);
		return () => cancelAnimationFrame(raf);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [index]);

	// Keep the spotlight glued to the anchor as the window resizes or content scrolls.
	//
	// PERF: the highlight casts a ~20000px box-shadow (the screen dim — see .tour-highlight
	// in styles.css). Re-measuring it on *every* scroll/resize event used to froze the app at
	// startup: this listener is in the capture phase, so any scroll anywhere (Monaco laying
	// out, the results grid, a panel settling on mount) fired a synchronous getBoundingClientRect
	// + setRect, and each resulting re-render repainted that whole box-shadow region. We now
	// coalesce to one re-measure per animation frame and only setRect when the anchor actually
	// moved, so a burst of scroll events causes at most one repaint per frame. The companion
	// fix is dropping the CSS transition on .tour-highlight. If the overlay still janks, the
	// real fix is structural: stop using a giant box-shadow for the dim (four dim panels or a
	// clip-path mask around the hole) so there is no oversized layer to repaint at all.
	useEffect(() => {
		let raf = 0;
		function remeasure(): void {
			raf = 0;
			const found = locate(step.anchor);
			if (found) {
				setRect((prev) =>
					prev && prev.top === found.top && prev.left === found.left
						&& prev.width === found.width && prev.height === found.height
						? prev
						: found,
				);
			}
		}
		function onChange(): void {
			if (raf === 0) {
				raf = requestAnimationFrame(remeasure);
			}
		}
		window.addEventListener('resize', onChange, { passive: true });
		window.addEventListener('scroll', onChange, { passive: true, capture: true });
		return () => {
			if (raf !== 0) {
				cancelAnimationFrame(raf);
			}
			window.removeEventListener('resize', onChange);
			window.removeEventListener('scroll', onChange, true);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [index]);

	// Position the card relative to the anchor (or center it when there's none), then clamp
	// it inside the viewport. Runs after layout so we can read the card's real size.
	useLayoutEffect(() => {
		const card = cardRef.current;
		if (!card) {
			return;
		}
		const cw = card.offsetWidth;
		const ch = card.offsetHeight;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		if (!rect) {
			setPos({ top: (vh - ch) / 2, left: (vw - cw) / 2, place: 'center' });
			return;
		}
		const order = [step.placement ?? 'right', 'right', 'left', 'bottom', 'top'];
		const fits = (p: string): { top: number; left: number } | null => {
			let top = 0;
			let left = 0;
			if (p === 'right') { left = rect.left + rect.width + GAP; top = rect.top + rect.height / 2 - ch / 2; }
			else if (p === 'left') { left = rect.left - GAP - cw; top = rect.top + rect.height / 2 - ch / 2; }
			else if (p === 'bottom') { top = rect.top + rect.height + GAP; left = rect.left + rect.width / 2 - cw / 2; }
			else { top = rect.top - GAP - ch; left = rect.left + rect.width / 2 - cw / 2; }
			const ok = left >= MARGIN && left + cw <= vw - MARGIN && top >= MARGIN && top + ch <= vh - MARGIN;
			return ok ? { top, left } : null;
		};
		for (const p of order) {
			const got = fits(p);
			if (got) {
				setPos({ ...got, place: p });
				return;
			}
		}
		// Nothing fit cleanly: fall back to the preferred side and clamp into view.
		const p = step.placement ?? 'right';
		let top = rect.top + rect.height / 2 - ch / 2;
		let left = p === 'left' ? rect.left - GAP - cw : rect.left + rect.width + GAP;
		if (p === 'top') { top = rect.top - GAP - ch; left = rect.left + rect.width / 2 - cw / 2; }
		if (p === 'bottom') { top = rect.top + rect.height + GAP; left = rect.left + rect.width / 2 - cw / 2; }
		left = Math.min(Math.max(left, MARGIN), vw - cw - MARGIN);
		top = Math.min(Math.max(top, MARGIN), vh - ch - MARGIN);
		setPos({ top, left, place: p });
	}, [rect, index, step.placement]);

	function next(): void {
		if (last) {
			onFinish();
		} else {
			setIndex((i) => i + 1);
		}
	}

	function back(): void {
		setIndex((i) => Math.max(0, i - 1));
	}

	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') { e.preventDefault(); onFinish(); }
			else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
			else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [index, last]);

	return (
		<div className={`tour-overlay${rect ? '' : ' tour-overlay-dim'}`} onClick={onFinish}>
			{rect && (
				<div
					className="tour-highlight"
					style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}
				/>
			)}
			<div
				ref={cardRef}
				className={`tour-card tour-place-${pos.place}`}
				style={{ top: pos.top, left: pos.left }}
				onClick={(e) => e.stopPropagation()}
			>
				{step.liby && (
					<div className="tour-liby-perch" aria-hidden="true">
						<div key={index} className="liby tour-liby" data-mood={step.liby}>
							<LibyArt />
						</div>
					</div>
				)}
				<div className="tour-card-head">
					<span className="tour-step-count">
						{badge && <span className="tour-badge">{badge}</span>}
						{steps.length > 1 ? `${index + 1} / ${steps.length}` : (badge ? '' : `${index + 1} of ${steps.length}`)}
					</span>
					<button className="tour-skip" type="button" onClick={onFinish}>{skipLabel}</button>
				</div>
				{step.art && <div className="tour-card-art">{step.art}</div>}
				<h3 className="tour-card-title">{step.title}</h3>
				<p className="tour-card-body">{step.body}</p>
				{step.ctaLabel && step.ctaUrl && onOpenLink && (
					<button className="tour-cta" type="button" onClick={() => onOpenLink(step.ctaUrl as string)}>
						{step.ctaLabel} <Icon name="link-external" />
					</button>
				)}
				<div className="tour-card-foot">
					<div className="tour-dots">
						{steps.map((_, i) => (
							<span key={i} className={`tour-dot${i === index ? ' active' : ''}`} />
						))}
					</div>
					<div className="tour-card-actions">
						{steps.length > 1 && (
							<button className="tour-nav" type="button" onClick={back} disabled={index === 0} title="Previous">
								<Icon name="chevron-left" />
							</button>
						)}
						{last
							? <button className="tour-next" type="button" onClick={next}><Icon name="check" /> {finishLabel}</button>
							: <button className="tour-nav" type="button" onClick={next} title="Next"><Icon name="chevron-right" /></button>}
					</div>
				</div>
			</div>
		</div>
	);
}

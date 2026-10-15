/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useRef } from 'react';

interface SplitterProps {
	/** `vertical` is a vertical bar dragged left/right (resizes width); `horizontal`
	 *  is a horizontal bar dragged up/down (resizes height). */
	orientation: 'vertical' | 'horizontal';
	/** Incremental pointer movement since the last event, in CSS pixels. */
	onDrag(dx: number, dy: number): void;
	/**
	 * True when this splitter sits BETWEEN TWO FLOATING PANES, in which case it is the gutter and
	 * takes the gap's full width. A horizontal splitter is a hairline by default because the one
	 * that has always existed is inside a pane (editor over results, which are one pane); a dock
	 * area below the workbench is a different thing and must not touch its neighbour.
	 */
	gutter?: boolean;
}

/** A draggable divider between two panes. Uses pointer capture so the drag keeps
 *  tracking even when the pointer outruns the thin bar. The parent owns the size
 *  and applies the deltas (so collapse/clamp logic stays in one place). */
export function Splitter({ orientation, onDrag, gutter = false }: SplitterProps): JSX.Element {
	const last = useRef<{ x: number; y: number } | null>(null);

	function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		last.current = { x: e.clientX, y: e.clientY };
	}

	function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
		if (!last.current) {
			return;
		}
		const dx = e.clientX - last.current.x;
		const dy = e.clientY - last.current.y;
		last.current = { x: e.clientX, y: e.clientY };
		onDrag(dx, dy);
	}

	function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
		last.current = null;
		e.currentTarget.releasePointerCapture(e.pointerId);
	}

	return (
		<div
			className={`splitter splitter-${orientation}${gutter ? ' splitter-gutter' : ''}`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
		/>
	);
}

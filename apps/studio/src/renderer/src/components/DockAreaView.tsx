/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Splitter } from './Splitter';
import type { DockArea } from '../docking';

/*
 * One dock area: the sized, floating pane a tool window is shown in, plus the splitter that
 * resizes it. Left and right are full-height columns; bottom is a strip under the editor,
 * inside the centre column.
 *
 * It renders NO tool content. The tools are mounted once, elsewhere, and portalled into this
 * area's host div, which is what lets a panel keep its state (a conversation, a live terminal)
 * when the user moves it. That is also why the host stays mounted, hidden, when nothing is
 * showing: unmounting it would take the portalled tool down with it.
 */

interface DockAreaViewProps {
	area: DockArea;
	/** Width for left/right, height for bottom. */
	size: number;
	/** Whether this area has an active, un-collapsed tool to show. */
	visible: boolean;
	/** Pointer movement translated into "grow this area by n pixels". */
	onResize(delta: number): void;
	/** Handed the host element the tools portal into. */
	hostRef(el: HTMLDivElement | null): void;
}

export function DockAreaView({ area, size, visible, onResize, hostRef }: DockAreaViewProps): JSX.Element {
	// The splitter is always on the side facing the editor, and the drag sign follows: dragging
	// right grows a left area, dragging left grows a right one, dragging up grows the bottom.
	const splitter = !visible ? null : area === 'bottom'
		? <Splitter orientation="horizontal" gutter onDrag={(_dx, dy) => onResize(-dy)} />
		: <Splitter orientation="vertical" onDrag={(dx) => onResize(area === 'left' ? dx : -dx)} />;
	// THREE SLOTS, ALWAYS, even when two of them are null. React reconciles children by position,
	// so a fragment that changes shape when the area is shown or hidden would replace the host div
	// with a new one — and a portal whose container changes identity unmounts everything inside it.
	// That would quietly remount them: the assistant's conversation and the console's live
	// terminal are in there. Fixed slots keep the host the same DOM node for the life of the window.
	return (
		<>
			{area === 'left' ? null : splitter}
			<div
				className={`dock dock-${area}`}
				ref={hostRef}
				style={visible ? { flex: `0 0 ${size}px`, ...(area === 'bottom' ? {} : { width: size }) } : { display: 'none' }}
			/>
			{area === 'left' ? splitter : null}
		</>
	);
}

interface DockToolProps {
	/** The area host to render into. Null on the very first paint, before the ref has fired. */
	host: HTMLDivElement | null;
	/** Whether this is the tool its area is showing. Hidden, never unmounted. */
	visible: boolean;
	/** Right-click inside the tool. App decides whether it landed on the panel's header. */
	onContextMenu?(event: React.MouseEvent<HTMLDivElement>): void;
	/** Pointer down on the panel's HEADER: the start of a drag to another area. */
	onHeaderPointerDown?(event: React.PointerEvent<HTMLDivElement>): void;
	children: ReactNode;
}

/** One tool window, rendered into its area through a portal so moving it does not remount it. */
/** The strips a panel can be dragged BY: its own title bar, whichever shape it uses. */
const HEADERS = '.sidebar-header, .chat-header, .pane-header';

export function DockTool({ host, visible, onContextMenu, onHeaderPointerDown, children }: DockToolProps): JSX.Element | null {
	if (!host) {
		return null;
	}
	return createPortal(
		<div
			className="dock-tool"
			style={visible ? undefined : { display: 'none' }}
			onContextMenu={onContextMenu}
			onPointerDown={(event) => {
				// Only the header drags. A pointer down in a tree, a conversation or a terminal
				// belongs to what is under it: selecting text must not fling the panel across
				// the window.
				if ((event.target as HTMLElement).closest(HEADERS)) {
					onHeaderPointerDown?.(event);
				}
			}}
		>{children}</div>,
		host,
	);
}

/**
 * Where an element React does not PLACE is shown: on mount, the slot adopts `node` as its child.
 *
 * This is how Liby (the assistant) moves without remounting. A portal whose container changes
 * identity unmounts everything inside it (React compares containers by identity), so Liby is
 * portalled into ONE element for the life of the window, and that element is what moves: into a
 * `DomSlot` inside the dock it sits in, or into the one App draws for the full view. Only one
 * slot for a node is mounted at a time; when it unmounts, the node leaves with it and the next
 * slot to mount takes it in, in the same commit.
 */
export function DomSlot({ node }: { node: HTMLElement }): JSX.Element {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const slot = ref.current;
		if (slot && node.parentNode !== slot) {
			slot.appendChild(node);
		}
	}, [node]);
	return <div ref={ref} className="dom-slot" />;
}

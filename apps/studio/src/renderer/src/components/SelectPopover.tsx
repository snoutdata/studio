/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

// Every <select> in the app opens OUR list instead of the operating system's. Mounted once, like
// IconButtonTips.
//
// A native select's popup is drawn by the OS: a grey system menu with none of our tokens, in the
// middle of a themed app. Rewriting ~120 selects as a custom component would also throw away every
// CSS rule that sizes them, the <label> wrapping that names them, and the e2e suite's
// `selectOption`. So the select STAYS (its box, its value, its React onChange, its label) and only
// the moment it would open is taken over: the press that opens it is cancelled and the connection
// picker's list (ConnectionPicker.tsx, the `conn-picker-*` classes) opens under it instead. A pick
// sets the select's value and fires the same `input` and `change` events the browser would, so
// React's onChange runs exactly as it did.
//
// Left native on purpose: `multiple` and `size > 1` (those are lists on the page, not popups).

/** Past this many options the list gets a filter box, focused as it opens. */
const FILTER_AT = 12;
const GAP = 4;
const MARGIN = 8;
const MAX_WIDTH = 520;

interface Item {
	/** Index into `select.options`. */
	index: number;
	label: string;
	disabled: boolean;
	/** The <optgroup> label it sits under, if any. */
	group?: string;
}

interface Placement {
	left: number;
	minWidth: number;
	maxWidth: number;
	maxHeight: number;
	top?: number;
	bottom?: number;
}

function itemsOf(select: HTMLSelectElement): Item[] {
	return Array.from(select.options).map((option, index) => ({
		index,
		label: option.label || option.text,
		disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
		group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : undefined,
	}));
}

/** A select this takes over: a single-choice dropdown that is enabled. */
function ours(target: EventTarget | null): HTMLSelectElement | null {
	return target instanceof HTMLSelectElement && !target.multiple && target.size <= 1 && !target.disabled ? target : null;
}

/** Set the value and announce it the way the browser does, so React's onChange runs. */
function choose(select: HTMLSelectElement, index: number): void {
	if (select.selectedIndex === index) {
		return;
	}
	const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex')?.set;
	if (setter) {
		setter.call(select, index);
	} else {
		select.selectedIndex = index;
	}
	select.dispatchEvent(new Event('input', { bubbles: true }));
	select.dispatchEvent(new Event('change', { bubbles: true }));
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export function SelectPopover(): JSX.Element | null {
	const [select, setSelect] = useState<HTMLSelectElement | null>(null);
	const [items, setItems] = useState<Item[]>([]);
	const [filter, setFilter] = useState('');
	const [cursor, setCursor] = useState(0);
	const [place, setPlace] = useState<Placement | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const filterRef = useRef<HTMLInputElement>(null);
	const pointerRef = useRef<{ x: number; y: number } | null>(null);
	const openRef = useRef<HTMLSelectElement | null>(null);
	openRef.current = select;

	const needle = filter.trim().toLowerCase();
	const rows = needle ? items.filter((item) => item.label.toLowerCase().includes(needle)) : items;
	const showFilter = items.length >= FILTER_AT;

	const reposition = useCallback((): void => {
		const el = openRef.current;
		if (!el) {
			return;
		}
		const r = el.getBoundingClientRect();
		const room = window.innerWidth - 2 * MARGIN;
		const maxWidth = Math.min(Math.max(MAX_WIDTH, r.width), room);
		const minWidth = Math.min(r.width, maxWidth);
		const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - minWidth - MARGIN));
		const below = window.innerHeight - r.bottom - GAP - MARGIN;
		const above = r.top - GAP - MARGIN;
		setPlace(below >= 240 || below >= above
			? { left, minWidth, maxWidth, top: r.bottom + GAP, maxHeight: Math.min(420, below) }
			: { left, minWidth, maxWidth, bottom: window.innerHeight - r.top + GAP, maxHeight: Math.min(420, above) });
	}, []);

	const close = useCallback((refocus: boolean): void => {
		const el = openRef.current;
		setSelect(null);
		if (refocus) {
			el?.focus();
		}
	}, []);

	const open = useCallback((el: HTMLSelectElement): void => {
		const list = itemsOf(el);
		setItems(list);
		setFilter('');
		setCursor(Math.max(0, el.selectedIndex));
		pointerRef.current = null;
		openRef.current = el;
		reposition();
		setSelect(el);
	}, [reposition]);

	// The takeover: the press or key that would open the OS popup opens ours.
	useEffect(() => {
		function onDown(e: MouseEvent): void {
			const el = ours(e.target);
			if (!el || e.button !== 0) {
				return;
			}
			e.preventDefault();
			if (openRef.current === el) {
				close(true);
			} else {
				el.focus();
				open(el);
			}
		}
		function onKey(e: KeyboardEvent): void {
			const el = ours(e.target);
			if (!el || openRef.current === el) {
				return;
			}
			const arrow = e.key === 'ArrowDown' || e.key === 'ArrowUp';
			if (e.key === ' ' || e.key === 'Enter' || e.key === 'F4' || (arrow && (e.altKey || isMac))) {
				e.preventDefault();
				e.stopPropagation();
				open(el);
			}
		}
		document.addEventListener('mousedown', onDown, true);
		document.addEventListener('keydown', onKey, true);
		return () => {
			document.removeEventListener('mousedown', onDown, true);
			document.removeEventListener('keydown', onKey, true);
		};
	}, [open, close]);

	// While open: an outside press closes it, the page moving keeps it pinned, the app losing focus
	// closes it, and so does the select leaving the page (its tab or modal closed under it).
	useEffect(() => {
		if (!select) {
			return;
		}
		function onDown(e: MouseEvent): void {
			const t = e.target as Node;
			if (t !== select && !menuRef.current?.contains(t)) {
				close(false);
			}
		}
		function onMove(e: Event): void {
			if (e.target instanceof Node && menuRef.current?.contains(e.target)) {
				return;
			}
			if (!select?.isConnected) {
				close(false);
				return;
			}
			reposition();
		}
		function onBlur(): void {
			close(false);
		}
		document.addEventListener('mousedown', onDown);
		window.addEventListener('resize', reposition);
		window.addEventListener('scroll', onMove, true);
		window.addEventListener('blur', onBlur);
		return () => {
			document.removeEventListener('mousedown', onDown);
			window.removeEventListener('resize', reposition);
			window.removeEventListener('scroll', onMove, true);
			window.removeEventListener('blur', onBlur);
		};
	}, [select, reposition, close]);

	useLayoutEffect(() => {
		if (select) {
			(showFilter ? filterRef.current : listRef.current)?.focus();
		}
	}, [select, showFilter]);

	useEffect(() => {
		if (select) {
			listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
		}
	}, [select, cursor]);

	if (!select || !place) {
		return null;
	}
	const el = select;

	function pick(item: Item): void {
		if (item.disabled) {
			return;
		}
		close(true);
		choose(el, item.index);
	}

	/** The next enabled row from `from` in direction `step`, wrapping; `from` itself if none. */
	function step(from: number, by: 1 | -1): number {
		for (let i = 1; i <= rows.length; i++) {
			const at = (from + by * i + rows.length * 2) % rows.length;
			if (!rows[at].disabled) {
				return at;
			}
		}
		return from;
	}

	function onKeyDown(e: React.KeyboardEvent): void {
		// Everything here is the list's; none of it may reach the app (Escape closes modals).
		e.stopPropagation();
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				setCursor((c) => step(c, 1));
				break;
			case 'ArrowUp':
				e.preventDefault();
				setCursor((c) => step(c, -1));
				break;
			case 'Home':
				if (!showFilter) {
					e.preventDefault();
					setCursor(step(rows.length - 1, 1));
				}
				break;
			case 'End':
				if (!showFilter) {
					e.preventDefault();
					setCursor(step(0, -1));
				}
				break;
			case 'Enter':
				e.preventDefault();
				if (rows[cursor]) {
					pick(rows[cursor]);
				}
				break;
			case 'Escape':
				e.preventDefault();
				close(true);
				break;
			case 'Tab':
				close(false);
				break;
			default:
				// Type-ahead without a filter box: jump to the next row starting with the letter.
				if (!showFilter && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
					const letter = e.key.toLowerCase();
					for (let i = 1; i <= rows.length; i++) {
						const at = (cursor + i) % rows.length;
						if (!rows[at].disabled && rows[at].label.toLowerCase().startsWith(letter)) {
							setCursor(at);
							break;
						}
					}
				}
		}
	}

	function onPointer(e: React.MouseEvent): void {
		const last = pointerRef.current;
		pointerRef.current = { x: e.clientX, y: e.clientY };
		if (!last || (last.x === e.clientX && last.y === e.clientY)) {
			return;
		}
		const row = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
		const index = row ? Number(row.dataset.row) : -1;
		if (index >= 0 && index !== cursor && !rows[index]?.disabled) {
			setCursor(index);
		}
	}

	let lastGroup: string | undefined;
	return createPortal(
		<div
			ref={menuRef}
			className={`conn-picker-menu select-pop${place.bottom !== undefined ? ' above' : ''}`}
			style={{ left: place.left, minWidth: place.minWidth, maxWidth: place.maxWidth, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}
			onKeyDown={onKeyDown}
			onMouseMove={onPointer}
			// A press inside must not blur the select's modal or start a drag behind it.
			onMouseDown={(e) => e.preventDefault()}
		>
			{showFilter && (
				<div className="conn-picker-filter">
					<Icon name="search" />
					<input
						ref={filterRef}
						value={filter}
						placeholder="Filter"
						aria-label="Filter"
						onMouseDown={(e) => e.stopPropagation()}
						onChange={(e) => { setFilter(e.target.value); setCursor(0); }}
					/>
				</div>
			)}
			<div ref={listRef} className="conn-picker-list" role="listbox" tabIndex={-1} aria-activedescendant={rows[cursor] ? `select-pop-${cursor}` : undefined}>
				{rows.length === 0 && <div className="conn-picker-empty">Nothing matches</div>}
				{rows.map((item, row) => {
					const heading = item.group !== undefined && item.group !== lastGroup ? item.group : undefined;
					lastGroup = item.group;
					const selected = item.index === el.selectedIndex;
					return (
						<div key={item.index}>
							{heading !== undefined && <div className="select-pop-group">{heading}</div>}
							<div
								id={`select-pop-${row}`}
								data-row={row}
								role="option"
								aria-selected={selected}
								aria-disabled={item.disabled || undefined}
								className={`conn-picker-row${selected ? ' selected' : ''}${row === cursor ? ' cursor' : ''}${item.disabled ? ' disabled' : ''}`}
								onClick={() => pick(item)}
							>
								<span className="select-pop-label">{item.label}</span>
								<span className="conn-picker-check">{selected && <Icon name="check" />}</span>
							</div>
						</div>
					);
				})}
			</div>
		</div>,
		document.body,
	);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { ConnectionMarks, ConnectionTags } from './ConnectionMarks';
import type { ConnectionConfig } from '../../../shared/connection';
import { engineDisplayName } from '../../../shared/engine';

// The connection picker: the editor toolbar's, the assistant composer's and Orbit's. It used to be
// a native <select>, which can draw text and nothing else, so a PROD connection looked like any
// other and the driver glyph the sidebar shows was missing. Every row here is drawn from the same
// pieces as the sidebar's row (ConnectionMarks / ConnectionTags), so the two always agree.
//
// It changes NOTHING by being opened, closed, filtered or arrowed through. `onChange` fires once,
// on a pick of a DIFFERENT connection, exactly when the native select's change event did: the
// callers hang a lot on it (binding the tab, connecting on select, re-grounding the assistant,
// redrawing Orbit), and none of that should run because somebody looked at the list.

/** Past this many connections the list gets a filter box, focused as it opens. */
const FILTER_AT = 7;

/** The gap between the trigger and the list, and the least room kept to the window's edge. */
const GAP = 4;
const MARGIN = 8;

/** The list's width: never narrower than this (or the trigger), and grows with the names to the cap. */
const MIN_WIDTH = 320;
const MAX_WIDTH = 520;

interface ConnectionPickerProps {
	connections: ConnectionConfig[];
	isConnected(id: string): boolean;
	/** The chosen connection's id, or undefined for none. */
	value: string | undefined;
	/** Called only when the pick differs from `value`. */
	onChange(id: string | undefined): void;
	/** Offer a "no connection" row with this label. Omitted, a connection must be chosen. */
	noneLabel?: string;
	/** Said on the trigger when nothing is chosen and there is no `noneLabel`. */
	placeholder?: string;
	/** The trigger's tooltip: what this connection is FOR here. */
	title: string;
	/** A "New Connection…" row under the list. */
	onAdd?(): void;
	/** Extra class on the wrapper, for a surface that sizes it differently. */
	className?: string;
	disabled?: boolean;
}

interface Placement {
	left: number;
	minWidth: number;
	maxWidth: number;
	maxHeight: number;
	top?: number;
	bottom?: number;
}

/** One pickable row: a connection, or the "no connection" row (id undefined). */
interface Row {
	key: string;
	id: string | undefined;
	config?: ConnectionConfig;
}

function matches(config: ConnectionConfig, needle: string): boolean {
	const haystack = `${config.label} ${config.environment ?? ''} ${engineDisplayName(config.driver, config.flavor)} ${config.host ?? ''}`.toLowerCase();
	return needle.split(/\s+/).every((word) => haystack.includes(word));
}

export function ConnectionPicker(props: ConnectionPickerProps): JSX.Element {
	const { connections, isConnected, value, onChange, noneLabel, placeholder, title, onAdd, className, disabled } = props;
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState('');
	const [cursor, setCursor] = useState(0);
	const [place, setPlace] = useState<Placement | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const filterRef = useRef<HTMLInputElement>(null);
	/** Where the pointer was when it last moved over the list, or null since it opened. */
	const pointerRef = useRef<{ x: number; y: number } | null>(null);

	const current = connections.find((c) => c.id === value);
	const showFilter = connections.length >= FILTER_AT;

	const rows = useMemo<Row[]>(() => {
		const needle = filter.trim().toLowerCase();
		const listed = connections
			.filter((c) => !needle || matches(c, needle))
			.map((c) => ({ key: c.id, id: c.id, config: c }));
		return noneLabel !== undefined && !needle ? [{ key: '', id: undefined }, ...listed] : listed;
	}, [connections, filter, noneLabel]);

	// Under the trigger, as wide as it at least and otherwise as wide as the names need, up to a
	// cap; above it when the window has more room there (the assistant's composer sits at the
	// bottom of the app).
	const reposition = useCallback((): void => {
		const el = triggerRef.current;
		if (!el) {
			return;
		}
		const r = el.getBoundingClientRect();
		const room = window.innerWidth - 2 * MARGIN;
		const maxWidth = Math.min(MAX_WIDTH, room);
		const minWidth = Math.min(Math.max(r.width, MIN_WIDTH), maxWidth);
		// Kept on screen at its widest, so growing to fit a long name never runs it off the edge.
		const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - maxWidth - MARGIN));
		const below = window.innerHeight - r.bottom - GAP - MARGIN;
		const above = r.top - GAP - MARGIN;
		setPlace(below >= 240 || below >= above
			? { left, minWidth, maxWidth, top: r.bottom + GAP, maxHeight: Math.min(420, below) }
			: { left, minWidth, maxWidth, bottom: window.innerHeight - r.top + GAP, maxHeight: Math.min(420, above) });
	}, []);

	function openMenu(): void {
		if (disabled) {
			return;
		}
		setFilter('');
		// Start on the chosen row, so Enter on an unchanged list is a no-op rather than a switch.
		// The filter was just cleared, so the rows are the whole list: the none row, then each one.
		const offset = noneLabel !== undefined ? 1 : 0;
		const at = connections.findIndex((c) => c.id === value);
		setCursor(at >= 0 ? at + offset : 0);
		pointerRef.current = null;
		reposition();
		setOpen(true);
	}

	const close = useCallback((refocus: boolean): void => {
		setOpen(false);
		if (refocus) {
			triggerRef.current?.focus();
		}
	}, []);

	function pick(row: Row): void {
		close(true);
		if (row.id !== value) {
			onChange(row.id);
		}
	}

	// Outside clicks close it; the window moving under it keeps it pinned to the trigger.
	useEffect(() => {
		if (!open) {
			return;
		}
		function onDown(e: MouseEvent): void {
			const t = e.target as Node;
			if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) {
				close(false);
			}
		}
		function onMove(e: Event): void {
			// Scrolling the list itself is not the trigger moving.
			if (e.target instanceof Node && menuRef.current?.contains(e.target)) {
				return;
			}
			reposition();
		}
		// The app losing focus closes it, the way a native popup does.
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
	}, [open, reposition, close]);

	// Focus goes into the list as it opens: the filter when there is one, the list otherwise, so
	// the arrow keys work at once.
	useLayoutEffect(() => {
		if (open) {
			(showFilter ? filterRef.current : listRef.current)?.focus();
		}
	}, [open, showFilter]);

	// Keep the cursor's row in view as it moves.
	useEffect(() => {
		if (open) {
			listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
		}
	}, [open, cursor]);

	function onKeyDown(e: React.KeyboardEvent): void {
		// Everything here is the list's; none of it may reach the app's own shortcuts (Escape
		// closes panels, Enter runs a query).
		e.stopPropagation();
		const last = rows.length - 1;
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				setCursor((c) => (c >= last ? 0 : c + 1));
				break;
			case 'ArrowUp':
				e.preventDefault();
				setCursor((c) => (c <= 0 ? last : c - 1));
				break;
			case 'Home':
				if (!showFilter) {
					e.preventDefault();
					setCursor(0);
				}
				break;
			case 'End':
				if (!showFilter) {
					e.preventDefault();
					setCursor(last);
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
		}
	}

	/**
	 * The pointer moves the cursor only when it really MOVES. The list opens under wherever the
	 * mouse was resting, and Chromium sends a mousemove when the layout changes under a still
	 * pointer, which would snatch the cursor from the keyboard the moment the list appeared.
	 */
	function onPointer(e: React.MouseEvent): void {
		const last = pointerRef.current;
		pointerRef.current = { x: e.clientX, y: e.clientY };
		if (!last || (last.x === e.clientX && last.y === e.clientY)) {
			return;
		}
		const row = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
		const index = row ? Number(row.dataset.index) : -1;
		if (index >= 0 && index !== cursor) {
			setCursor(index);
		}
	}

	function onTriggerKey(e: React.KeyboardEvent): void {
		if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
			e.preventDefault();
			openMenu();
		}
	}

	const isProd = current?.environment === 'prod';
	const triggerLabel = current ? current.label : (noneLabel ?? placeholder ?? "Choose a connection");

	return (
		<span className={`conn-picker${className ? ` ${className}` : ''}`}>
			<button
				type="button"
				ref={triggerRef}
				className={`conn-picker-btn${open ? ' open' : ''}${isProd ? ' prod' : ''}`}
				title={title}
				disabled={disabled}
				role="combobox"
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => (open ? close(false) : openMenu())}
				onKeyDown={onTriggerKey}
			>
				{current
					? <ConnectionMarks config={current} connected={isConnected(current.id)} />
					: <span className="dot"><Icon name="circle-outline" /></span>}
				<span className={`conn-picker-label${isProd ? ' prod' : ''}${current ? '' : ' none'}`}>{triggerLabel}</span>
				{current && <ConnectionTags config={current} />}
				<Icon name="chevron-down" className="conn-picker-chevron" />
			</button>
			{open && place && createPortal(
				<div
					ref={menuRef}
					className={`conn-picker-menu${place.bottom !== undefined ? ' above' : ''}`}
					style={{ left: place.left, minWidth: place.minWidth, maxWidth: place.maxWidth, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}
					onKeyDown={onKeyDown}
					onMouseMove={onPointer}
				>
					{showFilter && (
						<div className="conn-picker-filter">
							<Icon name="search" />
							<input
								ref={filterRef}
								value={filter}
								placeholder="Filter connections"
								aria-label="Filter connections"
								onChange={(e) => { setFilter(e.target.value); setCursor(0); }}
							/>
						</div>
					)}
					<div
						ref={listRef}
						className="conn-picker-list"
						role="listbox"
						tabIndex={-1}
						aria-label={title}
						aria-activedescendant={rows[cursor] ? `conn-picker-opt-${cursor}` : undefined}
					>
						{rows.length === 0 && <div className="conn-picker-empty">{connections.length === 0 ? "No connections yet" : "Nothing matches"}</div>}
						{rows.map((row, index) => {
							const selected = row.id === value;
							const connected = row.id !== undefined && isConnected(row.id);
							const prod = row.config?.environment === 'prod';
							return (
								<div
									key={row.key}
									id={`conn-picker-opt-${index}`}
									data-index={index}
									role="option"
									aria-selected={selected}
									className={`conn-picker-row${selected ? ' selected' : ''}${index === cursor ? ' cursor' : ''}`}
									title={row.config ? `${row.config.label}${connected ? '' : ' (not connected)'}` : undefined}
									onClick={() => pick(row)}
								>
									{row.config
										? <ConnectionMarks config={row.config} connected={connected} />
										: <><span className="dot"><Icon name="circle-slash" /></span><span className="driver-gap" /></>}
									<span className={`conn-picker-label${prod ? ' prod' : ''}${row.config ? '' : ' none'}`}>{row.config ? row.config.label : noneLabel}</span>
									{row.config && <ConnectionTags config={row.config} />}
									<span className="conn-picker-meta">
										{row.config ? engineDisplayName(row.config.driver, row.config.flavor) : ''}
									</span>
									<span className="conn-picker-check">{selected && <Icon name="check" />}</span>
								</div>
							);
						})}
					</div>
					{onAdd && (
						<button type="button" className="conn-picker-add" onClick={() => { close(false); onAdd(); }}>
							<Icon name="add" /> New Connection…
						</button>
					)}
				</div>,
				document.body,
			)}
		</span>
	);
}

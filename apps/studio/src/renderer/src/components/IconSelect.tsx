/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from './Icon';

/*
 * A <select> that can show a glyph on every row, and that looks like the rest of the app.
 *
 * A native <select> cannot do either. Its option list is drawn by the OPERATING SYSTEM: it takes no
 * markup, so an icon per row is impossible, and it takes none of our tokens either, so on macOS the
 * driver picker opened a grey system menu in the middle of a dark gold modal — visibly a different
 * application, which is the exact thing the design system exists to prevent.
 *
 * So this is a button plus a popup listbox. It is deliberately NOT a general replacement for every
 * select in the app: a native control is the right answer for a plain list of words, and it comes
 * with keyboard behaviour, accessibility and platform conventions for free. This exists for the one
 * case where the rows carry meaning a word does not — here, what KIND of backend each driver is.
 *
 * What it has to re-implement, because leaving any of it out is what makes a custom picker worse
 * than the native one it replaced: arrow/Home/End navigation, Enter and Escape, type-ahead, closing
 * on an outside click or on blur, scrolling the active row into view, and the ARIA roles a screen
 * reader needs to announce it as a combobox rather than as a button next to a list of divs.
 */

export interface IconSelectOption {
	value: string;
	label: string;
	/** Icon name, as `<Icon/>` takes it (a Codicon name, or `brand:<id>`). */
	icon: string;
	/** Heading this option sits under. Consecutive options sharing one are grouped beneath it. */
	group?: string;
}

interface IconSelectProps {
	value: string;
	options: readonly IconSelectOption[];
	onChange(value: string): void;
	/** Labels the control for assistive tech, since the visible label is a sibling, not a wrapper. */
	ariaLabel?: string;
	className?: string;
}

/** How long a type-ahead buffer survives without another keystroke, matching the platform's own. */
const TYPEAHEAD_MS = 800;

export function IconSelect({ value, options, onChange, ariaLabel, className }: IconSelectProps): JSX.Element {
	const [open, setOpen] = useState(false);
	const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
	// Which row the keyboard is on. It follows the selection each time the popup opens, so arrowing
	// starts from what is selected rather than from wherever it was left last time.
	const [active, setActive] = useState(selectedIndex);
	const wrapper = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 });
	const selected = options[selectedIndex];

	// Rows, with each group's heading emitted before its first member.
	const rows = useMemo(() => {
		const out: { option: IconSelectOption; index: number; heading?: string }[] = [];
		let current: string | undefined;
		options.forEach((option, index) => {
			const heading = option.group && option.group !== current ? option.group : undefined;
			current = option.group;
			out.push({ option, index, heading });
		});
		return out;
	}, [options]);

	useEffect(() => {
		if (!open) {
			return;
		}
		setActive(selectedIndex);
		function onPointerDown(event: MouseEvent): void {
			if (!wrapper.current?.contains(event.target as Node)) {
				setOpen(false);
			}
		}
		// `mousedown`, not `click`: a click that starts outside and ends inside should still close,
		// and waiting for `click` lets a drag-select inside the modal reopen it.
		document.addEventListener('mousedown', onPointerDown);
		return () => document.removeEventListener('mousedown', onPointerDown);
	}, [open, selectedIndex]);

	// Keep the active row visible. Without this, arrowing past the fold moves a selection nobody
	// can see, which is the commonest way a hand-rolled listbox is worse than the native one.
	useEffect(() => {
		if (!open) {
			return;
		}
		list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [open, active]);

	function choose(index: number): void {
		const option = options[index];
		if (option) {
			onChange(option.value);
		}
		setOpen(false);
		button.current?.focus();
	}

	/** Move `delta` rows, stopping at the ends rather than wrapping (the platform behaviour). */
	function move(delta: number): void {
		setActive((current) => Math.min(options.length - 1, Math.max(0, current + delta)));
	}

	/** Jump to the next option whose label starts with what has just been typed. */
	function typeAhead(key: string): boolean {
		if (key.length !== 1 || key === ' ') {
			return false;
		}
		const now = Date.now();
		const text = (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : '') + key.toLowerCase();
		typed.current = { text, at: now };
		// Search from just after the active row so repeated presses of one letter cycle through the
		// options starting with it, which is what every native picker does.
		const start = text.length === 1 ? active + 1 : active;
		for (let step = 0; step < options.length; step += 1) {
			const index = (start + step) % options.length;
			if (options[index].label.toLowerCase().startsWith(text)) {
				setActive(index);
				if (!open) {
					choose(index);
				}
				return true;
			}
		}
		return true;
	}

	function onKeyDown(event: React.KeyboardEvent): void {
		if (!open) {
			if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				setOpen(true);
				return;
			}
			if (typeAhead(event.key)) {
				event.preventDefault();
			}
			return;
		}
		switch (event.key) {
			case 'Escape':
				event.preventDefault();
				setOpen(false);
				button.current?.focus();
				return;
			case 'Enter':
			case ' ':
				event.preventDefault();
				choose(active);
				return;
			case 'ArrowDown':
				event.preventDefault();
				move(1);
				return;
			case 'ArrowUp':
				event.preventDefault();
				move(-1);
				return;
			case 'Home':
				event.preventDefault();
				setActive(0);
				return;
			case 'End':
				event.preventDefault();
				setActive(options.length - 1);
				return;
			case 'Tab':
				// Tab commits and moves on, as a native select does, rather than leaving a popup
				// floating over the next field.
				choose(active);
				return;
			default:
				if (typeAhead(event.key)) {
					event.preventDefault();
				}
		}
	}

	return (
		<div className={`icon-select${className ? ` ${className}` : ''}`} ref={wrapper}>
			<button
				type="button"
				ref={button}
				className="icon-select-button"
				role="combobox"
				aria-expanded={open}
				aria-haspopup="listbox"
				aria-label={ariaLabel}
				onClick={() => setOpen((was) => !was)}
				onKeyDown={onKeyDown}
			>
				{selected && <Icon name={selected.icon} className="icon-select-mark" />}
				<span className="icon-select-value">{selected?.label ?? ''}</span>
				<Icon name="chevron-down" className="icon-select-chevron" />
			</button>
			{open && (
				<div className="icon-select-popup" role="listbox" aria-label={ariaLabel} ref={list} onKeyDown={onKeyDown} tabIndex={-1}>
					{rows.map(({ option, index, heading }) => (
						<div key={option.value}>
							{heading && <div className="icon-select-group">{heading}</div>}
							<div
								role="option"
								aria-selected={index === selectedIndex}
								data-active={index === active}
								className={`icon-select-option${index === selectedIndex ? ' selected' : ''}`}
								// `mousedown` rather than `click` so the choice lands before the button
								// loses focus and the outside-click handler closes the popup under it.
								onMouseDown={(event) => { event.preventDefault(); choose(index); }}
								onMouseEnter={() => setActive(index)}
							>
								<Icon name={option.icon} className="icon-select-mark" />
								<span className="icon-select-label">{option.label}</span>
								{index === selectedIndex && <Icon name="check" className="icon-select-tick" />}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

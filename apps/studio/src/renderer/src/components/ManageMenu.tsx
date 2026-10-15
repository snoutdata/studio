/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { THEMES, type Theme } from '../theme';
import type { ActivityBarPosition } from '../appSettings';

interface ManageMenuProps {
	/** Activity-bar orientation, which decides where the menu (and its submenus) open. */
	position: ActivityBarPosition;
	/** The active theme id (radio-checked in the Color Theme submenu). */
	theme: Theme;
	onSelectTheme(id: Theme): void;
	onOpenSettings(): void;
}

/** Viewport-anchored position for the `fixed` portal menu. */
interface Anchor {
	left?: number;
	right?: number;
	top?: number;
	bottom?: number;
}

/**
 * The activity bar's "Manage" gear: a VSCode-style menu rooted on the cog icon, with a Color
 * Theme submenu and a Settings item. New global actions slot in here as more menu items (or
 * their own submenus) instead of piling up as standalone activity-bar icons.
 */
export function ManageMenu(props: ManageMenuProps): JSX.Element {
	const [open, setOpen] = useState(false);
	const [submenu, setSubmenu] = useState<string | null>(null);
	const [anchor, setAnchor] = useState<Anchor | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const submenuRef = useRef<HTMLDivElement>(null);
	const [submenuTop, setSubmenuTop] = useState<number | null>(null);

	// Anchor the menu to the gear, in viewport coordinates (the menu is `fixed`). In the top bar
	// the gear sits top-right, so the menu drops below right-aligned; in the side strip it sits
	// bottom-left, so the menu pops up to the right, bottom-aligned.
	function reposition(): void {
		const el = btnRef.current;
		if (!el) {
			return;
		}
		const r = el.getBoundingClientRect();
		if (props.position === 'top') {
			setAnchor({ right: window.innerWidth - r.right, top: r.bottom + 4 });
		} else {
			setAnchor({ left: r.right + 4, bottom: window.innerHeight - r.bottom });
		}
	}

	// Close on a click outside, or on Escape; keep the menu pinned as the window resizes/scrolls.
	useEffect(() => {
		if (!open) {
			return;
		}
		function onDown(e: MouseEvent): void {
			const t = e.target as Node;
			if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) {
				setOpen(false);
			}
		}
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				setOpen(false);
			}
		}
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		window.addEventListener('resize', reposition);
		window.addEventListener('scroll', reposition, true);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
			window.removeEventListener('resize', reposition);
			window.removeEventListener('scroll', reposition, true);
		};
	}, [open]);

	// Clamp the open theme submenu vertically: measure its height and shift it up so it can't
	// spill past the bottom of the viewport (the gear sits near the screen bottom in the side
	// strip, so a tall theme list would otherwise hide rows under the edge). Mirrors the grid
	// context-menu submenu clamp.
	useLayoutEffect(() => {
		if (submenu !== 'theme') {
			setSubmenuTop(null);
			return;
		}
		const el = submenuRef.current;
		const parent = el?.parentElement;
		if (!el || !parent) {
			return;
		}
		const pRect = parent.getBoundingClientRect();
		const height = el.offsetHeight;
		const margin = 4;
		let viewTop = pRect.top - 5; // the CSS default (top: -5px) in viewport coords
		if (viewTop + height > window.innerHeight - margin) {
			viewTop = window.innerHeight - margin - height;
		}
		if (viewTop < margin) {
			viewTop = margin;
		}
		setSubmenuTop(Math.round(viewTop - pRect.top));
	}, [submenu, anchor]);

	function toggle(): void {
		if (!open) {
			reposition();
		}
		setSubmenu(null);
		setOpen((o) => !o);
	}

	function chooseTheme(id: Theme): void {
		props.onSelectTheme(id);
		setOpen(false);
	}

	function openSettings(): void {
		props.onOpenSettings();
		setOpen(false);
	}

	// Open submenus toward the screen interior: to the left when the menu is right-aligned (top
	// bar), to the right when it hugs the left strip.
	const submenuSide = props.position === 'top' ? 'left' : 'right';

	return (
		<>
			<button
				ref={btnRef}
				className={`activity-item${open ? ' active' : ''}`}
				aria-label="Manage"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={toggle}
			>
				<Icon name="gear" />
			</button>
			{open && anchor && createPortal(
				<div className="manage-menu ctx-menu" ref={menuRef} style={anchor} role="menu">
					<div
						className="ctx-menu-item has-submenu"
						role="menuitem"
						aria-haspopup="menu"
						onMouseEnter={() => setSubmenu('theme')}
						onClick={() => setSubmenu('theme')}
					>
						<span className="ctx-label"><Icon name="paintcan" /> Color Theme</span>
						<Icon name="chevron-right" />
						{submenu === 'theme' && (
							<div ref={submenuRef} className={`ctx-menu submenu submenu-${submenuSide}`} role="menu" style={{ top: submenuTop ?? undefined, visibility: submenuTop === null ? 'hidden' : undefined }}>
								{THEMES.map((t) => (
									<button
										type="button"
										role="menuitemradio"
										aria-checked={t.id === props.theme}
										key={t.id}
										className="ctx-menu-item"
										onClick={() => chooseTheme(t.id)}
									>
										<span className="ctx-label">
											<span className="ctx-check">{t.id === props.theme && <Icon name="check" />}</span>
											{t.label}
										</span>
									</button>
								))}
							</div>
						)}
					</div>
					<button
						type="button"
						role="menuitem"
						className="ctx-menu-item"
						onMouseEnter={() => setSubmenu(null)}
						onClick={openSettings}
					>
						<span className="ctx-label"><Icon name="settings-gear" /> Settings</span>
					</button>
				</div>,
				document.body,
			)}
		</>
	);
}

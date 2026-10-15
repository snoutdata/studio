/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react';
import type { AppMenu, AppMenuItem } from '../../../shared/menu';
import { Icon } from './Icon';
import { formatAccelerator } from '../shortcuts';

/**
 * The app's own title bar.
 *
 * The window is frameless, so this strip IS the caption: it carries the drag region, the app
 * mark, the title, and — on Windows and Linux, where a frameless window has no native menu bar —
 * the application menu, drawn from the model main serializes out of the very template it gives
 * Electron.
 *
 * macOS is deliberately different. Its traffic lights stay native (the window is `hiddenInset`)
 * and its menu bar stays in the system bar where the platform puts it, so there this strip is
 * only the drag region and the title, indented past the lights.
 */
export function TitleBar(props: { title?: string; onCommand(id: string): void }): JSX.Element {
	const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
	const [menus, setMenus] = useState<AppMenu[]>([]);
	const [open, setOpen] = useState<number | null>(null);
	const barRef = useRef<HTMLDivElement | null>(null);

	// The menu is only drawn where the native one is gone. Fetched once, after mount: it is not
	// needed to paint the window and startup is sacred.
	useEffect(() => {
		if (isMac) {
			return;
		}
		let alive = true;
		void window.sqlApi?.menuModel().then((model) => {
			if (alive) {
				setMenus(model);
			}
		}).catch(() => { /* no menu is better than a broken boot */ });
		return () => { alive = false; };
	}, [isMac]);

	// Click-away and Escape close the open menu. Pointerdown rather than click so the menu is
	// already gone by the time the click lands on whatever is underneath it.
	useEffect(() => {
		if (open === null) {
			return;
		}
		function onDown(event: PointerEvent): void {
			if (!barRef.current?.contains(event.target as Node)) {
				setOpen(null);
			}
		}
		function onKey(event: KeyboardEvent): void {
			if (event.key === 'Escape') {
				setOpen(null);
			}
		}
		document.addEventListener('pointerdown', onDown, true);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('pointerdown', onDown, true);
			document.removeEventListener('keydown', onKey);
		};
	}, [open]);

	function run(item: AppMenuItem): void {
		setOpen(null);
		if (item.commandId) {
			props.onCommand(item.commandId);
			return;
		}
		if (item.role) {
			void window.sqlApi?.menuRole(item.role);
		}
	}

	return (
		<div className={`titlebar${isMac ? ' titlebar-mac' : ''}`} ref={barRef}>
			<div className="titlebar-left">
				{!isMac && <Icon name="database" className="titlebar-mark" />}
				{menus.map((menu, index) => (
					<div className="titlebar-menu" key={menu.label}>
						<button
							type="button"
							className={`titlebar-menu-btn${open === index ? ' open' : ''}`}
							aria-haspopup="menu"
							aria-expanded={open === index}
							onClick={() => setOpen(open === index ? null : index)}
							// Once one menu is open, sliding across the bar opens the next, which is
							// what every menu bar does and what the hand expects.
							onPointerEnter={() => { if (open !== null) { setOpen(index); } }}
						>
							{menu.label}
						</button>
						{open === index && (
							<div className="ctx-menu titlebar-dropdown" role="menu">
								{menu.items.map((item, i) => item.separator
									? <div className="ctx-sep" key={`sep-${i}`} />
									: (
										<button
											type="button"
											className="ctx-menu-item"
											role="menuitem"
											key={`${item.label}-${i}`}
											onClick={() => run(item)}
										>
											<span className="ctx-label">{item.icon ? <Icon name={item.icon} /> : <span className="ctx-icon-gap" aria-hidden="true" />}{item.label}</span>
											{item.accelerator && <span className="shortcut">{formatAccelerator(item.accelerator)}</span>}
										</button>
									))}
							</div>
						)}
					</div>
				))}
			</div>
			{/* The only part of the strip that drags the window: a menu bar you cannot click
			    because you dragged the window instead is worse than a smaller drag target. */}
			<div className="titlebar-drag">
				<span className="titlebar-title">{props.title ? `${props.title} · SnoutData Studio` : "SnoutData Studio"}</span>
			</div>
		</div>
	);
}

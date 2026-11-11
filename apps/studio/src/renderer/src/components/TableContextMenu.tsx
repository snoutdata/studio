/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { useT } from '../i18n';

interface TableContextMenuProps {
	/** Where the click was, in viewport coordinates. */
	at: { x: number; y: number };
	/** A production connection that has not been unlocked: the item shows, and says why it is off. */
	dropLocked: boolean;
	onDrop(): void;
	onClose(): void;
}

/** The right-click menu of a table row in the schema tree. Portalled, because the tree lives in a
 *  dock that can sit anywhere in the window. */
export function TableContextMenu({ at, dropLocked, onDrop, onClose }: TableContextMenuProps): JSX.Element {
	const t = useT();
	const ref = useRef<HTMLDivElement | null>(null);
	const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

	useEffect(() => {
		const away = (event: MouseEvent): void => {
			if (ref.current && !ref.current.contains(event.target as Node)) {
				onClose();
			}
		};
		const key = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				onClose();
			}
		};
		// Capture, so a click that also opens something else still closes this first.
		document.addEventListener('mousedown', away, true);
		document.addEventListener('keydown', key);
		return () => {
			document.removeEventListener('mousedown', away, true);
			document.removeEventListener('keydown', key);
		};
	}, [onClose]);

	// Clamp inside the viewport once the real size is known, before the browser paints.
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const rect = element.getBoundingClientRect();
		const margin = 4;
		setPosition({
			x: Math.max(margin, Math.min(at.x, window.innerWidth - rect.width - margin)),
			y: Math.max(margin, Math.min(at.y, window.innerHeight - rect.height - margin)),
		});
	}, [at.x, at.y]);

	return createPortal(
		<div
			ref={ref}
			className="ctx-menu"
			role="menu"
			style={{ position: 'fixed', left: position?.x ?? at.x, top: position?.y ?? at.y, visibility: position ? 'visible' : 'hidden' }}
		>
			<button
				type="button"
				role="menuitem"
				className="ctx-menu-item"
				disabled={dropLocked}
				title={dropLocked ? t('shell.sidebar.dropTableLocked') : undefined}
				onClick={() => { onClose(); onDrop(); }}
			>
				<span className="ctx-label"><Icon name="trash" />{t('shell.sidebar.dropTable')}</span>
			</button>
		</div>,
		document.body,
	);
}

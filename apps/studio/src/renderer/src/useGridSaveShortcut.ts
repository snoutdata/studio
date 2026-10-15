/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect } from 'react';

/**
 * While a grid has unsaved edits and is the foreground view, Ctrl/Cmd+S opens that grid's
 * save (the DML preview) instead of saving the SQL editor file. A capture-phase window
 * listener preempts the app-level "Save File" shortcut, and it is bound only while it should
 * act (active + dirty) so a clean or background grid never swallows Ctrl+S.
 */
export function useGridSaveShortcut(active: boolean, dirty: boolean, onSave: () => void): void {
	useEffect(() => {
		if (!active || !dirty) {
			return;
		}
		function onKey(e: KeyboardEvent): void {
			if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
				e.preventDefault();
				e.stopImmediatePropagation();
				onSave();
			}
		}
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [active, dirty, onSave]);
}

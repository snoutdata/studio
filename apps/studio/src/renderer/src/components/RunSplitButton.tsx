/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../i18n';

interface RunSplitButtonProps {
	disabled: boolean;
	onRun(): void;
	onRunNewTab(): void;
	onRunScript(): void;
	/** Explain the statement instead of running it. Absent on an engine whose dialect declares no
	 *  EXPLAIN variants, which is every engine but ClickHouse today. */
	onExplain?(): void;
}

/** The Run button plus a caret that opens the other ways to run: into a fresh result tab (the live
 *  tab is reused otherwise), every statement in turn, or not at all (Explain, where the engine has
 *  one). The caret shares the Run button's enabled state. */
export function RunSplitButton({ disabled, onRun, onRunNewTab, onRunScript, onExplain }: RunSplitButtonProps): JSX.Element {
	const t = useT();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		function onDown(e: MouseEvent): void {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		}
		window.addEventListener('mousedown', onDown);
		return () => window.removeEventListener('mousedown', onDown);
	}, [open]);

	return (
		<div className="run-split" ref={ref}>
			<button className="run" type="button" onClick={onRun} disabled={disabled} data-tour="run-button">
				<Icon name="play" /> {t('editor.common.run')}
			</button>
			<button
				className="run run-caret"
				type="button"
				title={t('editor.run.more')}
				disabled={disabled}
				onClick={() => setOpen((o) => !o)}
			>
				<Icon name="chevron-down" />
			</button>
			{open && (
				<div className="run-dropdown">
					<button type="button" className="run-item" onClick={() => { setOpen(false); onRunNewTab(); }}>
						<Icon name="empty-window" /> {t('editor.run.newTab')}
					</button>
					<button type="button" className="run-item" onClick={() => { setOpen(false); onRunScript(); }} title={t('editor.run.scriptTitle')}>
						<Icon name="run-all" /> {t('editor.run.script')}
					</button>
					{onExplain && (
						<button type="button" className="run-item" onClick={() => { setOpen(false); onExplain(); }} title={t('editor.run.explainTitle')}>
							<Icon name="list-tree" /> {t('editor.run.explain')}
						</button>
					)}
				</div>
			)}
		</div>
	);
}

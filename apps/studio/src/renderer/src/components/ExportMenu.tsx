/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import type { ExportFormat } from '../exportData';

/** Which rows to export: the loaded grid, or a fresh full run with no auto-LIMIT. */
export type ExportSource = 'current' | 'full';

/** Clipboard copy formats for the current grid. */
export type CopyFormat = 'tsv' | 'csv';

interface ExportMenuProps {
	/** The grid holds a successful result that can be exported as-is. */
	hasResults: boolean;
	/** A connected query is available to re-run for the full (no auto-LIMIT) export. */
	canRunFull: boolean;
	onExport(format: ExportFormat, source: ExportSource): void;
	/** Copy the current grid to the clipboard in the given format. */
	onCopy(format: CopyFormat): void;
	/**
	 * The formats this engine will write a whole result in ITSELF, if it will.
	 *
	 * A different thing from the two groups above and not a third serializer: the statement runs
	 * again and the server streams its answer to the file, so the rows never reach the app and the
	 * size of the export stops mattering. Empty for every engine that cannot (`bulkFormatsFor`).
	 */
	serverFormats?: readonly { id: string; label: string }[];
	onServerExport?(formatId: string): void;
}

/** Results-header dropdown: copy the current grid to the clipboard, or export the current
 *  grid / the full query to a file, as CSV/JSON. */
export function ExportMenu({ hasResults, canRunFull, onExport, onCopy, serverFormats = [], onServerExport }: ExportMenuProps): JSX.Element {
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

	function pick(format: ExportFormat, source: ExportSource): void {
		setOpen(false);
		onExport(format, source);
	}

	function copy(format: CopyFormat): void {
		setOpen(false);
		onCopy(format);
	}

	function server(formatId: string): void {
		setOpen(false);
		onServerExport?.(formatId);
	}

	return (
		<div className="export-menu" ref={ref}>
			{/* The server-side group needs a connection and a statement, not rows in the grid: its
			    whole point is exporting what is too big to have run into the grid. So the trigger
			    opens for that too, and the items that DO need a loaded result say so themselves. */}
			<button className="export-trigger" title="Export results" disabled={!hasResults && !(serverFormats.length > 0 && canRunFull)} onClick={() => setOpen((o) => !o)}>
				<Icon name="cloud-download" /> Export <Icon name="chevron-down" className="caret" />
			</button>
			{open && (
				<div className="export-dropdown">
					<div className="export-group">Copy to clipboard</div>
					<button type="button" className="export-item" disabled={!hasResults} onClick={() => copy('tsv')}>TSV</button>
					<button type="button" className="export-item" disabled={!hasResults} onClick={() => copy('csv')}>CSV</button>
					<div className="export-group">Data in grid</div>
					<button type="button" className="export-item" disabled={!hasResults} onClick={() => pick('csv', 'current')}>CSV</button>
					<button type="button" className="export-item" disabled={!hasResults} onClick={() => pick('json', 'current')}>JSON</button>
					<button type="button" className="export-item" disabled={!hasResults} onClick={() => pick('xlsx', 'current')}>Excel</button>
					<div className="export-group">Full data <span className="muted">- no limit</span></div>
					<button type="button" className="export-item" disabled={!canRunFull} onClick={() => pick('csv', 'full')}>CSV</button>
					<button type="button" className="export-item" disabled={!canRunFull} onClick={() => pick('json', 'full')}>JSON</button>
					<button type="button" className="export-item" disabled={!canRunFull} onClick={() => pick('xlsx', 'full')}>Excel</button>
					{serverFormats.length > 0 && onServerExport && (
						<>
							<div className="export-group">Straight from the server <span className="muted">- any size</span></div>
							{serverFormats.map((f) => (
								<button type="button" key={f.id} className="export-item" disabled={!canRunFull} onClick={() => server(f.id)}>{f.label}</button>
							))}
						</>
					)}
				</div>
			)}
		</div>
	);
}

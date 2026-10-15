/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';
import { cellText } from './DataGrid';
import type { FkPeekData } from '../useFkLookup';

// The hover/right-click peek card for a foreign-key cell: shows the referenced row's handful
// of fields (fetched by PK), a spinner while loading, and an "Open in new tab" action that
// navigates to the referenced row. Purely presentational — DataGrid owns its placement and
// the hover lifecycle; the data + querying come from useFkLookup.

interface FkPeekCardProps {
	/** Referenced table name, shown in the header (e.g. "customers"). */
	refTable: string;
	/** The looked-up key value, shown in the header (e.g. the FK id). */
	value: unknown;
	data: FkPeekData | undefined;
	/** "Open in new tab" — navigate to the referenced row. */
	onOpen(): void;
}

export function FkPeekCard({ refTable, value, data, onOpen }: FkPeekCardProps): JSX.Element {
	return (
		<div className="fk-peek">
			<div className="fk-peek-head">
				<Icon name="references" />
				<span className="fk-peek-title">{refTable}</span>
				<span className="fk-peek-key">#{cellText(value) ?? ''}</span>
			</div>
			{(!data || data.status === 'loading') && (
				<div className="fk-peek-body fk-peek-loading"><Icon name="loading" className="spin" /> Loading…</div>
			)}
			{data?.status === 'error' && (
				<div className="fk-peek-body fk-peek-error">{data.error}</div>
			)}
			{data?.status === 'done' && data.columns && data.values && (
				<div className="fk-peek-body">
					{data.columns.map((col, i) => {
						const text = cellText(data.values![i]);
						return (
							<div className="fk-peek-row" key={col}>
								<span className="fk-peek-col">{col}</span>
								<span className={`fk-peek-val${text === null ? ' null' : ''}`}>{text === null ? 'NULL' : text}</span>
							</div>
						);
					})}
				</div>
			)}
			<button type="button" className="fk-peek-open" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onOpen(); }}>
				<Icon name="link-external" /> Open in new tab
			</button>
		</div>
	);
}

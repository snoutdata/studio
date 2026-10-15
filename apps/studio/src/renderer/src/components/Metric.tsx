/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';

/** One number with a label and a glyph, in a `--bg-card` tile. The table page's Telemetry tab
 *  and its ClickHouse Storage tab both lay out rows of these (`.metric-cards`), which is why it
 *  lives here rather than inside either of them. */
export function Metric({ icon, label, value, hint }: { icon: string; label: string; value: string; hint?: string }): JSX.Element {
	return (
		<div className="metric-card" title={hint ?? label}>
			<div className="metric-head"><Icon name={icon} /> <span className="metric-label">{label}</span></div>
			<div className="metric-value">{value}</div>
		</div>
	);
}

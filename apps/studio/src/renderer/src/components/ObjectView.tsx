/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';
import type { RoutineParam } from '../../../shared/schema';

// A read-only detail view for a non-table database object: a stored procedure, a
// function, or a trigger. Double-clicking one in the explorer opens it here, mirroring
// the table's Properties pane: a header, a small metadata table, a parameters list (for
// routines), and the full CREATE DDL. The object's definition is carried on the schema
// (RoutineInfo.definition / TriggerInfo.statement), so this view owns no data fetching.

/** The kind of object shown. Drives the header icon and the labels. */
export type ObjectKind = 'procedure' | 'function' | 'trigger';

/** A normalized, self-contained payload the explorer builds from the schema. */
export interface ObjectDetail {
	connectionId: string;
	kind: ObjectKind;
	schema?: string;
	name: string;
	/** Key/value rows shown above the DDL (type, returns, timing, table, …). */
	meta: { label: string; value: string }[];
	/** Routine parameters, when the object is a procedure/function. */
	parameters?: RoutineParam[];
	/** Full CREATE statement / body. Absent when the source DB didn't expose it. */
	ddl?: string;
}

const ICONS: Record<ObjectKind, string> = {
	procedure: 'symbol-misc',
	function: 'symbol-method',
	trigger: 'symbol-event',
};

export function ObjectView({ detail }: { detail: ObjectDetail }): JSX.Element {
	const qualified = detail.schema ? `${detail.schema}.${detail.name}` : detail.name;
	const params = detail.parameters ?? [];
	return (
		<div className="table-view">
			<div className="tv-head">
				<Icon name={ICONS[detail.kind]} className="tv-head-icon" />
				<span className="tv-title">{qualified}</span>
				<span className="muted">{detail.kind}</span>
			</div>
			<div className="object-detail">
				{detail.meta.length > 0 && (
					<div className="prop-table object-meta">
						{detail.meta.map((m) => (
							<div className="pt-row" key={m.label}>
								<span className="muted">{m.label}</span>
								<span>{m.value}</span>
							</div>
						))}
					</div>
				)}

				{detail.parameters !== undefined && (
					<>
						<div className="object-section-title">Parameters</div>
						{params.length === 0
							? <div className="prop-empty">No parameters.</div>
							: (
								<div className="prop-table">
									<div className="pt-row pt-head"><span>Name</span><span>Type</span><span>Mode</span></div>
									{params.map((p, i) => (
										<div className="pt-row" key={i}>
											<span>{p.name || `(arg ${i + 1})`}</span>
											<span>{p.dataType}</span>
											<span>{p.mode ?? 'IN'}</span>
										</div>
									))}
								</div>
							)}
					</>
				)}

				<div className="object-section-title">Definition</div>
				<pre className="ddl-view">{detail.ddl ?? '-- Definition not available.'}</pre>
			</div>
		</div>
	);
}

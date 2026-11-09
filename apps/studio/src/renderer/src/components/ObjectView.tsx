/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';
import type { RoutineParam } from '../../../shared/schema';
import { useT } from '../i18n';

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
	const t = useT();
	const kindLabel = { procedure: t('tables.object.procedure'), function: t('tables.object.function'), trigger: t('tables.object.trigger') }[detail.kind];
	const qualified = detail.schema ? `${detail.schema}.${detail.name}` : detail.name;
	const params = detail.parameters ?? [];
	return (
		<div className="table-view">
			<div className="tv-head">
				<Icon name={ICONS[detail.kind]} className="tv-head-icon" />
				<span className="tv-title">{qualified}</span>
				<span className="muted">{kindLabel}</span>
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
						<div className="object-section-title">{t('tables.object.parameters')}</div>
						{params.length === 0
							? <div className="prop-empty">{t('tables.object.noParameters')}</div>
							: (
								<div className="prop-table">
									<div className="pt-row pt-head"><span>{t('tables.common.name')}</span><span>{t('tables.common.type')}</span><span>{t('tables.object.mode')}</span></div>
									{params.map((p, i) => (
										<div className="pt-row" key={i}>
											<span>{p.name || t('tables.object.arg', { n: String(i + 1) })}</span>
											<span>{p.dataType}</span>
											<span>{p.mode ?? 'IN'}</span>
										</div>
									))}
								</div>
							)}
					</>
				)}

				<div className="object-section-title">{t('tables.object.definition')}</div>
				<pre className="ddl-view">{detail.ddl ?? t('tables.object.noDefinition')}</pre>
			</div>
		</div>
	);
}

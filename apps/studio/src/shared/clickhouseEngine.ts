/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Choosing a ClickHouse table's ENGINE, and writing the clause that follows it.
 *
 *  The designer wrote `ENGINE = MergeTree ORDER BY (key)` for every table it made, which is the
 *  one shape that is never wrong and is very often not what was wanted: no partitioning, no TTL,
 *  no deduplication, no compression choice. Those are not decorations on a ClickHouse table, they
 *  ARE the table.
 *
 *  Pure: the catalogue of engines with what each one does to a row, the clause an engine draft
 *  renders to, and the problems worth saying out loud BEFORE the statement is run. The designer
 *  (`TableProperties.tsx` through `renderer/src/ddl.ts`) does the rest.
 *
 *  Only the MergeTree family is offered. A Memory, Distributed, Kafka, S3 or Dictionary table is
 *  not a thing you reach for a table designer to make, and offering them would mean a different
 *  form for each.
 *--------------------------------------------------------------------------------------------*/

import { quoteClickHouseIdent } from './engine';
import { t } from './i18n/core';

/** One engine in the picker. `parameter` is the engine's own argument, where it takes one. */
export interface MergeTreeEngine {
	readonly id: string;
	readonly label: string;
	/** One line: what this engine does to a row, in the terms someone choosing would think in. */
	readonly hint: string;
	readonly parameter?: {
		readonly label: string;
		readonly placeholder: string;
		readonly hint: string;
		/** A CollapsingMergeTree without its sign column will not be created at all. */
		readonly required: boolean;
	};
}

export const MERGE_TREE_ENGINES: readonly MergeTreeEngine[] = [
	{
		id: 'MergeTree',
		label: 'MergeTree',
		get hint() { return t('engineShared.chEngine.mergeTree'); },
	},
	{
		id: 'ReplacingMergeTree',
		label: 'ReplacingMergeTree',
		get hint() { return t('engineShared.chEngine.replacing'); },
		parameter: {
			get label() { return t('engineShared.chEngine.versionColumn'); },
			placeholder: 'updated_at',
			get hint() { return t('engineShared.chEngine.versionHint'); },
			required: false,
		},
	},
	{
		id: 'SummingMergeTree',
		label: 'SummingMergeTree',
		get hint() { return t('engineShared.chEngine.summing'); },
		parameter: {
			get label() { return t('engineShared.chEngine.sumColumns'); },
			placeholder: 'amount, count',
			get hint() { return t('engineShared.chEngine.sumHint'); },
			required: false,
		},
	},
	{
		id: 'AggregatingMergeTree',
		label: 'AggregatingMergeTree',
		get hint() { return t('engineShared.chEngine.aggregating'); },
	},
	{
		id: 'CollapsingMergeTree',
		label: 'CollapsingMergeTree',
		get hint() { return t('engineShared.chEngine.collapsing'); },
		parameter: {
			get label() { return t('engineShared.chEngine.signColumn'); },
			placeholder: 'sign',
			get hint() { return t('engineShared.chEngine.signHint'); },
			required: true,
		},
	},
	{
		id: 'VersionedCollapsingMergeTree',
		label: 'VersionedCollapsingMergeTree',
		get hint() { return t('engineShared.chEngine.versioned'); },
		parameter: {
			get label() { return t('engineShared.chEngine.signVersionColumns'); },
			placeholder: 'sign, version',
			get hint() { return t('engineShared.chEngine.signVersionHint'); },
			required: true,
		},
	},
];

/** What the designer holds about the physical side of a new table. */
export interface EngineDraft {
	/** One of {@link MERGE_TREE_ENGINES}' ids. */
	engine: string;
	/** The engine's own argument, as typed; '' when it has none or none was given. */
	parameter: string;
	/** Write the table on every replica: a `Replicated*` engine plus `ON CLUSTER`. */
	replicated: boolean;
	/** The cluster to create on, when `replicated`. */
	cluster: string;
	partitionBy: string;
	ttl: string;
	/** Free text, as it would be typed after `SETTINGS`. */
	settings: string;
}

export function blankEngineDraft(): EngineDraft {
	return { engine: 'MergeTree', parameter: '', replicated: false, cluster: '', partitionBy: '', ttl: '', settings: '' };
}

export function engineById(id: string): MergeTreeEngine | undefined {
	return MERGE_TREE_ENGINES.find((engine) => engine.id === id);
}

/** Where a replicated table's metadata lives in Keeper. */
export interface ReplicaPath {
	database: string;
	table: string;
}

/**
 * `ENGINE = ... PARTITION BY ... ORDER BY ... TTL ... SETTINGS ...`, in the order ClickHouse
 * requires (PARTITION BY before ORDER BY; a clause out of order is a syntax error).
 *
 * `orderBy` is passed in rather than held on the draft: the sort key is the columns ticked as the
 * key in the designer's grid, so it has exactly one source and the engine form cannot disagree
 * with it.
 */
export function engineClause(draft: EngineDraft, orderBy: string, path: ReplicaPath): string {
	const parts = [`ENGINE = ${engineName(draft, path)}`];
	if (draft.partitionBy.trim() !== '') {
		parts.push(`PARTITION BY ${draft.partitionBy.trim()}`);
	}
	parts.push(`ORDER BY ${orderBy}`);
	if (draft.ttl.trim() !== '') {
		parts.push(`TTL ${draft.ttl.trim()}`);
	}
	if (draft.settings.trim() !== '') {
		parts.push(`SETTINGS ${draft.settings.trim()}`);
	}
	return parts.join('\n');
}

/**
 * `ReplacingMergeTree(updated_at)`, or its Replicated form.
 *
 * A Replicated engine's first two arguments are the Keeper path and this replica's name, and they
 * come BEFORE the engine's own. The path is written with the database and table spelled out and
 * only `{shard}` and `{replica}` left as macros: `{database}` and `{table}` are also substituted by
 * newer servers, but spelling them is exact on every version and is what the ClickHouse docs show.
 */
export function engineName(draft: EngineDraft, path: ReplicaPath): string {
	const args: string[] = [];
	if (draft.replicated) {
		args.push(`'/clickhouse/tables/{shard}/${path.database}/${path.table}'`, `'{replica}'`);
	}
	const parameter = draft.parameter.trim();
	if (parameter !== '') {
		args.push(parameter);
	}
	const name = `${draft.replicated ? 'Replicated' : ''}${draft.engine}`;
	return args.length > 0 ? `${name}(${args.join(', ')})` : name;
}

/** `ON CLUSTER x ` for a replicated table, or ''. Goes after the table name in CREATE. */
export function onClusterClause(draft: EngineDraft): string {
	return draft.replicated && draft.cluster.trim() !== '' ? ` ON CLUSTER ${quoteClickHouseIdent(draft.cluster.trim())}` : '';
}

/**
 * What is wrong, or worth knowing, before this statement is run. An engine that will not be
 * created at all is a `blocking` problem; the rest are things that are legal, do what they say,
 * and are almost never what was meant.
 */
export interface EngineProblem {
	readonly blocking: boolean;
	readonly message: string;
}

export function engineProblems(draft: EngineDraft, orderBy: string): EngineProblem[] {
	const out: EngineProblem[] = [];
	const engine = engineById(draft.engine);
	if (!engine) {
		return [{ blocking: true, message: t('engineShared.chEngine.unknownEngine', { engine: draft.engine }) }];
	}
	if (engine.parameter?.required && draft.parameter.trim() === '') {
		out.push({ blocking: true, message: t('engineShared.chEngine.needsParameter', { engine: engine.label, parameter: engine.parameter.label.toLowerCase(), hint: engine.parameter.hint }) });
	}
	// A key-less table is legal, and for every engine but plain MergeTree it means something
	// drastic: one row for the whole table, all of it summed into one, everything collapsed.
	if (isKeyless(orderBy) && draft.engine !== 'MergeTree') {
		out.push({
			blocking: false,
			message: t('engineShared.chEngine.noSortKey', { engine: engine.label }),
		});
	}
	if (draft.replicated && draft.cluster.trim() === '') {
		out.push({ blocking: true, message: t('engineShared.chEngine.needsCluster') });
	}
	if (draft.ttl.trim() !== '' && draft.partitionBy.trim() === '') {
		out.push({
			blocking: false,
			message: t('engineShared.chEngine.ttlNoPartition'),
		});
	}
	return out;
}

/** True when the sort key is `tuple()` - ClickHouse's way of saying "no order at all". */
function isKeyless(orderBy: string): boolean {
	return orderBy.trim().replace(/\s+/g, '') === 'tuple()';
}

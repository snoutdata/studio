/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the explorer shows under a partitioned table, and under a SnoutTime series table.
// Pure, so the tree's rules are tested without React.
//
// A partition is part of its parent: the schema group lists the parent only, and the parent gets
// a Partitions folder. For a series that folder carries what SnoutTime knows about each one
// (live, sealed, tiered) and what sealing saved; for a plain partitioned table it is the child
// tables, since Postgres alone says nothing more about them.

import type { DatabaseSchema, SeriesPartitionState, TableInfo } from '../../shared/schema';
import { formatBytes } from './formatBytes';

/** One row of a Partitions folder. */
export interface PartitionRow {
	schema?: string;
	name: string;
	/** Absent for a plain Postgres partition. */
	state?: SeriesPartitionState;
	/** The muted text beside the name: state, size, and the seal's saving. */
	detail: string;
	/** The hover: its range and estimated rows, where known. */
	title: string;
}

/** The children of every partitioned table, by `schema.name` of the parent. */
export function partitionsByParent(schema: DatabaseSchema): Map<string, TableInfo[]> {
	const out = new Map<string, TableInfo[]>();
	for (const t of schema.tables) {
		if (t.partitionOf) {
			const k = `${t.partitionOf.schema ?? ''}.${t.partitionOf.name}`;
			const list = out.get(k) ?? [];
			list.push(t);
			out.set(k, list);
		}
	}
	return out;
}

/** Whether the explorer lists a table in its schema group, or folds it under its parent. A
 *  rollup's materialized buckets are read through the rollup, and with SnoutTime installed its
 *  column stores' delta and delete tables (`snouttime_internal`) are not the user's to open. The
 *  `snouttime` schema itself stays: its views are worth reading (except on a SnoutData Cloud
 *  connection, where cloudPlatform.ts hides it with the other platform schemas). */
export function listedInSchema(table: TableInfo, schema?: DatabaseSchema): boolean {
	if (table.partitionOf || table.rollupStoreOf) {
		return false;
	}
	return !(schema?.snouttime && table.schema === 'snouttime_internal');
}

/** How much smaller, as `7.9×`, when both sides are known and it did shrink. */
export function ratioText(before: number | undefined, after: number | undefined): string | undefined {
	if (!before || !after || before <= 0 || after <= 0) {
		return undefined;
	}
	const r = before / after;
	return `${r >= 10 ? r.toFixed(0) : r.toFixed(1)}×`;
}

/**
 * The rows of a table's Partitions folder: a series' partitions newest first, as SnoutTime
 * reports them, or a plain partitioned table's child tables by name. Empty when it has none.
 */
export function partitionRows(table: TableInfo, children: TableInfo[] = []): PartitionRow[] {
	const series = table.series;
	if (series) {
		return [...series.partitions].reverse().map((p) => {
			const size = p.bytes !== undefined ? formatBytes(p.bytes) : undefined;
			const saved = p.bytesBefore !== undefined && p.bytes !== undefined
				? `${formatBytes(p.bytesBefore)} → ${size}${ratioText(p.bytesBefore, p.bytes) ? ` (${ratioText(p.bytesBefore, p.bytes)})` : ''}`
				: size;
			const range = p.rangeStart || p.rangeEnd ? `${p.rangeStart ?? '…'} to ${p.rangeEnd ?? '…'}` : undefined;
			return {
				schema: p.schema,
				name: p.name,
				state: p.state,
				detail: [p.state, saved].filter(Boolean).join(' · '),
				title: [
					range ? `Holds ${range}` : undefined,
					p.estimatedRows !== undefined ? `~${p.estimatedRows.toLocaleString()} rows` : undefined,
					STATE_HINT[p.state],
				].filter(Boolean).join('\n'),
			};
		});
	}
	return [...children]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((c) => ({
			schema: c.schema,
			name: c.name,
			detail: c.stats?.totalBytes !== undefined ? formatBytes(c.stats.totalBytes) : '',
			title: c.stats?.rowCount !== undefined && c.stats.rowCount >= 0 ? `~${c.stats.rowCount.toLocaleString()} rows` : '',
		}));
}

const STATE_HINT: Record<SeriesPartitionState, string> = {
	live: 'Live: plain rows, taking writes.',
	sealed: 'Sealed: rewritten into a compressed column store. Late writes still land.',
	tiered: 'Tiered: its column store lives in S3; reads fetch what they need.',
	default: 'Default: catches rows outside every range. They are moved out, not kept here.',
	foreign: 'Not made by SnoutTime, so it is left alone.',
	spread: 'Split by the space key into hash partitions.',
};

/** The muted word beside a table's name: `series`, `partitioned`, or a rollup and its bucket. */
export function seriesKindLabel(table: TableInfo, hasPartitions: boolean): string | undefined {
	if (table.series) {
		const sealed = table.series.partitions.filter((p) => p.state === 'sealed' || p.state === 'tiered').length;
		const ratio = ratioText(table.series.sealedBytesBefore, table.series.sealedBytes);
		return `series${sealed > 0 ? ` · ${sealed} sealed` : ''}${ratio ? ` · ${ratio} smaller` : ''}`;
	}
	if (table.rollup) {
		return `rollup · ${table.rollup.bucket}`;
	}
	return hasPartitions ? 'partitioned' : undefined;
}

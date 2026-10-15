/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a finished move says about itself.
 *
 * A move is `success` only when every object restored and every row count and sequence matched.
 * Anything short of that is `partial`, never success, because the one decision that reads this is
 * whether the source may now be deleted.
 */

import type { RestoreFailure } from './toolLog.js';
import type { SequenceValue, TableCount } from './runSql.js';

export type MoveRunStatus = 'success' | 'partial' | 'failed' | 'cancelled';

export interface TableVerification {
	readonly schema: string;
	readonly table: string;
	readonly sourceRows: number | null;
	/** Null when the table is not on the target. */
	readonly targetRows: number | null;
	readonly matches: boolean;
}

export interface SequenceVerification {
	readonly schema: string;
	readonly name: string;
	readonly source: string | null;
	readonly target: string | null;
	readonly matches: boolean;
}

export interface MoveRunResult {
	readonly runId: string;
	readonly moveId: string;
	readonly status: MoveRunStatus;
	readonly startedAt: string;
	readonly finishedAt: string;
	/** Why it failed, in a sentence. Null unless `failed`. */
	readonly error: string | null;
	/** Everything that did not restore, harmless noise left out. */
	readonly failures: readonly RestoreFailure[];
	readonly harmlessErrors: number;
	readonly tables: readonly TableVerification[];
	readonly sequences: readonly SequenceVerification[];
	/** A target the move created, which stays whatever happened after. */
	readonly created: { readonly label: string; readonly connectionId: string | null } | null;
	/** The copy of a hosted target taken before replacing it. */
	readonly backup: { readonly url: string | null } | null;
	/** What was done to the source afterwards, in a sentence. Null when it was kept. */
	readonly sourceAfter: string | null;
	readonly bytes: number;
	readonly durationMs: number;
}

function key(schema: string, name: string): string {
	return `${schema}.${name}`;
}

export function verifyTables(source: readonly TableCount[], target: readonly TableCount[]): TableVerification[] {
	const onTarget = new Map(target.map((count) => [key(count.schema, count.table), count.rows]));
	return source.map((count) => {
		const targetRows = onTarget.get(key(count.schema, count.table)) ?? null;
		return { schema: count.schema, table: count.table, sourceRows: count.rows, targetRows, matches: count.rows !== null && count.rows === targetRows };
	});
}

export function verifySequences(source: readonly SequenceValue[], target: readonly SequenceValue[]): SequenceVerification[] {
	const onTarget = new Map(target.map((sequence) => [key(sequence.schema, sequence.name), sequence.lastValue]));
	return source.map((sequence) => {
		const found = onTarget.has(key(sequence.schema, sequence.name));
		const targetValue = onTarget.get(key(sequence.schema, sequence.name)) ?? null;
		return { schema: sequence.schema, name: sequence.name, source: sequence.lastValue, target: targetValue, matches: found && sequence.lastValue === targetValue };
	});
}

export function runStatus(input: {
	readonly cancelled: boolean;
	readonly failed: boolean;
	readonly failures: readonly RestoreFailure[];
	readonly tables: readonly TableVerification[];
	readonly sequences: readonly SequenceVerification[];
}): MoveRunStatus {
	if (input.cancelled) {
		return 'cancelled';
	}
	if (input.failed) {
		return 'failed';
	}
	const clean =
		input.failures.every((failure) => failure.harmless) &&
		input.tables.every((table) => table.matches) &&
		input.sequences.every((sequence) => sequence.matches);
	return clean ? 'success' : 'partial';
}

/** One sentence for the view, the audit log and a terminal. */
export function describeRun(result: MoveRunResult): string {
	const created = result.created ? ` "${result.created.label}" was created and is left in place.` : '';
	switch (result.status) {
		case 'cancelled':
			return `The move was stopped. What had already been copied is left on the target.${created}`;
		case 'failed':
			return `The move failed: ${result.error ?? 'no reason was given'}${created}`;
		case 'partial': {
			const parts: string[] = [];
			const failed = result.failures.filter((failure) => !failure.harmless).length;
			if (failed > 0) {
				parts.push(`${failed} object${failed === 1 ? '' : 's'} did not restore`);
			}
			const tables = result.tables.filter((table) => !table.matches).length;
			if (tables > 0) {
				parts.push(`${tables} table${tables === 1 ? '' : 's'} do not match the source`);
			}
			const sequences = result.sequences.filter((sequence) => !sequence.matches).length;
			if (sequences > 0) {
				parts.push(`${sequences} sequence${sequences === 1 ? '' : 's'} do not match`);
			}
			return `The move finished, but ${parts.join(', and ')}. The source was left as it was.`;
		}
		case 'success': {
			const tables = result.tables.length;
			const after = result.sourceAfter ? ` ${result.sourceAfter}` : '';
			return `Moved${tables > 0 ? `, and all ${tables} table${tables === 1 ? '' : 's'} match the source` : ''}.${after}`;
		}
	}
}

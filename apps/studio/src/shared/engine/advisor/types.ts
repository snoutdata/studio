/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Query advisor — the shared contract for large-dataset safety advice (see the plan
// "Large-dataset safety"). Two producers emit the same `Advisory` shape:
//   - the static sargability linter (sargability.ts) — parses the SQL and flags predicates
//     that defeat an index (DATE(col), LOWER(col), leading-wildcard LIKE, type mismatch);
//     surfaced as inline Monaco squiggles, zero round-trips.
//   - the EXPLAIN plan advisor (planAdvisor.ts) — reads the vendor's plan JSON and flags
//     full/large scans, filesorts and temp tables; surfaced in the results advisory strip.
// Both are deterministic and local (no model), so this type stays pure (no Monaco/DOM imports)
// and node-testable alongside the rest of shared/.

export type AdvisoryLevel = 'info' | 'warn';

export type AdvisoryKind =
	// Static (sargability linter):
	| 'non-sargable-function' // fn(col) in a predicate defeats the index on col
	| 'non-sargable-cast'     // CAST(col AS ...) defeats the index on col
	| 'non-sargable-arith'    // col +/-/*/÷ x defeats the index on col
	| 'leading-wildcard-like' // LIKE '%x' can't use a b-tree index on col
	| 'type-mismatch'         // literal type conflicts with col's type → implicit cast
	// Plan advisor (EXPLAIN):
	| 'full-scan'             // sequential/full-table scan
	| 'large-scan'            // scan estimated to read a large number of rows
	| 'filesort'              // sort not backed by an index
	| 'temp-table'            // intermediate temp table materialised
	| 'projection'            // ClickHouse answered from a projection instead of the table
	| 'final'                 // ClickHouse FINAL on a large table merges at read time
	| 'partition-scan';       // every partition of a partitioned (or SnoutTime series) table is read

export interface Advisory {
	level: AdvisoryLevel;
	kind: AdvisoryKind;
	/** Table the advisory concerns, when known (unqualified name). */
	table?: string;
	/** Column the advisory concerns, when known. */
	column?: string;
	/** One-line, human-readable summary. */
	message: string;
	/** Estimated rows the flagged step touches (from the plan), when known — used to threshold the
	 *  pre-flight "this will scan a lot" warning. */
	rows?: number;
	/** Longer explanation of why it matters. */
	rationale?: string;
	/** A suggested rewrite or index DDL the user can apply / hand to the assistant. */
	suggestedSql?: string;
	/** Character offsets into the linted SQL text, for an inline squiggle. Absent when the
	 *  offending span couldn't be located unambiguously (the advisory still shows in the strip). */
	range?: { start: number; end: number };
}

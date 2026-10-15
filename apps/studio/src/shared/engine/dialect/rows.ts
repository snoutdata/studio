/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The shapes of a row on its way into a table, before any vendor's type names are involved: what the
// dialect's insert emitter (`insert.ts`) and column-type mapping (`columnTypes.ts`) take. They began
// as the flow layer's, which still re-exports them under the same names (`flow/spec.ts`); they live
// here because writing rows into a table is the dialect's job, whoever is writing them.

/** The column types reasoned in before any vendor's type names are involved. */
export type InferredType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'timestamp' | 'json';

/** A value after casting, in the small set the insert emitters know how to render. */
export type FlowCell = string | number | boolean | Date | null;

/** One record shaped into the target's column order. */
export type FlowRow = FlowCell[];

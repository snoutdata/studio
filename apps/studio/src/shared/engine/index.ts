/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  snout-engine — the public surface.
 *
 *  This is the ONLY path other code may import. Nothing outside `shared/engine/` reaches a
 *  module by deep path (`shared/engine/guard/sqlGuard`); it imports `shared/engine` and takes
 *  what it needs from here. That rule is what makes the invariant checkable rather than
 *  aspirational, and it is enforced by `invariants.test.ts` beside this file.
 *
 *  Two hard rules for anything added under this root:
 *
 *    1. PURE. No `node:`, `fs`, `path`, `electron`, or native modules. Engine code runs
 *       unchanged in the renderer, in main, and in the server child, which is why the same
 *       guard can give instant feedback in the UI and do the actual enforcing in main.
 *       Anything needing the filesystem or the keychain is a host service (see `host.ts`).
 *    2. It DECIDES. If it moves bytes rather than deciding something, it is not engine:
 *       providers, drivers, stores and transports all stay outside.
 *
 *  Data Flows' modules (`flow/`, `learn/`) are NOT on this surface: Data Flows is private,
 *  and its code imports `shared/engine/pro`, which is this surface plus those two. It is the one
 *  other door, and only private code may use it.
 *--------------------------------------------------------------------------------------------*/

// --- Parse & Shape: the deterministic reading of query text everything else builds on.
// Named rather than `export *`: masking is plumbing, this module is itself only a re-export of
// `@snout/review-core`, and these three functions are the whole of what anything outside the
// engine wants from it.
export { findAtDepth, maskSql, splitAtDepth, type MaskedSql } from './parse/mask';
export * from './parse/queryShape';
export * from './parse/sqlStatement';

// --- Compiler: authored SQL to a backend's native execution form.
export * from './compile/logRows';
export * from './compile/logs';
export * from './compile/native';
export * from './compile/sqlToMongo';
export * from './compile/sqlToLogs';
export * from './compile/sqlToPinecone';
// Named rather than `export *`: sqlAst is the compilers' own plumbing, and only the syntax half of
// it is anyone else's business (the editor's squiggles, and the error that must never reach a model).
export { SqlSyntaxError, sqlSyntaxDiagnostics, type SqlSyntaxDiagnostic } from './compile/sqlAst';
export { type SqlSyntaxProblem } from './compile/sqlSyntax';

// --- Dialect: vendor capability strategy, so feature code never special-cases a vendor.
export * from './dialect/index';
export * from './dialect/flavors';
export * from './dialect/querylang/index';
export * from './dialect/querylang/keyset';
export * from './dialect/querylang/logs';
export * from './dialect/querylang/sql';
export * from './dialect/schemaDiff/index';
export * from './dialect/columnTypes';
export * from './dialect/explain';
export * from './dialect/mask';
export * from './dialect/insert';
export * from './dialect/rows';
export { inferColumns, type InferOptions } from './dialect/documentColumns';
export * from './dialect/bulkFormats';
export * from './dialect/bulkLoad';
export * from './dialect/tableFunctionSpecs';
export * from './dialect/tableFunctions';

// --- Audit: the record every mediated action produces.
export * from './audit';

// --- Guard: what is allowed to leave.
export * from './guard/sqlGuard';
export * from './guard/sideEffects';
export * from './guard/statementHazards';
export * from './guard/policy';
export * from './guard/boundary';

// --- Security: who can reach a database and what they may do with it. The catalog SQL, the
//     GRANT/REVOKE emitters, and the redaction every recording site runs SQL through first.
export * from './security/index';

// --- Context: what the model is told (deterministic ranking, no inference).
export * from './context/schemaPrompt';
export * from './context/completionGuard';
export * from './context/historyContext';
export * from './context/documentDigest';
export * from './context/tools';
export * from './context/dataAccess';

// --- Advisor: no-model linting of plans and predicates.
export * from './advisor/types';
export * from './advisor/sargability';
export * from './advisor/planAdvisor';

// --- Memory: classification and retrieval of past failures.
export * from './memory/errorClass';
export * from './memory/failureMemory';
export * from './memory/failureRetrieval';
export * from './memory/connectionError';
export * from './memory/failureBenchScenarios';

// --- The host services the engine is handed (never imports).
export type * from './host';

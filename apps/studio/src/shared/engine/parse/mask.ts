/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Masking — the shared, parser-free scan every textual SQL rule stands on.
//
// A real parser normalises the AST and hides exactly the textual mistakes the guard and the
// PR reviewer hunt for, and it must never throw on half-typed SQL. So the rules scan text
// instead — with string literals, quoted identifiers and comments blanked out (offsets
// preserved 1:1) and paren depth recorded per character, which is what lets a rule ask
// "the first FROM at depth 0" or "split this column list on top-level commas".
//
// THE IMPLEMENTATION IS NOT HERE. It lives in `packages/review-core` (`src/sql/mask.ts`), the
// dependency-free reviewer library, and this module re-exports it so there is exactly one copy
// of the scan the guard and the reviewer both stand on. It was duplicated while the desktop had
// no reason to depend on that package; the desktop reviewer gave it one, so the
// duplicate went. One direction, once: the package never imports from here.
//
// Re-exported rather than imported at the call sites so `shared/engine` stays the door: engine
// code asks its own `parse/` module for masking, exactly as it did before.

export { findAtDepth, maskSql, splitAtDepth } from '@snout/review-core';
export type { MaskedSql } from '@snout/review-core';

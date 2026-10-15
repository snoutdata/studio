/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Per-connection knowledge base: durable facts the user teaches the app about THEIR database,
// injected into the AI prompt so domain quirks don't have to be re-typed every turn. Two
// buckets: glossary/rules (always injected) and table/column notes (ride schema linking in
// schemaPrompt.ts).

export type KnowledgeScope = 'glossary' | 'table' | 'column';

/** A note's lifecycle. `active` notes are injected; `suggested` notes were proposed by the
 *  background observer and are NEVER injected until the user approves (never silently);
 *  `dismissed` notes were declined and are kept only to suppress re-proposing the same fact. */
export type KnowledgeStatus = 'active' | 'suggested' | 'dismissed';

/** Sentinel connectionId for a GLOBAL note: a `glossary` note with this id is injected on every
 *  connection (this is what the retired "AI instructions" textarea becomes). */
export const GLOBAL_CONNECTION = '*';

export interface KnowledgeNote {
	id: string;                 // uuid
	connectionId: string;       // per-connection scope (matches SavedConnection.id), or GLOBAL_CONNECTION
	scope: KnowledgeScope;
	/** For 'table': lowercased table name. For 'column': lowercased "table.column".
	 *  Unused for 'glossary'. */
	target?: string;
	text: string;               // the fact, as the user phrased it (user-facing prose)
	enabled: boolean;           // toggle without deleting
	/** Lifecycle; absent is treated as 'active' (back-compat with older notes + manual adds). */
	status?: KnowledgeStatus;
	pinned?: boolean;           // table/column only: force the target table into the
	                            //   detailed schema slice even if lexical ranking misses it
	source: 'manual' | 'chat';  // where it was captured (management list vs inline)
	createdAt: number;          // epoch ms
	updatedAt: number;
}

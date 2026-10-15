/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The vector (Pinecone) QueryLanguageProfile. The native form is a
 *  similarity/metadata query against one index; the editor/chat author JSON; the AI flavour is the
 *  Pinecone query. A connection's queries can still be written in SQL (the cross-DB lingua franca)
 *  and transcribed to a vector query in main (metadata filter + topK), so `referencedEntities`
 *  reuses the SQL FROM/JOIN heuristic — the index name maps 1:1 to a "table".
 *--------------------------------------------------------------------------------------------*/

import type { NativeQuery } from '../../compile/native';
import type { BrowsePage, BrowseTarget, QueryLanguageProfile } from './index';
import { referencedTables } from './sql';

export const PINECONE_PROFILE: QueryLanguageProfile = {
	kind: 'vector',
	monacoLanguage: 'json',
	fenceId: 'json',
	aiDisplayName: () => 'Pinecone query',
	// Only the write op family (upsert/delete) mutates; a read query never does.
	isDestructive: (query: NativeQuery) => query.lang === 'pinecone-write',
	// On a Pinecone connection the user authors SQL (transcribed) or a native query; the SQL
	// FROM/JOIN heuristic covers the schema-linking path. Indexes map 1:1 to "tables".
	referencedEntities: (input) => referencedTables(input),
	// Browse an index = list + fetch `limit` vectors starting at `offset` (no vector/id → the driver
	// scans). Pinecone's API pages by an opaque token rather than a numeric offset, so the driver
	// walks tokens and slices; the grid gets the same "page N of this index" it gets for a table.
	// `schema` is the index's NAMESPACE (introspection exposes one pseudo-table per namespace) —
	// dropping it here would silently browse the default namespace instead.
	browse: (target: BrowseTarget, page: BrowsePage): NativeQuery => ({
		lang: 'pinecone',
		index: target.name,
		query: {
			topK: page.limit,
			...(page.offset > 0 ? { offset: page.offset } : {}),
			...(target.schema ? { namespace: target.schema } : {}),
		},
	}),
};

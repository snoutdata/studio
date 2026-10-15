/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The document (MongoDB) QueryLanguageProfile. The native form is an
 *  aggregation pipeline; the editor/chat author JSON; the AI flavour is the aggregation pipeline.
 *  A connection's queries can still be written in SQL (the cross-DB lingua franca) and transcribed
 *  to a pipeline in main — so `referencedEntities` reuses the SQL FROM/JOIN heuristic, which is the
 *  primary schema-linking path on a Mongo connection.
 *--------------------------------------------------------------------------------------------*/

import type { NativeQuery } from '../../compile/native';
import type { BrowsePage, BrowseTarget, QueryLanguageProfile } from './index';
import { referencedTables } from './sql';

/** Pipeline stages that write (rather than read): a pipeline containing one is destructive. */
const WRITE_STAGES = new Set(['$out', '$merge']);

/** True when an aggregation pipeline contains a stage that writes back to the database. */
function pipelineWrites(pipeline: object[]): boolean {
	return pipeline.some((stage) => Object.keys(stage).some((key) => WRITE_STAGES.has(key)));
}

export const MONGO_PROFILE: QueryLanguageProfile = {
	kind: 'document',
	newEntityLabel: 'New collection',
	monacoLanguage: 'json',
	fenceId: 'json',
	aiDisplayName: () => 'MongoDB aggregation pipeline',
	// A write batch (cell edit / insert / delete) or a structure op (collection/index management)
	// always mutates; an aggregation pipeline only when it carries a writing stage ($out/$merge).
	isDestructive: (query: NativeQuery) =>
		query.lang === 'mongo-write' || query.lang === 'mongo-ddl' || (query.lang === 'mongo' && pipelineWrites(query.pipeline)),
	// On a Mongo connection the user authors SQL (transcribed) or a native pipeline; the SQL
	// FROM/JOIN heuristic covers the schema-linking path. Collections map 1:1 to "tables".
	referencedEntities: (input) => referencedTables(input),
	browse: (target: BrowseTarget, page: BrowsePage): NativeQuery => {
		const pipeline: object[] = [];
		if (page.offset > 0) {
			pipeline.push({ $skip: page.offset });
		}
		pipeline.push({ $limit: page.limit });
		return { lang: 'mongo', collection: target.name, pipeline };
	},
};

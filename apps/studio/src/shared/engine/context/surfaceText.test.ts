/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The assistant's static text lives in `@snout/harness/studio`, where the harness lab can tune it.
// These pin that the prompt and the tools are BUILT from it, so a tuned string reaches the model and
// no copy of it is left behind here to drift.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { studioPrompt as P, studioScreen as S, studioTools as T } from '@snout/harness/studio';
import { assistantIs } from '../../assistant';
import type { AiToolSettings } from '../../ai';
import type { DatabaseSchema, TableInfo } from '../../schema';
import { dataAccessPromptNote } from './dataAccess';
import { buildAgentPrompt, buildAmbientComment, buildGlossaryBlock, buildSystemPrompt } from './schemaPrompt';
import { buildToolSpecs } from './tools';

function table(name: string): TableInfo {
	return { name, kind: 'table', columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }], primaryKey: ['id'], foreignKeys: [], indexes: [] } as unknown as TableInfo;
}

const schema: DatabaseSchema = { database: 'shop', tables: Array.from({ length: 10 }, (_, i) => table(`t${i}`)), fetchedAt: 0 } as DatabaseSchema;

describe("the assistant's text comes from the harness surface", () => {
	test('the agent prompt', () => {
		const prompt = buildAgentPrompt('PostgreSQL', schema, { gridInView: true });
		for (const part of [P.SQL_INTRO(assistantIs(P.SQL_ROLE), 'PostgreSQL'), P.NO_EM_DASH, ...P.AGENT_RULES('PostgreSQL'), P.CHART_FORMAT + P.CHART_DOCKED, P.SCHEMA_HEADER('shop', 10, 8), P.OTHER_TABLES_TOOLS(2), P.AGENT_TOOL_PROTOCOL.join('\n'), P.RESULTS_IN_GRID, P.PERF_GUIDANCE.join('\n')]) {
			assert.ok(prompt.includes(part), part.slice(0, 60));
		}
	});

	test('the one-shot prompt and the notes', () => {
		const prompt = buildSystemPrompt('MySQL', schema, { chartNoSql: true });
		for (const part of [...P.ASK_RULES('MySQL'), P.CHART_FORMAT + P.CHART_FULL, P.OTHER_TABLES_HIDDEN(2)]) {
			assert.ok(prompt.includes(part), part.slice(0, 60));
		}
		assert.ok(buildSystemPrompt('MySQL', null, { dbRestricted: true }).endsWith(P.DB_RESTRICTED));
		assert.ok(buildAgentPrompt('MySQL', null, {}).endsWith(P.NO_CONNECTION));
		assert.equal(dataAccessPromptNote('schema'), P.DATA_ACCESS_SCHEMA);
		assert.equal(dataAccessPromptNote('screen'), P.DATA_ACCESS_SCREEN);
		assert.ok(buildGlossaryBlock([{ id: 'g', scope: 'glossary', text: 'churn means cancelled', enabled: true } as never]).startsWith(P.GLOSSARY_HEADER.join('\n')));
	});

	test('the screen', () => {
		const block = buildAmbientComment({ editorBuffer: 'select 1', lastError: 'boom', focusedTable: { name: 'orders' } });
		for (const part of [S.HEADER.join('\n'), S.EDITOR, S.ERROR, S.TABLE('orders')]) {
			assert.ok(block.includes(part), part.slice(0, 60));
		}
	});

	test('the database tools', () => {
		const settings = { listTables: true, describeTable: true, searchColumns: true, runQuery: true } as AiToolSettings;
		const byName = new Map(buildToolSpecs(settings, true).map((spec) => [spec.name, spec]));
		assert.equal(byName.get('list_tables')?.description, T.LIST_TABLES.description);
		assert.equal(byName.get('describe_table')?.description, T.DESCRIBE_TABLE.description);
		assert.equal(byName.get('search_columns')?.description, T.SEARCH_COLUMNS.description);
		assert.equal(byName.get('run_query')?.description, T.RUN_QUERY.description);
		const connection = (byName.get('run_query')?.parameters as { properties: Record<string, { description: string }> }).properties.connection;
		assert.equal(connection.description, T.CONNECTION_ARG.description);
		assert.equal(buildToolSpecs(settings, true, true).find((spec) => spec.name === 'run_query')?.description, T.RUN_PIPELINE.description);
	});
});

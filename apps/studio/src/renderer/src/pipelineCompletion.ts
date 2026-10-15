/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Schema-aware JSON completion for the native MongoDB aggregation-pipeline editor.
 *  Registered once on Monaco's `json` language; it offers aggregation stage operators
 *  ($match, $group, …), the fields of the tab's target collection, and the other collection names
 *  (for $lookup). The active collection's schema is pushed in by App (the only json editor in the
 *  app is the pipeline tab), and cleared when no pipeline tab is focused so a stray json buffer
 *  gets nothing.
 *--------------------------------------------------------------------------------------------*/

import { monaco } from './monaco';
import { MONGO_STAGES } from './pipeline';

let activeFields: string[] = [];
let activeCollections: string[] = [];
let registered = false;

/** Push the current pipeline tab's schema context (the target collection's field names + all
 *  collection names). Pass empty arrays to disable completion when no pipeline tab is focused. */
export function setPipelineSchema(fields: string[], collections: string[]): void {
	activeFields = fields;
	activeCollections = collections;
}

/** Register the json completion provider once (idempotent; safe under dev HMR re-runs). */
export function registerPipelineCompletion(): void {
	if (registered) {
		return;
	}
	registered = true;
	monaco.languages.registerCompletionItemProvider('json', {
		triggerCharacters: ['$', '"'],
		provideCompletionItems(model, position): monaco.languages.ProviderResult<monaco.languages.CompletionList> {
			if (activeFields.length === 0 && activeCollections.length === 0) {
				return { suggestions: [] };
			}
			const lineToCursor = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column));
			// Inside a JSON string when an odd number of quotes precede the cursor on this line: then
			// the surrounding quotes already exist, so suggestions slot in bare (no added quotes).
			const inString = (lineToCursor.match(/"/g)?.length ?? 0) % 2 === 1;
			// Replace the identifier-ish run immediately before the cursor (so `"$ma` → `"$match"`).
			const tokenLen = (lineToCursor.match(/[A-Za-z0-9_$]*$/)?.[0].length) ?? 0;
			const range = new monaco.Range(position.lineNumber, position.column - tokenLen, position.lineNumber, position.column);
			const wrap = (s: string): string => (inString ? s : `"${s}"`);
			const suggestions: monaco.languages.CompletionItem[] = [];
			for (const stage of MONGO_STAGES) {
				suggestions.push({ label: stage, kind: monaco.languages.CompletionItemKind.Keyword, insertText: wrap(stage), range, detail: 'aggregation stage', sortText: `0${stage}` });
			}
			for (const field of activeFields) {
				suggestions.push({ label: field, kind: monaco.languages.CompletionItemKind.Field, insertText: wrap(field), range, detail: 'field', sortText: `1${field}` });
			}
			for (const coll of activeCollections) {
				suggestions.push({ label: coll, kind: monaco.languages.CompletionItemKind.Class, insertText: wrap(coll), range, detail: 'collection', sortText: `2${coll}` });
			}
			return { suggestions };
		},
	});
}

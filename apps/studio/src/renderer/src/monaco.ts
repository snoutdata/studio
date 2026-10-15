/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Monaco is imported PIECEWISE, not as the `monaco-editor` barrel.
//
// That barrel is `esm/vs/editor/editor.main`, which pulls in the whole of `basic-languages`
// (89 languages: ABAP, Solidity, PowerQuery, …) plus the css, html, json and typescript language
// SERVICES, for an app whose editor only ever holds two languages. It was the single biggest thing
// in the renderer's launch chunk. Every registration below is one the app actually uses:
//
//   edcore.main            the editor and ALL its standalone contributions (find/replace, folding,
//                          suggest, hover, multi-cursor, the command palette, …). Nothing is
//                          traded away here; cherry-picking contributions is where editor features
//                          go missing silently, so this stays whole.
//   sql.contribution       registers the `sql` language id. The app replaces its tokenizer via
//                          `sqlHighlight.ts`'s setMonarchTokensProvider, but the id has to exist
//                          first or the override has nothing to attach to.
//   json/monaco.contribution   the JSON language service (validation + formatting), which the
//                          native MongoDB pipeline surface genuinely uses.
//
// The API binding comes from `editor.api`, the same module `edcore.main` re-exports, so this is
// the identical runtime object the barrel would have given us. It is imported separately only
// because `edcore.main` ships no .d.ts and `editor.api` does.
//
// Adding a language means adding its `.contribution` here, deliberately, rather than getting all
// 89 back by importing the barrel.
import 'monaco-editor/esm/vs/editor/edcore.main';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

// Standalone Monaco needs its web worker wired up explicitly. SQL is tokenizer-only (no
// worker-backed language service), so the generic editor worker covers it. The native MongoDB
// pipeline surface edits JSON, which DOES have a worker-backed language service
// (validation + formatting), so 'json' gets the dedicated json worker. Vite's `?worker` import
// bundles both locally — no CDN, works offline inside Electron.
self.MonacoEnvironment = {
	getWorker(_workerId: string, label: string): Worker {
		if (label === 'json') {
			return new JsonWorker();
		}
		return new EditorWorker();
	},
};

export { monaco };

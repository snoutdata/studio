/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { monaco } from './monaco';
import { CompletionItemKind, InsertTextFormat } from 'vscode-languageserver-protocol';
import type { CompletionItem, Hover, MarkupContent } from 'vscode-languageserver-protocol';
import type { KeywordCase } from './appSettings';
import { backendKindForDriver, lintSargability, statementHazards } from '../../shared/engine';
import type { SqlSyntaxDiagnostic } from '../../shared/engine';
import type { DatabaseSchema } from '../../shared/schema';

// Bridges Monaco's editor language features to the ported SQL server. Instead of the
// heavyweight monaco-languageclient + vscode-services stack, we register Monaco
// providers directly and forward to the server (which already implements the standard
// textDocument/completion, completionItem/resolve and textDocument/hover) through the
// preload `sqlApi` over IPC. The server keeps its own copy of the buffer via
// TextDocuments, so providers push the current text right before each request to
// guarantee the server sees what the user sees.

let registered = false;
const versions = new Map<string, number>();

// Keyword-completion casing, set from app settings. `preserve` mirrors what the user is
// typing (the server's keyword list is uppercase, which otherwise force-uppercases).
let keywordCase: KeywordCase = 'preserve';

/** Set the case applied to keyword suggestions (from the editor settings). */
export function setKeywordCase(mode: KeywordCase): void {
	keywordCase = mode;
}

// The active tab's connection, so completion/hover scope to a single schema. Without it
// the server falls back to every cached schema and tables appear duplicated once per open
// connection.
let activeConnectionId: string | undefined;

/** Point the editor language features at the active connection's schema. */
export function setActiveConnectionId(id: string | undefined): void {
	activeConnectionId = id;
}

// Supplies the active connection's cached schema + driver id for the static sargability linter
// (query advisor, Pillar 2 Tier A). Injected by App so the linter — which is pure/local and
// needs the indexes + column types — can run on the editor buffer with no round-trip. Returns an
// empty object when there's no connected schema (the linter then no-ops).
let schemaProvider: () => { schema?: DatabaseSchema; driver?: string } = () => ({});
const ADVISOR_MARKER_OWNER = 'sql-advisor';

/** Inject the schema/driver source for the inline sargability linter. */
export function setAdvisorSchemaProvider(fn: () => { schema?: DatabaseSchema; driver?: string }): void {
	schemaProvider = fn;
}

/**
 * Re-run the static sargability linter over a model's buffer and publish the results as Monaco
 * markers (inline squiggles). Deterministic + local — no model call, no round-trip — so it's safe
 * to run on every (debounced) edit, matching the "no model on keystrokes" rule. Called from the
 * Editor's content-change handler and by App when the schema refreshes.
 */
export function refreshAdvisorDiagnostics(model: monaco.editor.ITextModel | null): void {
	if (!model || model.isDisposed()) {
		return;
	}
	const { schema, driver } = schemaProvider();
	const text = model.getValue();
	const advisories = schema ? lintSargability(text, schema, driver) : [];
	const markers: monaco.editor.IMarkerData[] = [];
	// Statement hazards (guard/statementHazards) — SQL that runs, succeeds, and does something other
	// than what it reads like (`SET a = 1 AND b = 2`). Needs no schema and no connection, so unlike
	// the sargability pass it runs on every buffer; that's the point, the mistake is textual and the
	// warning has to arrive while it's still being typed rather than in a confirm dialog.
	for (const h of statementHazards(text)) {
		const start = model.getPositionAt(h.range.start);
		const end = model.getPositionAt(h.range.end);
		markers.push({
			severity: monaco.MarkerSeverity.Warning,
			message: `${h.message}\n\n${h.rationale}${h.suggestedSql ? `\n\nDid you mean: ${h.suggestedSql}` : ''}`,
			source: 'sql hazard',
			startLineNumber: start.lineNumber,
			startColumn: start.column,
			endLineNumber: end.lineNumber,
			endColumn: end.column,
		});
	}
	for (const a of advisories) {
		if (!a.range) {
			continue; // no anchor → surfaced in the results strip instead, not inline
		}
		const start = model.getPositionAt(a.range.start);
		const end = model.getPositionAt(a.range.end);
		const detail = [a.rationale, a.suggestedSql ? `Suggested: ${a.suggestedSql}` : undefined].filter(Boolean).join('\n\n');
		markers.push({
			severity: monaco.MarkerSeverity.Warning,
			message: detail ? `${a.message}\n\n${detail}` : a.message,
			source: 'index advisor',
			startLineNumber: start.lineNumber,
			startColumn: start.column,
			endLineNumber: end.lineNumber,
			endColumn: end.column,
		});
	}
	monaco.editor.setModelMarkers(model, ADVISOR_MARKER_OWNER, markers);
	void refreshSyntaxDiagnostics(model);
}

const SYNTAX_MARKER_OWNER = 'sql-syntax';
// The buffer each model's in-flight syntax pass was asked about, so a reply that arrives after the
// user has typed on is dropped instead of underlining text that has moved.
const syntaxPending = new WeakMap<monaco.editor.ITextModel, string>();

/**
 * Underline what is wrong with the statement before it is ever run. ONLY for the backends whose SQL
 * this app compiles itself (document, vector, telemetry): a relational connection sends its SQL to
 * a real database, which knows its own dialect and answers with its own error, so marking those
 * here would squiggle perfectly good MySQL/Oracle/T-SQL against a Postgres grammar. For the
 * compiled backends there is no second opinion, and a typo used to be answered only by running it
 * (see `shared/engine/compile/sqlSyntax.ts`).
 *
 * The parse happens in main, over IPC, because the grammar is 2.5 MB and the renderer's launch
 * bundle is not the place for it ("Startup is sacred").
 */
async function refreshSyntaxDiagnostics(model: monaco.editor.ITextModel): Promise<void> {
	const { driver } = schemaProvider();
	if (backendKindForDriver(driver) === 'relational') {
		if (syntaxPending.has(model)) {
			syntaxPending.delete(model);
			monaco.editor.setModelMarkers(model, SYNTAX_MARKER_OWNER, []);
		}
		return;
	}
	const text = model.getValue();
	syntaxPending.set(model, text);
	let found: SqlSyntaxDiagnostic[];
	try {
		found = await window.sqlApi.syntaxDiagnostics(text);
	} catch {
		return; // diagnostics are advice; a failed round-trip leaves the last set alone
	}
	if (model.isDisposed() || syntaxPending.get(model) !== text) {
		return;
	}
	monaco.editor.setModelMarkers(model, SYNTAX_MARKER_OWNER, found.map((d) => {
		const start = model.getPositionAt(d.start);
		const end = model.getPositionAt(d.end);
		return {
			severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
			message: d.suggestion ? `${d.message}\n\n${d.suggestion}` : d.message,
			// Named, like the other two marker sources: it is what the peek panel prints under the
			// message, and a bare "sql" there reads like the language rather than the checker.
			source: 'sql syntax',
			startLineNumber: start.lineNumber,
			startColumn: start.column,
			endLineNumber: end.lineNumber,
			endColumn: end.column,
		};
	}));
}

// Tells the DefinitionProvider which identifiers under the cursor refer to known tables;
// when true, Monaco underlines the word + switches the cursor to pointer on Ctrl/Cmd-hover.
let isTableName: (name: string) => boolean = () => false;

/** Inject the table-name resolver used by the Ctrl/Cmd-click-to-open affordance. */
export function setTableResolver(fn: (name: string) => boolean): void {
	isTableName = fn;
}

// Keywords that introduce a table identifier (or a comma-separated list of them). Used to
// distinguish a table reference from a column whose name happens to match a table.
const TABLE_POSITION_KEYWORDS = new Set([
	'FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'TRUNCATE',
	'ANALYZE', 'DESCRIBE', 'DESC', 'EXPLAIN', 'LOCK', 'REFERENCES',
]);

/**
 * True when the text leading up to the cursor ends in a table-position context — i.e. a
 * table-introducing keyword followed by any comma-separated list of identifiers/qualifiers.
 * Walks back past identifier chunks and commas to find the introducing keyword.
 */
function isTablePosition(text: string): boolean {
	const isWordPart = (c: string): boolean => /[\w.]/.test(c);
	const isSpace = (c: string): boolean => /\s/.test(c);
	let pos = text.length;
	// Skip trailing whitespace.
	while (pos > 0 && isSpace(text[pos - 1])) {
		pos -= 1;
	}
	// Walk back through any comma-separated table list (`FROM a, b, c`).
	while (pos > 0 && text[pos - 1] === ',') {
		pos -= 1;
		while (pos > 0 && isSpace(text[pos - 1])) {
			pos -= 1;
		}
		if (pos === 0 || !isWordPart(text[pos - 1])) {
			return false;
		}
		while (pos > 0 && isWordPart(text[pos - 1])) {
			pos -= 1;
		}
		while (pos > 0 && isSpace(text[pos - 1])) {
			pos -= 1;
		}
	}
	// Whatever's at `pos` should be the keyword that introduced the list.
	const end = pos;
	while (pos > 0 && /\w/.test(text[pos - 1])) {
		pos -= 1;
	}
	return TABLE_POSITION_KEYWORDS.has(text.slice(pos, end).toUpperCase());
}

/**
 * Position-aware check: the identifier at `position` matches a known table AND is being
 * used as a table reference (in a table-position context, or as a `tbl.col` qualifier).
 * Used by both the DefinitionProvider (visual hint) and Editor's Ctrl+click handler.
 */
export function isTableReferenceAt(model: monaco.editor.ITextModel, position: monaco.IPosition): boolean {
	const word = model.getWordAtPosition(position);
	if (!word || !isTableName(word.word)) {
		return false;
	}
	const lineAfter = model.getLineContent(position.lineNumber).slice(word.endColumn - 1);
	// `users.id` — `users` is a qualifier-form table reference.
	if (lineAfter.trimStart().startsWith('.')) {
		return true;
	}
	const textBefore = model.getValueInRange({
		startLineNumber: 1,
		startColumn: 1,
		endLineNumber: position.lineNumber,
		endColumn: word.startColumn,
	});
	return isTablePosition(textBefore);
}

/** Recase a keyword to the chosen mode; `preserve` follows the typed prefix's case. */
function caseKeyword(keyword: string, typed: string): string {
	if (keywordCase === 'upper') {
		return keyword.toUpperCase();
	}
	if (keywordCase === 'lower') {
		return keyword.toLowerCase();
	}
	// preserve: match an all-uppercase prefix, else lowercase (the un-shouty default).
	if (typed.length > 0 && typed === typed.toUpperCase() && typed !== typed.toLowerCase()) {
		return keyword.toUpperCase();
	}
	return keyword.toLowerCase();
}

function nextVersion(uri: string): number {
	const version = (versions.get(uri) ?? 0) + 1;
	versions.set(uri, version);
	return version;
}

/** Language features run on the typing path, where the worst honest outcome is "no
 *  suggestions this keystroke". A transport failure (the server child died and is being
 *  respawned underneath us) must degrade to that, not bubble out of a Monaco provider as an
 *  unhandled error — which is how one dead child used to become a stream of crash reports. */
async function quietly<T>(work: () => Promise<T>, fallback: T): Promise<T> {
	try {
		return await work();
	} catch (err) {
		console.warn('[sql-lsp] request failed, degrading', err);
		return fallback;
	}
}

/** Open the model's buffer on the server. Call once per model, before edits. */
export function notifyDidOpen(model: monaco.editor.ITextModel): void {
	const uri = model.uri.toString();
	versions.set(uri, 1);
	void quietly(() => window.sqlApi.didOpen(uri, model.getValue(), 1), undefined);
}

/** Register the SQL completion + hover providers (idempotent, process-global). */
export function registerSqlLanguageFeatures(): void {
	if (registered) {
		return;
	}
	registered = true;

	monaco.languages.registerCompletionItemProvider('sql', {
		// Mirror the server's declared trigger characters.
		triggerCharacters: ['.', ' '],
		async provideCompletionItems(model, position) {
			const uri = model.uri.toString();
			return quietly(async () => {
				await window.sqlApi.didChange(uri, nextVersion(uri), model.getValue());
				const answer = await window.sqlApi.completion(uri, { line: position.lineNumber - 1, character: position.column - 1 }, activeConnectionId);
				const items = answer.items;
				const word = model.getWordUntilPosition(position);
				const range: monaco.IRange = {
					startLineNumber: position.lineNumber,
					endLineNumber: position.lineNumber,
					startColumn: word.startColumn,
					endColumn: word.endColumn,
				};
				// A name the server hands back already quoted (a log scope, `"/aws/lambda/checkout"`)
				// has to REPLACE the quote the user has begun, not sit inside it: Monaco's word range
				// stops at the first `/`, so inserting into it would leave `""/aws/lambda/checkout"`.
				// Only when there is an unclosed opening quote on this line before the cursor.
				const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
				const open = /(["`[])[^"`\]]*$/.exec(before);
				const quotedRange: monaco.IRange = open ? { ...range, startColumn: open.index + 1 } : range;
				// `incomplete` is not a detail: the engine catalog (ClickHouse's 1,900 functions and
				// 1,800 settings) is narrowed server-side to the word typed so far, so filtering this
				// list locally on the next keystroke would show a list cut for the PREVIOUS word.
				// Saying it is incomplete is what makes Monaco ask again.
				return { suggestions: items.map((item) => toMonacoCompletion(item, range, word.word, quotedRange)), incomplete: answer.isIncomplete };
			}, { suggestions: [], incomplete: false });
		},
		async resolveCompletionItem(item) {
			const lsp = (item as MonacoCompletion)._lsp;
			if (!lsp) {
				return item;
			}
			return quietly(async () => {
				const resolved = await window.sqlApi.completionResolve(lsp);
				if (resolved.documentation) {
					item.documentation = toMarkdown(resolved.documentation);
				}
				return item;
			}, item);
		},
	});

	monaco.languages.registerHoverProvider('sql', {
		async provideHover(model, position) {
			const uri = model.uri.toString();
			return quietly(async () => {
				await window.sqlApi.didChange(uri, nextVersion(uri), model.getValue());
				const hover = await window.sqlApi.hover(uri, { line: position.lineNumber - 1, character: position.column - 1 }, activeConnectionId);
				if (!hover) {
					return null;
				}
				return { contents: toHoverContents(hover.contents) };
			}, null);
		},
	});

	// SQL folding: fold whole multi-line statements (top-level, semicolon-delimited),
	// balanced multi-line parenthesised groups (subqueries / column lists), and block
	// comments. Computed locally from the buffer — the ported server has no folding request,
	// and indentation-based folding (Monaco's default with no provider) reads SQL poorly.
	monaco.languages.registerFoldingRangeProvider('sql', {
		provideFoldingRanges(model) {
			return computeSqlFoldingRanges(model.getValue());
		},
	});

	// Definition provider used only as a visual hint: when an identifier matches a known
	// table in the active connection's schema, Monaco underlines it and switches the cursor
	// to pointer on Ctrl/Cmd-hover (the actual open is wired through Editor.onMouseUp).
	// Returning a Location at the word itself means Monaco's default Ctrl+click navigation
	// is a no-op (cursor stays put) while still triggering the link styling.
	monaco.languages.registerDefinitionProvider('sql', {
		provideDefinition(model, position) {
			if (!isTableReferenceAt(model, position)) {
				return null;
			}
			const word = model.getWordAtPosition(position);
			if (!word) {
				return null;
			}
			return {
				uri: model.uri,
				range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
			};
		},
	});
}

/**
 * Compute SQL folding ranges by scanning the buffer once, skipping over string literals
 * and comments so braces/semicolons inside them don't count. Emits a fold for:
 *  - each multi-line statement (start of statement → its top-level `;`, or EOF),
 *  - each balanced `(` … `)` group that spans more than one line,
 *  - each multi-line block comment.
 * Ranges are 1-based line numbers (Monaco's FoldingRange convention).
 */
function computeSqlFoldingRanges(text: string): monaco.languages.FoldingRange[] {
	const ranges: monaco.languages.FoldingRange[] = [];
	const parenStack: number[] = [];
	let line = 1;
	// First content line of the current top-level statement (-1 = between statements).
	let stmtStart = -1;
	// Last line that carried statement content, so a trailing (semicolon-less) statement
	// folds to its real end rather than to a trailing blank line.
	let lastContent = 1;
	const len = text.length;
	let i = 0;
	const markContent = (): void => {
		if (stmtStart === -1) {
			stmtStart = line;
		}
		lastContent = line;
	};
	while (i < len) {
		const c = text[i];
		if (c === '\n') {
			line += 1;
			i += 1;
			continue;
		}
		if (c === ' ' || c === '\t' || c === '\r') {
			i += 1;
			continue;
		}
		// Line comment to end of line.
		if (c === '-' && text[i + 1] === '-') {
			while (i < len && text[i] !== '\n') {
				i += 1;
			}
			continue;
		}
		// Block comment (folds on its own when multi-line; not statement content).
		if (c === '/' && text[i + 1] === '*') {
			const startLine = line;
			i += 2;
			while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
				if (text[i] === '\n') {
					line += 1;
				}
				i += 1;
			}
			i += i < len ? 2 : 0;
			if (line > startLine) {
				ranges.push({ start: startLine, end: line, kind: monaco.languages.FoldingRangeKind.Comment });
			}
			continue;
		}
		// String / quoted-identifier literal: consume to the closing quote (doubled quote
		// escapes; backslash escapes outside backticks), tracking newlines.
		if (c === '\'' || c === '"' || c === '`') {
			markContent();
			i += 1;
			while (i < len) {
				const d = text[i];
				if (d === '\n') {
					line += 1;
					i += 1;
					continue;
				}
				if (d === '\\' && c !== '`') {
					i += 2;
					continue;
				}
				if (d === c) {
					if (text[i + 1] === c) {
						i += 2;
						continue;
					}
					i += 1;
					break;
				}
				i += 1;
			}
			continue;
		}
		markContent();
		if (c === '(') {
			parenStack.push(line);
		} else if (c === ')') {
			const openLine = parenStack.pop();
			if (openLine !== undefined && line > openLine) {
				ranges.push({ start: openLine, end: line });
			}
		} else if (c === ';' && parenStack.length === 0) {
			if (stmtStart !== -1 && line > stmtStart) {
				ranges.push({ start: stmtStart, end: line });
			}
			stmtStart = -1;
		}
		i += 1;
	}
	// Trailing statement with no closing semicolon.
	if (stmtStart !== -1 && lastContent > stmtStart) {
		ranges.push({ start: stmtStart, end: lastContent });
	}
	// Monaco keys folding regions by start line; when a statement and an inner group share a
	// start line, keep the widest so the outer region wins.
	const byStart = new Map<number, monaco.languages.FoldingRange>();
	for (const range of ranges) {
		const existing = byStart.get(range.start);
		if (!existing || range.end > existing.end) {
			byStart.set(range.start, range);
		}
	}
	return [...byStart.values()];
}

/** A Monaco completion item carrying the original LSP item for lazy resolve. */
interface MonacoCompletion extends monaco.languages.CompletionItem {
	_lsp?: CompletionItem;
}

function toMonacoCompletion(item: CompletionItem, range: monaco.IRange, typed: string, quotedRange: monaco.IRange = range): MonacoCompletion {
	const isKeyword = item.kind === CompletionItemKind.Keyword;
	const insertText = isKeyword ? caseKeyword(item.insertText ?? item.label, typed) : (item.insertText ?? item.label);
	const monacoItem: MonacoCompletion = {
		label: isKeyword ? caseKeyword(item.label, typed) : item.label,
		kind: toMonacoKind(item.kind),
		insertText,
		detail: item.detail,
		sortText: item.sortText,
		// An insertion that carries its own opening quote swallows the one already typed.
		range: /^["`[]/.test(insertText) ? quotedRange : range,
		filterText: item.filterText,
		_lsp: item,
	};
	if (item.insertTextFormat === InsertTextFormat.Snippet) {
		monacoItem.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
	}
	if (item.documentation) {
		monacoItem.documentation = toMarkdown(item.documentation);
	}
	return monacoItem;
}

function toMonacoKind(kind: CompletionItemKind | undefined): monaco.languages.CompletionItemKind {
	const K = monaco.languages.CompletionItemKind;
	switch (kind) {
		case CompletionItemKind.Field:
			return K.Field;
		case CompletionItemKind.Keyword:
			return K.Keyword;
		case CompletionItemKind.Snippet:
			return K.Snippet;
		case CompletionItemKind.Struct:
			return K.Struct;
		case CompletionItemKind.Function:
			return K.Function;
		case CompletionItemKind.Variable:
			return K.Variable;
		default:
			return K.Property;
	}
}

function toMarkdown(documentation: string | MarkupContent): monaco.IMarkdownString {
	return { value: typeof documentation === 'string' ? documentation : documentation.value };
}

function toHoverContents(contents: Hover['contents']): monaco.IMarkdownString[] {
	if (typeof contents === 'string') {
		return [{ value: contents }];
	}
	if (Array.isArray(contents)) {
		return contents.map((entry) => ({ value: typeof entry === 'string' ? entry : entry.value }));
	}
	// MarkupContent ({ kind, value }) or MarkedString ({ language, value }).
	return [{ value: contents.value }];
}

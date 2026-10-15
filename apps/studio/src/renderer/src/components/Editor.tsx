/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react';
import { monaco } from '../monaco';
import { isTableReferenceAt, refreshAdvisorDiagnostics, registerSqlLanguageFeatures } from '../lspBridge';
import { registerAiCompletion, triggerAiCompletion } from '../aiCompletion';
import { attachSelectionHint, triggerAddToChat, triggerAiEdit, triggerExplainSql, triggerOptimizeSql, triggerPipelineTranslation, triggerTextToSql } from '../aiEdit';
import { matchesEvent, type ResolvedKeybinding } from '../../../shared/keybindings';

interface EditorProps {
	/** Hand the editor instance back so the app can swap its model per tab. */
	onReady(editor: monaco.editor.IStandaloneCodeEditor): void;
	onRun(): void;
	/** Format the selection (or whole buffer) as SQL. */
	onFormat(): void;
	/** Resolved keyboard shortcuts. ALL of them are dispatched from the editor's onKeyDown while
	 *  it's focused (not just 'editor'-scope ones) so they pre-empt Monaco's built-in keybindings —
	 *  e.g. a command rebound to Ctrl+I would otherwise be eaten by Monaco's Trigger Suggest before
	 *  the window-level dispatcher ever sees it. Passed the full list so a rebind takes effect live. */
	editorBindings: ResolvedKeybinding[];
	/** Run a 'global'-scope command (new/open/save/close/palette) by id — used when the editor is
	 *  focused, so global shortcuts work (and beat Monaco) without leaving the editor. */
	onGlobalShortcut(commandId: string): void;
	/** Ctrl/Cmd+click an identifier — return true if it resolved to a table the app opened. */
	onIdentifierClick?(identifier: string): boolean;
	/** Initial appearance options; the app live-updates these via updateOptions later. */
	options?: { fontSize: number; wordWrap: 'on' | 'off'; minimap: { enabled: boolean }; quickSuggestions: boolean; suggestOnTriggerCharacters: boolean };
}

/**
 * Thin React wrapper around a single standalone Monaco editor. It owns no document —
 * the app creates one model per tab and calls `editor.setModel(...)` to switch — so
 * Monaco stays imperative and the tab/model bookkeeping lives in App.
 */
export function Editor(props: EditorProps): JSX.Element {
	const hostRef = useRef<HTMLDivElement>(null);
	const onRunRef = useRef(props.onRun);
	onRunRef.current = props.onRun;
	const onFormatRef = useRef(props.onFormat);
	onFormatRef.current = props.onFormat;
	const onIdentifierClickRef = useRef(props.onIdentifierClick);
	onIdentifierClickRef.current = props.onIdentifierClick;
	// Live keybindings, read by the onKeyDown dispatcher below so a rebind takes effect without
	// re-mounting the editor (Monaco's addCommand can't be unbound, so we dispatch by hand).
	const bindingsRef = useRef(props.editorBindings);
	bindingsRef.current = props.editorBindings;
	const onGlobalShortcutRef = useRef(props.onGlobalShortcut);
	onGlobalShortcutRef.current = props.onGlobalShortcut;

	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}
		registerSqlLanguageFeatures();
		registerAiCompletion();
		const editor = monaco.editor.create(host, {
			model: null,
			language: 'sql',
			// Theme is set globally by applyTheme() (see theme.ts), so don't pin it here.
			automaticLayout: true,
			// Pull the line-number gutter tight to the left edge: drop the unused glyph margin
			// (breakpoint icons we never show) and narrow the reserved line-number column.
			// NOTE: re-enable glyphMargin if we ever add a debugger / breakpoint gutter — that
			// feature renders its icons here, so it needs this margin back.
			glyphMargin: false,
			lineNumbersMinChars: 3,
			minimap: props.options?.minimap ?? { enabled: false },
			fontSize: props.options?.fontSize ?? 13,
			wordWrap: props.options?.wordWrap ?? 'off',
			// Default to manual completion (Ctrl+Space); the app overrides from settings.
			quickSuggestions: props.options?.quickSuggestions ?? false,
			suggestOnTriggerCharacters: props.options?.suggestOnTriggerCharacters ?? false,
			scrollBeyondLastLine: false,
			// SQL code folding: our FoldingRangeProvider (lspBridge.ts) supplies the ranges;
			// 'auto' uses it, and 'always'-on controls keep the fold gutter discoverable.
			folding: true,
			foldingStrategy: 'auto',
			showFoldingControls: 'always',
			// Ghost text only renders on an explicit trigger (see aiCompletion.ts); it
			// never fetches as-you-type, so this won't call a model on keystrokes.
			inlineSuggest: { enabled: true },
		});
		// All keyboard shortcuts are dispatched here from the keybinding registry while the editor
		// is focused, rather than via editor.addCommand: addCommand can't be rebound, and being the
		// first responder lets us pre-empt Monaco's built-ins. The editor's onKeyDown fires from the
		// textarea (a descendant of the container Monaco's keybinding service listens on), so
		// preventDefault + stopPropagation here stops BOTH Monaco's own handling and the
		// window-level dispatcher. Matching is on browserEvent.code (see matchesEvent) — correct on
		// macOS (Option mangles the char) and non-US layouts.
		const editorCommands: Record<string, () => void> = {
			run: () => onRunRef.current(),
			format: () => onFormatRef.current(),
			aiComplete: () => triggerAiCompletion(editor),
			aiEdit: () => triggerAiEdit(editor),
			addToChat: () => triggerAddToChat(editor),
		};
		editor.onKeyDown((e) => {
			for (const b of bindingsRef.current) {
				if (!matchesEvent(b.combo, e.browserEvent)) {
					continue;
				}
				// Editor-scope commands run locally; global-scope ones (new/open/save/close/palette)
				// route up to the app so they work — and beat Monaco — without leaving the editor.
				const handler = b.scope === 'editor' ? editorCommands[b.id] : () => onGlobalShortcutRef.current(b.id);
				if (handler) {
					e.preventDefault();
					e.stopPropagation();
					handler();
					return;
				}
			}
		});
		// Ctrl/Cmd+click an identifier → ask the app to open that table in a tab. Gate on
		// the same position-aware check the DefinitionProvider uses, so a column reference
		// that happens to share a name with a table doesn't trigger a navigation.
		editor.onMouseUp((e) => {
			const me = e.event;
			if (!(me.ctrlKey || me.metaKey) || !e.target.position) {
				return;
			}
			const model = editor.getModel();
			if (!model || !isTableReferenceAt(model, e.target.position)) {
				return;
			}
			const word = model.getWordAtPosition(e.target.position);
			if (!word) {
				return;
			}
			onIdentifierClickRef.current?.(word.word);
		});
		// Right-click AI actions: pinned to the very top of the context menu. Monaco forces the
		// 'navigation' group first, so we put them there with low order values. Each runs on the
		// current selection (or the whole document when nothing is selected) and routes to the
		// chat panel — see the trigger* functions in aiEdit.ts.
		editor.addAction({
			id: 'snout.ai.textToSql',
			label: 'Text to SQL',
			contextMenuGroupId: 'navigation',
			contextMenuOrder: 0.1,
			run: () => triggerTextToSql(editor),
		});
		editor.addAction({
			id: 'snout.ai.explainSql',
			label: 'Explain SQL',
			contextMenuGroupId: 'navigation',
			contextMenuOrder: 0.2,
			run: () => triggerExplainSql(editor),
		});
		editor.addAction({
			id: 'snout.ai.optimizeSql',
			label: 'SQL Optimization',
			contextMenuGroupId: 'navigation',
			contextMenuOrder: 0.3,
			run: () => triggerOptimizeSql(editor),
		});
		editor.addAction({
			id: 'snout.ai.pipelineTranslation',
			label: 'Get Pipeline Translation',
			contextMenuGroupId: 'navigation',
			contextMenuOrder: 0.35,
			run: () => triggerPipelineTranslation(editor),
		});
		// Drop the "Go to Definition" + "Peek" context-menu items. They only exist because we
		// register a DefinitionProvider for the Ctrl-hover link hint (lspBridge.ts) — the real
		// table-open is our own Ctrl+click handler above, so the menu entries are dead weight.
		// Monaco has no public remove-menu-item API, so filter them out of the context menu
		// contribution's action list (revealDefinition + the EditorContextPeek submenu), then
		// drop any separator left dangling by the removal.
		hideContextMenuActions(editor, new Set(['editor.action.revealDefinition', 'submenuitem.EditorContextPeek']));
		attachSelectionHint(editor);
		// Inline index/scan advisor (query advisor, Pillar 2 Tier A): re-lint the buffer on a
		// debounced content change and immediately when the tab's model swaps. The linter is
		// deterministic + local (no model call), so this never fetches on keystrokes.
		let advisorLintTimer: ReturnType<typeof setTimeout> | undefined;
		const scheduleLintAdvisor = (): void => {
			if (advisorLintTimer) {
				clearTimeout(advisorLintTimer);
			}
			advisorLintTimer = setTimeout(() => refreshAdvisorDiagnostics(editor.getModel()), 400);
		};
		editor.onDidChangeModelContent(scheduleLintAdvisor);
		editor.onDidChangeModel(() => refreshAdvisorDiagnostics(editor.getModel()));
		props.onReady(editor);
		return () => {
			if (advisorLintTimer) {
				clearTimeout(advisorLintTimer);
			}
			editor.dispose();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return <div className="editor" ref={hostRef} />;
}

/** A context-menu entry as the contextmenu contribution yields it (separators carry the id
 *  'vs.actions.separator'). */
interface MenuEntry {
	id: string;
}

/** The private context-menu contribution we wrap to filter built-in menu entries. */
interface ContextMenuContribution {
	_getMenuActions(model: monaco.editor.ITextModel, menuId: unknown): MenuEntry[];
}

const SEPARATOR_ID = 'vs.actions.separator';

/** Remove the given action ids (and the now-redundant separators) from an editor's right-click
 *  menu. Monaco exposes no public API for this, so we wrap the contextmenu contribution's
 *  `_getMenuActions`. Best-effort: if the contribution shape ever changes, the menu just keeps
 *  its default entries. */
function hideContextMenuActions(editor: monaco.editor.IStandaloneCodeEditor, hidden: Set<string>): void {
	const contribution = editor.getContribution('editor.contrib.contextmenu') as unknown as ContextMenuContribution | null;
	if (!contribution || typeof contribution._getMenuActions !== 'function') {
		return;
	}
	const original = contribution._getMenuActions.bind(contribution);
	contribution._getMenuActions = (model, menuId): MenuEntry[] => {
		const kept = original(model, menuId).filter((a) => !hidden.has(a.id));
		// Collapse separators left dangling by the removal: no leading/trailing separator and
		// never two in a row.
		const result: MenuEntry[] = [];
		for (const entry of kept) {
			if (entry.id === SEPARATOR_ID && (result.length === 0 || result[result.length - 1].id === SEPARATOR_ID)) {
				continue;
			}
			result.push(entry);
		}
		while (result.length > 0 && result[result.length - 1].id === SEPARATOR_ID) {
			result.pop();
		}
		return result;
	};
}

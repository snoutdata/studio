/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../shared/assistant';
import { monaco } from './monaco';
import { isReasoningModel, type AiProviderId } from '../../shared/ai';
import { formatShortcut } from './shortcuts';

// Inline editor edit (Ctrl+K): a content widget anchored at the selection
// where the user types an instruction. With a selection it rewrites it ("edit"); with none
// it generates SQL at the cursor ("generate"). The suggestion is applied as one undoable
// edit, highlighted green, with an Accept / Reject bar — Reject restores the original.
// Instruction-driven, so it's separate from the as-you-type ghost text in aiCompletion.ts.

interface AiEditContext {
	/** Active connection id for schema grounding, or undefined when none. */
	getConnectionId(): string | undefined;
	/** Surface progress/errors (wired to the app status line). */
	onStatus(message: string): void;
	/** Drop the selected text into the chat composer (opens the panel). */
	onAddToChat(text: string): void;
	/** Open the chat panel and auto-run a turn with the given prompt (the Explain / Optimize /
	 *  Text-to-SQL context-menu actions). */
	onAsk(prompt: string): void;
	/** Translate the given SQL to the connection's native pipeline form (deterministic-first, AI for
	 *  the rest), returning a comment block to insert, or null on failure / not applicable (the
	 *  handler surfaces the reason via onStatus). Used by the "Get Pipeline Translation" action. */
	onTranslateToPipeline(sql: string): Promise<string | null>;
}

let ctx: AiEditContext = { getConnectionId: () => undefined, onStatus: () => undefined, onAddToChat: () => undefined, onAsk: () => undefined, onTranslateToPipeline: async () => null };

/** Update the active connection + status sink (called from App, like configureAiCompletion). */
export function configureAiEdit(next: AiEditContext): void {
	ctx = next;
}

let session: EditSession | null = null;
let hint: SelectionHint | null = null;

/** Open the inline-edit prompt at the current selection/cursor (bound to Ctrl+K). */
export function triggerAiEdit(editor: monaco.editor.IStandaloneCodeEditor | null): void {
	if (!editor) {
		return;
	}
	hint?.hide();
	session?.close();
	session = new EditSession(editor);
	session.open();
}

/** Send the current selection to the chat composer (bound to Ctrl+L). No-op on an empty
 *  selection — the pill that exposes this only shows when something is selected. */
export function triggerAddToChat(editor: monaco.editor.IStandaloneCodeEditor | null): void {
	if (!editor) {
		return;
	}
	const selection = editor.getSelection();
	const model = editor.getModel();
	if (!selection || selection.isEmpty() || !model) {
		return;
	}
	const text = model.getValueInRange(selection);
	if (!text.trim()) {
		return;
	}
	hint?.hide();
	ctx.onAddToChat(text);
}

/** The text the AI context-menu actions operate on: the current selection, or the whole
 *  document when nothing is selected. Empty (no usable text) ⇒ null. */
function selectionOrDocument(editor: monaco.editor.IStandaloneCodeEditor): string | null {
	const model = editor.getModel();
	if (!model) {
		return null;
	}
	const selection = editor.getSelection();
	const text = selection && !selection.isEmpty() ? model.getValueInRange(selection) : model.getValue();
	return text.trim() ? text : null;
}

/** Explain the selected SQL (or the whole document) in the chat panel, grounded in the
 *  database's real EXPLAIN plan rather than the model's reading of the text. */
export function triggerExplainSql(editor: monaco.editor.IStandaloneCodeEditor | null): void {
	if (!editor) {
		return;
	}
	const sql = selectionOrDocument(editor);
	if (!sql) {
		return;
	}
	hint?.hide();
	ctx.onAsk(
		"Explain the following SQL query, grounded in the database's real execution plan. " +
		"First run the plan against the connected database with the run_query tool, using this database's EXPLAIN form (e.g. `EXPLAIN <query>`). " +
		'Then explain, in plain language: what the query does, and what the plan shows about how the database will run it (scans vs. index use, join order, row estimates) and any performance concerns. ' +
		'If EXPLAIN fails because a table or column does not exist, report that instead of guessing.' +
		`\n\n\`\`\`sql\n${sql}\n\`\`\``,
	);
}

/** Suggest an optimized rewrite of the selected SQL (or the whole document) in the chat panel. */
export function triggerOptimizeSql(editor: monaco.editor.IStandaloneCodeEditor | null): void {
	if (!editor) {
		return;
	}
	const sql = selectionOrDocument(editor);
	if (!sql) {
		return;
	}
	hint?.hide();
	ctx.onAsk(`Review the following SQL query for performance and suggest an optimized version, explaining each change. If it is already optimal, say so.\n\n\`\`\`sql\n${sql}\n\`\`\``);
}

/** Translate the selected SQL (or the whole document) to a MongoDB aggregation pipeline and insert
 *  it as a comment just below the selection — a learning aid and a starting point to copy into a
 *  Pipeline tab. Deterministic when possible (free); the AI covers the rest. No-op on relational
 *  connections (the handler surfaces why). */
export function triggerPipelineTranslation(editor: monaco.editor.IStandaloneCodeEditor | null): void {
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	const sql = selectionOrDocument(editor);
	if (!model || !sql) {
		return;
	}
	hint?.hide();
	const selection = editor.getSelection();
	// Insert after the selection's last line, or the cursor line / end of document when nothing is selected.
	const line = selection ? selection.endLineNumber : model.getLineCount();
	void ctx.onTranslateToPipeline(sql).then((text) => {
		if (!text) {
			return; // the handler already surfaced the reason via onStatus
		}
		const eol = model.getEOL();
		const col = model.getLineMaxColumn(line);
		editor.executeEdits('snout.pipelineTranslation', [{ range: new monaco.Range(line, col, line, col), text: `${eol}${text}` }]);
	});
}

/** Turn the selected natural-language description (or the whole document) into a SQL query
 *  via the chat panel, where the proposed query can be inserted into the editor. */
export function triggerTextToSql(editor: monaco.editor.IStandaloneCodeEditor | null): void {
	if (!editor) {
		return;
	}
	const text = selectionOrDocument(editor);
	if (!text) {
		return;
	}
	hint?.hide();
	ctx.onAsk(`Write a SQL query for the following request. Return the query in a single \`\`\`sql code block.\n\n${text}`);
}

/** Attach the on-selection pill (Add to Chat + Quick Edit) to an editor — call once per
 *  editor. It floats above any non-empty selection and doubles as the Ctrl+L / Ctrl+K
 *  discoverability hint. */
export function attachSelectionHint(editor: monaco.editor.IStandaloneCodeEditor): void {
	hint = new SelectionHint(editor);
}

const WIDGET_ID = 'snout.aiEdit.widget';

/** Distinct id per edit request, so a streamed chunk only updates the session that asked. */
let editRequestSeq = 0;

/** Split a "provider:model" picker value (model names can carry colons, e.g. "qwen:7b",
 *  so split on the first colon only). */
function splitModelValue(value: string): { provider: AiProviderId; model: string } | null {
	const idx = value.indexOf(':');
	if (idx < 0) {
		return null;
	}
	return { provider: value.slice(0, idx) as AiProviderId, model: value.slice(idx + 1) };
}

/** Picker label for a "provider:model" value: the model name, marked ✦ when it's a
 *  reasoning model (mirrors the chat picker). */
function modelLabel(value: string): string {
	const parsed = splitModelValue(value);
	if (!parsed) {
		return value;
	}
	return isReasoningModel(parsed.provider, parsed.model) ? `✦ ${parsed.model}` : parsed.model;
}

/** The last non-empty line of the streamed reply, trimmed and clipped to its tail — the
 *  live progress shown in place of a static "Generating…". */
function lastLine(text: string): string {
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line) {
			return line.length > 80 ? `…${line.slice(-80)}` : line;
		}
	}
	return '';
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
	const el = document.createElement('button');
	el.type = 'button';
	el.className = className;
	el.textContent = label;
	el.addEventListener('click', onClick);
	return el;
}

class EditSession {
	private readonly node = document.createElement('div');
	/** A textarea, not an input: instructions run to a sentence or two, and a one-line box that
	 *  scrolls its own text sideways hides what you typed. It grows with the content (see
	 *  {@link autoGrow}); Enter still submits, Shift+Enter takes a newline. */
	private readonly input = document.createElement('textarea');
	private readonly footer = document.createElement('div');
	private readonly modelSelect = document.createElement('select');
	private readonly hint = document.createElement('div');
	/** Spinning loader glyph shown inside the hint while the reply streams. */
	private readonly spinner = document.createElement('span');
	/** Text part of the hint (keybind tip, or the live progress line). */
	private readonly hintText = document.createElement('span');
	private widget: monaco.editor.IContentWidget | null = null;
	private anchor: monaco.IPosition;
	private readonly targetRange: monaco.Range;
	private readonly mode: 'edit' | 'generate';
	private readonly originalText: string;
	private decorations: string[] = [];
	private appliedRange: monaco.Range | null = null;
	private busy = false;
	/** No active connection ⇒ the edit can't be schema-grounded; show a "connect first"
	 *  message instead of the prompt (set in the constructor). */
	private blocked = false;
	/** Model override picked in the widget; undefined until the picker loads (the edit then
	 *  falls back to the configured chat model in main). */
	private chosenProvider: AiProviderId | undefined;
	private chosenModel: string | undefined;
	/** Detach the streamed-chunk listener for the in-flight request, if any. */
	private unsubscribeChunk: (() => void) | null = null;

	/** Dismiss when the user clicks outside the widget — but never while a request is in
	 *  flight. Before any edit is applied this just cancels; mid-review it rejects (so no
	 *  half-committed change is left behind), matching Escape. */
	private readonly onOutsideClick = (e: MouseEvent): void => {
		if (this.busy || this.node.contains(e.target as Node)) {
			return;
		}
		if (this.appliedRange) {
			this.reject();
		} else {
			this.close();
		}
	};

	constructor(private readonly editor: monaco.editor.IStandaloneCodeEditor) {
		const selection = editor.getSelection();
		const model = editor.getModel();
		const hasSelection = Boolean(selection && !selection.isEmpty());
		const caret = selection?.getStartPosition() ?? editor.getPosition() ?? new monaco.Position(1, 1);
		this.mode = hasSelection ? 'edit' : 'generate';
		this.targetRange = hasSelection && selection ? monaco.Range.lift(selection) : monaco.Range.fromPositions(caret, caret);
		this.originalText = hasSelection && model ? model.getValueInRange(this.targetRange) : '';
		this.anchor = this.targetRange.getStartPosition();
		this.blocked = ctx.getConnectionId() === undefined;
		this.buildPrompt();
	}

	private buildPrompt(): void {
		this.node.className = 'ai-edit-widget';
		if (this.blocked) {
			this.buildBlocked();
			return;
		}
		this.input.className = 'ai-edit-input';
		this.input.rows = 2;
		this.input.spellcheck = false;
		this.input.placeholder = this.mode === 'edit' ? 'Edit selection: describe the change…' : 'Generate SQL: describe what you want…';
		this.input.addEventListener('keydown', (e) => this.onPromptKey(e));
		this.input.addEventListener('input', () => this.autoGrow());
		this.modelSelect.className = 'ai-edit-model';
		this.modelSelect.title = 'Model for this edit';
		// Keep the select's own key handling (arrow keys) from bubbling to the editor.
		this.modelSelect.addEventListener('keydown', (e) => e.stopPropagation());
		this.modelSelect.addEventListener('change', () => this.onModelChange());
		this.hint.className = 'ai-edit-hint';
		this.spinner.className = 'codicon codicon-loading codicon-modifier-spin ai-edit-spin';
		this.spinner.setAttribute('aria-hidden', 'true');
		this.hintText.className = 'ai-edit-hint-text';
		this.hintText.textContent = this.mode === 'edit' ? '⏎ apply · ⇧⏎ newline · Esc cancel' : '⏎ generate · ⇧⏎ newline · Esc cancel';
		// The spinner is added to the DOM only while streaming (see submit) — toggling it by
		// CSS loses to the codicon base rule's display:inline-block.
		this.hint.append(this.hintText);
		this.footer.className = 'ai-edit-foot';
		this.footer.append(this.modelSelect, this.hint);
		this.node.append(this.input, this.footer);
		void this.loadModels();
	}

	/** No active connection: an edit would have no schema to ground on (it could only
	 *  hallucinate), so show a "connect first" message instead of the prompt. */
	private buildBlocked(): void {
		const msg = document.createElement('div');
		msg.className = 'ai-edit-blocked';
		const icon = document.createElement('span');
		icon.className = 'codicon codicon-plug ai-edit-blocked-icon';
		icon.setAttribute('aria-hidden', 'true');
		const text = document.createElement('span');
		text.textContent = 'Connect to a database to use Quick Edit.';
		msg.append(icon, text);
		this.hint.className = 'ai-edit-hint';
		this.hintText.className = 'ai-edit-hint-text';
		this.hintText.textContent = 'Esc to dismiss';
		this.hint.append(this.hintText);
		this.footer.className = 'ai-edit-foot';
		this.footer.append(this.hint);
		// The input never mounts here, so let the node itself catch Escape.
		this.node.tabIndex = -1;
		this.node.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Escape') {
				e.preventDefault();
				this.close();
			}
		});
		this.node.append(msg, this.footer);
	}

	/** Populate the model picker from the configured/reachable providers, pre-selecting the
	 *  current chat model. Best-effort: on failure the picker stays empty and the edit just
	 *  uses the default model. */
	private async loadModels(): Promise<void> {
		let statuses;
		let settings;
		try {
			[statuses, settings] = await Promise.all([window.sqlApi.aiProviderStatus(), window.sqlApi.aiSettings()]);
		} catch {
			return;
		}
		const currentModel = settings.provider === 'ollama' ? settings.ollama.model : settings['positron-cloud'].model;
		const current = `${settings.provider}:${currentModel}`;
		this.chosenProvider = settings.provider;
		this.chosenModel = currentModel;
		const values = statuses.flatMap((s) => s.models.filter((m) => m.enabled).map((m) => `${m.provider}:${m.model}`));
		// The active model always shows, even if it's been toggled off in Settings.
		if (!values.includes(current)) {
			values.unshift(current);
		}
		this.modelSelect.replaceChildren();
		for (const value of values) {
			const opt = document.createElement('option');
			opt.value = value;
			opt.textContent = modelLabel(value);
			this.modelSelect.append(opt);
		}
		this.modelSelect.value = current;
		// The picker widened the widget; re-layout so it stays anchored to the selection.
		if (this.widget) {
			this.editor.layoutContentWidget(this.widget);
		}
	}

	private onModelChange(): void {
		const parsed = splitModelValue(this.modelSelect.value);
		if (parsed) {
			this.chosenProvider = parsed.provider;
			this.chosenModel = parsed.model;
		}
		this.input.focus();
	}

	open(): void {
		this.widget = {
			getId: () => WIDGET_ID,
			getDomNode: () => this.node,
			getPosition: () => ({
				position: this.anchor,
				preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE, monaco.editor.ContentWidgetPositionPreference.BELOW],
			}),
		};
		this.editor.addContentWidget(this.widget);
		// Focus the prompt input (or the message node when blocked), then re-assert on the next
		// frame — adding the content widget can hand focus back to the editor, which would
		// route typing to the document.
		const focusTarget: HTMLElement = this.blocked ? this.node : this.input;
		if (!this.blocked) {
			this.autoGrow();
		}
		focusTarget.focus();
		requestAnimationFrame(() => focusTarget.focus());
		// Dismiss on a click outside the widget. Deferred a tick so the click/keypress that
		// opened the prompt doesn't immediately close it.
		setTimeout(() => document.addEventListener('mousedown', this.onOutsideClick, true), 0);
	}

	/** Size the textarea to its content (2 rows to 10), so a long instruction is fully visible
	 *  instead of scrolling inside a one-line slot. Re-layouts the widget so it stays anchored. */
	private autoGrow(): void {
		const style = getComputedStyle(this.input);
		const lineHeight = parseFloat(style.lineHeight) || 17;
		const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
		const min = lineHeight * 2 + padding;
		const max = lineHeight * 10 + padding;
		this.input.style.height = 'auto';
		this.input.style.height = `${Math.min(Math.max(this.input.scrollHeight, min), max)}px`;
		if (this.widget) {
			this.editor.layoutContentWidget(this.widget);
		}
	}

	private onPromptKey(e: KeyboardEvent): void {
		e.stopPropagation();
		// Shift+Enter (or Alt+Enter) writes a newline; plain Enter submits.
		if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
			e.preventDefault();
			void this.submit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			this.close();
		}
	}

	private async submit(): Promise<void> {
		const instruction = this.input.value.trim();
		if (!instruction || this.busy) {
			return;
		}
		this.busy = true;
		this.input.disabled = true;
		this.modelSelect.disabled = true;
		this.hint.classList.add('streaming');
		this.hint.prepend(this.spinner);
		this.hintText.textContent = 'Processing…';
		const model = this.editor.getModel();
		// Stream the reply so the hint shows the latest line as live progress (replacing the
		// static "Generating…"), scoped to this request's id.
		const requestId = `edit-${++editRequestSeq}`;
		let streamed = '';
		this.unsubscribeChunk = window.sqlApi.onAiEditChunk((id, delta) => {
			if (id !== requestId) {
				return;
			}
			streamed += delta;
			const line = lastLine(streamed);
			if (line) {
				this.hintText.textContent = line;
			}
		});
		const result = await window.sqlApi.aiEdit(requestId, {
			connectionId: ctx.getConnectionId(),
			instruction,
			selection: this.originalText,
			document: model?.getValue() ?? '',
			provider: this.chosenProvider,
			model: this.chosenModel,
		});
		this.unsubscribeChunk?.();
		this.unsubscribeChunk = null;
		this.busy = false;
		this.spinner.remove();
		this.hint.classList.remove('streaming');
		if (!result.ok) {
			ctx.onStatus(result.error);
			this.close();
			return;
		}
		if (!result.text.trim()) {
			ctx.onStatus(`${ASSISTANT_NAME}: no change suggested.`);
			this.close();
			return;
		}
		this.applyPreview(result.text);
	}

	/** Apply the suggestion as one undoable edit, highlight it, and switch to the review bar. */
	private applyPreview(text: string): void {
		const model = this.editor.getModel();
		if (!model) {
			this.close();
			return;
		}
		this.editor.pushUndoStop();
		this.editor.executeEdits('ai-edit', [{ range: this.targetRange, text, forceMoveMarkers: true }]);
		this.editor.pushUndoStop();
		const start = this.targetRange.getStartPosition();
		this.appliedRange = monaco.Range.fromPositions(start, this.endPosition(start, text));
		this.decorations = this.editor.deltaDecorations([], [{
			range: this.appliedRange,
			options: { className: 'ai-edit-added', isWholeLine: false },
		}]);
		this.anchor = start;
		this.showReview();
	}

	/** Position after inserting `text` at `start`. */
	private endPosition(start: monaco.IPosition, text: string): monaco.IPosition {
		const lines = text.split('\n');
		if (lines.length === 1) {
			return { lineNumber: start.lineNumber, column: start.column + text.length };
		}
		return { lineNumber: start.lineNumber + lines.length - 1, column: lines[lines.length - 1].length + 1 };
	}

	private showReview(): void {
		this.node.replaceChildren();
		const bar = document.createElement('div');
		bar.className = 'ai-edit-review';
		bar.append(
			button('Accept', 'ai-edit-accept', () => this.accept()),
			button('Reject', 'ai-edit-reject', () => this.reject()),
		);
		const hint = document.createElement('div');
		hint.className = 'ai-edit-hint';
		hint.textContent = '⏎ accept · Esc reject';
		this.node.append(bar, hint);
		this.node.tabIndex = -1;
		this.node.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				this.accept();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this.reject();
			}
		});
		if (this.widget) {
			this.editor.layoutContentWidget(this.widget);
		}
		setTimeout(() => this.node.focus(), 0);
	}

	/** Keep the change. */
	private accept(): void {
		this.close();
	}

	/** Undo the change, restoring the original selection (or removing generated text). */
	private reject(): void {
		const model = this.editor.getModel();
		if (model && this.appliedRange) {
			this.editor.executeEdits('ai-edit-reject', [{ range: this.appliedRange, text: this.originalText, forceMoveMarkers: true }]);
		}
		this.close();
	}

	close(): void {
		this.unsubscribeChunk?.();
		this.unsubscribeChunk = null;
		document.removeEventListener('mousedown', this.onOutsideClick, true);
		if (this.decorations.length > 0) {
			this.decorations = this.editor.deltaDecorations(this.decorations, []);
		}
		if (this.widget) {
			this.editor.removeContentWidget(this.widget);
			this.widget = null;
		}
		if (session === this) {
			session = null;
		}
		this.editor.focus();
		// A selection may remain after closing — let the pill reappear for it.
		hint?.sync();
	}
}

const HINT_WIDGET_ID = 'snout.aiEdit.hint';

/**
 * A floating "Quick Edit ⌘K" pill anchored above the current selection.
 * It's a single content widget whose position is null'd to hide it; we re-evaluate on every
 * selection change. Clicking it opens the inline-edit prompt for the selection.
 */
class SelectionHint {
	private readonly node = document.createElement('div');
	private readonly widget: monaco.editor.IContentWidget;
	private anchor: monaco.IPosition | null = null;

	constructor(private readonly editor: monaco.editor.IStandaloneCodeEditor) {
		this.node.className = 'ai-edit-pill';
		this.node.append(
			this.pillButton('Add to Chat', formatShortcut('Mod+L'), () => triggerAddToChat(this.editor)),
			this.pillButton('Quick Edit', formatShortcut('Mod+K'), () => triggerAiEdit(this.editor)),
		);
		this.widget = {
			getId: () => HINT_WIDGET_ID,
			getDomNode: () => this.node,
			getPosition: () => this.anchor
				? { position: this.anchor, preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE, monaco.editor.ContentWidgetPositionPreference.BELOW] }
				: null,
		};
		this.editor.addContentWidget(this.widget);
		this.editor.onDidChangeCursorSelection(() => this.sync());
		this.editor.onDidBlurEditorWidget(() => this.hide());
	}

	/** One pill button: a label with its dimmed keybind. */
	private pillButton(label: string, kbd: string, onClick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'ai-edit-pill-btn';
		const labelEl = document.createElement('span');
		labelEl.textContent = label;
		const kbdEl = document.createElement('span');
		kbdEl.className = 'ai-edit-pill-kbd';
		kbdEl.textContent = kbd;
		btn.append(labelEl, kbdEl);
		// Don't let the click move focus/clear the selection before we read it.
		btn.addEventListener('mousedown', (e) => e.preventDefault());
		btn.addEventListener('click', onClick);
		return btn;
	}

	/** Show the pill above a non-empty selection; hide it otherwise or while editing. */
	sync(): void {
		const selection = this.editor.getSelection();
		if (session || !selection || selection.isEmpty()) {
			this.hide();
			return;
		}
		this.anchor = selection.getStartPosition();
		this.editor.layoutContentWidget(this.widget);
	}

	hide(): void {
		if (this.anchor) {
			this.anchor = null;
			this.editor.layoutContentWidget(this.widget);
		}
	}
}

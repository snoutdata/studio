/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../shared/assistant';
import { monaco } from './monaco';
import { isCompletionPosition } from '../../shared/engine';
import type { CompletionOutcome, InlineCompletionMode } from '../../shared/ai';

// AI completion: a Monaco inline-completions provider that renders the model's suggestion
// as ghost text (accept with Tab, dismiss with Esc). Deliberately separate from the
// deterministic schema completion in lspBridge.ts — that one never calls a model. This one
// runs only when enabled in AI settings, and either on an EXPLICIT trigger (manual mode:
// Alt+\ or the command palette) or automatically as you type (auto mode:
// debounced + cancellable so it doesn't hammer the model on every keystroke).
//
// Two things beyond fetching happen here:
//  - POSITION GATING (auto triggers only): `isCompletionPosition` keeps the model out of the
//    positions lspBridge already answers exactly (mid-identifier, after a `.`, after FROM/JOIN),
//    where a guess can only be worse than the symbol list the user would otherwise get.
//  - OUTCOME REPORTING: whether the user actually took the suggestion. Nothing else measures
//    that, and without it no change to the completion path can be judged.

/** How long to wait after the last keystroke before firing an automatic completion. */
const AUTO_DEBOUNCE_MS = 350;

/** Editor command Monaco runs when an inline suggestion is accepted in full. */
const ACCEPT_COMMAND_ID = 'snout.aiCompletionAccepted';

interface AiCompletionContext {
	/** Whether the feature is enabled (the AI-settings toggle). */
	enabled: boolean;
	/** Manual (explicit trigger only) vs auto (as-you-type). */
	mode: InlineCompletionMode;
	/** Active connection id for schema grounding, or undefined when none. */
	getConnectionId(): string | undefined;
	/** Surface progress/errors (wired to the app status line). */
	onStatus(message: string): void;
}

/** Our inline-completion list, tagged with the audit id of the round-trip that produced it so
 *  the outcome can be reported against the same entry. */
interface AiInlineCompletions extends monaco.languages.InlineCompletions {
	requestId: string;
}

let ctx: AiCompletionContext = { enabled: false, mode: 'manual', getConnectionId: () => undefined, onStatus: () => undefined };
let registered = false;

/** Shown suggestions whose outcome is still open, so a discarded list can be reported as
 *  dismissed exactly once. Keyed by audit id. */
const openSuggestions = new Map<string, { decided: boolean }>();

/** Update the provider's view of enablement, mode, the active connection, and status sink. */
export function configureAiCompletion(next: AiCompletionContext): void {
	ctx = next;
}

/** Resolve true after `ms`, or false if the request is cancelled first (newer keystroke). */
function waitDebounced(ms: number, token: monaco.CancellationToken): Promise<boolean> {
	return new Promise((resolve) => {
		if (token.isCancellationRequested) {
			resolve(false);
			return;
		}
		const handle = setTimeout(() => { sub.dispose(); resolve(true); }, ms);
		const sub = token.onCancellationRequested(() => { clearTimeout(handle); resolve(false); });
	});
}

/** Report an outcome to main. Best-effort and never awaited — a measurement failure must not
 *  affect the editor. `accepted`/`partial` close the suggestion so `free` won't call it dismissed. */
function report(requestId: string, outcome: CompletionOutcome, acceptedChars?: number): void {
	if (!requestId) {
		return;
	}
	if (outcome === 'accepted' || outcome === 'partial') {
		const state = openSuggestions.get(requestId);
		if (state) {
			state.decided = true;
		}
	}
	try {
		window.sqlApi.aiCompletionOutcome({ id: requestId, outcome, acceptedChars });
	} catch {
		// Measurement only; swallow.
	}
}

/** Register the inline-completions provider (idempotent, process-global). */
export function registerAiCompletion(): void {
	if (registered) {
		return;
	}
	registered = true;

	monaco.editor.addCommand({
		id: ACCEPT_COMMAND_ID,
		run: (_accessor, requestId: string) => report(requestId, 'accepted'),
	});

	const provider: monaco.languages.InlineCompletionsProvider<AiInlineCompletions> = {
		async provideInlineCompletions(model, position, context, token) {
			const empty: AiInlineCompletions = { items: [], requestId: '' };
			const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
			if (!ctx.enabled) {
				// Only nag on an explicit trigger; stay silent for as-you-type calls.
				if (explicit) {
					ctx.onStatus('AI completion is off. Enable it under Settings → AI.');
				}
				return empty;
			}
			// In manual mode, ignore automatic (as-you-type) triggers.
			if (!explicit && ctx.mode !== 'auto') {
				return empty;
			}
			const offset = model.getOffsetAt(position);
			const value = model.getValue();
			const prefix = value.slice(0, offset);
			const suffix = value.slice(offset);
			// An explicit Alt+\ always goes through — the user asked for this position. An
			// automatic trigger only fires where the model can beat the deterministic completion.
			if (!explicit && !isCompletionPosition(prefix, suffix)) {
				return empty;
			}
			// Debounce automatic triggers so a newer keystroke supersedes (cancels) this one.
			if (!explicit && !(await waitDebounced(AUTO_DEBOUNCE_MS, token))) {
				return empty;
			}
			if (explicit) {
				ctx.onStatus(`${ASSISTANT_NAME}: thinking…`);
			}
			const result = await window.sqlApi.aiComplete({ connectionId: ctx.getConnectionId(), prefix, suffix });
			if (token.isCancellationRequested) {
				// Clear the progress line: an explicit trigger that gets superseded used to leave
				// "Liby: thinking…" on the status bar forever, with no suggestion ever arriving.
				if (explicit) {
					ctx.onStatus('');
				}
				return empty;
			}
			if (!result.ok) {
				// Surface errors only for explicit triggers; auto mode fails quietly.
				if (explicit) {
					ctx.onStatus(result.error);
				}
				return empty;
			}
			if (explicit) {
				ctx.onStatus(result.text ? '' : `${ASSISTANT_NAME}: no suggestion`);
			}
			if (!result.text) {
				// A suggestion the guard emptied never reaches the user — record that as its outcome
				// rather than leaving the round-trip looking merely unaccepted.
				report(result.id, 'dismissed');
				return empty;
			}
			openSuggestions.set(result.id, { decided: false });
			return {
				requestId: result.id,
				items: [{
					insertText: result.text,
					range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
					command: { id: ACCEPT_COMMAND_ID, title: '', arguments: [result.id] },
				}],
			};
		},
		handleItemDidShow(completions) {
			report(completions.requestId, 'shown');
		},
		handlePartialAccept(completions, _item, acceptedCharacters) {
			report(completions.requestId, 'partial', acceptedCharacters);
		},
		freeInlineCompletions(completions) {
			const state = openSuggestions.get(completions.requestId);
			openSuggestions.delete(completions.requestId);
			if (state && !state.decided) {
				report(completions.requestId, 'dismissed');
			}
		},
	};

	monaco.languages.registerInlineCompletionsProvider('sql', provider);
}

/** Ask the editor to fetch an inline completion at the cursor (explicit trigger). */
export function triggerAiCompletion(editor: monaco.editor.IStandaloneCodeEditor | null): void {
	if (!editor) {
		return;
	}
	editor.focus();
	void editor.getAction('editor.action.inlineSuggest.trigger')?.run();
}

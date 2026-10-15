/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	conflictingIds,
	eventToCombo,
	matchesEvent,
	normalizeCombo,
	resolveKeybindings,
	toAccelerator,
	type KeyEventLike,
} from './keybindings';

// A minimal KeyboardEvent stand-in. Matching is on `code`, not `key`.
function ev(parts: Partial<KeyEventLike>): KeyEventLike {
	return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: '', code: '', ...parts };
}

// Node has defined a `navigator` global since v21, and on macOS it reports "MacIntel" — so the
// module's own `isMac` is TRUE when these run on a Mac and 'Mod' means Cmd there, not Ctrl. Mirror
// that detection rather than assuming one platform, or every Mod assertion below is a coin flip
// decided by whose machine the suite runs on.
const MOD_IS_META = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

/** The modifier 'Mod' resolves to on this platform. */
function mod(): Partial<KeyEventLike> {
	return MOD_IS_META ? { metaKey: true } : { ctrlKey: true };
}

test('normalizeCombo canonicalizes modifier order and key case', () => {
	assert.equal(normalizeCombo('Shift+Mod+p'), 'Mod+Shift+P');
	assert.equal(normalizeCombo('Mod+Enter'), 'Mod+Enter');
	assert.equal(normalizeCombo('Alt+\\'), 'Alt+\\');
});

test('resolveKeybindings applies overrides over defaults', () => {
	const resolved = resolveKeybindings({ run: 'Mod+R' });
	assert.equal(resolved.find((b) => b.id === 'run')?.combo, 'Mod+R');
	// Untouched bindings keep their (normalized) default.
	assert.equal(resolved.find((b) => b.id === 'new')?.combo, 'Mod+N');
});

test('conflictingIds only flags same-scope collisions', () => {
	const resolved = resolveKeybindings({ saveFile: 'Mod+K' }); // collides with editor-scope aiEdit
	// saveFile is global, aiEdit is editor — different scopes, no conflict.
	assert.deepEqual(conflictingIds(resolved, 'saveFile', 'Mod+K', 'global'), []);
	// Within the editor scope, asking for Mod+K finds aiEdit.
	assert.deepEqual(conflictingIds(resolved, 'run', 'Mod+K', 'editor'), ['aiEdit']);
});

test('matchesEvent matches on physical code with exact modifiers', () => {
	assert.ok(matchesEvent('Mod+Shift+P', ev({ ...mod(), shiftKey: true, code: 'KeyP' })));
	// Missing a required modifier -> no match.
	assert.ok(!matchesEvent('Mod+Shift+P', ev({ ...mod(), code: 'KeyP' })));
	// An extra modifier held -> no match (exact match).
	assert.ok(!matchesEvent('Mod+N', ev({ ...mod(), shiftKey: true, code: 'KeyN' })));
});

test('matchesEvent uses code, so the typed character is irrelevant (macOS Option+\\ = "«")', () => {
	// Alt+\ on macOS yields key '«' but code stays 'Backslash'; matching on code still works.
	assert.ok(matchesEvent('Alt+\\', ev({ altKey: true, key: '«', code: 'Backslash' })));
});

test('matchesEvent accepts numpad Enter for an Enter binding', () => {
	assert.ok(matchesEvent('Mod+Enter', ev({ ...mod(), code: 'Enter' })));
	assert.ok(matchesEvent('Mod+Enter', ev({ ...mod(), code: 'NumpadEnter' })));
});

test('eventToCombo collapses Ctrl/Cmd to portable Mod and yields the US-label token', () => {
	assert.equal(eventToCombo(ev({ ctrlKey: true, shiftKey: true, code: 'KeyP' })), 'Mod+Shift+P');
	assert.equal(eventToCombo(ev({ metaKey: true, code: 'KeyS' })), 'Mod+S');
	// Backslash code -> '\\' token regardless of the (Option-mangled) typed char.
	assert.equal(eventToCombo(ev({ altKey: true, key: '«', code: 'Backslash' })), 'Alt+\\');
	// A lone modifier or unsupported key -> null.
	assert.equal(eventToCombo(ev({ ctrlKey: true, key: 'Control', code: 'ControlLeft' })), null);
	assert.equal(eventToCombo(ev({ ctrlKey: true, code: 'F13' })), null);
});

test('toAccelerator maps Mod to CmdOrCtrl for the Electron menu hint', () => {
	assert.equal(toAccelerator('Mod+Shift+P'), 'CmdOrCtrl+Shift+P');
	assert.equal(toAccelerator('Alt+\\'), 'Alt+\\');
});

describe('the terminal key', () => {
	test("Mod+` round-trips, so the agent console's binding is bindable and rebindable", () => {
		// Through `mod()` like every other Mod assertion here: built by hand with ctrlKey it asserted
		// the WINDOWS meaning of Mod, so it passed there and failed on every Mac.
		const event = ev({ ...mod(), code: 'Backquote', key: '`' });
		assert.equal(matchesEvent('Mod+`', event), true);
		assert.equal(eventToCombo(event), 'Mod+`');
	});
});

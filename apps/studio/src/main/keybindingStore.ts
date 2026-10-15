/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { normalizeCombo, resolveKeybindings, type ResolvedKeybinding } from '../shared/keybindings';

// User keyboard-shortcut overrides live in userData/keybindings.json as a flat
// { commandId: combo } map; anything not present falls back to the default declared in
// shared/keybindings.ts. We persist only the overrides (not the full resolved set) so a
// later change to a default reaches users who never rebound that command.

export class KeybindingStore {
	private cache: Record<string, string> | null = null;

	private filePath(): string {
		return join(app.getPath('userData'), 'keybindings.json');
	}

	private read(): Record<string, string> {
		if (this.cache) {
			return this.cache;
		}
		let overrides: Record<string, string> = {};
		const path = this.filePath();
		if (existsSync(path)) {
			try {
				const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
				if (raw && typeof raw === 'object') {
					for (const [id, combo] of Object.entries(raw as Record<string, unknown>)) {
						if (typeof combo === 'string' && combo.length > 0) {
							overrides[id] = normalizeCombo(combo);
						}
					}
				}
			} catch {
				// Corrupt file — fall back to no overrides (defaults).
			}
		}
		this.cache = overrides;
		return overrides;
	}

	private write(overrides: Record<string, string>): void {
		this.cache = overrides;
		const path = this.filePath();
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(overrides, null, 2), 'utf8');
		} catch {
			// A failure to persist an override is not worth crashing over; it just won't survive restart.
		}
	}

	/** The effective bindings (overrides merged over defaults). */
	resolved(): ResolvedKeybinding[] {
		return resolveKeybindings(this.read());
	}

	/** Set one command's combo. An empty combo, or one equal to the default, clears the override. */
	set(id: string, combo: string): ResolvedKeybinding[] {
		const overrides = { ...this.read() };
		const normalized = combo ? normalizeCombo(combo) : '';
		const def = resolveKeybindings({}).find((b) => b.id === id);
		if (!normalized || (def && def.combo === normalized)) {
			delete overrides[id];
		} else {
			overrides[id] = normalized;
		}
		this.write(overrides);
		return this.resolved();
	}

	/** Reset one command (by id) or all commands (id omitted) to their defaults. */
	reset(id?: string): ResolvedKeybinding[] {
		if (id === undefined) {
			this.write({});
		} else {
			const overrides = { ...this.read() };
			delete overrides[id];
			this.write(overrides);
		}
		return this.resolved();
	}
}

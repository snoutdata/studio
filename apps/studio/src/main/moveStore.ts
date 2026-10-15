/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Saved moves → userData/moves.json.
 *
 * In main rather than in the view's state so the assistant and a coding agent edit the same
 * document the screen shows. A spec never holds a credential, so this is a plain file like
 * connections.json, not the keychain.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MoveSpec } from '@snout/move';

export class MoveStore {
	constructor(private readonly file: string) {}

	list(): MoveSpec[] {
		try {
			const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { moves?: unknown };
			return Array.isArray(raw.moves) ? (raw.moves as MoveSpec[]) : [];
		} catch {
			return [];
		}
	}

	get(id: string): MoveSpec | undefined {
		return this.list().find((move) => move.id === id);
	}

	upsert(spec: MoveSpec): MoveSpec {
		this.write([...this.list().filter((move) => move.id !== spec.id), spec]);
		return spec;
	}

	remove(id: string): void {
		this.write(this.list().filter((move) => move.id !== id));
	}

	private write(moves: MoveSpec[]): void {
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(this.file, JSON.stringify({ version: 1, moves }, null, '\t'), 'utf8');
	}
}

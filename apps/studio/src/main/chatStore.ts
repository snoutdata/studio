/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ChatSession } from '../shared/chat';

// Assistant chat history, persisted as JSON in the app data dir (newest-first, capped).
// Mirrors queryStore.ts; the panel upserts the active session after each reply.

const MAX_SESSIONS = 100;

export class ChatStore {
	private filePath(): string {
		return join(app.getPath('userData'), 'chats.json');
	}

	private read(): ChatSession[] {
		const path = this.filePath();
		if (!existsSync(path)) {
			return [];
		}
		try {
			const raw = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: ChatSession[] };
			return raw.sessions ?? [];
		} catch {
			return [];
		}
	}

	private write(sessions: ChatSession[]): void {
		const path = this.filePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ sessions }, null, 2), 'utf8');
	}

	/** Sessions, newest-updated first. */
	list(): ChatSession[] {
		return [...this.read()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** Upsert by id; floats it to the front and trims to the cap. */
	save(session: ChatSession): void {
		const rest = this.read().filter((s) => s.id !== session.id);
		this.write([session, ...rest].slice(0, MAX_SESSIONS));
	}

	delete(id: string): void {
		this.write(this.read().filter((s) => s.id !== id));
	}

	clear(): void {
		this.write([]);
	}
}

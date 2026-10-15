/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { McpLogEntry, McpLogInput } from '../shared/mcp';

// Queries an external agent ran over MCP, kept in their own log (userData/mcpLogs.json) and
// deliberately NOT in the user's query history — the two have different audiences. Newest-first,
// capped, no dedupe (an agent re-running the same query is meaningful activity worth seeing).

const MAX_ENTRIES = 500;

export class McpLogStore {
	private filePath(): string {
		return join(app.getPath('userData'), 'mcpLogs.json');
	}

	private read(): McpLogEntry[] {
		const path = this.filePath();
		if (!existsSync(path)) {
			return [];
		}
		try {
			const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
			return Array.isArray(raw) ? (raw as McpLogEntry[]) : [];
		} catch {
			return [];
		}
	}

	private write(entries: McpLogEntry[]): void {
		const path = this.filePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(entries, null, 2), 'utf8');
	}

	list(): McpLogEntry[] {
		return this.read();
	}

	record(input: McpLogInput): void {
		const entry: McpLogEntry = { ...input, id: randomUUID(), timestamp: Date.now() };
		this.write([entry, ...this.read()].slice(0, MAX_ENTRIES));
	}

	clear(): void {
		this.write([]);
	}

	delete(id: string): void {
		this.write(this.read().filter((entry) => entry.id !== id));
	}
}

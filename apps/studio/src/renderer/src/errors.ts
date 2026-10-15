/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Strip Electron's IPC error prefix from an unknown thrown value, so user-facing
 * status lines read like the underlying problem ("Connection is closed.") rather
 * than the transport wrapping it ("Error invoking remote method 'sql:execute':
 * Error: Connection is closed.").
 *
 * Electron wraps any throw inside `ipcMain.handle` so the renderer's `invoke()`
 * rejects with `Error: Error invoking remote method '<channel>': <inner>`, and
 * the inner is itself prefixed with `Error: ` when it was an Error. We peel both.
 */
export function errorMessage(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}

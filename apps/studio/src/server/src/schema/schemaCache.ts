/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DatabaseSchema } from '../../../shared/schema';

/** In-memory schema store, keyed by connection id. Feeds the completion engine. */
export class SchemaCache {
	private readonly byConnection = new Map<string, DatabaseSchema>();

	set(connectionId: string, schema: DatabaseSchema): void {
		this.byConnection.set(connectionId, schema);
	}

	get(connectionId: string): DatabaseSchema | undefined {
		return this.byConnection.get(connectionId);
	}

	delete(connectionId: string): void {
		this.byConnection.delete(connectionId);
	}

	all(): DatabaseSchema[] {
		return [...this.byConnection.values()];
	}
}

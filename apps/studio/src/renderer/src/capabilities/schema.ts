/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { backendKindForDriver, dialectFor, profileFor } from '../../../shared/engine';
import type { ColumnDraft, TableDraft } from '../ddl';
import { blankColumn } from '../ddl';
import type { CapabilityHandler } from './registry';

/**
 * Schema-authoring capabilities. `open_table_designer` opens the visual table designer seeded
 * with a draft the assistant proposes; the user reviews the generated CREATE TABLE and applies
 * it. The assistant never runs DDL directly — the designer is the review surface.
 */

function columnsFromArgs(raw: unknown): ColumnDraft[] {
	if (!Array.isArray(raw)) {
		return [blankColumn()];
	}
	const cols = raw
		.filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
		.map((c) => ({
			name: typeof c.name === 'string' ? c.name : '',
			dataType: typeof c.dataType === 'string' ? c.dataType : typeof c.type === 'string' ? (c.type as string) : '',
			nullable: c.nullable !== false,
			isPrimaryKey: c.isPrimaryKey === true || c.primaryKey === true,
			default: typeof c.default === 'string' ? c.default : '',
		}))
		.filter((c) => c.name.trim() !== '');
	return cols.length > 0 ? cols : [blankColumn()];
}

export const schemaCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'open_table_designer',
			consentLabel: 'Open the table designer with a proposed table for you to review.',
			description: 'Open the visual table designer to create a new table, prefilled with a proposed name and columns. The user reviews the generated CREATE TABLE and applies it. Requires a connected database.',
			parameters: {
				type: 'object',
				properties: {
					connectionId: { type: 'string', description: 'The connection to create the table in (see list_connections / get_app_state).' },
					schema: { type: 'string', description: 'Optional target schema/database name.' },
					name: { type: 'string', description: 'The new table name.' },
					columns: {
						type: 'array',
						description: 'Column definitions.',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string' },
								dataType: { type: 'string', description: 'e.g. INT, VARCHAR(255), TIMESTAMP.' },
								nullable: { type: 'boolean' },
								isPrimaryKey: { type: 'boolean' },
								default: { type: 'string' },
							},
							required: ['name', 'dataType'],
						},
					},
				},
				required: ['connectionId', 'name'],
			},
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			domain: 'schema',
		},
		run: (args, ctx) => {
			const connectionId = String(args.connectionId ?? '');
			const conn = ctx.snapshot().connections.find((c) => c.id === connectionId);
			if (!conn) {
				return { ok: false, summary: '', error: `No connection with id "${connectionId}".` };
			}
			if (!conn.connected) {
				return { ok: false, summary: '', error: `Connection "${conn.label}" is not connected. Connect it first.` };
			}
			// The same question the connection tree's "+" asks: can anything be created here at all?
			// A log service's scopes are the provider's, so the designer would compose a CREATE TABLE
			// that has nowhere to run.
			const label = profileFor(backendKindForDriver(conn.driver)).newEntityLabel;
			if (!label) {
				return { ok: false, summary: '', error: `"${conn.label}" has no tables you can create: its ${dialectFor(conn.driver).displayName} entities are managed outside this app.` };
			}
			const schema = typeof args.schema === 'string' && args.schema.trim() ? args.schema.trim() : undefined;
			const draft: TableDraft = { schema, name: String(args.name ?? 'new_table'), columns: columnsFromArgs(args.columns) };
			ctx.app.openTableDesigner(connectionId, schema, draft);
			return { ok: true, summary: `Opened a table designer for "${draft.name}"` };
		},
	},
];

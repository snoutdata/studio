/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../shared/connection';
import { monitorQueryRefusal } from '../shared/monitor';

/*---------------------------------------------------------------------------------------------
 *  What main checks before a model may put a query on a monitor.
 *
 *  `create_monitor` and `add_monitor_widget` hand the poller a query it then runs by itself every
 *  interval, in the background and after a restart, with nobody looking. Before this, either took
 *  any SQL for any saved connection: a model the user never let near a database could leave a
 *  DELETE running on it every minute. So, in main and before anyone is asked:
 *
 *    - the target is resolved HERE (by id or label, or the assistant's own connection when the call
 *      names none) and written back into the arguments, so the renderer acts on the connection the
 *      card named and not on whatever happens to be selected;
 *    - it must be a connection the caller may use: for an agent over MCP, one the user allowed in
 *      Settings, Agent access; for the assistant, one whose AI access lets it run queries;
 *    - the query must be a read (`monitorQueryRefusal`).
 *
 *  Both capabilities are also asked every time (`ALWAYS_ASK` in shared/capabilities.ts), and the
 *  card names the connection and shows the query whole (agentActionDetail.ts). Pure, so it is
 *  tested without Electron.
 *--------------------------------------------------------------------------------------------*/

/** The capabilities that put a query on a monitor. */
export const MONITOR_QUERY_CAPABILITIES: ReadonlySet<string> = new Set(['create_monitor', 'add_monitor_widget']);

export interface MonitorGateOptions {
	connections: ConnectionConfig[];
	/** May this caller use the connection at all? */
	allowed(connectionId: string): boolean;
	/** Where the user grants that, for the refusal: "Settings, Agent access". */
	allowedWhere: string;
	/** The connection a call that names none runs against (the assistant's own); none for an agent. */
	fallbackConnectionId?: string;
}

export type MonitorGate = { ok: true; arguments: Record<string, unknown> } | { ok: false; error: string };

/** Does this call put a query on a monitor? `create_monitor` may also make an empty one. */
function carriesQuery(name: string, args: Record<string, unknown>): boolean {
	return name === 'add_monitor_widget' || (name === 'create_monitor' && (args.title !== undefined || args.sql !== undefined));
}

export function gateMonitorCall(name: string, args: Record<string, unknown>, options: MonitorGateOptions): MonitorGate {
	if (!MONITOR_QUERY_CAPABILITIES.has(name) || !carriesQuery(name, args)) {
		return { ok: true, arguments: args };
	}
	const named = typeof args.connectionId === 'string' && args.connectionId.trim() !== '' ? args.connectionId.trim() : undefined;
	const ref = named ?? options.fallbackConnectionId;
	if (!ref) {
		return { ok: false, error: 'Name the connection the widget queries, with connectionId (its id or label; see list_connections).' };
	}
	const needle = ref.toLowerCase();
	const config = options.connections.find((c) => c.id === ref) ?? options.connections.find((c) => c.label.toLowerCase() === needle);
	if (!config) {
		return { ok: false, error: `No connection called "${ref}". Use list_connections to see them.` };
	}
	if (!options.allowed(config.id)) {
		return { ok: false, error: `Refused: "${config.label}" is not a connection the user has allowed you to query, so a monitor cannot be put on it. They can allow it in ${options.allowedWhere}.` };
	}
	const sql = typeof args.sql === 'string' ? args.sql.trim() : '';
	if (sql === '') {
		return { ok: false, error: 'Give the widget a sql query to poll.' };
	}
	const refusal = monitorQueryRefusal(sql, config.driver, config.flavor);
	if (refusal) {
		return { ok: false, error: `Refused: ${refusal.replace(/^Paused: /, '').replace(/\s*Edit the query to resume it\.$/, '')}` };
	}
	return { ok: true, arguments: { ...args, connectionId: config.id } };
}

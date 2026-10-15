/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the AI may see of a database: the data-sharing level.
 *
 * Three levels, each including the one before it:
 *
 * - `schema`: table and column names, types, keys. No values.
 * - `screen`: plus what is on screen, meaning the small sample of the result grid that rides
 *   with every chat turn, the selected cell and row, and `get_query_result`.
 * - `queries`: plus read-only queries the AI runs itself (`run_query`, `explain`), each still
 *   approved per call wherever it was before.
 *
 * It is one setting for every path that reaches a model: the assistant (whichever provider
 * serves it), and the coding agent and any other MCP client. The assistant applies it by
 * stripping the ambient fields and leaving the tools out; the MCP server, whose tool list is
 * frozen when a client connects, applies it by REFUSING, with a sentence the agent can relay.
 *
 * Unset means the user has never chosen. It behaves as `queries`, which is what the app did
 * before the setting existed, so nobody loses a working flow until they decide; the assistant
 * shows its banner while it is unset.
 */

import type { AmbientContext } from '../../ai';
import { valueFreeError } from '../memory/errorClass';

export type DataAccessLevel = 'schema' | 'screen' | 'queries';

export const DATA_ACCESS_LEVELS: readonly DataAccessLevel[] = ['schema', 'screen', 'queries'];

/** The level in force when the user has not chosen one: today's behaviour, unchanged. */
export const DEFAULT_DATA_ACCESS: DataAccessLevel = 'queries';

/** What each level is called and what it means, for the banner and Settings. */
export const DATA_ACCESS_INFO: Record<DataAccessLevel, { label: string; detail: string }> = {
	schema: {
		label: 'Schema only',
		detail: 'Table and column names, types and relationships. No values from your database. Answers about the data itself will be generic.',
	},
	screen: {
		label: 'Schema and what is on screen',
		detail: 'Also a few rows of the result you are looking at, and the cell or row you selected. The AI cannot run queries of its own.',
	},
	queries: {
		label: 'Schema, screen and read-only queries',
		detail: 'Also lets the AI run read-only queries and read their rows, with your approval for each one. The most accurate answers.',
	},
};

const RANK: Record<DataAccessLevel, number> = { schema: 0, screen: 1, queries: 2 };

/** The level in force for a stored choice (undefined: never chosen). */
export function effectiveDataAccess(chosen: DataAccessLevel | undefined): DataAccessLevel {
	return chosen && RANK[chosen] !== undefined ? chosen : DEFAULT_DATA_ACCESS;
}

/**
 * The level for one database: its own setting when it has one (the connection form), else the
 * Settings → AI default. The most specific wins in BOTH directions, so a local dev database may
 * be allowed more than the default as well as a production one less.
 */
export function resolveDataAccess(chosen: DataAccessLevel | undefined, connection: DataAccessLevel | undefined): DataAccessLevel {
	return connection && RANK[connection] !== undefined ? connection : effectiveDataAccess(chosen);
}

/** The most restrictive of some levels: the one for content that cannot be tied to a single
 *  database, so it is held to the strictest any of them is set to. Empty: the default. */
export function strictestDataAccess(levels: readonly DataAccessLevel[]): DataAccessLevel {
	return levels.reduce<DataAccessLevel>((low, level) => (RANK[level] < RANK[low] ? level : low), DEFAULT_DATA_ACCESS);
}

/** Whether `level` includes `need`. */
export function dataAccessAllows(level: DataAccessLevel, need: DataAccessLevel): boolean {
	return RANK[level] >= RANK[need];
}

/** The tools that hand database VALUES to a model, and the level each needs. A tool not listed
 *  here carries no values (schema tools, app actions) and is never gated by this setting. */
const TOOL_NEEDS: Record<string, DataAccessLevel> = {
	get_query_result: 'screen',
	// Filters the grid and reports how many rows matched: guessing values one filter at a time
	// reads them back, so it is held to what reading the grid needs.
	filter_results: 'screen',
	// A database's own error text quotes values (a duplicate key, the input it could not cast), and
	// the log carries those errors. They are on the user's screen, so they need what the screen needs.
	get_last_error: 'screen',
	get_recent_logs: 'screen',
	run_query: 'queries',
	explain: 'queries',
};

/**
 * Tools that run at every level, with what they hand on reduced to a value-free form below their
 * need instead of being refused: the class and code of an error are still what a model needs to
 * help, and refusing would hide that anything went wrong at all.
 */
const REDUCED_BELOW_NEED: ReadonlySet<string> = new Set(['get_last_error', 'get_recent_logs']);

/** Whether the tool's values are reduced to a value-free form below its need (rather than refused),
 *  so content of it that no connection can be named for may still go out, reduced. */
export function valuesReducedBelowNeed(tool: string): boolean {
	return REDUCED_BELOW_NEED.has(tool);
}

/** The level a tool needs, or undefined when it carries no database values. */
export function toolDataAccessNeed(tool: string): DataAccessLevel | undefined {
	return TOOL_NEEDS[tool];
}

/**
 * The refusal for a tool the level does not allow, or undefined when it may run. Written for a
 * model to relay: it says what is switched off and where the user turns it on.
 */
export function dataAccessRefusal(tool: string, level: DataAccessLevel): string | undefined {
	const need = TOOL_NEEDS[tool];
	if (!need || REDUCED_BELOW_NEED.has(tool) || dataAccessAllows(level, need)) {
		return undefined;
	}
	return `"${tool}" is switched off: the user has set what the AI may see to "${DATA_ACCESS_INFO[level].label}", and this needs "${DATA_ACCESS_INFO[need].label}". Tell the user that, and that they can change it in SnoutData Studio → Settings → AI, or for one database in its connection settings. Do not guess the values instead.`;
}

/** The part of a tool result this gate reads. Structural, so a capability result fits it. */
export interface ValuesResult {
	ok: boolean;
	summary: string;
	error?: string;
	refused?: boolean;
	/** The connection whose VALUES the result carries (get_query_result: the result tab's). */
	dataConnectionId?: string;
	/** `error` is the database's own message rather than a sentence the app wrote. */
	errorFromDatabase?: boolean;
}

/**
 * Check a tool result on its way to a model, for tools whose values come from wherever the user's
 * screen happens to be (the result grid) rather than from a connection the call named. `levelFor`
 * resolves a connection's level; the result is replaced by a refusal when it may not be handed on.
 */
export function gateValuesResult<T extends ValuesResult>(tool: string, result: T, levelFor: (connectionId: string | undefined) => DataAccessLevel): T {
	const need = TOOL_NEEDS[tool];
	if (need && REDUCED_BELOW_NEED.has(tool)) {
		return reduceValues(tool, need, result, levelFor);
	}
	if (!result.ok) {
		// A failed read can still carry the database's words: the error it failed on.
		if (need && result.errorFromDatabase && result.error && !dataAccessAllows(levelFor(result.dataConnectionId), need)) {
			return { ...result, error: valueFreeError(result.error) };
		}
		return result;
	}
	const refusal = dataAccessRefusal(tool, levelFor(result.dataConnectionId));
	return refusal ? ({ ...result, ok: false, summary: '', data: undefined, error: refusal, refused: true } as T) : result;
}

/** One log line as `get_recent_logs` returns it. */
interface LogLineValues {
	ts?: number;
	level?: string;
	message?: string;
	connectionId?: string;
}

/** The last error as `get_last_error` returns it. */
interface LastErrorValues {
	title?: string;
	detail?: string;
	source?: string;
	connectionId?: string;
	connectionLabel?: string;
	sql?: string;
	ts?: number;
}

/**
 * The result of a tool in {@link REDUCED_BELOW_NEED}, with every database message that the level of
 * the connection it is about does not allow replaced by its {@link valueFreeError} form. A log line
 * is judged on its own connection; one with none is judged on `levelFor(undefined)`, the caller's
 * answer for content no connection can be named for.
 */
function reduceValues<T extends ValuesResult>(tool: string, need: DataAccessLevel, result: T, levelFor: (connectionId: string | undefined) => DataAccessLevel): T {
	const allowed = (connectionId: string | undefined): boolean => dataAccessAllows(levelFor(connectionId), need);
	const data = (result as { data?: unknown }).data;
	if (!result.ok) {
		return result.error && !allowed(result.dataConnectionId) ? { ...result, error: valueFreeError(result.error) } : result;
	}
	if (tool === 'get_recent_logs' && Array.isArray(data)) {
		const lines = (data as LogLineValues[]).map((line) => (allowed(line.connectionId) ? line : { ...line, message: valueFreeError(line.message ?? '') }));
		return { ...result, data: lines };
	}
	if (tool === 'get_last_error' && data && typeof data === 'object') {
		const error = data as LastErrorValues;
		if (allowed(error.connectionId ?? result.dataConnectionId)) {
			return result;
		}
		const { title: _title, detail, ...kept } = error;
		const where = error.connectionLabel ? ` (connection "${error.connectionLabel}")` : '';
		return { ...result, summary: `Last error${where}: its text is withheld at this data-access level.`, data: { ...kept, error: valueFreeError(detail ?? error.title ?? '') } };
	}
	return result;
}

/** The ambient context with everything the level does not allow taken out. Only database VALUES
 *  are removed: the SQL on screen and the result's column names stay, since they are the user's
 *  own text and the schema's shape. The last error stays as its class and code, because a
 *  database's message can quote the values it failed on. */
export function limitAmbient(ambient: AmbientContext, level: DataAccessLevel): AmbientContext {
	if (dataAccessAllows(level, 'screen')) {
		return ambient;
	}
	const { resultRows: _rows, selectedCell: _cell, selectedRow: _row, ...rest } = ambient;
	return rest.lastError ? { ...rest, lastError: valueFreeError(rest.lastError) } : rest;
}

/**
 * A line for the system prompt saying what the model cannot see, so a question about the data
 * gets "I cannot see the rows at your current setting" rather than a confident guess. Empty at
 * the top level.
 */
export function dataAccessPromptNote(level: DataAccessLevel): string {
	switch (level) {
		case 'queries':
			return '';
		case 'screen':
			return 'DATA ACCESS: the user has allowed you the schema and what is on screen (a few rows of the shown result, the selected cell or row), but NOT running queries of your own. If an answer needs more rows than that, say so plainly, give the SQL for the user to run, and mention they can allow read-only queries in Settings → AI or in this connection\'s settings. Never invent values.';
		case 'schema':
			return 'DATA ACCESS: the user has allowed you the SCHEMA ONLY. You cannot see any values from their database, including the result grid on screen, and you cannot run queries. If a question depends on the data, say you cannot see it at their current setting, answer from the schema (give the SQL for them to run), and mention they can change it in Settings → AI or in this connection\'s settings. Never invent values.';
	}
}

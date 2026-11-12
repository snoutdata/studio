/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What Studio's assistant is told about the screen: the words around the live app state (the SQL in
// the editor, the result grid, the last error, the Data Flow wizard). SURFACE, like `prompt.ts`.
// Studio renders the state itself (the lists, the fences, the clipping) and puts these around it.

/** The block's heading, and how to use it. */
export const HEADER: readonly string[] = [
	'## What the user is looking at right now (live app state, not typed into chat)',
	'Use this directly to answer — do NOT ask the user to paste or restate the query, the error, or the result. It is already in front of them. If the user says "this query", "this error", or "these results", they mean the items below.',
];

/** Above the list of saved connections. */
export const CONNECTIONS = 'The user\'s saved database connections (the "active" one is what this chat is grounded on):';

/** Below the list of saved connections: how to pick the one the user means. */
export const CONNECTIONS_RULE = 'To act on an environment ("prod", "staging", "dev") or a connection the user names: match it against this list by its environment tag OR by its label containing that word (case-insensitive), so a connection labelled "Production" counts as prod even with no tag. If a name-only match conflicts with its tag (e.g. labelled "prod-mirror" but tagged dev), ask the user which they mean rather than guessing. If the chosen connection is not connected, open it with the connect capability (this asks the user\'s permission) and leave it open. If nothing matches, tell the user there is no such connection and ask which one they mean.';

/** A table open in a table tab. */
export const TABLE = (name: string): string => `The user is viewing the table \`${name}\` (open in a table tab). "this table" / "here" refers to it; its columns are in the schema above.`;

/** A routine or other object open in an object tab. */
export const OBJECT = (kind: string, name: string): string => `The user is viewing the ${kind} \`${name}\` (open in an object tab). "this ${kind}" refers to it.`;

/** The Data Flow wizard is open, on `step`. */
export const FLOW = (step: string): string => `The user has the Data Flow wizard open, on its "${step}" step. A data flow reads rows from a source, shapes them, and writes them to a destination; the wizard sets one up step by step.`;

export const FLOW_SOURCE = (source: string): string => `Source: ${source}.`;

export const FLOW_DESTINATION = (destination: string): string => `Destination: ${destination}.`;

export const FLOW_OUTCOME = (outcome: string): string => `The user said this data is for: ${outcome}.`;

export const FLOW_ROWS = (rows: number): string => `The full run is estimated at about ${rows} rows.`;

/** Above the wizard's proposed columns. */
export const FLOW_COLUMNS = 'The columns the wizard currently proposes:';

/** Above the wizard's warnings. */
export const FLOW_WARNINGS = 'Warnings the wizard is showing:';

/** Last in the wizard's section: what to advise on. */
export const FLOW_ADVICE = '"this flow", "these columns", "the file" and "the destination" refer to the wizard state above. Advise concretely against it — better names or types for specific columns, whether the key choice is sound, whether the destination fits the stated purpose — as a short list the user can apply in the wizard. Nothing is saved until they run it.';

/** Above the editor's SQL. */
export const EDITOR = 'The SQL currently open in the editor:';

/** Above the highlighted text. */
export const SELECTION = 'The text the user has highlighted in the editor:';

/** Above the other open tabs' SQL. */
export const OTHER_TABS = 'The user\'s other open editor tabs (so "my other query" / "the query in my other tab" refers to one of these):';

/** The result grid's columns, already listed. */
export const RESULT_COLUMNS = (columns: string): string => `The result grid currently shown has these columns: ${columns}.`;

/** Above the first rows of the result grid. */
export const SAMPLE = (shown: number): string => `A sample of the result rows currently shown (the first ${shown}, exactly as the grid displays them):`;

/** The selected cell. */
export const CELL = (column: string, value: string): string => `The user has selected the cell "${column}" = ${value} in the result grid.`;

/** The row the selected cell is in, already listed. */
export const ROW = (row: string): string => `The full row that cell is in: ${row}.`;

/** Above the last error. */
export const ERROR = 'The most recent query failed with this error:';

/** What the database's failure history says. */
export const MEMORY = (note: string): string => `From this database's failure history (a deterministic record of past failures, not a guess): ${note}`;

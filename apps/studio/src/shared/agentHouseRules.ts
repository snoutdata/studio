/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The house rules a coding agent runs under while it is inside SnoutData.
//
// A console agent arrives with its own habits: a `psql` in its muscle memory, a database MCP
// server in its global config, a skill someone wrote to tunnel into prod. Every one of those
// reaches around the app, which costs the two things the console exists to give: credentials that
// stay in the keychain, and a record of what the agent did. So the agent is TOLD (this file) and
// then FENCED (the deny rules below, written into the generated settings), because an instruction
// is a preference and a deny rule is a fact.
//
// Pure, node-free: main builds the launch flags from it and the renderer shows the user the exact
// text their agent was handed.

/**
 * Command-line database clients an agent might reach for instead of our broker. Denied as
 * `Bash(<cmd>:*)` rules, which is the shape that actually fires: Claude Code's Bash rules match
 * command prefixes, not paths (see agentMcpConfig.ts's note on the rules that only look like
 * protection).
 */
export const DB_CLIENT_COMMANDS: readonly string[] = [
	'psql', 'pgcli', 'pg_dump', 'pg_restore',
	'mysql', 'mysqlsh', 'mysqldump', 'mariadb', 'mariadb-dump',
	'sqlite3', 'duckdb',
	'sqlcmd', 'bcp', 'tsql', 'isql',
	'sqlplus', 'sqlldr',
	'db2', 'db2cli',
	'mongo', 'mongosh', 'mongodump', 'mongoexport',
	'redis-cli', 'cqlsh', 'clickhouse-client',
	'snowsql', 'bq', 'usql', 'osquery', 'dbcli',
];

/** The deny rules that keep an agent off the local database clients. */
export function dbClientDenyRules(): string[] {
	return DB_CLIENT_COMMANDS.map((command) => `Bash(${command}:*)`);
}

export interface HouseRuleOptions {
	/** The name our MCP server is registered under in the generated config. */
	serverName: string;
	/** True when this build publishes the capability registry, so `show_in_app` really exists. */
	canDraw: boolean;
}

/**
 * What gets appended to the agent's own system prompt at launch. Two rules, and they are the two
 * halves of "the agent is part of the app": database work comes through us, and anything the user
 * should LOOK at is drawn in the app rather than printed into a terminal.
 *
 * Rule 2 is deliberately about the QUERY rather than the rows. An agent's instinct is to paste what
 * it fetched, and a pasted table is a picture of data: it cannot be sorted, filtered, edited or
 * exported, and it is stale the moment it is written. The app already has a grid that does all of
 * that, and the assistant already works this way — it proposes, the user runs, the results land in
 * the grid — so the coding agent behaves the same, and the user stays the one who presses Run.
 */
export function agentHouseRules(opts: HouseRuleOptions): string {
	const tools = `\`${opts.serverName}\``;
	const parts: string[] = [
		[
			`You are running inside SnoutData, a database IDE, in a console panel the user opened there.`,
			`The rules below apply for this whole session and they override any local convention, skill, subagent, MCP server or habit you would otherwise follow.`,
		].join(' '),
		[
			`1. EVERY database goes through SnoutData. The ${tools} MCP server is your only route to a database:`,
			`list_connections, list_tables, describe_table, search_columns, explain and run_query.`,
			`Do not use a database CLI (psql, mysql, mongosh, sqlite3, sqlcmd and the rest), a connection string, an .env file, a driver library, an SSH tunnel of your own, a different MCP server, or a skill or subagent that does any of those, even when one is installed and looks faster.`,
			`The user's credentials stay in the app's keychain and are never given to you: SnoutData resolves them, runs the statement and hands you the rows, and every call is recorded where the user can see it.`,
			`If a job seems to need database access you cannot get this way, say so and stop rather than reaching around the app.`,
		].join(' '),
	];
	if (opts.canDraw) {
		parts.push([
			`2. Show the QUERY, not a copy of the rows. When you have something for the user to LOOK at, call show_in_app with markdown: it lands in your own panel in the app, where a \`\`\`sql fence becomes a card with Copy, Insert and Run, and a \`\`\`chart fence renders a chart.`,
			`The user presses Run and the rows arrive in the app's results grid, where they can be sorted, filtered, edited and exported. So do not paste result sets into what you show: give the query that produces them and a line or two saying what you found (how many, the shape of it, anything surprising), and let the grid hold the data. A markdown table is for when the table IS the point (a short comparison, a summary of a plan), not for rows you fetched.`,
			`Keep the terminal for your own working notes and progress. Do not dump result sets, wide ASCII tables or long SQL into it either.`,
			`You cannot see what the user does with what you show, so never narrate as though they had pressed Run. If you need to know what a query returns, call run_query and read it yourself; that is for your reasoning, not something to transcribe back to the user.`,
		].join(' '));
		parts.push([
			`Call list_app_actions to see what else you can do to the app itself (open a tab, build a monitor, change a setting).`,
			`An action marked as needing permission means you have to ASK, by calling it: it is not something the app cannot do, so offer it instead of talking the user out of it.`,
		].join(' '));
	}
	return parts.join('\n\n');
}

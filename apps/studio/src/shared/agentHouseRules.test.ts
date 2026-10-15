/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DB_CLIENT_COMMANDS, agentHouseRules, dbClientDenyRules } from './agentHouseRules';

const RULES = agentHouseRules({ serverName: 'snoutdata', canDraw: true });

describe('agentHouseRules', () => {
	test('names our MCP server as the only route to a database', () => {
		assert.match(RULES, /snoutdata/);
		for (const tool of ['list_connections', 'describe_table', 'run_query']) {
			assert.ok(RULES.includes(tool), `the rules never mention ${tool}`);
		}
	});

	test('overrides the agent own habits explicitly, since that is the whole point', () => {
		// An instruction that says "prefer our tools" loses to an installed psql. The wording has to
		// say it outranks a local skill, a local MCP server and the CLI, by name.
		for (const habit of ['skill', 'MCP server', 'psql', 'connection string', '.env']) {
			assert.ok(RULES.includes(habit), `the rules never mention ${habit}`);
		}
	});

	test('makes the credential property true as stated, and never overstates it', () => {
		assert.match(RULES, /never given to you/);
		// The standing rule: "never RECEIVES your credentials" is ours to say; "cannot
		// REACH them" is a sandbox claim we do not implement.
		assert.equal(/cannot (reach|access)/i.test(RULES), false);
		assert.equal(/sandbox/i.test(RULES), false);
	});

	test('sends what the user should look at to the app, not the terminal', () => {
		assert.ok(RULES.includes('show_in_app'));
		// Deliberately NOT named as a place: where the surface renders follows where the user put the
		// console (docking.ts, `agentSurfaceHome`), so a rule that promised "the panel above your
		// terminal" would be wrong half the time.
		assert.match(RULES, /your own panel in the app/);
		assert.match(RULES, /terminal/);
		assert.equal(/chat panel/.test(RULES), false);
	});

	test('asks for the QUERY, not a pasted copy of the rows', () => {
		// The behaviour this rule exists to stop: an agent pasting a result set as a markdown table,
		// which cannot be sorted, filtered or exported and is stale on arrival. The app has a grid;
		// the assistant already works this way, and so does the agent.
		assert.match(RULES, /Show the QUERY, not a copy of the rows/);
		assert.match(RULES, /results grid/);
		assert.match(RULES, /sorted, filtered/);
	});

	test('does not mention drawing when this build cannot draw', () => {
		const plain = agentHouseRules({ serverName: 'snoutdata', canDraw: false });
		assert.equal(plain.includes('show_in_app'), false);
		assert.equal(plain.includes('list_app_actions'), false);
		// The database rule still stands: it is the half that does not depend on a window.
		assert.match(plain, /run_query/);
	});

	test('says "needs permission" means ask, never refused', () => {
		// An agent told it is refused reports to the user that the APP cannot do the thing, which is
		// the exact confusion fixed in the tool descriptions.
		assert.match(RULES, /have to ASK/);
		assert.match(RULES, /not something the app cannot do/);
	});
});

describe('dbClientDenyRules', () => {
	test('is one command-scoped Bash rule per client', () => {
		const rules = dbClientDenyRules();
		assert.equal(rules.length, DB_CLIENT_COMMANDS.length);
		// Command-scoped, not path-scoped: a Bash rule matches what was TYPED, so `Bash(psql:*)`
		// fires and `Bash(cat:/some/path/**)` would not.
		assert.ok(rules.every((rule) => /^Bash\([a-z0-9_-]+:\*\)$/.test(rule)), rules.join(', '));
	});

	test('covers the clients for every backend the app itself drives', () => {
		const rules = dbClientDenyRules().join(' ');
		for (const command of ['psql', 'mysql', 'sqlcmd', 'sqlplus', 'db2', 'mongosh', 'snowsql', 'duckdb', 'sqlite3']) {
			assert.ok(rules.includes(`Bash(${command}:*)`), `${command} is not denied`);
		}
	});

	test('lists no command twice, so the generated deny list is exactly as long as it looks', () => {
		assert.equal(new Set(DB_CLIENT_COMMANDS).size, DB_CLIENT_COMMANDS.length);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { capabilityTitle, type CapabilitySpec } from './capabilities';

function spec(over: Partial<CapabilitySpec>): CapabilitySpec {
	return { name: 'x', description: 'd', parameters: {}, domain: 'test', mutates: true, implicitConnection: 'none', returnsData: 'none', ...over };
}

test('capabilityTitle turns a tool name into something a person reads', () => {
	assert.equal(capabilityTitle('open_connection_form'), 'Open connection form');
	assert.equal(capabilityTitle('connect'), 'Connect');
	assert.equal(capabilityTitle('add_monitor_widget'), 'Add monitor widget');
});

test('capabilityTitle is sentence case, not Title Case', () => {
	// "Open Connection Form" reads like a product name; only the first word is capitalized.
	assert.equal(capabilityTitle('open_table_designer'), 'Open table designer');
});

test('capabilityTitle keeps acronyms upper-case wherever they fall', () => {
	assert.equal(capabilityTitle('insert_sql'), 'Insert SQL');
	assert.equal(capabilityTitle('sql_preview'), 'SQL preview');
	assert.equal(capabilityTitle('create_ssh_tunnel'), 'Create SSH tunnel');
});

test('an explicit title wins over the derived one', () => {
	assert.equal(capabilityTitle(spec({ name: 'run_current', title: 'Run the current query' })), 'Run the current query');
	// ...and a spec without one still derives.
	assert.equal(capabilityTitle(spec({ name: 'notify_user' })), 'Notify user');
});

test('capabilityTitle survives a name it cannot improve', () => {
	assert.equal(capabilityTitle(''), '');
	assert.equal(capabilityTitle('__'), '__');
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentConsoleStore } from './agentConsoleStore';

function withStore(fn: (store: AgentConsoleStore, dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'agentstore-'));
	try {
		fn(new AgentConsoleStore(dir), dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('AgentConsoleStore', () => {
	test('defaults to Claude Code with the mutating path closed', () => {
		withStore((store) => {
			assert.equal(store.lastKind(), 'claude');
			assert.equal(store.allowsMutatingCapabilities(), false);
		});
	});

	test('round-trips through the file', () => {
		withStore((store, dir) => {
			store.setLastKind('codex');
			store.setAllowMutatingCapabilities(true);
			store.setPinnedPath('claude', '/opt/claude');
			const reopened = new AgentConsoleStore(dir);
			assert.equal(reopened.lastKind(), 'codex');
			assert.equal(reopened.allowsMutatingCapabilities(), true);
			assert.equal(reopened.pinnedPath('claude'), '/opt/claude');
		});
	});

	test('clearing a pinned path removes it', () => {
		withStore((store) => {
			store.setPinnedPath('claude', '/opt/claude');
			store.setPinnedPath('claude', undefined);
			assert.equal(store.pinnedPath('claude'), undefined);
		});
	});

	test('a corrupt file fails CLOSED, not open', () => {
		withStore((_store, dir) => {
			writeFileSync(join(dir, 'agents.json'), '{ not json', 'utf8');
			const store = new AgentConsoleStore(dir);
			assert.equal(store.allowsMutatingCapabilities(), false);
			assert.equal(store.lastKind(), 'claude');
		});
	});

	test('a truthy-but-not-true value does not open the mutating path', () => {
		withStore((_store, dir) => {
			writeFileSync(join(dir, 'agents.json'), JSON.stringify({ allowMutatingCapabilities: 'yes' }), 'utf8');
			assert.equal(new AgentConsoleStore(dir).allowsMutatingCapabilities(), false);
		});
	});

	test('an unknown agent kind in the file is ignored', () => {
		withStore((_store, dir) => {
			writeFileSync(join(dir, 'agents.json'), JSON.stringify({ lastKind: 'cursor' }), 'utf8');
			assert.equal(new AgentConsoleStore(dir).lastKind(), 'claude');
		});
	});
});

/*
 * The rule that decides what appears on the activity bar.
 *
 * Three states, not two: never decided, on, off. Undecided is what lets an agent installed months
 * from now turn up by itself; off is a decision that outranks any number of later sightings.
 */
describe('which agents the user sees', () => {
	test('an agent nobody has decided about is off, but is not a decision', () => {
		withStore((store) => {
			assert.equal(store.isEnabled('codex'), false);
			assert.equal(store.hasDecided('codex'), false);
		});
	});

	test('the first sighting turns it on, and says so', () => {
		withStore((store) => {
			assert.equal(store.noteDetected('codex', 1_000), true);
			assert.equal(store.isEnabled('codex'), true);
			assert.equal(store.preference('codex').firstSeenAt, 1_000);
		});
	});

	test('a second sighting changes nothing and does not claim to be the first', () => {
		withStore((store) => {
			store.noteDetected('codex', 1_000);
			assert.equal(store.noteDetected('codex', 2_000), false);
			assert.equal(store.preference('codex').firstSeenAt, 1_000, 'the first time stays the first time');
		});
	});

	test('an agent the user switched OFF is never turned back on by a sighting', () => {
		// The whole point: uninstalling and reinstalling, or simply launching again tomorrow, must
		// not undo a decision the user made.
		withStore((store) => {
			store.noteDetected('opencode', 1_000);
			store.setEnabled('opencode', false);
			assert.equal(store.noteDetected('opencode', 2_000), false);
			assert.equal(store.isEnabled('opencode'), false);
			assert.equal(store.hasDecided('opencode'), true);
		});
	});

	test('the user can turn it back on, and that sticks too', () => {
		withStore((store, dir) => {
			store.setEnabled('claude', false);
			store.setEnabled('claude', true);
			assert.equal(new AgentConsoleStore(dir).isEnabled('claude'), true);
		});
	});

	test('a decision survives a restart', () => {
		withStore((store, dir) => {
			store.noteDetected('codex', 1_000);
			store.setEnabled('codex', false);
			const reopened = new AgentConsoleStore(dir);
			assert.equal(reopened.isEnabled('codex'), false);
			assert.equal(reopened.hasDecided('codex'), true);
		});
	});

	test('a non-boolean enabled in the file is not a decision', () => {
		// Fails towards "ask the discovery again" rather than towards a state the user never chose.
		withStore((_store, dir) => {
			writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agents: { codex: { enabled: 'yes' } } }), 'utf8');
			const store = new AgentConsoleStore(dir);
			assert.equal(store.hasDecided('codex'), false);
			assert.equal(store.noteDetected('codex', 5), true);
		});
	});

	test('a standing "always allow" is per capability name, and revocable', () => {
		withStore((store) => {
			assert.equal(store.isAutoApproved('open_in_new_tab'), false);
			store.setAutoApproved('open_in_new_tab', true);
			assert.equal(store.isAutoApproved('open_in_new_tab'), true);
			// One name only. Granting one action says nothing about any other.
			assert.equal(store.isAutoApproved('set_setting'), false);
			store.setAutoApproved('open_in_new_tab', false);
			assert.equal(store.isAutoApproved('open_in_new_tab'), false);
		});
	});

	test('turning app changes off forgets the grants', () => {
		// Otherwise switching the feature back on silently re-opens everything ever allowed, which
		// is not what "off" looked like when the user chose it.
		withStore((store) => {
			store.setAllowMutatingCapabilities(true);
			store.setAutoApproved('open_in_new_tab', true);
			store.setAllowMutatingCapabilities(false);
			assert.deepEqual(store.config().autoApproveCapabilities, []);
			store.setAllowMutatingCapabilities(true);
			assert.equal(store.isAutoApproved('open_in_new_tab'), false);
		});
	});

	test('grants survive a reload, and a corrupt list grants nothing', () => {
		withStore((store, dir) => {
			store.setAutoApproved('insert_sql', true);
			assert.equal(new AgentConsoleStore(dir).isAutoApproved('insert_sql'), true);
			writeFileSync(join(dir, 'agents.json'), JSON.stringify({ autoApproveCapabilities: 'insert_sql' }), 'utf8');
			assert.deepEqual(new AgentConsoleStore(dir).config().autoApproveCapabilities, []);
		});
	});

	test('setAutoApprovedAll grants a whole list in one go, and takes it back the same way', () => {
		withStore((store) => {
			store.setAutoApprovedAll(['open_in_new_tab', 'insert_sql', 'remember_this'], true);
			assert.deepEqual(store.config().autoApproveCapabilities.sort(), ['insert_sql', 'open_in_new_tab', 'remember_this']);
			store.setAutoApprovedAll(['open_in_new_tab', 'insert_sql', 'remember_this'], false);
			assert.deepEqual(store.config().autoApproveCapabilities, []);
		});
	});

	test('running SQL never gets a standing yes, however it is asked for or was stored', () => {
		// run_current runs whatever is in the editor, writes included; run_data_flow writes to its
		// destination. A yes is for the run in front of the person.
		withStore((store, dir) => {
			store.setAutoApproved('run_current', true);
			store.setAutoApprovedAll(['run_data_flow', 'open_in_new_tab'], true);
			assert.deepEqual(store.config().autoApproveCapabilities, ['open_in_new_tab']);
			writeFileSync(join(dir, 'agents.json'), JSON.stringify({ allowMutatingCapabilities: true, autoApproveCapabilities: ['run_current', 'open_in_new_tab'] }), 'utf8');
			const reloaded = new AgentConsoleStore(dir);
			assert.equal(reloaded.isAutoApproved('run_current'), false);
			assert.equal(reloaded.isAutoApproved('open_in_new_tab'), true);
		});
	});

	test('setAutoApprovedAll leaves grants outside the list alone', () => {
		// Settings sends the names it is SHOWING. A capability whose module has not published yet
		// must not lose a grant the user made earlier just because it was off-screen.
		withStore((store) => {
			store.setAutoApproved('remember_this', true);
			store.setAutoApprovedAll(['open_in_new_tab'], true);
			assert.equal(store.isAutoApproved('remember_this'), true);
			store.setAutoApprovedAll(['open_in_new_tab'], false);
			assert.equal(store.isAutoApproved('remember_this'), true);
			assert.equal(store.isAutoApproved('open_in_new_tab'), false);
		});
	});

	test('setAutoApprovedAll is idempotent and survives a reload', () => {
		withStore((store, dir) => {
			store.setAutoApprovedAll(['a', 'b'], true);
			store.setAutoApprovedAll(['a', 'b'], true);
			assert.deepEqual(store.config().autoApproveCapabilities.sort(), ['a', 'b']);
			assert.deepEqual(new AgentConsoleStore(dir).config().autoApproveCapabilities.sort(), ['a', 'b']);
			store.setAutoApprovedAll([], true);
			assert.deepEqual(store.config().autoApproveCapabilities.sort(), ['a', 'b']);
		});
	});

	test('clearAutoApproved forgets everything at once', () => {
		withStore((store) => {
			store.setAutoApproved('a', true);
			store.setAutoApproved('b', true);
			store.clearAutoApproved();
			assert.deepEqual(store.config().autoApproveCapabilities, []);
		});
	});

	test('agents are independent of one another', () => {
		withStore((store) => {
			store.noteDetected('claude', 1);
			store.setEnabled('claude', false);
			store.noteDetected('opencode', 2);
			assert.equal(store.isEnabled('claude'), false);
			assert.equal(store.isEnabled('opencode'), true);
		});
	});
});

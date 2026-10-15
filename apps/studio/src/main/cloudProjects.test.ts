/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudApi, CloudProjectSummary } from './cloudApi';
import { askCloudProject, cloudProjectsView, createCloudProject, deleteCloudProject, toRow } from './cloudProjects';
import { CloudRequestError } from './cloudApi';

// The pods view. What it OFFERS is decided here; what is ALLOWED is the control plane's
// and is never re-implemented. These prove the two do not drift into disagreeing, and that
// the panel is honest about "asked" versus "done".

function project(over: Partial<CloudProjectSummary> = {}): CloudProjectSummary {
	return {
		ref: 'exampleref001',
		name: "first light",
		region: 'us-west-2',
		production: false,
		state: 'ready',
		desiredState: 'running',
		host: 'exampleref001.db.snoutdata.com',
		database: 'exampleref001',
		user: 'exampleref001_owner',
		wakesInstantly: true,
		readOnly: false,
		sizeBytes: 8_058_547,
		...over,
	};
}

function api(over: Partial<CloudApi> = {}): CloudApi {
	return {
		account: async () => 'alex@example.com',
		list: async () => [project()],
		connection: async () => { throw new Error('not used'); },
		pause: async () => ({ project: project({ desiredState: 'paused' }), changed: true }),
		resume: async () => ({ project: project(), changed: true }),
		mintToken: async () => { throw new Error('not used'); },
		create: async () => { throw new Error('not used'); },
		requestExport: async () => { throw new Error('not used'); },
		exportStatus: async () => { throw new Error('not used'); },
		remove: async () => { throw new Error('not used'); },
		request: async () => { throw new Error('not used'); },
		...over,
	};
}

test('a running project can be stopped and not started', () => {
	const row = toRow(project());
	assert.equal(row.canPause, true);
	assert.equal(row.canResume, false);
	assert.equal(row.busy, false);
});

test('a paused project can be started and not stopped', () => {
	const row = toRow(project({ state: 'paused', desiredState: 'paused' }));
	assert.equal(row.canResume, true);
	assert.equal(row.canPause, false);
});

test('a production project is never offered a stop, and the reason is stated up front', () => {
	// A property of the project the user set themselves, so it is worth saying before they
	// try — unlike the transient refusals, where "wait a second" is the better answer.
	const row = toRow(project({ production: true }));
	assert.equal(row.canPause, false);
	assert.match(row.pauseRefusal ?? '', /never paused/);
});

test('a project mid-flight is offered nothing, and says what it is doing', () => {
	// Something is already happening. Asking for a second thing on top is how a pod ends
	// up being told to start and stop in the same tick.
	for (const state of ['creating', 'starting', 'pausing', 'restoring']) {
		const row = toRow(project({ state, desiredState: 'running' }));
		assert.equal(row.busy, true, `${state} should read as busy`);
		assert.equal(row.canPause, false, `${state} should offer no stop`);
		assert.equal(row.canResume, false, `${state} should offer no start`);
	}
});

test('ready satisfies running: the two fields do NOT share a vocabulary', () => {
	// The bug this caught on the first run. `desired_state` is running/paused/deleted and
	// `state` is creating/starting/ready/…, so comparing the raw strings marks every
	// healthy project as busy and offers it nothing at all.
	const row = toRow(project({ state: 'ready', desiredState: 'running' }));
	assert.equal(row.busy, false);
	assert.equal(row.desiredState, undefined, 'no redundant "→ running" beside "ready"');
	assert.equal(row.canPause, true);
});

test('an errored project is stuck, not busy, so it still offers what it can', () => {
	// A spinner forever is the wrong answer to "something failed". Nothing is happening.
	const row = toRow(project({ state: 'error', desiredState: 'running' }));
	assert.equal(row.busy, false);
	assert.equal(row.canPause, true);
});

test('a state that disagrees with the desired state is busy, whatever the two are', () => {
	// The gap IS the work: `ready` with a desired state of `paused` is a project on its
	// way down, and offering to stop it again would be a second identical request.
	const row = toRow(project({ state: 'ready', desiredState: 'paused' }));
	assert.equal(row.busy, true);
	assert.equal(row.canPause, false);
	assert.equal(row.desiredState, 'paused');
});

test('a cold project says so, because its next start is a restore rather than a start', () => {
	assert.equal(toRow(project({ state: 'paused', desiredState: 'paused', wakesInstantly: false })).wakesInstantly, false);
});

test('a signed-out user is told to sign in, not shown an empty list', async () => {
	const view = await cloudProjectsView(api({ account: async () => null }));
	assert.equal(view.projects.length, 0);
	assert.match(view.unavailable ?? '', /Sign in/);
});

test('an account with no projects is told where to make one', async () => {
	const view = await cloudProjectsView(api({ list: async () => [] }));
	assert.match(view.unavailable ?? '', /no hosted databases yet/);
	assert.equal(view.account, 'alex@example.com');
});

test('a control plane that cannot be reached says so, and keeps the account', async () => {
	const view = await cloudProjectsView(api({ list: async () => { throw new Error("offline"); } }));
	assert.match(view.unavailable ?? '', /Could not reach SnoutData Cloud: offline/);
	assert.equal(view.account, 'alex@example.com', 'still signed in; the network is the problem');
});

test('a front door restarting under a poll is asked again, never shown as unreachable', async () => {
	let calls = 0;
	const view = await cloudProjectsView(api({
		list: async () => {
			calls++;
			if (calls < 3) {
				throw new CloudRequestError("Failed to fetch", calls === 1 ? 0 : 502);
			}
			return [project({ state: 'creating', desiredState: 'running' })];
		},
	}), async () => undefined);
	assert.equal(calls, 3);
	assert.equal(view.unavailable, undefined);
	assert.equal(view.projects[0].state, 'creating');
	assert.equal(view.projects[0].busy, true);
});

test('a refusal is not retried, and a control plane that stays down is reported once the retries are spent', async () => {
	let refused = 0;
	await cloudProjectsView(api({ list: async () => { refused++; throw new CloudRequestError("no", 403); } }), async () => undefined);
	assert.equal(refused, 1);
	let down = 0;
	const view = await cloudProjectsView(api({ list: async () => { down++; throw new CloudRequestError("bad gateway", 503); } }), async () => undefined);
	assert.equal(down, 5);
	assert.match(view.unavailable ?? '', /Could not reach SnoutData Cloud: bad gateway/);
});

test('a deleted project is not listed', async () => {
	const view = await cloudProjectsView(api({ list: async () => [project({ state: 'deleted' })] }));
	assert.equal(view.projects.length, 0);
});

test('an action reports what was ASKED, never what is done', async () => {
	// pause/resume set a desired state and return; the host agent acts on its next tick.
	// Reporting "stopped" here would be a lie for several seconds.
	const outcome = await askCloudProject(api(), 'pause', 'exampleref001');
	assert.equal(outcome.ok, true);
	assert.match(outcome.message, /Asked it to stop/);
});

test('a pause that was accepted closes the app\'s own connections to it, which would wake it again', async () => {
	const closed: string[] = [];
	const outcome = await askCloudProject(api(), 'pause', 'exampleref001', async (ref) => { closed.push(ref); });
	assert.equal(outcome.ok, true);
	assert.deepEqual(closed, ['exampleref001']);
	// A resume, or a refused pause, leaves them alone.
	await askCloudProject(api(), 'resume', 'exampleref001', async (ref) => { closed.push(ref); });
	await askCloudProject(api({ pause: async () => { throw new CloudRequestError("a production project is never paused", 409); } }), 'pause', 'exampleref001', async (ref) => { closed.push(ref); });
	assert.deepEqual(closed, ['exampleref001']);
});

test('an action that changed nothing says so, instead of promising a wait', async () => {
	const outcome = await askCloudProject(
		api({ pause: async () => ({ project: project(), changed: false }) }),
		'pause',
		'exampleref001',
	);
	assert.equal(outcome.ok, true);
	assert.match(outcome.message, /Already stopped/);
});

test("a refusal is shown in the control plane's own words, and is not a failure of ours", async () => {
	// The rules live in the tested control package and come back as sentences. Composing
	// our own here would be a second copy of a policy, and the copy that disagrees.
	const outcome = await askCloudProject(
		api({ pause: async () => { throw new Error("a production project is never paused"); } }),
		'pause',
		'exampleref001',
	);
	assert.equal(outcome.ok, false);
	assert.equal(outcome.message, "a production project is never paused");
});

test('create adds the project as a connection and says so', async () => {
	let connected = '';
	const outcome = await createCloudProject(
		api({ create: async () => ({ project: project({ ref: 'newref', state: 'creating' }) }) }),
		{ name: " orders ", region: 'us-west-2', production: false },
		async (ref) => { connected = ref; },
	);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.ref, 'newref');
	assert.equal(outcome.connected, true);
	assert.equal(connected, 'newref');
});

test('a create refused by the control plane is a refusal in its own words, and nothing is connected', async () => {
	const outcome = await createCloudProject(
		api({ create: async () => { throw new CloudRequestError("Your plan allows 1 project", 403); } }),
		{ name: "two", region: 'us-west-2', production: false },
		async () => { throw new Error('must not connect'); },
	);
	assert.equal(outcome.ok, false);
	assert.equal(outcome.refused, true);
	assert.match(outcome.message, /plan allows 1/);
});

test('a create that worked with a connection that did not still reports the create', async () => {
	const outcome = await createCloudProject(
		api({ create: async () => ({ project: project({ ref: 'newref' }) }) }),
		{ name: "x", region: 'us-west-2', production: false },
		async () => { throw new Error('keychain locked'); },
	);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.connected, false);
	assert.match(outcome.message, /keychain locked/);
});

test('a blank name is refused before any call', async () => {
	const outcome = await createCloudProject(api(), { name: "  ", region: 'us-west-2', production: false }, async () => undefined);
	assert.equal(outcome.refused, true);
});

test('a delete removes the project connections, and a refused one removes nothing', async () => {
	let removed = '';
	const ok = await deleteCloudProject(api({ remove: async () => ({ project: project(), changed: true }) }), 'x', async (ref) => { removed = ref; return 1; });
	assert.equal(removed, 'x');
	assert.match(ok.message, /connection was removed/);
	removed = '';
	const refused = await deleteCloudProject(api({ remove: async () => { throw new CloudRequestError('not yours', 403); } }), 'x', async (ref) => { removed = ref; return 1; });
	assert.equal(refused.ok, false);
	assert.equal(removed, '');
});

test('delete asks, and a project mid-flight offers no delete', async () => {
	const outcome = await deleteCloudProject(api({ remove: async () => ({ project: project({ desiredState: 'deleted' }), changed: true }) }), 'x');
	assert.equal(outcome.ok, true);
	assert.equal(toRow(project({ state: 'starting' })).canDelete, false);
	assert.equal(toRow(project()).canDelete, true);
});

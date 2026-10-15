/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ConnectionConfig } from '../shared/connection';
import { dueLabel, trayModel, type TrayCloudProjectInput, type TrayInput, type TrayLocalProjectInput } from './trayMenu';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');

interface TestFlow {
	id: string;
	name: string;
}

function flow(id: string, name: string): TestFlow {
	return { id, name };
}

function connection(id: string, label: string, environment?: string): ConnectionConfig {
	return { id, label, driver: 'postgres', host: 'localhost', port: 5432, username: 'u', environment } as ConnectionConfig;
}

/** The tray's input, with each flow's due time given as a function over the flows, as the
 *  scheduler would answer it. */
function input(partial: Omit<Partial<TrayInput>, 'flows'> & { flows?: TestFlow[]; dueAt?: (flow: TestFlow) => Date | null } = {}): TrayInput {
	const { flows = [], dueAt = () => null, ...rest } = partial;
	return {
		flowsAvailable: true,
		flows: flows.map((f) => ({ ...f, dueAt: dueAt(f) })),
		running: new Set<string>(),
		failed: new Set<string>(),
		entitled: true,
		paused: false,
		connections: [],
		connectedIds: new Set<string>(),
		account: { email: null, tier: 'free', restoring: false },
		update: null,
		review: { enabled: false, watching: 0, awaiting: 0 },
		projects: { local: [], cloud: [], busy: new Set<string>() },
		now: NOW,
		...rest,
	};
}

describe('dueLabel', () => {
	test('counts down in the largest unit that still reads as a number', () => {
		assert.equal(dueLabel(new Date(NOW + 12 * 60_000), NOW), 'in 12m');
		assert.equal(dueLabel(new Date(NOW + 3 * 3_600_000), NOW), 'in 3h');
		assert.equal(dueLabel(new Date(NOW + 50 * 3_600_000), NOW), 'in 2d');
	});

	test('anything already owed is due now, not a negative countdown', () => {
		assert.equal(dueLabel(new Date(NOW - 60_000), NOW), 'due now');
		assert.equal(dueLabel(new Date(NOW), NOW), 'due now');
	});
});

describe('trayModel flows', () => {
	test('lists only flows that are scheduled or running', () => {
		const [scheduled, idle, manual] = [flow('a', "Nightly orders"), flow('b', "One off"), flow('c', "Big import")];
		const model = trayModel(input({
			flows: [scheduled, idle, manual],
			running: new Set(['c']),
			dueAt: (spec) => spec.id === 'a' ? new Date(NOW + 12 * 60_000) : null,
		}));
		assert.deepEqual(model.flows.map((item) => item.name), ["Big import", "Nightly orders"]);
		assert.equal(model.flowsEmpty, null);
		assert.equal(model.flowsOverflow, 0);
	});

	test('a running flow sorts first, says so, and is not offered a run', () => {
		const model = trayModel(input({
			flows: [flow('a', "Soon"), flow('b', "Running")],
			running: new Set(['b']),
			dueAt: () => new Date(NOW + 60_000),
		}));
		assert.deepEqual(model.flows.map((item) => [item.name, item.detail, item.running, item.dot]), [
			["Running", 'running', true, 'busy'],
			["Soon", 'in 1m', false, 'ok'],
		]);
	});

	test('soonest due comes first', () => {
		const due: Record<string, number> = { a: 3, b: 1, c: 2 };
		const model = trayModel(input({
			flows: [flow('a', "A"), flow('b', "B"), flow('c', "C")],
			dueAt: (spec) => new Date(NOW + due[spec.id] * 3_600_000),
		}));
		assert.deepEqual(model.flows.map((item) => item.name), ["B", "C", "A"]);
	});

	test('says nothing is scheduled rather than showing an empty submenu', () => {
		const model = trayModel(input({ flows: [flow('a', "Idle")] }));
		assert.deepEqual(model.flows, []);
		assert.equal(model.flowsEmpty, "No scheduled flows");
		assert.equal(model.status.label, "SnoutData Studio is running");
	});

	test('caps the list and counts the rest', () => {
		const many = Array.from({ length: 13 }, (_v, i) => flow(`f${i}`, `Flow ${i}`));
		const model = trayModel(input({ flows: many, dueAt: () => new Date(NOW + 60_000) }));
		assert.equal(model.flows.length, 8);
		assert.equal(model.flowsOverflow, 5);
	});

	test('a failed flow is listed, named and sorted above the ones that are merely waiting', () => {
		const model = trayModel(input({
			flows: [flow('a', "Nightly orders"), flow('b', "Broken"), flow('c', "Manual, broke")],
			failed: new Set(['b', 'c']),
			dueAt: (spec) => spec.id === 'c' ? null : new Date(NOW + 12 * 60_000),
		}));
		assert.deepEqual(model.flows.map((item) => [item.name, item.detail, item.dot]), [
			["Broken", 'failed, in 12m', 'error'],
			["Manual, broke", 'failed', 'error'],
			["Nightly orders", 'in 12m', 'ok'],
		]);
		assert.equal(model.status.label, "2 flows failed");
		// Two are listed as failed, but only two of the three are on a schedule.
		assert.equal(model.tooltip, 'SnoutData Studio\n2 flows scheduled');
	});

	test('one failure is named, and work in flight still outranks it', () => {
		const failing = input({
			flows: [flow('a', "Nightly orders"), flow('b', "Busy")],
			failed: new Set(['a']),
			dueAt: () => new Date(NOW + 60_000),
		});
		assert.deepEqual(trayModel(failing).status, { label: 'Last run of "Nightly orders" failed', dot: 'error' });
		assert.deepEqual(trayModel({ ...failing, running: new Set(['b']) }).status, { label: 'Running "Busy"', dot: 'busy' });
	});

	test('a countdown nothing will act on says paused instead, on a plan lapse or a pause', () => {
		const lapsed = trayModel(input({
			flows: [flow('a', "Nightly orders")],
			dueAt: () => new Date(NOW + 60_000),
			entitled: false,
		}));
		assert.equal(lapsed.flows[0].detail, "paused");
		assert.equal(lapsed.flows[0].dot, 'idle');
		assert.equal(lapsed.status.label, "Scheduled flows need a paid plan");

		const paused = trayModel(input({
			flows: [flow('a', "Nightly orders")],
			dueAt: () => new Date(NOW + 60_000),
			paused: true,
		}));
		assert.equal(paused.flows[0].detail, "paused");
		assert.equal(paused.status.label, "Scheduled flows are paused");
		assert.equal(paused.schedules?.label, "Resume Scheduled Flows");
	});

	test('a build without Data Flows never speaks of flows', () => {
		const open = trayModel(input({ flowsAvailable: false }));
		assert.equal(open.flowsAvailable, false);
		assert.equal(open.schedules, null, 'nothing to pause: no flows and no reviewer');
		assert.equal(open.status.label, "SnoutData Studio is running");

		// With the reviewer set up, the switch pauses reviews, and says only that.
		const reviewing = trayModel(input({ flowsAvailable: false, review: { enabled: true, watching: 1, awaiting: 0 } }));
		assert.deepEqual(reviewing.schedules, { label: "Pause Reviews", paused: false });
		const paused = trayModel(input({ flowsAvailable: false, paused: true, review: { enabled: true, watching: 1, awaiting: 0 } }));
		assert.deepEqual(paused.schedules, { label: "Resume Reviews", paused: true });
		assert.equal(paused.status.label, "Reviews are paused");
		// Every word the menu could show (the values, not the field names).
		const words = (value: unknown): string[] =>
			typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(words) : [];
		for (const model of [open, reviewing, paused]) {
			assert.deepEqual(words(model).filter((word) => /flow/i.test(word)), []);
		}
	});
});

describe('trayModel connections', () => {
	test('connected first, then by name, with production called out', () => {
		const model = trayModel(input({
			connections: [connection('a', "Local"), connection('b', "Aurora", 'prod'), connection('c', "Staging")],
			connectedIds: new Set(['b', 'c']),
		}));
		assert.deepEqual(model.connections.map((item) => [item.label, item.detail, item.dot]), [
			["Aurora", 'PROD, connected', 'warn'],
			["Staging", 'connected', 'ok'],
			["Local", '', 'idle'],
		]);
	});

	test('says there are none rather than showing an empty submenu', () => {
		const model = trayModel(input());
		assert.deepEqual(model.connections, []);
		assert.equal(model.connectionsEmpty, "No connections yet");
	});
});

describe('trayModel status, account and update', () => {
	test('the status line names one running flow and counts more than one', () => {
		const one = trayModel(input({ flows: [flow('a', "Nightly orders")], running: new Set(['a']) }));
		assert.deepEqual([one.status.label, one.status.dot], ['Running "Nightly orders"', 'busy']);
		const two = trayModel(input({
			flows: [flow('a', "A"), flow('b', "B")],
			running: new Set(['a', 'b']),
		}));
		assert.equal(two.status.label, "Running 2 flows");
	});

	test('the account line is an invitation when signed out and an identity when signed in', () => {
		assert.deepEqual(trayModel(input()).account, { label: "Sign In / Sign Up", signedIn: false });
		assert.deepEqual(trayModel(input({ account: { email: null, tier: 'free', restoring: true } })).account,
			{ label: "Signing in…", signedIn: false });
		assert.deepEqual(trayModel(input({ account: { email: 'alex@example.com', tier: 'pro', restoring: false } })).account,
			{ label: 'alex@example.com (Pro)', signedIn: true });
	});

	test('the update line offers the action the updater is actually at', () => {
		assert.deepEqual(trayModel(input()).update, { label: "Check for Updates…", action: 'check', dot: null, pending: false });
		assert.equal(trayModel(input({ update: { state: 'available', version: '1.0.22' } })).update.action, 'download');
		assert.equal(trayModel(input({ update: { state: 'downloaded', version: '1.0.22' } })).update.label, "Restart & Update (1.0.22)");
		const downloading = trayModel(input({ update: { state: 'downloading', percent: 42 } })).update;
		assert.deepEqual([downloading.label, downloading.action], ["Downloading update… 42%", 'none']);
		// Once downloaded, the update is made ready before Restart is offered; it is not still at 100%.
		const preparing = trayModel(input({ update: { state: 'downloading', percent: 100, preparing: true } })).update;
		assert.deepEqual([preparing.label, preparing.action], ["Preparing update…", 'none']);
	});

	test('a download with no percent says how it is going instead, once there is something to say', () => {
		const line = (startedAt: number) => trayModel(input({ update: { state: 'downloading', startedAt } })).update.label;
		// macOS reports no progress at all, so the line grows with the wait rather than sitting on
		// an ellipsis. No clock: this menu is rebuilt on an interval, and stale seconds read as a hang.
		assert.equal(line(NOW), "Downloading update…");
		assert.equal(line(NOW - 45_000), "Downloading update, still going, in the background…");
		assert.equal(line(NOW - 70_000), "Downloading update, you can keep working…");
	});

	test('the icon badge tracks a version being in play, not the item being clickable', () => {
		const pending = (update: TrayInput['update']) => trayModel(input({ update })).update.pending;
		// A download in flight is inert in the menu but is exactly when the bar should say so.
		assert.equal(pending({ state: 'downloading', percent: 42 }), true);
		assert.equal(pending({ state: 'available', version: '1.0.23' }), true);
		assert.equal(pending({ state: 'downloaded', version: '1.0.23' }), true);
		// Checking must NOT badge, or every launch and every four-hourly poll flashes one at a user
		// who turns out to have nothing to install.
		assert.equal(pending({ state: 'checking' }), false);
		assert.equal(pending({ state: 'not-available', version: '1.0.22' }), false);
		assert.equal(pending({ state: 'error', message: "feed unreachable" }), false);
		assert.equal(pending(null), false);
	});

	test('the tooltip is what is happening, in the order it matters', () => {
		const model = trayModel(input({
			flows: [flow('a', "A"), flow('b', "B"), flow('c', "C")],
			running: new Set(['a']),
			dueAt: (spec) => spec.id === 'a' ? null : new Date(NOW + 60_000),
			connections: [connection('x', "Local")],
			connectedIds: new Set(['x']),
		}));
		assert.equal(model.tooltip, 'SnoutData Studio\nRunning "A"\n2 flows scheduled\n1 connection open');
	});
});

describe('trayModel and the pull-request reviewer', () => {
	const review = (partial: Partial<TrayInput['review']> = {}): TrayInput['review'] =>
		({ enabled: true, watching: 1, awaiting: 0, ...partial });

	test('says nothing at all until a repository has been watched', () => {
		// An item reading "Snoutbot is off" to somebody who has never heard of Snoutbot is an
		// advertisement in a context menu, and the tray is not where a feature gets sold.
		assert.equal(trayModel(input()).review, null);
		assert.equal(trayModel(input({ review: review({ enabled: false, watching: 0 }) })).review, null);
	});

	test('once configured it says so even when it is switched off', () => {
		const line = trayModel(input({ review: review({ enabled: false }) })).review;
		assert.deepEqual([line?.label, line?.dot], ["Snoutbot is off", 'idle']);
	});

	test('what needs the user outranks what it is doing', () => {
		const busy = trayModel(input({ review: review({ activity: "Reviewing acme/api #12" }) })).review;
		assert.deepEqual([busy?.label, busy?.dot], ["Snoutbot: Reviewing acme/api #12", 'busy']);
		// A review waiting to be posted is a promise the app is HOLDING, so it wins over one in flight.
		const waiting = trayModel(input({ review: review({ activity: "Reviewing acme/api #12", awaiting: 2 }) })).review;
		assert.deepEqual([waiting?.label, waiting?.dot], ["Snoutbot: 2 reviews to read", 'warn']);
	});

	test('the status line carries a waiting review, above a switch the user threw themselves', () => {
		const waiting = trayModel(input({ paused: true, review: review({ awaiting: 1 }) })).status;
		assert.deepEqual([waiting.label, waiting.dot], ["1 review waiting for you", 'warn']);
		// Nothing waiting, and the pause is back to being the thing worth saying.
		assert.equal(trayModel(input({ paused: true, review: review() })).status.label, "Scheduled flows are paused");
	});

	test('a running flow and a failed flow both still outrank the reviewer', () => {
		const running = trayModel(input({
			flows: [flow('a', "Nightly orders")],
			running: new Set(['a']),
			review: review({ awaiting: 3 }),
		}));
		assert.equal(running.status.label, 'Running "Nightly orders"');
		const failed = trayModel(input({
			flows: [flow('a', "Nightly orders")],
			failed: new Set(['a']),
			review: review({ awaiting: 3 }),
		}));
		assert.equal(failed.status.label, 'Last run of "Nightly orders" failed');
	});

	test('the tooltip carries only the reviews that are waiting, never its idle state', () => {
		assert.equal(trayModel(input({ review: review() })).tooltip, "SnoutData Studio");
		assert.equal(
			trayModel(input({ review: review({ awaiting: 1 }) })).tooltip,
			"SnoutData Studio\n1 review waiting to post",
		);
	});
});

function local(id: string, name: string, state: TrayLocalProjectInput['state'], production = false): TrayLocalProjectInput {
	return { id, name, state, production };
}

function cloud(ref: string, name: string, partial: Partial<TrayCloudProjectInput> = {}): TrayCloudProjectInput {
	return { ref, name, state: 'ready', busy: false, production: false, canPause: true, canResume: false, ...partial };
}

describe('trayModel projects', () => {
	test('says so when there are none, rather than an empty submenu', () => {
		const model = trayModel(input());
		assert.equal(model.projectsEmpty, "No projects yet");
		assert.deepEqual(model.localProjects, []);
		assert.deepEqual(model.cloudProjects, []);
	});

	test('a local project says its state in the panel\'s words, running ones first', () => {
		const model = trayModel(input({ projects: {
			local: [local('a', "Alpha", 'stopped'), local('b', "Beta", 'running', true), local('c', "Gone", 'missing')],
			cloud: [],
			busy: new Set(),
		} }));
		assert.deepEqual(model.localProjects.map((p) => [p.name, p.detail, p.dot]), [
			["Beta", "PROD, running", 'ok'],
			["Alpha", "stopped", 'idle'],
			["Gone", "its folder is gone", 'error'],
		]);
		assert.equal(model.projectsEmpty, null);
	});

	test('Start and Stop are enabled exactly when the panel\'s buttons are', () => {
		const actions = (state: TrayLocalProjectInput['state']): Record<string, boolean> => {
			const [item] = trayModel(input({ projects: { local: [local('a', "A", state)], cloud: [], busy: new Set() } })).localProjects;
			return Object.fromEntries(item.actions.map((a) => [a.verb, a.enabled]));
		};
		assert.deepEqual(actions('running'), { start: false, stop: true });
		assert.deepEqual(actions('stopped'), { start: true, stop: false });
		assert.deepEqual(actions('missing'), { start: false, stop: false });
		assert.deepEqual(actions('unknown'), { start: true, stop: false });
		assert.deepEqual(actions('partial'), { start: true, stop: true });
	});

	test('a project the tray is working on offers nothing until it is done', () => {
		const model = trayModel(input({ projects: {
			local: [local('a', "A", 'stopped')],
			cloud: [cloud('abcdefghijklm', "C")],
			busy: new Set(['local:a', 'cloud:abcdefghijklm']),
		} }));
		assert.equal(model.localProjects[0].detail, "working");
		assert.equal(model.cloudProjects[0].detail, "asking");
		assert.ok([...model.localProjects[0].actions, ...model.cloudProjects[0].actions].every((a) => !a.enabled));
	});

	test('a cloud project offers the one of Pause and Resume that would change it', () => {
		const model = trayModel(input({ projects: {
			local: [],
			cloud: [
				cloud('aaaaaaaaaaaaa', "Up"),
				cloud('bbbbbbbbbbbbb', "Asleep", { state: 'paused', canPause: false, canResume: true }),
				cloud('ccccccccccccc', "Prod", { production: true, canPause: false }),
			],
			busy: new Set(),
		} }));
		assert.deepEqual(model.cloudProjects.map((p) => [p.name, p.detail, p.actions.map((a) => `${a.label}:${a.enabled}`)]), [
			["Prod", "PROD, running", ["Pause:false"]],
			["Up", "running", ["Pause:true"]],
			["Asleep", "paused", ["Resume:true"]],
		]);
	});

	test('a cloud project on its way somewhere says where, not the state it is leaving', () => {
		const [item] = trayModel(input({ projects: {
			local: [],
			cloud: [cloud('aaaaaaaaaaaaa', "A", { busy: true, desiredState: 'paused', canPause: false })],
			busy: new Set(),
		} })).cloudProjects;
		assert.equal(item.detail, "pausing");
		assert.equal(item.dot, 'busy');
		// Already asked to pause, so the action shown is the way back, and it waits for the pause.
		assert.deepEqual(item.actions.map((a) => [a.verb, a.enabled]), [['resume', false]]);
	});

	test('both groups together fit the cap, local first, and the rest is counted', () => {
		const locals = Array.from({ length: 6 }, (_, i) => local(`l${i}`, `Local ${i}`, 'stopped'));
		const clouds = Array.from({ length: 5 }, (_, i) => cloud(`c${'x'.repeat(11)}${i}`, `Cloud ${i}`));
		const model = trayModel(input({ projects: { local: locals, cloud: clouds, busy: new Set() } }));
		assert.equal(model.localProjects.length, 6);
		assert.equal(model.cloudProjects.length, 2);
		assert.equal(model.projectsOverflow, 3);
	});
});

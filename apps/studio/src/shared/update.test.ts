/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeUpdateFailure, formatElapsed, isNewerVersion, updateElapsedMs, updateErrorDetail, updateFailureIcon, updateProgressDetail, updateProgressNote, UPDATE_PROGRESS_STEPS_MS, type UpdateStatus } from './update';

const NOW = 1_700_000_000_000;

function downloading(partial: { percent?: number; startedAt?: number } = {}): UpdateStatus {
	return { state: 'downloading', ...partial };
}

describe('update download readout', () => {
	test('elapsed comes from the stamp, and is 0 when there is not one', () => {
		assert.equal(updateElapsedMs(downloading({ startedAt: NOW - 44_000 }), NOW), 44_000);
		assert.equal(updateElapsedMs(downloading(), NOW), 0);
		assert.equal(updateElapsedMs({ state: 'checking' }, NOW), 0);
	});

	test('a clock that moved backwards reads 0, never a negative age', () => {
		assert.equal(updateElapsedMs(downloading({ startedAt: NOW + 5_000 }), NOW), 0);
	});

	test('the note escalates at each step and stops at the last one', () => {
		const [first, second, third] = UPDATE_PROGRESS_STEPS_MS;
		assert.equal(updateProgressNote(0), '');
		assert.equal(updateProgressNote(first - 1), '');
		assert.equal(updateProgressNote(first), "this can take a minute");
		assert.equal(updateProgressNote(second), "still going, in the background");
		assert.equal(updateProgressNote(third), "you can keep working");
		// Nothing further to say: a ten-minute download keeps the last note rather than running out.
		assert.equal(updateProgressNote(10 * 60_000), "you can keep working");
	});

	test('the clock reads the way a person says it', () => {
		assert.equal(formatElapsed(0), '0s');
		assert.equal(formatElapsed(7_400), '7s');
		assert.equal(formatElapsed(60_000), '1min 0s');
		assert.equal(formatElapsed(104_000), '1min 44s');
		assert.equal(formatElapsed(750_000), '12min 30s');
	});

	test('the detail grows as the download runs', () => {
		const at = (ms: number) => updateProgressDetail(downloading({ startedAt: NOW - ms }), NOW, true);
		assert.equal(at(7_000), "7s");
		assert.equal(at(25_000), "25s · this can take a minute");
		assert.equal(at(45_000), "45s · still going, in the background");
		assert.equal(at(70_000), "1min 10s · you can keep working");
	});

	// The rule this feature lives or dies by: Windows reports a percentage that moves, so its
	// label is left exactly as it was and nothing here appends to it.
	test('a download that reports a percent gets nothing added', () => {
		assert.equal(updateProgressDetail(downloading({ percent: 42, startedAt: NOW - 70_000 }), NOW, true), '');
		assert.equal(updateProgressDetail(downloading({ percent: 0, startedAt: NOW - 70_000 }), NOW, true), '');
	});

	test('without a clock the note still escalates, which is all a tray can do', () => {
		assert.equal(updateProgressDetail(downloading({ startedAt: NOW - 45_000 }), NOW, false), "still going, in the background");
		assert.equal(updateProgressDetail(downloading({ startedAt: NOW - 1_000 }), NOW, false), '');
	});

	test('an unstamped download says nothing rather than counting from zero forever', () => {
		assert.equal(updateProgressDetail(downloading(), NOW, true), '');
	});

	test('nothing to say about a state that is not a download', () => {
		assert.equal(updateProgressDetail({ state: 'downloaded', version: '1.0.27' }, NOW, true), '');
	});
});

describe('version comparison', () => {
	test('a later patch, minor or major is newer', () => {
		assert.equal(isNewerVersion('1.0.30', '1.0.29'), true);
		assert.equal(isNewerVersion('1.1.0', '1.0.29'), true);
		assert.equal(isNewerVersion('2.0.0', '1.9.9'), true);
	});

	test('the same version is not newer, and neither is an older one', () => {
		assert.equal(isNewerVersion('1.0.29', '1.0.29'), false);
		assert.equal(isNewerVersion('1.0.28', '1.0.29'), false);
		assert.equal(isNewerVersion('0.9.9', '1.0.0'), false);
	});

	// Skipping versions is the ordinary case (a user who leaves the app closed for a month), so the
	// compare is a plain ordering and never a step of one.
	test('a version several releases ahead is newer', () => {
		assert.equal(isNewerVersion('1.0.40', '1.0.9'), true);
		assert.equal(isNewerVersion('1.0.9', '1.0.40'), false);
	});

	test('missing or unparseable segments read as 0 rather than throwing', () => {
		assert.equal(isNewerVersion('1.1', '1.0.9'), true);
		assert.equal(isNewerVersion('1.0', '1.0.0'), false);
		assert.equal(isNewerVersion('', '1.0.0'), false);
	});
});

describe('when an update check fails', () => {
	// The real thing, from a user's app on 2026-09-21: GitHub's release-asset edge 504'd, and this
	// whole string was printed into a one-line toast, which stretched it across the window.
	const GITHUB_504 = [
		'Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/snoutdata/studio/releases/latest), please ensure a production release exists: HttpError: 504 ',
		'  "method: GET url: https://github.com/snoutdata/studio/releases/tag/v1.0.42',
		'',
		' Data:',
		' <html><body><h1>504 Gateway Time-out</h1>',
		"The server didn't respond in time.",
		'</body></html>',
		'',
		' " Headers: { "cache-control": "no-cache", "content-length": "92", "set-cookie": [ "_gh_sess=qcLDjtxrKohwGSwmyFLB" ] }',
	].join('\n');

	test('a feed that answered badly is OURS, not the user’s, and says so', () => {
		const failure = describeUpdateFailure(GITHUB_504, 504);
		assert.equal(failure.kind, 'feed-unavailable');
		assert.match(failure.message, /GitHub is not answering/);
		assert.match(failure.message, /Nothing is wrong with your installation/);
	});

	test('a 504 is not read as "there is no release", though the text says both', () => {
		// The trap this ordering exists for: GitHub's own message includes "please ensure a
		// production release exists", which is the opposite of what happened. The release was
		// there; the front door timed out.
		assert.equal(describeUpdateFailure(GITHUB_504).kind, 'feed-unavailable');
		assert.equal(describeUpdateFailure('HttpError: 404 Not Found: please ensure a production release exists', 404).kind, 'no-release');
	});

	test('the detail is one line, and carries no headers, HTML or cookies', () => {
		const detail = describeUpdateFailure(GITHUB_504, 504).detail ?? '';
		assert.ok(detail.length <= 200, `detail was ${detail.length} chars`);
		assert.doesNotMatch(detail, /<html>|set-cookie|_gh_sess|Headers/i);
		assert.match(detail, /Cannot parse releases feed/);
		assert.equal(detail.includes('\n'), false);
	});

	test('a machine that cannot reach anything is the user’s own network, said plainly', () => {
		for (const raw of ['getaddrinfo ENOTFOUND github.com', 'connect ECONNREFUSED 140.82.121.4:443', 'net::ERR_INTERNET_DISCONNECTED', 'request to https://github.com failed, reason: ETIMEDOUT']) {
			assert.equal(describeUpdateFailure(raw).kind, 'offline', raw);
		}
		assert.match(describeUpdateFailure('getaddrinfo ENOTFOUND github.com').message, /offline/);
	});

	test('a download that did not match its signature is judged before the transport', () => {
		// It is the alarming one, and the request SUCCEEDED, which is what makes it worth saying.
		assert.equal(describeUpdateFailure('sha512 checksum mismatch, expected abc, got def').kind, 'signature');
		assert.match(describeUpdateFailure('New version 1.0.43 is not signed by the application owner').message, /Nothing was installed/);
	});

	test('the rest of the kinds', () => {
		assert.equal(describeUpdateFailure('ENOSPC: no space left on device, write').kind, 'disk');
		assert.equal(describeUpdateFailure('API rate limit exceeded for 1.2.3.4', 403).kind, 'rate-limited');
		assert.equal(describeUpdateFailure('something nobody has seen before').kind, 'unknown');
		// Never an empty message, whatever arrives: the toast has to say something.
		for (const raw of ['', 'x', GITHUB_504]) {
			assert.ok(describeUpdateFailure(raw).message.length > 10, JSON.stringify(raw));
		}
		assert.equal(updateErrorDetail(''), undefined);
	});

	test('each kind has an icon, and the unknown one still gets a warning', () => {
		assert.equal(updateFailureIcon('offline'), 'debug-disconnect');
		assert.equal(updateFailureIcon('signature'), 'shield');
		assert.equal(updateFailureIcon('feed-unavailable'), 'cloud');
		assert.equal(updateFailureIcon(undefined), 'warning');
	});
});

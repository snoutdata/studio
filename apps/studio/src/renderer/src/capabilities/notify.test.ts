/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { notifyCapabilities } from './notify';
import { onNotify, type AppNotification } from '../notifications';
import type { CapabilityContext } from './registry';
import { ASSISTANT_NAME } from '../../../shared/assistant';

/*
 * notify_user is the one way a model raises a toast in the app's own style, and it asks nobody
 * first. So what it raises has to say who wrote it, stay short, and carry no characters that make
 * text read as something it is not; the app's own notices are untouched (they never come this way).
 */

const handler = notifyCapabilities[0];
// The caps the spec states (notify.ts's NOTICE_TITLE_MAX / NOTICE_DETAIL_MAX).
const NOTICE_TITLE_MAX = 120;
const NOTICE_DETAIL_MAX = 600;

async function raise(args: Record<string, unknown>, client?: string): Promise<AppNotification> {
	let seen: AppNotification | undefined;
	const off = onNotify((entry) => {
		seen = entry;
	});
	try {
		const out = await handler.run(args, { client } as CapabilityContext);
		assert.equal(out.ok, true, out.error);
	} finally {
		off();
	}
	assert.ok(seen, 'no notification was recorded');
	return seen;
}

describe('notify_user', () => {
	test('an external agent\'s notice names the agent', async () => {
		const n = await raise({ title: 'Migration needs a decision', severity: 'warn' }, 'claude-code');
		assert.equal(n.from, 'Claude Code');
		assert.equal(n.source, 'agent');
		assert.equal(n.severity, 'warn');
	});

	test('a client that names itself something we do not know is just "an agent"', async () => {
		const n = await raise({ title: 'Update required', severity: 'error' }, 'SnoutData Security');
		assert.equal(n.from, 'an agent');
	});

	test('the app\'s own assistant is named as the assistant', async () => {
		const n = await raise({ title: 'Done' });
		assert.equal(n.from, ASSISTANT_NAME);
		assert.equal(n.source, 'assistant');
	});

	test('the text is capped, one line in the title, and stripped of disguising characters', async () => {
		const n = await raise({
			title: `Your session expired\nvisit‮moc.elpmaxe‬ now ${'x'.repeat(400)}`,
			detail: `Run​ this: ${'y'.repeat(5000)}`,
			severity: 'error',
		}, 'codex');
		assert.ok(n.title.length <= NOTICE_TITLE_MAX, `title is ${n.title.length} long`);
		assert.ok(!n.title.includes('\n'));
		assert.ok(!/[‪-‮​]/.test(n.title));
		assert.ok(n.detail !== undefined && n.detail.length <= NOTICE_DETAIL_MAX, `detail is ${n.detail?.length} long`);
		assert.ok(!n.detail.includes('​'));
		assert.equal(n.from, 'Codex');
	});

	test('a blank title is still refused', async () => {
		const out = await handler.run({ title: '​  ' }, {} as CapabilityContext);
		assert.equal(out.ok, false);
	});
});

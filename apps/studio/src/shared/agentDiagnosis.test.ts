/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { diagnoseStartupFailure, stripAnsi } from './agentDiagnosis';

/*
 * Naming what stopped an agent, without taking on its problems.
 *
 * Most of these are about what the app must NOT say. The agent's own message is already on screen;
 * a console that paraphrases it, or hands out install advice for a machine it cannot see, is doing
 * someone else's job badly.
 */

/** The real thing, captured from codex-cli 0.29.0 on 2026-08-21, escape codes and all. */
const CODEX_CONFIG_ERROR =
	'[?25l[2J[m[HError loading configuration: [?25lunknown variant `xhigh`, expected one of `minimal`, `low`, `medium`, `high`\r\nin `model_reasoning_effort`[5;1H[?25h';

/** The same failure as a TERMINAL delivers it: hard-wrapped mid-word at the window width. */
const CODEX_CONFIG_ERROR_WRAPPED =
	'Error loading configuration: unknown variant `xhigh`, expected one of `minimal`, `low`, `medi\r\num`, `high`\r\nin `model_reasoning_effort`';

describe('stripAnsi', () => {
	test('leaves the words and drops the escape sequences', () => {
		const text = stripAnsi(CODEX_CONFIG_ERROR);
		assert.match(text, /unknown variant `xhigh`/);
		assert.doesNotMatch(text, //);
	});
});

describe('diagnoseStartupFailure', () => {
	test('names the part of the agent that stopped it', () => {
		const found = diagnoseStartupFailure('codex', CODEX_CONFIG_ERROR);
		assert.ok(found, 'the failure was recognised');
		assert.match(found!.title, /would not start because of its own settings/);
		assert.match(found!.detail, /outside SnoutData/);
	});

	test('a wrapped line is still the same failure', () => {
		// A terminal breaks lines where the window ends, not where the sentence does. Matching has to
		// survive that, or it passes here and never fires in the app.
		assert.ok(diagnoseStartupFailure('codex', CODEX_CONFIG_ERROR_WRAPPED));
	});

	test('does NOT repeat or interpret what the agent said', () => {
		// The agent's message sits directly above this strip. Paraphrasing it is noise at best, and
		// at worst it is us being confidently wrong about software we do not own.
		const found = diagnoseStartupFailure('codex', CODEX_CONFIG_ERROR);
		assert.doesNotMatch(found!.detail, /xhigh|model_reasoning_effort|minimal|newer/i);
		assert.doesNotMatch(found!.title, /xhigh/i);
	});

	test('hands out no install, update or repair advice, for any agent', () => {
		// The line this file will not cross. A machine may have no npm; an agent may have come from
		// Homebrew or a native installer, where `npm install -g` would leave a second copy shadowing
		// the first. How the agent got here is the agent's business.
		for (const kind of ['claude', 'codex', 'opencode'] as const) {
			for (const transcript of [CODEX_CONFIG_ERROR, "'x' is not recognized as an internal or external command", 'EACCES: permission denied']) {
				const found = diagnoseStartupFailure(kind, transcript);
				assert.ok(found);
				assert.doesNotMatch(JSON.stringify(found), /npm|brew|winget|apt-get|choco|install -g|reinstall|upgrade/i);
				assert.ok(found!.actions.every((a) => a.kind === 'openConfig' || a.kind === 'openUrl'), 'pointers only, never commands');
			}
		}
	});

	test('offers the settings folder only when the settings are what failed', () => {
		const config = diagnoseStartupFailure('codex', CODEX_CONFIG_ERROR);
		assert.deepEqual(config!.actions.map((a) => a.kind), ['openConfig', 'openUrl']);
		const launcher = diagnoseStartupFailure('codex', 'Error: Cannot find module ../lib/main.js');
		assert.deepEqual(launcher!.actions.map((a) => a.kind), ['openUrl'], 'a broken launcher is not a settings problem');
	});

	test('a broken launcher and a permissions refusal read as themselves', () => {
		assert.match(diagnoseStartupFailure('opencode', "'opencode' is not recognized as an internal or external command")!.title, /could not run/);
		assert.match(diagnoseStartupFailure('codex', 'EACCES: permission denied, open /home/j/.codex/config.toml')!.title, /not allowed to start/);
	});

	test('says NOTHING about output it does not recognise', () => {
		assert.equal(diagnoseStartupFailure('codex', 'Bye!'), null);
		assert.equal(diagnoseStartupFailure('claude', ''), null);
		assert.equal(diagnoseStartupFailure('opencode', 'some unrelated stack trace\nat foo (bar.js:1)'), null);
	});
});

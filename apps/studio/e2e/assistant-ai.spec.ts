/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

// The ASSISTANT's own AI surfaces, through the real app: a chat turn, the agent tool loop driving
// the app through the capability bridge, inline (FIM) completion, and the Ctrl/Cmd+K edit.
//
// Everything except the model's answer is production code: the IPC handlers, the prompt this build
// builds, the streaming back to the renderer, the agent loop, the approval lifecycle, the renderer's
// real capability registry, the completion guard and the audit record.
//
// WHAT IS NOT COVERED HERE, and cannot be from a scratch profile: the ChatPanel itself. The panel
// is account-gated in the renderer (`signedIn` comes from the auth state, which `setModelScript`
// does not touch — it flips the gate in MAIN), so a signed-out window renders the sign-in view
// instead of a thread, a composer or an approval card. These drive `window.sqlApi` directly, which
// is exactly what the panel calls, and pass the capability manifest the panel would pass
// (`__snoutDebugCapabilities()` is `capabilityRegistry.list()`, the same call ChatPanel makes).
// The approval card's BUTTONS are therefore also uncovered; the spec answers `respondToolApproval`
// as the card does, so what is pinned is the loop's approval lifecycle, not the card's UI.

/** One prompt as the app sent it. `messages` is the whole conversation, which is where a TOOL
 *  result fed back to the model shows up. */
interface SentPrompt {
	system: string;
	user: string;
	messages: { role: string; content: string }[];
}

interface AiHook {
	setModelScript(replies: unknown[] | null): void;
	modelPrompts(): SentPrompt[];
	modelFim(): { prefix: string; suffix: string }[];
}

/** What one driven chat turn produced: the handler's result, plus everything the renderer saw. */
interface TurnOutcome {
	result: { ok: boolean; error?: string; aborted?: boolean; usage?: { totalTokens: number } };
	deltas: string[];
	tools: { tool: string; phase: string; summary: string }[];
	approvals: string[];
}

interface TurnOptions {
	/** Capability names to advertise, taken from the renderer's REAL manifest. Empty ⇒ none. */
	capabilities?: string[];
	ambient?: Record<string, unknown>;
	/** Overrides the persisted agent-mode setting for this turn, as the surface config does. */
	agentMode?: boolean;
	/** How to answer an approval request ("the assistant wants to …"). Absent ⇒ never answer. */
	approve?: boolean;
	/** Cancel the turn as soon as the first delta arrives (needs a `hang` reply to be meaningful). */
	cancelOnFirstDelta?: boolean;
}

/** Script the model for the next call(s). `null` uninstalls it (a signed-out session). */
async function script(app: ElectronApplication, replies: unknown[] | null): Promise<void> {
	await app.evaluate(async (_electron, list) => {
		(globalThis as unknown as { __snoutE2E: AiHook }).__snoutE2E.setModelScript(list as unknown[] | null);
	}, replies);
}

/** Every chat prompt the scripted model has been given, as the app sent it. */
async function prompts(app: ElectronApplication): Promise<SentPrompt[]> {
	return app.evaluate(async () => (globalThis as unknown as { __snoutE2E: AiHook }).__snoutE2E.modelPrompts());
}

/** Every fill-in-the-middle request, likewise — what inline completion sent. */
async function fimRequests(app: ElectronApplication): Promise<{ prefix: string; suffix: string }[]> {
	return app.evaluate(async () => (globalThis as unknown as { __snoutE2E: AiHook }).__snoutE2E.modelFim());
}

/**
 * Drive one chat turn the way ChatPanel does: subscribe to the streams, send, answer whatever the
 * loop asks for, unsubscribe. Everything happens inside the page so the listeners are the real IPC
 * subscriptions rather than a Playwright poll.
 */
async function chatTurn(page: Page, question: string, options: TurnOptions = {}): Promise<TurnOutcome> {
	return page.evaluate(async (input) => {
		const api = (window as unknown as {
			sqlApi: {
				aiChat(id: string, messages: unknown[], connectionId: string | undefined, capabilities: unknown[], ambient: unknown, agentMode?: boolean): Promise<TurnOutcome['result']>;
				cancelChat(id: string): Promise<void>;
				respondToolApproval(id: string, callId: string, approved: boolean): Promise<void>;
				onAiChunk(handler: (id: string, delta: string) => void): () => void;
				onAiTool(handler: (id: string, event: { tool: string; phase: string; summary: string }) => void): () => void;
				onAiApprovalRequest(handler: (request: { requestId: string; callId: string; sql?: string; summary?: string }) => void): () => void;
			};
			__snoutDebugCapabilities(): { name: string }[];
		}).sqlApi;
		const manifest = (window as unknown as { __snoutDebugCapabilities(): { name: string }[] }).__snoutDebugCapabilities();
		const wanted = new Set(input.options.capabilities ?? []);
		const capabilities = manifest.filter((spec) => wanted.has(spec.name));

		const requestId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const deltas: string[] = [];
		const tools: { tool: string; phase: string; summary: string }[] = [];
		const approvals: string[] = [];
		let firstDelta: (() => void) | undefined;
		const sawDelta = new Promise<void>((resolve) => { firstDelta = resolve; });

		const offChunk = api.onAiChunk((id, delta) => {
			if (id === requestId) {
				deltas.push(delta);
				firstDelta?.();
			}
		});
		const offTool = api.onAiTool((id, event) => { if (id === requestId) { tools.push(event); } });
		const offApproval = api.onAiApprovalRequest((request) => {
			if (request.requestId !== requestId) {
				return;
			}
			approvals.push(request.summary ?? request.sql ?? '');
			if (input.options.approve !== undefined) {
				void api.respondToolApproval(requestId, request.callId, input.options.approve);
			}
		});
		try {
			const pending = api.aiChat(
				requestId,
				[{ role: 'user', content: input.question }],
				undefined,
				capabilities,
				input.options.ambient ?? {},
				input.options.agentMode,
			);
			if (input.options.cancelOnFirstDelta) {
				await sawDelta;
				await api.cancelChat(requestId);
			}
			const result = await pending;
			// The chunks (`webContents.send`) and the reply (the invoke's own answer) travel on two IPC
			// paths, so under load the reply can land before its last chunks, or all of them. Let the
			// stream settle: wait until no new chunk arrives for a beat (and, for a reply that
			// succeeded, until the first one has), up to two seconds.
			const deadline = Date.now() + 2000;
			let seen = -1;
			while (Date.now() < deadline && (seen !== deltas.length || (result.ok && !result.aborted && deltas.length === 0))) {
				seen = deltas.length;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return { result, deltas, tools, approvals };
		} finally {
			offChunk();
			offTool();
			offApproval();
		}
	}, { question, options });
}

/** Invoke a capability through the renderer's real registry — how a test reads the app's state. */
async function capability(page: Page, name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data?: Record<string, unknown> }> {
	return page.evaluate(async (input) => {
		const invoke = (window as unknown as { __snoutDebugCapability(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: Record<string, unknown> }> }).__snoutDebugCapability;
		return invoke(input.name, input.args);
	}, { name, args });
}

/** The AI audit log, as the Settings view reads it. */
async function auditEntries(page: Page): Promise<Record<string, unknown>[]> {
	return page.evaluate(async () => (window as unknown as { sqlApi: { aiAuditLog(): Promise<Record<string, unknown>[]> } }).sqlApi.aiAuditLog());
}

test.describe.serial('the assistant, end to end', () => {
	let handle: AppHandle;

	test.beforeAll(async () => {
		handle = await launchApp('assistant-ai');
	});
	test.afterAll(async () => {
		await closeApp(handle);
	});

	test('a chat turn streams to the renderer, and the prompt is this build\'s own', async () => {
		await script(handle.app, ['Use `SELECT count(*) FROM orders`.']);
		const turn = await chatTurn(handle.page, 'how many orders are there?');

		expect(turn.result.ok, turn.result.error).toBe(true);
		// The reply reached the renderer as deltas — the panel renders those, not the resolved text.
		expect(turn.deltas.join('')).toBe('Use `SELECT count(*) FROM orders`.');

		const sent = await prompts(handle.app);
		expect(sent).toHaveLength(1);
		expect(sent[0].user).toContain('how many orders are there?');
		// The system message is the app's, not the test's: it names the assistant's job.
		expect(sent[0].system.toLowerCase()).toContain('sql');
	});

	test('the ambient bundle reaches the model, and an empty one carries nothing', async () => {
		// The spine of the UX thesis (A1): the assistant is supposed to know what is on screen
		// without being told. Assembling the bundle is tested where each screen builds it; this is
		// the other half — that a chat turn actually SENDS it. The seam between them is where one
		// screen's grounding once silently vanished.
		await handle.page.locator('.monaco-editor').first().click();
		await handle.page.keyboard.type('SELECT id FROM shipments WHERE delayed = 1');
		await expect(handle.page.locator('.monaco-editor .view-lines').first()).toContainText('shipments');

		const ambient = await handle.page.evaluate(() => (window as unknown as { __snoutDebugAmbient(): Record<string, unknown> }).__snoutDebugAmbient());
		expect(String(ambient.editorBuffer)).toContain('shipments');

		await script(handle.app, ['That query reads the shipments table.', 'Nothing on screen.']);
		await chatTurn(handle.page, 'what am I looking at?', { ambient });
		await chatTurn(handle.page, 'what am I looking at?', { ambient: {} });

		const [withAmbient, without] = (await prompts(handle.app)).slice(-2);
		expect(withAmbient.system).toContain('SELECT id FROM shipments WHERE delayed = 1');
		// The control: the same question with nothing on screen must not carry it. Without this the
		// assertion above could be satisfied by any prompt that happened to mention the table.
		expect(without.system).not.toContain('shipments');
	});

	test('with the audit log off, which is the default, nothing about those turns is written down', async () => {
		// Recording is opt-in (Settings → AI) and three turns have already happened, so an empty log
		// here is the privacy half of the promise rather than an accident of ordering.
		expect(await auditEntries(handle.page)).toEqual([]);
	});

	test('with it on, a chat turn is recorded with the grounding prompt it was sent', async () => {
		await handle.page.evaluate(async () => {
			await (window as unknown as { sqlApi: { setAuditKinds(kinds: string[]): Promise<void> } }).sqlApi.setAuditKinds(['chat', 'completion', 'edit', 'action']);
		});
		await script(handle.app, ['Two hundred.']);
		await chatTurn(handle.page, 'how many customers?');

		const [entry] = await auditEntries(handle.page);
		expect(entry, 'a chat entry').toBeTruthy();
		expect(entry.kind).toBe('chat');
		expect(entry.ok).toBe(true);
		expect(entry.response).toBe('Two hundred.');
		// The exact system message the model was given, kept so the log answers "what did it know?".
		expect(String(entry.systemPrompt).toLowerCase()).toContain('sql');
		// …and the conversation WITHOUT it duplicated into the messages.
		expect((entry.messages as { role: string }[]).every((message) => message.role !== 'system')).toBe(true);
	});

	test('stopping a stream keeps what arrived, and is not recorded as a failure', async () => {
		// A user pressing Stop is an outcome, not an error: the partial reply stays on screen and the
		// audit entry is `ok`. The scripted reply streams its text and then waits to be aborted, which
		// is the only way a test can be inside a turn at all.
		await script(handle.app, [{ text: 'Let me think about th', hang: true }]);
		const before = (await auditEntries(handle.page)).length;
		const turn = await chatTurn(handle.page, 'a long question', { cancelOnFirstDelta: true });

		expect(turn.result.ok).toBe(false);
		expect(turn.result.aborted).toBe(true);
		expect(turn.deltas.join('')).toBe('Let me think about th');

		const entries = await auditEntries(handle.page);
		expect(entries).toHaveLength(before + 1);
		expect(entries[0].ok, 'a stop is not a failure').toBe(true);
		expect(entries[0].error).toBeUndefined();
		expect(entries[0].response).toBe('Let me think about th');
	});

	test('the agent runs a capability through the real registry and answers from its result', async () => {
		// The tool loop, end to end: the model asks for a renderer capability, main round-trips it to
		// the renderer, the REGISTRY runs it, and the result comes back as a tool message the model's
		// second turn answers from. `agent.test.ts` owns the loop's own mechanics; what is pinned here
		// is that all four processes are actually wired to each other.
		await script(handle.app, [
			{ text: '', toolCalls: [{ id: 'call-1', name: 'get_settings', arguments: {} }] },
			'Your default row limit is the one the tool reported.',
		]);
		const turn = await chatTurn(handle.page, 'what is my row limit?', { capabilities: ['get_settings'], agentMode: true });

		expect(turn.result.ok, turn.result.error).toBe(true);
		expect(turn.deltas.join('')).toContain('row limit');
		// The step reached the renderer, which is what draws the "ran get_settings" line in the panel.
		expect(turn.tools.map((event) => `${event.tool}:${event.phase}`)).toEqual(['get_settings:start', 'get_settings:end']);
		// A read-only capability must NOT ask permission.
		expect(turn.approvals).toEqual([]);

		// The second turn carried the capability's own answer back to the model, as a tool message.
		const second = (await prompts(handle.app)).slice(-1)[0];
		const toolResult = second.messages.filter((message) => message.role === 'tool').map((message) => message.content).join('\n');
		expect(toolResult).toContain('defaultLimit');
	});

	test('a mutating capability is approved first, and the app really changes', async () => {
		const before = await capability(handle.page, 'get_settings');
		expect(before.data?.fontSize).not.toBe(21);

		await script(handle.app, [
			{ text: '', toolCalls: [{ id: 'call-2', name: 'set_setting', arguments: { key: 'fontSize', value: 21 } }] },
			'Done — the editor font is 21 now.',
		]);
		const turn = await chatTurn(handle.page, 'make the font bigger', { capabilities: ['set_setting'], agentMode: true, approve: true });

		expect(turn.result.ok, turn.result.error).toBe(true);
		// The card's sentence: the capability in words, the setting, and the value it would get.
		expect(turn.approvals.join(' '), 'the user is asked before it runs').toContain('set setting (setting: fontSize, new value: 21)');
		const after = await capability(handle.page, 'get_settings');
		expect(after.data?.fontSize).toBe(21);
	});

	test('declining it changes nothing, and the model is told so rather than left guessing', async () => {
		await script(handle.app, [
			{ text: '', toolCalls: [{ id: 'call-3', name: 'set_setting', arguments: { key: 'fontSize', value: 9 } }] },
			'Left it alone.',
		]);
		const turn = await chatTurn(handle.page, 'make the font tiny', { capabilities: ['set_setting'], agentMode: true, approve: false });

		expect(turn.result.ok, turn.result.error).toBe(true);
		const after = await capability(handle.page, 'get_settings');
		expect(after.data?.fontSize, 'still what the previous test set').toBe(21);
		// The decline is a soft stop the model can recover from, not an error: it is told, in words.
		const last = (await prompts(handle.app)).slice(-1)[0];
		const toolResult = last.messages.filter((message) => message.role === 'tool').map((message) => message.content).join('\n');
		expect(toolResult).toContain('The user declined "set_setting"');
	});

	// (A test of "agent mode off" stood here. The Ask/Agent switch was retired on 2026-10-09 and every
	// tier is entitled to the tool loop, so no user can reach a turn without tools any more.)

	test('inline completion is off until the user turns it on, and sends nothing until then', async () => {
		// It is the one AI path that fires on the keystroke path, so it is opt-in (DEFAULT_AI_SETTINGS
		// has `inlineCompletion: false`) — and the refusal has to happen before anything is sent.
		await script(handle.app, ['  WHERE id = 1']);
		const refused = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { aiComplete(params: unknown): Promise<{ ok: boolean; error?: string }> } }).sqlApi;
			return api.aiComplete({ connectionId: undefined, prefix: 'SELECT * FROM orders\n', suffix: '' });
		});
		expect(refused.ok).toBe(false);
		expect(refused.error).toContain('Settings');
		expect(await fimRequests(handle.app), 'nothing left the machine').toEqual([]);
	});

	test('turned on, it sends the text around the cursor and inserts what came back', async () => {
		await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { aiSettings(): Promise<Record<string, unknown>>; saveAiSettings(values: unknown): Promise<unknown> } }).sqlApi;
			const settings = await api.aiSettings();
			const behavior = settings.behavior as Record<string, unknown>;
			await api.saveAiSettings({ ...settings, behavior: { ...behavior, inlineCompletion: true } });
		});
		// The completion model is a FIM model, so this drives `provider.fim` — the branch the gateway
		// serves `snout-fim-1.0` on, not the chat fallback.
		await script(handle.app, ['WHERE status = \'open\'']);
		const done = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { aiComplete(params: unknown): Promise<{ ok: boolean; text?: string; id?: string; error?: string }> } }).sqlApi;
			return api.aiComplete({ connectionId: undefined, prefix: 'SELECT * FROM orders\n', suffix: '\nORDER BY id' });
		});
		expect(done.ok, done.error).toBe(true);
		expect(done.text).toBe('WHERE status = \'open\'');

		// What actually left: the buffer either side of the cursor, as a fill-in-the-middle request.
		const [request] = await fimRequests(handle.app);
		expect(request.prefix).toContain('SELECT * FROM orders');
		expect(request.suffix).toBe('\nORDER BY id');

		const [entry] = await auditEntries(handle.page);
		expect(entry.kind).toBe('completion');
		// What the deterministic guard made of it, which is the only record of whether it was shown
		// as the model wrote it.
		expect((entry.completion as { verdict: string }).verdict).toBe('clean');
	});

	test('a superseded completion is abandoned quietly, not failed and not recorded', async () => {
		// Inline completion is strictly single-flight: the cursor the older request was answering no
		// longer exists. It used to keep running, and they serialize at the model — a queue that only
		// ever got longer (13s → 20s → timeout). The abandoned one must resolve EMPTY, without an
		// error the editor would show and without an audit entry claiming a round trip happened.
		const before = (await auditEntries(handle.page)).length;
		await script(handle.app, [{ text: 'ORDER BY 1', hang: true }, 'LIMIT 10']);
		const both = await handle.page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { aiComplete(params: unknown): Promise<{ ok: boolean; text?: string; error?: string }> } }).sqlApi;
			const stale = api.aiComplete({ connectionId: undefined, prefix: 'SELECT * FROM orders\n', suffix: '' });
			// Let the first reach the provider before superseding it; otherwise this test proves nothing.
			await new Promise((resolve) => setTimeout(resolve, 150));
			const fresh = await api.aiComplete({ connectionId: undefined, prefix: 'SELECT * FROM orders\nWHERE id > 5\n', suffix: '' });
			return { stale: await stale, fresh };
		});
		expect(both.stale.ok, 'abandoned, not failed').toBe(true);
		expect(both.stale.text).toBe('');
		expect(both.fresh.text).toBe('LIMIT 10');
		expect((await auditEntries(handle.page)).length - before, 'only the one that answered').toBe(1);
	});

	test('a Ctrl+K edit streams its progress and comes back as SQL, not as markdown', async () => {
		// The widget shows the reply as it arrives and then applies it to the buffer, so a stray
		// ```sql fence would be pasted into the editor verbatim.
		await script(handle.app, ['```sql\nSELECT id, name FROM orders WHERE total > 100\n```']);
		const edit = await handle.page.evaluate(async () => {
			const api = (window as unknown as {
				sqlApi: {
					aiEdit(id: string, params: unknown): Promise<{ ok: boolean; text?: string; error?: string }>;
					onAiEditChunk(handler: (id: string, delta: string) => void): () => void;
				};
			}).sqlApi;
			const requestId = 'e2e-edit';
			const deltas: string[] = [];
			const off = api.onAiEditChunk((id, delta) => { if (id === requestId) { deltas.push(delta); } });
			try {
				const result = await api.aiEdit(requestId, {
					connectionId: undefined,
					instruction: 'only orders over 100',
					selection: 'SELECT id, name FROM orders',
					document: 'SELECT id, name FROM orders',
				});
				return { result, deltas };
			} finally {
				off();
			}
		});
		expect(edit.result.ok, edit.result.error).toBe(true);
		expect(edit.result.text).toBe('SELECT id, name FROM orders WHERE total > 100');
		expect(edit.deltas.join(''), 'the widget streams the raw reply').toContain('```sql');

		const [entry] = await auditEntries(handle.page);
		expect(entry.kind).toBe('edit');
		// The instruction and the selection are what was sent, so the log shows what was rewritten.
		const sent = (await prompts(handle.app)).slice(-1)[0];
		expect(sent.user).toContain('only orders over 100');
		expect(sent.user).toContain('SELECT id, name FROM orders');
	});
});

test.describe.serial('a session that cannot reach a model', () => {
	let handle: AppHandle;

	// The state every user starts in. The renderer hides the composer, but each of these is also
	// reachable by a keystroke (inline completion) or an IPC, so main refuses on its own — with a
	// sentence that says what to do, and before it sends anything.

	test.beforeAll(async () => {
		handle = await launchApp('assistant-ai-signedout');
	});
	test.afterAll(async () => {
		await closeApp(handle);
	});

	test('chat refuses with the sentence that names the fix', async () => {
		const turn = await chatTurn(handle.page, 'how many orders are there?');
		expect(turn.result.ok).toBe(false);
		expect(turn.result.error).toContain('Sign in');
		expect(turn.deltas).toEqual([]);
	});

	test('inline completion and a Ctrl+K edit refuse too', async () => {
		const refused = await handle.page.evaluate(async () => {
			const api = (window as unknown as {
				sqlApi: {
					aiComplete(params: unknown): Promise<{ ok: boolean; error?: string }>;
					aiEdit(id: string, params: unknown): Promise<{ ok: boolean; error?: string }>;
				};
			}).sqlApi;
			return {
				completion: await api.aiComplete({ connectionId: undefined, prefix: 'SELECT ', suffix: '' }),
				edit: await api.aiEdit('e2e-edit-out', { connectionId: undefined, instruction: 'fix it', selection: 'SELECT 1', document: 'SELECT 1' }),
			};
		});
		expect(refused.completion.ok).toBe(false);
		expect(refused.completion.error).toContain('Sign in');
		expect(refused.edit.ok).toBe(false);
		expect(refused.edit.error).toContain('Sign in');
	});
});

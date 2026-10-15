/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { AUTH_PROFILE, closeApp, launchApp, signedInProfileExists, waitForSignIn, type AppHandle } from './helpers';

/*
 * The ChatPanel ITSELF: the thread a user reads and what it lets them do with a reply. (Its approval
 * card and the Data Flows panel's "Explain" need a flow, so Data Flows' own specs drive them.)
 *
 * `assistant-ai.spec.ts` drives `window.sqlApi` directly and says in its own header why: the panel
 * is account-gated in the RENDERER, and a scratch profile can never be signed in, so a scratch
 * launch renders the sign-in view instead of a thread. That left the panel, its composer and its
 * approval card uncovered by anything.
 *
 * This closes that by launching against the signed-in profile (`npm run e2e:signin`, the same one
 * the live specs use) with the model still SCRIPTED, so it spends no AI budget and asserts nothing
 * about what a model says. It skips cleanly with no profile, which is what CI has.
 *
 * It leaves nothing behind in that profile.
 */

const skip = signedInProfileExists() ? null : `no signed-in profile at ${AUTH_PROFILE} — run \`npm run e2e:signin\` once`;

let handle: AppHandle;

async function script(app: ElectronApplication, replies: unknown[] | null): Promise<void> {
	await app.evaluate(async (_electron, list) => {
		(globalThis as unknown as { __snoutE2E: { setModelScript(r: unknown[] | null): void } }).__snoutE2E.setModelScript(list as unknown[] | null);
	}, replies);
}

/** The thread, as text. */
function thread(page: Page) {
	return page.locator('.chat-panel, .chat').first();
}

async function ask(page: Page, question: string): Promise<void> {
	await page.locator('.composer-input').fill(question);
	await page.locator('.composer-input').press('Enter');
}

test.describe.serial('the assistant panel a signed-in user actually reads', () => {
	test.skip(skip !== null, skip ?? '');

	test.beforeAll(async () => {
		handle = await launchApp('chat-panel', { profile: AUTH_PROFILE });
		// The assistant has to be ON SCREEN before anything can type at it, and that is not a given:
		// where panels sit is remembered per profile and this spec runs against a REAL profile that
		// is reused between runs, so it may well open with the panel put away. Clicking the icon
		// blind would be worse than doing nothing, since it toggles.
		// Decided by the icon's own state, not the composer: while the account is restoring the panel
		// is open but shows a skeleton, and reading that as "closed" clicked it shut.
		expect(await waitForSignIn(handle.page), 'no account on this profile').toBeTruthy();
		const icon = handle.page.locator('.activity-item[data-tool="assistant"]');
		if (!(await icon.getAttribute('class'))?.split(' ').includes('active')) {
			await icon.click();
		}
		await expect(handle.page.locator('.composer-input').first()).toBeVisible();
	});

	test.afterAll(async () => {
		if (handle) {
			await script(handle.app, null).catch(() => {});
		}
		await closeApp(handle);
	});

	test('a reply reaches the thread', async () => {
		// Not the tautology it looks like. The panel renders ONLY what the `ai:chunk` stream puts in
		// the message, and a chunk arriving after the turn's own reply used to be dropped — the two
		// travel over different IPC paths and nothing orders them. A scripted model lands the whole
		// turn in one tick, so it loses that race every time and the thread stayed empty; a real
		// model can only lose the tail of a reply, which is far harder to notice.
		await script(handle.app, ['A **grounded** answer.']);
		await ask(handle.page, 'is anyone there?');
		await expect(thread(handle.page).locator('.chat-msg.assistant').last()).toContainText('A grounded answer.', { timeout: 20_000 });
	});

	test('Copy on a reply puts the WHOLE answer on the clipboard', async () => {
		// snoutdata/studio#2: the per-block Copy buttons take one statement, so copying the answer meant
		// selecting it by hand. This copies what the model wrote, markdown and fences included, so
		// the fence is what proves it isn't the rendered prose.
		const reply = ['Here is the query:', '', '```sql', 'SELECT 1;', '```', '', 'That is all.'].join('\n');
		await script(handle.app, [reply]);
		await ask(handle.page, 'give me a query');
		const message = thread(handle.page).locator('.chat-msg.assistant').last();
		await expect(message).toContainText('That is all.', { timeout: 20_000 });
		await handle.app.evaluate(async ({ clipboard }) => clipboard.writeText('not the reply'));
		// The browser clipboard refuses a window that is not focused, and a person's click focuses
		// it; a synthetic one does not, so a run while somebody works in another app failed here.
		await handle.app.evaluate(({ app, BrowserWindow }) => {
			app.focus({ steal: true });
			BrowserWindow.getAllWindows()[0]?.focus();
		});
		await message.hover();
		await message.getByRole('button', { name: 'Copy this reply' }).click();
		// The write is asynchronous and the check mark follows it, so wait for the mark first.
		await expect(message.locator('.chat-copy .codicon-check')).toBeVisible();
		const copied = await handle.app.evaluate(async ({ clipboard }) => clipboard.readText());
		// Windows' clipboard stores CRLF, so normalise before comparing: the newlines are the
		// clipboard's business, the text is ours.
		expect(copied.replace(/\r\n/g, '\n')).toBe(reply);
		// The click is acknowledged, not silent.
		await expect(message.locator('.chat-copy .codicon-check')).toBeVisible();
	});
});

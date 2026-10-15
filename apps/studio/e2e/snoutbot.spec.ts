/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launchApp, closeApp, MOD, PRO_BUILD, type AppHandle } from './helpers';

/*
 * Snoutbot, the pull-request reviewer, driven end to end on this machine.
 *
 * A FAKE GITHUB stands on 127.0.0.1 and the app is pointed at it (`SNOUT_E2E_GITHUB_API`, which
 * `githubClient.ts` reads only when the profile is already a scratch one). Everything else is
 * real: the real token check into the real keychain, the real store, the real poller, the real
 * review-core rule set, the real markdown, the real view, the real approve path. The only thing
 * this cannot prove is that GITHUB's own payloads are the shapes we assume — which is exactly
 * what the hand test against a real repository is for, and this does not replace it.
 *
 * The pull request under review is a migration with something wrong with it that the STATIC tier
 * can see on its own: `DROP TABLE` is destructive, full stop, no database needed. Nothing here is
 * bound to a connection, so the review runs text-only and the comment has to SAY so rather than
 * implying it looked.
 *
 * The user has "let me read it first" on, so the review is written and posted NOTHING until the
 * approve button is pressed. That gate is what the desktop reviewer is for, and the assertion that
 * the fake GitHub received no comment until then is the point of this file.
 */

let handle: AppHandle;
let server: Server;
let api = '';

/** What `/user/repos` does next. A token that can reach nothing, and a GitHub that is having a
 *  bad day, are both states the pane has to SAY something about rather than spin on. */
let reposMode: 'ok' | 'empty' | 'error' = 'ok';

/** Everything the fake GitHub was asked to do, in order, for assertions afterwards. `inm` is the
 *  `If-None-Match` the request carried, which is how the conditional-request path is proved. */
const seen: { method: string; path: string; body?: string; auth?: string; inm?: string }[] = [];
/** How many times the fake answered 304 rather than sending a body again. */
let notModified = 0;
/** What `approveBeforePosting` was before the two database tests held it. They review a pull
 *  request the tests after them also review, and a second review of the same one edits the comment
 *  the first left, which the fake has no way to serve back. */
let heldPosting = false;
/** The ETag the pull-request list is served with. Real GitHub always sends one; this is the same
 *  shape (weak, quoted) so nothing about the client's handling is special-cased for the fake. */
const PULLS_ETAG = 'W/"pulls-7-only"';
/**
 * What `Cache-Control` the pull-request list is served with, which is the whole variable in the
 * polling test below.
 *
 * `github` is what GitHub actually sends, and is the state that could have the reviewer served a
 * cached list without asking. `no-store` makes Chromium keep nothing, which is what makes the
 * reviewer's OWN cache the only possible source of an `If-None-Match`.
 */
let pullsCaching: 'github' | 'no-store' = 'github';
/** Commit statuses posted, in order. The pending one is the point: it has to go up BEFORE the
 *  work, or a pull request says nothing for as long as the review takes. */
const statuses: { state: string; context: string; description: string }[] = [];
/** Where the fake App is installed. One by default; the test that needs two sets it. */
let installations: { id: number; account: { login: string }; repository_selection: string }[] = [
	{ id: 501, account: { login: 'acme' }, repository_selection: 'selected' },
];
/** Comments the fake GitHub is holding for pull request #7, as GitHub would return them. */
const comments: { id: number; body: string; login: string }[] = [];

const DIFF = `diff --git a/db/migrate/007_drop_legacy.sql b/db/migrate/007_drop_legacy.sql
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/db/migrate/007_drop_legacy.sql
@@ -0,0 +1,2 @@
+DROP TABLE legacy_orders;
+CREATE INDEX idx_orders_customer ON orders (customer_id);
`;

const FILE = 'DROP TABLE legacy_orders;\nCREATE INDEX idx_orders_customer ON orders (customer_id);\n';

/** What `/user/repos` returns: the three this token can reach, and no more. `snoutdata/private`
 *  is read-only for this account, which the picker has to SAY rather than let it 403 later. */
const REPOS = [
	{
		name: 'api',
		full_name: 'acme/api',
		private: false,
		archived: false,
		pushed_at: '2026-08-28T08:00:00Z',
		owner: { login: 'acme' },
		permissions: { push: true, pull: true },
	},
	{
		name: 'warehouse',
		full_name: 'acme/warehouse',
		private: true,
		archived: false,
		pushed_at: '2026-08-27T08:00:00Z',
		owner: { login: 'acme' },
		permissions: { push: true, pull: true },
	},
	{
		name: 'readonly-fork',
		full_name: 'someone/readonly-fork',
		private: false,
		archived: false,
		pushed_at: '2026-08-20T08:00:00Z',
		owner: { login: 'someone' },
		permissions: { push: false, pull: true },
	},
];

/** `?page=N` off a query string, defaulting to the first. */
function page(path: string): number {
	return Number(new URL(path, 'http://x').searchParams.get('page') ?? '1');
}

const PULL = {
	number: 7,
	title: 'Drop the legacy orders table',
	draft: false,
	updated_at: '2026-08-28T09:00:00Z',
	html_url: 'https://github.com/acme/api/pull/7',
	// A branch in the repository itself, which is what lets it be reviewed without anybody asking:
	// a fork's would wait for a maintainer to comment (`reviewPoller.ts`).
	head: { sha: 'abcdef1234567890', repo: { full_name: 'acme/api' } },
	base: { ref: 'main', repo: { full_name: 'acme/api' } },
	user: { login: 'someone-else', type: 'User' },
};

/** A second open pull request, so the list can hold more than one review and the card in the
 *  corner has something to be WRONG about if it only opens "the reviews". */
const PULL_8 = {
	...PULL,
	number: 8,
	title: 'Add the shipping index',
	html_url: 'https://github.com/acme/api/pull/8',
	head: { sha: 'fedcba0987654321', repo: { full_name: 'acme/api' } },
};

function send(res: ServerResponse, status: number, body: string, contentType = 'application/json'): void {
	res.writeHead(status, { 'Content-Type': contentType });
	res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

test.beforeAll(async () => {
	server = createServer((req, res) => {
		void (async () => {
			const path = req.url ?? '';
			const method = req.method ?? 'GET';
			const body = method === 'GET' ? undefined : await readBody(req);
			const inm = req.headers['if-none-match'];
			seen.push({ method, path, body, auth: req.headers.authorization, inm: typeof inm === 'string' ? inm : undefined });

			// The GitHub App endpoints: how a review comes from `snoutbot[bot]` instead of from a
			// person. The app signs a JWT with the App's key, asks who it is, and trades the JWT
			// for an installation token. None of that is checked here (a fake cannot verify a
			// signature it has no public key for); what IS checked is that the app takes the whole
			// path and then posts as the App's login rather than the user's.
			if (path === '/app') {
				send(res, 200, JSON.stringify({ slug: 'snoutbot', name: 'Snoutbot' }));
				return;
			}
			if (path === '/app/installations') {
				send(res, 200, JSON.stringify(installations));
				return;
			}
			if (/^\/app\/installations\/\d+\/access_tokens$/.test(path) && method === 'POST') {
				send(res, 201, JSON.stringify({ token: 'ghs_installation', expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
				return;
			}
			if (path.startsWith('/installation/repositories')) {
				send(res, 200, JSON.stringify({ total_count: REPOS.length, repositories: page(path) > 1 ? [] : REPOS }));
				return;
			}
			// Who the token belongs to. The app verifies it BEFORE storing it, so this is the first
			// call any of this makes.
			if (path === '/user') {
				res.writeHead(200, { 'Content-Type': 'application/json', 'x-oauth-scopes': 'repo' });
				res.end(JSON.stringify({ login: 'alex-test' }));
				return;
			}
			// The token's own permission list, which is what the settings picker offers.
			if (path.startsWith('/user/repos')) {
				if (reposMode === 'error') {
					send(res, 500, JSON.stringify({ message: 'Server Error' }));
					return;
				}
				if (reposMode === 'empty') {
					send(res, 200, '[]');
					return;
				}
				send(res, 200, JSON.stringify(page(path) > 1 ? [] : REPOS));
				return;
			}
			// Who may command the reviewer: everybody on this fake repository can write to it.
			if (/^\/repos\/[^/]+\/[^/]+\/collaborators\/[^/]+\/permission$/.test(path)) {
				send(res, 200, JSON.stringify({ permission: 'write', role_name: 'write' }));
				return;
			}
			if (path.startsWith('/repos/acme/api/pulls?')) {
				// Conditional requests, which is how the reviewer polls without spending its rate
				// limit on silence (`main/review/httpCache.ts`). GitHub answers an unchanged list
				// with 304 and no body, and does not charge it against the limit at all.
				if (inm === PULLS_ETAG) {
					notModified++;
					res.writeHead(304, {
						'Cache-Control': pullsCaching === 'github' ? 'private, max-age=60' : 'no-store',
						ETag: PULLS_ETAG,
					});
					res.end();
					return;
				}
				res.writeHead(200, {
					'Content-Type': 'application/json',
					// GitHub's own header, or one that forbids Chromium keeping anything. See
					// `pullsCaching`.
					'Cache-Control': pullsCaching === 'github' ? 'private, max-age=60' : 'no-store',
					ETag: PULLS_ETAG,
				});
				res.end(JSON.stringify([PULL]));
				return;
			}
			// The other watched repository has nothing open, so a poll over both is quiet.
			if (/^\/repos\/[^/]+\/[^/]+\/pulls\?/.test(path)) {
				send(res, 200, '[]');
				return;
			}
			if (path === '/repos/acme/api/pulls/8') {
				if ((req.headers.accept ?? '').includes('diff')) {
					send(res, 200, DIFF, 'text/plain');
					return;
				}
				send(res, 200, JSON.stringify(PULL_8));
				return;
			}
			if (path.startsWith('/repos/acme/api/issues/8/comments')) {
				send(res, method === 'POST' ? 201 : 200, method === 'POST'
					? JSON.stringify({ id: 950, body: '', created_at: '2026-08-28T09:05:00Z', updated_at: '2026-08-28T09:05:00Z', html_url: 'https://github.com/acme/api/pull/8', user: { login: 'alex-test', type: 'User' } })
					: '[]');
				return;
			}
			// The same path serves the pull request and its diff; the Accept header chooses.
			if (path === '/repos/acme/api/pulls/7') {
				if ((req.headers.accept ?? '').includes('diff')) {
					send(res, 200, DIFF, 'text/plain');
					return;
				}
				send(res, 200, JSON.stringify(PULL));
				return;
			}
			// The reviewer's line beside CI. A commit status, not a check run: check runs need a
			// GitHub App, and this product is the user's own token on their own machine.
			if (/^\/repos\/[^/]+\/[^/]+\/statuses\//.test(path) && method === 'POST') {
				statuses.push(JSON.parse(body ?? '{}') as { state: string; context: string; description: string });
				send(res, 201, JSON.stringify({ id: 1 }));
				return;
			}
			if (path.startsWith('/repos/acme/api/contents/')) {
				send(res, 200, FILE, 'text/plain');
				return;
			}
			if (path.startsWith('/repos/acme/api/issues/7/comments')) {
				if (method === 'POST') {
					const created = {
						id: 900 + comments.length,
						body: (JSON.parse(body ?? '{}') as { body: string }).body,
						login: 'alex-test',
					};
					comments.push(created);
					send(res, 201, JSON.stringify({
						id: created.id,
						body: created.body,
						created_at: '2026-08-28T09:05:00Z',
						updated_at: '2026-08-28T09:05:00Z',
						html_url: `https://github.com/acme/api/pull/7#issuecomment-${created.id}`,
						user: { login: created.login, type: 'User' },
					}));
					return;
				}
				send(res, 200, JSON.stringify(comments.map((c) => ({
					id: c.id,
					body: c.body,
					created_at: '2026-08-28T09:05:00Z',
					updated_at: '2026-08-28T09:05:00Z',
					html_url: `https://github.com/acme/api/pull/7#issuecomment-${c.id}`,
					user: { login: c.login, type: 'User' },
				}))));
				return;
			}
			send(res, 404, JSON.stringify({ message: 'Not Found' }));
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	handle = await launchApp('snoutbot', { env: { SNOUT_E2E_GITHUB_API: api } });
});

test.afterAll(async () => {
	await closeApp(handle);
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Open Settings → Snoutbot the way a user finds it: the command palette. */
async function openSettings(): Promise<void> {
	await handle.page.keyboard.press(`${MOD}+Shift+P`);
	await expect(handle.page.locator('.palette')).toBeVisible();
	await handle.page.keyboard.type('Snoutbot Settings');
	await handle.page.keyboard.press('Enter');
	await expect(handle.page.locator('.review-settings')).toBeVisible();
}

/**
 * Move to one of the pane's three tabs.
 *
 * The pane opens on the tab the user came for (Repositories once a host is connected, Where your
 * code lives before that), so a test that wants the OTHER one has to say so rather than assume the
 * page is one long column.
 */
async function reviewTab(label: string): Promise<void> {
	await handle.page.locator('.review-section-tabs .tab', { hasText: label }).click();
}

/** Open the reviews tab the way a user finds it: the command palette. */
async function openReviews(): Promise<void> {
	await handle.page.keyboard.press(`${MOD}+Shift+P`);
	await expect(handle.page.locator('.palette')).toBeVisible();
	await handle.page.keyboard.type('Show Reviews');
	await handle.page.keyboard.press('Enter');
	await expect(handle.page.locator('[data-test="review-view"]')).toBeVisible();
}

/** Snoutbot's activity-bar icon, which is only there once the feature has been set up. */
function snoutbotIcon() {
	return handle.page.locator('.activity-bar button', { has: handle.page.locator('.codicon-git-pull-request') });
}

test('the reviews view says WHY it is empty, not merely that it is', async () => {
	// Before anything is connected there is no icon in the bar. An icon for a feature nobody has
	// heard of is an advertisement in the window chrome, and this is the assertion that keeps the
	// gate honest: it is checked BEFORE the token test below runs, which is the only moment in
	// this file when nothing is set up.
	await expect(snoutbotIcon()).toHaveCount(0);
	await openReviews();
	// Nothing is set up at all yet, so the sentence has to be the one about connecting a host —
	// an empty state that just says "no reviews" leaves the user with nothing to do next.
	await expect(handle.page.locator('[data-test="review-empty"]')).toContainText(/Connect a GitHub or GitLab account/i);
	await handle.page.screenshot({ path: 'e2e/.artifacts/snoutbot-empty.png' });
});

test('a token is verified against GitHub before it is stored, and names the account', async () => {
	const result = await handle.page.evaluate(async () => window.sqlApi.review.setToken('github', 'ghp_faketoken'));
	expect(result).toMatchObject({ ok: true, login: 'alex-test' });
	expect(seen.some((r) => r.path === '/user')).toBe(true);

	// A bad one fails at the moment it is pasted rather than silently on every poll.
	const bad = await handle.page.evaluate(async () => window.sqlApi.review.setToken('github', ''));
	expect(bad).toMatchObject({ ok: false });
	// …and putting the good one back leaves the feature usable for the rest of this file.
	await handle.page.evaluate(async () => window.sqlApi.review.setToken('github', 'ghp_faketoken'));
});

test('once a host is connected, Snoutbot is in the activity bar', async () => {
	// The review happens while the user is somewhere else entirely, so the way back to it cannot
	// be a settings pane. The icon appears on the SAME broadcast that told the settings pane a
	// token had been stored, with no reload and nothing polling for it.
	await expect(snoutbotIcon()).toHaveCount(1);
	await snoutbotIcon().click();
	await expect(handle.page.locator('[data-test="review-view"]')).toBeVisible();
	await handle.page.screenshot({ path: 'e2e/.artifacts/snoutbot-activity-bar.png' });
});

test('one host at a time: the pane opens on the one that is connected', async () => {
	// A team is on GitHub or it is on GitLab. Both cards stacked meant the pane opened by asking
	// for two tokens, the first of which is for a host this user does not use.
	await openSettings();
	// A connected host opens the pane on Repositories, which is where that user was going. The
	// host cards are one tab over.
	await reviewTab('Where your code lives');
	const tabs = handle.page.locator('.review-forge-tabs .tab');
	await expect(tabs).toHaveCount(2);

	// GitHub holds the token (the test above pasted it), so that is the tab that is open — not
	// whichever happens to be first.
	await expect(tabs.filter({ hasText: 'GitHub' })).toHaveAttribute('aria-selected', 'true');
	await expect(tabs.filter({ hasText: 'GitHub' }).locator('.tab-dot')).toBeVisible();
	await expect(tabs.filter({ hasText: 'GitLab' }).locator('.tab-dot')).toHaveCount(0);
	await expect(handle.page.locator('.review-settings')).toContainText('Connected as');
	// The other host's fields are FOLDED, not merely further down the page.
	await expect(handle.page.getByPlaceholder('https://gitlab.com')).toBeHidden();

	// Folded, not removed: GitLab is one click away, self-hosted field and all.
	await tabs.filter({ hasText: 'GitLab' }).click();
	await expect(handle.page.getByPlaceholder('https://gitlab.com')).toBeVisible();
	await expect(handle.page.getByPlaceholder('glpat-…')).toBeVisible();
	await expect(handle.page.locator('.review-settings')).not.toContainText('Connected as');

	// What to allow is a LIST, in front of the token field, not a sentence folded under it: the
	// user reads it here and ticks it on the host's own form. Each line carries what it buys.
	const grants = handle.page.locator('.review-grants li');
	await expect(grants).toHaveCount(1);
	await expect(grants.first()).toContainText('api');
	await expect(grants.first()).toContainText(/post the review/i);
	// And the promise that bounds the whole list.
	await expect(handle.page.locator('.review-settings')).toContainText(/never pushes, merges or changes a branch/i);
	await handle.page.screenshot({ path: 'e2e/.artifacts/snoutbot-connect.png' });

	// And back, without disturbing the GitHub connection.
	await tabs.filter({ hasText: 'GitHub' }).click();
	await expect(handle.page.locator('.review-settings')).toContainText('Connected as');
	await handle.page.keyboard.press('Escape');
	await expect(handle.page.locator('.settings-page')).toBeHidden();
});

test('repositories are PICKED from what the token can reach, several at a time', async () => {
	// Nobody should have to be the index of their own permissions. The combo IS the token's access:
	// three here, one private and one read-only for this account, which the option has to say out
	// loud rather than let it 403 on the first pull request.
	await openSettings();
	const pick = handle.page.locator('select[data-test="review-pick"]');
	const options = pick.locator('option:not([value=""])');
	await expect(options).toHaveCount(3);
	await expect(options.nth(0)).toContainText('acme/api');
	await expect(options.nth(1)).toContainText('private');
	await expect(options.nth(2)).toContainText('cannot comment');

	// Picking IS watching — no commit step, and the card appears straight away. What is watched
	// leaves the combo, so the two halves never disagree about the same repository.
	await pick.selectOption('acme/api');
	await expect(handle.page.locator('.review-repo')).toHaveCount(1);
	await expect(options).toHaveCount(2);

	// And it goes back. The card's own button is the way out, and an unbound repository has
	// nothing to lose so it goes without a question (the bound case is the next test).
	await handle.page.locator('.review-repo').getByRole('button', { name: 'Stop watching' }).click();
	await expect(handle.page.locator('.review-repo')).toHaveCount(0);
	await expect(options).toHaveCount(3);

	// Several, because nobody has exactly one repository.
	await pick.selectOption('acme/api');
	await pick.selectOption('acme/warehouse');
	await expect(handle.page.locator('.review-repo')).toHaveCount(2);
	await expect(options).toHaveCount(1);
	await handle.page.screenshot({ path: 'e2e/.artifacts/snoutbot-settings.png' });
	await handle.page.keyboard.press('Escape');
	await expect(handle.page.locator('.settings-page')).toBeHidden();
});

test('stopping a repository that has been SET UP asks first', async () => {
	// Stopping throws its binding away, so a mis-click must not be the last word. An untouched
	// repository has nothing to lose and goes without a question (asserted above).
	// Bound through the API rather than the card's picker: this profile has no connections, and
	// what the guard reads is that the binding EXISTS, not that it resolves.
	await handle.page.evaluate(async () =>
		window.sqlApi.review.updateRepo('acme/api', { connectionId: 'staging-connection' }));

	await openSettings();
	// The question comes BEFORE anything moves, so cancelling leaves the card exactly where it was.
	const card = handle.page.locator('.review-repo').filter({ hasText: 'acme/api' });
	await card.getByRole('button', { name: 'Stop watching' }).click();
	await expect(handle.page.locator('.modal.confirm')).toContainText(/Stop watching/i);
	await handle.page.locator('.modal.confirm').getByRole('button', { name: 'Stop watching' }).click();
	await expect(handle.page.locator('.review-repo')).toHaveCount(1);

	// Put it back for the reviews that follow.
	await handle.page.locator('select[data-test="review-pick"]').selectOption('acme/api');
	await expect(handle.page.locator('.review-repo')).toHaveCount(2);
	// …and unbound again, so the review below is the STATIC tier it says it is.
	await handle.page.evaluate(async () =>
		window.sqlApi.review.updateRepo('acme/api', { connectionId: undefined }));
	await handle.page.keyboard.press('Escape');
	await expect(handle.page.locator('.settings-page')).toBeHidden();
});

test('a token that can reach nothing says so, and names what causes it', async () => {
	// The failure mode this replaces was a "Loading…" that never finished and never said anything,
	// which reads as a broken app rather than as an answer.
	reposMode = 'empty';
	await openSettings();
	await handle.page.getByRole('button', { name: 'Refresh' }).click();
	const empty = handle.page.locator('.review-empty-list');
	await expect(empty).toContainText('cannot reach any repositories');
	// Both real causes are named, because neither is guessable from this screen. The first is
	// worded for the FINE-GRAINED token the pane now hands out, where the repositories are
	// granted one by one and "All repositories" is not the default — a wrong scope is the
	// classic token's version of the same mistake.
	await expect(empty).toContainText(/not granted the repositories/i);
	await expect(empty).toContainText(/SSO/);
	await expect(handle.page.getByRole('button', { name: 'Refresh' })).toBeEnabled();

	// And a GitHub that errors is an error with a way out, not a spinner.
	reposMode = 'error';
	await handle.page.getByRole('button', { name: 'Refresh' }).click();
	await expect(handle.page.locator('.review-settings .form-error')).toContainText(/GitHub|Server Error/i);
	await expect(handle.page.getByRole('button', { name: 'Try again' })).toBeVisible();

	reposMode = 'ok';
	await handle.page.getByRole('button', { name: 'Try again' }).click();
	// One of the three, because the other two are already watched and a watched repository is not
	// offered again. What matters is that the list came BACK, and that the error did not take the
	// two cards with it.
	await expect(handle.page.locator('select[data-test="review-pick"] option:not([value=""])')).toHaveCount(1);
	await expect(handle.page.locator('.review-repo')).toHaveCount(2);
	await handle.page.keyboard.press('Escape');
	await expect(handle.page.locator('.settings-page')).toBeHidden();
});

test('a bound repository REACHES the database, without anybody having connected it', async () => {
	// The defect this pins, found by hand against a real repository on 2026-08-29. The schema is
	// served from the language server's cache, the cache is filled by CONNECTING, and the runner
	// used to ask for whatever happened to be in it. So a user who had bound a connection and
	// chosen "read the schema and measure the data" still got a text-only review unless they had
	// also, by hand, in that session, opened that connection in the editor — and the comment then
	// said "no database was connected", which is true about the run and flatly contradicts the
	// setting they had just made.
	//
	// NOTHING HERE CONNECTS. That omission is the whole test: `saveConnection` and then straight
	// into a review. If the runner does not connect for itself, the footer below comes back.
	const db = join(mkdtempSync(join(tmpdir(), 'snoutbot-db-')), 'orders.db');
	const seed = new DatabaseSync(db);
	seed.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, ship_date TEXT, customer_id INTEGER)');
	seed.exec('CREATE TABLE legacy_orders (id INTEGER PRIMARY KEY)');
	seed.close();

	// NOTHING IS POSTED by this test or the next one, so neither can disturb what follows them.
	// What is being tested here is what the review SAYS, not how it travels.
	heldPosting = await handle.page.evaluate(async () => {
		const status = await window.sqlApi.review.status();
		const was = status.repos.find((r) => r.id === 'acme/api')?.approveBeforePosting ?? false;
		await window.sqlApi.review.updateRepo('acme/api', { approveBeforePosting: true });
		return was;
	});

	const connectionId = await handle.page.evaluate(async (file) => {
		const api = (window as unknown as {
			sqlApi: { saveConnection(form: unknown): Promise<{ id: string }> };
		}).sqlApi;
		const saved = await api.saveConnection({
			label: 'snoutbot-dev', driver: 'sqlite', host: '', port: 0,
			database: file, username: '', ssl: false, readOnly: false,
		});
		return saved.id;
	}, db);

	await handle.page.evaluate(async (id) =>
		window.sqlApi.review.updateRepo('acme/api', { connectionId: id, depth: 'connected' }), connectionId);

	await handle.page.evaluate(async () => window.sqlApi.review.reviewPull('acme/api', 7));
	await openReviews();
	const detail = handle.page.locator('[data-test="review-detail"]');
	await expect(detail).toContainText('Drop the legacy orders table');

	// The sentence that was there before the fix, and must not be now.
	await expect(detail).not.toContainText(/No database was connected/i);
	// And it names what it looked at, because a measurement with nothing attached to it is not a
	// measurement.
	await expect(detail).toContainText('snoutbot-dev');
	await handle.page.screenshot({ path: 'e2e/.artifacts/snoutbot-connected.png' });

	// Unbound again, so the reviews after this one are the static tier they say they are. Posting
	// stays held for the next test, which puts it back.
	await handle.page.evaluate(async () =>
		window.sqlApi.review.updateRepo('acme/api', { connectionId: undefined, depth: 'connected' }));
});

test('a destination that cannot be reached is a NAMED gap, never a quiet text-only review', async () => {
	// The other half of the same defect. Every way of failing to reach the destination used to
	// return undefined, which is indistinguishable from "this repository is unbound" — so the
	// comment printed the ordinary static-tier footer and the user had no way to tell a
	// deliberately text-only review from a broken one.
	await handle.page.evaluate(async () =>
		window.sqlApi.review.updateRepo('acme/api', { connectionId: 'a-connection-that-was-deleted', depth: 'connected' }));

	// The COMMENT is what is asserted, read back over IPC rather than off the screen. That is the
	// artefact this is about: the gap has to reach the pull request, where the person who set the
	// binding will be looking, not merely the window they are not in.
	const body = await handle.page.evaluate(async () => {
		const run = await window.sqlApi.review.reviewPull('acme/api', 7);
		return run?.body ?? '';
	});
	expect(body).toMatch(/no longer exists/i);
	expect(body).toMatch(/nothing here was measured/i);
	// And it is filed as something that could NOT be checked, never as a clean pass.
	expect(body).toMatch(/could not check/i);

	// Unbound, and posting put back exactly as it was found.
	await handle.page.evaluate(async (was) =>
		window.sqlApi.review.updateRepo('acme/api', { connectionId: undefined, approveBeforePosting: was }), heldPosting);
});

test('a review is written to disk, so a restart does not lose one nobody has read', async () => {
	// Reviews used to live in an array on the service and nowhere else, deliberately. The app is a
	// tray app whose close button HIDES the window, so a review written in the afternoon and not
	// yet read was simply gone the next morning, with nothing to say it had existed. Approval before
	// posting is what the desktop reviewer is for, so losing the thing waiting for approval was the worst
	// possible thing to drop.
	//
	// Asserted against the FILE rather than the screen, because the screen would still show what is
	// in memory whether or not anything was persisted, which is precisely the bug.
	await handle.page.evaluate(async () => window.sqlApi.review.reviewPull('acme/api', 8));
	// The profile is a scratch directory this spec never named, so main is asked where it is and
	// the file is read here, in node. Reading it inside `app.evaluate` would mean requiring fs in
	// the main process, which is more machinery than a test needs.
	const profile = await handle.app.evaluate(({ app }) => app.getPath('userData'));
	const runsFile = join(profile, 'reviewRuns.json');
	const runs = JSON.parse(existsSync(runsFile) ? readFileSync(runsFile, 'utf8') : '[]') as Array<{ id: string; prNumber: number; body: string; method: { kind: string } }>;
	const eight = runs.find((r) => r.prNumber === 8);
	assert(eight, 'the review just written is not in reviewRuns.json');
	// The whole comment, not a summary of it: what was SAID is the record, and the pull request is
	// not somewhere this app can read it back from months later.
	expect(eight.body).toContain('snout-review:v1');
	// And which rung wrote it, which the pull request does not record anywhere.
	expect(eight.method.kind).toBeTruthy();

	// Discarding takes it off the disk too, or "remove from this list" would be a lie that comes
	// back at the next restart.
	await handle.page.evaluate(async (id) => window.sqlApi.review.discard(id), eight.id);
	const after = JSON.parse(readFileSync(runsFile, 'utf8')) as Array<{ prNumber: number }>;
	expect(after.some((r) => r.prNumber === 8)).toBe(false);
});

test('the rungs this build offers, and a sentence about where the data goes that is COMPUTED', async () => {
	// The picker is the same ladder Data Flows offers for reading a file, and the findings do not
	// move between its rungs. What is asserted here is the part a screen gets wrong on its own: the
	// sentence under it comes from `reviewBoundary`, so it cannot say "nothing is sent anywhere"
	// while the app sends it somewhere.
	await openSettings();
	const card = handle.page.locator('.review-repo').filter({ hasText: 'acme/api' });
	const method = card.locator('select').filter({ has: handle.page.locator('option[value="snoutAi"]') });
	// The model on this computer is Data Flows' local runtime, so a build without Data Flows (the
	// open-source one) offers the other three and not that one.
	if (PRO_BUILD) {
		await expect(method.locator('option')).toHaveCount(4);
		await expect(method.locator('option[value="localEngine"]')).toBeEnabled();
	} else {
		await expect(method.locator('option')).toHaveCount(3);
		await expect(method.locator('option[value="localEngine"]')).toHaveCount(0);
	}

	// The default, on a repository nobody has touched: the rules alone, no model anywhere.
	await expect(method).toHaveValue('deterministic');
	const boundary = card.locator('.review-method-boundary');
	await expect(boundary).toHaveAttribute('data-boundary', 'local');
	await expect(boundary).toContainText(/no model is called/i);

	// Our AI is the rung that costs the allowance, and it says both halves.
	await method.selectOption('snoutAi');
	await expect(boundary).toHaveAttribute('data-boundary', 'ourServers');
	await expect(boundary).toContainText(/our servers/i);
	await expect(boundary).toContainText(/allowance/i);

	// THE ONE THAT MATTERS. "Bring your own model" is not one answer to "does my data leave this
	// computer": an Ollama here is local and the same Ollama on the box under the desk is not, and
	// the sentence has to follow the HOST rather than the rung.
	await method.selectOption('byok');
	const host = card.getByPlaceholder('http://127.0.0.1:11434');
	await expect(boundary).toHaveAttribute('data-boundary', 'local');
	await host.fill('http://10.0.0.4:11434');
	await expect(boundary).toHaveAttribute('data-boundary', 'theirNetwork');
	await expect(boundary).toContainText('10.0.0.4');

	// A vendor key is a third party and is named, not called "your provider".
	await card.locator('select').filter({ has: handle.page.locator('option[value="anthropic"]') }).selectOption('anthropic');
	await expect(boundary).toHaveAttribute('data-boundary', 'thirdParty');
	await expect(boundary).toContainText('Anthropic');
	await handle.page.screenshot({ path: 'e2e/.artifacts/snoutbot-method.png' });

	// Back to the rules for the reviews below, which are the static tier they say they are.
	await method.selectOption('deterministic');
	await expect(boundary).toHaveAttribute('data-boundary', 'local');
	await handle.page.keyboard.press('Escape');
	await expect(handle.page.locator('.settings-page')).toBeHidden();
});

test('a review of an unbound repository runs text-only and SAYS the database was not consulted', async () => {
	await handle.page.evaluate(async () => {
		// No connection bound, so this is the static tier, and approval is on: nothing may go out
		// until it has been read.
		await window.sqlApi.review.updateRepo('acme/api', { approveBeforePosting: true, depth: 'static' });
		await window.sqlApi.review.setEnabled(true);
		await window.sqlApi.review.pollNow();
	});

	await openReviews();
	const item = handle.page.locator('[data-test="review-list-item"]');
	await expect(item).toHaveCount(1);
	await expect(item).toContainText('acme/api #7');
	await expect(item).toContainText('Waiting');

	const detail = handle.page.locator('[data-test="review-detail"]');
	await expect(detail).toContainText('Drop the legacy orders table');
	// Never imply the static tier checked the database.
	await expect(detail).toContainText(/the database was not consulted/i);
	// It found the thing a diff alone can find.
	await expect(detail.locator('.review-comment')).toContainText(/Drops the table/i);
	await handle.page.screenshot({ path: 'e2e/.artifacts/snoutbot-review.png' });
});

test('nothing reaches GitHub until the user says so', async () => {
	// The review has been written and read. No comment has been posted.
	expect(comments).toHaveLength(0);
	expect(seen.some((r) => r.method === 'POST' && r.path.includes('/issues/7/comments'))).toBe(false);

	await handle.page.locator('[data-test="review-approve"]').click();
	await expect(handle.page.locator('[data-test="review-detail"]')).toContainText(/Posted to the pull request/i);

	expect(comments).toHaveLength(1);
	// One comment per pull request, and it carries the marker that lets the next push EDIT it
	// rather than stack another one. The marker is deliberately brand-free — review-core's
	// `COMMENT_MARKER`, since no product name may live outside `branding.ts`.
	expect(comments[0].body).toContain('<!-- snout-review:v1 -->');
	// It is a review of the change, not a summary of the diff: the finding names the consequence.
	expect(comments[0].body).toMatch(/Drops the table `legacy_orders`/);

	// And the commit's check line is settled by POSTING, not by reviewing: it read `pending` for
	// the whole time the review sat unread, because nothing had been said on the pull request yet.
	const last = statuses[statuses.length - 1];
	expect(last.context).toBe('snoutbot');
	expect(last.state).not.toBe('pending');
});

test('the pull request says it is being reviewed WHILE it is being reviewed', async () => {
	// The reviewer was silent for the whole time it worked: a diff to fetch, a schema to read and
	// rows to count, with nothing on the pull request and nothing in the app. Two things fix it,
	// and this asserts both.
	statuses.length = 0;

	// 1. A commit status goes up BEFORE the work, under one context so the result replaces it
	//    rather than stacking a second row.
	await handle.page.evaluate(async () => window.sqlApi.review.reviewPull('acme/api', 7));
	expect(statuses.length).toBeGreaterThanOrEqual(2);
	expect(statuses[0].state).toBe('pending');
	expect(statuses[0].description).toMatch(/reviewing/i);
	expect(new Set(statuses.map((s) => s.context))).toEqual(new Set(['snoutbot']));
	// The last word is the findings, not a verdict on the change.
	expect(statuses[statuses.length - 1].state).not.toBe('pending');
	expect(statuses[statuses.length - 1].description).toMatch(/warning|blocker|note|Nothing to flag|waiting/i);

	// 2. And the app says so in the corner, the same place the update card uses. ONE card: the
	//    generic notification toast is suppressed for Snoutbot, which has its own and says the
	//    same thing better. Its entry still lands in the notifications centre.
	await expect(handle.page.locator('[data-test="review-toast"]')).toBeVisible();
	await expect(handle.page.locator('.notif-toast')).toHaveCount(0);
	await handle.page.screenshot({ path: 'e2e/.artifacts/snoutbot-toast.png' });
});

test("the card's button opens the review it is about, from a cold app", async () => {
	// The button is the only way into a review from the corner of the screen, so it has to work
	// with the tab CLOSED (the state anybody who was not already reading reviews is in) and it
	// has to land on the review the card was about, not merely on the list.
	const reviewTab = handle.page.locator('.tab-item', { hasText: 'Reviews' });
	if (await reviewTab.count() > 0) {
		await reviewTab.locator('.tab-close').click();
	}
	await expect(handle.page.locator('[data-test="review-view"]')).toBeHidden();

	// A SECOND review, so "open the reviews" and "open THIS review" are different answers. The
	// view picks the oldest one still waiting when nobody says, and #7 is waiting from earlier,
	// so a button that only opened the list would land on the wrong one.
	await handle.page.evaluate(async () => window.sqlApi.review.reviewPull('acme/api', 8));
	const toast = handle.page.locator('[data-test="review-toast"]');
	await expect(toast).toBeVisible();
	await expect(toast).toContainText('acme/api #8');
	await toast.getByRole('button', { name: /Open|Read it/ }).click();

	await expect(handle.page.locator('[data-test="review-view"]')).toBeVisible();
	await expect(handle.page.locator('[data-test="review-list-item"]')).toHaveCount(2);
	await expect(handle.page.locator('[data-test="review-list-item"].chosen')).toContainText('acme/api #8');
	await expect(handle.page.locator('[data-test="review-detail"]')).toContainText('Add the shipping index');

	// And asking for a review that is ALREADY open still works, which is what the nonce is for:
	// select #7 by hand, then ask the card for #8 again.
	await handle.page.locator('[data-test="review-list-item"]', { hasText: '#7' }).click();
	await expect(handle.page.locator('[data-test="review-detail"]')).toContainText('Drop the legacy orders table');
	await handle.page.evaluate(async () => window.sqlApi.review.reviewPull('acme/api', 8));
	await toast.getByRole('button', { name: /Open|Read it/ }).click();
	await expect(handle.page.locator('[data-test="review-detail"]')).toContainText('Add the shipping index');
});

test('posting as snoutbot[bot]: the App path, end to end', async () => {
	// The thing every reviewer of this shape does, and the only way GitHub allows a name that is
	// not a person's. What matters is that the WHOLE path is taken: sign a JWT with a real key,
	// ask who the App is, trade the JWT for an installation token, and then post with that token
	// under the App's login rather than the user's.
	const dir = mkdtempSync(join(tmpdir(), 'snoutbot-app-'));
	const pem = join(dir, 'snoutbot.private-key.pem');
	writeFileSync(pem, generateKeyPairSync('rsa', {
		modulusLength: 2048,
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	}).privateKey);
	await handle.app.evaluate(({ dialog }, chosen) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
	}, pem);

	await openSettings();
	// Who the review is posted AS belongs with the host it is posted to, so it is on that tab.
	await reviewTab('Where your code lives');
	// Both ways of posting are offered, and the person is the one selected: it needs no setup, so
	// it stays the default.
	// Indexed, not filtered by text: "your organization" appears in the OTHER card's prose, so
	// `hasText: 'You'` matches both. The order is the escalation: no setup first.
	const options = handle.page.locator('.review-identity-option');
	await expect(options).toHaveCount(2);
	await expect(options.nth(0).locator('.review-identity-title')).toHaveText(/^\s*You\s*$/);
	await expect(options.nth(1).locator('.review-identity-title')).toHaveText(/Snoutbot/);
	await expect(options.nth(0)).toHaveAttribute('aria-pressed', 'true');

	await options.nth(1).click();
	await handle.page.getByLabel('App ID').fill('1234567');
	await handle.page.getByRole('button', { name: /Choose the private key/ }).click();

	// It reports the identity the comments will carry, not the person's.
	await expect(handle.page.locator('.review-settings')).toContainText('snoutbot[bot]');
	await handle.page.screenshot({ path: 'e2e/.artifacts/snoutbot-app.png' });

	// The repositories now come from what the App is INSTALLED on, a different question and a
	// different endpoint from what a person can reach.
	//
	// Polled, not asserted once: the pane refetches the list as a side effect of the identity
	// changing, and nothing on screen marks the moment that request goes out. A bare `expect`
	// here passed on an idle machine and lost the race on a busy one, which is the definition of
	// a flake rather than a finding.
	await expect.poll(() => seen.some((r) => r.path.startsWith('/installation/repositories'))).toBe(true);
	// The whole App handshake was taken: who the App is, then a JWT traded for an installation
	// token. The token lasts an hour, so the review below reuses it rather than minting again.
	expect(seen.some((r) => r.path === '/app')).toBe(true);
	expect(seen.some((r) => r.method === 'POST' && /\/app\/installations\/\d+\/access_tokens/.test(r.path))).toBe(true);
	await handle.page.keyboard.press('Escape');

	// And a real review posts through it: JWT, installation token, comment.
	comments.length = 0;
	seen.length = 0;
	await handle.page.evaluate(async () => {
		await window.sqlApi.review.updateRepo('acme/api', { approveBeforePosting: false });
		await window.sqlApi.review.reviewPull('acme/api', 7);
	});
	expect(comments).toHaveLength(1);
	expect(comments[0].body).toContain('<!-- snout-review:v1 -->');
	// THE assertion: the comment went out with the App's installation token, not with the
	// personal token that is still sitting in the keychain. That is what decides the byline, and
	// it is the only thing a fake GitHub can actually prove about who posted.
	const posted = seen.find((r) => r.method === 'POST' && r.path.includes('/issues/7/comments'));
	expect(posted?.auth).toBe('Bearer ghs_installation');
	expect(posted?.auth).not.toContain('ghp_faketoken');

	// Going back is not destructive: the personal token is still in the keychain, so the choice
	// is a choice rather than a one-way door.
	await openSettings();
	await reviewTab('Where your code lives');
	await handle.page.locator('.review-identity-option').nth(0).click();
	await expect(handle.page.locator('.review-settings')).toContainText('Connected as');
	await expect(handle.page.locator('.review-settings')).toContainText('alex-test');
	await handle.page.keyboard.press('Escape');
});

test('every poll reaches GitHub, and an unchanged one is answered 304', async () => {
	// A webhook cannot reach a laptop, so this asks rather than being told, and the cost of asking
	// is what limits how often it can. One call per repository for the open pull requests plus one
	// per pull request for its comments is 1 + N a minute; four repositories at that rate is over
	// GitHub's 5,000-an-hour ceiling, and reaching it does not slow the reviewer down, it stops it.
	//
	// Two separate claims, so two phases. Neither is provable in the other's conditions.
	await handle.page.evaluate(async () => window.sqlApi.review.setEnabled(true));

	// PHASE 1 — the request always goes out.
	//
	// `netFetch` is Chromium's stack, which brings Chromium's HTTP cache, and this is the header
	// GitHub really sends. Without a cache mode a poll on a 60s interval can be handed the list
	// out of that cache WITHOUT ASKING, so a pull request opened a moment ago stays invisible
	// until the entry goes stale. If `cache: 'no-cache'` were ignored, this phase would see one
	// request for two polls.
	pullsCaching = 'github';
	seen.length = 0;
	await handle.page.evaluate(async () => {
		await window.sqlApi.review.pollNow();
		await window.sqlApi.review.pollNow();
	});
	expect(seen.filter((r) => r.path.startsWith('/repos/acme/api/pulls?'))).toHaveLength(2);

	// PHASE 2 — and an unchanged answer is cheap, on the reviewer's own ETag.
	//
	// Served `no-store` here, so Chromium keeps nothing: an `If-None-Match` on the wire can only
	// be the reviewer's cache, and the 304 has to be understood by our code rather than absorbed
	// by the browser's. That is also the real state whenever Chromium's cache is cold and ours is
	// not, which is every launch.
	pullsCaching = 'no-store';
	const before = notModified;
	seen.length = 0;
	await handle.page.evaluate(async () => {
		await window.sqlApi.review.pollNow();
		await window.sqlApi.review.pollNow();
	});
	const asked = seen.filter((r) => r.path.startsWith('/repos/acme/api/pulls?'));
	expect(asked).toHaveLength(2);
	expect(asked[asked.length - 1].inm).toBe(PULLS_ETAG);
	// GitHub does not charge a 304 against the rate limit at all, which is the whole saving.
	expect(notModified).toBeGreaterThan(before);

	// A 304 is not an error. It is outside the 2xx range, so the one way to get all of this wrong
	// is to treat it as a failed request: the poller would stop after one pass and the pane would
	// show "GitHub returned 304" for the rest of the session.
	const status = await handle.page.evaluate(async () => window.sqlApi.review.status());
	expect(status.lastError).toBeUndefined();
});

test('Check now says what it found, even when that is nothing', async () => {
	// It returned nothing and drew nothing, so a check that found nothing new looked like a dead
	// button. And "Pause Scheduled Flows" swallowed the press outright: a person is not a schedule.
	const page = handle.page;
	await page.evaluate(async () => window.sqlApi.review.setEnabled(true));
	await page.evaluate(async () => window.sqlApi.schedules.setPaused(true));
	try {
		const result = await page.evaluate(async () => window.sqlApi.review.pollNow());
		expect(result.outcome).toBe('checked');
		await openReviews();
		await page.locator('[data-test="review-view"] button', { hasText: 'Check now' }).click();
		await expect(page.locator('[data-test="review-check-result"]')).toContainText(/Checked \d+ repositor(y|ies) at .+: /);
	} finally {
		await page.evaluate(async () => window.sqlApi.schedules.setPaused(false));
	}
});

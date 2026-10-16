/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launchApp, closeApp, type AppHandle } from './helpers';

/** A value from the project's .env, read the way the stack writes it. */
function envOf(project: string, name: string): string {
	const line = new RegExp(`^${name}=(.*)$`, 'm').exec(readFileSync(join(project, '.env'), 'utf8'))?.[1] ?? '';
	return line.replace(/^(['"])(.*)\1$/, '$2');
}

/** The role a key is signed for. */
function roleOf(key: string): string {
	return String(JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf8')).role);
}

/** One statement as the project's owner, with the password .env holds now. */
async function ownerSql(project: string, sql: string): Promise<string> {
	const { Client } = await import('pg');
	const ref = envOf(project, 'SNOUT_REF');
	const client = new Client({ host: '127.0.0.1', port: Number(envOf(project, 'DB_PORT')), user: `${ref}_owner`, database: ref, password: envOf(project, 'POSTGRES_OWNER_PASSWORD') });
	await client.connect();
	try {
		const res = await client.query(sql);
		return res.rows.length > 0 ? String(Object.values(res.rows[0] as Record<string, unknown>)[0]) : '';
	} finally {
		await client.end();
	}
}

/*
 * Local projects: the Projects panel's Local group, the setup wizard and a project's tab, driven
 * through the real app.
 *
 * The first two tests run everywhere. They read this machine's Docker as it is (a requirements
 * check is a few read-only `docker` calls), so they assert the SHAPE of the answer, not that Docker
 * is there: with no Docker the wizard must say so and keep Next shut.
 *
 * The last test is opt-in (`SNOUTDATA_TEST_DOCKER=1`): it sets a real project up in a temporary
 * folder, which pulls the stack's images the first time (about 670 MB, 1.9 GB on disk) and runs a dozen containers,
 * then removes it with its data.
 */

let handle: AppHandle;
const live = process.env.SNOUTDATA_TEST_DOCKER === '1';
let folder = '';

test.beforeAll(async () => {
	handle = await launchApp('local-projects');
});

test.afterAll(async () => {
	await closeApp(handle);
	if (folder) {
		// A run that failed half way leaves its stack running. Take down THAT project only, by the
		// ref in its own .env: never by a name pattern, which would match the user's own projects.
		const env = join(folder, 'e2e-project', '.env');
		const ref = existsSync(env) ? /^SNOUT_REF=([a-z0-9]{13})$/m.exec(readFileSync(env, 'utf8'))?.[1] : undefined;
		if (ref) {
			try {
				execFileSync('docker', ['compose', '-p', `snout-${ref}`, 'down', '-v', '--remove-orphans'], { cwd: join(folder, 'e2e-project'), stdio: 'ignore' });
			} catch {
				// already gone, which is what a passing run leaves
			}
		}
		rmSync(folder, { recursive: true, force: true });
	}
});

const header = () => handle.page.locator('.sidebar-header', { hasText: 'DASHBOARD' });

async function showProjects(): Promise<void> {
	if (!(await header().isVisible().catch(() => false))) {
		await handle.page.click('.activity-bar button[aria-label="Dashboard"]');
	}
	await expect(header()).toBeVisible();
}

test('the Projects panel has a Local and a Cloud group, and Local offers a setup', async () => {
	await showProjects();
	const panel = handle.page.locator('.sidebar', { has: header() });
	await expect(panel.locator('.tree-row.projects-group', { hasText: 'Local' })).toHaveCount(1);
	await expect(panel.locator('.tree-row.projects-group', { hasText: 'Cloud' })).toHaveCount(1);
	await expect(panel.locator('.tree-row', { hasText: 'Set up a local project' })).toHaveCount(1);

	// The header's + asks which kind, rather than guessing.
	await header().locator('button[aria-label="New project"]').click();
	await expect(handle.page.locator('.panel-menu-item', { hasText: 'Local, in Docker' })).toBeVisible();
	await handle.page.keyboard.press('Escape');
	await expect(handle.page.locator('.panel-menu')).toHaveCount(0);
	await handle.page.screenshot({ path: 'test-results/local-projects-panel.png' });
});

test('the wizard checks the requirements first, and only a passing check opens the next step', async () => {
	await showProjects();
	await handle.page.locator('.tree-row', { hasText: 'Set up a local project' }).click();
	const view = handle.page.locator('.local-setup');
	await expect(view.locator('.settings-section-title')).toHaveText('Requirements');
	// Every machine gets an answer about Docker: found, or not with what to do.
	await expect(view.locator('.local-requirement', { hasText: 'Docker' }).first()).toBeVisible({ timeout: 30000 });
	await handle.page.screenshot({ path: 'test-results/local-projects-requirements.png' });

	const next = view.locator('.modal-actions button', { hasText: 'Next' });
	const failing = await view.locator('.local-requirement-icon.fail').count();
	if (failing > 0) {
		await expect(next).toBeDisabled();
		await expect(view.locator('.local-requirement .field-hint').first()).toBeVisible();
		return;
	}
	await next.click();
	await expect(view.locator('.settings-section-title')).toHaveText('Project');
	// The folder and the ports are filled in before the user types anything.
	await expect(view.locator('.local-folder-row input')).not.toHaveValue('');
	await expect(view.locator('label', { hasText: 'API port' }).locator('input')).not.toHaveValue('');
	// No name yet, so Next says why instead of moving on.
	await view.locator('.modal-actions button', { hasText: 'Next' }).click();
	await expect(view.locator('.form-status.warn')).toContainText('name');
	await handle.page.screenshot({ path: 'test-results/local-projects-project-step.png' });
});

test('a real project: set up, keys, services, stop and remove (opt-in, SNOUTDATA_TEST_DOCKER=1)', async () => {
	test.skip(!live, 'opt-in: pulls the stack and runs it in Docker');
	test.setTimeout(30 * 60 * 1000);
	folder = mkdtempSync(join(tmpdir(), 'snout-local-e2e-'));
	const target = join(folder, 'e2e-project');
	const view = handle.page.locator('.local-setup');

	await view.locator('label', { hasText: 'Name' }).locator('input').fill('e2e local');
	await view.locator('.local-folder-row input').fill(target);
	await view.locator('.modal-actions button', { hasText: 'Next' }).click();
	await expect(view.locator('.settings-section-title')).toHaveText('Sign-in and mail');
	await view.locator('.modal-actions button', { hasText: 'Next' }).click();
	await expect(view.locator('.settings-section-title')).toHaveText('Files');
	await view.locator('.modal-actions button', { hasText: 'Next' }).click();
	await expect(view.locator('.settings-section-title')).toHaveText('Review');
	await handle.page.screenshot({ path: 'test-results/local-projects-review.png' });
	await view.locator('button', { hasText: 'Set up and start' }).click();

	await expect(view.locator('legend', { hasText: 'Ready' })).toBeVisible({ timeout: 25 * 60 * 1000 });
	await handle.page.screenshot({ path: 'test-results/local-projects-installed.png' });

	// The database is a connection, with the butterfly.
	await view.locator('button', { hasText: 'Open project' }).click();
	const tab = handle.page.locator('.cloud-project-view');
	await expect(tab.locator('.cloud-facts').first()).toContainText('running', { timeout: 60000 });

	// The keys are on the Dashboard, where the cloud dashboard keeps them.
	const keys = tab.locator('fieldset', { hasText: 'API and keys' });
	await keys.locator('.cloud-actions', { hasText: 'Ships in your application' }).locator('button', { hasText: 'Copy' }).click();
	await expect(tab).toContainText('The app key was copied.');
	const anon = await handle.app.evaluate(({ clipboard }) => clipboard.readText());
	expect(anon.split('.').length).toBe(3);
	// The pinned stack's init signs its keys with the new layout's role names.
	expect(roleOf(anon)).toBe('snout_app');
	expect(roleOf(envOf(target, 'SERVICE_ROLE_KEY'))).toBe('snout_server');
	// The pinned stack serves our names (and the earlier ones beside them, which an older project's gateway alone serves).
	const apiUrl = (await keys.locator('.cloud-actions .mono').first().textContent()) ?? '';
	const res = await fetch(`${apiUrl}/v1/data/`, { headers: { 'Snout-Key': anon } });
	expect(res.status).toBe(200);

	const section = async (label: string): Promise<void> => {
		await tab.locator('.settings-nav-item').filter({ hasText: new RegExp(`^${label}$`) }).click();
		await expect(tab.locator('.settings-section-title')).toHaveText(label);
	};
	const shot = (name: string): Promise<Buffer> => handle.page.screenshot({ path: `test-results/local-projects-${name}.png` });

	// The Dashboard carries every service's health.
	await section('Overview');
	await expect(tab.locator('.local-service', { hasText: 'gateway' })).toBeVisible();
	// The dashboard's numbers, its "Work on it", and what the app has done so far.
	await expect(tab.locator('.local-stat', { hasText: 'Size' })).toBeVisible({ timeout: 30000 });
	await expect(tab.locator('legend', { hasText: 'Work on it' })).toBeVisible();
	await expect(tab.locator('fieldset', { hasText: 'Recent activity' })).toContainText('The app key was copied');
	await shot('overview');

	// Auth: a user added through the admin API is listed by the owner's SQL, then deleted.
	await section('Auth');
	await tab.locator('input[placeholder="someone@example.com"]').fill('e2e@example.com');
	await tab.locator('fieldset', { hasText: 'Add a user' }).locator('input[type="password"]').fill('correct horse battery');
	await tab.locator('button', { hasText: 'Add user' }).click();
	await expect(tab).toContainText('e2e@example.com was added.');
	await expect(tab.locator('.cloud-table').first()).toContainText('e2e@example.com');
	await shot('auth');
	await tab.locator('.cloud-table tr', { hasText: 'e2e@example.com' }).getByRole('button', { name: 'Delete' }).click();
	await handle.page.locator('.modal button', { hasText: 'Delete user' }).click();
	await expect(tab).toContainText('The user was deleted.');

	// Redirect addresses go to AUTH_URI_ALLOW_LIST and auth is recreated with them.
	const authForm = tab.locator('fieldset').filter({ has: handle.page.locator('legend', { hasText: /^Redirect addresses$/ }) });
	await authForm.locator('textarea').fill('http://localhost:5173\nhttps://staging.example.com');
	await tab.locator('.modal-actions button', { hasText: 'Save and restart' }).click();
	await expect(tab).toContainText('Saved. The services that changed were restarted.', { timeout: 5 * 60 * 1000 });
	expect(envOf(target, 'AUTH_URI_ALLOW_LIST')).toBe('http://localhost:5173,https://staging.example.com');

	// An email template of the project's own: a file served to auth, its URL and subject in auth's environment.
	const templates = tab.locator('fieldset').filter({ has: handle.page.locator('legend', { hasText: /^Email templates$/ }) });
	await templates.locator('tr', { hasText: 'Email confirmation' }).locator('button', { hasText: 'Edit' }).click();
	await templates.locator('label', { hasText: 'Subject' }).locator('input').fill('Welcome to e2e');
	await templates.locator('textarea').fill('<p>Hello from e2e. <a href="{{ .ConfirmationURL }}">Confirm</a></p>');
	await shot('auth-template');
	await templates.locator('button', { hasText: 'Save' }).click();
	await expect(tab).toContainText('Saved. Auth sends it from now on.', { timeout: 5 * 60 * 1000 });
	await expect(templates.locator('tr', { hasText: 'Email confirmation' })).toContainText('Yours');
	const project = `snout-${envOf(target, 'SNOUT_REF')}`;
	const authEnv = execFileSync('docker', ['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', `${project}-auth-1`], { encoding: 'utf8' });
	expect(authEnv).toContain('AUTH_MAILER_TEMPLATES_CONFIRMATION=http://mail-templates:8080/confirmation.html');
	expect(authEnv).toContain('AUTH_MAILER_SUBJECTS_CONFIRMATION=Welcome to e2e');
	// What auth fetches, fetched from auth's own network namespace (the db container's).
	const served = execFileSync('docker', ['run', '--rm', '--network', `container:${project}-db-1`, 'docker.io/library/busybox:1.37', 'wget', '-qO-', 'http://mail-templates:8080/confirmation.html'], { encoding: 'utf8' });
	expect(served).toContain('Hello from e2e.');

	// Storage: a bucket made through the storage API appears, and is deleted again.
	await section('Storage');
	await tab.locator('label', { hasText: 'New bucket' }).locator('input').fill('e2e-files');
	await tab.locator('.local-inline-form button', { hasText: 'Create' }).click();
	await expect(tab).toContainText('e2e-files was created.');
	await expect(tab.locator('legend', { hasText: 'e2e-files' })).toBeVisible();
	await shot('storage');
	await tab.locator('button', { hasText: 'Delete bucket' }).click();
	await handle.page.locator('.modal button', { hasText: 'Delete bucket' }).click();
	await expect(tab).toContainText('e2e-files was deleted.');

	await section('Push');
	await expect(tab).toContainText('not part of the self-hosted stack');

	// Realtime: the publication and the subscriptions read as the owner.
	await section('Realtime');
	await expect(tab.locator('legend', { hasText: 'Tables that stream their changes' })).toBeVisible();
	await expect(tab.locator('.form-status.error')).toHaveCount(0);
	await shot('realtime');

	// Logs: a service's log from Docker, and Postgres's statements.
	await section('Logs');
	await tab.locator('.local-chip', { hasText: 'gateway' }).click();
	await expect(tab.locator('.local-log')).toContainText('gateway', { timeout: 30000 });
	await tab.locator('.local-chip', { hasText: 'Postgres statements' }).click();
	await expect(tab.locator('legend', { hasText: 'Postgres statements' })).toBeVisible();
	await shot('logs');

	// Functions: a secret in functions/.env reaches a function, and "No key needed" lets it be called bare.
	await section('Functions');
	const newFunction = tab.locator('fieldset').filter({ has: handle.page.locator('legend', { hasText: /^New function$/ }) });
	await newFunction.locator('input').fill('e2e-secret');
	await newFunction.locator('button', { hasText: 'Create' }).click();
	await expect(tab).toContainText('functions/e2e-secret/index.ts was created.');
	writeFileSync(join(target, 'functions', 'e2e-secret', 'index.ts'), "Deno.serve(() => Response.json({ secret: Deno.env.get('E2E_SECRET') ?? null }));\n");
	await tab.locator('tr', { hasText: 'e2e-secret' }).locator('label.check').click();
	await expect(tab).toContainText('Saved. The services that changed were restarted.', { timeout: 5 * 60 * 1000 });
	const secrets = tab.locator('fieldset').filter({ has: handle.page.locator('legend', { hasText: /^Secrets$/ }) });
	await secrets.locator('input[placeholder="STRIPE_KEY"]').fill('E2E_SECRET');
	await secrets.locator('input[type="password"]').fill(`it's "quoted" & spaced`);
	await secrets.locator('button', { hasText: 'Set secret' }).click();
	await expect(tab).toContainText('E2E_SECRET was set.', { timeout: 5 * 60 * 1000 });
	await expect(secrets.locator('.cloud-table')).toContainText('E2E_SECRET');
	await shot('functions');
	const bare = await fetch(`${apiUrl}/functions/v1/e2e-secret`);
	expect(bare.status).toBe(200);
	expect(await bare.json()).toEqual({ secret: `it's "quoted" & spaced` });

	// The Data API: one switch for REST and GraphQL, and what the gateway says either way.
	await section('Data API');
	const dataApi = tab.locator('fieldset', { hasText: 'Data API' }).locator('label.check');
	await expect(dataApi).toContainText('On');
	await dataApi.click();
	await expect(tab).toContainText('The data API is off.', { timeout: 120000 });
	expect((await fetch(`${apiUrl}/v1/data/`, { headers: { 'Snout-Key': anon } })).status).toBe(502);
	await shot('dataapi-off');
	await dataApi.click();
	await expect(tab).toContainText('The data API is on', { timeout: 300000 });
	expect((await fetch(`${apiUrl}/v1/data/`, { headers: { 'Snout-Key': anon } })).status).toBe(200);
	await tab.locator('.local-subtabs .local-chip', { hasText: 'Docs' }).click();
	await expect(tab.locator('legend', { hasText: 'Your tables' })).toBeVisible();
	await shot('dataapi-docs');
	await expect(tab.locator('.form-status.error')).toHaveCount(0);

	// Extensions: the image's catalog, with the ones already on first.
	await section('Extensions');
	await expect(tab.locator('.cloud-table')).toContainText('vector');
	await shot('extensions');

	// Cron: switched on, a job scheduled, then deleted.
	await section('Cron');
	const cronOn = tab.locator('button', { hasText: 'Switch on pg_cron' });
	await expect(cronOn.or(tab.locator('legend', { hasText: 'New job' }))).toBeVisible({ timeout: 30000 });
	if (await cronOn.isVisible()) {
		await cronOn.click();
	}
	await expect(tab.locator('legend', { hasText: 'New job' })).toBeVisible({ timeout: 30000 });
	await tab.locator('label', { hasText: 'Name (optional)' }).locator('input').fill('e2e-job');
	await tab.locator('label', { hasText: 'SQL to run' }).locator('textarea').fill('select 1');
	await tab.locator('button', { hasText: 'Schedule' }).click();
	await expect(tab.locator('.local-job', { hasText: 'e2e-job' })).toBeVisible();
	await shot('cron');
	await tab.locator('.local-job', { hasText: 'e2e-job' }).locator('button', { hasText: 'Delete' }).click();
	await handle.page.locator('.modal button', { hasText: 'Delete job' }).click();
	await expect(tab.locator('.local-job', { hasText: 'e2e-job' })).toHaveCount(0);

	await section('Time series');
	await expect(tab.locator('legend').first()).toBeVisible();
	await shot('timeseries');

	await section('Domains');
	await expect(tab.locator('input[placeholder="https://api.example.com"]')).toHaveValue(/^http:\/\/localhost:\d+$/);
	await shot('domains');

	// Settings: a new owner password, then the app's own SQL door logs in with it.
	await section('Settings');
	await tab.locator('button', { hasText: 'Reset the password' }).click();
	await handle.page.locator('.modal button', { hasText: 'Reset password' }).click();
	await expect(tab).toContainText('New password set.', { timeout: 60000 });
	expect(await ownerSql(target, 'select current_user')).toBe(`${envOf(target, 'SNOUT_REF')}_owner`);

	// Export, write something after it, put it back: the later table is gone, the rest still answers.
	await tab.locator('fieldset').filter({ has: handle.page.locator('legend', { hasText: /^Export$/ }) }).getByRole('button', { name: /^Export/ }).click();
	await expect(tab).toContainText('Exported to backups/', { timeout: 10 * 60 * 1000 });
	await ownerSql(target, 'create table e2e_after_export (id int)');
	await tab.locator('fieldset').filter({ has: handle.page.locator('legend', { hasText: /^Put it back$/ }) }).locator('button', { hasText: 'Put it back' }).click();
	await handle.page.locator('.modal button', { hasText: 'Put it back' }).click();
	await expect(tab).toContainText('Put back to', { timeout: 15 * 60 * 1000 });
	expect(await ownerSql(target, "select count(*) from pg_tables where tablename = 'e2e_after_export'")).toBe('0');
	expect((await fetch(`${apiUrl}/v1/data/`, { headers: { 'Snout-Key': anon } })).status).toBe(200);
	await shot('settings');

	// Production: Stop asks first.
	await tab.locator('label.check', { hasText: 'Treat this as production' }).click();
	await expect(tab).toContainText('Marked production.');

	// Rotate the keys on the Dashboard: the old app key is refused, the new one works.
	await section('Overview');
	await tab.locator('button', { hasText: 'Rotate keys' }).click();
	await handle.page.locator('.modal button', { hasText: 'Rotate keys' }).click();
	await expect(tab).toContainText('New keys issued.', { timeout: 15 * 60 * 1000 });
	expect((await fetch(`${apiUrl}/v1/data/`, { headers: { 'Snout-Key': anon } })).status).toBe(401);
	expect((await fetch(`${apiUrl}/v1/data/`, { headers: { 'Snout-Key': envOf(target, 'ANON_KEY') } })).status).toBe(200);
	expect(roleOf(envOf(target, 'ANON_KEY'))).toBe('snout_app');
	expect(roleOf(envOf(target, 'SERVICE_ROLE_KEY'))).toBe('snout_server');

	await tab.locator('button', { hasText: 'Stop' }).first().click();
	await handle.page.locator('.modal button', { hasText: 'Stop it' }).click();
	await expect(tab).toContainText('is stopped', { timeout: 5 * 60 * 1000 });

	// Removing is in Settings, where the dashboard keeps Delete.
	await section('Settings');

	await tab.locator('button', { hasText: 'Remove project…' }).click();
	await tab.locator('label.check', { hasText: 'Also delete its data' }).click();
	await tab.locator('label.check', { hasText: 'And delete the folder' }).click();
	await tab.locator('button', { hasText: 'Remove and delete data' }).click();
	await expect(handle.page.locator('.cloud-project-view')).toHaveCount(0, { timeout: 5 * 60 * 1000 });
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

// A vendor's client (SAP's HANA client, IBM's Db2 driver) is fetched only after a person accepts
// that vendor's licence. Main refuses the download before it, whoever asks, and the prompt shows the
// licence and keeps Download off until it is accepted. Nothing here downloads: the HANA client is
// not installed in this repo, so connecting to HANA in a development build asks for it the way a
// user's first connect does, and the spec stops short of pressing Download.

interface Requirement {
	terms?: { id: string; vendor: string; url: string }[];
}
interface Api {
	componentsRequiredFor(driver: string): Promise<Requirement | null>;
	componentsInstallFor(driver: string): Promise<{ ok: boolean; error?: string }>;
	onComponentProgress(listener: (p: { phase: string }) => void): () => void;
	saveConnection(form: unknown): Promise<{ id: string }>;
}

let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('component-terms');
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('main refuses a vendor download before its licence is accepted, and fetches nothing', async () => {
	const seen = await handle.page.evaluate(async () => {
		const api = (window as unknown as { sqlApi: Api }).sqlApi;
		const phases: string[] = [];
		const off = api.onComponentProgress((p) => phases.push(p.phase));
		const requirement = await api.componentsRequiredFor('hana');
		const install = await api.componentsInstallFor('hana');
		off();
		return { terms: requirement?.terms?.map((t) => t.id) ?? [], install, phases };
	});
	expect(seen.terms).toEqual(['sap-hana-client']);
	expect(seen.install.ok).toBe(false);
	expect(seen.install.error).toMatch(/Nothing was downloaded: SAP's licence terms have not been accepted/);
	expect(seen.phases).toEqual([]);
});

test('the first HANA connect shows SAP\'s licence, and Download waits for "I accept"', async () => {
	const { page } = handle;
	await page.evaluate(async () => {
		const api = (window as unknown as { sqlApi: Api }).sqlApi;
		await api.saveConnection({ label: 'HANA terms', driver: 'hana', host: '127.0.0.1', port: 39015, username: 'x', ssl: false, readOnly: false });
	});
	const root = page.locator('.tree-row.depth-0', { hasText: 'HANA terms' });
	await expect(root).toBeVisible({ timeout: 30_000 });
	await root.locator('.twisty').click();

	const modal = page.locator('.modal').filter({ has: page.locator('[data-terms="sap-hana-client"]') });
	await expect(modal).toBeVisible({ timeout: 30_000 });
	await expect(modal.locator('a[href="https://tools.hana.ondemand.com/developer-license-3_2.txt"]')).toBeVisible();
	await expect(modal).toContainText('developer-license-3_2.txt');
	const download = modal.getByRole('button', { name: 'Download' });
	await expect(download).toBeDisabled();

	await modal.locator('label.check', { hasText: "I accept SAP's terms" }).click();
	await expect(download).toBeEnabled();
	await page.screenshot({ path: 'e2e/.artifacts/component-terms.png' });

	// Switching it off again takes the permission back, and closing the prompt accepts nothing.
	await modal.locator('label.check', { hasText: "I accept SAP's terms" }).click();
	await expect(download).toBeDisabled();
	await modal.getByRole('button', { name: 'Cancel' }).click();
	await expect(modal).toBeHidden();
	const terms = await page.evaluate(async () => {
		const api = (window as unknown as { sqlApi: Api }).sqlApi;
		return (await api.componentsRequiredFor('hana'))?.terms?.map((t) => t.id) ?? [];
	});
	expect(terms).toEqual(['sap-hana-client']);
});

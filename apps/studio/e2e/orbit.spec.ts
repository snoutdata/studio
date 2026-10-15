/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { addSqliteConnection, seedShopDb } from './sqliteShop';
import { closeApp, launchApp, MOD, type AppHandle } from './helpers';

/*
 * Snout Orbit: the database drawn as a 3D world.
 *
 * What this spec is for, and what it deliberately is not. It is NOT a pixel test — asserting what
 * a bloom pass produced would fail on every driver and tell us nothing. It asserts the things that
 * actually break: that the tab opens, that a WebGL context comes up inside the real packaged
 * renderer (the one thing no unit test can cover), that the rail's controls are wired to the scene
 * rather than to nothing, and that Pulse stays OFF until somebody asks for it.
 *
 * What the graph IS, where it settles and which tables a statement touched are pure and covered by
 * `src/shared/orbit.test.ts` and `orbitLayout.test.ts` in the unit tier, which is where a test of
 * that can be exhaustive and fast.
 */

let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('orbit');
});

test.afterAll(async () => {
	await closeApp(handle);
});

/** Open Orbit the way a user finds it. Idempotent, so each test can call it. */
async function openOrbit(): Promise<void> {
	if (await handle.page.locator('.orbit-view').isVisible()) {
		return;
	}
	await handle.page.keyboard.press(`${MOD}+Shift+P`);
	await expect(handle.page.locator('.palette')).toBeVisible();
	await handle.page.keyboard.type('Orbit');
	await handle.page.keyboard.press('Enter');
	await expect(handle.page.locator('.orbit-view')).toBeVisible();
}

/** Close Orbit the way a user does: its tab, from the tab strip. */
async function closeOrbitTab(): Promise<void> {
	await handle.page.locator('.tab-item', { hasText: 'Orbit' }).locator('.tab-close').click();
	await expect(handle.page.locator('.orbit-view')).toHaveCount(0);
}

test('opens from the command palette and brings up a WebGL context', async () => {
	await openOrbit();
	await expect(handle.page.locator('canvas.orbit-canvas')).toBeVisible();

	// The one thing only a real run can prove: three.js got a context out of this Electron build.
	// A renderer that silently falls back to nothing would still pass every other assertion here.
	const context = await handle.page.evaluate(() => {
		const canvas = document.querySelector('canvas.orbit-canvas') as HTMLCanvasElement | null;
		if (!canvas) {
			return 'no canvas';
		}
		// The scene already holds the context, so asking for the same type returns it rather than
		// allocating a second one.
		return canvas.getContext('webgl2') ? 'webgl2' : canvas.getContext('webgl') ? 'webgl' : 'none';
	});
	expect(context).not.toBe('none');
	expect(context).not.toBe('no canvas');
});

test('says there is nothing to map before a connection exists', async () => {
	await openOrbit();
	// A scratch profile has no connections, so Orbit has no schema. It must say why rather than
	// showing an empty void that reads as a broken canvas.
	await expect(handle.page.locator('.orbit-empty')).toBeVisible();
	await expect(handle.page.locator('.orbit-empty')).toContainText(/connect/i);
});

test('the controls live in the docked panel, and the canvas keeps the tab', async () => {
	await openOrbit();
	// The rail is PORTALLED into the Orbit tool window and drawn NOWHERE ELSE: the canvas wants
	// the whole tab, the knobs want to stay put.
	await expect(handle.page.locator('.orbit-rail-host .orbit-rail')).toBeVisible();
	// Exactly one rail in the document: it used to fall back to floating over the canvas, so
	// collapsing the panel left every slider sitting in the middle of the picture.
	await expect(handle.page.locator('.orbit-rail')).toHaveCount(1);
	// And the editor body is hidden, so Orbit is the tab rather than a strip under the results.
	await expect(handle.page.locator('.sql-body')).toBeHidden();
});

test('the activity bar opens Orbit', async () => {
	// Close it first so the icon has something to do. Orbit is closed from its tab, like every
	// other tab: the canvas carries no close button of its own.
	if (await handle.page.locator('.orbit-view').isVisible()) {
		await closeOrbitTab();
	}
	await handle.page.locator('.activity-item[aria-label="Orbit: this database in 3D"]').click();
	await expect(handle.page.locator('.orbit-view')).toBeVisible();
	await expect(handle.page.locator('.orbit-rail-host .orbit-rail')).toBeVisible();
});

test('the rail carries the light, matter and world controls', async () => {
	await openOrbit();
	const rail = handle.page.locator('.orbit-rail');
	for (const group of ['Light', 'Matter', 'Pulse', 'World']) {
		await expect(rail.getByText(group, { exact: true })).toBeVisible();
	}
	// The database picker is the rail's HEAD, above the cards, so it is not one of them.
	await expect(rail.locator('.orbit-conns .conn-picker-btn')).toBeVisible();
	// Four palettes, and Theme is the default: Orbit takes its colours from the app's own tokens
	// unless the user overrides it.
	await expect(rail.locator('.orbit-preset')).toHaveCount(4);
	await expect(rail.locator('.orbit-preset[aria-pressed="true"]')).toHaveText('Theme');
});

test('a palette preset takes effect', async () => {
	await openOrbit();
	const rail = handle.page.locator('.orbit-rail');
	await rail.locator('.orbit-preset', { hasText: 'Tron' }).click();
	await expect(rail.locator('.orbit-preset[aria-pressed="true"]')).toHaveText('Tron');
	await rail.locator('.orbit-preset', { hasText: 'Theme' }).click();
	await expect(rail.locator('.orbit-preset[aria-pressed="true"]')).toHaveText('Theme');
});

test('Pulse is off, and says why it cannot read this database', async () => {
	await openOrbit();
	const pulse = handle.page.locator('.orbit-toggle', { hasText: 'Live database activity' });
	// OFF by default and disabled with no connection: 3b runs a query against a database the user
	// may pay for by the read, so it never starts on its own.
	await expect(pulse).toHaveAttribute('aria-pressed', 'false');
	await expect(pulse).toBeDisabled();
	// Scoped to the Pulse group: the database picker writes a note of its own when there is
	// nothing to connect to, and `.orbit-note` is the shared class for both.
	const pulseNote = handle.page.locator('.orbit-group', { hasText: 'Pulse' }).locator('.orbit-note');
	await expect(pulseNote).toContainText(/what this app ran/i);
});

test('the rail names the database it drew, and the HUD waits for one', async () => {
	await openOrbit();
	// Which connection Orbit is on is the first thing in the rail, and it is the SAME control the
	// editor toolbar uses (`.conn-picker`) rather than one of Orbit's own.
	const picker = handle.page.locator('.orbit-conns');
	// It reads as the rail's HEAD, not as one of the setting cards: no box, no "Database" label
	// over it, the accent rule under it doing the separating.
	await expect(picker).not.toHaveClass(/orbit-group/);
	await expect(picker.locator('.orbit-eyebrow')).toHaveCount(0);
	const trigger = picker.locator('.conn-picker-btn');
	await expect(trigger).toBeVisible();
	await expect(trigger).toContainText('No connection');
	// A scratch profile has no connections, so the only option is the empty one.
	await trigger.click();
	await expect(handle.page.locator('.conn-picker-menu [role="option"]')).toHaveCount(1);
	await handle.page.keyboard.press('Escape');
	await expect(handle.page.locator('.conn-picker-menu')).toHaveCount(0);
	// The heads-up readout counts what was DRAWN, so it stays away until there is a world.
	await expect(handle.page.locator('.orbit-hud')).toHaveCount(0);
});

test('collapsing the panel takes the rail off the world rather than floating it', async () => {
	await openOrbit();
	await expect(handle.page.locator('.orbit-rail')).toHaveCount(1);
	await handle.page.locator('.orbit-panel .sidebar-header .icon-btn[aria-label="Collapse"]').click();
	// No rail ANYWHERE. It used to fall back to floating over the canvas when there was no panel
	// to portal into, so collapsing the controls left every slider in the middle of the picture.
	await expect(handle.page.locator('.orbit-rail')).toHaveCount(0);
	await expect(handle.page.locator('.orbit-view')).toBeVisible();
	// The activity bar puts it back, which is the only door there is now.
	await handle.page.locator('.activity-item[aria-label="Orbit: this database in 3D"]').click();
	await expect(handle.page.locator('.orbit-rail-host .orbit-rail')).toHaveCount(1);
});

test('showing the controls opens Orbit, rather than telling you to', async () => {
	// The panel holds nothing of its own, so a panel with no tab is a pane whose only content is
	// a sentence saying to go and open one — after you have just clicked the Orbit icon.
	await openOrbit();
	await closeOrbitTab();
	// Closing the tab takes the controls with it and hands the side bar back to the connections.
	await expect(handle.page.locator('.orbit-panel')).toHaveCount(0);
	await expect(handle.page.locator('.activity-item[aria-label="Connections"]')).toHaveClass(/active/);

	// Now show the panel WITHOUT going through the activity bar's own open: drag is the other way
	// a tool becomes the one its area shows, and it must not land on an empty pane either.
	await handle.page.evaluate(() => {
		const item = document.querySelector('.activity-item[aria-label="Orbit: this database in 3D"]') as HTMLElement;
		item.click();
	});
	await expect(handle.page.locator('.orbit-view')).toBeVisible();
	await expect(handle.page.locator('.orbit-rail-host .orbit-rail')).toHaveCount(1);
});

test('the Find box waits for a database', async () => {
	await openOrbit();
	// A search over nothing can only disappoint, so the group is not drawn until a schema is.
	// What it DOES with a name is pure and covered by `searchNodes` in the unit tier.
	await expect(handle.page.locator('.orbit-find')).toHaveCount(0);
});

test('closing Orbit leaves the workbench usable', async () => {
	await openOrbit();
	await closeOrbitTab();
	await expect(handle.page.locator('.orbit-view')).toHaveCount(0);
	// The editor is back and the app did not wedge on a disposed WebGL context.
	await expect(handle.page.locator('.tabbar')).toBeVisible();
});

test('a window with no WebGL says so in the tab, and the rest of the app keeps drawing', async () => {
	// No GPU and no software fallback (a virtual machine, a refused driver, hardware acceleration
	// off): three.js throws from its constructor, and uncaught that replaced the WHOLE window with
	// "The interface stopped drawing". Take the context away the way such a machine does, by
	// getContext answering null, and only for this one opening.
	await handle.page.evaluate(() => {
		const proto = HTMLCanvasElement.prototype as unknown as { getContext: (type: string, ...rest: unknown[]) => unknown; __realGetContext?: unknown };
		proto.__realGetContext = proto.getContext;
		const real = proto.getContext;
		proto.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
			return type.startsWith('webgl') ? null : real.call(this, type, ...rest);
		};
	});
	try {
		await openOrbit();
		await expect(handle.page.locator('.orbit-no-webgl')).toContainText('Orbit cannot draw here');
		await expect(handle.page.locator('.tabbar')).toBeVisible();
		await expect(handle.page.getByText('The interface stopped drawing')).toHaveCount(0);
	} finally {
		await handle.page.evaluate(() => {
			const proto = HTMLCanvasElement.prototype as unknown as { getContext: unknown; __realGetContext?: unknown };
			proto.getContext = proto.__realGetContext;
			delete proto.__realGetContext;
		});
	}
	await closeOrbitTab();
});

/* ---------------------------------------------------------------------------------------------
 * With a database actually drawn.
 *
 * Everything above runs on a scratch profile with no connection, which is most of Orbit's shell
 * but none of its world. A SQLite file is the cheapest real schema there is: three tables, real
 * foreign keys by name, through the real driver and the real introspection, so the graph under
 * these assertions is the one a user would see.
 *
 * These come LAST in the file on purpose. The tests above assert what Orbit says when there is no
 * connection, and a spec's tests share one app instance in file order.
 * ------------------------------------------------------------------------------------------ */

test.describe('with a database drawn', () => {
	test.beforeAll(async () => {
		const dir = mkdtempSync(join(tmpdir(), 'snout-orbit-'));
		await addSqliteConnection(handle.page, 'Orbit shop', seedShopDb(dir));
		// The IPC made and connected it; SELECTING it is what makes it the active connection, and
		// Orbit binds to whichever one that is when it opens.
		// The activity bar TOGGLES, so clicking it unconditionally is as likely to put the
		// connections away as to bring them out.
		const connections = handle.page.locator('.activity-item[aria-label="Connections"]');
		if (!(await connections.evaluate((el) => el.classList.contains('active')))) {
			await connections.click();
		}
		const root = handle.page.locator('.tree-row.depth-0', { hasText: 'Orbit shop' });
		await expect(root).toBeVisible({ timeout: 30_000 });
		await root.click();
		await openOrbit();
		// The world only exists once the schema has arrived and settled.
		await expect(handle.page.locator('.orbit-hud')).toBeVisible({ timeout: 30_000 });
	});

	// The rail's picker carries the editor toolbar's three connection states, and it had none of
	// them. A connection the user has not opened yet (every lazily-opened one, on every launch)
	// showed "(not connected)" in the combo with nothing anywhere to press, and an empty world
	// above it — the world being empty for the one reason the user could have fixed in a click.
	test('the rail offers Connect when the database it names is not open', async () => {
		const rail = handle.page.locator('.orbit-conns');
		// Connected: nothing to offer.
		await expect(rail.locator('.icon-btn[aria-label="Connect"]')).toHaveCount(0);

		// Disconnect from the tree. The rail and the connections tree are both tool windows in the
		// LEFT area, so showing one HIDES the other — the rail has to be brought back
		// before anything in it can be asserted, or the button is simply not on the page.
		await handle.page.locator('.activity-item[aria-label="Connections"]').click();
		await handle.page.locator('.tree-row.depth-0', { hasText: 'Orbit shop' }).hover();
		await handle.page.locator('.icon-btn[aria-label="Disconnect"]').first().click();
		await handle.page.locator('.activity-item[aria-label="Orbit: this database in 3D"]').click();
		await expect(rail).toBeVisible();

		// Still the selected database, now closed — and now there is a way back.
		const connect = rail.locator('.icon-btn[aria-label="Connect"]');
		await expect(connect).toBeVisible({ timeout: 15_000 });
		await connect.click();
		// It goes away by connecting, not by being clicked: the world comes back with it.
		await expect(connect).toHaveCount(0, { timeout: 30_000 });
		await expect(handle.page.locator('.orbit-hud')).toBeVisible({ timeout: 30_000 });
	});

	test('the Find box appears once there is a database, and matches a substring anywhere', async () => {
		const find = handle.page.locator('.orbit-find');
		await expect(find).toBeVisible();
		const hits = find.locator('.orbit-hit-name');
		// Nothing typed, no list: it is a combobox, and the matches only exist while it is open.
		await expect(find.locator('.orbit-find-pop')).toHaveCount(0);
		await expect(hits).toHaveCount(0);

		// The point of the feature. "or" is in the MIDDLE of `order_items` and at the start of
		// `orders`, and `customers` does not contain it at all.
		await find.locator('input').fill('or');
		await expect(hits).toHaveCount(2);
		// As a SET: which of two equally-connected tables sorts first is the ranking's business,
		// and `searchNodes` in the unit tier is where that is pinned.
		expect((await hits.allInnerTexts()).sort()).toEqual(['order_items', 'orders']);

		// And a match that is only ever in the middle: `customers` carries "us" at index one.
		await find.locator('input').fill('us');
		await expect(hits).toHaveText(['customers']);

		await find.locator('input').fill('nothing_like_this');
		await expect(hits).toHaveCount(0);
		await expect(find.locator('.orbit-find-empty')).toContainText(/no table or view/i);
	});

	test('picking a hit isolates it, and the inspector says so', async () => {
		const find = handle.page.locator('.orbit-find');
		await find.locator('input').fill('order_items');
		await find.locator('.orbit-find-pop button').first().click();
		// Picking one puts the list away: it has done its job, and the rail is a column of
		// controls rather than a place a list lives.
		await expect(find.locator('.orbit-find-pop')).toHaveCount(0);
		const inspector = handle.page.locator('.orbit-inspector');
		await expect(inspector.locator('h2')).toHaveText('order_items');
		await expect(inspector.locator('.orbit-hint')).toContainText(/isolated/i);
	});

	test('the keyboard drives the list, and escape closes it before it resets the world', async () => {
		const find = handle.page.locator('.orbit-find');
		const input = find.locator('input');
		await input.fill('or');
		await expect(find.locator('.orbit-find-pop')).toBeVisible();

		// Arrowing marks a row, and Enter takes it.
		await input.press('ArrowDown');
		await expect(find.locator('.orbit-find-pop button.chosen')).toHaveCount(1);
		await input.press('ArrowDown');
		const second = await find.locator('.orbit-find-pop button.chosen .orbit-hit-name').innerText();
		await input.press('Enter');
		await expect(handle.page.locator('.orbit-inspector h2')).toHaveText(second);
		await expect(find.locator('.orbit-find-pop')).toHaveCount(0);

		// Escape with the list up closes the LIST, and must not also reset the world: two
		// meanings for one key, and the press has to stop before the window handler sees it.
		// A DIFFERENT word, because re-typing the one that is already there fires no change.
		await input.fill('ord');
		await expect(find.locator('.orbit-find-pop')).toBeVisible();
		await input.press('Escape');
		await expect(find.locator('.orbit-find-pop')).toHaveCount(0);
		await expect(input).toHaveValue('ord');
		// A second press, with no list to close, is the reset.
		await input.press('Escape');
		await expect(input).toHaveValue('');
	});

	test('escape clears the search, the isolation and the camera', async () => {
		const find = handle.page.locator('.orbit-find');
		await find.locator('input').fill('orders');
		await find.locator('.orbit-find-pop button').first().click();
		await expect(handle.page.locator('.orbit-inspector h2')).toHaveText('orders');

		// The camera has flown somewhere by now. Escape has to bring it back, and a throw inside a
		// keydown handler is invisible from the DOM, so the console is watched across the press.
		const errors: string[] = [];
		const onError = (message: { type(): string; text(): string }): void => {
			if (message.type() === 'error') {
				errors.push(message.text());
			}
		};
		handle.page.on('console', onError);
		handle.page.on('pageerror', (error) => errors.push(String(error)));
		await handle.page.locator('canvas.orbit-canvas').click({ position: { x: 4, y: 4 } });
		await handle.page.keyboard.press('Escape');
		// Escape is RESET: the query goes, the hits go, and nothing is isolated any more.
		await expect(find.locator('input')).toHaveValue('');
		await expect(find.locator('.orbit-find-pop')).toHaveCount(0);
		await expect(handle.page.locator('.orbit-inspector')).toHaveCount(0);
		handle.page.off('console', onError);
		expect(errors).toEqual([]);
	});

	test('the legend says how the world is driven, and no longer advertises a hover', async () => {
		const legend = handle.page.locator('.orbit-legend');
		await expect(legend).toBeVisible();
		await expect(legend).toContainText('esc clear and recentre');
		// Hovering a filament still names its constraint; it is just not worth a line of the
		// legend, which is read once and then never again.
		await expect(legend).not.toContainText(/hover/i);
	});
});

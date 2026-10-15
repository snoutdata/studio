/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Menu, Tray, nativeImage, nativeTheme, type MenuItemConstructorOptions, type NativeImage } from 'electron';

import {
	TRAY_DOTS,
	TRAY_ICON_16,
	TRAY_ICON_32,
	TRAY_ICON_UPDATE_16,
	TRAY_ICON_UPDATE_32,
	TRAY_ICON_UPDATE_WHITE_32,
	TRAY_ICON_WHITE_32,
} from './trayIcon';
import type { ProjectTarget } from '../shared/projects';
import { trayModel, type TrayDot, type TrayInput, type TrayModel, type TrayProjectItem, type TrayProjectVerb } from './trayMenu';

// The app lives in the tray.
//
// The window's close button HIDES the window; the app keeps running behind the icon, which is what
// makes a scheduled flow a promise the app can keep - before this, closing the window ended every
// schedule, poller and background run, and the only way to keep them was to leave a window open.
// Quitting for real is a deliberate act from this menu (or the app menu / Ctrl+Q), never a side
// effect of closing a window.
//
// The menu is the app's face while there is no window, so it says what is happening rather than
// just offering a way back: a status line with a coloured dot, who is signed in, the scheduled
// flows, open connections and the Dashboard's projects with their state, the update the app is
// holding, and a pause for the schedules. The rules about WHAT it says live in trayMenu.ts, which is pure and tested; this file
// is the Electron half - the icon, the menu it is handed, and when to rebuild it.

/**
 * How often the menu is rebuilt while there is something in it.
 *
 * The labels go stale on their own - a flow due "in 12m" is due in 11 a minute later - so a timer
 * is needed on top of the event-driven refreshes. It is armed ONLY when the last rebuild found a
 * flow to list, so a user with no scheduled flows never pays for it, and it is unref'd: a menu
 * label must never be the reason the process stays up.
 */
const REFRESH_MS = 60_000;

/**
 * How often it is rebuilt while an update is downloading.
 *
 * A download's line says more about itself the longer it runs (see updateProgressDetail), in
 * twenty-second steps, and a minute is too coarse to read those. Armed only while a download is
 * actually in flight, so it is bounded by the download and costs nothing the rest of the time.
 */
const DOWNLOAD_REFRESH_MS = 10_000;

export interface TrayHost {
	/** Bring the window back, creating one if it is gone. */
	show(): void;
	/** The state the menu is drawn from, read fresh on every rebuild. */
	state(): TrayInput;
	/** Run one flow now, without opening the window. */
	runFlow(flowId: string): void;
	/** Connect or disconnect a connection, without opening the window. */
	setConnected(connectionId: string, connected: boolean): void;
	/** Pause or resume scheduled flows. */
	setSchedulesPaused(paused: boolean): void;
	/** Show the window on one project's tab, at Overview. */
	openProject(target: ProjectTarget, name: string): void;
	/** Start or stop a local project, or pause or resume a cloud one, without opening the window. */
	projectAction(target: ProjectTarget, verb: TrayProjectVerb): void;
	/** The menu was just closed. The projects in it are the Dashboard's LAST reading (a menu rebuild
	 *  never runs docker or calls the control plane), so this is when they are read again, ready for
	 *  the next time it is opened. */
	menuClosed(): void;
	/** Ask the pull-request reviewer to poll GitHub now rather than on its interval. */
	checkReviews(): void;
	/** Show the window and run the renderer command of this id (the same ids the palette uses). */
	open(commandId: string): void;
	/** Open one of the app's web pages in the browser. */
	openLink(link: 'docs' | 'site'): void;
	/** Drive the updater: check, download, or restart into the downloaded update. */
	update(action: 'check' | 'download' | 'install'): void;
	/** Quit for real. */
	quit(): void;
}

export class AppTray {
	private tray: Tray | undefined;
	private timer: NodeJS.Timeout | undefined;
	/** The interval the current timer runs at, so a rebuild that wants the same one leaves it alone. */
	private timerMs: number | null = null;
	private theme: (() => void) | undefined;

	constructor(private readonly host: TrayHost) {}

	/** Put the icon in the tray. Called after the window has painted, never on the boot path.
	 *
	 *  A desktop with no status-notifier host (some Linux sessions, a CI display) throws here, and
	 *  that must cost the user a tray icon and nothing else: the window still works, and the app
	 *  falls back to quitting on close when there is no tray to hide into (see `available`). */
	start(): void {
		if (this.tray) {
			return;
		}
		try {
			this.tray = new Tray(trayImage(false));
		} catch (err) {
			console.error(`[tray] could not create the tray icon: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this.tray.setToolTip("SnoutData Studio");
		// macOS opens the context menu on a plain click and has no double-click convention for a
		// status item, so the click handlers are for the other two platforms, where the icon is
		// expected to bring the window back.
		if (process.platform !== 'darwin') {
			this.tray.on('click', () => this.host.show());
			this.tray.on('double-click', () => this.host.show());
			// The glyph is one ink on transparency, so it has to be the opposite of the bar behind
			// it, and the user can change that bar while the app is running. macOS is not here
			// because its image is a template and the menu bar re-inks it without being asked.
			// It goes through refresh() rather than setImage() so the re-inked icon keeps whatever
			// badge it was wearing.
			this.theme = () => this.refresh();
			nativeTheme.on('updated', this.theme);
		}
		this.refresh();
	}

	/** Whether there is an icon to go back to. False when the platform refused one, which is what
	 *  decides whether closing the window may hide it. */
	available(): boolean {
		return this.tray !== undefined;
	}

	/** Rebuild the menu from what is true now. Cheap, and safe to call before start(). */
	refresh(): void {
		if (!this.tray) {
			return;
		}
		const state = this.host.state();
		const model = trayModel(state);
		// The icon is part of the rebuild, not something set once at start(): an update landing is
		// the one piece of state a user must be able to read WITHOUT opening the menu, which is the
		// whole reason the badged variant exists.
		this.tray.setImage(trayImage(model.update.pending));
		this.tray.setToolTip(model.tooltip);
		const menu = Menu.buildFromTemplate(this.template(model));
		menu.on('menu-will-close', () => this.host.menuClosed());
		this.tray.setContextMenu(menu);
		this.arm(state.update?.state === 'downloading' ? DOWNLOAD_REFRESH_MS : model.flows.length > 0 ? REFRESH_MS : null);
	}

	destroy(): void {
		this.arm(null);
		if (this.theme) {
			nativeTheme.off('updated', this.theme);
			this.theme = undefined;
		}
		this.tray?.destroy();
		this.tray = undefined;
	}

	private arm(intervalMs: number | null): void {
		if (intervalMs === this.timerMs) {
			return;
		}
		clearInterval(this.timer);
		this.timer = undefined;
		this.timerMs = intervalMs;
		if (intervalMs === null) {
			return;
		}
		this.timer = setInterval(() => this.refresh(), intervalMs);
		this.timer.unref();
	}

	private template(model: TrayModel): MenuItemConstructorOptions[] {
		return [
			// The status line, the way a background app introduces itself: what it is doing, in a
			// colour, before anything it can be asked to do. Inert on purpose - it is a readout.
			{ label: model.status.label, icon: dot(model.status.dot), enabled: false },
			// The pause sits in that same group, with no separator, because it is the switch for
			// what the line above just said: the readout and the one control that changes it read
			// as a pair. It used to live down by Quit, which is where you look to LEAVE, not where
			// you look to hold the schedules for a minute.
			...(model.schedules
				? [{
					label: model.schedules.label,
					icon: dot(model.schedules.paused ? 'idle' : 'ok'),
					click: () => this.host.setSchedulesPaused(!model.schedules?.paused),
				}]
				: []),
			{ type: 'separator' },
			{ label: "Open SnoutData Studio", click: () => this.host.show() },
			{ label: model.account.label, click: () => this.host.open('account') },
			{ type: 'separator' },
			// A build without Data Flows (the open tree) has no flows to list or make.
			...(model.flowsAvailable ? [{ label: "Data Flows", submenu: this.flowsMenu(model) }] : []),
			{ label: "Connections", submenu: this.connectionsMenu(model) },
			{ label: "Dashboard", submenu: this.projectsMenu(model) },
			// The reviewer joins its neighbours only once it exists: `model.review` is null until
			// the user has watched a repository, so nobody meets Snoutbot for the first time in a
			// context menu (trayMenu.ts, `reviewLine`).
			...(model.review
				? [{ label: model.review.label, icon: dot(model.review.dot), submenu: this.reviewMenu() }]
				: []),
			{ type: 'separator' },
			// No accelerator hints here: Settings and About have no shortcut in this app, and a menu
			// that showed one would be inventing it.
			{ label: "Settings…", click: () => this.host.open('settings') },
			{ label: "Documentation", click: () => this.host.openLink('docs') },
			{ label: "Website", click: () => this.host.openLink('site') },
			{ label: "About SnoutData Studio", click: () => this.host.open('about') },
			{ type: 'separator' },
			{
				label: model.update.label,
				icon: model.update.dot ? dot(model.update.dot) : undefined,
				enabled: model.update.action !== 'none',
				click: () => {
					if (model.update.action !== 'none') {
						this.host.update(model.update.action);
					}
				},
			},
			{ label: "Quit SnoutData Studio", click: () => this.host.quit() },
		];
	}

	private flowsMenu(model: TrayModel): MenuItemConstructorOptions[] {
		const items: MenuItemConstructorOptions[] = model.flows.map((flow) => ({
			label: flow.detail ? `${flow.name} (${flow.detail})` : flow.name,
			icon: dot(flow.dot),
			submenu: [
				{ label: "Run Now", enabled: !flow.running, click: () => this.host.runFlow(flow.id) },
				{ label: "Show in App", click: () => this.host.open('flowsPanel') },
			],
		}));
		if (model.flowsEmpty) {
			items.push({ label: model.flowsEmpty, enabled: false });
		}
		if (model.flowsOverflow > 0) {
			items.push({ label: `and ${model.flowsOverflow} more`, enabled: false });
		}
		items.push(
			{ type: 'separator' },
			{ label: "New Data Flow…", click: () => this.host.open('newFlow') },
			{ label: "Open Data Flows", click: () => this.host.open('flowsPanel') },
		);
		return items;
	}

	/** The reviewer's submenu. Deliberately three items and no list of reviews: what a review SAYS
	 *  is markdown, and markdown belongs in the app, not in a context menu the OS draws. */
	private reviewMenu(): MenuItemConstructorOptions[] {
		return [
			{ label: "Open Reviews", click: () => this.host.open('reviews') },
			{ label: "Check Now", click: () => this.host.checkReviews() },
			{ label: "Snoutbot Settings…", click: () => this.host.open('snoutbotSettings') },
		];
	}

	/** The Dashboard panel's projects, in its two groups. A group is headed only when it has
	 *  something in it, and both are headed when both do, since a local and a cloud project can
	 *  carry the same name. */
	private projectsMenu(model: TrayModel): MenuItemConstructorOptions[] {
		const items: MenuItemConstructorOptions[] = [];
		for (const [label, group] of [["Local", model.localProjects], ["Cloud", model.cloudProjects]] as const) {
			if (group.length > 0) {
				items.push({ label, enabled: false }, ...group.map((project) => this.projectItem(project)));
			}
		}
		if (model.projectsEmpty) {
			items.push({ label: model.projectsEmpty, enabled: false });
		}
		if (model.projectsOverflow > 0) {
			items.push({ label: `and ${model.projectsOverflow} more`, enabled: false });
		}
		items.push(
			{ type: 'separator' },
			{ label: "Set Up a Local Project…", click: () => this.host.open('localSetup') },
			{ label: "Open Dashboard", click: () => this.host.open('dashboardView') },
		);
		return items;
	}

	private projectItem(project: TrayProjectItem): MenuItemConstructorOptions {
		const target: ProjectTarget = project.kind === 'local' ? { kind: 'local', id: project.id } : { kind: 'cloud', ref: project.id };
		return {
			label: project.detail ? `${project.name} (${project.detail})` : project.name,
			icon: dot(project.dot),
			submenu: [
				...project.actions.map((action) => ({
					label: action.label,
					enabled: action.enabled,
					click: () => this.host.projectAction(target, action.verb),
				})),
				{ label: "Show in App", click: () => this.host.openProject(target, project.name) },
			],
		};
	}

	private connectionsMenu(model: TrayModel): MenuItemConstructorOptions[] {
		const items: MenuItemConstructorOptions[] = model.connections.map((connection) => ({
			label: connection.detail ? `${connection.label} (${connection.detail})` : connection.label,
			icon: dot(connection.dot),
			submenu: [
				{
					label: connection.connected ? "Disconnect" : "Connect",
					click: () => this.host.setConnected(connection.id, !connection.connected),
				},
				{ label: "Show in App", click: () => this.host.open('connectionsView') },
			],
		}));
		if (model.connectionsEmpty) {
			items.push({ label: model.connectionsEmpty, enabled: false });
		}
		if (model.connectionsOverflow > 0) {
			items.push({ label: `and ${model.connectionsOverflow} more`, enabled: false });
		}
		items.push(
			{ type: 'separator' },
			{ label: "New Connection…", click: () => this.host.open('addConn') },
			{ label: "Open Connections", click: () => this.host.open('connectionsView') },
		);
		return items;
	}
}

/** The status dots, decoded once each. A menu item's icon is an image, not a font, so this is how
 *  the app's one vocabulary of state reaches a menu the OS draws. */
const dots = new Map<TrayDot, NativeImage>();

function dot(name: TrayDot): NativeImage {
	const cached = dots.get(name);
	if (cached) {
		return cached;
	}
	const image = nativeImage.createFromBuffer(Buffer.from(TRAY_DOTS[name], 'base64'));
	dots.set(name, image);
	return image;
}

/** The icon, at the sizes and in the ink the platforms actually ask for.
 *
 *  The asset is a SILHOUETTE on transparency, not the app icon. Handing a tray the app icon is
 *  what used to happen, and it is why the menu bar showed a dark opaque tile: build/icon.png
 *  carries its own #21201d ground and its own app-icon margin, so there was nothing for the bar to
 *  composite against and the mark was a speck in the middle of it. See scripts/make-icons.mjs. */
function trayImage(badged: boolean): NativeImage {
	if (process.platform === 'darwin') {
		// The menu bar asks for a 16pt image and draws it at the screen's scale factor, so hand it
		// both representations rather than one that has to be stretched on a Retina display.
		const image = nativeImage.createEmpty();
		const small = badged ? TRAY_ICON_UPDATE_16 : TRAY_ICON_16;
		const large = badged ? TRAY_ICON_UPDATE_32 : TRAY_ICON_32;
		image.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: Buffer.from(small, 'base64') });
		image.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: Buffer.from(large, 'base64') });
		// A TEMPLATE image is drawn by the menu bar in its OWN ink: it reads the alpha and throws
		// the colour away. That is the only way one asset is right in light mode, in dark mode, and
		// inverted while the menu is open - which is exactly what the icons that look native up
		// there (Ollama's among them) are doing.
		image.setTemplateImage(true);
		return image;
	}
	// Windows and Linux have no template convention, so the ink is chosen here and the glyph is
	// whichever one the notification area is not.
	//
	// Read shouldUseDarkColorsForSystemIntegratedUI, NOT shouldUseDarkColors: this app drives
	// nativeTheme.themeSource to its own theme (index.ts, `app:setNativeTheme`, so the native
	// window chrome matches the theme picked in-app), which means shouldUseDarkColors answers "is
	// the APP dark" and would paint a Gold-themed app's glyph white on a light taskbar. The
	// system-integrated one is documented as the SYSTEM theme on Windows, which is the taskbar's.
	//
	// It is darwin/win32 only, so Linux falls through to the white glyph. That is a default, not a
	// reading: a Linux system tray is dark far more often than not, and there is no signal left to
	// read there that themeSource has not already polluted.
	const dark = process.platform === 'win32' ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI : true;
	// One image, at the larger size: the notification area scales it down to whatever it is using,
	// so a 200% display gets a real 32px glyph rather than a blown-up 16.
	const glyph = badged
		? (dark ? TRAY_ICON_UPDATE_WHITE_32 : TRAY_ICON_UPDATE_32)
		: (dark ? TRAY_ICON_WHITE_32 : TRAY_ICON_32);
	return nativeImage.createFromBuffer(Buffer.from(glyph, 'base64'));
}

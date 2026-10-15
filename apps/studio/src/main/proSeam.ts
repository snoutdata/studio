/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { BrowserWindow } from 'electron';
import type { AiService, LocalProseResolver } from './aiService';
import type { AiSettingsStore } from './aiSettingsStore';
import type { AuthStore } from './authStore';
import type { CloudService } from './cloud/cloudService';
import type { ComponentStore } from './componentStore';
import type { ConnectionManager } from './connectionManager';
import type { SecretStore } from './secretStore';
import type { TrayFlow } from './trayMenu';

/*---------------------------------------------------------------------------------------------
 *  The seam between Studio's main process and Data Flows' main half.
 *
 *  Data Flows is private: its stores, runner, scheduler, model runtime and IPC handlers are built
 *  by `registerMain` (`@snout/studio-pro/main`), which `index.ts` calls once with the shell services
 *  below and then talks to only through `ProMain`. A build without it (the open-source tree, or
 *  `SNOUT_PRO=0`) gets packages/studio-pro-stub, whose `ProMain` does nothing and registers no
 *  handlers. This file is the whole of what the two sides know about each other, so it is open.
 *--------------------------------------------------------------------------------------------*/

/** What the shell hands Data Flows. One instance of each, shared with the rest of the app. */
export interface ProMainHost {
	secretStore: SecretStore;
	componentStore: ComponentStore;
	connections: ConnectionManager;
	aiService: AiService;
	aiSettingsStore: AiSettingsStore;
	authStore: AuthStore;
	cloudService: CloudService;
	/** Send to every window. */
	broadcast(channel: string, ...args: unknown[]): void;
	/** The main window, when there is one. */
	mainWindow(): BrowserWindow | null;
	/** Run a palette command in the window (bringing it back first). */
	runCommandInWindow(id: string): void;
	/** Redraw the tray, whose menu shows scheduled and running flows. */
	refreshTray(): void;
	/** The user's saved network proxy, as a session config, for any window it opens on a session of
	 *  its own. */
	proxyConfig(): Electron.ProxyConfig;
	/** An e2e run under a scratch profile: the scheduler's test hooks are installed. */
	e2e: boolean;
}

/** Data Flows' share of what is running, for deciding when an update may install from the tray. */
export interface ProActivity {
	flowRuns: number;
	nextScheduledRunInMs: number | null;
	modelJobs: number;
}

/** Data Flows' part of the tray menu. */
export interface ProTrayFlows {
	/** True when Data Flows is in this build; the stub says false, and the tray then speaks of no
	 *  flows at all. */
	flowsAvailable: boolean;
	flows: TrayFlow[];
	running: ReadonlySet<string>;
	failed: ReadonlySet<string>;
	/** Whether the plan includes scheduled flows. */
	entitled: boolean;
}

/** What the shell may ask of Data Flows' main half. */
export interface ProMain {
	/** Register its IPC handlers. Called from `registerIpc`, beside the shell's own. */
	registerIpc(): void;
	/** After first paint: start the scheduler and close out runs a crash left running. */
	start(): void;
	/** The tray's Pause Scheduled Flows switch (which also pauses reviews, in the shell). */
	setSchedulesPaused(paused: boolean): void;
	/** The account's plan changed: a schedule may have stopped or started being allowed. */
	entitlementsChanged(): void;
	/** On quit: stop the model runtime, cancel runs and close the ledger. */
	shutdown(): void;
	backgroundActivity(schedulesPaused: boolean): ProActivity;
	trayFlows(): ProTrayFlows;
	/** Run one flow because the tray asked, with no window involved. */
	runFromTray(flowId: string): void;
	/** The reviewer's two LOCAL methods (the model on this computer, the user's own Ollama), which
	 *  are served by Data Flows' reader models. Absent in a build without it. */
	localProse?: LocalProseResolver;
	/** E2E hooks for the scheduler, merged into `globalThis.__snoutE2E`. Empty outside e2e. */
	e2eHooks: Record<string, unknown>;
}

export type RegisterMain = (host: ProMainHost) => ProMain;

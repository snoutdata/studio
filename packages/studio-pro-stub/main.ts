/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Data Flows' main half, as the open-source tree builds it: nothing. No stores, no scheduler, no
// model runtime and no IPC handlers, so a `flow:*` call from the renderer is simply not answered
// (the renderer's half shows a placeholder instead of the Flows panel). See README.md.

import type { ProMain, ProMainHost } from '@snout/studio/main/proSeam';

const NONE: ReadonlySet<string> = new Set();

export function registerMain(_host: ProMainHost): ProMain {
	return {
		registerIpc: () => {},
		start: () => {},
		setSchedulesPaused: () => {},
		entitlementsChanged: () => {},
		shutdown: () => {},
		backgroundActivity: () => ({ flowRuns: 0, nextScheduledRunInMs: null, modelJobs: 0 }),
		trayFlows: () => ({ flowsAvailable: false, flows: [], running: NONE, failed: NONE, entitled: false }),
		runFromTray: () => {},
		e2eHooks: {},
	};
}

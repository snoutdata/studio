/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FIRST import on purpose: startupPerf's module-eval timestamp is the origin every other startup
// mark is measured from, so anything imported ahead of it would be invisible to the budget.
import { mark } from './startupPerf';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/electron/renderer';
import { App } from './App';
import { CrashScreen } from './components/CrashScreen';
import { applyTheme, loadTheme } from './theme';
import { IGNORED_ERROR_MESSAGES, SENTRY_DSN } from '../../shared/telemetry';
import '@vscode/codicons/dist/codicon.css';
// The agent console's terminal. xterm ships its own reset for cell metrics and the scrollbar;
// the PALETTE is ours, built from the theme tokens in the panel.
import '@xterm/xterm/css/xterm.css';
import './styles.css';
// Data Flows' rules, after the shell's (an empty file in a build without Data Flows).
import '@snout/studio-pro/styles';

// Apply the saved theme before first paint (also sets Monaco's global theme).
applyTheme(loadTheme());

// Crash/error reporting for the renderer. The renderer SDK forwards to the main process'
// transport (and its scrubbing) over the `sentry-ipc://` protocol that the main SDK registers at
// startup. We gate on `active` (main actually initialized) rather than `available` (a DSN merely
// ships): in a dev run main no-ops, so initializing here would route to an unregistered protocol
// and throw "scheme not supported". Init is fire-and-forget so it never delays first paint.
if (SENTRY_DSN) {
	void window.sqlApi.getTelemetry().then(({ active }) => {
		if (active) {
			// Filter here rather than in main's beforeSend: these are renderer-origin unhandled
			// rejections, so dropping them at the source keeps them off the IPC hop entirely.
			Sentry.init({ ignoreErrors: [...IGNORED_ERROR_MESSAGES] });
		}
	});
}

const container = document.getElementById('root');
if (!container) {
	throw new Error('root element not found');
}
mark('render');
createRoot(container).render(
	<StrictMode>
		<CrashScreen>
			<App />
		</CrashScreen>
	</StrictMode>,
);

// Double rAF lands after the browser has actually painted the first frame, which is the number a
// user experiences as "the app started". Reported by `__snoutStartup()`; budgeted in e2e/startup.spec.ts.
requestAnimationFrame(() => requestAnimationFrame(() => mark('paint')));

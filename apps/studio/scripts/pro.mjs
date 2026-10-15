/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which Data Flows this build compiles in. This tree does not carry Data Flows, so it is always
// packages/studio-pro-stub (same exports, inert): where Data Flows would be, the app shows a short
// note and a link to the official build. Read by electron.vite.config.ts and esbuild.server.mjs.
import { resolve } from 'node:path';

export function proPaths(appDir) {
	const stub = resolve(appDir, '../../packages/studio-pro-stub');
	const renderer = (file) => resolve(stub, 'renderer', file);
	return {
		real: false,
		main: resolve(stub, 'main.ts'),
		// The renderer half: a light entry plus the code-split views (renderer/src/proSeam.ts).
		renderer: {
			index: renderer('index.tsx'),
			wizard: renderer('FlowWizardView.tsx'),
			vectorSearch: renderer('VectorSearchView.tsx'),
			settings: renderer('settings.tsx'),
			capabilities: renderer('capabilities.ts'),
			styles: renderer('styles.css'),
		},
		// What `@snout/studio/*` names: this app's source, for the stub to import the seam types and
		// the shell's modules from.
		app: resolve(appDir, 'src'),
	};
}

/** The main-process aliases: Data Flows' main half and the app it plugs into. */
export function proMainAliases(paths) {
	return {
		'@snout/studio-pro/main': paths.main,
		'@snout/studio': paths.app,
	};
}

/** The renderer's aliases: Data Flows' renderer entries (most specific first). */
export function proRendererAliases(paths) {
	return {
		'@snout/studio-pro/wizard': paths.renderer.wizard,
		'@snout/studio-pro/vector-search': paths.renderer.vectorSearch,
		'@snout/studio-pro/settings': paths.renderer.settings,
		'@snout/studio-pro/capabilities': paths.renderer.capabilities,
		'@snout/studio-pro/styles': paths.renderer.styles,
		'@snout/studio-pro/renderer': paths.renderer.index,
	};
}

/**
 * Constants only the official build compiles in (`define`). A build from this tree has none: it is
 * not the official build (src/shared/officialBuild.ts: no install heartbeat, no updates from the
 * official feed), crash reporting is dormant (src/shared/telemetry.ts), and the knowledge observer
 * and the dev benchmark use the model the settings name.
 */
export function proDefines() {
	return {
		__SNOUT_OFFICIAL_BUILD__: JSON.stringify(false),
		__SNOUT_SENTRY_DSN__: JSON.stringify(''),
		__SNOUT_OBSERVER_MODEL__: JSON.stringify(''),
		// A JSON string the app parses, so the define stays a plain string literal for every bundler.
		__SNOUT_BENCHMARK_MODELS__: JSON.stringify(JSON.stringify([])),
	};
}

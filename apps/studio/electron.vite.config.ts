/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { rendererCsp } from './src/shared/rendererCsp';
import { libyAliases, libyNameAlias, libyPaths } from './scripts/liby.mjs';
import { proDefines, proMainAliases, proPaths, proRendererAliases } from './scripts/pro.mjs';

// The PR reviewer's rule set lives in `packages/review-core`: a dependency-free rule set with no
// I/O that any host can run (this app is the one that does today), so it deliberately is NOT part
// of this app's src tree. It is
// aliased to its BUILT output rather than installed: no npm workspace, no `file:` symlink for
// electron-builder to trip over, and vite bundles it straight into out/main. `npm run review:build`
// produces it and every build/dev/test script here runs that first.
const REVIEW_CORE = resolve(__dirname, '../../packages/review-core/dist/index.js');
// Moving a database: shared with the `snoutdata` CLI, wired the same way.
const MOVE = resolve(__dirname, '../../packages/move/dist/index.js');
// Its Node half (spawning pg_dump/pg_restore), for main only: a renderer must never reach it.
const MOVE_RUNNER = resolve(__dirname, '../../packages/move/dist/runner/index.js');
// `@snoutdata/client` (packages/client), wired the same way: built from this monorepo's source by
// `npm run client:build`, never taken from npm, so the app always carries the client as it is
// here. It is ESM with no dependencies and is bundled into main, so nothing about loading it
// depends on Electron's require(esm). (It is built rather than aliased to its source because main's
// tsconfig has no DOM lib and the client's source uses DOM names; its .d.ts is what tsc reads.)
const CLIENT = resolve(__dirname, '../../packages/client/dist/index.js');
// Liby (her own package): shared with the website, the dashboard and the docs. Unlike
// the two above it is React + three.js SOURCE, compiled by whoever imports it, so it is aliased to
// its source, its react and three are deduped to THIS app's copies (one React, one three), and the
// dev server is allowed to serve its folder. She is private: a tree without her package (or
// `SNOUT_PRO=0`) compiles packages/liby-stub instead (scripts/liby.mjs).
const LIBY_PATHS = libyPaths(__dirname);
const LIBY_ALIASES = libyAliases(LIBY_PATHS);
// Data Flows, the same way (scripts/pro.mjs): private, with a stub for a tree without it.
const PRO_PATHS = proPaths(__dirname);
// Constants only the official build carries (the Sentry DSN): empty in a build without Data Flows.
const PRO_DEFINES = proDefines(PRO_PATHS, __dirname);

/**
 * Write the renderer's Content-Security-Policy into index.html as the first thing in <head>
 * (src/shared/rendererCsp.ts says what it allows and why). A dev run gets the dev variant, which
 * also lets Vite's inline React-refresh preamble and its HMR socket through.
 */
function contentSecurityPolicy(): Plugin {
	let dev = false;
	return {
		name: 'snout-renderer-csp',
		configResolved(config) {
			dev = config.command === 'serve';
		},
		transformIndexHtml() {
			return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: rendererCsp(dev) }, injectTo: 'head-prepend' }];
		},
	};
}

// Three build targets: the Electron main process, the preload bridge, and the
// React renderer. The ported SQL language server is NOT built here — it is bundled
// separately by esbuild (see esbuild.server.mjs) so it keeps mysql2/pg/ssh2 as
// runtime externals exactly as it did inside the original VSCode extension.
export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		resolve: { alias: { '@snoutdata/client': CLIENT, '@snout/review-core': REVIEW_CORE, '@snout/move': MOVE, '@snout/move-runner': MOVE_RUNNER, ...libyNameAlias(LIBY_PATHS), ...proMainAliases(PRO_PATHS) } },
		define: PRO_DEFINES,
		build: {
			rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') },
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') },
		},
	},
	renderer: {
		root: resolve(__dirname, 'src/renderer'),
		plugins: [react(), contentSecurityPolicy()],
		define: PRO_DEFINES,
		resolve: {
			alias: { '@snout/review-core': REVIEW_CORE, '@snout/move': MOVE, ...proRendererAliases(PRO_PATHS), ...LIBY_ALIASES },
			dedupe: ['react', 'react-dom', 'three'],
		},
		server: { fs: { allow: [__dirname, LIBY_PATHS.dir] } },
		build: {
			/*
			 * MINIFY THE RENDERER. electron-vite defaults `build.minify` to false, which is easy to
			 * miss because the build is otherwise a normal production build — so every shipped
			 * version until now loaded a fully formatted, commented renderer bundle: ~274,000 lines
			 * averaging 46 characters. It was by far the largest single cost in the app's launch,
			 * and no feature put it there.
			 *
			 * Main and preload are deliberately NOT minified. Main's whole module graph evaluates in
			 * ~2ms (measured, e2e/startup.spec.ts), so there is nothing to win there, while readable
			 * frames in a crash report are worth keeping.
			 *
			 * `sourcemap: 'hidden'` emits maps WITHOUT a sourceMappingURL comment: nothing fetches
			 * them at runtime, so they cost the user nothing, but they exist to be uploaded to
			 * Sentry. Until such an upload is wired up, renderer stack traces in Sentry are
			 * minified — they were readable before this only as a side effect of shipping
			 * unminified code. Excluded from the package in electron-builder.yml.
			 */
			minify: 'esbuild',
			sourcemap: 'hidden',
			// Every image is inlined as a data: URL, whatever its size: the packaged page's CSP allows
			// no file: images at all (src/shared/rendererCsp.ts says why), so an image emitted as a
			// file beside the bundle would not show. Fonts and everything else stay files.
			assetsInlineLimit: (filePath) => (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i.test(filePath) ? true : undefined),
			rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
		},
	},
});

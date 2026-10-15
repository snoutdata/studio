/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Bundles the ported SQL language server with esbuild, mirroring how the original VSCode extension
// built it: shared/ contracts inline into the bundle, and mysql2/pg/ssh2 stay
// external (dynamic requires resolved from node_modules at runtime). The output sits
// in out/server/ alongside electron-vite's out/main and out/preload.
import esbuild from 'esbuild';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { libyAliases, libyNameAlias, libyPaths } from './scripts/liby.mjs';
import { proDefines, proMainAliases, proPaths, proRendererAliases } from './scripts/pro.mjs';

// See electron.vite.config.ts: the reviewer's rule set is aliased to its built output rather
// than installed, so the test bundles resolve it the same way the app does.
const REVIEW_CORE = resolve(process.cwd(), '../../packages/review-core/dist/index.js');
const MOVE = resolve(process.cwd(), '../../packages/move/dist/index.js');
const MOVE_RUNNER = resolve(process.cwd(), '../../packages/move/dist/runner/index.js');
// `@snoutdata/client`, built from packages/client the same way (`npm run client:build`).
const CLIENT = resolve(process.cwd(), '../../packages/client/dist/index.js');
// Liby (her own package): TypeScript source, not a build. Only the test bundles reach it. Private: a
// tree without her compiles packages/liby-stub, and has none of her tests (scripts/liby.mjs).
const LIBY_PATHS = libyPaths(process.cwd());
const PRO_PATHS = proPaths(process.cwd());

const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

/** Recursively collect `*.test.ts` files under `dir`. */
function findTests(dir) {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			return findTests(full);
		}
		return name.endsWith('.test.ts') ? [full] : [];
	});
}

const common = {
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'cjs',
	sourcemap: true,
	logLevel: 'info',
	// mysql2/pg/ssh2/mssql/oracledb/ibm_db use dynamic requires and native bits; keep them external
	// and resolve them from node_modules at runtime rather than bundling. mongodb (pure JS, but
	// large with optional peer deps it requires lazily) is external too. snowflake-sdk is external +
	// dynamically required (a devDependency in dev, the on-demand component dir when packaged) so its
	// ~95 MB dependency tree never lands in the bundle or the installer. @duckdb/node-api and
	// @sap/hana-client are the same deal with a native (but ABI-stable N-API) payload.
	// `electron` is provided by the runtime, never bundled. The real main process gets it from
	// electron-vite; the test bundles (run under stock `node --test`) leave it as a runtime require
	// that resolves to the path stub, so `net` is undefined there and netFetch falls back to global
	// fetch. The server bundle never imports it.
	// The cloud SDKs the TELEMETRY drivers use are external for the same reason mongodb is, and it
	// is measured rather than assumed: bundling them took this file from 4.9 MB to 8.2 MB, because
	// a static `require()` of a bare specifier is resolved and inlined by esbuild however lazily it
	// is written. External, the drivers still require them lazily at runtime out of node_modules
	// (pure JS, so they resolve through the asar), and a user who never opens a CloudWatch
	// connection never loads a byte of them.
	external: ['mysql2', 'pg', 'ssh2', 'mssql', 'oracledb', 'ibm_db', 'mongodb', 'snowflake-sdk', '@duckdb/node-api', '@sap/hana-client', 'electron',
		'@aws-sdk/client-cloudwatch-logs', '@aws-sdk/credential-providers', '@azure/identity', 'google-auth-library'],
	alias: { '@snoutdata/client': CLIENT, '@snout/review-core': REVIEW_CORE, '@snout/move': MOVE, '@snout/move-runner': MOVE_RUNNER, ...libyNameAlias(LIBY_PATHS), ...proMainAliases(PRO_PATHS) },
	define: proDefines(PRO_PATHS, process.cwd()),
};

const serverTarget = {
	...common,
	entryPoints: ['src/server/src/server.ts'],
	outfile: 'out/server/server.js',
};

// The Db2 sidecar is a SEPARATE program: it runs under stock Node (not Electron), because ibm_db's
// native binary cannot load/recompile against Electron's ABI. The server child spawns it and proxies
// over stdio (see db2Sidecar.ts). ibm_db stays external; the parent passes its absolute path in.
const db2SidecarTarget = {
	...common,
	entryPoints: ['src/server/src/drivers/db2/db2SidecarEntry.ts'],
	outfile: 'out/server/db2-sidecar.cjs',
};

// The staged-update swap waiter: the app copies this ONE file out of the asar and runs it as
// SnoutData.exe in Node mode, so it must import nothing but Node built-ins.
// Built here rather than by electron-vite because the main build would share chunks with index.js.
const swapWaiterTarget = {
	...common,
	sourcemap: false,
	entryPoints: ['src/main/swapWaiterEntry.ts'],
	outfile: 'out/server/swap-waiter.cjs',
};

if (tests) {
	// Scan all source roots for *.test.ts (engine analyzer/schema, plus the app's
	// pure logic and the env-gated integration test). outbase 'src' mirrors the tree
	// under out/tests so `node --test "out/tests/**/*.test.js"` finds them all.
	// Start from an empty out/tests. esbuild only ever adds files, so a test whose source was
	// deleted or renamed kept its old bundle here, and `node --test "out/tests/**/*.test.js"` went
	// on running it (and failing, when it read its own source at runtime). Nothing else writes here.
	rmSync('out/tests', { recursive: true, force: true });
	const roots = ['src/server/src', 'src/main', 'src/renderer/src', 'src/shared'];
	const entryPoints = roots.flatMap((dir) => findTests(dir));
	// @snout/liby is source living outside this app: alias it, resolve its react from HERE, drop its
	// CSS, and keep three external (only her lazily loaded 3D chunk imports it, and no test loads it).
	const liby = {
		alias: { ...common.alias, ...proRendererAliases(PRO_PATHS), ...libyAliases(LIBY_PATHS) },
		nodePaths: [resolve(process.cwd(), 'node_modules')],
		loader: { '.css': 'empty' },
		external: [...common.external, 'three', 'three/*'],
	};
	await esbuild.build({ ...common, ...liby, sourcemap: false, entryPoints, outdir: 'out/tests', outbase: 'src' });
	// The package's own tests (hers, and her Studio half), under out/tests too, so
	// `node --test "out/tests/**/*.test.js"` runs them. The stub has none.
	const libyTests = LIBY_PATHS.real ? [...findTests(LIBY_PATHS.src), ...findTests(LIBY_PATHS.studioDir)] : [];
	if (libyTests.length > 0) {
		await esbuild.build({ ...common, ...liby, sourcemap: false, entryPoints: libyTests, outdir: 'out/tests/companion', outbase: LIBY_PATHS.dir });
	}
	console.log(`built ${entryPoints.length + libyTests.length} test bundle(s) → out/tests (${libyTests.length} from the companion's package)`);
} else if (watch) {
	const serverCtx = await esbuild.context(serverTarget);
	const sidecarCtx = await esbuild.context(db2SidecarTarget);
	const waiterCtx = await esbuild.context(swapWaiterTarget);
	await Promise.all([serverCtx.watch(), sidecarCtx.watch(), waiterCtx.watch()]);
	console.log('esbuild watching server + db2 sidecar…');
} else {
	await Promise.all([esbuild.build(serverTarget), esbuild.build(db2SidecarTarget), esbuild.build(swapWaiterTarget)]);
	console.log('server build complete → out/server/server.js (+ db2-sidecar.cjs, swap-waiter.cjs)');
}

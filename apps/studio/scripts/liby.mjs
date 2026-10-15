/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which companion this build compiles in. This tree does not carry her, so it is always
// packages/liby-stub (same exports, inert): the assistant is called "AI", and help opens the
// assistant. Read by electron.vite.config.ts and esbuild.server.mjs; tsconfig.web.json lists the
// stub in `paths`.
import { resolve } from 'node:path';

export function libyPaths(appDir) {
	const dir = resolve(appDir, '../../packages/liby-stub');
	return {
		real: false,
		dir,
		src: resolve(dir, 'src'),
		index: resolve(dir, 'src/index.ts'),
		studio: resolve(dir, 'studio/index.ts'),
		// The assistant's name and identity: pure constants, the one part every process imports.
		name: resolve(dir, 'studio/name.ts'),
		// Only the companion's own landing rule imports this, so the stub has none.
		landing: undefined,
		studioDir: resolve(dir, 'studio'),
		// What `@snout/studio/*` names: this app's source.
		app: resolve(appDir, 'src'),
	};
}

/** The resolver aliases, most specific first (a prefix alias would otherwise swallow the subpath
 *  entries). */
export function libyAliases(paths) {
	return {
		...libyNameAlias(paths),
		'@snout/liby/studio': paths.studio,
		'@snout/liby': paths.index,
		'@snout/studio': paths.app,
	};
}

/** The one alias main and the server child get: the assistant's name (`shared/assistant.ts`). */
export function libyNameAlias(paths) {
	return { '@snout/liby/name': paths.name };
}

/** A string only the companion's compiled code carries (scripts/assert-build.mjs). None here: no
 *  build from this tree can carry her. */
export function libyBuildMarker() {
	return null;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface LibyPaths {
	real: boolean;
	dir: string;
	src: string;
	index: string;
	studio: string;
	name: string;
	landing: string | undefined;
	studioDir: string;
	app: string;
}
export function libyPaths(appDir: string): LibyPaths;
export function libyAliases(paths: LibyPaths): Record<string, string>;
export function libyNameAlias(paths: LibyPaths): Record<string, string>;
export function libyBuildMarker(appDir: string): string | null;

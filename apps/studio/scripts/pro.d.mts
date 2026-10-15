/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ProPaths {
	real: boolean;
	main: string;
	renderer: { index: string; wizard: string; vectorSearch: string; settings: string; capabilities: string; styles: string };
	app: string;
}
export function proPaths(appDir: string): ProPaths;
export function proMainAliases(paths: ProPaths): Record<string, string>;
export function proRendererAliases(paths: ProPaths): Record<string, string>;
export function proDefines(paths: ProPaths, appDir: string): Record<string, string>;

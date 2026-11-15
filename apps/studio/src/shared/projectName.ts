/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a Cloud project may be called: letters, digits, hyphens and underscores, starting with a
 * letter or digit, at most 60 characters. No spaces and no other characters, so a name reads the
 * same in a URL, a shell, a file name and a log line.
 *
 * SnoutData Cloud holds every client to the same rule and is the one that decides; this copy
 * only shows it while a name is typed, so the two change together.
 */
export const PROJECT_NAME_MAX = 60;

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Whether `name` (already trimmed) is a name the control plane accepts. */
export function isProjectName(name: string): boolean {
	return name.length <= PROJECT_NAME_MAX && PROJECT_NAME.test(name);
}

/** The nearest acceptable name to `name`, for a field that starts from an existing one: '' when nothing is left. */
export function asProjectName(name: string): string {
	return name
		.trim()
		.replace(/[^A-Za-z0-9_-]+/g, '-')
		.replace(/^[-_]+/, '')
		.slice(0, PROJECT_NAME_MAX)
		.replace(/-+$/, '');
}

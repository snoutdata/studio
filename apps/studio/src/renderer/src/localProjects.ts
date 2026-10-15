/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LocalProjectRow } from '../../shared/localStack';

// How a local project's state is drawn, shared by the Projects panel and the project tab so the
// dot and the words agree.

/** The dot beside a local project. A stopped one is not unhealthy. */
export function localTone(state: LocalProjectRow['state']): string {
	switch (state) {
		case 'running': return 'ok';
		case 'starting': return 'warn';
		case 'partial':
		case 'missing': return 'error';
		default: return 'dim';
	}
}

/** A local state in words, for the dot's title and the Overview line. */
export function localStateLabel(state: LocalProjectRow['state']): string {
	switch (state) {
		case 'running': return "running";
		case 'starting': return "starting";
		case 'partial': return "some services are down";
		case 'missing': return "its folder is gone";
		case 'unknown': return "Docker is not running";
		default: return "stopped";
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Data Flows' renderer half, as the open-source tree builds it: the Flows side view says where the
// feature is, and nothing else of it exists (no status-bar reading, no run notices, nothing to
// import). Same seam as the real one (`@snout/studio/renderer/src/proSeam`). See ../README.md.

import { Icon } from '@snout/studio/renderer/src/components/Icon';
import type { ProFlowsPanelProps, ProImportHost, ProStatusItemsProps } from '@snout/studio/renderer/src/proSeam';
import { DataFlowsPlaceholder } from './Placeholder';

/** False: this build has no Data Flows. */
export const PRO_AVAILABLE = false;

export function FlowsPanel(props: ProFlowsPanelProps): JSX.Element {
	return (
		<div className="sidebar">
			<div className="sidebar-header">
				<span>DATA FLOWS</span>
				<span className="spacer" />
				<button className="icon-btn" aria-label="Collapse" onClick={props.onCollapse}><Icon name="chevron-left" /></button>
			</div>
			<DataFlowsPlaceholder />
		</div>
	);
}

export function ProStatusItems(_props: ProStatusItemsProps): null {
	return null;
}

export function useFlowRunNotices(): void {}

export function useReviewCount(_rev: number): number {
	return 0;
}

export async function importFlowFromFile(_host: ProImportHost): Promise<void> {}

/** No release notes: they describe the official build, which this tree is not. */
export const RELEASE_NOTES = '';

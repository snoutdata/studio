/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The flow wizard tab, as the open-source tree builds it: the placeholder (a dropped data file opens
// this tab too). See ../README.md.

import type { ProFlowWizardProps } from '@snout/studio/renderer/src/proSeam';
import { DataFlowsPlaceholder } from './Placeholder';

export function FlowWizardView(_props: ProFlowWizardProps): JSX.Element {
	return <DataFlowsPlaceholder />;
}

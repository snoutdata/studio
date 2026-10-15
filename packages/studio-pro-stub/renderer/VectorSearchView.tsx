/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Searching a vector flow, as the open-source tree builds it: nothing can open it, but the app's
// tab code names it. See ../README.md.

import type { ProVectorSearchProps } from '@snout/studio/renderer/src/proSeam';
import { DataFlowsPlaceholder } from './Placeholder';

export function VectorSearchView(_props: ProVectorSearchProps): JSX.Element {
	return <DataFlowsPlaceholder />;
}

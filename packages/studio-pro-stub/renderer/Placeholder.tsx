/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a build from the open-source tree shows where Data Flows would be: the feature exists, and
// this is where it is. The house empty state (a drawing, one sentence, one way forward), so it reads
// as part of the app rather than as something broken.

import { GenerateArt } from '@snout/studio/renderer/src/art/Illustrations';

const DOWNLOAD = 'https://snoutdata.com/download';

export function DataFlowsPlaceholder(): JSX.Element {
	return (
		<div className="queries-empty" data-test="pro-placeholder">
			<GenerateArt className="queries-empty-art" />
			<p>Data Flows ships in the official SnoutData Studio build: read files, documents, web pages and cloud logs into your databases.</p>
			<p>
				<button type="button" className="link-btn" onClick={() => void window.sqlApi.openExternal(DOWNLOAD)}>Download SnoutData Studio</button>
			</p>
		</div>
	);
}

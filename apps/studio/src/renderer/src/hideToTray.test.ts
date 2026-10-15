/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hideToTrayDetail } from './hideToTray';

test('the hide-to-tray notice promises scheduled flows only in a build that has them', () => {
	assert.match(hideToTrayDetail({ mac: false, flows: true }), /in the tray, so scheduled flows and anything already running carry on\./);
	const open = hideToTrayDetail({ mac: true, flows: false });
	assert.match(open, /in the menu bar, so anything already running carries on\./);
	assert.doesNotMatch(open, /flow/i);
});

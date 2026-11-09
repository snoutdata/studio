/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { t } from '../../shared/i18n/core';

/**
 * What the hide-to-tray notice says (components/HideToTrayNotice.tsx). Pure, so a test can hold
 * the one thing that differs by build: a build without Data Flows (the open tree) has no
 * scheduled flows to keep running, so it does not promise any.
 */
export function hideToTrayDetail(o: { mac: boolean; flows: boolean }): string {
	// Four whole sentences: "the menu bar" / "the tray" change the words around them in every language.
	if (o.mac) {
		return o.flows ? t('shell.hideToTray.macFlows') : t('shell.hideToTray.mac');
	}
	return o.flows ? t('shell.hideToTray.trayFlows') : t('shell.hideToTray.tray');
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { JSX, ReactNode } from 'react';

/**
 * A settings page's opening prose with its drawing beside it, on the card the Extraction Model's hero
 * set (`.learn-hero`). The drawing drops under the prose on a narrow window rather than squeezing it.
 * `art` is a drawing from art/Illustrations.tsx; it is given `settings-intro-art` here.
 */
export function SettingsIntro({ art: Art, children }: { art: (props: { className?: string }) => JSX.Element; children: ReactNode }): JSX.Element {
	return (
		<div className="settings-intro">
			<div className="settings-intro-text">{children}</div>
			<Art className="settings-intro-art" />
		</div>
	);
}

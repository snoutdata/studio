/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hideToTrayDetail } from '../hideToTray';
import { Icon } from './Icon';

interface HideToTrayNoticeProps {
	/** Whether this build has Data Flows, whose schedules are what keeps running. */
	flows: boolean;
	onHide(): void;
	onQuit(): void;
}

/**
 * Said once, the first time the window is closed: the app did not close, it moved to the tray.
 *
 * It has to be said BEFORE the window goes, which is why this is a dialog in the app rather than
 * an OS notification after the fact: a window that vanishes from the taskbar with no explanation
 * reads as an app that quit, and the next thing the user does is launch it again.
 */
export function HideToTrayNotice(props: HideToTrayNoticeProps): JSX.Element {
	const mac = /mac/i.test(navigator.platform || navigator.userAgent);
	return (
		<div className="modal-backdrop" onClick={props.onHide}>
			<div className="modal confirm" onClick={(e) => e.stopPropagation()}>
				<h2>
					<Icon name="pulse" />
					SnoutData Studio keeps running
				</h2>
				<p className="confirm-detail">{hideToTrayDetail({ mac, flows: props.flows })}</p>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={props.onQuit}>Quit Instead</button>
					<button type="button" onClick={props.onHide} autoFocus>Got It</button>
				</div>
			</div>
		</div>
	);
}

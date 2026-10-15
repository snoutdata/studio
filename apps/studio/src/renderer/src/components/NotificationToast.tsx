/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../../shared/assistant';
import { useEffect } from 'react';
import { Icon } from './Icon';
import { ProblemArt } from '../art/Illustrations';
import type { AppNotification } from '../notifications';

interface NotificationToastProps {
	notification: AppNotification;
	onAskAI(entry: AppNotification): void;
	/** Open the notifications center. */
	onOpen(): void;
	onDismiss(): void;
}

/** A card at the foot of the workbench that surfaces a freshly-recorded error so it isn't missed,
 *  then sends the user to the notifications center for the full history. A drawing of what went
 *  wrong sits beside the message (a pulled cable for a connection). Auto-dismisses after a few
 *  seconds. */
export function NotificationToast({ notification, onAskAI, onOpen, onDismiss }: NotificationToastProps): JSX.Element {
	useEffect(() => {
		const timer = setTimeout(onDismiss, 9000);
		return () => clearTimeout(timer);
	}, [notification.id, onDismiss]);

	return (
		<div className={`update-toast notif-toast sev-${notification.severity}${notification.from ? ' from-model' : ''}`} role="alert">
			<ProblemArt unplugged={notification.source === 'connection'} className="notif-toast-art" />
			<div className="notif-toast-body">
				{/* A model wrote this one (an agent, or the assistant), so it says so before it says
				    anything else: the card is the app's, the words are not. Plain text throughout,
				    so nothing it says is a link or a command the card would act on. */}
				{notification.from && (
					<div className="notif-toast-from" data-test="notif-toast-from"><Icon name="hubot" /> From {notification.from}</div>
				)}
				<div className="notif-toast-title">
					<Icon name={notification.severity === 'error' ? 'error' : 'warning'} /> {notification.title}
				</div>
				{notification.detail && notification.detail !== notification.title && (
					<div className="notif-toast-detail">{notification.detail}</div>
				)}
				<div className="notif-toast-actions">
					<button className="update-toast-action" type="button" onClick={() => { onAskAI(notification); onDismiss(); }}><Icon name="sparkle" /> Ask {ASSISTANT_NAME}</button>
					<button className="notif-toast-link" type="button" onClick={() => { onOpen(); onDismiss(); }}><Icon name="bell" /> View all</button>
				</div>
			</div>
			<button className="update-toast-close" type="button" onClick={onDismiss} title="Dismiss" aria-label="Dismiss"><Icon name="close" /></button>
		</div>
	);
}

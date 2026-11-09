/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { UpdateStatus } from '../../../shared/update';
import { Icon } from './Icon';
import { useI18n, type Translate } from '../i18n';

interface UpdateRequiredSheetProps {
	minimum: string;
	current: string;
	/** The updater's last status, or null before it has said anything. */
	update: UpdateStatus | null;
	onCheck(): void;
	onInstall(): void;
	onQuit(): void;
	onDownloadPage(): void;
}

/**
 * This version is older than the oldest one the backend still supports. Blocking on purpose: an
 * app that keeps working against a backend that has moved on fails in ways that look like the
 * user's fault. There is no dismiss, only the way forward, which is the app's own updater, and Quit.
 */
export function UpdateRequiredSheet(props: UpdateRequiredSheetProps): JSX.Element {
	const { t, tr } = useI18n();
	const linux = /linux/i.test(navigator.platform || navigator.userAgent);
	const { update } = props;
	return (
		<div className="modal-backdrop update-required-backdrop">
			<div className="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="update-required-title">
				<h2 id="update-required-title">
					<Icon name="cloud-download" />
					{t('shell.updateRequired.title')}
				</h2>
				<p className="confirm-detail">
					{t('shell.updateRequired.body', { current: props.current, minimum: props.minimum })}
				</p>
				{linux ? (
					<p className="confirm-detail">
						{tr('shell.updateRequired.linux')}
					</p>
				) : (
					<p className="confirm-detail update-required-status" role="status">{statusText(update, t)}</p>
				)}
				<div className="modal-actions">
					<button type="button" className="secondary" onClick={props.onDownloadPage}><Icon name="link-external" /> {t('shell.updateRequired.downloadPage')}</button>
					<span className="spacer" />
					<button type="button" className="secondary" onClick={props.onQuit}><Icon name="sign-out" /> {t('shell.common.quit')}</button>
					{!linux && primary(update, props, t)}
				</div>
			</div>
		</div>
	);
}

function primary(update: UpdateStatus | null, props: UpdateRequiredSheetProps, t: Translate): JSX.Element {
	if (update?.state === 'downloaded') {
		return <button type="button" onClick={props.onInstall} autoFocus><Icon name="debug-restart" /> {t('shell.updateRequired.restartUpdate')}</button>;
	}
	const busy = update?.state === 'checking' || update?.state === 'available' || update?.state === 'downloading';
	return (
		<button type="button" onClick={props.onCheck} disabled={busy} autoFocus><Icon name="cloud-download" /> 
			{t(busy ? 'shell.updateRequired.updating' : 'shell.updateRequired.getUpdate')}
		</button>
	);
}

function statusText(update: UpdateStatus | null, t: Translate): string {
	switch (update?.state) {
		case undefined:
			return t('shell.updateRequired.statusStart');
		case 'checking':
			return t('shell.updateRequired.statusChecking');
		case 'available':
			return t('shell.updateRequired.statusAvailable', { version: update.version });
		case 'downloading':
			if (update.preparing) {
				return t('shell.updateRequired.statusPreparing');
			}
			return update.percent !== undefined ? t('shell.updateRequired.statusDownloadingPercent', { percent: update.percent }) : t('shell.updateRequired.statusDownloading');
		case 'downloaded':
			return t('shell.updateRequired.statusDownloaded', { version: update.version });
		case 'not-available':
			return t('shell.updateRequired.statusNotAvailable');
		case 'error':
			return t('shell.updateRequired.statusError', { message: update.message });
	}
}

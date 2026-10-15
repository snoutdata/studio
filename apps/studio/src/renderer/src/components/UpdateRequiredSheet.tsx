/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { UpdateStatus } from '../../../shared/update';
import { Icon } from './Icon';

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
	const linux = /linux/i.test(navigator.platform || navigator.userAgent);
	const { update } = props;
	return (
		<div className="modal-backdrop update-required-backdrop">
			<div className="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="update-required-title">
				<h2 id="update-required-title">
					<Icon name="cloud-download" />
					Update required
				</h2>
				<p className="confirm-detail">
					This version of SnoutData Studio (v{props.current}) is no longer supported. Version v{props.minimum} or
					newer is needed to keep signing in, syncing and using the assistant.
				</p>
				{linux ? (
					<p className="confirm-detail">
						Update SnoutData Studio with your package manager (for example <code>sudo apt upgrade</code>), then
						start it again.
					</p>
				) : (
					<p className="confirm-detail update-required-status" role="status">{statusText(update)}</p>
				)}
				<div className="modal-actions">
					<button type="button" className="secondary" onClick={props.onDownloadPage}><Icon name="link-external" /> Download Page</button>
					<span className="spacer" />
					<button type="button" className="secondary" onClick={props.onQuit}><Icon name="sign-out" /> Quit</button>
					{!linux && primary(update, props)}
				</div>
			</div>
		</div>
	);
}

function primary(update: UpdateStatus | null, props: UpdateRequiredSheetProps): JSX.Element {
	if (update?.state === 'downloaded') {
		return <button type="button" onClick={props.onInstall} autoFocus><Icon name="debug-restart" /> Restart and Update</button>;
	}
	const busy = update?.state === 'checking' || update?.state === 'available' || update?.state === 'downloading';
	return (
		<button type="button" onClick={props.onCheck} disabled={busy} autoFocus><Icon name="cloud-download" /> 
			{busy ? "Updating…" : "Get the Update"}
		</button>
	);
}

function statusText(update: UpdateStatus | null): string {
	switch (update?.state) {
		case undefined:
			return "Get the update to continue.";
		case 'checking':
			return "Looking for the latest version…";
		case 'available':
			return `Found v${update.version}. Downloading it now.`;
		case 'downloading':
			if (update.preparing) {
				return "Getting the update ready.";
			}
			return update.percent !== undefined ? `Downloading the update (${update.percent}%).` : "Downloading the update.";
		case 'downloaded':
			return `v${update.version} is ready. Restart to finish updating.`;
		case 'not-available':
			return "No newer version was found from here. Try again, or get it from the download page.";
		case 'error':
			return `The update could not be fetched: ${update.message}`;
	}
}

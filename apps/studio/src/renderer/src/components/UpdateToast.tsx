/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CSSProperties } from 'react';
import { updateFailureIcon, type UpdateStatus } from '../../../shared/update';
import { Icon } from './Icon';

interface UpdateToastProps {
	status: UpdateStatus;
	/** Positioning override (the parent offsets the card past the activity bar + sidebar so it
	 *  never sits on top of them, and follows the activity-bar side/top setting). */
	style?: CSSProperties;
	onInstall(): void;
	onDismiss(): void;
	/** Open the Release Notes document. Omit to hide the button (e.g. this build ships no notes). */
	onReleaseNotes?(): void;
}

/** A compact single-row card, bottom-right, for the auto-update lifecycle (see main/updater.ts).
 *  Download PROGRESS is shown ambiently in the status bar, not here — this surfaces only the
 *  moments that warrant a card: the "ready to install" call-to-action (downloaded), and the
 *  feedback for an explicit "Check for Updates…" (checking / up-to-date / error). The
 *  `downloading` state never renders here. Platform-agnostic: the same UpdateStatus is emitted
 *  by the Windows (electron-updater), macOS (Squirrel) and (suppressed) Linux paths.
 *  On the "ready to install" card it offers a "Release Notes" link to the per-version notes
 *  document (when this build ships notes); the notes also auto-open after the restart. */
export function UpdateToast({ status, style, onInstall, onDismiss, onReleaseNotes }: UpdateToastProps): JSX.Element {
	return (
		<div className={`update-toast update-toast-${status.state}`} role="status" style={style}>
			<Icon name={iconFor(status)} className={`update-toast-icon${status.state === 'checking' ? ' spin' : ''}`} />
			{/* The detail is a tooltip rather than a second line: what it says ("HttpError: 504") is
			    for whoever is diagnosing this, and the sentence is for whoever is using the app. */}
			<span className="update-toast-text" title={status.state === 'error' ? status.detail : undefined}>{textFor(status)}</span>
			{status.state === 'downloaded' ? (
				<span className="update-toast-actions">
					{onReleaseNotes && <button className="update-toast-later" type="button" onClick={onReleaseNotes}><Icon name="book" /> Release Notes</button>}
					<button className="update-toast-later" type="button" onClick={onDismiss}>Later</button>
					<button className="update-toast-action" type="button" onClick={onInstall}><Icon name="debug-restart" /> Restart</button>
				</span>
			) : (
				<button className="update-toast-close" type="button" onClick={onDismiss} title="Dismiss">
					<Icon name="close" />
				</button>
			)}
		</div>
	);
}

function iconFor(status: UpdateStatus): string {
	switch (status.state) {
		case 'checking': return 'sync';
		case 'available': return 'cloud-download';
		case 'downloading': return 'cloud-download';
		case 'downloaded': return 'rocket';
		case 'not-available': return status.fromSource ? 'info' : 'check';
		case 'error': return updateFailureIcon(status.kind);
	}
}

/** A build from the open-source tree has no update feed. */
const FROM_SOURCE_TEXT = "This build was made from source and does not update itself. Build it again from the latest source to update.";

function textFor(status: UpdateStatus): string {
	switch (status.state) {
		case 'checking': return 'Checking for updates…';
		case 'available': return `Update found (v${status.version}), downloading…`;
		case 'downloading': return status.preparing ? 'Preparing update…' : 'Downloading update…';
		case 'downloaded': return `Update ready · v${status.version}`;
		case 'not-available': return status.fromSource ? FROM_SOURCE_TEXT : `You're up to date (v${status.version})`;
		// Already a sentence by the time it gets here (shared/update.ts), and deliberately not
		// prefixed with "Update check failed": that is what the message says.
		case 'error': return status.message;
	}
}

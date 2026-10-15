/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';

interface ConfirmCloseTabProps {
	title: string;
	onConfirm(): void;
	onCancel(): void;
}

/** Themed "discard unsaved changes" prompt for closing a dirty editor tab — mirrors the
 *  quit dialog so we never fall back to the OS confirm box. */
export function ConfirmCloseTab(props: ConfirmCloseTabProps): JSX.Element {
	return (
		<div className="modal-backdrop" onClick={props.onCancel}>
			<div className="modal confirm" onClick={(e) => e.stopPropagation()}>
				<h2 className="danger">
					<Icon name="warning" />
					Discard unsaved changes?
				</h2>
				<p className="confirm-detail">
					<b>{props.title}</b> has unsaved edits. If you close it now, they will be lost.
				</p>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={props.onCancel} autoFocus><Icon name="close" /> Cancel</button>
					<button type="button" className="danger" onClick={props.onConfirm}><Icon name="discard" /> Discard</button>
				</div>
			</div>
		</div>
	);
}

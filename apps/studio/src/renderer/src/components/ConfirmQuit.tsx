/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';

interface ConfirmQuitProps {
	dirty: boolean;
	onConfirm(): void;
	onCancel(): void;
}

/** Quit confirmation. A stronger "edits will be lost" warning when an editor is dirty. */
export function ConfirmQuit(props: ConfirmQuitProps): JSX.Element {
	return (
		<div className="modal-backdrop" onClick={props.onCancel}>
			<div className="modal confirm" onClick={(e) => e.stopPropagation()}>
				<h2 className={props.dirty ? 'danger' : undefined}>
					<Icon name={props.dirty ? 'warning' : 'sign-out'} />
					Quit SnoutData Studio?
				</h2>
				<p className="confirm-detail">
					{props.dirty
						? "You have unsaved query edits. If you quit now, they might be lost."
						: "Are you sure you want to quit?"}
				</p>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={props.onCancel} autoFocus><Icon name="close" /> Cancel</button>
					<button type="button" className={props.dirty ? 'danger' : ''} onClick={props.onConfirm}><Icon name="sign-out" /> Quit</button>
				</div>
			</div>
		</div>
	);
}
